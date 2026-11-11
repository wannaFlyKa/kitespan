// Row 78 on the page: a chat whose session another app has open (the chat list's `held`) has Continue in a copy in
// Send's place (the bar's end on a laptop, the field row's key on a phone, at Send's height) and one plain dim line
// under the box, as the composer's other lines ("This session is open in the terminal. You can send here again when it
// is closed there.", in the desktop app's and another app's words); Enter sends nothing. Row 80 (held-box.test.ts)
// replaces row 78's editable draft: the field shows the draft read-only and the box's other controls are off. W19d's
// line over the chat is gone. When the hold goes, the store attaches the open chat again, so its history is read again
// (the other app's turns show) and Send comes back.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PROTOCOL_VERSION, type ChatRow, type ClientFrame, type ServerFrame } from "../../shared/protocol";
import { Connection, type SocketLike } from "../../web/net/socket";
import { act, connectWith, getState, resetState } from "../../web/state/store";
import { COPY_LABEL, HeldCopy, HeldLine, heldLine } from "../../web/composer/HeldLine";

const WEB = join(import.meta.dir, "..", "..", "web");
const src = (...p: string[]) => readFileSync(join(WEB, ...p), "utf8");
const PROJECT = "k3m7q2x4ab";
const CHAT = "k3m7q2x4abk3m7q2x4ab";
const OTHER = "abcdefghijabcdefghij";
const SID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("the words", () => {
  test("the line, in each app's words", () => {
    expect(heldLine("terminal")).toBe("This session is open in the terminal. You can send here again when it is closed there.");
    expect(heldLine("desktop")).toBe("This session is open in the desktop app. You can send here again when it is closed there.");
    expect(heldLine("other")).toBe("This session is open in another app. You can send here again when it is closed there.");
    expect(COPY_LABEL).toBe("Continue in a copy");
  });
  test("the line is one plain line under the box, as the composer's other lines: no tile, no button in it", () => {
    const html = renderToStaticMarkup(createElement(HeldLine, { app: "desktop" }));
    expect(html).toBe(`<p class="cmp-line" data-testid="composer-held" role="status">${heldLine("desktop")}</p>`);
    expect(html).not.toContain("notice");
  });
  test("Continue in a copy is a button in Send's place, at Send's height", () => {
    const html = renderToStaticMarkup(createElement(HeldCopy, { onCopy: () => {} }));
    expect(html).toMatch(/^<button type="button" class="btn cmp-copy"[^>]*data-testid="composer-copy"[^>]*>Continue in a copy<\/button>$/);
    expect(renderToStaticMarkup(createElement(HeldCopy, { onCopy: () => {}, busy: true }))).toContain("disabled");
    const css = src("styles", "composer.css").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toMatch(/\.btn\.cmp-copy\s*\{[^}]*height:\s*var\(--btn-h\)/);
    expect(css).not.toContain(".cmp-held");
  });
});

describe("the composer while the chat is held (row 78)", () => {
  const composer = src("composer", "Composer.tsx");
  test("Continue in a copy takes Send's place on every size: no Send or Run key, Stop stays while kitespan's own turn runs", () => {
    expect(composer).toContain("const held = chat.held ?? null;");
    // The laptop's bar: Stop while a turn runs, then Continue in a copy where Send was, as one unit (G-25).
    expect(composer).toContain('<span className="cmp-keys">\n                    {canStop ? stopButton : null}\n                    {held ? copyButton : sendButton}\n                  </span>');
    // The phone's field row has one key: Stop while kitespan's own turn finishes, then Continue in a copy.
    expect(composer).toContain("{phone ? (held ? (canStop ? stopButton : copyButton) : stopShared ? stopButton : sendButton) : null}");
    // A session handed to the terminal (S16) has Send again there instead (end-here.test.ts), off while one waits.
    expect(composer).toMatch(/held\?\.kind === "handed" \? \(\s*<HeldSendAgain busy=\{againOut\} onPress=\{\(\) => act\.sendQueued\(chat\.id\)\} \/>\s*\)/);
    expect(composer).toMatch(/: \(\s*<HeldCopy busy=\{copying\} onCopy=\{copyHeld\} \/>\s*\);/);
    // A chat that kitespan's own orphan holds (R16, `finishing`) has Stop alone (canStop), which ends that process; a
    // hand-over whose Claude Code still runs has nothing there until it sleeps (end-here.test.ts).
    expect(composer).toMatch(/const copyButton =\s*held\?\.kind === "finishing" \|\| handing \? null :/);
    // The sentence is the first line under the box.
    expect(composer).toContain('<div className="cmp-lines">\n            {held ? <HeldLine app={held.app} kind={held.kind} live={handing} /> : null}');
  });
  test("Enter and the Send path send nothing while held; the field shows the draft read-only, never disabled (row 80)", () => {
    expect(composer).toMatch(/const canSend = !held && !uploading && /);
    const field = composer.slice(composer.indexOf("<textarea"), composer.indexOf("/>", composer.indexOf("<textarea")));
    expect(field).toContain("readOnly={isHeld}");
    expect(field).toContain("value={d.text}");
    expect(field).not.toContain("disabled");
  });
  test("Continue in a copy forks the held session (the server opens its copy, or makes one) and opens that chat", () => {
    expect(composer).toContain("act.continueSession(chat.projectId, held.session, true)");
    expect(composer).toContain('navigate(href("chat", { chat: id }))');
  });
});

describe("W19d's line is gone", () => {
  test("the chat view has no also-open line, and its words are gone", () => {
    const view = src("chat", "ChatView.tsx");
    expect(view).not.toContain("alsoOpen");
    expect(view).not.toContain("also-open");
    expect(existsSync(join(WEB, "chat", "alsoOpen.ts"))).toBe(false);
  });
  test("its style rule is gone too", () => {
    expect(src("styles", "chat.css")).not.toContain("also-open");
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
  act.open(null);
  if (ownWindow) delete g.window;
  connectWith(null);
  resetState();
});

function boot(): FakeSocket {
  act.open(null);
  resetState();
  const sock = new FakeSocket();
  const conn = new Connection({ url: "ws://127.0.0.1:7942/ws", tab: "tab_me", open: () => sock, now: () => 0, setTimer: () => 0, clearTimer: () => {}, random: () => 0.5, reload: () => {} });
  connectWith(conn);
  conn.start();
  sock.onopen?.({});
  sock.receive({ t: "welcome", epoch: "lz2k3m-abcdefghijkl", version: "0.1.0", v: PROTOCOL_VERSION, claude: { ok: true, version: "2.1.312", drift: null }, update: { available: false }, auth: "none" });
  return sock;
}
const row = (over: Partial<ChatRow> = {}): ChatRow => ({ chat: CHAT, title: "Fix the upload", project: PROJECT, state: "sleeping", needsYou: false, lastActivity: "2026-10-31T10:00:00.000Z", archived: false, ...over });
const attaches = (sock: FakeSocket, chat: string) => sock.sent.filter((f) => f.t === "attach" && f.chat === chat).length;

describe("the store", () => {
  test("the chat keeps the list's held; a delta with null takes it away", () => {
    const sock = boot();
    sock.receive({ t: "chats", list: [row({ held: { app: "terminal", session: SID } })] });
    expect(getState().chats[0]!.held).toEqual({ app: "terminal", session: SID });
    sock.receive({ t: "chats", delta: { chat: CHAT, held: null } });
    expect(getState().chats[0]!.held ?? null).toBeNull();
    sock.receive({ t: "chats", delta: { chat: CHAT, held: { app: "desktop", session: SID } } });
    expect(getState().chats[0]!.held).toEqual({ app: "desktop", session: SID });
  });

  test("when the open chat's hold goes, the store attaches it again: its history is read again", () => {
    const sock = boot();
    sock.receive({ t: "chats", list: [row({ held: { app: "terminal", session: SID } }), row({ chat: OTHER, held: { app: "terminal", session: "0b1e2a3c-4d5e-4f60-8172-93a4b5c6d7e8" } })] });
    act.open(CHAT);
    expect(attaches(sock, CHAT)).toBe(1);
    // A change of app, or busy, is no end of the hold: no second read.
    sock.receive({ t: "chats", delta: { chat: CHAT, held: { app: "desktop", session: SID } } });
    expect(attaches(sock, CHAT)).toBe(1);
    sock.receive({ t: "chats", delta: { chat: CHAT, held: null } });
    expect(attaches(sock, CHAT)).toBe(2);
    // A chat that is not on screen reads its history when it is opened, not now.
    sock.receive({ t: "chats", delta: { chat: OTHER, held: null } });
    expect(attaches(sock, OTHER)).toBe(0);
    // A delta that changes something else does not read it again.
    sock.receive({ t: "chats", delta: { chat: CHAT, title: "Renamed" } });
    expect(attaches(sock, CHAT)).toBe(2);
  });

  test("Stop on a chat that kitespan's own orphan holds (finishing) sends an interrupt with turn 0; on D58's hold, nothing", async () => {
    const sock = boot();
    sock.receive({ t: "chats", list: [row({ held: { app: "other", session: SID, kind: "finishing" } }), row({ chat: OTHER, held: { app: "terminal", session: SID } })] });
    const done = act.stop(CHAT);
    const f = sock.sent.filter((x) => x.t === "interrupt");
    expect(f).toEqual([{ t: "interrupt", rid: expect.any(String), chat: CHAT, turn: 0 }]);
    sock.receive({ t: "ack", rid: f[0]!.rid, ok: true, result: { stillQueued: null } });
    expect(await done).toBe(true);
    expect(await act.stop(OTHER)).toBe(true);
    expect(sock.sent.filter((x) => x.t === "interrupt")).toHaveLength(1);
  });

  test("a send that the server refuses with session_held keeps the draft: the text comes back to the box, with no second line", async () => {
    const sock = boot();
    sock.receive({ t: "chats", list: [row()] });
    act.open(CHAT);
    const done = act.send(CHAT, "next step");
    const f = sock.sent.find((x) => x.t === "send") as { rid: string };
    // The server holds the chat before it answers, so its row's held comes first; the box's line says why.
    sock.receive({ t: "chats", delta: { chat: CHAT, held: { app: "terminal", session: SID } } });
    sock.receive({ t: "ack", rid: f.rid, ok: false, error: { code: "session_held", message: "This session is open in another app. You can send here again when it is closed there." } });
    expect(await done).toBe(false);
    expect(getState().drafts[CHAT]).toBe("next step");
    expect(getState().notice).toBeNull();
    // Any other refusal still shows its line.
    const again = act.send(CHAT, "next step");
    const g = sock.sent.filter((x) => x.t === "send")[1] as { rid: string };
    sock.receive({ t: "ack", rid: g.rid, ok: false, error: { code: "restarting", message: "kitespan is restarting." } });
    expect(await again).toBe(false);
    expect(getState().notice).toBe("kitespan is restarting.");
  });
});
