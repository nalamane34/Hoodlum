import { Connection, PublicKey } from "@solana/web3.js";
import type { RateLimiter } from "../util.js";

export interface WalletInfo {
  txCount: number; // capped at the sample size
  ageSec: number | null;
  fresh: boolean;
}

/** Cheap wallet-history lookups (one getSignaturesForAddress call), cached. */
export class WalletInfoCache {
  private cache = new Map<string, { at: number; info: WalletInfo }>();
  constructor(
    private conn: Connection,
    private limiter: RateLimiter,
    private sample = 25,
    private ttlMs = 10 * 60_000,
  ) {}

  async info(wallet: string, maxWaitMs = 1500): Promise<WalletInfo | null> {
    const hit = this.cache.get(wallet);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.info;
    if (!(await this.limiter.take(maxWaitMs))) return null;
    try {
      const sigs = await this.conn.getSignaturesForAddress(new PublicKey(wallet), { limit: this.sample }, "confirmed");
      const times = sigs.map((s) => s.blockTime ?? 0).filter((t) => t > 0);
      const oldest = times.length ? Math.min(...times) : null;
      const info: WalletInfo = {
        txCount: sigs.length,
        ageSec: oldest ? Math.max(0, Math.floor(Date.now() / 1000) - oldest) : null,
        fresh: sigs.length <= 2,
      };
      if (this.cache.size > 20_000) this.cache.clear();
      this.cache.set(wallet, { at: Date.now(), info });
      return info;
    } catch {
      return null;
    }
  }
}
