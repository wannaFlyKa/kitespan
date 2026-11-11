// The counts-only logger (DESIGN.md 4.4 "logs/", 4.9 guard 5): the only writer of the state folder's
// logs/kitespan-<YYYY-MM-DD>.log files (a restart's preflight check and its successor print into logs/server-out.log,
// server/update/successor.ts). One JSON-lines file per UTC day, kept 14 days. A line holds a time, an event name from
// a fixed list, a chat id and numbers; never message text, tool input or output, file contents, a command line, a
// query string, a path, an Origin value or an environment value. Anything that does not fit its field's rule is
// written as null. One exception (R127): a `trust` line holds the folder that kitespan asked Claude Code to trust, and
// the answer, and nothing else. R131: a `bg_stop` line holds a background session's short id and the stop's answer, and
// a `bg_list` line the list run's time, exit code and count of rows kept; nothing else of either. R130: a `push` line
// holds the push service's host, the status and the time; `push_gone` the host and the status; `push_device` what
// changed. Never an endpoint's path, a key, a payload, a title or a device's name. U5: a `search` line holds the
// query's length, the chats read, the time and three flags; never the query, a snippet or a message's id.

import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { BG_ID, CHAT_ID } from "../shared/ids";
import { LEGACY_LOG_PREFIX } from "../shared/legacy";
import { BG_STOP_ANSWERS, TRUST_ANSWERS } from "../shared/protocol";
import { pushHostOf } from "../shared/push";
import { ROUTE_PATTERNS } from "../shared/route";
import { trustPathProblem } from "../shared/trust";

/** The events. A new event needs a change here. */
/** `update`: one line per update job of the Update button (row 108) as it ends: ok, its time, and a deadline that cut it. */
/** `side`: one line per side question (R124) as it settles: answered or not, and its time. */
/**
 * `trust` (R127): one line per answer of Trust this folder, with the folder's path and the answer: the one line that
 * holds a path (FIX-R127 section 2; DESIGN 4.9 guard 5's exception), never anything else.
 */
/**
 * `bg_stop` (R131): one line per Stop of a background session, with its short id and the answer. `bg_list`: one line
 * per run of Claude Code's list (`claude agents --json --all`), with its time, its exit code and the count of rows kept.
 */
/**
 * `push` (R130): one line per push sent to a device's push service: its host (a push service of shared/push.ts's list,
 * or the loopback stub of a test), the status (0: no answer, with `answer` timeout or network) and the time.
 * `push_gone`: a 404 or 410 removed a device (the host and the status). `push_device`: a device was added, removed or
 * renamed (`answer`).
 */
/**
 * `search` (U5): one line per message search that answered (`len`: the query's length in characters; `count`: the
 * chats whose transcripts were read from disk while it waited; `ms`; `ok`: complete; `timeout`: the deadline cut it;
 * `capped`: the memory cap left chats or messages out), and one line with `len` null when a background read ends with
 * no query waiting for it. Never the query, a word of it, a snippet, a title or a message's id.
 */
/**
 * `changes` (U1): one line per turn's changes summary as it settles (`ok`: from the git marks, not the fallback; `count`:
 * the files the turn changed; `ms`: the end mark and the summary; `timeout`: a deadline cut a mark), and one per diff
 * read (`count` null). Never a path, a file's name, a line or a tree id.
 */
/**
 * Iteration 7, the browser pane (DESIGN-B1 2.15; SERVER-B1 12): `browser`, one line per state change of the shared
 * browser's host (`answer`, BROWSER_LOG_ANSWERS; `ms`, a start's time to /json/version; `code`, Chrome's exit code),
 * and one with `self_refused` and the route pattern when the document rule or the peer check refuses kitespan's own
 * page to the shared browser; `browser_view`, one line per cast as it ends (`ms`, `count` frames sent, `capped` whether
 * backpressure dropped a frame, `stale` presses refused); `browser_download`, one line per download as it ends (`ok`,
 * `ms`). Never a URL or any part of one, a title, page text, a dialog's message, a file or download name, a selection,
 * a field's facts, a target, session or frame id, a binary's path or Chrome's own output.
 */
export const LOG_EVENTS = ["claude_start", "claude_exit", "turn_end", "bash", "corpus", "origin_refused", "reconnect", "restart", "update", "side", "trust", "bg_stop", "bg_list", "push", "push_gone", "push_device", "search", "changes", "browser", "browser_view", "browser_download", "error"] as const;
export type LogEvent = (typeof LOG_EVENTS)[number];

/** The error codes of an `error` line: the code only, never the error's text. A new code needs a change here. */
export const LOG_ERRORS = [
  "spawn_failed",
  "sdk_error",
  "store_read",
  "store_write",
  "bad_record",
  "ws_send",
  "bash_spawn",
  "upload",
  "shell",
  "corpus",
  "update",
  "browser",
  "uncaught",
  "unknown",
] as const;
export type LogError = (typeof LOG_ERRORS)[number];

export const LOG_KEEP_DAYS = 14;

/** The socket paths a line may name beside the route table's patterns; the HTTP layer adds its API patterns. */
export const SOCKET_ROUTES = ["/ws", "/ws/shell", "/ws/browser"] as const;

export interface LogFields {
  chat?: string | null;
  /** A route pattern (for example `/c/:chat/files/*`), never a path. Only patterns the logger knows are kept. */
  route?: string | null;
  /** The exit code of a claude process, of a `!` command, or of `git ls-files --cached` (a `corpus` build). */
  code?: number | null;
  signal?: string | null;
  ms?: number | null;
  ok?: boolean | null;
  timeout?: boolean | null;
  capped?: boolean | null;
  err?: LogError | null;
  /** R127, `trust` lines only: the folder that kitespan asked Claude Code to trust (absolute, at most 4,096 bytes). */
  path?: string | null;
  /** R127, `trust` lines only: the answer (TRUST_ANSWERS); R131, `bg_stop` lines: the stop's (BG_STOP_ANSWERS). */
  answer?: string | null;
  /** R131, `bg_stop` lines only: the background session's short id. */
  id?: string | null;
  /** R131, `bg_list` lines only: how many rows the list kept (the book's ids); U5, `search` lines: the chats read. */
  count?: number | null;
  /** U5, `search` lines only: the query's length in characters (code points), never the query; null for a background read. */
  len?: number | null;
  /** R130, `push` and `push_gone` lines only: the push service's host, never the endpoint's path. */
  host?: string | null;
  /** R130, `push` and `push_gone` lines only: the push service's HTTP status (0: no answer). */
  status?: number | null;
  /** Iteration 7, `browser_view` lines only: the presses refused against a stale frame (DESIGN-B1 2.14). */
  stale?: number | null;
}

/** Iteration 7: a `browser` line's answer (a state change of the host, or a refusal of kitespan's own page). */
export const BROWSER_LOG_ANSWERS = ["started", "adopted", "stopped", "exited", "crashed", "missing", "port_own", "port_other", "cleared", "self_refused"] as const;

/** R130: a `push` line's answer when there was no status; a `push_device` line's change. */
export const PUSH_LOG_ANSWERS = { push: ["timeout", "network"], push_device: ["added", "removed", "renamed"] } as const;

export interface LogLine {
  t: string;
  ev: LogEvent;
  chat: string | null;
  route: string | null;
  code: number | null;
  signal: string | null;
  ms: number | null;
  ok: boolean | null;
  timeout: boolean | null;
  capped: boolean | null;
  err: LogError | null;
  /** R127: only on a `trust` line. */
  path?: string | null;
  /** R127: on a `trust` line; R131: on a `bg_stop` line. */
  answer?: string | null;
  /** R131: only on a `bg_stop` line. */
  id?: string | null;
  /** R131: only on a `bg_list` line; U5: and on a `search` line. */
  count?: number | null;
  /** U5: only on a `search` line. */
  len?: number | null;
  /** R130: only on `push` and `push_gone` lines. */
  host?: string | null;
  status?: number | null;
  /** Iteration 7: only on a `browser_view` line. */
  stale?: number | null;
}

const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

/** The only fields some events' lines hold; every other field is null. */
const EVENT_FIELDS: Partial<Record<LogEvent, readonly (keyof LogFields)[]>> = {
  // R9: one line per attach that named a cursor: true for a replay, false for a snapshot, and the catch-up's time.
  reconnect: ["chat", "ok", "ms"],
  side: ["chat", "ok", "ms"],
  trust: ["path", "answer"],
  bg_stop: ["id", "answer"],
  bg_list: ["ms", "code", "count"],
  push: ["host", "status", "ms", "answer"],
  push_gone: ["host", "status"],
  push_device: ["answer"],
  search: ["ms", "count", "len", "ok", "timeout", "capped"],
  changes: ["chat", "ms", "count", "ok", "timeout", "capped"],
  browser: ["answer", "ms", "code", "route"],
  browser_view: ["ms", "count", "capped", "stale"],
  browser_download: ["ok", "ms"],
};

/** A count or a length as a line may hold it: a whole number from 0. */
const countOk = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** A push service's host as a line may hold it: one of the list, or the loopback stub of a test. */
const pushHostOk = (v: unknown): v is string => typeof v === "string" && (v === "127.0.0.1" || pushHostOf(v) !== null) && v.length <= 253;
const statusOk = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 999;

/** One line, every field checked: an unknown event throws (a programming error); a bad field becomes null. */
export function logLine(ev: LogEvent, fields: LogFields, at: Date, routes: ReadonlySet<string>): LogLine {
  if (!(LOG_EVENTS as readonly string[]).includes(ev)) throw new Error("unknown log event");
  const only = EVENT_FIELDS[ev];
  const f: LogFields = only ? Object.fromEntries(only.map((k) => [k, fields[k]])) : fields;
  return {
    t: at.toISOString(),
    ev,
    chat: typeof f.chat === "string" && CHAT_ID.test(f.chat) ? f.chat : null,
    route: typeof f.route === "string" && routes.has(f.route) ? f.route : null,
    code: typeof f.code === "number" && Number.isSafeInteger(f.code) ? f.code : null,
    signal: typeof f.signal === "string" && /^SIG[A-Z0-9]{1,12}$/.test(f.signal) ? f.signal : null,
    ms: typeof f.ms === "number" && Number.isFinite(f.ms) && f.ms >= 0 ? Math.round(f.ms) : null,
    ok: bool(f.ok),
    timeout: bool(f.timeout),
    capped: bool(f.capped),
    err: typeof f.err === "string" && (LOG_ERRORS as readonly string[]).includes(f.err) ? f.err : null,
    // R127: the trust line's two fields, each checked (a path kitespan would trust, a known answer), on it alone.
    ...(ev === "trust"
      ? {
          path: typeof f.path === "string" && trustPathProblem(f.path) === null ? f.path : null,
          answer: typeof f.answer === "string" && (TRUST_ANSWERS as readonly string[]).includes(f.answer) ? f.answer : null,
        }
      : {}),
    // R131: a stop's two fields and a list run's count, each checked, on their own lines alone.
    ...(ev === "bg_stop"
      ? {
          id: typeof f.id === "string" && BG_ID.test(f.id) ? f.id : null,
          answer: typeof f.answer === "string" && (BG_STOP_ANSWERS as readonly string[]).includes(f.answer) ? f.answer : null,
        }
      : {}),
    ...(ev === "bg_list" ? { count: countOk(f.count) ? f.count : null } : {}),
    // U5: a search line's count and length, each a whole number, on it alone; never the query itself.
    ...(ev === "search" ? { count: countOk(f.count) ? f.count : null, len: countOk(f.len) ? f.len : null } : {}),
    // U1: a changes line's count of files, a whole number, on it alone.
    ...(ev === "changes" ? { count: countOk(f.count) ? f.count : null } : {}),
    // R130: the push lines' host and status, each checked, on their own lines alone; the answer from its event's list.
    ...(ev === "push" || ev === "push_gone" ? { host: pushHostOk(f.host) ? f.host.toLowerCase() : null, status: statusOk(f.status) ? f.status : null } : {}),
    ...(ev === "push" || ev === "push_device"
      ? { answer: typeof f.answer === "string" && (PUSH_LOG_ANSWERS[ev] as readonly string[]).includes(f.answer) ? f.answer : null }
      : {}),
    // Iteration 7: the browser's lines, each field checked, on their own lines alone; never a URL, a title or a name.
    ...(ev === "browser" ? { answer: typeof f.answer === "string" && (BROWSER_LOG_ANSWERS as readonly string[]).includes(f.answer) ? f.answer : null } : {}),
    ...(ev === "browser_view" ? { count: countOk(f.count) ? f.count : null, stale: countOk(f.stale) ? f.stale : null } : {}),
  };
}

/** `kitespan-<YYYY-MM-DD>.log`, the UTC date. */
export function logFileName(at: Date): string {
  return `kitespan-${at.toISOString().slice(0, 10)}.log`;
}

/** A day file, also of the old name (shared/legacy.ts): the sweep removes those too once they are over the limit. */
const FILE_RE = new RegExp(`^(?:kitespan-|${LEGACY_LOG_PREFIX})(\\d{4}-\\d{2}-\\d{2})\\.log$`);

export interface Logger {
  log(ev: LogEvent, fields?: LogFields): void;
  /** Remove the day files older than the keep limit; returns how many went. */
  sweep(): number;
  close(): void;
  /** Lines that could not be written (the file's check failed, or the write did). Never thrown. */
  readonly failures: number;
}

export interface LoggerOptions {
  /** The state folder's `logs/` (made 0700 when missing). */
  dir: string;
  /** Route patterns beyond the route table's and the sockets' (the JSON API's, for example). */
  routes?: Iterable<string>;
  now?: () => Date;
  keepDays?: number;
}

/** The folder must be a real folder of this user with no group or other bit. */
function checkDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  const uid = typeof process.getuid === "function" ? process.getuid() : st.uid;
  if (st.isSymbolicLink() || !st.isDirectory() || (st.mode & 0o077) !== 0 || st.uid !== uid) {
    throw new Error("the logs folder must be a real folder of this user with mode 0700");
  }
}

export function createLogger(opts: LoggerOptions): Logger {
  const { dir } = opts;
  const now = opts.now ?? (() => new Date());
  const keepDays = opts.keepDays ?? LOG_KEEP_DAYS;
  const routes = new Set<string>([...ROUTE_PATTERNS, ...SOCKET_ROUTES, ...(opts.routes ?? [])]);
  checkDir(dir);

  let fd: number | null = null;
  let day = "";
  let failures = 0;
  let closed = false;

  const closeFile = () => {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
      fd = null;
    }
  };

  /** Open the day's file for appending, never through a symbolic link, and check that it is this user's 0600 file. */
  const openDay = (name: string): number | null => {
    const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;
    let f: number;
    try {
      f = openSync(join(dir, name), flags, 0o600);
    } catch {
      return null;
    }
    try {
      const st = fstatSync(f);
      const uid = typeof process.getuid === "function" ? process.getuid() : st.uid;
      if (st.isFile() && (st.mode & 0o777) === 0o600 && st.uid === uid) return f;
    } catch {
      // fall through
    }
    closeSync(f);
    return null;
  };

  const sweep = (): number => {
    const cutoff = new Date(now().getTime() - keepDays * 86_400_000).toISOString().slice(0, 10);
    let removed = 0;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return 0;
    }
    for (const name of names) {
      const m = FILE_RE.exec(name);
      if (!m || m[1]! >= cutoff) continue;
      try {
        const st = lstatSync(join(dir, name));
        if (st.isFile() || st.isSymbolicLink()) {
          unlinkSync(join(dir, name));
          removed++;
        }
      } catch {
        // gone already
      }
    }
    return removed;
  };

  sweep();

  return {
    log(ev, fields = {}) {
      if (closed) return;
      const at = now();
      const line = logLine(ev, fields, at, routes);
      const name = logFileName(at);
      if (name !== day) {
        closeFile();
        day = name;
        fd = openDay(name);
        sweep();
      }
      if (fd === null) {
        failures++;
        return;
      }
      try {
        writeSync(fd, `${JSON.stringify(line)}\n`);
      } catch {
        failures++;
      }
    },
    sweep,
    close() {
      closed = true;
      closeFile();
    },
    get failures() {
      return failures;
    },
  };
}
