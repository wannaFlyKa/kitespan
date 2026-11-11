// The chat registry's life cycle (DESIGN.md 4.1; BUILD-BRIEF section 2): the states table, D2's idle timer, D3's cap
// with the least-recently-used rule and its first-in, first-out queue, cards in memory, viewers (D49: one process per
// chat however many pages), the boot rebuild with every chat asleep, and the sessionId rule (kitespan's own id on the
// first start, `resume` once the transcript exists). The scripted driver and the in-memory store stand in for the SDK
// and the disk.
import { describe, expect, test } from "bun:test";
import { isUuid } from "../../shared/ids";
import type { ChatDelta, ChatEvent, NewChatFrame, PermissionCard, QuestionCard, SendFrame } from "../../shared/protocol";
import { MARK_RE } from "../../server/agents/types";
import { CAP_NOTICE, ChatRegistry } from "../../server/chats/registry";
import { FakeBash, FakeDriver, MemoryStore, RecordingViewer, apply, autoReply, projectRecord, settle } from "../../server/chats/testing";
import type { RegistryOptions } from "../../server/chats/types";
import type { ChatLedger } from "../../server/store/types";

const PROJECT = "k3m7q2x4ab";
const CHAT = "k3m7q2x4abk3m7q2x4ab";
const rid = () => crypto.randomUUID();

async function setup(opts: RegistryOptions = {}, prep?: (d: FakeDriver, s: MemoryStore) => void) {
  const driver = new FakeDriver();
  const store = new MemoryStore();
  const bash = new FakeBash();
  store.projects = [projectRecord(PROJECT)];
  prep?.(driver, store);
  const reg = new ChatRegistry({ driver, store, bash }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500, ...opts });
  await reg.boot();
  const deltas: ChatDelta[] = [];
  reg.subscribe((d) => deltas.push(d));
  return { driver, store, reg, deltas, bash };
}

function newChatFrame(text: string, over: Partial<NewChatFrame> = {}): NewChatFrame {
  return { t: "new_chat", rid: rid(), project: PROJECT, uuid: rid(), text, picks: { model: null, effort: null, mode: null }, uploads: [], ...over };
}

async function newChat(reg: ChatRegistry, text = "Plan the upload feature", over: Partial<NewChatFrame> = {}): Promise<string> {
  const o = await apply(reg, newChatFrame(text, over));
  if (!o.ok) throw new Error(`new_chat refused: ${o.code}`);
  return (o.result as { chat: string }).chat;
}

function send(chat: string, text: string, over: Partial<SendFrame> = {}): SendFrame {
  const r = rid();
  return { t: "send", rid: r, chat, uuid: r, text, draftRev: null, uploads: [], ...over };
}

function ledger(over: Partial<ChatLedger>): ChatLedger {
  return {
    v: 1,
    id: CHAT,
    project: PROJECT,
    cwd: "/srv/work/app",
    agent: "claude-code",
    sessionId: null,
    title: { text: "Old chat", from: "first-prompt" },
    picks: { model: null, effort: null, permissionMode: null },
    createdAt: "2026-10-30T08:00:00.000Z",
    seenAt: "2026-10-30T08:00:00.000Z",
    lastActivityAt: "2026-10-30T08:00:00.000Z",
    lastSeq: 0,
    state: "sleeping",
    lastExit: null,
    archivedAt: null,
    ...over,
  };
}

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
  input: { command: "ls" },
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  sessionRule: true,
  parent: null,
  ...over,
});

const turnEnd = (uuids: string[] = []): ChatEvent => ({ k: "turn_end", ok: true, subtype: "success", durationMs: 3, error: null, uuids });
const sessionEv = (sessionId: string): ChatEvent => ({ k: "session", sessionId, model: "claude-haiku-5-5", mode: "default", version: "2.1.311", bypass: false });

describe("boot", () => {
  test("every chat is rebuilt asleep, seq goes on from lastSeq, and the session index holds", async () => {
    const sid = rid();
    const { reg, driver } = await setup({}, (d, s) => {
      s.chats.set(CHAT, ledger({ state: "running", lastSeq: 41, sessionId: sid }));
      d.transcript(sid);
    });
    expect(reg.list().map((r) => [r.chat, r.state, r.title])).toEqual([[CHAT, "sleeping", "Old chat"]]);
    expect(reg.chatForSession(sid)).toBe(CHAT);
    expect(reg.claudeStatus).toEqual({ ok: true, version: "2.1.311", drift: null });
    expect(await apply(reg, { t: "continue_session", rid: rid(), project: PROJECT, session: sid })).toEqual({ ok: true, result: { chat: CHAT } });
    const v = new RecordingViewer();
    await reg.attach(CHAT, v);
    expect(driver.opens.length).toBe(0); // opening a chat starts nothing
    await apply(reg, send(CHAT, "go on"));
    // 42 is D32's line: the ledger said `running`, and the transcript holds no reply that ends the turn (chats-stop).
    expect(v.items[0]!.seq).toBe(43);
    expect(driver.opens.length).toBe(1);
    expect(driver.last.input.resume?.value).toBe(sid);
    expect(MARK_RE.exec(driver.last.input.resume!.mark)?.[1]).toBe("the user opened this past chat");
    expect(driver.last.input.sessionId).toBeNull();
  });

  test("a chat whose ledger has no title takes its session's custom title (a /rename lands in the transcript) as a rename, and keeps it", async () => {
    const sid = rid();
    const other = "abcdefghijklmnopqrst";
    const { reg, store } = await setup({}, (d, s) => {
      s.chats.set(CHAT, ledger({ sessionId: sid, title: null }));
      // No transcript, or no session yet: nothing to read, so the title stays empty.
      s.chats.set(other, ledger({ id: other, sessionId: null, title: null }));
      d.transcript(sid, "/rename Probe title 42", "/srv/work/app", "Probe title 42");
    });
    const titles = Object.fromEntries(reg.list().map((r) => [r.chat, r.title]));
    expect(titles).toEqual({ [CHAT]: "Probe title 42", [other]: null });
    expect(store.chats.get(CHAT)!.title).toEqual({ text: "Probe title 42", from: "renamed" });
    const p = await reg.attach(CHAT, new RecordingViewer());
    expect(p!.attached.title).toEqual({ text: "Probe title 42", from: "renamed" });
  });

  test("a session with no custom title gives its first prompt as a first-prompt title, never as a rename", async () => {
    const sid = rid();
    const { reg, store } = await setup({}, (d, s) => {
      s.chats.set(CHAT, ledger({ sessionId: sid, title: null }));
      d.transcript(sid, `Explain the upload retry ${"x".repeat(100)}`);
    });
    const t = store.chats.get(CHAT)!.title!;
    expect(t.from).toBe("first-prompt");
    expect(t.text).toBe(`Explain the upload retry ${"x".repeat(100)}`.slice(0, 80));
    expect(reg.list()[0]!.title).toBe(t.text);
  });

  test("a boot first-prompt title gives way to the agent's own title after the next reply (D13)", async () => {
    const sid = rid();
    const { reg, store, driver } = await setup({}, (d, s) => {
      s.chats.set(CHAT, ledger({ sessionId: sid, title: null }));
      d.transcript(sid, "Explain the upload retry");
    });
    autoReply(driver);
    await apply(reg, send(CHAT, "and the tests"));
    driver.last.title = "Upload retry tests";
    await settle(10);
    expect(store.chats.get(CHAT)!.title).toEqual({ text: "Upload retry tests", from: "generated" });
  });

  test("a ledger's own title wins over the session's", async () => {
    const sid = rid();
    const { reg } = await setup({}, (d, s) => {
      s.chats.set(CHAT, ledger({ sessionId: sid, title: { text: "Mine", from: "renamed" } }));
      d.transcript(sid, "Older name");
    });
    expect(reg.list()[0]!.title).toBe("Mine");
  });
});

describe("the session id (D41, live L1)", () => {
  test("the first start passes kitespan's own id; once the transcript exists, the next start resumes it", async () => {
    const { reg, driver, store } = await setup();
    autoReply(driver);
    const chat = await newChat(reg);
    const first = driver.last;
    expect(first.input.resume).toBeNull();
    expect(MARK_RE.exec(first.input.sessionId!.mark)?.[1]).toBe("the user started this new chat");
    const sid = first.input.sessionId!.value;
    expect(isUuid(sid)).toBe(true);
    expect(store.chats.get(chat)!.sessionId).toBe(sid);
    expect(reg.chatForSession(sid)).toBe(chat);
    await settle();
    first.end();
    await settle();
    expect(reg.stateOf(chat)).toBe("sleeping");
    await apply(reg, send(chat, "and again"));
    expect(driver.opens.length).toBe(2);
    expect(driver.last.input.resume?.value).toBe(sid);
    expect(driver.last.input.sessionId).toBeNull();
  });

  test("a restart before any transcript exists passes the same id again, never resume", async () => {
    const { reg, driver } = await setup();
    const chat = await newChat(reg);
    const sid = driver.last.input.sessionId!.value;
    driver.last.end();
    await settle();
    await apply(reg, send(chat, "hello again"));
    expect(driver.last.input.sessionId?.value).toBe(sid);
    expect(driver.last.input.resume).toBeNull();
  });

  test("a transcript that the session info does not find (no summary to read) still resumes when its history has messages", async () => {
    const { reg, driver } = await setup();
    const chat = await newChat(reg);
    const sid = driver.last.input.sessionId!.value;
    driver.last.end();
    await settle();
    // getSessionInfo answers undefined for a transcript with no extractable summary; the messages are there.
    driver.histories.set(sid, [{ k: "user", uuid: rid(), text: "x".repeat(70_000), queued: false }]);
    await apply(reg, send(chat, "go on"));
    expect(driver.opens.length).toBe(2);
    expect(driver.last.input.resume?.value).toBe(sid);
    expect(driver.last.input.sessionId).toBeNull();
  });

  test("once a turn ended in the session, the next start resumes, whatever the session info says", async () => {
    const { reg, driver } = await setup();
    const chat = await newChat(reg);
    const sid = driver.last.input.sessionId!.value;
    driver.last.emit(sessionEv(sid), turnEnd());
    await settle();
    driver.last.end();
    await settle();
    await apply(reg, send(chat, "go on"));
    expect(driver.last.input.resume?.value).toBe(sid);
    expect(driver.last.input.sessionId).toBeNull();
  });

  test("a start that Claude Code refuses because the session id is in use resumes next time", async () => {
    const { reg, driver } = await setup();
    const chat = await newChat(reg);
    const sid = driver.last.input.sessionId!.value;
    driver.last.end(null);
    await settle();
    await apply(reg, send(chat, "again"));
    expect(driver.last.input.sessionId?.value).toBe(sid);
    driver.last.emit({ k: "exit", code: 1, signal: null, stderr: [`Error: Session ID ${sid} is already in use.`] });
    driver.last.end(null);
    await settle();
    await apply(reg, send(chat, "and again"));
    expect(driver.opens.length).toBe(3);
    expect(driver.last.input.resume?.value).toBe(sid);
    expect(driver.last.input.sessionId).toBeNull();
  });

  test("a session event with another id moves the index", async () => {
    const { reg, driver, store } = await setup();
    const chat = await newChat(reg);
    const old = driver.last.input.sessionId!.value;
    const next = rid();
    driver.last.emit(sessionEv(next));
    await settle();
    expect(reg.chatForSession(next)).toBe(chat);
    expect(reg.chatForSession(old)).toBeNull();
    expect(store.chats.get(chat)!.sessionId).toBe(next);
  });
});

describe("the states table", () => {
  test("sleeping, starting, running, waiting, running, idle, ending, sleeping", async () => {
    const { reg, driver, deltas } = await setup();
    const chat = await newChat(reg);
    expect(reg.stateOf(chat)).toBe("starting");
    const c = driver.last;
    c.emit(sessionEv(c.input.sessionId!.value));
    await settle();
    expect(reg.stateOf(chat)).toBe("running");
    const asked = c.ask(permission("toolu_1"));
    await settle();
    expect(reg.stateOf(chat)).toBe("waiting");
    expect(reg.list()[0]!.needsYou).toBe(true);
    expect(await apply(reg, { t: "answer", rid: rid(), chat, card: "toolu_1", answer: { kind: "permission", allow: true, scope: "once" } })).toEqual({ ok: true, result: null });
    expect(await asked.answer).toEqual({ kind: "permission", allow: true, scope: "once" });
    expect(reg.stateOf(chat)).toBe("running");
    c.emit(turnEnd());
    await settle();
    expect(reg.stateOf(chat)).toBe("idle");
    c.holdClose = new Promise((r) => setTimeout(r, 30));
    await apply(reg, { t: "archive", rid: rid(), chat, on: true, stop: false });
    expect(reg.stateOf(chat)).toBe("ending");
    await Bun.sleep(60);
    expect(reg.stateOf(chat)).toBe("sleeping");
    const states = deltas.filter((d) => d.chat === chat && "state" in d).map((d) => (d as { state: string }).state);
    expect(states).toEqual(["sleeping", "starting", "running", "waiting", "running", "idle", "ending", "sleeping"]);
  });

  test("a process that exits by itself puts the chat to sleep with one exit line; the next message starts it again", async () => {
    const { reg, driver, store } = await setup();
    const chat = await newChat(reg);
    const v = new RecordingViewer();
    await reg.attach(chat, v);
    driver.last.end({ code: 1, signal: null });
    await settle();
    expect(reg.stateOf(chat)).toBe("sleeping");
    expect(v.of("exit")).toEqual([{ k: "exit", code: 1, signal: null, stderr: [] }]);
    expect(store.chats.get(chat)!.lastExit?.code).toBe(1);
    await apply(reg, send(chat, "again"));
    expect(driver.opens.length).toBe(2);
  });

  test("an event stream that ends with no exit event still gets one exit line", async () => {
    const { reg, driver } = await setup();
    const chat = await newChat(reg);
    const v = new RecordingViewer();
    await reg.attach(chat, v);
    driver.last.end(null);
    await settle();
    expect(v.of("exit")).toEqual([{ k: "exit", code: null, signal: null, stderr: [] }]);
  });

  test("a close that kitespan asks for draws no exit line, now or for a page that attaches later; the tasks clear", async () => {
    const { reg, driver, store } = await setup({ idleMs: 20 });
    const chat = await newChat(reg);
    const c = driver.last;
    const v = new RecordingViewer();
    await reg.attach(chat, v);
    c.emit(turnEnd(), { k: "tasks", running: [{ taskId: "w1", description: "watch", ambient: true }] });
    await settle();
    expect(await apply(reg, { t: "archive", rid: rid(), chat, on: true, stop: false })).toEqual({ ok: true, result: null });
    await settle(10);
    expect(reg.stateOf(chat)).toBe("sleeping");
    expect(store.chats.get(chat)!.lastExit?.code).toBe(0);
    expect(v.of("exit")).toEqual([]);
    expect(v.of("tasks").at(-1)).toEqual({ k: "tasks", running: [] });
    const p = (await reg.attach(chat, new RecordingViewer()))!;
    expect(p.tail.map((i) => i.e.k)).not.toContain("exit");
    expect(p.tail.filter((i) => i.e.k === "tasks").at(-1)?.e).toEqual({ k: "tasks", running: [] });
    // The idle timer's close is kitespan's too.
    await apply(reg, { t: "archive", rid: rid(), chat, on: false, stop: false });
    const other = await newChat(reg, "other");
    driver.last.emit(turnEnd());
    await Bun.sleep(60);
    expect(driver.last.closed).toBe(true);
    const q = (await reg.attach(other, new RecordingViewer()))!;
    expect(q.tail.map((i) => i.e.k)).not.toContain("exit");
  });

  test("Stop and archive: a message still in Claude Code's queue is taken back to the draft, with no exit line", async () => {
    const { reg, driver } = await setup();
    const chat = await newChat(reg, "long task");
    const v = new RecordingViewer();
    await reg.attach(chat, v);
    const queued = send(chat, "and then this");
    expect(await apply(reg, queued)).toEqual({ ok: true, result: { queued: false } });
    expect(v.of("user").at(-1)).toMatchObject({ uuid: queued.uuid, queued: true });
    expect(await apply(reg, { t: "archive", rid: rid(), chat, on: true, stop: true })).toEqual({ ok: true, result: null });
    await settle(10);
    expect(driver.last.calls).toContain("interrupt");
    expect(reg.stateOf(chat)).toBe("sleeping");
    expect(v.of("exit")).toEqual([]);
    expect(v.of("taken_back")).toEqual([{ k: "taken_back", uuid: queued.uuid }]);
    expect(reg.draftOf(chat)?.text).toBe("and then this");
  });

  test("activity with no turn (a background task's follow-up) starts a turn by the agent", async () => {
    const { reg, driver } = await setup();
    const chat = await newChat(reg);
    const c = driver.last;
    c.emit(turnEnd());
    await settle();
    const v = new RecordingViewer();
    await reg.attach(chat, v);
    c.emit({ k: "block", key: "m9:0", kind: "text", text: "The task finished.", parent: null });
    await settle();
    expect(v.events.slice(0, 2).map((e) => e.k)).toEqual(["turn_start", "block"]);
    expect(v.of("turn_start")[0]!.by).toBe("agent");
    expect(reg.stateOf(chat)).toBe("running");
    c.emit({ k: "turn_start", by: "agent" }); // the driver's own turn_start for the same turn is dropped
    await settle();
    expect(v.of("turn_start").length).toBe(1);
  });
});

describe("the idle rule (D2)", () => {
  test("a live chat with no viewer and nothing running sleeps after the limit", async () => {
    const { reg, driver } = await setup({ idleMs: 30 });
    autoReply(driver);
    const chat = await newChat(reg);
    await settle();
    expect(reg.stateOf(chat)).toBe("idle");
    await Bun.sleep(80);
    expect(driver.last.closed).toBe(true);
    expect(reg.stateOf(chat)).toBe("sleeping");
  });

  test("a viewer keeps it live; the timer starts when the last viewer leaves", async () => {
    const { reg, driver } = await setup({ idleMs: 30 });
    autoReply(driver, 5);
    const chat = await newChat(reg);
    const v = new RecordingViewer();
    await reg.attach(chat, v);
    await Bun.sleep(80);
    expect(driver.last.closed).toBe(false);
    reg.detach(chat, v);
    await Bun.sleep(80);
    expect(driver.last.closed).toBe(true);
  });

  test("a running turn, an open card or a task that is not ambient keeps it; an ambient task does not", async () => {
    const { reg, driver } = await setup({ idleMs: 30 });
    const chat = await newChat(reg);
    const c = driver.last;
    await Bun.sleep(60);
    expect(c.closed).toBe(false); // the turn runs
    c.emit(turnEnd(), { k: "tasks", running: [{ taskId: "t1", description: "build", ambient: false }] });
    await Bun.sleep(60);
    expect(c.closed).toBe(false);
    c.emit({ k: "tasks", running: [{ taskId: "w1", description: "watch", ambient: true }] });
    await Bun.sleep(60);
    expect(c.closed).toBe(true);
    expect(reg.stateOf(chat)).toBe("sleeping");
  });

  test("the limit comes from Settings > Chats when no option overrides it", async () => {
    const { reg, driver, store } = await setup({ idleMs: undefined }, (_d, s) => {
      s.settingsValue = { ...s.settingsValue, "chats.keepIdleMinutes": 0 };
    });
    autoReply(driver);
    await newChat(reg);
    await settle(10);
    expect(driver.last.closed).toBe(true);
    expect(store.settingsValue["chats.keepIdleMinutes"]).toBe(0);
  });
});

describe("a send while the chat is ending", () => {
  test("waits until the process is gone, then starts the chat again with the message", async () => {
    const { reg, driver } = await setup({ idleMs: 10 });
    const chat = await newChat(reg, "first");
    const c = driver.last;
    c.holdClose = new Promise((r) => setTimeout(r, 40));
    c.emit(turnEnd());
    await Bun.sleep(25);
    expect(reg.stateOf(chat)).toBe("ending");
    const f = send(chat, "right after");
    expect(await apply(reg, f)).toEqual({ ok: true, result: { queued: false } });
    expect(c.closed).toBe(true);
    expect(driver.opens.length).toBe(2);
    expect(driver.last.sent.map((s) => s.uuid)).toEqual([f.uuid]);
  });
});

describe("the cap rule (D3)", () => {
  test("over the cap, the least recently used idle chat with no viewer sleeps first", async () => {
    const { reg, driver } = await setup({ maxLive: 2 });
    autoReply(driver);
    const a = await newChat(reg, "a");
    await settle();
    await Bun.sleep(5);
    const b = await newChat(reg, "b");
    await settle();
    await Bun.sleep(5);
    expect(reg.liveCount()).toBe(2);
    const c = await newChat(reg, "c");
    expect(driver.opens[0]!.closed).toBe(true);
    expect(driver.opens[1]!.closed).toBe(false);
    expect(reg.stateOf(a)).toBe("sleeping");
    expect(reg.stateOf(b)).toBe("idle");
    expect(reg.stateOf(c)).not.toBe("sleeping");
    expect(reg.liveCount()).toBe(2);
  });

  test("a chat with a viewer is not put to sleep: the next least recently used one is", async () => {
    const { reg, driver } = await setup({ maxLive: 2 });
    autoReply(driver);
    const a = await newChat(reg, "a");
    await settle();
    await Bun.sleep(5);
    await newChat(reg, "b");
    await settle();
    await reg.attach(a, new RecordingViewer());
    await newChat(reg, "c");
    expect(driver.opens[0]!.closed).toBe(false);
    expect(driver.opens[1]!.closed).toBe(true);
  });

  test("when no chat can sleep, starts wait in a first-in, first-out queue and go on as slots free", async () => {
    const { reg, driver } = await setup({ maxLive: 1 });
    const a = await newChat(reg, "a"); // its turn runs: it cannot sleep
    const vb = new RecordingViewer();
    const bFrame = newChatFrame("b");
    const ob = await apply(reg, bFrame);
    expect(ob.ok).toBe(true);
    const b = (ob as { result: { chat: string } }).result.chat;
    await reg.attach(b, vb);
    expect(driver.opens.length).toBe(1);
    expect(reg.stateOf(b)).toBe("sleeping");
    const snap = (await reg.attach(b, vb))!;
    expect(snap.tail.map((i) => i.e)).toEqual([
      { k: "user", uuid: bFrame.uuid, text: "b", queued: true, mentions: [] },
      { k: "notice", text: CAP_NOTICE, id: expect.any(String) },
    ]);
    const more = send(b, "b2");
    expect(await apply(reg, more)).toEqual({ ok: true, result: { queued: true } });
    const c = await newChat(reg, "c");
    expect(driver.opens.length).toBe(1);
    // a's turn ends: it is idle with no viewer, so it sleeps, and b (first in) starts with both its messages
    driver.opens[0]!.emit(turnEnd());
    await settle(10);
    expect(reg.stateOf(a)).toBe("sleeping");
    expect(driver.opens.length).toBe(2);
    expect(driver.opens[1]!.input.chatId).toBe(b);
    expect(driver.opens[1]!.sent.map((s) => s.text)).toEqual(["b", "b2"]);
    // b2 showed as queued when it was sent; b's first message starts the turn and loses its Queued label.
    expect(vb.of("user").map((e) => [e.uuid, e.queued])).toEqual([[more.uuid, true], [bFrame.uuid, false]]);
    // The wait ended with a start: its line goes from every page.
    const line = snap.tail.map((i) => i.e).find((e) => e.k === "notice") as Extract<ChatEvent, { k: "notice" }>;
    expect(vb.of("taken_back")).toEqual([{ k: "taken_back", uuid: line.id! }]);
    expect(reg.stateOf(c)).toBe("sleeping");
    // b's turn ends while a viewer has it, so it stays; c waits until b is free
    driver.opens[1]!.emit(sessionEv(rid()), turnEnd([bFrame.uuid, more.uuid]));
    await settle(10);
    expect(driver.opens.length).toBe(2);
    reg.detach(b, vb);
    await settle(10);
    expect(driver.opens.length).toBe(3);
    expect(driver.opens[2]!.input.chatId).toBe(c);
  });

  test("a wait that ends with a start takes the free-slot line from every page, so a live page and a reload draw the same lines", async () => {
    const { reg, driver } = await setup({ maxLive: 1 });
    await newChat(reg, "a"); // its turn runs: it cannot sleep
    const bFrame = newChatFrame("b");
    const b = ((await apply(reg, bFrame)) as { result: { chat: string } }).result.chat;
    const live = new RecordingViewer();
    const first = (await reg.attach(b, live))!;
    const line = first.tail.map((i) => i.e).find((e) => e.k === "notice") as Extract<ChatEvent, { k: "notice" }>;
    expect(line).toEqual({ k: "notice", text: CAP_NOTICE, id: expect.any(String) });
    /** The server lines that a page draws from its events: a line with an id goes at the `taken_back` with that id. */
    const lines = (events: readonly ChatEvent[]) => {
      const shown = new Map<string, string>();
      events.forEach((e, i) => {
        if (e.k === "notice") shown.set(e.id ?? `line-${i}`, e.text);
        else if (e.k === "taken_back") shown.delete(e.uuid);
      });
      return [...shown.values()];
    };
    const view = (p: { snapshot: { history: ChatEvent[] }; tail: { e: ChatEvent }[] }) => [...p.snapshot.history, ...p.tail.map((i) => i.e)];
    expect(lines(view(first))).toEqual([CAP_NOTICE]);
    // a's turn ends, so a sleeps and b starts: the line goes with the start, before b's message loses its Queued label.
    driver.opens[0]!.emit(turnEnd());
    await settle(10);
    expect(driver.opens[1]!.input.chatId).toBe(b);
    expect(live.events.map((e) => (e.k === "user" ? `user ${e.queued}` : e.k === "taken_back" ? `taken_back ${e.uuid}` : e.k))).toEqual([
      `taken_back ${line.id}`,
      "turn_start",
      "user false",
    ]);
    const liveView = () => [...view(first), ...live.events];
    expect(lines(liveView())).toEqual([]);
    // A reload while b's turn runs, and one after it ended, draw the same lines as the page that watched.
    expect(lines(view((await reg.attach(b, new RecordingViewer("tab_b")))!))).toEqual([]);
    const sid = driver.opens[1]!.input.sessionId!.value;
    driver.opens[1]!.emit(sessionEv(sid), { k: "block", key: "msg_b:0", kind: "text", text: "Done.", parent: null }, turnEnd([bFrame.uuid]));
    await settle(10);
    driver.histories.set(sid, [{ k: "user", uuid: bFrame.uuid, text: "b", queued: false }, { k: "block", key: "msg_b:0", kind: "text", text: "Done.", parent: null }, turnEnd([bFrame.uuid])]);
    expect(lines(liveView())).toEqual([]);
    expect(lines(view((await reg.attach(b, new RecordingViewer("tab_c")))!))).toEqual([]);
  });

  test("an archived chat never counts toward the cap and never starts", async () => {
    const { reg, driver } = await setup({ maxLive: 1 });
    autoReply(driver);
    const a = await newChat(reg, "a");
    await settle();
    expect(await apply(reg, { t: "archive", rid: rid(), chat: a, on: true, stop: false })).toEqual({ ok: true, result: null });
    await settle(10);
    expect(reg.liveCount()).toBe(0);
    expect(await apply(reg, send(a, "more"))).toEqual({ ok: false, code: "archived" });
    expect(driver.opens.length).toBe(1);
    await newChat(reg, "b");
    expect(driver.opens.length).toBe(2);
    expect(driver.opens[0]!.closed).toBe(true);
  });

  test("a queued start goes on as soon as the only live chat's last task that is not ambient ends", async () => {
    const { reg, driver } = await setup({ maxLive: 1 });
    const a = await newChat(reg, "a");
    const ca = driver.last;
    ca.emit(turnEnd(), { k: "tasks", running: [{ taskId: "t1", description: "build", ambient: false }] });
    await settle();
    expect(reg.stateOf(a)).toBe("idle");
    const b = await newChat(reg, "b");
    expect(driver.opens.length).toBe(1);
    expect(reg.stateOf(b)).toBe("sleeping");
    // The task ends: a's state stays idle, but nothing keeps it any more, so it sleeps and b starts.
    ca.emit({ k: "tasks", running: [{ taskId: "w1", description: "watch", ambient: true }] });
    await settle(10);
    expect(ca.closed).toBe(true);
    expect(reg.stateOf(a)).toBe("sleeping");
    expect(driver.opens.length).toBe(2);
    expect(driver.last.input.chatId).toBe(b);
  });

  test("a queued start goes on as soon as the only live chat's `!` command ends", async () => {
    const { reg, driver, bash, store } = await setup({ maxLive: 1 }, (_d, s) => {
      s.settingsValue = { ...s.settingsValue, "chats.bashReply": "never" };
    });
    expect(store.settingsValue["chats.bashReply"]).toBe("never");
    const a = await newChat(reg, "a");
    const ca = driver.last;
    ca.emit(turnEnd());
    await settle();
    let release!: () => void;
    bash.hold = new Promise((r) => (release = r));
    expect(await apply(reg, { t: "bash", rid: rid(), chat: a, input: "make", draftRev: null, uploads: [] })).toEqual({ ok: true, result: null });
    const b = await newChat(reg, "b");
    expect(driver.opens.length).toBe(1);
    release();
    await settle(10);
    expect(ca.bashRecords.map((r) => r.reply)).toEqual([false]);
    expect(ca.closed).toBe(true);
    expect(driver.opens.length).toBe(2);
    expect(driver.last.input.chatId).toBe(b);
  });

  test("a `!` command that Claude replies to keeps its chat until the reply turn ends", async () => {
    const { reg, driver, bash } = await setup({ maxLive: 1 });
    const a = await newChat(reg, "a");
    const ca = driver.last;
    ca.emit(turnEnd());
    await settle();
    let release!: () => void;
    bash.hold = new Promise((r) => (release = r));
    await apply(reg, { t: "bash", rid: rid(), chat: a, input: "git status", draftRev: null, uploads: [] });
    const b = await newChat(reg, "b");
    release();
    await settle(10);
    // The record went to Claude Code with a reply: its turn starts at once, so a is not idle and b still waits.
    expect(ca.bashRecords.map((r) => r.reply)).toEqual([true]);
    expect(reg.stateOf(a)).toBe("running");
    expect(ca.closed).toBe(false);
    expect(driver.opens.length).toBe(1);
    ca.emit({ k: "block", key: "m2:0", kind: "text", text: "Clean tree.", parent: null }, turnEnd());
    await settle(10);
    expect(ca.closed).toBe(true);
    expect(driver.opens.length).toBe(2);
    expect(driver.last.input.chatId).toBe(b);
  });
});

describe("cards in memory", () => {
  test("the first answer wins, a second gets stale, and every viewer sees card_open and card_close", async () => {
    const { reg, driver } = await setup();
    const chat = await newChat(reg);
    const va = new RecordingViewer("tab_a");
    const vb = new RecordingViewer("tab_b");
    await reg.attach(chat, va);
    await reg.attach(chat, vb);
    const asked = driver.last.ask(permission("toolu_7"));
    await settle();
    expect(va.of("card_open").map((e) => e.card.id)).toEqual(["toolu_7"]);
    expect(vb.of("card_open").map((e) => e.card.id)).toEqual(["toolu_7"]);
    const snap = (await reg.attach(chat, new RecordingViewer("tab_c")))!;
    expect(snap.attached.cards.map((c) => c.id)).toEqual(["toolu_7"]);
    expect(snap.attached.state).toBe("waiting");
    const [one, two] = await Promise.all([
      apply(reg, { t: "answer", rid: rid(), chat, card: "toolu_7", answer: { kind: "permission", allow: false, message: "no" } }, { tab: "tab_a" }),
      apply(reg, { t: "answer", rid: rid(), chat, card: "toolu_7", answer: { kind: "permission", allow: true, scope: "once" } }, { tab: "tab_b" }),
    ]);
    expect(one).toEqual({ ok: true, result: null });
    expect(two).toEqual({ ok: false, code: "stale" });
    expect(await asked.answer).toEqual({ kind: "permission", allow: false, message: "no" });
    // How it closed goes with the close, for the record every page draws (5.4): Deny, with its note.
    expect(vb.of("card_close")).toEqual([{ k: "card_close", id: "toolu_7", why: "answered", answer: "denied", note: "no" }]);
  });

  test("an answer of the wrong kind, or Allow for this session where the card offers none, is refused", async () => {
    const { reg, driver } = await setup();
    const chat = await newChat(reg);
    driver.last.ask(permission("toolu_1", { suppressAlwaysAllowRule: true }));
    await settle();
    const q: QuestionCard = { kind: "question", id: "toolu_2", toolUseId: "toolu_2", questions: [] };
    driver.last.ask(q);
    await settle();
    expect(await apply(reg, { t: "answer", rid: rid(), chat, card: "toolu_2", answer: { kind: "permission", allow: true, scope: "once" } })).toEqual({ ok: false, code: "bad_request" });
    expect(await apply(reg, { t: "answer", rid: rid(), chat, card: "toolu_1", answer: { kind: "permission", allow: true, scope: "session" } })).toEqual({ ok: false, code: "bad_request" });
    expect(await apply(reg, { t: "answer", rid: rid(), chat, card: "toolu_9", answer: { kind: "permission", allow: true, scope: "once" } })).toEqual({ ok: false, code: "stale" });
  });

  test("a long deny note is cut at 2,000 characters before the driver gets it", async () => {
    const { reg, driver } = await setup();
    const chat = await newChat(reg);
    const asked = driver.last.ask(permission("toolu_1"));
    await settle();
    await apply(reg, { t: "answer", rid: rid(), chat, card: "toolu_1", answer: { kind: "permission", allow: false, message: "x".repeat(5_000) } });
    const a = (await asked.answer) as { message: string };
    expect(a.message.length).toBe(2_000);
  });

  test("a card that Claude Code cancels closes as cancelled; one whose process ends closes as lost", async () => {
    const { reg, driver } = await setup();
    const chat = await newChat(reg);
    const v = new RecordingViewer();
    await reg.attach(chat, v);
    const one = driver.last.ask(permission("toolu_1"));
    const two = driver.last.ask(permission("toolu_2"));
    await settle();
    one.abort();
    expect(await one.answer).toBeNull();
    driver.last.end();
    await settle();
    expect(await two.answer).toBeNull();
    expect(v.of("card_close")).toEqual([
      { k: "card_close", id: "toolu_1", why: "cancelled", answer: "cancelled" },
      { k: "card_close", id: "toolu_2", why: "lost", answer: "cancelled" },
    ]);
    expect(await apply(reg, { t: "answer", rid: rid(), chat, card: "toolu_2", answer: { kind: "permission", allow: true, scope: "once" } })).toEqual({ ok: false, code: "stale" });
  });

  test("a card from an earlier process of the chat is answered with nothing", async () => {
    const { reg, driver } = await setup();
    const chat = await newChat(reg);
    const old = driver.last;
    old.end();
    await settle();
    await apply(reg, send(chat, "again"));
    expect(await old.ask(permission("toolu_1")).answer).toBeNull();
    expect(reg.stateOf(chat)).not.toBe("waiting");
  });
});

describe("viewers (D49)", () => {
  test("two pages on one chat: one open(), both messages in arrival order, both pages see both", async () => {
    const { reg, driver } = await setup();
    const chat = await newChat(reg, "first");
    const c = driver.last;
    c.emit(turnEnd());
    await settle();
    const va = new RecordingViewer("tab_a");
    const vb = new RecordingViewer("tab_b");
    await reg.attach(chat, va);
    await reg.attach(chat, vb);
    const fa = send(chat, "from the laptop");
    const fb = send(chat, "from the phone");
    const [oa, ob] = await Promise.all([apply(reg, fa, { tab: "tab_a" }), apply(reg, fb, { tab: "tab_b" })]);
    expect(oa).toEqual({ ok: true, result: { queued: false } });
    expect(ob).toEqual({ ok: true, result: { queued: false } });
    expect(driver.opens.length).toBe(1);
    expect(c.sent.map((s) => s.text)).toEqual(["first", "from the laptop", "from the phone"]);
    for (const v of [va, vb]) expect(v.of("user").map((e) => [e.uuid, e.queued])).toEqual([[fa.uuid, false], [fb.uuid, true]]);
    // a reply that names both marks both consumed
    c.emit(turnEnd([fa.uuid, fb.uuid]));
    await settle();
    expect(vb.of("user").map((e) => [e.uuid, e.queued])).toEqual([[fa.uuid, false], [fb.uuid, true], [fb.uuid, false]]);
  });

  test("the CLI's echo of a message the server already showed is dropped by its uuid", async () => {
    const { reg, driver } = await setup();
    const f = newChatFrame("hello");
    const o = await apply(reg, f);
    const chat = (o as { result: { chat: string } }).result.chat;
    const v = new RecordingViewer();
    await reg.attach(chat, v);
    driver.last.emit({ k: "user", uuid: f.uuid, text: "hello", queued: false }, { k: "user", uuid: rid(), text: "from history", queued: false });
    await settle();
    expect(v.of("user").map((e) => e.text)).toEqual(["from history"]);
  });

  test("the attach payload: attached before the snapshot, and the snapshot's tail is what the page does not hold", async () => {
    const { reg, driver } = await setup();
    const chat = await newChat(reg, "Plan it");
    const c = driver.last;
    const sid = c.input.sessionId!.value;
    c.emit(sessionEv(sid), { k: "block", key: "m1:0", kind: "text", text: "First part", parent: null }, { k: "tool_call", id: "toolu_a", name: "Read", input: { file_path: "a.ts" }, parent: null });
    await settle();
    // The transcript already holds the block and the tool call; the page gets the rest of the turn in flight.
    driver.transcript(sid);
    driver.histories.set(sid, [
      { k: "block", key: "m1:0", kind: "text", text: "First part", parent: null },
      { k: "tool_call", id: "toolu_a", name: "Read", input: { file_path: "a.ts" }, parent: null },
    ]);
    const p = (await reg.attach(chat, new RecordingViewer()))!;
    expect(p.attached).toMatchObject({ t: "attached", chat, epoch: reg.epoch, state: "running", replay: "snapshot", archived: false, cards: [] });
    expect(p.attached.title).toEqual({ text: "Plan it", from: "first-prompt" });
    // U2: history marks the turn in flight's start at its first row there (server/chats/turns.ts).
    expect(p.snapshot.history.map((e) => e.k)).toEqual(["turn_start", "block", "tool_call"]);
    expect(p.tail.map((i) => i.e.k)).toEqual(["turn_start", "user", "session"]);
    expect(p.snapshot.seq).toBe(p.tail[0]!.seq - 1);
    expect(p.cursor).toBe(p.attached.seq);
    c.emit(turnEnd());
    await settle();
    // After the turn: only the newest state events follow the snapshot.
    const q = (await reg.attach(chat, new RecordingViewer()))!;
    expect(q.tail.map((i) => i.e.k)).toEqual(["session"]);
    expect(q.snapshot.seq).toBe(q.tail[0]!.seq - 1);
  });

  test("after the ring dropped the start of a long turn, a page that attaches still gets the turn_start and each open block's start with all its text", async () => {
    const { reg, driver } = await setup();
    const chat = await newChat(reg, "Think hard");
    const c = driver.last;
    const turnSeq = (await reg.attach(chat, new RecordingViewer()))!.tail.find((i) => i.e.k === "turn_start")!.seq;
    c.emit(sessionEv(c.input.sessionId!.value), { k: "block_start", key: "m1:0", kind: "thinking", parent: null });
    const pieces = Array.from({ length: 2_100 }, (_, i) => `step ${String(i).padStart(4, "0")} of the plan; `);
    for (const t of pieces) c.emit({ k: "block_delta", key: "m1:0", text: t });
    await settle(10);
    const p = (await reg.attach(chat, new RecordingViewer()))!;
    const seqs = p.tail.map((i) => i.seq);
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(p.snapshot.seq).toBeLessThan(seqs[0]!);
    const ts = p.tail.filter((i) => i.e.k === "turn_start");
    expect(ts.map((i) => i.seq)).toEqual([turnSeq]);
    const kinds = p.tail.map((i) => i.e.k);
    expect(kinds.indexOf("block_start")).toBeGreaterThan(kinds.indexOf("turn_start"));
    const text = p.tail.flatMap((i) => (i.e.k === "block_delta" && i.e.key === "m1:0" ? [i.e.text] : [])).join("");
    expect(text).toBe(pieces.join(""));
    expect(kinds.indexOf("block_start")).toBeLessThan(kinds.indexOf("block_delta"));
    for (const i of p.tail) {
      expect(i.bytes).toBeLessThanOrEqual(256 * 1024);
      expect(JSON.parse(i.json)).toEqual({ t: "ev", chat, seq: i.seq, e: i.e });
    }
    // Stop names the turn's seq, which that page now has.
    expect(await apply(reg, { t: "interrupt", rid: rid(), chat, turn: ts[0]!.seq })).toEqual({ ok: true, result: { stillQueued: null } });
    // Once the block and the turn end, only the newest state event is kept outside the ring (the ring dropped it).
    c.emit({ k: "block_end", key: "m1:0" }, turnEnd());
    await settle();
    const q = (await reg.attach(chat, new RecordingViewer()))!;
    expect(q.tail.map((i) => i.e)).toEqual([sessionEv(c.input.sessionId!.value)]);
    expect(q.tail[0]!.seq).toBeLessThan(p.tail.find((i) => i.e.k === "block_start")!.seq);
  });

  test("a tool's denied tag and its live result follow a snapshot whose page holds only its call; only the newest progress follows", async () => {
    const { reg, driver } = await setup();
    const chat = await newChat(reg, "Read it");
    const c = driver.last;
    const sid = c.input.sessionId!.value;
    const call: ChatEvent = { k: "tool_call", id: "toolu_x", name: "Bash", input: { command: "make" }, parent: null };
    c.emit(
      sessionEv(sid),
      call,
      { k: "denied", id: "toolu_x", tool: "Bash", reasonType: "classifier", reason: "Denied by auto mode", parent: null },
      { k: "tool_progress", id: "toolu_x", seconds: 1, parent: null },
      { k: "tool_progress", id: "toolu_x", seconds: 2, parent: null },
      { k: "tool_progress", id: "toolu_x", seconds: 3, parent: null },
      { k: "tool_result", id: "toolu_x", text: "done", isError: false, parent: null, report: "The hand-back report" },
    );
    await settle();
    driver.transcript(sid);
    driver.histories.set(sid, [call]);
    const p = (await reg.attach(chat, new RecordingViewer()))!;
    const toolEvents = p.tail.map((i) => i.e).filter((e) => e.k !== "turn_start" && e.k !== "user" && e.k !== "session");
    expect(toolEvents).toEqual([
      { k: "denied", id: "toolu_x", tool: "Bash", reasonType: "classifier", reason: "Denied by auto mode", parent: null },
      { k: "tool_progress", id: "toolu_x", seconds: 3, parent: null },
      { k: "tool_result", id: "toolu_x", text: "done", isError: false, parent: null, report: "The hand-back report" },
    ]);
    // When the page holds the result too, the result and the progress stay out; the tag still follows.
    driver.histories.set(sid, [call, { k: "tool_result", id: "toolu_x", text: "done", isError: false, parent: null, report: null }]);
    const q = (await reg.attach(chat, new RecordingViewer()))!;
    expect(q.tail.map((i) => i.e.k).filter((k) => k !== "turn_start" && k !== "user" && k !== "session")).toEqual(["denied"]);
  });

  test("a background task that outlived its turn: its start and its newest progress follow the snapshot until it ends", async () => {
    const { reg, driver } = await setup();
    const chat = await newChat(reg, "Run the workflow");
    const c = driver.last;
    const sid = c.input.sessionId!.value;
    const started = (taskId: string): Extract<ChatEvent, { k: "task" }> => ({ k: "task", ev: "started", taskId, toolUseId: `toolu_${taskId}`, taskType: "local_workflow", subagentType: null, description: "Review", workflowName: "review", background: true, prompt: null, parentTaskId: null });
    const progress = (taskId: string, summary: string): Extract<ChatEvent, { k: "task" }> => ({ k: "task", ev: "progress", taskId, toolUseId: `toolu_${taskId}`, description: "Review", lastTool: null, summary, usage: null, workflow: null });
    c.emit(sessionEv(sid), started("wf1"), started("wf2"), progress("wf1", "phase 1"), { k: "tasks", running: [{ taskId: "wf1", description: "Review", ambient: false }, { taskId: "wf2", description: "Review", ambient: false }] }, turnEnd());
    await settle();
    c.emit(progress("wf1", "phase 2"), progress("wf2", "phase 1"), { k: "task", ev: "done", taskId: "wf2", toolUseId: "toolu_wf2", status: "completed", summary: null, usage: null }, { k: "tasks", running: [{ taskId: "wf1", description: "Review", ambient: false }] });
    await settle();
    // The page attaches after the turn ended (and the ring keeps the events): the running workflow can draw its phases.
    const p = (await reg.attach(chat, new RecordingViewer()))!;
    const tasks = p.tail.map((i) => i.e).filter((e): e is Extract<ChatEvent, { k: "task" }> => e.k === "task");
    // wf1 runs: its start and newest progress from the ended turn, then what came after. wf2 ended: only what came
    // after the turn.
    expect(tasks.filter((e) => e.taskId === "wf1")).toEqual([started("wf1"), progress("wf1", "phase 1"), progress("wf1", "phase 2")]);
    expect(tasks.filter((e) => e.taskId === "wf2").map((e) => e.ev)).toEqual(["progress", "done"]);
    expect(p.tail.map((i) => i.e.k)).toContain("tasks");
  });

  test("a page whose history read ends after a whole turn ran gets that turn's message and reply once", async () => {
    const { reg, driver } = await setup();
    autoReply(driver, 0, "First reply");
    const chat = await newChat(reg, "Run the tests");
    await settle();
    const sid = driver.last.input.sessionId!.value;
    // The transcript as the page's read finds it: the first turn only.
    const first = driver.last.sent[0]!;
    driver.histories.set(sid, [
      { k: "user", uuid: first.uuid, text: "Run the tests", queued: false },
      { k: "block", key: `m-${first.uuid}`, kind: "text", text: "First reply", parent: null },
    ]);
    autoReply(driver, 0, "Second reply");
    const read = driver.history.bind(driver);
    let raced = false;
    driver.history = async (s, cwd, page) => {
      const p = await read(s, cwd, page);
      if (!raced) {
        // While the transcript is read, another page sends a message and its whole turn runs and ends.
        raced = true;
        await apply(reg, send(chat, "Run the tests again"));
        await settle();
      }
      return p;
    };
    const p = (await reg.attach(chat, new RecordingViewer("tab_b")))!;
    expect(raced).toBe(true);
    const all = [...p.snapshot.history, ...p.tail.map((i) => i.e)];
    expect(all.filter((e) => e.k === "user").map((e) => (e as { text: string }).text)).toEqual(["Run the tests", "Run the tests again"]);
    expect(all.filter((e) => e.k === "block").map((e) => (e as { text: string }).text)).toEqual(["First reply", "Second reply"]);
    expect(p.cursor).toBe(reg.seq(chat));
  });

  test("a call that was open when the history read began is not drawn stopped when its turn ends during the read", async () => {
    const { reg, driver } = await setup();
    const chat = await newChat(reg, "Read it");
    const c = driver.last;
    const sid = c.input.sessionId!.value;
    const call: ChatEvent = { k: "tool_call", id: "toolu_r", name: "Read", input: { file_path: "a.ts" }, parent: null };
    c.emit(sessionEv(sid), call);
    await settle();
    driver.transcript(sid);
    driver.histories.set(sid, [call]);
    let raced = false;
    driver.history = async (_s, _cwd, page) => {
      // The transcript is read while the call runs; the turn ends (the result comes) before the read is decorated.
      const events = [structuredClone(call)];
      c.emit({ k: "tool_result", id: "toolu_r", text: "done", isError: false, parent: null, report: null }, turnEnd());
      await settle();
      raced = true;
      return { events: page.decorate ? page.decorate(events) : events, more: null };
    };
    const p = (await reg.attach(chat, new RecordingViewer("tab_b")))!;
    expect(raced).toBe(true);
    // U2: the turn as it was when the read began: its start in history, its end in the tail (once).
    expect(p.snapshot.history.map((e) => e.k)).toEqual(["turn_start", "tool_call"]);
    const tailKinds = p.tail.map((i) => i.e.k);
    expect(tailKinds.filter((k) => k === "tool_result" || k === "tool_stopped" || k === "turn_end")).toEqual(["tool_result", "turn_end"]);
  });

  test("attach of an unknown chat is null; detach of a viewer that is not there does nothing", async () => {
    const { reg } = await setup();
    expect(await reg.attach("zzzzzzzzzzzzzzzzzzzz", new RecordingViewer())).toBeNull();
    reg.detach("zzzzzzzzzzzzzzzzzzzz", new RecordingViewer());
  });
});

describe("shutdown", () => {
  test("closes every live chat, writes the ledgers, flushes the store, and starts no new turn", async () => {
    const { reg, driver, store } = await setup();
    autoReply(driver);
    const a = await newChat(reg, "a");
    await newChat(reg, "b");
    await settle();
    await reg.shutdown();
    expect(driver.opens.every((c) => c.closed)).toBe(true);
    expect(reg.liveCount()).toBe(0);
    expect(store.flushed).toBe(1);
    expect(store.chats.get(a)!.state).toBe("sleeping");
    expect(await apply(reg, send(a, "more"))).toEqual({ ok: false, code: "restarting" });
    expect(await apply(reg, newChatFrame("c"))).toEqual({ ok: false, code: "restarting" });
  });
});
