import { Connection } from "@solana/web3.js";
import type { Config } from "../config.js";

/**
 * RPC connection. Behind an HTTPS_PROXY we route through Node's global fetch (which honours the proxy when
 * NODE_USE_ENV_PROXY=1 is set) because web3.js refuses non-https.Agent proxies; otherwise web3.js defaults apply.
 */
export function makeConnection(cfg: Config): Connection {
  const proxied = Boolean(process.env.HTTPS_PROXY ?? process.env.https_proxy);
  return new Connection(cfg.RPC_URL, {
    commitment: "processed",
    wsEndpoint: cfg.wsUrl,
    disableRetryOnRateLimit: true,
    ...(proxied ? { fetch: globalThis.fetch as unknown as NonNullable<ConstructorParameters<typeof Connection>[1] extends infer T ? (T extends { fetch?: infer F } ? F : never) : never> } : {}),
  });
}
