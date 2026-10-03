import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import type { Position, ScoredLaunch } from "../types.js";

/**
 * Fresh-data check of the entry rules frozen on 3 October 2026 (docs/EXPERIMENTS.md). The bot keeps buying with its
 * normal settings; this splits the trades opened since the freeze by whether each rule would have let them through.
 *   npm run rulecheck                          # trades opened since the freeze
 *   npm run rulecheck -- 2026-10-05T00:00:00Z  # trades opened since another time
 */
const FROZEN_AT = "2026-10-03T22:00:00Z";
const RULES: { name: string; pass: (d: ScoredLaunch) => boolean }[] = [
  { name: "score >= 70", pass: (d) => d.score >= 70 },
  { name: "creator holds < 2%", pass: (d) => Number(d.features.devPct) < 2 },
  { name: "market cap < 60 SOL", pass: (d) => Number(d.features.mcapSol) < 60 },
];

const dataDir = process.env.DATA_DIR ?? "./data";
const since = Date.parse(process.argv[2] ?? FROZEN_AT);
if (!Number.isFinite(since)) {
  console.log(`not a date: ${process.argv[2]}`);
  process.exit(1);
}
const rows = <T>(name: string, keep: (line: string) => boolean = () => true): T[] => {
  const file = path.join(dataDir, name);
  if (!fs.existsSync(file)) return [];
  const out: T[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim() || !keep(line)) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* torn line */
    }
  }
  return out;
};

const buys = new Map<string, ScoredLaunch>();
for (const d of rows<ScoredLaunch>("launches.jsonl", (l) => l.includes('"decision":"buy"'))) buys.set(d.mint, d);
const trades = rows<Position>("closed.jsonl")
  .filter((p) => p.strategy === "launch" && p.openedAt >= since && buys.has(p.mint))
  .map((p) => ({ pnl: p.realizedPnlSol, d: buys.get(p.mint)! }));

const line = (label: string, a: { pnl: number }[]): string => {
  if (!a.length) return `  ${label.padEnd(30)} no trades`;
  const total = a.reduce((s, x) => s + x.pnl, 0);
  const wins = a.filter((x) => x.pnl > 0).length;
  // Without the single best trade: a rule that only "works" because of one lucky trade does not count.
  const best = Math.max(...a.map((x) => x.pnl));
  const avgNoBest = a.length > 1 ? (total - best) / (a.length - 1) : NaN;
  return `  ${label.padEnd(30)} ${String(a.length).padStart(4)} trades  ${String(wins).padStart(3)} wins  total ${total >= 0 ? "+" : ""}${total.toFixed(4)} SOL  avg ${(total / a.length).toFixed(4)}  avg without best ${Number.isFinite(avgNoBest) ? avgNoBest.toFixed(4) : "-"}`;
};

console.log(`launch trades opened since ${new Date(since).toISOString()}: ${trades.length}${trades.length < 60 ? " (decide at 60 or more)" : ""}`);
console.log(line("all", trades));
for (const r of RULES) {
  console.log(`\n${r.name}`);
  console.log(line("allowed", trades.filter((t) => r.pass(t.d))));
  console.log(line("blocked", trades.filter((t) => !r.pass(t.d))));
}
console.log("\nall three rules together");
console.log(line("allowed", trades.filter((t) => RULES.every((r) => r.pass(t.d)))));
console.log(line("blocked by at least one", trades.filter((t) => !RULES.every((r) => r.pass(t.d)))));
