import { describe, expect, it } from "vitest";
import { RpcFailover, failoverFor, registerFailover, rpcFetch } from "../src/chain/rpcFailover.js";

const P = "https://primary.example/?api-key=secret";
const F = "https://fallback.example/";
const BODY = '{"jsonrpc":"2.0","result":1,"id":1}';

const ok = () => new Response(BODY, { status: 200, headers: { "content-type": "application/json" } });
const quota = () => new Response("max usage reached", { status: 429, statusText: "Too Many Requests", headers: { "content-length": "17" } });
const rateLimited = () => new Response('{"jsonrpc":"2.0","error":{"code":429,"message":"Too many requests"}}', { status: 429 });
const serverError = () => new Response("bad gateway", { status: 502 });

function fakeNet(handlers: Record<string, () => Response>) {
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const h = handlers[url];
    if (!h) throw new Error(`ECONNREFUSED ${url}`);
    return h();
  };
  return { calls, fetchImpl };
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function make(handlers: Record<string, () => Response>, extra: Partial<ConstructorParameters<typeof RpcFailover>[0]> = {}) {
  const net = fakeNet(handlers);
  const c = clock();
  const logs: string[] = [];
  const log = { warn: (m: string) => logs.push(`warn ${m}`), info: (m: string) => logs.push(`info ${m}`) };
  const fo = new RpcFailover({ primary: P, fallback: F, tripMs: 60_000, tripAfter: 3, fetchImpl: net.fetchImpl, now: c.now, log, ...extra });
  return { fo, net, c, logs };
}

describe("RpcFailover", () => {
  it("passes a healthy primary through untouched", async () => {
    const { fo, net } = make({ [P]: ok, [F]: ok });
    const res = await fo.fetch(P, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(BODY);
    expect(net.calls).toEqual([P]);
    expect(fo.state).toBe("primary");
    expect(fo.failovers).toBe(0);
  });

  it("leaves requests to other URLs alone", async () => {
    const { fo, net } = make({ [P]: quota, [F]: ok, "https://other.example/": ok });
    const res = await fo.fetch("https://other.example/");
    expect(res.status).toBe(200);
    expect(net.calls).toEqual(["https://other.example/"]);
  });

  it("trips on a spent-credits 429 and probes the primary after the trip window", async () => {
    let primaryHealthy = false;
    const { fo, net, c, logs } = make({ [P]: () => (primaryHealthy ? ok() : quota()), [F]: ok });

    const first = await fo.fetch(P, { body: "{}" });
    expect(first.status).toBe(200);
    expect(net.calls).toEqual([P, F]);
    expect(fo.state).toBe("fallback");
    expect(fo.reason).toContain("max usage reached");
    expect(fo.trips).toBe(1);
    expect(logs.some((l) => l.startsWith("warn rpc primary.example unusable (429 max usage reached)"))).toBe(true);
    expect(logs.join("\n")).not.toContain("secret");

    net.calls.length = 0;
    await fo.fetch(P, { body: "{}" });
    expect(net.calls).toEqual([F]); // tripped: primary not touched

    c.advance(59_000);
    net.calls.length = 0;
    await fo.fetch(P, { body: "{}" });
    expect(net.calls).toEqual([F]);

    c.advance(2_000);
    net.calls.length = 0;
    const probe = await fo.fetch(P, { body: "{}" });
    expect(probe.status).toBe(200);
    expect(net.calls).toEqual([P, F]); // probe failed, request still answered by the fallback
    expect(fo.state).toBe("fallback");
    expect(fo.trips).toBe(1); // re-trip is not a new trip

    primaryHealthy = true;
    c.advance(61_000);
    net.calls.length = 0;
    const back = await fo.fetch(P, { body: "{}" });
    expect(back.status).toBe(200);
    expect(net.calls).toEqual([P]);
    expect(fo.state).toBe("primary");
    expect(logs.some((l) => l.startsWith("info rpc primary.example answers again"))).toBe(true);
  });

  it("re-sends a plain rate-limited request to the fallback without tripping", async () => {
    let n = 0;
    const { fo, net } = make({ [P]: () => (n++ === 0 ? rateLimited() : ok()), [F]: ok });
    const res = await fo.fetch(P, { body: "{}" });
    expect(res.status).toBe(200);
    expect(net.calls).toEqual([P, F]);
    expect(fo.state).toBe("primary");
    expect(fo.failovers).toBe(1);

    net.calls.length = 0;
    await fo.fetch(P, { body: "{}" });
    expect(net.calls).toEqual([P]); // primary tried again right away
  });

  it("trips after repeated failures of any kind", async () => {
    const { fo, net } = make({ [P]: serverError, [F]: ok });
    for (let i = 0; i < 3; i++) await fo.fetch(P, { body: "{}" });
    expect(fo.state).toBe("fallback");
    expect(fo.reason).toContain("502");
    net.calls.length = 0;
    await fo.fetch(P, { body: "{}" });
    expect(net.calls).toEqual([F]);
  });

  it("fails over on a network error and returns the fallback's answer even when that is an error", async () => {
    const { fo, net } = make({ [F]: rateLimited }); // primary unreachable
    const res = await fo.fetch(P, { body: "{}" });
    expect(res.status).toBe(429);
    expect(net.calls).toEqual([P, F]);
    expect(fo.reason).toBeNull(); // one network error does not trip
    expect(fo.state).toBe("primary");
  });

  it("returns the primary's error unchanged when no fallback is configured", async () => {
    const net = fakeNet({ [P]: quota });
    const fo = new RpcFailover({ primary: P, fallback: P, fetchImpl: net.fetchImpl });
    expect(fo.hasFallback).toBe(false);
    const res = await fo.fetch(P, { body: "{}" });
    expect(res.status).toBe(429);
    expect(await res.text()).toBe("max usage reached");
    expect(net.calls).toEqual([P]);
  });

  it("preserves the error body for callers when the fallback is also missing at probe time", async () => {
    const net = fakeNet({ [P]: quota, [F]: quota });
    const fo = new RpcFailover({ primary: P, fallback: F, fetchImpl: net.fetchImpl });
    const res = await fo.fetch(P, { body: "{}" });
    expect(res.status).toBe(429);
    expect(await res.text()).toBe("max usage reached");
  });

  it("shares a registered breaker with raw fetches by URL", async () => {
    const { fo, net } = make({ [P]: quota, [F]: ok });
    registerFailover(fo);
    expect(failoverFor(P)).toBe(fo);
    const res = await rpcFetch(P, { body: "{}" });
    expect(res.status).toBe(200);
    expect(net.calls).toEqual([P, F]);
  });
});
