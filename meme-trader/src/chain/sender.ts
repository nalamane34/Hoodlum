import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { errMsg, sleep } from "../util.js";
import type { FeeOracle } from "./fees.js";

export const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

export const HELIUS_TIP_ACCOUNTS = [
  "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE",
  "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
  "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta",
  "5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn",
  "2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD",
  "2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ",
  "wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF",
  "3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT",
  "4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey",
  "4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or",
];

export interface SendResult {
  signature: string;
  confirmed: boolean;
  err?: string;
  slot?: number;
  /** lamports spent on tip + priority fee (estimate) */
  feeLamports: number;
}

export interface Prelude {
  ixs: TransactionInstruction[];
  tipLamports: number;
  microLamports: number;
  cuLimit: number;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Builds compute-budget + tip instructions, assembles v0 transactions, sends through the configured path and confirms. */
export class Sender {
  constructor(
    private conn: Connection,
    private cfg: Config,
    private fees: FeeOracle,
    private log: Logger,
  ) {}

  async prelude(payer: PublicKey, opts: { feeMultiplier?: number; cuLimit?: number } = {}): Promise<Prelude> {
    const mult = opts.feeMultiplier ?? 1;
    const cuLimit = opts.cuLimit ?? this.cfg.CU_LIMIT;
    const microLamports = await this.fees.priorityMicroLamports(mult);
    const ixs: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
    ];
    let tipLamports = 0;
    if (this.cfg.SENDER === "jito" || this.cfg.SENDER === "helius") {
      tipLamports = await this.fees.tipLamports(mult);
      const tipAccount = new PublicKey(pick(this.cfg.SENDER === "jito" ? JITO_TIP_ACCOUNTS : HELIUS_TIP_ACCOUNTS));
      ixs.push(SystemProgram.transfer({ fromPubkey: payer, toPubkey: tipAccount, lamports: tipLamports }));
    }
    return { ixs, tipLamports, microLamports, cuLimit };
  }

  estimateFeeLamports(p: Prelude): number {
    return 5000 + Math.ceil((p.microLamports * p.cuLimit) / 1_000_000) + p.tipLamports;
  }

  async build(payer: Keypair, ixs: TransactionInstruction[]): Promise<{ tx: VersionedTransaction; lastValidBlockHeight: number }> {
    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([payer]);
    return { tx, lastValidBlockHeight };
  }

  private async dispatch(raw: Uint8Array, label: string): Promise<void> {
    const b64 = Buffer.from(raw).toString("base64");
    if (this.cfg.SENDER === "rpc") {
      await this.conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0, preflightCommitment: "processed" });
      return;
    }
    const url = this.cfg.SENDER === "jito" ? `${this.cfg.JITO_URL.replace(/\/$/, "")}/api/v1/transactions` : this.cfg.HELIUS_SENDER_URL;
    const body =
      this.cfg.SENDER === "jito"
        ? { jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [b64, { encoding: "base64" }] }
        : { jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [b64, { encoding: "base64", skipPreflight: true, maxRetries: 0 }] };
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    if (!res.ok || json.error) {
      throw new Error(`${this.cfg.SENDER} send failed (${label}): ${json.error?.message ?? res.statusText}`);
    }
  }

  /** Sends (and re-sends) until confirmed, failed, or the blockhash expires. */
  async sendAndConfirm(tx: VersionedTransaction, lastValidBlockHeight: number, label: string, feeLamports: number): Promise<SendResult> {
    const raw = tx.serialize();
    const signature = bs58.encode(tx.signatures[0]);
    const started = Date.now();
    let lastDispatch = 0;
    let lastHeightCheck = 0;
    let dispatchErrors = 0;
    const resendEveryMs = this.cfg.SENDER === "jito" ? 2500 : 1500;

    while (Date.now() - started < 50_000) {
      if (Date.now() - lastDispatch >= resendEveryMs) {
        lastDispatch = Date.now();
        try {
          await this.dispatch(raw, label);
        } catch (e) {
          dispatchErrors++;
          this.log.debug(`dispatch error (${label})`, { err: errMsg(e), n: dispatchErrors });
          if (dispatchErrors >= 4) return { signature, confirmed: false, err: `dispatch failed repeatedly: ${errMsg(e)}`, feeLamports: 0 };
        }
      }
      await sleep(400);
      try {
        const st = await this.conn.getSignatureStatuses([signature]);
        const s = st.value[0];
        if (s) {
          if (s.err) return { signature, confirmed: false, err: `on-chain error: ${JSON.stringify(s.err)}`, slot: s.slot, feeLamports };
          if (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized") {
            return { signature, confirmed: true, slot: s.slot, feeLamports };
          }
        }
      } catch (e) {
        this.log.debug("getSignatureStatuses failed", { err: errMsg(e) });
      }
      if (Date.now() - lastHeightCheck > 2000) {
        lastHeightCheck = Date.now();
        try {
          const h = await this.conn.getBlockHeight("confirmed");
          if (h > lastValidBlockHeight) return { signature, confirmed: false, err: "blockhash expired", feeLamports: 0 };
        } catch {
          /* ignore */
        }
      }
    }
    return { signature, confirmed: false, err: "confirmation timeout", feeLamports: 0 };
  }
}
