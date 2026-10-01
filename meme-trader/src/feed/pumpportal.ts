import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { proxyAgent } from "../chain/proxy.js";
import type { Logger } from "../logger.js";
import type { LaunchEvent, MigrationEvent } from "../types.js";
import { errMsg, sleep } from "../util.js";

interface PPCreate {
  signature: string;
  mint: string;
  traderPublicKey: string;
  txType: "create";
  initialBuy: number;
  solAmount: number;
  bondingCurveKey: string;
  vTokensInBondingCurve: number;
  vSolInBondingCurve: number;
  marketCapSol: number;
  name: string;
  symbol: string;
  uri: string;
  is_mayhem_mode?: boolean;
  pool: string;
}

export interface PumpPortalEvents {
  launch: (ev: LaunchEvent) => void;
  migration: (ev: MigrationEvent) => void;
}

/** Free PumpPortal feed: token creations and migrations. */
export class PumpPortalFeed extends EventEmitter {
  private ws: WebSocket | null = null;
  private closed = false;
  private backoff = 1000;
  private lastMessage = Date.now();
  private timer: NodeJS.Timeout | null = null;
  received = 0;

  constructor(
    private url: string,
    private log: Logger,
  ) {
    super();
  }

  start(): void {
    this.closed = false;
    this.connect();
    this.timer = setInterval(() => {
      if (this.ws && Date.now() - this.lastMessage > 60_000) {
        this.log.warn("pumpportal silent for 60s, reconnecting");
        this.ws.terminate();
      }
    }, 15_000);
  }

  stop(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.ws?.close();
  }

  private connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.url, { handshakeTimeout: 10_000, agent: proxyAgent() });
    this.ws = ws;
    ws.on("open", () => {
      this.backoff = 1000;
      this.lastMessage = Date.now();
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      ws.send(JSON.stringify({ method: "subscribeMigration" }));
      this.log.info("pumpportal connected");
    });
    ws.on("message", (d) => {
      this.lastMessage = Date.now();
      this.handle(d.toString());
    });
    ws.on("error", (e) => this.log.warn("pumpportal ws error", { err: errMsg(e) }));
    ws.on("close", async () => {
      if (this.closed) return;
      this.log.warn(`pumpportal closed, reconnecting in ${this.backoff}ms`);
      await sleep(this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
      this.connect();
    });
  }

  private handle(text: string): void {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    this.received++;
    if (m.txType === "create") {
      const c = m as unknown as PPCreate;
      const isMayhem = Boolean(c.is_mayhem_mode);
      const ev: LaunchEvent = {
        mint: c.mint,
        dev: c.traderPublicKey,
        creator: c.traderPublicKey,
        bondingCurve: c.bondingCurveKey,
        name: c.name ?? "",
        symbol: c.symbol ?? "",
        uri: c.uri ?? "",
        signature: c.signature,
        ts: Date.now(),
        initialBuyTokens: Number(c.initialBuy) || 0,
        initialBuySol: Number(c.solAmount) || 0,
        vSol: Number(c.vSolInBondingCurve) || 0,
        vTokens: Number(c.vTokensInBondingCurve) || 0,
        totalSupply: isMayhem ? 2_000_000_000 : 1_000_000_000,
        isMayhem,
        solQuoted: true,
        source: "pumpportal",
      };
      this.emit("launch", ev);
      return;
    }
    if (typeof m.mint === "string" && (m.txType === "migrate" || m.txType === "migration" || m.pool === "pump-amm")) {
      this.emit("migration", { mint: m.mint, pool: typeof m.pool === "string" ? m.pool : undefined, signature: typeof m.signature === "string" ? m.signature : undefined, ts: Date.now() } satisfies MigrationEvent);
      return;
    }
    if (typeof m.message === "string") this.log.debug("pumpportal", { message: m.message });
    else this.log.debug("pumpportal unknown message", { keys: Object.keys(m).join(",") });
  }
}
