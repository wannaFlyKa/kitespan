// One update at a time on this machine (owner row 108): the Update button's job and bin/update.sh both take
// `update.lock` in the state folder before their first step, and give it back after their last. The file is made with
// O_EXCL and no link followed, mode 0600, and holds the holder's pid and its start (field 22 of /proc/<pid>/stat with
// the boot's id, as the ledger's `proc` does, server/chats/stops.ts), so a lock that a crash left behind (its pid gone,
// or the pid given again to another process) is taken over, and a live holder's is never.
//
// A step runs in a process group of its own, which outlives a holder that was killed (kill -9, a crash): its deadline
// was the holder's timer. So the holder writes each step's group leader into the lock as the step starts (its pid,
// its start and the step's deadline), and the lock stays held while that leader lives, up to the deadline; past it,
// the next process that looks ends that group (SIGKILL), as the holder's own deadline would have, and the lock is
// taken over. A second update never runs beside such a step.

import { closeSync, constants, openSync, readSync } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { systemProcs, type ProcTable } from "../chats/stops";

export const UPDATE_LOCK = "update.lock";

export interface UpdateLock {
  /** A step's program started: its group leader `pid`, which the step ends at `timeoutMs` from now. */
  step(pid: number, timeoutMs: number): Promise<void>;
  release(): Promise<void>;
}

interface Step {
  pid: number;
  start: string;
  /** The step's deadline (ms since the epoch). */
  until: number;
}

interface Holder {
  pid: number;
  start: string;
  step: Step | null;
}

const procOk = (pid: unknown, start: unknown): boolean => Number.isInteger(pid) && (pid as number) > 1 && typeof start === "string" && start.length <= 64;

function holderOf(text: string): Holder | null {
  try {
    const v = JSON.parse(text) as { v?: unknown; pid?: unknown; start?: unknown; step?: { pid?: unknown; start?: unknown; until?: unknown } } | null;
    if (!v || v.v !== 1 || !procOk(v.pid, v.start)) return null;
    const s = v.step;
    const step = s && typeof s === "object" && procOk(s.pid, s.start) && typeof s.until === "number" && Number.isFinite(s.until) ? { pid: s.pid as number, start: s.start as string, until: s.until } : null;
    return { pid: v.pid as number, start: v.start as string, step };
  } catch {
    return null;
  }
}

async function readHolder(file: string): Promise<Holder | null | "absent"> {
  try {
    const h = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = await h.stat();
      if (!st.isFile() || st.size > 4096) return null;
      return holderOf(await h.readFile("utf8"));
    } finally {
      await h.close();
    }
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : null;
  }
}

/**
 * The holder lives, with its recorded start; or, with the holder gone, the group of the step it ran does, within the
 * step's deadline. Past it, that group is ended here (only while its leader has the recorded start) and the lock is
 * free.
 */
async function lives(h: Holder, procs: ProcTable): Promise<boolean> {
  const start = await procs.startOf(h.pid);
  if (start !== null && procs.sameStart(h.start, start)) return true;
  if (!h.step) return false;
  const leader = await procs.startOf(h.step.pid);
  if (leader === null || !procs.sameStart(h.step.start, leader)) return false;
  if (Date.now() < h.step.until) return true;
  // The step leads its group (it was spawned detached), so the group's id is its pid.
  procs.kill(-h.step.pid, "SIGKILL");
  return false;
}

/** True while a live process holds the lock in `dir`. */
export async function lockHeld(dir: string, procs: ProcTable = systemProcs): Promise<boolean> {
  const h = await readHolder(join(dir, UPDATE_LOCK));
  return h !== "absent" && h !== null && (await lives(h, procs));
}

/**
 * Take the lock in `dir` (made 0700 when it is not there yet) for this process; null while a live process holds it.
 * A lock of a process that is gone, or one that does not read, is taken over.
 */
export async function takeLock(dir: string, procs: ProcTable = systemProcs, pid: number = process.pid): Promise<UpdateLock | null> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, UPDATE_LOCK);
  const start = await procs.startOf(pid);
  if (start === null) return null;
  let mine = `${JSON.stringify({ v: 1, pid, start })}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const h = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await h.writeFile(mine);
      } finally {
        await h.close();
      }
      // One change of the file at a time, so a step's record never lands after the release.
      let chain: Promise<void> = Promise.resolve();
      const then = (fn: () => Promise<void>) => (chain = chain.then(fn, fn).catch(() => {}));
      return {
        step: (leader, timeoutMs) =>
          then(async () => {
            const at = await procs.startOf(leader);
            // Only our own: a lock that another process took over after ours is its.
            if (at === null || (await readFile(file, "utf8").catch(() => null)) !== mine) return;
            const next = `${JSON.stringify({ v: 1, pid, start, step: { pid: leader, start: at, until: Date.now() + timeoutMs } })}\n`;
            // A new file beside it that then takes its name, so a reader never sees a part of one.
            const tmp = join(dir, `${UPDATE_LOCK}.${pid}.tmp`);
            await unlink(tmp).catch(() => {});
            try {
              const t = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
              try {
                await t.writeFile(next);
              } finally {
                await t.close();
              }
              await rename(tmp, file);
              mine = next;
            } catch {
              await unlink(tmp).catch(() => {});
            }
          }),
        release: () =>
          then(async () => {
            const now = await readFile(file, "utf8").catch(() => null);
            if (now === mine) await unlink(file).catch(() => {});
          }),
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST" && (e as NodeJS.ErrnoException).code !== "ELOOP") throw e;
    }
    const held = await readHolder(file);
    if (held !== "absent" && held !== null && (await lives(held, procs))) return null;
    await unlink(file).catch(() => {});
  }
  return null;
}

/**
 * install.sh's own lock (DESIGN-I1 2.8 and 3.3): the folder `<versions>/.lock`, made with mkdir, whose `pid` file names
 * the installer that runs (a `curl | sh`, an `sh install.sh`, or the Update button's). Held while that process lives
 * (kill -0: no such process is free, a process of another user is held); a lock with no pid file, or one that does not
 * read, is the installer's stale lock, which its next run takes over, so it is free here too.
 */
export function versionsLockHeld(versions: string): boolean {
  let text: string;
  try {
    const h = openSync(join(versions, ".lock", "pid"), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const buf = Buffer.alloc(32);
      text = buf.subarray(0, readSync(h, buf, 0, 32, 0)).toString("utf8");
    } finally {
      closeSync(h);
    }
  } catch {
    return false;
  }
  const m = /^([1-9][0-9]{0,9})\s*$/.exec(text);
  if (!m) return false;
  const pid = Number(m[1]);
  if (pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
