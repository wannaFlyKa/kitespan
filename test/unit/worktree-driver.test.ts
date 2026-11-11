// The Claude driver with a chat's own worktree (build checklist W3, W5, L21, L34), through the SDK and the fake CLI:
// each chat's Claude Code starts in its worktree with `--project-config-root=<project folder>` as one argument;
// `system/init`'s cwd reaches the `session` event; a start-up refusal (`startup_failure_reason`) ends the process with
// its reason and Claude Code's first error line on `exit`, and no turn.
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { MARK_PHRASES, markOf } from "../../server/agents/types";
import { startupFailureOf } from "../../server/agents/claude/driver";
import { rig, type Rig } from "../fake-claude/harness";
import { git, scratch } from "./worktree-repo";

const s = scratch();
const WT_A = join(s.root, "wt-a");
const WT_B = join(s.root, "wt-b");
git(s.repo, "worktree", "add", "-q", "-b", "kitespan/aaaaaaaa", WT_A);
git(s.repo, "worktree", "add", "-q", "-b", "kitespan/bbbbbbbb", WT_B);
const rigs: Rig[] = [];
afterAll(async () => {
  for (const r of rigs) await r.cleanup();
  s.cleanup();
});
const use = (r: Rig) => (rigs.push(r), r);
const now = () => new Date();

describe("W3: each chat's Claude Code in its own worktree", () => {
  test("two chats: each fake's cwd is its worktree, and --project-config-root=<project folder> is one argument", async () => {
    const r = use(rig("text-thinking", { knownFolders: () => [s.repo] }));
    const a = r.open({ cwd: WT_A, worktree: { path: WT_A, root: s.repo, own: true } });
    const b = r.open({ cwd: WT_B, worktree: { path: WT_B, root: s.repo, own: true } });
    await a.chat.send({ uuid: randomUUID(), text: "Hi" });
    await b.chat.send({ uuid: randomUUID(), text: "Hi" });
    await a.events.turnEnds(1);
    await b.events.turnEnds(1);
    const starts = r.fake.trace().filter((l) => l.t === "start");
    expect(starts.map((l) => l.cwd).sort()).toEqual([WT_A, WT_B].sort());
    for (const st of starts) {
      const args = st.args as string[];
      expect(args).toContain(`--project-config-root=${s.repo}`);
      expect(args.filter((x) => x.startsWith("--project-config-root"))).toHaveLength(1);
    }
    // L34: system/init's cwd on the session event.
    expect(a.events.of("session")[0]!.cwd).toBe(WT_A);
    expect(b.events.of("session")[0]!.cwd).toBe(WT_B);
  });

  test("a chat in its project's folder gets no --project-config-root", async () => {
    const r = use(rig("text-thinking", { knownFolders: () => [s.repo] }));
    const c = r.open({ cwd: s.repo });
    await c.chat.send({ uuid: randomUUID(), text: "Hi" });
    await c.events.turnEnds(1);
    const args = r.fake.trace().find((l) => l.t === "start")!.args as string[];
    expect(args.some((x) => x.startsWith("--project-config-root"))).toBe(false);
  });
});

describe("W5: Claude Code's start-up refusals", () => {
  const LINE = "Error: cannot resume into worktree /x/wt: it failed its safety checks. This session was not started.";
  for (const [reason, expected] of [
    ["worktree_resume_refused", "worktree_resume_refused"],
    ["worktree_unverified", "worktree_unverified"],
    ["cwd_unavailable", "cwd_unavailable"],
    // The current docs name it; the pinned SDK does not: it reads as unknown.
    ["sandbox_required_unavailable", "unknown"],
  ] as const)
    test(`${reason}: the exit says so, with the first error line, and no turn ran`, async () => {
      const r = use(rig({ startupFailure: { reason, errors: [LINE, "second line"] } }, { knownFolders: () => [s.repo] }));
      const sid = randomUUID();
      const { chat, events } = r.open({ cwd: s.repo, sessionId: null, resume: { value: sid, mark: markOf(MARK_PHRASES.resume, now()) }, ledgerSessionId: sid });
      await chat.send({ uuid: randomUUID(), text: "Hi" }).catch(() => {});
      await events.until((ev) => ev.some((e) => e.k === "exit"));
      const exit = events.of("exit")[0]!;
      expect(exit.startup).toEqual({ reason: expected, line: LINE });
      expect(events.of("turn_end")).toEqual([]);
      expect(events.of("turn_start")).toEqual([]);
      // Nothing started again by itself.
      await Bun.sleep(300);
      expect(r.fake.trace().filter((l) => l.t === "start")).toHaveLength(1);
    });

  test("startupFailureOf reads only an error result that carries the field", () => {
    expect(startupFailureOf({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom"] })).toBeNull();
    expect(startupFailureOf({ type: "assistant", startup_failure_reason: "worktree_unverified" })).toBeNull();
    expect(startupFailureOf({ type: "result", startup_failure_reason: "worktree_unverified", errors: [] })).toEqual({ reason: "worktree_unverified", line: null });
    expect(startupFailureOf({ type: "result", startup_failure_reason: 7 })).toBeNull();
    expect(startupFailureOf({ type: "result", startup_failure_reason: "x", errors: ["a\u0007b"] })).toEqual({ reason: "unknown", line: "a b" });
  });
});

describe("the session lists and settings (W6, W12, L29, L31)", () => {
  const info = (sessionId: string, cwd: string, extra: Record<string, unknown> = {}) => ({ sessionId, summary: "s", lastModified: 1, fileSize: 1, firstPrompt: "hello", cwd, ...extra });

  test("Suggested maps a linked worktree to its main checkout, once", async () => {
    const r = use(
      rig("text-thinking", {
        knownFolders: () => [s.repo],
        sdk: { listSessions: (async () => [info(randomUUID(), WT_A), info(randomUUID(), s.repo), info(randomUUID(), WT_B)]) as never },
      }),
    );
    expect(await r.driver.sessionFolders()).toEqual([s.repo]);
  });

  test("a session's branch comes with its info; history and info read only the folder they get, never every folder", async () => {
    const sid = randomUUID();
    const asked: { op: string; dir: string | undefined }[] = [];
    const r = use(
      rig("text-thinking", {
        knownFolders: () => [s.repo],
        sdk: {
          getSessionInfo: (async (_id: string, o?: { dir?: string }) => {
            asked.push({ op: "info", dir: o?.dir });
            return o?.dir === WT_A ? info(sid, WT_A, { gitBranch: "kitespan/aaaaaaaa" }) : undefined;
          }) as never,
          getSessionMessages: (async (_id: string, o?: { dir?: string }) => {
            asked.push({ op: "messages", dir: o?.dir });
            return [];
          }) as never,
        },
      }),
    );
    expect(await r.driver.sessionInfo(sid, WT_A)).toMatchObject({ sessionId: sid, cwd: WT_A, gitBranch: "kitespan/aaaaaaaa" });
    // Nothing under the folder (a new chat's session before its first turn): no read of every folder follows.
    expect(await r.driver.sessionInfo(sid, s.repo)).toBeNull();
    expect((await r.driver.history(sid, s.repo, { before: null, maxBytes: 4096 })).events).toEqual([]);
    expect(asked).toEqual([
      { op: "info", dir: WT_A },
      { op: "info", dir: s.repo },
      { op: "messages", dir: s.repo },
    ]);
  });

  test("a WorktreeCreate hook in the settings is read (L29); none is no field", async () => {
    const hooked = use(rig("text-thinking", { sdk: { resolveSettings: (async () => ({ effective: { hooks: { WorktreeCreate: [{ hooks: [] }] } } })) as never, filterEscalatingDefaultMode: ((x: unknown) => x) as never } }));
    expect((await hooked.driver.settings(s.repo)).worktreeHook).toBe(true);
    const plain = use(rig("text-thinking", { sdk: { resolveSettings: (async () => ({ effective: { hooks: { PreToolUse: [] } } })) as never, filterEscalatingDefaultMode: ((x: unknown) => x) as never } }));
    expect("worktreeHook" in (await plain.driver.settings(s.repo))).toBe(false);
  });
});
