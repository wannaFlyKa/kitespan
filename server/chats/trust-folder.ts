// R127: what the server checks of a folder before it asks the agent to trust it, and the repository root that the
// confirm names (DESIGN-R127 7.1 and 7.3). File reads only, never git: a repository that is not trusted yet may hold a
// config that names programs git would run.

import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { TrustRef, TrustRefusal } from "../../shared/protocol";
import { holdsPath } from "../../shared/trust";

/** The folder as it is on disk now: there and its real path (`ok`), not there (`gone`), or refused with a reason. */
export type FolderCheck = { ok: true } | { gone: true } | { refused: Extract<TrustRefusal, "link" | "not_folder"> };

/**
 * `path` (absolute, checked as text before) on disk: `gone` when nothing is there (or a part of it is not a folder);
 * `link` when it is a symbolic link or its real path differs (a link in a part of it); `not_folder` when it is
 * something else, or cannot be read.
 */
export function checkFolder(path: string): FolderCheck {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    return code === "ENOENT" || code === "ENOTDIR" ? { gone: true } : { refused: "not_folder" };
  }
  if (st.isSymbolicLink()) return { refused: "link" };
  if (!st.isDirectory()) return { refused: "not_folder" };
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return { refused: "not_folder" };
  }
  return real === path ? { ok: true } : { refused: "link" };
}

/**
 * `home`: the path is the home folder (Claude Code holds its trust for the session only and never saves it).
 * `holds_home`: the path holds it (the root among them): a trust outside a repository covers every folder under it
 * that is not a repository of its own, so it would cover the home folder's (lead decision b). Null: neither.
 */
export function homeRefusal(path: string, homes: readonly string[]): "home" | "holds_home" | null {
  if (homes.includes(path)) return "home";
  return homes.some((h) => holdsPath(path, h)) ? "holds_home" : null;
}

/** Whether `p` exists, with lstat (never through a link at its end); its kind. */
function entryKind(p: string): "dir" | "file" | "link" | "other" | null {
  try {
    const st = lstatSync(p);
    return st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
  } catch {
    return null;
  }
}

/** The `.git`, `commondir` and `gitdir` files are one line; anything longer is not one of git's. */
const MAX_POINTER = 4096;

/** A small regular file's text (never through a link), or null. */
function pointerText(p: string): string | null {
  try {
    const st = lstatSync(p);
    if (!st.isFile() || st.size > MAX_POINTER) return null;
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/**
 * The trust key of `d`, a folder whose `.git` is a file, by Claude Code's own rule (2.1.318, the key function that
 * reads a `.git` file): `.git` says `gitdir: <admin>`; `<admin>/commondir` names the common dir; `<admin>` is in
 * `<common>/worktrees`; `<admin>/gitdir` points back at `d/.git`. Then the key is the main checkout (the common dir's
 * folder) when the common dir is named `.git`, else the common dir itself (a bare repository, whose one key covers
 * every worktree of it) unless that holds a `.git` of its own. Any other form (a submodule, a nested repository, a
 * pointer that does not hold) keys on `d`. Unlike linkedRootOf (kitespan's own worktrees), a bare repository counts.
 */
function linkedKeyOf(d: string): string {
  const dotGit = join(d, ".git");
  const text = pointerText(dotGit)?.trim();
  if (!text?.startsWith("gitdir:")) return d;
  const pointer = text.slice("gitdir:".length).trim();
  if (!pointer || pointer.includes("\0")) return d;
  const admin = resolve(d, pointer);
  const commondir = pointerText(join(admin, "commondir"))?.trim();
  if (!commondir || commondir.includes("\0")) return d;
  const common = resolve(admin, commondir);
  if (dirname(admin) !== join(common, "worktrees")) return d;
  const back = pointerText(join(admin, "gitdir"))?.trim();
  if (!back || back.includes("\0")) return d;
  // Claude Code keys on `d` itself when any of these paths holds a backslash.
  if ([d, admin, back, common].some((p) => p.includes("\\"))) return d;
  if (resolve(admin, back) !== dotGit) return d;
  if (basename(common) === ".git") return dirname(common);
  const inner = entryKind(join(common, ".git"));
  return inner === "dir" || inner === "file" ? d : common;
}

/**
 * The repository that holds `path`, by the `.git` entries, walking up from the path itself: `top`, the first folder `d`
 * with a `.git`, and `root`, the key that Claude Code records the trust on. A `.git` that is a real folder: `d` is
 * both. A `.git` file: the root is linkedKeyOf(d) (the main checkout, a bare repository's folder, or `d` itself), whose
 * one trust covers `d` and every other worktree of it. A `.git` that is a link, or anything else, stops the walk with
 * no repository; so does reaching `/`. Claude Code computes its own key; this is what the confirm names.
 */
export function repoOf(path: string): { top: string; root: string } | null {
  if (!isAbsolute(path)) return null;
  for (let d = path; ; d = dirname(d)) {
    const kind = entryKind(join(d, ".git"));
    if (kind === "dir") return { top: d, root: d };
    if (kind === "file") return { top: d, root: linkedKeyOf(d) };
    if (kind !== null) return null;
    if (dirname(d) === d) return null;
  }
}

/** The repository root that Claude Code keys the trust of `path` on (repoOf), or null. */
export function repoRootOf(path: string): string | null {
  return repoOf(path)?.root ?? null;
}

/** A refused row's `trust`: the folder, and its repository's root when that is another folder. */
export function folderRef(path: string): TrustRef {
  const root = repoRootOf(path);
  return { path, root: root !== null && root !== path ? root : null };
}
