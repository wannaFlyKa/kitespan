// New environment's Browse (D54): the folders inside one folder, read only. Folders only, never a file name; dot
// folders only when asked; a filter (`q`) narrows the names before the cap; at most 500, sorted by name. A symbolic
// link to a folder is listed under its own path and resolved only when it is chosen (POST /api/projects takes its real
// path). A folder that cannot be read answers one plain reason, never an error. A file system that stalls (a network
// or FUSE mount) answers late or never, so every read has a deadline: a probe that is late answers "unknown", and a
// listing that is late answers "failed".

import type { Dirent } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { CONTROL_CHARS } from "../../shared/protocol";
import { STORE_LIMITS } from "../store/types";
import type { FolderEntry, FolderProblem, FoldersReply } from "../http/api-types";

export const FOLDER_LIST_CAP = 500;
/** How many links (or entries with no type) a subfolder check looks at before it answers "maybe". */
const SCAN_CAP = 2_000;
/** Folders probed at once (the `.git` mark and the subfolder check). */
const PROBES_AT_ONCE = 16;

export const FOLDER_MS = {
  /** The longest one probe (a `.git` mark, a subfolder check, a link's target) waits before it answers "unknown". */
  probe: 1_000,
  /** The longest a listing takes; a folder whose own read is later than this answers "failed". */
  list: 4_000,
} as const;

export const FOLDER_LINES: Record<FolderProblem, string> = {
  missing: "That folder does not exist.",
  not_a_folder: "That is a file, not a folder.",
  denied: "You do not have permission to open that folder.",
  failed: "That folder could not be read.",
};

/** Folder names in the order a person reads them: case and accents ignored, numbers by value, then code points. */
const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });
export const byName = (a: string, b: string): number => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

/** `fn` over `items`, at most `limit` at once, the results in the items' order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * A time budget of `totalMs` for one read. The race it returns answers `start()`'s value, or `fallback` once `ms`
 * (one probe's time by default) or the budget has run out; after the budget, it answers `fallback` at once and starts
 * nothing. A late read is not stopped (a file system call cannot be), only no longer waited for.
 */
export function timeBudget(totalMs: number, probeMs: number = FOLDER_MS.probe) {
  const end = performance.now() + totalMs;
  // Set when a timer that the deadline cut short fires (a timer may fire a little before the clock says so).
  let over = false;
  return <T>(start: () => Promise<T>, fallback: T, ms: number = probeMs): Promise<T> => {
    const toEnd = end - performance.now();
    if (over || toEnd <= 0) return Promise.resolve(fallback);
    const byEnd = toEnd <= ms;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<T>(
      (r) =>
        (timer = setTimeout(() => {
          if (byEnd) over = true;
          r(fallback);
        }, Math.min(ms, toEnd))),
    );
    return Promise.race([start(), late]).finally(() => clearTimeout(timer));
  };
}

const running = new Map<string, Promise<unknown>>();
/**
 * One read per `key` at a time: an ask while the same read runs shares it. A stalled path then holds one of the
 * runtime's file system threads, however often the page asks for it, not one more per ask.
 */
export function once<T>(key: string, start: () => Promise<T>): Promise<T> {
  let p = running.get(key) as Promise<T> | undefined;
  if (!p) {
    p = start().finally(() => running.delete(key));
    running.set(key, p);
  }
  return p;
}

/**
 * The folder holds a `.git` entry (a repository, a worktree or a submodule). The direct call; Browse and Suggested go
 * through FS_PROBES.git, which shares a read that still runs.
 */
export async function hasGit(dir: string): Promise<boolean> {
  try {
    await lstat(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

/** An entry's kind from its own type: "dir", null (not a folder), or undefined when only a look can tell (a link, or a file system that gives no type). */
function kindOf(e: Dirent): "dir" | null | undefined {
  if (e.isDirectory()) return "dir";
  if (e.isFile() || e.isFIFO() || e.isSocket() || e.isCharacterDevice() || e.isBlockDevice()) return null;
  return undefined;
}

/** Whether an entry of `dir` is a folder: "dir", a symbolic link to one ("link"), or null for anything else. */
export async function folderKind(dir: string, e: Dirent): Promise<"dir" | "link" | null> {
  const plain = kindOf(e);
  if (plain !== undefined) return plain;
  const p = join(dir, e.name);
  try {
    // A link, or a file system that gives no type: ask it.
    const own = e.isSymbolicLink() ? null : await lstat(p);
    if (own?.isDirectory()) return "dir";
    if (own && !own.isSymbolicLink()) return null;
    return (await stat(p)).isDirectory() ? "link" : null;
  } catch {
    return null;
  }
}

/**
 * The folder holds a subfolder (a dot folder counts only when `hidden`); false when it cannot be read. Every entry's
 * own type is read (the runtime reads a whole folder at once anyway), so the order of the entries does not matter;
 * links and entries with no type are looked at, at most `scanCap` of them. Past that the answer is true, since a
 * chevron too many costs one tap and a missing one hides a way in.
 */
export async function holdsFolder(dir: string, hidden: boolean, scanCap = SCAN_CAP): Promise<boolean> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  const named = hidden ? entries : entries.filter((e) => !e.name.startsWith("."));
  if (named.some((e) => e.isDirectory())) return true;
  const unsure = named.filter((e) => kindOf(e) === undefined);
  for (const e of unsure.slice(0, scanCap)) if (await folderKind(dir, e)) return true;
  return unsure.length > scanCap;
}

/** The file system reads that Browse and Suggested make; tests replace some of them. */
export interface FolderProbes {
  /** A folder's entries, with their types. */
  entries(path: string): Promise<Dirent[]>;
  /** An entry that only a look can tell: folderKind. */
  kind(dir: string, e: Dirent): Promise<"dir" | "link" | null>;
  git(path: string): Promise<boolean>;
  subfolders(path: string, hidden: boolean): Promise<boolean>;
  isFolder(path: string): Promise<boolean>;
  realpath(path: string): Promise<string>;
}

export const FS_PROBES: FolderProbes = {
  entries: (p) => once(`entries:${p}`, () => readdir(p, { withFileTypes: true })),
  kind: (dir, e) => once(`kind:${join(dir, e.name)}`, () => folderKind(dir, e)),
  git: (p) => once(`git:${p}`, () => hasGit(p)),
  subfolders: (p, hidden) => once(`subfolders:${hidden ? 1 : 0}:${p}`, () => holdsFolder(p, hidden)),
  isFolder: (p) =>
    once(`folder:${p}`, () =>
      stat(p).then(
        (s) => s.isDirectory(),
        () => false,
      ),
    ),
  realpath: (p) => once(`realpath:${p}`, () => realpath(p)),
};

/**
 * The absolute folder a request names: an absolute path, `~` or a path that starts with `~/` (the home folder), or
 * the home folder when none is given; normalized (`..` and repeated slashes), links left as they are. null: not a path.
 */
export function folderPath(raw: string | null, home: string): string | null {
  if (raw === null || raw === "" || raw === "~") return resolve(home);
  if (raw.length > STORE_LIMITS.cwd || CONTROL_CHARS.test(raw)) return null;
  if (raw.startsWith("~/")) return resolve(home, raw.slice(2));
  return isAbsolute(raw) ? resolve(raw) : null;
}

function problemOf(e: unknown): FolderProblem {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT" || code === "ELOOP") return "missing";
  if (code === "ENOTDIR") return "not_a_folder";
  if (code === "EACCES" || code === "EPERM") return "denied";
  return "failed";
}

const LATE = Symbol("late");

/** A name as the filter compares it, as the page's narrow does (web/dialogs/finder.ts): case and accents ignored. */
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * The folders inside `path` (an absolute, normalized path: folderPath's), within FOLDER_MS.list. A probe that is late
 * answers no `.git` mark and a chevron (git false, subfolders true), and a link whose target is late is left out, as a
 * broken link is. `q` keeps the names that hold it (case and accents ignored) before the cap, and `truncated` counts
 * those, so a folder past the cap is found by its name.
 */
export async function listFolders(
  path: string,
  opts: { home: string; hidden?: boolean; q?: string; cap?: number; probes?: Partial<FolderProbes>; ms?: { list?: number; probe?: number } },
): Promise<FoldersReply> {
  const hidden = opts.hidden === true;
  const cap = opts.cap ?? FOLDER_LIST_CAP;
  const fs: FolderProbes = { ...FS_PROBES, ...opts.probes };
  const race = timeBudget(opts.ms?.list ?? FOLDER_MS.list, opts.ms?.probe ?? FOLDER_MS.probe);
  const parent = path === "/" ? null : dirname(path);
  const home = resolve(opts.home);
  const failed = (reason: FolderProblem): FoldersReply => ({ ok: false, path, parent, home, reason, line: FOLDER_LINES[reason] });
  let entries: Dirent[] | typeof LATE;
  try {
    entries = await race<Dirent[] | typeof LATE>(() => fs.entries(path), LATE, Infinity);
  } catch (e) {
    return failed(problemOf(e));
  }
  if (entries === LATE) return failed("failed");
  const q = fold(opts.q ?? "");
  const named = entries
    .filter((e) => (hidden || !e.name.startsWith(".")) && (!q || fold(e.name).includes(q)))
    .sort((a, b) => byName(a.name, b.name));
  const kinds = await mapLimit(named, PROBES_AT_ONCE * 4, async (e) => {
    const plain = kindOf(e);
    return plain !== undefined ? plain : race(() => fs.kind(path, e), null);
  });
  const found = named.flatMap((e, i) => (kinds[i] ? [{ name: e.name, link: kinds[i] === "link" }] : []));
  const shown = found.slice(0, cap);
  const folders: FolderEntry[] = await mapLimit(shown, PROBES_AT_ONCE, async ({ name, link }) => {
    const p = join(path, name);
    const [git, subfolders] = await Promise.all([race(() => fs.git(p), false), race(() => fs.subfolders(p, hidden), true)]);
    return { name, path: p, git, subfolders, link };
  });
  return { ok: true, path, parent, home, folders, truncated: found.length > cap };
}
