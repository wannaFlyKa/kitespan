// The Terminal pane's shells and their socket, /ws/shell (D38, D52; DESIGN.md 6.10, 4.9).
//
// One login shell per chat, owned by the chat: it starts in the chat's folder, as the user, from the clean environment
// (env.ts), when the first page opens the pane, and every page that opens the pane attaches to the same shell. The
// shell keeps the last 256 KiB of its output in a ring that a page gets when it attaches. A socket that falls more
// than 1 MiB behind gets no more live output; once its buffer drains it gets `reset` and the ring again.
//
// Frames (shared/protocol.ts): the first text frame is `open`; the server answers `opened`, then the ring as binary
// frames, then live output as binary frames. Keys come in as binary frames and are written once each. `resize`,
// `type_resume`, (R127) `type_trust` and (R131) `type_attach` are JSON text frames. `type_resume` types the command
// that command.ts computes from the chat's own session id and state, `type_trust` `cd <folder> && claude` for the
// folder that the server matched in the named tool row's refusal, and `type_attach` `claude attach <id>` for a
// background session that a launch row of the chat printed (the server's book); never anything from the page, and
// never a line end, and only at a free prompt: the shell's
// line editor waits, the shell itself holds the terminal (no program it started runs), and no key has come since
// that prompt began, nor while the command before it ran (keys typed ahead are on the line). Otherwise nothing is
// typed and the answer is `busy`. A request waits only for the shell's first prompt, and any key drops it, so a link
// opened on one page never types into a line that someone types on another page.
//
// Two ways to mount it. A router that upgrades the socket itself, after its own Origin check (guard 2), gives
// `handlers` a socket whose data has a `state` slot (the HTTP layer's `{route, state}`). Or `upgrade()` runs the
// Origin check and the upgrade, and the four `websocket` handlers return false for a socket that it did not make.
//
// A restart ends every shell (DESIGN.md 4.10), and with it the program that runs in a pane: `programs()` names the
// chats whose shell has a program in the foreground, or whose foreground the system does not report, for the restart
// dialog's list and the clause under Restart now (build checklist S15, L15).

import {
  ERROR_MESSAGES,
  SHELL_LIMITS,
  WIRE,
  parseShellControl,
  type ShellClientFrame,
  type ShellErrorCode,
  type ShellServerFrame,
  type ShellTypedCase,
  type ShellTypedFrame,
} from "../../shared/protocol";
import type { EnvVar } from "../agents/types";
import type { Logger } from "../log";
import { START_ENV } from "../start-env-copy";
import { attachCommand, isTypeable, resumeCommand, trustCommand, type ShellChat } from "./command";
import { LineEditorWatch, QUIET_MS } from "./editor";
import { shellEnv } from "./env";
import { defaultShell, ShellPty, type PaneShell, type ShellExit, type ShellPtyOptions } from "./pty";
import { OutputRing } from "./ring";

/** What the shell service asks of the registry. */
export interface ShellHost {
  /** The chat, or null when there is no such chat (deleted, or never made). */
  chat(id: string): ShellChat | null;
  /**
   * D60 (L38, L39): the variables of the chat's environment, which its shell gets as its Claude Code does; null when
   * they could not be read, and then no shell starts. Absent: none.
   */
  vars?(id: string): readonly EnvVar[] | null;
  /**
   * R127: the folder that a refused tool row of the chat names (the server's own match), for `type_trust`; null when
   * the chat has no such row. Absent: `type_trust` types nothing.
   */
  trustPath?(id: string, toolUse: string): string | null;
  /**
   * R131: whether a launch row of the chat printed this background session's short id (the server's book), for
   * `type_attach`. Absent: `type_attach` types nothing.
   */
  backgroundId?(id: string, bg: string): boolean;
}

/**
 * The answer to `type_resume` and `type_trust` (shared/protocol.ts SHELL_TYPED_CASES): `plain` or `fork`, the resume
 * command that is now at the prompt; `trust` (R127), `cd <folder> && claude` is; `none`, nothing to type (no message
 * yet, or no refused row of that tool use); `busy`, nothing typed because the prompt is not free (a program holds the
 * terminal, a line is being typed, or a key came while the request waited).
 */
export type TypedCase = ShellTypedCase;
export type { ShellTypedFrame };

export type ShellOutFrame = ShellServerFrame | ShellTypedFrame;

/**
 * What one page's request asks to type: the chat's resume command, (R127) the trust command of one refused row, or
 * (R131) `claude attach <id>` for one background session of the chat.
 */
type TypeWant = { kind: "resume" } | { kind: "trust"; toolUse: string } | { kind: "attach"; id: string };

export const SHELL_ERROR_MESSAGES: Record<ShellErrorCode, string> = {
  bad_request: ERROR_MESSAGES.bad_request,
  not_found: ERROR_MESSAGES.not_found,
  archived: ERROR_MESSAGES.archived,
  no_shell: "The terminal could not start.",
};

/** The socket as the handlers use it; Bun's ServerWebSocket fits. */
export interface ShellSocket {
  readonly data: unknown;
  sendText(data: string, compress?: boolean): number;
  sendBinary(data: Uint8Array, compress?: boolean): number;
  getBufferedAmount(): number;
  close(code?: number, reason?: string): void;
}

/** What `upgrade()` needs of Bun's server. */
export interface ShellUpgradeServer {
  upgrade(req: Request, options: { data: ShellWsData }): boolean;
}

/** The data of a socket that `upgrade()` made; a server that also has other sockets makes a union with it. */
export interface ShellWsData {
  readonly kind: "shell";
  readonly conn: ShellConn;
}

/**
 * A socket that a router upgraded itself, with a `state` slot in its data that this service fills in `open` (the
 * HTTP layer's per-path socket data, `{route, state}`); its router has already run the Origin check.
 */
export interface ShellSlotSocket extends Omit<ShellSocket, "data"> {
  readonly data: { state: unknown };
}

/** The handlers of the slot form; they fit a router's per-path socket handlers. */
export interface ShellSlotHandlers {
  open(ws: ShellSlotSocket): void;
  message(ws: ShellSlotSocket, message: string | ArrayBuffer | ArrayBufferView): void;
  drain(ws: ShellSlotSocket): void;
  close(ws: ShellSlotSocket, code?: number, reason?: string): void;
}

export interface ShellServiceOptions {
  host: ShellHost;
  /**
   * Guard 2 for `upgrade()`: true only for an allowed origin, compared exactly; a missing Origin is null. Without it
   * `upgrade()` refuses every request (the slot form's router runs its own check).
   */
  allowOrigin?(origin: string | null): boolean;
  log?: Pick<Logger, "log">;
  /** The login shell (default: defaultShell of the environment). */
  shell?: string;
  /**
   * The environment that shellEnv cleans, copied when the service is made (default: the start environment,
   * server/start-env-copy.ts, never the server's process.env, which holds the SDK's own names).
   */
  env?: Readonly<Record<string, string | undefined>>;
  dropNames?: readonly string[];
  dropPrefixes?: readonly string[];
  /** How long a shell with no socket lives on (default 30 minutes). */
  detachedKeepMs?: number;
  /** Each step of the close path (default 1,000 ms). */
  closeStepMs?: number;
  /** How long `type_resume` waits for the shell's first prompt (default 10 s); then nothing is typed (`busy`). */
  typeWaitMs?: number;
  /** How long a new socket may wait before its `open` (default 10 s). */
  openWaitMs?: number;
  /** Starts a pane's shell (tests: a double); default ShellPty. */
  pty?: (o: ShellPtyOptions) => PaneShell;
}

export interface ShellService {
  /** For a request to WIRE.shellPath: 403 for an origin that is not allowed, else the upgrade (undefined). */
  upgrade(req: Request, server: ShellUpgradeServer): Response | undefined;
  /** The handlers for sockets that `upgrade()` made; each returns false for any other socket. */
  readonly websocket: {
    open(ws: ShellSocket): boolean;
    message(ws: ShellSocket, message: string | ArrayBuffer | ArrayBufferView): boolean;
    drain(ws: ShellSocket): boolean;
    close(ws: ShellSocket, code?: number, reason?: string): boolean;
  };
  /** The same handlers for sockets that a router upgraded on WIRE.shellPath, after its own Origin check. */
  readonly handlers: ShellSlotHandlers;
  /** End the chat's shell (archive, delete): the close path; the pages get `exit`. */
  end(chat: string): Promise<void>;
  /** End every shell (shutdown). */
  closeAll(): Promise<void>;
  has(chat: string): boolean;
  /**
   * S15: each chat whose live shell does not hold its own terminal: a program runs in the foreground (`known`), or the
   * system did not say (`known` false, which the restart counts as a program).
   */
  programs(): { chat: string; known: boolean }[];
  readonly count: number;
}

const RING_FRAME_BYTES = 64 * 1024;
/** A lagging socket gets the ring again once its buffer is under this. */
const LAG_LOW_BYTES = 256 * 1024;
const LAG_POLL_MS = 250;
/** Ctrl+U: clears a command that this service typed and that is still alone at the prompt. */
const CLEAR_LINE = "\x15";
/**
 * The terminal's own answers to a program's queries, which the page's terminal sends on the keys channel: a cursor
 * position or status report, a device attributes or mode report, a keyboard flags report, a focus change, an OSC or a
 * DCS answer. A frame of nothing else is not the user typing.
 */
const REPORTS =
  /^(?:\x1b\[\??\d+;\d+R|\x1b\[\d*n|\x1b\[[IO]|\x1b\[[?>][\d;]*c|\x1b\[\??[\d;]*\$y|\x1b\[\?\d*u|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\)+$/;
/** Keys that leave no text in a line typed ahead: Enter, Ctrl+C, Ctrl+D, Ctrl+Z and Ctrl+backslash. */
const NO_TEXT_KEYS = new Set([0x0a, 0x0d, 0x03, 0x04, 0x1a, 0x1c]);
const isReport = (b: Uint8Array): boolean => REPORTS.test(Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("latin1"));
const leavesText = (b: Uint8Array): boolean => b.some((x) => !NO_TEXT_KEYS.has(x));

type Timer = ReturnType<typeof setTimeout>;

/** One socket of the pane. */
export class ShellConn {
  ws: ShellSocket | null = null;
  shell: ChatShell | null = null;
  lagging = false;
  lagTimer: ReturnType<typeof setInterval> | null = null;
  openTimer: Timer | null = null;
  closed = false;

  send(frame: ShellOutFrame): void {
    if (this.closed || !this.ws) return;
    this.ws.sendText(JSON.stringify(frame));
  }
}

class ChatShell {
  readonly ring = new OutputRing(SHELL_LIMITS.ringBytes);
  readonly editor = new LineEditorWatch();
  readonly conns = new Set<ShellConn>();
  pty!: PaneShell;
  ended = false;
  closing: Promise<ShellExit> | null = null;
  /** The command this service typed, while no key has come since. */
  typed: string | null = null;
  /** The editor's prompt count when the last key came (-1: no key yet): a key since the prompt began is on its line. */
  keyPrompt = -1;
  /** A key that leaves text came while no prompt waited: it was typed ahead, onto the next prompt's line. */
  typedAhead = false;
  /**
   * The pages whose `type_resume` or `type_trust` waits for the shell's first prompt, each with what it asked (each
   * gets its `typed`; a command is typed once). A key from any page ends the wait with `busy`.
   */
  pendingType: { conns: { conn: ShellConn; want: TypeWant }[]; timer: Timer } | null = null;
  quietTimer: Timer | null = null;
  detachTimer: Timer | null = null;

  constructor(readonly chat: string) {}
}

function connOf(ws: ShellSocket): ShellConn | null {
  const d = ws.data as { kind?: unknown; conn?: unknown } | null | undefined;
  if (typeof d !== "object" || d === null || d.kind !== "shell" || !(d.conn instanceof ShellConn)) return null;
  return d.conn;
}

function slotConnOf(ws: ShellSlotSocket): ShellConn | null {
  const state = ws.data.state;
  return state instanceof ShellConn ? state : null;
}

function bytesOf(message: string | ArrayBuffer | ArrayBufferView): Uint8Array | null {
  if (typeof message === "string") return null;
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
}

export function createShellService(opts: ShellServiceOptions): ShellService {
  const shells = new Map<string, ChatShell>();
  // A copy, taken once: the SDK's query() writes to the server's own process.env at each chat start, and a shell that
  // starts later must still get the start environment (4.7).
  const baseEnv = { ...(opts.env ?? START_ENV) };
  const loginShell = opts.shell ?? defaultShell(baseEnv);
  const detachedKeepMs = opts.detachedKeepMs ?? 30 * 60_000;
  const typeWaitMs = opts.typeWaitMs ?? 10_000;
  const openWaitMs = opts.openWaitMs ?? 10_000;

  const error = (conn: ShellConn, code: ShellErrorCode) => conn.send({ t: "error", code, message: SHELL_ERROR_MESSAGES[code] });

  const sendRing = (conn: ShellConn, s: ChatShell) => {
    if (conn.closed || !conn.ws) return;
    for (const frame of s.ring.frames(RING_FRAME_BYTES)) conn.ws.sendBinary(frame);
  };

  const stopLag = (conn: ShellConn) => {
    conn.lagging = false;
    if (conn.lagTimer) clearInterval(conn.lagTimer);
    conn.lagTimer = null;
  };

  /** The socket is caught up: it clears its terminal and gets the ring again. */
  const recover = (conn: ShellConn) => {
    stopLag(conn);
    conn.send({ t: "reset" });
    if (conn.shell) sendRing(conn, conn.shell);
  };

  const tryRecover = (conn: ShellConn) => {
    if (!conn.lagging || conn.closed || !conn.ws) return;
    if (conn.ws.getBufferedAmount() > LAG_LOW_BYTES) return;
    recover(conn);
  };

  const startLag = (conn: ShellConn) => {
    conn.lagging = true;
    if (!conn.lagTimer) {
      conn.lagTimer = setInterval(() => tryRecover(conn), LAG_POLL_MS);
      conn.lagTimer.unref?.();
    }
  };

  const deliver = (conn: ShellConn, chunk: Uint8Array) => {
    if (conn.lagging || conn.closed || !conn.ws) return;
    if (conn.ws.getBufferedAmount() > SHELL_LIMITS.lagBytes) return startLag(conn);
    // 0: dropped, so this page's copy has a hole; it gets the ring again once it drains.
    if (conn.ws.sendBinary(chunk) === 0) startLag(conn);
  };

  const clearPendingType = (s: ChatShell) => {
    if (s.pendingType) clearTimeout(s.pendingType.timer);
    s.pendingType = null;
    if (s.quietTimer) clearTimeout(s.quietTimer);
    s.quietTimer = null;
  };

  /** Every page whose request waits gets this answer, and the wait ends. */
  const answerPending = (s: ChatShell, c: TypedCase) => {
    const p = s.pendingType;
    clearPendingType(s);
    if (p) for (const { conn } of p.conns) if (!conn.closed && conn.shell === s) conn.send({ t: "typed", case: c });
  };

  /**
   * The prompt is free for the command: the shell itself holds the terminal (no program that it started runs, even
   * one that turned bracketed paste on), no key has come since the prompt began, and no text was typed ahead of it.
   */
  const promptFree = (s: ChatShell): boolean => s.keyPrompt < s.editor.prompts && !s.typedAhead && s.pty.foreground() === true;

  /** The command a request types now, from the server's own facts (never the page's), and its case. */
  const commandFor = (s: ChatShell, want: TypeWant): { case: TypedCase; command: string | null } => {
    let info: ShellChat | null = null;
    try {
      info = opts.host.chat(s.chat);
    } catch {
      info = null;
    }
    if (!info || info.archived) return { case: "none", command: null };
    if (want.kind === "resume") return resumeCommand(info);
    if (want.kind === "attach") {
      // R131: only an id that a launch row of the chat printed (the server's book), never one the page names alone.
      let held = false;
      try {
        held = opts.host.backgroundId?.(s.chat, want.id) === true;
      } catch {
        held = false;
      }
      const command = held ? attachCommand(want.id) : null;
      return command ? { case: "attach", command } : { case: "none", command: null };
    }
    // R127: the folder of the chat's refused row, as the server matched it.
    let folder: string | null = null;
    try {
      folder = opts.host.trustPath?.(s.chat, want.toolUse) ?? null;
    } catch {
      folder = null;
    }
    const command = trustCommand(folder);
    return command ? { case: "trust", command } : { case: "none", command: null };
  };

  const doType = (s: ChatShell, conn: ShellConn, want: TypeWant) => {
    const rc = commandFor(s, want);
    if (rc.command === null || !isTypeable(rc.command)) return conn.send({ t: "typed", case: "none" });
    if (s.typed !== rc.command) {
      if (!promptFree(s)) return conn.send({ t: "typed", case: "busy" });
      if (s.typed !== null) s.pty.write(CLEAR_LINE);
      s.pty.write(rc.command);
      s.typed = rc.command;
    }
    conn.send({ t: "typed", case: rc.case });
  };

  const maybeType = (s: ChatShell) => {
    const p = s.pendingType;
    if (!p || s.ended) return;
    const now = performance.now();
    if (s.editor.ready(now)) {
      clearPendingType(s);
      for (const { conn, want } of p.conns) if (!conn.closed && conn.shell === s) doType(s, conn, want);
      return;
    }
    // The shell showed its prompt before and now runs a command: nothing waits for that to end, so the command is
    // never typed later into a prompt that someone else is about to use.
    if (s.editor.prompts > 0) return answerPending(s, "busy");
    if (s.editor.bracketed === null && s.editor.seenOutput) {
      if (s.quietTimer) clearTimeout(s.quietTimer);
      s.quietTimer = setTimeout(() => maybeType(s), Math.max(1, QUIET_MS - (now - s.editor.lastOutputAt) + 1));
    }
  };

  const onData = (s: ChatShell, chunk: Uint8Array) => {
    if (s.ended) return;
    s.ring.push(chunk);
    s.editor.feed(chunk, performance.now());
    for (const conn of s.conns) deliver(conn, chunk);
    if (s.pendingType) maybeType(s);
  };

  const onExit = (s: ChatShell, exit: ShellExit) => {
    s.ended = true;
    if (shells.get(s.chat) === s) shells.delete(s.chat);
    clearPendingType(s);
    if (s.detachTimer) clearTimeout(s.detachTimer);
    s.detachTimer = null;
    for (const conn of s.conns) {
      if (conn.lagging) recover(conn);
      conn.send({ t: "exit", code: exit.code, signal: exit.signal });
      conn.shell = null;
    }
    s.conns.clear();
    s.typed = null;
  };

  const closeShell = (s: ChatShell): Promise<ShellExit> => {
    s.closing ??= s.pty.close();
    return s.closing;
  };

  const start = (chat: string, cwd: string, cols: number, rows: number): ChatShell => {
    // D60: an environment whose variables could not be read starts no shell (L39), as it starts no chat.
    const vars = opts.host.vars ? opts.host.vars(chat) : [];
    if (vars === null) throw new Error("the environment's variables could not be read");
    const s = new ChatShell(chat);
    s.pty = (opts.pty ?? ((o: ShellPtyOptions) => new ShellPty(o)))({
      shell: loginShell,
      cwd,
      env: shellEnv(baseEnv, { dropNames: opts.dropNames, dropPrefixes: opts.dropPrefixes, vars }),
      cols,
      rows,
      onData: (chunk) => onData(s, chunk),
      onExit: (exit) => onExit(s, exit),
      closeStepMs: opts.closeStepMs,
    });
    shells.set(chat, s);
    return s;
  };

  const resize = (s: ChatShell, from: ShellConn | null, cols: number, rows: number) => {
    if (s.pty.cols === cols && s.pty.rows === rows) return;
    try {
      s.pty.resize(cols, rows);
    } catch {
      return;
    }
    for (const c of s.conns) if (c !== from) c.send({ t: "size", cols, rows });
  };

  const attach = (conn: ShellConn, s: ChatShell, cols: number, rows: number, fresh: boolean) => {
    conn.shell = s;
    s.conns.add(conn);
    if (s.detachTimer) clearTimeout(s.detachTimer);
    s.detachTimer = null;
    // The page that opened or resized last sets the size; the others get `size`.
    if (!fresh) resize(s, conn, cols, rows);
    conn.send({ t: "opened", chat: s.chat, cols: s.pty.cols, rows: s.pty.rows, fresh });
    sendRing(conn, s);
  };

  const detach = (conn: ShellConn) => {
    const s = conn.shell;
    conn.shell = null;
    stopLag(conn);
    if (!s) return;
    s.conns.delete(conn);
    if (s.pendingType?.conns.some((c) => c.conn === conn)) {
      s.pendingType.conns = s.pendingType.conns.filter((c) => c.conn !== conn);
      if (s.pendingType.conns.length === 0) clearPendingType(s);
    }
    if (s.conns.size === 0 && !s.ended && !s.detachTimer) {
      s.detachTimer = setTimeout(() => void closeShell(s), detachedKeepMs);
      s.detachTimer.unref?.();
    }
  };

  const onOpen = (conn: ShellConn, f: Extract<ShellClientFrame, { t: "open" }>) => {
    if (conn.openTimer) clearTimeout(conn.openTimer);
    conn.openTimer = null;
    if (conn.shell) return error(conn, "bad_request");
    let info: ShellChat | null;
    try {
      info = opts.host.chat(f.chat);
    } catch {
      info = null;
    }
    if (!info) return error(conn, "not_found");
    if (info.archived) return error(conn, "archived");
    let s = shells.get(f.chat);
    let fresh = false;
    if (!s || s.ended || s.closing) {
      try {
        s = start(f.chat, info.cwd, f.cols, f.rows);
      } catch {
        opts.log?.log("error", { chat: f.chat, err: "shell" });
        return error(conn, "no_shell");
      }
      fresh = true;
    }
    attach(conn, s, f.cols, f.rows, fresh);
  };

  const onControl = (conn: ShellConn, text: string) => {
    const r = parseShellControl(text);
    if (!r.ok) return error(conn, "bad_request");
    const f = r.frame;
    if (f.t === "open") return onOpen(conn, f);
    const s = conn.shell;
    if (!s) return error(conn, "bad_request");
    if (f.t === "resize") return resize(s, conn, f.cols, f.rows);
    // type_resume, (R127) type_trust and (R131) type_attach: the requests of every page wait together (each page gets
    // its `typed`); the wait starts again. A page's newer request replaces its older one.
    const want: TypeWant = f.t === "type_trust" ? { kind: "trust", toolUse: f.toolUse } : f.t === "type_attach" ? { kind: "attach", id: f.id } : { kind: "resume" };
    const waiting = s.pendingType?.conns.filter((c) => c.conn !== conn) ?? [];
    clearPendingType(s);
    const timer = setTimeout(() => {
      if (s.pendingType?.timer === timer) answerPending(s, "busy");
    }, typeWaitMs);
    timer.unref?.();
    s.pendingType = { conns: [...waiting, { conn, want }], timer };
    maybeType(s);
  };

  const onKeys = (conn: ShellConn, bytes: Uint8Array) => {
    const s = conn.shell;
    if (!s || bytes.length > SHELL_LIMITS.inputFrameBytes) return error(conn, "bad_request");
    if (bytes.length === 0) return;
    if (!isReport(bytes)) {
      s.typed = null;
      s.keyPrompt = s.editor.prompts;
      if (s.editor.bracketed === true) s.typedAhead = false;
      else if (leavesText(bytes)) s.typedAhead = true;
      // A key on any page drops a request that waits: the command is never typed into a line that someone types in.
      if (s.pendingType) answerPending(s, "busy");
    }
    s.pty.write(bytes);
  };

  const onSocketOpen = (conn: ShellConn, ws: ShellSocket) => {
    conn.ws = ws;
    conn.openTimer = setTimeout(() => {
      conn.openTimer = null;
      if (!conn.shell && !conn.closed) ws.close(1008, "");
    }, openWaitMs);
    conn.openTimer.unref?.();
  };

  const onMessage = (conn: ShellConn, message: string | ArrayBuffer | ArrayBufferView) => {
    const bytes = bytesOf(message);
    if (bytes === null) onControl(conn, message as string);
    else onKeys(conn, bytes);
  };

  const onSocketClose = (conn: ShellConn) => {
    conn.closed = true;
    if (conn.openTimer) clearTimeout(conn.openTimer);
    conn.openTimer = null;
    detach(conn);
    conn.ws = null;
  };

  return {
    upgrade(req, server) {
      if (!opts.allowOrigin?.(req.headers.get("origin"))) {
        opts.log?.log("origin_refused", { route: WIRE.shellPath });
        return new Response(null, { status: 403 });
      }
      if (req.method !== "GET") return new Response(null, { status: 405 });
      if (server.upgrade(req, { data: { kind: "shell", conn: new ShellConn() } })) return undefined;
      return new Response(null, { status: 400 });
    },
    websocket: {
      open(ws) {
        const conn = connOf(ws);
        if (conn) onSocketOpen(conn, ws);
        return conn !== null;
      },
      message(ws, message) {
        const conn = connOf(ws);
        if (conn) onMessage(conn, message);
        return conn !== null;
      },
      drain(ws) {
        const conn = connOf(ws);
        if (conn) tryRecover(conn);
        return conn !== null;
      },
      close(ws) {
        const conn = connOf(ws);
        if (conn) onSocketClose(conn);
        return conn !== null;
      },
    },
    handlers: {
      open(ws) {
        const conn = new ShellConn();
        ws.data.state = conn;
        onSocketOpen(conn, ws);
      },
      message(ws, message) {
        const conn = slotConnOf(ws);
        if (conn) onMessage(conn, message);
      },
      drain(ws) {
        const conn = slotConnOf(ws);
        if (conn) tryRecover(conn);
      },
      close(ws) {
        const conn = slotConnOf(ws);
        if (conn) onSocketClose(conn);
      },
    },
    async end(chat) {
      const s = shells.get(chat);
      if (s) await closeShell(s);
    },
    async closeAll() {
      await Promise.all([...shells.values()].map((s) => closeShell(s)));
    },
    has(chat) {
      const s = shells.get(chat);
      return s !== undefined && !s.ended;
    },
    programs() {
      const out: { chat: string; known: boolean }[] = [];
      for (const s of shells.values()) {
        if (s.ended || !s.pty.alive()) continue;
        const fg = s.pty.foreground();
        if (fg !== true) out.push({ chat: s.chat, known: fg === false });
      }
      return out;
    },
    get count() {
      return shells.size;
    },
  };
}
