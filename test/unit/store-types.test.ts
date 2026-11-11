// The records that iteration 4 adds (DESIGN.md 4.4): the ledger's `stop` (R15) and `proc` (R16), read defensively so
// that a bad field reads as null and never sets the ledger aside, the stop lines, and the queue file of RD-8 (R11).
import { describe, expect, test } from "bun:test";
import { STORE_LIMITS, ledgerProcOf, ledgerStopOf, queueRecordOf, stopLine, type QueueRecord } from "../../server/store/types";

const CHAT = "k3m7q2x4abk3m7q2x4ab";
const U1 = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const U2 = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const UPLOAD = "abcdefghijklmnop";
const AT = "2026-11-02T20:30:00.000Z";

describe("the ledger's stop (R15)", () => {
  test("each stop reads as it was written; another key is dropped", () => {
    for (const why of ["running", "waiting"] as const)
      for (const by of ["crash", "shutdown", "restart", "restart_failed"] as const) expect(ledgerStopOf({ why, by, at: AT, extra: 1 })).toEqual({ why, by, at: AT });
  });
  test("absent, untyped or bad reads as null", () => {
    for (const v of [undefined, null, "running", [], {}, { why: "idle", by: "crash", at: AT }, { why: "running", by: "kill", at: AT }, { why: "running", by: "crash", at: "yesterday" }, { why: "running", by: "crash" }])
      expect(ledgerStopOf(v)).toBeNull();
  });
  test("the lines: a crash, a kill -9 and a shutdown say stopped; Restart now says restarted (DESIGN 9.4, 4.10)", () => {
    const running = "kitespan stopped while this chat was running. Send a message to continue.";
    const waiting = "This chat was waiting for your answer when kitespan stopped. Send a message to continue.";
    expect(stopLine({ why: "running", by: "crash" })).toBe(running);
    expect(stopLine({ why: "running", by: "shutdown" })).toBe(running);
    expect(stopLine({ why: "waiting", by: "crash" })).toBe(waiting);
    expect(stopLine({ why: "waiting", by: "shutdown" })).toBe(waiting);
    expect(stopLine({ why: "running", by: "restart" })).toBe("kitespan restarted during this turn. Send a message to continue.");
    expect(stopLine({ why: "waiting", by: "restart" })).toBe("This chat was waiting for your answer when kitespan restarted. Send a message to continue.");
    // Restart now cut it, and the restart did not happen (its successor failed): the words say both.
    expect(stopLine({ why: "running", by: "restart_failed" })).toBe("The restart stopped this turn, but kitespan did not restart. Send a message to continue.");
    expect(stopLine({ why: "waiting", by: "restart_failed" })).toBe("This chat was waiting for your answer when the restart stopped it, but kitespan did not restart. Send a message to continue.");
  });
});

describe("the ledger's proc (R16)", () => {
  test("the pid and its start time read as they were written, with the boot's id after the ticks or without", () => {
    expect(ledgerProcOf({ pid: 4242, start: "123456789", extra: true })).toEqual({ pid: 4242, start: "123456789" });
    expect(ledgerProcOf({ pid: 4242, start: `123456789@${U1}` })).toEqual({ pid: 4242, start: `123456789@${U1}` });
    for (const start of ["123456789@", `@${U1}`, "123456789@not-a-boot-id", `123456789@${U1.toUpperCase()}`, `123456789@${U1}@${U2}`]) expect(ledgerProcOf({ pid: 4242, start })).toBeNull();
  });
  test("absent, untyped or bad reads as null", () => {
    for (const v of [undefined, null, 4242, { pid: 0, start: "1" }, { pid: -1, start: "1" }, { pid: 1.5, start: "1" }, { pid: 2 ** 31, start: "1" }, { pid: "4242", start: "1" }, { pid: 4242 }, { pid: 4242, start: "" }, { pid: 4242, start: "12a" }, { pid: 4242, start: "1".repeat(21) }, { pid: 4242, start: 12 }])
      expect(ledgerProcOf(v)).toBeNull();
  });
});

describe("the queue file (R11)", () => {
  const note = (uuid: string, over: Record<string, unknown> = {}) => ({ uuid, text: "Run the tests @src/a.ts", userText: "Run the tests", uploads: [], mentions: ["src/a.ts"], at: AT, ...over });
  const rec = (msgs: unknown, over: Record<string, unknown> = {}) => ({ v: 1, id: CHAT, msgs, ...over });

  test("a record reads as it was written, in send order; other keys are dropped", () => {
    const r = rec([note(U1), note(U2, { uploads: [UPLOAD], mentions: [] })]);
    expect(queueRecordOf(r, CHAT)).toEqual(r as QueueRecord);
    expect(queueRecordOf({ ...rec([{ ...note(U1), where: "cli" }]), extra: 1 }, CHAT)).toEqual(rec([note(U1)]) as QueueRecord);
    expect(queueRecordOf(rec([]))).toEqual(rec([]) as QueueRecord);
  });

  test("a record that fails its check is null: its version, its id, a bad message, a repeated uuid", () => {
    const bad = [
      null,
      [],
      rec([], { v: 2 }),
      rec([], { id: "nope" }),
      rec("x"),
      rec([note("not-a-uuid")]),
      rec([note(U1), note(U1)]),
      rec([note(U1, { at: "now" })]),
      rec([note(U1, { text: 3 })]),
      rec([note(U1, { userText: null })]),
      rec([note(U1, { uploads: ["u-1"] })]),
      rec([note(U1, { uploads: undefined })]),
      rec([note(U1, { mentions: ["/etc/passwd"] })]),
      rec([note(U1, { mentions: undefined })]),
    ];
    for (const v of bad) expect(queueRecordOf(v, CHAT)).toBeNull();
    // Another chat's file name.
    expect(queueRecordOf(rec([]), "abcdefghijklmnopqrst")).toBeNull();
  });

  test("at most 50 messages wait in one chat; 4 MiB of JSON is the file's cap; the notes keep 200 stop lines", () => {
    const many = Array.from({ length: STORE_LIMITS.queueMessages + 1 }, () => note(crypto.randomUUID()));
    expect(queueRecordOf(rec(many), CHAT)).toBeNull();
    expect(queueRecordOf(rec(many.slice(1)), CHAT)?.msgs.length).toBe(50);
    expect(STORE_LIMITS.queueMessages).toBe(50);
    expect(STORE_LIMITS.queueBytes).toBe(4 * 1024 * 1024);
    expect(STORE_LIMITS.noteStops).toBe(200);
  });
});
