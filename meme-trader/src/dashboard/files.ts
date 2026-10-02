import fs from "node:fs";
import path from "node:path";

/**
 * Incrementally tails a JSONL file: only bytes appended since the last refresh are read, and rows older than
 * `keepMs` are dropped. Handles truncation/rotation by re-reading from the start.
 */
export class JsonlTail<T> {
  private offset = 0;
  private partial = "";
  private rows: T[] = [];

  constructor(
    private file: string,
    private tsOf: (row: T) => number,
    private keepMs: number,
  ) {}

  refresh(now = Date.now()): T[] {
    if (!fs.existsSync(this.file)) {
      this.reset();
      return this.rows;
    }
    const size = fs.statSync(this.file).size;
    if (size < this.offset) this.reset();
    if (size > this.offset) {
      const fd = fs.openSync(this.file, "r");
      try {
        while (this.offset < size) {
          const len = Math.min(8 * 1024 * 1024, size - this.offset);
          const buf = Buffer.alloc(len);
          const n = fs.readSync(fd, buf, 0, len, this.offset);
          if (n <= 0) break;
          this.offset += n;
          const text = this.partial + buf.subarray(0, n).toString("utf8");
          const lines = text.split("\n");
          this.partial = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              this.rows.push(JSON.parse(line) as T);
            } catch {
              /* skip a torn line */
            }
          }
        }
      } finally {
        fs.closeSync(fd);
      }
    }
    const cutoff = now - this.keepMs;
    let drop = 0;
    while (drop < this.rows.length && (this.tsOf(this.rows[drop]) || 0) < cutoff) drop++;
    if (drop > 0) this.rows.splice(0, drop);
    return this.rows;
  }

  private reset(): void {
    this.offset = 0;
    this.partial = "";
    this.rows = [];
  }
}

export function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Last `maxLines` lines of a (possibly large) text file, reading only its tail. */
export function tailLines(file: string, maxLines = 60, maxBytes = 96 * 1024): string[] {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - maxBytes);
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString("utf8").split("\n").filter((l) => l.trim().length > 0);
      if (start > 0) lines.shift(); // first line may be partial
      return lines.slice(-maxLines);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

export function fileMtimeMs(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

export function dataPath(dataDir: string, name: string): string {
  return path.join(dataDir, name);
}
