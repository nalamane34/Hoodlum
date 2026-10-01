import { describe, expect, it } from "vitest";
import { preFilter, scoreLaunch, type ScoreConfig } from "../src/strategy/scorer.js";
import type { Observation } from "../src/strategy/tracker.js";
import type { LaunchEvent } from "../src/types.js";

const cfg: ScoreConfig = {
  minScore: 55,
  minUniqueBuyers: 5,
  maxDevPct: 5,
  maxSingleHolderPct: 8,
  maxTop10Pct: 30,
  maxBundlePct: 10,
  bundleMinWallets: 3,
  maxSellRatio: 0.6,
  minNetInflowSol: 1,
  maxEntryMcapSol: 90,
  skipMayhem: true,
  requireSocials: false,
  nameBlacklist: [/test/i, /rug/i],
  creatorBlacklist: new Set(["BAD"]),
  creatorMinTx: 0,
  ringMaxSampled: 2,
};

const launch = (over: Partial<LaunchEvent> = {}): LaunchEvent => ({
  mint: "M",
  dev: "DEV",
  creator: "DEV",
  bondingCurve: "BC",
  name: "Good Coin",
  symbol: "GOOD",
  uri: "https://x",
  signature: "s",
  ts: Date.now(),
  initialBuyTokens: 10_000_000,
  initialBuySol: 0.3,
  vSol: 30.3,
  vTokens: 1_063_000_000,
  totalSupply: 1_000_000_000,
  isMayhem: false,
  solQuoted: true,
  source: "rpc",
  ...over,
});

const obs = (over: Partial<Observation> = {}): Observation => ({
  ageMs: 25_000,
  buys: 14,
  sells: 2,
  uniqueBuyers: 12,
  buySol: 3.2,
  sellSol: 0.3,
  netSol: 2.9,
  sellRatio: 2 / 14,
  devSold: false,
  devExtraBuySol: 0,
  largestBuyerPctSupply: 2.1,
  sameSlotClusterWallets: 1,
  bundlePctSupply: 1,
  firstHalfSol: 1,
  secondHalfSol: 2.2,
  interArrivalCv: 1.1,
  lastPrice: 3.5e-8,
  marketCapSol: 35,
  curveProgressPct: 4,
  earliestBuyers: ["a", "b", "c"],
  solQuoted: true,
  ...over,
});

describe("preFilter", () => {
  it("rejects mayhem, blacklisted names, blacklisted creators, big dev buys, non-SOL quotes", () => {
    expect(preFilter(launch({ isMayhem: true }), cfg)).toContain("mayhem_mode");
    expect(preFilter(launch({ name: "RUG PULL" }), cfg)).toContain("name_blacklisted");
    expect(preFilter(launch({ dev: "BAD" }), cfg)).toContain("creator_blacklisted");
    expect(preFilter(launch({ initialBuyTokens: 80_000_000 }), cfg)[0]).toMatch(/dev_holds_8\.0pct/);
    expect(preFilter(launch({ solQuoted: false }), cfg)).toContain("not_sol_quoted");
    expect(preFilter(launch(), cfg)).toEqual([]);
  });
});

describe("scoreLaunch", () => {
  it("buys a healthy organic launch", () => {
    const r = scoreLaunch({ launch: launch(), obs: obs(), socials: { telegram: "t", twitter: "x", count: 2 }, creatorInfo: { txCount: 25, ageSec: 1e6, fresh: false }, holders: { top10Pct: 18, largestPct: 3, accounts: 40 }, sampledBuyers: [], cfg });
    expect(r.hardFails).toEqual([]);
    expect(r.decision).toBe("buy");
    expect(r.score).toBeGreaterThanOrEqual(55);
  });
  it("hard-fails on dev sell, bundles, concentration, chasing, sell pressure", () => {
    expect(scoreLaunch({ launch: launch(), obs: obs({ devSold: true }), socials: null, creatorInfo: null, holders: null, sampledBuyers: [], cfg }).hardFails).toContain("dev_sold");
    expect(scoreLaunch({ launch: launch(), obs: obs({ sameSlotClusterWallets: 4, bundlePctSupply: 7 }), socials: null, creatorInfo: null, holders: null, sampledBuyers: [], cfg }).hardFails.join()).toMatch(/bundle/);
    expect(scoreLaunch({ launch: launch(), obs: obs({ largestBuyerPctSupply: 12 }), socials: null, creatorInfo: null, holders: null, sampledBuyers: [], cfg }).hardFails.join()).toMatch(/single_holder/);
    expect(scoreLaunch({ launch: launch(), obs: obs({ marketCapSol: 150 }), socials: null, creatorInfo: null, holders: null, sampledBuyers: [], cfg }).hardFails.join()).toMatch(/mcap_150/);
    expect(scoreLaunch({ launch: launch(), obs: obs({ sells: 10, sellRatio: 10 / 14 }), socials: null, creatorInfo: null, holders: null, sampledBuyers: [], cfg }).hardFails.join()).toMatch(/sell_ratio/);
    expect(scoreLaunch({ launch: launch(), obs: obs(), socials: null, creatorInfo: null, holders: { top10Pct: 45, largestPct: 9, accounts: 12 }, sampledBuyers: [], cfg }).hardFails.join()).toMatch(/top10_45/);
  });
  it("a USDC-quoted curve discovered from its first trade is rejected", () => {
    const r = scoreLaunch({ launch: launch(), obs: obs({ solQuoted: false }), socials: null, creatorInfo: null, holders: null, sampledBuyers: [], cfg });
    expect(r.hardFails).toContain("not_sol_quoted");
  });
  it("too few buyers or too little inflow is a skip even with a nice name", () => {
    const r = scoreLaunch({ launch: launch(), obs: obs({ uniqueBuyers: 3, buys: 3, netSol: 0.4 }), socials: null, creatorInfo: null, holders: null, sampledBuyers: [], cfg });
    expect(r.decision).toBe("skip");
    expect(r.hardFails.join()).toMatch(/buyers_3<5/);
    expect(r.hardFails.join()).toMatch(/net_inflow/);
  });
  it("mechanical rhythm, fresh wallets and ring members pull the score down", () => {
    const good = scoreLaunch({ launch: launch(), obs: obs(), socials: null, creatorInfo: null, holders: null, sampledBuyers: [], cfg }).score;
    const bad = scoreLaunch({
      launch: launch(),
      obs: obs({ interArrivalCv: 0.1 }),
      socials: null,
      creatorInfo: { txCount: 1, ageSec: 10, fresh: true },
      holders: null,
      sampledBuyers: [
        { wallet: "a", info: { txCount: 1, ageSec: 5, fresh: true }, ringCount: 4 },
        { wallet: "b", info: { txCount: 2, ageSec: 5, fresh: true }, ringCount: 5 },
      ],
      cfg,
    });
    expect(bad.score).toBeLessThan(good - 25);
  });
  it("too many ring wallets among sampled buyers is a hard fail", () => {
    const r = scoreLaunch({
      launch: launch(),
      obs: obs(),
      socials: null,
      creatorInfo: null,
      holders: null,
      sampledBuyers: [
        { wallet: "a", info: null, ringCount: 3 },
        { wallet: "b", info: null, ringCount: 3 },
        { wallet: "c", info: null, ringCount: 7 },
      ],
      cfg,
    });
    expect(r.hardFails).toContain("ring_wallets_3");
  });
});
