// R127: the agent seam's one trust method on the Claude driver, against the fake claude (never the real one). The trust
// start is one query() in the folder with the attestation and no message: the fake learns `workspaceTrust` in the
// initialize request and answers `workspace_trust_recorded`. Every answer: recorded true, false, absent; a late answer
// past the cap, an exit before the answer, no claude on PATH, and the shutdown's endReads all end it with its process
// gone. A chat's start and the short reads never send the attestation.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createClaudeDriver } from "../../server/agents/claude/driver";
import { TRUST_SETTING_SOURCES_OFF } from "../../server/agents/claude/trust";
import { installFakeClaude, type FakeClaude, type Fixture, type TraceLine } from "../fake-claude/install";
import { rig, type Rig } from "../fake-claude/harness";

const fakes: FakeClaude[] = [];
const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
  for (const f of fakes.splice(0)) f.cleanup();
});

/** A fake claude and a driver whose PATH holds only it; `folder` is a new nested folder under the fake's root. */
function setup(fixture: Fixture = {}, opts: { trustReadMs?: number; pathEnv?: string } = {}) {
  const fake = installFakeClaude(fixture);
  fakes.push(fake);
  const folder = join(fake.root, "shop", "tasks", "remove-negative-qty");
  mkdirSync(folder, { recursive: true });
  const driver = createClaudeDriver({
    knownFolders: () => [fake.project],
    allowBypass: () => false,
    pathEnv: () => opts.pathEnv ?? fake.pathEnv,
    installRoot: fake.root,
    closeWaitMs: 4_000,
    ...(opts.trustReadMs ? { trustReadMs: opts.trustReadMs } : {}),
  });
  return { fake, driver, folder: realpathSync(folder) };
}

const starts = (f: FakeClaude): TraceLine[] => f.trace().filter((l) => l.t === "start");
const initializes = (f: FakeClaude) => f.trace().filter((l) => l.t === "control" && l.subtype === "initialize");
/** No fake claude of this test runs any more (each one traces its pid at start). */
function noneAlive(f: FakeClaude): boolean {
  return starts(f).every((s) => {
    try {
      process.kill(s.pid as number, 0);
      return false;
    } catch {
      return true;
    }
  });
}

describe("the trust start", () => {
  test("recorded: the attestation for the folder in initialize, in that folder, with no message and no session option", async () => {
    const { fake, driver, folder } = setup();
    expect(driver.capabilities().trustFolder).toBe(true);
    expect(await driver.trustFolder(folder)).toEqual({ recorded: true });
    const [start] = starts(fake);
    expect(start!.cwd).toBe(folder);
    const args = start!.args as string[];
    for (const flag of ["--model", "--resume", "--session-id", "--system-prompt", "--append-system-prompt", "--permission-mode", "--fork-session", "--mcp-config"])
      expect(args.some((a) => a === flag || a.startsWith(`${flag}=`))).toBe(false);
    if (TRUST_SETTING_SOURCES_OFF) expect(args.some((a) => a === "--setting-sources" || a === "--setting-sources=")).toBe(true);
    const [init] = initializes(fake);
    expect((init!.request as Record<string, unknown>).workspaceTrust).toEqual({ accepted: true, directory: folder });
    expect(fake.trace().some((l) => l.t === "trust_recorded" && l.directory === folder)).toBe(true);
    // No user message, so no turn.
    expect(fake.trace().filter((l) => l.t === "user" || l.t === "turn_start")).toEqual([]);
    expect(noneAlive(fake)).toBe(true);
  });

  test("Claude Code answers false: not recorded", async () => {
    const { driver, folder } = setup({ workspaceTrust: { recorded: false } });
    expect(await driver.trustFolder(folder)).toEqual({ recorded: false });
  });

  test("Claude Code answers without the field (an older CLI): not recorded", async () => {
    const { driver, folder } = setup({ workspaceTrust: { recorded: null } });
    expect(await driver.trustFolder(folder)).toEqual({ recorded: false });
  });

  test("a directory that is not the session's own records nothing (the fake's rule, as the CLI's schema says)", async () => {
    // The driver always attests its own cwd; the fake's default rule is checked here through its answer for that.
    const { fake, driver, folder } = setup();
    await driver.trustFolder(folder);
    const wt = fake.trace().find((l) => l.t === "workspace_trust")!;
    expect([wt.attested, wt.directory, wt.cwd]).toEqual([true, folder, folder]);
  });

  test("an answer later than the cap: failed, and the process is closed", async () => {
    const { fake, driver, folder } = setup({ workspaceTrust: { delayMs: 3_000 } }, { trustReadMs: 300 });
    const t0 = Date.now();
    await expect(driver.trustFolder(folder)).rejects.toMatchObject({ name: "DriverError", code: "failed" });
    expect(Date.now() - t0).toBeLessThan(2_900);
    expect(noneAlive(fake)).toBe(true);
    expect(fake.trace().some((l) => l.t === "trust_recorded")).toBe(false);
  });

  test("Claude Code exits before it answers: failed", async () => {
    const { fake, driver, folder } = setup({ workspaceTrust: { exitCode: 1 } });
    await expect(driver.trustFolder(folder)).rejects.toMatchObject({ name: "DriverError", code: "failed" });
    expect(noneAlive(fake)).toBe(true);
  });

  test("no claude on PATH: no_claude, and nothing starts", async () => {
    const { fake, driver, folder } = setup({}, { pathEnv: join(realpathSync("/"), "nonexistent-bin-for-test") });
    await expect(driver.trustFolder(folder)).rejects.toMatchObject({ name: "DriverError", code: "no_claude" });
    expect(starts(fake)).toEqual([]);
  });

  test("a folder that is not its real path is refused by the start's own check before anything starts", async () => {
    const { fake, driver, folder } = setup();
    await expect(driver.trustFolder(`${folder}/../remove-negative-qty`)).rejects.toMatchObject({ name: "TrustGateError" });
    expect(starts(fake)).toEqual([]);
  });

  test("endReads (the shutdown, a restart) ends a trust start in flight: failed, once its process has exited", async () => {
    const { fake, driver, folder } = setup({ workspaceTrust: { delayMs: 10_000 } });
    const run = driver.trustFolder(folder);
    await fake.waitFor((l) => l.t === "workspace_trust");
    const t0 = Date.now();
    await driver.endReads();
    await expect(run).rejects.toMatchObject({ code: "failed" });
    expect(Date.now() - t0).toBeLessThan(9_000);
    expect(noneAlive(fake)).toBe(true);
  });

  test("an aborted signal ends it too", async () => {
    const { driver, folder } = setup({ workspaceTrust: { delayMs: 10_000 } });
    const ac = new AbortController();
    const run = driver.trustFolder(folder, ac.signal);
    setTimeout(() => ac.abort(), 200);
    await expect(run).rejects.toMatchObject({ code: "failed" });
  });
});

describe("a chat never sends it", () => {
  test("a chat's start and its turn: no attestation in initialize, and no trust_recorded", async () => {
    const r = rig("text-thinking");
    rigs.push(r);
    const { chat, events } = r.open();
    await chat.send({ uuid: crypto.randomUUID(), text: "hello" });
    await events.turnEnds(1);
    const inits = r.fake.trace().filter((l) => l.t === "control" && l.subtype === "initialize");
    expect(inits.length).toBe(1);
    expect("workspaceTrust" in (inits[0]!.request as Record<string, unknown>)).toBe(false);
    expect(r.fake.trace().some((l) => l.t === "workspace_trust" || l.t === "trust_recorded")).toBe(false);
    expect(JSON.stringify(chat.optionsSnapshot)).not.toContain("workspaceTrust");
  });

  test("the short read of the command list: no attestation either", async () => {
    const { fake, driver } = setup();
    await driver.readCommands(fake.project);
    const inits = initializes(fake);
    expect(inits.length).toBe(1);
    expect("workspaceTrust" in (inits[0]!.request as Record<string, unknown>)).toBe(false);
    expect(fake.trace().some((l) => l.t === "trust_recorded")).toBe(false);
  });
});

describe("the capability", () => {
  test("on with the pinned SDK (an untyped option, D6)", () => {
    const { driver } = setup();
    expect(driver.capabilities()).toMatchObject({ trustFolder: true, sideQuestions: true });
  });
});
