import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Logger } from "../src/logger.js";
import { Store } from "../src/portfolio/store.js";

describe("Store daily files", () => {
  it("appends to one file per UTC day and deletes days older than the retention", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-store-"));
    const store = new Store(dir, new Logger("error"), 5);
    const day = 86_400_000;
    const now = Date.parse("2026-10-10T12:00:00Z");
    store.appendDaily("paths", { a: 1 }, now);
    store.appendDaily("paths", { a: 2 }, now);
    store.appendDaily("paths", { a: 3 }, now - 3 * day);
    store.appendDaily("paths", { a: 4 }, now - 9 * day);
    const files = () => fs.readdirSync(path.join(dir, "paths")).sort();
    expect(files()).toEqual(["2026-10-01.jsonl", "2026-10-07.jsonl", "2026-10-10.jsonl"]);
    expect(fs.readFileSync(path.join(dir, "paths", "2026-10-10.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
    store.pruneDaily("paths", 7, now);
    expect(files()).toEqual(["2026-10-07.jsonl", "2026-10-10.jsonl"]);
    store.pruneDaily("missing", 7, now); // no directory yet: no throw
  });
});
