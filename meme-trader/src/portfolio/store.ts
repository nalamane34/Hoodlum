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
