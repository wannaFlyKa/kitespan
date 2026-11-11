// D58: Claude Code's own registry of running sessions, `<config>/sessions/<pid>.json`, one record per running claude
// process (the terminal's, the desktop app's, an SDK host's such as kitespan's own). It is an undocumented file, so it
// is read defensively: only `<digits>.json` names (the `<pid>.<hash>.key` file beside each record is never opened),
// regular files of at most 16 KiB, and of each record only pid, sessionId, procStart, startedAt, entrypoint and status.
// A record counts only while its process lives with the start time the record names; kitespan's own claude processes (the
// children of the server) never count; anything unknown or unreadable counts as not open. Nothing of a record is
// logged or sent on except the session id's app, whether it is busy and whether it waits for an answer.
//
// R131: the same look gives the records of Claude Code's background sessions (`kind: "bg"` with a `jobId` that is
// Claude Code's short id) whose ids a chat's book holds, with only their job id, session id, name, folder, status, what
// they wait for and start time, each by its rule and cap; `messagingSocketPath`, `logPath` and every other field are
// never kept, and of any other background session (another folder's, one no chat started) nothing is kept beyond D58's
// own facts. D58's map is unchanged: a background session's record still counts there as its app's.

import { constants, existsSync } from "node:fs";
import { open, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { bgName } from "../../../shared/background";
import { isBgId, isUuid } from "../../../shared/ids";
import { BG_LIMITS, BG_WAITS, CONTROL_CHARS, type BgWait, type OpenApp, type SessionOpen } from "../../../shared/protocol";
import type { BgRecord } from "../types";

export const RUNNING_LIMITS = {
  /** The records read per look at the folder; past this many, the rest count as not open. */
  files: 512,
  /** A record's size cap; a larger file is not a record. */
  bytes: 16 * 1024,
  /**
   * How long one look at the folder is kept: under the registry's 2 s check (row 78), so each check of a chat with a
   * viewer or a live process reads the folder again.
   */
  cacheMs: 1_500,
  /**
   * Without /proc, how the process that has a record's pid now must have started against the record's startedAt
   * (Claude Code writes it, in ms, about 0.5 to 4 s after its process starts): from this long before it...
   */
  startEarlyMs: 60_000,
  /** ...to this long after it (ps gives the elapsed time in whole seconds). A pid that the system gave again starts later. */
  startLateMs: 2_000,
} as const;

const RECORD_NAME = /^[1-9][0-9]{0,9}\.json$/;
const MAX_PID = 2 ** 31 - 1;
const PROCFS = existsSync("/proc/self/stat");

/**
 * The registry's folder: `sessions` in Claude Code's config folder, which comes from where the SDK's session
 * functions (the session list, the transcripts) take it: CLAUDE_CONFIG_DIR when it is set, else `~/.claude`.
 */
export function claudeSessionsDir(env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
  return join(claudeConfigDir(env, home), "sessions");
}

/** Claude Code's config folder, as the SDK's session functions take it: CLAUDE_CONFIG_DIR when set, else `~/.claude`. */
export function claudeConfigDir(env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
  const set = env.CLAUDE_CONFIG_DIR?.trim();
  return set ? resolve(set) : join(home, ".claude");
}

/** R131: a session's folder as kitespan keeps one: absolute, at most 4,096 bytes of UTF-8, no control character. */
export function bgFolderOf(v: unknown): string | null {
  if (typeof v !== "string" || !isAbsolute(v) || CONTROL_CHARS.test(v) || Buffer.byteLength(v, "utf8") > BG_LIMITS.folderChars) return null;
  return v;
}

/** R131: what a session that waits for the user waits for: one of Claude Code's own values, else `other`. */
export function bgWaitOf(v: unknown): BgWait {
  return typeof v === "string" && (BG_WAITS as readonly string[]).includes(v) && v !== "other" ? (v as BgWait) : "other";
}

/** R131: a record's status as Claude Code's own `p()` reads it: `idle`, `waiting`, anything else `busy`. */
export function bgStatusOf(v: unknown): BgRecord["status"] {
  return v === "idle" ? "idle" : v === "waiting" ? "waiting" : "busy";
}

/** The app of a record's entrypoint: `cli` is the terminal, `claude-desktop...` the desktop app, anything else another app. */
export function openAppOf(entrypoint: string | null): OpenApp {
  if (entrypoint === "cli") return "terminal";
  if (entrypoint !== null && entrypoint.startsWith("claude-desktop")) return "desktop";
  return "other";
}

/** The fields of a record that kitespan reads; null when the record is not one. */
interface RunRecord {
  pid: number;
  sessionId: string;
  procStart: string | null;
  /** When the process wrote the record (ms since the epoch); compared where there is no /proc. */
  startedAt: number | null;
  entrypoint: string | null;
  /** R22: `busy`, or `waiting` (a session that waits for an answer counts as busy for D58's rules). */
  busy: boolean;
  waiting: boolean;
  /** R131: the background session's own fields, when the record is one's (kind `bg` with a short id); else null. */
  bg: Omit<BgRecord, "sessionId" | "startedAt" | "pid" | "procStart"> | null;
}

/**
 * R131: the background session's fields of a record (`kind: "bg"`, a `jobId` that is a short id), each by its rule, only
 * for an id in `ids` (a chat's book holds it): of any other session (another folder's, one no chat started) not one
 * field is read or kept beyond D58's own.
 */
function bgFieldsOf(o: Record<string, unknown>, ids: ReadonlySet<string>): RunRecord["bg"] {
  if (o.kind !== "bg" || !isBgId(o.jobId) || !ids.has(o.jobId)) return null;
  const status = bgStatusOf(o.status);
  return { jobId: o.jobId as string, name: bgName(o.name), cwd: bgFolderOf(o.cwd), status, waitingFor: status === "waiting" && o.waitingFor !== undefined ? bgWaitOf(o.waitingFor) : null };
}

function recordOf(text: string, bgIds: ReadonlySet<string>): RunRecord | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const pid = o.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 1 || pid > MAX_PID) return null;
  if (!isUuid(o.sessionId)) return null;
  const start = o.procStart;
  const procStart = typeof start === "string" && /^[0-9]{1,20}$/.test(start) ? start : typeof start === "number" && Number.isSafeInteger(start) && start >= 0 ? String(start) : null;
  const startedAt = typeof o.startedAt === "number" && Number.isSafeInteger(o.startedAt) && o.startedAt > 0 ? o.startedAt : null;
  const entrypoint = typeof o.entrypoint === "string" && o.entrypoint.length <= 64 ? o.entrypoint : null;
  const waiting = o.status === "waiting";
  return { pid, sessionId: o.sessionId as string, procStart, startedAt, entrypoint, busy: o.status === "busy" || waiting, waiting, bg: bgFieldsOf(o, bgIds) };
}

/** A file's text when it is a regular file within the cap; a symbolic link, a FIFO or a folder is never followed or waited on. */
async function readCapped(path: string, max: number): Promise<string | null> {
  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const st = await fh.stat();
    if (!st.isFile() || st.size > max) return null;
    const buf = Buffer.alloc(max + 1);
    const { bytesRead } = await fh.read(buf, 0, max + 1, 0);
    return bytesRead > max ? null : buf.toString("utf8", 0, bytesRead);
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/** The process's parent and start time from /proc/<pid>/stat (fields 4 and 22); null when it is gone or a zombie. */
async function procStat(pid: number): Promise<{ ppid: number; start: string } | null> {
  let s: string;
  try {
    s = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  // The command name (field 2) is in parentheses and may hold spaces or parentheses itself: the fields after it
  // start after the last ")".
  const close = s.lastIndexOf(")");
  if (close < 0) return null;
  const f = s.slice(close + 2).split(" ");
  const state = f[0];
  const start = f[19];
  if (state === undefined || state === "Z" || state === "X" || start === undefined || !/^[0-9]+$/.test(start)) return null;
  return { ppid: Number(f[1]), start };
}

/** The pids whose parent is `parent`: its threads' children lists, else every process's stat (no CONFIG_PROC_CHILDREN). */
async function childrenOf(parent: number): Promise<number[]> {
  const out = new Set<number>();
  let listed = false;
  try {
    for (const tid of await readdir(`/proc/${parent}/task`)) {
      try {
        const text = await readFile(`/proc/${parent}/task/${tid}/children`, "utf8");
        listed = true;
        for (const n of text.split(" ")) if (/^[0-9]+$/.test(n)) out.add(Number(n));
      } catch {
        // a thread that ended meanwhile, or no children file
      }
    }
  } catch {
    // no task folder
  }
  if (listed) return [...out];
  for (const n of await readdir("/proc").catch(() => [] as string[])) {
    if (!/^[0-9]+$/.test(n)) continue;
    const st = await procStat(Number(n));
    if (st?.ppid === parent) out.add(Number(n));
  }
  return [...out];
}

/**
 * R16: the child of `parent` whose arguments hold `arg` as one of them (a chat's `--resume=<id>` or
 * `--session-id=<id>`, which the SDK passes as one argument), so the driver can name its chat's claude process; the
 * SDK's process object gives no pid. With /proc: the parent's children and their command lines; without /proc: one
 * `ps` call. Null when there is none, or when it cannot tell.
 */
export async function childWithArg(parent: number, arg: string): Promise<number | null> {
  if (PROCFS) {
    for (const pid of await childrenOf(parent)) {
      try {
        if ((await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").includes(arg)) return pid;
      } catch {
        // gone meanwhile
      }
    }
    return null;
  }
  try {
    const proc = Bun.spawn(["ps", "-A", "-o", "pid=", "-o", "ppid=", "-o", "args="], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill("SIGKILL"), 2_000);
    const [text] = await Promise.all([new Response(proc.stdout).text(), proc.exited]).finally(() => clearTimeout(timer));
    for (const line of text.split("\n")) {
      const m = /^\s*([0-9]+)\s+([0-9]+)\s+(.*)$/.exec(line);
      if (m && Number(m[2]) === parent && m[3]!.split(/\s+/).includes(arg)) return Number(m[1]);
    }
  } catch {
    // ps cannot tell
  }
  return null;
}

/** ps's elapsed time, `[[dd-]hh:]mm:ss`, in seconds; null when it is not one. */
export function elapsedSeconds(etime: string): number | null {
  const m = /^(?:(?:([0-9]+)-)?([0-9]{1,2}):)?([0-9]{1,2}):([0-9]{2})$/.exec(etime.trim());
  if (!m) return null;
  return Number(m[1] ?? 0) * 86_400 + Number(m[2] ?? 0) * 3_600 + Number(m[3]) * 60 + Number(m[4]);
}

/**
 * Without /proc (macOS, for one), each pid's parent and start (ms since the epoch, from its elapsed time: up to a
 * second late) from one `ps` call; null when ps cannot tell, and then no record counts (unknown counts as not open).
 */
async function processesByPs(pids: readonly number[]): Promise<Map<number, { ppid: number; startMs: number }> | null> {
  if (pids.length === 0) return new Map();
  try {
    const proc = Bun.spawn(["ps", "-o", "pid=", "-o", "ppid=", "-o", "etime=", "-p", pids.join(",")], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill("SIGKILL"), 2_000);
    const [text] = await Promise.all([new Response(proc.stdout).text(), proc.exited]).finally(() => clearTimeout(timer));
    const now = Date.now();
    const out = new Map<number, { ppid: number; startMs: number }>();
    for (const line of text.split("\n")) {
      const m = /^\s*([0-9]+)\s+([0-9]+)\s+(\S+)\s*$/.exec(line);
      const secs = m ? elapsedSeconds(m[3]!) : null;
      if (m && secs !== null) out.set(Number(m[1]), { ppid: Number(m[2]), startMs: now - secs * 1_000 });
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * The records whose process lives and is not kitespan's own (one of `own` or a child of one). With /proc: the process
 * exists, is not a zombie, and started when the record says (field 22 of its stat), so a pid that the system gave to
 * a new process does not count. Without /proc: process.kill(pid, 0) works, and the process that has the pid started
 * within RUNNING_LIMITS' window around the record's startedAt (a pid given again belongs to a process that started
 * after the record's process ended, so after the record was written); kill(pid, 0) also fails for another user's
 * process, which then counts as not open. A record with no start time to compare counts as not open on either path.
 */
async function living(records: readonly RunRecord[], own: ReadonlySet<number>, procfs: boolean): Promise<RunRecord[]> {
  const mine = records.filter((r) => !own.has(r.pid));
  if (procfs) {
    const ok = await Promise.all(
      mine.map(async (r) => {
        if (r.procStart === null) return false;
        const st = await procStat(r.pid);
        return st !== null && st.start === r.procStart && !own.has(st.ppid);
      }),
    );
    return mine.filter((_, i) => ok[i]);
  }
  const alive = mine.filter((r) => {
    if (r.startedAt === null) return false;
    try {
      process.kill(r.pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  const procs = await processesByPs([...new Set(alive.map((r) => r.pid))]);
  if (!procs) return [];
  return alive.filter((r) => {
    const p = procs.get(r.pid);
    if (!p || own.has(p.ppid)) return false;
    return p.startMs >= r.startedAt! - RUNNING_LIMITS.startEarlyMs && p.startMs <= r.startedAt! + RUNNING_LIMITS.startLateMs;
  });
}

const RANK: Record<OpenApp, number> = { terminal: 0, desktop: 1, other: 2 };

export interface RunningOptions {
  /** The registry's folder (claudeSessionsDir()). */
  dir: string;
  /**
   * kitespan's own pids, read at each look: a record of one of them, or of a child of one, never counts (the driver
   * gives the server's own pid, since every claude it starts is a child of the server).
   */
  ownPids: () => Iterable<number>;
  cacheMs?: number;
  now?: () => number;
  /** Whether /proc can be read (tests: false for the other platforms' path); default: whether /proc/self/stat exists. */
  procfs?: boolean;
}

/** One look at the registry: D58's map, and (R131) the background sessions' records. */
interface Look {
  open: Map<string, SessionOpen>;
  background: BgRecord[];
}

/** The sessions that other processes have open now, from the registry, each look kept for about 1.5 s. */
export class RunningSessions {
  /** The kept look, and the background sessions' ids whose records it kept. */
  private cached: { at: number; ids: ReadonlySet<string>; value: Promise<Look> } | null = null;
  /** R131: the ids of the last readBackground (the chats' books): a look keeps the background records of these only. */
  private bgIds: ReadonlySet<string> = new Set();

  constructor(private readonly opts: RunningOptions) {}

  async read(): Promise<Map<string, SessionOpen>> {
    return (await this.current()).open;
  }

  /**
   * R131: the background sessions' records of the same look (each living, none of kitespan's own), of the ids in `ids`
   * only (the chats' books). From then on a look keeps those ids' records and nothing of any other background
   * session; a kept look that did not ask for one of `ids` gives way to a new look.
   */
  async readBackground(ids: ReadonlySet<string>): Promise<BgRecord[]> {
    this.bgIds = new Set([...ids].filter((id) => isBgId(id)));
    return (await this.current(this.bgIds)).background.filter((b) => ids.has(b.jobId)).map((b) => ({ ...b }));
  }

  private current(need?: ReadonlySet<string>): Promise<Look> {
    const now = this.opts.now?.() ?? Date.now();
    const c = this.cached;
    if (c && now - c.at < (this.opts.cacheMs ?? RUNNING_LIMITS.cacheMs) && (!need || [...need].every((id) => c.ids.has(id)))) return c.value;
    const ids = this.bgIds;
    const value = this.look(ids).catch((): Look => ({ open: new Map(), background: [] }));
    this.cached = { at: now, ids, value };
    return value;
  }

  private async look(bgIds: ReadonlySet<string>): Promise<Look> {
    const out = new Map<string, SessionOpen>();
    const background: BgRecord[] = [];
    let names: string[];
    try {
      names = await readdir(this.opts.dir);
    } catch {
      return { open: out, background };
    }
    const own = new Set<number>();
    for (const pid of this.opts.ownPids()) if (Number.isInteger(pid) && pid > 0) own.add(pid);
    const procfs = this.opts.procfs ?? PROCFS;
    const files = names.filter((n) => RECORD_NAME.test(n)).slice(0, RUNNING_LIMITS.files);
    const read = await Promise.all(
      files.map(async (name) => {
        const text = await readCapped(join(this.opts.dir, name), RUNNING_LIMITS.bytes);
        return text === null ? null : recordOf(text, bgIds);
      }),
    );
    for (const r of await living(read.filter((r): r is RunRecord => r !== null), own, procfs)) {
      const app = openAppOf(r.entrypoint);
      const was = out.get(r.sessionId);
      // One session in two processes: the first app in the order terminal, desktop, other; busy (and waiting) when
      // either is.
      const waiting = r.waiting || was?.waiting === true;
      out.set(r.sessionId, { app: was && RANK[was.app] <= RANK[app] ? was.app : app, busy: r.busy || was?.busy === true, ...(waiting ? { waiting } : {}) });
      if (r.bg) background.push({ ...r.bg, sessionId: r.sessionId, startedAt: r.startedAt, pid: r.pid, procStart: r.procStart });
    }
    return { open: out, background };
  }
}
