import type { Config } from "../config.js";
import type { Jupiter } from "../chain/jupiter.js";
import type { Executor } from "../exec/executor.js";
import type { Logger } from "../logger.js";
import { evaluateExit, markPrice } from "../strategy/exits.js";
import type { TokenTracker } from "../strategy/tracker.js";
import type { Fill, Position, Strategy, TradeTick } from "../types.js";
import { TOKEN_UNIT, errMsg, newId } from "../util.js";
import type { RiskManager } from "./risk.js";
import type { Store } from "./store.js";

export interface OpenMeta {
  mint: string;
  symbol: string;
  name: string;
  dev: string;
  tokenProgram: string;
  strategy: Strategy;
  copiedFrom?: string;
}

/** Owns open positions: applies fills, marks prices, runs exit rules, persists state. */
export class Portfolio {
  private selling = new Set<string>();
  private lastAmmQuote = new Map<string, number>();

  constructor(
    private cfg: Config,
    private store: Store,
    private tracker: TokenTracker,
    private executor: Executor,
    private risk: RiskManager,
    private jup: Jupiter,
    private log: Logger,
  ) {
    for (const p of this.open()) {
      this.tracker.watch(p.mint);
      this.tracker.pin(p.mint, true);
    }
  }

  open(): Position[] {
    return this.store.openPositions();
  }

  has(mint: string): boolean {
    return this.open().some((p) => p.mint === mint);
  }

  openPosition(fill: Fill, meta: OpenMeta): Position {
    const pos: Position = {
      id: newId("pos"),
      mint: meta.mint,
      symbol: meta.symbol,
      name: meta.name,
      dev: meta.dev,
      tokenProgram: meta.tokenProgram,
      strategy: meta.strategy,
      copiedFrom: meta.copiedFrom,
      openedAt: fill.ts,
      status: "open",
      venue: fill.venue,
      entryPrice: fill.price,
      tokens: fill.tokens,
      tokensBought: fill.tokens,
      costSol: fill.sol,
      proceedsSol: 0,
      lastPrice: fill.price,
      peakPrice: fill.price,
      lastTradeTs: fill.ts,
      ladderDone: [],
      trailingArmed: false,
      fills: [fill],
      exitReasons: [],
      realizedPnlSol: 0,
    };
    this.store.state.positions[pos.id] = pos;
    this.tracker.watch(pos.mint);
    this.tracker.pin(pos.mint, true);
    this.store.save();
    this.store.appendJsonl("fills.jsonl", { ...fill, positionId: pos.id, mint: pos.mint, symbol: pos.symbol, strategy: pos.strategy });
    this.log.info(`OPEN ${pos.symbol} ${pos.strategy}`, { mint: pos.mint, tokens: Math.round(pos.tokens), costSol: +pos.costSol.toFixed(4), price: pos.entryPrice, paper: fill.paper });
    return pos;
  }

  onTrade(t: TradeTick): void {
    for (const p of this.open()) {
      if (p.mint !== t.mint || p.venue !== "curve") continue;
      if (t.vTokens > 0) markPrice(p, t.vSol / t.vTokens, this.cfg.exits, t.ts);
    }
  }

  onComplete(mint: string): void {
    for (const p of this.open()) {
      if (p.mint === mint && p.venue === "curve") {
        p.venue = "amm";
        this.log.info(`${p.symbol} graduated to PumpSwap`, { mint });
        this.store.save();
      }
    }
  }

  /** Refresh prices for graduated positions through Jupiter (cheap, a few per second at most). */
  async refreshAmmPrices(): Promise<void> {
    for (const p of this.open()) {
      if (p.venue !== "amm" || p.tokens <= 0) continue;
      const last = this.lastAmmQuote.get(p.id) ?? 0;
      if (Date.now() - last < 3000) continue;
      this.lastAmmQuote.set(p.id, Date.now());
      const raw = BigInt(Math.floor(p.tokens * TOKEN_UNIT));
      const lamports = await this.jup.quoteSellLamports(p.mint, raw);
      if (lamports && lamports > 0) {
        const price = lamports / 1e9 / p.tokens;
        markPrice(p, price, this.cfg.exits, Date.now());
        p.lastTradeTs = Date.now(); // no per-trade feed on AMM; do not trigger stagnation
      }
    }
  }

  /** Evaluate exits for every open position. Called about once per second. */
  async tick(): Promise<void> {
    const now = Date.now();
    const kill = this.store.killSwitch();
    for (const p of this.open()) {
      if (this.selling.has(p.id)) continue;
      const st = this.tracker.get(p.mint);
      if (kill === "liquidate") {
        void this.sell(p, 100, "kill_switch_liquidate", true);
        continue;
      }
      const action = evaluateExit(p, this.cfg.exits, {
        now,
        price: p.lastPrice,
        devSold: st?.devSold ?? false,
        whaleDumpPct: this.tracker.whaleDumpPct(p.mint),
        graduated: p.venue === "amm" || (st?.graduated ?? false),
        lastTradeTs: p.venue === "amm" ? now : Math.max(p.lastTradeTs, st?.lastTradeTs ?? 0),
      });
      if (action) void this.sell(p, action.pct, action.reason, action.urgent, action.rungs);
    }
  }

  async sell(p: Position, pct: number, reason: string, urgent: boolean, rungs: number[] = []): Promise<void> {
    if (this.selling.has(p.id) || p.status !== "open") return;
    this.selling.add(p.id);
    try {
      this.log.info(`SELL ${p.symbol} ${pct.toFixed(0)}% (${reason})`, { mint: p.mint, mult: +(p.lastPrice / p.entryPrice).toFixed(2) });
      const fill = await this.executor.sell({
        mint: p.mint,
        tokensUi: p.tokens,
        pct,
        urgent,
        venue: p.venue,
        tokenProgram: p.tokenProgram,
        label: `${p.symbol}:${reason}`,
        dev: p.dev,
      });
      if (!fill) {
        this.log.error(`sell failed for ${p.symbol}; will retry next tick`, { mint: p.mint, reason });
        p.exitReasons.push(`failed:${reason}`);
        return;
      }
      this.applySell(p, fill, reason, rungs);
    } catch (e) {
      this.log.error(`sell threw for ${p.symbol}`, { err: errMsg(e) });
    } finally {
      this.selling.delete(p.id);
    }
  }

  applySell(p: Position, fill: Fill, reason: string, rungs: number[]): void {
    p.fills.push(fill);
    p.proceedsSol += fill.sol;
    p.tokens = Math.max(0, p.tokens - fill.tokens);
    p.exitReasons.push(reason);
    for (const r of rungs) if (!p.ladderDone.includes(r)) p.ladderDone.push(r);
    if (rungs.length) p.trailingArmed = true;
    this.store.appendJsonl("fills.jsonl", { ...fill, positionId: p.id, mint: p.mint, symbol: p.symbol, strategy: p.strategy, reason });
    const dust = p.tokens < Math.max(1, p.tokensBought * 0.002);
    if (dust) {
      p.status = "closed";
      p.closedAt = fill.ts;
      p.tokens = 0;
      p.realizedPnlSol = p.proceedsSol - p.costSol;
      this.risk.onClosed(p.realizedPnlSol, fill.ts);
      this.tracker.pin(p.mint, false);
      this.tracker.shadow(p.mint, "buy", reason, this.cfg.SHADOW_TRACK_MINUTES, true);
      if (/dev_sold|whale_dump/.test(reason) && p.dev && !this.store.state.learnedCreatorBlacklist.includes(p.dev)) {
        this.store.state.learnedCreatorBlacklist.push(p.dev);
      }
      const pct = p.costSol > 0 ? (p.realizedPnlSol / p.costSol) * 100 : 0;
      this.log.info(`CLOSED ${p.symbol} pnl ${p.realizedPnlSol >= 0 ? "+" : ""}${p.realizedPnlSol.toFixed(4)} SOL (${pct.toFixed(0)}%)`, {
        mint: p.mint,
        reasons: p.exitReasons.join(","),
        heldSec: Math.round(((p.closedAt ?? fill.ts) - p.openedAt) / 1000),
        strategy: p.strategy,
      });
      this.store.appendJsonl("closed.jsonl", { ...p, fills: undefined });
    }
    this.store.save();
  }

  async liquidateAll(reason: string): Promise<void> {
    await Promise.all(this.open().map((p) => this.sell(p, 100, reason, true)));
  }
}
