import { Keypair, VersionedTransaction } from "@solana/web3.js";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { errMsg } from "../util.js";

export const SOL_MINT = "So11111111111111111111111111111111111111112";

export interface JupOrder {
  transaction: string | null;
  requestId: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold?: string;
  slippageBps?: number;
  priceImpactPct?: string;
  router?: string;
  feeBps?: number;
  errorCode?: number;
  errorMessage?: string;
}

export interface JupExecute {
  status: "Success" | "Failed";
  signature?: string;
  code: number;
  totalInputAmount?: string;
  totalOutputAmount?: string;
  inputAmountResult?: string;
  outputAmountResult?: string;
  error?: string;
}

/** Jupiter Swap API v2 (used for graduated tokens on PumpSwap/Raydium and as a price oracle for them). */
export class Jupiter {
  private base = "https://api.jup.ag/swap/v2";
  constructor(
    private cfg: Config,
    private log: Logger,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { accept: "application/json", "content-type": "application/json" };
    if (this.cfg.JUPITER_API_KEY) h["x-api-key"] = this.cfg.JUPITER_API_KEY;
    return h;
  }

  async order(params: { inputMint: string; outputMint: string; amount: string; taker?: string; slippageBps?: number }): Promise<JupOrder> {
    const q = new URLSearchParams({ inputMint: params.inputMint, outputMint: params.outputMint, amount: params.amount });
    if (params.taker) q.set("taker", params.taker);
    if (params.slippageBps !== undefined) q.set("slippageBps", String(params.slippageBps));
    const res = await fetch(`${this.base}/order?${q.toString()}`, { headers: this.headers(), signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`jupiter /order ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as JupOrder;
  }

  async execute(signedTransactionB64: string, requestId: string): Promise<JupExecute> {
    const res = await fetch(`${this.base}/execute`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ signedTransaction: signedTransactionB64, requestId }),
      signal: AbortSignal.timeout(45_000),
    });
    const json = (await res.json().catch(() => ({}))) as JupExecute;
    if (!res.ok && !json.status) throw new Error(`jupiter /execute ${res.status}`);
    return json;
  }

  /** Lamports obtainable by selling `tokensRaw` of `mint` right now, or null if unroutable. */
  async quoteSellLamports(mint: string, tokensRaw: bigint): Promise<number | null> {
    try {
      const o = await this.order({ inputMint: mint, outputMint: SOL_MINT, amount: tokensRaw.toString() });
      if (!o.outAmount) return null;
      return Number(o.outAmount);
    } catch (e) {
      this.log.debug("jupiter quote failed", { mint, err: errMsg(e) });
      return null;
    }
  }

  /** Full swap: order -> sign -> execute. Returns signature and amounts (raw units). */
  async swap(params: { inputMint: string; outputMint: string; amount: bigint; slippageBps: number; signer: Keypair }): Promise<{
    signature: string;
    inAmount: bigint;
    outAmount: bigint;
  }> {
    const o = await this.order({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount.toString(),
      taker: params.signer.publicKey.toBase58(),
      slippageBps: params.slippageBps,
    });
    if (!o.transaction) throw new Error(`jupiter: no route (${o.errorCode ?? ""} ${o.errorMessage ?? ""})`);
    const tx = VersionedTransaction.deserialize(Buffer.from(o.transaction, "base64"));
    tx.sign([params.signer]);
    const exec = await this.execute(Buffer.from(tx.serialize()).toString("base64"), o.requestId);
    if (exec.status !== "Success" || !exec.signature) throw new Error(`jupiter execute failed: code ${exec.code} ${exec.error ?? ""}`);
    return {
      signature: exec.signature,
      inAmount: BigInt(exec.inputAmountResult ?? exec.totalInputAmount ?? o.inAmount),
      outAmount: BigInt(exec.outputAmountResult ?? exec.totalOutputAmount ?? o.outAmount),
    };
  }
}
