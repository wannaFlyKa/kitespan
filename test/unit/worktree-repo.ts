// Scratch git repositories for the worktree tests (row 73): each under its own mkdtemp folder, with git's global and
// system config files turned off (GIT_CONFIG_GLOBAL=/dev/null, GIT_CONFIG_NOSYSTEM=1), so neither the user's own git
// config nor any real repository is read or touched. kitespan's worktree git gets the same two names after its scrub.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findGit } from "../../server/search/git";
import { worktreeGit, type WorktreeGit } from "../../server/worktree/git";

/** The two names that keep a test's git away from the user's own config. */
export const GIT_TEST_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } as const;

const GIT = findGit(process.env.PATH ?? "");

/** The environment of the test's own git calls: no inherited GIT_* name, the scratch config, a fixed author. */
function testEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
  return {
    ...env,
    ...GIT_TEST_ENV,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** Run the test's own git in `cwd`; throws on a failure, returns stdout. */
export function git(cwd: string, ...args: string[]): string {
  if (!GIT) throw new Error("no git on PATH");
  const r = Bun.spawnSync([GIT, "-c", "init.defaultBranch=main", "-C", cwd, ...args], { env: testEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

/** Run the test's own git in `cwd`, and say only whether it worked. */
export function gitOk(cwd: string, ...args: string[]): boolean {
  try {
    git(cwd, ...args);
    return true;
  } catch {
    return false;
  }
}

export interface Scratch {
  /** The mkdtemp folder (a real path) that holds everything. */
  root: string;
  /** The main checkout: a repository with one commit (README.md) unless made `empty`. */
  repo: string;
  /** The data folder that `kitespan/worktrees` goes in. */
  data: string;
  /** kitespan's worktree git with the scratch config. */
  wg: WorktreeGit;
  /** The repository's first commit, or null for an empty one. */
  head: string | null;
  cleanup(): void;
}

/** A scratch repository (with one commit unless `empty`) and a data folder, under one mkdtemp folder. */
export function scratch(opts: { empty?: boolean } = {}): Scratch {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kitespan-wt-")));
  const repo = join(root, "repo");
  const data = join(root, "data");
  mkdirSync(repo);
  git(repo, "init", "-q");
  let head: string | null = null;
  if (!opts.empty) {
    writeFileSync(join(repo, "README.md"), "hello\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-q", "-m", "first");
    head = git(repo, "rev-parse", "HEAD").trim();
  }
  return {
    root,
    repo,
    data,
    wg: worktreeGit(process.env, GIT_TEST_ENV),
    head,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Commit every change of `cwd` with `message`. */
export function commitAll(cwd: string, message: string): string {
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD").trim();
}

/** The branches of the repository at `repo`, by short name. */
export function branches(repo: string): string[] {
  return git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/")
    .split("\n")
    .filter(Boolean)
    .sort();
}
