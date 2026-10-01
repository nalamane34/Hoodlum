import type { Config } from "../config.js";
import type { WalletInfo } from "../chain/creator.js";
import type { HolderStats } from "../chain/holders.js";
import type { Socials } from "../chain/meta.js";
import type { LaunchEvent } from "../types.js";
import type { Observation } from "./tracker.js";

export interface ScoreConfig {
  minScore: number;
  minUniqueBuyers: number;
  maxDevPct: number;
  maxSingleHolderPct: number;
  maxTop10Pct: number;
  maxBundlePct: number;
  bundleMinWallets: number;
  maxSellRatio: number;
  minNetInflowSol: number;
  maxEntryMcapSol: number;
  skipMayhem: boolean;
  requireSocials: boolean;
  nameBlacklist: RegExp[];
  creatorBlacklist: Set<string>;
  creatorMinTx: number;
  ringMaxSampled: number;
}

export function scoreConfigFrom(cfg: Config, learnedBlacklist: Iterable<string> = []): ScoreConfig {
  const creatorBlacklist = new Set(cfg.creatorBlacklist);
  for (const c of learnedBlacklist) creatorBlacklist.add(c);
  return {
    minScore: cfg.MIN_SCORE,
    minUniqueBuyers: cfg.MIN_UNIQUE_BUYERS,
    maxDevPct: cfg.MAX_DEV_PCT,
    maxSingleHolderPct: cfg.MAX_SINGLE_HOLDER_PCT,
    maxTop10Pct: cfg.MAX_TOP10_PCT,
    maxBundlePct: cfg.MAX_BUNDLE_PCT,
    bundleMinWallets: cfg.BUNDLE_MIN_WALLETS,
    maxSellRatio: cfg.MAX_SELL_RATIO,
    minNetInflowSol: cfg.MIN_NET_INFLOW_SOL,
    maxEntryMcapSol: cfg.MAX_ENTRY_MCAP_SOL,
    skipMayhem: cfg.SKIP_MAYHEM,
    requireSocials: cfg.REQUIRE_SOCIALS,
    nameBlacklist: cfg.nameBlacklist,
    creatorBlacklist,
    creatorMinTx: cfg.CREATOR_MIN_TX,
    ringMaxSampled: cfg.RING_MAX_SAMPLED,
  };
}

export function devPctOf(launch: LaunchEvent): number {
  return launch.totalSupply > 0 ? (launch.initialBuyTokens / launch.totalSupply) * 100 : 0;
}

/** Hard fails that are knowable the moment the token appears (no observation needed). */
export function preFilter(launch: LaunchEvent, cfg: ScoreConfig): string[] {
  const fails: string[] = [];
  if (!launch.solQuoted) fails.push("not_sol_quoted");
  if (launch.isMayhem && cfg.skipMayhem) fails.push("mayhem_mode");
  if (cfg.creatorBlacklist.has(launch.dev) || cfg.creatorBlacklist.has(launch.creator)) fails.push("creator_blacklisted");
  const text = `${launch.name} ${launch.symbol}`;
  if (cfg.nameBlacklist.some((re) => re.test(text))) fails.push("name_blacklisted");
  const devPct = devPctOf(launch);
  if (devPct > cfg.maxDevPct) fails.push(`dev_holds_${devPct.toFixed(1)}pct`);
  return fails;
}

export interface SampledBuyer {
  wallet: string;
  info: WalletInfo | null;
  ringCount: number;
}

export interface ScoreInput {
  launch: LaunchEvent;
  obs: Observation;
  socials: Socials | null;
  creatorInfo: WalletInfo | null;
  holders: HolderStats | null;
  sampledBuyers: SampledBuyer[];
  cfg: ScoreConfig;
}

export interface ScoreResult {
  decision: "buy" | "skip";
  score: number;
  hardFails: string[];
  reasons: string[];
  features: Record<string, number | string | boolean | null>;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

export function scoreLaunch(input: ScoreInput): ScoreResult {
  const { launch, obs, socials, creatorInfo, holders, sampledBuyers, cfg } = input;
  const hardFails = preFilter(launch, cfg);
  const reasons: string[] = [];
  let score = 0;

  // ---- hard fails from observation ----
  if (obs.devSold) hardFails.push("dev_sold");
  if (obs.solQuoted === false && !hardFails.includes("not_sol_quoted")) hardFails.push("not_sol_quoted");
  if (obs.uniqueBuyers < cfg.minUniqueBuyers) hardFails.push(`buyers_${obs.uniqueBuyers}<${cfg.minUniqueBuyers}`);
  if (obs.netSol < cfg.minNetInflowSol) hardFails.push(`net_inflow_${r1(obs.netSol)}<${cfg.minNetInflowSol}`);
  if (obs.sellRatio > cfg.maxSellRatio) hardFails.push(`sell_ratio_${r1(obs.sellRatio)}`);
  if (obs.marketCapSol > cfg.maxEntryMcapSol) hardFails.push(`mcap_${Math.round(obs.marketCapSol)}>${cfg.maxEntryMcapSol}`);
  if (obs.largestBuyerPctSupply > cfg.maxSingleHolderPct) hardFails.push(`single_holder_${r1(obs.largestBuyerPctSupply)}pct`);
  if (obs.sameSlotClusterWallets >= cfg.bundleMinWallets && obs.bundlePctSupply > cfg.maxBundlePct / 2) hardFails.push(`bundle_${obs.sameSlotClusterWallets}w_${r1(obs.bundlePctSupply)}pct`);
  if (obs.bundlePctSupply > cfg.maxBundlePct) hardFails.push(`bundle_supply_${r1(obs.bundlePctSupply)}pct`);
  if (holders && cfg.maxTop10Pct > 0 && holders.top10Pct > cfg.maxTop10Pct) hardFails.push(`top10_${r1(holders.top10Pct)}pct`);
  if (cfg.requireSocials && (!socials || socials.count === 0)) hardFails.push("no_socials");
  if (cfg.creatorMinTx > 0 && creatorInfo && creatorInfo.txCount < cfg.creatorMinTx) hardFails.push(`creator_fresh_${creatorInfo.txCount}tx`);
  const ringMembers = sampledBuyers.filter((b) => b.ringCount >= 3).length;
  if (ringMembers > cfg.ringMaxSampled) hardFails.push(`ring_wallets_${ringMembers}`);

  // ---- score ----
  const buyerPts = Math.min(25, (obs.uniqueBuyers / 12) * 25);
  score += buyerPts;
  reasons.push(`buyers:${obs.uniqueBuyers}(+${r1(buyerPts)})`);

  const inflowPts = Math.min(15, (obs.netSol / 3) * 15);
  score += inflowPts;
  reasons.push(`inflow:${r1(obs.netSol)}SOL(+${r1(inflowPts)})`);

  if (obs.firstHalfSol > 0 && obs.secondHalfSol > obs.firstHalfSol * 1.3) {
    score += 10;
    reasons.push("accelerating(+10)");
  } else if (obs.secondHalfSol < obs.firstHalfSol * 0.4 && obs.buys >= 4) {
    score -= 10;
    reasons.push("fading(-10)");
  }

  if (obs.buys >= 5) {
    if (obs.interArrivalCv >= 0.5 && obs.interArrivalCv <= 2.5) {
      score += 10;
      reasons.push(`organic_rhythm(cv=${r1(obs.interArrivalCv)},+10)`);
    } else if (obs.interArrivalCv < 0.3) {
      score -= 10;
      reasons.push(`mechanical_rhythm(cv=${r1(obs.interArrivalCv)},-10)`);
    }
  }

  if (socials) {
    let s = 0;
    if (socials.telegram) s += 10;
    if (socials.twitter) s += 5;
    if (socials.website) s += 5;
    s = Math.min(15, s);
    score += s;
    if (s) reasons.push(`socials:${socials.count}(+${s})`);
  }

  const devSol = launch.initialBuySol;
  if (devSol >= 0.3 && devSol <= 2.5) {
    score += 10;
    reasons.push(`dev_buy_${r1(devSol)}SOL(+10)`);
  } else if (devSol > 2.5) {
    score -= 5;
    reasons.push(`dev_buy_large_${r1(devSol)}SOL(-5)`);
  }

  if (creatorInfo) {
    if (creatorInfo.txCount >= 20) {
      score += 5;
      reasons.push("creator_aged(+5)");
    } else if (creatorInfo.fresh) {
      score -= 10;
      reasons.push("creator_fresh(-10)");
    }
  }

  const withInfo = sampledBuyers.filter((b) => b.info);
  if (withInfo.length >= 2) {
    const agedShare = withInfo.filter((b) => (b.info!.txCount ?? 0) >= 10).length / withInfo.length;
    if (agedShare >= 0.5) {
      score += 10;
      reasons.push(`aged_buyers_${Math.round(agedShare * 100)}pct(+10)`);
    } else if (agedShare < 0.2) {
      score -= 10;
      reasons.push(`fresh_buyers(-10)`);
    }
  }
  if (ringMembers > 0) {
    score -= 8 * ringMembers;
    reasons.push(`ring_members_${ringMembers}(-${8 * ringMembers})`);
  }

  if (obs.sellRatio < 0.2 && obs.buys >= 5) {
    score += 5;
    reasons.push("few_sells(+5)");
  }
  if (obs.largestBuyerPctSupply > 0 && obs.largestBuyerPctSupply < 3) {
    score += 5;
    reasons.push("spread_holders(+5)");
  }

  score = Math.max(0, Math.min(100, score));
  const decision: "buy" | "skip" = hardFails.length === 0 && score >= cfg.minScore ? "buy" : "skip";

  const features: Record<string, number | string | boolean | null> = {
    ageSec: r1(obs.ageMs / 1000),
    uniqueBuyers: obs.uniqueBuyers,
    buys: obs.buys,
    sells: obs.sells,
    netSol: r1(obs.netSol),
    sellRatio: r1(obs.sellRatio),
    devPct: r1(devPctOf(launch)),
    devBuySol: r1(devSol),
    devSold: obs.devSold,
    largestBuyerPct: r1(obs.largestBuyerPctSupply),
    clusterWallets: obs.sameSlotClusterWallets,
    bundlePct: r1(obs.bundlePctSupply),
    accel: obs.firstHalfSol > 0 ? r1(obs.secondHalfSol / obs.firstHalfSol) : null,
    cv: r1(obs.interArrivalCv),
    socials: socials?.count ?? null,
    creatorTx: creatorInfo?.txCount ?? null,
    top10Pct: holders ? r1(holders.top10Pct) : null,
    ringMembers,
    mcapSol: r1(obs.marketCapSol),
    progressPct: r1(obs.curveProgressPct),
    mayhem: launch.isMayhem,
  };
  return { decision, score: Math.round(score), hardFails, reasons, features };
}
