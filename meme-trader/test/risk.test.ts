import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { Logger } from "../src/logger.js";
import { RiskManager } from "../src/portfolio/risk.js";
import { Store } from "../src/portfolio/store.js";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-"));
  const cfg = loadConfig({ DATA_DIR: dir, MAX_POSITIONS: "2", MAX_DAILY_LOSS_SOL: "0.2", MIN_RESERVE_SOL: "0.05", MAX_CONSECUTIVE_LOSSES: "2", LOSS_COOLDOWN_MIN: "30" });
  const store = new Store(dir, new Logger("error"), 5);
  return { dir, cfg, store, risk: new RiskManager(cfg, store, new Logger("error")) };
}

describe("risk", () => {
  it("enforces max positions including in-flight buys", () => {
    const { risk } = setup();
    expect(risk.canOpen({ solNeeded: 0.05, walletSol: 1, openPositions: 1, inflight: 0 }).ok).toBe(true);
    expect(risk.canOpen({ solNeeded: 0.05, walletSol: 1, openPositions: 1, inflight: 1 }).reason).toMatch(/max_positions/);
  });
  it("stops after the daily loss limit and after consecutive losses", () => {
    const { risk } = setup();
    risk.onClosed(-0.15);
    expect(risk.canOpen({ solNeeded: 0.05, walletSol: 1, openPositions: 0, inflight: 0 }).ok).toBe(true);
    risk.onClosed(-0.06);
    const r = risk.canOpen({ solNeeded: 0.05, walletSol: 1, openPositions: 0, inflight: 0 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/daily_loss_limit|loss_cooldown/);
  });
  it("keeps the fee reserve", () => {
    const { risk } = setup();
    expect(risk.canOpen({ solNeeded: 0.05, walletSol: 0.09, openPositions: 0, inflight: 0 }).reason).toMatch(/insufficient_balance/);
    expect(risk.canOpen({ solNeeded: 0.05, walletSol: null, openPositions: 0, inflight: 0 }).ok).toBe(true);
  });
  it("kill switch file halts new entries", () => {
    const { risk, dir } = setup();
    fs.writeFileSync(path.join(dir, "KILL"), "halt");
    expect(risk.canOpen({ solNeeded: 0.05, walletSol: 1, openPositions: 0, inflight: 0 }).reason).toBe("kill_switch_halt");
  });
  it("persists state across restarts", () => {
    const { risk, store, dir, cfg } = setup();
    risk.onClosed(0.1);
    store.saveNow();
    const store2 = new Store(dir, new Logger("error"), 5);
    expect(store2.state.realizedPnlSol).toBeCloseTo(0.1, 9);
    expect(store2.state.closedCount).toBe(1);
    void cfg;
  });
});
