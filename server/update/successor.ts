// The restart's successor (DESIGN.md 4.10 step 4; build checklist S12, L12, L13): bin/kitespan with the server's own
// options plus `--bind-wait 10` (an option, never a variable: "kitespan adds no variable of its own"), detached into
// its own session (it outlives this server and any hangup of its terminal), standard input ignored, standard output
// and error to logs/server-out.log in the state folder (0600, a new file at each restart): the lines a terminal would
// show, which the health gate's failure needs and a phone has no other way to read. Its environment is the server's
// own as it was at start (the SDK writes a variable of its own into process.env at each chat start), which bin/kitespan
// cleans again. It runs in the repository root, so Bun reads no bunfig.toml of another folder.
//
// An installed kitespan (DESIGN-I1 3.5): the successor is the next start's root (kind.ts nextRoot, as the preflight read
// it), its own bin/kitespan in its own folder, and a --dist that names the running root's own build folder is left out,
// so the next version serves its own page.

import { closeSync, constants, openSync, realpathSync, unlinkSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/** The successor's lines (and the preflight's), in the state folder's logs/. */
export const OUT_LOG = "server-out.log";

/** How long the successor retries to bind the port that the old server releases, in seconds. */
export const BIND_WAIT_S = 10;

/** The options that are the restart's own, never the server's: the port wait and the preflight's check. */
const OWN_VALUE_OPTIONS = new Set(["--bind-wait"]);
const OWN_FLAGS = new Set(["--check"]);

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The server's own options from its argv (process.argv.slice(2), which its parser accepted): without the restart's
 * own, `--dev` taken out (bin/kitespan says `dev` as its first word), and a relative `--dist` made absolute against
 * the server's working folder `cwd`. `dropDist` (an installed kitespan: the running root's dist/web): a --dist that
 * names that folder is left out.
 */
export function ownOptions(argv: readonly string[], cwd: string, dropDist?: string): { dev: boolean; options: string[] } {
  const options: string[] = [];
  let dev = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dev") dev = true;
    else if (OWN_FLAGS.has(a)) continue;
    else if (OWN_VALUE_OPTIONS.has(a)) i++;
    else if (a === "--dist" && i + 1 < argv.length) {
      const v = argv[++i]!;
      const abs = isAbsolute(v) ? v : resolve(cwd, v);
      if (dropDist !== undefined && (abs === dropDist || real(abs) === real(dropDist))) continue;
      options.push(a, abs);
    } else options.push(a);
  }
  return { dev, options };
}

/** The successor's command line: bin/kitespan, `dev` in dev mode, the server's own options, then the port wait. */
export function successorArgv(root: string, argv: readonly string[], cwd: string, script = join(root, "bin", "kitespan"), dropDist?: string): string[] {
  const { dev, options } = ownOptions(argv, cwd, dropDist);
  return [script, ...(dev ? ["dev"] : []), ...options, "--bind-wait", String(BIND_WAIT_S)];
}

/**
 * logs/server-out.log, new: the old file goes first (a link in its place goes, never its target), then the new one is
 * made with O_EXCL and no link followed, mode 0600. Returns its descriptor, which the caller closes after the spawn.
 */
export function openOutLog(logs: string): number {
  const file = join(logs, OUT_LOG);
  try {
    unlinkSync(file);
  } catch {
    // none yet
  }
  return openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
}

export interface SuccessorOptions {
  /** The repository root (bin/kitespan is under it). */
  root: string;
  /** The server's argv after its script (process.argv.slice(2)). */
  argv: readonly string[];
  /** The server's working folder, for a relative --dist (default process.cwd()). */
  cwd?: string;
  /** The server's environment as it was at start. */
  env: Readonly<Record<string, string | undefined>>;
  /** The state folder's logs/. */
  logs: string;
  /** The start script (tests); default bin/kitespan under `root`. */
  script?: string;
  /** An installed kitespan: the running root's dist/web, which a --dist of the successor never names (ownOptions). */
  dropDist?: string;
}

export interface Successor {
  pid: number;
  /** The successor's exit, for the health gate (it may never come: a good successor runs on). */
  exited: Promise<number>;
  kill(): void;
}

/** S12: start the successor. Throws when it cannot start (the caller then undoes the drain). */
export function spawnSuccessor(o: SuccessorOptions): Successor {
  const cmd = successorArgv(o.root, o.argv, o.cwd ?? process.cwd(), o.script, o.dropDist);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.env)) if (v !== undefined) env[k] = v;
  const fd = openOutLog(o.logs);
  try {
    const proc = Bun.spawn(cmd, { cwd: o.root, env, detached: true, stdin: "ignore", stdout: fd, stderr: fd });
    proc.unref();
    let reaped = false;
    void proc.exited.then(() => (reaped = true));
    return {
      pid: proc.pid,
      exited: proc.exited,
      // Its own process group (detached: the successor leads it), so a child it started goes too. Only while the
      // successor has not been reaped: until then its pid, and the group of that id, cannot name another process.
      kill: () => {
        if (reaped || proc.exitCode !== null || proc.signalCode !== null) return;
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {
          try {
            proc.kill("SIGKILL");
          } catch {
            // gone
          }
        }
      },
    };
  } finally {
    closeSync(fd);
  }
}
