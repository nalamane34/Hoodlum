import "dotenv/config";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { COOKIE_NAME, LoginLimiter, clearCookie, clientAddress, cookieValue, isSecure, loginPage, safeEqual, safeNext, sessionCookie } from "../dashboard/auth.js";
import { JsonlTail, dataPath, fileMtimeMs, readJsonFile, tailLines } from "../dashboard/files.js";
import { summarize, type FillRow, type ShadowRow, type StateFile, type Summary } from "../dashboard/summary.js";
import type { Position, ScoredLaunch } from "../types.js";

/**
 * Read-only dashboard for the bot's data directory. Serves one page and one JSON endpoint.
 *   DASHBOARD_HOST   127.0.0.1 (default; reach it through an SSH tunnel or a reverse proxy such as Caddy) or 0.0.0.0
 *   DASHBOARD_PORT   8787
 *   DASHBOARD_TOKEN  required unless the host is loopback; entered once on /login (a cookie is set), or passed as ?token=
 *   DASHBOARD_TRUST_PROXY  true when behind Caddy/nginx: use X-Forwarded-For / X-Forwarded-Proto for rate limiting and Secure cookies
 */
const DATA_DIR = process.env.DATA_DIR ?? "./data";
const HOST = process.env.DASHBOARD_HOST ?? "127.0.0.1";
const PORT = Number(process.env.DASHBOARD_PORT ?? 8787);
const TOKEN = process.env.DASHBOARD_TOKEN?.trim() || null;
const TRUST_PROXY = ["1", "true", "yes"].includes((process.env.DASHBOARD_TRUST_PROXY ?? "").toLowerCase());
const MODE = (process.env.MODE as "paper" | "live" | undefined) ?? "paper";
const MIN_SCORE = Number(process.env.MIN_SCORE ?? 55);
const KEEP_DAYS = Number(process.env.DASHBOARD_KEEP_DAYS ?? 7);

const loopback = HOST === "127.0.0.1" || HOST === "localhost" || HOST === "::1";
if (!loopback && !TOKEN) {
  console.error("DASHBOARD_HOST is not loopback: set DASHBOARD_TOKEN (e.g. `openssl rand -hex 12`) before exposing the dashboard.");
  process.exit(1);
}
if (loopback && !TOKEN && TRUST_PROXY) {
  console.error("DASHBOARD_TRUST_PROXY is set (a reverse proxy will expose this): set DASHBOARD_TOKEN.");
  process.exit(1);
}

const keepMs = KEEP_DAYS * 86_400_000;
const launches = new JsonlTail<ScoredLaunch>(dataPath(DATA_DIR, "launches.jsonl"), (r) => r.ts, keepMs);
const shadow = new JsonlTail<ShadowRow>(dataPath(DATA_DIR, "shadow_outcomes.jsonl"), (r) => r.ts, keepMs);
const fills = new JsonlTail<FillRow>(dataPath(DATA_DIR, "fills.jsonl"), (r) => r.ts, 365 * 86_400_000);
const closed = new JsonlTail<Position>(dataPath(DATA_DIR, "closed.jsonl"), (r) => r.closedAt ?? r.openedAt, 365 * 86_400_000);
const limiter = new LoginLimiter(8, 60_000);

const htmlCandidates = [path.resolve(__dirname, "../../dashboard/index.html"), path.resolve(process.cwd(), "dashboard/index.html")];
const htmlFile = htmlCandidates.find((f) => fs.existsSync(f));
if (!htmlFile) {
  console.error(`dashboard/index.html not found (looked in ${htmlCandidates.join(", ")})`);
  process.exit(1);
}

const cache = new Map<number, { at: number; body: string }>();

function buildSummary(hours: number): Summary {
  const now = Date.now();
  const killFile = dataPath(DATA_DIR, "KILL");
  let kill: "none" | "halt" | "liquidate" = "none";
  if (fs.existsSync(killFile)) kill = fs.readFileSync(killFile, "utf8").trim().toLowerCase().startsWith("liquidate") ? "liquidate" : "halt";
  return summarize({
    now,
    windowHours: hours,
    mode: MODE,
    minScore: MIN_SCORE,
    state: readJsonFile<StateFile>(dataPath(DATA_DIR, "state.json")),
    launches: launches.refresh(now),
    shadow: shadow.refresh(now),
    fills: fills.refresh(now),
    closed: closed.refresh(now),
    logLines: tailLines(dataPath(DATA_DIR, "bot.log"), 60),
    lastLogAt: fileMtimeMs(dataPath(DATA_DIR, "bot.log")),
    kill,
  });
}

function authorised(req: http.IncomingMessage, url: URL): boolean {
  if (!TOKEN) return true;
  const q = url.searchParams.get("token");
  if (q && safeEqual(q, TOKEN)) return true;
  const c = cookieValue(req.headers.cookie, COOKIE_NAME);
  return Boolean(c && safeEqual(c, TOKEN));
}

function readBody(req: http.IncomingMessage, limit = 4096): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
      if (data.length > limit) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const baseHeaders: Record<string, string> = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const secure = isSecure(req.headers, Boolean((req.socket as { encrypted?: boolean }).encrypted));
    const client = clientAddress(req.headers, req.socket.remoteAddress, TRUST_PROXY);
    const headers = { ...baseHeaders };

    if (url.pathname === "/login" && TOKEN) {
      if (req.method === "POST") {
        if (!limiter.allow(client)) {
          res.writeHead(429, { ...headers, "content-type": "text/html; charset=utf-8", "retry-after": "60" });
          res.end(loginPage("Too many attempts. Wait a minute and try again.", "/"));
          return;
        }
        const body = await readBody(req);
        const form = new URLSearchParams(body);
        const next = safeNext(form.get("next"));
        if (safeEqual(form.get("token") ?? "", TOKEN)) {
          res.writeHead(303, { ...headers, "set-cookie": sessionCookie(TOKEN, secure), location: next });
          res.end();
        } else {
          res.writeHead(401, { ...headers, "content-type": "text/html; charset=utf-8" });
          res.end(loginPage("That token is not correct.", next));
        }
        return;
      }
      res.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" });
      res.end(loginPage(null, safeNext(url.searchParams.get("next"))));
      return;
    }
    if (url.pathname === "/healthz") {
      res.writeHead(200, { ...headers, "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (url.pathname === "/logout") {
      res.writeHead(303, { ...headers, "set-cookie": clearCookie(), location: TOKEN ? "/login" : "/" });
      res.end();
      return;
    }

    if (!authorised(req, url)) {
      if (url.pathname.startsWith("/api/")) {
        res.writeHead(401, { ...headers, "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorised" }));
      } else {
        res.writeHead(303, { ...headers, location: `/login?next=${encodeURIComponent(url.pathname + url.search)}` });
        res.end();
      }
      return;
    }
    // A token passed in the query string is exchanged for a cookie and removed from the URL.
    if (TOKEN && url.searchParams.get("token")) {
      url.searchParams.delete("token");
      res.writeHead(303, { ...headers, "set-cookie": sessionCookie(TOKEN, secure), location: url.pathname + (url.search || "") });
      res.end();
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(htmlFile, "utf8"));
      return;
    }
    if (url.pathname === "/api/agent") {
      const dir = dataPath(DATA_DIR, "agent");
      const jobs: { name: string; mtime: number; exit: number | null; tail: string[] }[] = [];
      let agentLog: string[] = [];
      if (fs.existsSync(dir)) {
        agentLog = tailLines(path.join(dir, "agent.log"), 40);
        for (const f of fs.readdirSync(dir).filter((x) => /^\d+-.*\.log$/.test(x)).sort()) {
          const file = path.join(dir, f);
          const tail = tailLines(file, 120);
          const m = /finished .* exit (\d+)/.exec(tail[tail.length - 1] ?? "");
          jobs.push({ name: f.replace(/\.log$/, ""), mtime: fileMtimeMs(file) ?? 0, exit: m ? Number(m[1]) : null, tail });
        }
      }
      res.writeHead(200, { ...headers, "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ generatedAt: Date.now(), agentLog, jobs: jobs.slice(-10) }));
      return;
    }
    if (url.pathname === "/api/summary") {
      const hours = Math.min(24 * 30, Math.max(1, Number(url.searchParams.get("hours") ?? 24) || 24));
      const hit = cache.get(hours);
      let body: string;
      if (hit && Date.now() - hit.at < 2000) body = hit.body;
      else {
        body = JSON.stringify(buildSummary(hours));
        cache.set(hours, { at: Date.now(), body });
      }
      res.writeHead(200, { ...headers, "content-type": "application/json; charset=utf-8" });
      res.end(body);
      return;
    }
    res.writeHead(404, { ...headers, "content-type": "text/plain" });
    res.end("not found");
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(`error: ${e instanceof Error ? e.message : String(e)}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`dashboard listening on http://${HOST}:${PORT}/ (data: ${path.resolve(DATA_DIR)}, window up to ${KEEP_DAYS} days, token ${TOKEN ? "required" : "not set"}, trust proxy ${TRUST_PROXY})`);
  if (loopback && !TRUST_PROXY) console.log(`tunnel from your machine:  ssh -i YOUR.pem -L ${PORT}:127.0.0.1:${PORT} ubuntu@YOUR_SERVER   then open http://localhost:${PORT}/`);
});
