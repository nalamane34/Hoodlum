import type { ExitConfig } from "../config.js";
import type { Position } from "../types.js";

export interface ExitContext {
  now: number;
  price: number;
  devSold: boolean;
  whaleDumpPct: number;
  graduated: boolean;
  lastTradeTs: number;
}

export interface ExitAction {
  /** percent of the remaining tokens to sell */
  pct: number;
  reason: string;
  urgent: boolean;
  rungs: number[];
}

/** Updates lastPrice / peakPrice / trailingArmed from a new price. Pure bookkeeping, no decisions. */
export function markPrice(pos: Position, price: number, cfg: ExitConfig, ts: number): void {
  if (!(price > 0)) return;
  pos.lastPrice = price;
  if (price > pos.peakPrice) pos.peakPrice = price;
  if (!pos.trailingArmed && pos.entryPrice > 0 && price >= pos.entryPrice * cfg.trailArmMult) pos.trailingArmed = true;
  pos.lastTradeTs = Math.max(pos.lastTradeTs, ts);
}

/** Decides the single most important exit action for a position right now, or null to hold. */
export function evaluateExit(pos: Position, cfg: ExitConfig, ctx: ExitContext): ExitAction | null {
  if (pos.status !== "open" || pos.tokens <= 0 || pos.entryPrice <= 0) return null;
  const price = ctx.price > 0 ? ctx.price : pos.lastPrice;
  if (!(price > 0)) return null;
  const mult = price / pos.entryPrice;
  const ageMs = ctx.now - pos.openedAt;

  if (ctx.devSold && cfg.exitOnDevSell) return { pct: 100, reason: "dev_sold", urgent: true, rungs: [] };
  if (cfg.whaleDumpPct > 0 && ctx.whaleDumpPct >= cfg.whaleDumpPct) return { pct: 100, reason: `whale_dump_${ctx.whaleDumpPct.toFixed(1)}pct`, urgent: true, rungs: [] };
  if (ctx.graduated && cfg.sellOnGraduation) return { pct: 100, reason: "graduation", urgent: false, rungs: [] };
  if (mult <= 1 - cfg.stopLossPct / 100) return { pct: 100, reason: `stop_loss_${((mult - 1) * 100).toFixed(0)}pct`, urgent: true, rungs: [] };

  const rungs: number[] = [];
  let originalPct = 0;
  cfg.ladder.forEach((r, i) => {
    if (!pos.ladderDone.includes(i) && mult >= r.mult) {
      rungs.push(i);
      originalPct += r.sellPct;
    }
  });
  if (rungs.length) {
    const alreadySold = pos.tokensBought - pos.tokens;
    const targetTokens = Math.max(0, Math.min(pos.tokens, (originalPct / 100) * pos.tokensBought - Math.max(0, alreadySold - ladderSoldSoFar(pos, cfg))));
    let pct = pos.tokens > 0 ? (targetTokens / pos.tokens) * 100 : 100;
    if (!(pct > 0)) pct = (originalPct / 100) * (pos.tokensBought / pos.tokens) * 100;
    pct = Math.min(100, Math.max(1, pct));
    if (pct >= 97) pct = 100;
    return { pct, reason: `take_profit_${cfg.ladder[rungs[rungs.length - 1]].mult}x`, urgent: false, rungs };
  }

  const armed = pos.trailingArmed || mult >= cfg.trailArmMult || pos.ladderDone.length > 0;
  if (armed && pos.peakPrice > 0 && price <= pos.peakPrice * (1 - cfg.trailPct / 100)) {
    return { pct: 100, reason: `trailing_stop_${(((price - pos.peakPrice) / pos.peakPrice) * 100).toFixed(0)}pct_from_peak`, urgent: false, rungs: [] };
  }

  if (cfg.hardMaxHoldMin > 0 && ageMs >= cfg.hardMaxHoldMin * 60_000) return { pct: 100, reason: "max_hold", urgent: false, rungs: [] };
  if (cfg.maxHoldMin > 0 && ageMs >= cfg.maxHoldMin * 60_000 && mult < 1 + cfg.minGainPctByMaxHold / 100) {
    return { pct: 100, reason: `time_stop_${((mult - 1) * 100).toFixed(0)}pct`, urgent: false, rungs: [] };
  }
  if (cfg.stagnationSec > 0 && ageMs >= cfg.stagnationSec * 1000 && ctx.now - ctx.lastTradeTs >= cfg.stagnationSec * 1000) {
    return { pct: 100, reason: "stagnation", urgent: false, rungs: [] };
  }
  return null;
}

/** Tokens the completed ladder rungs were supposed to sell (used to keep rung sizing relative to the original position). */
function ladderSoldSoFar(pos: Position, cfg: ExitConfig): number {
  let pct = 0;
  for (const i of pos.ladderDone) pct += cfg.ladder[i]?.sellPct ?? 0;
  return (pct / 100) * pos.tokensBought;
}
