// U5 (FIX-U5 1 "The log"; DESIGN-U5 10): a `search` line holds the query's length, the chats read from disk, the time,
// whether the answer was complete, whether the deadline cut it and whether the memory cap left chats out; never the
// query's text, a snippet, a title or a message's id, and no other event holds `len`.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createLogger, logLine, type LogFields } from "../../server/log";

const ROUTES = new Set(["/ws"]);
const T0 = new Date("2026-11-06T10:00:00.000Z");
const BASE = { t: "2026-11-06T10:00:00.000Z", chat: null, route: null, code: null, signal: null, ms: null, ok: null, timeout: null, capped: null, err: null };

describe("the search line", () => {
  test("len, count, ms, ok, timeout and capped; nothing else, whatever is passed", () => {
    const passed = { len: 10, count: 3, ms: 41.4, ok: true, timeout: false, capped: false, chat: "k3m7q2x4abk3m7q2x4ab", path: "/srv/you/shop", answer: "memory cap", id: "msg_01" } as LogFields;
    expect(logLine("search", passed, T0, ROUTES)).toEqual({ ...BASE, ev: "search", ms: 41, ok: true, timeout: false, capped: false, count: 3, len: 10 });
  });
  test("a background read's line has len null; a bad number is null", () => {
    expect(logLine("search", { len: null, count: 200, ms: 520, ok: true, timeout: false, capped: true }, T0, ROUTES)).toMatchObject({ len: null, count: 200, capped: true });
    expect(logLine("search", { len: -1, count: 1.5 }, T0, ROUTES)).toMatchObject({ len: null, count: null });
    expect(logLine("search", { len: "memory" as unknown as number }, T0, ROUTES).len).toBeNull();
  });
  test("no other event holds len", () => {
    for (const ev of ["claude_start", "turn_end", "corpus", "bg_list", "side", "error"] as const) {
      const line = logLine(ev, { len: 4 } as LogFields, T0, ROUTES) as unknown as Record<string, unknown>;
      expect("len" in line).toBe(false);
    }
  });
  test("the file's line never holds the query's text", () => {
    const dir = mkdtempSync(join(tmpdir(), "log-search-"));
    try {
      const log = createLogger({ dir, now: () => T0 });
      log.log("search", { len: 10, count: 2, ms: 5, ok: true, timeout: false, capped: false, answer: "memory cap", path: "memory cap" } as LogFields);
      log.close();
      const text = readFileSync(join(dir, "kitespan-2026-11-06.log"), "utf8");
      expect(text).toContain('"ev":"search"');
      expect(text).toContain('"len":10');
      expect(text).not.toContain("memory");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
