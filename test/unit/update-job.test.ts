// The Update button's job (owner row 108; DESIGN.md 4.10; server/update/job.ts, lock.ts, notice.ts), with a stand-in
// update source: one job at a time, and a second press joins the first; a refusal is its one line and starts nothing;
// no job while the restart drains or closes; the update lock, which bin/update.sh takes too, keeps a second updater out
// while its holder lives and is taken over from one that is gone; the job's end gives the lock back and checks origin
// again; each change is one update notice (the step line, the line of a job that did not finish with Update again,
// Restart to apply), and the restart's preflight refuses while an update runs. A step whose server was killed (kill -9,
// a crash) keeps the lock held while its process group lives within its deadline; past it, the next taker ends that
// group, as the dead server's deadline would have.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failedLine, runningLine, UPDATE_REFUSAL_LINES, UPDATE_WORDS, type UpdateJob, type UpdateRefusal, type UpdateStep } from "../../shared/update";
import { systemProcs } from "../../server/chats/stops";
import { createUpdateJobs } from "../../server/update/job";
import { lockHeld, takeLock, UPDATE_LOCK } from "../../server/update/lock";
import { noticeSender, standingUpdateNotice, updateNotice } from "../../server/update/notice";
import { preflight, PREFLIGHT_LINES } from "../../server/update/preflight";
import type { ApplyOptions, ApplyResult, UpdateSource } from "../../server/update/source";
import { UPDATE_LOG } from "../../server/update/steps";
import { createUpdates } from "../../server/update/updates";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "kitespan-update-job-")));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;

/** A source whose steps wait for the test: `go()` ends the step that runs, `fail(step)` ends the job there. */
function fakeSource(o: { refusal?: UpdateRefusal | null } = {}) {
  let release: ((r: ApplyResult | null) => void) | null = null;
  const applied: number[] = [];
  const src: UpdateSource = {
    check: async () => ({ kind: "none", failed: false }),
    refusal: async () => o.refusal ?? null,
    async apply(a: ApplyOptions) {
      applied.push(applied.length + 1);
      a.output !== "inherit" && a.output.line("fatal: https://user:pw@example.invalid/r.git");
      for (const step of ["fetch", "install", "build"] as UpdateStep[]) {
        a.onStep(step);
        const r = await new Promise<ApplyResult | null>((res) => {
          release = res;
          a.signal?.addEventListener("abort", () => res({ ok: false, step }), { once: true });
        });
        if (r) return r;
      }
      return { ok: true, head: "a".repeat(40) };
    },
  };
  return {
    src,
    applied,
    go: async () => {
      for (let i = 0; i < 100 && !release; i++) await Bun.sleep(5);
      const r = release!;
      release = null;
      r(null);
    },
    fail: async (step: UpdateStep, refusal?: UpdateRefusal) => {
      for (let i = 0; i < 100 && !release; i++) await Bun.sleep(5);
      const r = release!;
      release = null;
      r({ ok: false, step, ...(refusal ? { refusal } : {}) });
    },
  };
}

function setup(o: { refusal?: UpdateRefusal | null; restarting?: () => boolean } = {}) {
  const state = join(ROOT, `state-${++n}`);
  const logs = join(state, "logs");
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  const f = fakeSource(o);
  const seen: UpdateJob[] = [];
  const lines: unknown[] = [];
  let ended = 0;
  const jobs = createUpdateJobs({ source: f.src, state, logs, restarting: o.restarting ?? (() => false), ended: () => void ended++, log: { log: (ev, fl) => void lines.push([ev, fl]) } });
  jobs.onChange((j) => seen.push(j));
  return { ...f, state, logs, jobs, seen, lines, ended: () => ended };
}

describe("the job (row 108)", () => {
  test("one at a time: a second press joins the first; the steps reach the listeners; the end gives the lock back and checks again", async () => {
    const s = setup();
    const [a, b] = await Promise.all([s.jobs.start(), s.jobs.start()]);
    expect(a).toEqual({ ok: true, job: { state: "running", step: "fetch" } });
    expect(b).toEqual(a);
    expect(await s.jobs.start()).toEqual({ ok: true, job: { state: "running", step: "fetch" } });
    expect(s.applied).toEqual([1]);
    expect(existsSync(join(s.state, UPDATE_LOCK))).toBe(true);
    expect(await s.jobs.busy()).toBe(true);
    await s.go();
    await s.go();
    await s.go();
    await s.jobs.idle();
    expect(s.seen).toEqual([
      { state: "running", step: "fetch" },
      { state: "running", step: "install" },
      { state: "running", step: "build" },
      { state: "done" },
    ]);
    expect(existsSync(join(s.state, UPDATE_LOCK))).toBe(false);
    expect(await s.jobs.busy()).toBe(false);
    expect(s.ended()).toBe(1);
    expect(s.lines).toEqual([["update", { ok: true, ms: expect.any(Number), timeout: null }]]);
    // The log: a new file, the credential of the URL taken out.
    const log = readFileSync(join(s.logs, UPDATE_LOG), "utf8");
    expect(log).toContain("https://***@example.invalid/r.git");
    expect(log).not.toContain("pw@");
  });

  test("a finished update never shows Update available above Restart to apply: origin's line is none before done", async () => {
    let checks = 0;
    let answer!: () => void;
    const updates = await createUpdates({
      root: ROOT,
      dist: join(ROOT, "none"),
      dev: false,
      git: { git: null, env: {} },
      setting: async () => "manual",
      checkOnce: async () => {
        if (++checks === 1) return { kind: "available", failed: false };
        // The check after the job (up to 10 s on a network) answers only when the test says.
        await new Promise<void>((r) => (answer = r));
        return { kind: "none", failed: false };
      },
    });
    await updates.check();
    expect(updates.remote).toBe("available");
    const state = join(ROOT, `state-${++n}`);
    const logs = join(state, "logs");
    mkdirSync(logs, { recursive: true, mode: 0o700 });
    const f = fakeSource();
    const atDone: string[] = [];
    const jobs = createUpdateJobs({ source: f.src, state, logs, restarting: () => false, applied: () => updates.fastForwarded(), ended: () => void updates.check() });
    jobs.onChange((j) => {
      if (j.state === "done") atDone.push(updates.remote);
    });
    await jobs.start();
    await f.go();
    await f.go();
    await f.go();
    await jobs.idle();
    expect(atDone).toEqual(["none"]);
    expect((await updates.facts()).update).toBe("none");
    for (let i = 0; i < 100 && !answer; i++) await Bun.sleep(5);
    answer();
  });

  test("a step that fails: its line, with the step; Update can be pressed again", async () => {
    const s = setup();
    await s.jobs.start();
    await s.go();
    await s.fail("install");
    await s.jobs.idle();
    expect(s.jobs.view()).toEqual({ state: "failed", step: "install", line: failedLine("install") });
    expect(failedLine("install")).toBe("The update did not finish at step 2 of 3, install.");
    expect(await s.jobs.start()).toEqual({ ok: true, job: { state: "running", step: "fetch" } });
    expect(s.applied).toEqual([1, 2]);
    await s.fail("fetch", "diverged");
    await s.jobs.idle();
    expect(s.jobs.view()).toEqual({ state: "failed", step: "fetch", line: UPDATE_REFUSAL_LINES.diverged });
  });

  test("a refusal is its one line and starts nothing; none while the restart drains or closes", async () => {
    const s = setup({ refusal: "local_changes" });
    expect(await s.jobs.start()).toEqual({ ok: false, refusal: "local_changes", line: "This checkout has local changes." });
    expect(s.applied).toEqual([]);
    expect(s.seen).toEqual([]);
    const r = setup({ restarting: () => true });
    expect(await r.jobs.start()).toEqual({ ok: false, refusal: "restarting", line: "kitespan is restarting." });
    expect(r.applied).toEqual([]);
  });

  test("the update lock: a live holder (bin/update.sh) keeps the job out; one that is gone is taken over", async () => {
    const s = setup();
    // The test runner's parent stands in for a live bin/update.sh: its pid and start, read from /proc only.
    const start = await systemProcs.startOf(process.ppid);
    if (start === null) return;
    writeFileSync(join(s.state, UPDATE_LOCK), `${JSON.stringify({ v: 1, pid: process.ppid, start })}\n`, { mode: 0o600 });
    expect(await lockHeld(s.state)).toBe(true);
    expect(await s.jobs.start()).toEqual({ ok: false, refusal: "busy", line: "Another update is running." });
    expect(await s.jobs.busy()).toBe(true);
    // A pid with another start: the holder is gone.
    writeFileSync(join(s.state, UPDATE_LOCK), `${JSON.stringify({ v: 1, pid: process.ppid, start: "1@gone" })}\n`, { mode: 0o600 });
    expect(await lockHeld(s.state)).toBe(false);
    const lock = await takeLock(s.state);
    expect(lock).not.toBeNull();
    expect(await takeLock(s.state)).toBeNull();
    await lock!.release();
    expect(existsSync(join(s.state, UPDATE_LOCK))).toBe(false);
  });

  test("a shutdown ends the running step; the job does not finish", async () => {
    const s = setup();
    await s.jobs.start();
    s.jobs.stop();
    await s.jobs.idle();
    expect(s.jobs.view()).toEqual({ state: "failed", step: "fetch", line: failedLine("fetch") });
  });
});

describe("a step whose server is gone (row 108: a kill -9 during a step)", () => {
  /** A process group of this test's own (detached: its leader's pid is the group's id), recorded at its spawn. */
  const orphan = () => Bun.spawn(["sh", "-c", "sleep 30; :"], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const gone = (p: ReturnType<typeof orphan>, ms = 3_000) => Promise.race([p.exited.then(() => true), Bun.sleep(ms).then(() => false)]);
  /** A lock whose holder is gone (this pid, with another start) and whose step is `p`'s group. */
  async function orphanLock(state: string, p: ReturnType<typeof orphan>, untilMs: number) {
    const start = await systemProcs.startOf(p.pid);
    expect(start).not.toBeNull();
    writeFileSync(join(state, UPDATE_LOCK), `${JSON.stringify({ v: 1, pid: process.pid, start: "1@gone", step: { pid: p.pid, start, until: untilMs } })}\n`, { mode: 0o600 });
  }

  test("the lock stays held while the step's group lives within its deadline; it goes with the group", async () => {
    const s = setup();
    const p = orphan();
    try {
      await orphanLock(s.state, p, Date.now() + 60_000);
      expect(await lockHeld(s.state)).toBe(true);
      expect(await takeLock(s.state)).toBeNull();
      expect(await s.jobs.start()).toEqual({ ok: false, refusal: "busy", line: "Another update is running." });
      expect(await s.jobs.busy()).toBe(true);
      expect(s.applied).toEqual([]);
    } finally {
      p.kill("SIGKILL");
    }
    expect(await gone(p)).toBe(true);
    expect(await lockHeld(s.state)).toBe(false);
  });

  test("past its deadline, the next look ends the step's whole group and the lock is taken over", async () => {
    const s = setup();
    const p = orphan();
    try {
      await orphanLock(s.state, p, Date.now() - 1);
      const lock = await takeLock(s.state);
      expect(lock).not.toBeNull();
      expect(await gone(p)).toBe(true);
      await lock!.release();
    } finally {
      p.kill("SIGKILL");
    }
  });

  test("the job writes each step's group leader into the lock, with its start and deadline", async () => {
    const state = join(ROOT, `state-${++n}`);
    const logs = join(state, "logs");
    mkdirSync(logs, { recursive: true, mode: 0o700 });
    const p = orphan();
    let release!: () => void;
    const src: UpdateSource = {
      check: async () => ({ kind: "none", failed: false }),
      refusal: async () => null,
      async apply(a: ApplyOptions) {
        a.onStep("install");
        await a.onSpawn?.(p.pid, 60_000);
        await new Promise<void>((r) => (release = r));
        return { ok: false, step: "install" };
      },
    };
    const jobs = createUpdateJobs({ source: src, state, logs, restarting: () => false });
    try {
      await jobs.start();
      for (let i = 0; i < 100 && !release; i++) await Bun.sleep(5);
      const held = JSON.parse(readFileSync(join(state, UPDATE_LOCK), "utf8"));
      expect(held).toMatchObject({ v: 1, pid: process.pid, step: { pid: p.pid } });
      // The start that names the leader, as the lock's own check reads it: /proc's start ticks are exact, but without
      // /proc (macOS) a start comes from ps's elapsed whole seconds, so two reads of one process may differ a little.
      const now = await systemProcs.startOf(p.pid);
      expect(now).not.toBeNull();
      expect(systemProcs.sameStart(held.step.start, now!)).toBe(true);
      expect(held.step.until).toBeGreaterThan(Date.now() + 50_000);
      release();
      await jobs.idle();
      expect(existsSync(join(state, UPDATE_LOCK))).toBe(false);
    } finally {
      p.kill("SIGKILL");
    }
  });
});

describe("the update notice (row 108)", () => {
  test("the step line, a job that did not finish with Update again, Restart to apply, then origin's line", () => {
    expect(updateNotice("available", { state: "running", step: "install" })).toEqual({ text: "Updating kitespan: step 2 of 3, install.", id: "update" });
    expect(runningLine("fetch")).toBe("Updating kitespan: step 1 of 3, fetch.");
    expect(updateNotice("none", { state: "failed", step: "build", line: failedLine("build") })).toEqual({ text: "The update did not finish at step 3 of 3, build.", id: "update", actions: ["update"] });
    expect(updateNotice("diverged", { state: "failed", step: "fetch", line: UPDATE_REFUSAL_LINES.diverged })).toEqual({ text: UPDATE_REFUSAL_LINES.diverged, id: "update" });
    expect(updateNotice("none", { state: "done" })).toEqual({ text: UPDATE_WORDS.doneNotice, id: "update" });
    expect(updateNotice("available", { state: "idle" })).toEqual({ text: "Update available.", id: "update", actions: ["update"] });
    expect(updateNotice("diverged", { state: "idle" })).toEqual({ text: UPDATE_REFUSAL_LINES.diverged, id: "update" });
    expect(updateNotice("none", { state: "idle" })).toBeNull();
    // A page that says hello gets the job's line only, never origin's (welcome carries that).
    expect(standingUpdateNotice("available", { state: "idle" })).toEqual([]);
    expect(standingUpdateNotice("none", { state: "running", step: "build" })).toEqual([{ text: runningLine("build"), id: "update" }]);
  });

  test("each change is sent once; nothing is sent while there is nothing to say", () => {
    const sent: unknown[] = [];
    const send = noticeSender((x) => void sent.push(x));
    send(null);
    send(updateNotice("available", { state: "idle" }));
    send(updateNotice("available", { state: "idle" }));
    send(updateNotice("available", { state: "running", step: "fetch" }));
    send(null);
    expect(sent).toEqual([{ text: "Update available.", id: "update", actions: ["update"] }, { text: runningLine("fetch"), id: "update" }, null]);
    // A server that starts with origin's line kept (update.json): the pages have it from welcome, and its end is sent.
    const kept: unknown[] = [];
    const after = noticeSender((x) => void kept.push(x), updateNotice("available", { state: "idle" }));
    after(updateNotice("available", { state: "idle" }));
    after(updateNotice("none", { state: "idle" }));
    expect(kept).toEqual([null]);
  });

  test("the restart's preflight refuses while an update runs, with its one line, before any other check", async () => {
    const line = await preflight({ root: ROOT, dist: join(ROOT, "none"), dev: false, argv: [], env: {}, git: { git: null, env: {} }, logs: ROOT, updating: async () => true });
    expect(line).toBe(PREFLIGHT_LINES.updating);
    expect(line).toBe("An update is running.");
  });

  test("the preflight looks again after its check (which takes a while): an update that began meanwhile refuses it", async () => {
    let asks = 0;
    const logs = join(ROOT, `pf-again-${++n}`);
    mkdirSync(logs, { recursive: true });
    // dev skips the stamp; the system's true stands for `bun ... --check` and exits 0 (it is /usr/bin/true on macOS,
    // which has no /bin/true).
    const yes = Bun.which("true", { PATH: "/usr/bin:/bin" });
    expect(yes).not.toBeNull();
    const line = await preflight({ root: ROOT, dist: join(ROOT, "none"), dev: true, argv: [], env: {}, git: { git: null, env: {} }, logs, bun: yes!, updating: async () => ++asks > 1 });
    expect(asks).toBe(2);
    expect(line).toBe(PREFLIGHT_LINES.updating);
  });
});
