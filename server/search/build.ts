// One build of a chat folder's corpus (DESIGN.md 9.3; build checklist B1, B2): git when git is on the PATH's absolute
// entries (findGit, server/search/git.ts), the folder is in a repository (`ls-files --cached` exits 0) and the two
// calls give at least one path; otherwise the bounded walk. A root that is not a folder that can be read gives source
// `none`. At most 100,000 paths; git gets 5 s for both calls, the walk 3 s.

import { CORPUS_LIMITS, type CorpusSource } from "../../shared/corpus";
import { findGit, gitEnv, listGit } from "./git";
import { walkFiles, type WalkFs } from "./walk";

export const CORPUS_MS = { git: 5_000, walk: 3_000 } as const;

export interface CorpusListing {
  source: CorpusSource;
  /** Relative to the root, in git's order (tracked, then untracked) or the walk's (breadth first, by name). */
  paths: string[];
  /** False when the cap or a deadline cut the list. */
  complete: boolean;
  capped: boolean;
  timeout: boolean;
  /** The exit code of `ls-files --cached`, or null (the walk, or git could not tell). */
  code: number | null;
  ms: number;
  /** git was found but could not be started. */
  spawnFailed: boolean;
}

export interface ListOptions {
  max?: number;
  /** The git program (absolute); null: none (the walk only); absent: `git` on the PATH of `env` (findGit). */
  git?: string | null;
  /** The environment git's is made from (the server's own by default); every GIT_* variable is taken out. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Variables added after that (tests: a scratch HOME, so no user config is read). */
  extraEnv?: Readonly<Record<string, string>>;
  gitMs?: number;
  walkMs?: number;
  walkFs?: WalkFs;
}

/** The corpus of `root`, a real path. Never throws. */
export async function listCorpus(root: string, opts: ListOptions = {}): Promise<CorpusListing> {
  const t0 = performance.now();
  const max = opts.max ?? CORPUS_LIMITS.maxPaths;
  const env = opts.env ?? process.env;
  const git = opts.git === undefined ? findGit(env.PATH ?? "") : opts.git;
  let spawnFailed = false;
  if (git) {
    const g = await listGit(root, { git, max, ms: opts.gitMs ?? CORPUS_MS.git, env: gitEnv(env, opts.extraEnv) });
    spawnFailed = g.spawnFailed;
    // A repository: --cached exited 0, or listed paths before the cap or the deadline cut it.
    const repo = g.code === 0 || g.capped || g.timeout;
    if (repo && g.paths.length > 0) {
      return { source: "git", paths: g.paths, complete: !g.capped && !g.timeout, capped: g.capped, timeout: g.timeout, code: g.code, ms: performance.now() - t0, spawnFailed };
    }
  }
  const w = await walkFiles(root, { max, ms: opts.walkMs ?? CORPUS_MS.walk, fs: opts.walkFs });
  return {
    source: w.ok ? "walk" : "none",
    paths: w.paths,
    complete: w.ok && !w.capped && !w.timeout,
    capped: w.capped,
    timeout: w.timeout,
    // The log's `code` is the exit code of --cached for a git build, and null for the walk (B5).
    code: null,
    ms: performance.now() - t0,
    spawnFailed,
  };
}
