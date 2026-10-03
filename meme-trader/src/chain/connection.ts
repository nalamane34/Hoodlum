import { Connection, type ConnectionConfig } from "@solana/web3.js";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { RpcFailover, registerFailover } from "./rpcFailover.js";

/**
 * RPC connection with automatic failover. Every request goes through an RpcFailover breaker (rpcFailover.ts): a primary
 * that is out of credits ("429 max usage reached"), rejects the key or keeps failing is swapped for RPC_FALLBACK_URL
 * until it answers again. Requests use Node's global fetch, which honours HTTPS_PROXY when NODE_USE_ENV_PROXY=1 is set.
 */
export function makeConnection(cfg: Config, url: string = cfg.RPC_URL, log?: Logger): Connection {
  const failover = registerFailover(new RpcFailover({ primary: url, fallback: cfg.RPC_FALLBACK_URL, tripMs: cfg.RPC_FAILOVER_TRIP_SEC * 1000, log }));
  return new Connection(url, {
    commitment: "processed",
    wsEndpoint: cfg.wsUrl,
    disableRetryOnRateLimit: true,
    fetch: failover.fetch as unknown as ConnectionConfig["fetch"],
  });
}
