import { describe, expect, it } from "vitest";
import { parseLadder, type ExitConfig } from "../src/config.js";
import { evaluateExit, markPrice } from "../src/strategy/exits.js";
import type { Position } from "../src/types.js";

const cfg: ExitConfig = {
  ladder: parseLadder("2:50,3:25"),
  trailPct: 30,
  trailArmMult: 1.3,
  stopLossPct: 35,
  maxHoldMin: 10,
  minGainPctByMaxHold: 10,
  hardMaxHoldMin: 90,
  stagnationSec: 90,
  exitOnDevSell: true,
  whaleDumpPct: 5,
  sellOnGraduation: false,
};

function pos(over: Partial<Position> = {}): Position {
  const t0 = 1_000_000;
  return {
    id: "p1",
    mint: "M",
    symbol: "T",
    name: "T",
    dev: "D",
    tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    strategy: "launch",
    openedAt: t0,
    status: "open",
    venue: "curve",
    entryPrice: 1e-7,
    tokens: 500_000,
    tokensBought: 500_000,
    costSol: 0.05,
    proceedsSol: 0,
    lastPrice: 1e-7,
    peakPrice: 1e-7,
    lastTradeTs: t0,
    ladderDone: [],
    trailingArmed: false,
    fills: [],
    exitReasons: [],
    realizedPnlSol: 0,
    ...over,
  };
}
const ctx = (price: number, over: Partial<Parameters<typeof evaluateExit>[2]> = {}) => ({ now: 1_000_000 + 5000, price, devSold: false, whaleDumpPct: 0, graduated: false, lastTradeTs: 1_000_000 + 4000, ...over });

describe("exits", () => {
  it("holds a flat position", () => {
    expect(evaluateExit(pos(), cfg, ctx(1e-7))).toBeNull();
  });
  it("stop loss fires at -35%", () => {
    const a = evaluateExit(pos(), cfg, ctx(0.64e-7));
    expect(a?.pct).toBe(100);
    expect(a?.reason).toMatch(/stop_loss/);
    expect(a?.urgent).toBe(true);
  });
  it("dev sell is a panic exit", () => {
    const a = evaluateExit(pos(), cfg, ctx(1.5e-7, { devSold: true }));
    expect(a?.reason).toBe("dev_sold");
    expect(a?.urgent).toBe(true);
  });
  it("whale dump is a panic exit", () => {
    expect(evaluateExit(pos(), cfg, ctx(1.5e-7, { whaleDumpPct: 6 }))?.reason).toMatch(/whale_dump/);
    expect(evaluateExit(pos(), cfg, ctx(1.5e-7, { whaleDumpPct: 4 }))).toBeNull();
  });
  it("first ladder rung sells 50% of the original at 2x", () => {
    const a = evaluateExit(pos(), cfg, ctx(2.1e-7));
    expect(a?.rungs).toEqual([0]);
    expect(a?.pct).toBeCloseTo(50, 5);
    expect(a?.reason).toBe("take_profit_2x");
  });
  it("second rung sells 25% of original = 50% of what remains", () => {
    const p = pos({ tokens: 250_000, ladderDone: [0], trailingArmed: true, peakPrice: 3.1e-7 });
    const a = evaluateExit(p, cfg, ctx(3.1e-7));
    expect(a?.rungs).toEqual([1]);
    expect(a?.pct).toBeCloseTo(50, 5);
  });
  it("jumping straight past both rungs sells 75% of original at once", () => {
    const a = evaluateExit(pos(), cfg, ctx(3.5e-7));
    expect(a?.rungs).toEqual([0, 1]);
    expect(a?.pct).toBeCloseTo(75, 5);
  });
  it("trailing stop closes the moonbag 30% off the peak once armed", () => {
    const p = pos({ tokens: 125_000, ladderDone: [0, 1], trailingArmed: true, peakPrice: 5e-7 });
    expect(evaluateExit(p, cfg, ctx(3.6e-7))).toBeNull();
    const a = evaluateExit(p, cfg, ctx(3.4e-7));
    expect(a?.pct).toBe(100);
    expect(a?.reason).toMatch(/trailing_stop/);
  });
  it("trailing arms automatically at 1.3x via markPrice", () => {
    const p = pos();
    markPrice(p, 1.35e-7, cfg, 1_000_500);
    expect(p.trailingArmed).toBe(true);
    expect(p.peakPrice).toBe(1.35e-7);
    markPrice(p, 1.2e-7, cfg, 1_000_600);
    expect(p.peakPrice).toBe(1.35e-7);
  });
  it("time stop after 10 minutes without +10%", () => {
    const a = evaluateExit(pos(), cfg, { ...ctx(1.05e-7), now: 1_000_000 + 10 * 60_000 + 1, lastTradeTs: 1_000_000 + 10 * 60_000 });
    expect(a?.reason).toMatch(/time_stop/);
    const b = evaluateExit(pos(), cfg, { ...ctx(1.2e-7), now: 1_000_000 + 10 * 60_000 + 1, lastTradeTs: 1_000_000 + 10 * 60_000 });
    expect(b).toBeNull();
  });
  it("stagnation exit when no trades for 90s", () => {
    const a = evaluateExit(pos(), cfg, { ...ctx(1.1e-7), now: 1_000_000 + 100_000, lastTradeTs: 1_000_000 + 5_000 });
    expect(a?.reason).toBe("stagnation");
  });
  it("graduation only sells when configured", () => {
    expect(evaluateExit(pos(), cfg, ctx(1.1e-7, { graduated: true }))).toBeNull();
    expect(evaluateExit(pos(), { ...cfg, sellOnGraduation: true }, ctx(1.1e-7, { graduated: true }))?.reason).toBe("graduation");
  });
});
