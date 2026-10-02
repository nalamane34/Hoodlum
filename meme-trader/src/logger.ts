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

const MAX_LOG_BYTES = 50 * 1024 * 1024;

/** Shared file sink: one stream per log file, rotated to `<file>.1` when it passes MAX_LOG_BYTES. */
class FileSink {
  private stream: fs.WriteStream;
  private written = 0;
  private lastCheck = 0;
  constructor(private file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.stream = fs.createWriteStream(file, { flags: "a" });
    try {
      this.written = fs.statSync(file).size;
    } catch {
      this.written = 0;
    }
  }
  write(line: string): void {
    this.stream.write(line);
    this.written += line.length;
    const now = Date.now();
    if (this.written > MAX_LOG_BYTES && now - this.lastCheck > 60_000) {
      this.lastCheck = now;
      this.rotate();
    }
  }
  private rotate(): void {
    try {
      this.stream.end();
      fs.renameSync(this.file, `${this.file}.1`);
    } catch {
      /* keep writing to the current file */
    }
    this.stream = fs.createWriteStream(this.file, { flags: "a" });
    this.written = 0;
  }
}

export class Logger {
  private sink: FileSink | null = null;
  constructor(
    private level: Level,
    logFile?: string,
    private scope = "bot",
  ) {
    if (logFile) this.sink = new FileSink(logFile);
  }

  child(scope: string): Logger {
    const l = new Logger(this.level, undefined, scope);
    l.sink = this.sink;
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
    if (this.sink) {
      this.sink.write(scrub(JSON.stringify({ ts, level, scope: this.scope, msg, ...data }, (_k, v) => (typeof v === "bigint" ? v.toString() : v))) + "\n");
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
