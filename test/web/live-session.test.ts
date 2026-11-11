// D58 on the page: a session that another process has open is marked in the project's session list and in its
// preview ("Open in the terminal now", "Open in the desktop app now", "Open in another app now", with "busy" while its
// status says so), and its Continue here becomes "Continue in a copy", which sends `continue_session` with `fork`. A
// chat whose session is open elsewhere is held (row 78: test/web/held.test.ts), which replaced W19d's one line.
import { afterAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PROTOCOL_VERSION, type ClientFrame, type ServerFrame } from "../../shared/protocol";
import { Connection, type SocketLike } from "../../web/net/socket";
import { act, connectWith, getState, resetState } from "../../web/state/store";
import { continueWord, openMark, PreviewDock, ProjectSessionRows } from "../../web/screens/ProjectScreen";
import { SessionRows, whenBack } from "../../web/screens/Home";
import type { Project } from "../../web/state/types";

const PROJECT = "k3m7q2x4ab";
const CHAT = "k3m7q2x4abk3m7q2x4ab";
const A = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const B = "0b1e2a3c-4d5e-4f60-8172-93a4b5c6d7e8";
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("the words", () => {
  test("the mark says where the session is open, and busy while it is", () => {
    expect(openMark({ app: "terminal", busy: false })).toBe("Open in the terminal now");
    expect(openMark({ app: "terminal", busy: true })).toBe("Open in the terminal now, busy");
    expect(openMark({ app: "desktop", busy: false })).toBe("Open in the desktop app now");
    expect(openMark({ app: "other", busy: true })).toBe("Open in another app now, busy");
    // R22: a session that waits for an answer says so in busy's place.
    expect(openMark({ app: "terminal", busy: true, waiting: true })).toBe("Open in the terminal now, waiting for an answer");
  });
  test("the button is Continue in a copy while the session is open elsewhere, else Continue here", () => {
    expect(continueWord({ app: "terminal", busy: false })).toBe("Continue in a copy");
    expect(continueWord(null)).toBe("Continue here");
    expect(continueWord(undefined)).toBe("Continue here");
  });
});

describe("the project's session list and the preview's dock", () => {
  const project: Project = { id: PROJECT, name: "app", folder: "/srv/work/app", branch: "", picks: {} };
  test("only the open session's row carries the mark", () => {
    const html = renderToStaticMarkup(
      createElement(ProjectSessionRows, {
        project,
        sessions: [
          { sessionId: A, title: "Ledger loop", lastModified: Date.now() - 60_000, open: { app: "terminal", busy: true } },
          { sessionId: B, title: "Workspace sync", lastModified: Date.now() - 120_000 },
        ],
      }),
    );
    const rows = html.split("<li").slice(1).map(text);
    expect(rows[0]).toContain("Ledger loop");
    expect(rows[0]).toContain("Open in the terminal now, busy");
    expect(rows[1]).toContain("Workspace sync");
    expect(rows[1]).not.toContain("Open in");
  });
  test("Home's From the terminal marks the same rows (W19d), with the project on the same line when the list mixes projects", () => {
    const other: Project = { ...project, id: "abcdefghij", name: "notes-api" };
    const rows = (withProject: boolean) =>
      renderToStaticMarkup(
        createElement(SessionRows, {
          withProject,
          rows: [
            { s: { sessionId: A, title: "Ledger loop", lastModified: Date.now() - 60_000, open: { app: "terminal", busy: true } }, p: project },
            { s: { sessionId: B, title: "Notes search", lastModified: Date.now() - 120_000, open: { app: "desktop", busy: false } }, p: other },
            { s: { sessionId: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed", title: "Workspace sync", lastModified: Date.now() - 180_000 }, p: project },
          ],
        }),
      )
        .split("<li")
        .slice(1);
    const mixed = rows(true);
    expect(text(mixed[0]!)).toContain("Ledger loop");
    expect(text(mixed[0]!)).toContain("app, open in the terminal now, busy");
    expect(text(mixed[1]!)).toContain("notes-api, open in the desktop app now");
    expect(mixed[0]).toContain('data-testid="session-open"');
    expect(text(mixed[2]!)).toContain("Workspace sync");
    expect(text(mixed[2]!)).not.toContain("Open in");
    expect(text(mixed[2]!)).not.toContain("open in");
    const one = rows(false);
    expect(text(one[0]!)).toContain("Open in the terminal now, busy");
    expect(text(one[0]!)).not.toContain("app,");
  });
  test("a preview whose session has a copy offers it beside Continue (W19d); with none, no such link", () => {
    const COPY = "abcdefghijabcdefghij";
    const html = renderToStaticMarkup(createElement(PreviewDock, { open: { app: "terminal", busy: false }, ready: true, onContinue: () => {}, copy: COPY }));
    expect(text(html)).toContain("Open the copy");
    expect(html).toContain(`href="/c/${COPY}"`);
    expect(text(html)).toContain("Continue in a copy");
    const none = renderToStaticMarkup(createElement(PreviewDock, { open: { app: "terminal", busy: false }, ready: true, onContinue: () => {}, copy: null }));
    expect(text(none)).not.toContain("Open the copy");
  });
  test("the list and the preview read again when the page comes back into view or gets the focus, once for both", () => {
    const doc = new EventTarget() as EventTarget & { visibilityState: string };
    doc.visibilityState = "visible";
    const win = new EventTarget();
    let now = 0;
    let n = 0;
    const stop = whenBack(() => n++, { doc, win, now: () => now });
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(n).toBe(0);
    now = 10_000;
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    win.dispatchEvent(new Event("focus"));
    expect(n).toBe(1);
    now = 20_000;
    win.dispatchEvent(new Event("focus"));
    expect(n).toBe(2);
    stop();
    now = 30_000;
    win.dispatchEvent(new Event("focus"));
    expect(n).toBe(2);
  });
  test("an open session's dock says so and offers the copy; a closed one keeps Desktop's advice and Continue here", () => {
    const open = text(renderToStaticMarkup(createElement(PreviewDock, { open: { app: "desktop", busy: false }, ready: true, onContinue: () => {} })));
    expect(open).toContain("Open in the desktop app now");
    expect(open).toContain("Continue in a copy");
    expect(open).not.toContain("Continue here");
    const closed = text(renderToStaticMarkup(createElement(PreviewDock, { open: null, ready: true, onContinue: () => {} })));
    expect(closed).toContain("Close this session in your terminal first");
    expect(closed).toContain("Continue here");
    expect(closed).not.toContain("copy");
  });
});

// ---- the store on a fake socket

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

const g = globalThis as unknown as { window?: object };
const ownWindow = !g.window;
g.window ??= {};
afterAll(() => {
  if (ownWindow) delete g.window;
  connectWith(null);
  resetState();
});

function boot(): FakeSocket {
  resetState();
  const sock = new FakeSocket();
  const conn = new Connection({ url: "ws://127.0.0.1:7941/ws", tab: "tab_me", open: () => sock, now: () => 0, setTimer: () => 0, clearTimer: () => {}, random: () => 0.5, reload: () => {} });
  connectWith(conn);
  conn.start();
  sock.onopen?.({});
  sock.receive({ t: "welcome", epoch: "lz2k3m-abcdefghijkl", version: "0.1.0", v: PROTOCOL_VERSION, claude: { ok: true, version: "2.1.312", drift: null }, update: { available: false }, auth: "none" });
  return sock;
}

describe("the store", () => {
  test("Continue in a copy sends fork; Continue here does not", async () => {
    const sock = boot();
    const copy = act.continueSession(PROJECT, A, true);
    const f1 = sock.sent.find((f) => f.t === "continue_session")!;
    expect(f1).toMatchObject({ project: PROJECT, session: A, fork: true });
    sock.receive({ t: "ack", rid: (f1 as { rid: string }).rid, ok: true, result: { chat: CHAT } });
    expect(await copy).toBe(CHAT);
    const here = act.continueSession(PROJECT, B);
    const f2 = sock.sent.filter((f) => f.t === "continue_session")[1]!;
    expect(f2).not.toHaveProperty("fork");
    sock.receive({ t: "ack", rid: (f2 as { rid: string }).rid, ok: true, result: { chat: CHAT } });
    expect(await here).toBe(CHAT);
  });

  test("Continue here that the server refuses because the session is open now: no chat, and the page learns the code", async () => {
    const sock = boot();
    const codes: string[] = [];
    const here = act.continueSession(PROJECT, A, false, (code) => codes.push(code));
    const f = sock.sent.find((x) => x.t === "continue_session") as { rid: string };
    sock.receive({ t: "ack", rid: f.rid, ok: false, error: { code: "session_open", message: "That session is open in another app now. Continue it in a copy." } });
    expect(await here).toBeNull();
    expect(codes).toEqual(["session_open"]);
    expect(getState().notice).toBe("That session is open in another app now. Continue it in a copy.");
  });
});
