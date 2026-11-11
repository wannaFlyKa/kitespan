// Where kitespan's three folders are (DESIGN.md 4.4; iteration 6, round K1): the state, config and data folders under
// their XDG bases, `$XDG_STATE_HOME/kitespan` (default `~/.local/state`), `$XDG_CONFIG_HOME/kitespan` (`~/.config`) and
// `$XDG_DATA_HOME/kitespan` (`~/.local/share`). Every process that names one of them asks here: the server's boot and
// its store, the logger, the restart's `--check`, bin/update.sh's lock and the worktree records. bin/kitespan repeats
// the rule in sh for the config folder's start-env file.
//
// A folder of the old name (shared/legacy.ts) that has not moved yet is used where it is: when nothing is at the new
// name (lstat, any kind of entry) and the old one is a real folder of this user (for config also a link to a folder,
// which the old build followed), that old folder is the folder. Only the server's start from the terminal moves it
// (move.ts); every other process uses it in place. Anything else, a fresh install included, is the new name. The
// rule only reads: it makes nothing.

import { lstatSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { LEGACY_FOLDER } from "../../shared/legacy";
import { ownedBy, ownUid } from "./files";

/** The folders' name under each XDG base. */
export const FOLDER_NAME = "kitespan";

export type FolderKind = "state" | "config" | "data";
export const FOLDER_KINDS: readonly FolderKind[] = ["state", "config", "data"];

const XDG: Record<FolderKind, { name: string; fallback: readonly string[] }> = {
  state: { name: "XDG_STATE_HOME", fallback: [".local", "state"] },
  config: { name: "XDG_CONFIG_HOME", fallback: [".config"] },
  data: { name: "XDG_DATA_HOME", fallback: [".local", "share"] },
};

/** The XDG base of `kind`: its variable when it is an absolute path, else the home folder's default (the XDG rules). */
export function xdgBase(kind: FolderKind, env: Readonly<Record<string, string | undefined>>, home: string): string {
  const v = env[XDG[kind].name];
  return typeof v === "string" && isAbsolute(v) ? v : join(home, ...XDG[kind].fallback);
}

const lstatOf = (p: string) => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};

/** A folder of the old name under `base` that the move has not taken yet, or null (`kind`'s rule above). */
export function pendingFolder(kind: FolderKind, base: string, uid: number = ownUid()): string | null {
  if (lstatOf(join(base, FOLDER_NAME))) return null;
  const old = join(base, LEGACY_FOLDER);
  const st = lstatOf(old);
  if (!st) return null;
  if (st.isDirectory()) return ownedBy(st.uid, uid) ? old : null;
  if (kind !== "config" || !st.isSymbolicLink()) return null;
  try {
    return statSync(old).isDirectory() ? old : null;
  } catch {
    return null;
  }
}

/** The folder of `kind` under its XDG base `base`: the old one while it is pending, else `<base>/kitespan`. */
export function productFolder(kind: FolderKind, base: string, uid: number = ownUid()): string {
  return pendingFolder(kind, base, uid) ?? join(base, FOLDER_NAME);
}
