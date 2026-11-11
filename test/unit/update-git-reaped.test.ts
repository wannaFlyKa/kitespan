// The update check's git reads (server/update/git.ts; DESIGN.md 4.10, build checklist S4) end their whole process group
// at the deadline and when the server exits, but never a group whose leader Bun has already reaped: once git is reaped
// its pid, and the group of that id, may name another process. A fake git (a sh script, which leads its own group as
// git does) writes its pid and leaves a helper that holds its output, so the read goes on after the leader exited and
// was reaped; a second fake stays alive, so the exit hook must end its group. The helpers are this test's own processes
// and end by themselves (or by the hook, for the live one).

import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runGit } from "../../server/update/git";

const GIT_TS = resolve(import.meta.dir, "..", "..", "server", "update", "git.ts");
const dir = mkdtempSync(join(tmpdir(), "kitespan-git-reaped-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
function fakeGit(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\necho $$ > ${q(join(dir, `${name}.pid`))}\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}
const pidOf = (name: string) => Number(readFileSync(join(dir, `${name}.pid`), "utf8").trim());
/** Exits at once; a helper in its group keeps its output open for a second. */
const EXITS = fakeGit("exits", "(sleep 1) &\nexit 0");
/** Stays (its own pid: exec), as a git that hangs on a silent peer. */
const STAYS = fakeGit("stays", "exec sleep 5");
const options = (git: string, timeoutMs: number) => ({ git, env: { PATH: "/usr/bin:/bin" }, timeoutMs });

describe.skipIf(!existsSync("/bin/sh"))("a git read whose git was reaped gets no group signal", () => {
  test("the deadline after git exited (a helper still holds its output): no signal to that group; the read fails", async () => {
    const spy = spyOn(process, "kill");
    try {
      const r = await runGit(options(EXITS, 200), dir, ["ls-remote"]);
      expect(r).toEqual({ code: null, out: "" });
      const leader = pidOf("exits");
      expect(spy.mock.calls.filter(([pid]) => pid === -leader || pid === leader)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  }, 10_000);

  test("the exit hook: a read whose git was reaped gets none; a read whose git still runs has its group ended", async () => {
    const child = join(dir, "child.ts");
    writeFileSync(
      child,
      `import { runGit } from ${JSON.stringify(GIT_TS)};
const calls: [number, unknown][] = [];
const real = process.kill.bind(process);
process.kill = ((pid: number, signal?: NodeJS.Signals | number) => (calls.push([pid, signal]), real(pid, signal))) as typeof process.kill;
void runGit(${JSON.stringify(options(EXITS, 30_000))}, ${JSON.stringify(dir)}, ["ls-remote"]);
void runGit(${JSON.stringify(options(STAYS, 30_000))}, ${JSON.stringify(dir)}, ["ls-remote"]);
await Bun.sleep(400);
process.on("exit", () => process.stdout.write(JSON.stringify(calls)));
process.exit(0);
`,
    );
    const p = Bun.spawn([process.execPath, "--no-env-file", child], { cwd: dir, env: { PATH: "/usr/bin:/bin" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    const calls = JSON.parse(out) as [number, unknown][];
    expect(calls.filter(([pid]) => pid === -pidOf("exits") || pid === pidOf("exits"))).toEqual([]);
    expect(calls).toContainEqual([-pidOf("stays"), "SIGKILL"]);
  }, 10_000);
});
