// New environment's Suggested (D54): the folders of Claude Code's past sessions (newest first, existing folders only,
// at most 20), then the git repositories under the home folder that a walk in the background found (depth 3 at most,
// dot folders and node_modules skipped, symbolic links not followed, 2 s of walking at most, cached), each folder
// once, with the kitespan project that already has it. Read only, and within SUGGEST_LIMITS.readMs: the session list
// is cached too, and a check that is late (a stalled mount) leaves its folder out or unmarked.

import { readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { SuggestedFolder } from "../http/api-types";
import { byName, FOLDER_MS, FS_PROBES, hasGit, mapLimit, timeBudget, type FolderProbes } from "./list";

export const SUGGEST_LIMITS = {
  /** Session folders shown. */
  sessions: 20,
  /** Session folders looked at (each one once) before the list stops. */
  sessionsRead: 200,
  /** Repositories the walk keeps. */
  repos: 200,
  depth: 3,
  walkMs: 2_000,
  /** A cached walk older than this is served once more while a new one runs. */
  cacheMs: 5 * 60_000,
  /** The same for the session list (the SDK reads transcripts until it has its limit of terminal sessions). */
  sessionsCacheMs: 60_000,
  /** The longest a read waits for the first walk or session list (a file system that hangs stops no read). */
  waitMs: 2_500,
  /** The longest a Suggested read takes. */
  readMs: 4_000,
} as const;

/** Folder names the walk never enters (besides dot folders). */
const SKIP = new Set(["node_modules"]);

export interface RepoWalk {
  /** Absolute paths, sorted by path. */
  repos: string[];
  /** false: the walk stopped at its time budget or its cap, so some repositories may be missing. */
  complete: boolean;
}

/**
 * The git repositories (folders that hold a `.git` entry) under `home`, breadth first: the home folder's subfolders
 * are depth 1. A repository's own subfolders are not walked, and the home folder itself never counts as one.
 */
export async function findRepos(
  home: string,
  opts: { depth?: number; budgetMs?: number; cap?: number; now?: () => number } = {},
): Promise<RepoWalk> {
  const depth = opts.depth ?? SUGGEST_LIMITS.depth;
  const cap = opts.cap ?? SUGGEST_LIMITS.repos;
  const now = opts.now ?? (() => performance.now());
  const end = now() + (opts.budgetMs ?? SUGGEST_LIMITS.walkMs);
  const repos: string[] = [];
  let complete = true;
  const inTime = (): boolean => {
    if (now() <= end) return true;
    complete = false;
    return false;
  };
  let level = [resolve(home)];
  for (let d = 1; d <= depth && level.length > 0; d++) {
    const kids = (
      await mapLimit(level, 8, async (dir) => {
        if (!inTime()) return [];
        try {
          const ents = await readdir(dir, { withFileTypes: true });
          return ents.filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP.has(e.name)).map((e) => join(dir, e.name));
        } catch {
          return [];
        }
      })
    ).flat();
    kids.sort(byName);
    const marks = await mapLimit(kids, 16, async (k) => (inTime() ? hasGit(k) : null));
    level = [];
    kids.forEach((k, i) => {
      if (marks[i] === true) {
        if (repos.length < cap) repos.push(k);
        else complete = false;
      } else if (marks[i] === false && d < depth) level.push(k);
    });
    if (repos.length >= cap) {
      // Stopped with folders left to walk: some repositories may be missing.
      if (level.length > 0) complete = false;
      break;
    }
  }
  return { repos: repos.sort(byName), complete };
}

/**
 * A value read in the background and served from memory: the first read waits for the first load (`waitMs` at most,
 * then it answers `empty`); later reads answer at once, and a read of a value older than `cacheMs` starts a new load
 * in the background. A load that fails keeps the last value. `warm` starts a load with no reader (at boot).
 */
export class Cached<T> {
  private value: { v: T; at: number } | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly load: () => Promise<T>,
    private readonly empty: T,
    private readonly opts: { cacheMs?: number; waitMs?: number; now?: () => number } = {},
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** Start a load unless one runs. */
  warm(): Promise<void> {
    this.running ??= this.load()
      .then((v) => void (this.value = { v, at: this.now() }))
      .catch(() => {})
      .finally(() => (this.running = null));
    return this.running;
  }

  async get(): Promise<T> {
    if (!this.value) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waited = new Promise<void>((r) => (timer = setTimeout(r, this.opts.waitMs ?? SUGGEST_LIMITS.waitMs)));
      await Promise.race([this.warm(), waited]).finally(() => clearTimeout(timer));
    } else if (this.now() - this.value.at > (this.opts.cacheMs ?? SUGGEST_LIMITS.cacheMs)) void this.warm();
    return this.value?.v ?? this.empty;
  }
}

/** The walk's cache (Cached): a read before the first walk ends answers with none. */
export class RepoCache extends Cached<RepoWalk> {
  constructor(walk: () => Promise<RepoWalk>, opts: { cacheMs?: number; waitMs?: number; now?: () => number } = {}) {
    super(walk, { repos: [], complete: false }, opts);
  }
}

export interface SuggestDeps {
  /** The folders (cwd) of Claude Code's past sessions, newest first, each once (the driver's sessionFolders, cached). */
  sessionFolders(): Promise<string[]>;
  repos: Pick<RepoCache, "get">;
  /** The folders that kitespan's projects have (real paths), by project id. */
  projects(): Promise<{ id: string; cwd: string }[]>;
  /** Tests replace some of the file system reads, and the times. */
  probes?: Partial<FolderProbes>;
  ms?: { read?: number; probe?: number };
}

/**
 * Suggested: the session folders, then the repositories, each folder once (by its real path), within `readMs`. A
 * session folder whose check is late is left out; a late real path is the folder's own path; a late `.git` mark is no
 * mark.
 */
export async function suggestedFolders(deps: SuggestDeps): Promise<SuggestedFolder[]> {
  const fs: FolderProbes = { ...FS_PROBES, ...deps.probes };
  const race = timeBudget(deps.ms?.read ?? SUGGEST_LIMITS.readMs, deps.ms?.probe ?? FOLDER_MS.probe);
  const [sessionDirs, walk, projects] = await Promise.all([
    race<string[]>(() => deps.sessionFolders(), [], Infinity).catch(() => []),
    race<RepoWalk>(() => deps.repos.get(), { repos: [], complete: false }, Infinity),
    race<{ id: string; cwd: string }[]>(() => deps.projects(), [], Infinity),
  ]);
  const looked = [...new Set(sessionDirs)].slice(0, SUGGEST_LIMITS.sessionsRead);
  const exists = await mapLimit(looked, 16, (p) => race(() => fs.isFolder(p), false));
  const sessions = looked.filter((_, i) => exists[i]).slice(0, SUGGEST_LIMITS.sessions);
  const candidates = [...sessions.map((path) => ({ path, from: "session" as const })), ...walk.repos.map((path) => ({ path, from: "repo" as const }))];
  const reals = await mapLimit(candidates, 16, (c) => race(() => fs.realpath(c.path), c.path).catch(() => c.path));
  const byFolder = new Map(projects.map((p) => [p.cwd, p.id]));
  const seen = new Set<string>();
  const kept = candidates.flatMap((c, i) => {
    const real = reals[i]!;
    if (seen.has(real)) return [];
    seen.add(real);
    return [{ ...c, project: byFolder.get(real) ?? byFolder.get(c.path) ?? null }];
  });
  const git = await mapLimit(kept, 16, (c) => (c.from === "repo" ? Promise.resolve(true) : race(() => fs.git(c.path), false)));
  return kept.map((c, i) => ({ name: basename(c.path) || c.path, path: c.path, git: git[i]!, project: c.project, from: c.from }));
}
