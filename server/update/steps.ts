// The update's step runner (DESIGN.md 4.10, owner row 108): each program of a step runs as a child in a process group
// of its own (detached: it leads the group), with stdin ignored and a deadline that sends SIGKILL to the whole group,
// so a helper that git or Bun started (ssh, git's http helper, a package's install script) never outlives the step. A
// step that the server runs writes its output to logs/update.log (a new 0600 file each run, never through a link),
// with the user:password part of every URL taken out and at most UPDATE_LIMITS.logBytes in all; the page shows only
// the step's name. bin/update.sh's steps write to its own terminal instead, as before, and its fetch runs in the
// terminal's foreground with the terminal's stdin (`foreground`), so ssh or git can ask the user there: a group of its
// own could not read the terminal. Its deadline then ends that program alone (Ctrl+C reaches the whole foreground).
//
// The build goes into a folder beside the build folder (`<dist>.next`), and only a build that finished with its page
// and its stamp takes the build folder's place, by rename: a running server serves the page it read at its start
// (server/http/static.ts), and a build that fails, or is cut, leaves the build folder as it was, so a fresh start
// still has a page.

import type { Subprocess } from "bun";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { killGroup, track, untrack } from "./git";
import { readStamp } from "./stamp";

export const UPDATE_LIMITS = {
  /** The fetch and the fast-forward together. */
  fetchMs: 2 * 60_000,
  /** The locked install (a cold cache over a slow link takes long). */
  installMs: 10 * 60_000,
  buildMs: 2 * 60_000,
  /** logs/update.log, at most. */
  logBytes: 1024 * 1024,
} as const;

/** The update's own log in the state folder's logs/. */
export const UPDATE_LOG = "update.log";

/** Where a step's output goes: a line sink (the server's log), or this process's own standard output and error. */
export type StepOutput = { line(text: string): void } | "inherit";

export interface StepResult {
  /** The program's exit code; null when it did not start, or was killed. */
  code: number | null;
  /** The deadline passed (the group was killed). */
  timeout: boolean;
  /** The step was called off (a shutdown, or bin/update.sh's Ctrl+C): the group was killed. */
  aborted: boolean;
}

/** `scheme://user:password@host` and `scheme://token@host` with the credentials taken out. */
export function redact(line: string): string {
  return line.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@");
}

/** Every C0 control character but tab, and DEL: a log line holds none (a terminal's progress redraws included). */
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** Split a stream into lines for `sink`, a partial last line at the end too. */
async function pipeLines(stream: ReadableStream<Uint8Array>, sink: (line: string) => void): Promise<void> {
  const dec = new TextDecoder();
  let rest = "";
  for await (const chunk of stream) {
    rest += dec.decode(chunk, { stream: true });
    // A progress line rewrites itself with carriage returns; each of its states is a line here.
    const parts = rest.split(/\r\n|\n|\r/);
    rest = parts.pop() ?? "";
    for (const p of parts) sink(p);
  }
  rest += dec.decode();
  if (rest) sink(rest);
}

/**
 * One program of a step: `cmd` in `cwd` with `env`, until it exits, its deadline passes or `signal` aborts it.
 * `onSpawn` gets its pid (its group's id) and its deadline as it starts (the update lock records them, lock.ts).
 * `foreground`: in this process's group, with its stdin (bin/update.sh's fetch in a terminal).
 */
export async function runStep(
  cmd: readonly string[],
  o: { cwd: string; env: Record<string, string>; timeoutMs: number; output: StepOutput; signal?: AbortSignal; onSpawn?: (pid: number, timeoutMs: number) => void | Promise<void>; foreground?: boolean },
): Promise<StepResult> {
  if (o.signal?.aborted) return { code: null, timeout: false, aborted: true };
  let proc: Subprocess;
  const inherit = o.output === "inherit";
  const fg = o.foreground === true;
  try {
    proc = Bun.spawn([...cmd], { cwd: o.cwd, env: o.env, stdin: fg ? "inherit" : "ignore", stdout: inherit ? "inherit" : "pipe", stderr: inherit ? "inherit" : "pipe", detached: !fg });
  } catch {
    return { code: null, timeout: false, aborted: false };
  }
  track(proc);
  const record = o.onSpawn;
  if (record) {
    const pid = proc.pid;
    void Promise.resolve()
      .then(() => record(pid, o.timeoutMs))
      .catch(() => {});
  }
  let timeout = false;
  let aborted = false;
  const timer = setTimeout(() => {
    timeout = true;
    killGroup(proc);
  }, o.timeoutMs);
  const onAbort = () => {
    aborted = true;
    killGroup(proc);
  };
  o.signal?.addEventListener("abort", onAbort, { once: true });
  const reads: Promise<void>[] = [];
  if (!inherit) {
    const sink = (o.output as { line(text: string): void }).line;
    for (const s of [proc.stdout, proc.stderr]) if (s && typeof s !== "number") reads.push(pipeLines(s as ReadableStream<Uint8Array>, sink).catch(() => {}));
  }
  const code = await proc.exited;
  clearTimeout(timer);
  o.signal?.removeEventListener("abort", onAbort);
  // The group's other members may hold the pipes open; they went with the deadline's kill, else they end with them.
  await Promise.race([Promise.all(reads), Bun.sleep(2_000)]);
  untrack(proc);
  return { code: timeout || aborted ? null : code, timeout, aborted };
}

/**
 * logs/update.log, new: the old file goes first (a link in its place goes, never its target), then the new one is
 * made with O_EXCL and no link followed, mode 0600. Each line is redacted and has no control character; past
 * UPDATE_LIMITS.logBytes one last line says the rest was left out. A write that fails is dropped (the update goes on).
 */
export function openUpdateLog(logs: string, maxBytes: number = UPDATE_LIMITS.logBytes): { line(text: string): void; close(): void } {
  const file = join(logs, UPDATE_LOG);
  try {
    unlinkSync(file);
  } catch {
    // none yet
  }
  let fd: number | null = null;
  try {
    fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch {
    fd = null;
  }
  let bytes = 0;
  let full = false;
  const write = (text: string) => {
    if (fd === null) return;
    try {
      writeSync(fd, text);
    } catch {
      // the update goes on without its log
    }
  };
  return {
    line(text) {
      if (full) return;
      const clean = `${redact(text).replace(CONTROLS, "")}\n`;
      const size = Buffer.byteLength(clean);
      if (bytes + size > maxBytes) {
        full = true;
        write("(the rest of the output was left out)\n");
        return;
      }
      bytes += size;
      write(clean);
    },
    close() {
      if (fd !== null) closeSync(fd);
      fd = null;
    },
  };
}

/**
 * Remove a flat build folder: its regular files and links (never a link's target), then the folder itself; a missing
 * one is fine. A folder inside it is never entered, so the folder stays (rmdir throws) when it holds one.
 */
export function clearFlat(dir: string): void {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return;
  }
  if (!st.isDirectory()) {
    unlinkSync(dir);
    return;
  }
  for (const name of readdirSync(dir)) {
    const f = join(dir, name);
    if (!lstatSync(f).isDirectory()) unlinkSync(f);
  }
  rmdirSync(dir);
}

/** The folder a build writes into before it takes the build folder's place. */
export function nextDist(dist: string): string {
  return `${dist}.next`;
}

/**
 * The finished build in `next` takes the place of `dist`: only with its page and a stamp that names `head`. `dist`
 * goes to `<dist>.old` first and comes back when the second rename fails; the old build is then removed. Returns
 * false (and changes nothing in `dist`) when the build in `next` is not whole.
 */
export function swapBuild(dist: string, next: string, head: string | null): boolean {
  let page;
  try {
    page = lstatSync(join(next, "index.html"));
  } catch {
    return false;
  }
  const stamp = readStamp(next);
  if (!page.isFile() || !stamp || stamp.head !== head) return false;
  const old = `${dist}.old`;
  clearFlat(old);
  mkdirSync(dirname(dist), { recursive: true });
  const had = existsSync(dist) || isLink(dist);
  if (had) renameSync(dist, old);
  try {
    renameSync(next, dist);
  } catch (e) {
    if (had) renameSync(old, dist);
    throw e;
  }
  try {
    clearFlat(old);
  } catch {
    // an old build left beside the new one is harmless; the next update removes it
  }
  return true;
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
