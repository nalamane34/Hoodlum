import { EventEmitter } from "node:events";
import { bondingCurvePda, type PumpSdk } from "@pump-fun/pump-sdk";
import { PublicKey } from "@solana/web3.js";
import type { Logger } from "../logger.js";
import type { LaunchEvent, TradeTick } from "../types.js";
import { PUMP_PROGRAM, decodePumpLogs, toLaunchEvent, toTradeTick } from "../chain/logsDecode.js";
import type { RpcWs } from "./rpcWs.js";

interface LogsNotification {
  context: { slot: number };
  value: { signature: string; err: unknown; logs: string[] };
}

export type TradeFeedMode = "firehose" | "watched";

/**
 * Trade feed over logsSubscribe. Emits "launch" (LaunchEvent), "trade" (TradeTick) and "complete" (mint).
 *
 *  - firehose: one subscription on the pump.fun program. Every create and trade on the platform, plus every
 *    failed bot transaction (~85% of messages). Measured at ~0.75 MB/s (~65 GB/day). Best data; needs a paid RPC
 *    and a server-grade connection.
 *  - watched: one subscription per token we care about (observation window, open positions). Tiny bandwidth,
 *    works on free RPC tiers. Launches must come from another feed (PumpPortal or gRPC).
 */
export class RpcLogsFeed extends EventEmitter {
  private firehoseHandle: number | null = null;
  private perToken = new Map<string, number>();
  received = 0;
  decodedTrades = 0;
  decodedCreates = 0;

  constructor(
    private ws: RpcWs,
    private sdk: PumpSdk,
    private mode: TradeFeedMode,
    private log: Logger,
  ) {
    super();
  }

  start(): void {
    if (this.mode === "firehose") {
      this.firehoseHandle = this.ws.subscribe("logsSubscribe", [{ mentions: [PUMP_PROGRAM] }, { commitment: "processed" }], (r) => this.onLogs(r as LogsNotification));
      this.log.info("trade feed: firehose (all pump.fun logs)");
    } else {
      this.log.info("trade feed: watched tokens only");
    }
  }

  stop(): void {
    if (this.firehoseHandle !== null) this.ws.unsubscribe(this.firehoseHandle);
    for (const h of this.perToken.values()) this.ws.unsubscribe(h);
    this.perToken.clear();
  }

  /** Subscribe to one token's trades (no-op in firehose mode). */
  watch(mint: string, bondingCurve?: string): void {
    if (this.mode !== "watched" || this.perToken.has(mint)) return;
    const curve = bondingCurve ?? bondingCurvePda(new PublicKey(mint)).toBase58();
    const h = this.ws.subscribe("logsSubscribe", [{ mentions: [curve] }, { commitment: "processed" }], (r) => this.onLogs(r as LogsNotification));
    this.perToken.set(mint, h);
  }

  unwatch(mint: string): void {
    const h = this.perToken.get(mint);
    if (h === undefined) return;
    this.perToken.delete(mint);
    this.ws.unsubscribe(h);
  }

  get watchedCount(): number {
    return this.perToken.size;
  }

  private onLogs(n: LogsNotification): void {
    this.received++;
    if (!n?.value || n.value.err) return;
    const { signature, logs } = n.value;
    const slot = n.context?.slot;
    const d = decodePumpLogs(this.sdk, logs);
    for (const c of d.creates) {
      this.decodedCreates++;
      const ev: LaunchEvent = toLaunchEvent(c, d.trades, signature, slot, "rpc");
      this.emit("launch", ev);
    }
    for (const t of d.trades) {
      this.decodedTrades++;
      const tick: TradeTick = toTradeTick(t, signature, slot, "rpc");
      this.emit("trade", tick);
    }
    for (const c of d.completes) this.emit("complete", c.mint.toBase58());
  }
}
