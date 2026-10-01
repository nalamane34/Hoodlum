import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { bondingCurvePda } from "@pump-fun/pump-sdk";

export interface HolderStats {
  top10Pct: number;
  largestPct: number;
  accounts: number;
}

/** Top-holder concentration from getTokenLargestAccounts, excluding the bonding curve's own token account. */
export async function holderStats(conn: Connection, mint: PublicKey, totalSupplyUi: number): Promise<HolderStats | null> {
  try {
    const curve = bondingCurvePda(mint);
    const exclude = new Set(
      [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((tp) => getAssociatedTokenAddressSync(mint, curve, true, tp).toBase58()),
    );
    const res = await conn.getTokenLargestAccounts(mint, "processed");
    const rows = res.value.filter((r) => !exclude.has(r.address.toBase58())).map((r) => r.uiAmount ?? 0);
    if (totalSupplyUi <= 0) return null;
    const top10 = rows.slice(0, 10).reduce((a, b) => a + b, 0);
    return { top10Pct: (top10 / totalSupplyUi) * 100, largestPct: ((rows[0] ?? 0) / totalSupplyUi) * 100, accounts: rows.length };
  } catch {
    return null;
  }
}
