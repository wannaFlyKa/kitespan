// bin/update.sh's body (DESIGN.md 4.10, owner row 108): the same update as Settings > About > Update, through the same
// source (source.ts), so its rules live once. It refuses with one line (a checkout with local changes, one that is not
// a git checkout or has no upstream, one that has diverged from origin), takes the update lock (lock.ts; the server's
// job takes it too, so the two never run at once), then runs the three steps with their output on this terminal, and
// stops at the first one that fails and names it. After a build its last line says how to apply it. It never
// restarts kitespan. Ctrl+C ends the running step's process group, and gives the lock back. In a terminal its fetch is
// the user's own git there, as `git pull` was: their ssh command (GIT_SSH_COMMAND or core.sshCommand), and a prompt
// for an ssh passphrase or a password on the terminal (git.ts terminalGitEnv).
//
// An installed kitespan (DESIGN-I1 3.7; server/update/kind.ts): a release install runs the same release source as its
// Update button (release.ts: its own install.sh, whose lines are the progress here, and which names the step that
// failed), and says how to apply it with the `kitespan` command; a Homebrew install refuses with the line that names
// `brew upgrade kitespan`.
//
// Usage: bin/update.sh [--dist <build folder>]   (the server's --dist, when it names one)

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { UPDATE_REFUSAL_LINES, UPDATE_STEP_COMMANDS, UPDATE_STEPS } from "../../shared/update";
import { storeDirs } from "../store/store";
import { gitOptions, terminalGitEnv } from "./git";
import { installKind, versionAt } from "./kind";
import { takeLock } from "./lock";
import { releaseChecker, releaseSource } from "./release";
import { gitCheckoutSource } from "./source";

const ROOT = resolve(import.meta.dir, "..", "..");
export const UPDATE_DONE = "Restart kitespan to apply it: Settings > About > Restart, or bin/kitespan restart.";
/** A release install's last line: its command is `kitespan` (~/.local/bin/kitespan). */
export const RELEASE_DONE = "Restart kitespan to apply it: Settings > About > Restart, or kitespan restart.";

const say = (line: string) => process.stdout.write(`${line}\n`);
const complain = (line: string) => process.stderr.write(`update.sh: ${line}\n`);

function parse(argv: readonly string[], root: string): { dist: string } | string {
  let dist = join(root, "dist", "web");
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dist") {
      const v = argv[++i];
      if (v === undefined) return "--dist needs a value";
      dist = isAbsolute(v) ? v : resolve(v);
    } else return `unknown option ${a}`;
  }
  return { dist };
}

/** bin/update.sh of the kitespan in `root`, with `env` (a copy of the script's environment): its exit code. */
export async function runUpdate(root: string, argv: readonly string[], env: Record<string, string | undefined>): Promise<number> {
  const args = parse(argv, root);
  if (typeof args === "string") {
    complain(`${args} (usage: bin/update.sh [--dist <build folder>])`);
    return 2;
  }
  let real = root;
  try {
    real = realpathSync(root);
  } catch {
    // the checkout's rules say what is wrong
  }
  const install = installKind(real, versionAt(real));
  if (install.kind === "brew") {
    complain(UPDATE_REFUSAL_LINES.brew);
    return 1;
  }
  const release = install.kind === "release";
  const terminal = process.stdin.isTTY === true ? { env: terminalGitEnv(env) } : undefined;
  const source =
    install.kind === "release"
      ? releaseSource({ install, dist: args.dist, dev: false, env, checker: releaseChecker({ install, env }) })
      : gitCheckoutSource({ root, dist: args.dist, dev: false, git: gitOptions(env), env, terminal });
  const why = await source.refusal();
  if (why) {
    complain(UPDATE_REFUSAL_LINES[why]);
    return 1;
  }
  const lock = await takeLock(storeDirs(env, homedir()).state).catch(() => null);
  if (!lock) {
    complain(UPDATE_REFUSAL_LINES.busy);
    return 1;
  }
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
  try {
    const r = await source.apply({ onStep: () => {}, output: "inherit", signal: abort.signal, onSpawn: (pid, ms) => lock.step(pid, ms) });
    if (!r.ok) {
      if (r.refusal) complain(UPDATE_REFUSAL_LINES[r.refusal]);
      // install.sh named the step that failed on this terminal already.
      if (!release) complain(`step ${UPDATE_STEPS.indexOf(r.step) + 1} of ${UPDATE_STEPS.length} failed: ${UPDATE_STEP_COMMANDS[r.step]}${r.timeout ? " (it took too long)" : ""}`);
      else if (r.timeout) complain("install.sh took too long, so it was stopped.");
      return abort.signal.aborted ? 130 : 1;
    }
    say(release ? RELEASE_DONE : UPDATE_DONE);
    return 0;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    process.off("SIGHUP", stop);
    await lock.release();
  }
}

// A copy: no server code holds process.env itself (test/gate/process-env.test.ts).
if (import.meta.main) process.exit(await runUpdate(ROOT, process.argv.slice(2), { ...process.env }));
