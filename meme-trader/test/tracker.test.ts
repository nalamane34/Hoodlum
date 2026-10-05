import { describe, expect, it } from "vitest";
import { TokenTracker } from "../src/strategy/tracker.js";
import type { LaunchEvent, TradeTick } from "../src/types.js";

const launch: LaunchEvent = {
  mint: "M",
  dev: "DEV",
  creator: "DEV",
  bondingCurve: "BC",
  name: "n",
  symbol: "S",
  uri: "",
  signature: "sig0",
  slot: 100,
  ts: 1000,
  initialBuyTokens: 20_000_000,
  initialBuySol: 0.6,
  vSol: 30.6,
  vTokens: 1_053_000_000,
  totalSupply: 1_000_000_000,
  isMayhem: false,
  solQuoted: true,
  source: "rpc",
};
const tick = (over: Partial<TradeTick>): TradeTick => ({
  mint: "M",
  user: "u",
  isBuy: true,
  sol: 0.2,
  tokens: 6_000_000,
  vSol: 31,
  vTokens: 1_040_000_000,
  realTokens: 770_000_000,
  slot: 101,
  ts: 1500,
  signature: "s",
  creator: "DEV",
  source: "rpc",
  ...over,
});

describe("TokenTracker", () => {
  it("builds an observation with unique buyers, inflow, dev tracking and bundle clusters", () => {
    const tr = new TokenTracker();
    tr.onLaunch(launch);
    tr.watch("M", launch);
    // creation-slot bundle: 3 wallets same slot as creation
    tr.onTick(tick({ user: "b1", slot: 100, ts: 1001, tokens: 15_000_000, sol: 0.5 }));
    tr.onTick(tick({ user: "b2", slot: 100, ts: 1002, tokens: 15_000_000, sol: 0.5 }));
    tr.onTick(tick({ user: "b3", slot: 100, ts: 1003, tokens: 15_000_000, sol: 0.5 }));
    tr.onTick(tick({ user: "b4", slot: 105, ts: 3000 }));
    tr.onTick(tick({ user: "b1", slot: 106, ts: 3500, isBuy: false, tokens: 5_000_000, sol: 0.15 }));
    tr.onTick(tick({ user: "DEV", slot: 107, ts: 4000, isBuy: false, tokens: 1_000_000, sol: 0.03 }));
    const o = tr.observation("M");
    expect(o.uniqueBuyers).toBe(4);
    expect(o.buys).toBe(4);
    expect(o.sells).toBe(2);
    expect(o.devSold).toBe(true);
    expect(o.sameSlotClusterWallets).toBe(3);
    expect(o.bundlePctSupply).toBeCloseTo(4.5, 5);
    expect(o.netSol).toBeCloseTo(0.5 * 3 + 0.2 - 0.15 - 0.03, 6);
    expect(o.largestBuyerPctSupply).toBeCloseTo(1.5, 5);
    expect(o.marketCapSol).toBeCloseTo((31 / 1_040_000_000) * 1e9, 6);
  });
  it("tracks whale dumps and early-buyer rings", () => {
    const tr = new TokenTracker();
    tr.onLaunch({ ...launch, mint: "A", ts: Date.now() });
    tr.onLaunch({ ...launch, mint: "B", ts: Date.now() });
    tr.onLaunch({ ...launch, mint: "C", ts: Date.now() });
    tr.watch("A", { ...launch, mint: "A" });
    for (const m of ["A", "B", "C"]) tr.onTick(tick({ mint: m, user: "ring", ts: Date.now() }));
    expect(tr.ringCount("ring")).toBe(3);
    tr.onTick(tick({ mint: "A", user: "whale", isBuy: false, tokens: 60_000_000, ts: Date.now() }));
    expect(tr.whaleDumpPct("A")).toBeCloseTo(6, 5);
  });
  it("shadow tracking records the max market cap after a decision and expires", async () => {
    const tr = new TokenTracker();
    const unwatched: string[] = [];
    tr.on("unwatch", (m: string) => unwatched.push(m));
    tr.watch("M", launch);
    tr.onTick(tick({ ts: Date.now() }));
    tr.shadow("M", "skip", "test", 0.0001);
    expect(unwatched).toEqual(["M"]); // per-token feeds drop the subscription when a token goes to shadow
    tr.onTick(tick({ vSol: 62, ts: Date.now() }));
    await new Promise((r) => setTimeout(r, 20));
    const done = tr.prune();
    expect(done.length).toBe(1);
    expect(done[0].shadow.maxMcap).toBeGreaterThan(done[0].shadow.mcapAtDecision * 1.9);
    expect(tr.isWatched("M")).toBe(false);
  });
  it("a watched shadow keeps its subscription, measures peak, trough and end, and returns the price path", async () => {
    const tr = new TokenTracker(600, 100);
    const unwatched: string[] = [];
    tr.on("unwatch", (m: string) => unwatched.push(m));
    tr.watch("M", launch);
    tr.onTick(tick({ ts: launch.ts + 500 }));
    tr.shadow("M", "skip", "test", 0.0001, true);
    expect(unwatched).toEqual([]);
    expect(tr.watchedShadowCount()).toBe(1);
    tr.onTick(tick({ vSol: 62, ts: launch.ts + 2000 }));
    tr.onTick(tick({ user: "DEV", isBuy: false, vSol: 20, tokens: 50_000_000, sol: 1, ts: launch.ts + 3000 }));
    await new Promise((r) => setTimeout(r, 20));
    const [d] = tr.prune();
    expect(unwatched).toEqual(["M"]);
    expect(d.shadow.watched).toBe(true);
    expect(d.shadow.ticks).toBe(2);
    expect(d.shadow.maxMcap / d.shadow.mcapAtDecision).toBeGreaterThan(1.9);
    expect(d.shadow.minMcap).toBeCloseTo(d.shadow.lastMcap, 6);
    expect(d.shadow.lastMcap).toBeLessThan(d.shadow.mcapAtDecision);
    expect(d.path).toHaveLength(3); // the trade before the decision and both after it
    expect(d.path![0][0]).toBe(500);
    expect(d.path![2]).toEqual([3000, expect.any(Number), -1, 5, 1, "DEV"]);
    expect(d.pathTruncated).toBe(false);
  });
  it("caps the price path and drops it for shadows that are not kept subscribed", () => {
    const tr = new TokenTracker(600, 2);
    tr.watch("M", launch);
    for (let i = 0; i < 4; i++) tr.onTick(tick({ ts: launch.ts + i }));
    expect(tr.get("M")!.path).toHaveLength(2);
    expect(tr.get("M")!.pathTruncated).toBe(true);
    tr.shadow("M", "skip", "test", 1);
    expect(tr.get("M")!.path).toBeUndefined();
    expect(tr.watchedShadowCount()).toBe(0);
  });
  it("saves no path when path saving is off", () => {
    const tr = new TokenTracker();
    tr.watch("M", launch);
    tr.onTick(tick({}));
    expect(tr.get("M")!.path).toBeUndefined();
  });
});
