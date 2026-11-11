// The registry's side of the replay (DESIGN.md 4.3, 9.4): an attach whose cursor is in this epoch's ring gets the
// replay payload (no snapshot, no history read, the draft still loaded); next() says "gap" when the ring no longer
// holds what follows a cursor below the chat's last seq (R3); and a sleeping chat's ring goes after 30 minutes with
// no viewer, so a later attach takes the snapshot path (R8, on Bun's fake timers).
import { afterEach, describe, expect, jest, test } from "bun:test";
import { ChatRegistry } from "../../server/chats/registry";
import { FakeDriver, MemoryStore, RecordingViewer, apply, projectRecord, settle } from "../../server/chats/testing";

const PROJECT = "k3m7q2x4ab";
const RING_KEEP_MS = 30 * 60_000;
const rid = () => crypto.randomUUID();
const turnEnd = (uuids: string[] = []) => ({ k: "turn_end" as const, ok: true, subtype: "success", durationMs: 3, error: null, uuids });

afterEach(() => {
  jest.useRealTimers();
});

async function setup() {
  const driver = new FakeDriver();
  const store = new MemoryStore();
  store.projects = [projectRecord(PROJECT)];
  // D2's idle limit far above the ring's 30 minutes, so the fake clock never ends a live chat here.
  const reg = new ChatRegistry({ driver, store }, { idleMs: 4 * 60 * 60_000, closeGraceMs: 20, shutdownMs: 500 });
  await reg.boot();
  let reads = 0;
  const history = driver.history.bind(driver);
  driver.history = (...a: Parameters<FakeDriver["history"]>) => {
    reads++;
    return history(...a);
  };
  return { driver, store, reg, reads: () => reads };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

/** A chat whose first turn ended, attached by a page: its claude process is idle. */
async function liveChat(ctx: Ctx) {
  const o = await apply(ctx.reg, { t: "new_chat", rid: rid(), project: PROJECT, uuid: rid(), text: "start", picks: { model: null, effort: null, mode: null }, uploads: [] });
  const chat = (o as { result: { chat: string } }).result.chat;
  ctx.driver.last.emit(turnEnd());
  await settle();
  const page = new RecordingViewer();
  await ctx.reg.attach(chat, page);
  return { chat, page };
}

describe("the replay payload (R2)", () => {
  test("a cursor in this epoch's ring: no snapshot and no history read, the draft still loads, cursor is since", async () => {
    const ctx = await setup();
    const { chat } = await liveChat(ctx);
    await ctx.reg.draftEdit({ t: "draft", chat, text: "typed on the phone", mode: "chat", command: null, link: false, uploads: [] }, "tab_b");
    const since = ctx.reg.seq(chat);
    ctx.driver.last.emit({ k: "notice", text: "missed" });
    await settle();
    const before = ctx.reads();
    const p = (await ctx.reg.attach(chat, new RecordingViewer(), { since, epoch: ctx.reg.epoch }))!;
    expect(p.snapshot).toBeUndefined();
    expect(p.tail).toEqual([]);
    expect(p.cursor).toBe(since);
    expect(p.attached).toMatchObject({ replay: "events", cursor: since, seq: since + 1, draft: { text: "typed on the phone" } });
    expect(ctx.reads()).toBe(before);
    expect(ctx.reg.next(chat, since)).toMatchObject({ seq: since + 1, e: { k: "notice", text: "missed" } });
    // Nothing missed: none.
    const q = (await ctx.reg.attach(chat, new RecordingViewer(), { since: since + 1, epoch: ctx.reg.epoch }))!;
    expect(q.attached).toMatchObject({ replay: "none", cursor: since + 1 });
    // No cursor: the snapshot path, as before.
    const s = (await ctx.reg.attach(chat, new RecordingViewer()))!;
    expect(s.attached.replay).toBe("snapshot");
    expect(s.snapshot.t).toBe("snapshot");
    expect(ctx.reads()).toBe(before + 1);
  });

  test("a chat rebuilt at boot: a cursor at or below the ledger's last seq gets a snapshot, even with this epoch (R4)", async () => {
    const ctx = await setup();
    const { chat } = await liveChat(ctx);
    await ctx.reg.shutdown();
    const reg = new ChatRegistry({ driver: ctx.driver, store: ctx.store }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500, epoch: ctx.reg.epoch });
    await reg.boot();
    const last = reg.seq(chat);
    expect(last).toBeGreaterThan(0);
    const p = (await reg.attach(chat, new RecordingViewer(), { since: last, epoch: reg.epoch }))!;
    expect(p.attached.replay).toBe("snapshot");
    expect(p.snapshot).toBeDefined();
  });
});

describe("next() and a ring that no longer holds the cursor (R3)", () => {
  test("an emptied ring and a cursor below the last seq: gap, and an attach from it takes the snapshot path", async () => {
    const ctx = await setup();
    const { chat, page } = await liveChat(ctx);
    const since = ctx.reg.seq(chat) - 2;
    ctx.driver.last.end();
    await settle();
    jest.useFakeTimers();
    ctx.reg.detach(chat, page);
    jest.advanceTimersByTime(RING_KEEP_MS);
    jest.useRealTimers();
    expect(ctx.reg.next(chat, since)).toBe("gap");
    expect(ctx.reg.next(chat, ctx.reg.seq(chat))).toBeNull();
    const p = (await ctx.reg.attach(chat, new RecordingViewer(), { since, epoch: ctx.reg.epoch }))!;
    expect(p.attached.replay).toBe("snapshot");
    expect(p.snapshot).toBeDefined();
  });
});

describe("ring memory (R8, L11)", () => {
  test("a sleeping chat's ring goes after 30 minutes with no viewer; a later attach takes the snapshot path", async () => {
    const ctx = await setup();
    const { chat, page } = await liveChat(ctx);
    ctx.driver.last.end();
    await settle();
    expect(ctx.reg.stateOf(chat)).toBe("sleeping");
    const since = ctx.reg.seq(chat) - 1;
    jest.useFakeTimers();
    // A viewer keeps it.
    jest.advanceTimersByTime(RING_KEEP_MS * 2);
    expect(ctx.reg.next(chat, since)).not.toBe("gap");
    ctx.reg.detach(chat, page);
    jest.advanceTimersByTime(RING_KEEP_MS - 1);
    expect(ctx.reg.next(chat, since)).toMatchObject({ seq: since + 1 });
    jest.advanceTimersByTime(1);
    expect(ctx.reg.next(chat, since)).toBe("gap");
    jest.useRealTimers();
    const p = (await ctx.reg.attach(chat, new RecordingViewer(), { since, epoch: ctx.reg.epoch }))!;
    expect(p.attached.replay).toBe("snapshot");
  });

  test("a live chat keeps its ring with no viewer", async () => {
    const ctx = await setup();
    const { chat, page } = await liveChat(ctx);
    const since = ctx.reg.seq(chat) - 1;
    jest.useFakeTimers();
    ctx.reg.detach(chat, page);
    jest.advanceTimersByTime(RING_KEEP_MS * 2);
    expect(ctx.reg.stateOf(chat)).toBe("idle");
    expect(ctx.reg.next(chat, since)).toMatchObject({ seq: since + 1 });
  });

  test("a viewer that comes back within the 30 minutes stops the clock", async () => {
    const ctx = await setup();
    const { chat, page } = await liveChat(ctx);
    ctx.driver.last.end();
    await settle();
    const since = ctx.reg.seq(chat) - 1;
    jest.useFakeTimers();
    ctx.reg.detach(chat, page);
    jest.advanceTimersByTime(RING_KEEP_MS - 10);
    // The viewer counts at once, before the attach's reads.
    void ctx.reg.attach(chat, new RecordingViewer(), { since, epoch: ctx.reg.epoch });
    jest.advanceTimersByTime(RING_KEEP_MS * 2);
    expect(ctx.reg.next(chat, since)).toMatchObject({ seq: since + 1 });
    jest.useRealTimers();
    await settle();
  });
});
