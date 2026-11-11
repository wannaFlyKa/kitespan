// Row 78 in the registry: a kitespan chat whose session another Claude Code process opens gives the session up. Its own
// turn finishes first (never cut), then its process ends as the idle timer would end it (a close, no exit line);
// queued messages wait; every page's row carries `held` (the app and the session, for Continue in a copy); a send or a
// `!` command meanwhile is refused with `session_held`; a page that opens the chat starts no process. When the other
// process ends, the row's `held` goes (the pages read the history again), and what waited is sent on a new start that
// resumes the transcript. The check runs about every 2 s while a chat has a viewer or a live process. The scripted
// driver stands in for Claude Code, its `openNow` for the other app's record in Claude Code's registry.
import { describe, expect, test } from "bun:test";
import { ERROR_CODES, ERROR_MESSAGES, applyChatsFrame, type ChatDelta, type ChatRow } from "../../shared/protocol";
import { ChatRegistry } from "../../server/chats/registry";
import { FakeBash, FakeDriver, MemoryStore, RecordingViewer, apply, autoReply, projectRecord, settle } from "../../server/chats/testing";
import type { Outcome, RegistryOptions } from "../../server/chats/types";

const PROJECT = "k3m7q2x4ab";
const CWD = "/srv/work/app";
const rid = () => crypto.randomUUID();

async function setup(opts: RegistryOptions = {}) {
  const driver = new FakeDriver();
  const store = new MemoryStore();
  const bash = new FakeBash();
  store.projects = [projectRecord(PROJECT, CWD)];
  const reg = new ChatRegistry({ driver, store, bash }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500, openCheckMs: 15, openFastMs: 15, ...opts });
  await reg.boot();
  const deltas: ChatDelta[] = [];
  reg.subscribe((d) => deltas.push(d));
  return { driver, store, bash, reg, deltas };
}

const cont = (session: string, fork?: boolean) => ({ t: "continue_session" as const, rid: rid(), project: PROJECT, session, ...(fork === undefined ? {} : { fork }) });
const chatOf = (o: Outcome) => (o.ok ? (o.result as { chat: string }).chat : "");
const send = (chat: string, text: string) => {
  const r = rid();
  return { t: "send" as const, rid: r, chat, uuid: r, text, draftRev: null, uploads: [] };
};
const heldOf = (reg: ChatRegistry, chat: string) => reg.list().find((r) => r.chat === chat)?.held ?? null;
const heldDeltas = (deltas: ChatDelta[], chat: string) => deltas.filter((d) => d.chat === chat && "held" in d);
const turnEnd = (uuid: string) => ({ k: "turn_end" as const, ok: true, subtype: "success", durationMs: 5, error: null, uuids: [uuid] });
async function until(pred: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
}

/** A chat on a past session (its transcript exists, so a start resumes it), sleeping. */
async function chatOnSession(reg: ChatRegistry, driver: FakeDriver, title = "Plan the release") {
  const sid = rid();
  driver.transcript(sid, title, CWD);
  const chat = chatOf(await apply(reg, cont(sid)));
  return { sid, chat };
}

describe("the frames (row 78)", () => {
  test("session_held is a code of its own, with its own line", () => {
    expect(ERROR_CODES).toContain("session_held");
    expect(ERROR_MESSAGES.session_held).toBe("This session is open in another app. You can send here again when it is closed there.");
  });
  test("a chat-list delta's held sets the row's, and null takes it away", () => {
    const row: ChatRow = { chat: "abcdefghijklmnopqrst", title: "t", project: PROJECT, state: "idle", needsYou: false, lastActivity: "2026-11-02T00:00:00.000Z", archived: false, busy: false };
    const session = rid();
    const on = applyChatsFrame([row], { t: "chats", delta: { chat: row.chat, held: { app: "terminal", session } } });
    expect(on[0]!.held).toEqual({ app: "terminal", session });
    expect(applyChatsFrame(on, { t: "chats", delta: { chat: row.chat, held: null } })[0]!.held).toBeNull();
  });
});

describe("a sleeping chat whose session another process opens", () => {
  test("its row says held, with the app and the session; a send and a `!` command are refused; nothing starts; the draft stays", async () => {
    const { reg, driver, deltas } = await setup();
    const { sid, chat } = await chatOnSession(reg, driver);
    await reg.draftEdit({ t: "draft", chat, text: "next step", mode: "chat", command: null, link: false, uploads: [] }, "tab_a");
    driver.openNow.set(sid, { app: "terminal", busy: false });
    await until(() => heldOf(reg, chat) !== null);
    expect(heldOf(reg, chat)).toEqual({ app: "terminal", session: sid });
    expect(heldDeltas(deltas, chat)).toEqual([{ chat, held: { app: "terminal", session: sid } }]);
    expect(await apply(reg, send(chat, "next step"))).toEqual({ ok: false, code: "session_held" });
    expect(await apply(reg, { t: "bash", rid: rid(), chat, input: "ls", draftRev: null, uploads: [] })).toEqual({ ok: false, code: "session_held" });
    expect(driver.opens).toHaveLength(0);
    expect(reg.draftOf(chat)?.text).toBe("next step");
    // A page that opens the chat while it is held starts no process.
    const page = new RecordingViewer();
    expect(await reg.attach(chat, page)).not.toBeNull();
    await settle();
    expect(driver.opens).toHaveLength(0);
    // busy and another app's kind only change the words, never the hold: one delta for desktop, none for busy.
    driver.openNow.set(sid, { app: "desktop", busy: true });
    await until(() => heldOf(reg, chat)?.app === "desktop");
    const reads = driver.openReads;
    await until(() => driver.openReads > reads + 2);
    expect(heldDeltas(deltas, chat)).toHaveLength(2);
    // The other app closes the session: the row's held goes, and Send works again.
    driver.openNow.delete(sid);
    await until(() => heldOf(reg, chat) === null);
    expect(heldDeltas(deltas, chat).at(-1)).toEqual({ chat, held: null });
    expect(reg.list().find((r) => r.chat === chat)!).not.toHaveProperty("held");
    autoReply(driver);
    expect((await apply(reg, send(chat, "next step"))).ok).toBe(true);
    expect(driver.opens).toHaveLength(1);
    expect(driver.last.input.resume?.value).toBe(sid);
    await reg.shutdown();
  });

  test("a send that comes before any check saw the other app is refused too: the registry is read again before a start", async () => {
    const { reg, driver } = await setup({ openCheckMs: 60_000, openFastMs: 60_000 });
    const { sid, chat } = await chatOnSession(reg, driver);
    driver.openNow.set(sid, { app: "other", busy: false });
    expect(await apply(reg, send(chat, "go on"))).toEqual({ ok: false, code: "session_held" });
    expect(driver.opens).toHaveLength(0);
    expect(heldOf(reg, chat)).toEqual({ app: "other", session: sid });
    await reg.shutdown();
  });

  test("an archived chat is never held; an unreadable registry counts as none open and ends a hold", async () => {
    const { reg, driver } = await setup();
    const a = await chatOnSession(reg, driver, "First");
    const b = await chatOnSession(reg, driver, "Second");
    await apply(reg, { t: "archive", rid: rid(), chat: b.chat, on: true, stop: false });
    driver.openNow.set(a.sid, { app: "terminal", busy: false });
    driver.openNow.set(b.sid, { app: "terminal", busy: false });
    await until(() => heldOf(reg, a.chat) !== null);
    const reads = driver.openReads;
    await until(() => driver.openReads > reads + 2);
    expect(heldOf(reg, b.chat)).toBeNull();
    driver.openSessionsThrows = true;
    await until(() => heldOf(reg, a.chat) === null);
    await reg.shutdown();
  });
});

describe("a live chat whose session another process opens", () => {
  test("kitespan's turn finishes (no Stop), then its process ends as the idle timer would: a close, and no exit line", async () => {
    const { reg, driver } = await setup();
    const { sid, chat } = await chatOnSession(reg, driver);
    const page = new RecordingViewer();
    await reg.attach(chat, page);
    const m1 = send(chat, "first");
    expect((await apply(reg, m1)).ok).toBe(true);
    const c = driver.last;
    c.emit({ k: "block", key: "b1", kind: "text", text: "Half of the answer", parent: null });
    await until(() => reg.stateOf(chat) === "running");
    driver.openNow.set(sid, { app: "desktop", busy: true });
    await until(() => heldOf(reg, chat) !== null);
    await Bun.sleep(60);
    expect(c.calls).not.toContain("interrupt");
    expect(c.closed).toBe(false);
    expect(reg.stateOf(chat)).toBe("running");
    c.emit(turnEnd(m1.uuid));
    await until(() => c.closed && reg.stateOf(chat) === "sleeping");
    expect(page.of("turn_end")).toEqual([expect.objectContaining({ ok: true, subtype: "success" })]);
    expect(page.of("exit")).toHaveLength(0);
    expect(c.calls).not.toContain("interrupt");
    expect(driver.opens).toHaveLength(1);
    await reg.shutdown();
  });

  test("an idle live chat with a viewer ends its process at once (a viewer keeps the idle timer away, not the hold)", async () => {
    const { reg, driver } = await setup();
    const { sid, chat } = await chatOnSession(reg, driver);
    autoReply(driver);
    const page = new RecordingViewer();
    await reg.attach(chat, page);
    await apply(reg, send(chat, "first"));
    await until(() => reg.stateOf(chat) === "idle");
    driver.openNow.set(sid, { app: "terminal", busy: false });
    await until(() => driver.last.closed && reg.stateOf(chat) === "sleeping");
    expect(page.of("exit")).toHaveLength(0);
    await reg.shutdown();
  });

  test("queued messages wait: one in Claude Code's queue is taken back from it and stays Queued; after the hold a new start resumes and sends it", async () => {
    const { reg, driver, store } = await setup();
    const { sid, chat } = await chatOnSession(reg, driver);
    const page = new RecordingViewer();
    await reg.attach(chat, page);
    const m1 = send(chat, "first");
    const m2 = send(chat, "second");
    await apply(reg, m1);
    expect(await apply(reg, m2)).toEqual({ ok: true, result: { queued: false } });
    const c = driver.last;
    expect(c.sent.map((s) => s.uuid)).toEqual([m1.uuid, m2.uuid]);
    driver.openNow.set(sid, { app: "terminal", busy: true });
    await until(() => c.calls.includes(`takeBack:${m2.uuid}`));
    c.emit(turnEnd(m1.uuid));
    await until(() => c.closed && reg.stateOf(chat) === "sleeping");
    // It never went back to the draft: its row stays, Queued.
    expect(page.of("taken_back").map((e) => e.uuid)).not.toContain(m2.uuid);
    expect(page.of("user").filter((e) => e.uuid === m2.uuid).at(-1)).toMatchObject({ queued: true });
    expect(reg.draftOf(chat)?.text ?? "").not.toContain("second");
    expect(store.drafts.get(chat)?.text ?? "").not.toContain("second");
    // A page that opens the chat now gets it in the snapshot's tail, still Queued.
    const late = new RecordingViewer("tab_b");
    const p = await reg.attach(chat, late);
    expect(p!.tail.map((i) => i.e).filter((e) => e.k === "user" && e.uuid === m2.uuid).at(-1)).toMatchObject({ queued: true });
    expect(driver.opens).toHaveLength(1);
    autoReply(driver);
    driver.openNow.delete(sid);
    await until(() => driver.opens.length === 2);
    expect(driver.last.input.resume?.value).toBe(sid);
    await until(() => driver.last.sent.some((s) => s.uuid === m2.uuid));
    await until(() => page.of("user").filter((e) => e.uuid === m2.uuid).at(-1)?.queued === false);
    expect(heldOf(reg, chat)).toBeNull();
    await reg.shutdown();
  });

  test("R20: a held chat's queued message survives a restart (Not sent, nothing starts while held) and goes at the hold's end", async () => {
    const { reg, driver, store } = await setup();
    const { sid, chat } = await chatOnSession(reg, driver);
    const m1 = send(chat, "first");
    const m2 = send(chat, "second");
    await apply(reg, m1);
    await apply(reg, m2);
    const c = driver.last;
    driver.openNow.set(sid, { app: "terminal", busy: true });
    await until(() => c.calls.includes(`takeBack:${m2.uuid}`));
    c.emit(turnEnd(m1.uuid));
    await until(() => c.closed && reg.stateOf(chat) === "sleeping");
    expect(store.queues.get(chat)?.msgs.map((m) => m.uuid)).toEqual([m2.uuid]);
    await reg.shutdown();
    // The next server, while the terminal still has the session open: held at once, the message waits Not sent, and
    // neither a resume nor Send again starts anything.
    const next = new ChatRegistry({ driver, store, bash: new FakeBash() }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500, openCheckMs: 15, openFastMs: 15 });
    await next.boot();
    await until(() => heldOf(next, chat) !== null);
    const page = new RecordingViewer();
    const p = (await next.attach(chat, page))!;
    expect(p.tail.map((i) => i.e).filter((e) => e.k === "user" && e.uuid === m2.uuid).at(-1)).toMatchObject({ queued: true, notSent: true });
    expect(await apply(next, { t: "send_queued", rid: rid(), chat })).toEqual({ ok: false, code: "session_held" });
    expect(driver.opens).toHaveLength(1);
    // The hold's end sends it on a start that resumes the session (row 78), and the page reads the history again.
    autoReply(driver);
    driver.openNow.delete(sid);
    await until(() => driver.opens.length === 2);
    expect(driver.last.input.resume?.value).toBe(sid);
    await until(() => driver.last.sent.some((s) => s.uuid === m2.uuid));
    await until(() => page.of("user").filter((e) => e.uuid === m2.uuid).at(-1)?.queued === false);
    expect(page.of("user").filter((e) => e.uuid === m2.uuid).at(-1)?.notSent).toBeUndefined();
    await next.shutdown();
  });

  test("a queued message can still be taken back while held: its text goes to the draft, and the hold's end sends nothing", async () => {
    const { reg, driver } = await setup();
    const { sid, chat } = await chatOnSession(reg, driver);
    const page = new RecordingViewer();
    await reg.attach(chat, page);
    const m1 = send(chat, "first");
    const m2 = send(chat, "second");
    await apply(reg, m1);
    await apply(reg, m2);
    const c = driver.last;
    driver.openNow.set(sid, { app: "terminal", busy: false });
    await until(() => c.calls.includes(`takeBack:${m2.uuid}`));
    c.emit(turnEnd(m1.uuid));
    await until(() => c.closed && reg.stateOf(chat) === "sleeping");
    expect(await apply(reg, { t: "take_back", rid: rid(), chat, uuid: m2.uuid })).toEqual({ ok: true, result: { cancelled: true } });
    await until(() => reg.draftOf(chat)?.text === "second");
    expect(page.of("taken_back").map((e) => e.uuid)).toContain(m2.uuid);
    driver.openNow.delete(sid);
    await until(() => heldOf(reg, chat) === null);
    await Bun.sleep(60);
    expect(driver.opens).toHaveLength(1);
    await reg.shutdown();
  });

  test("a `!` command and the message behind it, sent during kitespan's turn, wait for the start after the hold too", async () => {
    const { reg, driver, store, bash } = await setup();
    store.settingsValue = { ...store.settingsValue, "chats.bashReply": "never" };
    await reg.reloadSettings();
    const { sid, chat } = await chatOnSession(reg, driver);
    const page = new RecordingViewer();
    await reg.attach(chat, page);
    const m1 = send(chat, "first");
    await apply(reg, m1);
    const cmd = rid();
    expect((await apply(reg, { t: "bash", rid: cmd, chat, input: "ls", draftRev: null, uploads: [] })).ok).toBe(true);
    const m3 = send(chat, "third");
    expect((await apply(reg, m3)).ok).toBe(true);
    const c = driver.last;
    driver.openNow.set(sid, { app: "terminal", busy: false });
    await until(() => heldOf(reg, chat) !== null);
    c.emit(turnEnd(m1.uuid));
    await until(() => c.closed && reg.stateOf(chat) === "sleeping");
    expect(bash.runs).toHaveLength(0);
    expect(page.of("bash").filter((e) => e.state === "not_run")).toHaveLength(0);
    expect(page.of("taken_back").map((e) => e.uuid)).not.toContain(m3.uuid);
    autoReply(driver);
    driver.openNow.delete(sid);
    await until(() => driver.opens.length === 2);
    await until(() => driver.last.sent.some((s) => s.uuid === m3.uuid));
    expect(bash.runs.map((r) => r.command)).toEqual(["ls"]);
    expect(driver.last.bashRecords.map((r) => r.uuid)).toEqual([cmd]);
    await reg.shutdown();
  });

  test("the hold ends while kitespan's turn still runs: its process still ends after the turn, and a message sent meanwhile waits for the next start", async () => {
    const { reg, driver } = await setup();
    const { sid, chat } = await chatOnSession(reg, driver);
    const m1 = send(chat, "first");
    await apply(reg, m1);
    const c = driver.last;
    driver.openNow.set(sid, { app: "terminal", busy: false });
    await until(() => heldOf(reg, chat) !== null);
    driver.openNow.delete(sid);
    await until(() => heldOf(reg, chat) === null);
    const m2 = send(chat, "second");
    expect(await apply(reg, m2)).toEqual({ ok: true, result: { queued: true } });
    expect(c.sent.map((s) => s.uuid)).toEqual([m1.uuid]);
    autoReply(driver);
    c.emit(turnEnd(m1.uuid));
    await until(() => driver.opens.length === 2);
    expect(c.closed).toBe(true);
    expect(driver.last.input.resume?.value).toBe(sid);
    await until(() => driver.last.sent.some((s) => s.uuid === m2.uuid));
    await reg.shutdown();
  });

  test("a start that waits for a free slot: its message stays Queued and the slot line goes; after the hold it starts", async () => {
    const { reg, driver } = await setup({ maxLive: 1 });
    const a = await chatOnSession(reg, driver, "Busy one");
    const b = await chatOnSession(reg, driver, "Waiting one");
    const pageB = new RecordingViewer();
    await reg.attach(b.chat, pageB);
    const ma = send(a.chat, "keep busy");
    await apply(reg, ma);
    const ca = driver.last;
    const mb = send(b.chat, "wait for a slot");
    expect(await apply(reg, mb)).toEqual({ ok: true, result: { queued: true } });
    const slotLine = pageB.of("notice").find((e) => e.id);
    expect(slotLine).toBeDefined();
    driver.openNow.set(b.sid, { app: "terminal", busy: false });
    await until(() => heldOf(reg, b.chat) !== null);
    await until(() => pageB.of("taken_back").some((e) => e.uuid === slotLine!.id));
    expect(pageB.of("taken_back").map((e) => e.uuid)).not.toContain(mb.uuid);
    autoReply(driver);
    ca.emit(turnEnd(ma.uuid));
    await until(() => reg.stateOf(a.chat) === "idle");
    await Bun.sleep(40);
    // A's process stays: nothing waits for its slot while B is held.
    expect(ca.closed).toBe(false);
    expect(driver.opens).toHaveLength(1);
    driver.openNow.delete(b.sid);
    await until(() => driver.opens.length === 2);
    expect(ca.closed).toBe(true);
    expect(driver.last.input.resume?.value).toBe(b.sid);
    await until(() => driver.last.sent.some((s) => s.uuid === mb.uuid));
    await reg.shutdown();
  });
});

describe("Continue in a copy from a held chat (row 78)", () => {
  test("makes one copy of the session (a fork), and a second press opens that copy; Continue here opens the chat itself", async () => {
    const { reg, driver } = await setup();
    const { sid, chat } = await chatOnSession(reg, driver);
    driver.openNow.set(sid, { app: "terminal", busy: false });
    await until(() => heldOf(reg, chat) !== null);
    const copy = chatOf(await apply(reg, cont(sid, true)));
    expect(copy).not.toBe("");
    expect(copy).not.toBe(chat);
    expect(driver.forks).toHaveLength(1);
    expect(driver.forks[0]).toMatchObject({ sessionId: sid, title: "Copy of Plan the release" });
    expect(chatOf(await apply(reg, cont(sid, true)))).toBe(copy);
    expect(driver.forks).toHaveLength(1);
    expect(chatOf(await apply(reg, cont(sid)))).toBe(chat);
    // The copy's own session is not open elsewhere: it is not held, and it starts.
    await until(() => driver.openReads > 3);
    expect(heldOf(reg, copy)).toBeNull();
    autoReply(driver);
    expect((await apply(reg, send(copy, "go on here"))).ok).toBe(true);
    expect(driver.last.input.resume?.value).toBe(driver.forks[0]!.id);
    await reg.shutdown();
  });
});

describe("how often the registry is read (row 78)", () => {
  test("about every 2 s while a chat has a viewer or a live process, else the slow check (both scaled down here)", async () => {
    const { reg, driver } = await setup({ openCheckMs: 2_000, openFastMs: 20 });
    const { chat } = await chatOnSession(reg, driver);
    await Bun.sleep(60);
    let from = driver.openReads;
    await Bun.sleep(200);
    expect(driver.openReads - from).toBeLessThanOrEqual(1);
    const page = new RecordingViewer();
    await reg.attach(chat, page);
    from = driver.openReads;
    await Bun.sleep(200);
    expect(driver.openReads - from).toBeGreaterThanOrEqual(4);
    reg.detach(chat, page);
    await Bun.sleep(40);
    from = driver.openReads;
    await Bun.sleep(200);
    expect(driver.openReads - from).toBeLessThanOrEqual(1);
    // A live process (no viewer) keeps the fast check too.
    autoReply(driver);
    await apply(reg, send(chat, "go"));
    await until(() => reg.stateOf(chat) === "idle");
    from = driver.openReads;
    await Bun.sleep(200);
    expect(driver.openReads - from).toBeGreaterThanOrEqual(4);
    await reg.shutdown();
  });
});
