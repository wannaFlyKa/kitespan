// U2 review (D49, DESIGN 4.4 and 6.3 The turn fold): one chat on every device. The page that watched the turns live
// and a page that comes later (a reload, the phone, a reconnect's snapshot, every page after a restart) group the rows
// into the same turns, with the same lines, tags and shown rows: the registry notes each turn at its end, and history
// gives every page each turn's start and end (server/chats/turns.ts). A page that attaches while a turn runs keeps the
// message read inside it in it, and an agent's own turn apart from the turn before it. The scripted driver stands in
// for Claude Code; its transcript is the events history reads.
import { describe, expect, test } from "bun:test";
import { ChatRegistry } from "../../server/chats/registry";
import { FakeBash, FakeDriver, MemoryStore, RecordingViewer, apply, projectRecord, settle, type FakeChat } from "../../server/chats/testing";
import type { RegistryOptions, RingItem } from "../../server/chats/types";
import type { ChatEvent, SendFrame } from "../../shared/protocol";
import { cardCalls } from "../../web/chat/fold";
import { drawnParts, turnLayout, turnList, turnsOf, type Turn } from "../../web/chat/turns";
import { applyEvent, applyHistory, type ChatPart } from "../../web/state/reduce";

const PROJECT = "k3m7q2x4ab";
const rid = () => crypto.randomUUID();
const OPTS: RegistryOptions = { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500 };

async function setup() {
  const driver = new FakeDriver();
  const store = new MemoryStore();
  store.projects = [projectRecord(PROJECT)];
  const reg = new ChatRegistry({ driver, store, bash: new FakeBash() }, OPTS);
  await reg.boot();
  return { driver, store, reg };
}

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

/** The page that watched it: its attach (the snapshot and its tail), then every event as it came. */
const watched = (at: Attached, items: readonly RingItem[]): ChatPart => items.reduce((c, it) => applyEvent(c, it.e, { seq: it.seq, replay: false, cwd: null, now: 1_000_000 }), later(at, false));
type Attached = { snapshot: { history: ChatEvent[] }; tail: RingItem[] };
/** A page that comes later: the snapshot's history, then its tail. */
function later(p: Attached, ended: boolean): ChatPart {
  const drawn = applyHistory(blank(), p.snapshot.history, { cwd: null, now: 1_000_000, ended });
  return p.tail.reduce((c, it) => applyEvent(c, it.e, { seq: it.seq, replay: true, tail: true, cwd: null, now: 1_000_000 }), drawn);
}

const turnsIn = (c: ChatPart, running = false): Turn[] => turnList(turnsOf(c.items, c.marks ?? [], { running, waiting: false, partial: false }));
/** Each turn as the folded transcript reads: its id, its line and tag (or none), and the rows that show. */
function read(c: ChatPart, running = false): string[] {
  return turnsIn(c, running).map((t) => {
    const l = turnLayout(t, "normal", undefined, cardCalls(c.items, c.pending));
    const shown = drawnParts(l, false)
      .filter((p) => !l.folds || p.role !== "work")
      .flatMap((p) => p.entries.map((e) => (e.type === "summary" ? e.id : e.item.id)));
    return `${t.id} ${t.state}: ${l.folds ? `${l.label}${l.tag ? ` [${l.tag}]` : ""}` : "no line"} | ${shown.join(" ")}`;
  });
}

const send = (chat: string, text: string): SendFrame => {
  const r = rid();
  return { t: "send", rid: r, chat, uuid: r, text, draftRev: null, uploads: [] };
};
const text = (key: string, t: string): ChatEvent => ({ k: "block", key, kind: "text", text: t, parent: null });
const call = (id: string, name = "Read", input: Record<string, unknown> = { file_path: `/srv/work/app/${id}.ts` }): ChatEvent => ({ k: "tool_call", id, name, input, parent: null });
const result = (id: string): ChatEvent => ({ k: "tool_result", id, text: "ok", isError: false, parent: null, report: null });
const user = (uuid: string, t: string): ChatEvent => ({ k: "user", uuid, text: t, queued: false });

async function chatWith(reg: ChatRegistry, driver: FakeDriver, first: string): Promise<{ chat: string; c: FakeChat; sid: string; m1: string; v: RecordingViewer; at: Attached }> {
  const m1 = rid();
  const o = await apply(reg, { t: "new_chat", rid: rid(), project: PROJECT, uuid: m1, text: first, picks: { model: null, effort: null, mode: null }, uploads: [] });
  if (!o.ok) throw new Error(`new_chat refused: ${o.code}`);
  const chat = (o.result as { chat: string }).chat;
  const c = driver.last;
  const sid = c.input.sessionId!.value;
  const v = new RecordingViewer();
  const at = (await reg.attach(chat, v))!;
  c.emit({ k: "session", sessionId: sid, model: "claude-haiku-5-5", mode: "default", version: "2.1.311", bypass: false });
  await settle();
  return { chat, c, sid, m1, v, at };
}

describe("the same turns live and from history (D49)", () => {
  test("a message read inside a turn, a failed turn and an agent's own turn read the same on the page that watched and on a page that comes later", async () => {
    const { reg, driver, store } = await setup();
    const { chat, c, sid, m1, v, at } = await chatWith(reg, driver, "Run the long command.");
    // Turn 1: a message sent while it runs, read at the tool boundary.
    c.emit(text("msg_a:0", "Running the long command now."), call("b1", "Bash", { command: "sleep 30" }));
    await settle();
    const m2 = send(chat, "Also check the phone size.");
    await apply(reg, m2);
    c.emit(result("b1"), { k: "taken_in", uuids: [m2.uuid] }, text("msg_b:0", "I read your new message."), call("r1"), result("r1"), text("msg_z:0", "Both done."));
    c.emit({ k: "turn_end", ok: true, subtype: "success", durationMs: 74_000, error: null, uuids: [m1, m2.uuid] });
    await settle();
    // Turn 2: it fails.
    const m3 = send(chat, "Edit the parser and run the tests.");
    await apply(reg, m3);
    c.emit(call("r5"), result("r5"), text("msg_c:0", "Editing."), call("e1", "Edit", { file_path: "/srv/work/app/a.ts", old_string: "a", new_string: "b" }), result("e1"), call("b2", "Bash", { command: "bun test" }));
    c.emit({ k: "turn_end", ok: false, subtype: "error_during_execution", durationMs: 12_000, error: "Claude Code could not reach the API.", uuids: [m3.uuid] });
    await settle();
    // Turn 3: Claude Code's own (a background task's notification).
    c.emit(text("msg_n:0", "The background tests finished."), call("r9"), result("r9"), text("msg_n2:0", "All 21 pass."));
    c.emit({ k: "turn_end", ok: true, subtype: "success", durationMs: 9_000, error: null, uuids: [] });
    await settle();

    // What the transcript holds (events.ts historyEvents): no turn marks, the queued message where Claude read it.
    driver.transcript(sid);
    driver.histories.set(sid, [
      user(m1, "Run the long command."),
      text("msg_a:0", "Running the long command now."),
      call("b1", "Bash", { command: "sleep 30" }),
      result("b1"),
      user(m2.uuid, "Also check the phone size."),
      text("msg_b:0", "I read your new message."),
      call("r1"),
      result("r1"),
      text("msg_z:0", "Both done."),
      user(m3.uuid, "Edit the parser and run the tests."),
      call("r5"),
      result("r5"),
      text("msg_c:0", "Editing."),
      call("e1", "Edit", { file_path: "/srv/work/app/a.ts", old_string: "a", new_string: "b" }),
      result("e1"),
      call("b2", "Bash", { command: "bun test" }),
      text("msg_n:0", "The background tests finished."),
      call("r9"),
      result("r9"),
      text("msg_n2:0", "All 21 pass."),
    ]);
    await settle(20);

    const live = read(watched(at, v.items));
    expect(live).toEqual([
      `${m1} ok: Worked for 1m 14s, ran 1 command, read 1 file | ${m1} ${m2.uuid} msg_z-0`,
      `${m3.uuid} failed: Worked for 12s, read 1 file, edited 1 file, ran 1 command [Failed] | ${m3.uuid} msg_c-0 error-${v.items.find((i) => i.e.k === "turn_end" && !i.e.ok)!.seq}`,
      `msg_n-0 ok: Worked for 9s, read 1 file | msg_n2-0`,
    ]);
    const p = await reg.attach(chat, new RecordingViewer("tab_b"));
    const fresh = later(p!, true);
    // The same lines, tags and shown rows; the failed turn's error row has a history id of its own.
    expect(read(fresh).map((l) => l.replace(/error-\S+/, "error"))).toEqual(live.map((l) => l.replace(/error-\S+/, "error")));
    expect(turnsIn(fresh).map((t) => t.id)).toEqual(turnsIn(watched(at, v.items)).map((t) => t.id));

    // After a restart, every page reads them so from the notes.
    await reg.shutdown();
    const next = new ChatRegistry({ driver, store, bash: new FakeBash() }, OPTS);
    await next.boot();
    const q = await next.attach(chat, new RecordingViewer("tab_c"));
    expect(read(later(q!, true)).map((l) => l.replace(/error-\S+/, "error"))).toEqual(live.map((l) => l.replace(/error-\S+/, "error")));
    await next.shutdown();
  });

  test("a page that attaches while a turn runs that read a queued message: one running turn, nothing folded", async () => {
    const { reg, driver } = await setup();
    const { chat, c, sid, m1 } = await chatWith(reg, driver, "Run the long command.");
    c.emit(text("msg_a:0", "Running the long command."), call("b1", "Bash", { command: "sleep 30" }));
    await settle();
    const m2 = send(chat, "Also check the phone size.");
    await apply(reg, m2);
    c.emit(result("b1"), { k: "taken_in", uuids: [m2.uuid] }, text("msg_b:0", "I read your new message."), call("r1"));
    await settle();
    driver.transcript(sid);
    driver.histories.set(sid, [user(m1, "Run the long command."), text("msg_a:0", "Running the long command."), call("b1", "Bash", { command: "sleep 30" }), result("b1"), user(m2.uuid, "Also check the phone size."), text("msg_b:0", "I read your new message."), call("r1")]);
    const p = await reg.attach(chat, new RecordingViewer("tab_b"));
    expect(p!.snapshot.history[0]).toEqual({ k: "turn_start", by: "user" });
    const page = later(p!, false);
    const all = turnsIn(page, true);
    expect(all.map((t) => `${t.id} ${t.state}`)).toEqual([`${m1} running`]);
    expect(all[0]!.rows.map((r) => r.id)).toEqual([m1, "msg_a-0", "b1", m2.uuid, "msg_b-0", "r1"]);
    expect(turnLayout(all[0]!, "normal", undefined, cardCalls(page.items, page.pending)).folds).toBe(false);
    await reg.shutdown();
  });

  test("a turn that ends while the history is read is one turn on that page: history marks its start, the tail its end", async () => {
    const { reg, driver } = await setup();
    const { chat, c, sid, m1 } = await chatWith(reg, driver, "Read it.");
    c.emit(text("msg_a:0", "Reading."), call("r1"));
    await settle();
    driver.transcript(sid);
    const original = driver.history.bind(driver);
    driver.history = async (s, cwd, page) => {
      // The transcript is read while the call runs; the turn ends before the read is decorated.
      c.emit(result("r1"), call("r2"), result("r2"), text("msg_z:0", "Read both."), { k: "turn_end", ok: true, subtype: "success", durationMs: 3_000, error: null, uuids: [m1] });
      await settle();
      return original(s, cwd, page);
    };
    driver.histories.set(sid, [user(m1, "Read it."), text("msg_a:0", "Reading."), call("r1")]);
    const p = await reg.attach(chat, new RecordingViewer("tab_b"));
    expect(p!.snapshot.history.map((e) => e.k)).toEqual(["turn_start", "user", "block", "tool_call"]);
    expect(read(later(p!, true))).toEqual([`${m1} ok: Worked for 3s, read 2 files | ${m1} msg_z-0`]);
    await reg.shutdown();
  });

  test("a turn whose Claude Code exits by itself is Failed on every page; one that a shutdown closes is not noted at all", async () => {
    const { reg, driver, store } = await setup();
    const { chat, c, sid, m1 } = await chatWith(reg, driver, "Run the tests.");
    c.emit(call("r1"), result("r1"), text("msg_a:0", "Running them."), call("b1", "Bash", { command: "bun test" }));
    await settle();
    c.end({ code: 1, signal: null });
    await settle();
    driver.transcript(sid);
    driver.histories.set(sid, [user(m1, "Run the tests."), call("r1"), result("r1"), text("msg_a:0", "Running them."), call("b1", "Bash", { command: "bun test" })]);
    // This server life: the snapshot's tail still holds the exit (no turn ended since), so the turn comes from it.
    const failed = `${m1} failed: Read 1 file, ran 1 command [Failed] | ${m1} msg_a-0`;
    const now = read(later((await reg.attach(chat, new RecordingViewer("tab_b")))!, true));
    expect(now).toHaveLength(1);
    expect(now[0]!.startsWith(`${failed} exit-`)).toBe(true);
    // A second chat whose turn runs when the server shuts down: kitespan closed it, so no end is noted.
    const second = await chatWith(reg, driver, "Run the long one.");
    second.c.emit(text("msg_b:0", "Running it."), call("b2", "Bash", { command: "sleep 30" }));
    await settle();
    await reg.shutdown();
    expect((await store.readNotes(second.chat)).turns ?? []).toEqual([]);
    // The next server life draws the exit's turn from the notes alone (the exit's own line is in no transcript).
    const next = new ChatRegistry({ driver, store, bash: new FakeBash() }, OPTS);
    await next.boot();
    const q = (await next.attach(chat, new RecordingViewer("tab_c")))!;
    expect(q.snapshot.history.filter((e) => e.k === "turn_end")).toEqual([{ k: "turn_end", ok: false, subtype: "exit", durationMs: 0, error: null, uuids: [] }]);
    expect(read(later(q, true))).toEqual([failed]);
    await next.shutdown();
  });

  test("a page that attaches during an agent's own turn: the turn before it keeps its own answer", async () => {
    const { reg, driver } = await setup();
    const { chat, c, sid, m1 } = await chatWith(reg, driver, "Start the tests in the background.");
    c.emit(call("r1"), result("r1"), call("r2"), result("r2"), text("msg_a:0", "Started the tests in the background."));
    c.emit({ k: "turn_end", ok: true, subtype: "success", durationMs: 4_000, error: null, uuids: [m1] });
    await settle();
    c.emit(call("x1"), result("x1"));
    await settle();
    driver.transcript(sid);
    driver.histories.set(sid, [user(m1, "Start the tests in the background."), call("r1"), result("r1"), call("r2"), result("r2"), text("msg_a:0", "Started the tests in the background."), call("x1"), result("x1")]);
    const p = await reg.attach(chat, new RecordingViewer("tab_b"));
    const page = later(p!, false);
    expect(read(page, true)).toEqual([`${m1} ok: no line | ${m1} sum-r1 msg_a-0`, "x1 running: no line | sum-x1"]);
    await reg.shutdown();
  });
});
