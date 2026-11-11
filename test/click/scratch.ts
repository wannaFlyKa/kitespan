// A scratch checkout for the update flows (owner row 108; scripts/ui-check.ts update-*), so that an Update runs only in
// a clone of the click-through's own, never in this checkout. In one new temporary folder:
// - `app`: a clone of this checkout's HEAD on a branch of its own, with this checkout's working tree on top (its
//   changed, new and removed files, committed there: the flows test the code as it is now), its locked install
//   without optional packages and its page built (dist/web, with its stamp);
// - `origin`: a clone of app that app's branch follows, with one more commit (`next`): by default one that changes the
//   page's script, so the build's hashed names change; or none.
// `localChange` leaves one changed file in app (the refusal). Nothing is ever pushed, and this checkout is only read
// (git clone, ls-files); every git here runs with no system or global git config and no hook.
//
// An installed kitespan (DESIGN-I1 3.9; scripts/ui-check.ts update-install and update-brew):
// - scratchRelease(): in one new temporary folder, two release archives of a scratch commit of this checkout's working
//   tree (0.1.0, and 0.1.1 with package.json's version changed and one line added to the page's script), in one folder
//   with its SHA256SUMS (0.1.0 only until publish(), then both) and install.sh; 0.1.0 installed by its own install.sh
//   with KITESPAN_VERSION=0.1.0 and KITESPAN_INSTALL_FROM=<that folder>, HOME and the XDG folders inside the scratch
//   folder, and a `bun` first on PATH that runs `bun install` with no network (`unshare -cn`) and the user's own Bun
//   cache (BUN_INSTALL_CACHE_DIR), so nothing is fetched.
// - scratchBrew(): a Homebrew layout by hand: <tmp>/prefix/Cellar/kitespan/0.1.0/libexec (this checkout's working tree,
//   its node_modules a link to this checkout's, its page built there; never a `bun install` in it), its
//   INSTALL_RECEIPT.json, and <tmp>/prefix/opt/kitespan -> ../Cellar/kitespan/0.1.0; upgrade() makes the keg 0.1.1 and
//   moves opt to it, as `brew upgrade` would.

import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ROOT } from "./harness";

export interface ScratchApp {
  tmp: string;
  app: string;
  origin: string;
  dist: string;
  branch: string;
  /** app's HEAD, which its build is of. */
  head: string;
  /** origin's new commit, or null when it has none. */
  next: string | null;
  /** The environment that the app's server should add: no system or global git config for its git either. */
  serverEnv: Record<string, string>;
  remove(): void;
}

const BRANCH = "kitespan-click-update";
const ISOLATED = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const WHO = ["-c", "user.name=kitespan click-through", "-c", "user.email=kitespan-click@example.invalid", "-c", "commit.gpgsign=false"];

function env(): Record<string, string> {
  return { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: process.env.HOME ?? tmpdir(), TMPDIR: tmpdir(), LANG: "C.UTF-8", ...ISOLATED };
}

function run(cmd: string[], cwd: string, ms: number): string {
  const r = Bun.spawnSync(cmd, { cwd, env: env(), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: ms, killSignal: "SIGKILL" });
  if (r.exitCode !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} failed (exit ${r.exitCode}): ${r.stderr.toString().trim().split("\n").slice(-3).join(" | ")}`);
  return r.stdout.toString();
}
const git = (cwd: string, ...args: string[]) => run(["git", "-c", "core.hooksPath=/dev/null", ...args], cwd, 120_000).trim();

/** This checkout's working tree as git sees it, read only: the files to copy (tracked or new, not ignored) and the removed ones. */
function workingTree(): { files: string[]; gone: string[] } {
  const list = (...args: string[]) => run(["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "ls-files", "-z", ...args], ROOT, 60_000).split("\0").filter(Boolean);
  const gone = new Set(list("--deleted"));
  const files = [...new Set([...list("--cached"), ...list("--others", "--exclude-standard")])].filter((f) => !gone.has(f));
  return { files, gone: [...gone] };
}

/** This checkout's working tree (its tracked and new files that git does not ignore) copied into `dest`, which exists. */
function copyWorkingTree(dest: string): { gone: string[] } {
  const tree = workingTree();
  for (const f of tree.files) {
    const from = join(ROOT, f);
    let st;
    try {
      st = lstatSync(from);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    mkdirSync(dirname(join(dest, f)), { recursive: true });
    copyFileSync(from, join(dest, f));
  }
  return { gone: tree.gone };
}

/** A clone of this checkout's HEAD at `dest` on a branch of its own, with the working tree on top as one commit. */
function cloneWithWorkingTree(tmp: string, dest: string): void {
  const head0 = git(ROOT, "rev-parse", "HEAD");
  git(tmp, "clone", "--quiet", "--no-hardlinks", "--no-checkout", ROOT, dest);
  git(dest, "checkout", "--quiet", "-b", BRANCH, head0);
  const { gone } = copyWorkingTree(dest);
  for (const f of gone) if (existsSync(join(dest, f))) unlinkSync(join(dest, f));
  git(dest, "add", "-A");
  if (git(dest, "status", "--porcelain")) git(dest, ...WHO, "commit", "--quiet", "--no-verify", "-m", "The click-through's working tree");
}

export function scratchApp(o: { next?: "page" | "none"; localChange?: boolean } = {}): ScratchApp {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "kitespan-click-update-")));
  const remove = () => rmSync(tmp, { recursive: true, force: true });
  try {
    const app = join(tmp, "app");
    const origin = join(tmp, "origin");
    // This checkout's working tree on top, as one commit.
    cloneWithWorkingTree(tmp, app);
    const head = git(app, "rev-parse", "HEAD");
    git(tmp, "clone", "--quiet", "--no-hardlinks", app, origin);
    git(origin, "checkout", "--quiet", BRANCH);
    let next: string | null = null;
    if ((o.next ?? "page") === "page") {
      // A line that changes the page's script, so the new build's hashed names differ.
      const main = join(origin, "web", "main.tsx");
      writeFileSync(main, `${readFileSync(main, "utf8")}document.documentElement.dataset.update = "${crypto.randomUUID().slice(0, 8)}";\n`);
      git(origin, "add", "web/main.tsx");
      git(origin, ...WHO, "commit", "--quiet", "--no-verify", "-m", "A new page for the click-through's update");
      next = git(origin, "rev-parse", "HEAD");
    }
    git(app, "remote", "set-url", "origin", origin);
    git(app, "config", `branch.${BRANCH}.remote`, "origin");
    git(app, "config", `branch.${BRANCH}.merge`, `refs/heads/${BRANCH}`);
    run([process.execPath, "install", "--frozen-lockfile", "--omit=optional"], app, 300_000);
    run([process.execPath, "run", "build"], app, 300_000);
    const dist = join(app, "dist", "web");
    if (!existsSync(join(dist, "index.html"))) throw new Error("the scratch checkout's build wrote no page");
    if (o.localChange) writeFileSync(join(app, "README.md"), `${readFileSync(join(app, "README.md"), "utf8")}\nA local change.\n`);
    return { tmp, app, origin, dist, branch: BRANCH, head, next, serverEnv: { ...ISOLATED }, remove };
  } catch (e) {
    remove();
    throw e;
  }
}

/** The build stamp's commit of a build folder, or null. */
export function stampHead(dist: string): string | null {
  try {
    const head = (JSON.parse(readFileSync(join(dist, "build.json"), "utf8")) as { head?: unknown }).head;
    return typeof head === "string" ? head : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// An installed kitespan (DESIGN-I1 3.9)

const SHA = (file: string) => new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex");

/** package.json with `version` set to `v` (the other fields as they are). */
function setVersion(dir: string, v: string): void {
  const file = join(dir, "package.json");
  const pkg = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  // Right after "name", as the release's package.json has it.
  for (const [k, val] of Object.entries(pkg)) {
    if (k === "version") continue;
    out[k] = val;
    if (k === "name") out.version = v;
  }
  if (!("version" in out)) out.version = v;
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
}

/** The user's own Bun cache (read only here: an install with no network takes its packages from it). */
export function userBunCache(): string {
  const set = process.env.BUN_INSTALL_CACHE_DIR;
  if (set) return set;
  // `bun pm cache` only prints the folder, and needs a package.json in its folder: this checkout's.
  const r = Bun.spawnSync([process.execPath, "pm", "cache"], { cwd: ROOT, env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: process.env.HOME ?? tmpdir() }, stdout: "pipe", stderr: "ignore" });
  const dir = r.stdout.toString().trim().split("\n")[0] ?? "";
  if (r.exitCode !== 0 || !dir.startsWith("/")) throw new Error("bun pm cache did not name Bun's cache folder");
  return dir;
}

/** Why an install with no network cannot run here, or null: unshare -cn (a network namespace of the user's own). */
export function offlineProblem(): string | null {
  const unshare = Bun.which("unshare", { PATH: "/usr/bin:/bin" });
  if (!unshare) return "needs unshare: offline by construction";
  const r = Bun.spawnSync([unshare, "-cn", "true"], { stdout: "ignore", stderr: "ignore", timeout: 10_000 });
  return r.exitCode === 0 ? null : "needs unshare -cn: offline by construction";
}

/**
 * A folder whose `bun` runs `bun install` in a network namespace of its own (no network at all) and every other bun
 * command as it is: first on an installer's PATH, so its locked install can only take packages from the cache.
 */
export function offlineBun(dir: string): string {
  const unshare = Bun.which("unshare", { PATH: "/usr/bin:/bin" });
  if (!unshare) throw new Error("needs unshare: offline by construction");
  mkdirSync(dir, { recursive: true });
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  writeFileSync(join(dir, "bun"), `#!/bin/sh\n# kitespan's click-through: bun install with no network (unshare -cn), every other command as it is.\ncase \${1-} in\n  install) exec ${q(unshare)} -cn ${q(process.execPath)} "$@" ;;\nesac\nexec ${q(process.execPath)} "$@"\n`);
  chmodSync(join(dir, "bun"), 0o755);
  return dir;
}

export interface ScratchRelease {
  tmp: string;
  /** KITESPAN_INSTALL_FROM: the archives, install.sh and SHA256SUMS. */
  releases: string;
  /** HOME and the XDG folders that the first install ran with. */
  home: string;
  data: string;
  /** <data>/kitespan, its versions/ and current. */
  kit: string;
  /** The installed 0.1.0 (a real path): the server's root. */
  root: string;
  dist: string;
  /** The user's own Bun cache. */
  cache: string;
  /** install.sh's output of the first install. */
  installLog: string;
  /** SHA256SUMS lists 0.1.1 too from now on: the new release is out. */
  publish(): void;
  remove(): void;
}

/** Why scratchRelease() cannot run here (the seed's flow skips with it), or null. */
export function releaseProblem(): string | null {
  if (!existsSync(join(ROOT, "install.sh"))) return "needs install.sh at the repository's top (INSTALLER's)";
  return offlineProblem();
}

export function scratchRelease(): ScratchRelease {
  const problem = releaseProblem();
  if (problem) throw new Error(problem);
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "kitespan-click-release-")));
  const remove = () => rmSync(tmp, { recursive: true, force: true });
  try {
    const src = join(tmp, "src");
    const releases = join(tmp, "releases");
    mkdirSync(releases);
    cloneWithWorkingTree(tmp, src);
    // 0.1.0: the working tree as it is, with that version.
    setVersion(src, "0.1.0");
    git(src, "add", "package.json");
    if (git(src, "status", "--porcelain")) git(src, ...WHO, "commit", "--quiet", "--no-verify", "-m", "kitespan 0.1.0 for the click-through");
    const c0 = git(src, "rev-parse", "HEAD");
    // 0.1.1: its version, and a line that changes the page's script (so the new build's hashed names differ).
    setVersion(src, "0.1.1");
    const main = join(src, "web", "main.tsx");
    writeFileSync(main, `${readFileSync(main, "utf8")}document.documentElement.dataset.release = "0.1.1";\n`);
    git(src, "add", "package.json", "web/main.tsx");
    git(src, ...WHO, "commit", "--quiet", "--no-verify", "-m", "kitespan 0.1.1 for the click-through");
    const c1 = git(src, "rev-parse", "HEAD");
    const archive = (v: string, commit: string) => {
      const out = join(releases, `kitespan-${v}.tar.gz`);
      run(["/bin/sh", "-c", 'git -C "$1" -c core.hooksPath=/dev/null archive --format=tar --prefix="kitespan-$2/" "$3" | gzip -n -9 > "$4"', "sh", src, v, commit, out], tmp, 120_000);
      return out;
    };
    const a0 = archive("0.1.0", c0);
    const a1 = archive("0.1.1", c1);
    writeFileSync(join(releases, "install.sh"), run(["git", "-c", "core.hooksPath=/dev/null", "show", `${c0}:install.sh`], src, 30_000));
    chmodSync(join(releases, "install.sh"), 0o755);
    const sums = (archives: string[]) => writeFileSync(join(releases, "SHA256SUMS"), [...archives.map((a) => `${SHA(a)}  ${a.slice(releases.length + 1)}`), `${SHA(join(releases, "install.sh"))}  install.sh`, ""].join("\n"));
    sums([a0]);

    const home = join(tmp, "home");
    const data = join(tmp, "data");
    for (const d of [home, data, join(tmp, "state"), join(tmp, "config"), join(tmp, "tmp")]) mkdirSync(d, { recursive: true, mode: 0o700 });
    const cache = userBunCache();
    const shim = offlineBun(join(tmp, "offline-bin"));
    const path = `${shim}:/usr/bin:/bin`;
    // The real claude never runs: no claude on this PATH (the installer only looks for one).
    for (const d of path.split(":")) if (existsSync(join(d, "claude"))) throw new Error(`${d} holds a claude; the click-through's install runs with none`);
    const env = {
      PATH: path,
      HOME: home,
      XDG_DATA_HOME: data,
      XDG_STATE_HOME: join(tmp, "state"),
      XDG_CONFIG_HOME: join(tmp, "config"),
      TMPDIR: join(tmp, "tmp"),
      LANG: "C.UTF-8",
      KITESPAN_VERSION: "0.1.0",
      KITESPAN_INSTALL_FROM: releases,
      BUN_INSTALL_CACHE_DIR: cache,
    };
    const r = Bun.spawnSync(["/bin/sh", join(releases, "install.sh")], { cwd: tmp, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 600_000, killSignal: "SIGKILL" });
    const installLog = `${r.stdout.toString()}${r.stderr.toString()}`;
    if (r.exitCode !== 0) throw new Error(`install.sh of 0.1.0 exited ${r.exitCode}: ${installLog.trim().split("\n").slice(-4).join(" | ")}`);
    const kit = join(data, "kitespan");
    const root = realpathSync(join(kit, "versions", "0.1.0"));
    const dist = join(root, "dist", "web");
    if (!existsSync(join(dist, "index.html"))) throw new Error("the installed 0.1.0 has no page");
    return { tmp, releases, home, data, kit, root, dist, cache, installLog, publish: () => sums([a0, a1]), remove };
  } catch (e) {
    remove();
    throw e;
  }
}

export interface ScratchBrew {
  tmp: string;
  prefix: string;
  /** The keg 0.1.0's libexec (a real path): the server's root. */
  root: string;
  dist: string;
  /** The keg 0.1.1, and opt moved to it, as `brew upgrade kitespan` leaves them. */
  upgrade(): void;
  remove(): void;
}

export function scratchBrew(): ScratchBrew {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "kitespan-click-brew-")));
  const remove = () => rmSync(tmp, { recursive: true, force: true });
  try {
    const prefix = join(tmp, "prefix");
    const keg = (v: string) => join(prefix, "Cellar", "kitespan", v);
    const libexec = join(keg("0.1.0"), "libexec");
    mkdirSync(libexec, { recursive: true });
    copyWorkingTree(libexec);
    setVersion(libexec, "0.1.0");
    // The page is built against this checkout's packages; no install ever runs in this folder.
    symlinkSync(join(ROOT, "node_modules"), join(libexec, "node_modules"));
    run([process.execPath, "run", "build"], libexec, 300_000);
    const dist = join(libexec, "dist", "web");
    if (!existsSync(join(dist, "index.html"))) throw new Error("the scratch keg's build wrote no page");
    writeFileSync(join(keg("0.1.0"), "INSTALL_RECEIPT.json"), "{}\n");
    mkdirSync(join(prefix, "opt"), { recursive: true });
    symlinkSync("../Cellar/kitespan/0.1.0", join(prefix, "opt", "kitespan"));
    const upgrade = () => {
      cpSync(keg("0.1.0"), keg("0.1.1"), { recursive: true, verbatimSymlinks: true });
      setVersion(join(keg("0.1.1"), "libexec"), "0.1.1");
      // rename(2) replaces the link itself (a POSIX mv would move into the folder it names).
      const tmpLink = join(prefix, "opt", ".kitespan.new");
      symlinkSync("../Cellar/kitespan/0.1.1", tmpLink);
      renameSync(tmpLink, join(prefix, "opt", "kitespan"));
    };
    return { tmp, prefix, root: realpathSync(libexec), dist: realpathSync(dist), upgrade, remove };
  } catch (e) {
    remove();
    throw e;
  }
}
