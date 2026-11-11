// The restart's preflight (DESIGN.md 4.10; build checklist S8): before anything drains, the code on disk must be able
// to start. No update runs (row 108: the Update button's job, or bin/update.sh, which hold the update lock: mid-update
// the checkout and the build do not match yet); then two checks, in order: the build's stamp names the checkout's
// HEAD (a restart would otherwise run new server code with an old page, or the other way round), and a child
// `bun --no-env-file server/main.ts --check` with the server's own options exits 0; then no update runs again, because
// the check takes a while and bin/update.sh may have begun meanwhile (the server's own job starts none while a restart
// is asked: main.ts). The caller drains in the same tick. A failed preflight refuses the restart with one line and
// changes nothing.
//
// `--check` (main.ts) parses the options and runs the start-environment check like a start, has every server module
// loaded (main.ts imports them all before it runs), then checks the state folder read only (checkStart below: the
// store's own folder and mode check, which writes nothing), and the page it would serve, and binds nothing. Its lines
// go to logs/server-out.log, as the successor's would.
//
// An installed kitespan (DESIGN-I1 3.5), with T the root that the next start runs (kind.ts nextRoot): T's page and a
// stamp that reads (any head: a release's build has none), else "The update did not finish"; for T the running root,
// the server's own build folder's. Then the check of T's code, `bun --no-env-file T/server/main.ts --check` in T, with
// the server's own options but a --dist of the running root's own build folder (the next version serves its own).

import { closeSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { absolutePath } from "../search/git";
import { checkTree, ownUid } from "../store/files";
import { leftOpaque } from "../store/store";
import { gitHead, type GitOptions } from "./git";
import { openOutLog, ownOptions } from "./successor";
import { readStamp } from "./stamp";
import { UPDATE_WORDS } from "../../shared/update";
import { UPDATE_LINES } from "./updates";

export const PREFLIGHT_LIMITS = { checkMs: 30_000 } as const;

/** The refusals, one line each; the page names the file without its path. */
export const PREFLIGHT_LINES = {
  updating: UPDATE_WORDS.restartBusy,
  unfinished: UPDATE_LINES.unfinished,
  check: "The code on disk did not start, so kitespan did not restart. Its lines are in server-out.log.",
} as const;

/** True for a regular file, never through a link. */
function isFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * `--check`'s own part, after the options and the start environment: the state folder passes the store's checks (read
 * only; a folder that is not there yet is made by the start), and the page is there: the build folder's index.html,
 * or in dev mode web/index.html. Lines for the terminal; empty when the start can go on.
 */
export async function checkStart(o: { root: string; dist: string; dev: boolean; state: string }): Promise<string[]> {
  const out: string[] = [];
  try {
    const problems = await checkTree(o.state, ownUid(), leftOpaque);
    if (problems.length) {
      out.push(`the state folder ${o.state} failed its checks:`);
      for (const p of problems) out.push(`  ${p.path}: ${p.why}`);
    }
  } catch {
    out.push(`the state folder ${o.state} could not be read`);
  }
  const page = o.dev ? join(o.root, "web", "index.html") : join(o.dist, "index.html");
  if (!isFile(page)) out.push(`there is no page at ${page}`);
  return out;
}

export interface PreflightOptions {
  root: string;
  dist: string;
  dev: boolean;
  /** The server's argv after its script; its own options go to the check. */
  argv: readonly string[];
  cwd?: string;
  /** The server's environment as it was at start. */
  env: Readonly<Record<string, string | undefined>>;
  git: GitOptions;
  /** The state folder's logs/, where the check's lines go. */
  logs: string;
  /** The Bun that runs the check (default the one on the start PATH's absolute entries, else this one). */
  bun?: string;
  checkMs?: number;
  /** An update runs now (its job, or bin/update.sh); absent: none. */
  updating?: () => Promise<boolean>;
  /** A release or brew install: the root that the next start runs (null: it cannot be read). Absent: a checkout. */
  install?: { next: string | null };
}

/** S8: null when the code on disk can start; else the one line that says why the restart does not happen. */
export async function preflight(o: PreflightOptions): Promise<string | null> {
  if (await o.updating?.()) return PREFLIGHT_LINES.updating;
  let target = o.root;
  let dropDist: string | undefined;
  if (o.install) {
    const t = o.install.next;
    if (t === null) return PREFLIGHT_LINES.unfinished;
    const dist = t === o.root ? o.dist : join(t, "dist", "web");
    if (!o.dev && (!isFile(join(dist, "index.html")) || !readStamp(dist))) return PREFLIGHT_LINES.unfinished;
    target = t;
    dropDist = join(o.root, "dist", "web");
  } else if (!o.dev) {
    const stamp = readStamp(o.dist);
    const head = await gitHead(o.root, o.git);
    if (!stamp || stamp.head !== head) return PREFLIGHT_LINES.unfinished;
  }
  const { dev, options } = ownOptions(o.argv, o.cwd ?? process.cwd(), dropDist);
  const bun = o.bun ?? (Bun.which("bun", { PATH: absolutePath(o.env.PATH ?? "") }) || process.execPath);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.env)) if (v !== undefined) env[k] = v;
  let fd: number;
  try {
    fd = openOutLog(o.logs);
  } catch {
    return PREFLIGHT_LINES.check;
  }
  try {
    const proc = Bun.spawn([bun, "--no-env-file", join(target, "server", "main.ts"), "--check", ...(dev ? ["--dev"] : []), ...options], {
      cwd: target,
      env,
      stdin: "ignore",
      stdout: fd,
      stderr: fd,
    });
    const timer = setTimeout(() => proc.kill("SIGKILL"), o.checkMs ?? PREFLIGHT_LIMITS.checkMs);
    const code = await proc.exited;
    clearTimeout(timer);
    if (code !== 0) return PREFLIGHT_LINES.check;
  } catch {
    return PREFLIGHT_LINES.check;
  } finally {
    closeSync(fd);
  }
  return (await o.updating?.()) ? PREFLIGHT_LINES.updating : null;
}
