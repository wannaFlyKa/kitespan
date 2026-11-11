// R127: the one log line that holds a path (FIX-R127 section 2, "Log the folder's path (never an environment) in
// kitespan's log"; DESIGN 4.9 guard 5's one exception): a `trust` line per answer, with the trusted folder's path and the
// answer only. Every other event still holds no path, and a `trust` line holds nothing else.
import { describe, expect, test } from "bun:test";
import { logLine, type LogFields } from "../../server/log";

const ROUTES = new Set(["/ws"]);
const T0 = new Date("2026-11-05T10:00:00.000Z");
const DIR = "/srv/you/projects/shop/tasks/remove-negative-qty";

describe("the trust line", () => {
  test("it holds the path and the answer, and no other field", () => {
    const line = logLine("trust", { path: DIR, answer: "trusted", chat: "k3m7q2x4abk3m7q2x4ab", ms: 812, code: 0, err: "unknown" }, T0, ROUTES);
    expect(line).toEqual({ t: "2026-11-05T10:00:00.000Z", ev: "trust", chat: null, route: null, code: null, signal: null, ms: null, ok: null, timeout: null, capped: null, err: null, path: DIR, answer: "trusted" });
  });

  test("each answer is kept; anything else is null", () => {
    for (const a of ["trusted", "already", "not_recorded", "failed", "gone"]) expect(logLine("trust", { path: DIR, answer: a }, T0, ROUTES).answer).toBe(a);
    expect(logLine("trust", { path: DIR, answer: "rm -rf" }, T0, ROUTES).answer).toBeNull();
  });

  test("a path that is not one kitespan would trust (relative, a control character, over 4,096 bytes) is null", () => {
    for (const p of ["shop/tasks", "/a\nb", `/${"a".repeat(4096)}`, "", 7]) expect(logLine("trust", { path: p, answer: "failed" } as unknown as LogFields, T0, ROUTES).path).toBeNull();
  });

  test("no other event holds a path or an answer, even when one is passed", () => {
    for (const ev of ["claude_start", "turn_end", "bash", "side", "error"] as const) {
      const line = logLine(ev, { path: DIR, answer: "trusted", ok: true } as LogFields, T0, ROUTES) as unknown as Record<string, unknown>;
      expect("path" in line).toBe(false);
      expect("answer" in line).toBe(false);
      expect(JSON.stringify(line)).not.toContain("/srv/you");
    }
  });
});
