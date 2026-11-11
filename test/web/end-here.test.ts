// End it here and copy on the page (DESIGN.md 6.10, 9.4; build checklist S16, L16): the copy dialog at
// /c/<chat>/terminal, while the chat's Claude Code lives, has two buttons, Copy a fork command and End it here and copy;
// the second copies the plain command inside the click, then sends `end_here`. While the chat is held as handed to the
// terminal, the dialog says "Wait: this chat's Claude Code is still running." until the chat sleeps, then "Ended. Paste
// the command in your terminal now." and shows the plain command. The chat's box says "This chat's session was handed to
// your terminal." with Send again in Send's place. Rendered with React's server renderer; a fake socket for the frame.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PROTOCOL_VERSION, type ClientFrame, type ServerFrame } from "../../shared/protocol";
import { Composer } from "../../web/composer/Composer";
import { heldLine } from "../../web/composer/HeldLine";
import { TerminalBody } from "../../web/dialogs/ChatDialogs";
import { END_HERE_WORDS, endHereClick, endHereLine, plainResume } from "../../web/dialogs/endHere";
import { resumeCommand } from "../../web/terminal/command";
import { Connection, type SocketLike } from "../../web/net/socket";
import { parse } from "../../web/router";
import { act, connectWith, resetState } from "../../web/state/store";
import type { Chat, Project } from "../../web/state/types";
import { scripted } from "./fixtures";

const SID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const P: Project = { id: "kitespanxx", name: "kitespan", folder: "/work/kite span", branch: "", picks: {} };
const CHAT = "endherechataaaaaaaaa";
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");
const ids = (html: string) => [...html.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]!);
const PLAIN = `cd '/work/kite span' && claude --resume ${SID}`;

function chatWith(p: Partial<Chat> = {}): Chat {
  return {
    ...scripted({
      id: CHAT,
      projectId: P.id,
      title: "Ship the release",
      titleSource: "first-prompt",
      state: "running",
      updatedAt: "2026-11-02T08:00:00.000Z",
      sessionId: SID,
      model: "default",
      effort: "default",
      mode: "default",
      items: [{ id: "u1", kind: "user", text: "go", at: "2026-11-02T08:00:00.000Z" } as Chat["items"][number]],
      pending: [],
      context: { usedPct: 0, usedTokens: 0, windowTokens: 0, parts: [] },
      connectors: [],
      outputs: [],
    }),
    ...p,
  };
}
const HANDED = { app: "terminal" as const, session: SID, kind: "handed" as const };

const g = globalThis as unknown as { matchMedia?: unknown; window?: unknown };
const was = { mm: g.matchMedia, win: g.window, hadMm: "matchMedia" in g, hadWin: "window" in g };
beforeAll(() => {
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  g.window = { innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {} };
});
afterAll(() => {
  if (was.hadMm) g.matchMedia = was.mm;
  else delete g.matchMedia;
  if (was.hadWin) g.window = was.win;
  else delete g.window;
  connectWith(null);
  resetState();
});

const body = (chat: Chat) => renderToStaticMarkup(createElement(TerminalBody, { chat, folder: P.folder, sheet: false, onClose: () => {} }));

describe("the copy dialog (S16)", () => {
  test("while the chat's Claude Code lives: the fork command, and two buttons, Copy a fork command and End it here and copy", () => {
    const html = body(chatWith());
    expect(ids(html)).toEqual(expect.arrayContaining(["confirm-copy-fork", "confirm-end-here"]));
    expect(text(html)).toContain("Copy a fork command");
    expect(text(html)).toContain(END_HERE_WORDS.button);
    expect(END_HERE_WORDS.button).toBe("End it here and copy");
    expect(text(html)).toContain("--fork-session");
    expect(text(html)).not.toContain(END_HERE_WORDS.wait);
  });

  test("handed to the terminal while the process still runs: the Wait line, and never the plain command (6.10)", () => {
    const html = body(chatWith({ held: HANDED }));
    expect(END_HERE_WORDS.wait).toBe("Wait: this chat's Claude Code is still running.");
    expect(text(html)).toContain(END_HERE_WORDS.wait);
    expect(text(html).replaceAll(`${PLAIN} --fork-session`, "")).not.toContain(PLAIN);
  });

  test("once it sleeps: Ended, the plain command and Copy; no fork button", () => {
    const html = body(chatWith({ held: HANDED, state: "sleeping", serverState: "sleeping" }));
    expect(END_HERE_WORDS.ended).toBe("Ended. Paste the command in your terminal now.");
    expect(text(html)).toContain(END_HERE_WORDS.ended);
    expect(text(html)).toContain(PLAIN);
    expect(ids(html)).toContain("confirm-copy");
    expect(ids(html)).not.toContain("confirm-end-here");
    expect(ids(html)).not.toContain("confirm-copy-fork");
  });

  test("a sleeping chat that was never handed over: the plain Copy only, no line", () => {
    const html = body(chatWith({ state: "sleeping", serverState: "sleeping" }));
    expect(ids(html)).not.toContain("confirm-end-here");
    expect(endHereLine(chatWith({ state: "sleeping", serverState: "sleeping" }))).toBeNull();
  });

  test("held as finishing (kitespan's own orphan still runs, its row says sleeping): only the fork command and its lines, no End it here", () => {
    const finishing = chatWith({ state: "sleeping", serverState: "sleeping", held: { app: "other", session: SID, kind: "finishing" } });
    const html = body(finishing);
    expect(text(html)).toContain(`${PLAIN} --fork-session`);
    expect(text(html)).toContain("This chat's Claude Code is still open.");
    expect(ids(html)).toContain("confirm-copy-fork");
    expect(ids(html)).not.toContain("confirm-copy");
    expect(ids(html)).not.toContain("confirm-end-here");
    expect(resumeCommand(finishing, P.folder)).toMatchObject({ case: "fork", command: `${PLAIN} --fork-session` });
  });

  test("Wait (handed, the process still runs): the box keeps the fork command under Copy a fork command, and End it here shows as done", () => {
    const html = body(chatWith({ held: HANDED }));
    expect(text(html)).toContain(END_HERE_WORDS.wait);
    const box = html.slice(html.indexOf("<pre"), html.indexOf("</pre>"));
    expect(text(box)).toContain(`${PLAIN} --fork-session`);
    expect(ids(html)).toContain("confirm-copy-fork");
    const end = html.slice(html.lastIndexOf("<button", html.indexOf('data-testid="confirm-end-here"')), html.indexOf(">", html.indexOf('data-testid="confirm-end-here"')) + 1);
    expect(end).toContain('disabled=""');
  });

  test("the button row wraps where three buttons do not fit (a 480 px dialog at touch sizes), so Close is never clipped past its edge", () => {
    const css = readFileSync(join(import.meta.dir, "..", "..", "web", "styles", "base.css"), "utf8");
    expect(css).toMatch(/\.dialog-actions \{[^}]*flex-wrap: wrap;/);
  });

  test("the click copies the plain command first, then sends end_here", () => {
    expect(plainResume(chatWith(), P.folder)).toBe(PLAIN);
    const order: string[] = [];
    endHereClick(PLAIN, (t) => order.push(`copy ${t}`), () => order.push("send"));
    expect(order).toEqual([`copy ${PLAIN}`, "send"]);
  });
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
  close() {
    this.readyState = 3;
  }
  receive(f: ServerFrame) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
}

describe("the store (S16)", () => {
  test("act.endHere sends one end_here frame for the chat and resolves on its ack", async () => {
    resetState({ ready: true, projects: [P], chats: [chatWith()] });
    const socket = new FakeSocket();
    const conn = new Connection({ url: "ws://127.0.0.1:7945/ws", tab: "tab_me", open: () => socket, now: () => 0, setTimer: () => 0, clearTimer: () => {}, random: () => 0.5, reload: () => {} });
    connectWith(conn);
    conn.start();
    socket.onopen?.({});
    socket.receive({ t: "welcome", epoch: "e1", version: "0.1.0", v: PROTOCOL_VERSION, claude: { ok: true, version: "2.1.317", drift: null }, update: { available: false }, auth: "none" });
    const done = act.endHere(CHAT);
    const frame = socket.sent.find((f) => f.t === "end_here") as Extract<ClientFrame, { t: "end_here" }>;
    expect(frame).toMatchObject({ t: "end_here", chat: CHAT });
    socket.receive({ t: "ack", rid: frame.rid, ok: true, result: { ending: true } });
    expect(await done).toBe(true);
    connectWith(null);
  });
});

describe("the box while handed to the terminal (S16, L16)", () => {
  const url = (path: string) => parse(new URL(path, "http://127.0.0.1"));
  const render = (chat: Chat) => {
    resetState({ projects: [P], chats: [chat], ready: true });
    return renderToStaticMarkup(createElement(Composer, { chat, route: url(`/c/${chat.id}`) }));
  };

  test("its own line, and Send again in Send's place; D58's line and Continue in a copy otherwise", () => {
    expect(heldLine("terminal", "handed")).toBe("This chat's session was handed to your terminal.");
    const handed = render(chatWith({ id: "endherechatbbbbbbbbb", held: HANDED, state: "sleeping", serverState: "sleeping" }));
    expect(text(handed)).toContain("This chat's session was handed to your terminal.");
    expect(ids(handed)).toContain("composer-send-again");
    expect(text(handed)).toContain("Send again");
    expect(ids(handed)).not.toContain("composer-copy");
    const other = render(chatWith({ id: "endherechatcccccccccc".slice(0, 20), held: { app: "terminal", session: SID }, state: "sleeping", serverState: "sleeping" }));
    expect(text(other)).toContain("This session is open in the terminal.");
    expect(ids(other)).toContain("composer-copy");
    expect(ids(other)).not.toContain("composer-send-again");
  });

  test("right after End it here, while kitespan's Claude Code still runs: the box says Wait, with no Send again; the hand-over line once it sleeps", () => {
    const running = render(chatWith({ id: "endherechatdddddddddd".slice(0, 20), held: HANDED, state: "running", serverState: "running", turn: 7 }));
    expect(text(running)).toContain(END_HERE_WORDS.wait);
    expect(text(running)).not.toContain("This chat's session was handed to your terminal.");
    expect(ids(running)).not.toContain("composer-send-again");
    expect(ids(running)).toContain("composer-stop");
    const idle = render(chatWith({ id: "endherechateeeeeeeeee".slice(0, 20), held: HANDED, state: "idle", serverState: "idle", turn: null }));
    expect(text(idle)).toContain(END_HERE_WORDS.wait);
    expect(ids(idle)).not.toContain("composer-send-again");
    const asleep = render(chatWith({ id: "endherechatffffffffff".slice(0, 20), held: HANDED, state: "sleeping", serverState: "sleeping", turn: null }));
    expect(text(asleep)).toContain("This chat's session was handed to your terminal.");
    expect(ids(asleep)).toContain("composer-send-again");
  });

  test("Send again sends send_queued (the server ends the hold there)", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "web", "composer", "Composer.tsx"), "utf8");
    expect(src).toContain("act.sendQueued(chat.id)");
  });
});
