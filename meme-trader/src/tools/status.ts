import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import type { Position } from "../types.js";

const dataDir = process.env.DATA_DIR ?? "./data";
const file = path.join(dataDir, "state.json");
if (!fs.existsSync(file)) {
  console.log(`no state yet at ${file}`);
  process.exit(0);
}
const s = JSON.parse(fs.readFileSync(file, "utf8")) as {
  positions: Record<string, Position>;
  paperSol: number;
  dailyPnl: Record<string, number>;
  realizedPnlSol: number;
  closedCount: number;
  consecutiveLosses: number;
  learnedCreatorBlacklist: string[];
};
const positions = Object.values(s.positions);
const open = positions.filter((p) => p.status === "open");
const closed = positions.filter((p) => p.status === "closed");
const today = new Date().toISOString().slice(0, 10);
console.log(`paper balance: ${s.paperSol.toFixed(4)} SOL`);
console.log(`realized pnl:  ${s.realizedPnlSol.toFixed(4)} SOL over ${s.closedCount} closed positions; today ${(s.dailyPnl[today] ?? 0).toFixed(4)} SOL; consecutive losses ${s.consecutiveLosses}`);
console.log(`learned creator blacklist: ${s.learnedCreatorBlacklist.length}`);
console.log(`\nOPEN (${open.length})`);
for (const p of open) {
  console.log(`  ${p.symbol.padEnd(10)} ${p.strategy.padEnd(6)} ${(p.lastPrice / p.entryPrice).toFixed(2)}x  tokens ${Math.round(p.tokens)}  cost ${p.costSol.toFixed(4)}  proceeds ${p.proceedsSol.toFixed(4)}  ${p.mint}`);
}
const wins = closed.filter((p) => p.realizedPnlSol > 0).length;
console.log(`\nCLOSED (${closed.length}) win rate ${closed.length ? ((wins / closed.length) * 100).toFixed(0) : 0}%`);
for (const p of closed.slice(-15)) {
  console.log(`  ${p.symbol.padEnd(10)} ${p.strategy.padEnd(6)} ${p.realizedPnlSol >= 0 ? "+" : ""}${p.realizedPnlSol.toFixed(4)} SOL  ${p.exitReasons.join(",")}`);
}
const kill = path.join(dataDir, "KILL");
if (fs.existsSync(kill)) console.log(`\nKILL switch active: ${fs.readFileSync(kill, "utf8").trim() || "halt"}`);
