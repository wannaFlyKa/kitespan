// The counts-only logger (DESIGN.md 4.4 "logs/", 4.9 guard 5), in scratch folders.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOG_ERRORS, LOG_EVENTS, createLogger, logFileName, logLine, type LogFields } from "../../server/log";

const scratch: string[] = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "kitespan-log-"));
  scratch.push(d);
  return d;
};
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

const CHAT = "k3m7q2x4abk3m7q2x4ab";
const ROUTES = new Set(["/c/:chat/files/*", "/ws"]);
const T0 = new Date("2026-10-31T23:59:59.000Z");
const KEYS = ["t", "ev", "chat", "route", "code", "signal", "ms", "ok", "timeout", "capped", "err"];

describe("logLine", () => {
  test("every field keeps only what its rule allows", () => {
    expect(logLine("bash", { chat: CHAT, route: "/c/:chat/files/*", code: 2, signal: "SIGTERM", ms: 12.6, ok: true, timeout: false, capped: true }, T0, ROUTES)).toEqual({
      t: "2026-10-31T23:59:59.000Z",
      ev: "bash",
      chat: CHAT,
      route: "/c/:chat/files/*",
      code: 2,
      signal: "SIGTERM",
      ms: 13,
      ok: true,
      timeout: false,
      capped: true,
      err: null,
    });
  });
  test("a path, a query string, an Origin, text or a bad value becomes null", () => {
    const f = {
      chat: "../../etc",
      route: `/c/${CHAT}/files/secret.txt`,
      code: 1.5,
      signal: "kill -9",
      ms: -1,
      ok: "yes",
      err: "ENOENT: no such file /var/x",
    } as unknown as LogFields;
    const line = logLine("error", f, T0, ROUTES);
    expect(line).toMatchObject({ chat: null, route: null, code: null, signal: null, ms: null, ok: null, err: null });
    expect(logLine("origin_refused", { route: "/ws?origin=https://evil.invalid" }, T0, ROUTES).route).toBeNull();
    expect(logLine("origin_refused", { route: "/ws" }, T0, ROUTES).route).toBe("/ws");
  });
  test("a reconnect line holds the chat, ok (a replay or a snapshot) and ms only (R9)", () => {
    const line = logLine("reconnect", { chat: CHAT, ok: true, ms: 41.7, route: "/ws", code: 3, signal: "SIGTERM", timeout: false, capped: true, err: "ws_send" }, T0, ROUTES);
    expect(line).toEqual({ t: "2026-10-31T23:59:59.000Z", ev: "reconnect", chat: CHAT, route: null, code: null, signal: null, ms: 42, ok: true, timeout: null, capped: null, err: null });
  });
  test("extra fields never reach a line", () => {
    const line = logLine("turn_end", { ok: true, text: "the user's prompt", input: { cmd: "ls" } } as unknown as LogFields, T0, ROUTES);
    expect(Object.keys(line)).toEqual(KEYS);
    expect(JSON.stringify(line)).not.toContain("prompt");
  });
  test("an unknown event is a programming error", () => {
    expect(() => logLine("prompt" as never, {}, T0, ROUTES)).toThrow();
  });
  test("the fixed lists", () => {
    expect([...LOG_EVENTS]).toEqual(["claude_start", "claude_exit", "turn_end", "bash", "corpus", "origin_refused", "reconnect", "restart", "update", "side", "trust", "bg_stop", "bg_list", "push", "push_gone", "push_device", "search", "changes", "browser", "browser_view", "browser_download", "error"]);
    expect(LOG_ERRORS).toContain("unknown");
  });
  test("R124: a side question's line holds its chat, how it ended and its time, never its text", () => {
    const line = logLine("side", { chat: "k3m7q2x4abk3m7q2x4ab", ok: true, ms: 1700, code: 3, err: "sdk_error" }, T0, ROUTES);
    expect(line).toMatchObject({ ev: "side", chat: "k3m7q2x4abk3m7q2x4ab", ok: true, ms: 1700, code: null, err: null });
  });
  test("one file per UTC day", () => {
    expect(logFileName(T0)).toBe("kitespan-2026-10-31.log");
    expect(logFileName(new Date("2026-11-01T00:00:00.000Z"))).toBe("kitespan-2026-11-01.log");
  });
});

describe("createLogger", () => {
  test("it makes the folder 0700 and writes 0600 JSON lines, one per call", () => {
    const dir = join(fresh(), "logs");
    const log = createLogger({ dir, now: () => T0 });
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
    log.log("claude_start", { chat: CHAT });
    log.log("claude_exit", { chat: CHAT, code: 0, ms: 1500 });
    log.close();
    const file = join(dir, logFileName(T0));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const lines = readFileSync(file, "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.ev)).toEqual(["claude_start", "claude_exit"]);
    expect(lines[1]).toMatchObject({ chat: CHAT, code: 0, ms: 1500 });
    expect(log.failures).toBe(0);
  });
  test("it moves to a new file when the UTC day changes, and appends to an existing one", () => {
    const dir = fresh();
    let now = T0;
    const log = createLogger({ dir, now: () => now });
    log.log("restart");
    now = new Date("2026-11-01T00:00:01.000Z");
    log.log("restart");
    log.close();
    const again = createLogger({ dir, now: () => now });
    again.log("reconnect");
    again.close();
    expect(readFileSync(join(dir, "kitespan-2026-10-31.log"), "utf8").trimEnd().split("\n")).toHaveLength(1);
    expect(readFileSync(join(dir, "kitespan-2026-11-01.log"), "utf8").trimEnd().split("\n")).toHaveLength(2);
  });
  test("the sweep removes day files older than 14 days and nothing else", () => {
    const dir = fresh();
    chmodSync(dir, 0o700);
    for (const name of ["kitespan-2026-10-16.log", "kitespan-2026-10-17.log", "kitespan-2026-10-30.log", "notes.txt", "kitespan-latest.log"]) writeFileSync(join(dir, name), "x\n", { mode: 0o600 });
    const log = createLogger({ dir, now: () => T0 });
    log.close();
    expect(existsSync(join(dir, "kitespan-2026-10-16.log"))).toBe(false);
    expect(existsSync(join(dir, "kitespan-2026-10-17.log"))).toBe(true);
    expect(existsSync(join(dir, "kitespan-2026-10-30.log"))).toBe(true);
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
    expect(existsSync(join(dir, "kitespan-latest.log"))).toBe(true);
  });
  test("a symbolic link planted at the day's file name is never followed", () => {
    const base = fresh();
    const dir = join(base, "logs");
    mkdirSync(dir, { mode: 0o700 });
    const target = join(base, "target.txt");
    writeFileSync(target, "untouched\n", { mode: 0o600 });
    symlinkSync(target, join(dir, logFileName(T0)));
    const log = createLogger({ dir, now: () => T0 });
    log.log("restart");
    log.close();
    expect(readFileSync(target, "utf8")).toBe("untouched\n");
    expect(log.failures).toBe(1);
  });
  test("a day file with a wider mode is refused, not written", () => {
    const dir = fresh();
    chmodSync(dir, 0o700);
    writeFileSync(join(dir, logFileName(T0)), "", { mode: 0o644 });
    chmodSync(join(dir, logFileName(T0)), 0o644);
    const log = createLogger({ dir, now: () => T0 });
    log.log("restart");
    log.close();
    expect(readFileSync(join(dir, logFileName(T0)), "utf8")).toBe("");
    expect(log.failures).toBe(1);
  });
  test("a logs folder with group or other bits, or a link, is refused", () => {
    const wide = fresh();
    chmodSync(wide, 0o755);
    expect(() => createLogger({ dir: wide, now: () => T0 })).toThrow();
    const base = fresh();
    const real = join(base, "real");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, join(base, "logs"));
    expect(() => createLogger({ dir: join(base, "logs"), now: () => T0 })).toThrow();
  });
  test("route patterns beyond the route table come from the caller", () => {
    const dir = fresh();
    chmodSync(dir, 0o700);
    const log = createLogger({ dir, now: () => T0, routes: ["/api/uploads/:chat"] });
    log.log("error", { route: "/api/uploads/:chat", err: "upload" });
    log.log("error", { route: "/c/:chat/files/*", err: "shell" });
    log.log("error", { route: "/api/other", err: "unknown" });
    log.close();
    const lines = readFileSync(join(dir, logFileName(T0)), "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.route)).toEqual(["/api/uploads/:chat", "/c/:chat/files/*", null]);
  });
  test("after close nothing is written", () => {
    const dir = fresh();
    chmodSync(dir, 0o700);
    const log = createLogger({ dir, now: () => T0 });
    log.close();
    log.log("restart");
    expect(existsSync(join(dir, logFileName(T0)))).toBe(false);
  });
});
