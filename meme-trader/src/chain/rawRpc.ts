/**
 * Raw JSON-RPC getTransaction. Solana now serves transaction version 1, which @solana/web3.js 1.x cannot
 * deserialize; for third-party transactions we only need `meta` and the parsed account keys, which are version
 * independent in the `jsonParsed` encoding.
 */
export interface RawTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { uiAmount: number | null; amount: string; decimals: number };
}

export interface RawTransaction {
  slot: number;
  blockTime?: number | null;
  meta: {
    err: unknown;
    fee: number;
    logMessages?: string[] | null;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: RawTokenBalance[] | null;
    postTokenBalances?: RawTokenBalance[] | null;
  } | null;
  transaction: {
    message: { accountKeys: ({ pubkey: string; signer: boolean; writable: boolean } | string)[] };
    signatures: string[];
  };
  version?: number | "legacy";
}

export const MAX_SUPPORTED_TX_VERSION = 1;

export async function getTransactionRaw(rpcUrl: string, signature: string, encoding: "json" | "jsonParsed" = "jsonParsed"): Promise<RawTransaction | null> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [signature, { encoding, commitment: "confirmed", maxSupportedTransactionVersion: MAX_SUPPORTED_TX_VERSION }],
    }),
    signal: AbortSignal.timeout(8000),
  });
  const json = (await res.json()) as { result?: RawTransaction | null; error?: { message: string } };
  if (json.error) throw new Error(`getTransaction: ${json.error.message}`);
  return json.result ?? null;
}

export function accountKeyStrings(tx: RawTransaction): string[] {
  return tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
}
