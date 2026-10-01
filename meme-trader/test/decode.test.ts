import fs from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { decodePumpLogs, isSolQuoted, toLaunchEvent, toTradeTick } from "../src/chain/logsDecode.js";

// The SDK's ESM entry is broken under Node (named import of BN from CommonJS Anchor); the bot runs as CommonJS, so test the same way.
const { PumpSdk } = createRequire(import.meta.url)("@pump-fun/pump-sdk") as typeof import("@pump-fun/pump-sdk");

interface Sample {
  slot: number;
  signature: string;
  logs: string[];
}

describe("pump.fun log decoding (real mainnet sample)", () => {
  const sample = JSON.parse(fs.readFileSync(new URL("./fixtures/pump_logs_sample.json", import.meta.url), "utf8")) as Sample[];
  const sdk = new PumpSdk();
  it("decodes trade events with sane values", () => {
    let trades = 0;
    for (const tx of sample) {
      const d = decodePumpLogs(sdk, tx.logs);
      for (const t of d.trades) {
        const tick = toTradeTick(t, tx.signature, tx.slot, "rpc");
        trades++;
        expect(tick.mint.length).toBeGreaterThan(30);
        expect(tick.vTokens).toBeGreaterThan(0);
        expect(tick.vSol).toBeGreaterThan(0);
        expect(tick.tokens).toBeGreaterThanOrEqual(0);
        if (isSolQuoted(t.quoteMint) && !t.mayhemMode) {
          // A regular SOL-quoted curve starts near 2.8e-8 SOL/token and graduates near 4e-7. Mayhem curves use other virtual params.
          expect(tick.vSol / tick.vTokens).toBeGreaterThan(1e-9);
          expect(tick.vSol / tick.vTokens).toBeLessThan(1e-3);
        }
      }
    }
    expect(trades).toBeGreaterThan(5);
  });
  it("decodes create events (if the sample contains any) into launch events", () => {
    for (const tx of sample) {
      const d = decodePumpLogs(sdk, tx.logs);
      for (const c of d.creates) {
        const ev = toLaunchEvent(c, d.trades, tx.signature, tx.slot, "rpc");
        expect(ev.totalSupply === 1_000_000_000 || ev.totalSupply === 2_000_000_000).toBe(true);
        expect(ev.vTokens).toBeGreaterThan(0);
        expect(ev.tokenProgram).toBeDefined();
      }
    }
  });
});
