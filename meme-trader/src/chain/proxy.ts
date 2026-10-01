import { HttpsProxyAgent } from "https-proxy-agent";
import type { Agent } from "node:http";

/** Honour HTTPS_PROXY for websocket and RPC connections (corporate networks, sandboxes). Undefined when unset. */
export function proxyAgent(): Agent | undefined {
  const url = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  return url ? (new HttpsProxyAgent(url) as unknown as Agent) : undefined;
}
