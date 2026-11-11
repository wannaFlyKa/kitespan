// The browser tab's title (owner row 91, which replaces row 50's lead default): always "kitespan", on every route, as
// web/index.html names it; nothing on the page sets it. A rename (in kitespan, a /rename typed in the chat, a generated
// title) still renames the chat everywhere in the app: its row in the store, its title bar.
import { afterAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PROTOCOL_VERSION, type ChatRow, type ClientFrame, type ServerFrame } from "../../shared/protocol";
import { TopBar } from "../../web/layout/TopBar";
import { parsePath } from "../../web/router";
import { Connection, type SocketLike } from "../../web/net/socket";
import { act, connectWith, getState, resetState } from "../../web/state/store";

const WEB = join(import.meta.dir, "..", "..", "web");
const CHAT = "k3m7q2x4abk3m7q2x4ab";
const OTHER = "abcdefghijklmnopqrst";
const PROJECT = "k3m7q2x4ab";

const g = globalThis as unknown as { window?: unknown; matchMedia?: unknown };
const own = { win: !g.window, mm: !g.matchMedia };
g.window ??= { innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {} };
g.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
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
    this.sent.push(JSON.parse(data) as ClientFrame);
  }
  close() {}
  receive(f: ServerFrame) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
}

const row = (chat: string, over: Partial<ChatRow> = {}): ChatRow => ({ chat, title: "Fix the upload", project: PROJECT, state: "idle", needsYou: false, lastActivity: "2026-10-31T10:00:00.000Z", archived: false, ...over });
const EPOCH = "lz2k3m-abcdefghijkl";

function boot(): FakeSocket {
  resetState();
  const sock = new FakeSocket();
  const conn = new Connection({ url: "ws://127.0.0.1:7942/ws", tab: "tab_me", open: () => sock, now: () => 0, setTimer: () => 0, clearTimer: () => {}, random: () => 0.5, reload: () => {} });
  connectWith(conn);
  conn.start();
  sock.onopen?.({});
  sock.receive({ t: "welcome", epoch: EPOCH, version: "0.1.0", v: PROTOCOL_VERSION, claude: { ok: true, version: "2.1.311", drift: null }, update: { available: false }, auth: "none" });
  sock.receive({ t: "chats", list: [row(CHAT), row(OTHER, { title: null, lastActivity: "2026-10-31T09:00:00.000Z" })] });
  return sock;
}

/** The chat's title as its title bar shows it. */
const barTitle = (chat: string) => {
  const c = getState().chats.find((x) => x.id === chat)!;
  const html = renderToStaticMarkup(createElement(TopBar, { route: parsePath(`/c/${chat}`), chat: c }));
  return /class="scr-bar-title"[^>]*>([^<]*)</.exec(html)?.[1] ?? null;
};

describe("the tab's title", () => {
  test("web/index.html names the tab kitespan, and nothing on the page sets document.title", () => {
    expect(readFileSync(join(WEB, "index.html"), "utf8")).toMatch(/<title>kitespan<\/title>/);
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|html)$/.test(n)) files.push(p);
      }
    };
    walk(WEB);
    const setters = files.filter((f) => /document\.title\s*=(?!=)|<title>(?!kitespan<)/.test(readFileSync(f, "utf8")));
    expect(setters.map((f) => f.slice(WEB.length + 1))).toEqual([]);
  });

  test("a rename from any page, a /rename typed in the chat, a generated title: the chat's row and its title bar follow", () => {
    const sock = boot();
    act.open(CHAT);
    sock.receive({ t: "attached", chat: CHAT, epoch: EPOCH, state: "idle", seq: 3, cards: [], picks: { model: null, effort: null, mode: null }, title: { text: "Fix the upload", from: "first-prompt" }, draft: { rev: 1, text: "", mode: "chat", command: null, link: false, uploads: [], by: null, at: "2026-10-31T10:00:00.000Z" }, archived: false, replay: "snapshot" });
    sock.receive({ t: "snapshot", chat: CHAT, seq: 3, more: null, history: [] });
    expect(barTitle(CHAT)).toBe("Fix the upload");
    sock.receive({ t: "ev", chat: CHAT, seq: 4, e: { k: "title", title: "Upload fix plan", from: "generated" } });
    expect(barTitle(CHAT)).toBe("Upload fix plan");
    sock.receive({ t: "ev", chat: CHAT, seq: 5, e: { k: "title", title: "Probe title 42", from: "renamed" } });
    sock.receive({ t: "chats", delta: { chat: CHAT, title: "Probe title 42" } });
    expect(getState().chats.find((c) => c.id === CHAT)?.title).toBe("Probe title 42");
    expect(barTitle(CHAT)).toBe("Probe title 42");
    // A chat this page has not opened follows its row.
    sock.receive({ t: "chats", delta: { chat: OTHER, title: "Named elsewhere" } });
    expect(barTitle(OTHER)).toBe("Named elsewhere");
  });
});
