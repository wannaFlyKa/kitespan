// What a page draws after a reload, on a late viewer and after a server restart (DESIGN.md 5.4, 6.3; BUILD-BRIEF
// D48, D49): each closed card's record with how it closed (from the server's own notes, merged into history right
// after the card's tool call), the `!` rows under their own uuids, the calls that a turn's end or an exit stopped,
// and the row's busy mark that Stop and archive reads. The scripted driver and the in-memory store stand in for the
// SDK and the disk.
import { describe, expect, test } from "bun:test";
import type { ChatDelta, ChatEvent, ElicitationCard, NewChatFrame, PermissionCard, PlanCard, QuestionCard } from "../../shared/protocol";
import { CARD_ABORT } from "../../server/agents/types";
import { bashDigest, decorateHistory, notRunAnchor } from "../../server/chats/history";
import { ChatRegistry } from "../../server/chats/registry";
import { FakeBash, FakeDriver, MemoryStore, RecordingViewer, apply, projectRecord, settle } from "../../server/chats/testing";
import { emptyNotes } from "../../server/store/notes";
import type { NotRunNote } from "../../server/store/types";
import type { RegistryOptions } from "../../server/chats/types";

const PROJECT = "k3m7q2x4ab";
const rid = () => crypto.randomUUID();
const OPTS: RegistryOptions = { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500 };

async function setup(prep?: (d: FakeDriver, s: MemoryStore) => void) {
  const driver = new FakeDriver();
  const store = new MemoryStore();
  const bash = new FakeBash();
  store.projects = [projectRecord(PROJECT)];
  prep?.(driver, store);
  const reg = new ChatRegistry({ driver, store, bash }, OPTS);
  await reg.boot();
  const deltas: ChatDelta[] = [];
  reg.subscribe((d) => deltas.push(d));
  return { driver, store, reg, deltas, bash };
}

/** The next server life over the same disk (the store) and the same Claude Code sessions (the driver). */
async function restart(reg: ChatRegistry, driver: FakeDriver, store: MemoryStore, bash: FakeBash): Promise<ChatRegistry> {
  await reg.shutdown();
  const next = new ChatRegistry({ driver, store, bash }, OPTS);
  await next.boot();
  return next;
}

function newChatFrame(text: string): NewChatFrame {
  return { t: "new_chat", rid: rid(), project: PROJECT, uuid: rid(), text, picks: { model: null, effort: null, mode: null }, uploads: [] };
}
async function newChat(reg: ChatRegistry, text = "Fix the upload test"): Promise<string> {
  const o = await apply(reg, newChatFrame(text));
  if (!o.ok) throw new Error(`new_chat refused: ${o.code}`);
  return (o.result as { chat: string }).chat;
}

const turnEnd = (subtype = "success"): ChatEvent => ({ k: "turn_end", ok: subtype === "success", subtype, durationMs: 3, error: null, uuids: [] });
const call = (id: string, parent: string | null = null, name = "Bash"): ChatEvent => ({ k: "tool_call", id, name, input: { command: "ls" }, parent });
const result = (id: string, parent: string | null = null): ChatEvent => ({ k: "tool_result", id, text: "ok", isError: false, parent, report: null });
const permission = (id: string, over: Partial<PermissionCard> = {}): PermissionCard => ({
  kind: "permission",
  id,
  toolUseId: id,
  toolName: "Bash",
  title: null,
  displayName: null,
  description: null,
  reason: null,
  blockedPath: null,
  input: { command: "rm -rf build" },
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  sessionRule: true,
  parent: null,
  ...over,
});
const question: QuestionCard = {
  kind: "question",
  id: "toolu_q",
  toolUseId: "toolu_q",
  questions: [
    { question: "Which branch?", header: "Branch", multiSelect: false, options: [{ label: "main", description: "" }, { label: "dev", description: "" }] },
    { question: "Run the tests?", header: "Tests", multiSelect: false, options: [{ label: "Yes", description: "" }] },
  ],
};
const plan: PlanCard = { kind: "plan", id: "toolu_plan", toolUseId: "toolu_plan", plan: "1. Fix it.\n2. Test it." };
const elicitation: ElicitationCard = {
  kind: "elicitation",
  id: "elicit-1",
  server: "notes",
  displayName: null,
  title: "Sign in",
  description: null,
  message: "Your notes server needs a token.",
  mode: "form",
  url: null,
  elicitationId: null,
  schema: { type: "object", properties: { token: { type: "string" } } },
};

/** The chat's live process, after its first turn ended, with the transcript written under its session id. */
async function liveChat(reg: ChatRegistry, driver: FakeDriver) {
  const chat = await newChat(reg);
  const c = driver.last;
  const sid = c.input.sessionId!.value;
  driver.transcript(sid);
  c.emit({ k: "session", sessionId: sid, model: "claude-haiku-5-5", mode: "default", version: "2.1.311", bypass: false }, turnEnd());
  await settle();
  return { chat, c, sid };
}

const answer = (reg: ChatRegistry, chat: string, card: string, a: unknown) => apply(reg, { t: "answer", rid: rid(), chat, card, answer: a } as never);
const closes = (events: readonly ChatEvent[]) => events.filter((e): e is Extract<ChatEvent, { k: "card_close" }> => e.k === "card_close");
/** What a page draws after an attach: the snapshot's history, then the tail. */
const drawn = (p: { snapshot: { history: ChatEvent[] }; tail: { e: ChatEvent }[] }) => [...p.snapshot.history, ...p.tail.map((i) => i.e)];
/** U2: history also gives each turn its start and end (server/chats/turns.ts; test/unit/turn-notes, test/web/turn-history); these tests are about the rows. */
const unmarked = (events: readonly ChatEvent[]) => events.filter((e) => e.k !== "turn_start" && e.k !== "turn_end");
const kinds = (events: readonly ChatEvent[]) =>
  events.map((e) => (e.k === "tool_call" || e.k === "tool_result" || e.k === "tool_stopped" ? `${e.k} ${e.id}` : e.k === "card_open" ? `card_open ${e.card.id}` : e.k === "card_close" ? `card_close ${e.id} ${e.answer}` : e.k));

describe("card_close says how the card closed (5.4)", () => {
  test("Allow once, Allow for this session, Deny with its note, a question's answers, a plan's mode and its feedback, an elicitation's Decline", async () => {
    const { reg, driver } = await setup();
    const { chat, c } = await liveChat(reg, driver);
    const v = new RecordingViewer();
    await reg.attach(chat, v);
    for (const id of ["toolu_1", "toolu_2", "toolu_3"]) c.ask(permission(id));
    c.ask(question);
    c.ask(plan);
    c.ask({ ...plan, id: "toolu_plan2", toolUseId: "toolu_plan2" });
    c.ask(elicitation);
    await settle();
    await answer(reg, chat, "toolu_1", { kind: "permission", allow: true, scope: "once" });
    await answer(reg, chat, "toolu_2", { kind: "permission", allow: true, scope: "session" });
    await answer(reg, chat, "toolu_3", { kind: "permission", allow: false, message: "  Use the clean script instead. " });
    // An answer to a question that the card does not ask is not part of the record (the driver drops it too).
    await answer(reg, chat, "toolu_q", { kind: "question", answers: { "Which branch?": "dev", "Run the tests?": "Yes", "Not asked": "x" } });
    await answer(reg, chat, "toolu_plan", { kind: "plan", approve: true, mode: "acceptEdits" });
    await answer(reg, chat, "toolu_plan2", { kind: "plan", approve: false, feedback: "Test first." });
    await answer(reg, chat, "elicit-1", { kind: "elicitation", action: "decline" });
    expect(closes(v.events)).toEqual([
      { k: "card_close", id: "toolu_1", why: "answered", answer: "once" },
      { k: "card_close", id: "toolu_2", why: "answered", answer: "session" },
      { k: "card_close", id: "toolu_3", why: "answered", answer: "denied", note: "Use the clean script instead." },
      { k: "card_close", id: "toolu_q", why: "answered", answer: "answered", answers: { "Which branch?": "dev", "Run the tests?": "Yes" } },
      { k: "card_close", id: "toolu_plan", why: "answered", answer: "answered", mode: "acceptEdits" },
      { k: "card_close", id: "toolu_plan2", why: "answered", answer: "denied", note: "Test first." },
      { k: "card_close", id: "elicit-1", why: "answered", answer: "denied" },
    ]);
  });

  test("Stop answers a waiting card as cancelled; a card whose process ends is lost, also cancelled", async () => {
    const { reg, driver } = await setup();
    const { chat, c } = await liveChat(reg, driver);
    const v = new RecordingViewer();
    await reg.attach(chat, v);
    c.emit({ k: "turn_start", by: "user" }, call("toolu_1"));
    c.ask(permission("toolu_1"));
    await settle();
    const turn = v.of("turn_start")[0]!;
    expect(turn).toBeDefined();
    const start = v.items.find((i) => i.e.k === "turn_start")!.seq;
    expect(await apply(reg, { t: "interrupt", rid: rid(), chat, turn: start })).toMatchObject({ ok: true });
    c.emit(call("toolu_2"));
    c.ask(permission("toolu_2"));
    await settle();
    c.end();
    await settle();
    expect(closes(v.events)).toEqual([
      { k: "card_close", id: "toolu_1", why: "cancelled", answer: "cancelled" },
      { k: "card_close", id: "toolu_2", why: "lost", answer: "cancelled" },
    ]);
  });

  test("the driver's own abort reasons: a card whose process ended is lost; a URL card finished elsewhere is answered", async () => {
    const { reg, driver } = await setup();
    const { chat, c } = await liveChat(reg, driver);
    const v = new RecordingViewer();
    await reg.attach(chat, v);
    const lost = c.ask(permission("toolu_1"));
    const url = c.ask({ ...elicitation, mode: "url", url: "https://notes.example.com/sign-in", elicitationId: "e-1" });
    const withdrawn = c.ask(permission("toolu_3"));
    await settle();
    lost.abort(CARD_ABORT.ended);
    url.abort(CARD_ABORT.completed);
    withdrawn.abort();
    expect(await lost.answer).toBeNull();
    expect(await url.answer).toEqual({ kind: "elicitation", action: "accept" });
    expect(await withdrawn.answer).toBeNull();
    expect(closes(v.events)).toEqual([
      { k: "card_close", id: "toolu_1", why: "lost", answer: "cancelled" },
      { k: "card_close", id: "elicit-1", why: "answered", answer: "answered" },
      { k: "card_close", id: "toolu_3", why: "cancelled", answer: "cancelled" },
    ]);
  });
});

describe("history holds each closed card's record (late viewers, reloads, restarts)", () => {
  test("a page that attaches after the turn ended gets the card's open and close right after its tool call, once", async () => {
    const { reg, driver } = await setup();
    const { chat, c, sid } = await liveChat(reg, driver);
    c.emit({ k: "turn_start", by: "user" }, call("toolu_1"));
    c.ask(permission("toolu_1"));
    await settle();
    await answer(reg, chat, "toolu_1", { kind: "permission", allow: true, scope: "session" });
    c.emit(result("toolu_1"), turnEnd());
    await settle();
    // The transcript as Claude Code wrote it: the call and its result, never the card.
    driver.histories.set(sid, [{ k: "user", uuid: rid(), text: "clean up", queued: false }, call("toolu_1"), result("toolu_1")]);
    const late = (await reg.attach(chat, new RecordingViewer("tab_late")))!;
    expect(kinds(unmarked(late.snapshot.history))).toEqual(["user", "tool_call toolu_1", "card_open toolu_1", "card_close toolu_1 session", "tool_result toolu_1"]);
    expect(late.snapshot.history.find((e) => e.k === "card_open")).toMatchObject({ card: { kind: "permission", toolName: "Bash", input: { command: "rm -rf build" } } });
    // Nothing of the ended turn follows the snapshot, so the record is there once.
    expect(late.tail.filter((i) => i.e.k === "card_open" || i.e.k === "card_close")).toEqual([]);
    expect(late.attached.cards).toEqual([]);
  });

  test("during the turn, a record that the history page holds is not sent again in the tail; one it does not hold is", async () => {
    const { reg, driver } = await setup();
    const { chat, c, sid } = await liveChat(reg, driver);
    c.emit({ k: "turn_start", by: "user" }, call("toolu_1"));
    c.ask(permission("toolu_1"));
    await settle();
    await answer(reg, chat, "toolu_1", { kind: "permission", allow: true, scope: "once" });
    c.emit(call("toolu_2"));
    c.ask(permission("toolu_2"));
    await settle();
    await answer(reg, chat, "toolu_2", { kind: "permission", allow: false, message: "" });
    await settle();
    // The transcript holds the first call so far, not the second.
    driver.histories.set(sid, [call("toolu_1")]);
    const p = (await reg.attach(chat, new RecordingViewer("tab_mid")))!;
    expect(kinds(unmarked(p.snapshot.history))).toEqual(["tool_call toolu_1", "card_open toolu_1", "card_close toolu_1 once"]);
    expect(kinds(p.tail.map((i) => i.e)).filter((k) => k.startsWith("card"))).toEqual(["card_open toolu_2", "card_close toolu_2 denied"]);
    const all = drawn(p);
    expect(all.filter((e) => e.k === "card_open").length).toBe(2);
    expect(all.filter((e) => e.k === "card_close").length).toBe(2);
  });

  test("the record survives a server restart: the question's answers, the plan's mode, the elicitation by the call it came in, a lost card", async () => {
    const { reg, driver, store, bash } = await setup();
    const { chat, c, sid } = await liveChat(reg, driver);
    c.emit({ k: "turn_start", by: "user" }, call("toolu_q", null, "AskUserQuestion"), call("toolu_plan", null, "ExitPlanMode"), call("toolu_mcp", null, "mcp__notes__find"));
    c.ask(question);
    c.ask(plan);
    c.ask(elicitation);
    await settle();
    await answer(reg, chat, "toolu_q", { kind: "question", answers: { "Which branch?": "main" } });
    await answer(reg, chat, "toolu_plan", { kind: "plan", approve: true, mode: "auto" });
    await answer(reg, chat, "elicit-1", { kind: "elicitation", action: "accept", content: { token: "secret-token-value" } });
    c.emit(call("toolu_x"));
    c.ask(permission("toolu_x"));
    await settle();
    c.end();
    await settle();
    driver.histories.set(sid, [call("toolu_q", null, "AskUserQuestion"), result("toolu_q"), call("toolu_plan", null, "ExitPlanMode"), result("toolu_plan"), call("toolu_mcp", null, "mcp__notes__find"), result("toolu_mcp"), call("toolu_x")]);
    const next = await restart(reg, driver, store, bash);
    const p = (await next.attach(chat, new RecordingViewer("tab_after")))!;
    expect(kinds(unmarked(p.snapshot.history))).toEqual([
      "tool_call toolu_q",
      "card_open toolu_q",
      "card_close toolu_q answered",
      "tool_result toolu_q",
      "tool_call toolu_plan",
      "card_open toolu_plan",
      "card_close toolu_plan answered",
      "tool_result toolu_plan",
      "tool_call toolu_mcp",
      "card_open elicit-1",
      "card_close elicit-1 answered",
      "tool_result toolu_mcp",
      "tool_call toolu_x",
      "card_open toolu_x",
      "card_close toolu_x cancelled",
      // No turn runs: the call that the exit cut off is stopped.
      "tool_stopped toolu_x",
    ]);
    const cl = closes(p.snapshot.history);
    expect(cl.find((e) => e.id === "toolu_q")).toEqual({ k: "card_close", id: "toolu_q", why: "answered", answer: "answered", answers: { "Which branch?": "main" } });
    expect(cl.find((e) => e.id === "toolu_plan")).toMatchObject({ answer: "answered", mode: "auto" });
    expect(cl.find((e) => e.id === "toolu_x")).toMatchObject({ why: "lost" });
    // The record keeps what it shows, never what the user typed into a form.
    expect(JSON.stringify(store.notes.get(chat))).not.toContain("secret-token-value");
    expect(p.snapshot.history.find((e) => e.k === "card_open" && e.card.kind === "elicitation")).toMatchObject({ card: { server: "notes", schema: null } });
    expect(p.tail).toEqual([]);
  });

  test("a record whose call no transcript holds is left out of history; Delete drops the notes", async () => {
    const { reg, driver, store } = await setup();
    const { chat, c, sid } = await liveChat(reg, driver);
    c.emit({ k: "turn_start", by: "user" }, call("toolu_1"));
    c.ask(permission("toolu_1"));
    await settle();
    await answer(reg, chat, "toolu_1", { kind: "permission", allow: true, scope: "once" });
    c.emit(result("toolu_1"), turnEnd());
    await settle();
    driver.histories.set(sid, [{ k: "user", uuid: rid(), text: "something else", queued: false }]);
    const p = (await reg.attach(chat, new RecordingViewer()))!;
    expect(p.snapshot.history.map((e) => e.k)).toEqual(["user"]);
    expect(store.notes.get(chat)?.cards.map((n) => n.card.id)).toEqual(["toolu_1"]);
    expect((await apply(reg, { t: "delete", rid: rid(), chat })).ok).toBe(true);
    expect(store.notes.has(chat)).toBe(false);
  });
});

describe("tool_stopped: the calls that a turn's end or an exit leaves with no result", () => {
  test("live: at the turn's end, before turn_end, the main calls and the calls inside them; not a background subagent's", async () => {
    const { reg, driver } = await setup();
    const { chat, c } = await liveChat(reg, driver);
    const v = new RecordingViewer();
    await reg.attach(chat, v);
    c.emit(
      { k: "turn_start", by: "user" },
      call("toolu_done"),
      result("toolu_done"),
      call("toolu_open"),
      call("toolu_agent", null, "Agent"),
      call("toolu_inner", "toolu_agent"),
      call("toolu_bg", null, "Agent"),
      // The background agent's call returned at once; its own calls go on after the turn.
      result("toolu_bg"),
      { k: "task", ev: "started", taskId: "task_bg", toolUseId: "toolu_bg", taskType: "local_agent", subagentType: "general-purpose", description: "Review", workflowName: null, background: true, prompt: null, parentTaskId: null },
      call("toolu_bg_inner", "toolu_bg"),
      turnEnd("error_during_execution"),
    );
    await settle();
    const after = v.events.slice(v.events.findIndex((e) => e.k === "turn_start"));
    expect(kinds(after).slice(-4)).toEqual(["tool_stopped toolu_open", "tool_stopped toolu_agent", "tool_stopped toolu_inner", "turn_end"]);
    expect(v.of("tool_stopped").find((e) => e.id === "toolu_inner")).toEqual({ k: "tool_stopped", id: "toolu_inner", parent: "toolu_agent" });
    // The background task ends later: its call that got no result stops then.
    c.emit({ k: "task", ev: "done", taskId: "task_bg", toolUseId: "toolu_bg", status: "completed", summary: null, usage: null });
    await settle();
    expect(v.of("tool_stopped").map((e) => e.id)).toEqual(["toolu_open", "toolu_agent", "toolu_inner", "toolu_bg_inner"]);
  });

  test("live: an exit stops every open call before its line; history then says the same, once", async () => {
    const { reg, driver } = await setup();
    const { chat, c, sid } = await liveChat(reg, driver);
    const v = new RecordingViewer();
    await reg.attach(chat, v);
    c.emit({ k: "turn_start", by: "user" }, call("toolu_1"));
    await settle();
    c.end({ code: 1, signal: null });
    await settle();
    expect(kinds(v.events).slice(-2)).toEqual(["tool_stopped toolu_1", "exit"]);
    driver.histories.set(sid, [{ k: "user", uuid: rid(), text: "go", queued: false }, call("toolu_1")]);
    const p = (await reg.attach(chat, new RecordingViewer("tab_b")))!;
    expect(kinds(unmarked(p.snapshot.history))).toEqual(["user", "tool_call toolu_1", "tool_stopped toolu_1"]);
    expect(drawn(p).filter((e) => e.k === "tool_stopped")).toHaveLength(1);
  });

  test("history leaves the last turn's calls as they are while that turn runs", async () => {
    const { reg, driver } = await setup();
    const { chat, c, sid } = await liveChat(reg, driver);
    c.emit({ k: "turn_start", by: "user" }, call("toolu_1"));
    await settle();
    driver.histories.set(sid, [call("toolu_1")]);
    const p = (await reg.attach(chat, new RecordingViewer()))!;
    expect(drawn(p).some((e) => e.k === "tool_stopped")).toBe(false);
    c.emit(turnEnd());
    await settle();
    const q = (await reg.attach(chat, new RecordingViewer()))!;
    expect(kinds(unmarked(q.snapshot.history))).toEqual(["tool_call toolu_1", "tool_stopped toolu_1"]);
  });
});

describe("`!` rows keep their own uuid in history (the CLI writes the record under its own id)", () => {
  test("after a restart the record shows under the row's uuid, so a page that drew it live draws it once", async () => {
    const { reg, driver, store, bash } = await setup((_d, s) => {
      s.settingsValue = { ...s.settingsValue, "chats.bashReply": "never" };
    });
    const { chat, sid } = await liveChat(reg, driver);
    const v = new RecordingViewer();
    await reg.attach(chat, v);
    const typedInTerminal = rid();
    // A `!` typed in the terminal before, with the same command and output: it keeps its own id.
    const record = (uuid: string): ChatEvent => ({ k: "bash", uuid, input: "git status", state: "done", stdout: "ok\n", stderr: "", code: null, ms: null, timedOut: false, capped: false });
    driver.histories.set(sid, [record(typedInTerminal)]);
    const frame = { t: "bash" as const, rid: rid(), chat, input: "git status", draftRev: null, uploads: [] };
    expect((await apply(reg, frame)).ok).toBe(true);
    await settle(10);
    expect(v.of("bash").map((e) => [e.uuid, e.state])).toEqual([
      [frame.rid, "running"],
      [frame.rid, "done"],
    ]);
    const cliOwn = rid();
    driver.histories.set(sid, [record(typedInTerminal), record(cliOwn)]);
    for (const r of [reg, await restart(reg, driver, store, bash)]) {
      const p = (await r.attach(chat, new RecordingViewer()))!;
      expect(p.snapshot.history.filter((e) => e.k === "bash").map((e) => (e as { uuid: string }).uuid)).toEqual([typedInTerminal, frame.rid]);
      expect(p.tail.filter((i) => i.e.k === "bash")).toEqual([]);
    }
  });

  test("the relabelled record carries the row's exit code, duration, timeout and cap, after a reload and after a restart", async () => {
    const { reg, driver, store, bash } = await setup((_d, s) => {
      s.settingsValue = { ...s.settingsValue, "chats.bashReply": "never" };
    });
    const { chat, sid } = await liveChat(reg, driver);
    bash.result = { stdout: "one\ntwo\n", stderr: "", code: 3, ms: 2, timedOut: false, capped: false };
    const v = new RecordingViewer();
    await reg.attach(chat, v);
    const input = "printf 'one\\ntwo\\n'; exit 3";
    const frame = { t: "bash" as const, rid: rid(), chat, input, draftRev: null, uploads: [] };
    expect((await apply(reg, frame)).ok).toBe(true);
    await settle(10);
    const live = v.of("bash").find((e) => e.state === "done")!;
    expect([live.code, live.ms]).toEqual([3, 2]);
    // The transcript's record holds no code and no duration.
    driver.histories.set(sid, [{ k: "bash", uuid: rid(), input, state: "done", stdout: "one\ntwo\n", stderr: "", code: null, ms: null, timedOut: false, capped: false }]);
    for (const r of [reg, await restart(reg, driver, store, bash)]) {
      const p = (await r.attach(chat, new RecordingViewer("tab_b")))!;
      const rows = p.snapshot.history.filter((e) => e.k === "bash");
      expect(rows).toEqual([{ ...live, uuid: frame.rid }]);
    }
  });
});

describe("Not run rows: a `!` command that never ran keeps its row in history (the notes keep its place)", () => {
  const user = (uuid: string, text = "hi"): ChatEvent => ({ k: "user", uuid, text, queued: false });
  const reply = (key: string): ChatEvent => ({ k: "block", key, kind: "text", text: "ok", parent: null });
  const row = (uuid: string, input: string, state: "done" | "not_run" = "not_run"): ChatEvent => ({ k: "bash", uuid, input, state, stdout: "", stderr: "", code: null, ms: null, timedOut: false, capped: false });
  const noted = (uuid: string, input: string, at: { after: string | null; skip: number }): NotRunNote => ({ uuid, input, ...at });
  const withRows = (rows: NotRunNote[]) => ({ ...emptyNotes("k3m7q2x4abk3m7q2x4ab"), notRun: rows });
  const [U1, U2, N1, N2, N3] = [rid(), rid(), rid(), rid(), rid()];

  test("its place is the transcript's end: the last event with an id, and the id-less events after it", () => {
    expect(notRunAnchor([])).toEqual({ after: null, skip: 0 });
    expect(notRunAnchor([turnEnd()])).toEqual({ after: null, skip: 1 });
    expect(notRunAnchor([user(U1), reply("msg_1:0"), turnEnd()])).toEqual({ after: "msg_1:0", skip: 1 });
    expect(notRunAnchor([user(U1), call("toolu_1")])).toEqual({ after: "call:toolu_1", skip: 0 });
  });

  test("the row stays where the transcript ended when it was noted, after the chat went on; rows noted together keep their order", () => {
    const then = [user(U1), reply("msg_1:0"), turnEnd()];
    const at = notRunAnchor(then);
    const now = [...then, user(U2), reply("msg_2:0"), turnEnd()];
    const notes = withRows([noted(N1, "make lint", at), noted(N2, "make test", at)]);
    expect(decorateHistory(now, notes, { ended: true })).toEqual([...then, row(N1, "make lint"), row(N2, "make test"), user(U2), reply("msg_2:0"), turnEnd()]);
    // Noted later, at a later end: after the later turn.
    const later = withRows([noted(N1, "make lint", at), noted(N3, "pwd", notRunAnchor(now))]);
    expect(decorateHistory(now, later, { ended: true }).filter((e) => e.k === "bash").map((e) => (e as { uuid: string }).uuid)).toEqual([N1, N3]);
  });

  test("an empty transcript puts the row first; a row whose place is gone from the transcript (a rewind) is left out; a row is drawn once", () => {
    const now = [user(U2), reply("msg_2:0"), turnEnd()];
    expect(decorateHistory(now, withRows([noted(N1, "ls", { after: null, skip: 0 })]), { ended: true })[0]).toEqual(row(N1, "ls"));
    expect(decorateHistory(now, withRows([noted(N1, "ls", { after: "msg_gone:0", skip: 0 })]), { ended: true })).toEqual(now);
    expect(decorateHistory([...now, row(N1, "ls")], withRows([noted(N1, "ls", { after: null, skip: 0 })]), { ended: true })).toEqual([...now, row(N1, "ls")]);
  });

  test("a Not run row is never taken for a `!` record, and the last turn's open calls still stop", () => {
    // A row that ran with an empty output of the same command, then one that never ran: the note's digest is the
    // transcript record's, and only that record takes the row's uuid.
    const record = rid();
    const events = [user(U1), row(record, "ls", "done")];
    const notes = { ...withRows([noted(N1, "ls", notRunAnchor(events))]), bash: [{ uuid: N2, digest: bashDigest("ls", "", ""), code: 0, ms: 1, timedOut: false, capped: false }] };
    const out = decorateHistory(events, notes, { ended: true });
    expect(out.filter((e) => e.k === "bash").map((e) => [(e as { uuid: string }).uuid, (e as { state: string }).state])).toEqual([
      [N2, "done"],
      [N1, "not_run"],
    ]);
    // [call, Not run row] with no result: the call stops at the end, as with no row.
    const open = decorateHistory([user(U1), call("toolu_2")], withRows([noted(N3, "pwd", notRunAnchor([user(U1), call("toolu_2")]))]), { ended: true });
    expect(kinds(open)).toEqual(["user", "tool_call toolu_2", "bash", "tool_stopped toolu_2"]);
  });
});

describe("ChatRow busy (D48: Stop and archive)", () => {
  test("busy while the chat starts, a turn runs, a card waits or a task that is not ambient runs", async () => {
    const { reg, driver, deltas } = await setup();
    const chat = await newChat(reg);
    const c = driver.last;
    const row = () => reg.list().find((r) => r.chat === chat)!;
    expect(row().busy).toBe(true);
    c.emit(turnEnd());
    await settle();
    expect(row().busy).toBe(false);
    expect(deltas.filter((d) => d.chat === chat && "busy" in d).map((d) => (d as { busy: boolean }).busy).at(-1)).toBe(false);
    c.ask(permission("toolu_1"));
    await settle();
    expect(row()).toMatchObject({ busy: true, needsYou: true });
    await answer(reg, chat, "toolu_1", { kind: "permission", allow: true, scope: "once" });
    c.emit(turnEnd());
    await settle();
    expect(row().busy).toBe(false);
    c.emit({ k: "tasks", running: [{ taskId: "t1", description: "watch", ambient: true }] });
    await settle();
    expect(row().busy).toBe(false);
    c.emit({ k: "tasks", running: [{ taskId: "t2", description: "review", ambient: false }] });
    await settle();
    expect(row().busy).toBe(true);
    // The row's busy is the archive rule's: Archive without stop is refused exactly then.
    expect(await apply(reg, { t: "archive", rid: rid(), chat, on: true, stop: false })).toEqual({ ok: false, code: "busy" });
    c.emit({ k: "tasks", running: [] });
    await settle();
    expect(row().busy).toBe(false);
    expect((await apply(reg, { t: "archive", rid: rid(), chat, on: true, stop: false })).ok).toBe(true);
  });
});
