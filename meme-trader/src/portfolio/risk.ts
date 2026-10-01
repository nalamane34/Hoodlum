import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { Store } from "./store.js";
import { utcDayKey } from "../util.js";

export interface OpenCheck {
  ok: boolean;
  reason?: string;
}

/** Hard limits that decide whether a new position may be opened. */
export class RiskManager {
  constructor(
    private cfg: Config,
    private store: Store,
    private log: Logger,
  ) {}

  dailyPnl(ts = Date.now()): number {
    return this.store.state.dailyPnl[utcDayKey(ts)] ?? 0;
  }

  canOpen(input: { solNeeded: number; walletSol: number | null; openPositions: number; inflight: number }): OpenCheck {
    const kill = this.store.killSwitch();
    if (kill !== "none") return { ok: false, reason: `kill_switch_${kill}` };
    if (input.openPositions + input.inflight >= this.cfg.MAX_POSITIONS) return { ok: false, reason: `max_positions_${this.cfg.MAX_POSITIONS}` };
    const pnl = this.dailyPnl();
    if (pnl <= -Math.abs(this.cfg.MAX_DAILY_LOSS_SOL)) return { ok: false, reason: `daily_loss_limit_${pnl.toFixed(3)}` };
    const s = this.store.state;
    if (this.cfg.MAX_CONSECUTIVE_LOSSES > 0 && s.consecutiveLosses >= this.cfg.MAX_CONSECUTIVE_LOSSES && s.lastLossAt) {
      const until = s.lastLossAt + this.cfg.LOSS_COOLDOWN_MIN * 60_000;
      if (Date.now() < until) return { ok: false, reason: `loss_cooldown_${Math.ceil((until - Date.now()) / 60_000)}min` };
      s.consecutiveLosses = 0;
    }
    if (input.walletSol !== null && input.walletSol - input.solNeeded < this.cfg.MIN_RESERVE_SOL) {
      return { ok: false, reason: `insufficient_balance_${input.walletSol.toFixed(3)}` };
    }
    return { ok: true };
  }

  onClosed(pnlSol: number, ts = Date.now()): void {
    const key = utcDayKey(ts);
    const s = this.store.state;
    s.dailyPnl[key] = (s.dailyPnl[key] ?? 0) + pnlSol;
    s.realizedPnlSol += pnlSol;
    s.closedCount += 1;
    if (pnlSol < 0) {
      s.consecutiveLosses += 1;
      s.lastLossAt = ts;
    } else {
      s.consecutiveLosses = 0;
    }
    for (const k of Object.keys(s.dailyPnl)) if (k < utcDayKey(ts - 14 * 86_400_000)) delete s.dailyPnl[k];
    this.store.save();
    if (s.dailyPnl[key] <= -Math.abs(this.cfg.MAX_DAILY_LOSS_SOL)) this.log.warn("daily loss limit reached; no new entries today", { pnl: s.dailyPnl[key] });
  }
}
