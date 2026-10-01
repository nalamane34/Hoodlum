import fs from "node:fs";
import path from "node:path";

export type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_PATTERNS = [/[1-9A-HJ-NP-Za-km-z]{85,90}/g]; // base58 64-byte secret keys

function scrub(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted-key]");
  return out;
}

export class Logger {
  private stream: fs.WriteStream | null = null;
  constructor(
    private level: Level,
    logFile?: string,
    private scope = "bot",
  ) {
    if (logFile) {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      this.stream = fs.createWriteStream(logFile, { flags: "a" });
    }
  }

  child(scope: string): Logger {
    const l = new Logger(this.level, undefined, scope);
    l.stream = this.stream;
    return l;
  }

  private write(level: Level, msg: string, data?: Record<string, unknown>): void {
    if (ORDER[level] < ORDER[this.level]) return;
    const ts = new Date().toISOString();
    const dataStr = data ? " " + scrub(JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v))) : "";
    const line = `${ts.slice(11, 23)} ${level.toUpperCase().padEnd(5)} [${this.scope}] ${scrub(msg)}${dataStr}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
    if (this.stream) {
      this.stream.write(
        scrub(JSON.stringify({ ts, level, scope: this.scope, msg, ...data }, (_k, v) => (typeof v === "bigint" ? v.toString() : v))) + "\n",
      );
    }
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.write("debug", msg, data);
  }
  info(msg: string, data?: Record<string, unknown>): void {
    this.write("info", msg, data);
  }
  warn(msg: string, data?: Record<string, unknown>): void {
    this.write("warn", msg, data);
  }
  error(msg: string, data?: Record<string, unknown>): void {
    this.write("error", msg, data);
  }
}
