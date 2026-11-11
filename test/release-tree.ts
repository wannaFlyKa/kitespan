// A scratch repository for the release tests (DESIGN-I1 1.3, 4.3, 5.3): this checkout's working tree as git sees it
// (its tracked files and its new ones that are not ignored, without the removed ones) committed in a new repository in
// a temporary folder, so `git archive` and scripts/release.ts run on the code as it is now, and never on a commit of
// this checkout. This checkout is only read (git ls-files). Every git here runs with no system or global config and no
// hook.

import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "..");
export const ISOLATED = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const WHO = ["-c", "user.name=kitespan release test", "-c", "user.email=kitespan-release@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];

/** A small environment: Bun's own folder and the system's on PATH, the temporary folder, no git config of the user's. */
export function baseEnv(): Record<string, string> {
  return { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: process.env.HOME ?? tmpdir(), TMPDIR: tmpdir(), LANG: "C.UTF-8", ...ISOLATED };
}

export function run(cmd: string[], cwd: string, o: { env?: Record<string, string>; ms?: number } = {}): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(cmd, { cwd, env: o.env ?? baseEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: o.ms ?? 120_000, killSignal: "SIGKILL" });
  return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString() };
}

/** Runs a command that must succeed, and gives its stdout. */
export function must(cmd: string[], cwd: string, o: { env?: Record<string, string>; ms?: number } = {}): string {
  const r = run(cmd, cwd, o);
  if (r.code !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} failed (exit ${r.code}): ${r.err.trim().split("\n").slice(-3).join(" | ")}`);
  return r.out;
}

export const git = (repo: string, ...args: string[]) => must(["git", ...WHO, ...args], repo).trim();

export interface ReleaseTree {
  /** The temporary folder that holds everything here. */
  tmp: string;
  /** The scratch repository: one commit of this checkout's working tree on branch main. */
  repo: string;
  /** package.json's version in that commit. */
  version: string;
  remove(): void;
}

/** This checkout's working tree, committed in a new repository. */
export function releaseTree(prefix: string): ReleaseTree {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const remove = () => rmSync(tmp, { recursive: true, force: true });
  try {
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    const list = (...args: string[]) => must(["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "ls-files", "-z", ...args], ROOT).split("\0").filter(Boolean);
    const gone = new Set(list("--deleted"));
    const files = [...new Set([...list("--cached"), ...list("--others", "--exclude-standard")])].filter((f) => !gone.has(f));
    for (const f of files) {
      let st;
      try {
        st = lstatSync(join(ROOT, f));
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      mkdirSync(dirname(join(repo, f)), { recursive: true });
      copyFileSync(join(ROOT, f), join(repo, f));
    }
    git(repo, "init", "--quiet", "-b", "main");
    git(repo, "add", "-A");
    git(repo, "commit", "--quiet", "--no-verify", "-m", "The release test's working tree");
    const version = (JSON.parse(git(repo, "show", "HEAD:package.json")) as { version: string }).version;
    return { tmp, repo, version, remove };
  } catch (e) {
    remove();
    throw e;
  }
}

/** Runs the scratch repository's own scripts/release.ts (with `env` on top of baseEnv's, for example GITHUB_REPOSITORY). */
export function release(tree: ReleaseTree, args: string[], env: Record<string, string> = {}): { code: number; out: string; err: string } {
  return run([process.execPath, "--no-env-file", join(tree.repo, "scripts", "release.ts"), ...args], tree.tmp, { ms: 120_000, env: { ...baseEnv(), ...env } });
}
