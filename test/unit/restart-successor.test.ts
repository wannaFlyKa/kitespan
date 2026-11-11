// The restart's successor and preflight (DESIGN.md 4.10; build checklist S8, S12, L12, L13): bin/kitespan with the
// server's own options plus --bind-wait 10, detached into a session of its own, stdin ignored, its lines in
// logs/server-out.log (0600, a new file each time, a link in its place never followed), with the server's start
// environment and no name that the old server lacked. The preflight: a build.json that names another HEAD refuses
// the restart; `--check` of the real server exits 0 with nothing bound, and a failed check refuses with one line.

import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gitHead, gitOptions } from "../../server/update/git";
import { checkStart, preflight, PREFLIGHT_LINES } from "../../server/update/preflight";
import { BUILD_STAMP, stampText } from "../../server/update/stamp";
import { OUT_LOG, openOutLog, ownOptions, spawnSuccessor, successorArgv } from "../../server/update/successor";
import { freePort } from "./free-port";

const REPO = resolve(import.meta.dir, "..", "..");
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "kitespan-successor-")));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("the successor's command line (S12)", () => {
  test("the server's own options, `dev` as the script's word, a relative --dist made absolute, then --bind-wait 10", () => {
    expect(successorArgv("/srv/kitespan", ["--port", "7941"], "/work/me")).toEqual(["/srv/kitespan/bin/kitespan", "--port", "7941", "--bind-wait", "10"]);
    expect(successorArgv("/srv/kitespan", ["--dev", "--port", "7942", "--dist", "build/web"], "/work/me")).toEqual([
      "/srv/kitespan/bin/kitespan",
      "dev",
      "--port",
      "7942",
      "--dist",
      "/work/me/build/web",
      "--bind-wait",
      "10",
    ]);
  });

  test("a successor's successor gets one --bind-wait, and the preflight's --check never goes on", () => {
    expect(ownOptions(["--port", "7941", "--bind-wait", "10", "--check"], "/")).toEqual({ dev: false, options: ["--port", "7941"] });
    expect(successorArgv("/r", ["--bind-wait", "10", "--port", "7941"], "/")).toEqual(["/r/bin/kitespan", "--port", "7941", "--bind-wait", "10"]);
  });
});

describe("the successor's start (S12, L13)", () => {
  const dir = join(ROOT, "spawn");
  const logs = join(dir, "logs");
  mkdirSync(logs, { recursive: true });
  const script = join(dir, "fake-kitespan");
  // The fake start script: its argv, its environment's names (never the values), its session and stdin.
  writeFileSync(
    script,
    `#!/bin/sh
printf '%s\\n' "$@" > '${dir}/args'
env | cut -d= -f1 | sort > '${dir}/names'
ps -o sid= -p $$ | tr -d ' ' > '${dir}/sid'
echo $$ > '${dir}/pid'
if read -r line; then echo "stdin had a line" > '${dir}/stdin'; else echo "stdin empty" > '${dir}/stdin'; fi
echo "a line for the terminal"
echo "a problem" >&2
`,
  );
  chmodSync(script, 0o755);

  // The fake start script reads its session with `ps -o sid=`, a keyword of Linux's ps only.
  test.skipIf(process.platform !== "linux")("detached into its own session, stdin ignored, its lines in server-out.log (0600, new), and the start environment (Linux only: ps -o sid)", async () => {
    // An old file, and later a link in its place: the new file replaces the first and never writes through the second.
    writeFileSync(join(logs, OUT_LOG), "old lines\n", { mode: 0o644 });
    const env = { PATH: "/usr/bin:/bin", HOME: dir, KITESPAN_TEST_NAME: "1" };
    const s = spawnSuccessor({ root: REPO, argv: ["--port", "7944"], cwd: dir, env, logs, script });
    expect(await s.exited).toBe(0);
    expect(readFileSync(join(dir, "args"), "utf8").split("\n").filter(Boolean)).toEqual(["--port", "7944", "--bind-wait", "10"]);
    const names = readFileSync(join(dir, "names"), "utf8").split("\n").filter(Boolean);
    // No name that the old server lacked (the fake's own sh adds PWD and SHLVL, as any sh does).
    const shellOwn = new Set(["PWD", "SHLVL", "OLDPWD", "_"]);
    expect(names.filter((k) => !(k in env) && !shellOwn.has(k))).toEqual([]);
    expect(names).toContain("KITESPAN_TEST_NAME");
    expect(readFileSync(join(dir, "sid"), "utf8").trim()).toBe(readFileSync(join(dir, "pid"), "utf8").trim());
    expect(readFileSync(join(dir, "stdin"), "utf8").trim()).toBe("stdin empty");
    const out = join(logs, OUT_LOG);
    expect(readFileSync(out, "utf8")).toBe("a line for the terminal\na problem\n");
    expect(lstatSync(out).mode & 0o777).toBe(0o600);
  });

  test("a successor that exited gets no signal: its pid (and the group of that id) may name another process now", async () => {
    const quick = join(dir, "exits-at-once");
    writeFileSync(quick, "#!/bin/sh\nexit 1\n");
    chmodSync(quick, 0o755);
    const s = spawnSuccessor({ root: REPO, argv: [], cwd: dir, env: { PATH: "/usr/bin:/bin" }, logs, script: quick });
    expect(await s.exited).toBe(1);
    // The spy sends nothing: a signal to a reused pid is what the test rules out.
    const spy = spyOn(process, "kill").mockImplementation(() => true);
    try {
      s.kill();
      expect(spy.mock.calls.filter(([pid]) => pid === s.pid || pid === -s.pid)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  test("a link in the log's place is replaced, never followed", () => {
    const target = join(dir, "elsewhere.txt");
    writeFileSync(target, "keep\n");
    rmSync(join(logs, OUT_LOG), { force: true });
    symlinkSync(target, join(logs, OUT_LOG));
    closeSync(openOutLog(logs));
    expect(lstatSync(join(logs, OUT_LOG)).isSymbolicLink()).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("keep\n");
  });
});

describe("the preflight (S8)", () => {
  const GIT = ["/usr/bin/git", "/bin/git"].find((g) => existsSync(g)) ?? null;
  const git = gitOptions({ PATH: "/usr/bin:/bin", HOME: ROOT }, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, 5_000);
  const logs = join(ROOT, "pf-logs");
  mkdirSync(logs, { recursive: true });
  const state = join(ROOT, "pf-state");
  const dist = join(ROOT, "pf-dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><html><body>kitespan page</body></html>");
  /** The real server's start environment for `--check`, with scratch folders. */
  const env = { PATH: `${resolve(process.execPath, "..")}:/usr/bin:/bin`, HOME: join(ROOT, "pf-home"), XDG_STATE_HOME: state, XDG_CONFIG_HOME: join(ROOT, "pf-config") };
  mkdirSync(env.HOME, { recursive: true });

  test.skipIf(!GIT)("a build.json that names another HEAD refuses the restart, before any check runs", async () => {
    writeFileSync(join(dist, BUILD_STAMP), stampText("0".repeat(40)));
    expect(await preflight({ root: REPO, dist, dev: false, argv: ["--dist", dist], env, git, logs })).toBe(PREFLIGHT_LINES.unfinished);
    rmSync(join(dist, BUILD_STAMP));
    expect(await preflight({ root: REPO, dist, dev: false, argv: ["--dist", dist], env, git, logs })).toBe(PREFLIGHT_LINES.unfinished);
  });

  test.skipIf(!GIT)(
    "the build of this checkout passes, and the real server's --check exits 0 and binds nothing",
    async () => {
      writeFileSync(join(dist, BUILD_STAMP), stampText(await gitHead(REPO, git)));
      // A port of the system's that nothing holds (never a lane's test port, where another agent's server may run).
      const port = freePort();
      expect(await preflight({ root: REPO, dist, dev: false, argv: ["--port", String(port), "--dist", dist], env, git, logs })).toBeNull();
      // Nothing listens on the port it was given.
      await expect(fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1_000) })).rejects.toBeDefined();
      // The check wrote nothing to the state folder: it opened nothing for writing.
      expect(existsSync(state)).toBe(false);
    },
    30_000,
  );

  test.skipIf(!GIT)(
    "a check that fails (an option the new code does not take, no page) refuses with one line; its lines are in server-out.log",
    async () => {
      writeFileSync(join(dist, BUILD_STAMP), stampText(await gitHead(REPO, git)));
      expect(await preflight({ root: REPO, dist, dev: false, argv: ["--dist", dist, "--bogus"], env, git, logs })).toBe(PREFLIGHT_LINES.check);
      expect(readFileSync(join(logs, OUT_LOG), "utf8")).toContain("unknown option --bogus");
      const empty = join(ROOT, "pf-empty");
      mkdirSync(empty, { recursive: true });
      writeFileSync(join(empty, BUILD_STAMP), stampText(await gitHead(REPO, git)));
      expect(await preflight({ root: REPO, dist: empty, dev: false, argv: ["--dist", empty], env, git, logs })).toBe(PREFLIGHT_LINES.check);
      expect(readFileSync(join(logs, OUT_LOG), "utf8")).toContain("there is no page at");
    },
    30_000,
  );

  test("--check's own part: a state folder with a wider mode, and a missing page, are named", async () => {
    const bad = join(ROOT, "pf-bad-state");
    mkdirSync(bad, { recursive: true, mode: 0o755 });
    chmodSync(bad, 0o755);
    const lines = await checkStart({ root: REPO, dist: join(ROOT, "nowhere"), dev: false, state: bad });
    expect(lines.some((l) => l.includes("failed its checks"))).toBe(true);
    expect(lines.some((l) => l.includes("there is no page at"))).toBe(true);
    expect(await checkStart({ root: REPO, dist, dev: false, state: join(ROOT, "not-made-yet") })).toEqual([]);
    expect(await checkStart({ root: REPO, dist: join(ROOT, "nowhere"), dev: true, state: join(ROOT, "not-made-yet") })).toEqual([]);
  });

  test("--check's own part leaves a chat's marks' git objects to git, as the store's boot check does (U1)", async () => {
    // git writes a mark's objects read only, in folders of its own making (0444 in 0755): the store's check stops at
    // changes/<chat>/objects, so --check (the restart's preflight) must too, or a chat with a mark refuses every restart.
    const marked = join(ROOT, "pf-changes-state");
    const chat = join(marked, "changes", "k3m7q2x4abk3m7q2x4ab");
    const fan = join(chat, "objects", "ab");
    mkdirSync(fan, { recursive: true, mode: 0o700 });
    for (const d of [marked, join(marked, "changes"), chat, join(chat, "objects")]) chmodSync(d, 0o700);
    chmodSync(fan, 0o755);
    writeFileSync(join(fan, "cdef0123456789abcdef0123456789abcdef01"), "x", { mode: 0o444 });
    chmodSync(join(fan, "cdef0123456789abcdef0123456789abcdef01"), 0o444);
    writeFileSync(join(chat, "turns.json"), "{}", { mode: 0o600 });
    chmodSync(join(chat, "turns.json"), 0o600);
    expect(await checkStart({ root: REPO, dist, dev: false, state: marked })).toEqual([]);
    // Anything else under changes/ is still checked.
    chmodSync(join(chat, "turns.json"), 0o644);
    const lines = await checkStart({ root: REPO, dist, dev: false, state: marked });
    expect(lines.some((l) => l.includes("turns.json") && l.includes("wider-mode"))).toBe(true);
    expect(lines.some((l) => l.includes("objects/ab"))).toBe(false);
    // A mark's working folder (U1 review): git's lock of the private index is 0644; a stray one never refuses --check.
    chmodSync(join(chat, "turns.json"), 0o600);
    const work = join(chat, "mark");
    mkdirSync(work, { recursive: true, mode: 0o700 });
    chmodSync(work, 0o700);
    for (const name of ["index", "index.lock"]) {
      writeFileSync(join(work, name), "x");
      chmodSync(join(work, name), 0o644);
    }
    expect(await checkStart({ root: REPO, dist, dev: false, state: marked })).toEqual([]);
  });
});
