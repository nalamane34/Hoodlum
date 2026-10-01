export type Source = "pumpportal" | "rpc" | "grpc";

/** A new pump.fun token, normalised from any feed. Amounts are UI units (SOL, tokens with 6 decimals applied). */
export interface LaunchEvent {
  mint: string;
  /** Wallet that signed the create transaction (the "dev"). */
  dev: string;
  /** On-chain creator field (equals dev except for holder-reward coins). */
  creator: string;
  bondingCurve: string;
  name: string;
  symbol: string;
  uri: string;
  signature: string;
  slot?: number;
  /** ms when we observed it */
  ts: number;
  initialBuyTokens: number;
  initialBuySol: number;
  vSol: number;
  vTokens: number;
  totalSupply: number;
  isMayhem: boolean;
  /** Only known from the rpc/grpc feeds; resolved lazily otherwise. */
  tokenProgram?: string;
  /** false for USDC-quoted coins, which the bot does not trade */
  solQuoted: boolean;
  source: Source;
}

export interface TradeTick {
  mint: string;
  user: string;
  isBuy: boolean;
  sol: number;
  tokens: number;
  vSol: number;
  vTokens: number;
  realTokens: number;
  slot?: number;
  ts: number;
  signature: string;
  creator?: string;
  /** base58 quote mint from the event; undefined or the default/WSOL key means a SOL-quoted curve */
  quoteMint?: string;
  source: Source;
}

export interface MigrationEvent {
  mint: string;
  pool?: string;
  signature?: string;
  ts: number;
}

/** A trade made by a wallet on the copy list, from any venue. */
export interface WalletTrade {
  wallet: string;
  mint: string;
  side: "buy" | "sell";
  sol: number;
  tokens: number;
  signature: string;
  venue: "pump" | "pumpswap" | "other";
  ts: number;
}

export type Strategy = "launch" | "copy" | "manual";

export interface Fill {
  ts: number;
  side: "buy" | "sell";
  tokens: number;
  sol: number;
  /** SOL per token actually achieved */
  price: number;
  signature?: string;
  reason?: string;
  paper: boolean;
  venue: "curve" | "amm";
}

export interface Position {
  id: string;
  mint: string;
  symbol: string;
  name: string;
  dev: string;
  tokenProgram: string;
  strategy: Strategy;
  copiedFrom?: string;
  openedAt: number;
  closedAt?: number;
  status: "open" | "closed";
  venue: "curve" | "amm";
  entryPrice: number;
  tokens: number;
  tokensBought: number;
  costSol: number;
  proceedsSol: number;
  lastPrice: number;
  peakPrice: number;
  lastTradeTs: number;
  ladderDone: number[];
  trailingArmed: boolean;
  fills: Fill[];
  exitReasons: string[];
  realizedPnlSol: number;
}

export interface ScoredLaunch {
  ts: number;
  mint: string;
  symbol: string;
  name: string;
  dev: string;
  decision: "buy" | "skip";
  score: number;
  hardFails: string[];
  reasons: string[];
  features: Record<string, number | string | boolean | null>;
  marketCapSol: number;
  source: Source;
  signature?: string;
}
