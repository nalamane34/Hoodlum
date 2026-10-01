import { Connection, PublicKey } from "@solana/web3.js";
import type { Config } from "../config.js";
import type { WalletInfoCache } from "../chain/creator.js";
import { holderStats } from "../chain/holders.js";
import { fetchSocials, type Socials } from "../chain/meta.js";
import type { Executor } from "../exec/executor.js";
import type { Logger } from "../logger.js";
import type { Portfolio } from "../portfolio/portfolio.js";
import type { RiskManager } from "../portfolio/risk.js";
import type { Store } from "../portfolio/store.js";
import type { LaunchEvent, ScoredLaunch, TradeTick } from "../types.js";
import { TtlSet, errMsg, withTimeout } from "../util.js";
import { preFilter, scoreConfigFrom, scoreLaunch, type SampledBuyer, type ScoreConfig } from "./scorer.js";
import type { TokenTracker } from "./tracker.js";

interface Candidate {
  ev: LaunchEvent;
  startedAt: number;
  socials: Promise<Socials>;
  creator: Promise<import("../chain/creator.js").WalletInfo | null>;
  timer: NodeJS.Timeout;
  decided: boolean;
}

/** Filter-first launch entries: observe the first seconds of every new token, score it, buy the few that pass. */
export class LaunchStrategy {
  private pending = new Map<string, Candidate>();
  private seen = new TtlSet(30 * 60_000);
  private inflight = 0;
  private holderWarned = false;
  stats = { launches: 0, prefiltered: 0, observed: 0, bought: 0, early: 0 };

  constructor(
    private cfg: Config,
    private conn: Connection,
    private tracker: TokenTracker,
    private portfolio: Portfolio,
    private executor: Executor,
    private risk: RiskManager,
    private store: Store,
    private walletInfo: WalletInfoCache,
    private log: Logger,
  ) {}

  private scoreCfg(): ScoreConfig {
    return scoreConfigFrom(this.cfg, this.store.state.learnedCreatorBlacklist);
  }

  onLaunch(ev: LaunchEvent): void {
    if (!this.cfg.LAUNCH_ENABLED) return;
    if (this.seen.has(ev.mint)) return;
    this.seen.add(ev.mint);
    this.stats.launches++;
    this.tracker.watch(ev.mint, ev);

    const fails = preFilter(ev, this.scoreCfg());
    if (fails.length) {
      this.stats.prefiltered++;
      this.record(ev, { decision: "skip", score: 0, hardFails: fails, reasons: [], features: { devPct: ev.totalSupply ? +((ev.initialBuyTokens / ev.totalSupply) * 100).toFixed(1) : 0, mayhem: ev.isMayhem } }, ev.vTokens > 0 ? (ev.vSol / ev.vTokens) * ev.totalSupply : 0);
      this.tracker.shadow(ev.mint, "skip", fails[0], this.cfg.SHADOW_TRACK_MINUTES);
      return;
    }
    this.stats.observed++;
    const cand: Candidate = {
      ev,
      startedAt: Date.now(),
      socials: fetchSocials(ev.uri, this.log),
      creator: this.walletInfo.info(ev.dev, 3000),
      timer: setTimeout(() => void this.decide(ev.mint, "window"), this.cfg.OBSERVE_SECONDS * 1000),
      decided: false,
    };
    this.pending.set(ev.mint, cand);
    this.log.debug(`observing ${ev.symbol}`, { mint: ev.mint, devSol: ev.initialBuySol, source: ev.source });
  }

  /** Early trigger: obvious organic demand before the window ends. */
  onTrade(t: TradeTick): void {
    const cand = this.pending.get(t.mint);
    if (!cand || cand.decided || this.cfg.EARLY_TRIGGER_BUYERS <= 0) return;
    if (Date.now() - cand.startedAt < 3000) return;
    const obs = this.tracker.observation(t.mint);
    if (
      obs.uniqueBuyers >= this.cfg.EARLY_TRIGGER_BUYERS &&
      !obs.devSold &&
      obs.sellRatio <= this.cfg.MAX_SELL_RATIO / 2 &&
      obs.sameSlotClusterWallets < this.cfg.BUNDLE_MIN_WALLETS &&
      obs.netSol >= Math.max(this.cfg.MIN_NET_INFLOW_SOL, this.cfg.EARLY_TRIGGER_MIN_SOL) &&
      obs.largestBuyerPctSupply <= this.cfg.MAX_SINGLE_HOLDER_PCT
    ) {
      this.stats.early++;
      void this.decide(t.mint, "early");
    }
  }

  private async decide(mint: string, trigger: "window" | "early"): Promise<void> {
    const cand = this.pending.get(mint);
    if (!cand || cand.decided) return;
    cand.decided = true;
    clearTimeout(cand.timer);
    this.pending.delete(mint);
    const ev = cand.ev;
    const obs = this.tracker.observation(mint);
    const scoreCfg = this.scoreCfg();

    const walletSol = await this.executor.walletSol();
    const gate = this.risk.canOpen({ solNeeded: this.cfg.BUY_SOL, walletSol, openPositions: this.portfolio.open().length, inflight: this.inflight });

    // Cheap-first: only spend RPC on holders/buyer sampling if the free signals already pass.
    const quick = scoreLaunch({ launch: ev, obs, socials: null, creatorInfo: null, holders: null, sampledBuyers: [], cfg: scoreCfg });
    let holders = null as Awaited<ReturnType<typeof holderStats>>;
    let sampled: SampledBuyer[] = [];
    if (quick.hardFails.length === 0 && gate.ok) {
      const [h, s] = await Promise.all([
        this.cfg.MAX_TOP10_PCT > 0 ? withTimeout(holderStats(this.conn, new PublicKey(mint), ev.totalSupply), 2000, "holders").catch(() => null) : Promise.resolve(null),
        this.sampleBuyers(obs.earliestBuyers),
      ]);
      holders = h;
      sampled = s;
      if (this.cfg.MAX_TOP10_PCT > 0 && !h && !this.holderWarned) {
        this.holderWarned = true;
        this.log.warn("holder check unavailable (getTokenLargestAccounts failed or rate-limited; public RPC returns 429 for it). MAX_TOP10_PCT is not enforced until your RPC serves it.");
      }
    }
    const socials = await withTimeout(cand.socials, 400, "socials").catch(() => null);
    const creatorInfo = await withTimeout(cand.creator, 400, "creator").catch(() => null);
    const result = scoreLaunch({ launch: ev, obs, socials, creatorInfo, holders, sampledBuyers: sampled, cfg: scoreCfg });
    if (!gate.ok) result.hardFails.push(`risk:${gate.reason}`);
    const finalDecision = result.hardFails.length === 0 && result.decision === "buy" ? "buy" : "skip";
    this.record(ev, { ...result, decision: finalDecision, features: { ...result.features, trigger } }, obs.marketCapSol);
    this.log.info(`${finalDecision === "buy" ? "BUY " : "skip"} ${ev.symbol} score=${result.score} ${trigger}`, {
      mint,
      fails: result.hardFails.join(",") || undefined,
      why: result.reasons.join(" "),
      mcap: +obs.marketCapSol.toFixed(1),
    });

    if (finalDecision !== "buy") {
      this.tracker.shadow(mint, "skip", result.hardFails[0] ?? `score_${result.score}`, this.cfg.SHADOW_TRACK_MINUTES);
      return;
    }
    this.inflight++;
    try {
      const fill = await this.executor.buy({ mint, solAmount: this.cfg.BUY_SOL, tokenProgramHint: ev.tokenProgram, label: ev.symbol, dev: ev.dev, isMayhem: ev.isMayhem, totalSupply: ev.totalSupply });
      if (!fill) {
        this.tracker.shadow(mint, "failed", "buy_failed", this.cfg.SHADOW_TRACK_MINUTES);
        return;
      }
      this.stats.bought++;
      const tokenProgram = ev.tokenProgram ?? (await this.resolveTokenProgram(mint));
      this.portfolio.openPosition(fill, { mint, symbol: ev.symbol, name: ev.name, dev: ev.dev, tokenProgram, strategy: "launch" });
    } catch (e) {
      this.log.error("buy failed", { mint, err: errMsg(e) });
    } finally {
      this.inflight--;
    }
  }

  private async resolveTokenProgram(mint: string): Promise<string> {
    try {
      const info = await this.conn.getAccountInfo(new PublicKey(mint), "processed");
      return info?.owner.toBase58() ?? "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    } catch {
      return "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    }
  }

  private async sampleBuyers(wallets: string[]): Promise<SampledBuyer[]> {
    const pick = wallets.slice(0, this.cfg.SAMPLE_BUYERS);
    const infos = await Promise.all(pick.map((w) => this.walletInfo.info(w, 900).catch(() => null)));
    return pick.map((wallet, i) => ({ wallet, info: infos[i], ringCount: this.tracker.ringCount(wallet) }));
  }

  private record(ev: LaunchEvent, r: { decision: "buy" | "skip"; score: number; hardFails: string[]; reasons: string[]; features: Record<string, number | string | boolean | null> }, mcap: number): void {
    const rec: ScoredLaunch = {
      ts: Date.now(),
      mint: ev.mint,
      symbol: ev.symbol,
      name: ev.name,
      dev: ev.dev,
      decision: r.decision,
      score: r.score,
      hardFails: r.hardFails,
      reasons: r.reasons,
      features: r.features,
      marketCapSol: +mcap.toFixed(2),
      source: ev.source,
      signature: ev.signature,
    };
    this.store.appendJsonl("launches.jsonl", rec);
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
