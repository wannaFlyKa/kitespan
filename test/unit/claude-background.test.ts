// R131 (DESIGN-R131 9.4, 9.7): the agent seam's methods for Claude Code's scripting commands, on the Claude driver,
// against the fake claude (never the real one). `claude agents --json --all` and `claude stop <id>` run as an argv array
// of the pinned binary, in the home folder, with the clean start environment, in their own process group, with a
// timeout and a capped output; one list run at a time, its answer kept about 5 s; only the rows whose id a chat's book
// holds; only on a Claude Code that is known to pick out both verbs before its root command (2.1.318 or later: below
// it, `stop <id>` could be a prompt, and a model turn). And the narrow read of a session's permission mode from its
// transcript's tail, under the SDK's own folder name for the session's folder.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_VIEW_SINCE, hasAgentView, parseAgentsJson, readPermissionMode, stopAnswerOf, transcriptSlug, type BgCliLimits } from "../../server/agents/claude/background";
import { createClaudeDriver } from "../../server/agents/claude/driver";
import { START_ENV } from "../../server/start-env-copy";
import { installFakeClaude, SHELL_OWN_ENV_NAMES, type FakeClaude, type Fixture, type TraceLine } from "../fake-claude/install";

const fakes: FakeClaude[] = [];
afterEach(() => {
  for (const f of fakes.splice(0)) f.cleanup();
});
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "claude-background-")));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const A = "7e682626";
const B = "8a56ad66";
const C = "0a1b2c3d";
const SID = "7e682626-781a-4916-b942-8fa4f25780e9";
/** The gate's own version: the first Claude Code checked to pick out `agents` and `stop` before its root command. */
const GATE_VERSION = "2.1.318 (Claude Code)";

/** A background row as `claude agents --json --all` prints one (2.1.318 printAgentsJson). */
const row = (id: string, over: Record<string, unknown> = {}) => ({
  pid: 2032935,
  id,
  cwd: "/srv/you/shop/worktrees/remove-negative-qty",
  kind: "background",
  startedAt: 1_762_300_000_000,
  sessionId: SID,
  name: "demo-remove-negative-qty-investigate",
  status: "busy",
  state: "working",
  ...over,
});

function setup(fixture: Fixture = {}, opts: { limits?: Partial<BgCliLimits>; pathEnv?: string } = {}) {
  const fake = installFakeClaude({ version: GATE_VERSION, agents: [row(A)], ...fixture });
  fakes.push(fake);
  const driver = createClaudeDriver({
    knownFolders: () => [fake.project],
    allowBypass: () => false,
    pathEnv: () => opts.pathEnv ?? fake.pathEnv,
    installRoot: fake.root,
    ...(opts.limits ? { bgLimits: opts.limits } : {}),
  });
  return { fake, driver };
}

const lines = (f: FakeClaude, t: string): TraceLine[] => f.trace().filter((l) => l.t === t);
const gone = (pid: unknown) => {
  try {
    process.kill(pid as number, 0);
    return false;
  } catch {
    return true;
  }
};

describe("claude agents --json --all", () => {
  test("the exact argv, in the home folder, with the clean start environment, in its own process group", async () => {
    // A name that comes into the server's environment after the start (as the SDK writes its own) never reaches it.
    process.env.KITESPAN_TEST_AFTER_START = "1";
    try {
      const { fake, driver } = setup();
      const list = await driver.listBackground(new Set([A]));
      expect(list?.rows.map((r) => r.id)).toEqual([A]);
      const [run] = lines(fake, "agents");
      expect(run!.args).toEqual(["agents", "--json", "--all"]);
      expect(run!.cwd).toBe(realpathSync(homedir()));
      if (run!.pgrp !== null) expect(run!.pgrp as number).toBe(run!.pid as number);
      const allowed = new Set([...Object.keys(START_ENV), ...SHELL_OWN_ENV_NAMES]);
      expect((run!.envNames as string[]).filter((n) => !allowed.has(n))).toEqual([]);
      expect(run!.envNames).not.toContain("KITESPAN_TEST_AFTER_START");
      expect(gone(run!.pid)).toBe(true);
    } finally {
      delete process.env.KITESPAN_TEST_AFTER_START;
    }
  });

  test("only the background rows of the asked ids, each by its rule; every other row is dropped", async () => {
    const { driver } = setup({
      agents: [
        row(A, { status: "waiting", waitingFor: "permission prompt", state: "blocked", name: `n${"x".repeat(300)}`, cwd: "relative/dir" }),
        row(B, { name: "another folder's worker" }),
        { pid: 1, cwd: "/srv/you/elsewhere", kind: "interactive", startedAt: 1, sessionId: SID, name: "demo-84", status: "idle" },
        row("NOTHEX00"),
        row(C, { state: "routine-ish", status: "thinking", waitingFor: "goal proposal", sessionId: "not-a-uuid", startedAt: "today" }),
        "not an object" as never,
      ],
    });
    const list = await driver.listBackground(new Set([A, C]));
    expect(list!.rows).toEqual([
      { id: A, sessionId: SID, name: `n${"x".repeat(119)}`, cwd: null, state: "blocked", status: "waiting", waitingFor: "permission prompt", startedAt: 1_762_300_000_000 },
      { id: C, sessionId: null, name: "demo-remove-negative-qty-investigate", cwd: "/srv/you/shop/worktrees/remove-negative-qty", state: null, status: "busy", waitingFor: null, startedAt: null },
    ]);
    expect(JSON.stringify(list)).not.toContain("another folder");
    expect(JSON.stringify(list)).not.toContain("demo-84");
    expect(list!.ran).toMatchObject({ code: 0 });
  });

  test("one run at a time, and its answer kept for about 5 s; an id the kept answer did not ask for runs again", async () => {
    const { fake, driver } = setup({ agentsWay: { delayMs: 200 } });
    const [x, y] = await Promise.all([driver.listBackground(new Set([A])), driver.listBackground(new Set([A]))]);
    expect(lines(fake, "agents").length).toBe(1);
    expect(x!.rows).toEqual(y!.rows);
    const kept = await driver.listBackground(new Set([A]));
    expect(kept!.ran).toBeNull();
    expect(kept!.at).toBe(x!.at);
    expect(lines(fake, "agents").length).toBe(1);
    const wider = await driver.listBackground(new Set([A, B]));
    expect(wider!.ran).not.toBeNull();
    expect(lines(fake, "agents").length).toBe(2);
  });

  test("bad JSON, not an array, a failed exit, agent view off: the list cannot be read", async () => {
    for (const way of [{ raw: "[{" }, { raw: '{"id":"7e682626"}\n' }, { exitCode: 3 }, { off: true }] as const) {
      const { driver } = setup({ agentsWay: way });
      expect(await driver.listBackground(new Set([A]))).toBeNull();
    }
  });

  test("an answer over the cap cannot be read, and its process ends", async () => {
    const { fake, driver } = setup({ agentsWay: { padBytes: 256 * 1024 } }, { limits: { stdoutBytes: 64 * 1024 } });
    expect(await driver.listBackground(new Set([A]))).toBeNull();
    await Bun.sleep(100);
    expect(gone(lines(fake, "agents")[0]!.pid)).toBe(true);
  });

  test("the timeout: the list cannot be read, and the process group is ended", async () => {
    const { fake, driver } = setup({ agentsWay: { delayMs: 10_000 } }, { limits: { agentsTimeoutMs: 400 } });
    const t0 = performance.now();
    expect(await driver.listBackground(new Set([A]))).toBeNull();
    expect(performance.now() - t0).toBeLessThan(5_000);
    await Bun.sleep(150);
    expect(gone(lines(fake, "agents")[0]!.pid)).toBe(true);
  });

  test("a Claude Code below the gate, or a version that cannot be read: no call at all, so no verb can become a prompt", async () => {
    expect(AGENT_VIEW_SINCE).toBe("2.1.296");
    // Each of these is a CLI whose root command would read `stop <id>` as a print-mode prompt (the fake's root command).
    for (const version of ["2.1.295 (Claude Code)", "2.1.196 (Claude Code)", "2.1.139 (Claude Code)", "2.1.138 (Claude Code)", "1.9.999 (Claude Code)", "not a version"]) {
      const { fake, driver } = setup({ version, verbs: ["agents"] });
      expect(await driver.listBackground(new Set([A]))).toBeNull();
      await expect(driver.stopBackground(A)).rejects.toMatchObject({ name: "DriverError", code: "unsupported" });
      expect(fake.trace().filter((l) => l.t !== "start" && l.t !== "version")).toEqual([]);
    }
  });

  test("the fake's own root command: a CLI without these verbs would run `stop <id>` as a prompt (why the gate holds)", async () => {
    const { fake } = setup({ verbs: [] });
    const run = Bun.spawnSync([fake.bin, "stop", A], { stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode).toBe(0);
    expect(lines(fake, "prompt")).toEqual([expect.objectContaining({ args: ["stop", A], print: true })]);
    expect(lines(fake, "stop")).toEqual([]);
    // An option that the root does not know is commander's error, so `agents --json` is no prompt on such a CLI.
    const list = Bun.spawnSync([fake.bin, "agents", "--json", "--all"], { stdout: "pipe", stderr: "pipe" });
    expect(list.exitCode).toBe(1);
    expect(new TextDecoder().decode(list.stderr)).toContain("unknown option '--json'");
    expect(lines(fake, "prompt").length).toBe(1);
  });

  test("no claude on PATH: the list cannot be read, and a stop is no_claude", async () => {
    const empty = join(ROOT, "empty-path");
    mkdirSync(empty, { recursive: true });
    const { driver } = setup({}, { pathEnv: empty });
    expect(await driver.listBackground(new Set([A]))).toBeNull();
    await expect(driver.stopBackground(A)).rejects.toMatchObject({ name: "DriverError", code: "no_claude" });
  });

  test("no id asked: nothing runs", async () => {
    const { fake, driver } = setup();
    expect(await driver.listBackground(new Set())).toEqual({ rows: [], at: expect.any(Number), ran: null });
    expect(lines(fake, "agents")).toEqual([]);
  });
});

describe("claude stop <id>", () => {
  test("the exact argv, the clean environment and the home folder; a known id answers stopped, and the list then says stopped", async () => {
    const { fake, driver } = setup({ stopWay: { worktree: "/srv/you/shop/.claude/worktrees/qty" } });
    expect(await driver.stopBackground(A)).toBe("stopped");
    const [run] = lines(fake, "stop");
    expect(run!.args).toEqual(["stop", A]);
    expect(run!.cwd).toBe(realpathSync(homedir()));
    if (run!.pgrp !== null) expect(run!.pgrp as number).toBe(run!.pid as number);
    const list = await driver.listBackground(new Set([A]));
    expect(list!.rows).toEqual([expect.objectContaining({ id: A, state: "stopped", status: null })]);
  });

  test("an id Claude Code does not know: not_found; one it could not confirm: failed; the timeout: failed", async () => {
    expect(await setup().driver.stopBackground(B)).toBe("not_found");
    expect(await setup({ stopWay: { answer: "unconfirmed" } }).driver.stopBackground(A)).toBe("failed");
    const slow = setup({ stopWay: { delayMs: 10_000 } }, { limits: { stopTimeoutMs: 400 } });
    expect(await slow.driver.stopBackground(A)).toBe("failed");
    await Bun.sleep(150);
    const [began] = lines(slow.fake, "stop");
    expect(gone(began!.pid)).toBe(true);
    expect(lines(slow.fake, "stop_answer")).toEqual([]);
  });

  test("an id that is not a short id is refused before any process starts", async () => {
    const { fake, driver } = setup();
    for (const id of ["--all", "7E682626", "7e68262", `${A} ${B}`, ""]) await expect(driver.stopBackground(id)).rejects.toMatchObject({ name: "DriverError", code: "bad_request" });
    expect(fake.trace()).toEqual([]);
  });

  test("the answer, read as Claude Code prints it", () => {
    const run = (code: number | null, stdout: string, stderr = "") => ({ code, stdout, stderr, timedOut: false, capped: false, failed: false });
    expect(stopAnswerOf(run(0, `stopped ${A}\n`), A)).toBe("stopped");
    expect(stopAnswerOf(run(0, `stopped ${A}\r\n  worktree retained at /x\n`), A)).toBe("stopped");
    expect(stopAnswerOf(run(0, `stopped ${B}\n`), A)).toBe("failed");
    expect(stopAnswerOf(run(1, "", `No job matching '${A}'. Run 'claude agents' to list running sessions.\n`), A)).toBe("not_found");
    expect(stopAnswerOf(run(1, "", `couldn't confirm ${A} was stopped — the background service may be restarting.\n`), A)).toBe("failed");
    expect(stopAnswerOf({ ...run(null, ""), timedOut: true }, A)).toBe("failed");
  });
});

describe("the pieces", () => {
  test("the version gate", () => {
    expect(hasAgentView("2.1.296 (Claude Code)")).toBe(true);
    expect(hasAgentView("2.1.317 (Claude Code)")).toBe(true);
    expect(hasAgentView("2.1.318 (Claude Code)")).toBe(true);
    expect(hasAgentView("2.1.319 (Claude Code)")).toBe(true);
    expect(hasAgentView("2.2.0")).toBe(true);
    expect(hasAgentView("3.0.1")).toBe(true);
    expect(hasAgentView("2.1.295 (Claude Code)")).toBe(false);
    expect(hasAgentView("2.1.139 (Claude Code)")).toBe(false);
    expect(hasAgentView("2.1.138 (Claude Code)")).toBe(false);
    expect(hasAgentView("2.0.999")).toBe(false);
    expect(hasAgentView(null)).toBe(false);
    expect(hasAgentView("Claude Code")).toBe(false);
  });

  test("the list's JSON: an array or nothing", () => {
    const ids = new Set([A]);
    expect(parseAgentsJson(`${JSON.stringify([row(A)], null, 2)}\n`, ids)).toHaveLength(1);
    expect(parseAgentsJson("", ids)).toBeNull();
    expect(parseAgentsJson("null", ids)).toBeNull();
    expect(parseAgentsJson("[]", ids)).toEqual([]);
  });
});

describe("the session's permission mode, from its transcript's tail", () => {
  const config = join(ROOT, "config");
  const file = (dir: string, sid: string) => join(config, "projects", transcriptSlug(dir), `${sid}.jsonl`);
  const put = (dir: string, sid: string, body: string) => {
    mkdirSync(join(config, "projects", transcriptSlug(dir)), { recursive: true });
    writeFileSync(file(dir, sid), body);
  };
  const pm = (mode: string) => JSON.stringify({ type: "permission-mode", permissionMode: mode, sessionId: SID });
  const msg = (n: number) => JSON.stringify({ type: "user", message: { role: "user", content: `line ${n} ${"p".repeat(200)}` }, sessionId: SID });

  test("the SDK's folder name: every character outside a-z, A-Z and 0-9 as a hyphen; past 200, cut and hashed", () => {
    expect(transcriptSlug("/srv/you/shop/worktrees/remove-negative-qty")).toBe("-srv-you-shop-worktrees-remove-negative-qty");
    const long = `/srv/${"deep/".repeat(60)}x`;
    const plain = long.replace(/[^a-zA-Z0-9]/g, "-");
    let h = 0;
    for (let i = 0; i < long.length; i++) h = (h << 5) - h + long.charCodeAt(i) | 0;
    expect(transcriptSlug(long)).toBe(`${plain.slice(0, 200)}-${Math.abs(h).toString(36)}`);
  });

  test("the last permission-mode record with a known mode wins; a half-written last line is skipped", async () => {
    const dir = "/srv/you/shop/worktrees/qty";
    put(dir, SID, [pm("default"), msg(1), pm("bypassPermissions"), msg(2), pm("dontAsk"), `{"type":"permission-mode","permissionMode":"pla`].join("\n"));
    expect(await readPermissionMode(config, [dir], SID)).toBe("bypassPermissions");
  });

  test("only the last 64 KiB is read: a record before it is not seen; none is null", async () => {
    const dir = "/srv/you/shop/worktrees/old";
    put(dir, SID, [pm("plan"), ...Array.from({ length: 400 }, (_, i) => msg(i))].join("\n") + "\n");
    expect(await readPermissionMode(config, [dir], SID)).toBeNull();
    put(dir, SID, [...Array.from({ length: 400 }, (_, i) => msg(i)), pm("acceptEdits")].join("\n") + "\n");
    expect(await readPermissionMode(config, [dir], SID)).toBe("acceptEdits");
  });

  test("the first folder that holds the file wins (the session's own, then its origin); a link or a missing file is none", async () => {
    const origin = "/srv/you/shop";
    put(origin, SID, pm("auto"));
    expect(await readPermissionMode(config, ["/srv/you/shop/.claude/worktrees/qty", origin], SID)).toBe("auto");
    const linked = "/srv/you/linked";
    mkdirSync(join(config, "projects", transcriptSlug(linked)), { recursive: true });
    symlinkSync(file(origin, SID), file(linked, SID));
    expect(await readPermissionMode(config, [linked], SID)).toBeNull();
    expect(await readPermissionMode(config, ["/srv/you/nothing"], SID)).toBeNull();
    expect(await readPermissionMode(config, [origin], "not-a-session")).toBeNull();
    expect(existsSync(file(origin, SID))).toBe(true);
  });

  test("the driver's read uses Claude Code's config folder, and the session's info has the transcript's size", async () => {
    const driver = createClaudeDriver({
      knownFolders: () => [],
      allowBypass: () => false,
      claudeConfigDir: config,
      sdk: { getSessionInfo: (async (id: string) => ({ sessionId: id, summary: "x", lastModified: 1_762_300_000_000, fileSize: 4096 })) as never },
    });
    expect(await driver.backgroundMode(SID, "/srv/you/shop")).toBe("auto");
    expect(await driver.sessionInfo(SID, "/srv/you/shop")).toMatchObject({ lastModified: 1_762_300_000_000, fileSize: 4096 });
  });
});
