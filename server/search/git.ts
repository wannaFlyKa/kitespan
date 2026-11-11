// The corpus from git (DESIGN.md 9.3; build checklist B1): the chat folder's files as `git ls-files` gives them, in
// two calls, tracked files first (git prints the untracked entries before the tracked ones, so one combined call
// under a cap would keep untracked files and drop tracked ones), then the untracked files that are not ignored, in
// the room that is left.
//
// A repository's own config can name a program that ls-files runs (core.fsmonitor), and the listing runs in the
// background with no act of the user, so git runs with core.fsmonitor off, with no optional locks (a read never
// writes the index), with every GIT_* variable that the server inherited taken out (GIT_DIR or GIT_WORK_TREE would
// list another repository), with no prompt and no lazy fetch, stdin ignored and stderr dropped. stdout is read as a
// stream, split on NUL (-z: every name comes out as it is), and git is killed at the cap or at the deadline.
//
// A symbolic link is left out, as the walk leaves it out (W19d): one that leads outside the folder would be offered by
// the @ picker and then refused at Send. The tracked part is read with its modes (`--stage`: a link is mode 120000, a
// submodule's entry, a folder, 160000); the untracked paths are checked with lstat, a few at a time off the event loop.
//
// git runs with the chat's folder as its working folder, which the repository controls, so a relative PATH entry
// (".", an empty entry, "bin") names a file of that folder: such entries are taken out of git's PATH, and git itself
// is found on the absolute entries only, as an absolute path, or not at all (then the walk lists the folder).

import { lstat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isSafeRelativePath } from "../../shared/protocol";

/** The flags before `ls-files`: no optional locks, pathspecs taken literally, the fsmonitor hook off. */
const FLAGS = ["--no-optional-locks", "--literal-pathspecs", "-c", "core.fsmonitor=false"] as const;

/** A PATH with its absolute entries only, in their order: no ".", no empty entry, no relative entry. */
export function absolutePath(pathEnv: string): string {
  return pathEnv
    .split(":")
    .filter((p) => isAbsolute(p))
    .join(":");
}

/**
 * A program that fails at once, for git's and ssh's password prompts: `false` on the absolute entries of `pathEnv`,
 * else the system's own (/usr/bin/false; Linux has /bin/false too, macOS has no /bin/false).
 */
export function failingProgram(pathEnv: string): string {
  const PATH = absolutePath(pathEnv);
  return (PATH && Bun.which("false", { PATH })) || Bun.which("false", { PATH: "/usr/bin:/bin" }) || "/usr/bin/false";
}

/** `git` on the absolute entries of `pathEnv`, as an absolute path; null when there is none (the walk runs). */
export function findGit(pathEnv: string): string | null {
  const PATH = absolutePath(pathEnv);
  if (!PATH) return null;
  const found = Bun.which("git", { PATH });
  return found !== null && isAbsolute(found) ? found : null;
}

/**
 * The environment git runs with: `base` with every GIT_* variable taken out, plus the fixed ones, and PATH with its
 * absolute entries only. A PATH with none left is not set at all: an empty PATH is the working folder to a shell.
 */
export function gitEnv(base: Readonly<Record<string, string | undefined>>, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
  const out: Record<string, string> = { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", LC_ALL: "C", ...extra };
  const PATH = absolutePath(out.PATH ?? "");
  if (PATH) out.PATH = PATH;
  else delete out.PATH;
  return out;
}

/**
 * A path the corpus keeps: relative to the root with no `.` or `..` segment, no control character, at most 1,024
 * characters (the download route's rule), not a folder entry (`nested/`, an untracked repository), and valid UTF-8
 * (a name that does not decode holds U+FFFD, and could not be found again by that name).
 */
export function keepPath(p: string): boolean {
  return isSafeRelativePath(p) && !p.includes("\uFFFD");
}

export interface GitOptions {
  /** The git program: an absolute path, or nothing runs (a relative one would be found from the chat's folder). */
  git: string;
  /** The most paths kept, both calls together. */
  max: number;
  /** The deadline for both calls together, in ms. */
  ms: number;
  /** The environment (gitEnv's result). */
  env: Record<string, string>;
}

export interface GitListing {
  /** The exit code of `ls-files --cached`; null when it was killed or did not start. */
  code: number | null;
  paths: string[];
  /** The cap stopped the listing: there were more paths than `max`. */
  capped: boolean;
  /** The deadline stopped a call. */
  timeout: boolean;
  /** git could not be started. */
  spawnFailed: boolean;
}

interface Call {
  code: number | null;
  capped: boolean;
  timeout: boolean;
  spawnFailed: boolean;
}

/** The index modes of entries that are no file: a symbolic link and a submodule's entry (a gitlink). */
const NOT_FILE_MODES = new Set(["120000", "160000"]);
/** The room before a `--stage` record's path: its mode, object id (SHA-256 at most), stage and the tab. */
const STAGE_PREFIX_MAX = 128;

/** The untracked paths checked for a link at once. */
const LSTAT_BATCH = 64;

/**
 * `paths` under `root` without the symbolic links, in their order, checked in batches off the event loop (an entry
 * that cannot be read is kept: the send checks it). Past `deadline` the rest is not checked and is left out.
 */
async function withoutLinks(root: string, paths: readonly string[], deadline: number): Promise<{ kept: string[]; timeout: boolean }> {
  const kept: string[] = [];
  for (let i = 0; i < paths.length; i += LSTAT_BATCH) {
    if (performance.now() > deadline) return { kept, timeout: true };
    const batch = paths.slice(i, i + LSTAT_BATCH);
    const links = await Promise.all(batch.map((p) => lstat(join(root, p)).then((st) => st.isSymbolicLink(), () => false)));
    batch.forEach((p, j) => {
      if (!links[j]) kept.push(p);
    });
  }
  return { kept, timeout: false };
}

/**
 * How a call's records are read: `stage`, the `--stage` form (`<mode> <object> <stage>TAB<path>`), whose links and
 * submodule entries are left out; `dedupe`, an unmerged path is listed once per stage, one after another, and is
 * kept once.
 */
interface Records {
  stage: boolean;
  dedupe: boolean;
}

/** One `ls-files -z` call: its kept paths go into `out`, at most `room` of them. */
async function lsFiles(opts: GitOptions, root: string, args: readonly string[], room: number, deadline: number, out: string[], how: Records): Promise<Call> {
  let proc: ReturnType<typeof Bun.spawn<"ignore", "pipe", "ignore">>;
  try {
    proc = Bun.spawn([opts.git, ...FLAGS, "-C", root, "ls-files", "-z", ...args], { cwd: root, env: opts.env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  } catch {
    return { code: null, capped: false, timeout: false, spawnFailed: true };
  }
  let timeout = false;
  const timer = setTimeout(
    () => {
      timeout = true;
      proc.kill("SIGKILL");
    },
    Math.max(0, deadline - performance.now()),
  );
  const decoder = new TextDecoder("utf-8");
  const longest = 1_024 + (how.stage ? STAGE_PREFIX_MAX : 0);
  let rest = "";
  // A piece longer than any kept path is dropped up to its NUL, so a stream with no NUL never piles up.
  let skipping = false;
  let last: string | null = null;
  let kept = 0;
  let capped = false;
  const reader = proc.stdout.getReader();
  try {
    read: for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = rest + decoder.decode(value, { stream: true });
      let start = 0;
      for (;;) {
        const nul = text.indexOf("\0", start);
        if (nul < 0) break;
        let p = text.slice(start, nul);
        start = nul + 1;
        if (skipping) {
          skipping = false;
          continue;
        }
        if (how.stage) {
          const tab = p.indexOf("\t");
          if (tab < 0) continue;
          const mode = p.slice(0, p.indexOf(" "));
          p = p.slice(tab + 1);
          if (NOT_FILE_MODES.has(mode)) continue;
        }
        // An unmerged path is listed once per stage, one after another.
        if (!keepPath(p) || (how.dedupe && p === last)) continue;
        last = p;
        if (kept >= room) {
          capped = true;
          break read;
        }
        out.push(p);
        kept++;
      }
      rest = text.slice(start);
      if (rest.length > longest) {
        rest = "";
        skipping = true;
      }
    }
  } catch {
    // the stream broke off (the kill): what came stands
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (capped) proc.kill("SIGKILL");
  await proc.exited;
  clearTimeout(timer);
  return { code: capped || timeout ? null : proc.exitCode, capped, timeout, spawnFailed: false };
}

/**
 * The files of `root` (a real path) by git: `--cached`, then `--others --exclude-standard` for the room that is
 * left. The second call runs only when the first exited 0 (or was cut by the cap), and runs even with no room left,
 * so `capped` says whether any path was left out. A git that is not an absolute path is not started (`spawnFailed`).
 */
export async function listGit(root: string, opts: GitOptions): Promise<GitListing> {
  if (!isAbsolute(opts.git)) return { code: null, paths: [], capped: false, timeout: false, spawnFailed: true };
  const deadline = performance.now() + opts.ms;
  const paths: string[] = [];
  const cached = await lsFiles(opts, root, ["--cached", "--stage"], opts.max, deadline, paths, { stage: true, dedupe: true });
  const listing: GitListing = { code: cached.code, paths, capped: cached.capped, timeout: cached.timeout, spawnFailed: cached.spawnFailed };
  if (cached.code !== 0) return listing;
  const untracked: string[] = [];
  const others = await lsFiles(opts, root, ["--others", "--exclude-standard"], opts.max - paths.length, deadline, untracked, { stage: false, dedupe: false });
  const files = await withoutLinks(root, untracked, deadline);
  paths.push(...files.kept);
  listing.capped = others.capped;
  listing.timeout = others.timeout || files.timeout;
  listing.spawnFailed = others.spawnFailed;
  return listing;
}
