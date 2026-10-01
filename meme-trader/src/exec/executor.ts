import type { BondingCurve } from "@pump-fun/pump-sdk";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import type { Config } from "../config.js";
import { Jupiter, SOL_MINT } from "../chain/jupiter.js";
import { CurveCompleteError, PumpClient } from "../chain/pumpfun.js";
import type { Sender } from "../chain/sender.js";
import type { Logger } from "../logger.js";
import type { Store } from "../portfolio/store.js";
import type { TokenTracker } from "../strategy/tracker.js";
import type { Fill } from "../types.js";
import { LAMPORTS_PER_SOL, TOKEN_UNIT, errMsg, retry, sleep } from "../util.js";

const ATA_RENT_SOL = 0.00203928;

export interface BuyRequest {
  mint: string;
  solAmount: number;
  tokenProgramHint?: string;
  label: string;
  dev?: string;
  isMayhem?: boolean;
  totalSupply?: number;
}

export interface SellRequest {
  mint: string;
  tokensUi: number;
  pct: number;
  urgent: boolean;
  venue: "curve" | "amm";
  tokenProgram: string;
  label: string;
  dev?: string;
}

/** Executes buys and sells, live or paper, through the same interface. */
export class Executor {
  readonly paper: boolean;
  private cachedBalance: { at: number; sol: number } | null = null;

  constructor(
    private cfg: Config,
    private conn: Connection,
    private wallet: Keypair,
    private pump: PumpClient,
    private jup: Jupiter,
    private sender: Sender,
    private tracker: TokenTracker,
    private store: Store,
    private log: Logger,
  ) {
    this.paper = !cfg.live;
  }

  get pubkey(): PublicKey {
    return this.wallet.publicKey;
  }

  /** Spendable SOL (paper balance in paper mode; cached on-chain balance in live mode). */
  async walletSol(): Promise<number | null> {
    if (this.paper) return this.store.state.paperSol;
    if (this.cachedBalance && Date.now() - this.cachedBalance.at < 15_000) return this.cachedBalance.sol;
    try {
      const lamports = await this.conn.getBalance(this.wallet.publicKey, "processed");
      this.cachedBalance = { at: Date.now(), sol: lamports / LAMPORTS_PER_SOL };
      return this.cachedBalance.sol;
    } catch {
      return this.cachedBalance?.sol ?? null;
    }
  }

  invalidateBalance(): void {
    this.cachedBalance = null;
  }

  // ───────────────────────────── BUY ─────────────────────────────

  async buy(req: BuyRequest): Promise<Fill | null> {
    return this.paper ? this.paperBuy(req) : this.liveBuy(req);
  }

  private async liveBuy(req: BuyRequest): Promise<Fill | null> {
    const mint = new PublicKey(req.mint);
    const lamports = new BN(Math.floor(req.solAmount * LAMPORTS_PER_SOL));
    let tokenProgram: PublicKey;
    try {
      tokenProgram = await this.pump.resolveTokenProgram(mint, req.tokenProgramHint);
    } catch (e) {
      this.log.error("could not resolve token program", { mint: req.mint, err: errMsg(e) });
      return null;
    }
    for (let attempt = 1; attempt <= this.cfg.MAX_TX_ATTEMPTS; attempt++) {
      const slippage = this.cfg.SLIPPAGE_BUY_PCT + (attempt - 1) * 5;
      const feeMult = 1 + (attempt - 1) * 0.75;
      const t0 = Date.now();
      try {
        const built = await this.pump.buildBuy({ mint, user: this.wallet.publicKey, lamports, slippagePct: slippage, tokenProgram });
        const prelude = await this.sender.prelude(this.wallet.publicKey, { feeMultiplier: feeMult });
        const { tx, lastValidBlockHeight } = await this.sender.build(this.wallet, [...prelude.ixs, ...built.ixs]);
        const res = await this.sender.sendAndConfirm(tx, lastValidBlockHeight, `buy:${req.label}`, this.sender.estimateFeeLamports(prelude));
        this.log.info(`buy tx ${res.confirmed ? "confirmed" : "failed"} (${Date.now() - t0}ms, attempt ${attempt})`, { sig: res.signature, err: res.err, label: req.label });
        if (res.confirmed) {
          this.invalidateBalance();
          const fill = await this.fillFromTx(res.signature, "buy", req.mint, "curve", {
            tokens: Number(built.expectedTokens.toString()) / TOKEN_UNIT,
            sol: req.solAmount + res.feeLamports / LAMPORTS_PER_SOL,
          });
          return fill;
        }
        if (res.err && /custom program error: 0x177[0-9a-f]|TooMuchSolRequired|slippage/i.test(res.err)) continue;
        if (res.err && /blockhash expired|timeout|dispatch/i.test(res.err)) continue;
        if (res.err && /on-chain error/.test(res.err)) {
          // A real program error that is not slippage: do not keep paying for failures.
          if (attempt >= 2) return null;
        }
      } catch (e) {
        if (e instanceof CurveCompleteError) return this.jupiterBuy(req, tokenProgram);
        this.log.warn(`buy attempt ${attempt} error`, { label: req.label, err: errMsg(e) });
        await sleep(300);
      }
    }
    return null;
  }

  private async jupiterBuy(req: BuyRequest, tokenProgram: PublicKey): Promise<Fill | null> {
    try {
      const lamports = BigInt(Math.floor(req.solAmount * LAMPORTS_PER_SOL));
      const r = await this.jup.swap({ inputMint: SOL_MINT, outputMint: req.mint, amount: lamports, slippageBps: Math.round(this.cfg.SLIPPAGE_BUY_PCT * 100), signer: this.wallet });
      this.invalidateBalance();
      const tokens = Number(r.outAmount) / TOKEN_UNIT;
      const sol = Number(r.inAmount) / LAMPORTS_PER_SOL + 0.001;
      void tokenProgram;
      return { ts: Date.now(), side: "buy", tokens, sol, price: tokens > 0 ? sol / tokens : 0, signature: r.signature, paper: false, venue: "amm", reason: "jupiter" };
    } catch (e) {
      this.log.error("jupiter buy failed", { mint: req.mint, err: errMsg(e) });
      return null;
    }
  }

  private async paperBuy(req: BuyRequest): Promise<Fill | null> {
    const curve = await this.curveSnapshot(req.mint, req.dev, req.isMayhem, req.totalSupply);
    if (!curve) return null;
    if (curve.complete) {
      this.log.info("paper buy skipped: curve complete (would route via Jupiter)", { mint: req.mint });
      return null;
    }
    const lamports = new BN(Math.floor(req.solAmount * LAMPORTS_PER_SOL));
    const tokensRaw = this.pump.quoteBuyTokens(curve, lamports);
    if (tokensRaw.isZero()) return null;
    const tokens = (Number(tokensRaw.toString()) / TOKEN_UNIT) * (1 - this.cfg.PAPER_SLIPPAGE_PCT / 100);
    const sol = req.solAmount + this.cfg.PAPER_FEE_SOL + ATA_RENT_SOL;
    if (this.store.state.paperSol < sol) {
      this.log.warn("paper balance too low", { have: this.store.state.paperSol, need: sol });
      return null;
    }
    this.store.state.paperSol -= sol;
    this.store.save();
    return { ts: Date.now(), side: "buy", tokens, sol, price: sol / tokens, paper: true, venue: "curve", reason: "paper" };
  }

  // ───────────────────────────── SELL ─────────────────────────────

  async sell(req: SellRequest): Promise<Fill | null> {
    return this.paper ? this.paperSell(req) : this.liveSell(req);
  }

  private async liveSell(req: SellRequest): Promise<Fill | null> {
    const mint = new PublicKey(req.mint);
    const tokenProgram = new PublicKey(req.tokenProgram);
    const all = req.pct >= 99.5;
    const baseSlippage = req.urgent ? this.cfg.SLIPPAGE_PANIC_PCT : this.cfg.SLIPPAGE_SELL_PCT;
    if (req.venue === "amm") return this.jupiterSell(req, mint, tokenProgram, all, baseSlippage);
    for (let attempt = 1; attempt <= this.cfg.MAX_TX_ATTEMPTS; attempt++) {
      const slippage = Math.min(90, baseSlippage + (attempt - 1) * 10);
      const feeMult = (req.urgent ? 1.5 : 1) * (1 + (attempt - 1) * 0.75);
      const t0 = Date.now();
      try {
        const tokensRaw: BN | "all" = all ? "all" : new BN(Math.floor(((req.tokensUi * req.pct) / 100) * TOKEN_UNIT));
        const built = await this.pump.buildSell({ mint, user: this.wallet.publicKey, tokensRaw, slippagePct: slippage, tokenProgram, closeAccount: all });
        const prelude = await this.sender.prelude(this.wallet.publicKey, { feeMultiplier: feeMult });
        const { tx, lastValidBlockHeight } = await this.sender.build(this.wallet, [...prelude.ixs, ...built.ixs]);
        const res = await this.sender.sendAndConfirm(tx, lastValidBlockHeight, `sell:${req.label}`, this.sender.estimateFeeLamports(prelude));
        this.log.info(`sell tx ${res.confirmed ? "confirmed" : "failed"} (${Date.now() - t0}ms, attempt ${attempt})`, { sig: res.signature, err: res.err, label: req.label });
        if (res.confirmed) {
          this.invalidateBalance();
          return this.fillFromTx(res.signature, "sell", req.mint, "curve", {
            tokens: Number(built.tokensRaw.toString()) / TOKEN_UNIT,
            sol: Math.max(0, Number(built.expectedLamports.toString()) / LAMPORTS_PER_SOL - res.feeLamports / LAMPORTS_PER_SOL),
          });
        }
      } catch (e) {
        if (e instanceof CurveCompleteError) return this.jupiterSell(req, mint, tokenProgram, all, baseSlippage);
        if (/no tokens to sell|Associated token account not found/i.test(errMsg(e))) {
          this.log.warn("nothing to sell on-chain; marking position closed", { mint: req.mint });
          return { ts: Date.now(), side: "sell", tokens: req.tokensUi, sol: 0, price: 0, paper: false, venue: "curve", reason: "no_balance" };
        }
        this.log.warn(`sell attempt ${attempt} error`, { label: req.label, err: errMsg(e) });
        await sleep(300);
      }
    }
    return null;
  }

  private async jupiterSell(req: SellRequest, mint: PublicKey, tokenProgram: PublicKey, all: boolean, slippagePct: number): Promise<Fill | null> {
    try {
      const balance = await this.pump.tokenBalanceRaw(mint, this.wallet.publicKey, tokenProgram);
      if (balance === 0n) return { ts: Date.now(), side: "sell", tokens: req.tokensUi, sol: 0, price: 0, paper: false, venue: "amm", reason: "no_balance" };
      const amount = all ? balance : (balance * BigInt(Math.round(req.pct * 100))) / 10_000n;
      const r = await retry(() => this.jup.swap({ inputMint: req.mint, outputMint: SOL_MINT, amount, slippageBps: Math.round(Math.min(90, slippagePct) * 100), signer: this.wallet }), 2, 500, "jupiter sell");
      this.invalidateBalance();
      const tokens = Number(r.inAmount) / TOKEN_UNIT;
      const sol = Number(r.outAmount) / LAMPORTS_PER_SOL;
      return { ts: Date.now(), side: "sell", tokens, sol, price: tokens > 0 ? sol / tokens : 0, signature: r.signature, paper: false, venue: "amm", reason: "jupiter" };
    } catch (e) {
      this.log.error("jupiter sell failed", { mint: req.mint, err: errMsg(e) });
      return null;
    }
  }

  private async paperSell(req: SellRequest): Promise<Fill | null> {
    const tokensUi = req.pct >= 99.5 ? req.tokensUi : (req.tokensUi * req.pct) / 100;
    const tokensRaw = BigInt(Math.floor(tokensUi * TOKEN_UNIT));
    if (tokensRaw <= 0n) return { ts: Date.now(), side: "sell", tokens: req.tokensUi, sol: 0, price: 0, paper: true, venue: req.venue, reason: "dust" };
    let sol = 0;
    const st = this.tracker.get(req.mint);
    if (req.venue === "amm" || st?.graduated) {
      const lamports = await this.jup.quoteSellLamports(req.mint, tokensRaw);
      if (lamports === null) {
        this.log.warn("paper sell: no Jupiter route yet; retry next tick", { mint: req.mint });
        return null;
      }
      sol = lamports / LAMPORTS_PER_SOL;
    } else {
      const curve = await this.curveSnapshot(req.mint, req.dev);
      if (!curve) return null;
      if (curve.complete) {
        const lamports = await this.jup.quoteSellLamports(req.mint, tokensRaw);
        if (lamports === null) return null;
        sol = lamports / LAMPORTS_PER_SOL;
      } else {
        sol = Number(this.pump.quoteSellLamports(curve, new BN(tokensRaw.toString())).toString()) / LAMPORTS_PER_SOL;
      }
    }
    sol = Math.max(0, sol * (1 - this.cfg.PAPER_SLIPPAGE_PCT / 100) - this.cfg.PAPER_FEE_SOL + (req.pct >= 99.5 ? ATA_RENT_SOL : 0));
    this.store.state.paperSol += sol;
    this.store.save();
    return { ts: Date.now(), side: "sell", tokens: tokensUi, sol, price: tokensUi > 0 ? sol / tokensUi : 0, paper: true, venue: req.venue, reason: "paper" };
  }

  // ───────────────────────────── helpers ─────────────────────────────

  /** Current curve state: from the firehose if fresh (no RPC), else fetched. */
  private async curveSnapshot(mint: string, dev?: string, isMayhem?: boolean, totalSupply?: number): Promise<BondingCurve | null> {
    const st = this.tracker.get(mint);
    const last = st?.ticks[st.ticks.length - 1];
    if (st && last && Date.now() - last.ts < 3000 && !st.graduated) {
      return {
        virtualTokenReserves: new BN(Math.round(last.vTokens * TOKEN_UNIT).toString()),
        virtualQuoteReserves: new BN(Math.round(last.vSol * LAMPORTS_PER_SOL).toString()),
        realTokenReserves: new BN(Math.round(last.realTokens * TOKEN_UNIT).toString()),
        realQuoteReserves: new BN(0),
        tokenTotalSupply: new BN(Math.round((totalSupply ?? st.totalSupply) * TOKEN_UNIT).toString()),
        complete: false,
        creator: new PublicKey(dev ?? st.dev ?? this.wallet.publicKey.toBase58()),
        isMayhemMode: isMayhem ?? st.launch?.isMayhem ?? false,
        isCashbackCoin: false,
        quoteMint: PublicKey.default,
        creatorFeeBps: new BN(0),
        canEditCreatorFee: false,
        isHolderReward: false,
      };
    }
    try {
      const { curve } = await this.pump.fetchCurve(new PublicKey(mint));
      return curve;
    } catch (e) {
      this.log.warn("curve fetch failed", { mint, err: errMsg(e) });
      return null;
    }
  }

  /** Reads exact SOL and token deltas from the confirmed transaction; falls back to estimates. */
  private async fillFromTx(signature: string, side: "buy" | "sell", mint: string, venue: "curve" | "amm", est: { tokens: number; sol: number }): Promise<Fill> {
    const base: Fill = { ts: Date.now(), side, tokens: est.tokens, sol: est.sol, price: est.tokens > 0 ? est.sol / est.tokens : 0, signature, paper: false, venue, reason: "estimated" };
    try {
      const tx = await retry(
        async () => {
          const t = await this.conn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
          if (!t) throw new Error("tx not yet available");
          return t;
        },
        5,
        600,
        "getTransaction",
      );
      const meta = tx.meta;
      if (!meta) return base;
      const me = this.wallet.publicKey.toBase58();
      const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: meta.loadedAddresses ?? undefined }).staticAccountKeys;
      const idx = keys.findIndex((k) => k.toBase58() === me);
      const solDelta = idx >= 0 ? (meta.postBalances[idx] - meta.preBalances[idx]) / LAMPORTS_PER_SOL : 0;
      const pre = (meta.preTokenBalances ?? []).find((b) => b.owner === me && b.mint === mint)?.uiTokenAmount.uiAmount ?? 0;
      const post = (meta.postTokenBalances ?? []).find((b) => b.owner === me && b.mint === mint)?.uiTokenAmount.uiAmount ?? 0;
      const tokenDelta = post - pre;
      const tokens = Math.abs(tokenDelta) > 0 ? Math.abs(tokenDelta) : est.tokens;
      const sol = Math.abs(solDelta) > 0 ? Math.abs(solDelta) : est.sol;
      return { ...base, tokens, sol, price: tokens > 0 ? sol / tokens : 0, reason: "exact" };
    } catch (e) {
      this.log.warn("could not read fill from tx; using estimate", { signature, err: errMsg(e) });
      return base;
    }
  }
}
