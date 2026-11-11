// Row 111 (FIX-W28 sections 1 and 2): Send now on a queued message, the terminal's Ctrl+Enter, in the registry. A
// foreground Bash call or subagent moves to the background (backgroundTasks with no tool use) and Claude reads the
// messages in the same turn; a Bash call whose task has not started is waited for, up to the wait; anything else gets
// Stop's plain interrupt, which keeps the queue, and the messages run next. One action per press, none for a message
// that waits no more. And the queued state stays exact: a message leaves Queued when Claude takes it in (the reply's
// answering uuids, or the next reply frame after a tool result) and stays in the queue file until a turn's end lists
// it. The scripted driver and MemoryStore stand in for Claude Code and the disk.
import { describe, expect, test } from "bun:test";
import { TURN_INTERRUPTED, type ChatEvent, type NewChatFrame, type PermissionCard, type SendFrame, type SendNowAct, type SendNowFrame } from "../../shared/protocol";
import { ChatRegistry } from "../../server/chats/registry";
import { SendNowWatch, sendNowAct } from "../../server/chats/send-now";
import { FakeBash, FakeDriver, MemoryStore, RecordingViewer, apply, projectRecord, settle, type FakeChat } from "../../server/chats/testing";
import type { RegistryOptions } from "../../server/chats/types";

const PROJECT = "k3m7q2x4ab";
const rid = () => crypto.randomUUID();

async function setup(opts: RegistryOptions = {}) {
  const driver = new FakeDriver();
  const store = new MemoryStore();
  const bash = new FakeBash();
  store.projects = [projectRecord(PROJECT)];
  const reg = new ChatRegistry({ driver, store, bash }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500, sendNowWaitMs: 400, ...opts });
  await reg.boot();
  return { driver, store, reg, bash };
}

/** A chat whose first message runs a turn now, with a viewer attached; `first` is that message's uuid. */
async function running(reg: ChatRegistry, driver: FakeDriver) {
  const f: NewChatFrame = { t: "new_chat", rid: rid(), project: PROJECT, uuid: rid(), text: "long task", picks: { model: null, effort: null, mode: null }, uploads: [] };
  const o = await apply(reg, f);
  if (!o.ok) throw new Error(`new_chat refused: ${o.code}`);
  const chat = (o.result as { chat: string }).chat;
  const v = new RecordingViewer();
  await reg.attach(chat, v);
  return { chat, c: driver.last, v, first: f.uuid };
}

function send(chat: string, text: string): SendFrame {
  const r = rid();
  return { t: "send", rid: r, chat, uuid: r, text, draftRev: null, uploads: [] };
}
const now = (chat: string, uuid: string): SendNowFrame => ({ t: "send_now", rid: rid(), chat, uuid });
const acted = (a: SendNowAct) => ({ ok: true as const, result: { acted: a } });

const bashCall = (id: string, input: Record<string, unknown> = { command: "sleep 20" }): ChatEvent => ({ k: "tool_call", id, name: "Bash", input, parent: null });
const started = (taskId: string, toolUseId: string, taskType = "local_bash", background = false): ChatEvent => ({
  k: "task",
  ev: "started",
  taskId,
  toolUseId,
  taskType,
  subagentType: null,
  description: "sleep 20",
  workflowName: null,
  background,
  prompt: null,
  parentTaskId: null,
});
const moved = (taskId: string, toolUseId: string): ChatEvent => ({ k: "task", ev: "updated", taskId, toolUseId, status: null, error: null, background: true });
const result = (id: string, text = "ok", parent: string | null = null): ChatEvent => ({ k: "tool_result", id, text, isError: false, parent, report: null });
const block = (key: string, text = "Done."): ChatEvent => ({ k: "block", key, kind: "text", text, parent: null });
const turnEnd = (uuids: string[], ok = true): ChatEvent => ({ k: "turn_end", ok, subtype: ok ? "success" : "error_during_execution", durationMs: 3, error: null, uuids });
/** Each `user` event's uuid and Queued mark, in order. */
const marks = (v: RecordingViewer) => v.of("user").map((e) => [e.uuid, e.queued] as const);
const queuedFile = (store: MemoryStore, chat: string) => (store.queues.get(chat)?.msgs ?? []).map((m) => m.uuid);
const calls = (c: FakeChat, name: string) => c.calls.filter((x) => x === name).length;

const permission = (id: string): PermissionCard => ({
  kind: "permission",
  id,
  toolUseId: id,
  toolName: "Bash",
  title: null,
  displayName: null,
  description: null,
  reason: null,
  blockedPath: null,
  input: { command: "sleep 20" },
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  sessionRule: true,
  parent: null,
});

describe("Send now while a Bash call or a subagent runs in the foreground", () => {
  test("the call moves to the background once; Claude takes every queued message in at its tool boundary", async () => {
    const { reg, driver, store } = await setup();
    const { chat, c, v, first } = await running(reg, driver);
    c.emit(bashCall("toolu_b"), started("b1", "toolu_b"));
    const m2 = send(chat, "and this");
    const m3 = send(chat, "and that");
    await apply(reg, m2);
    await apply(reg, m3);
    await settle();
    expect(marks(v)).toEqual([[m2.uuid, true], [m3.uuid, true]]);
    // The press is on the last queued message; it acts on both.
    expect(await apply(reg, now(chat, m3.uuid))).toEqual(acted("background"));
    expect(calls(c, "backgroundAll")).toBe(1);
    expect(calls(c, "interrupt")).toBe(0);
    // A second device's press on the same messages does nothing.
    expect(await apply(reg, now(chat, m3.uuid))).toEqual(acted("none"));
    expect(calls(c, "backgroundAll")).toBe(1);
    // The call returns at once (Claude Code's background line); the next reply frame shows that both went in.
    c.emit(moved("b1", "toolu_b"), result("toolu_b", "Command was manually backgrounded by user with ID: b1."));
    await settle();
    expect(marks(v)).toEqual([[m2.uuid, true], [m3.uuid, true]]);
    c.emit(block("msg_2:0"));
    await settle();
    expect(marks(v)).toEqual([[m2.uuid, true], [m3.uuid, true], [m2.uuid, false], [m3.uuid, false]]);
    const kinds = v.events.map((e) => e.k);
    expect(kinds.lastIndexOf("user")).toBeLessThan(kinds.lastIndexOf("block"));
    // Until the turn's end lists them, the queue file keeps them (R11), with the message that started the turn.
    expect(queuedFile(store, chat)).toEqual([first, m2.uuid, m3.uuid]);
    expect(await apply(reg, now(chat, m2.uuid))).toEqual(acted("none"));
    c.emit(turnEnd([first, m2.uuid, m3.uuid]));
    await settle();
    expect(marks(v)).toHaveLength(4);
    expect(queuedFile(store, chat)).toEqual([]);
  });

  test("a subagent in the foreground moves too; one that runs in the background already does not count", async () => {
    const { reg, driver } = await setup();
    const { chat, c } = await running(reg, driver);
    c.emit({ k: "tool_call", id: "toolu_a", name: "Agent", input: { description: "look", prompt: "look" }, parent: null }, started("a1", "toolu_a", "local_agent"));
    const m2 = send(chat, "now this");
    await apply(reg, m2);
    await settle();
    expect(await apply(reg, now(chat, m2.uuid))).toEqual(acted("background"));

    const second = await setup();
    const r2 = await running(second.reg, second.driver);
    r2.c.emit({ k: "tool_call", id: "toolu_a", name: "Agent", input: { run_in_background: true }, parent: null }, started("a1", "toolu_a", "local_agent", true));
    const n2 = send(r2.chat, "now this");
    await apply(second.reg, n2);
    await settle();
    expect(await apply(second.reg, now(r2.chat, n2.uuid))).toEqual(acted("interrupt"));
    expect(calls(r2.c, "backgroundAll")).toBe(0);
  });

  test("with background tasks off for the session, the turn stops instead", async () => {
    const { reg, driver } = await setup();
    const { chat, c } = await running(reg, driver);
    c.backgroundAllResult = false;
    c.emit(bashCall("toolu_b"), started("b1", "toolu_b"));
    const m2 = send(chat, "now");
    await apply(reg, m2);
    await settle();
    expect(await apply(reg, now(chat, m2.uuid))).toEqual(acted("interrupt"));
    expect(c.calls.filter((x) => x === "backgroundAll" || x === "interrupt")).toEqual(["backgroundAll", "interrupt"]);
  });
});

describe("Send now on a Bash call whose task has not started", () => {
  test("waits for task_started, then moves the call to the background", async () => {
    const { reg, driver } = await setup();
    const { chat, c } = await running(reg, driver);
    c.emit(bashCall("toolu_b"));
    const m2 = send(chat, "now");
    await apply(reg, m2);
    await settle();
    const press = apply(reg, now(chat, m2.uuid));
    await Bun.sleep(40);
    expect(calls(c, "backgroundAll")).toBe(0);
    c.emit(started("b1", "toolu_b"));
    expect(await press).toEqual(acted("background"));
    expect(calls(c, "backgroundAll")).toBe(1);
  });

  test("Claude Code's own order: the moved task's update comes before backgroundTasks() answers (live, 2.1.317)", async () => {
    for (const startedFirst of [false, true]) {
      const { reg, driver } = await setup();
      const { chat, c } = await running(reg, driver);
      c.emit(bashCall("toolu_b"));
      if (startedFirst) c.emit(started("b1", "toolu_b"));
      const m2 = send(chat, "now");
      await apply(reg, m2);
      await settle();
      c.backgroundAllEvents = [moved("b1", "toolu_b")];
      const press = apply(reg, now(chat, m2.uuid));
      await Bun.sleep(40);
      if (!startedFirst) c.emit(started("b1", "toolu_b"));
      expect(await press).toEqual(acted("background"));
      expect(c.calls.filter((x) => x === "backgroundAll" || x === "interrupt")).toEqual(["backgroundAll"]);
    }
  });

  test("a call that ends before its task starts needs nothing more: its tool boundary takes the message in", async () => {
    const { reg, driver } = await setup();
    const { chat, c, v } = await running(reg, driver);
    c.emit(bashCall("toolu_b"));
    const m2 = send(chat, "now");
    await apply(reg, m2);
    await settle();
    const press = apply(reg, now(chat, m2.uuid));
    await Bun.sleep(20);
    c.emit(result("toolu_b"));
    expect(await press).toEqual(acted("none"));
    expect(c.calls.filter((x) => x === "backgroundAll" || x === "interrupt")).toEqual([]);
    c.emit(block("msg_2:0"));
    await settle();
    expect(marks(v).at(-1)).toEqual([m2.uuid, false]);
  });

  test("a task that does not start in time: the turn stops, and the message runs next", async () => {
    const { reg, driver } = await setup({ sendNowWaitMs: 60 });
    const { chat, c } = await running(reg, driver);
    c.emit(bashCall("toolu_b"));
    const m2 = send(chat, "now");
    await apply(reg, m2);
    await settle();
    expect(await apply(reg, now(chat, m2.uuid))).toEqual(acted("interrupt"));
    expect(calls(c, "backgroundAll")).toBe(0);
  });

  test("a Bash call that asks for the background, or one whose card waits for an answer, is not waited for", async () => {
    const { reg, driver } = await setup({ sendNowWaitMs: 5_000 });
    const { chat, c } = await running(reg, driver);
    c.emit(bashCall("toolu_bg", { command: "npm run dev", run_in_background: true }));
    const m2 = send(chat, "now");
    await apply(reg, m2);
    await settle();
    const t0 = performance.now();
    expect(await apply(reg, now(chat, m2.uuid))).toEqual(acted("interrupt"));
    expect(performance.now() - t0).toBeLessThan(1_000);

    const second = await setup({ sendNowWaitMs: 5_000 });
    const r2 = await running(second.reg, second.driver);
    r2.c.emit(bashCall("toolu_b"));
    const asked = r2.c.ask(permission("toolu_b"));
    const n2 = send(r2.chat, "now");
    await apply(second.reg, n2);
    await settle();
    const t1 = performance.now();
    expect(await apply(second.reg, now(r2.chat, n2.uuid))).toEqual(acted("interrupt"));
    expect(performance.now() - t1).toBeLessThan(1_000);
    // As for Stop: the card is dismissed.
    expect(await asked.answer).toBeNull();
  });

  test("one step's calls: a call that ends while another is open is no tool boundary; the press waits on and moves the other", async () => {
    const { reg, driver } = await setup();
    const { chat, c } = await running(reg, driver);
    c.emit(bashCall("toolu_short", { command: "git status" }), bashCall("toolu_long", { command: "bun test" }));
    const m2 = send(chat, "now");
    await apply(reg, m2);
    await settle();
    const press = apply(reg, now(chat, m2.uuid));
    await Bun.sleep(20);
    c.emit(result("toolu_short"));
    await Bun.sleep(20);
    expect(calls(c, "backgroundAll")).toBe(0);
    c.emit(started("b_long", "toolu_long"));
    expect(await press).toEqual(acted("background"));
    expect(c.calls.filter((x) => x === "backgroundAll" || x === "interrupt")).toEqual(["backgroundAll"]);

    // Both end before their tasks start: the last one's end is the step's tool boundary, so nothing more is needed.
    const second = await setup();
    const r2 = await running(second.reg, second.driver);
    r2.c.emit(bashCall("toolu_a"), bashCall("toolu_b"));
    const n2 = send(r2.chat, "now");
    await apply(second.reg, n2);
    await settle();
    const press2 = apply(second.reg, now(r2.chat, n2.uuid));
    await Bun.sleep(20);
    r2.c.emit(result("toolu_a"));
    await Bun.sleep(20);
    r2.c.emit(result("toolu_b"));
    expect(await press2).toEqual(acted("none"));
    expect(r2.c.calls.filter((x) => x === "backgroundAll" || x === "interrupt")).toEqual([]);
  });

  test("one call in the foreground and another whose task has not started: the press moves the first, then the second", async () => {
    const { reg, driver } = await setup();
    const { chat, c } = await running(reg, driver);
    c.emit(bashCall("toolu_a"), started("a1", "toolu_a"), bashCall("toolu_b"));
    const m2 = send(chat, "now");
    await apply(reg, m2);
    await settle();
    const press = apply(reg, now(chat, m2.uuid));
    await Bun.sleep(20);
    expect(calls(c, "backgroundAll")).toBe(1);
    c.emit(moved("a1", "toolu_a"), result("toolu_a", "Command was manually backgrounded by user with ID: a1."));
    await Bun.sleep(20);
    c.emit(started("b1", "toolu_b"));
    expect(await press).toEqual(acted("background"));
    expect(c.calls.filter((x) => x === "backgroundAll" || x === "interrupt")).toEqual(["backgroundAll", "backgroundAll"]);
  });

  test("a Take back while the press waits: nothing moves, and the turn goes on", async () => {
    const { reg, driver } = await setup();
    const { chat, c } = await running(reg, driver);
    c.emit(bashCall("toolu_b"));
    const m2 = send(chat, "now");
    await apply(reg, m2);
    await settle();
    const press = apply(reg, now(chat, m2.uuid));
    await Bun.sleep(20);
    expect(await apply(reg, { t: "take_back", rid: rid(), chat, uuid: m2.uuid })).toEqual({ ok: true, result: { cancelled: true } });
    c.emit(started("b1", "toolu_b"));
    expect(await press).toEqual(acted("none"));
    expect(c.calls.filter((x) => x === "backgroundAll" || x === "interrupt")).toEqual([]);
  });

  test("the restart's drain starts while the press waits: the turn finishes uncut, and nothing moves", async () => {
    // The task never starts: no stop when the wait ends.
    const { reg, driver } = await setup({ sendNowWaitMs: 200 });
    const { chat, c } = await running(reg, driver);
    c.emit(bashCall("toolu_b"));
    const m2 = send(chat, "now");
    await apply(reg, m2);
    await settle();
    const press = apply(reg, now(chat, m2.uuid));
    await Bun.sleep(20);
    expect(reg.drain("finish")).toEqual({ ok: true });
    expect(await press).toEqual(acted("none"));
    expect(c.calls.filter((x) => x === "backgroundAll" || x === "interrupt")).toEqual([]);

    // The task starts after the drain began: it stays in the foreground.
    const second = await setup({ sendNowWaitMs: 2_000 });
    const r2 = await running(second.reg, second.driver);
    r2.c.emit(bashCall("toolu_b"));
    const n2 = send(r2.chat, "now");
    await apply(second.reg, n2);
    await settle();
    const press2 = apply(second.reg, now(r2.chat, n2.uuid));
    await Bun.sleep(20);
    expect(second.reg.drain("finish")).toEqual({ ok: true });
    await settle();
    r2.c.emit(started("b1", "toolu_b"));
    expect(await press2).toEqual(acted("none"));
    expect(r2.c.calls.filter((x) => x === "backgroundAll" || x === "interrupt")).toEqual([]);
  });

  test("a message that the drain held back goes into Claude Code's queue again at Cancel restart: a press acts for it again", async () => {
    const { reg, driver } = await setup({ sendNowWaitMs: 100 });
    const { chat, c } = await running(reg, driver);
    c.emit(bashCall("toolu_b"));
    const m2 = send(chat, "now");
    await apply(reg, m2);
    await settle();
    const press = apply(reg, now(chat, m2.uuid));
    await Bun.sleep(20);
    expect(reg.drain("finish")).toEqual({ ok: true });
    expect(await press).toEqual(acted("none"));
    expect(reg.undrain()).toBe(true);
    await settle();
    c.emit(started("b1", "toolu_b"));
    await settle();
    expect(await apply(reg, now(chat, m2.uuid))).toEqual(acted("background"));
    expect(calls(c, "backgroundAll")).toBe(1);
  });

  test("two presses at once, from two devices, act once", async () => {
    const { reg, driver } = await setup();
    const { chat, c } = await running(reg, driver);
    c.emit(bashCall("toolu_b"));
    const m2 = send(chat, "now");
    await apply(reg, m2);
    await settle();
    const a = apply(reg, now(chat, m2.uuid), { tab: "tab_a" });
    const b = apply(reg, now(chat, m2.uuid), { tab: "tab_b" });
    await Bun.sleep(20);
    c.emit(started("b1", "toolu_b"));
    const answers = (await Promise.all([a, b])).map((o) => (o.ok ? (o.result as { acted: string }).acted : o.code)).sort();
    expect(answers).toEqual(["background", "none"]);
    expect(calls(c, "backgroundAll")).toBe(1);
  });
});

describe("Send now while Claude writes", () => {
  test("a plain interrupt that keeps the queue: Stop's end on every page, then the message runs next", async () => {
    const { reg, driver, store } = await setup();
    const { chat, c, v, first } = await running(reg, driver);
    c.emit({ k: "block_start", key: "msg_1:0", kind: "text", parent: null }, { k: "block_delta", key: "msg_1:0", text: "Once upon" });
    const m2 = send(chat, "stop the story");
    await apply(reg, m2);
    await settle();
    c.interruptResult = { stillQueued: [m2.uuid] };
    expect(await apply(reg, now(chat, m2.uuid))).toEqual(acted("interrupt"));
    expect(c.calls.filter((x) => x === "backgroundAll" || x === "interrupt")).toEqual(["interrupt"]);
    // Stop on the same turn is stale now; a second press does nothing.
    const turn = (await reg.attach(chat, new RecordingViewer("tab_b")))!.tail.find((i) => i.e.k === "turn_start")!.seq;
    expect(await apply(reg, { t: "interrupt", rid: rid(), chat, turn })).toEqual({ ok: false, code: "stale" });
    expect(await apply(reg, now(chat, m2.uuid))).toEqual(acted("none"));
    c.emit(turnEnd([first], false));
    await settle();
    expect(v.of("turn_end").at(-1)).toMatchObject({ ok: false, subtype: TURN_INTERRUPTED, error: null });
    // Still Queued, and still in the queue file, until its own turn starts.
    expect(marks(v)).toEqual([[m2.uuid, true]]);
    expect(queuedFile(store, chat)).toEqual([m2.uuid]);
    c.emit({ k: "turn_start", by: "user" }, { k: "taken_in", uuids: [m2.uuid] }, block("msg_3:0"));
    await settle();
    expect(marks(v)).toEqual([[m2.uuid, true], [m2.uuid, false]]);
  });

  test("a `!` command that waits ahead of the message: the turn stops even while a Bash call runs in the foreground", async () => {
    const { reg, driver } = await setup();
    const { chat, c, v } = await running(reg, driver);
    c.emit(bashCall("toolu_b"), started("b1", "toolu_b"));
    expect(await apply(reg, { t: "bash", rid: rid(), chat, input: "git status", draftRev: null, uploads: [] })).toEqual({ ok: true, result: null });
    const m2 = send(chat, "after the command");
    await apply(reg, m2);
    await settle();
    expect(marks(v)).toEqual([[m2.uuid, true]]);
    expect(await apply(reg, now(chat, m2.uuid))).toEqual(acted("interrupt"));
    expect(calls(c, "backgroundAll")).toBe(0);
  });
});

describe("a press that does nothing", () => {
  test("nothing queued, a message that is not queued, an idle chat, a chat that gives its session up", async () => {
    const { reg, driver } = await setup();
    const { chat, c, first } = await running(reg, driver);
    // The message that started the turn waits for nothing.
    expect(await apply(reg, now(chat, first))).toEqual(acted("none"));
    expect(await apply(reg, now(chat, rid()))).toEqual(acted("none"));
    const m2 = send(chat, "queued");
    await apply(reg, m2);
    c.emit(turnEnd([first]));
    await settle();
    // Between the turns: Claude Code starts it next by itself.
    expect(await apply(reg, now(chat, m2.uuid))).toEqual(acted("none"));
    expect(c.calls.filter((x) => x === "backgroundAll" || x === "interrupt")).toEqual([]);
    expect(await apply(reg, now("zzzzzzzzzzzzzzzzzzzz", m2.uuid))).toEqual({ ok: false, code: "not_found" });
  });

  test("while the restart's drain waits, the chat's turn finishes uncut", async () => {
    const { reg, driver } = await setup();
    const { chat, c } = await running(reg, driver);
    const m2 = send(chat, "queued");
    await apply(reg, m2);
    await settle();
    expect(reg.drain("finish")).toEqual({ ok: true });
    expect(await apply(reg, now(chat, m2.uuid))).toEqual(acted("none"));
    expect(c.calls.filter((x) => x === "backgroundAll" || x === "interrupt")).toEqual([]);
  });
});

describe("the queued state (FIX-W28 section 2, last rule)", () => {
  test("the reply's answering uuids take a queued message in at once, before the turn's end", async () => {
    const { reg, driver, store } = await setup();
    const { chat, c, v, first } = await running(reg, driver);
    const m2 = send(chat, "queued");
    await apply(reg, m2);
    c.emit(turnEnd([first]), { k: "turn_start", by: "agent" }, { k: "taken_in", uuids: [m2.uuid] });
    await settle();
    expect(marks(v)).toEqual([[m2.uuid, true], [m2.uuid, false]]);
    // taken_in never reaches a page.
    expect(v.events.some((e) => e.k === "taken_in")).toBe(false);
    c.emit(turnEnd([m2.uuid]));
    await settle();
    expect(queuedFile(store, chat)).toEqual([]);
  });

  test("taken in at a tool boundary: plain at the next reply frame, and only what waited at the tool result", async () => {
    const { reg, driver, store } = await setup();
    const { chat, c, v, first } = await running(reg, driver);
    c.emit({ k: "tool_call", id: "toolu_r", name: "Read", input: { file_path: "a" }, parent: null });
    const m2 = send(chat, "before the result");
    await apply(reg, m2);
    await settle();
    c.emit(result("toolu_r"));
    await settle();
    const m3 = send(chat, "after the result");
    await apply(reg, m3);
    await settle();
    // A subagent's own frames are no reply of the main thread.
    c.emit({ k: "block", key: "msg_s:0", kind: "text", text: "inner", parent: "toolu_x" });
    await settle();
    expect(marks(v)).toEqual([[m2.uuid, true], [m3.uuid, true]]);
    c.emit(block("msg_2:0"));
    await settle();
    expect(marks(v)).toEqual([[m2.uuid, true], [m3.uuid, true], [m2.uuid, false]]);
    // Send now still acts for the one that waits.
    expect(await apply(reg, now(chat, m3.uuid))).toEqual(acted("interrupt"));
    expect(queuedFile(store, chat)).toEqual([first, m2.uuid, m3.uuid]);
    c.emit(turnEnd([first, m2.uuid], false));
    await settle();
    expect(queuedFile(store, chat)).toEqual([m3.uuid]);
    expect(marks(v)).toHaveLength(3);
  });

  test("a turn's end that does not list a message drawn as taken in: Queued again, and it runs next", async () => {
    const { reg, driver, store } = await setup();
    const { chat, c, v, first } = await running(reg, driver);
    c.emit({ k: "tool_call", id: "toolu_r", name: "Read", input: {}, parent: null });
    const m2 = send(chat, "queued");
    await apply(reg, m2);
    await settle();
    c.emit(result("toolu_r"), block("msg_2:0"));
    await settle();
    expect(marks(v).at(-1)).toEqual([m2.uuid, false]);
    c.emit(turnEnd([first]));
    await settle();
    expect(marks(v)).toEqual([[m2.uuid, true], [m2.uuid, false], [m2.uuid, true]]);
    expect(queuedFile(store, chat)).toEqual([m2.uuid]);
    c.emit({ k: "turn_start", by: "user" }, block("msg_3:0"), turnEnd([m2.uuid]));
    await settle();
    expect(marks(v).at(-1)).toEqual([m2.uuid, false]);
    expect(queuedFile(store, chat)).toEqual([]);
  });

  test("a turn that Claude Code starts by itself (a task's notification) while a message waits: on a CLI that stamps, it stays queued", async () => {
    const { reg, driver, store } = await setup();
    const { chat, c, v, first } = await running(reg, driver);
    // This CLI stamps its turns: the first reply frame names the message that it answers.
    c.emit({ k: "taken_in", uuids: [first] }, block("msg_1:0"));
    const m4 = send(chat, "queued during the turn");
    await apply(reg, m4);
    await settle();
    c.emit(turnEnd([first]));
    await settle();
    // The notification's turn: the CLI counts a message as waiting, and no stamp names it.
    c.emit({ k: "turn_start", by: "user" }, block("msg_n:0", "The background task finished."));
    await settle();
    expect(marks(v)).toEqual([[m4.uuid, true]]);
    // Send now acts for it (Claude writes: the turn stops, and it runs next); the queue file keeps it.
    expect(await apply(reg, now(chat, m4.uuid))).toEqual(acted("interrupt"));
    c.emit(turnEnd([], false));
    await settle();
    expect(queuedFile(store, chat)).toEqual([m4.uuid]);
    // Its own turn's stamp takes it in.
    c.emit({ k: "turn_start", by: "user" }, { k: "taken_in", uuids: [m4.uuid] }, block("msg_3:0"), turnEnd([m4.uuid]));
    await settle();
    expect(marks(v)).toEqual([[m4.uuid, true], [m4.uuid, false]]);
    expect(queuedFile(store, chat)).toEqual([]);
  });

  test("with no list from Claude Code, a message drawn as taken in went with the turn", async () => {
    const { reg, driver, store } = await setup();
    const { chat, c, v } = await running(reg, driver);
    c.emit({ k: "tool_call", id: "toolu_r", name: "Read", input: {}, parent: null });
    const m2 = send(chat, "queued");
    await apply(reg, m2);
    await settle();
    c.emit(result("toolu_r"), block("msg_2:0"), turnEnd([]));
    await settle();
    expect(marks(v)).toEqual([[m2.uuid, true], [m2.uuid, false]]);
    expect(queuedFile(store, chat)).toEqual([]);
  });
});

describe("the rules alone (send-now.ts)", () => {
  const chatOf = (watch: SendNowWatch, over: Partial<Parameters<typeof sendNowAct>[0]> = {}) => {
    const done: string[] = [];
    return {
      done,
      chat: {
        watch,
        behindCommand: false,
        canBackground: true,
        cardFor: () => false,
        stillWaiting: () => true,
        background: async () => (done.push("background"), true),
        interrupt: async () => (done.push("interrupt"), true),
        waitMs: 50,
        ...over,
      },
    };
  };

  test("a task's move to the background or its end leaves no foreground task; a turn's end clears the watch", () => {
    const w = new SendNowWatch();
    w.note(bashCall("toolu_b"), () => []);
    expect(w.starting()).toEqual(["toolu_b"]);
    w.note(started("b1", "toolu_b"), () => []);
    expect([w.foreground, w.starting()]).toEqual([true, []]);
    w.note(moved("b1", "toolu_b"), () => []);
    expect(w.foreground).toBe(false);
    w.note(bashCall("toolu_c"), () => []);
    w.note(started("c1", "toolu_c"), () => []);
    w.note({ k: "task", ev: "done", taskId: "c1", toolUseId: "toolu_c", status: "completed", summary: null, usage: null }, () => []);
    expect(w.foreground).toBe(false);
    w.note(bashCall("toolu_d"), () => []);
    w.note({ k: "tool_call", id: "toolu_e", name: "Read", input: {}, parent: null }, () => []);
    w.note({ k: "tool_call", id: "toolu_f", name: "Bash", input: {}, parent: "toolu_agent" }, () => []);
    expect(w.starting()).toEqual(["toolu_d"]);
    w.note(turnEnd([]), () => []);
    expect([w.foreground, w.starting()]).toEqual([false, []]);
  });

  test("a task that another tool's call started, or a task of another kind, is not moved", async () => {
    const w = new SendNowWatch();
    w.note({ k: "tool_call", id: "toolu_w", name: "Workflow", input: {}, parent: null }, () => []);
    w.note(started("w1", "toolu_w", "local_workflow"), () => []);
    const { chat, done } = chatOf(w);
    expect(await sendNowAct(chat)).toBe("interrupt");
    expect(done).toEqual(["interrupt"]);
  });

  test("a wait ends when the call's task starts in the background (its call returns: nothing more) or as a kind that cannot move (a stop)", async () => {
    for (const [background, taskType, want] of [
      [true, "local_bash", "none"],
      [false, "local_workflow", "interrupt"],
    ] as const) {
      const w = new SendNowWatch();
      w.note(bashCall("toolu_b"), () => []);
      const { chat, done } = chatOf(w, { waitMs: 5_000 });
      const t0 = performance.now();
      const act = sendNowAct(chat);
      w.note(started("b1", "toolu_b", taskType, background), () => []);
      expect(await act).toBe(want);
      expect(performance.now() - t0).toBeLessThan(1_000);
      expect(done).toEqual(want === "none" ? [] : ["interrupt"]);
    }
  });

  test("messages that went in meanwhile need no stop", async () => {
    const { chat, done } = chatOf(new SendNowWatch(), { stillWaiting: () => false });
    expect(await sendNowAct(chat)).toBe("none");
    expect(done).toEqual([]);
  });
});
