// The /ws protocol end to end (DESIGN.md 4.3; D49; checklist A8 and F4): a Bun server on a free port of 127.0.0.1
// with the chat socket's handlers and Bun settings, the scripted driver behind the registry, and two Bun WebSocket
// clients, a laptop and a phone, on one chat. One open() for the chat with two viewers; each ack to its sender only;
// both pages see both messages; a resend is applied once; the first answer to a card wins; a draft reaches both pages
// and comes back in `attached`; Delete sends {chat, gone: true} to both; no frame is over 256 KiB; a page whose socket
// drops mid-turn gets only what it missed when it attaches again with its cursor.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { WIRE, type ChatEvent, type PermissionCard } from "../../shared/protocol";
import { ChatRegistry } from "../../server/chats/registry";
import { FakeDriver, MemoryStore, autoReply, projectRecord } from "../../server/chats/testing";
import { CHAT_SOCKET_OPTIONS, wsHandlers, type ChatSocketServer } from "../../server/ws/handlers";

/** The server binds port 0, so the system picks a free one; set once it listens. */
let PORT = 0;
const PROJECT = "k3m7q2x4ab";
const rid = () => crypto.randomUUID();
type Frame = Record<string, unknown> & { t: string };

interface SocketData {
  route: "/ws";
  state: unknown;
}

let server: ReturnType<typeof Bun.serve<SocketData>>;
let hub: ChatSocketServer;
let driver: FakeDriver;
let reg: ChatRegistry;

class Client {
  readonly frames: Frame[] = [];
  readonly sizes: number[] = [];
  private waiters: { pred: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = [];
  closed = false;
  private constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (ev) => {
      const text = String(ev.data);
      this.sizes.push(Buffer.byteLength(text));
      const f = JSON.parse(text) as Frame;
      this.frames.push(f);
      this.waiters = this.waiters.filter((w) => {
        if (!w.pred(f)) return true;
        w.resolve(f);
        return false;
      });
    });
    ws.addEventListener("close", () => (this.closed = true));
  }

  static async open(tab: string): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${WIRE.path}`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("socket error")), { once: true });
    });
    const c = new Client(ws);
    const welcome = c.next((f) => f.t === "welcome");
    c.send({ t: "hello", v: 1, tab });
    await welcome;
    await c.next((f) => f.t === "chats", true);
    return c;
  }

  send(f: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(f));
  }

  /** The first frame (already received, when `seen`) that matches, or the next one. */
  next(pred: (f: Frame) => boolean, seen = false, ms = 2_000): Promise<Frame> {
    if (seen) {
      const f = this.frames.find(pred);
      if (f) return Promise.resolve(f);
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timed out waiting for a frame")), ms);
      this.waiters.push({ pred, resolve: (f) => (clearTimeout(t), resolve(f)) });
    });
  }

  ack(r: string): Promise<Frame> {
    return this.next((f) => f.t === "ack" && f.rid === r, true);
  }

  evs(chat: string): ChatEvent[] {
    return this.frames.filter((f) => f.t === "ev" && f.chat === chat).map((f) => f.e as ChatEvent);
  }

  close(): void {
    this.ws.close();
  }
}

beforeAll(async () => {
  driver = new FakeDriver();
  autoReply(driver, 10);
  const store = new MemoryStore();
  store.projects = [projectRecord(PROJECT)];
  reg = new ChatRegistry({ driver, store }, { idleMs: 60_000, closeGraceMs: 50, shutdownMs: 1_000 });
  await reg.boot();
  hub = wsHandlers(reg);
  server = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === WIRE.path && srv.upgrade(req, { data: { route: "/ws", state: null } })) return undefined;
      return new Response("not here", { status: 404 });
    },
    websocket: {
      ...CHAT_SOCKET_OPTIONS,
      open: (ws) => hub.open(ws),
      message: (ws, m) => hub.message(ws, m),
      close: (ws, code, reason) => hub.close(ws, code, reason),
      drain: (ws) => hub.drain(ws),
    },
  });
  PORT = server.port!;
});

afterAll(async () => {
  hub.bye("shutdown");
  await reg.shutdown();
  server.stop(true);
});

describe("/ws with two pages on one chat", () => {
  test("the whole flow", async () => {
    const laptop = await Client.open("laptop_tab");
    const phone = await Client.open("phone_tab");

    // Start on the laptop: one chat, its row on both pages.
    const r0 = rid();
    const u0 = rid();
    laptop.send({ t: "new_chat", rid: r0, project: PROJECT, uuid: u0, text: "Plan the upload feature", picks: { model: null, effort: null, mode: null } });
    const a0 = await laptop.ack(r0);
    expect(a0.ok).toBe(true);
    const chat = (a0.result as { chat: string }).chat;
    await phone.next((f) => f.t === "chats" && (f.delta as { chat?: string } | undefined)?.chat === chat, true);

    // Both pages attach: attached before the snapshot, then the tail.
    for (const c of [laptop, phone]) c.send({ t: "attach", chat, since: 0, epoch: null });
    for (const c of [laptop, phone]) {
      const at = await c.next((f) => f.t === "attached" && f.chat === chat, true);
      expect(at).toMatchObject({ epoch: reg.epoch, replay: "snapshot", archived: false });
      const snap = await c.next((f) => f.t === "snapshot" && f.chat === chat, true);
      expect(c.frames.indexOf(at)).toBeLessThan(c.frames.indexOf(snap));
    }
    await laptop.next((f) => f.t === "ev" && (f.e as ChatEvent).k === "turn_end", true);
    await phone.next((f) => f.t === "ev" && (f.e as ChatEvent).k === "turn_end", true);

    // Two senders: each ack to its own page; both pages see both messages; one process.
    const ra = rid();
    const rb = rid();
    laptop.send({ t: "send", rid: ra, chat, uuid: ra, text: "from the laptop", draftRev: null });
    phone.send({ t: "send", rid: rb, chat, uuid: rb, text: "from the phone", draftRev: null });
    expect((await laptop.ack(ra)).ok).toBe(true);
    expect((await phone.ack(rb)).ok).toBe(true);
    for (const c of [laptop, phone]) {
      await c.next((f) => f.t === "ev" && (f.e as ChatEvent).k === "user" && (f.e as { uuid: string }).uuid === rb, true);
      const users = c.evs(chat).filter((e): e is Extract<ChatEvent, { k: "user" }> => e.k === "user");
      expect(new Set(users.map((u) => u.uuid))).toEqual(new Set([u0, ra, rb]));
    }
    expect(laptop.frames.some((f) => f.t === "ack" && f.rid === rb)).toBe(false);
    expect(phone.frames.some((f) => f.t === "ack" && f.rid === ra)).toBe(false);
    expect(driver.opens.length).toBe(1);
    expect(driver.last.sent.map((s) => s.text)).toEqual(["Plan the upload feature", "from the laptop", "from the phone"]);

    // A resend after a drop: the same ack, applied once.
    laptop.send({ t: "send", rid: ra, chat, uuid: ra, text: "from the laptop", draftRev: null });
    await laptop.next((f) => f.t === "ack" && f.rid === ra && laptop.frames.filter((x) => x.t === "ack" && x.rid === ra).length === 2, true);
    expect(driver.last.sent.filter((s) => s.uuid === ra).length).toBe(1);

    // A card: both pages see it; the first answer wins, the other page gets stale.
    await laptop.next((f) => f.t === "ev" && (f.e as ChatEvent).k === "turn_end" && laptop.evs(chat).filter((e) => e.k === "turn_end").length >= 3, true);
    const card: PermissionCard = {
      kind: "permission",
      id: "toolu_01race",
      toolUseId: "toolu_01race",
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
    };
    const asked = driver.last.ask(card);
    for (const c of [laptop, phone]) await c.next((f) => f.t === "ev" && (f.e as ChatEvent).k === "card_open", true);
    const qa = rid();
    const qb = rid();
    laptop.send({ t: "answer", rid: qa, chat, card: card.id, answer: { kind: "permission", allow: false, message: "not now" } });
    phone.send({ t: "answer", rid: qb, chat, card: card.id, answer: { kind: "permission", allow: true, scope: "once" } });
    const [aa, ab] = await Promise.all([laptop.ack(qa), phone.ack(qb)]);
    expect([aa.ok, ab.ok].sort()).toEqual([false, true]);
    expect(((aa.ok ? ab : aa).error as { code: string }).code).toBe("stale");
    expect(await asked.answer).not.toBeNull();
    for (const c of [laptop, phone]) await c.next((f) => f.t === "ev" && (f.e as ChatEvent).k === "card_close", true);

    // The draft: from the laptop to both pages, then in the phone's next attached.
    laptop.send({ t: "draft", chat, text: "half a thought", mode: "chat", command: null, link: false, uploads: [] });
    for (const c of [laptop, phone]) {
      const d = await c.next((f) => f.t === "draft" && f.chat === chat, true);
      expect(d).toMatchObject({ text: "half a thought", by: "laptop_tab" });
    }
    phone.send({ t: "attach", chat, since: 0, epoch: reg.epoch });
    const again = await phone.next((f) => f.t === "attached" && (f.draft as { text: string }).text === "half a thought", true);
    expect((again.draft as { rev: number }).rev).toBeGreaterThan(0);

    // Ping.
    phone.send({ t: "ping", n: 41 });
    expect(await phone.next((f) => f.t === "pong", true)).toEqual({ t: "pong", n: 41 });

    // Delete from the phone: its ack, then {chat, gone: true} on both pages.
    const rd = rid();
    phone.send({ t: "delete", rid: rd, chat });
    const ad = await phone.ack(rd);
    expect(ad.ok).toBe(true);
    for (const c of [laptop, phone]) {
      const gone = await c.next((f) => f.t === "chats" && (f.delta as { gone?: boolean } | undefined)?.gone === true, true);
      expect(gone).toEqual({ t: "chats", delta: { chat, gone: true } });
    }
    expect(phone.frames.indexOf(ad)).toBeLessThan(phone.frames.findIndex((f) => f.t === "chats" && (f.delta as { gone?: boolean } | undefined)?.gone === true));
    expect(driver.last.closed).toBe(true);
    expect(driver.opens.length).toBe(1);

    // No frame over a page; neither socket was closed.
    for (const c of [laptop, phone]) {
      expect(Math.max(...c.sizes)).toBeLessThanOrEqual(WIRE.pageBytes);
      expect(c.closed).toBe(false);
    }
    laptop.close();
    phone.close();
  }, 15_000);

  test("a page that opens a chat after more than 2,000 events of one turn can stop it, and every delta has its block start", async () => {
    const script = driver.script;
    driver.script = null; // this turn runs until Stop
    try {
      const laptop = await Client.open("laptop_long");
      const r = rid();
      laptop.send({ t: "new_chat", rid: r, project: PROJECT, uuid: rid(), text: "Think it through", picks: { model: null, effort: null, mode: null } });
      const chat = ((await laptop.ack(r)).result as { chat: string }).chat;
      const c = driver.last;
      c.emit(
        { k: "session", sessionId: c.input.sessionId!.value, model: "claude-haiku-5-5", mode: "default", version: "2.1.311", bypass: false },
        { k: "tool_call", id: "toolu_long", name: "Bash", input: { command: "make all" }, parent: null },
      );
      for (let i = 1; i <= 1_200; i++) c.emit({ k: "tool_progress", id: "toolu_long", seconds: i, parent: null });
      c.emit({ k: "block_start", key: "m7:0", kind: "text", parent: null });
      const pieces = Array.from({ length: 1_000 }, (_, i) => `word${i} `);
      for (const t of pieces) c.emit({ k: "block_delta", key: "m7:0", text: t });
      const isLast = () => {
        const n = reg.next(chat, reg.seq(chat) - 1);
        return n !== null && n !== "gap" && n.e.k === "block_delta" && n.e.text === pieces.at(-1);
      };
      for (let waited = 0; !isLast() && waited < 5_000; waited += 10) await Bun.sleep(10);
      expect(isLast()).toBe(true);
      expect(reg.seq(chat)).toBeGreaterThan(WIRE.ringEvents);

      const phone = await Client.open("phone_long");
      phone.send({ t: "attach", chat, since: 0, epoch: null });
      const at = await phone.next((f) => f.t === "attached" && f.chat === chat, true);
      expect(at.state).toBe("running");
      await phone.next((f) => f.t === "ev" && f.chat === chat && f.seq === at.seq, true, 5_000);
      const evs = phone.frames.filter((f) => f.t === "ev" && f.chat === chat) as unknown as { seq: number; e: ChatEvent }[];
      const turn = evs.find((f) => f.e.k === "turn_start");
      expect(turn).toBeDefined();
      const started = new Set<string>();
      let text = "";
      for (const f of evs) {
        if (f.e.k === "block_start") started.add(f.e.key);
        if (f.e.k === "block_delta") {
          expect(started.has(f.e.key)).toBe(true);
          text += f.e.text;
        }
      }
      expect(text).toBe(pieces.join(""));
      const rs = rid();
      phone.send({ t: "interrupt", rid: rs, chat, turn: turn!.seq });
      expect(await phone.ack(rs)).toMatchObject({ t: "ack", rid: rs, ok: true });
      expect(c.calls).toContain("interrupt");
      expect(Math.max(...phone.sizes)).toBeLessThanOrEqual(WIRE.pageBytes);
      laptop.close();
      phone.close();
    } finally {
      driver.script = script;
    }
  }, 15_000);

  test("a phone whose socket drops mid-turn reconnects with its cursor: the waiting card first, then each missed event once, no snapshot (R2)", async () => {
    const script = driver.script;
    driver.script = null; // this turn runs until the test ends it
    try {
      const laptop = await Client.open("laptop_drop");
      const r = rid();
      laptop.send({ t: "new_chat", rid: r, project: PROJECT, uuid: rid(), text: "Write it up", picks: { model: null, effort: null, mode: null } });
      const chat = ((await laptop.ack(r)).result as { chat: string }).chat;
      const c = driver.last;
      c.emit({ k: "block_start", key: "m9:0", kind: "text", parent: null }, { k: "block_delta", key: "m9:0", text: "First " });
      const phone = await Client.open("phone_drop");
      phone.send({ t: "attach", chat, since: 0, epoch: null });
      const at = await phone.next((f) => f.t === "attached" && f.chat === chat, true);
      await phone.next((f) => f.t === "snapshot" && f.chat === chat, true);
      for (let waited = 0; reg.seq(chat) < 4 && waited < 2_000; waited += 10) await Bun.sleep(10);
      const since = reg.seq(chat);
      expect(since).toBeGreaterThanOrEqual(at.seq as number);
      // The page draws up to `since` (the tail, then live events); its cursor is that.
      if (!phone.frames.some((f) => f.t === "ev" && f.chat === chat && f.seq === since)) await phone.next((f) => f.t === "ev" && f.chat === chat && f.seq === since, true);
      phone.close();
      await Bun.sleep(50);
      for (let i = 0; i < 50; i++) c.emit({ k: "block_delta", key: "m9:0", text: `w${i} ` });
      const card: PermissionCard = { kind: "permission", id: "toolu_drop", toolUseId: "toolu_drop", toolName: "Bash", title: null, displayName: null, description: null, reason: null, blockedPath: null, input: { command: "ls" }, defaultToNo: false, suppressAlwaysAllowRule: false, sessionRule: true, parent: null };
      void c.ask(card).answer;
      for (let waited = 0; reg.seq(chat) < since + 51 && waited < 2_000; waited += 10) await Bun.sleep(10);
      const last = reg.seq(chat);
      const back = await Client.open("phone_drop");
      back.send({ t: "attach", chat, since, epoch: reg.epoch });
      await back.next((f) => f.t === "ev" && f.chat === chat && f.seq === last, true, 5_000);
      const mine = back.frames.filter((f) => f.chat === chat);
      expect(mine[0]).toMatchObject({ t: "attached", replay: "events", cursor: since, cards: [{ id: "toolu_drop" }] });
      expect(mine.some((f) => f.t === "snapshot")).toBe(false);
      // Each missed event once, in order; the run of 50 deltas as one delta of their whole text (the bytes of a slow link).
      const seqs = mine.slice(1).map((f) => f.seq as number);
      expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
      expect(new Set(seqs).size).toBe(seqs.length);
      expect(seqs.at(-1)).toBe(last);
      expect(back.evs(chat).filter((e) => e.k === "block_delta")).toEqual([{ k: "block_delta", key: "m9:0", text: Array.from({ length: 50 }, (_, i) => `w${i} `).join("") }]);
      c.emit({ k: "turn_end", ok: true, subtype: "success", durationMs: 1, error: null, uuids: [] });
      laptop.close();
      back.close();
    } finally {
      driver.script = script;
    }
  }, 15_000);

  test("a closed page stops being a viewer, and the chat goes on without it", async () => {
    const one = await Client.open("tab_one");
    const r = rid();
    one.send({ t: "new_chat", rid: r, project: PROJECT, uuid: rid(), text: "keep going", picks: { model: null, effort: null, mode: null } });
    const chat = ((await one.ack(r)).result as { chat: string }).chat;
    one.send({ t: "attach", chat, since: 0, epoch: null });
    await one.next((f) => f.t === "attached", true);
    const opensBefore = driver.opens.length;
    one.close();
    await Bun.sleep(50);
    const two = await Client.open("tab_two");
    const s = rid();
    two.send({ t: "send", rid: s, chat, uuid: s, text: "still the same process?", draftRev: null });
    expect((await two.ack(s)).ok).toBe(true);
    expect(driver.opens.length).toBe(opensBefore);
    expect(driver.last.closed).toBe(false);
    two.close();
  });
});
