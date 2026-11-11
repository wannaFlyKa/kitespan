// U1 (DESIGN-U1 4 and 5): a turn's summary from what the marks saw (git) or from Claude's own edits (edits), with no
// git and no disk here: the caller gathers the files' ctimes and the large files, so a test can feed them.

import { isAbsolute, normalize, relative } from "node:path";
import { CHANGES_LIMITS, type ChangedFile, type ChangeStatus, type EditHunk } from "../../shared/changes";
import { keepPath } from "../search/git";
import type { TurnActivity } from "./activity";
import type { RawChange } from "./patch";

/** An untracked file over the size cap, left out of a mark: its size and times when the mark was taken. */
export interface LargeFile {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

/** What a summary holds before its id and its place: the files (every one), the totals and the left-out counts. */
export interface Tally {
  /** Every file of the turn's, in path order (the caller caps the list). */
  files: ChangedFile[];
  total: number;
  added: number;
  removed: number;
  /** Changed while Claude was not running a tool (the user's own). */
  others: number;
  /** Another chat's in the same folder (review): its file tool named it, or it changed in its command's window. */
  elsewhere: number;
}

/**
 * What other chats in the folder did while this turn ran (book.ts): the paths their file tools named, relative to this
 * chat's folder, and whether a time lies inside one of their command windows (a Bash call, a `!` command).
 */
export interface Elsewhere {
  targets: ReadonlySet<string>;
  inWindow(ctimeMs: number): boolean;
}

/**
 * A path as the chat's folder names it, or null when it is outside the folder or not a path a URL may hold. `cwd` is
 * the chat's folder; `real`, its real path (a tool may name the file by either).
 */
export function inFolder(p: string, cwd: string, real: string | null = null): string | null {
  const tries = isAbsolute(p) ? [relative(cwd, p), ...(real && real !== cwd ? [relative(real, p)] : [])] : [normalize(p)];
  for (const rel of tries) {
    if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) continue;
    if (keepPath(rel)) return rel;
  }
  return null;
}

/** The facts of the turn that the git rules read. */
export interface GitFacts {
  activity: TurnActivity;
  /** The file tools' targets, relative to the chat's folder. */
  targets: ReadonlySet<string>;
  /** Each changed path's ctime at the end (ms), or null when it is gone. */
  ctimes: ReadonlyMap<string, number | null>;
  /** The large untracked files at the start and at the end. */
  startLarge: ReadonlyMap<string, LargeFile>;
  endLarge: ReadonlyMap<string, LargeFile>;
  /** Other chats in the same folder at the same time; none by default. */
  elsewhere?: Elsewhere;
}

const GITLINK = "160000";
const sameLarge = (a: LargeFile, b: LargeFile) => a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

/**
 * The turn's files from the summary's records (DESIGN-U1 4.2 and 5): each one that is the turn's, with its counts;
 * the rest counted in `others` (the user's) or `elsewhere` (another chat's in the folder). Left out: gitlinks (a nested
 * repository or a submodule) and files git ignores (never in a mark). A change of the mode alone is counted in
 * `others`. A large untracked file that is new, or whose size or times changed, gets a row of its own with `large` and
 * no counts.
 *
 * Another chat in the folder (review): a path that only its file tools named is its own; a change inside one of its
 * command windows is this turn's only when one of this turn's commands ran then too (both may have made it: it counts
 * for both, as the user's own edit while a command runs does), else its own.
 *
 * A file's ctime is its last change (read after the end mark): a file that only a command changed, and that the user
 * changed again later in the turn while no tool ran, is left out and counted in `others` (two marks cannot tell the two
 * writers apart; a file tool's target stays the turn's, its diff holding both).
 */
export function gitTally(raw: readonly RawChange[], f: GitFacts): Tally {
  const rows: ChangedFile[] = [];
  let total = 0;
  let added = 0;
  let removed = 0;
  let others = 0;
  let elsewhere = 0;
  type Whose = "turn" | "others" | "elsewhere";
  const whose = (path: string, gone: boolean): Whose => {
    if (f.targets.has(path)) return "turn";
    if (f.elsewhere?.targets.has(path)) return "elsewhere";
    if (gone) return f.activity.ranCommand ? "turn" : "others";
    const c = f.ctimes.get(path);
    if (c === null || c === undefined) return f.activity.ranCommand ? "turn" : "others";
    if (!f.activity.inWindow(c)) return "others";
    if (f.elsewhere?.inWindow(c) && !f.activity.inCommandWindow(c)) return "elsewhere";
    return "turn";
  };
  const apart = (w: Whose) => (w === "elsewhere" ? elsewhere++ : others++);
  const take = (row: ChangedFile): void => {
    total++;
    added += row.added;
    removed += row.removed;
    if (keepPath(row.path)) {
      if (row.from !== undefined && !keepPath(row.from)) delete row.from;
      rows.push(row);
    }
  };
  // The large files decide their own rows; git's records of them (a file that crossed the cap) give way.
  const largeRows = new Map<string, ChangedFile>();
  for (const [path, end] of f.endLarge) {
    const start = f.startLarge.get(path);
    if (start && sameLarge(start, end)) continue;
    const inStart = start !== undefined || raw.some((r) => r.status === "D" && r.path === path);
    largeRows.set(path, { path, status: inStart ? "M" : "A", added: 0, removed: 0, large: true });
  }
  for (const [path] of f.startLarge) {
    if (f.endLarge.has(path)) continue;
    // Under the cap again (git's record is an add), or gone.
    const back = raw.some((r) => r.path === path && r.status === "A");
    largeRows.set(path, { path, status: back ? "M" : "D", added: 0, removed: 0, large: true });
  }

  for (const r of raw) {
    if (largeRows.has(r.path)) continue;
    if (r.oldMode === GITLINK || r.newMode === GITLINK) continue;
    let status: ChangeStatus;
    if (r.status === "M" || r.status === "T") status = "M";
    else if (r.status === "A" || r.status === "C") status = "A";
    else if (r.status === "D") status = "D";
    else if (r.status === "R") status = "R";
    else continue;
    const w = whose(r.path, status === "D");
    if (w !== "turn") {
      apart(w);
      continue;
    }
    // A change of the mode alone: no line changed, and nothing to show.
    if (status === "M" && r.oldId === r.newId) {
      others++;
      continue;
    }
    const binary = r.added === null || r.removed === null;
    take({
      path: r.path,
      status,
      added: binary ? 0 : r.added!,
      removed: binary ? 0 : r.removed!,
      ...(status === "R" && r.from !== undefined ? { from: r.from } : {}),
      ...(binary ? { binary: true as const } : {}),
    });
  }
  for (const row of largeRows.values()) {
    const w = whose(row.path, row.status === "D");
    if (w === "turn") take(row);
    else apart(w);
  }
  rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files: rows, total, added, removed, others, elsewhere };
}

/** A fallback summary's hunks of each file, by path, in the order of the edits. */
export type EditHunks = Map<string, EditHunk[]>;

/**
 * The fallback (DESIGN-U1 4.4): the files that the turn's Edit, MultiEdit and Write calls changed, each with the lines
 * their hunks add and remove (summed over the turn's edits; A when the turn's first edit of it created it), and each
 * NotebookEdit's notebook with no counts. Commands' changes are not in it. Hunks are kept up to `maxBytes` of JSON.
 */
export function editsTally(a: TurnActivity, cwd: string, real: string | null, maxBytes: number = CHANGES_LIMITS.editsBytes): Tally & { hunks: EditHunks } {
  const byPath = new Map<string, ChangedFile>();
  const hunks: EditHunks = new Map();
  let outside = { total: 0, added: 0, removed: 0 };
  let bytes = 2;
  for (const p of a.patches) {
    const path = inFolder(p.path, cwd, real);
    if (!path) {
      outside = { total: outside.total + 1, added: outside.added + p.added, removed: outside.removed + p.removed };
      continue;
    }
    const row = byPath.get(path);
    if (row) {
      row.added += p.added;
      row.removed += p.removed;
      delete row.notebook;
    } else byPath.set(path, { path, status: p.create ? "A" : "M", added: p.added, removed: p.removed });
    const list = hunks.get(path) ?? [];
    for (const h of p.hunks) {
      const size = JSON.stringify(h).length + 1;
      if (bytes + size > maxBytes) break;
      bytes += size;
      list.push(h);
    }
    hunks.set(path, list);
  }
  for (const n of a.notebooks) {
    const path = inFolder(n, cwd, real);
    if (!path) {
      outside.total++;
      continue;
    }
    if (!byPath.has(path)) byPath.set(path, { path, status: "M", added: 0, removed: 0, notebook: true });
  }
  const files = [...byPath.values()].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  return {
    files,
    total: files.length + outside.total,
    added: files.reduce((s, f) => s + f.added, 0) + outside.added,
    removed: files.reduce((s, f) => s + f.removed, 0) + outside.removed,
    others: 0,
    elsewhere: 0,
    hunks,
  };
}
