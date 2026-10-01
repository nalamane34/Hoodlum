import { Connection, PublicKey } from "@solana/web3.js";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { clamp, LAMPORTS_PER_SOL, percentile } from "../util.js";

export const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

interface TipFloor {
  landed_tips_50th_percentile: number;
  landed_tips_75th_percentile: number;
  landed_tips_95th_percentile: number;
}

/** Decides priority fees and tips from live network data, with clamps from config. */
export class FeeOracle {
  private prioCache: { at: number; micro: number } | null = null;
  private tipCache: { at: number; sol: number } | null = null;

  /**
   * @param hotAccounts accounts that pump.fun trades lock as writable (the protocol fee recipients). getRecentPrioritizationFees
   *   reports the per-slot minimum fee among transactions locking any of these, which is what it costs to land a trade there.
   */
  constructor(
    private conn: Connection,
    private cfg: Config,
    private log: Logger,
    private hotAccounts: PublicKey[] = [],
  ) {}

  /** Micro-lamports per compute unit. */
  async priorityMicroLamports(multiplier = 1): Promise<number> {
    if (this.cfg.PRIORITY_FEE_MODE === "fixed") {
      return Math.round(clamp(this.cfg.PRIORITY_FEE_FIXED_MICRO * multiplier, this.cfg.PRIORITY_FEE_MIN_MICRO, this.cfg.PRIORITY_FEE_MAX_MICRO));
    }
    const now = Date.now();
    if (!this.prioCache || now - this.prioCache.at > 4000) {
      try {
        const fees = await this.conn.getRecentPrioritizationFees(this.hotAccounts.length ? { lockedWritableAccounts: this.hotAccounts.slice(0, 8) } : undefined);
        const values = fees.map((f) => f.prioritizationFee).filter((x) => x > 0);
        const p75 = values.length ? percentile(values, 75) : 0;
        this.prioCache = { at: now, micro: p75 };
      } catch (e) {
        this.log.debug("getRecentPrioritizationFees failed, using fallback", { err: String(e) });
        this.prioCache = { at: now, micro: this.cfg.PRIORITY_FEE_MIN_MICRO * 5 };
      }
    }
    return Math.round(clamp(this.prioCache.micro * multiplier, this.cfg.PRIORITY_FEE_MIN_MICRO, this.cfg.PRIORITY_FEE_MAX_MICRO));
  }

  /** Tip in lamports for jito / helius senders. */
  async tipLamports(multiplier = 1): Promise<number> {
    const now = Date.now();
    if (!this.tipCache || now - this.tipCache.at > 10_000) {
      try {
        const res = await fetch("https://bundles.jito.wtf/api/v1/bundles/tip_floor", { signal: AbortSignal.timeout(2500) });
        const data = (await res.json()) as TipFloor[];
        const f = data[0];
        // Between the median and 75th percentile of recently landed tips: enough to land, not top of book.
        const sol = f ? (f.landed_tips_50th_percentile + f.landed_tips_75th_percentile) / 2 : this.cfg.TIP_SOL_MIN;
        this.tipCache = { at: now, sol };
      } catch (e) {
        this.log.debug("tip floor fetch failed, using min tip", { err: String(e) });
        this.tipCache = { at: now, sol: this.cfg.TIP_SOL_MIN };
      }
    }
    const sol = clamp(this.tipCache.sol * multiplier, this.cfg.TIP_SOL_MIN, this.cfg.TIP_SOL_MAX);
    return Math.round(sol * LAMPORTS_PER_SOL);
  }
}
