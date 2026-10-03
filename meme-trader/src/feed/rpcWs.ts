import WebSocket from "ws";
import { proxyAgent } from "../chain/proxy.js";
import type { Logger } from "../logger.js";
import { errMsg, sleep } from "../util.js";

type Notify = (result: unknown) => void;

/** No frame of any kind (pong included) for this long means the connection is dead. */
const SILENT_RECONNECT_MS = 120_000;
/** Backoff after a refused connection (HTTP 429 from the provider): start high, cap at 10 minutes. */
const RATE_LIMIT_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 10 * 60_000;

export function safeUrlLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/\?.*$/, "");
  }
}

interface Sub {
  method: string;
  params: unknown[];
  onNotify: Notify;
  serverId?: number;
}

/**
 * Minimal JSON-RPC-over-WebSocket client for Solana subscriptions with automatic reconnect and re-subscribe.
 * Used for logsSubscribe so we control heartbeats and backoff ourselves.
 */
export class RpcWs {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; sub?: Sub }>();
  private subs = new Map<number, Sub>(); // local id -> sub
  private byServerId = new Map<number, Sub>();
  private closed = false;
  private lastMessage = Date.now();
  private backoff = 1000;
  private heartbeat: NodeJS.Timeout | null = null;
  bytesReceived = 0;
  messagesReceived = 0;
  connectedAt = 0;
  /** Seconds since the socket was last (re)connected, for the status line. */
  get uptimeSec(): number {
    return this.connected && this.connectedAt ? Math.round((Date.now() - this.connectedAt) / 1000) : 0;
  }

  /** host only, so API keys in the query string never reach the logs */
  private readonly label: string;

  constructor(
    private url: string,
    private log: Logger,
    private unsubMethodFor: (method: string) => string = (m) => m.replace(/Subscribe$/, "Unsubscribe"),
  ) {
    this.label = safeUrlLabel(url);
  }

  start(): void {
    this.closed = false;
    this.connect();
    this.heartbeat = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const silent = Date.now() - this.lastMessage;
      if (silent > SILENT_RECONNECT_MS) {
        this.log.warn(`ws silent for ${Math.round(silent / 1000)}s, reconnecting`, { url: this.label });
        this.ws.terminate();
      } else {
        this.ws.ping();
      }
    }, 20_000);
  }

  stop(): void {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.ws?.close();
    this.ws = null;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.url, { handshakeTimeout: 10_000, agent: proxyAgent() });
    this.ws = ws;
    ws.on("open", () => {
      this.lastMessage = Date.now();
      this.backoff = 1000;
      this.connectedAt = Date.now();
      this.log.info("ws connected", { url: this.label, subs: this.subs.size });
      for (const sub of this.subs.values()) this.sendSubscribe(sub);
    });
    ws.on("message", (data) => {
      this.lastMessage = Date.now();
      const text = data.toString();
      this.bytesReceived += text.length;
      this.messagesReceived++;
      this.onMessage(text);
    });
    ws.on("pong", () => (this.lastMessage = Date.now()));
    ws.on("error", (e) => {
      const msg = errMsg(e);
      this.log.warn("ws error", { url: this.label, err: msg });
      // A 429 on the handshake means the provider is refusing connections (plan limits): do not hammer it.
      if (/\b429\b/.test(msg)) this.backoff = Math.max(this.backoff, RATE_LIMIT_BACKOFF_MS);
    });
    ws.on("close", async () => {
      if (this.ws === ws) this.ws = null;
      this.byServerId.clear();
      for (const p of this.pending.values()) p.reject(new Error("ws closed"));
      this.pending.clear();
      if (this.closed) return;
      const wait = Math.round(this.backoff * (0.8 + Math.random() * 0.4));
      this.log.warn(`ws closed, reconnecting in ${Math.round(wait / 1000)}s`, { url: this.label });
      await sleep(wait);
      if (this.closed) return;
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
      this.connect();
    });
  }

  private onMessage(text: string): void {
    let msg: { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: { subscription: number; result: unknown } };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else {
        if (p.sub && typeof msg.result === "number") {
          p.sub.serverId = msg.result;
          this.byServerId.set(msg.result, p.sub);
        }
        p.resolve(msg.result);
      }
      return;
    }
    if (msg.method && msg.params) {
      const sub = this.byServerId.get(msg.params.subscription);
      if (sub) sub.onNotify(msg.params.result);
    }
  }

  private send(payload: unknown, sub?: Sub): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error("ws not open"));
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject, sub });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, ...(payload as object) }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("rpc ws request timeout"));
        }
      }, 15_000);
    });
  }

  private sendSubscribe(sub: Sub): void {
    this.send({ method: sub.method, params: sub.params }, sub).catch((e) => this.log.warn("subscribe failed", { method: sub.method, err: errMsg(e) }));
  }

  /** Registers a subscription that survives reconnects. Returns a local handle for unsubscribe(). */
  subscribe(method: string, params: unknown[], onNotify: Notify): number {
    const localId = this.nextId++;
    const sub: Sub = { method, params, onNotify };
    this.subs.set(localId, sub);
    if (this.connected) this.sendSubscribe(sub);
    return localId;
  }

  unsubscribe(localId: number): void {
    const sub = this.subs.get(localId);
    if (!sub) return;
    this.subs.delete(localId);
    if (sub.serverId !== undefined) {
      this.byServerId.delete(sub.serverId);
      if (this.connected) this.send({ method: this.unsubMethodFor(sub.method), params: [sub.serverId] }).catch(() => undefined);
    }
  }
}
