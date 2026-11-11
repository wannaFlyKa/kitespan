// The check before every start of a worktree chat (build checklist W4, L35) and the gate's worktree case of `cwd` (G4):
// file reads only, no git. A linked worktree of a main checkout `<root>` holds a `.git` file, `gitdir: <path>`, that
// points into `<root>/.git/worktrees/<id>`, and that folder's own `gitdir` file points back at the worktree's `.git`.
// Every part is read with lstat first: a symbolic link anywhere in it fails the check, so a folder that only looks like
// a worktree, or one that leads somewhere else, never passes.

import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/** The `.git` and `gitdir` files are one line; anything longer is not one of git's. */
const MAX_POINTER = 4096;

function isDir(p: string): boolean {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** A small regular file's text (never through a link), or null. */
function readPointer(p: string): string | null {
  try {
    const st = lstatSync(p);
    if (!st.isFile() || st.size > MAX_POINTER) return null;
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** The path a pointer file names (`gitdir: <path>` in a `.git` file, a bare path in `gitdir`), resolved from `from`. */
function pointed(text: string, from: string, prefix: string): string | null {
  const line = text.split("\n")[0]!.replace(/\r$/, "");
  if (!line.startsWith(prefix)) return null;
  const p = line.slice(prefix.length).trim();
  if (!p || p.includes("\0")) return null;
  // git 2.48 and later may write a relative path (worktree.useRelativePaths).
  return isAbsolute(p) ? resolve(p) : resolve(from, p);
}

function realOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * The main checkout that `path` is a linked worktree of, or null: `path` is a real folder (its real path, no link),
 * its `.git` is a file that points into `<root>/.git/worktrees/<id>`, `<root>/.git` is a real folder, and the
 * worktree's `gitdir` points back at `<path>/.git`.
 */
export function linkedRootOf(path: string): string | null {
  if (!isAbsolute(path) || realOrNull(path) !== path || !isDir(path)) return null;
  const dotGit = join(path, ".git");
  const text = readPointer(dotGit);
  if (text === null) return null;
  const admin = pointed(text, path, "gitdir:");
  if (!admin) return null;
  const worktrees = dirname(admin);
  const common = dirname(worktrees);
  if (basename(worktrees) !== "worktrees" || basename(common) !== ".git") return null;
  const root = dirname(common);
  if (!isDir(admin) || !isDir(worktrees) || !isDir(common) || realOrNull(root) !== root || !isDir(root)) return null;
  const back = readPointer(join(admin, "gitdir"));
  if (back === null || pointed(back, admin, "") !== dotGit) return null;
  return root;
}

/** W4: the chat's worktree at `path` is there, and is a linked worktree of `root` (G4: of that very checkout). */
export function worktreeHere(path: string, root: string): boolean {
  return path !== root && linkedRootOf(path) === root;
}
