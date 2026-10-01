import { describe, expect, it } from "vitest";
import { deriveWsUrl, loadConfig, parseLadder } from "../src/config.js";

describe("config", () => {
  it("parses ladders and rejects bad ones", () => {
    expect(parseLadder("3:25,2:50")).toEqual([
      { mult: 2, sellPct: 50 },
      { mult: 3, sellPct: 25 },
    ]);
    expect(() => parseLadder("1:50")).toThrow();
    expect(() => parseLadder("2:60,3:50")).toThrow(/more than 100/);
  });
  it("derives websocket urls", () => {
    expect(deriveWsUrl("https://api.mainnet-beta.solana.com")).toBe("wss://api.mainnet-beta.solana.com/");
    expect(deriveWsUrl("http://localhost:8899")).toBe("ws://localhost:8899/");
  });
  it("defaults to paper mode and requires a key for live", () => {
    const c = loadConfig({});
    expect(c.MODE).toBe("paper");
    expect(c.live).toBe(false);
    expect(c.feeds.has("rpc")).toBe(true);
    expect(() => loadConfig({ MODE: "live" })).toThrow(/WALLET_SECRET_KEY/);
    expect(() => loadConfig({ FEEDS: "grpc" })).toThrow(/GRPC_ENDPOINT/);
  });
  it("forces the helius minimum tip", () => {
    const c = loadConfig({ SENDER: "helius", TIP_SOL_MIN: "0.0001", TIP_SOL_MAX: "0.0002" });
    expect(c.TIP_SOL_MIN).toBe(0.001);
    expect(c.TIP_SOL_MAX).toBe(0.001);
  });
});
