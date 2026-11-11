// U1 (DESIGN-U1 3, 5 and 9): the git of a turn's marks and of a diff's read. A mark is a tree object of the chat's
// folder as it is on disk, made through a private index, its new objects in the chat's own changes folder:
//
// - the repository's index (`rev-parse --git-path index`, a linked worktree's own) is copied into the mark's working
//   folder, `changes/<chat>/mark/` (0700, emptied before each mark: git writes its own lock there at git's file mode,
//   so the state folder's checks look at that folder and not into it), and git runs with GIT_INDEX_FILE at that copy,
//   GIT_OBJECT_DIRECTORY at the chat's `objects/` and GIT_ALTERNATE_OBJECT_DIRECTORIES at the repository's objects
//   (`rev-parse --git-common-dir`), which it only reads;
// - `ls-files -z --others --exclude-standard` lists the untracked files; one over 8 MiB is left out of the mark by a
//   NUL-separated pathspec file (`.` and one `:(exclude,literal)<path>` each), its size and times kept. A folder whose
//   other untracked files are more than CHANGES_LIMITS.markFiles or CHANGES_LIMITS.markBytes takes no mark at all
//   (`big`): a fresh `git init` in a project, a `node_modules` that is not ignored, a repository of a whole home folder;
// - `add --all --ignore-errors --pathspec-from-file <file> --pathspec-file-nul`, then `write-tree`: the tree's id is the
//   mark. The copy and the pathspec file are removed after each mark. Ignored files are never in a mark.
//
// git is kitespan's own worktree git (server/worktree/git.ts): from the absolute PATH entries of the start environment,
// every inherited GIT_* variable out, no prompt, no hook, no fsmonitor, no transport, no credential helper, stdin
// ignored, stderr dropped, its own process group ended at a deadline, its output capped, plus no split index written
// and no untracked cache. Every filter driver of every config scope gets empty commands (so a clean filter, git-lfs
// too, never runs), and a repository whose own config could run a program takes no mark at all (readRepoConfig).
// Nothing is written into the repository: no ref, no index, no object, no config, no work-tree file, and no file
// changes its bytes or its size. As every `git add` does, git refreshes the time of the repository's packs and loose
// objects that a mark finds, and of a split index's shared index file, which reading the copied index freshens
// (DESIGN-U1 3 and 19). Needs git 2.25 or later (`--pathspec-from-file`). git runs only at a turn's start and end and at
// a diff's read: never on a timer. A diff's read takes its paths literally (GIT_LITERAL_PATHSPECS), so a `[id].tsx`
// or a `*` in a name matches that name alone.

import { copyFile, lstat, mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CHANGES_LIMITS } from "../../shared/changes";
import { filterArgs, readRepoConfig, runWorktreeGit, type WorktreeGit, type WorktreeGitResult } from "../worktree/git";
import { lsTreeSize, parsePatch, parseRawNumstat, type ParsedPatch, type RawChange } from "./patch";
import type { LargeFile } from "./summary";

/** After the worktree code's flags: a mark writes no split index and no untracked cache. */
export const MARK_FLAGS = ["-c", "core.splitIndex=false", "-c", "core.untrackedCache=false"] as const;

/** The longest outputs kept: the untracked listing, the summary, one file's patch (past it: too large). */
export const MARK_OUT = { untracked: 8 * 1024 * 1024, summary: 16 * 1024 * 1024 } as const;

/** The chat folder's repository, as a mark needs it. */
export interface RepoAt {
  /** The chat's folder: git runs there, and every path is relative to it (`--relative`). */
  cwd: string;
  /** The index of the folder's work tree (absolute). */
  index: string;
  /** The repository's objects folder (absolute), which the marks read as an alternate. */
  objects: string;
  /** The `-c` pairs before every subcommand: MARK_FLAGS, then each filter driver's empty commands. */
  config: string[];
}

export type RepoProbe = { ok: true; repo: RepoAt } | { ok: false; why: "not_git" | "no_git" | "refused" | "failed" };

/** The chat's changes folder, as the marks use it. */
export interface MarkPlace {
  /** `changes/<chat>/`, 0700. */
  dir: string;
  /** `changes/<chat>/objects/`, 0700: the marks' new objects. */
  objects: string;
  /** `changes/<chat>/mark/`, 0700: a mark's private index, git's lock of it and the pathspec file, while it runs. */
  work: string;
}

/** Why a mark was not taken, for its caller: too many untracked files to hash, or anything else. */
export interface MarkWhy {
  why?: "big" | "failed";
}

/** The most untracked files (each under the large file cap) a mark hashes, and their bytes. */
export interface MarkCaps {
  files: number;
  bytes: number;
}
const MARK_CAPS: MarkCaps = { files: CHANGES_LIMITS.markFiles, bytes: CHANGES_LIMITS.markBytes };

/** A mark: its tree, and the large untracked files it left out. */
export interface Mark {
  tree: string;
  large: Map<string, LargeFile>;
}

const left = (deadline: number) => Math.max(1, Math.round(deadline - performance.now()));
const TREE_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** The git of one call: the base git with these variables after its own, and the deadline's time left. */
function withEnv(g: WorktreeGit, extra: Record<string, string>, deadline: number): WorktreeGit {
  return { ...g, env: { ...g.env, ...extra }, callMs: left(deadline) };
}

function placeEnv(repo: RepoAt, place: MarkPlace, index?: string): Record<string, string> {
  return {
    GIT_OBJECT_DIRECTORY: place.objects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: repo.objects,
    // A read never needs an index; a name in the mark's folder that no mark leaves keeps the repository's own unread.
    GIT_INDEX_FILE: index ?? join(place.work, "no-index"),
  };
}

/**
 * The folder's repository: its index and objects, and the filter drivers to turn off. `not_git` for a folder that is
 * not in a work tree (git exits 128), `no_git` with no git on the absolute PATH entries, `refused` for a repository
 * whose own config could run a program, `failed` for a call that failed or passed the deadline.
 */
export async function probeRepo(g: WorktreeGit, cwd: string, deadline: number, signal?: AbortSignal): Promise<RepoProbe> {
  if (!g.git) return { ok: false, why: "no_git" };
  const r = await runWorktreeGit({ ...g, callMs: left(deadline) }, cwd, ["rev-parse", "--is-inside-work-tree", "--git-path", "index", "--git-common-dir"], { config: MARK_FLAGS, signal });
  if (r.code === null) return { ok: false, why: "failed" };
  const lines = r.out.split("\n");
  if (r.code !== 0 || lines[0] !== "true" || !lines[1] || !lines[2]) return { ok: false, why: "not_git" };
  const conf = await readRepoConfig({ ...g, callMs: left(deadline) }, cwd);
  if (!conf) return { ok: false, why: "failed" };
  if (conf.refused) return { ok: false, why: "refused" };
  return { ok: true, repo: { cwd, index: resolve(cwd, lines[1]), objects: join(resolve(cwd, lines[2]), "objects"), config: [...MARK_FLAGS, ...filterArgs(conf.filters)] } };
}

/** The chat's changes folder of `dir`: its objects and the mark's working folder. */
export function placeOf(dir: string): MarkPlace {
  return { dir, objects: join(dir, "objects"), work: join(dir, "mark") };
}

/** Make the chat's changes folder, its objects folder and the mark's working folder (0700). */
export async function preparePlace(place: MarkPlace): Promise<void> {
  await mkdir(place.dir, { recursive: true, mode: 0o700 });
  await mkdir(place.objects, { recursive: true, mode: 0o700 });
  await mkdir(place.work, { recursive: true, mode: 0o700 });
}

/** Empty the mark's working folder (what a mark that a crash or a kill cut left: the index copy, git's lock). */
export async function clearWork(place: MarkPlace): Promise<void> {
  const names = await readdir(place.work).catch(() => [] as string[]);
  await Promise.all(names.map((n) => unlink(join(place.work, n)).catch(() => {})));
}

/** Remove the temporary object files that a git killed at a deadline left in the chat's objects (`tmp_obj_*`). */
export async function sweepObjects(place: MarkPlace): Promise<number> {
  let n = 0;
  const drop = async (dir: string, names: string[]) => {
    for (const name of names) {
      if (!name.startsWith("tmp_")) continue;
      if (await unlink(join(dir, name)).then(() => true, () => false)) n++;
    }
  };
  const top = await readdir(place.objects).catch(() => [] as string[]);
  await drop(place.objects, top);
  for (const sub of top) if (/^[0-9a-f]{2}$/.test(sub)) await drop(join(place.objects, sub), await readdir(join(place.objects, sub)).catch(() => [] as string[]));
  return n;
}

/** The untracked files over the size cap, and the bytes of the others (which a mark hashes), by lstat in batches; past the deadline, null. */
async function largeOf(cwd: string, paths: readonly string[], deadline: number): Promise<{ large: Map<string, LargeFile>; bytes: number } | null> {
  const large = new Map<string, LargeFile>();
  let bytes = 0;
  for (let i = 0; i < paths.length; i += 64) {
    if (performance.now() > deadline) return null;
    const batch = paths.slice(i, i + 64);
    const stats = await Promise.all(batch.map((p) => lstat(join(cwd, p)).catch(() => null)));
    batch.forEach((p, j) => {
      const st = stats[j];
      if (!st?.isFile()) return;
      if (st.size > CHANGES_LIMITS.largeFileBytes) large.set(p, { size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs });
      else bytes += st.size;
    });
  }
  return { large, bytes };
}

/** A pathspec file's text: the folder, less each large file taken literally. */
export function pathspecOf(large: Iterable<string>): string {
  let s = ".\0";
  for (const p of large) s += `:(exclude,literal)${p}\0`;
  return s;
}

/** Remove a file of the chat's changes folder, if there. */
const drop = (p: string) => unlink(p).catch(() => {});

/**
 * Take a mark of the chat's folder (see the top of this file). Null when a call failed or the deadline passed, or when
 * the untracked files are too many to hash (`why.why` says which); nothing half-made is kept but objects (which a later
 * mark may use).
 */
export async function takeMark(g: WorktreeGit, repo: RepoAt, place: MarkPlace, deadline: number, signal?: AbortSignal, why: MarkWhy = {}, caps: MarkCaps = MARK_CAPS): Promise<Mark | null> {
  const index = join(place.work, "index");
  const spec = join(place.work, "pathspec");
  why.why = "failed";
  try {
    await mkdir(place.work, { recursive: true, mode: 0o700 });
    await clearWork(place);
    try {
      await copyFile(repo.index, index);
    } catch (e) {
      // A repository with nothing added yet has no index: the mark starts from an empty one.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") return null;
      await drop(index);
    }
    const env = placeEnv(repo, place, index);
    const run = (args: string[], maxOut?: number): Promise<WorktreeGitResult> => runWorktreeGit(withEnv(g, env, deadline), repo.cwd, args, { config: repo.config, signal, ...(maxOut ? { maxOut } : {}) });
    const listed = await run(["ls-files", "-z", "--others", "--exclude-standard"], MARK_OUT.untracked);
    if (listed.capped) why.why = "big";
    if (listed.code !== 0) return null;
    const paths = listed.out.split("\0").filter(Boolean);
    if (paths.length > caps.files) {
      why.why = "big";
      return null;
    }
    const sized = await largeOf(repo.cwd, paths, deadline);
    if (!sized) return null;
    if (sized.bytes > caps.bytes) {
      why.why = "big";
      return null;
    }
    const { large } = sized;
    await writeFile(spec, pathspecOf(large.keys()), { mode: 0o600 });
    const added = await run(["add", "--all", "--ignore-errors", "--pathspec-from-file", spec, "--pathspec-file-nul"]);
    // --ignore-errors: a file that could not be read is left out, and git exits 1.
    if (added.code !== 0 && added.code !== 1) return null;
    const tree = await run(["write-tree"]);
    const id = tree.out.trim();
    if (tree.code !== 0 || !TREE_ID.test(id)) return null;
    delete why.why;
    return { tree: id, large };
  } catch {
    return null;
  } finally {
    await Promise.all([drop(index), drop(`${index}.lock`), drop(spec)]);
  }
}

/** The summary's records between two marks, relative to the chat's folder; null on a failure, a cap or the deadline. */
export async function diffMarks(g: WorktreeGit, repo: RepoAt, place: MarkPlace, from: string, to: string, deadline: number, signal?: AbortSignal): Promise<RawChange[] | null> {
  const r = await runWorktreeGit(withEnv(g, placeEnv(repo, place), deadline), repo.cwd, ["diff-tree", "-r", "-M", "-z", "--raw", "--numstat", "--relative", "--no-ext-diff", "--no-textconv", from, to], {
    config: repo.config,
    signal,
    maxOut: MARK_OUT.summary,
  });
  return r.code === 0 ? parseRawNumstat(r.out) : null;
}

/**
 * How many bytes the chat's own objects take (`count-objects -v`): its loose objects (all a mark writes), any pack, and
 * the garbage (the temporary files of a git killed at a deadline, until sweepObjects removes them).
 */
export async function objectBytes(g: WorktreeGit, repo: RepoAt, place: MarkPlace, deadline: number): Promise<number | null> {
  const r = await runWorktreeGit(withEnv(g, placeEnv(repo, place), deadline), repo.cwd, ["count-objects", "-v"], { config: repo.config });
  if (r.code !== 0) return null;
  const kib = (key: string) => Number(new RegExp(`^${key}: ([0-9]+)$`, "m").exec(r.out)?.[1] ?? Number.NaN);
  const parts = [kib("size"), kib("size-pack"), kib("size-garbage")];
  if (!Number.isFinite(parts[0]!)) return null;
  return parts.reduce((s, x) => s + (Number.isFinite(x) ? x : 0), 0) * 1024;
}

export type FilePatch = { ok: true; patch: ParsedPatch } | { ok: false; why: "large"; bytes: number } | { ok: false; why: "gone" | "failed" };

/**
 * One file's diff between two marks (DESIGN-U1 9): both sides' sizes first (`ls-tree -l`), so a side over 1 MiB is too
 * large to compare and no patch is made; then `diff-tree -p -M -U3 --relative` of the path (and a rename's old path),
 * its output capped at 2 MiB (too large past it), its lines cut to the caps. `gone`: a mark's tree is not there any
 * more (the repository moved, or its objects were pruned).
 */
export async function readPatch(
  g: WorktreeGit,
  repo: RepoAt,
  place: MarkPlace,
  marks: { from: string; to: string },
  file: { path: string; from?: string },
  deadline: number,
): Promise<FilePatch> {
  // Each path is taken literally (a `[id].tsx` or a `*` in a name is that name), and the headers name it unquoted but
  // for git's C quoting of a control character, a backslash or a double quote (parsePatch reads them).
  const env = { ...placeEnv(repo, place), GIT_LITERAL_PATHSPECS: "1" };
  const config = [...repo.config, "-c", "core.quotePath=false"];
  const run = (args: string[], maxOut?: number) => runWorktreeGit(withEnv(g, env, deadline), repo.cwd, args, { config, ...(maxOut ? { maxOut } : {}) });
  const [a, b] = await Promise.all([run(["ls-tree", "-l", "-z", marks.from, "--", file.from ?? file.path]), run(["ls-tree", "-l", "-z", marks.to, "--", file.path])]);
  if (a.code === null || b.code === null) return { ok: false, why: "failed" };
  // ls-tree exits 128 for a tree it cannot read.
  if (a.code !== 0 || b.code !== 0) return { ok: false, why: "gone" };
  const sizes = [lsTreeSize(a.out), lsTreeSize(b.out)];
  const bytes = Math.max(sizes[0] ?? 0, sizes[1] ?? 0);
  if (bytes > CHANGES_LIMITS.sideBytes) return { ok: false, why: "large", bytes };
  const paths = file.from && file.from !== file.path ? [file.path, file.from] : [file.path];
  const p = await run(["diff-tree", "-p", "-M", "-U3", "--relative", "--no-ext-diff", "--no-textconv", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", marks.from, marks.to, "--", ...paths], CHANGES_LIMITS.patchBytes);
  if (p.capped) return { ok: false, why: "large", bytes };
  if (p.code === null) return { ok: false, why: "failed" };
  if (p.code !== 0) return { ok: false, why: "gone" };
  // Only the asked file's own section (and its rename's old side): a path of a folder that a file became, say, is
  // also a pathspec of every file under it.
  return { ok: true, patch: parsePatch(p.out, { maxLines: CHANGES_LIMITS.lines, lineChars: CHANGES_LIMITS.lineChars, only: { path: file.path, ...(file.from ? { from: file.from } : {}) } }) };
}
