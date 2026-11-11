// Owner row 116 (FIX-R116, DESIGN-R116): the four dots of the chat lists and their accessible names, the one state a
// row shows (needs you, then working, then starting, then failed, then unread), the seen flag from the chat list's
// frames (`unseen`), the title bar's marks (no unread dot there), the count badge (Needs input only), and the page's
// seen report: an `on_screen` frame only while the page is visible and the chat's view shows the turn's end, sent
// again after each attach is drawn, never from a hidden page, and never recorded as an action (a link only pre-fills).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PROTOCOL_VERSION, type ChatRow, type ClientFrame, type ServerFrame } from "../../shared/protocol";
import { isMutatingFrame } from "../../web/net/frames";
import { OnScreen } from "../../web/net/onScreen";
import { conversationShows } from "../../web/chat/seen";
import { Connection, type SocketLike } from "../../web/net/socket";
import { parse } from "../../web/router";
import { ChatListBody, headingCount, listGroups } from "../../web/screens/ChatListBody";
import { STATE_WORD } from "../../web/screens/common";
import { TopBar } from "../../web/layout/TopBar";
import { listState } from "../../web/state/reduce";
import { act, connectWith, getState, resetState } from "../../web/state/store";

const EPOCH = "lz2k3m-abcdefghijkl";
const PROJECT = "k3m7q2x4ab";
// One chat in each state the list draws, and a seen idle chat.
const RUNNING = "runningchat2abcdefgh";
const WAITING = "waitingchat2abcdefgh";
const UNREAD = "unreadchat2abcdefghi";
const FAILED = "failedchat2abcdefghi";
const SEEN = "seenidlechat2abcdefg";

type Unseen = "done" | "failed" | null;
/** A chat list row; `unseen` is the R116 field (absent when seen). */
const row = (chat: string, title: string, over: Partial<ChatRow> & { unseen?: Unseen } = {}) =>
  ({ chat, title, project: PROJECT, state: "idle", needsYou: false, lastActivity: "2026-10-30T08:56:00.000Z", archived: false, ...over }) as ChatRow;
const ROWS = [
  row(RUNNING, "Fold a finished turn", { state: "running", busy: true }),
  row(WAITING, "Pick the search scope", { state: "waiting", needsYou: true, busy: true }),
  row(UNREAD, "Draw the turn rail", { unseen: "done" }),
  row(FAILED, "Build the home-screen icon", { state: "sleeping", unseen: "failed" }),
  row(SEEN, "Rename the looks", { lastActivity: "2026-10-30T07:00:00.000Z" }),
];

const g = globalThis as unknown as { window?: { __kitespanFrames?: { t: string }[]; innerWidth?: number; innerHeight?: number; addEventListener?: () => void; removeEventListener?: () => void }; matchMedia?: unknown };
const own = { win: !g.window, mm: !g.matchMedia };
let coarse = false;
function viewport(width: number, height: number, touch: boolean) {
  coarse = touch;
  g.window = { ...(g.window ?? {}), innerWidth: width, innerHeight: height, addEventListener() {}, removeEventListener() {} };
}
beforeAll(() => {
  g.matchMedia = (q: string) => ({ matches: coarse && q === "(pointer: coarse)", addEventListener() {}, removeEventListener() {} });
  viewport(1280, 800, false);
});
afterAll(() => {
  connectWith(null);
  resetState();
  if (own.win) delete g.window;
  if (own.mm) delete g.matchMedia;
});

class FakeSocket implements SocketLike {
  readyState = 1;
  sent: ClientFrame[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(data: string) {
    if (this.readyState !== 1) throw new Error("not open");
    this.sent.push(JSON.parse(data) as ClientFrame);
  }
  close() {
    this.readyState = 3;
  }
  receive(f: ServerFrame | Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

const WELCOME = { t: "welcome", epoch: EPOCH, version: "0.1.0", v: PROTOCOL_VERSION, claude: { ok: true, version: "2.1.322", drift: null }, update: { available: false }, auth: "none" } as ServerFrame;
const attachedOf = (chat: string, seq: number, replay: "snapshot" | "events" | "none" = "snapshot") =>
  ({ t: "attached", chat, epoch: EPOCH, state: "idle", seq, cards: [], picks: { model: null, effort: null, mode: null }, title: { text: "Draw the turn rail", from: "generated" }, draft: { rev: 1, text: "", mode: "chat", command: null, link: false, uploads: [], by: null, at: "2026-10-30T08:56:00.000Z" }, archived: false, replay }) as ServerFrame;

let sock: FakeSocket;
let conn: Connection;
/** The store on a fake socket with the five rows; the open chat (if any) attached and drawn. */
const KITESPAN = { id: PROJECT, name: "kitespan", folder: "~/src/kitespan", branch: "main", picks: {} };
function boot(open: string | null = null) {
  resetState({ projects: [KITESPAN] });
  sock = new FakeSocket();
  conn = new Connection({ url: "ws://127.0.0.1:7941/ws", tab: "tab_me", open: () => (sock = sock.readyState === 3 ? new FakeSocket() : sock), now: () => 0, setTimer: () => 0, clearTimer: () => {}, random: () => 0.5, reload: () => {} });
  connectWith(conn);
  conn.start();
  sock.onopen?.({});
  sock.receive(WELCOME);
  sock.receive({ t: "chats", list: ROWS });
  if (open) {
    act.open(open);
    sock.receive(attachedOf(open, 3));
    sock.receive({ t: "snapshot", chat: open, seq: 3, more: null, history: [] });
  }
  (g.window!.__kitespanFrames ??= []).length = 0;
}
const chatOf = (id: string) => getState().chats.find((c) => c.id === id)!;
const screens = () => sock.sent.filter((f) => (f as { t: string }).t === "on_screen") as unknown as { t: "on_screen"; chat: string; on: boolean }[];

/** The accessible name of a row's link: its text with what is aria-hidden left out (the dot), the hidden words kept. */
function nameOf(html: string, chat: string): string {
  const m = new RegExp(`<a href="/c/${chat}"[^>]*>([\\s\\S]*?)</a>`).exec(html);
  if (!m) throw new Error(`no row for ${chat}`);
  return m[1]!.replace(/<span[^>]*aria-hidden="true"[^>]*><\/span>/g, "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
const dotOf = (html: string, chat: string) => new RegExp(`<a href="/c/${chat}"[^>]*>\\s*<span class="(dot [a-z]+)"`).exec(html)?.[1] ?? null;
const list = (path = "/", variant: "sidebar" | "screen" = "sidebar") => renderToStaticMarkup(createElement(ChatListBody, { route: parse(new URL(path, "http://127.0.0.1")), variant }));

describe("the one state a row shows (DESIGN-R116 5, the order)", () => {
  test("needs you, then working, then starting, then failed, then unread, then idle or sleeping", () => {
    expect(listState("waiting", "done")).toBe("waiting");
    expect(listState("waiting", "failed")).toBe("waiting");
    expect(listState("running", "failed")).toBe("running");
    expect(listState("starting", "done")).toBe("starting");
    expect(listState("idle", "failed")).toBe("failed");
    expect(listState("sleeping", "failed")).toBe("failed");
    expect(listState("idle", "done")).toBe("unread");
    expect(listState("sleeping", "done")).toBe("unread");
    expect(listState("ending", "done")).toBe("unread");
    expect(listState("idle", null)).toBe("idle");
    expect(listState("idle")).toBe("idle");
    expect(listState("ending")).toBe("sleeping");
  });
  test("the words: Desktop's Unread beside agent view's states; no visible word for unread", () => {
    expect(STATE_WORD).toEqual({ starting: "Starting", running: "Working", waiting: "Needs input", failed: "Failed", unread: "Unread", idle: "Idle", sleeping: "Sleeping" });
  });
});

describe("the seen flag from the chat list's frames", () => {
  test("a row's unseen gives the chat its state; a delta sets it and takes it away with null", () => {
    boot();
    expect([chatOf(UNREAD).state, chatOf(UNREAD).unseen]).toEqual(["unread", "done"]);
    expect([chatOf(FAILED).state, chatOf(FAILED).unseen]).toEqual(["failed", "failed"]);
    expect([chatOf(SEEN).state, chatOf(SEEN).unseen ?? null]).toEqual(["idle", null]);
    sock.receive({ t: "chats", delta: { chat: UNREAD, unseen: null } });
    expect([chatOf(UNREAD).state, chatOf(UNREAD).unseen ?? null]).toEqual(["idle", null]);
    sock.receive({ t: "chats", delta: { chat: SEEN, unseen: "done" } });
    expect(chatOf(SEEN).state).toBe("unread");
    // A new turn runs: its dot is Working until it ends; the flag stays until seen.
    sock.receive({ t: "chats", delta: { chat: SEEN, state: "running", busy: true } });
    expect([chatOf(SEEN).state, chatOf(SEEN).unseen]).toEqual(["running", "done"]);
    sock.receive({ t: "chats", delta: { chat: SEEN, state: "idle", busy: false, unseen: "failed" } });
    expect(chatOf(SEEN).state).toBe("failed");
    // A bad value reads as seen.
    sock.receive({ t: "chats", delta: { chat: SEEN, unseen: "maybe" } });
    expect([chatOf(SEEN).state, chatOf(SEEN).unseen ?? null]).toEqual(["idle", null]);
  });
  test("the open chat's attached frame keeps its flag; a chat new to the list gets it from its first delta", () => {
    boot(UNREAD);
    expect(chatOf(UNREAD).state).toBe("unread");
    sock.receive({ t: "chats", delta: { chat: "brandnewchat2abcdefg", title: "New", project: PROJECT, state: "idle", needsYou: false, lastActivity: "2026-10-30T08:59:00.000Z", archived: false, unseen: "done" } });
    expect(chatOf("brandnewchat2abcdefg").state).toBe("unread");
  });
});

describe("the four dots and their accessible names (6.2, 6.13)", () => {
  test("the laptop sidebar: each state's dot, and the row's name says the state", () => {
    viewport(1280, 800, false);
    boot();
    const html = list();
    expect(dotOf(html, RUNNING)).toBe("dot running");
    expect(dotOf(html, WAITING)).toBe("dot waiting");
    expect(dotOf(html, UNREAD)).toBe("dot unread");
    expect(dotOf(html, FAILED)).toBe("dot failed");
    expect(dotOf(html, SEEN)).toBe("dot idle");
    // Each dot is aria-hidden: the row's words carry the state.
    expect(html).toContain('<span class="dot unread" aria-hidden="true"></span>');
    expect(nameOf(html, RUNNING)).toBe("Fold a finished turnWorking");
    expect(nameOf(html, WAITING)).toBe("Needs input, Pick the search scope");
    expect(nameOf(html, FAILED)).toBe("Failed, Build the home-screen icon");
    expect(nameOf(html, UNREAD)).toMatch(/^Draw the turn railUnread, \d+ (min|h|d)$/);
    expect(nameOf(html, SEEN)).toMatch(/^Rename the looksIdle, \d+ (min|h|d)$/);
  });
  test("an unread row shows no visible word: its dot and its time only (principle 0)", () => {
    boot();
    const html = list();
    const m = new RegExp(`<a href="/c/${UNREAD}"[^>]*>([\\s\\S]*?)</a>`).exec(html)![1]!;
    const shown = m.replace(/<span class="visually-hidden">[^<]*<\/span>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    expect(shown).toMatch(/^Draw the turn rail \d+ (min|h|d)$/);
    expect(m).not.toContain("scr-lead");
  });
  test("the phone's list screen and the tablet's touch list draw the same dots", () => {
    for (const [w, h] of [[390, 844], [834, 1194]] as const) {
      viewport(w, h, true);
      boot();
      const html = list("/chats", "screen");
      expect([w, dotOf(html, UNREAD), dotOf(html, WAITING), dotOf(html, RUNNING), dotOf(html, FAILED)]).toEqual([w, "dot unread", "dot waiting", "dot running", "dot failed"]);
    }
    viewport(1280, 800, false);
  });
  test("the filters stay: Working lists the running chat, Needs input the waiting one; an unread chat is under All only", () => {
    boot();
    const working = list("/chats?filter=working", "screen");
    expect(working).toContain(`href="/c/${RUNNING}"`);
    expect(working).not.toContain(`href="/c/${UNREAD}"`);
    const needs = list("/chats?filter=needs-input", "screen");
    expect(needs).toContain(`href="/c/${WAITING}"`);
    expect(needs).not.toContain(`href="/c/${UNREAD}"`);
    expect(needs).not.toContain(`href="/c/${FAILED}"`);
    expect(list("/chats", "screen")).toContain(`href="/c/${UNREAD}"`);
  });
  test("the folded heading's badge counts the chats that need input only, not the unread or failed ones (DESIGN-R116 7)", () => {
    boot();
    const g1 = listGroups(getState().chats, [KITESPAN], "all")[0]!;
    expect(g1.needs).toBe(1);
    expect(headingCount(g1, true)).toBe(1);
  });
});

describe("the chat's own bar: the needs-you dot only, no unread or failed dot (DESIGN-R116 9)", () => {
  const bar = (id: string, touch = false) => {
    viewport(touch ? 390 : 1280, touch ? 844 : 800, touch);
    const html = renderToStaticMarkup(createElement(TopBar, { route: parse(new URL(`/c/${id}`, "http://127.0.0.1")), chat: chatOf(id) }));
    viewport(1280, 800, false);
    return html;
  };
  test("an unread chat's bar has no dot and names the chat's own state, not Unread", () => {
    boot(UNREAD);
    const laptop = bar(UNREAD);
    expect(laptop).not.toContain('class="dot');
    expect(laptop).toContain('<span class="visually-hidden">Idle</span>');
    expect(laptop).not.toContain("Unread");
    const phone = bar(UNREAD, true);
    expect(phone).not.toContain('class="dot');
    expect(phone).toContain('aria-label="Draw the turn rail, Idle. Rename"');
  });
  test("a waiting chat's bar has the warm dot with its pulse class", () => {
    boot();
    expect(bar(WAITING)).toContain('<span class="dot waiting" aria-hidden="true"></span>');
    expect(bar(WAITING, true)).toContain('aria-label="Pick the search scope, Needs input. Rename"');
  });
  test("a failed chat's bar has no dot either and names the chat's own state: Failed is the seen flag too, which the open view clears (one mark per fact)", () => {
    boot();
    const laptop = bar(FAILED);
    expect(laptop).not.toContain('class="dot');
    expect(laptop).toContain('<span class="visually-hidden">Sleeping</span>');
    expect(laptop).not.toContain("Failed");
    const phone = bar(FAILED, true);
    expect(phone).not.toContain('class="dot');
    expect(phone).toContain('aria-label="Build the home-screen icon, Sleeping. Rename"');
  });
});

describe("where the conversation shows (web/chat/seen.ts, rule 2 of the seen report)", () => {
  const at = (path: string) => parse(new URL(path, "http://127.0.0.1"));
  test("a chat's own paths show it; on the phone a pane or page over the chat hides it", () => {
    const c = `/c/${UNREAD}`;
    for (const p of [c, `${c}/model`, `${c}/rename`, `${c}/m/msg_1`, `${c}/send?text=hi`]) expect([p, conversationShows(at(p), false), conversationShows(at(p), true)]).toEqual([p, true, true]);
    for (const p of [`${c}/details`, `${c}/context`, `${c}/search`, `${c}/shell`]) expect([p, conversationShows(at(p), false), conversationShows(at(p), true)]).toEqual([p, true, false]);
    for (const p of ["/", "/chats", "/settings", `/p/${PROJECT}`]) expect([p, conversationShows(at(p), false), conversationShows(at(p), true)]).toEqual([p, false, false]);
  });
});

describe("the seen report's sender (web/net/onScreen.ts)", () => {
  /** The sender, with the attach of A and B drawn (rule 3) unless `drawn` is false. */
  function sender(drawn = true) {
    const writes: [string, boolean][] = [];
    const s = { visible: true, open: true };
    const os = new OnScreen({ write: (chat, on) => (s.open ? (writes.push([chat, on]), true) : false), visible: () => s.visible });
    if (drawn) for (const chat of [A, B]) os.drawn(chat);
    return { os, writes, s };
  }
  const A = UNREAD;
  const B = FAILED;
  test("rule 3: no on until the chat's attach is drawn; a new attach, or a lost socket, holds it back again", () => {
    const { os, writes } = sender(false);
    os.view(A, true);
    os.visibility();
    expect(writes).toEqual([]);
    os.drawn(A);
    expect(writes).toEqual([[A, true]]);
    // A new attach on the same socket (a reattach, or an open): off until its replay is drawn.
    os.attaching(A);
    expect(writes).toEqual([[A, true], [A, false]]);
    os.view(A, true);
    expect(writes.length).toBe(2);
    os.drawn(A);
    expect(writes.at(-1)).toEqual([A, true]);
    // A lost socket: the server forgot the on, and the next socket's attach is not drawn yet.
    os.lost();
    os.view(A, true);
    os.visibility();
    expect(writes.length).toBe(3);
    os.drawn(A);
    expect(writes).toEqual([[A, true], [A, false], [A, true], [A, true]]);
    // A chat whose view has not said it shows the end: drawn sends nothing.
    os.drawn(B);
    expect(writes.length).toBe(4);
  });
  test("on while the view shows the end on a visible page, off at each change, and only on a change", () => {
    const { os, writes } = sender();
    os.view(A, true);
    os.view(A, true);
    expect(writes).toEqual([[A, true]]);
    os.view(A, false);
    os.view(A, false);
    expect(writes).toEqual([[A, true], [A, false]]);
    // A chat that never said on never says off.
    os.view(B, false);
    expect(writes).toEqual([[A, true], [A, false]]);
  });
  test("never on from a hidden page; off when the page hides, on again when it shows", () => {
    const { os, writes, s } = sender();
    s.visible = false;
    os.view(A, true);
    expect(writes).toEqual([]);
    s.visible = true;
    os.visibility();
    expect(writes).toEqual([[A, true]]);
    s.visible = false;
    os.visibility();
    expect(writes).toEqual([[A, true], [A, false]]);
    os.drawn(A);
    expect(writes).toEqual([[A, true], [A, false]]);
  });
  test("pagehide says off at once, whatever the visibility says, until pageshow", () => {
    const { os, writes } = sender();
    os.view(A, true);
    os.hide();
    os.visibility();
    os.drawn(A);
    expect(writes).toEqual([[A, true], [A, false]]);
    os.show();
    expect(writes).toEqual([[A, true], [A, false], [A, true]]);
  });
  test("once the attach is drawn on a new socket the on goes again (the server forgets a closed socket's); a frame that could not go is sent then", () => {
    const { os, writes, s } = sender();
    os.view(A, true);
    os.lost();
    os.drawn(A);
    expect(writes).toEqual([[A, true], [A, true]]);
    // Drawn again with no new attach: nothing goes.
    os.drawn(A);
    expect(writes.length).toBe(2);
    // A chat whose view does not show the end: nothing.
    os.drawn(B);
    expect(writes.length).toBe(2);
    // Down, or not attached yet: the on could not go; it goes when the attach is drawn.
    s.open = false;
    os.view(B, true);
    s.open = true;
    expect(writes.length).toBe(2);
    os.drawn(B);
    expect(writes.at(-1)).toEqual([B, true]);
  });
  test("a view that leaves says off once and is forgotten", () => {
    const { os, writes } = sender();
    os.view(A, true);
    os.leave(A);
    os.drawn(A);
    os.visibility();
    expect(writes).toEqual([[A, true], [A, false]]);
  });
});

describe("the on_screen frame on the socket", () => {
  test("not an action: never recorded, read only for the click-through (a link only pre-fills, 5.2, 8.4)", () => {
    expect(isMutatingFrame("on_screen")).toBe(false);
  });
  test("it goes only on an open socket, for a chat this socket attached, with no rid", () => {
    boot();
    expect(conn.onScreen(UNREAD, true)).toBe(false);
    act.open(UNREAD);
    expect(conn.onScreen(UNREAD, true)).toBe(true);
    expect(screens()).toEqual([{ t: "on_screen", chat: UNREAD, on: true }]);
    expect(conn.onScreen(FAILED, true)).toBe(false);
    expect(g.window!.__kitespanFrames ?? []).toEqual([]);
    sock.drop();
    expect(conn.onScreen(UNREAD, false)).toBe(false);
  });
  test("the store: a chat drawn at its end says on; after a reconnect its attach is drawn and it says on again", () => {
    boot(UNREAD);
    act.onScreen(UNREAD, true);
    expect(screens()).toEqual([{ t: "on_screen", chat: UNREAD, on: true }]);
    const first = sock;
    first.drop();
    conn.wake();
    expect(sock).not.toBe(first);
    sock.onopen?.({});
    sock.receive(WELCOME);
    expect(sock.sent.map((f) => f.t)).toEqual(["hello", "attach"]);
    sock.receive(attachedOf(UNREAD, 3, "none"));
    expect(screens()).toEqual([{ t: "on_screen", chat: UNREAD, on: true }]);
    act.onScreen(UNREAD, false);
    expect(screens().at(-1)).toEqual({ t: "on_screen", chat: UNREAD, on: false });
    expect(g.window!.__kitespanFrames ?? []).toEqual([]);
  });
  test("the store sends what the view tells it; an on said before the chat's attach goes once the attach is drawn", () => {
    boot();
    act.open(UNREAD);
    act.onScreen(UNREAD, true);
    // Rule 3: the attach is not drawn yet, so nothing goes; its snapshot is in, and the on goes then.
    expect(screens()).toEqual([]);
    sock.receive(attachedOf(UNREAD, 3));
    expect(screens()).toEqual([]);
    sock.receive({ t: "snapshot", chat: UNREAD, seq: 3, more: null, history: [] });
    expect(screens()).toEqual([{ t: "on_screen", chat: UNREAD, on: true }]);
    act.onScreen(UNREAD, true);
    expect(screens().length).toBe(1);
    // A view that comes back before its attach (React runs the view's effects before App's act.open): the on cannot
    // go yet, and goes when the new attach is drawn.
    act.onScreen(UNREAD, false, true);
    act.open(null);
    act.onScreen(UNREAD, true);
    expect(screens().map((f) => f.on)).toEqual([true, false]);
    act.open(UNREAD);
    sock.receive(attachedOf(UNREAD, 3, "none"));
    expect(screens().map((f) => f.on)).toEqual([true, false, true]);
  });
  test("after a reconnect the view's report waits until the chat's new attach is drawn: its snapshot, or its missed events (rule 3)", () => {
    boot(UNREAD);
    act.onScreen(UNREAD, true);
    expect(screens()).toEqual([{ t: "on_screen", chat: UNREAD, on: true }]);
    // A phone that wakes: the socket went down while the page still drew the chat at its end.
    const again = () => {
      sock.drop();
      conn.wake();
      sock.onopen?.({});
      sock.receive(WELCOME);
      // The full list after welcome builds new chats, and the view's next render reports again: the chat is still
      // loaded from the socket before, but this socket's attach is not drawn.
      sock.receive({ t: "chats", list: ROWS });
      act.onScreen(UNREAD, true);
      expect(sock.sent.map((f) => f.t)).toEqual(["hello", "attach"]);
    };
    again();
    sock.receive(attachedOf(UNREAD, 3, "snapshot"));
    act.onScreen(UNREAD, true);
    expect(screens()).toEqual([]);
    sock.receive({ t: "snapshot", chat: UNREAD, seq: 3, more: null, history: [] });
    expect(screens()).toEqual([{ t: "on_screen", chat: UNREAD, on: true }]);
    // The events path: nothing until the last missed event is in.
    again();
    sock.receive(attachedOf(UNREAD, 5, "events"));
    act.onScreen(UNREAD, true);
    expect(screens()).toEqual([]);
    sock.receive({ t: "ev", chat: UNREAD, seq: 4, e: { k: "turn_start", by: "user" } });
    act.onScreen(UNREAD, true);
    expect(screens()).toEqual([]);
    sock.receive({ t: "ev", chat: UNREAD, seq: 5, e: { k: "turn_end", ok: true, subtype: "success", durationMs: 10, error: null, uuids: [] } });
    expect(screens()).toEqual([{ t: "on_screen", chat: UNREAD, on: true }]);
  });
  test("back to a chat drawn earlier in the page's life: no on until its new attach is drawn (rule 3)", () => {
    boot(UNREAD);
    act.onScreen(UNREAD, true);
    act.onScreen(UNREAD, false, true);
    act.open(null);
    expect(screens().map((f) => f.on)).toEqual([true, false]);
    // The view comes back (its chat is still loaded from before), then App opens the chat: an attach on the same socket.
    act.onScreen(UNREAD, true);
    act.open(UNREAD);
    act.onScreen(UNREAD, true);
    expect(screens().map((f) => f.on)).toEqual([true, false]);
    sock.receive(attachedOf(UNREAD, 3, "events"));
    expect(screens().map((f) => f.on)).toEqual([true, false, true]);
  });
});
