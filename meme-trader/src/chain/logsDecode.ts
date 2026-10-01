import type { CompleteEventBc, CreateEventBc, PumpSdk, TradeEventBc } from "@pump-fun/pump-sdk";
import { PublicKey } from "@solana/web3.js";
import type { LaunchEvent, Source, TradeTick } from "../types.js";
import { LAMPORTS_PER_SOL, TOKEN_UNIT } from "../util.js";

export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMP_AMM_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const NATIVE_MINT = "So11111111111111111111111111111111111111112";

const DISC = {
  create: Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]),
  trade: Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]),
  complete: Buffer.from([95, 114, 97, 156, 212, 46, 152, 8]),
  ammBuy: Buffer.from([103, 244, 82, 31, 44, 245, 119, 119]),
  ammSell: Buffer.from([62, 47, 55, 10, 165, 3, 220, 42]),
};

const PROGRAM_DATA = "Program data: ";

export interface DecodedLogs {
  creates: CreateEventBc[];
  trades: TradeEventBc[];
  completes: CompleteEventBc[];
  ammBuys: AmmSwap[];
  ammSells: AmmSwap[];
}

export interface AmmSwap {
  user: string;
  baseMint?: string;
  pool: string;
  quoteLamports: number;
  baseTokensRaw: number;
}

const bnNum = (x: { toString(): string }) => Number(x.toString());

/** Decodes every pump.fun / PumpSwap Anchor event found in a transaction's log lines. */
export function decodePumpLogs(sdk: PumpSdk, logs: string[]): DecodedLogs {
  const out: DecodedLogs = { creates: [], trades: [], completes: [], ammBuys: [], ammSells: [] };
  for (const line of logs) {
    if (!line.startsWith(PROGRAM_DATA)) continue;
    let buf: Buffer;
    try {
      buf = Buffer.from(line.slice(PROGRAM_DATA.length), "base64");
    } catch {
      continue;
    }
    if (buf.length < 8) continue;
    const disc = buf.subarray(0, 8);
    const body = buf.subarray(8);
    try {
      if (disc.equals(DISC.trade)) out.trades.push(sdk.decodeTradeEventBc(body));
      else if (disc.equals(DISC.create)) out.creates.push(sdk.decodeCreateEventBc(body));
      else if (disc.equals(DISC.complete)) out.completes.push(sdk.decodeCompleteEventBc(body));
      else if (disc.equals(DISC.ammBuy)) {
        const e = sdk.decodeBuyEventAmm(body) as unknown as Record<string, { toString(): string }>;
        out.ammBuys.push(ammSwapOf(e, "buy"));
      } else if (disc.equals(DISC.ammSell)) {
        const e = sdk.decodeSellEventAmm(body) as unknown as Record<string, { toString(): string }>;
        out.ammSells.push(ammSwapOf(e, "sell"));
      }
    } catch {
      // Unknown layout version or foreign program sharing a discriminator prefix: ignore.
    }
  }
  return out;
}

function ammSwapOf(e: Record<string, { toString(): string }>, side: "buy" | "sell"): AmmSwap {
  const quote = side === "buy" ? e.quoteAmountInWithLpFee ?? e.quoteAmountIn : e.quoteAmountOut;
  const base = side === "buy" ? e.baseAmountOut : e.baseAmountIn;
  return {
    user: e.user?.toString() ?? "",
    pool: e.pool?.toString() ?? "",
    quoteLamports: quote ? bnNum(quote) : 0,
    baseTokensRaw: base ? bnNum(base) : 0,
  };
}

export function isSolQuoted(quoteMint: PublicKey): boolean {
  return quoteMint.equals(PublicKey.default) || quoteMint.toBase58() === NATIVE_MINT;
}

export function toLaunchEvent(c: CreateEventBc, tradesSameTx: TradeEventBc[], signature: string, slot: number | undefined, source: Source): LaunchEvent {
  const mint = c.mint.toBase58();
  const devTrade = tradesSameTx.find((t) => t.mint.toBase58() === mint && t.isBuy);
  const vSolRaw = devTrade ? pickQuote(devTrade.virtualSolReserves, devTrade.virtualQuoteReserves) : pickQuote(c.virtualSolReserves, c.virtualQuoteReserves);
  const vTokRaw = devTrade ? bnNum(devTrade.virtualTokenReserves) : bnNum(c.virtualTokenReserves);
  return {
    mint,
    dev: c.user.toBase58(),
    creator: c.creator.toBase58(),
    bondingCurve: c.bondingCurve.toBase58(),
    name: c.name,
    symbol: c.symbol,
    uri: c.uri,
    signature,
    slot,
    ts: Date.now(),
    initialBuyTokens: devTrade ? bnNum(devTrade.tokenAmount) / TOKEN_UNIT : 0,
    initialBuySol: devTrade ? pickQuote(devTrade.solAmount, devTrade.quoteAmount) / LAMPORTS_PER_SOL : 0,
    vSol: vSolRaw / LAMPORTS_PER_SOL,
    vTokens: vTokRaw / TOKEN_UNIT,
    totalSupply: bnNum(c.tokenTotalSupply) / TOKEN_UNIT,
    isMayhem: c.isMayhemMode,
    tokenProgram: c.tokenProgram.toBase58(),
    solQuoted: isSolQuoted(c.quoteMint),
    source,
  };
}

function pickQuote(sol: { toString(): string }, quote: { toString(): string }): number {
  const s = bnNum(sol);
  return s > 0 ? s : bnNum(quote);
}

export function toTradeTick(t: TradeEventBc, signature: string, slot: number | undefined, source: Source): TradeTick {
  return {
    mint: t.mint.toBase58(),
    user: t.user.toBase58(),
    isBuy: t.isBuy,
    sol: pickQuote(t.solAmount, t.quoteAmount) / LAMPORTS_PER_SOL,
    tokens: bnNum(t.tokenAmount) / TOKEN_UNIT,
    vSol: pickQuote(t.virtualSolReserves, t.virtualQuoteReserves) / LAMPORTS_PER_SOL,
    vTokens: bnNum(t.virtualTokenReserves) / TOKEN_UNIT,
    realTokens: bnNum(t.realTokenReserves) / TOKEN_UNIT,
    slot,
    ts: Date.now(),
    signature,
    creator: t.creator.toBase58(),
    quoteMint: t.quoteMint.toBase58(),
    source,
  };
}

export function isSolQuotedKey(quoteMint: string | undefined): boolean {
  return quoteMint === undefined || quoteMint === PublicKey.default.toBase58() || quoteMint === NATIVE_MINT;
}
