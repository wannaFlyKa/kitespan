// `.worktreeinclude` (build checklist L30): Claude Code and Desktop copy into each new worktree the files of the main
// checkout that match a pattern of the project's `.worktreeinclude` (gitignore syntax) and are also gitignored ("Only
// files that match a pattern and are also gitignored are copied"), for example a local `.env`. kitespan does the same
// for its own worktrees, with the upload code's rules: regular files only, never through a symbolic link on either
// side, each folder made on its own and checked with lstat, a file that is there already left as it is, and caps on
// how many and how much.

import { constants, lstatSync, mkdirSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { isSafeRelativePath } from "../../shared/protocol";
import type { LedgerWorktree } from "../store/types";
import { runWorktreeGit, type WorktreeGit } from "./git";

export const INCLUDE_LIMITS = { files: 500, bytes: 64 * 1024 * 1024, perCall: 100 } as const;

/** Every part of `rel` under `base` is a real folder (no link), and the last one is a regular file: its size, or null. */
function regularFile(base: string, rel: string): number | null {
  const parts = rel.split("/");
  let at = base;
  for (let i = 0; i < parts.length; i++) {
    at = join(at, parts[i]!);
    try {
      const st = lstatSync(at);
      if (i < parts.length - 1 ? !st.isDirectory() : !st.isFile()) return null;
      if (i === parts.length - 1) return st.size;
    } catch {
      return null;
    }
  }
  return null;
}

/** The folders of `rel` under `base`, each made on its own and checked: true when every one is a real folder. */
function folders(base: string, rel: string): boolean {
  const parts = rel.split("/").slice(0, -1);
  let at = base;
  for (const p of parts) {
    at = join(at, p);
    try {
      mkdirSync(at);
    } catch {
      // there already (checked below)
    }
    try {
      if (!lstatSync(at).isDirectory()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Copy the project's `.worktreeinclude` files into the new worktree `w`; how many were copied. */
export async function copyIncludes(g: WorktreeGit, w: LedgerWorktree): Promise<number> {
  if (regularFile(w.root, ".worktreeinclude") === null) return 0;
  // The untracked files that match the include patterns (`--exclude-from` alone), then those of them that git ignores.
  const matched = await runWorktreeGit(g, w.root, ["ls-files", "-z", "--others", "--ignored", `--exclude-from=${join(w.root, ".worktreeinclude")}`]);
  if (matched.code !== 0) return 0;
  const wanted = matched.out.split("\0").filter((p) => p && isSafeRelativePath(p)).slice(0, INCLUDE_LIMITS.files);
  const ignored: string[] = [];
  for (let i = 0; i < wanted.length; i += INCLUDE_LIMITS.perCall) {
    const batch = wanted.slice(i, i + INCLUDE_LIMITS.perCall);
    const r = await runWorktreeGit(g, w.root, ["check-ignore", "--", ...batch]);
    // 0: some are ignored; 1: none is. One path a line; a path that git had to quote matches none of the batch.
    const given = new Set(batch);
    if (r.code === 0) ignored.push(...r.out.split("\n").filter((p) => given.has(p)));
  }
  let copied = 0;
  let bytes = 0;
  for (const rel of ignored) {
    const size = regularFile(w.root, rel);
    if (size === null || bytes + size > INCLUDE_LIMITS.bytes || !folders(w.path, rel)) continue;
    try {
      await copyFile(join(w.root, rel), join(w.path, rel), constants.COPYFILE_EXCL);
      bytes += size;
      copied++;
    } catch {
      // there already, or it could not be read: left out
    }
  }
  return copied;
}
