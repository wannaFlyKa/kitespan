// Where a chat's worktree lives and what it is called (DESIGN.md 9.4; build checklist L23, L24, W13; owner row 100):
// `<project folder>/.claude/worktrees/<name>`, as Desktop ("Worktrees are stored in `<project-root>/.claude/worktrees/`
// by default") and the CLI's `--worktree` place theirs, so Claude Code's trust of the project's folder covers it. The
// branch is `kitespan/<name>`, where the name is the first 8 symbols of the chat id (lowercase, so a file system that
// folds case never joins two), with `-2`, `-3` on a taken name. Paths are real paths (on macOS `/tmp` and `/var` lead
// into `/private`), so the gate compares the folder that Claude Code really runs in.
//
// The link rule: `.claude` and `.claude/worktrees` are each a real folder or not there (lstat). A symbolic link or
// anything else in either place gets no worktree (`link`), since it could lead the add outside the repository. Neither
// may hold a `.git` of any kind (`nested`): then it is the top of another git working tree (a submodule, or a clone of
// shared Claude Code config that the project ignores), the worktree would land in that repository, and the project's
// local ignore (ignore.ts) would not reach it. kitespan makes the two folders when they are missing (the mode that the
// user's umask gives, as git's own add does) and never removes them.
//
// kitespan's own records stay in its data folder, `$XDG_DATA_HOME/kitespan/worktrees/<project id>/` (`~/.local/share`
// when the variable is not set or not an absolute path, as the XDG rules say): the records in the making
// (pending.ts). That folder is also where the worktrees made before row 100 are, which keep working at their path: the
// data folder of the old name (server/store/places.ts) stays the data folder while it holds one (server/store/move.ts),
// and their branches keep the old prefix (WORKTREE_BRANCH). Each folder that kitespan makes there is made on its own
// (never `recursive`), 0700, and checked with lstat.

import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { isProjectId } from "../../shared/ids";
import { productFolder, xdgBase } from "../store/places";

/** How many names a chat may try: `<8 symbols>`, then `-2` up to this. */
export const NAME_TRIES = 20;

/** `$XDG_DATA_HOME`, the folder that `kitespan/worktrees` goes in (an empty or relative variable is ignored). */
export function dataHome(env: Readonly<Record<string, string | undefined>>, home: string): string {
  return xdgBase("data", env, home);
}

/** The `n`th name of a chat's worktree (1 is the first): its folder's name and the branch's last part. */
export function worktreeName(chatId: string, n: number): string {
  const short = chatId.slice(0, 8).toLowerCase();
  return n <= 1 ? short : `${short}-${n}`;
}

export const branchOf = (name: string): string => `kitespan/${name}`;

/** The two folders under a project's folder that its worktrees go in. */
const IN_PROJECT = [".claude", "worktrees"] as const;

/** `<root>/.claude/worktrees`: the folder that a project's worktrees go in (row 100). */
export function worktreesOf(root: string): string {
  return join(root, ...IN_PROJECT);
}

/** A folder that is there and is a real folder (lstat: no link). */
function realFolder(p: string): boolean {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Nothing is at `p` (lstat: not even a dangling link). */
export function nothingAt(p: string): boolean {
  try {
    lstatSync(p);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "ENOENT";
  }
}

/** `p` holds a `.git` of any kind (a folder, a submodule's file, a link): it is the top of a git working tree. */
const gitTop = (p: string): boolean => !nothingAt(join(p, ".git"));

/**
 * The link rule: `<root>/.claude` and `<root>/.claude/worktrees` are each a real folder, or not there (else `link`),
 * and neither is the top of another git working tree (`nested`); null when both hold.
 */
export function placeOff(root: string): "link" | "nested" | null {
  let at = root;
  for (const part of IN_PROJECT) {
    at = join(at, part);
    if (nothingAt(at)) return null;
    if (!realFolder(at)) return "link";
    if (gitTop(at)) return "nested";
  }
  return null;
}

export const placeOk = (root: string): boolean => placeOff(root) === null;

/**
 * `<root>/.claude/worktrees` (`root` a real path), with each of its two folders made when missing (not recursive, with
 * the mode that the umask gives) and checked with lstat; null when one is a link, not a folder, or the top of another
 * git working tree (placeOff).
 */
export function worktreesIn(root: string): string | null {
  if (!isAbsolute(root)) return null;
  let at = root;
  for (const part of IN_PROJECT) {
    at = join(at, part);
    try {
      mkdirSync(at);
    } catch {
      // there already (checked below), or its parent is not there
    }
    if (!realFolder(at) || gitTop(at)) return null;
  }
  return at;
}

/** Make one folder of kitespan's own (not recursive, 0700), then check it with lstat; true when a real folder is there. */
function makeOwn(p: string): boolean {
  try {
    mkdirSync(p, { mode: 0o700 });
  } catch {
    // there already (checked below), or its parent is not there
  }
  return realFolder(p);
}

/**
 * The project's folder under the data folder `data`, made as needed: its records in the making, and its worktrees made
 * before row 100. The data folder itself may be made with its parents (it is the user's own XDG folder), then each
 * folder that kitespan makes (`kitespan`, `worktrees`, the project's) one by one, each checked. Its real path, or null
 * when one part is a link or not a folder.
 */
export function projectRecords(data: string, projectId: string): string | null {
  if (!isAbsolute(data) || !isProjectId(projectId)) return null;
  try {
    mkdirSync(data, { recursive: true, mode: 0o700 });
  } catch {
    // checked below
  }
  let real: string;
  try {
    real = realpathSync(data);
  } catch {
    return null;
  }
  let at = real;
  for (const part of [dataFolderName(real), "worktrees", projectId]) {
    at = join(at, part);
    if (!makeOwn(at)) return null;
  }
  return at;
}

/**
 * The data folder's own name under the XDG base `real` (server/store/places.ts): `kitespan`, or the old name's while
 * that folder is pending; it stays the data folder while it holds a worktree made under it (server/store/move.ts).
 */
const dataFolderName = (real: string): string => basename(productFolder("data", real));

/** A real folder is at `p` and its real path is `p` (no link on the way). */
export function folderAt(p: string): boolean {
  if (!realFolder(p)) return false;
  try {
    return realpathSync(p) === p;
  } catch {
    return false;
  }
}

/** The project's folder under `data` when each part of it is a real folder (nothing is made), or null. */
export function projectRecordsThere(data: string, projectId: string): string | null {
  if (!isAbsolute(data) || !isProjectId(projectId)) return null;
  let at: string;
  try {
    at = realpathSync(data);
  } catch {
    return null;
  }
  for (const part of [dataFolderName(at), "worktrees", projectId]) {
    at = join(at, part);
    if (!realFolder(at)) return null;
  }
  return at;
}

/**
 * Where the worktree at `path` of the project folder `root` is: `project`, in `<root>/.claude/worktrees` (row 100);
 * `data`, in the project's folder `records` of the data folder (made before row 100); null for any other path.
 */
export function placeOf(path: string, root: string, records: string | null): "project" | "data" | null {
  const name = basename(path);
  if (path === join(worktreesOf(root), name)) return "project";
  if (records !== null && path === join(records, name)) return "data";
  return null;
}
