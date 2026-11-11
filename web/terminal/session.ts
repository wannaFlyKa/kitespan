// The Terminal pane's session per chat, in page memory (D38, D52): the chat's shell over /ws/shell (link.ts), the
// xterm view (xterm.ts, loaded when a pane first opens) and what the pane says above the terminal. Closing the pane
// keeps the session, its view and its socket for a while (GRACE_MS), so opening it again shows the same screen at
// once; after that the socket closes, and the next open gets the screen back from the shell's replay ring.
//
// The rule of every link (BUILD-BRIEF section 3): opening the pane, attaching to the shell and asking the server to
// type the resume command (type_resume) record nothing. The user's Enter in the pane is the action: it is recorded as
// "shell" in window.__kitespanFrames (net/frames.ts) when it goes out.
//
// Two pages on one chat share one shell. The page that opened, resized or typed last sets the shell's size (the
// server tells the others with `size`, and each draws the shell's screen at the shell's size until its own user
// types). Only that page answers the terminal queries in the output (the device attributes, the cursor position), and
// no page answers the ones in a replayed ring, so a query is answered once and never again on a reattach.
import { recordFrame } from "../net/frames";
import { BUSY_LINE, FORK_LINE, NO_SESSION_LINE, OPEN_AGAIN_BUSY_LINE, thenTypeLine } from "./command";
import { TRUST_NOT_IN_CHAT, TRUST_PANE_LINE } from "../chat/trust";
import { ATTACH_AGAIN_LINE, ATTACH_PANE_LINE, BG_NOT_IN_CHAT } from "../chat/background";
import { browserLinkDeps, ShellLink, type LinkStatus, type ShellLinkDeps, type TypedCase } from "./link";

/** What the session needs of the xterm view (xterm.ts makes it). */
export interface TermView {
  readonly cols: number;
  readonly rows: number;
  write(data: Uint8Array | string, done?: () => void): void;
  /** Clear the screen, the scrollback and the modes: the ring that follows draws the screen again. */
  clear(): void;
  resize(cols: number, rows: number): void;
}

export interface Size {
  cols: number;
  rows: number;
}

/**
 * The line the pane shows above the terminal after the server answered type_resume; `busy` (nothing typed) holds only
 * until the next key.
 */
export interface TermNote {
  case: TypedCase;
  /** The terminal-only command whose / menu pick opened the pane (D47): "Then type /<name>." */
  then: string | null;
  /**
   * What the answer was for, when not the chat's own resume: a type_attach (R131: its `none` says the chat did not start
   * that session) or a type_trust (R127). Either one's `busy` has a line of its own: Copy the command is the chat's own
   * command, the wrong way on there.
   */
  of?: "attach" | "trust";
  /** R131: the `attach` case for a session that had ended (completed, failed, stopped) when it was asked: "open it again". */
  ended?: true;
}

export interface TermSession {
  chatId: string;
  link: ShellLink | null;
  view: TermView | null;
  /** Panes showing the view now (0 or 1); the socket closes GRACE_MS after the last one closed. */
  views: number;
  releaseTimer: ReturnType<typeof setTimeout> | null;
  /** The terminal-only command of the type_resume that waits for its answer. */
  then: string | null;
  /** The type request that waits for its answer, when not the chat's own resume: type_attach (R131) or type_trust (R127). */
  asked?: { of: "attach" | "trust"; ended: boolean } | null;
  note: TermNote | null;
  /** The mark (typeForEntry) of the history entry that asked for the note's command: it keeps the note's case. */
  noteEntry: string | null;
  status: LinkStatus;
  /** The server's line when it will not open a shell for this chat (archived, gone, could not start). */
  refusal: string | null;
  /** What a screen reader hears (the pane's status region). */
  said: string;
  /** The size that fits this page's pane, once the view measured it. */
  fit: Size | null;
  /** True while this page's size is the shell's: it opened, resized or typed last. */
  owner: boolean;
  /** True while the replay ring is being drawn. */
  replaying: boolean;
  replayTimers: ReturnType<typeof setTimeout>[];
  /** Shell output was drawn since the view was last cleared. */
  printed: boolean;
  /** The last thing drawn is the ended line (the shell exited). */
  afterExit: boolean;
  /** The key bar's Ctrl: on until the next key. */
  ctrl: boolean;
  onCtrl: ((on: boolean) => void) | null;
  listeners: Set<() => void>;
  version: number;
}

/** How long a closed pane keeps its socket, so a quick close and open (Ctrl+backtick twice) redraws nothing. */
export const GRACE_MS = 30_000;
/** The ring comes as one burst after `opened` or `reset`: it is over after this much quiet, or at REPLAY_MAX_MS. */
const REPLAY_QUIET_MS = 120;
const REPLAY_MAX_MS = 1_500;

/** Written into the terminal when the shell exits; Enter starts a new one. */
export const ENDED_LINE = "The shell ended. Press Enter for a new one.";
/** The app's own word while a socket dials again (the sidebar foot says the same). */
export const RECONNECTING_LINE = "Reconnecting...";

const sessions = new Map<string, TermSession>();
let makeDeps: (chatId: string) => ShellLinkDeps = () => browserLinkDeps();

/** Tests: the link's socket, timers and URL (null: the browser's). */
export function configureLinks(make: ((chatId: string) => ShellLinkDeps) | null): void {
  makeDeps = make ?? (() => browserLinkDeps());
}

function notify(s: TermSession) {
  s.version++;
  for (const fn of s.listeners) fn();
}

/** Re-render on a change of the session's status, note or line (useSyncExternalStore). */
export function subscribe(s: TermSession, fn: () => void): () => void {
  s.listeners.add(fn);
  return () => s.listeners.delete(fn);
}

/** The chat's session, made on first use. */
export function sessionFor(chatId: string): TermSession {
  let s = sessions.get(chatId);
  if (!s) {
    s = {
      chatId,
      link: null,
      view: null,
      views: 0,
      releaseTimer: null,
      then: null,
      note: null,
      noteEntry: null,
      status: "idle",
      refusal: null,
      said: "",
      fit: null,
      owner: false,
      replaying: false,
      replayTimers: [],
      printed: false,
      afterExit: false,
      ctrl: false,
      onCtrl: null,
      listeners: new Set(),
      version: 0,
    };
    sessions.set(chatId, s);
  }
  return s;
}

/** The session of a chat if it has one (the pane layer's Esc in Shell.tsx, a test). */
export function existingSession(chatId: string): TermSession | undefined {
  return sessions.get(chatId);
}

/** Close every link and forget every session and entry mark, as a new page load would (tests). */
export function resetSessions() {
  for (const s of sessions.values()) {
    if (s.releaseTimer) clearTimeout(s.releaseTimer);
    for (const t of s.replayTimers) clearTimeout(t);
    s.link?.stop();
  }
  sessions.clear();
  known.clear();
}

// ---- the view comes and goes

/** A pane shows the session's view, which fits `fit` there: attach to the chat's shell (once). */
export function viewShown(s: TermSession, view: TermView, fit: Size | null) {
  s.view = view;
  s.views++;
  if (s.releaseTimer) clearTimeout(s.releaseTimer);
  s.releaseTimer = null;
  if (fit) s.fit = fit;
  const size = s.fit ?? { cols: view.cols, rows: view.rows };
  if (s.link && s.link.status !== "idle" && s.link.status !== "refused") {
    claim(s);
    return;
  }
  s.link ??= new ShellLink(s.chatId, makeDeps(s.chatId), events(s));
  if (view.cols !== size.cols || view.rows !== size.rows) view.resize(size.cols, size.rows);
  s.refusal = null;
  s.link.start(size.cols, size.rows);
}

/** The pane closed (or moved: a new pane shows the view in the same commit). */
export function viewHidden(s: TermSession) {
  s.views = Math.max(0, s.views - 1);
  if (s.views > 0 || s.releaseTimer) return;
  s.releaseTimer = setTimeout(() => {
    s.releaseTimer = null;
    if (s.views === 0) s.link?.stop();
  }, GRACE_MS);
}

/** The pane's box changed size: this page's size is the shell's now. */
export function viewResized(s: TermSession, cols: number, rows: number) {
  s.fit = { cols, rows };
  claim(s);
}

/** The pane came back into view (the page was hidden): a dropped socket dials at once. */
export function wake(s: TermSession) {
  s.link?.wake();
}

/** Draw the shell's screen at this page's size, and tell the shell when that is not its size. */
function claim(s: TermSession) {
  const v = s.view;
  const fit = s.fit;
  if (!v || !fit) return;
  if (v.cols !== fit.cols || v.rows !== fit.rows) v.resize(fit.cols, fit.rows);
  const link = s.link;
  if (!link || link.status !== "open") return;
  const shell = link.shellSize;
  if (!shell || shell.cols !== fit.cols || shell.rows !== fit.rows) {
    link.resize(fit.cols, fit.rows);
    link.shellSize = { ...fit };
  }
  s.owner = true;
}

/** True when the view may answer a terminal query in the output: not in a replayed ring, and this page sets the size. */
export function answersQueries(s: TermSession): boolean {
  return !s.replaying && s.owner;
}

/** The ring is drawn: once the view has parsed everything written so far, queries are answered again. */
function endReplay(s: TermSession) {
  for (const t of s.replayTimers) clearTimeout(t);
  s.replayTimers = [];
  if (s.view) s.view.write("", () => (s.replaying = false));
  else s.replaying = false;
}

/** The ring follows (after `opened` on a running shell, or `reset`): it is over after a short quiet, or at the cap. */
function beginReplay(s: TermSession) {
  for (const t of s.replayTimers) clearTimeout(t);
  s.replaying = true;
  s.replayTimers = [setTimeout(() => endReplay(s), REPLAY_QUIET_MS), setTimeout(() => endReplay(s), REPLAY_MAX_MS)];
}

/** More of the ring came: the quiet starts again (the cap stays). */
function quietAgain(s: TermSession) {
  const [quiet, cap] = s.replayTimers;
  if (quiet) clearTimeout(quiet);
  s.replayTimers = [setTimeout(() => endReplay(s), REPLAY_QUIET_MS), ...(cap ? [cap] : [])];
}

/** What a screen reader hears after the server typed (or could not type) the command. */
export function saidFor(note: TermNote): string {
  if (note.case === "none") return note.of === "attach" ? BG_NOT_IN_CHAT : note.of === "trust" ? TRUST_NOT_IN_CHAT : NO_SESSION_LINE;
  if (note.case === "trust") return TRUST_PANE_LINE;
  // R131: Claude Code's own UI asks the session's prompts once the user runs the typed command (or opens it again).
  if (note.case === "attach") return note.ended ? ATTACH_AGAIN_LINE : ATTACH_PANE_LINE;
  if (note.case === "busy" && note.of) return OPEN_AGAIN_BUSY_LINE;
  const then = note.then ? `, then type /${note.then}` : "";
  if (note.case === "busy") return note.then ? `${BUSY_LINE.slice(0, -1)}${then}.` : BUSY_LINE;
  return `The ${note.case === "fork" ? "fork" : "resume"} command is at the prompt. Press Enter to run it${then}.`;
}

/** The lines above the terminal: one thing at a time, and only while it holds (principle 0). */
export function noteLines(s: Pick<TermSession, "status" | "refusal" | "note">): string[] {
  if (s.status === "refused") return s.refusal ? [s.refusal] : [];
  if (s.status === "down") return [RECONNECTING_LINE];
  const n = s.note;
  if (!n) return [];
  if (n.case === "none") return [n.of === "attach" ? BG_NOT_IN_CHAT : n.of === "trust" ? TRUST_NOT_IN_CHAT : NO_SESSION_LINE];
  // R127: Claude Code's own trust question asks once the user runs the typed command.
  if (n.case === "trust") return [TRUST_PANE_LINE];
  if (n.case === "attach") return [n.ended ? ATTACH_AGAIN_LINE : ATTACH_PANE_LINE];
  // Open in terminal's own commands: free the prompt and press it again (never Copy the command, the chat's own).
  if (n.case === "busy" && n.of) return [OPEN_AGAIN_BUSY_LINE];
  const head = n.case === "fork" ? [FORK_LINE] : n.case === "busy" ? [BUSY_LINE] : [];
  return [...head, ...(n.then ? [thenTypeLine(n.then)] : [])];
}

function events(s: TermSession) {
  return {
    output(bytes: Uint8Array) {
      s.printed = true;
      s.afterExit = false;
      if (s.replaying) quietAgain(s);
      s.view?.write(bytes);
    },
    opened(f: { cols: number; rows: number; fresh: boolean }) {
      const v = s.view;
      if (!f.fresh) {
        // A running shell: its ring follows and draws the screen as it is.
        v?.clear();
        s.printed = false;
        beginReplay(s);
      } else if (s.printed && !s.afterExit) {
        // A new shell under an old screen (the server restarted): its prompt starts on a line of its own.
        v?.write("\x1b[0m\r\n");
      }
      if (f.fresh && s.note) {
        // A new shell has nothing typed at its prompt: a line kept from before (a reload, a reconnect) goes.
        dropNote(s);
        notify(s);
      }
      s.owner = true;
      if (v && (v.cols !== f.cols || v.rows !== f.rows)) v.resize(f.cols, f.rows);
      claim(s);
    },
    size(cols: number, rows: number) {
      // Another page set the shell's size: draw its screen at that size until this page's user types.
      s.owner = false;
      s.view?.resize(cols, rows);
    },
    reset() {
      s.view?.clear();
      s.printed = false;
      beginReplay(s);
    },
    exit() {
      s.view?.write(`\x1b[0m\r\n\x1b[90m${ENDED_LINE}\x1b[0m\r\n`);
      s.afterExit = true;
      dropNote(s);
      s.said = ENDED_LINE;
      notify(s);
    },
    typed(c: TypedCase) {
      // Nothing was typed when the prompt was not free (`busy`): the line says so until the next key, so the pane never
      // looks as if the link did nothing; the pending command is dropped either way.
      s.note = { case: c, then: c === "none" ? null : s.then };
      // R131 and R127: the answer to Open in terminal's own command. Either one's `none` (the chat does not hold that
      // session or that refused folder) and `busy` have lines of their own; `attach` says whether the session had ended.
      const asked = s.asked;
      if (asked && (c === "busy" || c === "none" || (asked.of === "attach" && c === "attach"))) s.note.of = asked.of;
      if (asked?.of === "attach" && asked.ended && c === "attach") s.note.ended = true;
      s.then = null;
      s.asked = null;
      s.said = saidFor(s.note);
      // The entry that asked keeps the case, so a reload of it shows this line again without asking again.
      markCase(s.noteEntry, c, s.note.of, s.note.ended);
      notify(s);
    },
    status(st: LinkStatus) {
      s.status = st;
      s.refusal = st === "refused" ? (s.link?.refusal?.message ?? null) : null;
      if (st === "refused") s.said = s.refusal ?? "";
      notify(s);
    },
  };
}

// ---- keys

/**
 * The key bar's sticky Ctrl on the next key, as common terminals send it: a letter or one of @[\]^_ becomes its
 * control character, an arrow its Ctrl form, space NUL, ? DEL, and / and - the unit separator (byte 31, which zsh and
 * readline read as undo).
 */
export function withCtrl(data: string): string {
  const arrow = /^\x1b\[([A-D])$/.exec(data);
  if (arrow) return `\x1b[1;5${arrow[1]}`;
  if (data.length !== 1) return data;
  const c = data.toUpperCase().charCodeAt(0);
  if (c >= 64 && c <= 95) return String.fromCharCode(c - 64);
  if (data === " ") return "\u0000";
  if (data === "?") return "\u007f";
  if (data === "/" || data === "-") return "\u001f";
  return data;
}

/** The key bar's Ctrl on or off. */
export function setCtrl(s: TermSession, on: boolean) {
  if (s.ctrl === on) return;
  s.ctrl = on;
  s.onCtrl?.(on);
}

/** True for keys that end the line at the prompt: Enter (carriage return, or Ctrl+J). */
const ENTER = /[\r\n]/;

/**
 * Keys and pastes from the user (xterm's input, the key bar, Esc from the layer over the chat): they go to the shell
 * while one is attached, and are dropped while none is. Only Enter runs a line, so only a key with Enter in it is
 * recorded (as "shell"). After the shell exited, Enter starts a new one.
 */
export function userInput(s: TermSession, data: string, binary = false) {
  if (binary) {
    if (s.link?.status === "open") s.link.keys(data, true);
    return;
  }
  if (s.ctrl) {
    setCtrl(s, false);
    data = withCtrl(data);
  }
  const link = s.link;
  if (!link || !data) return;
  if (link.status === "ended") {
    if (!ENTER.test(data)) return;
    recordFrame("shell");
    link.restart();
    return;
  }
  if (link.status !== "open") return;
  claim(s);
  const enter = ENTER.test(data);
  if (link.keys(data) && enter) recordFrame("shell");
  // The typed command ran, or Ctrl+C dropped it: its line is no longer about the prompt. The line that nothing was
  // typed goes with any key: the prompt is the user's again.
  if (s.note && (enter || data.includes("\x03") || s.note.case === "busy")) {
    dropNote(s);
    notify(s);
  }
}

/**
 * /c/<chat>/shell?type=resume (DESIGN.md 6.10, D38): the server types the chat's own command at the prompt (the fork
 * command while the chat's Claude Code is still open, the plain one while it sleeps), never with Enter; its `typed`
 * answer brings the pane's line. `then` is the terminal-only command whose / menu pick opened the pane (D47). It runs
 * nothing and records nothing.
 */
export function requestType(s: TermSession, then: string | null, trust: string | null = null, attach: string | null = null, ended = false) {
  s.then = trust || attach ? null : then;
  s.asked = attach ? { of: "attach", ended } : trust ? { of: "trust", ended: false } : null;
  if (attach) s.link?.typeAttach(attach);
  else if (trust) s.link?.typeTrust(trust);
  else s.link?.typeResume();
}

/**
 * The mark that this history entry's ?type=resume asked already, in the entry's own state beside the router's fields:
 * `{ id, case }`, with the case once the server said what it typed. The browser keeps an entry's state across a
 * reload, a restored tab, Back and Forward, so the mark outlives the page's memory: a reload is not a click, and by
 * then the chat's shell (on the server, shared by every page) may run a program that would read the typed line as its
 * own input. The case lets a reload show the line about the typed command again (5.5 item 2: the same state), while
 * it holds. A new pick at the same URL gives the entry a fresh state (router.ts navigate), so that one types again. A
 * mark of any other form (an earlier page's) counts as asked, with no line to show.
 */
const MARK_KEY = "terminalTyped";
const CASES: ReadonlySet<string> = new Set<TermNote["case"]>(["plain", "fork", "none", "busy", "trust", "attach"]);
/** The marks this page load made or read: for these the page's memory is the truth, not the entry's case. */
const known = new Set<string>();
let marks = 0;

interface EntryMark {
  id: string | null;
  case: TermNote["case"] | null;
  /** The case answered a type_attach (R131) or a type_trust (R127), whose lines are their own. */
  of?: "attach" | "trust";
  /** R131: the attach was for a session that had ended. */
  ended?: true;
}

function entryFields(): Record<string, unknown> {
  const st = typeof history === "undefined" ? null : history.state;
  return st && typeof st === "object" ? (st as Record<string, unknown>) : {};
}

/** The current entry's mark, or null when its ?type=resume has not asked yet. */
function readMark(): EntryMark | null {
  const m = entryFields()[MARK_KEY];
  if (m == null) return null;
  const o = typeof m === "object" ? (m as Record<string, unknown>) : {};
  return {
    id: typeof o.id === "string" ? o.id : null,
    case: typeof o.case === "string" && CASES.has(o.case) ? (o.case as TermNote["case"]) : null,
    ...(o.of === "attach" || o.of === "trust" ? { of: o.of } : {}),
    ...(o.ended === true ? { ended: true as const } : {}),
  };
}

/** Put the case (or no case) into the current entry's mark, when that entry is the one with mark `id`. */
function markCase(id: string | null, c: TermNote["case"] | null, of?: "attach" | "trust", ended?: true) {
  if (!id || readMark()?.id !== id) return;
  history.replaceState({ ...entryFields(), [MARK_KEY]: c ? { id, case: c, ...(of ? { of } : {}), ...(ended ? { ended } : {}) } : { id } }, "", location.href);
}

/** The line about the typed command no longer holds (it ran, Ctrl+C dropped it, the shell is new or ended). */
function dropNote(s: TermSession) {
  if (!s.note) return;
  s.note = null;
  markCase(s.noteEntry, null);
}

/**
 * ?type=resume on the current history entry: ask the server to type the command (requestType) once for the entry,
 * never again on a remount of the pane, a Back or Forward to it, a reload or a restored tab. After a reload the line
 * about the typed command comes back from the entry's mark, and nothing is asked. True when it asked.
 */
export function typeForEntry(s: TermSession, then: string | null, trust: string | null = null, attach: string | null = null, ended = false): boolean {
  const mark = readMark();
  if (mark) {
    if (mark.id && !known.has(mark.id)) {
      known.add(mark.id);
      if (mark.case && !s.note) {
        s.note = { case: mark.case, then: mark.case === "none" ? null : then, ...(mark.of ? { of: mark.of } : {}), ...(mark.ended ? { ended: true as const } : {}) };
        s.noteEntry = mark.id;
        s.said = saidFor(s.note);
        notify(s);
      }
    }
    return false;
  }
  const id = `${Math.random().toString(36).slice(2, 10)}:${++marks}`;
  known.add(id);
  history.replaceState({ ...entryFields(), [MARK_KEY]: { id } }, "", location.href);
  s.noteEntry = id;
  requestType(s, then, trust, attach, ended);
  return true;
}
