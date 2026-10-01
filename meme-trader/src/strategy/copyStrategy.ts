import { Connection, PublicKey } from "@solana/web3.js";
import type { Config } from "../config.js";
import type { Executor } from "../exec/executor.js";
import type { Logger } from "../logger.js";
import type { Portfolio } from "../portfolio/portfolio.js";
import type { RiskManager } from "../portfolio/risk.js";
import type { Store } from "../portfolio/store.js";
import type { WalletTrade } from "../types.js";
import { errMsg, shortKey } from "../util.js";
import type { TokenTracker } from "./tracker.js";

/** Mirrors buys (and optionally sells) of a curated wallet list at our own fixed size. */
export class CopyStrategy {
  private inflight = 0;
  stats = { seen: 0, copied: 0, exits: 0 };

  constructor(
    private cfg: Config,
    private conn: Connection,
    private tracker: TokenTracker,
    private portfolio: Portfolio,
    private executor: Executor,
    private risk: RiskManager,
    private store: Store,
    private log: Logger,
  ) {}

  async onWalletTrade(t: WalletTrade): Promise<void> {
    if (!this.cfg.COPY_ENABLED || !this.cfg.copyWallets.has(t.wallet)) return;
    this.stats.seen++;
    this.store.appendJsonl("copy_signals.jsonl", t);
    if (t.mint.startsWith("pool:")) {
      this.log.debug("copy: PumpSwap trade without mint mapping; ignored", { wallet: shortKey(t.wallet), pool: t.mint });
      return;
    }
    if (t.side === "sell") return this.onLeaderSell(t);
    if (t.sol < this.cfg.COPY_MIN_THEIR_SOL) return;
    if (this.portfolio.has(t.mint)) return;
    if (this.cfg.COPY_MAX_TOKEN_AGE_MIN > 0) {
      const age = this.tracker.tokenAgeMs(t.mint);
      if (age === null || age > this.cfg.COPY_MAX_TOKEN_AGE_MIN * 60_000) {
        this.log.debug("copy: token too old or age unknown", { mint: t.mint, ageMin: age === null ? null : +(age / 60_000).toFixed(1) });
        return;
      }
    }
    const walletSol = await this.executor.walletSol();
    const gate = this.risk.canOpen({ solNeeded: this.cfg.COPY_BUY_SOL, walletSol, openPositions: this.portfolio.open().length, inflight: this.inflight });
    if (!gate.ok) {
      this.log.info(`copy skip ${shortKey(t.wallet)} -> ${t.mint}: ${gate.reason}`);
      return;
    }
    this.inflight++;
    try {
      this.tracker.watch(t.mint);
      const fill = await this.executor.buy({ mint: t.mint, solAmount: this.cfg.COPY_BUY_SOL, label: `copy:${shortKey(t.wallet)}` });
      if (!fill) return;
      this.stats.copied++;
      const st = this.tracker.get(t.mint);
      const info = await this.conn.getAccountInfo(new PublicKey(t.mint), "processed").catch(() => null);
      const tokenProgram = info?.owner.toBase58() ?? "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
      this.portfolio.openPosition(fill, {
        mint: t.mint,
        symbol: st?.launch?.symbol ?? shortKey(t.mint),
        name: st?.launch?.name ?? "",
        dev: st?.dev ?? "",
        tokenProgram,
        strategy: "copy",
        copiedFrom: t.wallet,
      });
    } catch (e) {
      this.log.error("copy buy failed", { mint: t.mint, err: errMsg(e) });
    } finally {
      this.inflight--;
    }
  }

  private async onLeaderSell(t: WalletTrade): Promise<void> {
    if (!this.cfg.COPY_FOLLOW_SELLS) return;
    for (const p of this.portfolio.open()) {
      if (p.mint === t.mint && p.copiedFrom === t.wallet) {
        this.stats.exits++;
        await this.portfolio.sell(p, 100, `leader_sold_${shortKey(t.wallet)}`, true);
      }
    }
  }
}
