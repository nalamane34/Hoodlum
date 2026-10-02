import type { Position, ScoredLaunch } from "../types.js";

export interface FillRow {
  ts: number;
  side: "buy" | "sell";
  tokens: number;
  sol: number;
  price: number;
  paper: boolean;
  venue: string;
  reason?: string;
  positionId: string;
  mint: string;
  symbol: string;
  strategy: string;
}

export interface ShadowRow {
  ts: number;
  mint: string;
  symbol: string;
  decision: "skip" | "buy" | "failed";
  reason: string;
  mcapAtDecision: number;
  maxMcapSeen: number;
  mcapAtEnd: number | null;
  endMult: number | null;
}

export interface StateFile {
  positions: Record<string, Position>;
  paperSol: number;
  dailyPnl: Record<string, number>;
  consecutiveLosses: number;
  learnedCreatorBlacklist: string[];
  closedCount: number;
  realizedPnlSol: number;
}

export interface SummaryInput {
  now: number;
  windowHours: number;
  mode: "paper" | "live" | "unknown";
  minScore: number;
  state: StateFile | null;
  launches: ScoredLaunch[];
  shadow: ShadowRow[];
  fills: FillRow[];
  closed: Position[];
  logLines: string[];
  lastLogAt: number | null;
  kill: "none" | "halt" | "liquidate";
}

export interface Summary {
  generatedAt: number;
  windowHours: number;
  mode: string;
  alive: boolean;
  lastLogAt: number | null;
  lastStatus: string | null;
  kill: string;
  balance: {
    paperSol: number | null;
    paperStartSol: number | null;
    realizedPnlSol: number;
    todayPnlSol: number;
    windowPnlSol: number;
    closedCount: number;
    closedInWindow: number;
    winRate: number | null;
    consecutiveLosses: number;
    openCount: number;
    learnedBlacklist: number;
  };
  equity: { ts: number; cash: number }[];
  pnlCurve: { ts: number; cum: number }[];
  open: Array<{ symbol: string; mint: string; strategy: string; openedAt: number; entryPrice: number; lastPrice: number; mult: number; tokens: number; costSol: number; proceedsSol: number; venue: string; trailingArmed: boolean; ladderDone: number }>;
  closed: Array<{ symbol: string; mint: string; strategy: string; closedAt: number; heldSec: number; pnlSol: number; pnlPct: number; reasons: string }>;
  funnel: { total: number; prefiltered: number; observed: number; skippedAfterObservation: number; bought: number };
  skipReasons: { reason: string; count: number }[];
  scoreBins: { label: string; from: number; count: number }[];
  minScore: number;
  perBucket: { ts: number; launches: number; observed: number; bought: number }[];
  bucketMs: number;
  shadow: {
    count: number;
    withOutcome: number;
    bins: { label: string; count: number }[];
    medianEndMult: number | null;
    pctAbove2x: number | null;
    missed: Array<{ symbol: string; mint: string; reason: string; endMult: number; score: number | null; ts: number }>;
    dodged: Array<{ symbol: string; mint: string; reason: string; endMult: number; score: number | null; ts: number }>;
  };
  decisions: Array<{ ts: number; symbol: string; mint: string; decision: string; score: number; fails: string; trigger: string; mcapSol: number; buyers: number | null; netSol: number | null }>;
  log: string[];
}

const r = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

export function normaliseReason(f: string): string {
  return f.replace(/^risk:/, "risk:").replace(/_-?[0-9][0-9.]*(?:[<>].*|pct|w.*|sol.*|tx.*)?$/i, "").replace(/_$/, "");
}

export function summarize(input: SummaryInput): Summary {
  const { now, windowHours, state } = input;
  const since = now - windowHours * 3600_000;
  const launches = input.launches.filter((l) => l.ts >= since);
  const shadow = input.shadow.filter((s) => s.ts >= since);
  const closedAll = input.closed;
  const closedWin = closedAll.filter((p) => (p.closedAt ?? 0) >= since);

  // funnel + skip reasons + score bins
  const funnel = { total: launches.length, prefiltered: 0, observed: 0, skippedAfterObservation: 0, bought: 0 };
  const reasonCount = new Map<string, number>();
  const scoreBins = Array.from({ length: 10 }, (_, i) => ({ label: `${i * 10}-${i * 10 + 9}`, from: i * 10, count: 0 }));
  scoreBins[9].label = "90-100";
  for (const l of launches) {
    const observed = l.features && l.features.trigger !== undefined && l.features.trigger !== null;
    if (l.decision === "buy") funnel.bought++;
    else if (observed) funnel.skippedAfterObservation++;
    else funnel.prefiltered++;
    if (observed) {
      funnel.observed++;
      const b = Math.min(9, Math.max(0, Math.floor(l.score / 10)));
      scoreBins[b].count++;
    }
    for (const f of l.hardFails) {
      const k = normaliseReason(f);
      reasonCount.set(k, (reasonCount.get(k) ?? 0) + 1);
    }
  }
  let skipReasons = [...reasonCount.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
  if (skipReasons.length > 12) {
    const other = skipReasons.slice(11).reduce((a, x) => a + x.count, 0);
    skipReasons = [...skipReasons.slice(0, 11), { reason: "other", count: other }];
  }

  // time buckets
  const bucketMs = windowHours <= 3 ? 10 * 60_000 : windowHours <= 12 ? 30 * 60_000 : windowHours <= 48 ? 3600_000 : 6 * 3600_000;
  const firstBucket = Math.floor(since / bucketMs) * bucketMs;
  const nBuckets = Math.ceil((now - firstBucket) / bucketMs);
  const perBucket = Array.from({ length: nBuckets }, (_, i) => ({ ts: firstBucket + i * bucketMs, launches: 0, observed: 0, bought: 0 }));
  for (const l of launches) {
    const i = Math.floor((l.ts - firstBucket) / bucketMs);
    if (i < 0 || i >= nBuckets) continue;
    perBucket[i].launches++;
    if (l.features?.trigger !== undefined && l.features?.trigger !== null) perBucket[i].observed++;
    if (l.decision === "buy") perBucket[i].bought++;
  }

  // shadow outcomes
  const scoreByMint = new Map<string, number>();
  for (const l of input.launches) scoreByMint.set(l.mint, l.score);
  const withOutcome = shadow.filter((s) => s.decision === "skip" && typeof s.endMult === "number" && s.endMult > 0);
  const binsDef: { label: string; test: (m: number) => boolean }[] = [
    { label: "<0.5x", test: (m) => m < 0.5 },
    { label: "0.5-0.9x", test: (m) => m >= 0.5 && m < 0.9 },
    { label: "0.9-1.1x", test: (m) => m >= 0.9 && m < 1.1 },
    { label: "1.1-2x", test: (m) => m >= 1.1 && m < 2 },
    { label: "2-5x", test: (m) => m >= 2 && m < 5 },
    { label: ">5x", test: (m) => m >= 5 },
  ];
  const bins = binsDef.map((b) => ({ label: b.label, count: withOutcome.filter((s) => b.test(s.endMult as number)).length }));
  const mults = withOutcome.map((s) => s.endMult as number).sort((a, b) => a - b);
  const medianEndMult = mults.length ? mults[Math.floor(mults.length / 2)] : null;
  const pctAbove2x = mults.length ? (mults.filter((m) => m >= 2).length / mults.length) * 100 : null;
  const row = (s: ShadowRow) => ({ symbol: s.symbol, mint: s.mint, reason: s.reason, endMult: r(s.endMult as number, 2), score: scoreByMint.get(s.mint) ?? null, ts: s.ts });
  const missed = [...withOutcome].sort((a, b) => (b.endMult as number) - (a.endMult as number)).slice(0, 8).map(row);
  const dodged = [...withOutcome].sort((a, b) => (a.endMult as number) - (b.endMult as number)).slice(0, 8).map(row);

  // positions
  const openPositions = state ? Object.values(state.positions).filter((p) => p.status === "open") : [];
  const open = openPositions
    .sort((a, b) => b.openedAt - a.openedAt)
    .map((p) => ({
      symbol: p.symbol,
      mint: p.mint,
      strategy: p.strategy,
      openedAt: p.openedAt,
      entryPrice: p.entryPrice,
      lastPrice: p.lastPrice,
      mult: p.entryPrice > 0 ? r(p.lastPrice / p.entryPrice, 3) : 0,
      tokens: Math.round(p.tokens),
      costSol: r(p.costSol),
      proceedsSol: r(p.proceedsSol),
      venue: p.venue,
      trailingArmed: p.trailingArmed,
      ladderDone: p.ladderDone.length,
    }));
  const closed = [...closedAll]
    .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
    .slice(0, 25)
    .map((p) => ({
      symbol: p.symbol,
      mint: p.mint,
      strategy: p.strategy,
      closedAt: p.closedAt ?? 0,
      heldSec: Math.round(((p.closedAt ?? 0) - p.openedAt) / 1000),
      pnlSol: r(p.realizedPnlSol),
      pnlPct: p.costSol > 0 ? r((p.realizedPnlSol / p.costSol) * 100, 1) : 0,
      reasons: p.exitReasons.join(","),
    }));
  const wins = closedAll.filter((p) => p.realizedPnlSol > 0).length;

  // pnl curve (window) and equity sparkline from fills
  const pnlCurve: { ts: number; cum: number }[] = [];
  let cum = 0;
  for (const p of [...closedWin].sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0))) {
    cum += p.realizedPnlSol;
    pnlCurve.push({ ts: p.closedAt ?? 0, cum: r(cum) });
  }
  const fillsSorted = [...input.fills].sort((a, b) => a.ts - b.ts);
  const equity: { ts: number; cash: number }[] = [];
  let paperStartSol: number | null = null;
  if (state && typeof state.paperSol === "number" && fillsSorted.length) {
    const deltas = fillsSorted.map((f) => (f.side === "buy" ? -f.sol : f.sol));
    const total = deltas.reduce((a, b) => a + b, 0);
    let cash = state.paperSol - total;
    paperStartSol = r(cash);
    for (let i = 0; i < fillsSorted.length; i++) {
      cash += deltas[i];
      equity.push({ ts: fillsSorted[i].ts, cash: r(cash) });
    }
  }

  const today = new Date(now).toISOString().slice(0, 10);
  const lastStatus = [...input.logLines].reverse().find((l) => l.includes("status |")) ?? null;
  return {
    generatedAt: now,
    windowHours,
    mode: input.mode,
    alive: input.lastLogAt !== null && now - input.lastLogAt < 120_000,
    lastLogAt: input.lastLogAt,
    lastStatus: lastStatus ? extractMsg(lastStatus) : null,
    kill: input.kill,
    balance: {
      paperSol: state && input.mode !== "live" ? r(state.paperSol) : null,
      paperStartSol: input.mode !== "live" ? paperStartSol : null,
      realizedPnlSol: r(state?.realizedPnlSol ?? 0),
      todayPnlSol: r(state?.dailyPnl?.[today] ?? 0),
      windowPnlSol: r(closedWin.reduce((a, p) => a + p.realizedPnlSol, 0)),
      closedCount: state?.closedCount ?? closedAll.length,
      closedInWindow: closedWin.length,
      winRate: closedAll.length ? r((wins / closedAll.length) * 100, 1) : null,
      consecutiveLosses: state?.consecutiveLosses ?? 0,
      openCount: open.length,
      learnedBlacklist: state?.learnedCreatorBlacklist?.length ?? 0,
    },
    equity: equity.slice(-60),
    pnlCurve,
    open,
    closed,
    funnel,
    skipReasons,
    scoreBins,
    minScore: input.minScore,
    perBucket,
    bucketMs,
    shadow: { count: shadow.length, withOutcome: withOutcome.length, bins, medianEndMult: medianEndMult === null ? null : r(medianEndMult, 2), pctAbove2x: pctAbove2x === null ? null : r(pctAbove2x, 1), missed, dodged },
    decisions: [...launches]
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 30)
      .map((l) => ({
        ts: l.ts,
        symbol: l.symbol,
        mint: l.mint,
        decision: l.decision,
        score: l.score,
        fails: l.hardFails.join(", "),
        trigger: String(l.features?.trigger ?? "prefilter"),
        mcapSol: l.marketCapSol,
        buyers: typeof l.features?.uniqueBuyers === "number" ? (l.features.uniqueBuyers as number) : null,
        netSol: typeof l.features?.netSol === "number" ? (l.features.netSol as number) : null,
      })),
    log: input.logLines.slice(-60).map(extractMsg),
  };
}

/** bot.log lines are JSON; render them as `HH:MM:SS LEVEL [scope] message`. */
export function extractMsg(line: string): string {
  try {
    const j = JSON.parse(line) as { ts?: string; level?: string; scope?: string; msg?: string; [k: string]: unknown };
    const extra: string[] = [];
    for (const [k, v] of Object.entries(j)) {
      if (["ts", "level", "scope", "msg"].includes(k)) continue;
      if (v === undefined) continue;
      extra.push(`${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
    }
    return `${(j.ts ?? "").slice(11, 19)} ${(j.level ?? "").toUpperCase().padEnd(5)} [${j.scope ?? ""}] ${j.msg ?? ""}${extra.length ? " " + extra.join(" ") : ""}`;
  } catch {
    return line;
  }
}
