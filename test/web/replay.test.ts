// Row 79 and R6: a reconnect's replay is a load, not live text. A reply that streams live shows word by word (the
// pacer of chat/reveal.ts); the same reply's missed pieces that a replay brings after a reconnect show at once, with no
// row drawn twice. The real store and Connection on a fake socket; the reveal hook rendered with React's server
// renderer (no effects, so no frame moves the pacer: what a render returns is what that frame shows).
import { afterAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PROTOCOL_VERSION, type ClientFrame, type ServerFrame } from "../../shared/protocol";
import { QUIET_MS } from "../../web/chat/arrivals";
import type { RevealCut } from "../../web/chat/Markdown";
import { resetPacers, useReveal } from "../../web/chat/reveal";
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
const draft = { rev: 1, text: "", mode: "chat" as const, command: null, link: false, uploads: [], by: null, at: "2026-11-02T10:00:00.000Z" };
const attached = (seq: number, replay: "snapshot" | "events", cursor?: number): ServerFrame => ({ t: "attached", chat: CHAT, epoch: EPOCH, state: "running", seq, cards: [], picks: { model: null, effort: null, mode: null }, title: null, draft, archived: false, replay, ...(cursor === undefined ? {} : { cursor }) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let sock = new FakeSocket();

/** The reply's row as the conversation would draw it now: what the reveal shows of it (null: all of it). */
function draw(): { cut: RevealCut | null; total: number; text: string } {
  const item = getState().chats.find((c) => c.id === CHAT)!.items.find((i) => i.kind === "assistant");
  if (!item || item.kind !== "assistant") throw new Error("no reply row");
  const out: { cut: RevealCut | null } = { cut: null };
  function Row() {
    out.cut = useReveal(CHAT, item!.id, item!.kind === "assistant" ? item!.markdown.length : 0, true);
    return null;
  }
  renderToStaticMarkup(createElement(Row));
  return { cut: out.cut, total: item.markdown.length, text: item.markdown };
}

describe("a replay is a load (R6, row 79)", () => {
  test("a reply's 50 missed pieces show at once after a reconnect; the live pieces before it were paced", async () => {
    resetState();
    resetPacers();
    const conn = new Connection({ url: "ws://127.0.0.1:7942/ws", tab: "tab_me", open: () => sock, now: () => 0, setTimer: () => 0, clearTimer: () => {}, random: () => 0.5, reload: () => {} });
    connectWith(conn);
    conn.start();
    sock.onopen?.({});
    sock.receive(WELCOME);
    sock.receive({ t: "chats", list: [{ chat: CHAT, title: "Long reply", project: "k3m7q2x4ab", state: "running", needsYou: false, lastActivity: "2026-11-02T10:00:00.000Z", archived: false }] });
    act.open(CHAT);
    sock.receive(attached(2, "snapshot"));
    sock.receive({ t: "snapshot", chat: CHAT, seq: 2, tail: 0, more: null, history: [] });
    sock.receive({ t: "ev", chat: CHAT, seq: 3, e: { k: "block_start", key: "m2:0", kind: "text", parent: null } });
    sock.receive({ t: "ev", chat: CHAT, seq: 4, e: { k: "block_delta", key: "m2:0", text: "Here is the plan. " } });
    expect(draw().cut).toBeNull(); // a row seen for the first time shows what it holds
    // The load's quiet moment is over: live text is paced, word by word.
    await sleep(QUIET_MS + 100);
    sock.receive({ t: "ev", chat: CHAT, seq: 5, e: { k: "block_delta", key: "m2:0", text: "First read the code, then " } });
    const live = draw();
    expect(live.cut).not.toBeNull();
    expect(live.cut!.end).toBeLessThan(live.total);
    // The socket drops; the turn streams 50 more pieces; the page comes back and gets only those, replayed.
    sock.readyState = 3;
    sock.onclose?.({});
    sock = new FakeSocket();
    conn.wake();
    sock.onopen?.({});
    sock.receive(WELCOME);
    expect(sock.sent.filter((f) => f.t === "attach")).toEqual([{ t: "attach", chat: CHAT, since: 5, epoch: EPOCH }]);
    sock.receive(attached(55, "events", 5));
    for (let i = 0; i < 50; i++) sock.receive({ t: "ev", chat: CHAT, seq: 6 + i, e: { k: "block_delta", key: "m2:0", text: `w${i} ` } });
    const after = draw();
    expect(after.cut).toBeNull();
    expect(after.text).toBe(`Here is the plan. First read the code, then ${Array.from({ length: 50 }, (_, i) => `w${i} `).join("")}`);
    expect(getState().chats.find((c) => c.id === CHAT)!.items.filter((i) => i.kind === "assistant").length).toBe(1);
  });
});
