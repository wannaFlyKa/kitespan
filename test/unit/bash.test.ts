// `!` commands (DESIGN.md 4.1, 6.4, D10, D20, O-L5): the chat's folder, the shell, the limits, the record string, the
// reply rule, and a timeout that ends the children too (the command runs in its own process group).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASH_LIMITS, bashInputProblem, bashRecordText, bashShouldReply, parseBashRecord, runBash, SPAWN_FAILED, timeoutNote } from "../../server/agents/claude/bash";

const DIR = realpathSync(mkdtempSync(join(tmpdir(), "bash-test-")));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));
const SH = "/bin/sh";
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("the limits and the input check", () => {
  test("the limits are D20's", () => {
    expect(BASH_LIMITS).toMatchObject({ timeoutMs: 120_000, streamChars: 30_000, inputChars: 10_000 });
  });
  test("an empty command or one over 10,000 characters is refused; 10,000 passes", () => {
    expect(bashInputProblem("")).not.toBeNull();
    expect(bashInputProblem("   ")).not.toBeNull();
    expect(bashInputProblem(42)).not.toBeNull();
    expect(bashInputProblem("x".repeat(10_000))).toBeNull();
    expect(bashInputProblem("x".repeat(10_001))).not.toBeNull();
  });
});

describe("the record and the reply rule (D10)", () => {
  test("the record is the spike's string, and it reads back", () => {
    const r = bashRecordText("ls -la", "a\nb", "warn");
    expect(r).toBe("<bash-input>ls -la</bash-input><bash-stdout>a\nb</bash-stdout><bash-stderr>warn</bash-stderr>");
    expect(parseBashRecord(r)).toEqual({ input: "ls -la", stdout: "a\nb", stderr: "warn" });
    expect(parseBashRecord("plain text")).toBeNull();
  });
  test("Claude replies as the user's respondToBashCommands says, unless Settings says always or never", () => {
    expect(bashShouldReply("follow-cli", true)).toBe(true);
    expect(bashShouldReply("follow-cli", false)).toBe(false);
    expect(bashShouldReply("always", false)).toBe(true);
    expect(bashShouldReply("never", true)).toBe(false);
  });
});

describe("running a command", () => {
  test("in the chat's folder, with the given shell; stdout, stderr and the exit code", async () => {
    const r = await runBash("pwd; echo oops >&2; exit 3", { cwd: DIR, shell: SH });
    expect(r.stdout).toBe(DIR);
    expect(r.stderr).toBe("oops");
    expect(r.code).toBe(3);
    expect(r.timedOut).toBe(false);
    expect(r.capped).toBe(false);
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  test("trailing newlines are removed, inner ones kept", async () => {
    const r = await runBash("printf 'a\\n\\nb\\n\\n\\n'", { cwd: DIR, shell: SH });
    expect(r.stdout).toBe("a\n\nb");
  });

  test("each stream keeps 30,000 characters, and the command is ended at the cap", async () => {
    const t0 = Date.now();
    const r = await runBash("yes 0123456789", { cwd: DIR, shell: SH });
    expect(r.capped).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(BASH_LIMITS.streamChars);
    expect(r.stdout.length).toBeGreaterThan(29_000);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  test("the timeout ends the shell and a child that keeps the pipes open; the note goes to stderr", async () => {
    const pidFile = join(DIR, "child.pid");
    // The background child holds stdout and stderr open long after the shell is gone.
    const r = await runBash(`sleep 30 & echo $! > ${pidFile}; echo started; wait`, { cwd: DIR, shell: SH, timeoutMs: 400, killGraceMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.stdout).toBe("started");
    expect(r.stderr).toBe(timeoutNote(400));
    const child = Number(readFileSync(pidFile, "utf8").trim());
    expect(child).toBeGreaterThan(0);
    await Bun.sleep(100);
    expect(alive(child)).toBe(false);
  });

  test("a child that ignores SIGTERM is ended by SIGKILL after the grace", async () => {
    const pidFile = join(DIR, "stubborn.pid");
    const r = await runBash(`sh -c 'trap "" TERM; sleep 30' & echo $! > ${pidFile}; wait`, { cwd: DIR, shell: SH, timeoutMs: 300, killGraceMs: 200 });
    expect(r.timedOut).toBe(true);
    const child = Number(readFileSync(pidFile, "utf8").trim());
    await Bun.sleep(100);
    expect(alive(child)).toBe(false);
  });

  test("the registry's signal ends the shell and its children early (Delete, Archive, a shutdown), with no timeout note", async () => {
    const pidFile = join(DIR, "aborted.pid");
    const ac = new AbortController();
    const t0 = Date.now();
    const running = runBash(`sleep 30 & echo $! > ${pidFile}; echo started; wait`, { cwd: DIR, shell: SH, signal: ac.signal, killGraceMs: 200 });
    await Bun.sleep(300);
    ac.abort();
    const r = await running;
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(r).toMatchObject({ stdout: "started", stderr: "", timedOut: false, capped: false });
    await Bun.sleep(100);
    expect(alive(Number(readFileSync(pidFile, "utf8").trim()))).toBe(false);
    // A signal that is already aborted ends the command at once.
    const done = new AbortController();
    done.abort();
    expect((await runBash("sleep 30", { cwd: DIR, shell: SH, signal: done.signal, killGraceMs: 200 })).timedOut).toBe(false);
  });

  test("a folder that is gone gives a result that says so, never a throw", async () => {
    const r = await runBash("echo hi", { cwd: join(DIR, "no-such-folder"), shell: SH });
    expect(r).toMatchObject({ stdout: "", stderr: SPAWN_FAILED, code: null, timedOut: false, capped: false });
  });

  test("the timeout note uses whole seconds", () => {
    expect(timeoutNote(120_000)).toBe("Command timed out after 120s");
  });
});
