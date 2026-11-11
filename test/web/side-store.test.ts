// The side chat's frames on the page (owner rows 124 and 125; DESIGN-R124 section 9), with a fake socket: the welcome's
// capability turns the side chat on, `get side` reads the thread when it shows and again after each attach while it
// shows, the ring's side events change the thread and never the transcript, an ask sends one side_question (never a
// send) and shows at once, its ack lands the answer, Stop sends side_stop and the stopped question leaves, Clear sends
// side_clear, and a refused side frame shows no chat notice; `unsupported` hides the side chat.
import { afterEach, describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, type ClientFrame, type ServerFrame, type SideExchange } from "../../shared/protocol";
import { Connection, type SocketLike } from "../../web/net/socket";
import { act, connectWith, getState, resetState } from "../../web/state/store";
import type { Chat } from "../../web/state/types";
import { CHATS, PROJECTS } from "./fixtures";

const CHAT = "demoolxxxxxxxxxxxxxx";
const AT = "2026-11-04T10:00:00.000Z";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ans = (n: number, q: string, a: string): SideExchange => ({ id: uuid(n), question: q, at: AT, state: "answered", answer: a });

class FakeSocket implements SocketLike {
  readyState = 1;
  sent: ClientFrame[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data) as ClientFrame);
  }
  close() {
    this.readyState = 3;
  }
  receive(f: ServerFrame) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
}

function boot(capabilities: { sideQuestions: boolean } | null = { sideQuestions: true }) {
  resetState({ ready: true, projects: structuredClone(PROJECTS), chats: structuredClone(CHATS) as Chat[] });
  const socket = new FakeSocket();
  const conn = new Connection({ url: "ws://127.0.0.1:7941/ws", tab: "tab_me", open: () => socket, now: () => 0, setTimer: () => 0, clearTimer: () => {}, random: () => 0.5, reload: () => {} });
  connectWith(conn);
  conn.start();
  socket.onopen?.({});
  socket.receive({ t: "welcome", epoch: "e1", version: "0.1.0", v: PROTOCOL_VERSION, claude: { ok: true, version: "2.1.317", drift: null }, update: { available: false }, auth: "none", ...(capabilities ? { capabilities } : {}) });
  return socket;
}
const last = <T extends ClientFrame["t"]>(s: FakeSocket, t: T) => s.sent.filter((f) => f.t === t).at(-1) as Extract<ClientFrame, { t: T }> | undefined;
const thread = () => getState().side[CHAT];
const flush = () => new Promise((r) => setTimeout(r, 0));
const ev = (seq: number, e: Extract<ServerFrame, { t: "ev" }>["e"]): ServerFrame => ({ t: "ev", chat: CHAT, seq, e });
const ATTACHED: ServerFrame = {
  t: "attached",
  chat: CHAT,
  epoch: "e1",
  state: "idle",
  seq: 0,
  cards: [],
  picks: { model: null, effort: null, mode: null },
  title: null,
  draft: { rev: 0, text: "", mode: "chat", command: null, link: false, uploads: [], by: null, at: AT },
  archived: false,
  replay: "none",
};

afterEach(() => {
  act.sideView(CHAT, false);
  connectWith(null);
  resetState();
});

describe("the capability", () => {
  test("welcome's capabilities.sideQuestions turns the side chat on; absent, it stays off", () => {
    boot();
    expect(getState().sideQuestions).toBe(true);
    boot(null);
    expect(getState().sideQuestions).toBe(false);
  });

  test("an unsupported ack turns it off; a refused side frame shows no chat notice", async () => {
    const s = boot();
    const done = act.sideAsk(CHAT, "Which file?");
    const f = last(s, "side_question")!;
    s.receive({ t: "ack", rid: f.rid, ok: false, error: { code: "unsupported", message: "x" } });
    // Refused before the server stored anything (FIX-U2: a side box's question goes back into its draft then).
    expect(await done).toBe("refused");
    expect(getState().sideQuestions).toBe(false);
    expect(getState().notice).toBeNull();
    expect(thread()!.exchanges.map((x) => [x.state, x.error])).toEqual([["failed", "unsupported"]]);
  });
});

describe("the read and the ring", () => {
  test("the side chat reads its thread when it shows, and again after each attach while it shows", async () => {
    const s = boot();
    act.sideView(CHAT, true);
    const get = last(s, "get")!;
    expect(get).toMatchObject({ t: "get", chat: CHAT, what: "side" });
    s.receive({ t: "ack", rid: get.rid, ok: true, result: { rev: 3, exchanges: [ans(1, "Q1", "A1")] } });
    await flush();
    expect(thread()!.exchanges.map((x) => x.question)).toEqual(["Q1"]);
    expect(thread()!.rev).toBe(3);
    const before = s.sent.filter((f) => f.t === "get").length;
    s.receive(ATTACHED);
    expect(s.sent.filter((f) => f.t === "get").length).toBe(before + 1);
    // Closed, an attach reads nothing.
    act.sideView(CHAT, false);
    s.receive(ATTACHED);
    expect(s.sent.filter((f) => f.t === "get").length).toBe(before + 1);
  });

  test("the ring's side events change the thread and never the transcript", () => {
    const s = boot();
    const items = getState().chats.find((c) => c.id === CHAT)!.items;
    s.receive(ev(1, { k: "side", rev: 1, x: ans(1, "Q1", "A1") }));
    s.receive(ev(2, { k: "side", rev: 2, x: ans(2, "Q2", "A2") }));
    expect(thread()!.exchanges.map((x) => x.id)).toEqual([uuid(1), uuid(2)]);
    s.receive(ev(3, { k: "side_gone", rev: 3, id: uuid(2) }));
    expect(thread()!.exchanges.map((x) => x.id)).toEqual([uuid(1)]);
    s.receive(ev(4, { k: "side_clear", rev: 4 }));
    expect(thread()!.exchanges).toEqual([]);
    expect(getState().chats.find((c) => c.id === CHAT)!.items).toBe(items);
  });
});

describe("ask, Stop and Clear", () => {
  test("an ask sends one side_question (never a send), shows at once, and its ack lands the answer", async () => {
    const s = boot();
    const done = act.sideAsk(CHAT, "Why did it time out?");
    const f = last(s, "side_question")!;
    expect(f).toMatchObject({ t: "side_question", chat: CHAT, text: "Why did it time out?" });
    expect(f.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.sent.some((x) => x.t === "send")).toBe(false);
    expect(thread()!.exchanges.map((x) => [x.id, x.state])).toEqual([[f.id, "asking"]]);
    s.receive(ev(1, { k: "side", rev: 1, x: { id: f.id, question: "Why did it time out?", at: AT, state: "asking" } }));
    s.receive(ack(f.rid, { answered: { id: f.id, question: "Why did it time out?", at: AT, state: "answered", answer: "The listener." } }));
    expect(await done).toBe("answered");
    expect(thread()!.exchanges.map((x) => [x.state, x.answer])).toEqual([["answered", "The listener."]]);
  });

  test("while a side question runs, a second ask sends nothing and ends busy; the running one stays", async () => {
    const s = boot();
    s.receive(ev(1, { k: "side", rev: 1, x: { id: uuid(1), question: "First?", at: AT, state: "asking" } }));
    const before = s.sent.length;
    expect(await act.sideAsk(CHAT, "Second?")).toBe("busy");
    expect(s.sent.length).toBe(before);
    expect(thread()!.exchanges.map((x) => [x.id, x.state])).toEqual([[uuid(1), "asking"]]);
  });

  test("a busy ack (another page asked first) ends busy and leaves no failed row", async () => {
    const s = boot();
    const done = act.sideAsk(CHAT, "Mine?");
    const f = last(s, "side_question")!;
    s.receive({ t: "ack", rid: f.rid, ok: false, error: { code: "busy", message: "x" } });
    expect(await done).toBe("busy");
    expect(thread()!.exchanges).toEqual([]);
    expect(getState().notice).toBeNull();
  });

  test("Try again asks the same id with a new rid", () => {
    const s = boot();
    void act.sideAsk(CHAT, "Q", uuid(7));
    const a = last(s, "side_question")!;
    void act.sideAsk(CHAT, "Q", uuid(7));
    const b = last(s, "side_question")!;
    expect(a.id).toBe(uuid(7));
    expect(b.id).toBe(uuid(7));
    expect(a.rid).not.toBe(b.rid);
  });

  test("Stop sends side_stop for the running question; when it stopped it, the question leaves the thread", async () => {
    const s = boot();
    const asked = act.sideAsk(CHAT, "Long one?");
    const q = last(s, "side_question")!;
    const stopped = act.sideStop(CHAT, q.id);
    const f = last(s, "side_stop")!;
    expect(f).toMatchObject({ t: "side_stop", chat: CHAT, id: q.id });
    s.receive(ack(f.rid, { stopped: true }));
    expect(await stopped).toBe(true);
    s.receive(ack(q.rid, { stopped: true }));
    expect(await asked).toBe("stopped");
    expect(thread()!.exchanges).toEqual([]);
    expect(getState().notice).toBeNull();
  });

  test("Clear sends side_clear; the thread empties by its event", async () => {
    const s = boot();
    s.receive(ev(1, { k: "side", rev: 1, x: ans(1, "Q1", "A1") }));
    const done = act.sideClear(CHAT);
    const f = last(s, "side_clear")!;
    expect(f).toMatchObject({ t: "side_clear", chat: CHAT });
    s.receive(ack(f.rid, null));
    expect(await done).toBe(true);
    s.receive(ev(2, { k: "side_clear", rev: 2 }));
    expect(thread()!.exchanges).toEqual([]);
  });
});

function ack(rid: string, result: unknown): ServerFrame {
  return { t: "ack", rid, ok: true, result };
}
