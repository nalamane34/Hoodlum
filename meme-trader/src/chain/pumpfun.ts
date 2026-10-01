import {
  OnlinePumpSdk,
  PumpSdk,
  bondingCurveMarketCap,
  bondingCurvePda,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
  type BondingCurve,
  type FeeConfig,
  type Global,
} from "@pump-fun/pump-sdk";
import { AccountLayout, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createCloseAccountInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, PublicKey, type AccountInfo, type TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import type { Logger } from "../logger.js";
import { LAMPORTS_PER_SOL, TOKEN_UNIT, errMsg } from "../util.js";

export { PUMP_PROGRAM_ID } from "./fees.js";

export interface CurveState {
  accountInfo: AccountInfo<Buffer>;
  curve: BondingCurve;
}

/** Thin wrapper over the official pump.fun SDK: state, quotes and instruction building. */
export class PumpClient {
  readonly sdk = new PumpSdk();
  readonly online: OnlinePumpSdk;
  global!: Global;
  feeConfig: FeeConfig | null = null;
  private tokenProgramCache = new Map<string, PublicKey>();
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(
    private conn: Connection,
    private log: Logger,
  ) {
    this.online = new OnlinePumpSdk(conn);
  }

  async init(): Promise<void> {
    await this.refreshGlobals();
    this.refreshTimer = setInterval(() => this.refreshGlobals().catch((e) => this.log.warn("global refresh failed", { err: errMsg(e) })), 10 * 60_000);
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  private async refreshGlobals(): Promise<void> {
    this.global = await this.online.fetchGlobal();
    try {
      this.feeConfig = await this.online.fetchFeeConfig();
    } catch (e) {
      this.log.warn("fee config fetch failed; using global flat fees", { err: errMsg(e) });
      this.feeConfig = null;
    }
  }

  async fetchCurve(mint: PublicKey): Promise<CurveState> {
    const accountInfo = await this.conn.getAccountInfo(bondingCurvePda(mint), "processed");
    if (!accountInfo) throw new Error(`bonding curve not found for ${mint.toBase58()}`);
    return { accountInfo, curve: this.sdk.decodeBondingCurve(accountInfo) };
  }

  /** Token program owning the mint (legacy SPL for `create`, Token-2022 for `create_v2`). */
  async resolveTokenProgram(mint: PublicKey, hint?: string): Promise<PublicKey> {
    const key = mint.toBase58();
    if (hint) {
      const pk = new PublicKey(hint);
      this.tokenProgramCache.set(key, pk);
      return pk;
    }
    const cached = this.tokenProgramCache.get(key);
    if (cached) return cached;
    const info = await this.conn.getAccountInfo(mint, "processed");
    if (!info) throw new Error(`mint account not found: ${key}`);
    const owner = info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    this.tokenProgramCache.set(key, owner);
    return owner;
  }

  /** SOL per token (UI units) from curve reserves. */
  static priceOf(curve: BondingCurve): number {
    const vq = curve.virtualQuoteReserves.isZero() ? 0 : Number(curve.virtualQuoteReserves.toString());
    const vt = Number(curve.virtualTokenReserves.toString());
    if (vt === 0) return 0;
    return vq / LAMPORTS_PER_SOL / (vt / TOKEN_UNIT);
  }

  static marketCapSol(curve: BondingCurve): number {
    if (curve.virtualTokenReserves.isZero()) return 0;
    const mc = bondingCurveMarketCap({
      mintSupply: curve.tokenTotalSupply,
      virtualQuoteReserves: curve.virtualQuoteReserves,
      virtualTokenReserves: curve.virtualTokenReserves,
    });
    return Number(mc.toString()) / LAMPORTS_PER_SOL;
  }

  quoteBuyTokens(curve: BondingCurve, lamports: BN): BN {
    return getBuyTokenAmountFromSolAmount({
      global: this.global,
      feeConfig: this.feeConfig,
      mintSupply: curve.tokenTotalSupply,
      bondingCurve: curve,
      amount: lamports,
      quoteMint: curve.quoteMint,
    });
  }

  quoteSellLamports(curve: BondingCurve, tokensRaw: BN): BN {
    return getSellSolAmountFromTokenAmount({
      global: this.global,
      feeConfig: this.feeConfig,
      mintSupply: curve.tokenTotalSupply,
      bondingCurve: curve,
      amount: tokensRaw,
    });
  }

  async buildBuy(params: {
    mint: PublicKey;
    user: PublicKey;
    lamports: BN;
    slippagePct: number;
    tokenProgram: PublicKey;
  }): Promise<{ ixs: TransactionInstruction[]; curve: BondingCurve; expectedTokens: BN }> {
    const { mint, user, lamports, slippagePct, tokenProgram } = params;
    const state = await this.online.fetchBuyState(mint, user, tokenProgram);
    const curve = state.bondingCurve;
    if (curve.complete) throw new CurveCompleteError(mint.toBase58());
    const expectedTokens = this.quoteBuyTokens(curve, lamports);
    if (expectedTokens.isZero()) throw new Error("quote returned zero tokens");
    const ixs = await this.sdk.buyInstructions({
      global: this.global,
      bondingCurveAccountInfo: state.bondingCurveAccountInfo,
      bondingCurve: curve,
      associatedUserAccountInfo: state.associatedUserAccountInfo,
      mint,
      user,
      amount: expectedTokens,
      solAmount: lamports,
      slippage: slippagePct,
      tokenProgram,
    });
    return { ixs, curve, expectedTokens };
  }

  /** Reads the user's token balance (raw units) for a mint, or 0n when no account exists. */
  async tokenBalanceRaw(mint: PublicKey, user: PublicKey, tokenProgram: PublicKey): Promise<bigint> {
    const ata = getAssociatedTokenAddressSync(mint, user, true, tokenProgram);
    const info = await this.conn.getAccountInfo(ata, "processed");
    if (!info) return 0n;
    return AccountLayout.decode(info.data).amount;
  }

  async buildSell(params: {
    mint: PublicKey;
    user: PublicKey;
    tokensRaw: BN | "all";
    slippagePct: number;
    tokenProgram: PublicKey;
    closeAccount?: boolean;
  }): Promise<{ ixs: TransactionInstruction[]; curve: BondingCurve; expectedLamports: BN; tokensRaw: BN }> {
    const { mint, user, slippagePct, tokenProgram } = params;
    const ata = getAssociatedTokenAddressSync(mint, user, true, tokenProgram);
    const [curveInfo, ataInfo] = await this.conn.getMultipleAccountsInfo([bondingCurvePda(mint), ata], "processed");
    if (!curveInfo) throw new Error(`bonding curve not found for ${mint.toBase58()}`);
    if (!ataInfo) throw new Error("no tokens to sell (token account missing)");
    const curve = this.sdk.decodeBondingCurve(curveInfo);
    if (curve.complete) throw new CurveCompleteError(mint.toBase58());
    const balance = new BN(AccountLayout.decode(ataInfo.data).amount.toString());
    const tokensRaw = params.tokensRaw === "all" ? balance : BN.min(params.tokensRaw, balance);
    if (tokensRaw.isZero()) throw new Error("no tokens to sell");
    const expectedLamports = this.quoteSellLamports(curve, tokensRaw);
    const ixs = await this.sdk.sellInstructions({
      global: this.global,
      bondingCurveAccountInfo: curveInfo,
      bondingCurve: curve,
      mint,
      user,
      amount: tokensRaw,
      solAmount: expectedLamports,
      slippage: slippagePct,
      tokenProgram,
      mayhemMode: curve.isMayhemMode,
    });
    if (params.closeAccount && tokensRaw.eq(balance)) {
      ixs.push(createCloseAccountInstruction(ata, user, user, [], tokenProgram));
    }
    return { ixs, curve, expectedLamports, tokensRaw };
  }
}

export class CurveCompleteError extends Error {
  constructor(public mint: string) {
    super(`bonding curve complete (graduated): ${mint}`);
  }
}
