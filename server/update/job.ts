// The Update button's job on the server (DESIGN.md 4.10, owner row 108): one at a time, and a second press, from any
// device, joins the first. It runs the update source's steps (source.ts) in the background while the server goes on
// serving its own page, with its output in logs/update.log (steps.ts), and every change of it reaches every page as the
// update notice (main.ts). It never restarts and never starts by itself: a job starts only from POST /api/update.
//
// Before the first step: no job while the restart drains or closes (and the restart's preflight refuses while a job
// runs, so neither cuts the other), the source's refusals (local changes, no checkout, no upstream, dev mode: one line
// each), and the update lock in the state folder (lock.ts), which bin/update.sh takes too. When the steps end well,
// origin's line goes before the job is done (the fetch's commit is in HEAD now), so no page shows Update available
// above Restart to apply; when the job ends it gives the lock back, and the check of origin runs again.

import type { UpdateJob, UpdateRefusal, UpdateStep } from "../../shared/update";
import { failedLine, UPDATE_REFUSAL_LINES } from "../../shared/update";
import type { Logger } from "../log";
import { lockHeld, takeLock, type UpdateLock } from "./lock";
import type { UpdateSource } from "./source";
import { openUpdateLog } from "./steps";

export type StartAnswer = { ok: true; job: UpdateJob } | { ok: false; refusal: UpdateRefusal; line: string };

export interface UpdateJobs {
  view(): UpdateJob;
  /** A job runs now on this server. */
  readonly running: boolean;
  /** A job runs, here or in bin/update.sh (a live holder of the lock): the restart's preflight refuses then. */
  busy(): Promise<boolean>;
  /** POST /api/update: the job starts, or the running one is joined; else the refusal's line. */
  start(): Promise<StartAnswer>;
  /** Each change of the job. */
  onChange(fn: (job: UpdateJob) => void): () => void;
  /** A shutdown: the running step's group is killed and no step follows. */
  stop(): void;
  /** Resolves when no job runs (tests). */
  idle(): Promise<void>;
}

export interface JobOptions {
  source: UpdateSource;
  /** The state folder: the lock. */
  state: string;
  /** The state folder's logs/: update.log. */
  logs: string;
  /** A restart is asked, drains or closes now: no job starts. */
  restarting: () => boolean;
  /** The steps ended well, just before the job is done: origin's commit that the fetch read is in HEAD now. */
  applied?: () => void;
  /** After a job ends (the check of origin again). */
  ended?: () => void;
  /**
   * Another updater runs that holds no update lock (a release install: install.sh's own lock, DESIGN-I1 3.3), so the
   * restart's preflight and its close's last look wait for it too. Absent: none.
   */
  held?: () => boolean | Promise<boolean>;
  log?: Pick<Logger, "log"> | null;
  now?: () => number;
}

export function createUpdateJobs(o: JobOptions): UpdateJobs {
  let job: UpdateJob = { state: "idle" };
  let run: Promise<void> | null = null;
  let starting: Promise<StartAnswer> | null = null;
  let abort: AbortController | null = null;
  const listeners = new Set<(job: UpdateJob) => void>();
  const now = o.now ?? Date.now;

  const set = (next: UpdateJob) => {
    job = next;
    for (const fn of listeners) fn(job);
  };
  const refused = (refusal: UpdateRefusal): StartAnswer => ({ ok: false, refusal, line: UPDATE_REFUSAL_LINES[refusal] });

  async function begin(): Promise<StartAnswer> {
    if (o.restarting()) return refused("restarting");
    const why = await o.source.refusal();
    if (why) return refused(why);
    let lock: UpdateLock | null;
    try {
      lock = await takeLock(o.state);
    } catch {
      lock = null;
    }
    if (!lock) return refused("busy");
    // The restart may have begun while the refusals ran.
    if (o.restarting()) {
      await lock.release();
      return refused("restarting");
    }
    const t0 = now();
    const out = openUpdateLog(o.logs);
    abort = new AbortController();
    let step: UpdateStep = "fetch";
    set({ state: "running", step });
    run = o.source
      .apply({
        onStep: (s) => {
          step = s;
          if (job.state === "running" && job.step !== s) set({ state: "running", step: s });
        },
        output: out,
        signal: abort.signal,
        // Its group outlives this server if it is killed: the lock stays held while the step lives (lock.ts).
        onSpawn: (pid, ms) => lock!.step(pid, ms),
      })
      .then(
        (r) => {
          if (r.ok) {
            o.applied?.();
            set({ state: "done" });
          } else set({ state: "failed", step: r.step, line: r.refusal ? UPDATE_REFUSAL_LINES[r.refusal] : failedLine(r.step) });
          o.log?.log("update", { ok: r.ok, ms: now() - t0, timeout: r.ok ? null : r.timeout === true });
        },
        () => {
          set({ state: "failed", step, line: failedLine(step) });
          o.log?.log("update", { ok: false, ms: now() - t0 });
        },
      )
      .finally(async () => {
        out.close();
        await lock!.release().catch(() => {});
        abort = null;
        run = null;
        o.ended?.();
      });
    return { ok: true, job };
  }

  return {
    view: () => job,
    get running() {
      return job.state === "running";
    },
    async busy() {
      if (job.state === "running" || starting) return true;
      if (await Promise.resolve(o.held?.() ?? false).catch(() => false)) return true;
      return lockHeld(o.state).catch(() => false);
    },
    start() {
      if (job.state === "running") return Promise.resolve({ ok: true, job });
      // Two presses at once: the second waits for the first's refusals, then joins its job (or gets its refusal).
      starting ??= begin().finally(() => {
        starting = null;
      });
      return starting;
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    stop() {
      abort?.abort();
    },
    async idle() {
      while (starting || run) await (starting ?? run);
    },
  };
}
