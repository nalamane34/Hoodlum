import crypto from "node:crypto";

export const COOKIE_NAME = "mt";

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function cookieValue(cookieHeader: string | undefined, name = COOKIE_NAME): string | null {
  if (!cookieHeader) return null;
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(cookieHeader);
  return m ? decodeURIComponent(m[1]) : null;
}

/** True when the request arrived over HTTPS, directly or through a reverse proxy that sets X-Forwarded-Proto. */
export function isSecure(headers: Record<string, string | string[] | undefined>, encrypted: boolean): boolean {
  if (encrypted) return true;
  const proto = headers["x-forwarded-proto"];
  const first = (Array.isArray(proto) ? proto[0] : proto)?.split(",")[0]?.trim();
  return first === "https";
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure ? "; Secure" : ""}`;
}

export function clearCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

/** Per-client sliding window limiter for login attempts. */
export class LoginLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private max = 8,
    private windowMs = 60_000,
  ) {}
  /** Returns true if the client may attempt now (and records the attempt). */
  allow(client: string, now = Date.now()): boolean {
    const arr = (this.hits.get(client) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) {
      this.hits.set(client, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(client, arr);
    if (this.hits.size > 10_000) this.hits.clear();
    return true;
  }
}

/** Client address as seen by a reverse proxy (first X-Forwarded-For hop) or the socket. */
export function clientAddress(headers: Record<string, string | string[] | undefined>, socketAddress: string | undefined, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = headers["x-forwarded-for"];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return socketAddress ?? "unknown";
}

export function loginPage(error: string | null, next: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>meme-trader · sign in</title>
<style>
:root{color-scheme:light dark;--bg:#f9f9f7;--card:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--border:rgba(11,11,11,.12);--accent:#2a78d6;--bad:#d03b3b}
@media(prefers-color-scheme:dark){:root{--bg:#0d0d0d;--card:#1a1a19;--ink:#fff;--ink2:#c3c2b7;--border:rgba(255,255,255,.12);--accent:#3987e5;--bad:#e66767}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
form{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:24px 22px;width:min(92vw,360px)}
h1{font-size:17px;margin:0 0 4px}p{margin:0 0 14px;color:var(--ink2);font-size:13px}
input{width:100%;box-sizing:border-box;font:inherit;padding:10px 12px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--ink)}
button{margin-top:12px;width:100%;font:inherit;font-weight:600;padding:10px;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer}
.err{color:var(--bad);font-size:13px;margin:10px 0 0}
</style></head><body><form method="post" action="/login"><h1>meme-trader</h1><p>Enter the dashboard token from <code>.env</code> (DASHBOARD_TOKEN).</p>
<input type="password" name="token" autocomplete="current-password" autofocus required placeholder="token"><input type="hidden" name="next" value="${esc(next)}"><button type="submit">Open dashboard</button>${error ? `<div class="err">${esc(error)}</div>` : ""}</form></body></html>`;
}

/** Only allow same-site relative redirect targets. */
export function safeNext(next: string | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/";
  return next;
}
