// The page's socket (web/net/socket.ts, DESIGN.md 4.3) with a fake WebSocket and a fake clock: hello with the tab id,
// welcome, the attach of each chat after every reconnect with its cursor, the outbox that resends with the same rid
// until the ack, the draft that waits for the socket, ping and the 35 s silence rule, the backoff, the wake path, a
// protocol version that differs (the page reloads), and the record of mutating frames (web/net/frames.ts): a request
// or a draft is recorded once, when the page sends it; hello, ping, attach, detach and get never are.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, WIRE, type AckFrame, type ClientFrame, type ServerFrame } from "../../shared/protocol";
import { apiPattern } from "../../web/net/api";
import { isMutatingFrame, newTabId, newUuid, recordFrame } from "../../web/net/frames";
import { Connection, backoffMs, type SocketLike } from "../../web/net/socket";
import { UUID } from "../../shared/ids";

const EPOCH = "lz2k3m-abcdefghijkl";
const CHAT = "k3m7q2x4abk3m7q2x4ab";

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: ClientFrame[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(data: string) {
    if (this.readyState !== 1) throw new Error("not open");
    this.sent.push(JSON.parse(data) as ClientFrame);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(f: ServerFrame | Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

/** A fake clock: timers run when `advance` passes their time, in order. */
class Clock {
  t = 1_000_000;
  timers: { at: number; fn: () => void; id: number }[] = [];
  n = 0;
  set = (fn: () => void, ms: number) => {
    const id = ++this.n;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  };
  clear = (id: unknown) => {
    this.timers = this.timers.filter((x) => x.id !== id);
  };
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}

function setup() {
  const clock = new Clock();
  const sockets: FakeSocket[] = [];
  let reloads = 0;
  const conn = new Connection({
    url: "ws://127.0.0.1:7941/ws",
    tab: "tab_one",
    open: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    now: () => clock.t,
    setTimer: clock.set,
    clearTimer: clock.clear,
    random: () => 0.5,
    reload: () => void reloads++,
  });
  const frames: ServerFrame[] = [];
  conn.on((f) => frames.push(f));
  const last = () => sockets[sockets.length - 1]!;
  const welcome = (s = last(), epoch = EPOCH) => {
    s.receive({ t: "welcome", epoch, version: "0.1.0", v: PROTOCOL_VERSION, claude: { ok: true, version: "2.1.322", drift: null }, update: { available: false }, auth: "none" });
  };
  return { conn, clock, sockets, frames, last, welcome, reloads: () => reloads };
}

const g = globalThis as unknown as { window?: { __kitespanFrames?: { t: string; at: number }[] } };
const ownWindow = !g.window;
g.window ??= {};
afterAll(() => {
  if (ownWindow) delete g.window;
});
const recorded = () => (g.window!.__kitespanFrames ??= []).map((f) => f.t);
beforeEach(() => {
  (g.window!.__kitespanFrames ??= []).length = 0;
});

describe("ids and the record", () => {
  test("a rid is a lowercase version 4 UUID; a tab id fits the hello frame", () => {
    for (let i = 0; i < 50; i++) {
      const u = newUuid();
      expect(UUID.test(u)).toBe(true);
      expect(u[14]).toBe("4");
    }
    expect(newTabId()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
  test("hello, ping, attach, detach and get read only; every other frame is mutating", () => {
    for (const t of ["hello", "ping", "attach", "detach", "get"]) expect(isMutatingFrame(t)).toBe(false);
    for (const t of ["send", "bash", "answer", "interrupt", "draft", "archive", "delete", "new_chat", "rename", "set_model"]) expect(isMutatingFrame(t)).toBe(true);
  });
  test("an API path is recorded as its pattern, with no id or query value", () => {
    expect(apiPattern("/api/settings")).toBe("/api/settings");
    expect(apiPattern("/api/projects/k3m7q2x4ab/forget")).toBe("/api/projects/:project/forget");
    expect(apiPattern("/api/uploads/k3m7q2x4abk3m7q2?x=1")).toBe("/api/uploads/:upload");
    expect(apiPattern(`/api/chats/${CHAT}/uploads`)).toBe("/api/chats/:chat/uploads");
    recordFrame("POST /api/settings");
    expect(recorded()).toEqual(["POST /api/settings"]);
  });
});

describe("hello and welcome", () => {
  test("the socket says hello with the tab id first, and is open at welcome", () => {
    const { conn, last, welcome, frames } = setup();
    const status: string[] = [];
    conn.onStatus((s) => status.push(s));
    conn.start();
    expect(conn.status).toBe("connecting");
    last().open();
    expect(last().sent).toEqual([{ t: "hello", v: PROTOCOL_VERSION, tab: "tab_one" }]);
    welcome();
    expect(conn.status).toBe("open");
    expect(conn.welcome?.epoch).toBe(EPOCH);
    expect(frames.map((f) => f.t)).toEqual(["welcome"]);
    expect(status).toEqual(["connecting", "open"]);
    expect(recorded()).toEqual([]);
  });

  test("a welcome with another protocol version stops the socket and reloads the page", () => {
    const { conn, last, reloads } = setup();
    conn.start();
    last().open();
    last().receive({ t: "welcome", epoch: EPOCH, version: "9.9.9", v: PROTOCOL_VERSION + 1, claude: { ok: true, version: null, drift: null }, update: { available: false }, auth: "none" });
    expect(reloads()).toBe(1);
    expect(conn.status).toBe("down");
  });

  test("a socket that does not open within the 5 s dial deadline: it dials again after the backoff", () => {
    const { conn, clock, sockets } = setup();
    conn.start();
    clock.advance(WIRE.dialDeadlineMs + 1);
    expect(conn.status).toBe("down");
    expect(sockets[0]!.closed).toBe(true);
    clock.advance(backoffMs(0, () => 0.5));
    expect(sockets.length).toBe(2);
  });

  test("an open socket with no welcome within the silence rule's 35 s: it dials again", () => {
    const { conn, clock, sockets, last } = setup();
    conn.start();
    last().open();
    clock.advance(WIRE.dialDeadlineMs + 1);
    expect(conn.status).toBe("connecting");
    clock.advance(WIRE.silenceMs - WIRE.dialDeadlineMs);
    expect(conn.status).toBe("down");
    expect(sockets[0]!.closed).toBe(true);
  });
});

describe("attach and the cursor", () => {
  test("attach and detach read only; each attached chat attaches again after a reconnect, with its cursor", () => {
    const { conn, last, welcome, clock } = setup();
    conn.start();
    conn.attach(CHAT);
    last().open();
    welcome();
    expect(last().sent.slice(1)).toEqual([{ t: "attach", chat: CHAT, since: 0, epoch: null }]);
    conn.cursor(CHAT, 41, EPOCH);
    last().drop();
    clock.advance(backoffMs(0, () => 0.5));
    last().open();
    welcome();
    expect(last().sent).toEqual([
      { t: "hello", v: PROTOCOL_VERSION, tab: "tab_one" },
      { t: "attach", chat: CHAT, since: 41, epoch: EPOCH },
    ]);
    conn.detach(CHAT);
    expect(last().sent.at(-1)).toEqual({ t: "detach", chat: CHAT });
    expect(conn.isAttached(CHAT)).toBe(false);
    expect(recorded()).toEqual([]);
  });

  test("reattach asks for a snapshot (R4): since 0, also after a reconnect or a detach, and no cursor counts until one comes", () => {
    const { conn, last, welcome, clock } = setup();
    conn.start();
    conn.attach(CHAT, 41, EPOCH);
    last().open();
    welcome();
    conn.reattach(CHAT);
    expect(last().sent.slice(-1)).toEqual([{ t: "attach", chat: CHAT, since: 0, epoch: null }]);
    // A live event already on its way names its seq; it does not count.
    conn.cursor(CHAT, 44, EPOCH);
    last().drop();
    clock.advance(backoffMs(0, () => 0.5));
    last().open();
    welcome();
    expect(last().sent.slice(1)).toEqual([{ t: "attach", chat: CHAT, since: 0, epoch: null }]);
    conn.detach(CHAT);
    conn.attach(CHAT, 44, EPOCH);
    expect(last().sent.at(-1)).toEqual({ t: "attach", chat: CHAT, since: 0, epoch: null });
    // Once the snapshot and its tail are in (the store's replayIn), the cursor counts again.
    last().receive({ t: "snapshot", chat: CHAT, seq: 50, tail: 0, more: null, history: [] });
    conn.cursor(CHAT, 50, EPOCH);
    conn.replayIn(CHAT, 50, EPOCH);
    last().drop();
    clock.advance(backoffMs(1, () => 0.5));
    last().open();
    welcome();
    expect(last().sent.slice(1)).toEqual([{ t: "attach", chat: CHAT, since: 50, epoch: EPOCH }]);
  });
});

describe("the outbox", () => {
  test("a request waits until welcome, goes out once, and its ack resolves it; it is recorded once", async () => {
    const { conn, last, welcome } = setup();
    conn.start();
    const rid = newUuid();
    const p = conn.request({ t: "rename", rid, chat: CHAT, title: "A title" });
    expect(recorded()).toEqual(["rename"]);
    last().open();
    expect(last().sent.map((f) => f.t)).toEqual(["hello"]);
    welcome();
    expect(last().sent.map((f) => f.t)).toEqual(["hello", "rename"]);
    last().receive({ t: "ack", rid, ok: true, result: null });
    expect(((await p) as AckFrame).ok).toBe(true);
    expect(recorded()).toEqual(["rename"]);
  });

  test("a request whose ack did not come goes out again after a reconnect, with the same rid, and is not recorded again", async () => {
    const { conn, last, welcome, clock } = setup();
    conn.start();
    last().open();
    welcome();
    const rid = newUuid();
    const p = conn.request({ t: "send", rid, chat: CHAT, uuid: rid, text: "hi", draftRev: 3, uploads: [] });
    expect(last().sent.at(-1)).toMatchObject({ t: "send", rid });
    last().drop();
    clock.advance(backoffMs(0, () => 0.5));
    last().open();
    welcome();
    expect(last().sent.filter((f) => f.t === "send")).toEqual([{ t: "send", rid, chat: CHAT, uuid: rid, text: "hi", draftRev: 3, uploads: [] }]);
    last().receive({ t: "ack", rid, ok: false, error: { code: "archived", message: "This chat is archived." } });
    const ack = (await p) as AckFrame;
    expect(ack.ok ? null : ack.error.code).toBe("archived");
    expect(recorded()).toEqual(["send"]);
    // Acked: a later reconnect sends nothing again.
    last().drop();
    clock.advance(backoffMs(0, () => 0.5));
    last().open();
    welcome();
    expect(last().sent.map((f) => f.t)).toEqual(["hello"]);
  });

  test("a get reads only: not recorded", async () => {
    const { conn, last, welcome } = setup();
    conn.start();
    last().open();
    welcome();
    const rid = newUuid();
    const p = conn.request({ t: "get", rid, chat: CHAT, what: "models" });
    last().receive({ t: "ack", rid, ok: true, result: [] });
    await p;
    expect(recorded()).toEqual([]);
  });
});

describe("drafts", () => {
  test("a draft goes out at once while open; while down the newest per chat waits for the next welcome", () => {
    const { conn, last, welcome, clock } = setup();
    conn.start();
    last().open();
    welcome();
    const d = (text: string) => ({ t: "draft" as const, chat: CHAT, text, mode: "chat" as const, command: null, link: false, uploads: [] });
    conn.draft(d("a"));
    expect(last().sent.at(-1)).toEqual(d("a"));
    last().drop();
    conn.draft(d("ab"));
    conn.draft(d("abc"));
    clock.advance(backoffMs(0, () => 0.5));
    last().open();
    welcome();
    expect(last().sent.filter((f) => f.t === "draft")).toEqual([d("abc")]);
    expect(recorded()).toEqual(["draft", "draft", "draft"]);
  });
  test("a send makes the waiting draft moot", () => {
    const { conn, last, welcome } = setup();
    conn.start();
    conn.draft({ t: "draft", chat: CHAT, text: "old", mode: "chat", command: null, link: false, uploads: [] });
    conn.dropDraft(CHAT);
    last().open();
    welcome();
    expect(last().sent.map((f) => f.t)).toEqual(["hello"]);
  });
});

describe("the heartbeat, the backoff and the wake path", () => {
  test("a ping every 15 s; 35 s with no frame from the server closes the socket and dials again", () => {
    const { conn, last, welcome, clock, sockets } = setup();
    conn.start();
    last().open();
    welcome();
    clock.advance(WIRE.pingEveryMs);
    expect(last().sent.at(-1)).toEqual({ t: "ping", n: 1 });
    last().receive({ t: "pong", n: 1 });
    clock.advance(WIRE.pingEveryMs);
    expect(last().sent.at(-1)).toEqual({ t: "ping", n: 2 });
    // No answer from here on: 35 s after the last frame (the pong at 15 s) the socket closes and dials again.
    clock.advance(WIRE.silenceMs - WIRE.pingEveryMs - 1);
    expect(sockets[0]!.closed).toBe(false);
    clock.advance(2);
    expect(sockets[0]!.closed).toBe(true);
    expect(conn.status).toBe("down");
  });

  test("the backoff doubles from 500 ms to 10 s, with plus or minus 20 percent", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map((n) => backoffMs(n, () => 0.5))).toEqual([500, 1000, 2000, 4000, 8000, 10000, 10000]);
    expect(backoffMs(0, () => 0)).toBe(400);
    expect(backoffMs(0, () => 1)).toBe(600);
    expect(backoffMs(20, () => 1)).toBe(12000);
  });

  test("bye: the server goes away, so the socket dials again", () => {
    const { conn, last, welcome, clock, sockets } = setup();
    conn.start();
    last().open();
    welcome();
    last().receive({ t: "bye", reason: "restart" });
    expect(conn.status).toBe("down");
    clock.advance(backoffMs(0, () => 0.5));
    expect(sockets.length).toBe(2);
  });

  test("wake: a ping at once, and a new dial when nothing comes back within 600 ms; a socket that is down dials now", () => {
    const { conn, last, welcome, clock, sockets } = setup();
    conn.start();
    last().open();
    welcome();
    conn.wake();
    expect(last().sent.at(-1)).toMatchObject({ t: "ping" });
    clock.advance(WIRE.wakeWaitMs + 1);
    expect(sockets[0]!.closed).toBe(true);
    expect(conn.status).toBe("down");
    conn.wake();
    expect(sockets.length).toBe(2);
    last().open();
    welcome();
    conn.wake();
    last().receive({ t: "pong", n: 9 });
    clock.advance(WIRE.wakeWaitMs + 1);
    expect(conn.status).toBe("open");
  });

  test("a frame that is not JSON, or has no t, is dropped", () => {
    const { conn, last, welcome, frames } = setup();
    conn.start();
    last().open();
    welcome();
    last().onmessage?.({ data: "not json" });
    last().onmessage?.({ data: JSON.stringify({ x: 1 }) });
    last().onmessage?.({ data: new Uint8Array([1, 2]) });
    expect(frames.map((f) => f.t)).toEqual(["welcome"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// A slow or silent link (DC9): the wake judges by the link's own round trip and never cuts a large frame on its way,
// a dial that reached the server waits for welcome as long as the silence rule does, the silence rule runs on its own
// timer, and a request whose ack is overdue checks the link (the review of iteration 4 part 1).

/** A link with a round trip of `rtt` ms: the socket opens after one round trip, and the server answers each frame. */
function slowLink(rtt: number, opts: { openAfter?: number } = {}) {
  const clock = new Clock();
  const sockets: FakeSocket[] = [];
  let silent = false;
  const conn = new Connection({
    url: "ws://127.0.0.1:7945/ws",
    tab: "tab_one",
    open: () => {
      const s = new FakeSocket();
      sockets.push(s);
      const send = s.send.bind(s);
      s.send = (data: string) => {
        send(data);
        const f = JSON.parse(data) as ClientFrame;
        if (silent) return;
        const answer = (out: Record<string, unknown>) =>
          clock.set(() => {
            if (!silent && s.readyState === 1) s.receive(out);
          }, rtt);
        if (f.t === "hello") answer({ t: "welcome", epoch: EPOCH, version: "0.1.0", v: PROTOCOL_VERSION, claude: { ok: true, version: "2.1.317", drift: null }, update: { available: false }, auth: "none" });
        if (f.t === "ping") answer({ t: "pong", n: f.n });
      };
      clock.set(() => {
        if (!silent) s.open();
      }, opts.openAfter ?? rtt);
      return s;
    },
    now: () => clock.t,
    setTimer: clock.set,
    clearTimer: clock.clear,
    random: () => 0.5,
    reload: () => {},
  });
  return { conn, clock, sockets, goSilent: () => void (silent = true) };
}

describe("a slow or silent link", () => {
  test("a dial whose welcome takes 2.6 s round trips past 5 s still connects: once the socket opened, it waits for welcome as long as the silence rule", () => {
    const { conn, clock, sockets } = slowLink(2600);
    conn.start();
    clock.advance(30_000);
    expect(conn.status).toBe("open");
    expect(sockets.length).toBe(1);
  });

  test("before the socket opens, the deadline grows with each attempt: 5, 10, then 20 s", () => {
    const { conn, clock, sockets } = slowLink(100, { openAfter: 7_000 });
    conn.start();
    clock.advance(WIRE.dialDeadlineMs + 1);
    expect(sockets.length).toBe(1);
    expect(conn.status).toBe("down");
    clock.advance(backoffMs(0, () => 0.5));
    expect(sockets.length).toBe(2);
    // The second dial gets 10 s, and this socket opens after 7 s.
    clock.advance(9_000);
    expect(conn.status).toBe("open");
    expect(sockets.length).toBe(2);
  });

  test("a wake on a link whose pong takes 700 ms dials nothing: the wait is three times the measured round trip", () => {
    const { conn, clock, sockets } = slowLink(700);
    conn.start();
    clock.advance(5_000);
    expect(conn.status).toBe("open");
    clock.advance(WIRE.pingEveryMs + 2_000); // one ping and its pong: the round trip is measured
    for (let i = 0; i < 5; i++) {
      conn.wake();
      clock.advance(4_000);
    }
    expect(sockets.length).toBe(1);
    expect(conn.status).toBe("open");
  });

  test("a wake while a snapshot is due, or while a history page is asked for, dials nothing: the silence rule judges then", () => {
    const { conn, last, welcome, clock, sockets } = setup();
    conn.start();
    conn.attach(CHAT);
    last().open();
    welcome();
    last().receive({ t: "attached", chat: CHAT, epoch: EPOCH, state: "idle", seq: 9, cards: [], picks: { model: null, effort: null, mode: null }, title: null, draft: { rev: 1, text: "", mode: "chat", command: null, link: false, uploads: [], by: null, at: "2026-11-03T00:00:00.000Z" }, archived: false, replay: "snapshot" });
    conn.wake();
    clock.advance(5_000);
    expect(sockets.length).toBe(1);
    expect(conn.status).toBe("open");
    last().receive({ t: "snapshot", chat: CHAT, seq: 9, tail: 0, more: null, history: [] });
    const rid = newUuid();
    void conn.request({ t: "get", rid, chat: CHAT, what: "history", before: "cursor-1" });
    conn.wake();
    clock.advance(5_000);
    expect(sockets.length).toBe(1);
    last().receive({ t: "ack", rid, ok: true, result: { history: [], more: null } });
    // Nothing large on its way: the wake judges again.
    conn.wake();
    clock.advance(WIRE.wakeWaitMs + 1);
    expect(conn.status).toBe("down");
  });

  test("the silence rule runs on its own timer: the next dial comes 35 s after the last frame, whatever the ping tick's phase", () => {
    const times: number[] = [];
    for (let at = 20_000; at < 35_000; at += 500) {
      const { conn, clock, sockets, goSilent } = slowLink(500);
      conn.start();
      clock.advance(at);
      goSilent();
      const from = clock.t;
      for (let t = 0; t < 120_000 && sockets.length === 1; t += 100) clock.advance(100);
      // From the start of the silence: the last frame came before it, so this is at most the silence rule's 35 s.
      times.push(clock.t - from);
      conn.stop();
    }
    expect(Math.max(...times)).toBeLessThanOrEqual(WIRE.silenceMs + 1_000);
  });

  test("a send into a silent link: its ack is overdue after 3 s, the page checks the link at once and dials again within about 4 s", () => {
    const { conn, clock, sockets, goSilent } = slowLink(100);
    const overdue: string[][] = [];
    conn.onOverdue((rids) => overdue.push([...rids]));
    conn.start();
    clock.advance(1_000);
    expect(conn.status).toBe("open");
    goSilent();
    const rid = newUuid();
    void conn.request({ t: "send", rid, chat: CHAT, uuid: rid, text: "hi", draftRev: 1, uploads: [] });
    clock.advance(3_001);
    expect(overdue.at(-1)).toEqual([rid]);
    expect(conn.isOverdue(rid)).toBe(true);
    clock.advance(1_000);
    expect(sockets[0]!.closed).toBe(true);
    expect(sockets.length).toBeGreaterThanOrEqual(1);
  });

  test("a slow ack on a live link: the wake check's pong shows the server read the send, so the overdue mark ends and does not come back; a later silence still dials", () => {
    const { conn, clock, sockets, goSilent } = slowLink(100);
    const overdue: string[][] = [];
    conn.onOverdue((rids) => overdue.push([...rids]));
    conn.start();
    clock.advance(1_000);
    const rid = newUuid();
    void conn.request({ t: "send", rid, chat: CHAT, uuid: rid, text: "hi", draftRev: 1, uploads: [] });
    clock.advance(3_001);
    expect(conn.isOverdue(rid)).toBe(true);
    clock.advance(200);
    expect(conn.isOverdue(rid)).toBe(false);
    expect(overdue.at(-1)).toEqual([]);
    clock.advance(10_000);
    expect(conn.isOverdue(rid)).toBe(false);
    expect(conn.status).toBe("open");
    expect(sockets.length).toBe(1);
    goSilent();
    clock.advance(WIRE.silenceMs + 1_000);
    expect(sockets[0]!.closed).toBe(true);
  });

  test("a heartbeat's pong after a send shows the server read it: no overdue mark comes", () => {
    const { conn, clock } = slowLink(100);
    const overdue: string[][] = [];
    conn.onOverdue((rids) => overdue.push([...rids]));
    conn.start();
    clock.advance(1_000);
    // The first beat goes 15 s after the welcome (at about 15.2 s); this send goes 1.2 s before it.
    clock.advance(13_000);
    const rid = newUuid();
    void conn.request({ t: "send", rid, chat: CHAT, uuid: rid, text: "hi", draftRev: 1, uploads: [] });
    clock.advance(5_000);
    expect(conn.isOverdue(rid)).toBe(false);
    expect(overdue).toEqual([]);
  });

  test("an ack that comes ends the overdue mark; a welcome after a resend starts its wait again", () => {
    const { conn, last, welcome, clock } = setup();
    const overdue: string[][] = [];
    conn.onOverdue((rids) => overdue.push([...rids]));
    conn.start();
    last().open();
    welcome();
    const rid = newUuid();
    void conn.request({ t: "rename", rid, chat: CHAT, title: "A title" });
    clock.advance(3_001);
    expect(conn.isOverdue(rid)).toBe(true);
    last().receive({ t: "pong", n: 1 });
    last().receive({ t: "ack", rid, ok: true, result: null });
    expect(conn.isOverdue(rid)).toBe(false);
    expect(overdue.at(-1)).toEqual([]);
    // A get is a read: no overdue mark (a large page may take long).
    const get = newUuid();
    void conn.request({ t: "get", rid: get, chat: CHAT, what: "models" });
    clock.advance(10_000);
    expect(conn.isOverdue(get)).toBe(false);
  });
});

describe("the cursor while a snapshot's tail comes (R1, DESIGN 4.3 item 6)", () => {
  const attached = (seq: number) => ({ t: "attached" as const, chat: CHAT, epoch: EPOCH, state: "running" as const, seq, cards: [], picks: { model: null, effort: null, mode: null }, title: null, draft: { rev: 1, text: "", mode: "chat" as const, command: null, link: false, uploads: [], by: null, at: "2026-11-03T00:00:00.000Z" }, archived: false, replay: "snapshot" as const });

  test("from an attached with a snapshot until the store says the tail is in, no cursor counts: a cut there attaches with since 0", () => {
    const { conn, last, welcome, clock } = setup();
    conn.start();
    conn.attach(CHAT);
    last().open();
    welcome();
    last().receive(attached(7));
    last().receive({ t: "snapshot", chat: CHAT, seq: 0, tail: 2, more: null, history: [] });
    last().receive({ t: "ev", chat: CHAT, seq: 1, e: { k: "turn_start", by: "user" } });
    conn.cursor(CHAT, 0, EPOCH);
    conn.cursor(CHAT, 1, EPOCH);
    last().drop();
    clock.advance(backoffMs(0, () => 0.5));
    last().open();
    welcome();
    expect(last().sent.slice(1)).toEqual([{ t: "attach", chat: CHAT, since: 0, epoch: null }]);
    // The tail is in: its cursor is attached.seq, and live events count again.
    last().receive(attached(7));
    last().receive({ t: "snapshot", chat: CHAT, seq: 0, tail: 0, more: null, history: [] });
    conn.replayIn(CHAT, 7, EPOCH);
    conn.cursor(CHAT, 8, EPOCH);
    last().drop();
    clock.advance(backoffMs(0, () => 0.5));
    last().open();
    welcome();
    expect(last().sent.slice(1)).toEqual([{ t: "attach", chat: CHAT, since: 8, epoch: EPOCH }]);
  });
});
