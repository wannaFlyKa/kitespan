// Chat actions (DESIGN.md 4.3, 6.3, 6.6, 6.9, 6.10; BUILD-BRIEF D48, D49, D50): send with the upload references, the
// queue, Stop (it keeps the queue), Take back, stop a task, the pickers (remembered per project, Plan never), rename
// and the titles, Archive (idle: close at once; busy: Stop and archive), Delete (the process, then the transcript,
// then the store), the server's drafts, `!` commands, Continue here and the reads.
import { describe, expect, test } from "bun:test";
import { ERROR_MESSAGES, type BashFrame, type ChatDelta, type ChatEvent, type DraftEditFrame, type NewChatFrame, type PermissionCard, type SendFrame } from "../../shared/protocol";
import { MARK_RE } from "../../server/agents/types";
import { CAP_NOTICE, ChatRegistry } from "../../server/chats/registry";
import {
  FakeBash,
  FakeDriver,
  MemoryStore,
  RecordingViewer,
  apply,
  autoReply,
  projectRecord,
  settle,
  uploadRecord,
} from "../../server/chats/testing";
import type { RegistryOptions } from "../../server/chats/types";

const PROJECT = "k3m7q2x4ab";
const UP1 = "abcdefghijklmnop";
const UP2 = "qrstuvwxyz234567";
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

function bashFrame(chat: string, input: string, over: Partial<BashFrame> = {}): BashFrame {
  return { t: "bash", rid: rid(), chat, input, draftRev: null, uploads: [], ...over };
}

function draft(chat: string, text: string, over: Partial<DraftEditFrame> = {}): DraftEditFrame {
  return { t: "draft", chat, text, mode: "chat", command: null, link: false, uploads: [], ...over };
}

const turnEnd = (uuids: string[] = []): ChatEvent => ({ k: "turn_end", ok: true, subtype: "success", durationMs: 3, error: null, uuids });
/** The `bash` event of a `!` command that never ran (Not run). */
const notRun = (uuid: string, input: string): ChatEvent => ({ k: "bash", uuid, input, state: "not_run", stdout: "", stderr: "", code: null, ms: null, timedOut: false, capped: false });
const rows = (events: readonly ChatEvent[]) => events.flatMap((e) => (e.k === "bash" ? [[e.uuid, e.state]] : []));

/** The next server life over the same disk (the store) and the same Claude Code sessions (the driver). */
async function restart(reg: ChatRegistry, driver: FakeDriver, store: MemoryStore, bash: FakeBash, opts: RegistryOptions = {}): Promise<ChatRegistry> {
  await reg.shutdown();
  const next = new ChatRegistry({ driver, store, bash }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500, ...opts });
  await next.boot();
  return next;
}

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
  input: { command: "ls" },
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  sessionRule: true,
  parent: null,
});

/** A chat whose first turn has ended, with a viewer attached. */
async function idleChat(reg: ChatRegistry, driver: FakeDriver, tab = "tab_a") {
  const chat = await newChat(reg, "first");
  const c = driver.last;
  c.emit(turnEnd());
  await settle();
  const v = new RecordingViewer(tab);
  await reg.attach(chat, v);
  return { chat, c, v };
}

describe("send (D50)", () => {
  test("the server adds each upload chip's reference to the message: @ and the path, quoted when it has a space", async () => {
    const { reg, driver, store } = await setup();
    const { chat, c, v } = await idleChat(reg, driver);
    store.uploads.set(UP1, uploadRecord(UP1, chat, PROJECT, "my notes.txt"));
    store.uploads.set(UP2, uploadRecord(UP2, chat, PROJECT, "red.png"));
    expect(await apply(reg, send(chat, "look at these", { uploads: [UP1, UP2] }))).toEqual({ ok: true, result: { queued: false } });
    const text = 'look at these @"/tmp/kitespan-uploads-test/u-abcdef/my notes.txt" @/tmp/kitespan-uploads-test/u-abcdef/red.png';
    expect(c.sent[1]!.text).toBe(text);
    expect(v.of("user").map((e) => e.text)).toEqual([text]);
    // Sent during the turn: on Claude Code's queue (the user event says Queued); the ack's `queued` is the cap's.
    expect(await apply(reg, send(chat, "only the file", { uploads: [UP1] }))).toEqual({ ok: true, result: { queued: false } });
    expect(c.sent[2]!.text).toBe('only the file @"/tmp/kitespan-uploads-test/u-abcdef/my notes.txt"');
    expect(v.of("user").map((e) => e.queued)).toEqual([false, true]);
  });

  test("an upload that is not this chat's (removed, or another chat's) is refused with the file's line, and nothing is sent", async () => {
    const { reg, driver, store, bash } = await setup();
    const { chat, c } = await idleChat(reg, driver);
    store.uploads.set(UP1, uploadRecord(UP1, "zzzzzzzzzzzzzzzzzzzz", PROJECT));
    expect(await apply(reg, send(chat, "x", { uploads: [UP1] }))).toEqual({ ok: false, code: "upload_gone" });
    expect(await apply(reg, send(chat, "x", { uploads: [UP2] }))).toEqual({ ok: false, code: "upload_gone" });
    expect(c.sent.length).toBe(1);
    // Removed from Uploads on another page while this box still showed its chip: a `!` command too.
    store.uploads.set(UP2, uploadRecord(UP2, chat, PROJECT));
    await store.removeUpload(UP2);
    expect(await apply(reg, bashFrame(chat, "wc -c", { uploads: [UP2] }))).toEqual({ ok: false, code: "upload_gone" });
    expect(await apply(reg, send(chat, "!echo hi", { uploads: [UP2] }))).toEqual({ ok: false, code: "upload_gone" });
    expect(bash.runs).toEqual([]);
    expect(ERROR_MESSAGES.upload_gone).toBe("A file in the message box is not there any more. Remove it and try again.");
  });

  test("new_chat claims the form's uploads and its first message names them", async () => {
    const { reg, driver, store } = await setup();
    store.uploads.set(UP1, uploadRecord(UP1, null, PROJECT, "plan.md"));
    const chat = await newChat(reg, "Read this", { uploads: [UP1] });
    expect(store.uploads.get(UP1)!.chat).toBe(chat);
    expect(driver.last.sent[0]!.text).toBe("Read this @/tmp/kitespan-uploads-test/u-abcdef/plan.md");
    expect(await apply(reg, newChatFrame("again", { uploads: [UP1] }))).toEqual({ ok: false, code: "upload_gone" });
    // A name with a space and a double quote has no @ form that Claude Code attaches: the path goes as text.
    store.uploads.set(UP2, uploadRecord(UP2, null, PROJECT, 'say "hi" now.md'));
    await newChat(reg, "And this", { uploads: [UP2] });
    expect(driver.last.sent[0]!.text).toBe('And this `/tmp/kitespan-uploads-test/u-abcdef/say "hi" now.md`');
  });

  test("an unknown chat is not_found; a resent message (same uuid) is applied once", async () => {
    const { reg, driver } = await setup();
    const { chat, c } = await idleChat(reg, driver);
    expect(await apply(reg, send("zzzzzzzzzzzzzzzzzzzz", "x"))).toEqual({ ok: false, code: "not_found" });
    const f = send(chat, "once");
    await apply(reg, f);
    await apply(reg, f);
    expect(c.sent.filter((s) => s.uuid === f.uuid).length).toBe(1);
  });

  test("with no usable claude, Start refuses and makes no chat (6.9)", async () => {
    const { reg, driver, store } = await setup();
    driver.probeResult = { ...driver.probeResult, ok: false, path: null, realpath: null, version: null };
    expect(await apply(reg, newChatFrame("hello"))).toEqual({ ok: false, code: "no_claude" });
    expect(reg.list()).toEqual([]);
    expect(store.chats.size).toBe(0);
    expect(reg.claudeStatus.ok).toBe(false);
  });

  test("a start whose spawn fails keeps the chat and puts the message back in its draft", async () => {
    const { reg, driver } = await setup();
    driver.openThrows = true;
    const o = await apply(reg, newChatFrame("keep my words"));
    expect(o.ok).toBe(true);
    const chat = (o as { result: { chat: string } }).result.chat;
    const v = new RecordingViewer();
    const p = (await reg.attach(chat, v))!;
    expect(p.attached.draft.text).toBe("keep my words");
    expect(p.tail.map((i) => i.e.k)).toEqual(["notice"]);
    expect(reg.stateOf(chat)).toBe("sleeping");
  });
});

describe("the queue and Stop", () => {
  test("a message sent during a turn is queued; Stop answers with stillQueued and keeps the queue", async () => {
    const { reg, driver } = await setup();
    const chat = await newChat(reg, "long task");
    const c = driver.last;
    const v = new RecordingViewer();
    const p = (await reg.attach(chat, v))!;
    const turnSeq = p.tail.find((i) => i.e.k === "turn_start")!.seq;
    const m2 = send(chat, "and then this");
    await apply(reg, m2);
    expect(v.of("user")).toEqual([{ k: "user", uuid: m2.uuid, text: "and then this", queued: true, mentions: [] }]);
    const asked = c.ask(permission("toolu_1"));
    await settle();
    c.interruptResult = { stillQueued: [m2.uuid] };
    expect(await apply(reg, { t: "interrupt", rid: rid(), chat, turn: turnSeq + 1 })).toEqual({ ok: false, code: "stale" });
    expect(await apply(reg, { t: "interrupt", rid: rid(), chat, turn: turnSeq })).toEqual({ ok: true, result: { stillQueued: [m2.uuid] } });
    expect(await asked.answer).toBeNull();
    expect(v.of("card_close")).toEqual([{ k: "card_close", id: "toolu_1", why: "cancelled", answer: "cancelled" }]);
    expect(await apply(reg, { t: "interrupt", rid: rid(), chat, turn: turnSeq })).toEqual({ ok: false, code: "stale" });
    expect(c.calls.filter((x) => x === "interrupt").length).toBe(1);
    // The CLI ends the stopped turn and starts the queued message.
    c.emit(turnEnd(), { k: "turn_start", by: "user" });
    await settle();
    expect(v.of("user").map((e) => e.queued)).toEqual([true, false]);
    expect(await apply(reg, { t: "interrupt", rid: rid(), chat, turn: turnSeq })).toEqual({ ok: false, code: "stale" });
  });
});

describe("a resend after a server restart (4.3)", () => {
  /** A server's life on a shared store: as setup(), with the same driver, store and `!` runner every time. */
  async function life(driver: FakeDriver, store: MemoryStore, bash: FakeBash, opts: RegistryOptions = {}) {
    const reg = new ChatRegistry({ driver, store, bash }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500, ...opts });
    await reg.boot();
    return reg;
  }

  test("a new chat, a message and a `!` command whose acks were lost are not applied again by the next server", async () => {
    const driver = new FakeDriver();
    const store = new MemoryStore();
    const bash = new FakeBash();
    store.projects = [projectRecord(PROJECT)];
    const one = await life(driver, store, bash);
    const first = newChatFrame("first");
    const made = await apply(one, first);
    const chat = (made as { result: { chat: string } }).result.chat;
    driver.last.emit(turnEnd([first.uuid]));
    await settle();
    const msg = send(chat, "say it again");
    expect(await apply(one, msg)).toEqual({ ok: true, result: { queued: false } });
    driver.last.emit(turnEnd([msg.uuid]));
    await settle();
    const cmd = bashFrame(chat, "make");
    expect(await apply(one, cmd)).toEqual({ ok: true, result: null });
    await settle(10);
    expect(bash.runs.length).toBe(1);
    await one.shutdown();

    // The next server on the same store; the page's outbox sends the three frames again, with the same ids.
    const two = await life(driver, store, bash);
    const opens = driver.opens.length;
    expect(await apply(two, first)).toEqual({ ok: true, result: { chat } });
    expect(await apply(two, msg)).toEqual({ ok: true, result: { queued: false } });
    expect(await apply(two, cmd)).toEqual({ ok: true, result: null });
    await settle(10);
    expect(driver.opens.length).toBe(opens);
    expect(bash.runs.length).toBe(1);
    expect(two.list().map((r) => r.chat)).toEqual([chat]);
    // A message the page had not sent before goes as always.
    const next = send(chat, "a new one");
    expect(await apply(two, next)).toEqual({ ok: true, result: { queued: false } });
    expect(driver.last.sent.map((s) => s.uuid)).toEqual([next.uuid]);
  });

  test("R10: Continue in a copy whose ack was lost makes one copy, also when the resend reaches the next server", async () => {
    const driver = new FakeDriver();
    const store = new MemoryStore();
    const bash = new FakeBash();
    store.projects = [projectRecord(PROJECT)];
    const sid = rid();
    driver.transcript(sid, "Plan the release");
    const one = await life(driver, store, bash);
    const frame = { t: "continue_session" as const, rid: rid(), project: PROJECT, session: sid, fork: true };
    const made = await apply(one, frame);
    const copy = (made as { result: { chat: string } }).result.chat;
    expect(await apply(one, frame)).toEqual({ ok: true, result: { chat: copy } });
    await one.shutdown();
    const two = await life(driver, store, bash);
    expect(await apply(two, frame)).toEqual({ ok: true, result: { chat: copy } });
    expect(driver.forks).toHaveLength(1);
    expect(two.list().map((r) => r.chat)).toEqual([copy]);
    // Another press (a new rid) makes the next copy, numbered.
    expect((await apply(two, { ...frame, rid: rid() })).ok).toBe(true);
    expect(driver.forks).toHaveLength(2);
  });

  test("a message that only waited for a free slot when the server stopped is Not sent for the next server (L6), and a resend of it is not sent as well", async () => {
    const driver = new FakeDriver();
    const store = new MemoryStore();
    const bash = new FakeBash();
    store.projects = [projectRecord(PROJECT)];
    const one = await life(driver, store, bash, { maxLive: 1 });
    const busy = await newChat(one, "busy");
    await one.attach(busy, new RecordingViewer());
    driver.last.emit(turnEnd());
    await settle();
    const other = await newChat(one, "other");
    expect(driver.opens.length).toBe(1);
    const waits = send(other, "for the slot");
    expect(await apply(one, waits)).toEqual({ ok: true, result: { queued: true } });
    await one.shutdown();
    const two = await life(driver, store, bash, { maxLive: 1 });
    await settle();
    // The chat's first message and the one sent after it never reached Claude Code: both wait, Not sent, in send
    // order, and the box is as it was.
    const p = (await two.attach(other, new RecordingViewer()))!;
    expect(p.attached.draft.text).toBe("");
    expect(p.tail.map((i) => i.e).filter((e) => e.k === "user").map((e) => [(e as { text: string }).text, (e as { notSent?: boolean }).notSent])).toEqual([
      ["other", true],
      ["for the slot", true],
    ]);
    expect(await apply(two, waits)).toEqual({ ok: true, result: { queued: true } });
    await settle(10);
    expect(driver.opens.length).toBe(1);
  });
});

describe("one Stop, one end on every page (D49)", () => {
  const cliStopped: ChatEvent = { k: "turn_end", ok: false, subtype: "error_during_execution", durationMs: 9, error: "error_during_execution", uuids: [] };
  const interrupted: ChatEvent = { k: "turn_end", ok: false, subtype: "interrupted", durationMs: 9, error: null, uuids: [] };

  test("the turn that a page stopped ends as interrupted, with no error, for every page; a turn that fails by itself keeps its error", async () => {
    const { reg, driver } = await setup();
    const chat = await newChat(reg, "long task");
    const c = driver.last;
    const a = new RecordingViewer("tab_a");
    const b = new RecordingViewer("tab_b");
    const turnSeq = (await reg.attach(chat, a))!.tail.find((i) => i.e.k === "turn_start")!.seq;
    await reg.attach(chat, b);
    expect(await apply(reg, { t: "interrupt", rid: rid(), chat, turn: turnSeq }, { tab: "tab_a" })).toEqual({ ok: true, result: { stillQueued: null } });
    // The CLI ends the stopped turn as an error of its own.
    c.emit(cliStopped);
    await settle();
    expect(a.of("turn_end")).toEqual([interrupted]);
    expect(b.of("turn_end")).toEqual([interrupted]);
    // A page that attaches later reads the same end in the ring.
    const late = (await reg.attach(chat, new RecordingViewer("tab_c")))!;
    expect(late.tail.filter((i) => i.e.k === "turn_end").map((i) => i.e)).toEqual([]);
    expect(reg.stateOf(chat)).toBe("idle");
    await apply(reg, send(chat, "again"));
    c.emit({ ...cliStopped, error: "API Error: 500" });
    await settle();
    expect(b.of("turn_end")[1]).toEqual({ ...cliStopped, error: "API Error: 500" });
  });

  test("Stop and archive ends the running turn as interrupted for a page that watches", async () => {
    const { reg, driver } = await setup();
    const chat = await newChat(reg, "long task");
    const c = driver.last;
    const b = new RecordingViewer("tab_b");
    await reg.attach(chat, b);
    const archived = apply(reg, { t: "archive", rid: rid(), chat, on: true, stop: true }, { tab: "tab_a" });
    c.emit(cliStopped);
    expect(await archived).toEqual({ ok: true, result: null });
    await settle(10);
    expect(b.of("turn_end")).toEqual([interrupted]);
  });
});

describe("Take back", () => {
  test("takes a queued message off Claude Code's queue and puts its text before the draft, on its own line", async () => {
    const { reg, driver, store } = await setup();
    const chat = await newChat(reg, "long task");
    const c = driver.last;
    const v = new RecordingViewer();
    await reg.attach(chat, v);
    store.uploads.set(UP1, uploadRecord(UP1, chat, PROJECT));
    const m2 = send(chat, "queued words", { uploads: [UP1] });
    await apply(reg, m2);
    await reg.draftEdit(draft(chat, "typed after"), "tab_b");
    expect(await apply(reg, { t: "take_back", rid: rid(), chat, uuid: m2.uuid })).toEqual({ ok: true, result: { cancelled: true } });
    expect(c.calls).toContain(`takeBack:${m2.uuid}`);
    expect(v.of("taken_back")).toEqual([{ k: "taken_back", uuid: m2.uuid }]);
    const d = v.drafts[v.drafts.length - 1]!;
    expect(d).toMatchObject({ text: "queued words\ntyped after", mode: "chat", uploads: [UP1], by: "tab_a" });
    expect(await apply(reg, { t: "take_back", rid: rid(), chat, uuid: m2.uuid })).toEqual({ ok: true, result: { cancelled: false } });
  });

  test("a taken-back message that starts with ! comes back as a message (chat mode) and not as link text", async () => {
    const { reg } = await setup();
    const chat = await newChat(reg, "long task");
    const v = new RecordingViewer();
    await reg.attach(chat, v);
    // The user typed "!" in front of the message text: the box kept chat mode, so it went as a message.
    const m2 = send(chat, "!echo TAKEN");
    await apply(reg, m2);
    expect(await apply(reg, { t: "take_back", rid: rid(), chat, uuid: m2.uuid })).toEqual({ ok: true, result: { cancelled: true } });
    expect(v.drafts[v.drafts.length - 1]).toMatchObject({ text: "!echo TAKEN", mode: "chat", command: null, link: false });
    // A plain message stays plain text.
    const m3 = send(chat, "plain words");
    await apply(reg, m3);
    await reg.draftEdit(draft(chat, ""), "tab_b");
    expect(await apply(reg, { t: "take_back", rid: rid(), chat, uuid: m3.uuid })).toEqual({ ok: true, result: { cancelled: true } });
    expect(v.drafts[v.drafts.length - 1]).toMatchObject({ text: "plain words", mode: "chat", link: false });
    // Text from a link that no one changed keeps its line when a taken-back message goes before it.
    const m4 = send(chat, "my own words");
    await apply(reg, m4);
    await reg.draftEdit(draft(chat, "text from a link", { link: true }), "tab_b");
    expect(await apply(reg, { t: "take_back", rid: rid(), chat, uuid: m4.uuid })).toEqual({ ok: true, result: { cancelled: true } });
    expect(v.drafts[v.drafts.length - 1]).toMatchObject({ text: "my own words\ntext from a link", mode: "chat", link: true });
  });

  test("once Claude Code started on it, Take back does nothing and the bubble stays", async () => {
    const { reg, driver } = await setup();
    const chat = await newChat(reg, "long task");
    const c = driver.last;
    const v = new RecordingViewer();
    await reg.attach(chat, v);
    const m2 = send(chat, "queued");
    await apply(reg, m2);
    c.takeBackResult = { cancelled: false };
    expect(await apply(reg, { t: "take_back", rid: rid(), chat, uuid: m2.uuid })).toEqual({ ok: true, result: { cancelled: false } });
    expect(v.of("taken_back")).toEqual([]);
  });

  test("SDK 0.3.322: a message that Claude Code held answers cancelled: false, and its drop later takes it back to the draft", async () => {
    // sdk.d.ts 0.3.322 line 4901: a held message gets a cancel-pending mark; the drain drops it later, with the
    // `command_lifecycle` frame `cancelled` (the `dropped` event).
    const { reg, driver, store } = await setup();
    const chat = await newChat(reg, "long task");
    const c = driver.last;
    const v = new RecordingViewer();
    await reg.attach(chat, v);
    const m2 = send(chat, "held words");
    await apply(reg, m2);
    await reg.draftEdit(draft(chat, "typed after"), "tab_b");
    c.takeBackResult = { cancelled: false };
    expect(await apply(reg, { t: "take_back", rid: rid(), chat, uuid: m2.uuid })).toEqual({ ok: true, result: { cancelled: false } });
    expect(v.of("taken_back")).toEqual([]);
    expect(store.queues.get(chat)?.msgs.map((m) => m.uuid)).toContain(m2.uuid);
    c.emit({ k: "dropped", uuid: m2.uuid });
    await settle(10);
    expect(v.of("taken_back")).toEqual([{ k: "taken_back", uuid: m2.uuid }]);
    expect(v.drafts[v.drafts.length - 1]).toMatchObject({ text: "held words\ntyped after", mode: "chat", by: "tab_a" });
    expect(store.queues.get(chat)?.msgs.map((m) => m.uuid) ?? []).not.toContain(m2.uuid);
    // It no longer waits: a turn's end that names nothing never draws it as taken in, and a second Take back finds nothing.
    c.emit(turnEnd([]));
    await settle(10);
    expect(v.of("user").filter((e) => e.uuid === m2.uuid && e.queued === false)).toEqual([]);
    expect(await apply(reg, { t: "take_back", rid: rid(), chat, uuid: m2.uuid })).toEqual({ ok: true, result: { cancelled: false } });
    expect(v.events.some((e) => (e as { k: string }).k === "dropped")).toBe(false);
  });

  test("a drop that no Take back asked for, or one after a turn took the message in, takes nothing back", async () => {
    const { reg, driver } = await setup();
    const chat = await newChat(reg, "long task");
    const c = driver.last;
    const v = new RecordingViewer();
    await reg.attach(chat, v);
    const m2 = send(chat, "queued one");
    const m3 = send(chat, "queued two");
    await apply(reg, m2);
    await apply(reg, m3);
    // Nobody asked: the CLI's own drop (for example of a turn that a Stop aborted) leaves the bubble and the draft.
    c.emit({ k: "dropped", uuid: m2.uuid });
    await settle(10);
    expect(v.of("taken_back")).toEqual([]);
    // Too late: the Take back answered false and the next turn took the message in; its drop (the aborted turn) is not a
    // Take back's.
    c.takeBackResult = { cancelled: false };
    expect(await apply(reg, { t: "take_back", rid: rid(), chat, uuid: m3.uuid })).toEqual({ ok: true, result: { cancelled: false } });
    c.emit(turnEnd([]), { k: "turn_start", by: "user" }, { k: "taken_in", uuids: [m2.uuid, m3.uuid] });
    c.emit({ k: "dropped", uuid: m3.uuid });
    await settle(10);
    expect(v.of("taken_back")).toEqual([]);
    expect(reg.draftOf(chat)?.text ?? "").not.toContain("queued two");
  });

  test("with a `!` or `/` command in the message box it takes nothing back; with no capability it is unsupported", async () => {
    const { reg, driver } = await setup();
    const chat = await newChat(reg, "long task");
    const m2 = send(chat, "queued");
    await apply(reg, m2);
    await reg.draftEdit(draft(chat, "git status", { mode: "bash" }), "tab_a");
    expect(await apply(reg, { t: "take_back", rid: rid(), chat, uuid: m2.uuid })).toEqual({ ok: false, code: "bad_request" });
    driver.caps.takeBack = false;
    const other = new ChatRegistry({ driver, store: new MemoryStore() });
    expect(other.capabilities.takeBack).toBe(false);
  });

  test("a message that waits for a free slot is taken back without Claude Code, and the free-slot line goes with the wait", async () => {
    const { reg, driver } = await setup({ maxLive: 1 });
    await newChat(reg, "busy one");
    const f = newChatFrame("waits");
    const chat = ((await apply(reg, f)) as { result: { chat: string } }).result.chat;
    const v = new RecordingViewer();
    const line = (await reg.attach(chat, v))!.tail.map((i) => i.e).find((e) => e.k === "notice") as Extract<ChatEvent, { k: "notice" }>;
    expect(line).toEqual({ k: "notice", text: CAP_NOTICE, id: expect.any(String) });
    expect(await apply(reg, { t: "take_back", rid: rid(), chat, uuid: f.uuid })).toEqual({ ok: true, result: { cancelled: true } });
    expect(v.of("taken_back")).toEqual([
      { k: "taken_back", uuid: line.id! },
      { k: "taken_back", uuid: f.uuid },
    ]);
    expect(driver.opens.length).toBe(1);
    const p = (await reg.attach(chat, new RecordingViewer()))!;
    expect(p.attached.draft.text).toBe("waits");
    driver.opens[0]!.emit(turnEnd());
    await settle(10);
    expect(driver.opens.length).toBe(1); // nothing is left to start
  });
});

describe("tasks", () => {
  test("Stop on a task works for a task id the chat has seen, and is stale after it is done", async () => {
    const { reg, driver } = await setup();
    const { chat, c } = await idleChat(reg, driver);
    expect(await apply(reg, { t: "stop_task", rid: rid(), chat, task: "t1" })).toEqual({ ok: false, code: "stale" });
    c.emit({ k: "task", ev: "started", taskId: "t1", toolUseId: "toolu_1", taskType: "local_bash", subagentType: null, description: "build", workflowName: null, background: true, prompt: null, parentTaskId: null });
    await settle();
    expect(await apply(reg, { t: "stop_task", rid: rid(), chat, task: "t1" })).toEqual({ ok: true, result: null });
    expect(c.calls).toContain("stopTask:t1");
    c.emit({ k: "task", ev: "done", taskId: "t1", toolUseId: "toolu_1", status: "stopped", summary: null, usage: null });
    await settle();
    expect(await apply(reg, { t: "stop_task", rid: rid(), chat, task: "t1" })).toEqual({ ok: false, code: "stale" });
  });

  test("Run in background: false on a sleeping chat, the driver's answer on a live one", async () => {
    const { reg, driver } = await setup();
    const { chat, c } = await idleChat(reg, driver);
    expect(await apply(reg, { t: "background", rid: rid(), chat, toolUse: "toolu_1" })).toEqual({ ok: true, result: { backgrounded: true } });
    c.end();
    await settle();
    expect(await apply(reg, { t: "background", rid: rid(), chat, toolUse: "toolu_1" })).toEqual({ ok: true, result: { backgrounded: false } });
  });
});

describe("the pickers (6.6, D11, D12)", () => {
  test("a pick goes to Claude Code, the chat's ledger (marked) and the project (remembered); picks follows the ack", async () => {
    const { reg, driver, store } = await setup();
    const { chat, c, v } = await idleChat(reg, driver);
    const o = await reg.request({ t: "set_model", rid: rid(), chat, value: "claude-haiku-5-5" }, { tab: "tab_a" });
    expect(o.ok).toBe(true);
    expect(c.calls).toContain("setModel:claude-haiku-5-5");
    expect(v.of("picks")).toEqual([]);
    if (o.ok) o.after?.();
    expect(v.of("picks")).toEqual([{ k: "picks", model: "claude-haiku-5-5", effort: null, mode: null }]);
    const led = store.chats.get(chat)!.picks.model!;
    expect(led.value).toBe("claude-haiku-5-5");
    expect(MARK_RE.exec(led.mark)?.[1]).toBe("the user's pick in this chat");
    const proj = store.projects[0]!.picks.model!;
    expect(MARK_RE.exec(proj.mark)?.[1]).toBe("remembered from the user's pick");
    await apply(reg, { t: "set_effort", rid: rid(), chat, value: "high" });
    await apply(reg, { t: "set_effort", rid: rid(), chat, value: null });
    expect(c.calls).toContain("setEffort:high");
    expect(c.calls).toContain("setEffort:null");
    expect(store.projects[0]!.picks.effort).toBeNull();
  });

  test("Plan applies to the current session only: never in the ledger or the project", async () => {
    const { reg, driver, store } = await setup();
    const { chat, c } = await idleChat(reg, driver);
    await apply(reg, { t: "set_mode", rid: rid(), chat, value: "acceptEdits" });
    await apply(reg, { t: "set_mode", rid: rid(), chat, value: "plan" });
    expect(c.calls).toContain("setMode:plan");
    expect(store.chats.get(chat)!.picks.permissionMode!.value).toBe("acceptEdits");
    expect(store.projects[0]!.picks.permissionMode!.value).toBe("acceptEdits");
    expect((await reg.attach(chat, new RecordingViewer()))!.attached.picks.mode).toBe("plan");
    c.end();
    await settle();
    expect((await reg.attach(chat, new RecordingViewer()))!.attached.picks.mode).toBe("acceptEdits");
    await apply(reg, send(chat, "go"));
    expect(driver.last.input.picks.permissionMode?.value).toBe("acceptEdits");
  });

  test("Plan picked on a sleeping chat is passed at its next start, marked as the user's pick", async () => {
    const { reg, driver } = await setup();
    const { chat, c } = await idleChat(reg, driver);
    c.end();
    await settle();
    await apply(reg, { t: "set_mode", rid: rid(), chat, value: "plan" });
    await apply(reg, send(chat, "plan it"));
    expect(driver.last.input.picks.permissionMode?.value).toBe("plan");
    expect(MARK_RE.exec(driver.last.input.picks.permissionMode!.mark)?.[1]).toBe("the user's pick in this chat");
  });

  test("a pick of no mode on a live chat sets the user's own defaultMode", async () => {
    const { reg, driver } = await setup();
    const { chat, c } = await idleChat(reg, driver);
    driver.agentSettings = { ...driver.agentSettings, defaultMode: "acceptEdits" };
    await apply(reg, { t: "set_mode", rid: rid(), chat, value: null });
    expect(c.calls).toContain("setMode:acceptEdits");
  });

  test("Bypass only with the Settings switch; the switch goes to the start marked", async () => {
    const { reg, driver, store } = await setup();
    const { chat } = await idleChat(reg, driver);
    expect(await apply(reg, { t: "set_mode", rid: rid(), chat, value: "bypassPermissions" })).toEqual({ ok: false, code: "bad_request" });
    expect(await apply(reg, newChatFrame("x", { picks: { model: null, effort: null, mode: "bypassPermissions" } }))).toEqual({ ok: false, code: "bad_request" });
    expect(driver.last.input.switches.allowBypass).toBeUndefined();
    store.settingsValue = { ...store.settingsValue, "chats.allowBypass": true };
    await reg.reloadSettings();
    await newChat(reg, "y", { picks: { model: null, effort: null, mode: "bypassPermissions" } });
    expect(driver.last.input.picks.permissionMode?.value).toBe("bypassPermissions");
    expect(MARK_RE.exec(driver.last.input.switches.allowBypass!.mark)?.[1]).toBe("the user allowed bypass permissions mode in Settings");
  });

  test("prompt suggestions are switched on only by the user's own setting", async () => {
    const { reg, driver } = await setup();
    await newChat(reg, "a");
    expect(driver.last.input.switches.promptSuggestions).toBeUndefined();
    driver.agentSettings = { ...driver.agentSettings, promptSuggestions: true };
    await newChat(reg, "b");
    expect(MARK_RE.exec(driver.last.input.switches.promptSuggestions!.mark)?.[1]).toBe("the user turned on prompt suggestions");
  });

  test("new chats start with the project's last picks (marked remembered), or the defaults when Settings say so", async () => {
    const { reg, driver, store } = await setup();
    store.projects[0]!.picks = {
      model: { value: "claude-opus-5-5", mark: "remembered from the user's pick on 2026-10-30T08:00:00.000Z" },
      effort: null,
      permissionMode: { value: "acceptEdits", mark: "remembered from the user's pick on 2026-10-30T08:00:00.000Z" },
    };
    await newChat(reg, "a");
    expect(driver.last.input.picks).toEqual({
      model: { value: "claude-opus-5-5", mark: "remembered from the user's pick on 2026-10-30T08:00:00.000Z" },
      permissionMode: { value: "acceptEdits", mark: "remembered from the user's pick on 2026-10-30T08:00:00.000Z" },
    });
    await newChat(reg, "b", { picks: { model: "claude-haiku-5-5", effort: "low", mode: null } });
    expect(driver.last.input.picks.model?.value).toBe("claude-haiku-5-5");
    expect(MARK_RE.exec(driver.last.input.picks.model!.mark)?.[1]).toBe("the user's pick in this chat");
    expect(store.projects[0]!.picks.model!.value).toBe("claude-haiku-5-5");
    store.settingsValue = { ...store.settingsValue, "chats.newChats": "defaults", "chats.rememberMode": false };
    await reg.reloadSettings();
    await newChat(reg, "c");
    expect(driver.last.input.picks).toEqual({});
    await newChat(reg, "d", { picks: { model: null, effort: null, mode: "auto" } });
    expect(store.projects[0]!.picks.permissionMode!.value).toBe("acceptEdits"); // Remember mode is off
  });
});

describe("rename and titles (D13)", () => {
  test("a rename goes through Claude Code's own renameSession, and the title event follows the ack", async () => {
    const { reg, driver, store, deltas } = await setup();
    autoReply(driver);
    const chat = await newChat(reg, "first");
    await settle();
    const sid = store.chats.get(chat)!.sessionId!;
    const v = new RecordingViewer();
    await reg.attach(chat, v);
    const before = deltas.length;
    const o = await reg.request({ t: "rename", rid: rid(), chat, title: "Flaky upload test" }, { tab: "tab_a" });
    expect(o.ok).toBe(true);
    expect(driver.renamed).toEqual([{ sessionId: sid, title: "Flaky upload test" }]);
    expect(v.of("title").filter((t) => t.from === "renamed")).toEqual([]);
    expect(deltas.slice(before).some((d) => "title" in d)).toBe(false);
    if (o.ok) o.after?.();
    expect(v.of("title").filter((t) => t.from === "renamed")).toEqual([{ k: "title", title: "Flaky upload test", from: "renamed" }]);
    expect(deltas.slice(before)).toContainEqual({ chat, title: "Flaky upload test" });
    expect(store.chats.get(chat)!.title).toEqual({ text: "Flaky upload test", from: "renamed" });
  });

  test("a rename of a live chat tells its Claude Code first (rename_session), then writes the transcript", async () => {
    const { reg, driver, store } = await setup();
    autoReply(driver);
    const chat = await newChat(reg, "first");
    await settle();
    const sid = store.chats.get(chat)!.sessionId!;
    driver.order.length = 0;
    expect(await apply(reg, { t: "rename", rid: rid(), chat, title: "Flaky upload test" })).toEqual({ ok: true, result: null });
    expect(driver.last.calls).toContain("rename:Flaky upload test");
    expect(driver.order).toEqual([`chat rename:${sid}`, `rename:${sid}`]);
    expect(driver.renamed).toEqual([{ sessionId: sid, title: "Flaky upload test" }]);
    // Claude Code then sends the new name (session_title_changed): the same name is no change.
    const v = new RecordingViewer();
    await reg.attach(chat, v);
    driver.last.emit({ k: "title", title: "Flaky upload test", from: "renamed" });
    await settle();
    expect(v.of("title")).toEqual([]);
    expect(store.chats.get(chat)!.title).toEqual({ text: "Flaky upload test", from: "renamed" });
  });

  test("a live chat whose Claude Code refuses the rename, or has no way to take one, still gets the transcript's name", async () => {
    const { reg, driver, store } = await setup();
    autoReply(driver);
    const chat = await newChat(reg, "first");
    await settle();
    const sid = store.chats.get(chat)!.sessionId!;
    driver.last.failNext.add("rename:Refused");
    expect(await apply(reg, { t: "rename", rid: rid(), chat, title: "Refused" })).toEqual({ ok: true, result: null });
    driver.last.renameTaken = false;
    expect(await apply(reg, { t: "rename", rid: rid(), chat, title: "Not taken" })).toEqual({ ok: true, result: null });
    expect(driver.renamed).toEqual([
      { sessionId: sid, title: "Refused" },
      { sessionId: sid, title: "Not taken" },
    ]);
    expect(store.chats.get(chat)!.title).toEqual({ text: "Not taken", from: "renamed" });
  });

  test("a live chat with no transcript yet: its Claude Code and the ledger take the name", async () => {
    const { reg, driver, store } = await setup();
    const chat = await newChat(reg, "first");
    expect(await apply(reg, { t: "rename", rid: rid(), chat, title: "Named early" })).toEqual({ ok: true, result: null });
    expect(driver.last.calls).toContain("rename:Named early");
    expect(driver.renamed).toEqual([]);
    expect(store.chats.get(chat)!.title).toEqual({ text: "Named early", from: "renamed" });
  });

  test("a sleeping chat's rename writes the transcript only", async () => {
    const { reg, driver, store, bash } = await setup();
    autoReply(driver);
    const chat = await newChat(reg, "first");
    await settle();
    const sid = store.chats.get(chat)!.sessionId!;
    const next = await restart(reg, driver, store, bash);
    const opened = driver.opens.length;
    driver.order.length = 0;
    expect(await apply(next, { t: "rename", rid: rid(), chat, title: "While asleep" })).toEqual({ ok: true, result: null });
    expect(driver.opens.length).toBe(opened);
    expect(driver.order).toEqual([`rename:${sid}`]);
    await next.shutdown();
  });

  test("a chat with no transcript yet keeps the name in its ledger", async () => {
    const { reg, driver, store } = await setup();
    const chat = await newChat(reg, "first");
    expect(await apply(reg, { t: "rename", rid: rid(), chat, title: "Named early" })).toEqual({ ok: true, result: null });
    expect(driver.renamed).toEqual([]);
    expect(store.chats.get(chat)!.title).toEqual({ text: "Named early", from: "renamed" });
  });

  test("the generated title comes once after the first reply, and never over a rename", async () => {
    const { reg, driver, store } = await setup();
    autoReply(driver);
    const chat = await newChat(reg, "help me plan the upload feature please");
    expect(store.chats.get(chat)!.title).toEqual({ text: "help me plan the upload feature please", from: "first-prompt" });
    driver.last.title = "Upload feature plan";
    await settle();
    expect(store.chats.get(chat)!.title).toEqual({ text: "Upload feature plan", from: "generated" });
    await apply(reg, send(chat, "more"));
    await settle();
    expect(driver.last.calls.filter((x) => x === "generateTitle").length).toBe(1);
    await apply(reg, { t: "rename", rid: rid(), chat, title: "Mine" });
    driver.last.emit({ k: "title", title: "Something else", from: "generated" });
    await settle();
    expect(store.chats.get(chat)!.title).toEqual({ text: "Mine", from: "renamed" });
  });

  test("a /rename typed in the chat is the user's own rename: the ledger, every page's row, a page that comes later", async () => {
    const { reg, driver, store, deltas } = await setup();
    autoReply(driver);
    const chat = await newChat(reg, "help me plan the upload feature please");
    driver.last.title = "Upload feature plan";
    await settle();
    expect(store.chats.get(chat)!.title).toEqual({ text: "Upload feature plan", from: "generated" });
    const v = new RecordingViewer();
    await reg.attach(chat, v);
    const before = deltas.length;
    // "/rename Probe title 42": Claude Code sends the name (events.ts: a rename), then its own output row.
    driver.last.emit({ k: "title", title: "Probe title 42", from: "renamed" }, { k: "local_output", stream: "stdout", text: "Session renamed to: Probe title 42" });
    await settle();
    expect(store.chats.get(chat)!.title).toEqual({ text: "Probe title 42", from: "renamed" });
    expect(v.of("title")).toEqual([{ k: "title", title: "Probe title 42", from: "renamed" }]);
    expect(v.of("local_output")).toEqual([{ k: "local_output", stream: "stdout", text: "Session renamed to: Probe title 42" }]);
    // Every page's chat list (the sidebar and Recent), attached or not.
    expect(deltas.slice(before)).toContainEqual(expect.objectContaining({ chat, title: "Probe title 42" }));
    expect(reg.list().find((r) => r.chat === chat)!.title).toBe("Probe title 42");
    const late = await reg.attach(chat, new RecordingViewer("tab_b"));
    expect(late!.attached.title).toEqual({ text: "Probe title 42", from: "renamed" });
  });

  test("a /rename wins over every title before it, a rename in kitespan too; a repeated name is no change", async () => {
    const { reg, driver, store, deltas } = await setup();
    autoReply(driver);
    const chat = await newChat(reg, "first");
    await settle();
    await apply(reg, { t: "rename", rid: rid(), chat, title: "Mine" });
    const v = new RecordingViewer();
    await reg.attach(chat, v);
    driver.last.emit({ k: "title", title: "Typed name", from: "renamed" });
    await settle();
    expect(store.chats.get(chat)!.title).toEqual({ text: "Typed name", from: "renamed" });
    expect(v.of("title")).toEqual([{ k: "title", title: "Typed name", from: "renamed" }]);
    // Claude Code sends the same name again (at a start, or after a change of its own): no event, no delta.
    const before = deltas.length;
    driver.last.emit({ k: "title", title: " Typed\tname ", from: "renamed" });
    await settle();
    expect(v.of("title")).toHaveLength(1);
    expect(deltas.slice(before).some((d) => "title" in d)).toBe(false);
    // kitespan's own Rename after it wins in turn.
    await apply(reg, { t: "rename", rid: rid(), chat, title: "Mine again" });
    expect(store.chats.get(chat)!.title).toEqual({ text: "Mine again", from: "renamed" });
  });

  test("an automatic title never replaces a /rename: kitespan's own after the first reply, or one from Claude Code", async () => {
    const { reg, driver, store } = await setup();
    // The chat's first message is the /rename: the name comes before the turn's end, then kitespan asks for a title.
    driver.script = (c, turn) =>
      setTimeout(() => {
        const sid = c.input.sessionId?.value ?? c.input.resume?.value ?? "";
        driver.transcript(sid);
        c.title = "A generated title";
        c.emit(
          { k: "title", title: "Release notes", from: "renamed" },
          { k: "session", sessionId: sid, model: "claude-haiku-5-5", mode: "default", version: "2.1.311", bypass: false },
          { k: "local_output", stream: "stdout", text: "Session renamed to: Release notes" },
          { k: "turn_end", ok: true, subtype: "success", durationMs: 1, error: null, uuids: [turn.uuid] },
        );
      }, 0);
    const chat = await newChat(reg, "/rename Release notes");
    await settle(10);
    expect(driver.last.calls).toContain("generateTitle");
    expect(store.chats.get(chat)!.title).toEqual({ text: "Release notes", from: "renamed" });
    driver.last.emit({ k: "title", title: "Something else", from: "generated" });
    await settle();
    expect(store.chats.get(chat)!.title).toEqual({ text: "Release notes", from: "renamed" });
    expect(reg.list().find((r) => r.chat === chat)!.title).toBe("Release notes");
  });

  test("the same words as the first prompt, sent as a name, become the user's own: a generated title no longer replaces them", async () => {
    const { reg, driver, store } = await setup();
    const chat = await newChat(reg, "Fix the flaky test");
    expect(store.chats.get(chat)!.title).toEqual({ text: "Fix the flaky test", from: "first-prompt" });
    driver.last.emit({ k: "title", title: "Fix the flaky test", from: "renamed" });
    await settle();
    expect(store.chats.get(chat)!.title).toEqual({ text: "Fix the flaky test", from: "renamed" });
  });

  test("after a restart the chat keeps the name that a /rename gave it", async () => {
    const { reg, driver, store, bash } = await setup();
    autoReply(driver);
    const chat = await newChat(reg, "first");
    await settle();
    driver.last.emit({ k: "title", title: "Probe title 42", from: "renamed" });
    await settle();
    const next = await restart(reg, driver, store, bash);
    expect(next.list().find((r) => r.chat === chat)!.title).toBe("Probe title 42");
    const p = await next.attach(chat, new RecordingViewer());
    expect(p!.attached.title).toEqual({ text: "Probe title 42", from: "renamed" });
    await next.shutdown();
  });

  test("the first-prompt title is the first message on one line, cut at 80", async () => {
    const { reg, store } = await setup();
    const chat = await newChat(reg, `  line one\n${"x".repeat(200)}`);
    const t = store.chats.get(chat)!.title!;
    expect(t.from).toBe("first-prompt");
    expect(t.text.length).toBe(80);
    expect(t.text.startsWith("line one x")).toBe(true);
  });
});

describe("Archive (D48)", () => {
  test("Archive of an idle chat closes its process at once; the archived delta follows the ack", async () => {
    const { reg, driver, store, deltas } = await setup();
    const { chat, c } = await idleChat(reg, driver);
    const before = deltas.length;
    const o = await reg.request({ t: "archive", rid: rid(), chat, on: true, stop: false }, { tab: "tab_a" });
    expect(o.ok).toBe(true);
    expect(c.calls).toContain("close");
    expect(c.calls).not.toContain("interrupt");
    expect(deltas.slice(before).some((d) => "archived" in d)).toBe(false);
    if (o.ok) o.after?.();
    expect(deltas.slice(before)).toContainEqual(expect.objectContaining({ chat, archived: true }));
    await settle(10);
    expect(reg.stateOf(chat)).toBe("sleeping");
    expect(store.chats.get(chat)!.archivedAt).not.toBeNull();
  });

  test("a busy chat gets busy without stop; Stop and archive interrupts, then closes", async () => {
    const { reg, driver } = await setup();
    const chat = await newChat(reg, "long task");
    const c = driver.last;
    const v = new RecordingViewer();
    await reg.attach(chat, v);
    const asked = c.ask(permission("toolu_1"));
    await settle();
    expect(await apply(reg, { t: "archive", rid: rid(), chat, on: true, stop: false })).toEqual({ ok: false, code: "busy" });
    expect(await apply(reg, { t: "archive", rid: rid(), chat, on: true, stop: true })).toEqual({ ok: true, result: null });
    await settle(10);
    expect(await asked.answer).toBeNull();
    expect(c.calls.filter((x) => x === "interrupt" || x === "close")).toEqual(["interrupt", "close"]);
    expect(reg.stateOf(chat)).toBe("sleeping");
  });

  test("a running task that is not ambient makes an idle chat busy", async () => {
    const { reg, driver } = await setup();
    const { chat, c } = await idleChat(reg, driver);
    c.emit({ k: "tasks", running: [{ taskId: "t1", description: "build", ambient: false }] });
    await settle();
    expect(await apply(reg, { t: "archive", rid: rid(), chat, on: true, stop: false })).toEqual({ ok: false, code: "busy" });
    c.emit({ k: "tasks", running: [{ taskId: "w1", description: "watch", ambient: true }] });
    await settle();
    expect(await apply(reg, { t: "archive", rid: rid(), chat, on: true, stop: false })).toEqual({ ok: true, result: null });
  });

  test("an archived chat refuses composer actions, still reads, and Unarchive only clears the mark", async () => {
    const { reg, driver, deltas } = await setup();
    const { chat } = await idleChat(reg, driver);
    await apply(reg, { t: "archive", rid: rid(), chat, on: true, stop: false });
    await settle(10);
    expect(await apply(reg, send(chat, "x"))).toEqual({ ok: false, code: "archived" });
    expect(await apply(reg, bashFrame(chat, "ls"))).toEqual({ ok: false, code: "archived" });
    expect(await apply(reg, { t: "set_model", rid: rid(), chat, value: "claude-haiku-5-5" })).toEqual({ ok: false, code: "archived" });
    expect(await apply(reg, { t: "get", rid: rid(), chat, what: "history", before: null })).toMatchObject({ ok: true });
    const p = (await reg.attach(chat, new RecordingViewer()))!;
    expect(p.attached.archived).toBe(true);
    expect(await apply(reg, { t: "archive", rid: rid(), chat, on: false, stop: false })).toEqual({ ok: true, result: null });
    expect(deltas).toContainEqual(expect.objectContaining({ chat, archived: false }));
    expect(reg.stateOf(chat)).toBe("sleeping");
    expect(driver.opens.length).toBe(1);
    await apply(reg, send(chat, "back again"));
    expect(driver.opens.length).toBe(2);
  });

  test("archiving a chat whose start waits for a slot drops the start and keeps the text in the draft", async () => {
    const { reg, driver } = await setup({ maxLive: 1 });
    await newChat(reg, "busy one");
    const f = newChatFrame("waiting words");
    const chat = ((await apply(reg, f)) as { result: { chat: string } }).result.chat;
    await apply(reg, { t: "archive", rid: rid(), chat, on: true, stop: false });
    const p = (await reg.attach(chat, new RecordingViewer()))!;
    expect(p.attached.draft.text).toBe("waiting words");
    expect(p.tail.map((i) => i.e)).toContainEqual({ k: "taken_back", uuid: f.uuid });
    driver.opens[0]!.emit(turnEnd());
    await settle(10);
    expect(driver.opens.length).toBe(1);
  });
});

describe("Delete (D48)", () => {
  test("the process ends first, then deleteSession, then the store; {chat, gone: true} follows the ack", async () => {
    const { reg, driver, store, deltas } = await setup();
    store.order = driver.order;
    autoReply(driver);
    const chat = await newChat(reg, "doomed");
    await settle();
    const sid = store.chats.get(chat)!.sessionId!;
    const v = new RecordingViewer();
    await reg.attach(chat, v);
    await reg.draftEdit(draft(chat, "unsent"), "tab_a");
    const o = await reg.request({ t: "delete", rid: rid(), chat }, { tab: "tab_a" });
    expect(o.ok).toBe(true);
    expect(driver.order.slice(-3)).toEqual(["close", "deleteSession", "deleteChat"]);
    expect(driver.deletedSessions).toEqual([sid]);
    expect(deltas.some((d) => "gone" in d)).toBe(false);
    if (o.ok) o.after?.();
    expect(deltas[deltas.length - 1]).toEqual({ chat, gone: true });
    expect(v.goneCount).toBe(1);
    expect(store.chats.has(chat)).toBe(false);
    expect(store.drafts.has(chat)).toBe(false);
    expect(reg.list()).toEqual([]);
    expect(reg.chatForSession(sid)).toBeNull();
    expect(await apply(reg, send(chat, "x"))).toEqual({ ok: false, code: "not_found" });
    expect(await apply(reg, { t: "delete", rid: rid(), chat })).toEqual({ ok: false, code: "not_found" });
  });

  test("a busy chat is stopped before it is closed", async () => {
    const { reg, driver } = await setup();
    const chat = await newChat(reg, "running");
    await apply(reg, { t: "delete", rid: rid(), chat });
    expect(driver.last.calls.filter((x) => x === "interrupt" || x === "close")).toEqual(["interrupt", "close"]);
  });

  test("when deleteSession fails and the transcript is still there, the chat stays", async () => {
    const { reg, driver, store } = await setup();
    autoReply(driver);
    const chat = await newChat(reg, "kept");
    await settle();
    driver.deleteSessionThrows = true;
    expect(await apply(reg, { t: "delete", rid: rid(), chat })).toEqual({ ok: false, code: "failed" });
    expect(store.chats.has(chat)).toBe(true);
    expect(reg.has(chat)).toBe(true);
    expect(await apply(reg, send(chat, "still here"))).toEqual({ ok: true, result: { queued: false } });
  });

  test("SDK 0.3.322: when deleteSession removed the transcript but left the session folder (keepChat), the chat stays, and Delete again ends it", async () => {
    const { reg, driver, store } = await setup();
    autoReply(driver);
    const chat = await newChat(reg, "kept");
    await settle();
    const del = driver.deleteSession.bind(driver);
    let first = true;
    driver.deleteSession = async (sid: string, cwd: string) => {
      if (!first) return del(sid, cwd);
      first = false;
      // The transcript is gone already (no session info), and the driver says the chat must stay.
      driver.sessions.delete(sid);
      throw Object.assign(new Error("deleteSession removed the transcript, but the session folder is still on disk"), { name: "DriverError", code: "failed", keepChat: true });
    };
    expect(await apply(reg, { t: "delete", rid: rid(), chat })).toEqual({ ok: false, code: "failed" });
    expect(store.chats.has(chat)).toBe(true);
    expect(reg.has(chat)).toBe(true);
    expect(await apply(reg, { t: "delete", rid: rid(), chat })).toEqual({ ok: true, result: null });
    expect(store.chats.has(chat)).toBe(false);
  });

  test("a chat that never started has no transcript to delete; a driver with no deleteSession is not asked", async () => {
    const { reg, driver, store } = await setup({ maxLive: 1 });
    await newChat(reg, "busy");
    const f = newChatFrame("never started");
    const chat = ((await apply(reg, f)) as { result: { chat: string } }).result.chat;
    expect(store.chats.get(chat)!.sessionId).toBeNull();
    expect(await apply(reg, { t: "delete", rid: rid(), chat })).toEqual({ ok: true, result: null });
    expect(driver.order).not.toContain("deleteSession");
  });
});

describe("drafts (D49)", () => {
  test("a draft goes to every viewer, the sender included; an unchanged one sends nothing; it is never a ring event", async () => {
    const { reg, driver, store } = await setup();
    const { chat } = await idleChat(reg, driver);
    const va = new RecordingViewer("tab_a");
    const vb = new RecordingViewer("tab_b");
    await reg.attach(chat, va);
    await reg.attach(chat, vb);
    await reg.draftEdit(draft(chat, "hel"), "tab_a");
    await reg.draftEdit(draft(chat, "hel"), "tab_a");
    expect(va.drafts.map((d) => [d.rev, d.text, d.by])).toEqual([[1, "hel", "tab_a"]]);
    expect(vb.drafts.map((d) => [d.rev, d.text, d.by])).toEqual([[1, "hel", "tab_a"]]);
    expect(store.drafts.get(chat)!.rev).toBe(1);
    expect(va.items.some((i) => i.json.includes('"t":"draft"'))).toBe(false);
    for (let s = 0; ; s++) {
      const n = reg.next(chat, s);
      if (n === null || n === "gap") break;
      expect(n.e.k).not.toBe("draft" as never);
    }
    expect((await reg.attach(chat, new RecordingViewer()))!.attached.draft).toMatchObject({ rev: 1, text: "hel" });
  });

  test("upload ids that are not this chat's are dropped from the draft", async () => {
    const { reg, driver, store } = await setup();
    const { chat, v } = await idleChat(reg, driver);
    store.uploads.set(UP1, uploadRecord(UP1, chat, PROJECT));
    store.uploads.set(UP2, uploadRecord(UP2, "zzzzzzzzzzzzzzzzzzzz", PROJECT));
    await reg.draftEdit(draft(chat, "", { uploads: [UP1, UP2] }), "tab_a");
    expect(v.drafts[0]!.uploads).toEqual([UP1]);
  });

  test("a send clears the draft that its own tab changed last, or whose rev it showed", async () => {
    const { reg, driver } = await setup();
    const { chat, v } = await idleChat(reg, driver);
    await reg.draftEdit(draft(chat, "my message"), "tab_a");
    await apply(reg, send(chat, "my message", { draftRev: 1 }), { tab: "tab_a" });
    expect(v.drafts[v.drafts.length - 1]).toMatchObject({ rev: 2, text: "", by: "tab_a" });
    await reg.draftEdit(draft(chat, "from b"), "tab_b");
    await apply(reg, send(chat, "something else", { draftRev: 3 }), { tab: "tab_a" });
    expect(v.drafts[v.drafts.length - 1]).toMatchObject({ rev: 4, text: "" });
  });

  test("another page's newer draft stays when a send arrives", async () => {
    const { reg, driver } = await setup();
    const { chat, v } = await idleChat(reg, driver);
    await reg.draftEdit(draft(chat, "a typed this"), "tab_a");
    await reg.draftEdit(draft(chat, "b typed this"), "tab_b");
    await apply(reg, send(chat, "a typed this", { draftRev: 1 }), { tab: "tab_a" });
    expect(v.drafts[v.drafts.length - 1]).toMatchObject({ rev: 2, text: "b typed this", by: "tab_b" });
  });

  test("a draft that changed after the send arrived stays (the sender typed its next message)", async () => {
    const { reg, driver, store } = await setup();
    const { chat, v } = await idleChat(reg, driver);
    store.uploads.set(UP1, uploadRecord(UP1, chat, PROJECT));
    await reg.draftEdit(draft(chat, "first"), "tab_a");
    const p = apply(reg, send(chat, "first", { draftRev: 1, uploads: [UP1] }), { tab: "tab_a" });
    const q = reg.draftEdit(draft(chat, "next one"), "tab_a");
    await Promise.all([p, q]);
    expect(v.drafts[v.drafts.length - 1]).toMatchObject({ text: "next one" });
  });

  test("the draft and its rev survive a restart", async () => {
    const { reg, driver, store } = await setup();
    const { chat } = await idleChat(reg, driver);
    await reg.draftEdit(draft(chat, "kept"), "tab_a");
    await reg.shutdown();
    const again = new ChatRegistry({ driver, store });
    await again.boot();
    expect((await again.attach(chat, new RecordingViewer()))!.attached.draft).toMatchObject({ rev: 1, text: "kept" });
  });

  test("the draft's mention chips survive a restart; a draft with none has no mentions key", async () => {
    const { reg, driver, store } = await setup();
    const { chat } = await idleChat(reg, driver);
    await reg.draftEdit(draft(chat, "see", { mentions: ["src/upload.ts", "docs/a b.md"] }), "tab_a");
    await reg.shutdown();
    const again = new ChatRegistry({ driver, store });
    await again.boot();
    const back = (await again.attach(chat, new RecordingViewer()))!.attached.draft;
    expect(back).toMatchObject({ rev: 1, text: "see", mentions: ["src/upload.ts", "docs/a b.md"] });
    await again.draftEdit(draft(chat, "see"), "tab_a");
    await again.shutdown();
    const third = new ChatRegistry({ driver, store });
    await third.boot();
    const none = (await third.attach(chat, new RecordingViewer()))!.attached.draft;
    expect(none).toMatchObject({ rev: 2, text: "see" });
    expect("mentions" in none).toBe(false);
  });

  test("an archived chat takes no draft", async () => {
    const { reg, driver } = await setup();
    const { chat, v } = await idleChat(reg, driver);
    await apply(reg, { t: "archive", rid: rid(), chat, on: true, stop: false });
    await reg.draftEdit(draft(chat, "x"), "tab_a");
    expect(v.drafts).toEqual([]);
  });
});

describe("`!` commands (D10, D20)", () => {
  test("runs in the chat's folder, shows running then done, and sends the record with the reply rule", async () => {
    const { reg, driver, bash, store } = await setup();
    const { chat, c, v } = await idleChat(reg, driver);
    expect(await apply(reg, bashFrame(chat, "git status"))).toEqual({ ok: true, result: null });
    await settle();
    expect(bash.runs).toEqual([{ command: "git status", cwd: "/srv/work/app" }]);
    expect(v.of("bash").map((e) => e.state)).toEqual(["running", "done"]);
    expect(v.of("bash")[1]).toMatchObject({ stdout: "ok\n", code: 0, ms: 4 });
    expect(c.bashRecords).toEqual([{ uuid: v.of("bash")[0]!.uuid, input: "git status", stdout: "ok\n", stderr: "", reply: true }]);
    // Claude replies to the output: its turn starts with the record, so Stop works and the next `!` waits for it.
    expect(v.events.at(-1)).toEqual({ k: "turn_start", by: "user" });
    expect(reg.stateOf(chat)).toBe("running");
    c.emit(turnEnd());
    await settle();
    store.settingsValue = { ...store.settingsValue, "chats.bashReply": "never" };
    await reg.reloadSettings();
    await apply(reg, bashFrame(chat, "ls"));
    await settle();
    expect(c.bashRecords[1]!.reply).toBe(false);
  });

  test("Claude Code keeps the record under an id of its own: a page that attaches after it was written draws the row once", async () => {
    const { reg, driver, store } = await setup({}, (_d, s) => {
      s.settingsValue = { ...s.settingsValue, "chats.bashReply": "never" };
    });
    const { chat, c, v } = await idleChat(reg, driver);
    expect(store.settingsValue["chats.bashReply"]).toBe("never");
    // An older row with the same command and output, already in the transcript before this run's rows.
    const record = (input: string, uuid = rid()): ChatEvent => ({ k: "bash", uuid, input, state: "done", stdout: "ok\n", stderr: "", code: null, ms: null, timedOut: false, capped: false });
    const sid = c.input.sessionId!.value;
    driver.transcript(sid);
    driver.histories.set(sid, [record("echo hi")]);
    await apply(reg, bashFrame(chat, "echo hi"));
    await apply(reg, bashFrame(chat, "echo hi"));
    await apply(reg, bashFrame(chat, "pwd"));
    await settle(10);
    const rows = [...new Set(v.of("bash").map((e) => e.uuid))];
    expect(rows.length).toBe(3);
    expect(c.bashRecords.map((r) => r.uuid)).toEqual(rows);
    // The live CLI writes a `!` record under its own id, never the host's (a live check found the host's uuid in no
    // transcript). The transcript holds the first two records of this run so far; the third is not written yet.
    driver.histories.set(sid, [record("echo hi"), record("echo hi"), record("echo hi")]);
    const p = (await reg.attach(chat, new RecordingViewer()))!;
    const drawn = [...p.snapshot.history, ...p.tail.map((i) => i.e)].filter((e): e is Extract<ChatEvent, { k: "bash" }> => e.k === "bash");
    expect(p.snapshot.history.filter((e) => e.k === "bash").length).toBe(3);
    // The page draws one row per command: the three records, and the live row of `pwd`, whose record is not there yet.
    expect(p.tail.filter((i) => i.e.k === "bash").map((i) => i.e)).toEqual(v.of("bash").filter((e) => e.uuid === rows[2]));
    expect(new Set(drawn.map((e) => e.uuid)).size).toBe(4);
    // Once the `pwd` record is in the transcript too, no live row follows the snapshot.
    driver.histories.set(sid, [record("echo hi"), record("echo hi"), record("echo hi"), record("pwd")]);
    const q = (await reg.attach(chat, new RecordingViewer()))!;
    expect(q.tail.filter((i) => i.e.k === "bash")).toEqual([]);
  });

  test("a row whose record never went to Claude Code (the chat ended while it ran) still follows a snapshot", async () => {
    const { reg, driver, bash } = await setup();
    const { chat, c } = await idleChat(reg, driver);
    const sid = c.input.sessionId!.value;
    driver.transcript(sid);
    driver.histories.set(sid, [{ k: "bash", uuid: rid(), input: "make", state: "done", stdout: "ok\n", stderr: "", code: null, ms: null, timedOut: false, capped: false }]);
    let release!: () => void;
    bash.hold = new Promise((r) => (release = r));
    await apply(reg, bashFrame(chat, "make"));
    c.end();
    await settle();
    release();
    await settle(10);
    expect(c.bashRecords).toEqual([]);
    const p = (await reg.attach(chat, new RecordingViewer()))!;
    expect(p.tail.filter((i) => i.e.k === "bash").map((i) => (i.e as Extract<ChatEvent, { k: "bash" }>).state)).toEqual(["running", "done"]);
  });

  test("upload chips are single-quoted paths in `!` mode", async () => {
    const { reg, driver, bash, store } = await setup();
    const { chat } = await idleChat(reg, driver);
    store.uploads.set(UP1, uploadRecord(UP1, chat, PROJECT, "it's here.txt"));
    await apply(reg, bashFrame(chat, "wc -l", { uploads: [UP1] }));
    await settle();
    expect(bash.runs[0]!.command).toBe("wc -l '/tmp/kitespan-uploads-test/u-abcdef/it'\\''s here.txt'");
  });

  test("typed during a turn it waits as Queued and runs after the turn", async () => {
    const { reg, driver, bash } = await setup();
    const chat = await newChat(reg, "long task");
    const v = new RecordingViewer();
    await reg.attach(chat, v);
    await apply(reg, bashFrame(chat, "make test"));
    await settle();
    expect(bash.runs).toEqual([]);
    expect(v.of("bash").map((e) => e.state)).toEqual(["queued"]);
    driver.last.emit(turnEnd());
    await settle();
    expect(bash.runs.map((r) => r.command)).toEqual(["make test"]);
    expect(v.of("bash").map((e) => e.state)).toEqual(["queued", "running", "done"]);
  });

  test("typed behind a message in Claude Code's queue, it runs after that message's turn, so the ring has the order the transcript gets", async () => {
    const { reg, driver, bash } = await setup();
    const chat = await newChat(reg, "long task");
    const c = driver.last;
    const v = new RecordingViewer();
    await reg.attach(chat, v);
    const m = send(chat, "Keep the old uploadFile");
    await apply(reg, m);
    const cmd = bashFrame(chat, "echo during-turn");
    await apply(reg, cmd);
    await settle();
    // The turn ends, and Claude Code starts the queued message's turn at once: the command waits for that turn.
    c.emit(turnEnd([c.sent[0]!.uuid]));
    await settle();
    expect(bash.runs).toEqual([]);
    c.emit({ k: "turn_start", by: "user" }, { k: "block", key: "m2:0", kind: "text", text: "Done.", parent: null });
    await settle();
    expect(bash.runs).toEqual([]);
    expect(c.bashRecords).toEqual([]);
    c.emit(turnEnd([m.uuid]));
    await settle();
    expect(bash.runs.map((r) => r.command)).toEqual(["echo during-turn"]);
    // Claude Code gets the record after the message's turn, so its transcript holds the reply, then the record.
    expect(c.calls.filter((x) => x === "send" || x === "bashRecord")).toEqual(["send", "send", "bashRecord"]);
    const order = v.events.flatMap((e) => (e.k === "block" ? [`reply ${e.text}`] : e.k === "bash" && e.state !== "queued" ? [`bash ${e.state}`] : e.k === "turn_end" ? ["turn_end"] : []));
    expect(order).toEqual(["turn_end", "reply Done.", "turn_end", "bash running", "bash done"]);
  });

  test("a message sent after a waiting command waits behind it in the server, so the command's record goes first", async () => {
    const { reg, driver, bash } = await setup();
    const chat = await newChat(reg, "long task");
    const c = driver.last;
    const v = new RecordingViewer();
    await reg.attach(chat, v);
    const cmd = bashFrame(chat, "make test");
    await apply(reg, cmd);
    const m = send(chat, "then explain the failures");
    expect(await apply(reg, m)).toEqual({ ok: true, result: { queued: false } });
    // Claude Code does not have it yet; every page shows it Queued, after the command's row.
    expect(c.sent.map((s) => s.uuid)).not.toContain(m.uuid);
    expect(v.events.filter((e) => e.k === "bash" || e.k === "user").map((e) => [e.k, e.k === "user" ? e.queued : e.state])).toEqual([
      ["bash", "queued"],
      ["user", true],
    ]);
    c.emit(turnEnd([c.sent[0]!.uuid]));
    await settle();
    expect(bash.runs.map((r) => r.command)).toEqual(["make test"]);
    // The record, then the message: Claude replies to the output first, and the message waits in Claude Code's queue.
    expect(c.calls.filter((x) => x === "send" || x === "bashRecord")).toEqual(["send", "bashRecord", "send"]);
    expect(c.sent.at(-1)!.uuid).toBe(m.uuid);
    expect(v.of("user").map((e) => e.queued)).toEqual([true]);
    c.emit(turnEnd([cmd.rid]), { k: "turn_start", by: "user" });
    await settle();
    expect(v.of("user").map((e) => e.queued)).toEqual([true, false]);
  });

  test("Take back of a message that waits behind a command takes it from the server's queue, and it never goes out", async () => {
    const { reg, driver, bash } = await setup();
    const chat = await newChat(reg, "long task");
    const c = driver.last;
    const v = new RecordingViewer();
    await reg.attach(chat, v);
    await apply(reg, bashFrame(chat, "make test"));
    const m = send(chat, "never mind");
    await apply(reg, m);
    expect(await apply(reg, { t: "take_back", rid: rid(), chat, uuid: m.uuid })).toEqual({ ok: true, result: { cancelled: true } });
    expect(c.calls).not.toContain(`takeBack:${m.uuid}`);
    expect(v.of("taken_back")).toEqual([{ k: "taken_back", uuid: m.uuid }]);
    expect(v.drafts.at(-1)).toMatchObject({ text: "never mind", mode: "chat" });
    c.emit(turnEnd([c.sent[0]!.uuid]));
    await settle();
    expect(bash.runs.length).toBe(1);
    expect(c.sent.map((s) => s.uuid)).not.toContain(m.uuid);
  });

  test("a command that waits for a slot keeps its row as Not run when its chat's start fails: the free-slot line goes, and the command comes back to an empty box in Bash mode, with its chips", async () => {
    const { reg, driver, bash, store } = await setup({ maxLive: 1 });
    const { chat, c, v } = await idleChat(reg, driver);
    const sid = c.input.sessionId!.value;
    c.end();
    await settle();
    store.uploads.set(UP1, uploadRecord(UP1, chat, PROJECT, "notes.txt"));
    await newChat(reg, "busy"); // its turn runs, so it cannot sleep: the cap is full
    const cmd = bashFrame(chat, "echo capq", { uploads: [UP1] });
    expect(await apply(reg, cmd)).toEqual({ ok: true, result: null });
    expect(rows(v.events)).toEqual([[cmd.rid, "queued"]]);
    const line = v.of("notice").at(-1)!;
    expect(line).toEqual({ k: "notice", text: CAP_NOTICE, id: expect.any(String) });
    // The transcript as it is now: where the row stays in history.
    const said: ChatEvent[] = [
      { k: "user", uuid: c.sent[0]!.uuid, text: "first", queued: false },
      { k: "block", key: "msg_1:0", kind: "text", text: "Done.", parent: null },
      turnEnd(),
    ];
    driver.histories.set(sid, said);
    // The slot frees, and the start fails.
    driver.openThrows = true;
    driver.last.emit(turnEnd());
    await settle(10);
    expect(bash.runs).toEqual([]);
    const row = notRun(cmd.rid, "echo capq '/tmp/kitespan-uploads-test/u-abcdef/notes.txt'");
    // The free-slot line goes, the row stays as Not run, and the start's failure is the chat's one line.
    expect(v.events.slice(-3)).toEqual([{ k: "taken_back", uuid: line.id! }, row, { k: "notice", text: ERROR_MESSAGES.failed }]);
    expect(v.of("taken_back")).toEqual([{ k: "taken_back", uuid: line.id! }]);
    expect(v.drafts.at(-1)).toMatchObject({ text: "echo capq", mode: "bash", command: null, link: false, uploads: [UP1] });
    expect(store.drafts.get(chat)).toMatchObject({ text: "echo capq", mode: "bash", uploads: [UP1] });
    // The chat went on in the terminal since. A reload, another page, and the next server life draw the row once,
    // where it was.
    const later: ChatEvent[] = [{ k: "user", uuid: rid(), text: "from the terminal", queued: false }, { k: "block", key: "msg_2:0", kind: "text", text: "Hi.", parent: null }, turnEnd()];
    driver.histories.set(sid, [...said, ...later]);
    driver.openThrows = false;
    for (const r of [reg, await restart(reg, driver, store, bash, { maxLive: 1 })]) {
      const p = (await r.attach(chat, new RecordingViewer("tab_b")))!;
      // The message this server sent names its mention paths, none (9.3); the terminal's has no record.
      // U2: history also gives each turn its start and end (server/chats/turns.ts); this test is about the row's place.
      const unmarked = (events: readonly ChatEvent[]) => events.filter((e) => e.k !== "turn_start" && e.k !== "turn_end");
      expect(unmarked(p.snapshot.history)).toEqual(unmarked([{ ...said[0]!, mentions: [] } as ChatEvent, ...said.slice(1), row, ...later]));
      expect(p.tail.filter((i) => i.e.k === "bash")).toEqual([]);
      expect(p.attached.draft).toMatchObject({ text: "echo capq", mode: "bash" });
    }
  });

  test("a command that waits for a slot keeps its row as Not run when its chat is archived, and the free-slot line goes; a box that holds text keeps it, and the row stays", async () => {
    const { reg, driver, store } = await setup({ maxLive: 1 });
    const { chat, c, v } = await idleChat(reg, driver);
    c.end();
    await settle();
    const other = await idleChat(reg, driver);
    other.c.end();
    await settle();
    await newChat(reg, "busy");
    const cmd = bashFrame(chat, "git status");
    await apply(reg, cmd);
    const line = v.of("notice").at(-1)!;
    expect(line.text).toBe(CAP_NOTICE);
    expect(await apply(reg, { t: "archive", rid: rid(), chat, on: true, stop: false })).toEqual({ ok: true, result: null });
    expect(v.of("taken_back")).toEqual([{ k: "taken_back", uuid: line.id! }]);
    expect(rows(v.events)).toEqual([
      [cmd.rid, "queued"],
      [cmd.rid, "not_run"],
    ]);
    expect(store.drafts.get(chat)).toMatchObject({ text: "git status", mode: "bash" });
    // Another page typed in the other chat's box after the command went: a command cannot join that text, so the
    // box keeps what it holds, and the row is where the command stays.
    const ls = bashFrame(other.chat, "ls");
    await apply(reg, ls);
    await reg.draftEdit(draft(other.chat, "half typed"), "tab_b");
    await apply(reg, { t: "archive", rid: rid(), chat: other.chat, on: true, stop: false });
    expect(store.drafts.get(other.chat)).toMatchObject({ text: "half typed", mode: "chat" });
    expect(rows(other.v.events)).toEqual([
      [ls.rid, "queued"],
      [ls.rid, "not_run"],
    ]);
    const p = (await reg.attach(other.chat, new RecordingViewer("tab_c")))!;
    expect(p.snapshot.history).toEqual([notRun(ls.rid, "ls")]);
  });

  test("commands typed during a turn keep their rows as Not run when the turn's chat is stopped and archived, or its process exits; they come back to the box", async () => {
    const { reg, driver, store } = await setup();
    const chat = await newChat(reg, "long task");
    const v = new RecordingViewer();
    await reg.attach(chat, v);
    const one = bashFrame(chat, "make lint");
    const two = bashFrame(chat, "make test");
    await apply(reg, one);
    await apply(reg, two);
    expect(await apply(reg, { t: "archive", rid: rid(), chat, on: true, stop: true })).toEqual({ ok: true, result: null });
    await settle(10);
    expect(v.of("taken_back")).toEqual([]);
    expect(rows(v.events)).toEqual([
      [one.rid, "queued"],
      [two.rid, "queued"],
      [one.rid, "not_run"],
      [two.rid, "not_run"],
    ]);
    expect(store.drafts.get(chat)).toMatchObject({ text: "make lint\nmake test", mode: "bash" });

    const other = await newChat(reg, "another long task");
    const c = driver.last;
    const w = new RecordingViewer();
    await reg.attach(other, w);
    const cmd = bashFrame(other, "pwd");
    await apply(reg, cmd);
    c.end({ code: 1, signal: null });
    await settle(10);
    expect(rows(w.events)).toEqual([
      [cmd.rid, "queued"],
      [cmd.rid, "not_run"],
    ]);
    expect(w.of("exit")).toHaveLength(1);
    expect(store.drafts.get(other)).toMatchObject({ text: "pwd", mode: "bash" });
  });

  test("a chat whose first start never ran keeps its Not run row after a restart (no session yet)", async () => {
    const { reg, driver, store, bash } = await setup({ maxLive: 1 });
    await newChat(reg, "busy");
    const chat = await newChat(reg, "waits");
    const cmd = bashFrame(chat, "pwd");
    expect(await apply(reg, cmd)).toEqual({ ok: true, result: null });
    expect(await apply(reg, { t: "archive", rid: rid(), chat, on: true, stop: false })).toEqual({ ok: true, result: null });
    expect(reg.list().find((r) => r.chat === chat)).toMatchObject({ state: "sleeping", archived: true });
    expect(driver.opens.length).toBe(1);
    const next = await restart(reg, driver, store, bash, { maxLive: 1 });
    const p = (await next.attach(chat, new RecordingViewer()))!;
    expect(p.snapshot.history).toEqual([notRun(cmd.rid, "pwd")]);
    expect(p.tail).toEqual([]);
  });

  test("a command and a message that wait for a slot when the server stops: the command keeps its row as Not run and comes back to the box (L5), the message stays Queued (L6), and the next server runs neither by itself", async () => {
    const { reg, driver, bash, store } = await setup({ maxLive: 1 });
    const x = await idleChat(reg, driver);
    x.c.end();
    await settle();
    const y = await idleChat(reg, driver, "tab_b");
    y.c.end();
    await settle();
    await newChat(reg, "busy"); // its turn runs, so it cannot sleep: the cap is full
    const cmd = bashFrame(x.chat, "make test");
    expect(await apply(reg, cmd)).toEqual({ ok: true, result: null });
    const msg = send(y.chat, "after the slot");
    expect(await apply(reg, msg)).toEqual({ ok: true, result: { queued: true } });
    const lineX = x.v.of("notice").at(-1)!;
    const lineY = y.v.of("notice").at(-1)!;
    expect([lineX.text, lineY.text]).toEqual([CAP_NOTICE, CAP_NOTICE]);
    const next = await restart(reg, driver, store, bash, { maxLive: 1 });
    await settle();
    // The open pages see it as the server stops: the free-slot line goes, the command's row turns Not run and its text
    // is back in its box; the message's row stays, Queued, and its text is not in the box.
    expect(x.v.events.slice(-2)).toEqual([{ k: "taken_back", uuid: lineX.id! }, notRun(cmd.rid, "make test")]);
    expect(y.v.events.at(-1)).toEqual({ k: "taken_back", uuid: lineY.id! });
    expect(x.v.drafts.at(-1)).toMatchObject({ text: "make test", mode: "bash" });
    expect(y.v.drafts.map((d) => d.text)).not.toContain("after the slot");
    // The next server: the row is where it was, the command is in the box, the message waits Not sent, and a page's
    // resend of either runs nothing.
    const px = (await next.attach(x.chat, new RecordingViewer()))!;
    expect(px.snapshot!.history).toEqual([notRun(cmd.rid, "make test")]);
    expect(px.attached.draft).toMatchObject({ text: "make test", mode: "bash" });
    const py = (await next.attach(y.chat, new RecordingViewer()))!;
    expect(py.snapshot!.history).toEqual([]);
    expect(py.tail.map((i) => i.e)).toContainEqual({ k: "user", uuid: msg.uuid, text: "after the slot", queued: true, mentions: [], notSent: true });
    expect(py.attached.draft.text).toBe("");
    const opens = driver.opens.length;
    expect(await apply(next, cmd)).toEqual({ ok: true, result: null });
    expect(await apply(next, msg)).toEqual({ ok: true, result: { queued: true } });
    await settle(10);
    expect(driver.opens.length).toBe(opens);
    expect(bash.runs).toEqual([]);
  });

  test("on a sleeping chat it starts the chat; with no runner it is unsupported", async () => {
    const { reg, driver, bash, store } = await setup();
    const { chat, c } = await idleChat(reg, driver);
    c.end();
    await settle();
    await apply(reg, bashFrame(chat, "pwd"));
    await settle();
    expect(driver.opens.length).toBe(2);
    expect(bash.runs.map((r) => r.command)).toEqual(["pwd"]);
    expect(driver.last.bashRecords.length).toBe(1);
    await reg.shutdown();
    const bare = new ChatRegistry({ driver, store });
    await bare.boot();
    expect(await bare.request(bashFrame(chat, "pwd"), { tab: null })).toEqual({ ok: false, code: "unsupported" });
  });
});

describe("Continue here (6.9, D49)", () => {
  test("makes one chat per session, also when two pages press it at once; its first start resumes", async () => {
    const { reg, driver, deltas } = await setup();
    const sid = rid();
    driver.transcript(sid, "Fix the flaky test");
    const frame = () => ({ t: "continue_session" as const, rid: rid(), project: PROJECT, session: sid });
    const [a, b] = await Promise.all([apply(reg, frame()), apply(reg, frame())]);
    expect(a.ok && b.ok).toBe(true);
    const chat = (a as { result: { chat: string } }).result.chat;
    expect((b as { result: { chat: string } }).result.chat).toBe(chat);
    expect(await apply(reg, frame())).toEqual({ ok: true, result: { chat } });
    expect(reg.list().length).toBe(1);
    expect(reg.list()[0]).toMatchObject({ chat, title: "Fix the flaky test", state: "sleeping" });
    expect(deltas.filter((d) => d.chat === chat && "project" in d).length).toBe(1);
    expect(driver.opens.length).toBe(0);
    await apply(reg, send(chat, "continue"));
    expect(driver.last.input.resume?.value).toBe(sid);
    expect(driver.last.input.sessionId).toBeNull();
  });

  test("an unknown session or project is not_found", async () => {
    const { reg } = await setup();
    expect(await apply(reg, { t: "continue_session", rid: rid(), project: PROJECT, session: rid() })).toEqual({ ok: false, code: "not_found" });
    expect(await apply(reg, { t: "continue_session", rid: rid(), project: "q2x4abk3m7", session: rid() })).toEqual({ ok: false, code: "not_found" });
  });
});

describe("reads (get)", () => {
  test("a sleeping chat reads its history and gives empty panels; it never starts", async () => {
    const { reg, driver } = await setup();
    const sid = rid();
    driver.transcript(sid);
    driver.histories.set(sid, [{ k: "user", uuid: rid(), text: "old question", queued: false }]);
    const chat = ((await apply(reg, { t: "continue_session", rid: rid(), project: PROJECT, session: sid })) as { result: { chat: string } }).result.chat;
    const hist = await apply(reg, { t: "get", rid: rid(), chat, what: "history", before: null });
    expect(hist).toMatchObject({ ok: true, result: { more: null } });
    expect((hist as { result: { history: ChatEvent[] } }).result.history.length).toBe(1);
    expect(await apply(reg, { t: "get", rid: rid(), chat, what: "context" })).toEqual({ ok: true, result: null });
    expect(await apply(reg, { t: "get", rid: rid(), chat, what: "connectors" })).toEqual({ ok: true, result: [] });
    expect(await apply(reg, { t: "get", rid: rid(), chat, what: "models" })).toEqual({ ok: true, result: [] });
    expect(driver.opens.length).toBe(0);
  });

  test("a live chat asks Claude Code; the model rows are kept for sleeping chats", async () => {
    const { reg, driver } = await setup();
    const { chat, c } = await idleChat(reg, driver);
    c.modelList = [{ value: "claude-haiku-5-5", displayName: "Haiku", description: "", efforts: ["low"], supportsAutoMode: false }];
    expect(await apply(reg, { t: "get", rid: rid(), chat, what: "models" })).toEqual({ ok: true, result: c.modelList });
    c.end();
    await settle();
    const other = ((await apply(reg, { t: "continue_session", rid: rid(), project: PROJECT, session: (driver.transcript("5d0a3c1e-2b4f-4a6d-8e9f-0a1b2c3d4e5f"), "5d0a3c1e-2b4f-4a6d-8e9f-0a1b2c3d4e5f") })) as { result: { chat: string } }).result.chat;
    expect(await apply(reg, { t: "get", rid: rid(), chat: other, what: "models" })).toEqual({ ok: true, result: c.modelList });
  });

  test("Account: the provider that a live chat's Claude Code reports; null while no chat is live (6.8)", async () => {
    const { reg, driver } = await setup();
    expect(await reg.account()).toBeNull();
    const { c } = await idleChat(reg, driver);
    c.provider = "bedrock";
    expect(await reg.account()).toEqual({ provider: "bedrock" });
    c.provider = null;
    expect(await reg.account()).toEqual({ provider: null });
    c.failNext.add("account");
    expect(await reg.account()).toBeNull();
    c.end();
    await settle();
    expect(await reg.account()).toBeNull();
  });

  test("a chat with no session yet has an empty history", async () => {
    const { reg } = await setup({ maxLive: 1 });
    await newChat(reg, "busy");
    const chat = ((await apply(reg, newChatFrame("waits"))) as { result: { chat: string } }).result.chat;
    expect(await apply(reg, { t: "get", rid: rid(), chat, what: "history", before: null })).toEqual({ ok: true, result: { history: [], more: null } });
  });
});
