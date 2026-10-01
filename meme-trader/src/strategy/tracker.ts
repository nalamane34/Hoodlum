import { EventEmitter } from "node:events";
import { isSolQuotedKey } from "../chain/logsDecode.js";
import type { LaunchEvent, TradeTick } from "../types.js";
import { coefficientOfVariation, nowMs } from "../util.js";

export interface RecentSell {
  ts: number;
  pctSupply: number;
  user: string;
}

export interface TokenState {
  mint: string;
  launch?: LaunchEvent;
  dev?: string;
  firstSeen: number;
  firstSlot?: number;
  ticks: TradeTick[];
  holdings: Map<string, number>;
  buyers: Set<string>;
  devSold: boolean;
  devExtraBuySol: number;
  lastPrice: number;
  lastTradeTs: number;
  graduated: boolean;
  realTokens: number;
  firstRealTokens: number;
  totalSupply: number;
  recentSells: RecentSell[];
  /** null until the first trade reveals the quote mint */
  solQuoted: boolean | null;
  /** present while we are only tracking the token to learn what it did */
  shadow?: { decision: "skip" | "buy" | "failed"; mcapAtDecision: number; maxMcap: number; minMcap: number; until: number; reason: string };
  pinned: boolean; // held position: never auto-pruned
}

export interface Observation {
  ageMs: number;
  buys: number;
  sells: number;
  uniqueBuyers: number;
  buySol: number;
  sellSol: number;
  netSol: number;
  sellRatio: number;
  devSold: boolean;
  devExtraBuySol: number;
  largestBuyerPctSupply: number;
  sameSlotClusterWallets: number;
  bundlePctSupply: number;
  firstHalfSol: number;
  secondHalfSol: number;
  interArrivalCv: number;
  lastPrice: number;
  marketCapSol: number;
  curveProgressPct: number;
  earliestBuyers: string[];
  solQuoted: boolean | null;
}

/** In-memory state of the tokens we care about, fed by the trade firehose. */
export class TokenTracker extends EventEmitter {
  private tokens = new Map<string, TokenState>();
  private launchTs = new Map<string, number>(); // every launch seen (for token age), pruned
  private earlyBuyers = new Map<string, { mints: Set<string>; at: number }>();

  constructor(private maxTicks = 600) {
    super();
  }

  get size(): number {
    return this.tokens.size;
  }

  onLaunch(ev: LaunchEvent): void {
    this.launchTs.set(ev.mint, ev.ts);
    const st = this.tokens.get(ev.mint);
    if (st && !st.launch) {
      st.launch = ev;
      st.dev = ev.dev;
      st.totalSupply = ev.totalSupply;
      if (ev.slot !== undefined) st.firstSlot = ev.slot;
    }
  }

  tokenAgeMs(mint: string): number | null {
    const t = this.launchTs.get(mint) ?? this.tokens.get(mint)?.launch?.ts;
    return t ? nowMs() - t : null;
  }

  watch(mint: string, launch?: LaunchEvent): TokenState {
    let st = this.tokens.get(mint);
    if (!st) {
      st = {
        mint,
        launch,
        dev: launch?.dev,
        firstSeen: launch?.ts ?? nowMs(),
        firstSlot: launch?.slot,
        ticks: [],
        holdings: new Map(),
        buyers: new Set(),
        devSold: false,
        devExtraBuySol: 0,
        lastPrice: launch && launch.vTokens > 0 ? launch.vSol / launch.vTokens : 0,
        lastTradeTs: launch?.ts ?? nowMs(),
        graduated: false,
        realTokens: 0,
        firstRealTokens: 0,
        totalSupply: launch?.totalSupply ?? 1_000_000_000,
        recentSells: [],
        solQuoted: launch ? (launch.source === "pumpportal" ? null : launch.solQuoted) : null,
        pinned: false,
      };
      if (launch && launch.initialBuyTokens > 0) st.holdings.set(launch.dev, launch.initialBuyTokens);
      this.tokens.set(mint, st);
      this.emit("watch", mint, launch?.bondingCurve);
    } else {
      if (launch && !st.launch) {
        st.launch = launch;
        st.dev = launch.dev;
        st.totalSupply = launch.totalSupply;
      }
      if (st.shadow) {
        st.shadow = undefined;
        this.emit("watch", mint, st.launch?.bondingCurve);
      }
    }
    return st;
  }

  pin(mint: string, pinned: boolean): void {
    const st = this.tokens.get(mint);
    if (st) st.pinned = pinned;
  }

  shadow(mint: string, decision: "skip" | "buy" | "failed", reason: string, minutes: number): void {
    const st = this.tokens.get(mint);
    if (!st || minutes <= 0) {
      if (st && !st.pinned) this.drop(mint);
      return;
    }
    const mcap = st.lastPrice * st.totalSupply;
    st.shadow = { decision, mcapAtDecision: mcap, maxMcap: mcap, minMcap: mcap, until: nowMs() + minutes * 60_000, reason };
    st.ticks = st.ticks.slice(-5);
    // Per-token feeds drop the subscription now; a firehose keeps updating the shadow for free.
    this.emit("unwatch", mint);
  }

  unwatch(mint: string): void {
    const st = this.tokens.get(mint);
    if (st && !st.pinned) this.drop(mint);
  }

  private drop(mint: string): void {
    this.tokens.delete(mint);
    this.emit("unwatch", mint);
  }

  /** Mints currently tracked (for feeds that subscribe per token). */
  watchedMints(): string[] {
    return [...this.tokens.keys()];
  }

  get(mint: string): TokenState | undefined {
    return this.tokens.get(mint);
  }

  isWatched(mint: string): boolean {
    return this.tokens.has(mint);
  }

  onTick(t: TradeTick): void {
    const age = this.tokenAgeMs(t.mint);
    if (t.isBuy && age !== null && age < 60_000) this.noteEarlyBuyer(t.user, t.mint);

    const st = this.tokens.get(t.mint);
    if (!st) return;
    if (!st.dev && t.creator) st.dev = t.creator;
    if (st.solQuoted === null) st.solQuoted = isSolQuotedKey(t.quoteMint);
    if (st.firstSlot === undefined && t.slot !== undefined) st.firstSlot = t.slot;
    if (t.vTokens > 0) st.lastPrice = t.vSol / t.vTokens;
    st.lastTradeTs = t.ts;
    st.realTokens = t.realTokens;
    if (st.firstRealTokens === 0) st.firstRealTokens = t.realTokens;
    if (st.shadow) {
      const mcap = st.lastPrice * st.totalSupply;
      st.shadow.maxMcap = Math.max(st.shadow.maxMcap, mcap);
      st.shadow.minMcap = Math.min(st.shadow.minMcap, mcap);
      return;
    }
    st.ticks.push(t);
    if (st.ticks.length > this.maxTicks) st.ticks.splice(0, st.ticks.length - this.maxTicks);
    const isDev = st.dev !== undefined && t.user === st.dev;
    const cur = st.holdings.get(t.user) ?? 0;
    st.holdings.set(t.user, cur + (t.isBuy ? t.tokens : -t.tokens));
    if (t.isBuy) {
      if (!isDev) st.buyers.add(t.user);
      else if (st.launch && t.signature !== st.launch.signature) st.devExtraBuySol += t.sol;
    } else {
      if (isDev) st.devSold = true;
      const pctSupply = st.totalSupply > 0 ? (t.tokens / st.totalSupply) * 100 : 0;
      st.recentSells.push({ ts: t.ts, pctSupply, user: t.user });
      if (st.recentSells.length > 50) st.recentSells.splice(0, st.recentSells.length - 50);
    }
  }

  onComplete(mint: string): void {
    const st = this.tokens.get(mint);
    if (st) st.graduated = true;
  }

  /** Largest single sell (as % of supply) in the last `windowMs`. */
  whaleDumpPct(mint: string, windowMs = 6000): number {
    const st = this.tokens.get(mint);
    if (!st) return 0;
    const since = nowMs() - windowMs;
    let max = 0;
    for (const s of st.recentSells) if (s.ts >= since && s.pctSupply > max) max = s.pctSupply;
    return max;
  }

  private noteEarlyBuyer(wallet: string, mint: string): void {
    let e = this.earlyBuyers.get(wallet);
    if (!e) {
      e = { mints: new Set(), at: nowMs() };
      this.earlyBuyers.set(wallet, e);
    }
    e.mints.add(mint);
    e.at = nowMs();
  }

  /** Number of distinct launches this wallet bought within their first minute (last hour). 3+ smells like a ring. */
  ringCount(wallet: string): number {
    return this.earlyBuyers.get(wallet)?.mints.size ?? 0;
  }

  observation(mint: string): Observation {
    const st = this.tokens.get(mint);
    const now = nowMs();
    if (!st) {
      return {
        ageMs: 0, buys: 0, sells: 0, uniqueBuyers: 0, buySol: 0, sellSol: 0, netSol: 0, sellRatio: 0, devSold: false, devExtraBuySol: 0,
        largestBuyerPctSupply: 0, sameSlotClusterWallets: 0, bundlePctSupply: 0, firstHalfSol: 0, secondHalfSol: 0, interArrivalCv: 0,
        lastPrice: 0, marketCapSol: 0, curveProgressPct: 0, earliestBuyers: [], solQuoted: null,
      };
    }
    const dev = st.dev;
    const buysT = st.ticks.filter((t) => t.isBuy && t.user !== dev);
    const sellsT = st.ticks.filter((t) => !t.isBuy);
    const buySol = buysT.reduce((a, t) => a + t.sol, 0);
    const sellSol = sellsT.reduce((a, t) => a + t.sol, 0);

    let largest = 0;
    for (const [w, tokens] of st.holdings) if (w !== dev && tokens > largest) largest = tokens;

    // Bundle heuristic: distinct non-dev buyers in the creation slot and the next slot (or first two 400ms buckets).
    const firstSlot = st.firstSlot;
    const bucketOf = (t: TradeTick): number => (firstSlot !== undefined && t.slot !== undefined ? t.slot - firstSlot : Math.floor((t.ts - st.firstSeen) / 400));
    const clusters = new Map<number, { wallets: Set<string>; tokens: number }>();
    for (const t of buysT) {
      const b = bucketOf(t);
      if (b > 1) continue;
      const c = clusters.get(b) ?? { wallets: new Set(), tokens: 0 };
      c.wallets.add(t.user);
      c.tokens += t.tokens;
      clusters.set(b, c);
    }
    let sameSlotClusterWallets = 0;
    let bundleTokens = 0;
    for (const c of clusters.values()) {
      sameSlotClusterWallets = Math.max(sameSlotClusterWallets, c.wallets.size);
      bundleTokens += c.tokens;
    }

    const ageMs = now - st.firstSeen;
    const mid = st.firstSeen + ageMs / 2;
    const firstHalfSol = buysT.filter((t) => t.ts < mid).reduce((a, t) => a + t.sol, 0);
    const secondHalfSol = buySol - firstHalfSol;
    const gaps: number[] = [];
    for (let i = 1; i < buysT.length; i++) gaps.push(Math.max(1, buysT[i].ts - buysT[i - 1].ts));

    const earliest: string[] = [];
    for (const t of buysT) {
      if (!earliest.includes(t.user)) earliest.push(t.user);
      if (earliest.length >= 8) break;
    }

    return {
      ageMs,
      buys: buysT.length,
      sells: sellsT.length,
      uniqueBuyers: st.buyers.size,
      buySol,
      sellSol,
      netSol: buySol - sellSol,
      sellRatio: buysT.length ? sellsT.length / buysT.length : sellsT.length ? 9 : 0,
      devSold: st.devSold,
      devExtraBuySol: st.devExtraBuySol,
      largestBuyerPctSupply: st.totalSupply ? (largest / st.totalSupply) * 100 : 0,
      sameSlotClusterWallets,
      bundlePctSupply: st.totalSupply ? (bundleTokens / st.totalSupply) * 100 : 0,
      firstHalfSol,
      secondHalfSol,
      interArrivalCv: coefficientOfVariation(gaps),
      lastPrice: st.lastPrice,
      marketCapSol: st.lastPrice * st.totalSupply,
      curveProgressPct: st.firstRealTokens > 0 ? ((st.firstRealTokens - st.realTokens) / st.firstRealTokens) * 100 : 0,
      earliestBuyers: earliest,
      solQuoted: st.solQuoted,
    };
  }

  /** Drops expired shadows and stale launch timestamps. Returns finished shadow records for logging. */
  prune(): { mint: string; symbol: string; shadow: NonNullable<TokenState["shadow"]> }[] {
    const now = nowMs();
    const done: { mint: string; symbol: string; shadow: NonNullable<TokenState["shadow"]> }[] = [];
    for (const [mint, st] of this.tokens) {
      if (st.shadow && st.shadow.until <= now && !st.pinned) {
        done.push({ mint, symbol: st.launch?.symbol ?? "", shadow: st.shadow });
        this.drop(mint);
      } else if (!st.shadow && !st.pinned && now - st.firstSeen > 30 * 60_000 && st.ticks.length === 0) {
        this.drop(mint);
      }
    }
    for (const [mint, ts] of this.launchTs) if (now - ts > 2 * 3600_000) this.launchTs.delete(mint);
    for (const [w, e] of this.earlyBuyers) if (now - e.at > 3600_000) this.earlyBuyers.delete(w);
    return done;
  }
}
