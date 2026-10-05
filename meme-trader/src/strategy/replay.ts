import type { ExitConfig } from "../config.js";
import type { Position } from "../types.js";
import { evaluateExit, markPrice } from "./exits.js";
import type { PathPoint } from "./tracker.js";

export interface ReplayOptions {
  /** SOL put into the token (BUY_SOL) */
  stakeSol: number;
  /** lost on every fill to fees and price impact (like PAPER_SLIPPAGE_PCT) */
  slippagePct: number;
  /** fixed cost per transaction (like PAPER_FEE_SOL) */
  feeSol: number;
  /** from deciding to the fill landing, for the buy and for every sell */
  delayMs: number;
  /** how often exits are checked (the bot's exit loop runs every 1000 ms); 0 = on every trade */
  tickMs: number;
}

export interface ReplayResult {
  pnlSol: number;
  /** first exit reason, or end_of_data when the saved path ran out first */
  reason: string;
  heldMs: number;
  fills: number;
}

interface Pt {
  t: number;
  mcap: number;
  sol: number;
  pct: number;
  dev: boolean;
}

/**
 * Replays one trade on a saved price path with the bot's own exit rules (evaluateExit). The buy fills at the market
 * price `delayMs` after `decideAt`; exits are checked every `tickMs` and each sell fills at the market price `delayMs`
 * after the check that fired it. Market caps stand in for prices (same supply, so ratios match). Returns null when
 * the path has no price at entry or ends before it.
 */
export function replayTrade(points: PathPoint[], firstSeen: number, decideAt: number, exits: ExitConfig, o: ReplayOptions): ReplayResult | null {
  const pts: Pt[] = points.map((p) => ({ t: firstSeen + p[0], mcap: p[1], sol: p[2], pct: p[3], dev: p[4] === 1 }));
  const priceAt = (t: number): number => {
    let m = 0;
    for (const x of pts) {
      if (x.t > t) break;
      m = x.mcap;
    }
    return m;
  };
  const openAt = decideAt + o.delayMs;
  const entry = priceAt(openAt);
  const end = pts.length ? pts[pts.length - 1].t : 0;
  if (!(entry > 0) || end <= openAt) return null;

  const keep = 1 - o.slippagePct / 100;
  const pos: Position = {
    id: "replay",
    mint: "",
    symbol: "",
    name: "",
    dev: "",
    tokenProgram: "",
    strategy: "launch",
    openedAt: openAt,
    status: "open",
    venue: "curve",
    entryPrice: entry,
    tokens: 1,
    tokensBought: 1,
    costSol: o.stakeSol + o.feeSol,
    proceedsSol: 0,
    lastPrice: entry,
    peakPrice: entry,
    lastTradeTs: openAt,
    ladderDone: [],
    trailingArmed: false,
    fills: [],
    exitReasons: [],
    realizedPnlSol: 0,
  };
  let proceeds = 0;
  let fills = 1;
  let devSold = false;
  let lastTrade = openAt;
  let i = 0;
  let busyUntil = openAt;
  const sells: { t: number; pct: number }[] = [];
  const step = (now: number): void => {
    for (; i < pts.length && pts[i].t <= now; i++) {
      const x = pts[i];
      if (x.dev && x.sol < 0) devSold = true;
      if (x.sol < 0) sells.push({ t: x.t, pct: x.pct });
      if (x.t > openAt) {
        markPrice(pos, x.mcap, exits, x.t);
        lastTrade = x.t;
      }
    }
  };
  step(openAt);
  const times: number[] = [];
  if (o.tickMs > 0) for (let t = openAt + o.tickMs; t <= end; t += o.tickMs) times.push(t);
  else for (const x of pts) if (x.t > openAt) times.push(x.t);

  for (const now of times) {
    if (pos.status !== "open") break;
    step(now);
    if (now < busyUntil) continue; // the previous sell has not landed yet
    let whale = 0;
    for (const s of sells) if (s.t >= now - 6000 && s.pct > whale) whale = s.pct;
    const action = evaluateExit(pos, exits, { now, price: pos.lastPrice, devSold, whaleDumpPct: whale, graduated: false, lastTradeTs: lastTrade });
    if (!action) continue;
    const sold = Math.min(pos.tokens, (pos.tokens * action.pct) / 100);
    const fillAt = now + o.delayMs;
    proceeds += sold * o.stakeSol * keep * (priceAt(fillAt) / entry) * keep - o.feeSol;
    fills++;
    pos.tokens -= sold;
    pos.exitReasons.push(action.reason);
    for (const r of action.rungs) if (!pos.ladderDone.includes(r)) pos.ladderDone.push(r);
    if (action.rungs.length) pos.trailingArmed = true;
    busyUntil = fillAt;
    if (pos.tokens < 0.002) {
      pos.status = "closed";
      pos.closedAt = fillAt;
    }
  }
  if (pos.status === "open") {
    proceeds += pos.tokens * o.stakeSol * keep * (priceAt(end) / entry) * keep - o.feeSol;
    fills++;
    pos.exitReasons.push("end_of_data");
    pos.closedAt = end;
  }
  return {
    pnlSol: proceeds - o.stakeSol - o.feeSol,
    reason: pos.exitReasons[0] ?? "end_of_data",
    heldMs: (pos.closedAt ?? end) - openAt,
    fills,
  };
}
