import { z } from "zod";
import { parseList } from "./util.js";

const bool = z.preprocess((v) => {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
  return v;
}, z.boolean());

const num = (d: number) => z.coerce.number().default(d);
const str = (d: string) => z.string().default(d);
const optStr = z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().optional());

export const ConfigSchema = z.object({
  MODE: z.enum(["paper", "live"]).default("paper"),
  RPC_URL: str("https://api.mainnet-beta.solana.com"),
  RPC_WS_URL: optStr,
  /** Endpoint for low-priority background reads (shadow outcome sampling, creator wallet history). Defaults to the public RPC so the paid plan's credits go to trading. */
  RPC_BACKGROUND_URL: str("https://api.mainnet-beta.solana.com"),
  RPC_FALLBACK_URL: str("https://api.mainnet-beta.solana.com"),
  RPC_FAILOVER_TRIP_SEC: num(600),
  RPC_MAX_RPS: num(8),
  WALLET_SECRET_KEY: optStr,

  FEEDS: str("pumpportal,rpc"),
  TRADE_FEED: z.enum(["watched", "firehose"]).default("watched"),
  PUMPPORTAL_WS: str("wss://pumpportal.fun/api/data"),
  GRPC_ENDPOINT: optStr,
  GRPC_TOKEN: optStr,

  SENDER: z.enum(["rpc", "jito", "helius"]).default("rpc"),
  JITO_URL: str("https://mainnet.block-engine.jito.wtf"),
  HELIUS_SENDER_URL: str("https://sender.helius-rpc.com/fast"),
  HELIUS_SWQOS_ONLY: bool.default(false),
  TIP_SOL_MIN: num(0.0005),
  TIP_SOL_MAX: num(0.003),
  PRIORITY_FEE_MODE: z.enum(["auto", "fixed"]).default("auto"),
  PRIORITY_FEE_MIN_MICRO: num(20_000),
  PRIORITY_FEE_MAX_MICRO: num(3_000_000),
  PRIORITY_FEE_FIXED_MICRO: num(300_000),
  CU_LIMIT: num(220_000),
  MAX_TX_ATTEMPTS: num(3),
  SLIPPAGE_BUY_PCT: num(12),
  SLIPPAGE_SELL_PCT: num(20),
  SLIPPAGE_PANIC_PCT: num(45),

  BUY_SOL: num(0.05),
  MAX_POSITIONS: num(3),
  MAX_DAILY_LOSS_SOL: num(0.5),
  MIN_RESERVE_SOL: num(0.05),
  MAX_CONSECUTIVE_LOSSES: num(4),
  LOSS_COOLDOWN_MIN: num(20),

  LAUNCH_ENABLED: bool.default(true),
  OBSERVE_SECONDS: num(25),
  EARLY_TRIGGER_BUYERS: num(12),
  EARLY_TRIGGER_MIN_SOL: num(2.0),
  MIN_SCORE: num(55),
  MIN_UNIQUE_BUYERS: num(5),
  MAX_DEV_PCT: num(5),
  MAX_SINGLE_HOLDER_PCT: num(8),
  MAX_TOP10_PCT: num(30),
  MAX_BUNDLE_PCT: num(10),
  BUNDLE_MIN_WALLETS: num(3),
  MAX_SELL_RATIO: num(0.6),
  MIN_NET_INFLOW_SOL: num(1.0),
  MAX_ENTRY_MCAP_SOL: num(90),
  SKIP_MAYHEM: bool.default(true),
  REQUIRE_SOCIALS: bool.default(false),
  NAME_BLACKLIST: str("test,rug,scam,airdrop,presale"),
  CREATOR_BLACKLIST: str(""),
  CREATOR_MIN_TX: num(0),
  SAMPLE_BUYERS: num(4),
  RING_MAX_SAMPLED: num(2),
  SHADOW_TRACK_MINUTES: num(10),
  /** Also track outcomes of launches rejected before observation (mayhem, dev holdings...). Off by default: they are never tradeable, and sampling them costs an RPC call each. */
  SHADOW_PREFILTERED: bool.default(false),
  /** Skipped launches with at least this many unique buyers stay subscribed for the whole shadow window, so their real peak, trough and end are seen. 0 = drop every skip at once (old behaviour). */
  SHADOW_WATCH_MIN_BUYERS: num(5),
  /** Cap on skipped launches kept subscribed at the same time (each is one more websocket subscription). */
  SHADOW_WATCH_MAX: num(20),
  /** Trades kept per token in the saved price paths (data/paths/DAY.jsonl). 0 = do not save paths. */
  PATH_MAX_POINTS: num(4000),

  COPY_ENABLED: bool.default(false),
  COPY_WALLETS: str(""),
  COPY_MIN_THEIR_SOL: num(0.2),
  COPY_BUY_SOL: num(0.05),
  COPY_MAX_TOKEN_AGE_MIN: num(0),
  COPY_FOLLOW_SELLS: bool.default(true),
  COPY_USE_EXITS: bool.default(true),

  TP_LADDER: str("2:50,3:25"),
  TRAIL_PCT: num(30),
  TRAIL_ARM_MULT: num(1.3),
  STOP_LOSS_PCT: num(35),
  MAX_HOLD_MIN: num(10),
  MIN_GAIN_PCT_BY_MAX_HOLD: num(10),
  HARD_MAX_HOLD_MIN: num(90),
  STAGNATION_SECONDS: num(90),
  EXIT_ON_DEV_SELL: bool.default(true),
  WHALE_DUMP_PCT: num(5),
  SELL_ON_GRADUATION: bool.default(false),

  PAPER_START_SOL: num(5),
  PAPER_SLIPPAGE_PCT: num(2),
  PAPER_FEE_SOL: num(0.0015),

  DATA_DIR: str("./data"),
  DATA_KEEP_DAYS: num(7),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  STATUS_EVERY_SEC: num(30),
  JUPITER_API_KEY: optStr,
});

export type RawConfig = z.infer<typeof ConfigSchema>;

export interface LadderRung {
  mult: number;
  sellPct: number;
}

export interface ExitConfig {
  ladder: LadderRung[];
  trailPct: number;
  trailArmMult: number;
  stopLossPct: number;
  maxHoldMin: number;
  minGainPctByMaxHold: number;
  hardMaxHoldMin: number;
  stagnationSec: number;
  exitOnDevSell: boolean;
  whaleDumpPct: number;
  sellOnGraduation: boolean;
}

export interface Config extends RawConfig {
  live: boolean;
  feeds: Set<"pumpportal" | "rpc" | "grpc">;
  nameBlacklist: RegExp[];
  creatorBlacklist: Set<string>;
  copyWallets: Set<string>;
  exits: ExitConfig;
  wsUrl: string;
}

export function parseLadder(s: string): LadderRung[] {
  const rungs = parseList(s).map((item) => {
    const [m, p] = item.split(":");
    const mult = Number(m);
    const sellPct = Number(p);
    if (!Number.isFinite(mult) || !Number.isFinite(sellPct) || mult <= 1 || sellPct <= 0 || sellPct > 100) {
      throw new Error(`Bad TP_LADDER entry "${item}" (expected e.g. 2:50)`);
    }
    return { mult, sellPct };
  });
  rungs.sort((a, b) => a.mult - b.mult);
  const total = rungs.reduce((a, r) => a + r.sellPct, 0);
  if (total > 100) throw new Error(`TP_LADDER sells more than 100% of the position (${total}%)`);
  return rungs;
}

export function deriveWsUrl(httpUrl: string): string {
  const u = new URL(httpUrl);
  u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
  return u.toString();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const raw = parsed.data;
  const feeds = new Set(parseList(raw.FEEDS).map((f) => f.toLowerCase())) as Set<"pumpportal" | "rpc" | "grpc">;
  for (const f of feeds) if (!["pumpportal", "rpc", "grpc"].includes(f)) throw new Error(`Unknown feed "${f}" in FEEDS`);
  if (feeds.size === 0) throw new Error("FEEDS must list at least one feed");
  if (feeds.has("grpc") && !raw.GRPC_ENDPOINT) throw new Error("FEEDS includes grpc but GRPC_ENDPOINT is not set");
  if (feeds.has("rpc") && raw.TRADE_FEED === "watched" && !feeds.has("pumpportal") && !feeds.has("grpc")) {
    throw new Error("TRADE_FEED=watched only streams trades for tokens we already know about; add pumpportal (or grpc) to FEEDS for launches, or set TRADE_FEED=firehose");
  }
  if (raw.MODE === "live" && !raw.WALLET_SECRET_KEY) throw new Error("MODE=live requires WALLET_SECRET_KEY");
  if (raw.SENDER === "helius") {
    // Helius Sender enforces a minimum tip: 0.001 SOL on all pathways, 0.000005 SOL in SWQoS-only mode.
    const minTip = raw.HELIUS_SWQOS_ONLY ? 0.000005 : 0.001;
    if (raw.TIP_SOL_MIN < minTip) raw.TIP_SOL_MIN = minTip;
    if (raw.TIP_SOL_MAX < raw.TIP_SOL_MIN) raw.TIP_SOL_MAX = raw.TIP_SOL_MIN;
  }
  const exits: ExitConfig = {
    ladder: parseLadder(raw.TP_LADDER),
    trailPct: raw.TRAIL_PCT,
    trailArmMult: raw.TRAIL_ARM_MULT,
    stopLossPct: raw.STOP_LOSS_PCT,
    maxHoldMin: raw.MAX_HOLD_MIN,
    minGainPctByMaxHold: raw.MIN_GAIN_PCT_BY_MAX_HOLD,
    hardMaxHoldMin: raw.HARD_MAX_HOLD_MIN,
    stagnationSec: raw.STAGNATION_SECONDS,
    exitOnDevSell: raw.EXIT_ON_DEV_SELL,
    whaleDumpPct: raw.WHALE_DUMP_PCT,
    sellOnGraduation: raw.SELL_ON_GRADUATION,
  };
  return {
    ...raw,
    live: raw.MODE === "live",
    feeds,
    nameBlacklist: parseList(raw.NAME_BLACKLIST).map((s) => new RegExp(s, "i")),
    creatorBlacklist: new Set(parseList(raw.CREATOR_BLACKLIST)),
    copyWallets: new Set(parseList(raw.COPY_WALLETS)),
    exits,
    wsUrl: raw.RPC_WS_URL ?? deriveWsUrl(raw.RPC_URL),
  };
}
