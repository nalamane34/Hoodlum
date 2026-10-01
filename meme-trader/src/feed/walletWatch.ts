import { EventEmitter } from "node:events";
import type { PumpSdk } from "@pump-fun/pump-sdk";
import { Connection } from "@solana/web3.js";
import type { Logger } from "../logger.js";
import type { WalletTrade } from "../types.js";
import { decodePumpLogs } from "../chain/logsDecode.js";
import { accountKeyStrings, getTransactionRaw } from "../chain/rawRpc.js";
import { LAMPORTS_PER_SOL, TOKEN_UNIT, errMsg } from "../util.js";
import type { RpcWs } from "./rpcWs.js";

interface LogsNotification {
  context: { slot: number };
  value: { signature: string; err: unknown; logs: string[] };
}

/**
 * Watches the wallets on the copy list. Decodes pump.fun and PumpSwap trades straight from logs;
 * for any other venue it fetches the transaction and reads the wallet's token balance change.
 */
export class WalletWatch extends EventEmitter {
  private handles: number[] = [];
  private seen = new Set<string>();

  constructor(
    private ws: RpcWs,
    private conn: Connection,
    private sdk: PumpSdk,
    private wallets: string[],
    private log: Logger,
  ) {
    super();
  }

  start(): void {
    for (const w of this.wallets) {
      const h = this.ws.subscribe("logsSubscribe", [{ mentions: [w] }, { commitment: "processed" }], (r) => this.onLogs(w, r as LogsNotification));
      this.handles.push(h);
    }
    if (this.wallets.length) this.log.info("watching copy wallets", { n: this.wallets.length });
  }

  stop(): void {
    for (const h of this.handles) this.ws.unsubscribe(h);
  }

  private async onLogs(wallet: string, n: LogsNotification): Promise<void> {
    if (!n?.value || n.value.err) return;
    const { signature, logs } = n.value;
    if (this.seen.has(signature)) return;
    this.seen.add(signature);
    if (this.seen.size > 5000) this.seen.clear();

    const d = decodePumpLogs(this.sdk, logs);
    const ts = Date.now();
    let emitted = false;
    for (const t of d.trades) {
      if (t.user.toBase58() !== wallet) continue;
      const sol = Number((t.solAmount.isZero() ? t.quoteAmount : t.solAmount).toString()) / LAMPORTS_PER_SOL;
      this.emit("trade", { wallet, mint: t.mint.toBase58(), side: t.isBuy ? "buy" : "sell", sol, tokens: Number(t.tokenAmount.toString()) / TOKEN_UNIT, signature, venue: "pump", ts } satisfies WalletTrade);
      emitted = true;
    }
    for (const s of d.ammBuys) if (s.user === wallet) emitted = this.emitAmm(wallet, s.pool, "buy", s.quoteLamports, s.baseTokensRaw, signature, ts) || emitted;
    for (const s of d.ammSells) if (s.user === wallet) emitted = this.emitAmm(wallet, s.pool, "sell", s.quoteLamports, s.baseTokensRaw, signature, ts) || emitted;
    if (emitted) return;

    // Generic fallback: any swap venue. One RPC call.
    const touchesSwap = logs.some((l) => /Program (JUP|675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8|CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK|pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA|6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P|LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj)/.test(l));
    if (!touchesSwap) return;
    try {
      const tx = await getTransactionRaw(this.conn.rpcEndpoint, signature, "jsonParsed");
      if (!tx?.meta) return;
      const pre = tx.meta.preTokenBalances ?? [];
      const post = tx.meta.postTokenBalances ?? [];
      const deltas = new Map<string, number>();
      for (const b of post) if (b.owner === wallet) deltas.set(b.mint, (deltas.get(b.mint) ?? 0) + (b.uiTokenAmount.uiAmount ?? 0));
      for (const b of pre) if (b.owner === wallet) deltas.set(b.mint, (deltas.get(b.mint) ?? 0) - (b.uiTokenAmount.uiAmount ?? 0));
      let best: { mint: string; delta: number } | null = null;
      for (const [mint, delta] of deltas) {
        if (mint === "So11111111111111111111111111111111111111112") continue;
        if (!best || Math.abs(delta) > Math.abs(best.delta)) best = { mint, delta };
      }
      if (!best || Math.abs(best.delta) < 1e-9) return;
      const idx = accountKeyStrings(tx).indexOf(wallet);
      const solDelta = idx >= 0 ? (tx.meta.postBalances[idx] - tx.meta.preBalances[idx]) / LAMPORTS_PER_SOL : 0;
      this.emit("trade", {
        wallet,
        mint: best.mint,
        side: best.delta > 0 ? "buy" : "sell",
        sol: Math.abs(solDelta),
        tokens: Math.abs(best.delta),
        signature,
        venue: "other",
        ts,
      } satisfies WalletTrade);
    } catch (e) {
      this.log.debug("wallet tx fetch failed", { signature, err: errMsg(e) });
    }
  }

  private emitAmm(wallet: string, pool: string, side: "buy" | "sell", quoteLamports: number, baseRaw: number, signature: string, ts: number): boolean {
    // PumpSwap events carry the pool, not the mint; resolve lazily via the pool account later if needed.
    this.emit("trade", { wallet, mint: `pool:${pool}`, side, sol: quoteLamports / LAMPORTS_PER_SOL, tokens: baseRaw / TOKEN_UNIT, signature, venue: "pumpswap", ts } satisfies WalletTrade);
    return true;
  }
}
