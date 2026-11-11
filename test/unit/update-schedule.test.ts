// The update check's schedule (owner row 108; DESIGN.md 4.10): Check for updates is Manually (no check by itself, at
// start or on a timer; Check now only), Daily (the default) or Every 3 hours (a check when the last one is older than
// that, then on that interval, with a few minutes of random spread). The last check's time is kept in the state
// folder's update.json, so a restart does not check again at once, and so is origin's commit that it read, so a
// restart shows the same line (read again by the ancestor rule, with no network); a change of the setting takes effect
// at once; a check records whether it read origin and why it could not look. The check itself is a stand-in here (the git check
// has its own tests in update-check.test.ts).

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpdateCheck } from "../../shared/update";
import { UPDATE_CHECK_EVERY_MS } from "../../shared/update";
import type { OriginCommit, RemoteCheck } from "../../server/update/remote";
import { CHECK_LIMITS, createUpdates, UPDATE_STATE } from "../../server/update/updates";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "kitespan-update-schedule-")));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const NO_GIT = { git: null, env: {} };
const T0 = Date.parse("2026-11-04T09:00:00.000Z");
const H = 60 * 60_000;
let n = 0;

async function until(pred: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await Bun.sleep(5);
}

/** A schedule on a state folder of its own (or the one given), with a stand-in check and a clock the test sets. */
async function schedule(o: { setting?: UpdateCheck; state?: string; at?: number; answer?: RemoteCheck; local?: (k: OriginCommit) => Promise<RemoteCheck> } = {}) {
  const state = o.state ?? join(ROOT, `state-${++n}`);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const clock = { now: o.at ?? T0 };
  let setting: UpdateCheck = o.setting ?? "daily";
  let answer: RemoteCheck = o.answer ?? { kind: "none", failed: false };
  const calls: number[] = [];
  const u = await createUpdates({
    root: ROOT,
    dist: join(ROOT, "no-dist"),
    dev: false,
    git: NO_GIT,
    state,
    setting: async () => setting,
    checkOnce: async () => {
      calls.push(clock.now);
      return answer;
    },
    ...(o.local ? { localOnce: o.local } : {}),
    now: () => clock.now,
    random: () => 0.5,
  });
  return {
    u,
    state,
    calls,
    clock,
    set: (s: UpdateCheck) => {
      setting = s;
    },
    answer: (a: RemoteCheck) => {
      answer = a;
    },
  };
}

const spread = Math.floor(0.5 * CHECK_LIMITS.spreadMs);

describe("Check for updates: the schedule (row 108)", () => {
  test("Daily, never checked: one check at start, kept in update.json (0600); the next one a day later, with spread", async () => {
    const s = await schedule();
    s.u.start();
    await until(() => s.calls.length === 1 && !s.u.checking);
    await s.u.settled();
    expect(s.calls).toEqual([T0]);
    const file = join(s.state, UPDATE_STATE);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ v: 1, at: new Date(T0).toISOString(), ok: true, why: null });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(s.u.next).toBe(T0 + UPDATE_CHECK_EVERY_MS.daily + spread);
    s.u.stop();
    expect(s.u.next).toBeNull();
  });

  test("a restart does not check again at once: the last check's time is read from update.json", async () => {
    const first = await schedule();
    first.u.start();
    await until(() => first.calls.length === 1 && !first.u.checking);
    first.u.stop();
    const again = await schedule({ state: first.state, at: T0 + H });
    again.u.start();
    await again.u.settled();
    await Bun.sleep(30);
    expect(again.calls).toEqual([]);
    expect(again.u.next).toBe(T0 + UPDATE_CHECK_EVERY_MS.daily + spread);
    expect(again.u.last).toEqual({ at: new Date(T0).toISOString(), ok: true, why: null });
    again.u.stop();
  });

  test("a restart keeps origin's line: the commit the last check read is kept, and read again at start with no network", async () => {
    const commit = "c".repeat(40);
    const origin: OriginCommit = { commit, ref: "refs/heads/main" };
    const first = await schedule({ answer: { kind: "available", failed: false, origin } });
    first.u.start();
    await until(() => first.calls.length === 1 && !first.u.checking);
    first.u.stop();
    expect(first.u.remote).toBe("available");
    expect(JSON.parse(readFileSync(join(first.state, UPDATE_STATE), "utf8"))).toEqual({ v: 1, at: new Date(T0).toISOString(), ok: true, why: null, origin });
    const asked: OriginCommit[] = [];
    const again = await schedule({ state: first.state, at: T0 + H, local: async (k) => (asked.push(k), { kind: "available", failed: false, origin: k }) });
    expect(asked).toEqual([origin]);
    expect(again.u.remote).toBe("available");
    expect(again.u.welcome()).toEqual({ available: true, kind: "available" });
    again.u.start();
    await again.u.settled();
    expect(again.calls).toEqual([]);
    again.u.stop();
    // Pulled meanwhile (the commit is in HEAD now): no line. A local read that fails: none either.
    const pulled = await schedule({ state: first.state, at: T0 + H, local: async () => ({ kind: "none", failed: false }) });
    expect(pulled.u.remote).toBe("none");
    const unread = await schedule({ state: first.state, at: T0 + H, local: async () => ({ kind: "none", failed: true }) });
    expect(unread.u.remote).toBe("none");
    // A check that read no commit (a failed read, no upstream) keeps none: the start reads nothing.
    const none = await schedule({ answer: { kind: "none", failed: true } });
    await none.u.check();
    const after = await schedule({ state: none.state, local: async (k) => (asked.push(k), { kind: "available", failed: false }) });
    expect(after.u.remote).toBe("none");
    expect(asked).toEqual([origin]);
  });

  test("Every 3 hours: due when the last check is older than 3 h, else 3 h after it", async () => {
    const first = await schedule({ setting: "3h" });
    first.u.start();
    await until(() => first.calls.length === 1 && !first.u.checking);
    first.u.stop();
    const soon = await schedule({ state: first.state, setting: "3h", at: T0 + H });
    soon.u.start();
    await soon.u.settled();
    expect(soon.calls).toEqual([]);
    expect(soon.u.next).toBe(T0 + UPDATE_CHECK_EVERY_MS["3h"] + spread);
    soon.u.stop();
    const late = await schedule({ state: first.state, setting: "3h", at: T0 + 4 * H });
    late.u.start();
    await until(() => late.calls.length === 1);
    expect(late.calls).toEqual([T0 + 4 * H]);
    late.u.stop();
  });

  test("Manually: no check at start and none on a timer; Check now checks and counts as the last check", async () => {
    const s = await schedule({ setting: "manual" });
    s.u.start();
    await s.u.settled();
    await Bun.sleep(30);
    expect(s.calls).toEqual([]);
    expect(s.u.next).toBeNull();
    expect(s.u.last).toBeNull();
    s.clock.now = T0 + 5 * H;
    expect(await s.u.check()).toBe("none");
    expect(s.calls).toEqual([T0 + 5 * H]);
    expect(s.u.last?.at).toBe(new Date(T0 + 5 * H).toISOString());
    await s.u.settled();
    expect(s.u.next).toBeNull();
    s.u.stop();
  });

  test("a change of the setting takes effect at once: Manually to Every 3 hours checks when due; Daily to Manually stops the timer", async () => {
    const s = await schedule({ setting: "manual" });
    s.u.start();
    await s.u.settled();
    s.set("3h");
    s.u.reload();
    await until(() => s.calls.length === 1 && !s.u.checking);
    await s.u.settled();
    expect(s.calls).toEqual([T0]);
    expect(s.u.next).toBe(T0 + UPDATE_CHECK_EVERY_MS["3h"] + spread);
    s.set("daily");
    s.u.reload();
    await s.u.settled();
    expect(s.u.next).toBe(T0 + UPDATE_CHECK_EVERY_MS.daily + spread);
    s.set("manual");
    s.u.reload();
    await s.u.settled();
    expect(s.u.next).toBeNull();
    s.u.stop();
  });

  test("Check now: the next check on the timer counts from it", async () => {
    const s = await schedule({ setting: "3h" });
    s.u.start();
    await until(() => s.calls.length === 1 && !s.u.checking);
    s.clock.now = T0 + 2 * H;
    await s.u.check();
    await s.u.settled();
    expect(s.u.next).toBe(T0 + 2 * H + UPDATE_CHECK_EVERY_MS["3h"] + spread);
    s.u.stop();
  });

  test("a check records why it could not look, and a failed read; origin's line changes reach the listeners once", async () => {
    const s = await schedule({ setting: "manual", answer: { kind: "none", failed: false, why: "no_upstream" } });
    const seen: string[] = [];
    s.u.onChange((k) => seen.push(k));
    await s.u.check();
    expect(s.u.last).toEqual({ at: new Date(T0).toISOString(), ok: true, why: "no_upstream" });
    s.answer({ kind: "none", failed: true });
    await s.u.check();
    expect(s.u.last).toEqual({ at: new Date(T0).toISOString(), ok: false, why: null });
    s.answer({ kind: "available", failed: false });
    await s.u.check();
    await s.u.check();
    expect(s.u.welcome()).toEqual({ available: true, kind: "available" });
    expect(seen).toEqual(["available"]);
  });

  test("a stop (the restart's close) clears the timer; start again resumes it", async () => {
    const s = await schedule();
    s.u.start();
    await until(() => s.calls.length === 1 && !s.u.checking);
    await s.u.settled();
    s.u.stop();
    expect(s.u.next).toBeNull();
    s.u.start();
    await s.u.settled();
    expect(s.u.next).toBe(T0 + UPDATE_CHECK_EVERY_MS.daily + spread);
    s.u.stop();
  });
});
