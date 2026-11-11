// R131 (FIX-R131 section 2, "Log the short id and the answer only"; DESIGN-R131 9.8): a `bg_stop` line per Stop of a
// background session holds its short id and the answer, and a `bg_list` line per run of Claude Code's list its time,
// exit code and count of rows kept. Neither holds a path, a name, another session's id or any output, and no other
// event holds their fields.
import { describe, expect, test } from "bun:test";
import { logLine, type LogFields } from "../../server/log";

const ROUTES = new Set(["/ws"]);
const T0 = new Date("2026-11-05T10:00:00.000Z");
const BASE = { t: "2026-11-05T10:00:00.000Z", chat: null, route: null, code: null, signal: null, ms: null, ok: null, timeout: null, capped: null, err: null };

describe("the background lines", () => {
  test("bg_stop: the short id and the answer, nothing else", () => {
    const line = logLine("bg_stop", { id: "3f9a1c2e", answer: "stopped", chat: "k3m7q2x4abk3m7q2x4ab", path: "/srv/you/shop", ms: 40, code: 0 }, T0, ROUTES);
    expect(line).toEqual({ ...BASE, ev: "bg_stop", id: "3f9a1c2e", answer: "stopped" });
    for (const a of ["stopped", "not_found", "failed"]) expect(logLine("bg_stop", { id: "3f9a1c2e", answer: a }, T0, ROUTES).answer).toBe(a);
    expect(logLine("bg_stop", { id: "3f9a1c2e", answer: "trusted" }, T0, ROUTES).answer).toBeNull();
    for (const id of ["3F9A1C2E", "7e682626-781a-4916-b942-8fa4f25780e9", "investigate"]) expect(logLine("bg_stop", { id, answer: "failed" }, T0, ROUTES).id).toBeNull();
  });

  test("bg_list: the run's time, its exit code and the count of rows kept, nothing else", () => {
    const line = logLine("bg_list", { ms: 191.6, code: 0, count: 2, id: "3f9a1c2e", answer: "stopped", path: "/srv/you/shop" }, T0, ROUTES);
    expect(line).toEqual({ ...BASE, ev: "bg_list", ms: 192, code: 0, count: 2 });
    expect(logLine("bg_list", { ms: 3, code: null, count: -1 }, T0, ROUTES).count).toBeNull();
  });

  test("no other event holds an id or a count, even when one is passed", () => {
    for (const ev of ["claude_start", "turn_end", "bash", "side", "trust", "error"] as const) {
      const line = logLine(ev, { id: "3f9a1c2e", count: 3 } as LogFields, T0, ROUTES) as unknown as Record<string, unknown>;
      expect("id" in line).toBe(false);
      expect("count" in line).toBe(false);
    }
  });
});
