import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlTail, tailLines } from "../src/dashboard/files.js";
import { extractMsg, normaliseReason, summarize, type ShadowRow, type StateFile } from "../src/dashboard/summary.js";
import type { Position, ScoredLaunch } from "../src/types.js";

const now = 1_800_000_000_000;
const launch = (over: Partial<ScoredLaunch>): ScoredLaunch => ({
  ts: now - 60_000,
  mint: "M" + Math.random().toString(36).slice(2, 8),
  symbol: "S",
  name: "n",
  dev: "d",
  decision: "skip",
  score: 10,
  hardFails: [],
  reasons: [],
  features: {},
  marketCapSol: 30,
  source: "pumpportal",
  ...over,
});
const pos = (over: Partial<Position>): Position => ({
  id: "p",
  mint: "MINT",
  symbol: "S",
  name: "n",
  dev: "d",
  tokenProgram: "T",
  strategy: "launch",
  openedAt: now - 120_000,
  status: "closed",
  venue: "curve",
  entryPrice: 1e-8,
  tokens: 0,
  tokensBought: 100,
  costSol: 0.05,
  proceedsSol: 0.06,
  lastPrice: 1e-8,
  peakPrice: 1e-8,
  lastTradeTs: now,
  ladderDone: [],
  trailingArmed: false,
  fills: [],
  exitReasons: ["take_profit_2x"],
  realizedPnlSol: 0.01,
  closedAt: now - 60_000,
  ...over,
});

describe("dashboard summary", () => {
  it("builds the funnel, reasons, score bins, buckets and shadow stats", () => {
    const launches = [
      launch({ hardFails: ["mayhem_mode"] }),
      launch({ hardFails: ["dev_holds_7.0pct"] }),
      launch({ features: { trigger: "window" }, hardFails: ["buyers_2<5", "net_inflow_0.1<1"], score: 22 }),
      launch({ ts: now - 30_000, features: { trigger: "early" }, decision: "buy", score: 70, mint: "BUYMINT" }),
      launch({ ts: now - 30 * 3600_000, features: { trigger: "window" }, score: 60 }), // outside 24h
    ];
    const shadow: ShadowRow[] = [
      { ts: now - 50_000, mint: launches[2].mint, symbol: "S", decision: "skip", reason: "buyers", mcapAtDecision: 30, maxMcapSeen: 30, mcapAtEnd: 90, endMult: 3 },
      { ts: now - 40_000, mint: "X", symbol: "X", decision: "skip", reason: "mayhem_mode", mcapAtDecision: 30, maxMcapSeen: 30, mcapAtEnd: 12, endMult: 0.4 },
      { ts: now - 40_000, mint: "Y", symbol: "Y", decision: "buy", reason: "stop_loss", mcapAtDecision: 30, maxMcapSeen: 30, mcapAtEnd: 12, endMult: 0.4 },
    ];
    const state: StateFile = { positions: { o: pos({ id: "o", status: "open", tokens: 100, closedAt: undefined }) }, paperSol: 4.9, dailyPnl: {}, consecutiveLosses: 1, learnedCreatorBlacklist: ["d"], closedCount: 1, realizedPnlSol: 0.01 };
    const s = summarize({
      now,
      windowHours: 24,
      mode: "paper",
      minScore: 55,
      state,
      launches,
      shadow,
      fills: [
        { ts: now - 120_000, side: "buy", tokens: 100, sol: 0.05, price: 5e-4, paper: true, venue: "curve", positionId: "p", mint: "MINT", symbol: "S", strategy: "launch" },
        { ts: now - 60_000, side: "sell", tokens: 100, sol: 0.06, price: 6e-4, paper: true, venue: "curve", positionId: "p", mint: "MINT", symbol: "S", strategy: "launch" },
      ],
      closed: [pos({})],
      logLines: ['{"ts":"2027-01-01T00:00:00.000Z","level":"info","scope":"bot","msg":"status | paper | bal 4.9"}'],
      lastLogAt: now - 10_000,
      kill: "none",
    });
    expect(s.funnel).toEqual({ total: 4, prefiltered: 2, observed: 2, skippedAfterObservation: 1, bought: 1 });
    expect(s.skipReasons.map((r) => r.reason)).toEqual(expect.arrayContaining(["mayhem_mode", "dev_holds", "buyers", "net_inflow"]));
    expect(s.scoreBins[2].count).toBe(1); // score 22
    expect(s.scoreBins[7].count).toBe(1); // score 70
    expect(s.perBucket.reduce((a, b) => a + b.launches, 0)).toBe(4);
    expect(s.shadow.withOutcome).toBe(2);
    expect(s.shadow.pctAbove2x).toBe(50);
    expect(s.shadow.missed[0].endMult).toBe(3);
    expect(s.shadow.missed[0].score).toBe(22);
    expect(s.shadow.dodged[0].mint).toBe("X");
    expect(s.balance.openCount).toBe(1);
    expect(s.balance.winRate).toBe(100);
    expect(s.equity.map((e) => e.cash)).toEqual([4.84, 4.9]);
    expect(s.balance.paperStartSol).toBe(4.89);
    expect(s.pnlCurve[0].cum).toBe(0.01);
    expect(s.alive).toBe(true);
    expect(s.lastStatus).toContain("status | paper");
    expect(s.decisions[0].decision).toBe("buy");
  });
  it("normalises reason suffixes", () => {
    expect(normaliseReason("dev_holds_7.0pct")).toBe("dev_holds");
    expect(normaliseReason("buyers_2<5")).toBe("buyers");
    expect(normaliseReason("net_inflow_-1.6<1")).toBe("net_inflow");
    expect(normaliseReason("bundle_5w_9pct")).toBe("bundle");
    expect(normaliseReason("risk:max_positions_3")).toBe("risk:max_positions");
    expect(normaliseReason("mayhem_mode")).toBe("mayhem_mode");
    expect(normaliseReason("mcap_125>90")).toBe("mcap");
  });
  it("tails JSONL incrementally and handles truncation", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-dash-"));
    const file = path.join(dir, "x.jsonl");
    fs.writeFileSync(file, JSON.stringify({ ts: now - 1000, a: 1 }) + "\n");
    const t = new JsonlTail<{ ts: number; a: number }>(file, (r) => r.ts, 86_400_000);
    expect(t.refresh(now).length).toBe(1);
    fs.appendFileSync(file, JSON.stringify({ ts: now - 500, a: 2 }) + "\n" + '{"ts":' );
    expect(t.refresh(now).map((r) => r.a)).toEqual([1, 2]);
    fs.appendFileSync(file, `${now},"a":3}\n`);
    expect(t.refresh(now).map((r) => r.a)).toEqual([1, 2, 3]);
    fs.writeFileSync(file, JSON.stringify({ ts: now, a: 9 }) + "\n"); // rotated / truncated
    expect(t.refresh(now).map((r) => r.a)).toEqual([9]);
    expect(tailLines(file, 5)).toEqual([JSON.stringify({ ts: now, a: 9 })]);
  });
  it("formats log lines", () => {
    expect(extractMsg('{"ts":"2027-01-01T12:34:56.789Z","level":"warn","scope":"ws","msg":"closed","url":"h"}')).toBe("12:34:56 WARN  [ws] closed url=h");
    expect(extractMsg("plain")).toBe("plain");
  });
});
