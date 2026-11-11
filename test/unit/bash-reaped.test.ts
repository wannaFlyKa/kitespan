// Group signals after the leader was reaped (the `!` commands, server/agents/claude/bash.ts; the version probe,
// server/agents/claude/locate.ts): once Bun has reaped a group's leader, the group's id is held only while a member is
// left in it; when the group is empty the id may become another process's group. So a `!` command's group gets a
// signal after its shell was reaped only while a process that was in the group at the reap is still in it (a
// background job keeps the timeout's end, O-L5), and the version probe's group gets none after the reap. The
// commands' processes are this test's own and end by themselves.

import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBash, timeoutNote } from "../../server/agents/claude/bash";
import { readVersion } from "../../server/agents/claude/locate";
import { LINUX_ONLY } from "../linux";

const DIR = realpathSync(mkdtempSync(join(tmpdir(), "bash-reaped-")));
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

describe.if(existsSync("/proc/self/stat") && existsSync("/usr/bin/setsid"))(`a \`!\` command whose shell was reaped ${LINUX_ONLY}`, () => {
  test("a job that left the group (setsid) holds the output: the timeout sends that group no signal, and the result comes at the output's end", async () => {
    const spy = spyOn(process, "kill");
    try {
      const r = await runBash("echo $$; /usr/bin/setsid sleep 1 &", { cwd: DIR, shell: SH, timeoutMs: 200, killGraceMs: 100 });
      expect(r.timedOut).toBe(true);
      expect(r.stderr).toBe(timeoutNote(200));
      const leader = Number(r.stdout);
      expect(leader).toBeGreaterThan(1);
      // A probe (signal 0) delivers nothing; no signal went to that group.
      expect(spy.mock.calls.filter(([pid, signal]) => pid === -leader && signal !== 0)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  }, 10_000);

  test("a background job still in the group holds the output: the timeout still ends it (it was in the group at the reap)", async () => {
    const pidFile = join(DIR, "job.pid");
    const t0 = Date.now();
    const r = await runBash(`sleep 30 & echo $! > ${pidFile}; echo started`, { cwd: DIR, shell: SH, timeoutMs: 400, killGraceMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.stdout).toBe("started");
    expect(Date.now() - t0).toBeLessThan(5_000);
    await Bun.sleep(100);
    expect(alive(Number(readFileSync(pidFile, "utf8").trim()))).toBe(false);
  }, 10_000);
});

describe.if(existsSync("/bin/sh"))("the version probe whose binary was reaped", () => {
  test("the deadline after the binary exited (a helper still holds its output): no signal to that group; no version", async () => {
    const bin = join(DIR, "claude");
    writeFileSync(bin, `#!/bin/sh\necho $$ > '${join(DIR, "claude.pid")}'\n(sleep 1) &\nexit 0\n`);
    chmodSync(bin, 0o755);
    const spy = spyOn(process, "kill");
    try {
      expect(await readVersion(bin, 200)).toBeNull();
      const leader = Number(readFileSync(join(DIR, "claude.pid"), "utf8").trim());
      expect(spy.mock.calls.filter(([pid]) => pid === -leader)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  }, 10_000);
});
