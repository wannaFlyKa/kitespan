// RD-8 in the registry (R11 to R14, L4 to L6): a message that waits (for a free slot, in Claude Code's own queue behind
// a turn, in a held chat, during a drain) is in its chat's queue file before its ack, and stays there until the end of
// the turn it ran in, Take back, Archive or Delete. A graceful stop keeps it Queued (not in the box); a kill -9 keeps
// it too. The next server shows it Not sent, Queued, and starts nothing; a message that the transcript holds ran, and
// counts as applied. Send again (`send_queued`), the next send or a hold's end sends them first, in order. `!` commands
// keep today's rule. The scripted driver stands in for Claude Code and MemoryStore for the disk.
import { describe, expect, test } from "bun:test";
import { STORE_LIMITS } from "../../server/store/types";
import type { ChatEvent, NewChatFrame, SendFrame } from "../../shared/protocol";
import { ChatRegistry } from "../../server/chats/registry";
import { FakeBash, FakeDriver, MemoryStore, RecordingViewer, apply, projectRecord, settle } from "../../server/chats/testing";
import type { RegistryOptions } from "../../server/chats/types";

const PROJECT = "k3m7q2x4ab";
const rid = () => crypto.randomUUID();

async function life(driver: FakeDriver, store: MemoryStore, opts: RegistryOptions = {}) {
  const reg = new ChatRegistry({ driver, store, bash: new FakeBash() }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500, openCheckMs: 15, openFastMs: 15, ...opts });
  await reg.boot();
  await settle();
  return reg;
}
async function setup(opts: RegistryOptions = {}) {
  const driver = new FakeDriver();
  const store = new MemoryStore();
  store.projects = [projectRecord(PROJECT)];
  return { driver, store, reg: await life(driver, store, opts) };
}
const newChatFrame = (text: string): NewChatFrame => ({ t: "new_chat", rid: rid(), project: PROJECT, uuid: rid(), text, picks: { model: null, effort: null, mode: null }, uploads: [] });
async function newChat(reg: ChatRegistry, text: string): Promise<string> {
  const o = await apply(reg, newChatFrame(text));
  if (!o.ok) throw new Error(`new_chat refused: ${o.code}`);
  return (o.result as { chat: string }).chat;
}
const send = (chat: string, text: string): SendFrame => {
  const r = rid();
  return { t: "send", rid: r, chat, uuid: r, text, draftRev: null, uploads: [] };
};
const turnEnd = (uuids: string[] = []): ChatEvent => ({ k: "turn_end", ok: true, subtype: "success", durationMs: 3, error: null, uuids });
const queued = (store: MemoryStore, chat: string) => store.queues.get(chat)?.msgs.map((m) => m.userText) ?? [];
/** The user's messages that a page draws from a tail: text, Queued, Not sent (the last event of each id wins). */
function bubbles(events: readonly ChatEvent[]): [string, boolean, boolean][] {
  const by = new Map<string, [string, boolean, boolean]>();
  for (const e of events) {
    if (e.k === "user") by.set(e.uuid, [e.text, e.queued, e.notSent === true]);
    if (e.k === "taken_back") by.delete(e.uuid);
  }
  return [...by.values()];
}

/** maxLive 1: one chat's turn holds the slot, so a second chat's messages wait for it (its new chat's and one more). */
async function waitingForSlot(reg: ChatRegistry, driver: FakeDriver) {
  await newChat(reg, "busy");
  const other = await newChat(reg, "other");
  expect(driver.opens).toHaveLength(1);
  const waits = send(other, "for the slot");
  expect(await apply(reg, waits)).toEqual({ ok: true, result: { queued: true } });
  return { other, waits };
}

describe("the queue file (R11)", () => {
  test("cap 1: a second chat's messages wait; after shutdown() the next server shows them Queued and Not sent, in a later page's tail, and starts nothing", async () => {
    const { reg, driver, store } = await setup({ maxLive: 1 });
    const { other } = await waitingForSlot(reg, driver);
    expect(queued(store, other)).toEqual(["other", "for the slot"]);
    await reg.shutdown();
    expect(queued(store, other)).toEqual(["other", "for the slot"]);
    const next = await life(driver, store, { maxLive: 1 });
    const p = (await next.attach(other, new RecordingViewer()))!;
    expect(bubbles(p.tail.map((i) => i.e))).toEqual([
      ["other", true, true],
      ["for the slot", true, true],
    ]);
    expect(p.attached.draft.text).toBe("");
    expect(driver.opens).toHaveLength(1);
  });

  test("the same with no shutdown (a kill -9): what was written before the ack is there", async () => {
    const { reg, driver, store } = await setup({ maxLive: 1 });
    const { other } = await waitingForSlot(reg, driver);
    const next = await life(driver, store, { maxLive: 1 });
    expect(bubbles((await next.attach(other, new RecordingViewer()))!.tail.map((i) => i.e))).toEqual([
      ["other", true, true],
      ["for the slot", true, true],
    ]);
    expect(driver.opens).toHaveLength(1);
    void reg;
  });

  test("a message in Claude Code's own queue is in the file from before its ack until the end of the turn it ran in", async () => {
    const { reg, driver, store } = await setup();
    const chat = await newChat(reg, "first");
    const c = driver.last;
    c.emit(turnEnd());
    await settle();
    expect(queued(store, chat)).toEqual([]);
    // A message to an idle live chat starts its turn at once: it never waits, so it is not in the file.
    const a = send(chat, "a long task");
    await apply(reg, a);
    expect(queued(store, chat)).toEqual([]);
    const b = send(chat, "and then this");
    const writes = store.queueWrites;
    expect(await apply(reg, b)).toEqual({ ok: true, result: { queued: false } });
    expect(store.queueWrites).toBe(writes + 1);
    expect(queued(store, chat)).toEqual(["and then this"]);
    c.emit(turnEnd([a.uuid]), { k: "turn_start", by: "user" });
    await settle();
    expect(queued(store, chat)).toEqual(["and then this"]);
    c.emit(turnEnd([b.uuid]));
    await settle();
    expect(store.queues.has(chat)).toBe(false);
  });

  test("Take back removes the message from the file before its ack", async () => {
    const { reg, driver, store } = await setup();
    const chat = await newChat(reg, "first");
    const c = driver.last;
    const m = send(chat, "take me back");
    await apply(reg, m);
    expect(queued(store, chat)).toEqual(["first", "take me back"]);
    expect(await apply(reg, { t: "take_back", rid: rid(), chat, uuid: m.uuid })).toEqual({ ok: true, result: { cancelled: true } });
    expect(queued(store, chat)).toEqual(["first"]);
    c.emit(turnEnd());
    await settle();
    expect(store.queues.has(chat)).toBe(false);
  });

  test("past 50 messages a send is refused with queue_full, and nothing is dropped", async () => {
    const { reg, driver, store } = await setup();
    const chat = await newChat(reg, "first");
    driver.last.emit(turnEnd());
    await settle();
    await apply(reg, send(chat, "a long task"));
    for (let i = 0; i < STORE_LIMITS.queueMessages; i++) expect((await apply(reg, send(chat, `waits ${i}`))).ok).toBe(true);
    expect(await apply(reg, send(chat, "one too many"))).toEqual({ ok: false, code: "queue_full" });
    expect(queued(store, chat)).toHaveLength(STORE_LIMITS.queueMessages);
    expect(queued(store, chat).at(-1)).toBe(`waits ${STORE_LIMITS.queueMessages - 1}`);
  });
});

describe("boot (R12): what waited comes back, and nothing starts", () => {
  test("a restored message that the transcript holds ran: it leaves the file, and a resend of it is applied once", async () => {
    const { reg, driver, store } = await setup();
    const chat = await newChat(reg, "first");
    const c = driver.last;
    c.emit(turnEnd());
    await settle();
    await apply(reg, send(chat, "running"));
    const ran = send(chat, "queued, then ran");
    const lost = send(chat, "queued, never ran");
    await apply(reg, ran);
    await apply(reg, lost);
    // A kill -9: the orphan ran `ran` and wrote it, as Claude Code does (live LV-R3); `lost` it never ran (LV-R4).
    const sid = store.chats.get(chat)!.sessionId!;
    driver.histories.set(sid, [{ k: "user", uuid: ran.uuid, text: "queued, then ran", queued: false }]);
    const next = await life(driver, store);
    expect(queued(store, chat)).toEqual(["queued, never ran"]);
    // Its id is in the ledger, so a resend after one more stop is not applied either.
    expect(store.chats.get(chat)!.applied).toContain(ran.uuid);
    const p = (await next.attach(chat, new RecordingViewer()))!;
    expect(bubbles(p.tail.map((i) => i.e))).toEqual([["queued, never ran", true, true]]);
    const opens = driver.opens.length;
    expect(await apply(next, ran)).toEqual({ ok: true, result: { queued: false } });
    expect(await apply(next, lost)).toEqual({ ok: true, result: { queued: true } });
    await settle();
    expect(driver.opens).toHaveLength(opens);
  });

  test("a graceful stop keeps a message of Claude Code's queue Queued, out of the box (L6)", async () => {
    const { reg, driver, store } = await setup();
    const chat = await newChat(reg, "first");
    const c = driver.last;
    c.emit(turnEnd());
    await settle();
    const v = new RecordingViewer();
    await reg.attach(chat, v);
    await apply(reg, send(chat, "running"));
    const b = send(chat, "behind the turn");
    await apply(reg, b);
    await reg.shutdown();
    expect(v.of("taken_back")).toEqual([]);
    expect(v.drafts.map((d) => d.text)).not.toContain("behind the turn");
    expect(queued(store, chat)).toContain("behind the turn");
    const next = await life(driver, store);
    expect(bubbles((await next.attach(chat, new RecordingViewer()))!.tail.map((i) => i.e))).toContainEqual(["behind the turn", true, true]);
  });
});

describe("Send again, the next send and Take back (R13)", () => {
  async function restored(over: RegistryOptions = {}) {
    const { reg, driver, store } = await setup({ maxLive: 1 });
    const { other, waits } = await waitingForSlot(reg, driver);
    await reg.shutdown();
    const next = await life(driver, store, over);
    const v = new RecordingViewer();
    const tail = (await next.attach(other, v))!.tail.map((i) => i.e);
    // What a page on the chat draws: the attach's tail, then the live events.
    const drawn = () => bubbles([...tail, ...v.events]);
    return { driver, store, next, other, waits, v, drawn };
  }

  test("Send again starts the chat and sends them in order; Not sent goes; with nothing left it starts nothing", async () => {
    const { driver, store, next, other, drawn } = await restored();
    expect(drawn()).toEqual([
      ["other", true, true],
      ["for the slot", true, true],
    ]);
    expect(await apply(next, { t: "send_queued", rid: rid(), chat: other })).toEqual({ ok: true, result: { started: true } });
    expect(driver.opens).toHaveLength(2);
    expect(driver.last.input.resume).toBeNull();
    expect(driver.last.sent.map((s) => s.text)).toEqual(["other", "for the slot"]);
    expect(drawn()).toEqual([
      ["other", false, false],
      ["for the slot", true, false],
    ]);
    driver.last.emit(turnEnd(), { k: "turn_start", by: "user" }, turnEnd());
    await settle();
    expect(store.queues.has(other)).toBe(false);
    expect(await apply(next, { t: "send_queued", rid: rid(), chat: other })).toEqual({ ok: true, result: { started: false } });
    expect(driver.opens).toHaveLength(2);
  });

  test("the next send sends the restored messages first, in order", async () => {
    const { driver, next, other } = await restored();
    expect((await apply(next, send(other, "a new one"))).ok).toBe(true);
    expect(driver.last.sent.map((s) => s.text)).toEqual(["other", "for the slot", "a new one"]);
  });

  test("Take back of a restored message puts its text in the draft and removes it from the file", async () => {
    const { store, next, other, waits, v, drawn } = await restored();
    expect(await apply(next, { t: "take_back", rid: rid(), chat: other, uuid: waits.uuid })).toEqual({ ok: true, result: { cancelled: true } });
    expect(v.drafts.at(-1)).toMatchObject({ text: "for the slot", mode: "chat" });
    expect(queued(store, other)).toEqual(["other"]);
    expect(drawn()).toEqual([["other", true, true]]);
  });

  test("Send again is refused as a send is: held, archived, an unknown chat, a server that stops", async () => {
    const { driver, next, other } = await restored();
    const sid = crypto.randomUUID();
    driver.transcript(sid, "Held", "/srv/work/app");
    const o = await apply(next, { t: "continue_session", rid: rid(), project: PROJECT, session: sid });
    const held = (o as { result: { chat: string } }).result.chat;
    driver.openNow.set(sid, { app: "terminal", busy: false });
    expect(await apply(next, send(held, "wait"))).toEqual({ ok: false, code: "session_held" });
    expect(await apply(next, { t: "send_queued", rid: rid(), chat: held })).toEqual({ ok: true, result: { started: false } });
    expect(await apply(next, { t: "send_queued", rid: rid(), chat: "abcdefghijabcdefghij" })).toEqual({ ok: false, code: "not_found" });
    expect(await apply(next, { t: "archive", rid: rid(), chat: other, on: true, stop: false })).toEqual({ ok: true, result: null });
    expect(await apply(next, { t: "send_queued", rid: rid(), chat: other })).toEqual({ ok: false, code: "archived" });
    expect(await apply(next, { t: "archive", rid: rid(), chat: other, on: false, stop: false })).toEqual({ ok: true, result: null });
    await next.shutdown();
    expect(await apply(next, { t: "send_queued", rid: rid(), chat: other })).toEqual({ ok: false, code: "restarting" });
  });
});

describe("the drain's rule for sends (setQueueOnly, sendWaiting: the API that RESTART-B builds on)", () => {
  test("a send is kept Queued in its queue file and never given to Claude Code; sendWaiting sends it, live or asleep", async () => {
    const { reg, driver, store } = await setup();
    const live = await newChat(reg, "first");
    const c = driver.last;
    c.emit(turnEnd());
    await settle();
    const v = new RecordingViewer();
    await reg.attach(live, v);
    reg.setQueueOnly(true);
    const m = send(live, "during the drain");
    expect(await apply(reg, m)).toEqual({ ok: true, result: { queued: true } });
    expect(queued(store, live)).toEqual(["during the drain"]);
    expect(c.sent.map((s) => s.text)).toEqual(["first"]);
    expect(bubbles(v.events).at(-1)).toEqual(["during the drain", true, false]);
    reg.setQueueOnly(false);
    reg.sendWaiting();
    await settle();
    expect(c.sent.map((s) => s.text)).toEqual(["first", "during the drain"]);
    expect(bubbles(v.events).at(-1)).toEqual(["during the drain", false, false]);
  });
});

describe("a snapshot after the ring dropped what still waits", () => {
  test("a message in Claude Code's queue, a `!` command and a message behind it, then more events than the ring holds: the tail still draws each, Queued, once", async () => {
    const { reg, driver } = await setup();
    const chat = await newChat(reg, "a long turn");
    const c = driver.last;
    c.emit({ k: "block_start", key: "m1:0", kind: "text", parent: null });
    const cli = send(chat, "behind the long turn");
    expect(await apply(reg, cli)).toEqual({ ok: true, result: { queued: false } });
    const job = rid();
    expect(await apply(reg, { t: "bash", rid: job, chat, input: "git status", draftRev: null, uploads: [] })).toEqual({ ok: true, result: null });
    const behind = send(chat, "behind the command");
    expect(await apply(reg, behind)).toEqual({ ok: true, result: { queued: false } });
    await settle();
    for (let i = 0; i < 2_500; i++) c.emit({ k: "block_delta", key: "m1:0", text: "word " });
    await settle();
    const p = (await reg.attach(chat, new RecordingViewer()))!;
    const seqs = p.tail.map((i) => i.seq);
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);
    expect(new Set(seqs).size).toBe(seqs.length);
    const users = p.tail.flatMap((i) => (i.e.k === "user" ? [[i.e.uuid, i.e.queued] as const] : []));
    expect(users).toEqual([
      [cli.uuid, true],
      [behind.uuid, true],
    ]);
    const jobs = p.tail.flatMap((i) => (i.e.k === "bash" ? [[i.e.uuid, i.e.state] as const] : []));
    expect(jobs).toEqual([[job, "queued"]]);
    for (const i of p.tail) expect(JSON.parse(i.json)).toEqual({ t: "ev", chat, seq: i.seq, e: i.e });
    // Once its turn ran, the message no longer waits: the tail keeps no Queued copy of it.
    c.emit({ k: "block_end", key: "m1:0" }, turnEnd([cli.uuid]));
    await settle();
    const q = (await reg.attach(chat, new RecordingViewer()))!;
    expect(bubbles(q.tail.map((i) => i.e)).find(([t]) => t === "behind the long turn")?.[1] ?? false).toBe(false);
  });
});
