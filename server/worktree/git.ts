// kitespan's own worktree git (DESIGN.md 9.4 "Worktrees", "Git safety"; build checklist W1). kitespan makes, checks and
// removes each chat's worktree itself (the way W-host, L20), so no program that a repository's config or files name may
// run, as Claude Code's own `--worktree` rules say:
//
// - git from the absolute PATH entries only, with the start environment (server/start-env-copy.ts) scrubbed as the
//   corpus code scrubs it (every inherited GIT_* variable out, no prompt, no lazy fetch), password prompts that fail at
//   once, and GIT_NO_REPLACE_OBJECTS=1 whatever the start environment said. The variables of an environment (D60) never
//   come here.
// - Before every subcommand: no optional locks, no hooks (`worktree add` runs post-checkout otherwise, "unless
//   --no-checkout is used"), no fsmonitor, no submodule recursion, no automatic gc or maintenance, none of git's own
//   transports (a lazy fetch of an old git, or a submodule's clone, is refused by git itself), and no credential helper
//   (an empty `credential.helper` clears the list).
// - Every filter driver that a config file defines (each `filter.<name>`, in any scope: the system's, the user's, the
//   repository's and its `config.worktree`) gets empty commands, so a checkout or a status runs none of them. That
//   includes git-lfs, whose filter the user's or the system's config names: git-lfs never runs, so it never sends a
//   request to the URL of a repository's `.lfsconfig` (git's `protocol.*.allow` does not reach git-lfs), and
//   GIT_LFS_SKIP_SMUDGE=1 is set too. A repository config that could still run a program, or whose filter names
//   cannot be passed back to git safely, gets no worktree at all (configProblem).
// - Stdin ignored, stderr dropped, a deadline; git runs in a process group of its own, which the deadline and the
//   server's exit end with every helper in it.
//
// A worktree goes only through `git worktree remove` and `worktree prune`: never a recursive delete of a folder.
// `--force` comes only after the user's confirm (Delete), or where nothing in the worktree is the user's (ops.ts: what
// a failed add left, and the rest of Archive's own removal of a clean worktree that stopped part way).

import type { Subprocess } from "bun";
import { failingProgram, findGit, gitEnv } from "../search/git";
import { START_ENV } from "../start-env-copy";

/** Before every subcommand: the corpus code's flags and Claude Code's own, no git transport, no credential helper. */
export const WORKTREE_GIT_FLAGS = [
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "submodule.recurse=false",
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
  "-c",
  "protocol.allow=never",
  ...["file", "git", "http", "https", "ssh", "ext"].flatMap((p) => ["-c", `protocol.${p}.allow=never`]),
  "-c",
  "credential.helper=",
] as const;

/** The deadline of one call, and of `worktree add`, whose checkout of a large repository takes longer. */
export const WORKTREE_GIT_MS = { call: 15_000, add: 120_000 } as const;

/** The longest stdout a call keeps; past it git is killed and the call fails. */
const MAX_OUT = 256 * 1024;

export interface WorktreeGit {
  /** git on the absolute PATH entries; null: no git, and every call fails. */
  git: string | null;
  env: Record<string, string>;
  callMs: number;
  addMs: number;
}

/**
 * The worktree git of a base environment (the start environment by default). `extra` comes after the scrub (tests
 * name a scratch global config with it).
 */
export function worktreeGit(
  base: Readonly<Record<string, string | undefined>> = START_ENV,
  extra: Readonly<Record<string, string>> = {},
  ms: { call?: number; add?: number } = {},
): WorktreeGit {
  // A password prompt fails at once (`false` on the absolute PATH entries), and ssh never asks, as the update reads do.
  const failing = failingProgram(base.PATH ?? "");
  const fixed = { GIT_ASKPASS: failing, SSH_ASKPASS: failing, GIT_SSH_COMMAND: "ssh -o BatchMode=yes", GCM_INTERACTIVE: "never", GIT_NO_REPLACE_OBJECTS: "1", GIT_LFS_SKIP_SMUDGE: "1" };
  return {
    git: findGit(base.PATH ?? ""),
    env: gitEnv(base, { ...fixed, ...extra }),
    callMs: ms.call ?? WORKTREE_GIT_MS.call,
    addMs: ms.add ?? WORKTREE_GIT_MS.add,
  };
}

export interface WorktreeGitResult {
  /** git's exit code; null when it did not start, was killed at the deadline, or wrote more than it may. */
  code: number | null;
  out: string;
  /** With `count`: how many NUL-ended records stdout held (nothing of them is kept). */
  records: number;
  /** U1: git wrote more than `maxOut`, so it was killed (`code` is null). */
  capped?: true;
}

/** SIGKILL to the call's process group (git leads it), only while git has not been reaped. */
function killGroup(p: Subprocess): void {
  if (p.exitCode !== null || p.signalCode !== null) return;
  try {
    process.kill(-p.pid, "SIGKILL");
  } catch {
    try {
      p.kill("SIGKILL");
    } catch {
      // gone
    }
  }
}

const running = new Set<Subprocess>();
let hooked = false;
function track(p: Subprocess): void {
  if (!hooked) {
    hooked = true;
    process.on("exit", () => {
      for (const q of running) killGroup(q);
    });
  }
  running.add(p);
}

export interface CallOptions {
  /** Prepended after the fixed flags: the filter drivers' empty commands (filterArgs). */
  config?: readonly string[];
  /** The deadline in ms (the git's `callMs` by default). */
  ms?: number;
  /** Count the NUL-ended records of stdout instead of keeping it (a status of many files). */
  count?: boolean;
  /** U1: the longest stdout kept (256 KiB by default); past it git is killed and the result says `capped`. */
  maxOut?: number;
  /** U1: git is killed when this aborts (a deleted chat's marks), and the call fails. */
  signal?: AbortSignal;
}

/** One call: `git <flags> <config> -C <cwd> <args>`, run in `cwd` too. */
export async function runWorktreeGit(g: WorktreeGit, cwd: string, args: readonly string[], o: CallOptions = {}): Promise<WorktreeGitResult> {
  if (!g.git) return { code: null, out: "", records: 0 };
  let proc: Subprocess<"ignore", "pipe", "ignore">;
  try {
    proc = Bun.spawn([g.git, ...WORKTREE_GIT_FLAGS, ...(o.config ?? []), "-C", cwd, ...args], {
      cwd,
      env: g.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      detached: true,
    });
  } catch {
    return { code: null, out: "", records: 0 };
  }
  track(proc);
  let failed = false;
  let capped = false;
  const kill = () => {
    failed = true;
    killGroup(proc);
  };
  const timer = setTimeout(kill, o.ms ?? g.callMs);
  if (o.signal?.aborted) kill();
  o.signal?.addEventListener("abort", kill, { once: true });
  const maxOut = o.maxOut ?? MAX_OUT;
  const parts: Uint8Array[] = [];
  let size = 0;
  let records = 0;
  const reader = proc.stdout.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (o.count) {
        for (const b of value) if (b === 0) records++;
        continue;
      }
      size += value.byteLength;
      if (size > maxOut) {
        capped = true;
        kill();
        break;
      }
      parts.push(value);
    }
  } catch {
    failed = true;
  } finally {
    await reader.cancel().catch(() => {});
  }
  const code = await proc.exited;
  clearTimeout(timer);
  o.signal?.removeEventListener("abort", kill);
  running.delete(proc);
  if (failed) return { code: null, out: "", records: 0, ...(capped ? { capped: true as const } : {}) };
  return { code, out: new TextDecoder().decode(Buffer.concat(parts)), records };
}

/** What the config that applies in a folder says, for configProblem and filterArgs. */
export interface RepoConfig {
  /** A key that could run a program or that cannot be passed back to git, so the repository gets no worktree. */
  refused: boolean;
  /** The names of the filter drivers that the config defines, in every scope. */
  filters: string[];
}

/** A filter name that `-c filter.<name>.<key>=` gives back to git as it is: no `=`, no line end, no NUL. */
const SAFE_FILTER_NAME = /^[^=\r\n\u0000]{1,200}$/;

/** The scopes that the repository itself writes: its `.git/config` and `config.worktree` (with what they include). */
const REPO_SCOPES = new Set(["local", "worktree"]);

/**
 * The config keys that apply in the folder `at` (a main checkout or a worktree), of every scope (the system's, the
 * user's, the repository's own, its `config.worktree` and the command's), with the files they include, read by name
 * only: never a value. Every filter driver's name is kept, so filterArgs turns each one off. Refused (as Claude Code
 * refuses them): an `includeIf`, `lfs.customtransfer.<name>.path` or `lfs.standalonetransferagent` that the repository
 * itself writes (in its `.git/config` or its `config.worktree`), and a filter name with `=` or a line end in any
 * scope. Null when the config cannot be read.
 */
export async function readRepoConfig(g: WorktreeGit, at: string): Promise<RepoConfig | null> {
  const r = await runWorktreeGit(g, at, ["config", "--includes", "--list", "--name-only", "--show-scope", "-z"]);
  if (r.code !== 0) return null;
  const filters = new Set<string>();
  let refused = false;
  // `--show-scope -z --name-only`: a scope and a name, each NUL-ended.
  const fields = r.out.split("\0");
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const scope = fields[i]!;
    const name = fields[i + 1]!;
    if (!name) continue;
    const lower = name.toLowerCase();
    const repo = REPO_SCOPES.has(scope);
    if (lower.startsWith("includeif.")) refused ||= repo;
    else if (lower === "lfs.standalonetransferagent") refused ||= repo;
    else if (lower.startsWith("lfs.customtransfer.") && lower.endsWith(".path")) refused ||= repo;
    else if (lower.startsWith("filter.")) {
      const last = name.lastIndexOf(".");
      const driver = last > "filter.".length ? name.slice("filter.".length, last) : "";
      if (!SAFE_FILTER_NAME.test(driver)) refused = true;
      else filters.add(driver);
    }
  }
  return { refused, filters: [...filters].sort() };
}

/** The `-c` pairs that turn each filter driver that readRepoConfig names off (empty commands, not required). */
export function filterArgs(filters: readonly string[]): string[] {
  const out: string[] = [];
  for (const f of filters) {
    if (!SAFE_FILTER_NAME.test(f)) continue;
    for (const key of ["smudge", "clean", "process"]) out.push("-c", `filter.${f}.${key}=`);
    out.push("-c", `filter.${f}.required=false`);
  }
  return out;
}
