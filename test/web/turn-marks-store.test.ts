// U2 (DESIGN-U2 3 rules 6 to 8): the store keeps each turn's marks beside the rows, as the frames come. A snapshot
// draws the chat again from its history, so its marks start again; the `turn_start` of the turn in flight that comes in
// the snapshot's tail is loose (the history drawn before it may hold the turn's message), so the turn starts at that
// message; an end that comes live is live (the timing rule keeps that turn open). The real store and Connection on a
// fake socket.
import { afterAll, describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, type ChatEvent, type ClientFrame, type ServerFrame } from "../../shared/protocol";
import { turnList, turnsOf } from "../../web/chat/turns";
import { Connection, type SocketLike } from "../../web/net/socket";
import { act, connectWith, getState, resetState } from "../../web/state/store";

const g = globalThis as unknown as { window?: object; localStorage?: unknown };
const own = { window: !g.window, storage: !g.localStorage };
g.window ??= {};
g.localStorage ??= { length: 0, key: () => null, getItem: () => null, setItem: () => {}, removeItem: () => {} };
afterAll(() => {
  act.open(null);
  if (own.window) delete g.window;
  if (own.storage) delete g.localStorage;
  connectWith(null);
  resetState();
});

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
  close() {}
  receive(f: ServerFrame) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
}

const EPOCH = "lz2k3m-abcdefghijkl";
const CHAT = "k3m7q2x4abk3m7q2x4ab";
const WELCOME: ServerFrame = { t: "welcome", epoch: EPOCH, version: "0.1.0", v: PROTOCOL_VERSION, claude: { ok: true, version: "2.1.317", drift: null }, update: { available: false }, auth: "none" };
const draft = { rev: 1, text: "", mode: "chat" as const, command: null, link: false, uploads: [], by: null, at: "2026-11-05T10:00:00.000Z" };
const attached = (seq: number): ServerFrame => ({ t: "attached", chat: CHAT, epoch: EPOCH, state: "running", seq, cards: [], picks: { model: null, effort: null, mode: null }, title: null, draft, archived: false, replay: "snapshot" });
const HISTORY: ChatEvent[] = [
  { k: "user", uuid: "m0", text: "Earlier.", queued: false },
  { k: "block", key: "msg_0:0", kind: "text", text: "Done before.", parent: null },
  { k: "user", uuid: "m1", text: "Fix the slash query.", queued: false },
  { k: "block", key: "msg_a:0", kind: "text", text: "Reading the matcher.", parent: null },
  { k: "tool_call", id: "r1", name: "Read", input: { file_path: "/src/a.ts" }, parent: null },
];

const chat = () => getState().chats.find((c) => c.id === CHAT)!;
const turns = () => turnList(turnsOf(chat().items, chat().marks ?? [], { running: chat().turn !== null, waiting: false, partial: false }));

describe("the store's turn marks (U2)", () => {
  test("a snapshot's tail starts the turn in flight at its message; a live end is live; a snapshot again starts the marks again", () => {
    resetState();
    const sock = new FakeSocket();
    const conn = new Connection({ url: "ws://127.0.0.1:7941/ws", tab: "tab_me", open: () => sock, now: () => 0, setTimer: () => 0, clearTimer: () => {}, random: () => 0.5, reload: () => {} });
    connectWith(conn);
    conn.start();
    sock.onopen?.({});
    sock.receive(WELCOME);
    sock.receive({ t: "chats", list: [{ chat: CHAT, title: "Slash query", project: "k3m7q2x4ab", state: "running", needsYou: false, lastActivity: "2026-11-05T10:00:00.000Z", archived: false }] });
    act.open(CHAT);
    sock.receive(attached(10));
    sock.receive({ t: "snapshot", chat: CHAT, seq: 8, tail: 2, more: null, history: HISTORY });
    sock.receive({ t: "ev", chat: CHAT, seq: 9, e: { k: "turn_start", by: "user" } });
    sock.receive({ t: "ev", chat: CHAT, seq: 10, e: { k: "block", key: "msg_b:0", kind: "text", text: "Found it.", parent: null } });
    expect(chat().marks).toEqual([{ k: "start", by: "user", at: ["r1", "msg_a-0", "m1"], seq: 9, loose: true }]);
    expect(turns().map((t) => `${t.id} ${t.state} ${t.rows.length}`)).toEqual(["m0 ok 2", "m1 running 4"]);

    // Live from here: the end is live.
    sock.receive({ t: "ev", chat: CHAT, seq: 11, e: { k: "turn_end", ok: true, subtype: "success", durationMs: 71_000, error: null, uuids: ["m1"] } });
    expect(chat().marks?.at(-1)).toMatchObject({ k: "end", live: true, durationMs: 71_000, seq: 11 });
    expect(turns().map((t) => `${t.id} ${t.state} ${t.durationMs}`)).toEqual(["m0 ok null", "m1 ok 71000"]);

    // A snapshot again (a reload of the chat, a reconnect that the ring cannot replay): the marks start again.
    sock.receive(attached(12));
    sock.receive({ t: "snapshot", chat: CHAT, seq: 12, tail: 0, more: null, history: HISTORY });
    expect(chat().marks).toEqual([]);
  });
});
