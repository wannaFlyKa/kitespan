// The update notice on every page (owner row 108; DESIGN.md 4.3, 4.10): the server's notice with the id "update" is
// kept by the store in a field of its own, never as the screen's plain notice, so the 8 s timers and a screen that
// opens (which clear that notice) never take it away: the step line stands for the whole update, and "Update
// available." keeps its Update button. `welcome` brings origin's line, a later notice replaces it, and `gone` takes
// it away. It shows once on each screen: in the chat list's foot (the docked sidebar on a laptop, the drawers, the
// phone's /chats), and where no docked sidebar is, on a chat's screen, Home, /new and Settings (About has its own
// rows). Rendered with React's server renderer, through a fake socket.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PROTOCOL_VERSION, UPDATE_NOTICE, type ClientFrame, type ServerFrame } from "../../shared/protocol";
import { failedLine, runningLine, UPDATE_REFUSAL_LINES, UPDATE_WORDS } from "../../shared/update";
import { Connection, type SocketLike } from "../../web/net/socket";
import { act, connectWith, getState, listNotice, resetState } from "../../web/state/store";
import type { Chat } from "../../web/state/types";
import { parse } from "../../web/router";
import { ChatListBody } from "../../web/screens/ChatListBody";
import { ChatScreen } from "../../web/chat/ChatScreen";
import { HomeBody, NewChat } from "../../web/screens/Home";
import { SettingsLine } from "../../web/screens/Settings";
import { resetUpdateState } from "../../web/update/state";
import { scripted } from "./fixtures";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");
const ids = (html: string) => [...html.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]!);
const count = (html: string, id: string) => ids(html).filter((x) => x === id).length;

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

type Kind = "none" | "available" | "diverged";
const welcome = (epoch: string, kind: Kind = "none"): ServerFrame => ({
  t: "welcome",
  epoch,
  version: "0.4.0",
  v: PROTOCOL_VERSION,
  claude: { ok: true, version: "2.1.317", drift: null },
  update: { available: kind === "available", kind },
  auth: "none",
});

function connect(kind: Kind = "none"): FakeSocket {
  const socket = new FakeSocket();
  const conn = new Connection({ url: "ws://127.0.0.1:7946/ws", tab: "tab_me", open: () => socket, now: () => 0, setTimer: () => 0, clearTimer: () => {}, random: () => 0.5, reload: () => {} });
  connectWith(conn);
  conn.start();
  socket.onopen?.({});
  socket.receive(welcome("e1", kind));
  return socket;
}

const CHAT = "k3m7q2x4abk3m7q2x4aa";
const PROJECT = { id: "k3m7q2x4ab", name: "kitespan", folder: "/work/kitespan", branch: "", picks: {}, env: 0, worktree: false, worktreeOff: null };
function chat(): Chat {
  return scripted({
    id: CHAT,
    projectId: PROJECT.id,
    title: "A chat",
    titleSource: "first-prompt",
    state: "idle",
    updatedAt: "2026-11-04T08:00:00.000Z",
    sessionId: "",
    model: "default",
    effort: "default",
    mode: "default",
    items: [],
    pending: [],
    context: { usedPct: 0, usedTokens: 0, windowTokens: 0, parts: [] },
    connectors: [],
    outputs: [],
  });
}

const g = globalThis as unknown as { matchMedia?: unknown; window?: { innerWidth: number; innerHeight: number } & Record<string, unknown>; history?: unknown };
const was = { mm: g.matchMedia, win: g.window, hist: g.history, hadMm: "matchMedia" in g, hadWin: "window" in g, hadHist: "history" in g };
const at = (width: number) => {
  g.window = { innerWidth: width, innerHeight: width < 600 ? 844 : 800, addEventListener() {}, removeEventListener() {} };
};
beforeAll(() => {
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  g.history = { state: null, pushState() {}, replaceState() {} }; // the drawer and the chat screen read their entry
  at(1280);
});
afterAll(() => {
  connectWith(null);
  if (was.hadMm) g.matchMedia = was.mm;
  else delete g.matchMedia;
  if (was.hadWin) g.window = was.win;
  else delete g.window;
  if (was.hadHist) g.history = was.hist;
  else delete g.history;
  resetUpdateState();
  resetState();
});
beforeEach(() => {
  at(1280);
  resetState({ ready: true });
  resetUpdateState();
});

describe("the store keeps the update notice (row 108)", () => {
  test("in a field of its own, never as the screen's notice: the 8 s timers and a screen that opens leave it", () => {
    const s = connect();
    s.receive({ t: "notice", text: runningLine("install"), id: UPDATE_NOTICE });
    expect(getState().updateNotice).toEqual({ text: runningLine("install"), actions: [] });
    expect(getState().notice).toBeNull();
    expect(listNotice(getState())).toBeNull();
    // What NOTICE_MS, SCREEN_NOTICE_MS and useScreenNotice's open do.
    act.setNotice(null);
    expect(getState().updateNotice?.text).toBe(runningLine("install"));
    // A refused request's line is the screen's notice, beside it.
    act.setNotice("That did not work.");
    expect(getState().updateNotice?.text).toBe(runningLine("install"));
  });

  test("a later one replaces it with its actions; `gone` takes it away and no other line", () => {
    const s = connect();
    s.receive({ t: "notice", text: UPDATE_WORDS.availableNotice, id: UPDATE_NOTICE, actions: ["update"] });
    expect(getState().updateNotice).toEqual({ text: UPDATE_WORDS.availableNotice, actions: ["update"] });
    s.receive({ t: "notice", text: runningLine("fetch"), id: UPDATE_NOTICE });
    expect(getState().updateNotice).toEqual({ text: runningLine("fetch"), actions: [] });
    s.receive({ t: "notice", text: failedLine("install"), id: UPDATE_NOTICE, actions: ["update"] });
    expect(getState().updateNotice).toEqual({ text: failedLine("install"), actions: ["update"] });
    act.setNotice("A line of its own.");
    s.receive({ t: "notice", text: "", id: UPDATE_NOTICE, gone: true });
    expect(getState().updateNotice).toBeNull();
    expect(getState().notice).toBe("A line of its own.");
  });

  test("welcome brings origin's line (a page that loads later shows it too); the standing notice after it replaces it", () => {
    connect("available");
    expect(getState().updateNotice).toEqual({ text: UPDATE_WORDS.availableNotice, actions: ["update"] });
    connect("diverged");
    expect(getState().updateNotice).toEqual({ text: UPDATE_REFUSAL_LINES.diverged, actions: [] });
    const s = connect("none");
    expect(getState().updateNotice).toBeNull();
    s.receive({ t: "notice", text: UPDATE_WORDS.doneNotice, id: UPDATE_NOTICE });
    expect(getState().updateNotice?.text).toBe(UPDATE_WORDS.doneNotice);
    // A new server life: its welcome and its own standing notices decide.
    s.receive(welcome("e2", "none"));
    expect(getState().updateNotice).toBeNull();
  });
});

describe("the update line on every screen, once (row 108)", () => {
  const withNotice = (text: string, actions: ("update")[] = []) => resetState({ ready: true, projects: [PROJECT], projectsRead: true, chats: [chat()], updateNotice: { text, actions } });

  test("the chat list's foot, in every form of the list, with Update when the notice offers it", () => {
    withNotice(UPDATE_WORDS.availableNotice, ["update"]);
    for (const variant of ["sidebar", "drawer", "screen"] as const) {
      const html = renderToStaticMarkup(createElement(ChatListBody, { route: parse(new URL("/chats", "http://127.0.0.1")), variant }));
      expect(ids(html)).toContain("update-line");
      expect(ids(html)).toContain("update-open");
      expect(html).toContain('href="/settings/about/update"');
    }
    // Beside Settings > About, whose own rows say it, the foot does not.
    for (const path of ["/settings/about", "/settings/about/update", "/settings/about/restart"])
      expect(ids(renderToStaticMarkup(createElement(ChatListBody, { route: parse(new URL(path, "http://127.0.0.1")), variant: "sidebar" })))).not.toContain("update-line");
    expect(ids(renderToStaticMarkup(createElement(ChatListBody, { route: parse(new URL("/settings/general", "http://127.0.0.1")), variant: "sidebar" })))).toContain("update-line");
    withNotice(runningLine("build"));
    const html = renderToStaticMarkup(createElement(ChatListBody, { route: parse(new URL("/chats", "http://127.0.0.1")), variant: "sidebar" }));
    expect(text(html)).toContain(runningLine("build"));
    expect(ids(html)).not.toContain("update-open");
  });

  test("a chat's screen: in the sidebar on a laptop, above the message box on a phone", () => {
    withNotice(runningLine("install"));
    const route = parse(new URL(`http://127.0.0.1/c/${CHAT}`));
    at(1280);
    let html = renderToStaticMarkup(createElement(ChatScreen, { route }));
    expect(count(html, "update-line")).toBe(1);
    at(390);
    html = renderToStaticMarkup(createElement(ChatScreen, { route }));
    expect(count(html, "update-line")).toBe(1);
    expect(text(html)).toContain(runningLine("install"));
    // A refused request's line takes the place while it shows; the step line comes back after it.
    act.setNotice("That did not work.");
    html = renderToStaticMarkup(createElement(ChatScreen, { route }));
    expect(ids(html)).toContain("chat-notice");
    expect(ids(html)).not.toContain("update-line");
  });

  test("Home and /new on a phone; on a laptop the sidebar's foot has it", () => {
    withNotice(runningLine("install"));
    at(390);
    expect(count(renderToStaticMarkup(createElement(HomeBody, { route: parse(new URL("http://127.0.0.1/")), autoFocus: false })), "update-line")).toBe(1);
    expect(count(renderToStaticMarkup(createElement(NewChat, { route: parse(new URL("http://127.0.0.1/new")) })), "update-line")).toBe(1);
    at(1280);
    expect(count(renderToStaticMarkup(createElement(HomeBody, { route: parse(new URL("http://127.0.0.1/")), autoFocus: false })), "update-line")).toBe(0);
  });

  test("origin's standing lines (Update available, diverged) only in the chat list's foot, never on a screen", () => {
    const route = parse(new URL(`http://127.0.0.1/c/${CHAT}`));
    for (const [text, actions] of [[UPDATE_WORDS.availableNotice, ["update"]], [UPDATE_REFUSAL_LINES.diverged, []]] as const) {
      withNotice(text, [...actions]);
      at(390);
      expect(count(renderToStaticMarkup(createElement(ChatScreen, { route })), "update-line")).toBe(0);
      expect(count(renderToStaticMarkup(createElement(HomeBody, { route: parse(new URL("http://127.0.0.1/")), autoFocus: false })), "update-line")).toBe(0);
      expect(count(renderToStaticMarkup(createElement(NewChat, { route: parse(new URL("http://127.0.0.1/new")) })), "update-line")).toBe(0);
      expect(count(renderToStaticMarkup(createElement(ChatListBody, { route: parse(new URL("/chats", "http://127.0.0.1")), variant: "screen" })), "update-line")).toBe(1);
    }
  });

  test("Settings' line on a phone, never in About (its own rows); on a laptop the sidebar's foot has it", () => {
    withNotice(runningLine("fetch"));
    const PHONE = { touch: true, laptop: false, phone: true, narrow: true };
    const LAPTOP = { touch: false, laptop: true, phone: false, narrow: false };
    const general = parse(new URL("/settings/general", "http://127.0.0.1"));
    const about = parse(new URL("/settings/about", "http://127.0.0.1"));
    at(390);
    expect(text(renderToStaticMarkup(createElement(SettingsLine, { route: general, section: "general", ctx: PHONE })))).toContain(runningLine("fetch"));
    expect(renderToStaticMarkup(createElement(SettingsLine, { route: about, section: "about", ctx: PHONE }))).not.toContain("update-line");
    at(1280);
    expect(renderToStaticMarkup(createElement(SettingsLine, { route: general, section: "general", ctx: LAPTOP }))).not.toContain("update-line");
  });
});
