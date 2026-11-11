// The chat socket's frame flow and flow control (DESIGN.md 4.3), on fake sockets whose buffered amount the test sets:
// hello and welcome, the chat list (split under a page), attach (attached, snapshot, the tail, then live events), the
// replay of a reattach (only the missed events; a snapshot for another epoch, a cursor the ring no longer holds, or
// history that changed outside the ring) and its log line, acks to the sender only, the lagging rule (1 MiB) and the paced catch-up (256 KiB), the draft sent once when a socket is
// live again, a new snapshot when the ring dropped what a socket was not sent, a dropped send closing the socket, and
// the long-transcript slow reader: every page, no frame over 256 KiB, one snapshot, never closed.
import { describe, expect, test } from "bun:test";
import { newChatId } from "../../shared/ids";
import { PROTOCOL_VERSION, WIRE, type Card, type ChatEvent, type ClientFrame } from "../../shared/protocol";
import { ChatRegistry } from "../../server/chats/registry";
import { FakeDriver, MemoryStore, projectRecord, settle } from "../../server/chats/testing";
import type { RegistryOptions } from "../../server/chats/types";
import type { LogEvent, LogFields } from "../../server/log";
import type { ChatLedger } from "../../server/store/types";
import { listFrames, wsHandlers, type ChatSock, type WsOptions } from "../../server/ws/handlers";

const PROJECT = "k3m7q2x4ab";
const rid = () => crypto.randomUUID();
type Frame = Record<string, unknown> & { t: string };

class FakeSock implements ChatSock {
  data: { state: unknown } = { state: null };
  readonly sent: string[] = [];
  buffered = 0;
  /** Each send adds its bytes to the buffer (a reader that has not read yet). */
  grow = false;
  sendResult: number | null = null;
  closedWith: { code?: number; reason?: string } | null = null;
  maxBuffered = 0;
  send(s: string): number {
    if (this.closedWith) return 0;
    if (this.sendResult !== null) return this.sendResult;
    this.sent.push(s);
    if (this.grow) this.buffered += Buffer.byteLength(s);
    this.maxBuffered = Math.max(this.maxBuffered, this.buffered);
    return Buffer.byteLength(s);
  }
  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
  }
  getBufferedAmount(): number {
    return this.buffered;
  }
  frames(): Frame[] {
    return this.sent.map((s) => JSON.parse(s) as Frame);
  }
  of(t: string): Frame[] {
    return this.frames().filter((f) => f.t === t);
  }
  evs(chat?: string): { seq: number; e: ChatEvent }[] {
    return this.of("ev").filter((f) => !chat || f.chat === chat) as unknown as { seq: number; e: ChatEvent }[];
  }
}

async function setup(wsOpts: WsOptions = {}, prep?: (d: FakeDriver, s: MemoryStore) => void, regOpts: RegistryOptions = {}) {
  const driver = new FakeDriver();
  const store = new MemoryStore();
  store.projects = [projectRecord(PROJECT)];
  prep?.(driver, store);
  const reg = new ChatRegistry({ driver, store }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500, ...regOpts });
  await reg.boot();
  const hub = wsHandlers(reg, { pumpMs: 5, ...wsOpts });
  const msg = (ws: FakeSock, f: ClientFrame | Record<string, unknown>) => hub.message(ws, JSON.stringify(f));
  const connect = (tab: string): FakeSock => {
    const ws = new FakeSock();
    hub.open(ws);
    msg(ws, { t: "hello", v: 1, tab });
    return ws;
  };
  return { driver, store, reg, hub, msg, connect };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

async function newChat(ctx: Ctx, ws: FakeSock, text = "start"): Promise<string> {
  const r = rid();
  ctx.msg(ws, { t: "new_chat", rid: r, project: PROJECT, uuid: rid(), text, picks: { model: null, effort: null, mode: null }, uploads: [] });
  await settle();
  const a = ws.of("ack").find((f) => f.rid === r)!;
  expect(a.ok).toBe(true);
  return (a.result as { chat: string }).chat;
}

const turnEnd = (): ChatEvent => ({ k: "turn_end", ok: true, subtype: "success", durationMs: 1, error: null, uuids: [] });

describe("hello, ping and bad frames", () => {
  test("hello gets welcome and the chat list; ping gets pong; a second hello is ignored", async () => {
    const ctx = await setup({ host: "devbox" });
    const ws = ctx.connect("tab_a");
    expect(ws.frames().slice(0, 2)).toEqual([
      { t: "welcome", epoch: ctx.reg.epoch, version: "0.1.0", v: PROTOCOL_VERSION, claude: { ok: true, version: "2.1.311", drift: null }, update: { available: false }, auth: "none", host: "devbox", capabilities: { sideQuestions: true, trustFolder: true } },
      { t: "chats", list: [] },
    ]);
    ctx.msg(ws, { t: "ping", n: 7 });
    ctx.msg(ws, { t: "hello", v: 1, tab: "tab_b" });
    expect(ws.frames().slice(2)).toEqual([{ t: "pong", n: 7 }]);
  });

  test("R124: welcome says whether the agent has side questions, so a page shows the side chat only then", async () => {
    const on = await setup();
    expect(on.connect("tab_a").frames()[0]).toMatchObject({ t: "welcome", capabilities: { sideQuestions: true } });
    const off = await setup({}, (d) => void (d.caps = { ...d.caps, sideQuestions: false }));
    expect(off.connect("tab_a").frames()[0]).toMatchObject({ t: "welcome", capabilities: { sideQuestions: false } });
  });

  test("R127: welcome says whether the agent has a trust start, so a refused folder offers Trust this folder only then", async () => {
    const on = await setup();
    expect(on.connect("tab_a").frames()[0]).toMatchObject({ t: "welcome", capabilities: { trustFolder: true } });
    const off = await setup({}, (d) => void (d.caps = { ...d.caps, trustFolder: false }));
    expect(off.connect("tab_a").frames()[0]).toMatchObject({ t: "welcome", capabilities: { sideQuestions: true, trustFolder: false } });
  });

  test("welcome names no machine when the server has no name to show (D54)", async () => {
    const ctx = await setup();
    expect(ctx.connect("tab_a").frames()[0]).toMatchObject({ t: "welcome", host: null });
  });

  test("a frame before hello closes the socket; a bad frame with a rid gets bad_request; binary is no frame", async () => {
    const ctx = await setup();
    const early = new FakeSock();
    ctx.hub.open(early);
    ctx.msg(early, { t: "attach", chat: "k3m7q2x4abk3m7q2x4ab", since: 0, epoch: null });
    expect(early.closedWith?.code).toBe(1008);
    const ws = ctx.connect("tab_a");
    const r = rid();
    ctx.msg(ws, { t: "send", rid: r, chat: "k3m7q2x4abk3m7q2x4ab", uuid: rid(), text: "x" });
    ctx.msg(ws, { t: "nonsense" });
    ctx.hub.message(ws, new Uint8Array([1, 2, 3]));
    ctx.hub.message(ws, "not json");
    expect(ws.of("ack")).toEqual([{ t: "ack", rid: r, ok: false, error: { code: "bad_request", message: "That request could not be read." } }]);
    expect(ws.closedWith).toBeNull();
  });

  test("an attach of an unknown chat gets the gone delta", async () => {
    const ctx = await setup();
    const ws = ctx.connect("tab_a");
    ctx.msg(ws, { t: "attach", chat: "zzzzzzzzzzzzzzzzzzzz", since: 0, epoch: null });
    await settle();
    expect(ws.of("chats").slice(1)).toEqual([{ t: "chats", delta: { chat: "zzzzzzzzzzzzzzzzzzzz", gone: true } }]);
  });
});

describe("requests and acks", () => {
  test("an ack goes to the sender only; the chat-list delta goes to every socket", async () => {
    const ctx = await setup();
    const a = ctx.connect("tab_a");
    const b = ctx.connect("tab_b");
    const chat = await newChat(ctx, a);
    expect(b.of("ack")).toEqual([]);
    for (const ws of [a, b]) expect(ws.of("chats").some((f) => (f.delta as { chat?: string } | undefined)?.chat === chat)).toBe(true);
  });

  test("a resent request gets the same ack and is applied once; a refused one is read again", async () => {
    const ctx = await setup();
    const a = ctx.connect("tab_a");
    const chat = await newChat(ctx, a);
    const r = rid();
    const f = { t: "rename", rid: r, chat, title: "Once" };
    ctx.msg(a, f);
    await settle();
    const b = ctx.connect("tab_a"); // the tab's new socket after a reconnect
    ctx.msg(b, f);
    await settle();
    expect(a.of("ack").filter((x) => x.rid === r)).toEqual([{ t: "ack", rid: r, ok: true, result: null }]);
    expect(b.of("ack").filter((x) => x.rid === r)).toEqual([{ t: "ack", rid: r, ok: true, result: null }]);
    expect(ctx.store.writes.filter((w) => w.title?.text === "Once").length).toBeGreaterThan(0);
    const titles = a.of("chats").filter((x) => (x.delta as { title?: string } | undefined)?.title === "Once");
    expect(titles.length).toBe(1);
    const s = rid();
    ctx.msg(a, { t: "send", rid: s, chat: "zzzzzzzzzzzzzzzzzzzz", uuid: s, text: "x" });
    ctx.msg(a, { t: "send", rid: s, chat: "zzzzzzzzzzzzzzzzzzzz", uuid: s, text: "x" });
    await settle();
    expect(a.of("ack").filter((x) => x.rid === s).length).toBe(2);
  });

  test("Delete: the ack, then {chat, gone: true} to every socket", async () => {
    const ctx = await setup();
    const a = ctx.connect("tab_a");
    const b = ctx.connect("tab_b");
    const chat = await newChat(ctx, a);
    ctx.msg(b, { t: "attach", chat, since: 0, epoch: null });
    await settle();
    const r = rid();
    ctx.msg(a, { t: "delete", rid: r, chat });
    await settle(10);
    const frames = a.frames();
    const ackAt = frames.findIndex((f) => f.t === "ack" && f.rid === r);
    const goneAt = frames.findIndex((f) => f.t === "chats" && (f.delta as { gone?: boolean } | undefined)?.gone === true);
    expect(ackAt).toBeGreaterThan(0);
    expect(goneAt).toBeGreaterThan(ackAt);
    expect(b.of("chats").at(-1)).toEqual({ t: "chats", delta: { chat, gone: true } });
  });
});

describe("attach", () => {
  test("attached, then the snapshot, then the tail; then live events in seq order; detach stops them", async () => {
    const ctx = await setup();
    const a = ctx.connect("tab_a");
    const chat = await newChat(ctx, a, "Plan it");
    ctx.msg(a, { t: "attach", chat, since: 0, epoch: null });
    await settle();
    const after = a.frames().slice(a.frames().findIndex((f) => f.t === "attached"));
    expect(after[0]).toMatchObject({ t: "attached", chat, epoch: ctx.reg.epoch, replay: "snapshot", draft: { rev: 0, text: "" } });
    expect(after[1]).toMatchObject({ t: "snapshot", chat, history: [], more: null });
    expect(after.slice(2).map((f) => (f.e as ChatEvent).k)).toEqual(["turn_start", "user"]);
    expect(after[1]!.seq).toBe((after[2] as unknown as { seq: number }).seq - 1);
    ctx.driver.last.emit({ k: "block", key: "m1:0", kind: "text", text: "hi", parent: null }, turnEnd());
    await settle();
    const seqs = a.evs(chat).map((f) => f.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(a.evs(chat).slice(-2).map((f) => f.e.k)).toEqual(["block", "turn_end"]);
    ctx.msg(a, { t: "detach", chat });
    const n = a.evs(chat).length;
    ctx.driver.last.emit({ k: "notice", text: "after detach" });
    await settle();
    expect(a.evs(chat).length).toBe(n);
  });

  test("the snapshot says how many ev frames follow it: its tail, every one at or below attached.seq (R1)", async () => {
    const ctx = await setup();
    const a = ctx.connect("tab_a");
    const chat = await newChat(ctx, a, "Plan it");
    const c = ctx.driver.last;
    /** A late page's attach: attached, the snapshot, and the ev frames that came before the next live one. */
    const attach = async (tab: string) => {
      const b = ctx.connect(tab);
      ctx.msg(b, { t: "attach", chat, since: 0, epoch: null });
      await settle();
      const frames = b.frames().filter((f) => f.chat === chat);
      const attached = frames.find((f) => f.t === "attached")!;
      const at = frames.findIndex((f) => f.t === "snapshot");
      return { b, attached, snapshot: frames[at]!, tail: frames.slice(at + 1).filter((f) => f.t === "ev").map((f) => f.seq as number) };
    };
    // A turn in flight: its events follow the snapshot.
    c.emit({ k: "session", sessionId: rid(), model: "m", mode: "default", version: "2", bypass: false });
    const mid = await attach("tab_b");
    expect(mid.tail.length).toBeGreaterThan(0);
    expect(mid.snapshot.tail).toBe(mid.tail.length);
    expect(mid.tail.every((s) => s <= (mid.attached.seq as number))).toBe(true);
    // The probe's case: an idle chat whose tail (its newest state event) ends below attached.seq.
    c.emit({ k: "block", key: "m1:0", kind: "text", text: "hello", parent: null }, turnEnd());
    await settle();
    const idle = await attach("tab_c");
    expect(idle.snapshot.tail).toBe(idle.tail.length);
    expect(idle.tail.at(-1)!).toBeLessThan(idle.attached.seq as number);
    // A live event after it is not counted: its seq is above attached.seq.
    c.emit({ k: "notice", text: "live" });
    await settle();
    const live = idle.b.evs(chat).at(-1)!;
    expect(live.e).toEqual({ k: "notice", text: "live" });
    expect(live.seq).toBeGreaterThan(idle.attached.seq as number);
    expect(idle.b.of("snapshot").length).toBe(1);
  });

  test("a draft frame reaches every attached socket, the sender included, as a draft frame", async () => {
    const ctx = await setup();
    const a = ctx.connect("tab_a");
    const b = ctx.connect("tab_b");
    const chat = await newChat(ctx, a);
    ctx.msg(a, { t: "attach", chat, since: 0, epoch: null });
    ctx.msg(b, { t: "attach", chat, since: 0, epoch: null });
    await settle();
    ctx.msg(a, { t: "draft", chat, text: "hello", mode: "chat", command: null, link: false, uploads: [] });
    await settle();
    for (const ws of [a, b]) expect(ws.of("draft")).toEqual([expect.objectContaining({ t: "draft", chat, rev: 1, text: "hello", by: "tab_a" })]);
    expect(a.of("ack").length).toBe(1); // only new_chat's: a draft has no ack
  });
});

describe("the replay (R2 to R4, R9)", () => {
  const card = (id: string): Card => ({
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

  /** A page drew the chat to its last event, then lost its socket: `since` is the cursor its next attach names. */
  async function away(ctx: Ctx): Promise<{ chat: string; since: number }> {
    const a = ctx.connect("tab_a");
    const chat = await newChat(ctx, a, "Plan it");
    ctx.msg(a, { t: "attach", chat, since: 0, epoch: null });
    await settle();
    const since = ctx.reg.seq(chat);
    ctx.hub.close(a);
    return { chat, since };
  }

  /** The tab's next socket attaches with `since` and `epoch`; what it got for the chat. */
  async function back(ctx: Ctx, chat: string, since: number, epoch: string | null = ctx.reg.epoch) {
    const b = ctx.connect("tab_a");
    ctx.msg(b, { t: "attach", chat, since, epoch });
    await settle();
    return { b, frames: b.frames().filter((f) => f.chat === chat) };
  }

  test("a reattach whose since is in the ring gets attached (the waiting card in cards), then exactly the missed ev frames in order, and no snapshot", async () => {
    const ctx = await setup();
    const { chat, since } = await away(ctx);
    const c = ctx.driver.last;
    c.emit({ k: "block_start", key: "m2:0", kind: "text", parent: null });
    for (let i = 0; i < 50; i++) c.emit({ k: "block_delta", key: "m2:0", text: `w${i} ` });
    c.emit({ k: "block_end", key: "m2:0" });
    void c.ask(card("toolu_1")).answer;
    await settle();
    const { b, frames } = await back(ctx, chat, since);
    expect(frames[0]).toMatchObject({ t: "attached", replay: "events", cursor: since, seq: ctx.reg.seq(chat), cards: [{ id: "toolu_1" }] });
    expect(b.of("snapshot")).toEqual([]);
    expect(frames.slice(1).every((f) => f.t === "ev")).toBe(true);
    // On a slow link a replay costs no more than the text: the block's run of 50 deltas goes as one delta with the
    // whole text, numbered with the last delta's seq; the start, the end and the card each go as they are, in order.
    const evs = b.evs(chat);
    expect(evs.map((f) => f.e.k).sort()).toEqual(["block_delta", "block_end", "block_start", "card_open"]);
    expect(evs.filter((f) => f.e.k === "block_delta").map((f) => f.e)).toEqual([{ k: "block_delta", key: "m2:0", text: Array.from({ length: 50 }, (_, i) => `w${i} `).join("") }]);
    const seqs = evs.map((f) => f.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(seqs.at(-1)).toBe(ctx.reg.seq(chat));
    expect(evs.find((f) => f.e.k === "block_delta")!.seq).toBe(evs.find((f) => f.e.k === "block_end")!.seq - 1);
    // Live events follow, once each.
    c.emit({ k: "notice", text: "live" });
    await settle();
    expect(b.evs(chat).at(-1)).toMatchObject({ seq: ctx.reg.seq(chat), e: { k: "notice", text: "live" } });
    expect(new Set(b.evs(chat).map((f) => f.seq)).size).toBe(b.evs(chat).length);
  });

  test("since equal to the last seq gets attached with replay none, and nothing else", async () => {
    const ctx = await setup();
    const { chat, since } = await away(ctx);
    const { frames } = await back(ctx, chat, since);
    expect(frames).toEqual([expect.objectContaining({ t: "attached", replay: "none", cursor: since, seq: since })]);
  });

  test("another epoch, since 0, since above the last seq and since older than the ring each get a snapshot", async () => {
    const ctx = await setup();
    const { chat, since } = await away(ctx);
    for (const [s, epoch] of [
      [since, "lz2k3m-otherepochxx"],
      [0, ctx.reg.epoch],
      [ctx.reg.seq(chat) + 5, ctx.reg.epoch],
    ] as const) {
      const { b, frames } = await back(ctx, chat, s, epoch);
      expect(frames[0]).toMatchObject({ t: "attached", replay: "snapshot" });
      expect(frames[0]!.cursor).toBeUndefined();
      expect(b.of("snapshot").length).toBe(1);
    }
    for (let i = 0; i < WIRE.ringEvents + 10; i++) ctx.driver.last.emit({ k: "notice", text: `n${i}` });
    await settle(20);
    const old = await back(ctx, chat, since);
    expect(old.frames[0]).toMatchObject({ t: "attached", replay: "snapshot" });
    expect(old.b.of("snapshot").length).toBe(1);
    expect(old.b.evs(chat).at(-1)!.e).toEqual({ k: "notice", text: `n${WIRE.ringEvents + 9}` });
  });

  test("a ring that drops events during the catch-up gives a new snapshot", async () => {
    const ctx = await setup();
    const { chat, since } = await away(ctx);
    ctx.driver.last.emit({ k: "notice", text: "missed" });
    await settle();
    const b = ctx.connect("tab_a");
    b.buffered = WIRE.lagHighBytes + 1; // a slow link: the catch-up waits for the buffer
    ctx.msg(b, { t: "attach", chat, since, epoch: ctx.reg.epoch });
    await settle();
    for (let i = 0; i < WIRE.ringEvents + 10; i++) ctx.driver.last.emit({ k: "notice", text: `n${i}` });
    await settle(20);
    b.buffered = 0;
    ctx.hub.drain(b);
    await settle();
    ctx.hub.drain(b);
    expect(b.of("attached").map((f) => f.replay)).toEqual(["events", "snapshot"]);
    expect(b.of("snapshot").length).toBe(1);
    expect(b.evs(chat).at(-1)!.e).toEqual({ k: "notice", text: `n${WIRE.ringEvents + 9}` });
  });

  test("history that changed outside the ring: after a D58 hold ends, the next attach gets a snapshot (R4)", async () => {
    const ctx = await setup({}, undefined, { openCheckMs: 10, openFastMs: 10 });
    const { chat, since } = await away(ctx);
    const c = ctx.driver.last;
    const sid = c.input.sessionId!.value;
    c.emit(turnEnd());
    await settle();
    // Another app opens the session: kitespan gives it up; that app's turns go to the transcript, never to the ring.
    ctx.driver.openNow.set(sid, { app: "terminal", busy: false });
    for (let i = 0; i < 100 && !ctx.reg.list().find((r) => r.chat === chat)?.held; i++) await Bun.sleep(5);
    ctx.driver.openNow.delete(sid);
    for (let i = 0; i < 100 && ctx.reg.list().find((r) => r.chat === chat)?.held; i++) await Bun.sleep(5);
    expect(ctx.reg.list().find((r) => r.chat === chat)?.held).toBeUndefined();
    const { b, frames } = await back(ctx, chat, since);
    expect(frames[0]).toMatchObject({ t: "attached", replay: "snapshot" });
    expect(b.of("snapshot").length).toBe(1);
  });

  test("one reconnect log line per attach with since above 0: the chat, ok (true for a replay, false for a snapshot) and ms", async () => {
    const lines: ({ ev: LogEvent } & LogFields)[] = [];
    const ctx = await setup({ log: { log: (ev, f) => lines.push({ ev, ...f }) } });
    const { chat, since } = await away(ctx);
    ctx.driver.last.emit({ k: "notice", text: "missed" });
    await settle();
    await back(ctx, chat, since);
    await back(ctx, chat, since, "lz2k3m-otherepochxx");
    await back(ctx, chat, 0);
    expect(lines.filter((l) => l.ev === "reconnect")).toEqual([
      { ev: "reconnect", chat, ok: true, ms: expect.any(Number) },
      { ev: "reconnect", chat, ok: false, ms: expect.any(Number) },
    ]);
  });
});

describe("backpressure", () => {
  test("over 1 MiB a socket lags and gets no live events; under 256 KiB it catches up in order, and gets the current draft once", async () => {
    const ctx = await setup();
    const a = ctx.connect("tab_a");
    const chat = await newChat(ctx, a);
    ctx.msg(a, { t: "attach", chat, since: 0, epoch: null });
    await settle();
    const c = ctx.driver.last;
    const before = a.evs(chat).length;
    a.buffered = WIRE.lagHighBytes + 1;
    c.emit({ k: "notice", text: "one" }, { k: "notice", text: "two" }, { k: "notice", text: "three" });
    ctx.msg(a, { t: "draft", chat, text: "typed meanwhile", mode: "chat", command: null, link: false, uploads: [] });
    ctx.msg(a, { t: "draft", chat, text: "typed meanwhile, more", mode: "chat", command: null, link: false, uploads: [] });
    await settle();
    expect(a.evs(chat).length).toBe(before);
    expect(a.of("draft")).toEqual([]);
    a.buffered = WIRE.lagLowBytes + 1; // still over the low mark: nothing yet
    ctx.hub.drain(a);
    expect(a.evs(chat).length).toBe(before);
    a.buffered = 0;
    ctx.hub.drain(a);
    const got = a.evs(chat).slice(before);
    expect(got.map((f) => (f.e as { text?: string }).text)).toEqual(["one", "two", "three"]);
    expect(a.of("draft")).toEqual([expect.objectContaining({ rev: 2, text: "typed meanwhile, more" })]);
    c.emit({ k: "notice", text: "live again" });
    await settle();
    expect(a.evs(chat).at(-1)!.e).toEqual({ k: "notice", text: "live again" });
  });

  test("the catch-up resumes on its timer when no drain comes", async () => {
    const ctx = await setup({ pumpMs: 5 });
    const a = ctx.connect("tab_a");
    const chat = await newChat(ctx, a);
    ctx.msg(a, { t: "attach", chat, since: 0, epoch: null });
    await settle();
    a.buffered = WIRE.lagHighBytes + 1;
    ctx.driver.last.emit({ k: "notice", text: "late" });
    await settle();
    a.buffered = 0;
    await Bun.sleep(30);
    expect(a.evs(chat).at(-1)!.e).toEqual({ k: "notice", text: "late" });
  });

  test("when the ring dropped what a lagging socket was not sent, it starts again from a snapshot", async () => {
    const ctx = await setup();
    const a = ctx.connect("tab_a");
    const chat = await newChat(ctx, a);
    ctx.msg(a, { t: "attach", chat, since: 0, epoch: null });
    await settle();
    a.buffered = WIRE.lagHighBytes + 1;
    for (let i = 0; i < WIRE.ringEvents + 10; i++) ctx.driver.last.emit({ k: "notice", text: `n${i}` });
    await settle(20);
    a.buffered = 0;
    ctx.hub.drain(a);
    await settle();
    ctx.hub.drain(a);
    expect(a.of("attached").length).toBe(2);
    expect(a.of("snapshot").length).toBe(2);
    const last = a.evs(chat).at(-1)!;
    expect(last.e).toEqual({ k: "notice", text: `n${WIRE.ringEvents + 9}` });
  });

  test("a send that Bun dropped (0) closes the socket", async () => {
    const ctx = await setup();
    const a = ctx.connect("tab_a");
    a.sendResult = 0;
    ctx.msg(a, { t: "ping", n: 1 });
    expect(a.closedWith?.code).toBe(1013);
  });

  test("Bun's settings for the socket are DESIGN 4.3's", async () => {
    const { CHAT_SOCKET_OPTIONS } = await import("../../server/ws/handlers");
    expect(CHAT_SOCKET_OPTIONS).toEqual({
      maxPayloadLength: 1024 * 1024,
      idleTimeout: 60,
      sendPings: true,
      backpressureLimit: 4 * 1024 * 1024,
      closeOnBackpressureLimit: true,
      perMessageDeflate: false,
    });
  });
});

describe("the chat list", () => {
  test("a list over a page goes as one list frame under 256 KiB and deltas for the rest", async () => {
    const rows = Array.from({ length: 3_000 }, (_, i) => ({
      chat: `chat${String(i).padStart(16, "a")}`,
      title: `A chat with a long enough title number ${i}`.padEnd(100, "."),
      project: PROJECT,
      state: "sleeping" as const,
      needsYou: false,
      lastActivity: "2026-10-31T10:00:00.000Z",
      archived: false,
    }));
    const frames = listFrames(rows);
    expect(Buffer.byteLength(frames[0]!)).toBeLessThanOrEqual(WIRE.pageBytes);
    const list = (JSON.parse(frames[0]!) as { list: unknown[] }).list;
    expect(list.length + frames.length - 1).toBe(3_000);
    expect(frames.slice(1).every((f) => (JSON.parse(f) as { delta?: unknown }).delta !== undefined)).toBe(true);
  });

  test("hello with many chats in the store: every row arrives, no frame over a page", async () => {
    const ctx = await setup({}, (_d, s) => {
      for (let i = 0; i < 1_500; i++) {
        let id = newChatId();
        while (s.chats.has(id)) id = newChatId();
        const rec: ChatLedger = {
          v: 1,
          id,
          project: PROJECT,
          cwd: "/srv/work/app",
          agent: "claude-code",
          sessionId: null,
          title: { text: "x".repeat(120), from: "renamed" },
          picks: { model: null, effort: null, permissionMode: null },
          createdAt: "2026-10-30T08:00:00.000Z",
          seenAt: "2026-10-30T08:00:00.000Z",
          lastActivityAt: "2026-10-30T08:00:00.000Z",
          lastSeq: 0,
          state: "sleeping",
          lastExit: null,
          archivedAt: null,
        };
        s.chats.set(id, rec);
      }
    });
    const a = ctx.connect("tab_a");
    expect(a.sent.every((s) => Buffer.byteLength(s) <= WIRE.pageBytes)).toBe(true);
    const chats = a.of("chats");
    const n = ((chats[0]!.list as unknown[]) ?? []).length + chats.slice(1).length;
    expect(ctx.reg.list().length).toBe(1_500);
    expect(n).toBe(1_500);
  });
});

describe("the long transcript and the slow reader (4.3)", () => {
  test("every page arrives, no frame is over 256 KiB, one snapshot only, and the limit never closes the socket", async () => {
    const PAGE = 120;
    const ctx = await setup();
    const sid = rid();
    // About 6 MiB of history in pages: each event about 10 KB.
    const history: ChatEvent[] = Array.from({ length: 600 }, (_, i) => ({ k: "block", key: `h${i}:0`, kind: "text", text: `${i} ${"word ".repeat(2_000)}`, parent: null }));
    ctx.driver.transcript(sid, "Long chat");
    ctx.driver.history = async (_s: string, _cwd: string, page: { before: string | null; maxBytes: number }) => {
      const end = page.before === null ? history.length : Number(page.before);
      let start = Math.max(0, end - PAGE);
      while (start < end && Buffer.byteLength(JSON.stringify(history.slice(start, end))) > page.maxBytes) start++;
      return { events: history.slice(start, end), more: start > 0 ? String(start) : null };
    };
    const a = ctx.connect("tab_a");
    const r = rid();
    ctx.msg(a, { t: "continue_session", rid: r, project: PROJECT, session: sid });
    await settle();
    const chat = (a.of("ack").find((f) => f.rid === r)!.result as { chat: string }).chat;
    // A turn runs while the reader is slow: each frame stays in its buffer until the test reads.
    a.grow = true;
    ctx.msg(a, { t: "attach", chat, since: 0, epoch: null });
    const s = rid();
    ctx.msg(a, { t: "send", rid: s, chat, uuid: s, text: "go on" });
    await settle();
    const c = ctx.driver.last;
    for (let i = 0; i < 400; i++) c.emit({ k: "block_delta", key: "live:0", text: `${i} ${"x".repeat(3_000)}` });
    c.emit(turnEnd());
    // Read 64 KiB at a time.
    let more: string | null = null;
    for (let round = 0; round < 2_000; round++) {
      await settle(1);
      a.buffered = Math.max(0, a.buffered - 64 * 1024);
      ctx.hub.drain(a);
      if (a.buffered === 0 && a.evs(chat).some((f) => f.e.k === "turn_end")) break;
    }
    a.grow = false;
    const snap = a.of("snapshot");
    expect(snap.length).toBe(1);
    more = snap[0]!.more as string | null;
    // Older pages on request.
    let pages = 1;
    let seen = (snap[0]!.history as unknown[]).length;
    while (more !== null) {
      const g = rid();
      ctx.msg(a, { t: "get", rid: g, chat, what: "history", before: more });
      await settle();
      const ack = a.of("ack").find((f) => f.rid === g)!;
      const res = ack.result as { history: unknown[]; more: string | null };
      seen += res.history.length;
      more = res.more;
      pages++;
    }
    expect(seen).toBe(history.length);
    expect(pages).toBeGreaterThan(10);
    expect(a.sent.every((x) => Buffer.byteLength(x) <= WIRE.pageBytes)).toBe(true);
    expect(a.closedWith).toBeNull();
    expect(a.maxBuffered).toBeLessThan(WIRE.backpressureBytes);
    // Every piece's text arrives once, in order; the catch-up sends a run of them as fewer deltas (each under a page).
    const deltas = a.evs(chat).filter((f) => f.e.k === "block_delta");
    expect(deltas.map((f) => (f.e as { text: string }).text).join("")).toBe(Array.from({ length: 400 }, (_, i) => `${i} ${"x".repeat(3_000)}`).join(""));
    expect(deltas.length).toBeLessThan(400);
    const seqs = a.evs(chat).map((f) => f.seq);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
    expect(seqs.at(-1)).toBe(ctx.reg.seq(chat));
  });
});

describe("bye and notice", () => {
  test("notice goes to every socket; bye goes to every socket, which is then closed", async () => {
    const ctx = await setup();
    const a = ctx.connect("tab_a");
    const b = ctx.connect("tab_b");
    ctx.hub.notice("kitespan restarts when the running turns end");
    ctx.hub.bye("shutdown");
    for (const ws of [a, b]) {
      expect(ws.of("notice")).toEqual([{ t: "notice", text: "kitespan restarts when the running turns end" }]);
      expect(ws.of("bye")).toEqual([{ t: "bye", reason: "shutdown" }]);
      expect(ws.closedWith?.code).toBe(1001);
    }
  });

  test("a closed socket stops counting as a viewer", async () => {
    const ctx = await setup();
    const a = ctx.connect("tab_a");
    const chat = await newChat(ctx, a);
    ctx.msg(a, { t: "attach", chat, since: 0, epoch: null });
    await settle();
    ctx.hub.close(a);
    expect(ctx.hub.size).toBe(0);
    const n = a.sent.length;
    ctx.driver.last.emit({ k: "notice", text: "nobody listens" });
    await settle();
    expect(a.sent.length).toBe(n);
  });
});
