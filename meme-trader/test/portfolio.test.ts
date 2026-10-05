import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Jupiter } from "../src/chain/jupiter.js";
import { loadConfig } from "../src/config.js";
import type { Executor, SellRequest } from "../src/exec/executor.js";
import { Logger } from "../src/logger.js";
import { Portfolio } from "../src/portfolio/portfolio.js";
import { RiskManager } from "../src/portfolio/risk.js";
import { Store } from "../src/portfolio/store.js";
import { TokenTracker } from "../src/strategy/tracker.js";
import type { TradeTick } from "../src/types.js";

function setup() {
  const cfg = loadConfig({});
  const log = new Logger("error");
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "mt-pf-")), log, 5);
  const tracker = new TokenTracker();
  const sell = vi.fn(async (req: SellRequest) => ({ ts: Date.now(), side: "sell" as const, tokens: (req.tokensUi * req.pct) / 100, sol: 0.03, price: 1, paper: true, venue: "curve" as const }));
  const executor = { sell } as unknown as Executor;
  const pf = new Portfolio(cfg, store, tracker, executor, new RiskManager(cfg, store, log), {} as Jupiter, log);
  // Entry at 5e-8 SOL per token (vSol 50 / vTokens 1e9)
  pf.openPosition({ ts: Date.now(), side: "buy", tokens: 1_000_000, sol: 0.05, price: 5e-8, paper: true, venue: "curve" }, { mint: "M", symbol: "S", name: "n", dev: "DEV", tokenProgram: "T", strategy: "launch" });
  const trade = (over: Partial<TradeTick>): void => {
    const t: TradeTick = { mint: "M", user: "u", isBuy: true, sol: 0.1, tokens: 1_000_000, vSol: 50, vTokens: 1e9, realTokens: 7e8, ts: Date.now(), signature: "s", creator: "DEV", source: "rpc", ...over };
    tracker.onTick(t);
    pf.onTrade(t);
  };
  return { sell, trade };
}

describe("Portfolio exits on trades", () => {
  it("sells on the trade that reveals a dev dump, without waiting for the next tick", () => {
    const { sell, trade } = setup();
    trade({});
    expect(sell).not.toHaveBeenCalled();
    trade({ user: "DEV", isBuy: false, tokens: 30_000_000, vSol: 40 });
    expect(sell).toHaveBeenCalledTimes(1);
    expect(sell.mock.calls[0][0].label).toBe("S:dev_sold");
    trade({ isBuy: false, vSol: 35 }); // a sell is already in flight: no second order
    expect(sell).toHaveBeenCalledTimes(1);
  });
  it("takes profit on the trade that crosses the first ladder rung", () => {
    const { sell, trade } = setup();
    trade({ vSol: 100, vTokens: 1e9 }); // 2x
    expect(sell).toHaveBeenCalledTimes(1);
    expect(sell.mock.calls[0][0].label).toBe("S:take_profit_2x");
  });
});
