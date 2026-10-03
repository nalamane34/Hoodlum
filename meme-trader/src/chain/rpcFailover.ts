import type { Logger } from "../logger.js";
import { errMsg } from "../util.js";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface RpcFailoverOptions {
  primary: string;
  /** Where requests go while the primary is unusable. Same URL as the primary (or unset) disables failover. */
  fallback?: string;
  /** How long requests go straight to the fallback once the primary is declared unusable; then one request probes the primary again. */
  tripMs?: number;
  /** Consecutive primary failures (rate limits, auth errors, 5xx, network errors) that declare it unusable. */
  tripAfter?: number;
  log?: Pick<Logger, "warn" | "info">;
  fetchImpl?: FetchLike;
  now?: () => number;
}

/** Metered providers answer a spent monthly budget with 429 and a body such as Helius's "max usage reached". */
const QUOTA_RE = /max usage|usage limit|quota|credits? (?:exhausted|exceeded|limit)|plan limit|monthly limit|exceeded .*limit/i;

function host(url: string | undefined): string {
  if (!url) return "none";
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

type PrimaryResult = { ok: true; response: Response } | { ok: false; reason: string; quota: boolean; response?: Response };

/**
 * Circuit breaker in front of one RPC endpoint, shaped like `fetch` so @solana/web3.js and our raw JSON-RPC calls can use it.
 *
 * - A healthy primary is used as is (no body is read, no latency added).
 * - A failing primary (429, 401/403, 5xx or a network error) has that request re-sent to the fallback.
 * - A 429 whose body says the monthly budget is spent, or `tripAfter` consecutive failures, trips the breaker: requests go
 *   straight to the fallback for `tripMs`, after which a single request probes the primary and a success flips back.
 */
export class RpcFailover {
  readonly primary: string;
  readonly fallback: string | undefined;
  private readonly tripMs: number;
  private readonly tripAfter: number;
  private readonly log: Pick<Logger, "warn" | "info"> | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private consecutiveFailures = 0;
  private tripped = false;
  private trippedUntil = 0;
  private probing = false;
  /** Why the primary was last declared unusable (status and the first bytes of the body). */
  reason: string | null = null;
  /** Requests sent to the primary (on Helius a standard call costs 1 credit, so this approximates credits used). */
  primaryRequests = 0;
  /** Requests answered by the fallback. */
  failovers = 0;
  /** Times the breaker tripped. */
  trips = 0;

  constructor(opts: RpcFailoverOptions) {
    this.primary = opts.primary;
    this.fallback = opts.fallback && opts.fallback !== opts.primary ? opts.fallback : undefined;
    this.tripMs = opts.tripMs ?? 10 * 60_000;
    this.tripAfter = opts.tripAfter ?? 5;
    this.log = opts.log;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.now = opts.now ?? Date.now;
  }

  get state(): "primary" | "fallback" {
    return this.tripped ? "fallback" : "primary";
  }

  get hasFallback(): boolean {
    return this.fallback !== undefined;
  }

  /** Drop-in `fetch`. Only requests to the primary URL are managed; anything else passes straight through. */
  readonly fetch: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!this.fallback || url !== this.primary) return this.fetchImpl(input, init);

    if (this.tripped) {
      if (this.now() < this.trippedUntil || this.probing) return this.viaFallback(init);
      this.probing = true;
      try {
        const res = await this.tryPrimary(init);
        if (res.ok) {
          this.recover();
          return res.response;
        }
        this.trip(res.reason, res.quota);
        return this.viaFallback(init);
      } finally {
        this.probing = false;
      }
    }

    const res = await this.tryPrimary(init);
    if (res.ok) return res.response;
    if (res.quota || this.consecutiveFailures >= this.tripAfter) this.trip(res.reason, res.quota);
    return this.viaFallback(init);
  };

  private async tryPrimary(init?: RequestInit): Promise<PrimaryResult> {
    let response: Response;
    this.primaryRequests++;
    try {
      response = await this.fetchImpl(this.primary, init);
    } catch (e) {
      this.consecutiveFailures++;
      return { ok: false, reason: `network error: ${errMsg(e)}`, quota: false };
    }
    const failing = response.status === 429 || response.status === 401 || response.status === 403 || response.status >= 500;
    if (!failing) {
      this.consecutiveFailures = 0;
      return { ok: true, response };
    }
    this.consecutiveFailures++;
    let body = "";
    try {
      body = (await response.text()).slice(0, 200).replace(/\s+/g, " ").trim();
    } catch {
      body = "";
    }
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    return {
      ok: false,
      reason: `${response.status}${body ? ` ${body}` : ""}`,
      quota: response.status === 429 && QUOTA_RE.test(body),
      response: new Response(body, { status: response.status, statusText: response.statusText, headers }),
    };
  }

  private viaFallback(init?: RequestInit): Promise<Response> {
    this.failovers++;
    return this.fetchImpl(this.fallback as string, init);
  }

  /** Spent credits stay spent, so a quota trip lasts the whole window; other failures are re-probed within a minute. */
  private trip(reason: string, quota: boolean): void {
    const first = !this.tripped;
    const windowMs = quota ? this.tripMs : Math.min(this.tripMs, 60_000);
    this.tripped = true;
    this.reason = reason;
    this.trippedUntil = this.now() + windowMs;
    if (first) {
      this.trips++;
      this.log?.warn(`rpc ${host(this.primary)} unusable (${reason}); using ${host(this.fallback)} and probing the primary every ${Math.round(windowMs / 1000)}s`);
    }
  }

  private recover(): void {
    this.tripped = false;
    this.consecutiveFailures = 0;
    this.reason = null;
    this.log?.info(`rpc ${host(this.primary)} answers again; back on the primary`);
  }
}

const registry = new Map<string, RpcFailover>();

/** Remembers the breaker for an endpoint so raw JSON-RPC helpers given only the URL share it with the Connection. */
export function registerFailover(fo: RpcFailover): RpcFailover {
  registry.set(fo.primary, fo);
  return fo;
}

export function failoverFor(url: string): RpcFailover | undefined {
  return registry.get(url);
}

/** `fetch` that honours a registered breaker for `url`, or plain global fetch when none is registered. */
export function rpcFetch(url: string, init?: RequestInit): Promise<Response> {
  const fo = registry.get(url);
  return fo ? fo.fetch(url, init) : globalThis.fetch(url, init);
}
