import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { JsonlTail, dataPath, fileMtimeMs, readJsonFile, tailLines } from "../dashboard/files.js";
import { summarize, type FillRow, type ShadowRow, type StateFile, type Summary } from "../dashboard/summary.js";
import type { Position, ScoredLaunch } from "../types.js";

/**
 * Read-only dashboard for the bot's data directory. Serves one page and one JSON endpoint.
 *   DASHBOARD_HOST   127.0.0.1 (default; reach it through an SSH tunnel) or 0.0.0.0 (needs DASHBOARD_TOKEN)
 *   DASHBOARD_PORT   8787
 *   DASHBOARD_TOKEN  required when the host is not loopback; pass once as ?token=... (a cookie is set)
 */
const DATA_DIR = process.env.DATA_DIR ?? "./data";
const HOST = process.env.DASHBOARD_HOST ?? "127.0.0.1";
const PORT = Number(process.env.DASHBOARD_PORT ?? 8787);
const TOKEN = process.env.DASHBOARD_TOKEN?.trim() || null;
const MODE = (process.env.MODE as "paper" | "live" | undefined) ?? "paper";
const MIN_SCORE = Number(process.env.MIN_SCORE ?? 55);
const KEEP_DAYS = Number(process.env.DASHBOARD_KEEP_DAYS ?? 7);

const loopback = HOST === "127.0.0.1" || HOST === "localhost" || HOST === "::1";
if (!loopback && !TOKEN) {
  console.error("DASHBOARD_HOST is not loopback: set DASHBOARD_TOKEN (e.g. `openssl rand -hex 12`) before exposing the dashboard.");
  process.exit(1);
}

const keepMs = KEEP_DAYS * 86_400_000;
const launches = new JsonlTail<ScoredLaunch>(dataPath(DATA_DIR, "launches.jsonl"), (r) => r.ts, keepMs);
const shadow = new JsonlTail<ShadowRow>(dataPath(DATA_DIR, "shadow_outcomes.jsonl"), (r) => r.ts, keepMs);
const fills = new JsonlTail<FillRow>(dataPath(DATA_DIR, "fills.jsonl"), (r) => r.ts, 365 * 86_400_000);
const closed = new JsonlTail<Position>(dataPath(DATA_DIR, "closed.jsonl"), (r) => r.closedAt ?? r.openedAt, 365 * 86_400_000);

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
  const cookie = req.headers.cookie ?? "";
  const m = /(?:^|;\s*)mt=([^;]+)/.exec(cookie);
  return Boolean(m && safeEqual(decodeURIComponent(m[1]), TOKEN));
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (!authorised(req, url)) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("unauthorised: open the dashboard with ?token=... once");
      return;
    }
    const headers: Record<string, string> = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
    if (TOKEN && url.searchParams.get("token")) headers["set-cookie"] = `mt=${encodeURIComponent(TOKEN)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`;
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(htmlFile, "utf8"));
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
  console.log(`dashboard listening on http://${HOST}:${PORT}/${TOKEN ? `?token=${TOKEN}` : ""} (data: ${path.resolve(DATA_DIR)}, window up to ${KEEP_DAYS} days)`);
  if (loopback) console.log(`tunnel from your machine:  ssh -i YOUR.pem -L ${PORT}:127.0.0.1:${PORT} ubuntu@YOUR_SERVER   then open http://localhost:${PORT}/`);
});
