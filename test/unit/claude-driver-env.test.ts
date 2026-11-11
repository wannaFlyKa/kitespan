// D60 through the real Agent SDK and the fake CLI (build checklist E3, E7, G2, L37, L38): a chat's Claude Code gets the
// start environment with the environment's variables over it; the fake proves a value by its SHA-256 only. The stderr
// tail masks each stored value; last-options.json keeps names only; the short read gets the variables, and a read with
// them is the environment's own. No model, no real claude.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { checkOptions, SDK_CHILD_ENV } from "../../server/agents/claude/options";
import { MARK_PHRASES, markOf, type EnvVar } from "../../server/agents/types";
import { START_ENV } from "../../server/start-env-copy";
import { loadFixture, SHELL_OWN_ENV_NAMES, type TraceLine } from "../fake-claude/install";
import { rig, type Rig } from "../fake-claude/harness";

let rigs: Rig[] = [];
afterEach(async () => {
  await Promise.all(rigs.map((r) => r.cleanup()));
  rigs = [];
});
const use = (r: Rig) => (rigs.push(r), r);

const SECRET = "planted-driver-env-value-Z3";
const NAME = "KITESPAN_ENV_LANE_VAR";
const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
const marked = (vars: EnvVar[]) => ({ value: vars, mark: markOf(MARK_PHRASES.env, new Date()) });
const shellOwn = (names: readonly string[]) => names.filter((n) => !SHELL_OWN_ENV_NAMES.includes(n));

describe("a chat's start with variables (E3)", () => {
  test("the child's names are the start environment's, the SDK's added ones and the environment's; the value arrives", async () => {
    const r = use(rig({ ...loadFixture("text-thinking"), envHash: [NAME, "KITESPAN_LATE_NAME"] }));
    // A name that the server's process.env gets after the start environment was copied never reaches the child.
    process.env.KITESPAN_LATE_NAME = "late";
    try {
      const { chat, events } = r.open({ env: marked([{ name: NAME, value: SECRET }]) });
      await chat.send({ uuid: randomUUID(), text: "Hi" });
      await events.turnEnds(1);
    } finally {
      delete process.env.KITESPAN_LATE_NAME;
    }
    const start = r.fake.trace().find((l: TraceLine) => l.t === "start")!;
    const removed: readonly string[] = SDK_CHILD_ENV.removed;
    const startNames = Object.keys(START_ENV).filter((n) => typeof START_ENV[n] === "string" && !removed.includes(n));
    const expected = [...new Set([...startNames, ...SDK_CHILD_ENV.added, NAME])].sort();
    expect(shellOwn(start.envNames as string[])).toEqual(shellOwn(expected));
    expect(start.envHashes).toEqual({ [NAME]: sha(SECRET), KITESPAN_LATE_NAME: null });
    expect(readFileSync(r.fake.tracePath, "utf8")).not.toContain(SECRET);
  });

  test("last-options.json keeps names only, and the gate passes on it (G2)", async () => {
    const r = use(rig("text-thinking"));
    const vars = [{ name: NAME, value: SECRET }];
    const { chat, events } = r.open({ env: marked(vars) });
    await chat.send({ uuid: randomUUID(), text: "Hi" });
    await events.turnEnds(1);
    const rec = r.lastOptions[0] as { options: Record<string, unknown>; marks: Record<string, string> };
    expect(rec.options.env).toEqual({ "[inherited]": true, [NAME]: "[set]" });
    expect(rec.marks.env).toStartWith(`${MARK_PHRASES.env} on `);
    expect(JSON.stringify(rec)).not.toContain(SECRET);
    for (const v of Object.values(START_ENV)) if (v && v.length > 12) expect(JSON.stringify(rec)).not.toContain(JSON.stringify(v));
    const ctx = { pinnedPath: r.fake.bin, knownFolders: [r.fake.project], platformPackages: [], allowBypass: false, promptSuggestionEnabled: false, ledgerSessionId: rec.options.sessionId as string, sessionExists: false, startEnv: START_ENV, envVars: vars };
    expect(checkOptions(rec.options, rec.marks, ctx)).toEqual([]);
    expect(chat.optionsSnapshot.env).toEqual({ "[inherited]": true, [NAME]: "[set]" });
  });

  test("an environment with no variables starts exactly as before: no env key", async () => {
    const r = use(rig("text-thinking"));
    const { chat, events } = r.open({ env: null });
    await chat.send({ uuid: randomUUID(), text: "Hi" });
    await events.turnEnds(1);
    expect("env" in (r.lastOptions[0] as { options: Record<string, unknown> }).options).toBe(false);
  });
});

describe("the stderr tail of an exit (E7)", () => {
  test("each stored value of 4 or more characters reads as the mask; a shorter one stays", async () => {
    const long = "y".repeat(600);
    const r = use(rig({ startup: { stderr: [`auth failed for ${SECRET} at the provider`, `x${long}`, "short abc", `${SECRET}`], exitCode: 1 } }));
    const { events } = r.open({ env: marked([{ name: NAME, value: SECRET }, { name: "SHORT_ONE", value: "abc" }, { name: "LONG_ONE", value: long }]) });
    const ev = await events.until((e) => e.some((x) => x.k === "exit"));
    const exit = ev.find((e) => e.k === "exit") as { stderr: string[] };
    expect(exit.stderr).toEqual(["auth failed for •••••••• at the provider", "x••••••••", "short abc", "••••••••"]);
    expect(JSON.stringify(exit)).not.toContain(SECRET);
  });

  test("a value that the end of a stderr chunk cuts in two reads as the mask, on one line; so does one the exit cuts", async () => {
    const half = SECRET.length >> 1;
    const parts = [`auth failed for ${SECRET.slice(0, half)}`, `${SECRET.slice(half)} at the provider\n`, `cut by the exit ${SECRET.slice(0, half)}`];
    const r = use(rig({ startup: { stderrParts: parts, exitCode: 1 } }));
    const { events } = r.open({ env: marked([{ name: NAME, value: SECRET }]) });
    const ev = await events.until((e) => e.some((x) => x.k === "exit"));
    const exit = ev.find((e) => e.k === "exit") as { stderr: string[] };
    expect(exit.stderr).toEqual(["auth failed for •••••••• at the provider", "cut by the exit ••••••••"]);
    expect(JSON.stringify(exit)).not.toContain(SECRET.slice(0, half));
    expect(JSON.stringify(exit)).not.toContain(SECRET.slice(half));
  });

  test("Claude Code's start-up refusal line masks each stored value too (W5)", async () => {
    const line = `Error: cannot resume into worktree /x/${SECRET}: it failed its safety checks.`;
    const r = use(rig({ startupFailure: { reason: "worktree_resume_refused", errors: [line] } }));
    const { events } = r.open({ env: marked([{ name: NAME, value: SECRET }]) });
    const ev = await events.until((e) => e.some((x) => x.k === "exit"));
    const exit = ev.find((e) => e.k === "exit") as { startup?: { reason: string; line: string | null } };
    expect(exit.startup).toEqual({ reason: "worktree_resume_refused", line: "Error: cannot resume into worktree /x/••••••••: it failed its safety checks." });
    expect(JSON.stringify(ev)).not.toContain(SECRET);
  });
});

describe("the short read gets the variables (L38) and is the environment's own (L37)", () => {
  test("a read with variables starts its own Claude Code with them; a read without starts another, without them", async () => {
    const r0 = use(rig("text-thinking"));
    mkdirSync(join(r0.fake.root, "other"), { recursive: true });
    const other = realpathSync(join(r0.fake.root, "other"));
    const r = use(rig({ ...loadFixture("text-thinking"), envHash: [NAME], initializeDelayMs: 400 }, { knownFolders: () => [r.fake.project, other] }));
    const [withVars, without] = await Promise.all([r.driver.readModels(r.fake.project, marked([{ name: NAME, value: SECRET }])), r.driver.readModels(other)]);
    expect(withVars.length).toBeGreaterThan(0);
    expect(without.length).toBeGreaterThan(0);
    const starts = r.fake.trace().filter((l) => l.t === "start");
    expect(starts).toHaveLength(2);
    const hashes = starts.map((s) => (s.envHashes as Record<string, string | null>)[NAME]).sort();
    expect(hashes).toEqual([sha(SECRET), null].sort() as never);
    expect(readFileSync(r.fake.tracePath, "utf8")).not.toContain(SECRET);
    // The command read takes them too.
    await r.driver.readCommands(r.fake.project, marked([{ name: NAME, value: SECRET }]));
    const third = r.fake.trace().filter((l) => l.t === "start")[2]!;
    expect((third.envHashes as Record<string, string | null>)[NAME]).toBe(sha(SECRET));
  });

  test("a read without variables still takes one that runs for any folder without them", async () => {
    const r0 = use(rig("text-thinking"));
    mkdirSync(join(r0.fake.root, "other"), { recursive: true });
    const real = realpathSync(join(r0.fake.root, "other"));
    const r = use(rig({ ...loadFixture("text-thinking"), initializeDelayMs: 300 }, { knownFolders: () => [r.fake.project, real] }));
    await Promise.all([r.driver.readModels(r.fake.project), r.driver.readModels(real)]);
    expect(r.fake.trace().filter((l) => l.t === "start")).toHaveLength(1);
  });

  test("row 94's windows come from the same process as the list: with the variables, its own; without, never that one", async () => {
    const r0 = use(rig("text-thinking"));
    mkdirSync(join(r0.fake.root, "other"), { recursive: true });
    const other = realpathSync(join(r0.fake.root, "other"));
    const r = use(rig({ ...loadFixture("text-thinking"), model: "claude-sonnet-5-5", envHash: [NAME], initializeDelayMs: 300, contextWindows: { "claude-sonnet-5-5": 500_000, "claude-fake-1": 1_000_000 } }, { knownFolders: () => [r.fake.project, other] }));
    const env = marked([{ name: NAME, value: SECRET }]);
    const [list, windows, hostWindows] = await Promise.all([r.driver.readModels(r.fake.project, env), r.driver.readWindows(r.fake.project, env), r.driver.readWindows(other)]);
    expect(list.map((m) => m.value)).toEqual(["default", "claude-fake-1"]);
    expect(windows).toEqual({ default: 500_000, "claude-fake-1": 1_000_000 });
    expect(hostWindows).toEqual(windows);
    const starts = r.fake.trace().filter((l) => l.t === "start");
    expect(starts).toHaveLength(2);
    expect(starts.map((s) => (s.envHashes as Record<string, string | null>)[NAME]).sort()).toEqual([sha(SECRET), null].sort() as never);
    expect(readFileSync(r.fake.tracePath, "utf8")).not.toContain(SECRET);
  });
});

describe("the names of the user's own settings env (E5's inSettings)", () => {
  test("names only, from resolveSettings; none when it has none or fails", async () => {
    const r = use(rig("text-thinking", { sdk: { resolveSettings: (async () => ({ effective: { env: { FROM_SETTINGS: SECRET, OTHER: "x" } } })) as never } }));
    const names = await r.driver.settingsEnvNames(r.fake.project);
    expect(names).toEqual(["FROM_SETTINGS", "OTHER"]);
    const none = use(rig("text-thinking", { sdk: { resolveSettings: (async () => ({ effective: {} })) as never } }));
    expect(await none.driver.settingsEnvNames(none.fake.project)).toEqual([]);
  });
});
