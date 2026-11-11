// What survives a stop of the server, besides the queue (queue.ts): D32's line and kitespan's own orphans (DESIGN.md
// 9.4; BUILD-BRIEF section 2 items 1 and 2).
// - The stop a chat gets at boot: the ledger's own (a shutdown or Restart now wrote it), else one that the state of a
//   crash or a kill -9 gives (`running` or `starting` cut a turn, `waiting` cut a card).
// - The line shows only when the turn did not finish: the transcript's last turn has no reply that ends it. A chat
//   that waited for an answer always gets it (its card died with the process).
// - Its place in history is a StopNote's, as a Not run row's: where the transcript ended when it was noted.
// - kitespan's own claude that outlived the server (a kill -9 does not end a turn that runs): known by the pid and
//   start time in the ledger, never by its pid alone, so a pid that the system gave again never counts (with /proc the
//   start counts from the boot, so it holds the boot's id: a ledger kept across a power loss names no process of the
//   new boot); Stop sends it SIGTERM, then SIGKILL after 5 s, each only after that check.

import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { TURN_CUT, TURN_INTERRUPTED, type ChatEvent, type ChatState } from "../../shared/protocol";
import type { LedgerProc, LedgerStop, StopBy, StopNote } from "../store/types";
import { notRunAnchor } from "./history";
import { eventId } from "./ring";

/** How long Stop waits after SIGTERM before SIGKILL (R16). */
export const ORPHAN_GRACE_MS = 5_000;
/** Without /proc, a start read from ps's elapsed time is up to a second late: two reads of one process agree within this. */
const PS_START_SLACK_MS = 2_000;

/** The ledger states whose cut gives a line, and why. */
const CUT: Partial<Record<ChatState, LedgerStop["why"]>> = { running: "running", starting: "running", waiting: "waiting" };

/** The stop that a chat's ledger gives at boot: its own `stop`, else the one that a crash left in its `state`. */
export function bootStop(rec: { state: ChatState; stop?: LedgerStop }, at: string): LedgerStop | null {
  if (rec.stop) return rec.stop;
  const why = CUT[rec.state];
  return why ? { why, by: "crash", at } : null;
}

/** The stop that a shutdown or Restart now writes for a live chat in `state`, or null when it cuts nothing. */
export function cutStop(state: ChatState, by: Exclude<StopBy, "crash">, at: string): LedgerStop | null {
  const why = CUT[state];
  return why ? { why, by, at } : null;
}

/**
 * Whether the transcript's last turn finished (the ledger said a turn ran): after the last message or `!` record, the
 * main thread's reply ended in text, with no call or result after it, or a Stop's line ended it. A transcript with no
 * turn did not: the cut turn never reached it.
 */
export function lastTurnEnded(events: readonly ChatEvent[]): boolean {
  let ended = false;
  for (const e of events) {
    if (e.k === "user" || (e.k === "bash" && e.state !== "not_run")) ended = false;
    else if (e.k === "block" && e.parent === null) ended = e.kind === "text";
    else if ((e.k === "tool_call" || e.k === "tool_result") && e.parent === null) ended = false;
    else if (e.k === "turn_end") ended = true;
  }
  return ended;
}

/** One read of the whole transcript at boot: its users' uuids (the queue's dedupe), its end, and whether its last turn ended. */
export interface TranscriptFacts {
  uuids: Set<string>;
  after: string | null;
  skip: number;
  ended: boolean;
}

export function transcriptFacts(events: readonly ChatEvent[]): TranscriptFacts {
  const uuids = new Set<string>();
  for (const e of events) if (e.k === "user") uuids.add(e.uuid);
  return { uuids, ...notRunAnchor(events), ended: lastTurnEnded(events) };
}

/** What history draws around a turn's end that is not the transcript's own: a card's record, a stopped call, a Not run row. */
function decoration(e: ChatEvent): boolean {
  return e.k === "card_open" || e.k === "card_close" || e.k === "tool_stopped" || (e.k === "bash" && e.state === "not_run");
}

/**
 * The chat's stop lines in its decorated history (history.ts decorateHistory), each as a `notice` with its id: after
 * its anchor and the id-less events that followed it when it was noted, then after the server's own rows there (the
 * cut turn's card records and stopped calls), so it reads under the cut turn. A line whose anchor is gone is left out.
 * The Interrupted end that Claude Code wrote for the turn a line is under (Restart now's interrupt, a card that a
 * close denied) becomes TURN_CUT: the line says what happened, once (DESIGN 4.10).
 */
export function insertStops(events: ChatEvent[], stops: readonly StopNote[] | undefined): ChatEvent[] {
  if (!stops?.length) return events;
  events = [...events];
  const index = new Map<string, number>();
  events.forEach((e, i) => {
    const id = eventId(e);
    if (id !== null) index.set(id, i);
  });
  const placed: { at: number; e: ChatEvent }[] = [];
  for (const n of stops) {
    const anchor = n.after === null ? -1 : index.get(n.after);
    if (anchor === undefined) continue;
    let at = anchor + 1;
    for (let left = n.skip; at < events.length && left > 0; at++) if (eventId(events[at]!) === null) left--;
    while (at < events.length && decoration(events[at]!)) at++;
    placed.push({ at, e: { k: "notice", text: n.text, id: n.id } });
    let end = at - 1;
    while (end >= 0 && decoration(events[end]!)) end--;
    const last = events[end];
    if (last?.k === "turn_end" && last.subtype === TURN_INTERRUPTED) events[end] = { ...last, subtype: TURN_CUT };
  }
  if (placed.length === 0) return events;
  const out: ChatEvent[] = [];
  let p = 0;
  for (let i = 0; i <= events.length; i++) {
    while (p < placed.length && placed[p]!.at === i) out.push(placed[p++]!.e);
    if (i < events.length) out.push(events[i]!);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// kitespan's own orphans (R16, BUILD-BRIEF section 2 item 1)

/** The system's processes as the orphan rule needs them; the registry's tests give their own. */
export interface ProcTable {
  /** The process's start time (LedgerProc.start), or null when it is gone, a zombie, or cannot be read. */
  startOf(pid: number): Promise<string | null>;
  /** Whether two start times name one process (the same pid then is the same process). */
  sameStart(recorded: string, now: string): boolean;
  /** Send the signal; false when it could not be sent. */
  kill(pid: number, signal: "SIGTERM" | "SIGKILL"): boolean;
}

/** What the registry takes besides RegistryDeps for the rules above (tests). */
export interface SurviveDeps {
  procs?: ProcTable;
  /** Stop's wait between SIGTERM and SIGKILL (ORPHAN_GRACE_MS). */
  orphanGraceMs?: number;
}

const PROCFS = existsSync("/proc/self/stat");

/** This boot's id: the start ticks of /proc count from the boot, so they name a process only with it; null: unknown. */
const BOOT_ID = ((): string | null => {
  try {
    const id = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) ? id : null;
  } catch {
    return null;
  }
})();

/**
 * Field 22 of /proc/<pid>/stat (the start in clock ticks after boot), then `@` and the boot's id when it is known;
 * null when the process is gone or a zombie.
 */
async function procfsStart(pid: number): Promise<string | null> {
  let s: string;
  try {
    s = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
  const state = f[0];
  const start = f[19];
  if (state === undefined || state === "Z" || state === "X" || start === undefined || !/^[0-9]{1,20}$/.test(start)) return null;
  return BOOT_ID ? `${start}@${BOOT_ID}` : start;
}

/** Without /proc: the start in ms since the epoch, from ps's elapsed time (whole seconds). */
async function psStart(pid: number): Promise<string | null> {
  try {
    const proc = Bun.spawn(["ps", "-o", "etime=", "-o", "stat=", "-p", String(pid)], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill("SIGKILL"), 2_000);
    const [text] = await Promise.all([new Response(proc.stdout).text(), proc.exited]).finally(() => clearTimeout(timer));
    const m = /^\s*(?:(?:([0-9]+)-)?([0-9]{1,2}):)?([0-9]{1,2}):([0-9]{2})\s+(\S+)/.exec(text);
    if (!m || m[5]!.startsWith("Z")) return null;
    const secs = Number(m[1] ?? 0) * 86_400 + Number(m[2] ?? 0) * 3_600 + Number(m[3]) * 60 + Number(m[4]);
    return String(Date.now() - secs * 1_000);
  } catch {
    return null;
  }
}

export const systemProcs: ProcTable = {
  startOf: (pid) => (Number.isInteger(pid) && pid > 1 ? (PROCFS ? procfsStart(pid) : psStart(pid)) : Promise.resolve(null)),
  sameStart: (recorded, now) => (PROCFS ? recorded === now : Math.abs(Number(recorded) - Number(now)) <= PS_START_SLACK_MS),
  kill(pid, signal) {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  },
};

/** The ledger's process lives, with the start that the ledger names. */
export async function procLives(table: ProcTable, proc: LedgerProc): Promise<boolean> {
  const now = await table.startOf(proc.pid);
  return now !== null && table.sameStart(proc.start, now);
}

/**
 * Stop on kitespan's own orphan: SIGTERM, then SIGKILL once `graceMs` passed, each sent only while the pid still has
 * the recorded start. Resolves when the process is gone or SIGKILL went; false when it did not live.
 */
export async function endOrphan(table: ProcTable, proc: LedgerProc, graceMs = ORPHAN_GRACE_MS): Promise<boolean> {
  if (!(await procLives(table, proc))) return false;
  table.kill(proc.pid, "SIGTERM");
  const end = Date.now() + graceMs;
  while (Date.now() < end) {
    await Bun.sleep(Math.min(100, Math.max(1, end - Date.now())));
    if (!(await procLives(table, proc))) return true;
  }
  if (await procLives(table, proc)) table.kill(proc.pid, "SIGKILL");
  return true;
}
