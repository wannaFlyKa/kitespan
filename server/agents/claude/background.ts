// R131 (owner row 131; DESIGN-R131 9.4 and 9.7): Claude Code's background sessions, from the Claude driver's side. Two
// of Claude Code's own scripting commands, and nothing else of its background service:
//
// - `claude agents --json --all`, "the supported way to read session state from outside Claude Code" (the agent-view
//   docs), for the state that a session's record cannot say (done, failed, stopped);
// - `claude stop <id>`, after the user's own press in kitespan's confirm.
//
// Each runs the pinned binary with an argv array (never one string: a wrong argument would become a prompt and a model
// turn), in the home folder (no project's settings), with the clean start environment (no chat's variables, nothing
// kitespan or the SDK adds), in its own process group, with a timeout that ends the group only while the binary is not
// reaped (readVersion's rule), and with a capped output. The list keeps only the rows whose id a chat's book holds:
// every other row (other folders' sessions, the user's other sessions, interactive ones) is dropped before anything
// else is done, and never kept, sent or logged. One list run at a time; its answer is kept about 5 s. Both run only on a
// Claude Code that is known to pick out both verbs before its root command parses (2.1.296 or later): on a CLI without
// that, `stop <id>` would fall through to the root command, where it is a prompt, and with a piped stdout a print-mode
// model turn. Nothing here opens the daemon's files, keys or sockets, a job's state file, or any `.key` file.
//
// And the session's permission mode: the SDK's reader drops a transcript's `permission-mode` records, so a narrow read
// takes the last 64 KiB of the one transcript file of a session that the chat named (opened read-only, never through a
// link) and the last such record in it.

import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { bgName } from "../../../shared/background";
import { isBgId, isUuid } from "../../../shared/ids";
import { MODE_IDS, type BgStopAnswer, type ModeId } from "../../../shared/protocol";
import type { BgList, BgListRow, BgListState } from "../types";
import { bgFolderOf, bgStatusOf, bgWaitOf } from "./running";

/**
 * The oldest Claude Code checked to have both commands (the lead read 2.1.296, 2.1.311, 2.1.317 and 2.1.318 with grep
 * on their binaries): `stop` is one of the background-session verbs that it picks out before commander parses anything
 * (`e==="logs"||e==="attach"||e==="stop"||...`, then `backgroundSessionVerbIndex`), and `claude agents --json` prints
 * `printAgentsJson`'s rows. Agent view came in 2.1.139, but the docs never say when `claude stop` came, and on a CLI
 * without that verb `stop <id>` is the root command's prompt (a model turn, the lead's slip in row 131). An older
 * version may be added here only once its binary is checked the same way.
 */
export const AGENT_VIEW_SINCE = "2.1.296";

/**
 * The oldest Claude Code that kitespan supports (rows 118 (3), 119): AGENT_VIEW_SINCE, the highest version that a
 * kitespan feature is known to need; the pinned SDK names no higher floor for a key that kitespan passes. Compared on
 * the first three numbers. Below it, Settings > Claude Code, the new-chat form and the start output say so in one
 * line; a chat never waits on it. At each SDK bump, its sdk.d.ts "Requires Claude Code" notes may move it.
 */
export const CLAUDE_CODE_MINIMUM = "2.1.296";

/**
 * Whether a Claude Code version (its `--version` line, or the part of it that a company's build prints) is `floor` or
 * later, on the first three numbers only (row 119); null when the version has no three numbers to read.
 */
export function atLeast(version: string | null, floor: string): boolean | null {
  const m = typeof version === "string" ? /(\d+)\.(\d+)\.(\d+)/.exec(version) : null;
  if (!m) return null;
  const want = floor.split(".").map(Number);
  const got = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) if (got[i] !== want[i]) return got[i]! > want[i]!;
  return true;
}

export const BG_CLI = {
  /** `claude agents --json --all` may take this long (the lead measured about 190 ms on the owner's host). */
  agentsTimeoutMs: 10_000,
  /** `claude stop <id>` may take this long (a starting point; the lead's live file tunes it). */
  stopTimeoutMs: 20_000,
  /** A run's standard output at most; over it, the run failed and nothing of it is read. */
  stdoutBytes: 4 * 1024 * 1024,
  /** A stop's standard error at most (only to know "No job matching '"; never kept or logged). */
  stderrBytes: 4 * 1024,
  /** How long a list's answer is kept. */
  cacheMs: 5_000,
  /** The tail of a transcript that the permission-mode read takes. */
  modeTailBytes: 64 * 1024,
} as const;
export type BgCliLimits = { -readonly [K in keyof typeof BG_CLI]: number };

const LIST_STATES: readonly BgListState[] = ["working", "blocked", "done", "failed", "stopped"];

/** True for a Claude Code version (its `--version` line) of AGENT_VIEW_SINCE or later; false when it cannot be read. */
export function hasAgentView(version: string | null): boolean {
  return atLeast(version, AGENT_VIEW_SINCE) === true;
}

/** How one run of the user's claude ended. `failed`: it could not start. */
export interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  capped: boolean;
  failed: boolean;
}

export interface CliOptions {
  timeoutMs: number;
  stdoutBytes: number;
  /** 0: standard error is not read at all. */
  stderrBytes: number;
  env: Record<string, string>;
  cwd: string;
}

/**
 * One run of `argv` (the pinned binary first): its own process group; the timeout, or an output over its cap, ends the
 * group while the binary is not reaped (until then its pid, and the group of that id, cannot name another process), and
 * then the run answers at once, also if a child still holds a pipe. Never throws.
 */
export async function runCli(argv: readonly string[], o: CliOptions): Promise<CliRun> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe" | "ignore">;
  try {
    proc = Bun.spawn([...argv], { cwd: o.cwd, env: o.env, stdin: "ignore", stdout: "pipe", stderr: o.stderrBytes > 0 ? "pipe" : "ignore", detached: true });
  } catch {
    return { code: null, stdout: "", stderr: "", timedOut: false, capped: false, failed: true };
  }
  let timedOut = false;
  let capped = false;
  const endGroup = () => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {}
  };
  const readers: { cancel(): Promise<void> }[] = [];
  const read = async (stream: ReadableStream<Uint8Array>, cap: number, over: () => void): Promise<string> => {
    const reader = stream.getReader();
    readers.push(reader);
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (size + value.byteLength > cap) {
          over();
          continue; // keep draining, so the writer is never blocked while its group ends
        }
        size += value.byteLength;
        parts.push(value);
      }
    } catch {}
    return new TextDecoder().decode(Buffer.concat(parts));
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"late">((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      endGroup();
      resolve("late");
    }, o.timeoutMs);
  });
  const work = Promise.all([
    read(proc.stdout, o.stdoutBytes, () => {
      capped = true;
      endGroup();
    }),
    proc.stderr instanceof ReadableStream ? read(proc.stderr, o.stderrBytes, () => {}) : Promise.resolve(""),
    proc.exited,
  ]);
  const got = await Promise.race([work, deadline]);
  clearTimeout(timer);
  if (got === "late") {
    for (const r of readers) void r.cancel().catch(() => {});
    return { code: proc.exitCode, stdout: "", stderr: "", timedOut, capped, failed: false };
  }
  const [stdout, stderr, code] = got;
  return { code, stdout: capped ? "" : stdout, stderr, timedOut, capped, failed: false };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * `claude agents --json`'s answer (Claude Code 2.1.318 printAgentsJson: a JSON array of rows), keeping only background
 * rows whose id is in `ids`, one per id, each field by its rule; null when it is not such an array.
 */
export function parseAgentsJson(stdout: string, ids: ReadonlySet<string>): BgListRow[] | null {
  let v: unknown;
  try {
    v = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(v)) return null;
  const out: BgListRow[] = [];
  for (const x of v) {
    // Every other row goes here, before any of its fields is read.
    if (!isObj(x) || x.kind !== "background" || !isBgId(x.id) || !ids.has(x.id) || out.some((r) => r.id === x.id)) continue;
    const status = x.status === undefined || x.status === null ? null : bgStatusOf(x.status);
    const started = x.startedAt;
    out.push({
      id: x.id,
      sessionId: isUuid(x.sessionId) ? x.sessionId : null,
      name: bgName(x.name),
      cwd: bgFolderOf(x.cwd),
      state: typeof x.state === "string" && (LIST_STATES as readonly string[]).includes(x.state) ? (x.state as BgListState) : null,
      status,
      waitingFor: status === "waiting" && x.waitingFor !== undefined ? bgWaitOf(x.waitingFor) : null,
      startedAt: typeof started === "number" && Number.isSafeInteger(started) && started > 0 ? started : null,
    });
  }
  return out;
}

const CSI = new RegExp(String.fromCharCode(27) + "[[][0-9;?]*[ -/]*[@-~]", "g");

/**
 * `claude stop <id>`'s answer, as Claude Code 2.1.318 prints it: exit 0 with the first line "stopped <id>" is
 * `stopped` (the worktree lines after it are dropped); "No job matching '<id>'." on standard error is `not_found`;
 * anything else ("couldn't confirm <id> was stopped", the timeout, a run that could not start) is `failed`.
 */
export function stopAnswerOf(run: CliRun, id: string): BgStopAnswer {
  if (run.code === 0 && !run.timedOut && !run.capped && !run.failed) {
    const first = (run.stdout.split("\n")[0] ?? "").replace(CSI, "").trim();
    if (first === `stopped ${id}`) return "stopped";
  }
  if (!run.timedOut && run.stderr.split("\n").some((l) => l.replace(CSI, "").startsWith("No job matching '"))) return "not_found";
  return "failed";
}

/**
 * The folder name that the SDK (0.3.322, `rd`) gives a session's folder under `<config>/projects/`: every character
 * outside a-z, A-Z and 0-9 as "-"; past 200 characters, the first 200, "-", and the base 36 of the absolute 32-bit
 * string hash of the folder (`eC`).
 */
export function transcriptSlug(dir: string): string {
  const plain = dir.replace(/[^a-zA-Z0-9]/g, "-");
  if (plain.length <= 200) return plain;
  let h = 0;
  for (let i = 0; i < dir.length; i++) h = ((h << 5) - h + dir.charCodeAt(i)) | 0;
  return `${plain.slice(0, 200)}-${Math.abs(h).toString(36)}`;
}

/** The last `max` bytes of a regular file, never through a link (null: missing, a link, not a regular file, unread). */
async function readTail(path: string, max: number): Promise<{ text: string; whole: boolean } | null> {
  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const st = await fh.stat();
    if (!st.isFile()) return null;
    const n = Math.min(st.size, max);
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, st.size - n);
    return { text: buf.toString("utf8", 0, bytesRead), whole: n === st.size };
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/** The mode of the last `permission-mode` record with a known mode in a transcript's tail; null when none. */
function modeIn(tail: { text: string; whole: boolean }): ModeId | null {
  const lines = tail.text.split("\n");
  // A tail that starts inside the file starts inside a line: that piece is not a record.
  if (!tail.whole) lines.shift();
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (!l.includes('"permission-mode"')) continue;
    try {
      const o = JSON.parse(l) as unknown;
      if (isObj(o) && o.type === "permission-mode" && typeof o.permissionMode === "string" && (MODE_IDS as readonly string[]).includes(o.permissionMode)) return o.permissionMode as ModeId;
    } catch {
      // a half-written line
    }
  }
  return null;
}

/**
 * A background session's permission mode, from `<config>/projects/<folder name>/<session>.jsonl`: the first of `dirs`
 * whose transcript file is there decides (its last known mode, or none). A folder name past 200 characters may carry
 * another hash in the CLI's own files, so the SDK's prefix rule finds those too.
 */
export async function readPermissionMode(configDir: string, dirs: readonly string[], sessionId: string, tailBytes: number = BG_CLI.modeTailBytes): Promise<ModeId | null> {
  if (!isUuid(sessionId)) return null;
  const projects = join(configDir, "projects");
  for (const dir of dirs) {
    const slug = transcriptSlug(dir.normalize("NFC"));
    const names = [slug];
    if (slug.length > 200) {
      const prefix = `${slug.slice(0, 200)}-`;
      try {
        for (const n of await readdir(projects)) if (n !== slug && n.startsWith(prefix)) names.push(n);
      } catch {}
    }
    for (const name of names) {
      const tail = await readTail(join(projects, name, `${sessionId}.jsonl`), tailBytes);
      if (tail) return modeIn(tail);
    }
  }
  return null;
}

/** Where a run finds the binary: its path, or why there is none to run. */
export type AgentViewBinary = string | "no_claude" | "unsupported";

export interface BackgroundCliOptions {
  env: () => Record<string, string>;
  cwd: () => string;
  limits: BgCliLimits;
  now?: () => number;
}

/** The two commands, with the list's one-at-a-time rule and its kept answer. */
export class BackgroundCli {
  private running: Promise<unknown> | null = null;
  private kept: { at: number; ids: ReadonlySet<string>; rows: BgListRow[] | null } | null = null;

  constructor(private readonly opts: BackgroundCliOptions) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** `claude agents --json --all`, for the rows of `ids`; null when it cannot be read. Never throws. */
  async list(ids: ReadonlySet<string>, binary: () => Promise<AgentViewBinary>): Promise<BgList | null> {
    if (ids.size === 0) return { rows: [], at: this.now(), ran: null };
    {
      // One at a time: a request during a run waits for it, then takes its answer when that covers its ids.
      while (this.running) await this.running.catch(() => {});
      const k = this.kept;
      if (k && this.now() - k.at < this.opts.limits.cacheMs && [...ids].every((id) => k.ids.has(id))) {
        return k.rows ? { rows: k.rows.filter((r) => ids.has(r.id)).map((r) => ({ ...r })), at: k.at, ran: null } : null;
      }
      const run = this.runList(new Set(ids), binary);
      this.running = run;
      try {
        return await run;
      } finally {
        if (this.running === run) this.running = null;
      }
    }
  }

  private async runList(ids: ReadonlySet<string>, binary: () => Promise<AgentViewBinary>): Promise<BgList | null> {
    const at = this.now();
    const bin = await binary().catch((): AgentViewBinary => "no_claude");
    if (bin === "no_claude" || bin === "unsupported") return null;
    const t0 = performance.now();
    const run = await runCli([bin, "agents", "--json", "--all"], {
      timeoutMs: this.opts.limits.agentsTimeoutMs,
      stdoutBytes: this.opts.limits.stdoutBytes,
      stderrBytes: 0,
      env: this.opts.env(),
      cwd: this.opts.cwd(),
    });
    const ms = Math.round(performance.now() - t0);
    const rows = run.code === 0 && !run.timedOut && !run.capped && !run.failed ? parseAgentsJson(run.stdout, ids) : null;
    this.kept = { at, ids, rows };
    return rows ? { rows: rows.map((r) => ({ ...r })), at, ran: { ms, code: run.code } } : null;
  }

  /** `claude stop <id>` with `bin` (the caller checked the id and the gate); its answer. A known answer drops the kept list. */
  async stop(bin: string, id: string): Promise<BgStopAnswer> {
    const run = await runCli([bin, "stop", id], {
      timeoutMs: this.opts.limits.stopTimeoutMs,
      stdoutBytes: this.opts.limits.stdoutBytes,
      stderrBytes: this.opts.limits.stderrBytes,
      env: this.opts.env(),
      cwd: this.opts.cwd(),
    });
    const answer = stopAnswerOf(run, id);
    if (answer !== "failed") this.kept = null;
    return answer;
  }
}
