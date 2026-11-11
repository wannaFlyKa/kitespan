// Where an update comes from (DESIGN.md 4.10, owner row 108): one small interface, so a release that installs from a
// package can add a source of its own without a change to the job, the routes or the page. The first source is this
// git checkout, and both the Update button and bin/update.sh run it (server/update/job.ts and cli.ts), so the rules
// live here once:
//
// - Refusals, each with one line (shared/update.ts): dev mode; no git; kitespan's folder is not the top of a git
//   checkout; HEAD on no branch; no upstream; an origin URL that kitespan does not read (remote.ts); local changes
//   (`git status`: a tracked change, or an untracked file that is not ignored); after the fetch, a checkout that has
//   diverged from origin.
// - Step 1, fetch: `git fetch` of the branch's upstream (the protocol allow-list, the stall limits, no prompt, ssh in
//   batch mode, git.ts; in bin/update.sh in a terminal, the user's own ssh command and prompts there), then `git merge --ff-only --no-overwrite-ignore` to the fetched commit when HEAD is behind it
//   (an ignored file of the user's that origin starts to track stops it, never overwritten). Neither runs a hook
//   (core.hooksPath=/dev/null) or the fsmonitor, and the fetch names its upload-pack program itself, so no program of
//   the repository's config runs on a press from a phone.
// - Step 2, install: `bun install --frozen-lockfile --omit=optional` (the lockfile decides every version; the SDK's
//   optional platform packages are never installed, 4.7).
// - Step 3, build: `bun run build --out <dist>.next`, then the swap (steps.ts): the running server keeps its page.
//
// git and Bun reach the network on purpose, so they keep the start environment's proxy variables (the server's
// loopback calls never use a proxy: loopback.ts). A step ends at its deadline with its whole process group.

import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { UpdateRefusal, UpdateStep } from "../../shared/update";
import { absolutePath } from "../search/git";
import { checkRemote, isAncestor, readUpstream, type RemoteCheck } from "./remote";
import { COMMIT_ID, GIT_FLAGS, REMOTE_FLAGS, gitHead, runGit, type GitOptions } from "./git";
import { clearFlat, nextDist, runStep, swapBuild, UPDATE_LIMITS, type StepOutput, type StepResult } from "./steps";

export type ApplyResult = { ok: true; head: string | null } | { ok: false; step: UpdateStep; refusal?: UpdateRefusal; timeout?: boolean };

export interface ApplyOptions {
  /** Before each step. */
  onStep(step: UpdateStep): void;
  output: StepOutput;
  /** Calls the steps off (a shutdown; Ctrl+C in bin/update.sh): the running step's group is killed. */
  signal?: AbortSignal;
  /** Each step's program as it starts: its group leader and its deadline (the update lock records them, lock.ts). */
  onSpawn?: (pid: number, timeoutMs: number) => void | Promise<void>;
}

export interface UpdateSource {
  /** "Update available": the check, read only. */
  check(): Promise<RemoteCheck>;
  /** Why an update cannot start now, or null when it can. */
  refusal(): Promise<UpdateRefusal | null>;
  /** The steps, in order; the first that fails ends them. */
  apply(o: ApplyOptions): Promise<ApplyResult>;
}

export interface CheckoutOptions {
  /** The checkout's top folder (kitespan's repository root). */
  root: string;
  /** The build folder (dist/web by default; the server's --dist). */
  dist: string;
  /** Dev mode serves web/ itself: no update. */
  dev: boolean;
  /** git, with updateGitEnv's environment (gitOptions). */
  git: GitOptions;
  /** The environment for Bun's install and build (the start environment: the proxy variables stay). */
  env: Readonly<Record<string, string | undefined>>;
  /** The Bun that installs and builds; default the one on the environment's absolute PATH entries, else this one. */
  bun?: string;
  /**
   * bin/update.sh in a terminal: the fetch runs with this environment (git.ts terminalGitEnv: the user's own ssh
   * command and prompts), in the terminal's foreground with its stdin, so ssh or git may ask the user there. Absent
   * (the Update button, a script with no terminal): no prompt, ssh in batch mode, a process group of its own.
   */
  terminal?: { env: Record<string, string> };
  limits?: Partial<typeof UPDATE_LIMITS>;
}

function plain(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

/** This git checkout as the update's source. */
export function gitCheckoutSource(o: CheckoutOptions): UpdateSource {
  const lim = { ...UPDATE_LIMITS, ...o.limits };
  const bun = o.bun ?? (Bun.which("bun", { PATH: absolutePath(o.env.PATH ?? "") }) || process.execPath);
  const root = (() => {
    try {
      return realpathSync(o.root);
    } catch {
      return o.root;
    }
  })();
  const git = (args: readonly string[]) => runGit(o.git, root, args);
  /** A program of a step, in the checkout. */
  const step = (cmd: readonly string[], env: Record<string, string>, timeoutMs: number, a: ApplyOptions, foreground = false): Promise<StepResult> =>
    runStep(cmd, { cwd: root, env, timeoutMs, output: a.output, signal: a.signal, onSpawn: a.onSpawn, foreground });
  /** git for a step: no hook, no fsmonitor, no optional lock. */
  const gitStep = (args: readonly string[]) => [o.git.git!, ...GIT_FLAGS, "-c", "core.hooksPath=/dev/null", ...args];

  async function refusal(): Promise<UpdateRefusal | null> {
    if (o.dev) return "dev";
    const up = await readUpstream(root, o.git);
    if ("why" in up) return up.why;
    // Tracked changes and untracked files that are not ignored; submodules too.
    const st = await git(["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=none"]);
    if (st.code !== 0) return "unreadable";
    return st.out.length > 0 ? "local_changes" : null;
  }

  async function apply(a: ApplyOptions): Promise<ApplyResult> {
    const failed = (s: UpdateStep, r?: StepResult, refused?: UpdateRefusal): ApplyResult => ({ ok: false, step: s, ...(refused ? { refusal: refused } : {}), ...(r?.timeout ? { timeout: true } : {}) });

    // 1. fetch, then the fast-forward.
    a.onStep("fetch");
    const up = await readUpstream(root, o.git);
    if ("why" in up) return failed("fetch", undefined, up.why);
    const fetchEnd = Date.now() + lim.fetchMs;
    const left = () => Math.max(1_000, fetchEnd - Date.now());
    const fetched = await step(gitStep([...REMOTE_FLAGS, "fetch", "--no-tags", "--no-recurse-submodules", "--upload-pack=git-upload-pack", "--", up.remote, up.merge]), o.terminal?.env ?? o.git.env, left(), a, !!o.terminal);
    if (fetched.code !== 0) return failed("fetch", fetched);
    const target = (await git(["rev-parse", "--verify", "--quiet", "FETCH_HEAD^{commit}"])).out.trim();
    if (!COMMIT_ID.test(target)) return failed("fetch");
    const behind = await isAncestor(root, o.git, "HEAD", target);
    if (behind === null) return failed("fetch");
    if (!behind) {
      // origin's commit is in HEAD already (nothing to merge), or the two have diverged.
      const ahead = await isAncestor(root, o.git, target, "HEAD");
      if (ahead === null) return failed("fetch");
      if (!ahead) return failed("fetch", undefined, "diverged");
    } else {
      // An ignored file of the user's (.env, a local settings file) that origin starts to track stops the merge (git
      // names it in the log), never overwritten: `git status` above lists no ignored file.
      const merged = await step(gitStep(["merge", "--ff-only", "--no-overwrite-ignore", "--no-edit", "--quiet", target]), o.git.env, left(), a);
      if (merged.code !== 0) return failed("fetch", merged);
    }

    // 2. The locked install.
    a.onStep("install");
    const env = plain(o.env);
    const installed = await step([bun, "install", "--frozen-lockfile", "--omit=optional"], env, lim.installMs, a);
    if (installed.code !== 0) return failed("install", installed);

    // 3. The build, beside the build folder; then it takes the folder's place.
    a.onStep("build");
    const next = nextDist(o.dist);
    const built = await step([bun, "run", `--cwd=${root}`, "build", "--out", next], env, lim.buildMs, a);
    const head = await gitHead(root, o.git);
    let swapped = false;
    if (built.code === 0) {
      try {
        swapped = swapBuild(o.dist, next, head);
      } catch {
        swapped = false;
      }
    }
    if (!swapped) {
      try {
        clearFlat(next);
      } catch {
        // a folder left beside the build folder; the next build clears it
      }
      return failed("build", built);
    }
    return { ok: true, head };
  }

  return { check: () => checkRemote(root, o.git), refusal, apply };
}

/** The build folder of a checkout when the server names none: dist/web under its root. */
export function defaultDist(root: string): string {
  return join(root, "dist", "web");
}
