// U2 (FIX-U2 section 1, DESIGN-U2 3 to 8): the shared turn model (web/chat/turns.ts) that the turn fold and U3's turn
// rail read, the marks the reducer keeps for it (web/state/reduce.ts), the fold's rules and words, and the timing rule
// and the reader's kept choices (web/chat/turnOpen.ts). Pure: the chats come from the reducer on recorded events.
import { describe, expect, test } from "bun:test";
import { TURN_CUT, TURN_INTERRUPTED, type ChatEvent } from "../../shared/protocol";
import { cardCalls } from "../../web/chat/fold";
import { TURN_CHOICES_KEY, TURN_CHOICES_MAX, foldNow, newWatch, noteRunsOn, readChoices, turnOpen, watchedOpen, writeChoice } from "../../web/chat/turnOpen";
import { drawnParts, turnDuration, turnLabel, turnLayout, turnList, turnsOf, type Block, type Turn, type TurnOpts } from "../../web/chat/turns";
import { applyEvent, applyHistory, markAt, type ChatPart } from "../../web/state/reduce";
import type { Item } from "../../web/state/types";

function blank(): ChatPart {
  return {
    items: [],
    pending: [],
    title: "",
    titleSource: "first-prompt",
    model: "default",
    effort: "default",
    mode: "default",
    picks: { model: null, effort: null, mode: null },
    sessionId: "",
    bypassFlag: false,
    lostRequests: [],
    turn: null,
    liveModel: null,
    version: null,
    commands: null,
    tasks: [],
    suggestion: null,
    outputs: [],
    init: null,
    workingFolder: null,
  };
}

/** Events as a page gets them live: seq 1, 2, ... after `from`. */
function live(events: ChatEvent[], start: ChatPart = blank(), from = 0, opts: { replay?: boolean; tail?: boolean; interrupted?: Set<number> } = {}): ChatPart {
  let c = start;
  events.forEach((e, i) => {
    c = applyEvent(c, e, { seq: from + i + 1, replay: !!opts.replay, tail: opts.tail, cwd: null, now: 1_000_000, interrupted: opts.interrupted });
  });
  return c;
}
const hist = (events: ChatEvent[], ended = true): ChatPart => applyHistory(blank(), events, { cwd: null, now: 1_000_000, ended });

const IDLE: TurnOpts = { running: false, waiting: false, partial: false };
const turnsIn = (c: ChatPart, opts: TurnOpts = IDLE): Turn[] => turnList(turnsOf(c.items, c.marks ?? [], opts));
const blocksIn = (c: ChatPart, opts: TurnOpts = IDLE): Block[] => turnsOf(c.items, c.marks ?? [], opts);
const ids = (t: Turn) => t.rows.map((r) => r.id);
const layout = (c: ChatPart, t: Turn, view: "normal" | "thinking" | "verbose" = "normal") => turnLayout(t, view, undefined, cardCalls(c.items, c.pending));
const shape = (l: ReturnType<typeof layout>, open = false) => drawnParts(l, open).map((p) => `${p.role}:${p.entries.map((e) => (e.type === "summary" ? e.id : e.item.id)).join(",")}`);

// ---- events
const start = (by: "user" | "agent" = "user"): ChatEvent => ({ k: "turn_start", by });
const user = (uuid: string, text = "Fix the slash query.", queued = false): ChatEvent => ({ k: "user", uuid, text, queued });
const text = (msg: string, t: string, n = 0): ChatEvent => ({ k: "block", key: `${msg}:${n}`, kind: "text", text: t, parent: null });
const think = (msg: string, t = "Looking at the matcher."): ChatEvent => ({ k: "block", key: `${msg}:0`, kind: "thinking", text: t, parent: null });
const call = (id: string, name = "Read", input: Record<string, unknown> = { file_path: `/src/${id}.ts` }): ChatEvent => ({ k: "tool_call", id, name, input, parent: null });
const result = (id: string, t = "ok"): ChatEvent => ({ k: "tool_result", id, text: t, isError: false, parent: null, report: null });
const end = (p: { ok?: boolean; subtype?: string; ms?: number; error?: string | null; uuids?: string[] } = {}): ChatEvent => ({ k: "turn_end", ok: p.ok ?? true, subtype: p.subtype ?? "success", durationMs: p.ms ?? 0, error: p.error ?? null, uuids: p.uuids ?? [] });
const EXIT: ChatEvent = { k: "exit", code: 1, signal: null, stderr: [] };
const bash = (uuid: string, state: "done" | "queued" | "running" = "done"): ChatEvent => ({ k: "bash", uuid, input: "ls", state, stdout: "a\nb", stderr: "", code: 0, ms: 12, timedOut: false, capped: false });

/** One long finished turn: a message, an in-between reply, two calls, then the answer. */
const longTurn = (m = "m1", ms = 134_000): ChatEvent[] => [
  start(),
  user(m),
  text(`msg_a${m}`, "The pane takes the slash off before it ranks."),
  call(`r${m}`, "Read"),
  result(`r${m}`),
  call(`b${m}`, "Bash", { command: "bun test" }),
  result(`b${m}`),
  text(`msg_z${m}`, "Fixed. The 41 tests pass."),
  end({ ms, uuids: [m] }),
];

describe("the reducer keeps each turn's marks beside the rows (DESIGN-U2 16 item 1)", () => {
  test("a live start and end name where they came, the end after the rows it adds; no mark is a row", () => {
    const c = live(longTurn());
    expect(c.items.map((i) => i.kind)).toEqual(["user", "assistant", "tool", "tool", "assistant"]);
    expect(c.marks).toEqual([
      { k: "start", by: "user", at: [], seq: 1 },
      { k: "end", at: ["msg_zm1-0", "bm1", "rm1"], seq: 9, ok: true, subtype: "success", durationMs: 134_000, uuids: ["m1"], live: true },
    ]);
  });

  test("a replayed end is not live; a start in a snapshot's tail is loose", () => {
    const c = live([start(), user("m1"), text("msg_a", "Hi."), end()], blank(), 0, { replay: true, tail: true });
    expect(c.marks?.map((m) => (m.k === "start" ? `start ${m.loose}` : `end ${m.live}`))).toEqual(["start true", "end false"]);
  });

  test("a mark never names a row that waits, nor a live status or retry line", () => {
    const items: Item[] = [
      { kind: "user", id: "m1", text: "a" },
      { kind: "assistant", id: "a1", markdown: "b" },
      { kind: "status", id: "status", status: "compacting" },
      { kind: "user", id: "q1", text: "c", queued: true },
      { kind: "user", id: "l1", text: "d", local: true },
    ];
    expect(markAt(items)).toEqual(["a1", "m1"]);
  });

  test("this page's own Stop ends the turn Interrupted in its mark; an exit during a turn ends it failed", () => {
    const stopped = live([start(), user("m1"), text("msg_a", "Working."), end({ ok: false, subtype: "error_during_execution" })], blank(), 0, { interrupted: new Set([1]) });
    expect(stopped.marks?.[1]).toMatchObject({ k: "end", ok: false, subtype: TURN_INTERRUPTED, at: ["interrupted-4", "msg_a-0", "m1"] });
    const died = live([start(), user("m1"), call("t1", "Bash", { command: "sleep 9" }), EXIT]);
    expect(died.marks?.[1]).toMatchObject({ k: "end", ok: false, subtype: "exit", at: ["exit-4", "t1", "m1"] });
    // An exit while no turn runs ends none.
    expect(live([EXIT]).marks).toBeUndefined();
  });

  test("history's own Interrupted end leaves an end mark that is not live", () => {
    const c = hist([user("m1"), text("msg_a", "Working."), call("t1", "Bash"), { k: "tool_stopped", id: "t1", parent: null }, end({ ok: false, subtype: TURN_INTERRUPTED })]);
    expect(c.marks).toEqual([{ k: "end", at: ["interrupted-h4", "t1", "msg_a-0"], seq: 0, ok: false, subtype: TURN_INTERRUPTED, durationMs: 0, uuids: [], live: false }]);
  });
});

describe("the turn model, case by case (DESIGN-U2 3)", () => {
  test("a: a user message starts a turn; its id is the message's", () => {
    const [t] = turnsIn(live(longTurn()));
    expect(t).toMatchObject({ id: "m1", by: "user", state: "ok", durationMs: 134_000, opening: 1 });
    expect(ids(t!)).toEqual(["m1", "msg_am1-0", "rm1", "bm1", "msg_zm1-0"]);
  });

  test("b: a `!` command whose output Claude replies to opens the turn its reply starts; a `/` command and its output are one turn", () => {
    const c = live([bash("b1", "running"), bash("b1"), start(), text("msg_a", "Two files."), end()]);
    const [t] = turnsIn(c);
    expect(t).toMatchObject({ id: "b1", opening: 1 });
    expect(ids(t!)).toEqual(["b1", "msg_a-0"]);
    const s = live([start(), user("u1", "/context"), { k: "local_output", stream: "stdout", text: "41% used" }, end()]);
    const [ts] = turnsIn(s);
    expect(ids(ts!)).toEqual(["u1", "local-3"]);
    expect(layout(s, ts!).folds).toBe(false);
  });

  test("c: a turn that starts by itself (a task's notification) has no input; its id is its first row's", () => {
    const c = live([...longTurn(), start("agent"), text("msg_n", "The background command finished."), call("r9", "Read"), result("r9"), text("msg_n2", "All 21 pass."), end({ ms: 9_000 })]);
    const [a, b] = turnsIn(c);
    expect(a!.id).toBe("m1");
    expect(b).toMatchObject({ id: "msg_n-0", by: "agent", opening: 0, durationMs: 9_000 });
    expect(ids(b!)).toEqual(["msg_n-0", "r9", "msg_n2-0"]);
  });

  test("several messages before the first row of work open one turn, and the line goes after the last of them", () => {
    const c = live([start(), user("m1"), user("m2", "And the files group."), text("msg_a", "Looking."), call("r1"), result("r1"), text("msg_z", "Both fixed."), end({ uuids: ["m1", "m2"] })]);
    const [t] = turnsIn(c);
    expect(t).toMatchObject({ id: "m1", opening: 2 });
    expect(shape(layout(c, t!))).toEqual(["input:m1,m2", "work:msg_a-0,sum-r1", "answer:msg_z-0"]);
  });

  test("a message read inside a running turn belongs to it and stays in its place, between the work before and after it", () => {
    const c = live([
      start(),
      user("m1"),
      text("msg_a", "Running the long command."),
      call("b1", "Bash", { command: "sleep 30" }),
      user("m2", "Also check the phone size.", true),
      result("b1"),
      user("m2", "Also check the phone size.", false),
      text("msg_b", "I read your new message."),
      call("r1"),
      result("r1"),
      text("msg_z", "Both done."),
      end({ uuids: ["m1", "m2"] }),
    ]);
    const all = turnsIn(c);
    expect(all.length).toBe(1);
    expect(ids(all[0]!)).toEqual(["m1", "msg_a-0", "b1", "m2", "msg_b-0", "r1", "msg_z-0"]);
    expect(shape(layout(c, all[0]!))).toEqual(["input:m1", "work:msg_a-0,sum-b1", "pinned:m2", "work:msg_b-0,sum-r1", "answer:msg_z-0"]);
  });

  test("Send now that interrupts: the running turn ends Interrupted, and the queued message opens the next turn", () => {
    const c = live([start(), user("m1"), text("msg_a", "Writing the long story."), user("m2", "Stop and do this.", true), end({ ok: false, subtype: TURN_INTERRUPTED }), start(), user("m2", "Stop and do this."), text("msg_b", "Done."), end({ uuids: ["m2"] })]);
    const [a, b] = turnsIn(c);
    expect(a).toMatchObject({ id: "m1", state: "interrupted" });
    expect(ids(a!)).toEqual(["m1", "msg_a-0", "interrupted-5"]);
    expect(b).toMatchObject({ id: "m2", state: "ok", opening: 1 });
  });

  test("how a turn ends: ok, interrupted, failed (an error, an exit), cut", () => {
    const ended = (e: ChatEvent) => turnsIn(live([start(), user("m1"), text("msg_a", "Hi."), call("t1", "Bash"), e]))[0]!.state;
    expect(ended(end())).toBe("ok");
    expect(ended(end({ ok: false, subtype: TURN_INTERRUPTED }))).toBe("interrupted");
    expect(ended(end({ ok: false, subtype: "error_during_execution", error: "Claude Code could not reach the API." }))).toBe("failed");
    expect(ended(end({ ok: false, subtype: TURN_CUT }))).toBe("cut");
    expect(ended(EXIT)).toBe("failed");
  });

  test("a running turn, and one whose card waits", () => {
    const c = live([start(), user("m1"), text("msg_a", "Reading.", 0), call("r1")]);
    expect(turnsIn(c, { running: true, waiting: false, partial: false })[0]!.state).toBe("running");
    expect(turnsIn(c, { running: true, waiting: true, partial: false })[0]!.state).toBe("waiting");
  });

  test("history with no marks: a turn opens at each input that a row of Claude's follows and runs to the next one", () => {
    const c = hist([user("m1"), text("msg_a", "Looking."), call("r1"), result("r1"), text("msg_b", "Fixed."), user("m2"), text("msg_c", "Done.")]);
    expect(turnsIn(c).map(ids)).toEqual([
      ["m1", "msg_a-0", "r1", "msg_b-0"],
      ["m2", "msg_c-0"],
    ]);
    expect(turnsIn(c).map((t) => t.durationMs)).toEqual([null, null]);
  });

  test("history's Interrupted end: the turn from its input to the mark, ended Interrupted", () => {
    const c = hist([user("m1"), text("msg_a", "Working."), call("t1", "Bash"), { k: "tool_stopped", id: "t1", parent: null }, end({ ok: false, subtype: TURN_INTERRUPTED }), user("m2"), text("msg_b", "Ok.")]);
    const [a, b] = turnsIn(c);
    expect(a).toMatchObject({ id: "m1", state: "interrupted" });
    expect(ids(a!)).toEqual(["m1", "msg_a-0", "t1", "interrupted-h4"]);
    expect(b).toMatchObject({ id: "m2", state: "ok" });
  });

  test("a snapshot's tail: its loose start begins at the turn's message that the history already holds", () => {
    const drawn = applyHistory(blank(), [user("m0"), text("msg_0", "Earlier."), user("m1"), text("msg_a", "Reading."), call("r1")], { cwd: null, now: 0, ended: false });
    const c = live([start(), text("msg_b", "More.", 0), call("r2")], drawn, 40, { replay: true, tail: true });
    const all = turnsIn(c, { running: true, waiting: false, partial: false });
    expect(all.map(ids)).toEqual([
      ["m0", "msg_0-0"],
      ["m1", "msg_a-0", "r1", "msg_b-0", "r2"],
    ]);
    expect(all[1]!.state).toBe("running");
    // A replay that is not a snapshot's (the missed events of a reconnect) starts where it came.
    const resumed = live([...longTurn("m5")], hist([user("m0"), text("msg_0", "Earlier.")]), 40, { replay: true });
    expect(turnsIn(resumed).map((t) => t.id)).toEqual(["m0", "m5"]);
  });

  // U2 review: the server's history marks where the turn in flight began (server/chats/turns.ts), so the snapshot tail's
  // loose start of that same turn starts nothing new: a message read inside it, or an agent's own turn, stays whole.
  test("a snapshot whose history marks the turn in flight: the tail's loose start is that turn, with the message read inside it", () => {
    const drawn = applyHistory(
      blank(),
      [start(), user("m0"), text("msg_0", "Earlier."), end({ ms: 2000 }), start(), user("m1"), text("msg_a", "Running the long command."), call("b1", "Bash", { command: "sleep 30" }), result("b1"), user("m2", "Also check the phone size."), text("msg_b", "I read your new message."), call("r1")],
      { cwd: null, now: 0, ended: false },
    );
    const c = live([start(), result("r1"), call("r2")], drawn, 40, { replay: true, tail: true });
    const running = { running: true, waiting: false, partial: false };
    const all = turnsIn(c, running);
    expect(all.map(ids)).toEqual([
      ["m0", "msg_0-0"],
      ["m1", "msg_a-0", "b1", "m2", "msg_b-0", "r1", "r2"],
    ]);
    expect(all.map((t) => t.state)).toEqual(["ok", "running"]);
    expect(all.map((t) => layout(c, t).folds)).toEqual([false, false]);
  });

  test("a snapshot during an agent's own turn that history marks: the turn before it keeps its answer", () => {
    const drawn = applyHistory(
      blank(),
      [start(), user("m1"), call("r1"), result("r1"), call("r2"), result("r2"), text("msg_a", "Started the tests in the background."), end({ ms: 4000, uuids: ["m1"] }), start("agent"), call("x1", "Read"), result("x1")],
      { cwd: null, now: 0, ended: false },
    );
    const c = live([start("agent"), text("msg_b", "Reading more."), call("x2")], drawn, 40, { replay: true, tail: true });
    const all = turnsIn(c, { running: true, waiting: false, partial: false });
    expect(all.map((t) => `${t.id}:${t.by}:${t.state}`)).toEqual(["m1:user:ok", "x1:agent:running"]);
    expect(ids(all[1]!)).toEqual(["x1", "msg_b-0", "x2"]);
    const first = layout(c, all[0]!);
    expect(shape(first)).toEqual(["input:m1", "work:sum-r1", "answer:msg_a-0"]);
    expect(first.label).toBe("Worked for 4s, read 2 files");
  });

  test("a partial window: rows before the first input are the end of an older turn, whose id is its first loaded row", () => {
    const c = hist([text("msg_x", "Second half of an older reply."), call("r0"), result("r0"), user("m1"), text("msg_a", "Hi.")]);
    expect(turnsIn(c, { ...IDLE, partial: true }).map((t) => `${t.id}:${t.opening}`)).toEqual(["msg_x-0:0", "m1:1"]);
    // At the chat's start they are no turn's.
    const blocks = blocksIn(c);
    expect(blocks.map((b) => (b.k === "row" ? `row ${b.item.id}` : `turn ${b.turn.id}`))).toEqual(["row msg_x-0", "row r0", "turn m1"]);
  });

  test("outside every turn: the messages that still wait at the end", () => {
    const c = live([...longTurn(), start(), user("m2"), text("msg_b", "On it.", 0), user("q1", "Then the tablet.", true), bash("q2", "queued")]);
    const blocks = blocksIn(c, { running: true, waiting: false, partial: false });
    expect(blocks.map((b) => (b.k === "row" ? `row ${b.item.id}` : `turn ${b.turn.id}`))).toEqual(["turn m1", "turn m2", "row q1", "row q2"]);
  });

  test("a turn's id stays the same live, from history, and after a reload", () => {
    const liveIds = turnsIn(live([...longTurn("m1"), ...longTurn("m2")])).map((t) => t.id);
    const hEvents: ChatEvent[] = [...longTurn("m1"), ...longTurn("m2")].filter((e) => e.k !== "turn_start" && e.k !== "turn_end");
    expect(turnsIn(hist(hEvents)).map((t) => t.id)).toEqual(liveIds);
  });
});

describe("what folds and what stays (DESIGN-U2 4)", () => {
  test("the answer is the last reply; the work before it folds into the line, inputs above it", () => {
    const c = live(longTurn());
    const l = layout(c, turnsIn(c)[0]!);
    expect(l.folds).toBe(true);
    expect(shape(l)).toEqual(["input:m1", "work:msg_am1-0,sum-rm1", "answer:msg_zm1-0"]);
    expect(l.workIds).toEqual(["msg_am1-0", "rm1", "bm1"]);
  });

  test("an error row and a refusal after the last reply stay as the answer, and so does the last reply when work came after it", () => {
    const failed = live([start(), user("m1"), text("msg_a", "Let me run the tests."), call("t1", "Bash"), end({ ok: false, subtype: "error_during_execution", error: "The API returned an error." })]);
    const l = layout(failed, turnsIn(failed)[0]!);
    // One summary after the reply is all the work: folding it would hide one one-line row only.
    expect(l.folds).toBe(false);
    expect(shape(l)).toEqual(["input:m1", "answer:msg_a-0", "work:sum-t1", "answer:error-5"]);
    expect(l.tag).toBe("Failed");
    // With more work before it, the turn folds, and the reply, the work after it and the error keep their order.
    const more = live([start(), user("m1"), call("r1"), result("r1"), text("msg_a", "Let me run the tests."), call("t1", "Bash"), end({ ok: false, subtype: "error_during_execution", error: "The API returned an error." })]);
    const lm = layout(more, turnsIn(more)[0]!);
    expect(lm.folds).toBe(true);
    expect(shape(lm)).toEqual(["input:m1", "work:sum-r1", "answer:msg_a-0", "work:sum-t1", "answer:error-7"]);
  });

  // U2 review (the answer always stays): Claude Code runs the user's Stop hooks after the last reply (the host asks for
  // hook events), a to-do update or a launch can come after it, and none of them may fold the reply away.
  const hook = (phase: "started" | "response", event = "Stop"): ChatEvent => ({ k: "hook", phase, event, name: `${event}:notify`, outcome: phase === "response" ? "success" : null, output: phase === "response" ? "" : null });

  test("a Stop hook after the last reply: the reply stays under the line, and the hook row is no work in Normal or Thinking", () => {
    const c = live([start(), user("m1"), call("r1"), result("r1"), call("r2"), result("r2"), text("msg_a", "Reading the matcher."), call("r3"), result("r3"), text("msg_z", "Fixed. The 41 tests pass."), hook("started"), hook("response"), end({ ms: 9000, uuids: ["m1"] })]);
    const t = turnsIn(c)[0]!;
    for (const view of ["normal", "thinking"] as const) {
      const l = layout(c, t, view);
      expect(l.folds).toBe(true);
      expect(shape(l)).toEqual(["input:m1", "work:sum-r1,msg_a-0,sum-r3", "answer:msg_z-0"]);
    }
    // Verbose draws the hook row in its place, after the answer, and folds nothing.
    const v = layout(c, t, "verbose");
    expect(v.folds).toBe(false);
    expect(shape(v).at(-1)).toMatch(/^work:hook-/);
  });

  test("only a reply and a Stop hook: nothing to fold, so no line", () => {
    const c = live([start(), user("m1"), text("msg_z", "Hello."), hook("started"), hook("response"), end({ ms: 2000, uuids: ["m1"] })]);
    const l = layout(c, turnsIn(c)[0]!);
    expect(l.folds).toBe(false);
    expect(shape(l)).toEqual(["input:m1", "answer:msg_z-0"]);
  });

  test("a to-do update or a workflow's launch after the last reply: the reply stays, and that work folds after it", () => {
    const todo = live([start(), user("m1"), call("r1"), result("r1"), call("r2"), result("r2"), text("msg_z", "Fixed. All done."), call("t1", "TodoWrite", { todos: [{ content: "x", status: "completed", activeForm: "x" }] }), result("t1"), end({ ms: 9000, uuids: ["m1"] })]);
    const lt = layout(todo, turnsIn(todo)[0]!);
    expect(lt.folds).toBe(true);
    expect(shape(lt)).toEqual(["input:m1", "work:sum-r1", "answer:msg_z-0", "work:sum-t1"]);
    expect(lt.label).toBe("Worked for 9s, read 2 files, updated the to-do list");
    expect(lt.workIds).toEqual(["r1", "r2", "t1"]);
    const flow = live([start(), user("m1"), call("r1"), result("r1"), text("msg_z", "A review workflow checks the fix while the tests run."), call("wf1", "Workflow", { name: "review", description: "Review the fix" }), result("wf1"), end({ uuids: ["m1"] })]);
    const lf = layout(flow, turnsIn(flow)[0]!);
    expect(lf.folds).toBe(true);
    expect(shape(lf)).toEqual(["input:m1", "work:sum-r1", "answer:msg_z-0", "work:wf1"]);
  });

  test("the Interrupted mark is the line's tag: a turn with a line does not draw the mark, folded or open (said once)", () => {
    const c = live([start(), user("m1"), call("r1"), result("r1"), text("msg_a", "Running it."), call("t1", "Bash"), end({ ok: false, subtype: TURN_INTERRUPTED, ms: 48_000 })]);
    const t = turnsIn(c)[0]!;
    const l = layout(c, t, "normal");
    expect(l.tag).toBe("Interrupted");
    expect(l.label).toBe("Worked for 48s, read 1 file, ran 1 command");
    expect(shape(l, false)).toEqual(["input:m1", "work:sum-r1", "answer:msg_a-0", "work:sum-t1"]);
    expect(shape(l, true)).toEqual(["input:m1", "work:sum-r1", "answer:msg_a-0", "work:sum-t1"]);
    // With nothing to fold there is no line and no tag: the mark shows.
    const bare = live([start(), user("m1"), text("msg_a", "Writing."), end({ ok: false, subtype: TURN_INTERRUPTED })]);
    const lb = layout(bare, turnsIn(bare)[0]!);
    expect(lb.folds).toBe(false);
    expect(shape(lb, false)).toEqual(["input:m1", "answer:msg_a-0", "mark:interrupted-4"]);
  });

  test("folding must save a row: one summary or one thinking row stays as it is; one reply, a subagent or a workflow folds", () => {
    const one = live([start(), user("m1"), call("r1"), result("r1"), text("msg_z", "Read it."), end()]);
    expect(layout(one, turnsIn(one)[0]!).folds).toBe(false);
    const thought = live([start(), user("m1"), think("msg_t"), text("msg_z", "Yes."), end()]);
    expect(layout(thought, turnsIn(thought)[0]!, "normal").folds).toBe(false);
    expect(layout(thought, turnsIn(thought)[0]!, "thinking").folds).toBe(false);
    const both = live([start(), user("m1"), think("msg_t"), call("r1"), result("r1"), text("msg_z", "Yes."), end()]);
    expect(layout(both, turnsIn(both)[0]!, "normal").folds).toBe(false);
    expect(layout(both, turnsIn(both)[0]!, "thinking").folds).toBe(true);
    const reply = live([start(), user("m1"), text("msg_a", "First."), text("msg_z", "Second.", 1), end()]);
    expect(layout(reply, turnsIn(reply)[0]!).folds).toBe(true);
    const agent = live([start(), user("m1"), call("ag1", "Agent", { description: "Find callers", subagent_type: "Explore", prompt: "x" }), result("ag1"), text("msg_z", "Found 3."), end()]);
    expect(layout(agent, turnsIn(agent)[0]!).folds).toBe(true);
    const plain = live([start(), user("m1"), text("msg_z", "Hello."), end()]);
    expect(layout(plain, turnsIn(plain)[0]!).folds).toBe(false);
  });

  test("never folded: a running turn, one whose card waits, one whose work runs in the background, and every turn in Verbose", () => {
    const c = live(longTurn());
    const t = turnsIn(c)[0]!;
    expect(layout(c, { ...t, state: "running" }).folds).toBe(false);
    expect(layout(c, { ...t, state: "waiting" }).folds).toBe(false);
    expect(layout(c, t, "verbose").folds).toBe(false);
    const bg = live([start(), user("m1"), text("msg_a", "Started it in the background."), call("t1", "Bash", { command: "bun run docs", run_in_background: true }), text("msg_z", "It runs.", 1), end()]);
    const [b] = turnsIn(bg);
    expect(b!.rows.find((r) => r.id === "t1")).toMatchObject({ status: "stopped" });
    const running = { ...b!, rows: b!.rows.map((r): Item => (r.id === "t1" && r.kind === "tool" ? { ...r, status: "running", background: true } : r)) };
    expect(layout(bg, running).folds).toBe(false);
  });
});

describe("the line's words (DESIGN-U2 5)", () => {
  test("the duration in the CLI's form: whole seconds, at least 1s, a part that is 0 left out", () => {
    expect([400, 1_500, 40_000, 59_000, 60_000, 134_000, 3_600_000, 3_900_000].map(turnDuration)).toEqual(["1s", "2s", "40s", "59s", "1m", "2m 14s", "1h", "1h 5m"]);
  });

  test("Worked for the time, then what it did; no time when none is known (0 is none); one sentence with no middle dots", () => {
    const work: Item[] = [
      { kind: "tool", id: "r1", name: "Read", summary: "a.ts", status: "ok" },
      { kind: "tool", id: "r2", name: "Read", summary: "b.ts", status: "ok" },
      { kind: "tool", id: "r3", name: "Read", summary: "a.ts", status: "ok" },
      { kind: "tool", id: "g1", name: "Grep", summary: "parseQuery", status: "ok" },
      { kind: "tool", id: "e1", name: "Edit", summary: "a.ts", status: "ok" },
      { kind: "tool", id: "b1", name: "Bash", summary: "bun test", status: "stopped" },
      { kind: "agent", id: "ag", agentType: "Explore", description: "x", status: "done", rows: [], toolUses: 0, seconds: 0 },
      { kind: "agent", id: "ag2", agentType: "Explore", description: "y", status: "done", rows: [], toolUses: 0, seconds: 0 },
      { kind: "workflow", id: "wf", name: "review", description: "", status: "done", phases: [] },
    ];
    const label = turnLabel({ durationMs: 134_000 }, work, "normal");
    expect(label).toBe("Worked for 2m 14s, read 2 files, searched for 1 pattern, edited 1 file, ran 1 command, ran 2 subagents, ran 1 workflow");
    expect(label).not.toContain("·");
    expect(turnLabel({ durationMs: null }, work.slice(0, 2), "normal")).toBe("Read 2 files");
    const c = live([start(), user("m1"), text("msg_a", "One."), text("msg_b", "Two.", 1), end({ ms: 0 })]);
    expect(turnsIn(c)[0]!.durationMs).toBeNull();
    expect(turnLabel({ durationMs: null }, [{ kind: "assistant", id: "a", markdown: "x" }], "normal")).toBe("Worked");
    expect(turnLabel({ durationMs: null }, [{ kind: "thinking", id: "t", seconds: 3, text: "x" }], "thinking")).toBe("Thought");
    expect(turnLabel({ durationMs: 40_000 }, [], "normal")).toBe("Worked for 40s");
  });

  test("the tags: Interrupted, Failed, and Stopped for a cut turn; none for one that ended well", () => {
    const tag = (e: ChatEvent) => {
      const c = live([start(), user("m1"), text("msg_a", "Hi."), call("t1", "Bash"), call("t2", "Bash"), e]);
      return layout(c, turnsIn(c)[0]!).tag;
    };
    expect(tag(end())).toBeNull();
    expect(tag(end({ ok: false, subtype: TURN_INTERRUPTED }))).toBe("Interrupted");
    expect(tag(end({ ok: false, subtype: "error_max_turns", error: "Too many turns." }))).toBe("Failed");
    expect(tag(end({ ok: false, subtype: TURN_CUT }))).toBe("Stopped");
  });

  test("the words are the same in Normal and in Thinking (open or closed, the line does not change)", () => {
    const c = live([start(), user("m1"), think("msg_t"), call("r1"), result("r1"), call("r2"), result("r2"), text("msg_z", "Done."), end({ ms: 71_000 })]);
    const t = turnsIn(c)[0]!;
    const words = new Set([layout(c, t, "normal"), layout(c, t, "thinking")].map((l) => l.label));
    expect([...words]).toEqual(["Worked for 1m 11s, read 2 files"]);
  });
});

describe("when a turn folds, and the reader's choice (DESIGN-U2 6 and 8)", () => {
  const ended = (id: string, liveEnd: boolean): Pick<Turn, "id" | "end"> => ({ id, end: { k: "end", at: [id], seq: 1, ok: true, subtype: "success", durationMs: 1, uuids: [], live: liveEnd } });

  test("drawn folded: an end the conversation had when it was drawn, or one that came in a replay, is not watched", () => {
    const old = ended("t1", true);
    const w = newWatch([old.end!]);
    expect(watchedOpen(w, old)).toBe(false);
    expect(watchedOpen(w, ended("t2", false))).toBe(false);
    expect(watchedOpen(w, ended("t3", true))).toBe(true);
    expect(watchedOpen(w, { id: "t4", end: null })).toBe(false);
  });

  test("the turn watched here stays open, and folds when the next turn starts, only while the view follows the end and the focus is not in it", () => {
    const w = newWatch([]);
    const t1 = ended("t1", true);
    expect(foldNow(w, [t1], true, () => false)).toEqual([]);
    const next = { id: "t2", end: null };
    expect(foldNow(w, [t1, next], false, () => false)).toEqual([]);
    expect(watchedOpen(w, t1)).toBe(true);
    expect(foldNow(w, [t1, next], true, (id) => id === "t1")).toEqual([]);
    expect(foldNow(w, [t1, next], true, () => false)).toEqual(["t1"]);
    expect(watchedOpen(w, t1)).toBe(false);
    expect(foldNow(w, [t1, next], true, () => false)).toEqual([]);
  });

  // U2 review: a turn drawn (not watched) whose work ran on in the background shows open with its Stop; when that work
  // ends, the turn waits as a watched turn does, so it never folds under the reader or the keyboard focus.
  test("a drawn turn whose background work ends later stays open, and folds at a later turn only while the view follows the end and the focus is not in it", () => {
    const evs: ChatEvent[] = [
      start(),
      user("m1"),
      text("msg_a", "Starting a reviewer."),
      call("ag1", "Agent", { subagent_type: "general-purpose", description: "Review", prompt: "Review it" }),
      { k: "task", ev: "started", taskId: "task1", toolUseId: "ag1", taskType: "local_agent", subagentType: "general-purpose", description: "Review", workflowName: null, background: false, prompt: "Review it", parentTaskId: null } as ChatEvent,
      { k: "task", ev: "updated", taskId: "task1", toolUseId: "ag1", status: "running", error: null, background: true } as ChatEvent,
      call("r1"),
      result("r1"),
      text("msg_z", "The reviewer runs in the background; I will report."),
      end({ ms: 5000, uuids: ["m1"] }),
    ];
    const c = { ...live(evs, blank(), 0, { replay: true }), tasks: [{ taskId: "task1" }] } as unknown as ChatPart;
    const w = newWatch(c.marks);
    const before = layout(c, turnsIn(c)[0]!);
    expect([before.folds, before.runsOn]).toEqual([false, true]);
    noteRunsOn(w, [before]);
    expect(watchedOpen(w, before.turn)).toBe(false);
    const done = live([{ k: "task", ev: "done", taskId: "task1", toolUseId: "ag1", status: "completed", summary: "ok", usage: null } as ChatEvent], c, 20);
    const after = layout(done, turnsIn(done)[0]!);
    expect([after.folds, after.runsOn]).toEqual([true, false]);
    noteRunsOn(w, [after]);
    expect(watchedOpen(w, after.turn)).toBe(true);
    const next = { id: "m2", end: null };
    expect(foldNow(w, [after.turn], true, () => false)).toEqual([]);
    expect(foldNow(w, [after.turn, next], false, () => false)).toEqual([]);
    expect(foldNow(w, [after.turn, next], true, (id) => id === "m1")).toEqual([]);
    expect(foldNow(w, [after.turn, next], true, () => false)).toEqual(["m1"]);
    expect(watchedOpen(w, after.turn)).toBe(false);
    // Drawn again (a snapshot gives the turn a new end mark), it is folded.
    const redrawn = { ...after.turn, end: { ...after.turn.end! } };
    noteRunsOn(w, [{ ...after, turn: redrawn }]);
    expect(watchedOpen(w, redrawn)).toBe(false);
  });

  test("the open state: this entry's toggle, then a link into the turn, then the reader's kept choice, then the timing rule", () => {
    expect(turnOpen({ forced: false, watched: false })).toBe(false);
    expect(turnOpen({ forced: false, watched: true })).toBe(true);
    expect(turnOpen({ forced: false, choice: false, watched: true })).toBe(false);
    expect(turnOpen({ forced: true, choice: false, watched: false })).toBe(true);
    expect(turnOpen({ entry: false, forced: true, choice: true, watched: true })).toBe(false);
  });

  test("the choice is kept per chat in session storage, the newest 200, and a bad value reads as none", () => {
    const data = new Map<string, string>();
    const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    writeChoice(store, "chat1", "t1", true);
    writeChoice(store, "chat1", "t2", false);
    expect(JSON.parse(data.get(`${TURN_CHOICES_KEY}chat1`)!)).toEqual({ t1: true, t2: false });
    expect(readChoices(store, "chat2").size).toBe(0);
    for (let i = 0; i < TURN_CHOICES_MAX + 5; i++) writeChoice(store, "chat1", `n${i}`, true);
    const kept = readChoices(store, "chat1");
    expect(kept.size).toBe(TURN_CHOICES_MAX);
    expect(kept.has("t1")).toBe(false);
    expect([...kept.keys()].at(-1)).toBe(`n${TURN_CHOICES_MAX + 4}`);
    // Choosing again makes it the newest.
    writeChoice(store, "chat1", "n10", false);
    expect([...readChoices(store, "chat1").keys()].at(-1)).toBe("n10");
    data.set(`${TURN_CHOICES_KEY}chat3`, "{not json");
    expect(readChoices(store, "chat3").size).toBe(0);
    data.set(`${TURN_CHOICES_KEY}chat3`, JSON.stringify({ a: "yes", b: true }));
    expect([...readChoices(store, "chat3")]).toEqual([["b", true]]);
    expect(readChoices(null, "chat1").size).toBe(0);
  });
});
