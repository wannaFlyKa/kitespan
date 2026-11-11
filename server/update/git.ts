// kitespan's own git reads for About's update lines (DESIGN.md 4.10; build checklist S3, S4): its checkout's HEAD, its
// branch's upstream, and origin's commit for that branch. Every call is a read with no input (stdin ignored, stderr
// dropped), a deadline that kills git, and the environment of the corpus code (server/search/git.ts gitEnv: every
// GIT_* variable that the server inherited taken out, no prompt, no lazy fetch, PATH with its absolute entries only),
// plus a password prompt that fails at once (GIT_ASKPASS and SSH_ASKPASS name a program that exits 1) and ssh in
// batch mode. git is found on the absolute PATH entries only.
//
// A read that passes its deadline ends with its whole process group: git runs in a group of its own, so its transport
// helpers (ssh; git's remote-http and git-remote-http) go with it and never keep a connection open after the read was
// given up. The helpers are bounded on their own side too: ssh gives up on a silent peer, and http on a stalled one.
//
// No program from a repository's config ever runs. The reads in the checkout (rev-parse, symbolic-ref, config,
// cat-file, merge-base) run no hook, filter, pager or helper, and run with the fsmonitor hook off. The one network
// read, ls-remote, runs outside the repository (GIT_DIR names /dev/null, which is no repository, so git reads no
// repository config at all: no url rewrite, no upload-pack program, no ssh command, no credential helper of the
// repository's), on the URL that the checkout's config names, with only the http, https, ssh, git and file
// transports allowed (no `ext::` or other remote helper).

import type { Subprocess } from "bun";
import { failingProgram, findGit, gitEnv } from "../search/git";

/** Before every subcommand: no optional locks (a read never writes the index), the fsmonitor hook off. */
export const GIT_FLAGS = ["--no-optional-locks", "-c", "core.fsmonitor=false"] as const;

/**
 * Before ls-remote: the transports it may use (every other one, ext:: or a remote helper, is refused by git), and an
 * http read that moves less than 1000 bytes a second for 10 s ends.
 */
export const REMOTE_FLAGS = [
  "-c",
  "protocol.allow=never",
  ...["http", "https", "ssh", "git", "file"].flatMap((p) => ["-c", `protocol.${p}.allow=always`]),
  "-c",
  "http.lowSpeedLimit=1000",
  "-c",
  "http.lowSpeedTime=10",
] as const;

/** ssh in batch mode (no prompt), and a peer that does not answer within 10 s, or goes silent for 5 s, ends it. */
export const UPDATE_SSH = "ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=1";

/** The longest stdout a read keeps; past it git is killed and the read fails. */
const MAX_OUT = 64 * 1024;

/** A program that fails at once, for the password prompts (server/search/git.ts). */
export { failingProgram };

/**
 * The GIT_* names that only choose which git config files apply (the user's own, or none): kept from the base, as the
 * user's git reads them. None of them can point git at another repository or name a program.
 */
export const GIT_CONFIG_PLACES = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"] as const;

/**
 * The environment of every update read and step: gitEnv's, with the password prompts failing and ssh in batch mode,
 * and the config file names of GIT_CONFIG_PLACES as the base has them.
 */
export function updateGitEnv(base: Readonly<Record<string, string | undefined>>, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const failing = failingProgram(base.PATH ?? "");
  const places: Record<string, string> = {};
  for (const k of GIT_CONFIG_PLACES) if (typeof base[k] === "string") places[k] = base[k]!;
  return gitEnv(base, { ...places, GIT_ASKPASS: failing, SSH_ASKPASS: failing, GIT_SSH_COMMAND: UPDATE_SSH, GCM_INTERACTIVE: "never", ...extra });
}

/** The user's own ssh and prompt settings that a fetch in their terminal keeps (terminalGitEnv). */
const TERMINAL_OWN = ["GIT_SSH_COMMAND", "GIT_SSH", "GIT_SSH_VARIANT", "GIT_ASKPASS", "GIT_TERMINAL_PROMPT"] as const;

/**
 * bin/update.sh in a terminal (row 108): the fetch as the user's own git runs it there, so it may ask on the terminal
 * for an ssh passphrase or a password, and the user's ssh command applies (GIT_SSH_COMMAND, or else core.sshCommand of
 * their config): updateGitEnv's environment without the failing prompts and the batch-mode ssh, with TERMINAL_OWN and
 * SSH_ASKPASS as the user set them. Every other GIT_* name stays out, as for every update read.
 */
export function terminalGitEnv(base: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const own: Record<string, string> = {};
  for (const k of [...GIT_CONFIG_PLACES, ...TERMINAL_OWN]) if (typeof base[k] === "string") own[k] = base[k]!;
  const env = gitEnv(base, own);
  if (own.GIT_TERMINAL_PROMPT === undefined) delete env.GIT_TERMINAL_PROMPT;
  return env;
}

export interface GitOptions {
  /** The git program (findGit's), or null: no read runs and each one fails. */
  git: string | null;
  /** updateGitEnv's result. */
  env: Record<string, string>;
  /** Each read's deadline, in ms (default 10 s). */
  timeoutMs?: number;
}

/** The git of a base environment: found on its absolute PATH entries, as the corpus code finds it. */
export function gitOptions(base: Readonly<Record<string, string | undefined>>, extra: Readonly<Record<string, string>> = {}, timeoutMs?: number): GitOptions {
  return { git: findGit(base.PATH ?? ""), env: updateGitEnv(base, extra), timeoutMs };
}

export interface GitResult {
  /** git's exit code; null when it did not start, was killed at the deadline, or wrote more than MAX_OUT. */
  code: number | null;
  out: string;
}

/**
 * SIGKILL to the read's process group (git leads it: it was spawned detached), so its helpers go too. Only while git
 * has not been reaped: until then its pid, and the group of that id, cannot name another process. A program in this
 * process's own group (bin/update.sh's fetch in a terminal) leads none, so no group has its id: it alone gets it.
 */
export function killGroup(p: Subprocess): void {
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

/** The reads (and an update's steps) that run now, killed with their helpers when the server exits, so none outlives it. */
const running = new Set<Subprocess>();
let hooked = false;
export function track(p: Subprocess): void {
  if (!hooked) {
    hooked = true;
    process.on("exit", () => {
      for (const q of running) killGroup(q);
    });
  }
  running.add(p);
}
export function untrack(p: Subprocess): void {
  running.delete(p);
}

/** One read: `git <GIT_FLAGS> <args>` in `cwd`; `env` replaces the options' environment when given. */
export async function runGit(o: GitOptions, cwd: string, args: readonly string[], env?: Record<string, string>): Promise<GitResult> {
  if (!o.git) return { code: null, out: "" };
  let proc: Subprocess<"ignore", "pipe", "ignore">;
  try {
    proc = Bun.spawn([o.git, ...GIT_FLAGS, ...args], { cwd, env: env ?? o.env, stdin: "ignore", stdout: "pipe", stderr: "ignore", detached: true });
  } catch {
    return { code: null, out: "" };
  }
  track(proc);
  let failed = false;
  const kill = () => {
    failed = true;
    killGroup(proc);
  };
  const timer = setTimeout(kill, o.timeoutMs ?? 10_000);
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of proc.stdout) {
      size += chunk.byteLength;
      if (size > MAX_OUT) {
        kill();
        break;
      }
      parts.push(chunk);
    }
  } catch {
    failed = true;
  }
  const code = await proc.exited;
  clearTimeout(timer);
  running.delete(proc);
  return { code: failed ? null : code, out: failed ? "" : new TextDecoder().decode(Buffer.concat(parts)) };
}

/** A full commit id: 40 hex digits (SHA-1) or 64 (SHA-256). */
export const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The checkout's HEAD commit, or null (not a git checkout, no commit yet, no git, or a failed read). */
export async function gitHead(root: string, o: GitOptions): Promise<string | null> {
  const r = await runGit(o, root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const head = r.out.trim();
  return r.code === 0 && COMMIT_ID.test(head) ? head : null;
}
