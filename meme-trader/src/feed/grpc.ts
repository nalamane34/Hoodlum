import { EventEmitter } from "node:events";
import type { PumpSdk } from "@pump-fun/pump-sdk";
import bs58 from "bs58";
import type { Logger } from "../logger.js";
import { PUMP_PROGRAM, decodePumpLogs, toLaunchEvent, toTradeTick } from "../chain/logsDecode.js";
import { errMsg, sleep } from "../util.js";

/**
 * Optional Yellowstone gRPC listener (5-20 ms behind the chain vs 150-300 ms for WebSocket).
 * Requires `npm i @triton-one/yellowstone-grpc` and a Geyser endpoint (Chainstack, Shyft, QuickNode, Helius LaserStream...).
 * Emits the same "launch" / "trade" / "complete" events as RpcLogsFeed.
 */
export class GrpcFeed extends EventEmitter {
  private closed = false;
  received = 0;

  constructor(
    private endpoint: string,
    private token: string | undefined,
    private sdk: PumpSdk,
    private log: Logger,
  ) {
    super();
  }

  async start(): Promise<void> {
    let mod: any;
    try {
      mod = await import("@triton-one/yellowstone-grpc" as string);
    } catch {
      throw new Error("FEEDS includes grpc but @triton-one/yellowstone-grpc is not installed. Run: npm i @triton-one/yellowstone-grpc");
    }
    const Client = mod.default ?? mod.Client;
    const CommitmentLevel = mod.CommitmentLevel;
    void (async () => {
      let backoff = 1000;
      while (!this.closed) {
        try {
          const client = new Client(this.endpoint, this.token, { "grpc.max_receive_message_length": 64 * 1024 * 1024 });
          if (typeof client.connect === "function") await client.connect();
          const stream = await client.subscribe({
            accounts: {},
            slots: {},
            transactions: {
              pump: { vote: false, failed: false, accountInclude: [PUMP_PROGRAM], accountExclude: [], accountRequired: [] },
            },
            transactionsStatus: {},
            blocks: {},
            blocksMeta: {},
            entry: {},
            accountsDataSlice: [],
            commitment: CommitmentLevel?.PROCESSED ?? 0,
          });
          this.log.info("grpc connected", { endpoint: this.endpoint });
          backoff = 1000;
          await new Promise<void>((resolve) => {
            stream.on("data", (u: any) => this.onUpdate(u));
            stream.on("error", (e: unknown) => {
              this.log.warn("grpc stream error", { err: errMsg(e) });
              resolve();
            });
            stream.on("end", () => resolve());
            stream.on("close", () => resolve());
          });
        } catch (e) {
          this.log.warn("grpc connect failed", { err: errMsg(e) });
        }
        if (this.closed) break;
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
      }
    })();
  }

  stop(): void {
    this.closed = true;
  }

  private onUpdate(u: any): void {
    const txu = u?.transaction;
    if (!txu?.transaction) return;
    this.received++;
    const info = txu.transaction;
    const meta = info.meta;
    if (!meta || meta.err) return;
    const logs: string[] = meta.logMessages ?? [];
    if (!logs.length) return;
    const sigBytes: Uint8Array | undefined = info.signature;
    const signature = sigBytes ? bs58.encode(sigBytes) : "";
    const slot = Number(txu.slot ?? 0) || undefined;
    const d = decodePumpLogs(this.sdk, logs);
    for (const c of d.creates) this.emit("launch", toLaunchEvent(c, d.trades, signature, slot, "grpc"));
    for (const t of d.trades) this.emit("trade", toTradeTick(t, signature, slot, "grpc"));
    for (const c of d.completes) this.emit("complete", c.mint.toBase58());
  }
}
