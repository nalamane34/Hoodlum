import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { loadConfig } from "../config.js";
import { replayTrade, type ReplayOptions, type ReplayResult } from "../strategy/replay.js";
import type { PathPoint } from "../strategy/tracker.js";

/**
 * Replays the exit rules on every saved price path (data/paths): each observed launch is bought at its decision time,
 * with a realistic delay on the buy and on every sell. Results are split by time, older part first, so a setting
 * tuned on the first part is judged on the second. Settings come from .env; override them for a what-if:
 *   npm run backtest
 *   npm run backtest -- --set TP_LADDER=1.3:100 --set TRAIL_PCT=20 --delay 1500 --tick 1000 --split 0.6
 * "bot would buy" = score >= MIN_SCORE and no hard fail other than risk gates (hard fails as recorded at the time).
 */
const args = process.argv.slice(2);
const sets: Record<string, string> = {};
let delayMs = 1500;
let tickMs = 1000;
let split = 0.6;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const v = args[i + 1];
  if (a === "--set" && v?.includes("=")) {
    const [k, ...rest] = v.split("=");
    sets[k] = rest.join("=");
    i++;
  } else if (a === "--delay" && v) (delayMs = Number(v)), i++;
  else if (a === "--tick" && v) (tickMs = Number(v)), i++;
  else if (a === "--split" && v) (split = Number(v)), i++;
  else {
    console.log(`unknown argument ${a}`);
    process.exit(1);
  }
}
const cfg = loadConfig({ ...process.env, ...sets });
const dataDir = cfg.DATA_DIR;
const opts: ReplayOptions = { stakeSol: cfg.BUY_SOL, slippagePct: cfg.PAPER_SLIPPAGE_PCT, feeSol: cfg.PAPER_FEE_SOL, delayMs, tickMs };

async function* lines(file: string): AsyncGenerator<string> {
  if (!fs.existsSync(file)) return;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) yield line;
}

interface Row {
  ts: number;
  wouldBuy: boolean;
  r: ReplayResult;
}

async function main(): Promise<void> {
  const decisions = new Map<string, { ts: number; wouldBuy: boolean }>();
  for await (const line of lines(path.join(dataDir, "launches.jsonl"))) {
    if (!line.includes('"uniqueBuyers"')) continue; // observed launches only (prefiltered ones have no observation)
    try {
      const d = JSON.parse(line) as { mint: string; ts: number; score: number; hardFails: string[] };
      const hard = d.hardFails.filter((f) => !f.startsWith("risk:"));
      decisions.set(d.mint, { ts: d.ts, wouldBuy: hard.length === 0 && d.score >= cfg.MIN_SCORE });
    } catch {
      /* torn line */
    }
  }
  const rows: Row[] = [];
  const done = new Set<string>();
  const dir = path.join(dataDir, "paths");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort() : [];
  for (const f of files) {
    for await (const line of lines(path.join(dir, f))) {
      try {
        const p = JSON.parse(line) as { mint: string; firstSeen: number; points: PathPoint[] };
        const d = decisions.get(p.mint);
        if (!d || done.has(p.mint)) continue;
        done.add(p.mint);
        const r = replayTrade(p.points, p.firstSeen, d.ts, cfg.exits, opts);
        if (r) rows.push({ ts: d.ts, wouldBuy: d.wouldBuy, r });
      } catch {
        /* torn line */
      }
    }
  }
  rows.sort((a, b) => a.ts - b.ts);
  if (rows.length < 10) {
    console.log(`only ${rows.length} launches with a saved path and a decision record; let the bot run longer`);
    return;
  }
  const cut = Math.floor(rows.length * split);
  const day = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ");
  const parts: [string, Row[]][] = [
    [`older ${day(rows[0].ts)} to ${day(rows[cut - 1].ts)}`, rows.slice(0, cut)],
    [`newer ${day(rows[cut].ts)} to ${day(rows[rows.length - 1].ts)}`, rows.slice(cut)],
  ];
  const line = (label: string, a: Row[]): string => {
    if (!a.length) return `    ${label.padEnd(16)} no trades`;
    const pnl = a.map((x) => x.r.pnlSol);
    const total = pnl.reduce((s, x) => s + x, 0);
    const best = Math.max(...pnl);
    const wins = pnl.filter((x) => x > 0).length;
    const noBest = a.length > 1 ? (total - best) / (a.length - 1) : NaN;
    return `    ${label.padEnd(16)} ${String(a.length).padStart(5)} trades  win ${((100 * wins) / a.length).toFixed(0).padStart(3)}%  avg ${(total / a.length).toFixed(4).padStart(8)} SOL  without best ${Number.isFinite(noBest) ? noBest.toFixed(4).padStart(8) : "       -"}  total ${total >= 0 ? "+" : ""}${total.toFixed(3)}`;
  };
  const overrides = Object.entries(sets).map(([k, v]) => `${k}=${v}`).join(" ");
  console.log(`exits ${overrides || "from .env"}; stake ${opts.stakeSol} SOL, slippage ${opts.slippagePct}% per fill, fee ${opts.feeSol} SOL per tx, delay ${delayMs} ms, exit check every ${tickMs || "trade"}${tickMs ? " ms" : ""}`);
  for (const [label, a] of parts) {
    console.log(`\n  ${label}`);
    console.log(line("all launches", a));
    console.log(line("bot would buy", a.filter((x) => x.wouldBuy)));
  }
  const reasons = new Map<string, number>();
  for (const x of rows) if (x.wouldBuy) {
    const k = x.r.reason.replace(/_-?[\d.]+(pct)?(_from_peak)?$/, "");
    reasons.set(k, (reasons.get(k) ?? 0) + 1);
  }
  console.log(`\n  first exit reasons (bot would buy): ${[...reasons].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
