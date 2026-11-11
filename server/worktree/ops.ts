// A chat's worktree from its start to its delete (DESIGN.md 9.4 "Worktrees"; build checklist W2, W3, W7, W8, W9, L22,
// L25, L26, L33), with kitespan's own git (git.ts) and the place rules (place.ts):
//
// - worktreeOff: why a folder gets no worktree (not in a git repository, not the top folder of a repository's main
//   checkout, no commit yet, a repository config that could run a program, a `.claude` or `.claude/worktrees` that is a
//   link, not a folder, or another git repository); the WorktreeCreate hook is the settings' read, the caller's.
// - makeWorktree (W3): `worktree add --no-track -b kitespan/<name> <path> <HEAD's commit>^{commit}` in the project's
//   folder, from the main checkout's local HEAD (L22: no fetch), at `<project folder>/.claude/worktrees/<name>` (row
//   100) with the first free name, with its record in the making (pending.ts) written first and the main checkout's
//   local ignore (ignore.ts) before the add. What a failed or killed add leaves is undone (undoAdd).
// - remakeWorktree (W8, W4's "Make it again from its branch"): `worktree add <path> <branch>` after a prune, at the
//   chat's own path (either place, place.ts), with its record in the making written first; addFinished tells the
//   boot's sweep whether a remake's add got to its end.
// - worktreeChanges (W7, L26): how many files `status --porcelain=v1 -z --untracked-files=all` names, never which.
// - ignoredWork (W7, L25): files that git ignores in the worktree, other than unchanged copies of the project's own.
// - branchStays (L26): the branch holds a commit that no other branch has.
// - removeWorktree (W7, W9): `worktree remove` (`--force` only after the user's confirm), then `worktree prune`.
// - dropBranch (W9): `branch -D`, only for a branch whose every commit another branch has.

import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { isSafeRelativePath, type WorktreeOff } from "../../shared/protocol";
import type { LedgerWorktree } from "../store/types";
import { linkedRootOf, worktreeHere } from "./check";
import { filterArgs, readRepoConfig, runWorktreeGit, type WorktreeGit } from "./git";
import { ignoreWorktrees } from "./ignore";
import { makingAt, markMaking, unmarkMaking } from "./pending";
import { NAME_TRIES, branchOf, folderAt, nothingAt, placeOf, placeOff, placeOk, projectRecords, worktreeName, worktreesIn } from "./place";

/** Why a folder gets no worktree (W2, L33; the hook, L29, is the caller's: it reads Claude Code's settings). */
export { WORKTREE_OFF, type WorktreeOff } from "../../shared/protocol";

/** The one line for each (kitespan's own words; Desktop's docs give none). */
export const WORKTREE_OFF_LINES: Record<WorktreeOff, string> = {
  not_git: "This folder is not a git repository.",
  not_top: "kitespan makes worktrees only from the top folder of a repository's main checkout.",
  no_commit: "This repository has no commit yet.",
  hook: "Your Claude Code settings have a WorktreeCreate hook, which kitespan's worktrees would not run.",
  config: "This repository's git config could run a program, so kitespan makes no worktree here.",
  link: "This repository's .claude or .claude/worktrees is a symbolic link or not a folder, so kitespan makes no worktree here.",
  nested: "This repository's .claude or .claude/worktrees is another git repository, so kitespan makes no worktree here.",
};

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** What the main checkout at `root` gives a new worktree: its HEAD (L22) and its own filter drivers (W1). */
interface Base {
  commit: string;
  ref: string;
  config: string[];
}

/**
 * The main checkout at `root` (a real path) as a worktree's base, or why it is none: `root` must be in a git repository
 * (`not_git`), and be its top folder with its `.git` a real folder, so `root` is the main checkout and not a subfolder
 * or a linked worktree (`not_top`), with a commit, and with no config that could run a program.
 */
async function baseOf(g: WorktreeGit, root: string): Promise<Base | WorktreeOff> {
  if (!g.git || !folderAt(root)) return "not_git";
  const top = await runWorktreeGit(g, root, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return "not_git";
  if (top.out.replace(/\n$/, "") !== root || !folderAt(join(root, ".git"))) return "not_top";
  const head = await runWorktreeGit(g, root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const commit = head.out.trim();
  if (head.code !== 0 || !COMMIT.test(commit)) return "no_commit";
  const config = await readRepoConfig(g, root);
  if (!config || config.refused) return "config";
  const sym = await runWorktreeGit(g, root, ["symbolic-ref", "--quiet", "HEAD"]);
  const ref = sym.code === 0 && /^refs\/heads\/[^\u0000- \u007f]{1,240}$/.test(sym.out.trim()) ? sym.out.trim() : "HEAD";
  return { commit, ref, config: filterArgs(config.filters) };
}

/** Why the folder `root` gets no worktree now, or null when it can (the hook aside); the link rule last (place.ts). */
export async function worktreeOff(g: WorktreeGit, root: string): Promise<WorktreeOff | null> {
  const b = await baseOf(g, root);
  if (typeof b === "string") return b;
  return placeOff(root);
}

async function branchExists(g: WorktreeGit, root: string, branch: string): Promise<boolean> {
  return (await runWorktreeGit(g, root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
}

export type MakeResult = { ok: true; worktree: LedgerWorktree } | { ok: false; why: WorktreeOff | "failed" };

/** Where the server's terminal lines of the worktree code go (the local ignore's skip); stderr by default. */
export type Say = (line: string) => void;
export const sayOnStderr: Say = (line) => void process.stderr.write(`kitespan: ${line}\n`);

/**
 * W3: the chat's worktree, at `<project folder>/.claude/worktrees/<name>` (row 100, L23), on `kitespan/<name>` (L24),
 * from the main checkout's local HEAD (L22). The two folders are made when missing, a link or anything else in their
 * place is `link`, and another git repository there is `nested` (place.ts). A name whose folder, record or branch is
 * taken gives the next one. The record in the making (pending.ts, in `data`'s `kitespan/worktrees/<project id>/`) is
 * written before the add, and stays until the caller's ledger holds the worktree (unmarkMaking); then the main
 * checkout's local ignore (ignore.ts), which never stops the add. A failed add, or one that the deadline ended in the
 * middle of its checkout, is undone (undoAdd), and its record goes once nothing of it is left.
 */
export async function makeWorktree(
  g: WorktreeGit,
  input: { root: string; data: string; projectId: string; chatId: string },
  say: Say = sayOnStderr,
): Promise<MakeResult> {
  const base = await baseOf(g, input.root);
  if (typeof base === "string") return { ok: false, why: base };
  const off = placeOff(input.root);
  if (off) return { ok: false, why: off };
  const records = projectRecords(input.data, input.projectId);
  if (!records) return { ok: false, why: "failed" };
  const dir = worktreesIn(input.root);
  if (!dir) return { ok: false, why: placeOff(input.root) ?? "failed" };
  for (let n = 1; n <= NAME_TRIES; n++) {
    const name = worktreeName(input.chatId, n);
    const path = join(dir, name);
    const branch = branchOf(name);
    if (!nothingAt(path) || makingAt(records, name) || (await branchExists(g, input.root, branch))) continue;
    const worktree: LedgerWorktree = { path, root: input.root, branch, baseRef: base.ref, baseCommit: base.commit };
    if (!(await markMaking(worktree, records))) return { ok: false, why: "failed" };
    await ignoreWorktrees(g, input.root, name, say).catch(() => null);
    const add = await runWorktreeGit(g, input.root, ["worktree", "add", "--no-track", "-b", branch, path, `${base.commit}^{commit}`], { config: base.config, ms: g.addMs });
    if (add.code === 0 && folderAt(path) && worktreeHere(path, input.root)) return { ok: true, worktree };
    if (await undoAdd(g, { path, root: input.root, branch, commit: base.commit })) await unmarkMaking(worktree, records);
    return { ok: false, why: "failed" };
  }
  return { ok: false, why: "failed" };
}

/** git's own record of the worktree at `path` (`worktree list`: its fields), undefined when it has none; null: unread. */
async function listing(g: WorktreeGit, root: string, path: string): Promise<string[] | undefined | null> {
  const r = await runWorktreeGit(g, root, ["worktree", "list", "--porcelain", "-z"]);
  if (r.code !== 0) return null;
  // -z: each field ends with a NUL, and each worktree's fields with one more.
  return r.out
    .split("\0\0")
    .map((rec) => rec.split("\0"))
    .find((fields) => fields[0] === `worktree ${path}`);
}

/** git lists the worktree at `path` on `refs/heads/<branch>`. */
async function onBranch(g: WorktreeGit, root: string, path: string, branch: string): Promise<boolean> {
  return (await listing(g, root, path))?.includes(`branch refs/heads/${branch}`) === true;
}

/** git's own record of a worktree at `path` (`worktree list`); a failed add may leave it locked, "initializing". */
async function listed(g: WorktreeGit, root: string, path: string): Promise<boolean | null> {
  const fields = await listing(g, root, path);
  return fields === null ? null : fields !== undefined;
}

/**
 * The add at `m.path` got to its end: git lists the worktree and it is not locked (git locks it as "initializing"
 * during the add's checkout and unlocks it at the end, so a kill -9 leaves the lock), and it is a linked worktree of
 * its root. The boot's sweep keeps a remake's worktree only then (pending.ts).
 */
export async function addFinished(g: WorktreeGit, m: { path: string; root: string }): Promise<boolean> {
  const fields = await listing(g, m.root, m.path);
  return !!fields && !fields.some((f) => f === "locked" || f.startsWith("locked ")) && worktreeHere(m.path, m.root);
}

/**
 * What a `worktree add` at `path` left when it failed or was ended in the middle of its checkout (the deadline, the
 * server's exit or a kill -9): the folder in part, git's entry for it (locked as "initializing", which `worktree
 * prune` skips), and the new branch. No chat ever ran in that folder, so it goes with `worktree remove --force
 * --force` (which takes a locked entry too), with no confirm of the user's (one of the two such removals, with
 * archiveRemove's; DESIGN.md 9.4). Then a prune, and the branch while it still points at the add's own commit (with
 * `commit`; null for remakeWorktree's add, whose branch is the chat's). True when the folder is gone. False, with
 * nothing done, while the project's folder is not there (a disk that is not mounted yet: the worktree's path inside it
 * is gone too, but the add is not undone) or git cannot list its worktrees, so the record in the making stays for a
 * later boot.
 */
export async function undoAdd(g: WorktreeGit, m: { path: string; root: string; branch: string; commit: string | null }): Promise<boolean> {
  if (!folderAt(m.root)) return false;
  const at = await listed(g, m.root, m.path);
  if (at === null) return false;
  if (at) await runWorktreeGit(g, m.root, ["worktree", "remove", "--force", "--force", m.path], { ms: g.addMs });
  await runWorktreeGit(g, m.root, ["worktree", "prune"]);
  if (m.commit) {
    const tip = await runWorktreeGit(g, m.root, ["rev-parse", "--verify", "--quiet", `refs/heads/${m.branch}`]);
    if (tip.code === 0 && tip.out.trim() === m.commit) await runWorktreeGit(g, m.root, ["branch", "-D", m.branch]);
  }
  return nothingAt(m.path);
}

/**
 * W8 and W4: the chat's worktree made again at its own path from its own branch (`worktree add <path> <branch>`), after a
 * prune of what git still records for the gone folder. The path is one of the project's two places (place.ts): in the
 * project's `.claude/worktrees`, with the link rule and the local ignore of a new add, or, for a worktree made before
 * row 100, in the project's folder of the data folder. Its record in the making (pending.ts, with no commit) is written
 * before the add, as a new chat's is, and goes once the add is done or undone. False when the branch is gone, the path
 * is taken or at neither place, the record cannot be written, or git fails. A worktree that is there already is the
 * chat's own, except after Archive's removal (`removed`): then only one on the chat's own branch is (a remake whose
 * ledger write was lost), since another tool may have taken the freed name (`claude -w <name>`); any other is taken.
 */
export async function remakeWorktree(g: WorktreeGit, w: LedgerWorktree, data: string, projectId: string, say: Say = sayOnStderr): Promise<boolean> {
  if (worktreeHere(w.path, w.root)) return !w.removed || (await onBranch(g, w.root, w.path, w.branch));
  const base = await baseOf(g, w.root);
  if (typeof base === "string") return false;
  const records = projectRecords(data, projectId);
  if (!records) return false;
  const place = placeOf(w.path, w.root, records);
  if (place === null || (place === "project" && (!placeOk(w.root) || !worktreesIn(w.root))) || !nothingAt(w.path)) return false;
  if (!(await branchExists(g, w.root, w.branch))) return false;
  if (!(await markMaking(w, records, true))) return false;
  if (place === "project") await ignoreWorktrees(g, w.root, basename(w.path), say).catch(() => null);
  await runWorktreeGit(g, w.root, ["worktree", "prune"]);
  const add = await runWorktreeGit(g, w.root, ["worktree", "add", w.path, w.branch], { config: base.config, ms: g.addMs });
  if (add.code === 0 && folderAt(w.path) && worktreeHere(w.path, w.root)) {
    // The chat's ledger holds the worktree already.
    await unmarkMaking(w, records);
    return true;
  }
  // A checkout cut part way leaves the folder and git's locked entry, as at the first add; the branch is the chat's.
  if (await undoAdd(g, { path: w.path, root: w.root, branch: w.branch, commit: null })) await unmarkMaking(w, records);
  return false;
}

/** The filter drivers' off switches for git in the worktree `w` (its config.worktree too); null: none can be read. */
async function configIn(g: WorktreeGit, w: LedgerWorktree): Promise<string[] | null> {
  const config = await readRepoConfig(g, w.path);
  return config && !config.refused ? filterArgs(config.filters) : null;
}

/** W7: the worktree's status, as a count of files with changes and whether each one is only a deletion of a file. */
async function worktreeStatus(g: WorktreeGit, w: LedgerWorktree): Promise<{ changes: number; deletions: number } | null> {
  if (!worktreeHere(w.path, w.root)) return null;
  const config = await configIn(g, w);
  if (!config) return null;
  // -z: each entry ends with a NUL, and a rename or a copy names its old path after it, in a NUL-ended field of its own.
  const r = await runWorktreeGit(g, w.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { config, ms: g.addMs });
  if (r.code !== 0) return null;
  let changes = 0;
  let deletions = 0;
  const fields = r.out.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    if (f.length < 4) continue;
    changes++;
    if (f[0] === " " && f[1] === "D") deletions++;
    if (f[0] === "R" || f[0] === "C" || f[1] === "R" || f[1] === "C") i++;
  }
  return { changes, deletions };
}

/** W7, L26: how many files have changes in the worktree (tracked and untracked); null: it is not there or unread. */
export async function worktreeChanges(g: WorktreeGit, w: LedgerWorktree): Promise<number | null> {
  return (await worktreeStatus(g, w))?.changes ?? null;
}

/** How many ignored files ignoredWork compares with the project's own before it counts the rest as work. */
const COPY_CHECK = { files: 500, bytes: 16 * 1024 * 1024 } as const;

/** `rel` under `a` and under `b` are regular files (no link on the way) with the same bytes. */
async function sameFile(a: string, b: string, rel: string, room: { files: number }): Promise<boolean> {
  if (--room.files < 0) return false;
  try {
    const [sa, sb] = await Promise.all([lstat(join(a, rel)), lstat(join(b, rel))]);
    if (!sa.isFile() || !sb.isFile() || sa.size !== sb.size || sa.size > COPY_CHECK.bytes) return false;
    const [ba, bb] = await Promise.all([readFile(join(a, rel)), readFile(join(b, rel))]);
    return ba.equals(bb);
  } catch {
    return false;
  }
}

/** Every file under the folder `rel` of `a` is a same file of `b` (the walk never follows a link). */
async function sameTree(a: string, b: string, rel: string, room: { files: number }): Promise<boolean> {
  let names: string[];
  try {
    if (!(await lstat(join(a, rel))).isDirectory()) return false;
    names = await readdir(join(a, rel));
  } catch {
    return false;
  }
  for (const name of names) {
    const sub = `${rel}/${name}`;
    let st;
    try {
      st = await lstat(join(a, sub));
    } catch {
      return false;
    }
    if (!(st.isDirectory() ? await sameTree(a, b, sub, room) : await sameFile(a, b, sub, room))) return false;
  }
  return true;
}

/**
 * W7 (L25): the worktree holds files that git ignores (`ls-files --others --ignored --exclude-standard --directory`)
 * other than unchanged copies of the project's own files (what `.worktreeinclude` copied in): an edited `.env`, a local
 * database, notes in an ignored folder, a build's output. `git worktree remove` would delete them without a word, so
 * Archive keeps such a worktree as it keeps one with changes. Null when it is not there or cannot be read.
 */
export async function ignoredWork(g: WorktreeGit, w: LedgerWorktree): Promise<boolean | null> {
  if (!worktreeHere(w.path, w.root)) return null;
  const r = await runWorktreeGit(g, w.path, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory"]);
  if (r.code !== 0) return null;
  const room = { files: COPY_CHECK.files };
  for (const entry of r.out.split("\0")) {
    if (!entry) continue;
    const folder = entry.endsWith("/");
    const rel = folder ? entry.slice(0, -1) : entry;
    if (!isSafeRelativePath(rel)) return true;
    if (!(folder ? await sameTree(w.path, w.root, rel, room) : await sameFile(w.path, w.root, rel, room))) return true;
  }
  return false;
}

/** L26: the branch holds a commit that no other branch has (so Delete keeps it). False when the branch is gone. */
export async function branchStays(g: WorktreeGit, w: LedgerWorktree): Promise<boolean> {
  if (!(await branchExists(g, w.root, w.branch))) return false;
  // `--exclude` before `--branches` takes the branch's name without refs/heads/ (git-rev-list).
  const r = await runWorktreeGit(g, w.root, ["rev-list", "--count", `refs/heads/${w.branch}`, "--not", `--exclude=${w.branch}`, "--branches"]);
  // A count that cannot be read keeps the branch.
  return r.code !== 0 || r.out.trim() !== "0";
}

/**
 * W7 (clean, no force) and W9 (`force`, after the user's confirm): `git worktree remove`, then `worktree prune`. Never
 * a recursive delete: a worktree that git does not remove stays where it is. A path that is no linked worktree of its
 * root (a link, a folder that only looks like one) is never handed to git. Without `force` git runs a status inside
 * the worktree first, so the filter drivers of every scope that applies there are off for it (git hands the `-c`
 * pairs on to that status), and a config that cannot be read or is refused keeps the worktree. The removal gets the
 * add's long deadline: a removal ended part way would leave a half-removed worktree. True when the folder is gone (a
 * gone path counts only while the project's folder is there: inside one that is away, it says nothing).
 */
export async function removeWorktree(g: WorktreeGit, w: LedgerWorktree, force: boolean): Promise<boolean> {
  if (nothingAt(w.path)) {
    if (!folderAt(w.root)) return false;
    await runWorktreeGit(g, w.root, ["worktree", "prune"]);
    return true;
  }
  if (linkedRootOf(w.path) !== w.root) return false;
  const config = await configIn(g, w);
  if (!config && !force) return false;
  const r = await runWorktreeGit(g, w.root, ["worktree", "remove", ...(force ? ["--force"] : []), w.path], { config: config ?? [], ms: g.addMs });
  await runWorktreeGit(g, w.root, ["worktree", "prune"]);
  return r.code === 0 && nothingAt(w.path);
}

/**
 * W7 (L25): Archive's removal of a worktree that was clean a moment ago (`worktreeChanges` 0, no ignored work). When
 * git's removal stops part way (its deadline, an error), the worktree is read again: if it lacks only files that git
 * had deleted already (each change a deletion), the removal is finished with `--force` and no confirm, since nothing
 * in it is the user's (Archive's own removal is never left half done); a worktree with other changes now stays
 * (`kept`); a whole, clean one, or one that is no longer a worktree (W4's check then gives its line at the next start),
 * is left as it is (null).
 */
export async function archiveRemove(g: WorktreeGit, w: LedgerWorktree): Promise<"removed" | "kept" | null> {
  if (await removeWorktree(g, w, false)) return "removed";
  const now = await worktreeStatus(g, w);
  if (!now || now.changes === 0) return null;
  if (now.deletions < now.changes) return "kept";
  return (await removeWorktree(g, w, true)) ? "removed" : null;
}

/** W9: the chat's branch goes, only when no commit of its own would go with it (L26). True when it went. */
export async function dropBranch(g: WorktreeGit, w: LedgerWorktree): Promise<boolean> {
  if (await branchStays(g, w)) return false;
  if (!(await branchExists(g, w.root, w.branch))) return true;
  return (await runWorktreeGit(g, w.root, ["branch", "-D", w.branch])).code === 0;
}
