// The main checkout's local ignore of its worktrees (owner row 100; DESIGN.md 9.4). A linked worktree at
// `<root>/.claude/worktrees/<name>` shows in the main checkout's `git status` as untracked, and a `git add -A` there
// would stage it as an embedded repository. Claude Code's CLI keeps its own runtime files and worktrees out with a
// block in the repository's `info/exclude` (its pattern `**/.claude/worktrees/`); its worktree creation itself writes
// no ignore, and Desktop's docs name none. kitespan does the same with one line, before each add at that place:
//
// - It asks git first (`check-ignore -q --no-index`, with a trailing slash, since the pattern names folders and the
//   folder may not be there yet): an answer of 0 (a `.gitignore` line, Claude Code's block, a global rule) leaves
//   everything as it is.
// - It writes only `<git common dir>/info/exclude`, the repository's own local file, never `.gitignore`, a global
//   excludes file or any tracked file. The common dir must be `<root>/.git`: a real folder with no `commondir` file,
//   holding a regular HEAD file and an objects folder (lstat: a link does not count).
// - The append is Claude Code's: `info` made when missing; `exclude` made with O_CREAT | O_EXCL (0644) when missing,
//   else opened with O_APPEND | O_NOFOLLOW; it must be a regular file with one hard link, at most 1 MiB, and the same
//   file (device and inode) as the path names; a newline first when the file does not end with one. The line goes in
//   once (one step at a time per repository): a later rule of the user's that turns it back stays as it is.
//
// The worktree is made whether or not this works (Claude Code makes its own with no ignore at all); a skip is one line
// on the server's terminal, in Claude Code's words.

import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, writeSync } from "node:fs";
import { join } from "node:path";
import { runWorktreeGit, type WorktreeGit } from "./git";

/** The line, Claude Code's own pattern for its worktrees. */
export const IGNORE_LINE = "**/.claude/worktrees/";

/** The largest `info/exclude` that kitespan appends to (Claude Code's limit). */
const MAX_EXCLUDE = 1024 * 1024;

export type IgnoreOutcome = "ignored" | "added" | { skipped: string };

/** The skip's line (Claude Code's words, with kitespan's worktrees in place of its own files). */
export function ignoreSkipLine(path: string, reason: string): string {
  return `Not adding ignore rules for kitespan's worktrees to ${path}: ${reason}. They may show as untracked in git status.`;
}

/** The line when git still does not ignore the folder after the append (Claude Code checks again, too). */
export function ignoreUnconfirmedLine(path: string): string {
  return `Added an ignore rule for kitespan's worktrees to ${path}, but git still does not ignore them. They may show as untracked in git status.`;
}

const code = (e: unknown) => (e as NodeJS.ErrnoException)?.code;

/** `p`'s lstat, or null when nothing is there; throws on any other error. */
function lstatOrNull(p: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(p);
  } catch (e) {
    if (code(e) === "ENOENT") return null;
    throw e;
  }
}

/** The repository's own git folder, `<root>/.git`, when git names it as the common dir and it passes the checks. */
async function commonDir(g: WorktreeGit, root: string): Promise<string | { skipped: string }> {
  const dotGit = join(root, ".git");
  const r = await runWorktreeGit(g, root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const named = r.out.replace(/\n$/, "");
  if (r.code !== 0 || !named) return { skipped: "git could not name the repository's git folder" };
  try {
    if (named !== dotGit || realpathSync(dotGit) !== dotGit || !lstatSync(dotGit).isDirectory()) return { skipped: "the git folder is a link or not a folder" };
    if (lstatOrNull(join(dotGit, "commondir")) !== null) return { skipped: "the git folder is shared with another checkout" };
    if (!lstatOrNull(join(dotGit, "HEAD"))?.isFile() || !lstatOrNull(join(dotGit, "objects"))?.isDirectory()) return { skipped: "the git folder has no HEAD file or no objects folder" };
  } catch {
    return { skipped: "kitespan could not check the git folder" };
  }
  return dotGit;
}

/** Append `line` to `<common>/info/exclude` the safe way; null when it is written, else why not. */
export function appendExclude(common: string, line: string): string | null {
  const info = join(common, "info");
  const path = join(info, "exclude");
  try {
    if (lstatOrNull(info) === null) {
      try {
        mkdirSync(info);
      } catch (e) {
        if (code(e) !== "EEXIST") throw e;
      }
    }
    if (!lstatSync(info).isDirectory()) return "its parent folder is a link or not a folder";
  } catch {
    return "its parent folder is a link or not a folder";
  }
  const flags = constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW;
  let fd: number;
  try {
    fd = openSync(path, flags | constants.O_CREAT | constants.O_EXCL, 0o644);
  } catch (e) {
    if (code(e) !== "EEXIST") return code(e) === "EACCES" || code(e) === "EPERM" || code(e) === "EROFS" ? "it cannot be written to" : "kitespan could not open it";
    try {
      fd = openSync(path, flags);
    } catch (e2) {
      if (code(e2) === "ELOOP") return "it is a symlink";
      if (code(e2) === "EISDIR" || code(e2) === "ENXIO") return "it is not a regular file";
      if (code(e2) === "ENOENT") return "it was replaced or removed while kitespan was opening it";
      if (code(e2) === "EACCES" || code(e2) === "EPERM" || code(e2) === "EROFS") return "it cannot be written to";
      return "kitespan could not open it";
    }
  }
  try {
    const open = fstatSync(fd);
    const named = lstatOrNull(path);
    if (!open.isFile() || !named?.isFile()) return "it is not a regular file";
    if (open.dev !== named.dev || open.ino !== named.ino) return "it was replaced or removed while kitespan was opening it";
    if (open.nlink > 1 || named.nlink > 1) return "it has more than one hard link";
    if (open.size > MAX_EXCLUDE) return "it is larger than 1 MiB";
    const was = Buffer.alloc(open.size);
    const got = open.size > 0 ? readSync(fd, was, 0, open.size, 0) : 0;
    const text = was.subarray(0, got).toString("utf8");
    // The line once only: a user's later rule that turns it back is the user's to keep.
    if (text.split(/\r?\n/).includes(line)) return "it has the line already, and a later rule turns it back";
    writeSync(fd, `${text.length > 0 && !text.endsWith("\n") ? "\n" : ""}${line}\n`);
    return null;
  } catch {
    return "kitespan could not write it";
  } finally {
    closeSync(fd);
  }
}

/** git's answer for the folder: 0 ignored, 1 not ignored, anything else (null) no answer. */
async function ignored(g: WorktreeGit, root: string, rel: string): Promise<boolean | null> {
  const r = await runWorktreeGit(g, root, ["check-ignore", "-q", "--no-index", "--", rel]);
  return r.code === 0 ? true : r.code === 1 ? false : null;
}

/** One ignore step at a time per repository, so two Starts at once write the line once. */
const chains = new Map<string, Promise<unknown>>();

/**
 * Before an add at `<root>/.claude/worktrees/<name>` (`root` the main checkout's top folder, ops.ts baseOf): the line
 * in the repository's `info/exclude` unless git ignores the folder already. `say` gets the one line of a skip.
 */
export function ignoreWorktrees(g: WorktreeGit, root: string, name: string, say: (line: string) => void): Promise<IgnoreOutcome> {
  const was = chains.get(root) ?? Promise.resolve();
  const run = was.then(
    () => ignoreOnce(g, root, name, say),
    () => ignoreOnce(g, root, name, say),
  );
  const tail = run.catch(() => undefined);
  chains.set(root, tail);
  void tail.then(() => {
    if (chains.get(root) === tail) chains.delete(root);
  });
  return run;
}

async function ignoreOnce(g: WorktreeGit, root: string, name: string, say: (line: string) => void): Promise<IgnoreOutcome> {
  const rel = `.claude/worktrees/${name}/`;
  const before = await ignored(g, root, rel);
  const exclude = join(root, ".git", "info", "exclude");
  const skip = (reason: string): IgnoreOutcome => {
    say(ignoreSkipLine(exclude, reason));
    return { skipped: reason };
  };
  if (before === true) return "ignored";
  if (before === null) return skip("git could not say whether the folder is ignored");
  const common = await commonDir(g, root);
  if (typeof common !== "string") return skip(common.skipped);
  const why = appendExclude(common, IGNORE_LINE);
  if (why) return skip(why);
  if ((await ignored(g, root, rel)) !== true) {
    say(ignoreUnconfirmedLine(exclude));
    return { skipped: "git still does not ignore the folder" };
  }
  return "added";
}
