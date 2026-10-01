import type { Logger } from "../logger.js";

export interface Socials {
  twitter?: string;
  telegram?: string;
  website?: string;
  description?: string;
  count: number;
}

const cache = new Map<string, Socials>();

function normaliseUri(uri: string): string {
  if (uri.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${uri.slice("ipfs://".length)}`;
  return uri;
}

/** Fetches the token metadata JSON and extracts social links. Never throws; returns count 0 on failure. */
export async function fetchSocials(uri: string, log: Logger, timeoutMs = 3500): Promise<Socials> {
  const hit = cache.get(uri);
  if (hit) return hit;
  const empty: Socials = { count: 0 };
  if (!uri || !/^(https?:\/\/|ipfs:\/\/)/i.test(uri)) return empty;
  try {
    const res = await fetch(normaliseUri(uri), { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
    if (!res.ok) return empty;
    const j = (await res.json()) as Record<string, unknown>;
    const pick = (...keys: string[]) => {
      for (const k of keys) {
        const v = j[k];
        if (typeof v === "string" && v.trim().length > 3) return v.trim();
      }
      return undefined;
    };
    const s: Socials = {
      twitter: pick("twitter", "x"),
      telegram: pick("telegram", "tg"),
      website: pick("website", "site", "url"),
      description: pick("description"),
      count: 0,
    };
    s.count = [s.twitter, s.telegram, s.website].filter(Boolean).length;
    if (cache.size > 5000) cache.clear();
    cache.set(uri, s);
    return s;
  } catch (e) {
    log.debug("metadata fetch failed", { uri, err: String(e) });
    return empty;
  }
}
