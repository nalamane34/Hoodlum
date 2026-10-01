export const LAMPORTS_PER_SOL = 1_000_000_000;
export const TOKEN_DECIMALS = 6;
export const TOKEN_UNIT = 1_000_000;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function nowMs(): number {
  return Date.now();
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = clamp(Math.floor((p / 100) * (sorted.length - 1)), 0, sorted.length - 1);
  return sorted[idx];
}

/** Coefficient of variation (std / mean) of a list; 0 for fewer than 2 values. */
export function coefficientOfVariation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

export function parseList(s: string | undefined): string[] {
  if (!s) return [];
  return s
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

export function shortKey(k: string, n = 4): string {
  return k.length <= n * 2 + 1 ? k : `${k.slice(0, n)}…${k.slice(-n)}`;
}

export function fmtSol(x: number, digits = 4): string {
  return `${x.toFixed(digits)} SOL`;
}

export function pct(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits)}%`;
}

export function withTimeout<T>(p: Promise<T>, ms: number, label = "operation"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export async function retry<T>(fn: () => Promise<T>, attempts: number, baseDelayMs: number, label = "op"): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await sleep(baseDelayMs * 2 ** i + Math.random() * 100);
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${errMsg(lastErr)}`);
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  try {
    return typeof e === "string" ? e : JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** Set whose members expire after ttlMs. */
export class TtlSet {
  private m = new Map<string, number>();
  constructor(private ttlMs: number) {}
  add(k: string): void {
    this.m.set(k, nowMs() + this.ttlMs);
  }
  has(k: string): boolean {
    const exp = this.m.get(k);
    if (exp === undefined) return false;
    if (exp < nowMs()) {
      this.m.delete(k);
      return false;
    }
    return true;
  }
  prune(): void {
    const t = nowMs();
    for (const [k, exp] of this.m) if (exp < t) this.m.delete(k);
  }
  get size(): number {
    return this.m.size;
  }
}

/** Simple token bucket used to keep optional background RPC calls under a rate. */
export class RateLimiter {
  private tokens: number;
  private last = nowMs();
  constructor(private perSecond: number) {
    this.tokens = perSecond;
  }
  /** Returns true and consumes a token if available; never blocks. */
  tryTake(): boolean {
    const t = nowMs();
    this.tokens = Math.min(this.perSecond, this.tokens + ((t - this.last) / 1000) * this.perSecond);
    this.last = t;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
  /** Waits (bounded) for a token. Returns false if it could not get one within maxWaitMs. */
  async take(maxWaitMs = 2000): Promise<boolean> {
    const deadline = nowMs() + maxWaitMs;
    while (!this.tryTake()) {
      if (nowMs() > deadline) return false;
      await sleep(50);
    }
    return true;
  }
}

export function utcDayKey(ts = nowMs()): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}
