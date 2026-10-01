import "dotenv/config";
import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { loadConfig } from "../config.js";
import { makeConnection } from "../chain/connection.js";
import { Jupiter } from "../chain/jupiter.js";
import { PumpClient } from "../chain/pumpfun.js";
import { Logger } from "../logger.js";
import { getTransactionRaw } from "../chain/rawRpc.js";
import { LAMPORTS_PER_SOL, TOKEN_UNIT } from "../util.js";

/** Read-only self-test: RPC, pump.fun globals, a live bonding curve quote, instruction building, Jupiter quote. No transactions are sent. */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = new Logger("info", undefined, "smoke");
  const conn = makeConnection(cfg);
  const t0 = Date.now();
  const slot = await conn.getSlot("processed");
  log.info(`rpc ok: slot ${slot} (${Date.now() - t0}ms) ${new URL(cfg.RPC_URL).host}`);

  const pump = new PumpClient(conn, log);
  await pump.init();
  log.info(`pump globals ok: fee tiers ${pump.feeConfig?.feeTiers.length ?? 0}, create_v2 ${pump.global.createV2Enabled}, mayhem ${pump.global.mayhemModeEnabled}`);
  if (pump.feeConfig) {
    const tier = pump.feeConfig.feeTiers[0];
    log.info(`lowest fee tier: protocol ${tier.fees.protocolFeeBps.toString()} bps + creator ${tier.fees.creatorFeeBps.toString()} bps (lp ${tier.fees.lpFeeBps.toString()})`);
  }

  // Find a live, incomplete curve: the most recent pump.fun program transaction that carries a trade.
  const t1 = Date.now();
  const sigs = await conn.getSignaturesForAddress(new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"), { limit: 25 }, "confirmed");
  log.info(`fetched ${sigs.length} recent program signatures (${Date.now() - t1}ms), scanning for a trade...`);
  let mint: PublicKey | null = null;
  let scanned = 0;
  for (const s of sigs) {
    if (s.err) continue;
    scanned++;
    const tx = await getTransactionRaw(cfg.RPC_URL, s.signature, "json").catch(() => null);
    const logs = tx?.meta?.logMessages ?? [];
    for (const line of logs) {
      if (!line.startsWith("Program data: ")) continue;
      const buf = Buffer.from(line.slice(14), "base64");
      if (buf.subarray(0, 8).equals(Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]))) {
        const t = pump.sdk.decodeTradeEventBc(buf.subarray(8));
        mint = t.mint;
        break;
      }
    }
    if (mint) break;
  }
  if (!mint) throw new Error(`could not find a recent trade to test against (scanned ${scanned})`);
  log.info(`found a traded mint after ${scanned} tx (${Date.now() - t1}ms)`);
  const { curve } = await pump.fetchCurve(mint);
  const price = PumpClient.priceOf(curve);
  log.info(`live curve ${mint.toBase58()}: price ${price.toExponential(3)} SOL/token, mcap ${PumpClient.marketCapSol(curve).toFixed(2)} SOL, complete ${curve.complete}, mayhem ${curve.isMayhemMode}, supply ${curve.tokenTotalSupply.div(new BN(TOKEN_UNIT)).toString()}`);
  if (!curve.complete) {
    const t2 = Date.now();
    const lamports = new BN(0.05 * LAMPORTS_PER_SOL);
    const tokens = pump.quoteBuyTokens(curve, lamports);
    const back = pump.quoteSellLamports(curve, tokens);
    const roundTrip = (Number(back.toString()) / Number(lamports.toString()) - 1) * 100;
    log.info(`quote: 0.05 SOL -> ${(Number(tokens.toString()) / TOKEN_UNIT).toFixed(0)} tokens -> ${(Number(back.toString()) / LAMPORTS_PER_SOL).toFixed(5)} SOL if sold back immediately (${roundTrip.toFixed(2)}% round-trip cost incl. fees + price impact)`);
    const kp = Keypair.generate();
    const tokenProgram = await pump.resolveTokenProgram(mint);
    const built = await pump.buildBuy({ mint, user: kp.publicKey, lamports, slippagePct: 10, tokenProgram });
    log.info(`buy instructions built: ${built.ixs.length} ixs, ${built.ixs[built.ixs.length - 1].keys.length} accounts on the buy ix, token program ${tokenProgram.toBase58().slice(0, 8)}... (${Date.now() - t2}ms)`);
  }
  const t3 = Date.now();
  const jup = new Jupiter(cfg, log);
  const q = await jup.order({ inputMint: "So11111111111111111111111111111111111111112", outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", amount: "10000000" });
  log.info(`jupiter ok: 0.01 SOL -> ${(Number(q.outAmount) / 1e6).toFixed(4)} USDC via ${q.router ?? "?"} (fee ${q.feeBps ?? 0} bps, ${Date.now() - t3}ms)`);
  log.info("smoke test passed (nothing was sent)");
  pump.stop();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("smoke test failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
