// bin/update.sh (DESIGN.md 4.10; build checklist S17; owner row 108) in a scratch clone whose origin is a local bare
// repository with one new commit. The script runs server/update/cli.ts, the same update source as the Update button,
// so the scratch project holds this checkout's bin/update.sh, server/ and shared/: its three steps run in order, the
// build goes beside the build folder and takes its place, and the last line says how to apply the update; a step that
// fails is named and stops the rest; a checkout with local changes, or one that diverged from origin, is refused with
// its one line; a live holder of the update lock keeps it out. The scratch project has no dependency (so the locked
// install needs no network) and a build script that writes a page and the stamp of the commit it built. And the real
// page build writes its stamp, build.json, with the checkout's HEAD.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { systemProcs } from "../../server/chats/stops";
import { UPDATE_LOCK } from "../../server/update/lock";
import { readStamp, stampText } from "../../server/update/stamp";

const REPO = resolve(import.meta.dir, "..", "..");
const GIT = ["/usr/bin/git", "/bin/git"].find((g) => existsSync(g)) ?? null;
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "kitespan-update-sh-")));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const HOME = join(ROOT, "home");
mkdirSync(HOME);
const ENV = { PATH: `${resolve(process.execPath, "..")}:/usr/bin:/bin`, HOME, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const LAST_LINE = "Restart kitespan to apply it: Settings > About > Restart, or bin/kitespan restart.";

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync(GIT!, ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { env: ENV, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** The scratch build: a page and the stamp of the commit it built, into the folder that --out names. */
const BUILD = `const out = process.argv[process.argv.indexOf("--out") + 1];
const { mkdirSync, writeFileSync } = await import("node:fs");
mkdirSync(out, { recursive: true });
const head = Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim();
writeFileSync(out + "/index.html", head);
writeFileSync(out + "/build.json", JSON.stringify({ v: 1, head }) + "\\n");
`;

let n = 0;
/** A bare origin holding a scratch kitespan (the real update.sh and its code, a build that stamps its commit), and a clone. */
function setup(build = BUILD) {
  const id = ++n;
  const bare = join(ROOT, `origin-${id}.git`);
  git(ROOT, "init", "-q", "--bare", "-b", "main", bare);
  const seed = join(ROOT, `seed-${id}`);
  git(ROOT, "clone", "-q", bare, seed);
  mkdirSync(join(seed, "bin"));
  copyFileSync(join(REPO, "bin", "update.sh"), join(seed, "bin", "update.sh"));
  cpSync(join(REPO, "server"), join(seed, "server"), { recursive: true });
  cpSync(join(REPO, "shared"), join(seed, "shared"), { recursive: true });
  writeFileSync(join(seed, "package.json"), JSON.stringify({ name: "scratch", private: true, scripts: { build: "bun build.ts" } }));
  writeFileSync(join(seed, "build.ts"), build);
  writeFileSync(join(seed, ".gitignore"), "node_modules/\ndist/\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "one");
  git(seed, "push", "-q", "origin", "HEAD:main");
  const install = join(ROOT, `install-${id}`);
  git(ROOT, "clone", "-q", bare, install);
  const first = git(install, "rev-parse", "HEAD");
  const dist = join(install, "dist", "web");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.html"), "old");
  writeFileSync(join(dist, "build.json"), stampText(first));
  // One new commit on origin.
  writeFileSync(join(seed, "new.txt"), "new\n");
  git(seed, "add", "new.txt");
  git(seed, "commit", "-q", "-m", "two");
  git(seed, "push", "-q", "origin", "HEAD:main");
  return { bare, seed, install, dist, first, newHead: git(seed, "rev-parse", "HEAD") };
}

function update(install: string) {
  const r = spawnSync("sh", [join(install, "bin", "update.sh")], { cwd: HOME, env: ENV, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe.skipIf(!GIT)("bin/update.sh (S17, row 108)", () => {
  test("fetch, install and build in order; the build is the new commit's and takes the build folder's place; the last line says how to apply it", () => {
    const s = setup();
    const r = update(s.install);
    expect(r.code).toBe(0);
    expect(git(s.install, "rev-parse", "HEAD")).toBe(s.newHead);
    expect(readStamp(s.dist)).toEqual({ head: s.newHead });
    expect(readFileSync(join(s.dist, "index.html"), "utf8")).toBe(s.newHead);
    expect(existsSync(`${s.dist}.next`)).toBe(false);
    expect(r.out.trimEnd().split("\n").at(-1)).toBe(LAST_LINE);
    // The lock went back.
    expect(existsSync(join(HOME, ".local", "state", "kitespan", UPDATE_LOCK))).toBe(false);
  }, 60_000);

  test("a checkout that diverged from origin: refused at step 1 with its line; nothing is built", () => {
    const s = setup();
    writeFileSync(join(s.install, "mine.txt"), "mine\n");
    git(s.install, "add", "mine.txt");
    git(s.install, "commit", "-q", "-m", "mine");
    const mine = git(s.install, "rev-parse", "HEAD");
    const r = update(s.install);
    expect(r.code).toBe(1);
    expect(r.err).toContain("update.sh: This checkout and origin have diverged; kitespan cannot fast-forward it.");
    expect(r.err).toContain("update.sh: step 1 of 3 failed: git fetch and git merge --ff-only");
    expect(git(s.install, "rev-parse", "HEAD")).toBe(mine);
    expect(readStamp(s.dist)).toEqual({ head: s.first });
    expect(r.out).not.toContain(LAST_LINE);
  }, 60_000);

  test("a build that fails is step 3, named; the fast-forward stays and the build folder is as it was", () => {
    const s = setup("process.exit(3);\n");
    const r = update(s.install);
    expect(r.code).toBe(1);
    expect(r.err).toContain("update.sh: step 3 of 3 failed: bun run build");
    expect(git(s.install, "rev-parse", "HEAD")).toBe(s.newHead);
    expect(readFileSync(join(s.dist, "index.html"), "utf8")).toBe("old");
    expect(existsSync(`${s.dist}.next`)).toBe(false);
    expect(r.out).not.toContain(LAST_LINE);
  }, 60_000);

  test("a checkout with local changes is refused with its one line, before any step", () => {
    const s = setup();
    writeFileSync(join(s.install, "build.ts"), "// a local change\n");
    const r = update(s.install);
    expect(r.code).toBe(1);
    expect(r.err.trim()).toBe("update.sh: This checkout has local changes.");
    expect(git(s.install, "rev-parse", "HEAD")).toBe(s.first);
  }, 60_000);

  test("while a live process holds the update lock (the Update button's job), it does not start", async () => {
    const s = setup();
    const state = join(HOME, ".local", "state", "kitespan");
    mkdirSync(state, { recursive: true, mode: 0o700 });
    const start = await systemProcs.startOf(process.pid);
    writeFileSync(join(state, UPDATE_LOCK), `${JSON.stringify({ v: 1, pid: process.pid, start })}\n`, { mode: 0o600 });
    try {
      const r = update(s.install);
      expect(r.code).toBe(1);
      expect(r.err.trim()).toBe("update.sh: Another update is running.");
      expect(git(s.install, "rev-parse", "HEAD")).toBe(s.first);
    } finally {
      rmSync(join(state, UPDATE_LOCK), { force: true });
    }
  }, 60_000);
});

describe.skipIf(!GIT)("the page build's stamp (S3)", () => {
  test(
    "scripts/build-web.ts writes build.json with the checkout's HEAD beside index.html",
    () => {
      const out = join(ROOT, "built-web");
      const r = spawnSync(process.execPath, [join(REPO, "scripts", "build-web.ts"), "--out", out], { cwd: REPO, env: { ...ENV, GIT_CONFIG_GLOBAL: "/dev/null" }, encoding: "utf8" });
      expect(r.status).toBe(0);
      expect(existsSync(join(out, "index.html"))).toBe(true);
      expect(readStamp(out)).toEqual({ head: git(REPO, "rev-parse", "HEAD") });
    },
    60_000,
  );
});
