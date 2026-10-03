import "dotenv/config";
import path from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { loadConfig } from "./config.js";
import { makeConnection } from "./chain/connection.js";
import { WalletInfoCache } from "./chain/creator.js";
import { FeeOracle } from "./chain/fees.js";
import { Jupiter } from "./chain/jupiter.js";
import { PumpClient } from "./chain/pumpfun.js";
import { Sender } from "./chain/sender.js";
import { loadKeypair } from "./chain/wallet.js";
import { Executor } from "./exec/executor.js";
import { GrpcFeed } from "./feed/grpc.js";
import { PumpPortalFeed } from "./feed/pumpportal.js";
import { RpcLogsFeed } from "./feed/rpcLogs.js";
import { RpcWs } from "./feed/rpcWs.js";
import { WalletWatch } from "./feed/walletWatch.js";
import { Logger } from "./logger.js";
import { Portfolio } from "./portfolio/portfolio.js";
import { RiskManager } from "./portfolio/risk.js";
import { Store } from "./portfolio/store.js";
import { CopyStrategy } from "./strategy/copyStrategy.js";
import { LaunchStrategy } from "./strategy/launchStrategy.js";
import { TokenTracker } from "./strategy/tracker.js";
import type { LaunchEvent, TradeTick, WalletTrade } from "./types.js";
import { RateLimiter, errMsg, shortKey } from "./util.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = new Logger(cfg.LOG_LEVEL, path.join(cfg.DATA_DIR, "bot.log"));
  log.info(`meme-trader starting in ${cfg.MODE.toUpperCase()} mode`, { feeds: [...cfg.feeds].join(","), sender: cfg.SENDER, rpc: new URL(cfg.RPC_URL).host });
  if (cfg.live) log.warn("LIVE MODE: real SOL will be traded without confirmation prompts. Kill switch: `npm run panic`.");

  const conn = makeConnection(cfg);
  const wallet = cfg.WALLET_SECRET_KEY ? loadKeypair(cfg.WALLET_SECRET_KEY) : Keypair.generate();
  log.info(`wallet ${wallet.publicKey.toBase58()}${cfg.WALLET_SECRET_KEY ? "" : " (ephemeral, paper only)"}`);

  const store = new Store(cfg.DATA_DIR, log.child("store"), cfg.PAPER_START_SOL);
  const pump = new PumpClient(conn, log.child("pump"));
  await pump.init();
  log.info("pump.fun globals loaded", { feeTiers: pump.feeConfig?.feeTiers.length ?? 0, mayhemEnabled: pump.global.mayhemModeEnabled });

  const hotAccounts = [pump.global.feeRecipient, ...pump.global.feeRecipients].filter((k) => !k.equals(PublicKey.default));
  const fees = new FeeOracle(conn, cfg, log.child("fees"), hotAccounts);
  const sender = new Sender(conn, cfg, fees, log.child("send"));
  const jup = new Jupiter(cfg, log.child("jup"));
  const tracker = new TokenTracker();
  const executor = new Executor(cfg, conn, wallet, pump, jup, sender, tracker, store, log.child("exec"));
  const risk = new RiskManager(cfg, store, log.child("risk"));
  const portfolio = new Portfolio(cfg, store, tracker, executor, risk, jup, log.child("pf"));
  const limiter = new RateLimiter(cfg.RPC_MAX_RPS);
  const walletInfo = new WalletInfoCache(conn, limiter);
  const launch = new LaunchStrategy(cfg, conn, tracker, portfolio, executor, risk, store, walletInfo, log.child("launch"));
  const copy = new CopyStrategy(cfg, conn, tracker, portfolio, executor, risk, store, log.child("copy"));

  if (cfg.live) {
    const sol = await executor.walletSol();
    log.info(`live balance ${sol?.toFixed(4) ?? "?"} SOL`);
    if (sol !== null && sol < cfg.BUY_SOL + cfg.MIN_RESERVE_SOL) log.warn("balance below BUY_SOL + MIN_RESERVE_SOL; the bot will not open positions until funded");
  } else {
    log.info(`paper balance ${store.state.paperSol.toFixed(4)} SOL`);
  }
  if (store.openPositions().length) log.info(`resuming ${store.openPositions().length} open position(s)`);

  // ───────── feeds ─────────
  const onLaunch = (ev: LaunchEvent) => {
    tracker.onLaunch(ev);
    launch.onLaunch(ev);
  };
  const onTrade = (t: TradeTick) => {
    tracker.onTick(t);
    portfolio.onTrade(t);
    launch.onTrade(t);
  };
  const onComplete = (mint: string) => {
    tracker.onComplete(mint);
    portfolio.onComplete(mint);
  };

  const rpcWs = new RpcWs(cfg.wsUrl, log.child("ws"));
  let rpcLogs: RpcLogsFeed | null = null;
  let pp: PumpPortalFeed | null = null;
  let grpc: GrpcFeed | null = null;
  let walletWatch: WalletWatch | null = null;

  const needWs = cfg.feeds.has("rpc") || (cfg.COPY_ENABLED && cfg.copyWallets.size > 0);
  if (needWs) rpcWs.start();
  if (cfg.feeds.has("rpc")) {
    rpcLogs = new RpcLogsFeed(rpcWs, pump.sdk, cfg.TRADE_FEED, log.child("rpcfeed"));
    rpcLogs.on("launch", onLaunch);
    rpcLogs.on("trade", onTrade);
    rpcLogs.on("complete", onComplete);
    rpcLogs.start();
    const feed = rpcLogs;
    tracker.on("watch", (mint: string, curve?: string) => feed.watch(mint, curve));
    tracker.on("unwatch", (mint: string) => feed.unwatch(mint));
    for (const mint of tracker.watchedMints()) feed.watch(mint);
  }
  if (cfg.feeds.has("pumpportal")) {
    pp = new PumpPortalFeed(cfg.PUMPPORTAL_WS, log.child("pumpportal"));
    pp.on("launch", onLaunch);
    pp.on("migration", (m) => onComplete(m.mint));
    pp.start();
  }
  if (cfg.feeds.has("grpc") && cfg.GRPC_ENDPOINT) {
    grpc = new GrpcFeed(cfg.GRPC_ENDPOINT, cfg.GRPC_TOKEN, pump.sdk, log.child("grpc"));
    grpc.on("launch", onLaunch);
    grpc.on("trade", onTrade);
    grpc.on("complete", onComplete);
    await grpc.start();
  }
  if (!cfg.feeds.has("rpc") && !cfg.feeds.has("grpc")) {
    log.warn("No trade feed (rpc or grpc) enabled: launch scoring and exits need live trades. Add rpc to FEEDS.");
  }
  if (cfg.COPY_ENABLED && cfg.copyWallets.size > 0) {
    walletWatch = new WalletWatch(rpcWs, conn, pump.sdk, [...cfg.copyWallets], log.child("copyfeed"));
    walletWatch.on("trade", (t: WalletTrade) => void copy.onWalletTrade(t));
    walletWatch.start();
  }

  // ───────── loops ─────────
  const exitLoop = setInterval(() => void portfolio.tick().catch((e) => log.error("exit loop error", { err: errMsg(e) })), 1000);
  const ammLoop = setInterval(() => void portfolio.refreshAmmPrices().catch(() => undefined), 1000);
  let liquidated = false;
  const killLoop = setInterval(() => {
    const k = store.killSwitch();
    if (k === "liquidate" && !liquidated) {
      liquidated = true;
      log.warn("KILL file says liquidate: selling every open position");
      void portfolio.liquidateAll("kill_switch_liquidate");
    }
    if (k === "none") liquidated = false;
  }, 2000);
  const pruneLoop = setInterval(() => {
    for (const s of tracker.prune()) {
      void (async () => {
        // In watched mode the shadow saw ticks only while subscribed; sample the curve now for an end-of-window mark.
        let mcapAtEnd: number | null = s.shadow.maxMcap > 0 ? +s.shadow.maxMcap.toFixed(2) : null;
        if (cfg.TRADE_FEED === "watched" && (await limiter.take(500))) {
          try {
            const { curve } = await pump.fetchCurve(new PublicKey(s.mint));
            mcapAtEnd = +PumpClient.marketCapSol(curve).toFixed(2);
          } catch {
            /* token may be gone */
          }
        }
        store.appendJsonl("shadow_outcomes.jsonl", {
          ts: Date.now(),
          mint: s.mint,
          symbol: s.symbol,
          decision: s.shadow.decision,
          reason: s.shadow.reason,
          mcapAtDecision: +s.shadow.mcapAtDecision.toFixed(2),
          maxMcapSeen: +s.shadow.maxMcap.toFixed(2),
          mcapAtEnd,
          endMult: s.shadow.mcapAtDecision > 0 && mcapAtEnd ? +(mcapAtEnd / s.shadow.mcapAtDecision).toFixed(2) : null,
        });
      })();
    }
  }, 30_000);

  const compactLoop = setInterval(() => {
    for (const f of ["launches.jsonl", "shadow_outcomes.jsonl", "copy_signals.jsonl"]) store.compactJsonl(f, cfg.DATA_KEEP_DAYS);
  }, 60 * 60_000);

  const statusLoop = setInterval(() => {
    const open = portfolio.open();
    const pos = open.map((p) => `${p.symbol}:${(p.lastPrice / p.entryPrice).toFixed(2)}x`).join(" ");
    log.info(
      `status | ${cfg.MODE} | bal ${cfg.live ? "(live)" : store.state.paperSol.toFixed(3)} | today ${risk.dailyPnl().toFixed(4)} SOL | total ${store.state.realizedPnlSol.toFixed(4)} SOL (${store.state.closedCount} closed) | open ${open.length} ${pos} | launches ${launch.stats.launches} observed ${launch.stats.observed} bought ${launch.stats.bought} | feed trades ${rpcLogs?.decodedTrades ?? grpc?.received ?? 0}${rpcLogs && cfg.TRADE_FEED === "watched" ? ` (subs ${rpcLogs.watchedCount})` : ""} | ws ${rpcWs.connected ? `up ${rpcWs.uptimeSec}s` : "DOWN"} ${(rpcWs.bytesReceived / 1e6).toFixed(1)}MB (${rpcWs.messagesReceived} msgs) | pp ${pp?.received ?? 0} | tracked ${tracker.size} | kill ${store.killSwitch()}`,
    );
  }, cfg.STATUS_EVERY_SEC * 1000);

  const shutdown = (sig: string) => {
    log.info(`${sig} received, shutting down (open positions stay open and resume on restart)`);
    clearInterval(exitLoop);
    clearInterval(ammLoop);
    clearInterval(killLoop);
    clearInterval(pruneLoop);
    clearInterval(compactLoop);
    clearInterval(statusLoop);
    pump.stop();
    pp?.stop();
    rpcLogs?.stop();
    walletWatch?.stop();
    grpc?.stop();
    rpcWs.stop();
    store.saveNow();
    setTimeout(() => process.exit(0), 300);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (e) => log.error("unhandled rejection", { err: errMsg(e) }));
  process.on("uncaughtException", (e) => log.error("uncaught exception", { err: errMsg(e) }));

  log.info(`ready. launch strategy ${cfg.LAUNCH_ENABLED ? "on" : "off"}, copy strategy ${cfg.COPY_ENABLED ? `on (${cfg.copyWallets.size} wallets: ${[...cfg.copyWallets].map((w) => shortKey(w)).join(" ")})` : "off"}`);
}

main().catch((e) => {
  console.error("fatal:", errMsg(e));
  process.exit(1);
});
