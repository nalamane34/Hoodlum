import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logger.js";
import type { Position } from "../types.js";
import { errMsg } from "../util.js";

export interface StoreState {
  version: 1;
  positions: Record<string, Position>;
  paperSol: number;
  dailyPnl: Record<string, number>;
  consecutiveLosses: number;
  lastLossAt: number | null;
  learnedCreatorBlacklist: string[];
  closedCount: number;
  realizedPnlSol: number;
}

export type KillSwitch = "none" | "halt" | "liquidate";

/** JSON state file + append-only JSONL logs in DATA_DIR. */
export class Store {
  state: StoreState;
  private file: string;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(
    private dataDir: string,
    private log: Logger,
    paperStartSol: number,
  ) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "state.json");
    this.state = {
      version: 1,
      positions: {},
      paperSol: paperStartSol,
      dailyPnl: {},
      consecutiveLosses: 0,
      lastLossAt: null,
      learnedCreatorBlacklist: [],
      closedCount: 0,
      realizedPnlSol: 0,
    };
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<StoreState>;
      this.state = { ...this.state, ...parsed, positions: parsed.positions ?? {} };
    } catch (e) {
      this.log.error("could not read state file; starting fresh", { err: errMsg(e) });
    }
  }

  save(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 250);
  }

  saveNow(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  appendJsonl(name: string, obj: unknown): void {
    try {
      fs.appendFileSync(path.join(this.dataDir, name), JSON.stringify(obj) + "\n");
    } catch (e) {
      this.log.warn("jsonl append failed", { name, err: errMsg(e) });
    }
  }

  /**
   * Keeps only rows newer than `keepDays` in a JSONL file (by its `tsField`). Runs only when the file is large,
   * so the bot's disk does not fill up over months (launches.jsonl alone grows ~25 MB/day).
   */
  compactJsonl(name: string, keepDays: number, tsField = "ts", minBytes = 20 * 1024 * 1024): void {
    const file = path.join(this.dataDir, name);
    try {
      if (!fs.existsSync(file) || fs.statSync(file).size < minBytes) return;
      const cutoff = Date.now() - keepDays * 86_400_000;
      const lines = fs.readFileSync(file, "utf8").split("\n");
      const kept: string[] = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line) as Record<string, unknown>;
          const ts = Number(row[tsField] ?? row.ts ?? 0);
          if (ts >= cutoff) kept.push(line);
        } catch {
          /* drop torn lines */
        }
      }
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, kept.length ? kept.join("\n") + "\n" : "");
      fs.renameSync(tmp, file);
      this.log.info(`compacted ${name}: kept ${kept.length} of ${lines.length} rows (last ${keepDays} days)`);
    } catch (e) {
      this.log.warn("jsonl compaction failed", { name, err: errMsg(e) });
    }
  }

  killSwitch(): KillSwitch {
    const f = path.join(this.dataDir, "KILL");
    if (!fs.existsSync(f)) return "none";
    const txt = fs.readFileSync(f, "utf8").trim().toLowerCase();
    return txt.startsWith("liquidate") ? "liquidate" : "halt";
  }

  openPositions(): Position[] {
    return Object.values(this.state.positions).filter((p) => p.status === "open");
  }
}
