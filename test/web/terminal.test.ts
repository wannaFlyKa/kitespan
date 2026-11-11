// The Terminal pane on the chat's real shell (D38, D52; BUILD-CHECKLIST D5; DESIGN.md 4.3 "The shell socket", 6.10),
// with a fake WebSocket, a fake clock for the link's backoff and a fake view (no browser): the page's side of
// /ws/shell (web/terminal/link.ts) and the pane's session (web/terminal/session.ts).
// - The link: `open` with the chat and the pane's size as the first frame; the ring and live output as bytes; keys as
//   UTF-8 binary frames of at most 64 KiB, and only while a shell is attached; `resize` and `type_resume` as JSON,
//   `type_resume` held until `opened`; `typed`, `size`, `reset`, `exit` and a new `open` after it; a refusal stops the
//   dialling; a dropped socket dials again with the backoff.
// - The session: opening the pane and asking for the resume command record nothing, a typed character records
//   nothing, and only Enter records one "shell" action (DESIGN.md 8.3 check 10); the key bar's Ctrl; keys typed while
//   no shell is attached are dropped; the line above the terminal; the page that types sets the shell's size; a
//   replayed ring answers no terminal query.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { SHELL_LIMITS } from "../../shared/protocol";
import { backoffMs } from "../../web/net/socket";
import { cleanPaste } from "../../web/terminal/keys";
import { ShellLink, keyFrames, type LinkStatus, type ShellLinkEvents, type ShellSocketLike } from "../../web/terminal/link";
import {
  ENDED_LINE,
  RECONNECTING_LINE,
  answersQueries,
  configureLinks,
  existingSession,
  noteLines,
  requestType,
  resetSessions,
  saidFor,
  sessionFor,
  setCtrl,
  typeForEntry,
  userInput,
  viewHidden,
  viewResized,
  viewShown,
  withCtrl,
  type TermSession,
  type TermView,
} from "../../web/terminal/session";
import { BUSY_LINE, FORK_LINE, NO_SESSION_LINE, OPEN_AGAIN_BUSY_LINE } from "../../web/terminal/command";
import { ATTACH_AGAIN_LINE, ATTACH_PANE_LINE, BG_NOT_IN_CHAT } from "../../web/chat/background";
import { TRUST_NOT_IN_CHAT } from "../../web/chat/trust";

const CHAT = "k3m7q2x4abk3m7q2x4ab";
const dec = new TextDecoder();

type Sent = { text: Record<string, unknown> } | { bin: Uint8Array };

class FakeSocket implements ShellSocketLike {
  readyState = 0;
  binaryType = "blob";
  sent: Sent[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(data: string | ArrayBufferView) {
    if (this.readyState !== 1) throw new Error("not open");
    if (typeof data === "string") this.sent.push({ text: JSON.parse(data) as Record<string, unknown> });
    else this.sent.push({ bin: new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)) });
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(f: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
  bytes(s: string) {
    const b = new TextEncoder().encode(s);
    this.onmessage?.({ data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({});
  }
  texts() {
    return this.sent.flatMap((s) => ("text" in s ? [s.text] : []));
  }
  keys() {
    return this.sent.flatMap((s) => ("bin" in s ? [dec.decode(s.bin)] : [])).join("");
  }
}

/** A fake clock: timers run when `advance` passes their time, in order. */
class Clock {
  t = 0;
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

function deps(clock: Clock, sockets: FakeSocket[]) {
  return {
    url: "ws://127.0.0.1:7947/ws/shell",
    open: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    setTimer: clock.set,
    clearTimer: clock.clear,
    random: () => 0.5,
  };
}

type Ev = [string, ...unknown[]];
function linkSetup() {
  const clock = new Clock();
  const sockets: FakeSocket[] = [];
  const evs: Ev[] = [];
  const events: ShellLinkEvents = {
    output: (b) => evs.push(["output", dec.decode(b)]),
    opened: (f) => evs.push(["opened", f]),
    size: (c, r) => evs.push(["size", c, r]),
    reset: () => evs.push(["reset"]),
    exit: (c, s) => evs.push(["exit", c, s]),
    typed: (c) => evs.push(["typed", c]),
    status: (s: LinkStatus) => evs.push(["status", s]),
  };
  const link = new ShellLink(CHAT, deps(clock, sockets), events);
  return { clock, sockets, evs, link, ws: () => sockets[sockets.length - 1]! };
}

describe("keys as frames", () => {
  test("UTF-8, one frame up to 64 KiB, cut between characters above it", () => {
    expect(keyFrames("")).toEqual([]);
    expect(keyFrames("ls\r").map((f) => dec.decode(f))).toEqual(["ls\r"]);
    const big = "é".repeat(40_000); // 80,000 bytes
    const frames = keyFrames(big);
    expect(frames.length).toBe(2);
    for (const f of frames) expect(f.length).toBeLessThanOrEqual(SHELL_LIMITS.inputFrameBytes);
    expect(frames.map((f) => dec.decode(f, { stream: false })).join("")).toBe(big);
    // A 4-byte character never splits across frames.
    const emoji = "\u{1F600}".repeat(5);
    const small = keyFrames(emoji, 6);
    expect(small.every((f) => f.length % 4 === 0)).toBe(true);
    expect(small.map((f) => dec.decode(f)).join("")).toBe(emoji);
  });
});

describe("the link to /ws/shell", () => {
  test("the first frame is open with the chat and the pane's size; the ring and live output come as bytes", () => {
    const { link, ws, evs } = linkSetup();
    link.start(100, 30);
    expect(ws().binaryType).toBe("arraybuffer");
    ws().open();
    expect(ws().texts()).toEqual([{ t: "open", chat: CHAT, cols: 100, rows: 30 }]);
    expect(link.status).toBe("connecting");
    ws().receive({ t: "opened", chat: CHAT, cols: 100, rows: 30, fresh: false });
    ws().bytes("ring ");
    ws().bytes("live");
    expect(link.status).toBe("open");
    expect(evs.filter((e) => e[0] !== "status")).toEqual([["opened", { cols: 100, rows: 30, fresh: false }], ["output", "ring "], ["output", "live"]]);
    expect(link.shellSize).toEqual({ cols: 100, rows: 30 });
  });
  test("keys go as binary frames, only while a shell is attached; resize and type_resume as JSON", () => {
    const { link, ws } = linkSetup();
    link.start(80, 24);
    ws().open();
    expect(link.keys("early")).toBe(false); // no `opened` yet: dropped
    link.resize(90, 20); // not sent before `opened`; the next open would carry it
    link.typeResume(); // waits for `opened`
    expect(ws().texts().map((f) => f.t)).toEqual(["open"]);
    ws().receive({ t: "opened", chat: CHAT, cols: 80, rows: 24, fresh: true });
    expect(ws().texts().map((f) => f.t)).toEqual(["open", "type_resume"]);
    expect(link.keys("pwd\r")).toBe(true);
    link.resize(120, 40);
    link.typeResume();
    expect(ws().keys()).toBe("pwd\r");
    expect(ws().texts().slice(2)).toEqual([{ t: "resize", cols: 120, rows: 40 }, { t: "type_resume" }]);
  });
  test("the server's typed, size, reset and exit reach the session; after exit a new open starts a new shell", () => {
    const { link, ws, evs } = linkSetup();
    link.start(80, 24);
    ws().open();
    ws().receive({ t: "opened", chat: CHAT, cols: 80, rows: 24, fresh: true });
    ws().receive({ t: "typed", case: "fork" });
    ws().receive({ t: "typed", case: "rm -rf" }); // not a case: ignored
    ws().receive({ t: "typed", case: "busy" }); // the prompt was not free: nothing typed
    ws().receive({ t: "size", cols: 50, rows: 20 });
    ws().receive({ t: "reset" });
    ws().receive({ t: "exit", code: 0, signal: null });
    expect(link.status).toBe("ended");
    expect(link.keys("x")).toBe(false);
    expect(evs.filter((e) => e[0] !== "status" && e[0] !== "opened")).toEqual([["typed", "fork"], ["typed", "busy"], ["size", 50, 20], ["reset"], ["exit", 0, null]]);
    link.restart();
    expect(ws().texts().at(-1)).toEqual({ t: "open", chat: CHAT, cols: 80, rows: 24 });
    expect(link.status).toBe("connecting");
  });
  test("a refusal (archived, gone, no shell) says why and stops the dialling", () => {
    for (const code of ["archived", "not_found", "no_shell"] as const) {
      const { link, ws, sockets, clock } = linkSetup();
      link.start(80, 24);
      ws().open();
      ws().receive({ t: "error", code, message: `line for ${code}` });
      expect([code, link.status, link.refusal]).toEqual([code, "refused", { code, message: `line for ${code}` }]);
      expect(ws().closed).toBe(true);
      clock.advance(60_000);
      expect(sockets.length).toBe(1);
    }
  });
  test("a bad_request once attached changes nothing; before, it is a refusal", () => {
    const a = linkSetup();
    a.link.start(80, 24);
    a.ws().open();
    a.ws().receive({ t: "opened", chat: CHAT, cols: 80, rows: 24, fresh: true });
    a.ws().receive({ t: "error", code: "bad_request", message: "That request could not be read." });
    expect(a.link.status).toBe("open");
    const b = linkSetup();
    b.link.start(80, 24);
    b.ws().open();
    b.ws().receive({ t: "error", code: "bad_request", message: "That request could not be read." });
    expect(b.link.status).toBe("refused");
  });
  test("a dropped socket dials again with the app's backoff, and attaches again", () => {
    const { link, ws, sockets, clock } = linkSetup();
    link.start(80, 24);
    ws().open();
    ws().receive({ t: "opened", chat: CHAT, cols: 80, rows: 24, fresh: true });
    ws().drop();
    expect(link.status).toBe("down");
    expect(link.keys("lost")).toBe(false); // never kept to run later
    clock.advance(backoffMs(0, () => 0.5) - 1);
    expect(sockets.length).toBe(1);
    clock.advance(1);
    expect(sockets.length).toBe(2);
    ws().drop();
    clock.advance(backoffMs(1, () => 0.5));
    expect(sockets.length).toBe(3);
    ws().open();
    expect(ws().texts()).toEqual([{ t: "open", chat: CHAT, cols: 80, rows: 24 }]);
    ws().receive({ t: "opened", chat: CHAT, cols: 80, rows: 24, fresh: false });
    expect(link.status).toBe("open");
    expect(sockets.slice(0, 2).map((s) => s.sent.filter((x) => "bin" in x).length)).toEqual([0, 0]);
  });
  test("wake dials at once instead of waiting out the backoff; stop closes for good", () => {
    const { link, ws, sockets, clock } = linkSetup();
    link.start(80, 24);
    ws().open();
    ws().drop();
    link.wake();
    expect(sockets.length).toBe(2);
    link.stop();
    expect(ws().closed).toBe(true);
    expect(link.status).toBe("idle");
    clock.advance(60_000);
    expect(sockets.length).toBe(2);
  });
});

// ---- the session, with the fake socket and a fake view

/** The page's record of mutating frames (web/net/frames.ts). */
type Log = { t: string; at: number }[];
const g = globalThis as unknown as { window?: { __kitespanFrames?: Log } };
const hadWindow = "window" in g;
if (!hadWindow) g.window = {};
const log = (): Log => (g.window!.__kitespanFrames ??= []);

class FakeView implements TermView {
  cols = 80;
  rows = 24;
  out = "";
  clears = 0;
  resizes: [number, number][] = [];
  write(data: Uint8Array | string, done?: () => void) {
    this.out += typeof data === "string" ? data : dec.decode(data);
    done?.();
  }
  clear() {
    this.clears++;
    this.out = "";
  }
  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.resizes.push([cols, rows]);
  }
}

let clock: Clock;
let sockets: FakeSocket[];
beforeEach(() => {
  resetSessions();
  log().length = 0;
  clock = new Clock();
  sockets = [];
  configureLinks(() => deps(clock, sockets));
});
afterAll(() => {
  resetSessions();
  configureLinks(null);
  if (!hadWindow) delete g.window;
});
const ws = () => sockets[sockets.length - 1]!;

/** A pane that shows the session at 100 x 30 and is attached to a running shell (`fresh` false: the ring follows). */
function opened(fresh = true) {
  const s = sessionFor(CHAT);
  const view = new FakeView();
  viewShown(s, view, { cols: 100, rows: 30 });
  ws().open();
  ws().receive({ t: "opened", chat: CHAT, cols: 100, rows: 30, fresh });
  return { s, view };
}

describe("a link never acts: only the user's Enter is recorded", () => {
  test("opening the pane attaches to the chat's shell at the pane's size and records nothing", () => {
    const { view } = opened();
    expect(view.resizes).toEqual([[100, 30]]);
    expect(ws().texts()).toEqual([{ t: "open", chat: CHAT, cols: 100, rows: 30 }]);
    expect(log()).toEqual([]);
  });
  test("asking the server to type the resume command records nothing and types nothing from the page", () => {
    const { s } = opened();
    requestType(s, null);
    expect(ws().texts().at(-1)).toEqual({ t: "type_resume" });
    expect(ws().keys()).toBe(""); // the server types the command, never the page
    ws().receive({ t: "typed", case: "fork" });
    expect(log()).toEqual([]);
    expect(noteLines(s)).toEqual([FORK_LINE]);
    expect(s.said).toBe("The fork command is at the prompt. Press Enter to run it.");
  });
  test("a busy answer (the prompt was not free, nothing typed) says so until the next key, and drops the pending command", () => {
    const { s } = opened();
    requestType(s, "doctor");
    ws().receive({ t: "typed", case: "busy" });
    // One line, and the same words for a screen reader: nothing was typed, and Copy the command (in the pane's header)
    // is the way on. A terminal-only command's pick keeps its "Then type /<command>." line.
    expect(noteLines(s)).toEqual([BUSY_LINE, "Then type /doctor."]);
    expect(s.said).toBe("Nothing was typed: the prompt is in use. Use Copy the command, then type /doctor.");
    expect(s.then).toBeNull();
    expect(ws().keys()).toBe("");
    expect(log()).toEqual([]);
    // The next key goes to the shell, and the line goes with it: the prompt is the user's again.
    userInput(s, "x");
    expect(noteLines(s)).toEqual([]);
    expect(log()).toEqual([]);
    // A later answer (another page's request on the shared shell) does not bring this page's dropped command back.
    ws().receive({ t: "typed", case: "fork" });
    expect(noteLines(s)).toEqual([FORK_LINE]);
  });
  test("a busy answer with no terminal-only command: the one line, and the words say it", () => {
    const { s } = opened();
    requestType(s, null);
    ws().receive({ t: "typed", case: "busy" });
    expect(noteLines(s)).toEqual([BUSY_LINE]);
    expect(s.said).toBe(BUSY_LINE);
    expect(saidFor({ case: "busy", then: null })).toBe(BUSY_LINE);
  });
  test("a busy answer to Open in terminal (a background session's attach, R127's trust fallback) never points at Copy the command", () => {
    // Copy the command is this chat's own resume command, whose dialog offers to end this chat: the wrong way on here.
    for (const ask of [(s: TermSession) => requestType(s, null, null, "3f9a1c2e"), (s: TermSession) => requestType(s, null, "toolu_01Refused")]) {
      const { s } = opened();
      ask(s);
      ws().receive({ t: "typed", case: "busy" });
      expect(noteLines(s)).toEqual([OPEN_AGAIN_BUSY_LINE]);
      expect(s.said).toBe(OPEN_AGAIN_BUSY_LINE);
      expect(OPEN_AGAIN_BUSY_LINE).not.toContain("Copy the command");
    }
    expect(OPEN_AGAIN_BUSY_LINE).toBe("Nothing was typed: the prompt is in use. Clear it or leave its program (Ctrl+Z leaves Claude Code), then press Open in terminal again.");
    // The chat's own resume keeps its line, which Copy the command answers.
    const { s } = opened();
    requestType(s, null);
    ws().receive({ t: "typed", case: "busy" });
    expect(noteLines(s)).toEqual([BUSY_LINE]);
  });
  test("a none answer to Open in terminal says which thing the chat does not hold: the refused folder, or the background session", () => {
    for (const [ask, line] of [
      [(s: TermSession) => requestType(s, null, "toolu_01Refused"), TRUST_NOT_IN_CHAT],
      [(s: TermSession) => requestType(s, null, null, "3f9a1c2e"), BG_NOT_IN_CHAT],
      [(s: TermSession) => requestType(s, null), NO_SESSION_LINE],
    ] as const) {
      const { s } = opened();
      ask(s);
      ws().receive({ t: "typed", case: "none" });
      expect(noteLines(s)).toEqual([line]);
      expect(s.said).toBe(line);
    }
  });
  test("the attach line names what Enter does now: open a session that runs (its prompts are answered there), or open one that ended again", () => {
    const { s } = opened();
    requestType(s, null, null, "3f9a1c2e");
    ws().receive({ t: "typed", case: "attach" });
    expect(noteLines(s)).toEqual([ATTACH_PANE_LINE]);
    expect(s.said).toBe(ATTACH_PANE_LINE);
    const again = opened();
    requestType(again.s, null, null, "3f9a1c2e", true);
    ws().receive({ t: "typed", case: "attach" });
    expect(noteLines(again.s)).toEqual([ATTACH_AGAIN_LINE]);
    expect(again.s.said).toBe(ATTACH_AGAIN_LINE);
  });
  test("typing records nothing; Enter records one shell action; the note goes once the line ran", () => {
    const { s } = opened();
    requestType(s, null);
    ws().receive({ t: "typed", case: "plain" });
    userInput(s, "\x1b[D");
    userInput(s, "x");
    expect(log()).toEqual([]);
    userInput(s, "\r");
    expect(log()).toMatchObject([{ t: "shell" }]);
    expect(ws().keys()).toBe("\x1b[Dx\r");
    expect(s.note).toBeNull();
  });
  test("a pasted text with a line end is the user's Enter too; Ctrl+C drops the note and records nothing", () => {
    const { s } = opened();
    requestType(s, "doctor");
    ws().receive({ t: "typed", case: "fork" });
    expect(noteLines(s)).toEqual([FORK_LINE, "Then type /doctor."]);
    userInput(s, "\x03");
    expect(s.note).toBeNull();
    expect(log()).toEqual([]);
    userInput(s, "\x1b[200~echo a\recho b\x1b[201~");
    expect(log()).toMatchObject([{ t: "shell" }]);
  });
  test("keys while no shell is attached are dropped and not recorded", () => {
    const { s } = opened();
    ws().drop();
    userInput(s, "rm -rf build\r");
    expect(log()).toEqual([]);
    expect(sockets.flatMap((x) => x.sent.filter((f) => "bin" in f))).toEqual([]);
    expect(noteLines(s)).toEqual([RECONNECTING_LINE]);
  });
  test("the key bar's Ctrl turns the next key into its control key, once", () => {
    const { s } = opened();
    setCtrl(s, true);
    userInput(s, "c");
    expect(s.ctrl).toBe(false);
    expect(ws().keys()).toBe("\x03");
    expect(log()).toEqual([]);
    expect(withCtrl("a")).toBe("\x01");
    expect(withCtrl("[")).toBe("\x1b");
    expect(withCtrl("\x1b[D")).toBe("\x1b[1;5D");
    expect(withCtrl("\t")).toBe("\t");
    // The key bar's own / and - keys: the unit separator, as a terminal sends Ctrl+/ and Ctrl+- (undo in zsh and readline).
    expect(withCtrl("/")).toBe("\x1f");
    expect(withCtrl("-")).toBe("\x1f");
    expect(withCtrl("_")).toBe("\x1f");
    expect(withCtrl("?")).toBe("\x7f");
    expect(withCtrl(" ")).toBe("\x00");
    expect(withCtrl("|")).toBe("|");
  });
  test("a legacy mouse report goes as raw bytes, never as text and never as a Ctrl key", () => {
    const { s } = opened();
    setCtrl(s, true);
    userInput(s, "\x1b[M \xa0\xa0", true);
    const bin = ws().sent.flatMap((f) => ("bin" in f ? [[...f.bin]] : []));
    expect(bin).toEqual([[0x1b, 0x5b, 0x4d, 0x20, 0xa0, 0xa0]]);
    expect(s.ctrl).toBe(true);
  });
});

describe("the shell ends and starts again", () => {
  test("exit writes the ended line; Enter starts a new shell on the same socket and is recorded", () => {
    const { s, view } = opened();
    ws().receive({ t: "exit", code: 0, signal: null });
    expect(view.out).toContain(ENDED_LINE);
    expect(s.said).toBe(ENDED_LINE);
    userInput(s, "x");
    expect(ws().texts().length).toBe(1);
    userInput(s, "\r");
    expect(log()).toMatchObject([{ t: "shell" }]);
    expect(ws().texts().at(-1)).toEqual({ t: "open", chat: CHAT, cols: 100, rows: 30 });
    ws().receive({ t: "opened", chat: CHAT, cols: 100, rows: 30, fresh: true });
    expect(view.clears).toBe(0); // the old lines stay above the new prompt
    expect(s.status).toBe("open");
  });
  test("a refusal shows the server's line, and the pane says nothing else", () => {
    const s = sessionFor(CHAT);
    viewShown(s, new FakeView(), { cols: 100, rows: 30 });
    ws().open();
    ws().receive({ t: "error", code: "archived", message: "This chat is archived." });
    expect(noteLines(s)).toEqual(["This chat is archived."]);
    expect(s.said).toBe("This chat is archived.");
  });
});

describe("two pages on one shell: the page that types sets the size", () => {
  test("another page's size draws the shell's screen at that size; this page's next key takes it back first", () => {
    const { s, view } = opened();
    expect(answersQueries(s)).toBe(true);
    ws().receive({ t: "size", cols: 44, rows: 20 });
    expect([view.cols, view.rows]).toEqual([44, 20]);
    expect(answersQueries(s)).toBe(false);
    userInput(s, "l");
    const sent = ws().sent.slice(1);
    expect("text" in sent[0]! ? sent[0].text : null).toEqual({ t: "resize", cols: 100, rows: 30 });
    expect("bin" in sent[1]! ? dec.decode(sent[1].bin) : null).toBe("l");
    expect([view.cols, view.rows]).toEqual([100, 30]);
    expect(answersQueries(s)).toBe(true);
  });
  test("a change of the pane's own box resizes the shell", () => {
    const { s, view } = opened();
    viewResized(s, 60, 18);
    expect(ws().texts().at(-1)).toEqual({ t: "resize", cols: 60, rows: 18 });
    expect([view.cols, view.rows]).toEqual([60, 18]);
    viewResized(s, 60, 18);
    expect(ws().texts().filter((f) => f.t === "resize").length).toBe(1);
  });
  test("joining a running shell clears the view for its ring, and no query in the ring is answered", async () => {
    const { s, view } = opened(false);
    expect(view.clears).toBe(1);
    expect(answersQueries(s)).toBe(false);
    ws().bytes("old screen\x1b[c");
    expect(view.out).toBe("old screen\x1b[c");
    await Bun.sleep(200);
    expect(answersQueries(s)).toBe(true);
    // A page that falls behind: reset clears it, and the ring follows.
    ws().receive({ t: "reset" });
    expect(view.out).toBe("");
    expect(answersQueries(s)).toBe(false);
    await Bun.sleep(200);
    expect(answersQueries(s)).toBe(true);
  });
  test("closing and opening the pane again soon keeps the socket: no second open, no replay", () => {
    const { s, view } = opened();
    viewHidden(s);
    expect(s.releaseTimer).not.toBeNull();
    viewShown(s, view, { cols: 100, rows: 30 });
    expect(s.releaseTimer).toBeNull();
    expect(sockets.length).toBe(1);
    expect(ws().texts().filter((f) => f.t === "open").length).toBe(1);
    expect(existingSession(CHAT)).toBe(s);
  });
});

// ---- ?type=resume types once per history entry: a reload, a restored tab, Back and Forward are not clicks

describe("a link types the command once per history entry, never again on a reload", () => {
  // The tab's history as the browser keeps it: an entry's state survives a reload and a restored tab (a structured
  // clone of what the page last put there); the page's memory does not.
  const h = globalThis as unknown as { history?: unknown; location?: unknown };
  const had = { history: "history" in h, location: "location" in h };
  const saved = { history: h.history, location: h.location };
  let entry: { url: string; state: unknown };
  const BASE = "http://127.0.0.1:7947";
  const pathOf = (u: string) => {
    const x = new URL(u, BASE);
    return x.pathname + x.search;
  };
  function tab(url: string, state: unknown) {
    entry = { url, state };
    const at = () => new URL(entry.url, BASE);
    h.location = {
      get href() {
        return at().href;
      },
      get pathname() {
        return at().pathname;
      },
      get search() {
        return at().search;
      },
    };
    h.history = {
      get state() {
        return entry.state;
      },
      replaceState(st: unknown, _t: string, to?: string) {
        entry = { url: to ? pathOf(to) : entry.url, state: structuredClone(st) };
      },
      pushState() {
        throw new Error("the pane pushes no entry");
      },
    };
  }
  /** The page loads again: its memory (the sessions, the sockets) is gone; the entry and its state stay. */
  function reload() {
    resetSessions();
    entry = { url: entry.url, state: structuredClone(entry.state) };
  }
  const typeFrames = () => sockets.flatMap((x) => x.texts()).filter((f) => f.t === "type_resume").length;
  afterAll(() => {
    if (had.history) h.history = saved.history;
    else delete h.history;
    if (had.location) h.location = saved.location;
    else delete h.location;
  });

  test("the first time it asks the server to type; a remount of the pane asks nothing more", () => {
    tab(`/c/${CHAT}/shell?type=resume`, { from: `/c/${CHAT}`, back: [`/c/${CHAT}`] });
    const { s } = opened();
    expect(typeForEntry(s, null)).toBe(true);
    expect(typeFrames()).toBe(1);
    expect(typeForEntry(s, null)).toBe(false);
    expect(typeFrames()).toBe(1);
    // The router's own fields stay beside the mark.
    expect(entry.state).toMatchObject({ from: `/c/${CHAT}`, back: [`/c/${CHAT}`] });
    expect(entry.url).toBe(`/c/${CHAT}/shell?type=resume`);
  });
  test("a reload of the same entry types nothing, even after the user ran the command (a program may read the line)", () => {
    tab(`/c/${CHAT}/shell?type=resume`, { from: `/c/${CHAT}`, back: [`/c/${CHAT}`] });
    const first = opened();
    expect(typeForEntry(first.s, null)).toBe(true);
    userInput(first.s, "\r");
    reload();
    const again = opened(false);
    expect(again.s).not.toBe(first.s);
    expect(typeForEntry(again.s, null)).toBe(false);
    expect(ws().texts()).toEqual([{ t: "open", chat: CHAT, cols: 100, rows: 30 }]);
    // A second reload, and the tab restored later: still nothing.
    reload();
    expect(typeForEntry(opened(false).s, null)).toBe(false);
    expect(typeFrames()).toBe(1);
    expect(log()).toMatchObject([{ t: "shell" }]); // the user's own Enter, nothing else
  });
  test("an entry that an earlier page marked (a mark of the old form too) types nothing", () => {
    tab(`/c/${CHAT}/shell?type=resume`, { from: `/c/${CHAT}`, terminalTyped: "k2j4h8a1:1" });
    const { s } = opened();
    expect(typeForEntry(s, null)).toBe(false);
    expect(typeFrames()).toBe(0);
  });
  test("a reload shows the line about the typed command again (the same state, 5.5 item 2), and asks nothing", () => {
    tab(`/c/${CHAT}/shell?type=resume`, { from: `/c/${CHAT}`, thenType: "doctor" });
    const first = opened();
    typeForEntry(first.s, "doctor");
    ws().receive({ t: "typed", case: "fork" });
    expect(noteLines(first.s)).toEqual([FORK_LINE, "Then type /doctor."]);
    reload();
    const again = opened(false);
    expect(typeForEntry(again.s, "doctor")).toBe(false);
    expect(noteLines(again.s)).toEqual([FORK_LINE, "Then type /doctor."]);
    expect(again.s.said).toBe("The fork command is at the prompt. Press Enter to run it, then type /doctor.");
    expect(typeFrames()).toBe(1);
    // The user ran it: the line goes, and a later reload does not bring it back.
    userInput(again.s, "\r");
    expect(noteLines(again.s)).toEqual([]);
    reload();
    const third = opened(false);
    typeForEntry(third.s, "doctor");
    expect(noteLines(third.s)).toEqual([]);
  });
  test("a reload after a busy answer shows that nothing was typed, until the next key, and asks nothing", () => {
    tab(`/c/${CHAT}/shell?type=resume`, { from: `/c/${CHAT}` });
    const first = opened();
    typeForEntry(first.s, null);
    ws().receive({ t: "typed", case: "busy" });
    reload();
    const again = opened(false);
    expect(typeForEntry(again.s, null)).toBe(false);
    expect(noteLines(again.s)).toEqual([BUSY_LINE]);
    expect(typeFrames()).toBe(1);
    userInput(again.s, "l");
    expect(noteLines(again.s)).toEqual([]);
    reload();
    const third = opened(false);
    typeForEntry(third.s, null);
    expect(noteLines(third.s)).toEqual([]);
  });
  test("after a reload onto a new shell (the old one ended), the line does not come back: nothing is typed there", () => {
    tab(`/c/${CHAT}/shell?type=resume`, { from: `/c/${CHAT}` });
    const first = opened();
    typeForEntry(first.s, null);
    ws().receive({ t: "typed", case: "plain" });
    reload();
    const s = sessionFor(CHAT);
    viewShown(s, new FakeView(), { cols: 100, rows: 30 });
    typeForEntry(s, null); // the pane asks as it attaches, before the server's answer
    ws().open();
    ws().receive({ t: "opened", chat: CHAT, cols: 100, rows: 30, fresh: true });
    expect(noteLines(s)).toEqual([]);
    expect(typeFrames()).toBe(1);
  });
  test("a Back to an earlier entry in the same page load keeps what the page knows: a line the user ran stays gone", () => {
    tab(`/c/${CHAT}/shell?type=resume`, { from: `/c/${CHAT}` });
    const { s } = opened();
    typeForEntry(s, null);
    ws().receive({ t: "typed", case: "fork" });
    const a = structuredClone(entry);
    userInput(s, "\x03"); // Ctrl+C drops the line
    entry = a; // Back to the entry as it was before (its mark still says fork)
    expect(typeForEntry(s, null)).toBe(false);
    expect(noteLines(s)).toEqual([]);
  });
  test("a new pick gives the entry a fresh state (router.ts navigate), so that one types again", () => {
    tab(`/c/${CHAT}/shell?type=resume`, { from: `/c/${CHAT}` });
    const { s } = opened();
    expect(typeForEntry(s, null)).toBe(true);
    entry = { url: entry.url, state: { from: `/c/${CHAT}`, thenType: "doctor" } };
    expect(typeForEntry(s, "doctor")).toBe(true);
    expect(typeFrames()).toBe(2);
  });
});

describe("the line above the terminal", () => {
  test("one thing at a time: the refusal, Reconnecting..., or the typed command's note", () => {
    const note = { case: "fork" as const, then: "doctor" };
    expect(noteLines({ status: "refused", refusal: "The terminal could not start.", note })).toEqual(["The terminal could not start."]);
    expect(noteLines({ status: "down", refusal: null, note })).toEqual([RECONNECTING_LINE]);
    expect(noteLines({ status: "open", refusal: null, note })).toEqual([FORK_LINE, "Then type /doctor."]);
    expect(noteLines({ status: "open", refusal: null, note: { case: "plain", then: null } })).toEqual([]);
    expect(noteLines({ status: "open", refusal: null, note: { case: "plain", then: "statusline" } })).toEqual(["Then type /statusline."]);
    expect(noteLines({ status: "open", refusal: null, note: { case: "none", then: null } })).toEqual([NO_SESSION_LINE]);
    expect(noteLines({ status: "connecting", refusal: null, note: null })).toEqual([]);
  });
  test("what a screen reader hears", () => {
    expect(saidFor({ case: "plain", then: null })).toBe("The resume command is at the prompt. Press Enter to run it.");
    expect(saidFor({ case: "fork", then: "doctor" })).toBe("The fork command is at the prompt. Press Enter to run it, then type /doctor.");
    expect(saidFor({ case: "none", then: null })).toBe(NO_SESSION_LINE);
  });
  test("a chat with no message: the server types nothing, and the pane says the no-session line", () => {
    const { s } = opened();
    requestType(s, "doctor");
    ws().receive({ t: "typed", case: "none" });
    expect(noteLines(s)).toEqual([NO_SESSION_LINE]);
    expect(log()).toEqual([]);
  });
});

describe("a paste loses its controls before the terminal reads it", () => {
  const JACK = "echo harmless\x1b[201~\ngit status\n";
  test("never an ESC, so never its own paste end marker; tab and line ends stay", () => {
    expect(cleanPaste(JACK)).toBe("echo harmless[201~\ngit status\n");
    expect(cleanPaste("a\tb\r\nc\x00\x07\x08\x0b\x0c\x1b\x7f\u0085\u009bd")).toBe("a\tb\r\ncd");
  });
});
