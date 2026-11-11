// The update's steps from this git checkout (owner row 108; DESIGN.md 4.10; server/update/source.ts), in scratch
// repositories that no user or system git config reaches: the refusals, each with its code (local changes, an
// untracked file, no checkout, a folder inside another repository, HEAD on no branch, no upstream, dev mode, no git);
// the fetch and fast-forward, the locked install and the build beside the build folder that then takes its place; a
// checkout that diverged from origin is refused after the fetch and nothing is built; a failed build leaves the build
// folder as it was; an ignored file of the user's that origin starts to track is never overwritten (the step fails at
// the fetch); no hook and no upload-pack program of the repository's runs; a step that passes its deadline ends
// with its whole process group; the update's log is a new 0600 file with no credential of a URL in it. bin/update.sh in
// a terminal fetches as the user's own git there: their ssh command, their prompts, the terminal's stdin, in its
// foreground (a step in a group of its own could not read the terminal).
//
// The scratch project has no dependency (its locked install needs no network) and a build script that writes a page,
// one asset and the stamp into the folder that `--out` names.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { UpdateStep } from "../../shared/update";
import { gitOptions, terminalGitEnv, UPDATE_SSH } from "../../server/update/git";
import { gitCheckoutSource, type CheckoutOptions } from "../../server/update/source";
import { clearFlat, openUpdateLog, redact, runStep, swapBuild, UPDATE_LOG } from "../../server/update/steps";
import { readStamp, stampText } from "../../server/update/stamp";
import { LINUX_ONLY, PROCFS } from "../linux";

const GIT = ["/usr/bin/git", "/bin/git"].find((g) => existsSync(g)) ?? null;
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "kitespan-update-apply-")));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const HOME = join(ROOT, "home");
mkdirSync(HOME);
const ISOLATED = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const ENV = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME, ...ISOLATED };

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync(GIT!, ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { env: ENV, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** The build: a page, one asset named by the commit, and the stamp, into --out; `extra` runs first. */
const BUILD = (extra = "") => `${extra}
const at = process.argv.indexOf("--out");
const out = process.argv[at + 1];
const { mkdirSync, writeFileSync, readdirSync, unlinkSync } = await import("node:fs");
mkdirSync(out, { recursive: true });
for (const f of readdirSync(out)) unlinkSync(out + "/" + f);
const head = Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim();
writeFileSync(out + "/index.html", "<p>" + head + "</p>");
writeFileSync(out + "/chunk-" + head.slice(0, 8) + ".js", "console.log(1)");
writeFileSync(out + "/build.json", JSON.stringify({ v: 1, head }) + "\\n");
`;

let n = 0;
/** A bare origin with a scratch project on main, an app clone of it with its build folder built, and a commit more on origin. */
function setup(o: { build?: string; behind?: boolean } = {}) {
  const id = ++n;
  const bare = join(ROOT, `origin-${id}.git`);
  git(ROOT, "init", "-q", "--bare", "-b", "main", bare);
  const seed = join(ROOT, `seed-${id}`);
  git(ROOT, "clone", "-q", bare, seed);
  writeFileSync(join(seed, "package.json"), JSON.stringify({ name: "scratch", private: true, scripts: { build: "bun build.ts" } }));
  writeFileSync(join(seed, "build.ts"), o.build ?? BUILD());
  writeFileSync(join(seed, ".gitignore"), "node_modules/\ndist/\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "one");
  git(seed, "push", "-q", "origin", "HEAD:main");
  const app = join(ROOT, `app-${id}`);
  git(ROOT, "clone", "-q", bare, app);
  const first = git(app, "rev-parse", "HEAD");
  const dist = join(app, "dist", "web");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.html"), "<p>old</p>");
  writeFileSync(join(dist, "chunk-old.js"), "old");
  writeFileSync(join(dist, "build.json"), stampText(first));
  let next = first;
  if (o.behind !== false) {
    writeFileSync(join(seed, "new.txt"), "new\n");
    git(seed, "add", "new.txt");
    git(seed, "commit", "-q", "-m", "two");
    git(seed, "push", "-q", "origin", "HEAD:main");
    next = git(seed, "rev-parse", "HEAD");
  }
  return { bare, seed, app, dist, first, next };
}

const source = (app: string, dist: string, over: Partial<CheckoutOptions> = {}) =>
  gitCheckoutSource({ root: app, dist, dev: false, git: gitOptions({ PATH: "/usr/bin:/bin", HOME, ...ISOLATED }, {}, 10_000), env: ENV, bun: process.execPath, ...over });

/** The steps' output into memory, and the steps seen. */
function run() {
  const lines: string[] = [];
  const steps: UpdateStep[] = [];
  return { lines, steps, opts: { onStep: (s: UpdateStep) => void steps.push(s), output: { line: (t: string) => void lines.push(t) } } };
}

describe.skipIf(!GIT)("the refusals (row 108)", () => {
  test("a clean checkout with an upstream may update; ignored files are not local changes", async () => {
    const s = setup();
    mkdirSync(join(s.app, "node_modules"), { recursive: true });
    writeFileSync(join(s.app, "node_modules", "x.js"), "x");
    expect(await source(s.app, s.dist).refusal()).toBeNull();
  });

  test("a tracked change, or an untracked file that is not ignored: local changes", async () => {
    const s = setup();
    writeFileSync(join(s.app, "build.ts"), "// mine\n");
    expect(await source(s.app, s.dist).refusal()).toBe("local_changes");
    git(s.app, "checkout", "--", "build.ts");
    writeFileSync(join(s.app, "notes.txt"), "mine\n");
    expect(await source(s.app, s.dist).refusal()).toBe("local_changes");
  });

  test("not a checkout, a folder inside another repository, HEAD on no branch, no upstream, dev mode, no git", async () => {
    const plain = join(ROOT, "plain");
    mkdirSync(plain, { recursive: true });
    expect(await source(plain, join(plain, "dist")).refusal()).toBe("not_checkout");
    const s = setup();
    const inner = join(s.app, "inner");
    mkdirSync(inner);
    writeFileSync(join(s.app, ".git", "info", "exclude"), "inner/\n");
    expect(await source(inner, join(inner, "dist")).refusal()).toBe("not_checkout");
    git(s.app, "checkout", "-q", "--detach", "HEAD");
    expect(await source(s.app, s.dist).refusal()).toBe("detached");
    git(s.app, "checkout", "-q", "-b", "topic");
    expect(await source(s.app, s.dist).refusal()).toBe("no_upstream");
    expect(await source(s.app, s.dist, { dev: true }).refusal()).toBe("dev");
    expect(await source(s.app, s.dist, { git: { git: null, env: {} } }).refusal()).toBe("no_git");
  });
});

describe.skipIf(!GIT)("the steps (row 108)", () => {
  test("fetch and fast-forward, the locked install, the build beside the build folder, which then takes its place", async () => {
    const s = setup();
    const r = run();
    const res = await source(s.app, s.dist).apply(r.opts);
    expect(res).toEqual({ ok: true, head: s.next });
    expect(r.steps).toEqual(["fetch", "install", "build"]);
    expect(git(s.app, "rev-parse", "HEAD")).toBe(s.next);
    // The remote-tracking branch follows, as a terminal pull's does.
    expect(git(s.app, "rev-parse", "origin/main")).toBe(s.next);
    expect(readStamp(s.dist)).toEqual({ head: s.next });
    expect(readFileSync(join(s.dist, "index.html"), "utf8")).toBe(`<p>${s.next}</p>`);
    expect(readdirSync(s.dist).sort()).toEqual(["build.json", `chunk-${s.next.slice(0, 8)}.js`, "index.html"]);
    expect(existsSync(`${s.dist}.next`)).toBe(false);
    expect(existsSync(`${s.dist}.old`)).toBe(false);
  }, 60_000);

  test("a checkout ahead of origin: nothing to merge; the install and the build run again", async () => {
    const s = setup({ behind: false });
    writeFileSync(join(s.app, "mine.txt"), "mine\n");
    git(s.app, "add", "mine.txt");
    git(s.app, "commit", "-q", "-m", "mine");
    const head = git(s.app, "rev-parse", "HEAD");
    const res = await source(s.app, s.dist).apply(run().opts);
    expect(res).toEqual({ ok: true, head });
    expect(readStamp(s.dist)).toEqual({ head });
  }, 60_000);

  test("diverged from origin: refused after the fetch, HEAD stays, nothing is built", async () => {
    const s = setup();
    writeFileSync(join(s.app, "mine.txt"), "mine\n");
    git(s.app, "add", "mine.txt");
    git(s.app, "commit", "-q", "-m", "mine");
    const mine = git(s.app, "rev-parse", "HEAD");
    const r = run();
    expect(await source(s.app, s.dist).apply(r.opts)).toEqual({ ok: false, step: "fetch", refusal: "diverged" });
    expect(r.steps).toEqual(["fetch"]);
    expect(git(s.app, "rev-parse", "HEAD")).toBe(mine);
    expect(readStamp(s.dist)).toEqual({ head: s.first });
  }, 60_000);

  test("a build that fails: the build folder stays as it was, its .next goes, and the fast-forward stays", async () => {
    const s = setup({ build: "process.exit(3);\n" });
    const before = Object.fromEntries(readdirSync(s.dist).map((f) => [f, readFileSync(join(s.dist, f), "utf8")]));
    const r = run();
    expect(await source(s.app, s.dist).apply(r.opts)).toEqual({ ok: false, step: "build" });
    expect(Object.fromEntries(readdirSync(s.dist).map((f) => [f, readFileSync(join(s.dist, f), "utf8")]))).toEqual(before);
    expect(existsSync(`${s.dist}.next`)).toBe(false);
    expect(git(s.app, "rev-parse", "HEAD")).toBe(s.next);
  }, 60_000);

  test("a build that writes no stamp of the checkout's HEAD never takes the build folder's place", async () => {
    const s = setup({ build: BUILD().replace('JSON.stringify({ v: 1, head })', 'JSON.stringify({ v: 1, head: null })') });
    expect(await source(s.app, s.dist).apply(run().opts)).toEqual({ ok: false, step: "build" });
    expect(readStamp(s.dist)).toEqual({ head: s.first });
  }, 60_000);

  test("an ignored file of the user's (.env) that origin starts to track is never overwritten: the fetch step fails", async () => {
    const s = setup({ behind: false });
    // The user's own file, ignored here (not by the project's .gitignore), so `git status` lists nothing.
    writeFileSync(join(s.app, ".git", "info", "exclude"), ".env\n");
    writeFileSync(join(s.app, ".env"), "MY_SECRET_LOCAL=keep\n");
    expect(await source(s.app, s.dist).refusal()).toBeNull();
    git(s.seed, "pull", "-q", "--ff-only");
    writeFileSync(join(s.seed, ".env"), "TRACKED=upstream\n");
    git(s.seed, "add", "-f", ".env");
    git(s.seed, "commit", "-q", "-m", "track .env");
    git(s.seed, "push", "-q", "origin", "HEAD:main");
    const r = run();
    expect(await source(s.app, s.dist).apply(r.opts)).toEqual({ ok: false, step: "fetch" });
    expect(readFileSync(join(s.app, ".env"), "utf8")).toBe("MY_SECRET_LOCAL=keep\n");
    expect(git(s.app, "rev-parse", "HEAD")).toBe(s.first);
    expect(readStamp(s.dist)).toEqual({ head: s.first });
    // git's own words are in the log, for the user to read.
    expect(r.lines.join("\n")).toMatch(/\.env/);
  }, 60_000);

  test.skipIf(!PROCFS)(`bin/update.sh in a terminal: the fetch has the user's ssh command and prompts, in the terminal's foreground ${LINUX_ONLY}`, async () => {
    const s = setup();
    const out = join(ROOT, `fetch-seen-${n}`);
    // git as a wrapper that notes, for the fetch, the ssh command it got and its process group, then runs git.
    const wrapper = join(ROOT, `git-wrapper-${n}.sh`);
    writeFileSync(wrapper, `#!/bin/sh\nfor a in "$@"; do if [ "$a" = fetch ]; then printf '%s|%s|%s\\n' "\${GIT_SSH_COMMAND-unset}" "\${GIT_TERMINAL_PROMPT-unset}" "$(cut -d' ' -f5 /proc/$$/stat)" >> '${out}'; fi; done\nexec ${GIT} "$@"\n`);
    chmodSync(wrapper, 0o755);
    const ownGroup = readFileSync(`/proc/${process.pid}/stat`, "utf8").split(") ")[1]!.split(" ")[2];
    const git = { ...gitOptions({ PATH: "/usr/bin:/bin", HOME, ...ISOLATED }, {}, 10_000), git: wrapper };
    const user = { PATH: "/usr/bin:/bin", HOME, ...ISOLATED, GIT_SSH_COMMAND: "ssh -i /keys/other", GIT_DIR: "/elsewhere" };
    const env = terminalGitEnv(user);
    expect(env.GIT_SSH_COMMAND).toBe("ssh -i /keys/other");
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_TERMINAL_PROMPT).toBeUndefined();
    expect(env.GIT_ASKPASS).toBeUndefined();
    // With none of the user's, core.sshCommand of their config applies: no ssh command is set.
    expect(terminalGitEnv({ PATH: "/usr/bin:/bin", HOME }).GIT_SSH_COMMAND).toBeUndefined();
    expect((await source(s.app, s.dist, { git, terminal: { env } }).apply(run().opts)).ok).toBe(true);
    const [ssh, prompt, group] = readFileSync(out, "utf8").trim().split("|");
    expect([ssh, prompt]).toEqual(["ssh -i /keys/other", "unset"]);
    expect(group).toBe(ownGroup);
    // The Update button's fetch (no terminal): batch-mode ssh, no prompt, a group of its own.
    const t = setup();
    rmSync(out);
    expect((await source(t.app, t.dist, { git }).apply(run().opts)).ok).toBe(true);
    const [ssh2, prompt2, group2] = readFileSync(out, "utf8").trim().split("|");
    expect([ssh2, prompt2]).toEqual([UPDATE_SSH, "0"]);
    expect(group2).not.toBe(ownGroup);
  }, 60_000);

  test("no hook and no upload-pack program of the repository's runs", async () => {
    const s = setup();
    const mark = join(ROOT, `ran-${n}`);
    const prog = join(ROOT, `planted-${n}.sh`);
    writeFileSync(prog, `#!/bin/sh\necho ran >> '${mark}'\nexit 1\n`);
    chmodSync(prog, 0o755);
    for (const hook of ["post-merge", "post-checkout", "reference-transaction", "pre-merge-commit"]) {
      writeFileSync(join(s.app, ".git", "hooks", hook), `#!/bin/sh\necho ${hook} >> '${mark}'\n`);
      chmodSync(join(s.app, ".git", "hooks", hook), 0o755);
    }
    git(s.app, "config", "remote.origin.uploadpack", prog);
    git(s.app, "config", "core.fsmonitor", prog);
    expect((await source(s.app, s.dist).apply(run().opts)).ok).toBe(true);
    expect(existsSync(mark)).toBe(false);
  }, 60_000);

  test.skipIf(!PROCFS)(`a step past its deadline ends with its whole process group ${LINUX_ONLY}`, async () => {
    const tag = `kitespan-update-deadline-${crypto.randomUUID()}`;
    // Two commands, so the shell stays (with the tag on its command line) while its sleep runs.
    const s = setup({ build: `Bun.spawn(["sh", "-c", "sleep 60; : ${tag}"]); await Bun.sleep(60_000);\n` });
    const t0 = Date.now();
    const res = await source(s.app, s.dist, { limits: { buildMs: 1_000 } }).apply(run().opts);
    expect(res).toEqual({ ok: false, step: "build", timeout: true });
    expect(Date.now() - t0).toBeLessThan(15_000);
    // The build's own child (a shell that sleeps) went with the group: only read here, never signalled.
    const left = () => readdirSync("/proc").filter((p) => /^\d+$/.test(p) && (() => { try { return readFileSync(`/proc/${p}/cmdline`, "utf8").includes(tag); } catch { return false; } })());
    const end = Date.now() + 2_000;
    while (left().length && Date.now() < end) await Bun.sleep(50);
    expect(left()).toEqual([]);
    expect(readStamp(s.dist)).toEqual({ head: s.first });
  }, 60_000);
});

describe("the update's log and the swap (row 108)", () => {
  test("logs/update.log: a new 0600 file each run, never through a link; no credential of a URL; no control character; capped", async () => {
    const logs = join(ROOT, "logs-a");
    mkdirSync(logs, { mode: 0o700 });
    writeFileSync(join(logs, UPDATE_LOG), "the last run\n");
    const log = openUpdateLog(logs, 200);
    const r = await runStep(["sh", "-c", "echo 'fatal: https://user:s3cret@example.invalid/r.git'; printf 'ssh://tok@host/x\\033[2K\\n' >&2"], { cwd: ROOT, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 10_000, output: log });
    expect(r).toEqual({ code: 0, timeout: false, aborted: false });
    for (let i = 0; i < 20; i++) log.line(`line ${i} of some length to pass the cap`);
    log.close();
    const text = readFileSync(join(logs, UPDATE_LOG), "utf8");
    expect(text).not.toContain("the last run");
    expect(text).not.toContain("s3cret");
    expect(text).not.toContain("tok@");
    expect(text).toContain("https://***@example.invalid/r.git");
    expect(text).not.toContain("\u001b");
    expect(text.length).toBeLessThan(260);
    expect(text.trimEnd().split("\n").at(-1)).toBe("(the rest of the output was left out)");
    expect(statSync(join(logs, UPDATE_LOG)).mode & 0o777).toBe(0o600);
    expect(redact("git@github.com:o/r.git and https://github.com/o/r")).toBe("git@github.com:o/r.git and https://github.com/o/r");
  });

  test("a step names its group leader and its deadline as it starts (the update lock records them)", async () => {
    const seen: [number, number][] = [];
    const r = await runStep(["sh", "-c", "echo $$"], { cwd: ROOT, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 10_000, output: { line: () => {} }, onSpawn: (pid, ms) => void seen.push([pid, ms]) });
    expect(r.code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]![1]).toBe(10_000);
    expect(seen[0]![0]).toBeGreaterThan(1);
  });

  test("the swap: only a whole build takes the folder's place; clearFlat never enters a folder", () => {
    const dist = join(ROOT, "swap", "web");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "old");
    const next = `${dist}.next`;
    mkdirSync(next);
    writeFileSync(join(next, "index.html"), "new");
    expect(swapBuild(dist, next, "a".repeat(40))).toBe(false);
    writeFileSync(join(next, "build.json"), stampText("a".repeat(40)));
    expect(swapBuild(dist, next, "b".repeat(40))).toBe(false);
    expect(readFileSync(join(dist, "index.html"), "utf8")).toBe("old");
    expect(swapBuild(dist, next, "a".repeat(40))).toBe(true);
    expect(readFileSync(join(dist, "index.html"), "utf8")).toBe("new");
    expect(existsSync(next)).toBe(false);
    expect(existsSync(`${dist}.old`)).toBe(false);
    const kept = join(ROOT, "swap", "kept");
    mkdirSync(join(kept, "inner"), { recursive: true });
    writeFileSync(join(kept, "a.js"), "a");
    writeFileSync(join(kept, "inner", "b.js"), "b");
    expect(() => clearFlat(kept)).toThrow();
    expect(existsSync(join(kept, "a.js"))).toBe(false);
    expect(readFileSync(join(kept, "inner", "b.js"), "utf8")).toBe("b");
  });
});
