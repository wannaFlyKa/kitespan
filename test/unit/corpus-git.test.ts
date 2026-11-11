// The corpus from git (DESIGN.md 9.3; build checklist B1), in scratch repositories that no user or system git config
// reaches: tracked files first under a cap, a repository's fsmonitor program never run, links listed once and never
// entered, ignore rules, a nested repository dropped, exact names, an inherited GIT_DIR that redirects nothing, a
// subfolder that lists its own files, the fall to the walk, a stalled git killed at its deadline, and the PATH: git is
// found on its absolute entries only and runs with no relative or empty entry, or the walk lists the folder.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { listCorpus } from "../../server/search/build";
import { absolutePath, findGit, gitEnv, keepPath, listGit } from "../../server/search/git";

const GIT = ["/usr/bin/git", "/bin/git"].find((g) => existsSync(g)) ?? null;
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "kitespan-corpus-git-")));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const HOME = join(ROOT, "home");
mkdirSync(HOME);
/** The server's environment in these tests: a scratch HOME, and no user or system git config. */
const BASE = { PATH: "/usr/bin:/bin", HOME };
const ISOLATED = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const env = (more: Record<string, string> = {}) => gitEnv({ ...BASE, ...more }, ISOLATED);

/** git for the test's own setup. */
function git(cwd: string, ...args: string[]): string {
  const r = spawnSync(GIT!, ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { env: { ...BASE, ...ISOLATED }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function write(path: string, body = "x\n"): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
}

/** A script that appends "ran" to `mark`, then runs `then` (or lists a planted path). */
function fakeGit(path: string, mark: string, then = "printf 'planted.txt\\000'"): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `#!/bin/sh\necho ran >> '${mark}'\n${then}\n`);
  chmodSync(path, 0o755);
}

let n = 0;
/** A fresh repository with `tracked` committed and `untracked` written after. */
function repo(tracked: string[], untracked: string[] = []): string {
  const dir = join(ROOT, `repo-${++n}`);
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  for (const f of tracked) write(join(dir, f));
  if (tracked.length) {
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "init");
  }
  for (const f of untracked) write(join(dir, f));
  return dir;
}

const opts = (max = 100_000, ms = 5_000, more: Record<string, string> = {}) => ({ git: GIT!, max, ms, env: env(more) });

describe.skipIf(!GIT)("git ls-files, hardened", () => {
  test("the environment: every GIT_* variable taken out, the fixed ones added", () => {
    const e = gitEnv({ PATH: "/usr/bin", GIT_DIR: "/elsewhere/.git", GIT_WORK_TREE: "/elsewhere", GIT_CONFIG_PARAMETERS: "'core.fsmonitor=/x'", LANG: "en_US.UTF-8" });
    expect(e).toEqual({ PATH: "/usr/bin", LANG: "en_US.UTF-8", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", LC_ALL: "C" });
  });

  test("the environment's PATH keeps its absolute entries only, and is left out when none is left", () => {
    // git runs in the chat's folder: ".", an empty entry and a relative entry would each name a file of that folder.
    expect(gitEnv({ PATH: ".:/usr/bin::bin:./tools:node_modules/.bin:/bin:" }).PATH).toBe("/usr/bin:/bin");
    expect(gitEnv({ PATH: "/usr/local/bin" }, { PATH: "bin:/opt/bin" }).PATH).toBe("/opt/bin");
    // An empty PATH is the current folder to a shell (sh -c finds "x" in its working folder), so it is not set.
    for (const base of [{ PATH: ".::bin" }, { PATH: "" }, { HOME }]) expect(Object.keys(gitEnv(base))).not.toContain("PATH");
  });

  test("git is found on the absolute PATH entries only, as an absolute path, or not at all", () => {
    // A git under a relative entry: relative to the test's own folder, where Bun.which finds it.
    const dir = join(ROOT, "relative-entry-bin");
    fakeGit(join(dir, "git"), join(ROOT, "relative-entry-mark"));
    const rel = relative(process.cwd(), dir);
    expect(Bun.which("git", { PATH: rel })).toBe(join(rel, "git"));
    expect(absolutePath(`.::${rel}:./bin:${dir}:`)).toBe(dir);
    for (const PATH of [rel, `.::${rel}`, ".", "", ":"]) expect(findGit(PATH)).toBeNull();
    expect(findGit(`.::${rel}:${dir}:/usr/bin`)).toBe(join(dir, "git"));
    expect(findGit(`.::${rel}:/usr/bin:/bin`)).toBe(Bun.which("git", { PATH: "/usr/bin:/bin" }));
  });

  test("tracked files come first: a small cap keeps them and drops untracked ones", async () => {
    // git prints untracked entries before tracked ones; the listing must not keep "u1" over "c" under a cap of 3.
    const dir = repo(["a.txt", "b.txt", "c.txt"], ["u1.txt", "u2.txt"]);
    // --cached gave its 3 and exited 0; --others, with no room left, was cut at its first path.
    expect(await listGit(dir, opts(3))).toEqual({ code: 0, paths: ["a.txt", "b.txt", "c.txt"], capped: true, timeout: false, spawnFailed: false });
    // A cap inside the tracked files: --cached itself is cut (no exit code), and --others does not run.
    expect(await listGit(dir, opts(2))).toEqual({ code: null, paths: ["a.txt", "b.txt"], capped: true, timeout: false, spawnFailed: false });
    expect((await listGit(dir, opts(4))).paths).toEqual(["a.txt", "b.txt", "c.txt", "u1.txt"]);
    const all = await listGit(dir, opts(5));
    expect(all).toEqual({ code: 0, paths: ["a.txt", "b.txt", "c.txt", "u1.txt", "u2.txt"], capped: false, timeout: false, spawnFailed: false });
    // Exactly at the cap with nothing left out: not capped.
    expect((await listGit(repo(["a.txt", "b.txt"]), opts(2))).capped).toBe(false);
  });

  test("a repository's core.fsmonitor program never runs", async () => {
    const dir = repo(["a.txt"], ["u.txt"]);
    const mark = join(ROOT, `fsmonitor-mark-${n}`);
    const hook = join(ROOT, `fsmonitor-hook-${n}.sh`);
    writeFileSync(hook, `#!/bin/sh\necho ran >> '${mark}'\nexit 1\n`);
    chmodSync(hook, 0o755);
    git(dir, "config", "core.fsmonitor", hook);
    // The hook is real: a plain ls-files runs it.
    spawnSync(GIT!, ["-C", dir, "ls-files", "-z"], { env: { ...BASE, ...ISOLATED } });
    expect(existsSync(mark)).toBe(true);
    rmSync(mark);
    const got = await listGit(dir, opts());
    expect(got.paths).toEqual(["a.txt", "u.txt"]);
    expect(existsSync(mark)).toBe(false);
    // The same through the inherited environment: GIT_CONFIG_PARAMETERS cannot turn it back on.
    await listGit(dir, opts(100_000, 5_000, { GIT_CONFIG_PARAMETERS: `'core.fsmonitor=${hook}'` }));
    expect(existsSync(mark)).toBe(false);
  });

  test("links are left out, tracked or not, as the walk leaves them out, and nothing under them is listed (W19d)", async () => {
    // A link that leads outside would be offered by the @ picker and then refused at Send (mention_gone).
    const dir = repo(["a.txt", "inner/b.txt"]);
    const outside = join(ROOT, `outside-${n}.txt`);
    write(outside);
    symlinkSync("/etc", join(dir, "link-out-dir"));
    symlinkSync("..", join(dir, "link-up"));
    symlinkSync("a.txt", join(dir, "link-file"));
    symlinkSync(outside, join(dir, "link-out"));
    symlinkSync(outside, join(dir, "link-out-untracked"));
    symlinkSync("no-such-target", join(dir, "link-dangling"));
    symlinkSync("inner", join(dir, "link-inner"));
    git(dir, "add", "link-file", "link-out");
    // A submodule's entry (a gitlink) is a folder, not a file.
    git(dir, "update-index", "--add", "--cacheinfo", `160000,${git(dir, "rev-parse", "HEAD").trim()},sub`);
    git(dir, "commit", "-q", "-m", "links");
    write(join(dir, "new.txt"));
    const { paths, code } = await listGit(dir, opts());
    expect(code).toBe(0);
    expect(paths).toEqual(["a.txt", "inner/b.txt", "new.txt"]);
  });

  test("an unmerged path is listed once", async () => {
    const dir = repo(["a.txt", "c.txt"]);
    git(dir, "checkout", "-q", "-b", "other");
    write(join(dir, "a.txt"), "other\n");
    git(dir, "commit", "-q", "-am", "other");
    git(dir, "checkout", "-q", "main");
    write(join(dir, "a.txt"), "main\n");
    git(dir, "commit", "-q", "-am", "main");
    spawnSync(GIT!, ["-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "-q", "other"], { env: { ...BASE, ...ISOLATED } });
    expect(git(dir, "ls-files", "-u")).toContain("a.txt");
    const { paths } = await listGit(dir, opts());
    expect(paths).toEqual(["a.txt", "c.txt"]);
  });

  test("ignored files are left out; a nested repository is dropped with everything in it", async () => {
    const dir = repo([".gitignore", "kept.txt"], ["ignored/secret.txt", "build.log", "new.txt", "nested/inside.txt"]);
    writeFileSync(join(dir, ".gitignore"), "ignored/\n*.log\n");
    git(join(dir, "nested"), "init", "-q");
    const { paths } = await listGit(dir, opts());
    expect(paths).toEqual([".gitignore", "kept.txt", "new.txt"]);
  });

  test("names come out exact (-z); a name with a control character is dropped, its neighbours kept", async () => {
    const names = ["back\\slash.txt", "été.txt", "日本語/メモ.md", "rocket 🚀.md", "with space.txt"];
    const dir = repo(names, ["new\nline.txt", "tab\there.txt", "z-last.txt"]);
    const { paths } = await listGit(dir, opts());
    expect(paths).toEqual(["back\\slash.txt", "rocket 🚀.md", "with space.txt", "été.txt", "日本語/メモ.md", "z-last.txt"]);
    expect(keepPath("new\nline.txt")).toBe(false);
    expect(keepPath("bad-\uFFFD.txt")).toBe(false);
  });

  test("a GIT_DIR or GIT_WORK_TREE in the server's environment does not redirect the listing", async () => {
    const mine = repo(["mine.txt"]);
    const other = repo(["other-1.txt", "other-2.txt"]);
    const got = await listGit(mine, opts(100_000, 5_000, { GIT_DIR: join(other, ".git"), GIT_WORK_TREE: other, GIT_INDEX_FILE: join(other, ".git", "index") }));
    expect(got.paths).toEqual(["mine.txt"]);
  });

  test("a subfolder of a repository lists its own files, relative to it, with no ../ path", async () => {
    const dir = repo(["top.txt", "web/App.tsx", "web/chat/Chat.tsx"], ["web/new.ts", "other.txt"]);
    const { paths, code } = await listGit(join(dir, "web"), opts());
    expect(code).toBe(0);
    expect(paths).toEqual(["App.tsx", "chat/Chat.tsx", "new.ts"]);
  });

  test("a git program that is not an absolute path is refused, so no file of the chat folder can run as git", async () => {
    // git runs with the chat folder as its working folder: a relative program would be found from there.
    const dir = repo(["a.txt"]);
    const mark = join(ROOT, `relative-git-mark-${n}`);
    writeFileSync(join(dir, "git"), `#!/bin/sh\necho ran >> '${mark}'\n`);
    chmodSync(join(dir, "git"), 0o755);
    for (const g of ["./git", "git", "sub/../git"]) {
      expect(await listGit(dir, { ...opts(), git: g })).toEqual({ code: null, paths: [], capped: false, timeout: false, spawnFailed: true });
    }
    expect(existsSync(mark)).toBe(false);
  });

  test("a stalled git is killed at the deadline, and what it gave stands", async () => {
    const fake = join(ROOT, "stalled-git.sh");
    // The tracked part is read with its modes (--stage).
    const blob = "100644 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 0";
    writeFileSync(fake, `#!/bin/sh\nprintf '${blob}\\011a.txt\\000${blob}\\011b.txt\\000'\nexec sleep 30\n`);
    chmodSync(fake, 0o755);
    const t0 = performance.now();
    const got = await listGit(ROOT, { ...opts(100_000, 300), git: fake });
    expect(performance.now() - t0).toBeLessThan(3_000);
    expect(got).toEqual({ code: null, paths: ["a.txt", "b.txt"], capped: false, timeout: true, spawnFailed: false });
  });
});

describe.skipIf(!GIT)("which builder", () => {
  const list = (root: string, more: Parameters<typeof listCorpus>[1] = {}) => listCorpus(root, { git: GIT, env: BASE, extraEnv: ISOLATED, ...more });

  test("a repository: git, complete, with git's exit code", async () => {
    const dir = repo(["a.txt", "src/b.ts"], ["c.md"]);
    const got = await list(dir);
    expect({ ...got, ms: 0 }).toEqual({ source: "git", paths: ["a.txt", "src/b.ts", "c.md"], complete: true, capped: false, timeout: false, code: 0, ms: 0, spawnFailed: false });
  });

  test("not a repository: the walk, with no exit code", async () => {
    const dir = join(ROOT, "plain");
    write(join(dir, "notes.md"));
    write(join(dir, "sub", "todo.txt"));
    const got = await list(dir);
    expect(got.source).toBe("walk");
    expect(got.code).toBeNull();
    expect(got.paths).toEqual(["notes.md", "sub/todo.txt"]);
  });

  test("a folder in an ignored part of a repository (git lists nothing) falls to the walk", async () => {
    const dir = repo([".gitignore", "kept.txt"], ["out/report.txt"]);
    writeFileSync(join(dir, ".gitignore"), "out/\n");
    const got = await list(join(dir, "out"));
    expect([got.source, got.paths]).toEqual(["walk", ["report.txt"]]);
  });

  test("no git, or a git that cannot start: the walk", async () => {
    const dir = repo(["a.txt"]);
    expect((await list(dir, { git: null })).source).toBe("walk");
    const broken = await list(dir, { git: join(ROOT, "no-such-git") });
    expect([broken.source, broken.spawnFailed, broken.paths]).toEqual(["walk", true, ["a.txt"]]);
  });

  /**
   * The build in a child process that stands for the server: its own folder is `server`, and `PATH` is the PATH
   * the build gets. The repository holds a git file of its own, which must never run either.
   */
  async function serverBuild(name: string, PATH: string) {
    const server = join(ROOT, `${name}-server`);
    const marks = { dot: join(ROOT, `${name}-dot-mark`), bin: join(ROOT, `${name}-bin-mark`), planted: join(ROOT, `${name}-planted-mark`) };
    // A git in the server's folder (".", and the empty entry) and one under the relative entry "bin".
    fakeGit(join(server, "git"), marks.dot, `exec '${GIT}' "$@"`);
    fakeGit(join(server, "bin", "git"), marks.bin, `exec '${GIT}' "$@"`);
    const dir = repo(["a.txt"]);
    fakeGit(join(dir, "git"), marks.planted);
    const build = join(import.meta.dir, "..", "..", "server", "search", "build.ts");
    const code = [
      `import { listCorpus } from ${JSON.stringify(build)};`,
      `const got = await listCorpus(${JSON.stringify(dir)}, { env: { PATH: ${JSON.stringify(PATH)}, HOME: ${JSON.stringify(HOME)} }, extraEnv: ${JSON.stringify(ISOLATED)} });`,
      `console.log(JSON.stringify({ which: Bun.which("git", { PATH: ${JSON.stringify(PATH)} }), source: got.source, paths: got.paths }));`,
    ].join("\n");
    const child = Bun.spawn([process.execPath, "-e", code], { cwd: server, env: { PATH: "/usr/bin:/bin", HOME }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, err] = [await new Response(child.stdout).text(), await new Response(child.stderr).text()];
    expect([await child.exited, err]).toEqual([0, ""]);
    const ran = Object.entries(marks).flatMap(([k, m]) => (existsSync(m) ? [k] : []));
    return { ...(JSON.parse(out) as { which: string | null; source: string; paths: string[] }), ran };
  }

  test("relative and empty PATH entries: no git they name runs, and with no absolute git the walk lists the folder", async () => {
    for (const [i, PATH] of [".", "bin", ".::bin", ":bin:"].entries()) {
      const got = await serverBuild(`relative-${i}`, PATH);
      // Bun.which finds a relative git here, from the server's folder; the build takes none of them.
      expect(got.which !== null && !got.which.startsWith("/")).toBe(true);
      expect({ PATH, ...got, which: null }).toEqual({ PATH, which: null, source: "walk", paths: ["a.txt", "git"], ran: [] });
    }
  });

  test("an absolute PATH entry after relative ones: that git runs, with the relative and empty entries out of its PATH", async () => {
    const abs = join(ROOT, "absolute-bin");
    const seen = join(ROOT, "absolute-git-path");
    fakeGit(join(abs, "git"), join(ROOT, "absolute-git-mark"), `printf '%s\\n' "$PATH" >> '${seen}'\nexec '${GIT}' "$@"`);
    const got = await serverBuild("absolute", `.::bin:${abs}:/usr/bin:`);
    expect(got).toEqual({ which: "./git", source: "git", paths: ["a.txt", "git"], ran: [] });
    // Both ls-files calls ran this git, each with only the absolute entries.
    expect(readFileSync(seen, "utf8")).toBe(`${abs}:/usr/bin\n`.repeat(2));
  });

  test("a folder that is not there: none", async () => {
    const got = await list(join(ROOT, "gone"));
    expect([got.source, got.paths, got.complete]).toEqual(["none", [], false]);
  });

  test("a capped git listing is not complete", async () => {
    const dir = repo(["a.txt", "b.txt", "c.txt"]);
    const got = await list(dir, { max: 2 });
    expect([got.source, got.paths, got.capped, got.complete]).toEqual(["git", ["a.txt", "b.txt"], true, false]);
  });

  test("the build writes nothing to the repository", async () => {
    const dir = repo(["a.txt"], ["u.txt"]);
    const index = readFileSync(join(dir, ".git", "index"));
    await list(dir);
    expect(readFileSync(join(dir, ".git", "index")).equals(index)).toBe(true);
    expect(existsSync(join(dir, ".git", "index.lock"))).toBe(false);
  });
});
