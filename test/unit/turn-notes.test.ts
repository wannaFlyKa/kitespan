// U2 review (D49; DESIGN 4.4 notes/, 6.3 The turn fold): the notes keep each turn that ran on this server, and history
// gives every page each turn's start and end from them (server/chats/turns.ts insertTurns): before its first row,
// after its last row and what follows that row (a closed card, a stopped call, Claude Code's Interrupted line, a stop
// line), with the noted end in place of Claude Code's own; the turn in flight's start where its first row is; and a
// turn that Claude Code started by itself, which no note knows, from a reply in a new API message after a finished one.
import { describe, expect, test } from "bun:test";
import { TURN_CUT, TURN_INTERRUPTED, type ChatEvent } from "../../shared/protocol";
import { insertTurns, turnRowId } from "../../server/chats/turns";
import { notesForSave, notesFrom, turnErrorNote } from "../../server/store/notes";
import { STORE_LIMITS, type TurnNote } from "../../server/store/types";

const CHAT = "c2k4m6p3qac2k4m6p3qa";
const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const U3 = "33333333-3333-4333-8333-333333333333";
/** A provider's resource name, put together at run time (no account id in the source; context-arn.test.ts's way). */
const ARN = ["arn", "aws", "bedrock", "us-west-2", "4321".repeat(3), "inference-profile/fdtestprofile"].join(":");

const user = (uuid: string, text = "Fix it."): ChatEvent => ({ k: "user", uuid, text, queued: false });
const text = (key: string, t = "Done."): ChatEvent => ({ k: "block", key, kind: "text", text: t, parent: null });
const call = (id: string): ChatEvent => ({ k: "tool_call", id, name: "Bash", input: { command: "ls" }, parent: null });
const result = (id: string): ChatEvent => ({ k: "tool_result", id, text: "ok", isError: false, parent: null, report: null });
const stopped = (id: string): ChatEvent => ({ k: "tool_stopped", id, parent: null });
const interrupted: ChatEvent = { k: "turn_end", ok: false, subtype: TURN_INTERRUPTED, durationMs: 0, error: null, uuids: [] };
const note = (over: Partial<TurnNote>): TurnNote => ({ ids: [U1], last: [], by: "user", ok: true, subtype: "success", durationMs: 4_000, uuids: [U1], error: null, ...over });
/** Each event as one short word, the marks spelled out. */
const words = (events: readonly ChatEvent[]) =>
  events.map((e) =>
    e.k === "turn_start" ? `start ${e.by}` : e.k === "turn_end" ? `end ${e.subtype}${e.durationMs ? ` ${e.durationMs}` : ""}` : e.k === "user" ? `user ${e.uuid.slice(0, 2)}` : e.k === "bash" ? `bash ${e.state}` : e.k === "block" ? e.key : e.k === "notice" ? "notice" : `${e.k} ${(e as { id: string }).id}`,
  );

describe("the notes keep each turn (TurnNote)", () => {
  test("a turn note reads back as written; one that fails its check is left out, and the cap holds", () => {
    const n = note({ ids: [U1, "msg_a:0"], last: ["result:t1", "call:t1"], error: "Claude Code could not reach the API." });
    expect(notesFrom({ v: 1, id: CHAT, cards: [], bash: [], turns: [n] }).turns).toEqual([n]);
    for (const bad of [{ ...n, ids: [] }, { ...n, by: "someone" }, { ...n, durationMs: -1 }, { ...n, uuids: ["m1"] }, { ...n, subtype: "" }, { ...n, error: `The model ${ARN} is gone.` }])
      expect(() => notesFrom({ v: 1, id: CHAT, cards: [], bash: [], turns: [bad] })).toThrow();
    const saved = notesForSave({ v: 1, id: CHAT, cards: [], bash: [], notRun: [], turns: [n, { ...n, by: "someone" as never }, ...Array.from({ length: STORE_LIMITS.noteTurns }, () => n)] });
    expect(saved.turns).toHaveLength(STORE_LIMITS.noteTurns);
    expect(notesFrom({ v: 1, id: CHAT, cards: [], bash: [] }).turns).toBeUndefined();
  });

  test("the end's line is kept short, and never one that names a provider's resource", () => {
    expect(turnErrorNote(null)).toBeNull();
    expect(turnErrorNote("x".repeat(500))!.length).toBeLessThanOrEqual(240);
    expect(turnErrorNote(`Bedrock could not find ${ARN}`)).toBeNull();
  });

  test("a turn's rows are the history ids of messages that ran, `!` rows that ran, and the main thread's blocks, calls and results", () => {
    expect(turnRowId(user(U1))).toBe(U1);
    expect(turnRowId({ k: "user", uuid: U2, text: "later", queued: true })).toBeNull();
    expect(turnRowId({ k: "block_start", key: "msg_a:0", kind: "text", parent: null })).toBe("msg_a:0");
    expect(turnRowId(call("t1"))).toBe("call:t1");
    expect(turnRowId(result("t1"))).toBe("result:t1");
    expect(turnRowId({ ...call("t2"), parent: "ag1" } as ChatEvent)).toBeNull();
    expect(turnRowId(stopped("t1"))).toBeNull();
    expect(turnRowId({ k: "turn_end", ok: true, subtype: "success", durationMs: 1, error: null, uuids: [] })).toBeNull();
  });
});

describe("history gives each turn its start and end (insertTurns)", () => {
  test("a noted turn: its start before its first row, its end after its last row and its stopped call, and the next input outside it", () => {
    const events = [user(U1), text("msg_a:0"), call("t1"), result("t1"), text("msg_z:0"), stopped("t9"), user(U2), text("msg_b:0")];
    const out = insertTurns(events, [note({ last: ["msg_z:0", "result:t1"], durationMs: 4_000 })], null, true);
    expect(words(out)).toEqual(["start user", "user 11", "msg_a:0", "tool_call t1", "tool_result t1", "msg_z:0", "tool_stopped t9", "end success 4000", "user 22", "msg_b:0"]);
  });

  test("a `!` row that never ran, noted where the transcript ended, is no turn's: the end goes before it", () => {
    const notRun: ChatEvent = { k: "bash", uuid: U3, input: "make test", state: "not_run", stdout: "", stderr: "", code: null, ms: null, timedOut: false, capped: false };
    const out = insertTurns([user(U1), text("msg_z:0"), notRun], [note({ last: ["msg_z:0"] })], null, true);
    expect(words(out)).toEqual(["start user", "user 11", "msg_z:0", "end success 4000", "bash not_run"]);
  });

  test("a message the turn took in stays in it; one it did not take in ends it (no last row in the transcript)", () => {
    const events = [user(U1), call("t1"), result("t1"), user(U2), text("msg_b:0"), user(U3), text("msg_c:0")];
    const out = insertTurns(events, [note({ uuids: [U1, U2], last: ["gone"] })], null, true);
    expect(words(out)).toEqual(["start user", "user 11", "tool_call t1", "tool_result t1", "user 22", "msg_b:0", "end success 4000", "user 33", "msg_c:0"]);
  });

  test("Claude Code's own Interrupted end inside a noted turn gives way to the noted one, after the stop line, so the end shows once", () => {
    const events = [user(U1), text("msg_a:0"), call("t1"), result("t1"), stopped("t1"), interrupted, { k: "notice", text: "kitespan restarted during this turn. Send a message to continue.", id: "stop-1" } as ChatEvent, user(U2)];
    const out = insertTurns(events, [note({ ok: false, subtype: TURN_CUT, durationMs: 0, last: ["result:t1"] })], null, true);
    expect(words(out)).toEqual(["start user", "user 11", "msg_a:0", "tool_call t1", "tool_result t1", "tool_stopped t1", "notice", `end ${TURN_CUT}`, "user 22"]);
  });

  test("a turn whose first row is not in the transcript starts at its next one", () => {
    const out = insertTurns([text("msg_x:0"), call("t1"), result("t1"), text("msg_z:0")], [note({ ids: ["gone", "call:t1"], by: "agent", last: ["msg_z:0"] })], null, true);
    expect(words(out)).toEqual(["msg_x:0", "start agent", "tool_call t1", "tool_result t1", "msg_z:0", "end success 4000"]);
  });

  test("the turn in flight: its start at its first row, no end; the noted turn before it ends there", () => {
    const events = [user(U1), text("msg_a:0"), user(U2), text("msg_b:0"), call("t1"), result("t1"), user(U3), text("msg_c:0"), call("t2")];
    const out = insertTurns(events, [note({ last: ["msg_a:0"] })], { ids: [U2], by: "user" }, false);
    expect(words(out)).toEqual(["start user", "user 11", "msg_a:0", "end success 4000", "start user", "user 22", "msg_b:0", "tool_call t1", "tool_result t1", "user 33", "msg_c:0", "tool_call t2"]);
    // An agent's own turn in flight, after a turn that no note knows.
    const agent = insertTurns([user(U1), call("r1"), result("r1"), text("msg_a:0"), call("x1"), result("x1")], undefined, { ids: ["call:x1"], by: "agent" }, false);
    expect(words(agent)).toEqual(["user 11", "tool_call r1", "tool_result r1", "msg_a:0", "start agent", "tool_call x1", "tool_result x1"]);
  });

  test("a turn of Claude Code's own that no note knows: a reply in a new API message after a finished reply starts it", () => {
    const events = [user(U1), call("r1"), result("r1"), text("msg_a:0", "Started the tests in the background."), text("msg_b:0", "The background tests passed."), call("r2"), result("r2"), text("msg_b2:0"), user(U2), text("msg_c:0")];
    expect(words(insertTurns(events, undefined, null, true))).toEqual(["user 11", "tool_call r1", "tool_result r1", "msg_a:0", "start agent", "msg_b:0", "tool_call r2", "tool_result r2", "msg_b2:0", "end success", "user 22", "msg_c:0"]);
    // At the transcript's end: ended when no turn runs, open while one does (kitespan's own orphan finishes it).
    const tail = [user(U1), text("msg_a:0"), text("msg_b:0")];
    expect(words(insertTurns(tail, undefined, null, true))).toEqual(["user 11", "msg_a:0", "start agent", "msg_b:0", "end success"]);
    expect(words(insertTurns(tail, undefined, null, false))).toEqual(["user 11", "msg_a:0", "start agent", "msg_b:0"]);
    // Not after a call or a result, nor for a second block of the same API message, nor inside a noted turn.
    expect(words(insertTurns([user(U1), text("msg_a:0"), call("t1"), result("t1"), text("msg_a2:0")], undefined, null, true))).not.toContain("start agent");
    expect(words(insertTurns([user(U1), text("msg_a:0"), text("msg_a:1")], undefined, null, true))).not.toContain("start agent");
    const inNoted = insertTurns([user(U1), text("msg_a:0"), text("msg_b:0", "After the Stop hook's feedback.")], [note({ last: ["msg_b:0"] })], null, true);
    expect(words(inNoted)).toEqual(["start user", "user 11", "msg_a:0", "msg_b:0", "end success 4000"]);
  });

  test("history with no note and no turn of Claude Code's own is left as it is", () => {
    const events = [user(U1), text("msg_a:0"), call("t1"), stopped("t1"), interrupted, user(U2), text("msg_b:0")];
    expect(insertTurns(events, undefined, null, true)).toEqual(events);
  });
});
