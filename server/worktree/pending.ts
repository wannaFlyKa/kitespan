// A worktree in the making (build checklist W3): `git worktree add` runs before the new chat's ledger exists, and a
// kill -9, a crash or a restart during the checkout would leave a worktree that nothing records (its folder, git's
// entry for it, and the branch kitespan/<name>) in the user's repository for good. So before the add, kitespan writes a
// small record in the project's folder of its data folder, `<data>/kitespan/worktrees/<project id>/<name>.making`
// (0600, the store's atomic writer; never in the user's repository, row 100), and removes it once the chat's ledger
// holds the worktree, or once the worktree is gone again. A remake of a chat's own worktree from its own branch (W8
// Unarchive, W4 Make it again) writes one too, with no commit: its ledger holds the worktree already, but a checkout
// cut part way would leave a half-made folder that passes the check before a start. At boot the registry hands each
// record left over to sweepMaking: a new chat's worktree that a ledger holds is kept, a remake's once its add
// finished; any other is undone (a remake's branch stays: it is the chat's). A record names a worktree at either place
// (place.ts): `<project folder>/.claude/worktrees/<name>`, or beside the record for one made before row 100.

import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { LEGACY_BRANCH_PREFIX } from "../../shared/legacy";
import type { LedgerWorktree } from "../store/types";
import { sweepTmp, unlinkSynced, writeAtomic } from "../store/files";
import { WORKTREE_BRANCH } from "../store/records";
import { branchOf, placeOf, projectRecordsThere } from "./place";

const SUFFIX = ".making";
const NAME = /^([a-z2-7]{8}(?:-[1-9][0-9]?)?)\.making$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_BYTES = 4096;

const uid = () => process.getuid?.() ?? 0;

/**
 * The record in the project's folder `records` of the data folder (place.ts projectRecords) that names `w` as being
 * made, written before its add (`again`: a remake from the chat's own branch, so the record names no commit); false
 * when it could not be written.
 */
export async function markMaking(w: LedgerWorktree, records: string, again = false): Promise<boolean> {
  const rec = { v: 1, path: w.path, root: w.root, branch: w.branch, commit: again ? null : w.baseCommit };
  try {
    await writeAtomic(records, basename(w.path) + SUFFIX, JSON.stringify(rec), MAX_BYTES, uid());
    return true;
  } catch {
    return false;
  }
}

/** `w` is no longer in the making: its ledger holds it, or it is gone again. */
export async function unmarkMaking(w: Pick<LedgerWorktree, "path">, records: string): Promise<void> {
  await unlinkSynced(records, basename(w.path) + SUFFIX).catch(() => false);
}

/** A record of the worktree `name` is in `records` (the name is taken until the boot's sweep has looked at it). */
export function makingAt(records: string, name: string): boolean {
  try {
    lstatSync(join(records, name + SUFFIX));
    return true;
  } catch {
    return false;
  }
}

/** Row 99: a record in the making is left in the project's folder of the data folder (one that cannot be listed has none). */
export function makingLeft(data: string, projectId: string): boolean {
  const dir = projectRecordsThere(data, projectId);
  if (!dir) return false;
  try {
    return readdirSync(dir).some((f) => f.endsWith(SUFFIX));
  } catch {
    return false;
  }
}

/**
 * A worktree that a record names: at one of the project's two places (place.ts placeOf), on its own branch, from a
 * commit (the new branch's tip at the add), or null for a remake from the chat's own branch, which never goes with it.
 */
export interface Making {
  path: string;
  root: string;
  branch: string;
  commit: string | null;
}

function readMaking(dir: string, file: string, root: string): Making | null {
  const name = NAME.exec(file)?.[1];
  if (!name) return null;
  try {
    const st = lstatSync(join(dir, file));
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    const o = JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>;
    // The record's own branch: this name's, with the new prefix or the old one (a record that a build of the old name
    // left, or a remake of a worktree made under it, which writes the ledger's own branch).
    const m = { path: o.path, root, branch: o.branch, commit: o.commit };
    if (o.v !== 1 || typeof m.path !== "string" || basename(m.path) !== name || placeOf(m.path, root, dir) === null) return null;
    if (o.root !== root || typeof m.branch !== "string" || (m.branch !== branchOf(name) && m.branch !== LEGACY_BRANCH_PREFIX + name) || !WORKTREE_BRANCH.test(m.branch)) return null;
    return m.commit === null || (typeof m.commit === "string" && COMMIT.test(m.commit)) ? (m as Making) : null;
  } catch {
    return null;
  }
}

/**
 * The boot's look at each project's folder of the data folder (`projects`: id and folder, every project's, whatever its
 * Worktree option says now): a record left over is kept with its worktree when `owned` says that a ledger holds the
 * worktree, a remake's only once `finished` says that its add finished (its ledger always holds it). Any other goes to
 * `undo` (the worktree, or the part of it that a cut checkout left, goes; the record goes once its folder is gone, so a
 * later boot tries again). A record that is not one of kitespan's goes. How many worktrees went.
 */
export async function sweepMaking(
  data: string,
  projects: readonly { id: string; cwd: string }[],
  owned: (path: string) => boolean,
  undo: (m: Making) => Promise<boolean>,
  finished: (m: Making) => Promise<boolean>,
): Promise<number> {
  let undone = 0;
  for (const p of projects) {
    const dir = projectRecordsThere(data, p.id);
    if (!dir) continue;
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(SUFFIX));
    } catch {
      continue;
    }
    await sweepTmp(dir).catch(() => 0);
    for (const file of files) {
      const m = readMaking(dir, file, p.cwd);
      if (!m) {
        // Not a record of this project's (a bad one, or one whose project's folder moved): it goes, the folder stays.
        await unlinkSynced(dir, file).catch(() => false);
        continue;
      }
      const keep = owned(m.path) && (m.commit !== null || (await finished(m)));
      if (keep || (await undo(m))) {
        await unmarkMaking(m, dir);
        if (!keep) undone++;
      }
    }
  }
  return undone;
}
