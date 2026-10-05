import { describe, expect, it } from "vitest";
import { parseLadder, type ExitConfig } from "../src/config.js";
import { replayTrade, type ReplayOptions } from "../src/strategy/replay.js";
import type { PathPoint } from "../src/strategy/tracker.js";

const exits: ExitConfig = {
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
// No costs, so results are pure price moves: stake 1 SOL.
const free: ReplayOptions = { stakeSol: 1, slippagePct: 0, feeSol: 0, delayMs: 0, tickMs: 1000 };
const buy = (dt: number, mcap: number): PathPoint => [dt, mcap, 0.1, 0.1, 0];

describe("replayTrade", () => {
  it("takes the ladder at 2x and 3x, then trails the rest", () => {
    const path = [buy(0, 30), buy(2000, 60), buy(4000, 90), buy(6000, 120), buy(8000, 60)];
    const r = replayTrade(path, 0, 500, exits, free)!;
    // 50% at 2x, 25% at 3x, last 25% at 2x after falling 50% from the 4x peak
    expect(r.pnlSol).toBeCloseTo(0.5 * 2 + 0.25 * 3 + 0.25 * 2 - 1, 6);
    expect(r.reason).toBe("take_profit_2x");
  });
  it("sells at the price after the delay, so a dump during the delay costs more", () => {
    const path = [buy(0, 30), [3000, 18, -1, 6, 1] as PathPoint, buy(4500, 9)];
    const fast = replayTrade(path, 0, 0, exits, free)!;
    const slow = replayTrade(path, 0, 0, exits, { ...free, delayMs: 1500 })!;
    expect(fast.reason).toBe("dev_sold");
    expect(fast.pnlSol).toBeCloseTo(18 / 30 - 1, 6);
    expect(slow.pnlSol).toBeLessThan(fast.pnlSol); // the buy also fills later, but the sell lands after the second drop
  });
  it("applies slippage on both fills and a fee per transaction", () => {
    const path = [buy(0, 30), buy(200_000, 30)];
    const r = replayTrade(path, 0, 0, exits, { stakeSol: 1, slippagePct: 2, feeSol: 0.01, delayMs: 0, tickMs: 1000 })!;
    expect(r.reason).toBe("stagnation");
    expect(r.pnlSol).toBeCloseTo(0.98 * 0.98 - 1 - 0.02, 6);
  });
  it("returns null when the path ends before the buy lands", () => {
    expect(replayTrade([buy(0, 30)], 0, 500, exits, free)).toBeNull();
  });
});
