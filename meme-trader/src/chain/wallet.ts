import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

/** Accepts a base58 secret key (Phantom export), a JSON byte array, or a base58 32-byte seed. */
export function loadKeypair(secret: string): Keypair {
  const s = secret.trim();
  if (s.startsWith("[")) {
    const arr = JSON.parse(s) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  const bytes = bs58.decode(s);
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new Error(`Unrecognised secret key format (${bytes.length} bytes)`);
}

export function exportBase58(kp: Keypair): string {
  return bs58.encode(kp.secretKey);
}
