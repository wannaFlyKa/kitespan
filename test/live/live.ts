// The shared pieces of the opt-in live tests (DESIGN.md 8.6, 8.7, 8.10; test/live/README.md). Nothing here runs at
// import: a file calls liveSuite(), which registers one skipped test unless KITESPAN_LIVE=1, one failing test when the
// environment is refused, and the file's own tests otherwise.
//
// - The environment: the scratch project (KITESPAN_LIVE_PROJECT, never a git repository with uncommitted changes), the
//   model rows (the CLI's own row values, never a bare alias), the port (KITESPAN_LIVE_PORT) and the PATH claude.
// - The server: bin/kitespan on that port with a temporary kitespan state and config folder, the user's own HOME and
//   PATH, stopped by its pid after a kill -0 and a /proc cmdline check. A kill -9 and a new server on the same folders,
//   and a restart's successor, which the server before started: the LiveServer takes it over by its pid.
// - A page: a socket on /ws or /ws/shell with the server's own Origin.
// - The processes: the claude processes under the server, found in /proc by their executable.
// - Claude Code's own transcripts, which only these opt-in tests read (the app never reads the CLI's request records).
// - One log line per real turn: its time, model, purpose, session and duration; never a message's or a reply's text.

import type { Subprocess } from "bun";
import { test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { CLEAN_ENV, maskArns } from "../../server/agents/types";
import { findGit, gitEnv } from "../../server/search/git";
import { BUILD_STAMP, stampText } from "../../server/update/stamp";
import { UUID } from "../../shared/ids";
import { legacyEnvName, readEnv } from "../../shared/legacy";
import { applyChatsFrame, type ChatEvent, type ChatRow, type ChatsFrame, type Picks } from "../../shared/protocol";

export const ROOT = realpathSync(resolve(import.meta.dir, "..", ".."));

/**
 * A live variable by its name; its old name is read for one release when the new one is unset, with one line on
 * stderr that names it and never its value (shared/legacy.ts). Every live file reads its variables here.
 */
export function liveVar(name: string, env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  return readEnv(env, name, (line) => void process.stderr.write(`${line}\n`));
}

export const LIVE = liveVar("KITESPAN_LIVE") === "1";

/** The ports a live run may use: a test copy on 7941 to 7949, or 7940 for the demo run (D52). */
export const LIVE_PORTS: readonly number[] = [7940, 7941, 7942, 7943, 7944, 7945, 7946, 7947, 7948, 7949];
export const DEFAULT_LIVE_PORT = 7946;

/** The CLI's bare aliases: each one can run the default model without a word (DESIGN 8.6). */
const ALIAS = /^(default|best|sonnet|opus|haiku|opusplan)(\[1m\])?$/i;
const MODEL_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,119}$/;

// ---------------------------------------------------------------------------------------------------------------
// The environment

export interface LiveEnv {
  /** The scratch project's real path. */
  project: string;
  model: string;
  strongModel: string | null;
  todoModel: string | null;
  /** The session id of the hand-recorded interactive turn (raw.test.ts). */
  rawReference: string | null;
  port: number;
  /** The claude on PATH, as PATH names it, and its real path (what /proc/<pid>/exe shows). */
  claude: string;
  claudeReal: string;
}

export interface Needs {
  todoModel?: boolean;
  rawReference?: boolean;
}

export type Setup = { ok: true; env: LiveEnv } | { ok: false; why: string };

/** Why a model variable is refused, or null. */
export function modelProblem(name: string, value: string | undefined, required: boolean): string | null {
  const v = value?.trim() ?? "";
  if (v === "") return required ? `${name} is not set: give the CLI's own row value for the model (its row's value in supportedModels())` : null;
  if (ALIAS.test(v)) return `${name} is the bare alias "${v}", which can run the default model without a word: give the row's own value from supportedModels()`;
  // Row 95: the live files log and send the model row, and no model string that starts with "arn:" goes anywhere.
  if (/^arn:/i.test(v)) return `${name} is a provider ARN: give the CLI's own row value that is not one`;
  if (!MODEL_VALUE.test(v)) return `${name} is not a model row value`;
  return null;
}

/** Why the scratch project is refused, or null. */
export function projectProblem(path: string | undefined): string | { real: string } {
  if (!path) return "KITESPAN_LIVE_PROJECT is not set: give a scratch folder outside any real repository (every live turn runs there)";
  if (!isAbsolute(path)) return "KITESPAN_LIVE_PROJECT must be an absolute path";
  let real: string;
  try {
    real = realpathSync(path);
    if (!statSync(real).isDirectory()) return "KITESPAN_LIVE_PROJECT is not a folder";
  } catch {
    return "KITESPAN_LIVE_PROJECT does not exist";
  }
  if (real === ROOT || real.startsWith(`${ROOT}/`)) return "KITESPAN_LIVE_PROJECT is inside kitespan's own folder: use a scratch folder";
  let inside = false;
  try {
    const r = Bun.spawnSync(["git", "-C", real, "rev-parse", "--is-inside-work-tree"], { stdout: "pipe", stderr: "pipe" });
    inside = r.exitCode === 0 && r.stdout.toString().trim() === "true";
  } catch {
    inside = false;
  }
  if (inside) {
    const s = Bun.spawnSync(["git", "-C", real, "status", "--porcelain"], { stdout: "pipe", stderr: "pipe" });
    if (s.exitCode !== 0) return "KITESPAN_LIVE_PROJECT is in a git repository whose status could not be read";
    if (s.stdout.toString().trim() !== "") return "KITESPAN_LIVE_PROJECT is in a git repository with uncommitted changes: use a scratch folder (DESIGN 8.10)";
  }
  return { real };
}

export function liveEnv(needs: Needs = {}, env: Record<string, string | undefined> = process.env): Setup {
  const v = (name: string) => liveVar(name, env);
  const project = projectProblem(v("KITESPAN_LIVE_PROJECT"));
  if (typeof project === "string") return { ok: false, why: project };
  const problems = [
    modelProblem("KITESPAN_LIVE_MODEL", v("KITESPAN_LIVE_MODEL"), true),
    modelProblem("KITESPAN_LIVE_STRONG_MODEL", v("KITESPAN_LIVE_STRONG_MODEL"), false),
    modelProblem("KITESPAN_LIVE_TODO_MODEL", v("KITESPAN_LIVE_TODO_MODEL"), needs.todoModel === true),
  ].filter((p): p is string => p !== null);
  if (problems.length) return { ok: false, why: problems.join("; ") };
  const rawPort = v("KITESPAN_LIVE_PORT")?.trim() || String(DEFAULT_LIVE_PORT);
  const port = /^\d{4}$/.test(rawPort) ? Number(rawPort) : NaN;
  if (!LIVE_PORTS.includes(port)) return { ok: false, why: "KITESPAN_LIVE_PORT must be a test port from 7941 to 7949 (or 7940 for the demo run)" };
  const ref = v("KITESPAN_LIVE_RAW_REFERENCE")?.trim() || null;
  if (needs.rawReference) {
    if (!ref) return { ok: false, why: "KITESPAN_LIVE_RAW_REFERENCE is not set: record one interactive claude turn by hand in the scratch project and give its session id (test/live/README.md)" };
    if (!UUID.test(ref)) return { ok: false, why: "KITESPAN_LIVE_RAW_REFERENCE is not a session id" };
  }
  const claude = Bun.which("claude", { PATH: env.PATH ?? "" });
  if (!claude) return { ok: false, why: "no claude on PATH: the live tests run the user's own Claude Code" };
  let claudeReal: string;
  try {
    claudeReal = realpathSync(claude);
  } catch {
    return { ok: false, why: "the claude on PATH could not be resolved" };
  }
  return {
    ok: true,
    env: {
      project: project.real,
      model: v("KITESPAN_LIVE_MODEL")!.trim(),
      strongModel: v("KITESPAN_LIVE_STRONG_MODEL")?.trim() || null,
      todoModel: v("KITESPAN_LIVE_TODO_MODEL")?.trim() || null,
      rawReference: ref,
      port,
      claude,
      claudeReal,
    },
  };
}

/**
 * The gate of every live file: without KITESPAN_LIVE=1 one skipped test (one line); with a refused environment one
 * failing test that says why; otherwise the file's own tests.
 */
export function liveSuite(file: string, needs: Needs, body: (env: LiveEnv) => void): void {
  if (!LIVE) {
    test.skip(`${file}: an opt-in live test that runs real turns; set KITESPAN_LIVE=1 to run it (test/live/README.md)`, () => {});
    return;
  }
  const s = liveEnv(needs);
  if (!s.ok) {
    const why = s.why;
    test(`${file}: the live environment`, () => {
      throw new Error(why);
    });
    return;
  }
  body(s.env);
}

/** A step that needs an earlier one: it fails with one line instead of a confusing error. */
export function need(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(`not run: ${what} did not pass`);
}

// ---------------------------------------------------------------------------------------------------------------
// The turn log (DESIGN 8.6: every turn with its time, model and purpose; 8.10: counts and ids, never content)

export interface TurnRow {
  purpose: string;
  model: string | null;
  chat?: string | null;
  session?: string | null;
  ms: number;
  ok: boolean;
  note?: string;
}

export class TurnLog {
  private n = 0;
  private readonly byModel = new Map<string, number>();
  constructor(readonly file: string) {}

  turn(row: TurnRow): void {
    this.n++;
    const m = row.model ?? "(the user's default)";
    this.byModel.set(m, (this.byModel.get(m) ?? 0) + 1);
    console.log(JSON.stringify({ live: this.file, turn: this.n, at: new Date().toISOString(), ...row, ms: Math.round(row.ms) }));
  }

  line(o: Record<string, unknown>): void {
    console.log(JSON.stringify({ live: this.file, ...o }));
  }

  summary(): void {
    console.log(JSON.stringify({ live: this.file, turns: this.n, byModel: Object.fromEntries(this.byModel) }));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Processes

export function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function cmdline(pid: number): string[] {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter((s) => s !== "");
  } catch {
    return [];
  }
}

export interface Stat {
  state: string;
  ppid: number;
  /** Field 22 of /proc/<pid>/stat: the start time, which tells a reused pid from the process that had it. */
  start: string;
}

export function statOf(pid: number): Stat | null {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
    return { state: f[0] ?? "", ppid: Number(f[1]), start: f[19] ?? "" };
  } catch {
    return null;
  }
}

function pids(): number[] {
  try {
    return readdirSync("/proc").filter((n) => /^\d+$/.test(n)).map(Number);
  } catch {
    return [];
  }
}

/** The live (not zombie) children of `pid`. */
export function childrenOf(pid: number): number[] {
  return pids().filter((p) => {
    const s = statOf(p);
    return s !== null && s.ppid === pid && s.state !== "Z";
  });
}

export function descendantsOf(pid: number): number[] {
  const out: number[] = [];
  const all = pids()
    .map((p) => ({ p, s: statOf(p) }))
    .filter((x): x is { p: number; s: Stat } => x.s !== null && x.s.state !== "Z");
  const queue = [pid];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const x of all) {
      if (x.s.ppid !== parent || out.includes(x.p)) continue;
      out.push(x.p);
      queue.push(x.p);
    }
  }
  return out;
}

function realOrNull(p: string | undefined): string | null {
  if (!p || !isAbsolute(p)) return null;
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** True when the process runs the PATH claude: its executable, or the script its interpreter runs, is that file. */
export function runsClaude(pid: number, claudeReal: string): boolean {
  let exe: string | null = null;
  try {
    exe = readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, "");
  } catch {
    exe = null;
  }
  if (exe === claudeReal) return true;
  const argv = cmdline(pid);
  return realOrNull(argv[0]) === claudeReal || realOrNull(argv[1]) === claudeReal;
}

/**
 * One field of Claude Code's record of a running claude, `<config>/sessions/<pid>.json`: that field only, or null.
 * The `.key` file beside the record is never read.
 */
export function sessionField(pid: number, field: "status" | "sessionId"): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const file = join(claudeConfigDir(), "sessions", `${pid}.json`);
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.size > 16_384) return null;
    const v = (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> | null)?.[field];
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/** The live processes that run the PATH claude on `session`: their command line or their session record names it. */
export function claudesOfSession(session: string, claudeReal: string): number[] {
  return pids().filter((p) => {
    const st = statOf(p);
    if (!st || st.state === "Z" || !runsClaude(p, claudeReal)) return false;
    return cmdline(p).some((a) => a.includes(session)) || sessionField(p, "sessionId") === session;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The server

/** The user's own environment without the live tests' variables (by either name): Claude Code runs as for the user. */
export function userEnv(): Record<string, string | undefined> {
  const old = legacyEnvName("KITESPAN_LIVE")!;
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("KITESPAN_LIVE") && !k.startsWith(old)));
}

/** True when nothing holds the port on 127.0.0.1 (a short bind proves it). */
export function portFree(port: number): boolean {
  try {
    const s = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    s.stop(true);
    return true;
  } catch {
    return false;
  }
}

/** The parts of the Settings reply (server/http/api-types.ts) that the live tests read. */
export interface SettingsView {
  settings: Record<string, unknown>;
  agent: { respondToBash: boolean; promptSuggestions: boolean; defaultMode: string | null } | null;
}

export interface BootOptions {
  /** Variables added to the user's own environment (the terminal test's model row for the pane's claude). */
  env?: Record<string, string>;
  /**
   * The build stamp of this checkout's HEAD beside the temporary page (build.json), so that a restart's preflight
   * passes: it refuses a build that is not the checkout's (4.10).
   */
  stamp?: boolean;
  /**
   * The temporary folder, made by the test with makeTemp(); its state/ and config/ are made when missing, and stop()
   * removes it. Default: a new one.
   */
  root?: string;
  /** Another kitespan checkout to run and the build folder it serves, inside `root` (the update test's scratch clone). */
  checkout?: { root: string; dist: string };
}

/** The name start of every temporary folder of the live tests, directly under tmpdir(). */
const TEMP_PREFIX = "kitespan-live-";

/** A new temporary folder of the live tests (its real path), for a server or the files of a check. */
export function makeTemp(tag: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `${TEMP_PREFIX}${tag}-`)));
}

/** The real path of a folder that makeTemp() made (directly under tmpdir(), with its prefix), or null. */
function ownTemp(path: string, parent: string = tmpdir()): string | null {
  try {
    const real = realpathSync(path);
    return dirname(real) === realpathSync(parent) && basename(real).startsWith(TEMP_PREFIX) ? real : null;
  } catch {
    return null;
  }
}

/** Remove a folder that makeTemp() made, with everything in it; any other path stays as it is. */
export function removeTemp(path: string): void {
  const real = ownTemp(path);
  if (real) rmSync(real, { recursive: true, force: true });
}

/** The commit that `dir`'s HEAD names, or null outside a git checkout. */
export function headOf(dir: string): string | null {
  const r = Bun.spawnSync(["git", "-C", dir, "rev-parse", "HEAD"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const head = r.stdout.toString().trim();
  return r.exitCode === 0 && /^[0-9a-f]{40,64}$/.test(head) ? head : null;
}

/** One server process of a LiveServer: one the test spawned, or a restart's successor, which the server before started. */
interface Run {
  pid: number;
  /** Its start time (Stat.start), so that a pid the system gave again never counts as this server. */
  start: string;
  /** The process when the test spawned it; null for a successor. */
  proc: Subprocess<"ignore", "pipe", "pipe"> | null;
}

/** The last line of a server whose restart passed its health gate (server/main.ts). */
const RESTARTED = /kitespan restarted as process (\d+);/;

export class LiveServer {
  out = "";
  err = "";
  /** Every claude process seen under this server, so one that outlived it can be ended by its pid. */
  private readonly claudes = new Map<number, string>();
  /** Every server process on this port and folder, the current one last (a kill -9 and reboot, a restart). */
  private readonly runs: Run[] = [];
  /**
   * Each restart's successor as a child of the server that started it (watchSuccessor), with its start: successor()
   * takes it over from here, and stop() ends one that the test never took over. No other process is ever looked for.
   */
  private readonly born: Run[] = [];
  /** The server processes whose children are watched now (one watch each). */
  private readonly watched = new Set<number>();
  private spawned: Subprocess<"ignore", "pipe", "pipe"> | null = null;
  private stopped = false;

  private constructor(
    readonly port: number,
    /** The temporary folder: state/, config/, and the build folder. */
    readonly root: string,
    private readonly claudeReal: string,
    /** The checkout's bin/kitespan and server/main.ts, by their real paths (bin/kitespan runs main.ts by its real path). */
    private readonly script: string,
    private readonly main: string,
    private readonly dist: string,
    private readonly childEnv: Record<string, string | undefined>,
  ) {}

  /** The last server process that the test spawned (a restart's successor is not one; `pid` names the current one). */
  get proc(): Subprocess<"ignore", "pipe", "pipe"> {
    return this.spawned!;
  }
  get pid(): number {
    return this.current.pid;
  }
  /** True while the current server process lives and is this test's server (a step after a failed one checks it). */
  get running(): boolean {
    return this.runs.length > 0 && this.lives(this.current);
  }
  private get current(): Run {
    return this.runs[this.runs.length - 1]!;
  }
  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }
  /** kitespan's own state folder (XDG_STATE_HOME/kitespan). */
  get stateDir(): string {
    return join(this.root, "state", "kitespan");
  }
  /** The folders the server got, which the raw test's `claude -p` run gets too. */
  get xdg(): { XDG_STATE_HOME: string; XDG_CONFIG_HOME: string; XDG_DATA_HOME: string } {
    return { XDG_STATE_HOME: join(this.root, "state"), XDG_CONFIG_HOME: join(this.root, "config"), XDG_DATA_HOME: join(this.root, "data") };
  }

  static async boot(env: LiveEnv, opts: BootOptions = {}): Promise<LiveServer> {
    if (!portFree(env.port)) throw new Error(`port ${env.port} is in use: a live test starts its own server and never talks to one that it did not start`);
    const root = opts.root === undefined ? realpathSync(mkdtempSync(join(tmpdir(), TEMP_PREFIX))) : ownTemp(opts.root);
    if (root === null) throw new Error("BootOptions.root must be a folder that makeTemp() made");
    // All three XDG folders are the run's own, the data folder too: with the user's own HOME, the server's first start
    // would otherwise move the user's real data folder of the old name (server/store/move.ts).
    for (const d of ["state", "config", "data"]) mkdirSync(join(root, d), { recursive: true, mode: 0o700 });
    let dist = join(root, "dist");
    let checkout = ROOT;
    if (opts.checkout) {
      checkout = realpathSync(opts.checkout.root);
      dist = realpathSync(opts.checkout.dist);
      if (!checkout.startsWith(`${root}/`) || !dist.startsWith(`${root}/`)) throw new Error("BootOptions.checkout must be inside the server's temporary folder");
    } else {
      mkdirSync(dist, { recursive: true, mode: 0o700 });
      writeFileSync(join(dist, "index.html"), "<!doctype html><title>kitespan</title>\n", { mode: 0o600 });
      if (opts.stamp) writeFileSync(join(dist, BUILD_STAMP), stampText(headOf(ROOT)), { mode: 0o600 });
    }
    const childEnv: Record<string, string | undefined> = {
      ...userEnv(),
      XDG_STATE_HOME: join(root, "state"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      ...opts.env,
    };
    for (const k of ["XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]) {
      const v = childEnv[k];
      if (!v || !(v === root || v.startsWith(`${root}/`))) throw new Error(`${k} must be inside the server's temporary folder: a live run never uses the user's own folders`);
    }
    const s = new LiveServer(env.port, root, env.claudeReal, join(checkout, "bin", "kitespan"), join(checkout, "server", "main.ts"), dist, childEnv);
    await s.start();
    return s;
  }

  /** bin/kitespan on the port with this folder's state, config and build, until it says that it listens. */
  private async start(): Promise<void> {
    const proc = Bun.spawn([this.script, "--port", String(this.port), "--dist", this.dist], {
      env: this.childEnv,
      cwd: this.root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.spawned = proc;
    this.out = "";
    this.err = "";
    this.runs.push({ pid: proc.pid, start: statOf(proc.pid)?.start ?? "", proc });
    const read = async (stream: ReadableStream<Uint8Array>, key: "out" | "err") => {
      const dec = new TextDecoder();
      for await (const c of stream) if (this.spawned === proc) this[key] += dec.decode(c, { stream: true });
    };
    void read(proc.stdout, "out");
    void read(proc.stderr, "err");
    const end = Date.now() + 30_000;
    while (!this.out.includes(`kitespan listens on ${this.origin}`)) {
      if (proc.exitCode !== null || Date.now() > end) {
        const tail = this.err.split("\n").filter(Boolean).slice(-4).join(" | ");
        await this.stop();
        throw new Error(`the server did not start (exit ${proc.exitCode}): ${tail}`);
      }
      await Bun.sleep(100);
    }
  }

  /**
   * A command line of this test's own server: this checkout's bin/kitespan or server/main.ts, this port, and a build
   * folder inside this test's own temporary folder (the one that holds its state folder); never the restart
   * preflight's `--check`.
   */
  private ownCommand(c: readonly string[]): boolean {
    const value = (flag: string) => {
      const i = c.indexOf(flag);
      return i >= 0 ? c[i + 1] : undefined;
    };
    return (c.includes(this.main) || c.includes(this.script)) && value("--port") === String(this.port) && (value("--dist") ?? "").startsWith(`${this.root}/`) && !c.includes("--check");
  }

  /** True while `run`'s process lives with its start time (not a zombie). */
  private same(run: Run): boolean {
    const st = statOf(run.pid);
    return st !== null && st.state !== "Z" && st.start === run.start;
  }

  /** True while `run` is that process and runs this test's server: the checks before any signal to it. */
  private lives(run: Run): boolean {
    return this.same(run) && alive(run.pid) && this.ownCommand(cmdline(run.pid));
  }

  /** Waits until `run` has exited, for at most `ms`; true when it has. */
  private async ended(run: Run, ms: number): Promise<boolean> {
    if (run.proc) return Promise.race([run.proc.exited.then(() => true), Bun.sleep(ms).then(() => false)]);
    const end = Date.now() + ms;
    while (this.same(run)) {
      if (Date.now() > end) return false;
      await Bun.sleep(100);
    }
    return true;
  }

  /** SIGTERM to `run` after the checks, then SIGKILL after 20 s, with the same checks. */
  private async end(run: Run): Promise<void> {
    if (!this.lives(run)) return;
    process.kill(run.pid, "SIGTERM");
    if (await this.ended(run, 20_000)) return;
    if (this.lives(run)) process.kill(run.pid, "SIGKILL");
    await this.ended(run, 5_000);
  }

  /**
   * From a restart's ask until `parent` exits: each child of `parent` with this test's server command line (the
   * successor, which bin/kitespan runs in the same pid from its sh to its bun) is noted with its start. A successor is
   * a child of the server that started it from its spawn until that server exits, which is after the successor answered
   * its health read, so a look every 100 ms sees it. The preflight's `--check` child never counts (ownCommand).
   */
  private watchSuccessor(parent: Run): void {
    if (this.watched.has(parent.pid) || !this.same(parent)) return;
    this.watched.add(parent.pid);
    // A drain waits for the running turns: a live test's longest is a few minutes.
    const end = Date.now() + 20 * 60_000;
    void (async () => {
      while (this.same(parent) && Date.now() < end) {
        for (const p of childrenOf(parent.pid)) {
          const st = statOf(p);
          if (!st || st.state === "Z" || this.born.some((r) => r.pid === p && r.start === st.start)) continue;
          if (this.ownCommand(cmdline(p))) this.born.push({ pid: p, start: st.start, proc: null });
        }
        await Bun.sleep(100);
      }
    })().finally(() => this.watched.delete(parent.pid));
  }

  /**
   * A kill -9 of the server: SIGKILL to its own recorded pid after the checks, then the wait for its exit. Its claude
   * children are noted first (stop() ends one that outlives it), and the folders stay for reboot(). Returns them.
   */
  async kill9(): Promise<number[]> {
    const run = this.current;
    const children = this.claudeChildren();
    if (!this.lives(run)) throw new Error("the server is not running, or its pid is no longer this test's server");
    process.kill(run.pid, "SIGKILL");
    if (!(await this.ended(run, 10_000))) throw new Error("the server did not exit after SIGKILL");
    return children;
  }

  /** A new server on the same port and the same state, config and build folders, once the one before is gone. */
  async reboot(): Promise<void> {
    if (this.stopped) throw new Error("this server was stopped");
    if (this.same(this.current)) throw new Error("the server before still runs");
    await until(() => portFree(this.port), 10_000, `port ${this.port} to be free`);
    await this.start();
  }

  /**
   * POST /api/restart with the sender gate's headers: Restart when they finish, or Restart now (4.10). The current
   * server's children are watched from now on, so its successor is known by its pid (watchSuccessor).
   */
  async restart(when: "finish" | "now"): Promise<Response> {
    this.watchSuccessor(this.current);
    return this.post("/api/restart", { when });
  }

  /** GET /api/health: the boot epoch of the server that answers on the port now, or null. */
  async health(): Promise<string | null> {
    try {
      const r = await fetch(`${this.origin}/api/health`, { signal: AbortSignal.timeout(2_000) });
      const epoch = r.ok ? ((await r.json()) as { epoch?: unknown }).epoch : null;
      return typeof epoch === "string" ? epoch : null;
    } catch {
      return null;
    }
  }

  /**
   * After a restart: the server before has exited and a new epoch answers on the port; the successor becomes this
   * LiveServer's server. It is the child of the server before that watchSuccessor noted; when the test spawned that
   * server, its last line names the pid too, and the two must agree. Either way it passes ownCommand's check, which
   * names this test's own folder.
   */
  async successor(oldEpoch: string, ms = 60_000): Promise<{ pid: number; epoch: string }> {
    const before = this.current;
    const end = Date.now() + ms;
    let epoch: string | null = null;
    for (;;) {
      if (epoch === null) {
        const e = await this.health();
        if (e !== null && e !== oldEpoch) epoch = e;
      }
      if (epoch !== null && !this.same(before)) break;
      if (Date.now() > end) throw new Error(epoch === null ? "no new epoch answered GET /api/health: the successor did not start" : "the server before the restart did not exit");
      await Bun.sleep(200);
    }
    let named: number | null = null;
    if (before.proc) {
      await until(() => RESTARTED.test(this.out), 5_000, "the restart's last line").catch(() => {});
      const m = RESTARTED.exec(this.out);
      if (m) named = Number(m[1]);
    }
    const kids = this.born.filter((r) => this.lives(r) && !this.runs.some((x) => x.pid === r.pid && x.start === r.start));
    let run: Run | undefined;
    if (kids.length === 1) run = kids[0];
    else if (kids.length === 0 && named !== null) {
      // The watch missed it: the line of the server that the test spawned names it, and it must pass the same checks.
      const st = statOf(named);
      if (st && st.state !== "Z" && this.ownCommand(cmdline(named))) run = { pid: named, start: st.start, proc: null };
    }
    if (!run) throw new Error(`${kids.length} live children of the server before ran this test's server, so the successor is not known`);
    if (named !== null && named !== run.pid) throw new Error(`the server before named process ${named} as its successor, and its child was process ${run.pid}`);
    this.runs.push(run);
    return { pid: run.pid, epoch };
  }

  private note(found: number[]): number[] {
    for (const p of found) {
      const st = statOf(p);
      if (st && !this.claudes.has(p)) this.claudes.set(p, st.start);
    }
    return found;
  }

  /** The server's children that run the PATH claude: one per live chat (D49). */
  claudeChildren(): number[] {
    return this.note(childrenOf(this.pid).filter((p) => runsClaude(p, this.claudeReal)));
  }

  /**
   * A claude that a Terminal pane's shell runs: below one of the server's children that is not a chat's claude (so a
   * process that a chat's own claude starts is not one).
   */
  paneClaude(): number[] {
    const out: number[] = [];
    for (const c of childrenOf(this.pid)) if (!runsClaude(c, this.claudeReal)) out.push(...descendantsOf(c).filter((p) => runsClaude(p, this.claudeReal)));
    return this.note(out);
  }

  /** True while the process `pid` that this server ran is alive (the same start time: not a reused pid). */
  stillRuns(pid: number): boolean {
    const st = statOf(pid);
    const start = this.claudes.get(pid);
    return st !== null && st.state !== "Z" && (start === undefined || st.start === start);
  }

  /** The claude processes seen under this server that still run (the same start time, the PATH claude). */
  private claudesLeft(): number[] {
    return [...this.claudes]
      .filter(([p, start]) => {
        const st = statOf(p);
        return st !== null && st.state !== "Z" && st.start === start && runsClaude(p, this.claudeReal);
      })
      .map(([p]) => p);
  }

  /** What still runs of what this server ran: the claude processes seen under it, its server processes and successors. */
  leftovers(): number[] {
    const servers = [...this.runs, ...this.born].filter((r) => this.lives(r)).map((r) => r.pid);
    return [...new Set([...this.claudesLeft(), ...servers])];
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const run of [...this.runs].reverse()) await this.end(run);
    // A restart's successor that the test did not take over (a step failed between the restart and successor()): the
    // one that watchSuccessor noted, by its pid and start, after the same checks.
    for (const run of this.born) await this.end(run);
    // The SDK ends each claude it started when the server exits; one that outlived it is ended by its own pid.
    await Bun.sleep(500);
    for (const p of this.claudesLeft()) {
      try {
        process.kill(p, "SIGTERM");
      } catch {
        // already gone
      }
    }
    await until(() => this.claudesLeft().length === 0, 10_000, "the claude processes to end").catch(() => {
      for (const p of this.claudesLeft()) {
        try {
          process.kill(p, "SIGKILL");
        } catch {
          // already gone
        }
      }
    });
    removeTemp(this.root);
  }

  // HTTP, with the headers that the sender gate asks of a mutating request (4.9).

  async post(path: string, body: unknown): Promise<Response> {
    return fetch(`${this.origin}${path}`, {
      method: "POST",
      headers: { "x-kitespan": "1", "content-type": "application/json", origin: this.origin },
      body: JSON.stringify(body),
    });
  }

  async get(path: string): Promise<Response> {
    return fetch(`${this.origin}${path}`);
  }

  async addProject(cwd: string): Promise<string> {
    const r = await this.post("/api/projects", { cwd });
    if (r.status !== 200 && r.status !== 201) throw new Error(`adding the project failed: ${r.status}`);
    return ((await r.json()) as { project: { id: string } }).project.id;
  }

  /** GET /api/settings?project=: kitespan's settings and the user's own Claude Code settings for that folder. */
  async settings(project: string): Promise<SettingsView> {
    const r = await this.get(`/api/settings?project=${encodeURIComponent(project)}`);
    if (!r.ok) throw new Error(`reading the settings failed: ${r.status}`);
    return (await r.json()) as SettingsView;
  }

  /** An upload for the new-chat form (`project=`) or a chat (`chat=`). */
  async upload(owner: string, name: string, type: string, body: string | Uint8Array): Promise<{ id: string; path: string }> {
    const q = `${owner}&name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`;
    const r = await fetch(`${this.origin}/api/uploads?${q}`, {
      method: "POST",
      headers: { "x-kitespan": "1", "content-type": "application/octet-stream", origin: this.origin },
      body,
    });
    if (r.status !== 201) throw new Error(`the upload failed: ${r.status}`);
    return ((await r.json()) as { upload: { id: string; path: string } }).upload;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// A page's socket

export type Frame = Record<string, any>;

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]/g;

export const rid = (): string => crypto.randomUUID();

export class Page {
  readonly frames: Frame[] = [];
  readonly bytes: Uint8Array[] = [];
  rows: ChatRow[] = [];
  closed = false;

  private constructor(readonly ws: WebSocket) {
    ws.binaryType = "arraybuffer";
    ws.onmessage = (m) => {
      if (typeof m.data === "string") {
        const f = JSON.parse(m.data) as Frame;
        this.frames.push(f);
        if (f.t === "chats") this.rows = applyChatsFrame(this.rows, f as ChatsFrame);
      } else {
        const chunk = new Uint8Array(m.data as ArrayBuffer);
        this.bytes.push(chunk);
        if (this.terminal) this.answerQueries(chunk);
      }
    };
    ws.onclose = () => {
      this.closed = true;
    };
  }

  /** A Terminal pane's page answers a program's terminal queries, as the page's terminal does. */
  terminal = false;
  private tail = "";

  /**
   * The answers a terminal gives (a cursor position, the device attributes, the keyboard flags, the colours), so a
   * program in the pane that waits for one goes on. Each answer has a form that the shell service counts as a report,
   * not a key.
   */
  private answerQueries(chunk: Uint8Array): void {
    // The last bytes of the previous chunk come first, so a query split across two chunks is seen; one that lay whole
    // in them was answered then.
    const kept = this.tail.length;
    const text = this.tail + Buffer.from(chunk).toString("latin1");
    this.tail = text.slice(-16);
    const answers: string[] = [];
    for (const m of text.matchAll(/\x1b\[6n|\x1b\[0?c|\x1b\[>0?c|\x1b\[\?u|\x1b\](1[01]);\?(\x07|\x1b\\)/g)) {
      const q = m[0];
      if (m.index + q.length <= kept) continue;
      if (q === "\x1b[6n") answers.push("\x1b[1;1R");
      else if (q.startsWith("\x1b[>")) answers.push("\x1b[>0;10;1c");
      else if (q.endsWith("c")) answers.push("\x1b[?62;22c");
      else if (q === "\x1b[?u") answers.push("\x1b[?0u");
      else answers.push(`\x1b]${m[1]};rgb:1e1e/1e1e/2e2e${m[2]}`);
    }
    if (answers.length) this.keys(answers.join(""));
  }

  static open(server: LiveServer, path = "/ws"): Promise<Page> {
    return new Promise((ok, fail) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}${path}`, { headers: { origin: server.origin } });
      const p = new Page(ws);
      ws.onopen = () => ok(p);
      ws.onerror = () => fail(new Error(`the socket on ${path} did not open`));
    });
  }

  send(o: unknown): void {
    this.ws.send(JSON.stringify(o));
  }

  /** Keys for a Terminal pane: one binary frame of UTF-8. */
  keys(s: string): void {
    this.ws.send(new TextEncoder().encode(s));
  }

  async waitFor(pred: (f: Frame) => boolean, ms = 30_000, from = 0, what = "a frame"): Promise<Frame> {
    const end = Date.now() + ms;
    for (;;) {
      const hit = this.frames.slice(from).find(pred);
      if (hit) return hit;
      if (Date.now() > end) {
        const seen = this.frames.slice(from).slice(-12).map((f) => (f.t === "ev" ? `ev:${f.e.k}` : f.t));
        throw new Error(`timed out waiting for ${what}; the last frames: ${seen.join(", ")}`);
      }
      await Bun.sleep(50);
    }
  }

  async request(f: Frame, ms = 30_000): Promise<Frame> {
    const from = this.frames.length;
    this.send(f);
    return this.waitFor((x) => x.t === "ack" && x.rid === f.rid, ms, from, `the ack of ${f.t}`);
  }

  /** The `ev` frames of `chat` from frame index `from`. */
  evs(chat: string, from = 0): Frame[] {
    return this.frames.slice(from).filter((f) => f.t === "ev" && f.chat === chat);
  }

  events(chat: string, from = 0): ChatEvent[] {
    return this.evs(chat, from).map((f) => f.e as ChatEvent);
  }

  /** What the page draws for `chat` since its last attach: the snapshot's history, then the ev frames after it. */
  drawn(chat: string): ChatEvent[] {
    let at = -1;
    this.frames.forEach((f, i) => {
      if (f.t === "snapshot" && f.chat === chat) at = i;
    });
    if (at < 0) return [];
    return [...(this.frames[at]!.history as ChatEvent[]), ...this.events(chat, at + 1)];
  }

  row(chat: string): ChatRow | undefined {
    return this.rows.find((r) => r.chat === chat);
  }

  /** A pane's output from binary frame `from`, without terminal escapes. */
  output(from = 0): string {
    return Buffer.concat(this.bytes.slice(from).map((b) => Buffer.from(b))).toString("utf8").replace(ANSI, "");
  }

  /** The pane's output bytes from binary frame `from`, as they came. */
  outputBytes(from = 0): number {
    return this.bytes.slice(from).reduce((n, b) => n + b.length, 0);
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}

/** A page that said hello: it has `welcome` and the chat list. */
export async function hello(server: LiveServer, tab: string): Promise<{ page: Page; welcome: Frame }> {
  const page = await Page.open(server, "/ws");
  page.send({ t: "hello", v: 1, tab });
  const welcome = await page.waitFor((f) => f.t === "welcome", 10_000, 0, "welcome");
  await page.waitFor((f) => f.t === "chats" && "list" in f, 10_000, 0, "the chat list");
  return { page, welcome };
}

export async function attach(page: Page, chat: string): Promise<{ attached: Frame; snapshot: Frame }> {
  const from = page.frames.length;
  page.send({ t: "attach", chat, since: 0, epoch: null });
  const attached = await page.waitFor((f) => f.t === "attached" && f.chat === chat, 20_000, from, "attached");
  const snapshot = await page.waitFor((f) => f.t === "snapshot" && f.chat === chat, 20_000, from, "the snapshot");
  return { attached, snapshot };
}

/** What a wait does with a card that opens: an answer for it (the answer frame's `answer`). */
export type CardPolicy = (card: Frame) => unknown;

/**
 * new_chat, then attach, then the first turn's end. Every card that opens meanwhile gets `policy`'s answer (by
 * default every tool is denied, so an answer about a file can only come from what the message itself carried).
 */
export async function startChat(
  page: Page,
  project: string,
  text: string,
  picks: Picks,
  opts: { uploads?: string[]; ms?: number; policy?: CardPolicy } = {},
): Promise<{ chat: string; uuid: string; end: ChatEvent & { k: "turn_end" }; from: number }> {
  const uuid = rid();
  const ack = await page.request({ t: "new_chat", rid: rid(), project, uuid, text, picks, uploads: opts.uploads ?? [] });
  if (!ack.ok) throw new Error(`new_chat was refused: ${ack.error?.code}`);
  const chat = ack.result.chat as string;
  const from = page.frames.length;
  await attach(page, chat);
  const end = await waitTurnEnd(page, chat, uuid, from, opts.ms ?? 180_000, cardAnswerer(page, chat, opts.policy ?? allowOnly([])));
  return { chat, uuid, end, from };
}

/** The `turn_end` that answered `uuid` (or the first one after frame `from` when the CLI names no message). */
export async function waitTurnEnd(
  page: Page,
  chat: string,
  uuid: string | null,
  from: number,
  ms: number,
  tick?: (from: number) => void,
): Promise<ChatEvent & { k: "turn_end" }> {
  const hit = await waitEv(page, chat, from, (e) => e.k === "turn_end" && (uuid === null || e.uuids.length === 0 || e.uuids.includes(uuid)), ms, tick, "the turn's end");
  return hit as ChatEvent & { k: "turn_end" };
}

/** The first event of `chat` after frame `from` that `pred` takes; `tick` runs on each poll (the card answerer). */
export async function waitEv(
  page: Page,
  chat: string,
  from: number,
  pred: (e: ChatEvent) => boolean,
  ms: number,
  tick?: (from: number) => void,
  what = "an event",
): Promise<ChatEvent> {
  const end = Date.now() + ms;
  for (;;) {
    tick?.(from);
    const hit = page.events(chat, from).find(pred);
    if (hit) return hit;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}; the last events: ${page.events(chat, from).slice(-12).map((e) => e.k).join(", ")}`);
    await Bun.sleep(100);
  }
}

/** A message on an open chat, and its turn: the events from the send to the turn's end. */
export async function sendTurn(
  page: Page,
  chat: string,
  text: string,
  opts: { ms?: number; policy?: CardPolicy } = {},
): Promise<{ uuid: string; events: ChatEvent[]; end: ChatEvent & { k: "turn_end" }; from: number }> {
  const uuid = rid();
  const from = page.frames.length;
  const ack = await page.request({ t: "send", rid: uuid, chat, uuid, text, draftRev: null, uploads: [] });
  if (!ack.ok) throw new Error(`send was refused: ${ack.error?.code}`);
  const end = await waitTurnEnd(page, chat, uuid, from, opts.ms ?? 180_000, cardAnswerer(page, chat, opts.policy ?? allowOnly([])));
  return { uuid, events: page.events(chat, from), end, from };
}

/**
 * Answers each card that opens on `chat` after frame `from` with `policy`, once; `skip` names cards that the test
 * answers itself. Returns the function that a wait calls on each poll.
 */
export function cardAnswerer(page: Page, chat: string, policy: CardPolicy, skip: readonly string[] = []): (from: number) => void {
  const answered = new Set<string>(skip);
  return (from: number) => {
    for (const f of page.evs(chat, from)) {
      if (f.e.k !== "card_open" || answered.has(f.e.card.id)) continue;
      answered.add(f.e.card.id);
      page.send({ t: "answer", rid: rid(), chat, card: f.e.card.id, answer: policy(f.e.card) });
    }
  };
}

/** Allow once the tools named; deny every other permission; answer a question with each first option. */
export function allowOnly(tools: readonly string[]): CardPolicy {
  return (card) => {
    if (card.kind === "permission")
      return tools.includes(card.toolName) ? { kind: "permission", allow: true, scope: "once" } : { kind: "permission", allow: false, message: "This live test allows no other tool." };
    if (card.kind === "question") return { kind: "question", answers: Object.fromEntries((card.questions as Frame[]).map((q) => [q.question, q.options?.[0]?.label ?? ""])) };
    if (card.kind === "plan") return { kind: "plan", approve: false, feedback: "" };
    if (card.kind === "elicitation") return { kind: "elicitation", action: "decline" };
    return { kind: "dialog", behavior: "cancelled" };
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Reading what a page draws

type Ev<K extends ChatEvent["k"]> = Extract<ChatEvent, { k: K }>;

export function ofKind<K extends ChatEvent["k"]>(events: readonly ChatEvent[], k: K): Ev<K>[] {
  return events.filter((e): e is Ev<K> => e.k === k);
}

/** The text and thinking blocks that events draw, by key, with their whole text (a key drawn twice counts once). */
export function blocks(events: readonly ChatEvent[]): { key: string; kind: string; text: string; parent: string | null }[] {
  const out = new Map<string, { key: string; kind: string; text: string; parent: string | null }>();
  for (const e of events) {
    if (e.k === "block_start") out.set(e.key, { key: e.key, kind: e.kind, text: "", parent: e.parent });
    else if (e.k === "block_delta") {
      const b = out.get(e.key);
      if (b) b.text += e.text;
    } else if (e.k === "block") out.set(e.key, { key: e.key, kind: e.kind, text: e.text, parent: e.parent });
  }
  return [...out.values()];
}

/** The top-level blocks of one reply: those after the user message that holds `needle`, up to the next message. */
export function replyBlocks(events: readonly ChatEvent[], needle: string): { key: string; kind: string; text: string; parent: string | null }[] {
  const at = events.findIndex((e) => e.k === "user" && e.text.includes(needle));
  if (at < 0) return [];
  const next = events.findIndex((e, i) => i > at && e.k === "user");
  return blocks(events.slice(at + 1, next < 0 ? undefined : next)).filter((b) => b.parent === null);
}

export const textOf = (bs: readonly { kind: string; text: string }[]): string =>
  bs
    .filter((b) => b.kind === "text")
    .map((b) => b.text)
    .join("\n");

export function sessionOf(events: readonly ChatEvent[]): Ev<"session"> | undefined {
  return ofKind(events, "session").at(-1);
}

export async function until(pred: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Claude Code's transcripts (read by these opt-in tests only)

export type Rec = Record<string, any>;

export const claudeConfigDir = (): string => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

/** The session's transcript: in the project's own folder, else wherever under projects/ it is; null when none. */
export function findTranscript(session: string, project: string): string | null {
  const base = join(claudeConfigDir(), "projects");
  const direct = join(base, project.replace(/[^a-zA-Z0-9]/g, "-"), `${session}.jsonl`);
  if (existsSync(direct)) return direct;
  try {
    for (const d of readdirSync(base)) {
      const p = join(base, d, `${session}.jsonl`);
      if (existsSync(p)) return p;
    }
  } catch {
    // no projects folder
  }
  return null;
}

export function readRecords(path: string): Rec[] {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: Rec[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r === "object") out.push(r as Rec);
    } catch {
      // a line being written
    }
  }
  return out;
}

/** A user record's own text (a string, or its text blocks); "" for a tool result. */
export function userText(r: Rec): string {
  if (r.type !== "user") return "";
  const c = r.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("\n");
  return "";
}

/** The content blocks of the assistant records that answer the user record holding `needle`. */
export function answerBlocks(records: readonly Rec[], needle: string): Rec[] {
  const at = records.findIndex((r) => r.type === "user" && userText(r).includes(needle));
  if (at < 0) return [];
  const out: Rec[] = [];
  for (let i = at + 1; i < records.length; i++) {
    const r = records[i]!;
    if (r.type === "user" && userText(r) !== "") break;
    if (r.type === "assistant" && Array.isArray(r.message?.content)) out.push(...(r.message.content as Rec[]));
  }
  return out;
}

/** The model that answered the user record holding `needle`, as the transcript names it. */
export function answerModel(records: readonly Rec[], needle: string): string | null {
  const at = records.findIndex((r) => r.type === "user" && userText(r).includes(needle));
  if (at < 0) return null;
  const a = records.slice(at + 1).find((r) => r.type === "assistant");
  return typeof a?.message?.model === "string" ? a.message.model : null;
}

const sha10 = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 10);

/** What the spike's raw check compared (p7), from a session's own request records: hashes and lengths, never text. */
export interface RequestDigest {
  session: string;
  version: string | null;
  /** The folder the session ran in. */
  cwd: string | null;
  entrypoint: string | null;
  permissionMode: string | null;
  model: string | null;
  /** Each system block: its length and its hash. */
  system: [number, string][];
  tools: { count: number; sha: string };
  betas: { count: number; sha: string };
  querySource: string | null;
  effort: string | null;
  thinking: string | null;
  maxTokens: number | null;
}

const MAIN_SOURCES = new Set(["sdk", "repl_main_thread"]);

/** The digest of the session's first main-thread request, or a line that says why there is none. */
export function requestDigest(records: readonly Rec[], session: string): RequestDigest | string {
  const reqs = records.filter((r) => r.type === "api-request");
  if (reqs.length === 0) return `session ${session} has no api-request record: this CLI writes none, so the raw test cannot compare`;
  const req = reqs.find((r) => MAIN_SOURCES.has(String(r.querySource))) ?? reqs[0]!;
  const shape = records.find((r) => r.type === "api-request-shape" && (req.shapeHash === undefined || r.shapeHash === req.shapeHash));
  if (!shape) return `session ${session} has no api-request-shape record for its first request`;
  const user = records.find((r) => r.type === "user" && typeof r.permissionMode === "string") ?? records.find((r) => r.type === "user");
  const system = Array.isArray(shape.shape?.system) ? (shape.shape.system as Rec[]) : [];
  const tools = Array.isArray(shape.shape?.tools) ? (shape.shape.tools as Rec[]) : [];
  const p = (req.params ?? {}) as Rec;
  const rawBetas: unknown = p.betas ?? p.anthropic_beta ?? [];
  const betas = Array.isArray(rawBetas) ? rawBetas.map(String) : typeof rawBetas === "string" ? rawBetas.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const effort = p.output_config?.effort;
  return {
    session,
    version: typeof (shape.version ?? req.version) === "string" ? (shape.version ?? req.version) : null,
    cwd: typeof user?.cwd === "string" ? user.cwd : null,
    entrypoint: typeof user?.entrypoint === "string" ? user.entrypoint : null,
    permissionMode: typeof user?.permissionMode === "string" ? user.permissionMode : null,
    model: typeof p.model === "string" ? p.model : null,
    system: system.map((b) => {
      const t = typeof b?.text === "string" ? b.text : "";
      return [t.length, sha10(t)] as [number, string];
    }),
    tools: { count: tools.length, sha: sha10(tools.map((t) => String(t?.name ?? "")).sort().join(",")) },
    betas: { count: betas.length, sha: sha10([...betas].sort().join(",")) },
    querySource: typeof req.querySource === "string" ? req.querySource : null,
    effort: typeof effort === "string" ? effort : null,
    thinking: typeof p.thinking?.type === "string" ? p.thinking.type : null,
    maxTokens: typeof p.max_tokens === "number" ? p.max_tokens : null,
  };
}

/** The version number in a version line ("2.1.311 (Claude Code)" or "2.1.311"), or null. */
export const versionOf = (s: string | null | undefined): string | null => /\d+\.\d+\.\d+/.exec(s ?? "")?.[0] ?? null;

// ---------------------------------------------------------------------------------------------------------------
// The start environment of a claude that the test runs itself (raw.test.ts's `claude -p`)

const SESSION_MARKERS = ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION"];
const RUNNER = ["NODE", "npm_command", "npm_config_local_prefix", "npm_config_user_agent", "npm_execpath", "npm_lifecycle_event", "npm_lifecycle_script", "npm_node_execpath", "npm_package_json"];

/**
 * The environment as bin/kitespan leaves it for the server (and so for each chat's claude): no variable of a Claude
 * Code session that started the test, of a Claude Desktop host, or of a package runner, and PATH without the runner's
 * leading node_modules/.bin and bun-node folders.
 */
export function cleanStartEnv(base: Record<string, string | undefined>): Record<string, string> {
  const has = (n: string) => typeof base[n] === "string";
  const drop = new Set<string>(CLEAN_ENV.always);
  if (CLEAN_ENV.desktopMarkers.some(has)) for (const n of CLEAN_ENV.desktop) drop.add(n);
  if (SESSION_MARKERS.some(has)) for (const n of CLEAN_ENV.traceAfterSession) drop.add(n);
  const runner = has("npm_lifecycle_event");
  if (runner) for (const n of RUNNER) drop.add(n);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (typeof v !== "string" || drop.has(k)) continue;
    if (CLEAN_ENV.alwaysPrefixes.some((p) => k.startsWith(p))) continue;
    if (runner && k.startsWith("npm_package_")) continue;
    out[k] = v;
  }
  if (runner && out.PATH) {
    const parts = out.PATH.split(":");
    while (parts.length && /(?:\/node_modules\/\.bin|\/bun-node(?:-[0-9a-f]+)?)$/.test(parts[0]!)) parts.shift();
    out.PATH = parts.join(":");
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Test files

/** A solid-colour PNG (the lead's live check B1 used red). */
export function png(r: number, g: number, b: number, w = 64, h = 64): Uint8Array {
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const x of buf) {
      c ^= x;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}

const WORDS = ["LANTERN", "HARBOUR", "OSPREY", "MERIDIAN", "QUARTZ", "COBALT", "KESTREL", "PLOVER", "JUNIPER", "SAFFRON", "TUNDRA", "BASALT"];

/** A word for a check, picked at random, so a reply cannot come from an earlier run. */
export function word(): string {
  return WORDS[Math.floor(Math.random() * WORDS.length)]!;
}

/** A short random tag that marks one message, so its records can be found again. */
export function nonce(): string {
  return crypto.randomUUID().slice(0, 8);
}

// ---------------------------------------------------------------------------------------------------------------
// The worktree test's fixture repository, the search for a planted value, and the Terminal pane's verdict (LV-W4)

/** A new folder of the live tests directly under `parent` (its real path), with makeTemp()'s prefix. */
export function makeTempIn(parent: string, tag: string): string {
  return realpathSync(mkdtempSync(join(realpathSync(parent), `${TEMP_PREFIX}${tag}-`)));
}

/** Remove a folder that makeTempIn(parent) made, with everything in it; any other path stays as it is. */
export function removeTempIn(parent: string, path: string): void {
  const real = ownTemp(path, parent);
  if (real) rmSync(real, { recursive: true, force: true });
}

/**
 * The test's own git in a scratch repository: the user's environment without any GIT_ name, no system or global git
 * config (so no hook, alias or setting of the user's runs or applies), no hook of the repository's, stdin ignored, and
 * a deadline. Its exit code (null: no git, or the deadline) and its output.
 */
export function scratchGit(cwd: string, args: readonly string[]): { code: number | null; out: string } {
  const git = findGit(process.env.PATH ?? "");
  if (!git) return { code: null, out: "" };
  const r = Bun.spawnSync([git, "-c", "core.hooksPath=/dev/null", "-C", cwd, ...args], {
    env: gitEnv(userEnv(), { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
  return { code: r.exitCode, out: r.stdout.toString() };
}

/** The command that the fixture's main checkout denies (LV-W1), and its rule. */
export const DENY_MARKER = "echo kitespan-deny-marker";
export const DENY_RULE = `Bash(${DENY_MARKER}:*)`;

/** The fixed identity of the fixture's one commit. */
const FIXTURE_WHO = ["-c", "user.name=kitespan live test", "-c", "user.email=kitespan-live@example.invalid", "-c", "commit.gpgsign=false"];

/**
 * worktree.test.ts's fixture (FIX-W25b section 2): a new git repository in a new folder directly under `parent` (the
 * scratch project), with one file in one commit by a fixed test identity, and `.claude/settings.json` in the main
 * checkout with one deny rule. `.claude/` is in `.git/info/exclude`, so it is never committed and a worktree made from
 * HEAD has no copy of it. removeTempIn(parent, root) removes it. Its real path and its commit.
 */
export function makeFixture(parent: string): { root: string; head: string } {
  const root = makeTempIn(parent, "worktree");
  const git = (what: string, args: string[]) => {
    const r = scratchGit(root, args);
    if (r.code !== 0) throw new Error(`git ${what} failed in the fixture (exit ${r.code})`);
    return r.out.trim();
  };
  try {
    git("init", ["-c", "init.defaultBranch=main", "init", "--quiet"]);
    writeFileSync(join(root, "README.md"), "A scratch repository of kitespan's live worktree test.\n");
    git("add", ["add", "README.md"]);
    git("commit", [...FIXTURE_WHO, "commit", "--quiet", "-m", "The fixture's one commit"]);
    mkdirSync(join(root, ".git", "info"), { recursive: true });
    appendFileSync(join(root, ".git", "info", "exclude"), "\n.claude/\n");
    mkdirSync(join(root, ".claude"));
    writeFileSync(join(root, ".claude", "settings.json"), `${JSON.stringify({ permissions: { deny: [DENY_RULE] } }, null, 2)}\n`);
    return { root, head: git("rev-parse", ["rev-parse", "HEAD"]) };
  } catch (e) {
    removeTempIn(parent, root);
    throw e;
  }
}

/**
 * The files under `dir` (paths relative to it, in order) whose bytes hold `needle`, never through a link; `skip`
 * leaves a relative path out. A file that cannot be read counts as a hit, so the check fails closed. The needle itself
 * is never returned.
 */
export function filesHolding(dir: string, needle: string, skip: (rel: string) => boolean = () => false): string[] {
  const want = Buffer.from(needle, "utf8");
  const out: string[] = [];
  const walk = (rel: string) => {
    let names: string[];
    try {
      names = readdirSync(rel ? join(dir, rel) : dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const r = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = lstatSync(join(dir, r));
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(r);
      else if (st.isFile() && !skip(r)) {
        try {
          if (readFileSync(join(dir, r)).includes(want)) out.push(r);
        } catch {
          out.push(`${r} (unreadable)`);
        }
      }
    }
  };
  if (want.length > 0) walk("");
  return out;
}

/** How many of a page's frames hold `needle`: its JSON frames, and its pane output as one text (a value may span frames). */
export function framesHolding(page: Pick<Page, "frames" | "bytes">, needle: string): number {
  const text = page.frames.filter((f) => JSON.stringify(f).includes(needle)).length;
  const pane = Buffer.concat(page.bytes.map((b) => Buffer.from(b))).includes(Buffer.from(needle, "utf8")) ? 1 : 0;
  return text + pane;
}

/**
 * A pane's output as the screen reads: a cursor move forward (CSI n C, which Claude Code 2.1.317 draws in place of a
 * space) becomes that many spaces, and every other escape sequence goes.
 */
export function screenText(output: string): string {
  return output
    .replace(/\x1b\[(\d*)C/g, (_, n: string) => " ".repeat(Math.min(Number(n || "1"), 400)))
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "")
    .replace(/\x1b[78=>]/g, "");
}

/**
 * Claude Code's question whether to trust a folder, on the screen's text (screenText): resume.test.ts's words and
 * 2.1.317's ("Quick safety check: Is this a project you created or one you trust?", "Yes, I trust this folder"). A
 * test never answers it for the user.
 */
export const TRUST_QUESTION = /trust\s+(?:the\s+files\s+in\s+)?this\s+folder|Do\s+you\s+trust|Yes,\s+proceed|a\s+project\s+you\s+created\s+or\s+one\s+you\s+trust/i;

/**
 * Whether a pane's output shows the trust question. Claude Code 2.1.317 draws the spaces between its words by moving
 * the cursor in more than one way, so the words are matched with every space and escape sequence taken out.
 */
export function trustAsked(output: string): boolean {
  const compact = screenText(output).replace(/\s+/g, "");
  return TRUST_QUESTION.test(screenText(output)) || /trustthisfolder|trustthefilesinthisfolder|Doyoutrust|Yes,proceed|aprojectyoucreatedoroneyoutrust/i.test(compact);
}

/** A line of the CLI that says it refused: an `error:` line, an unknown option, a session it cannot find. */
const CLI_ERROR = /(?:^|[^A-Za-z])(error: [^\r\n]+|unknown option[^\r\n]*|No conversation found[^\r\n]*)/i;

/**
 * The first error line in a pane's output, or null: its URLs as "<url>", each provider ARN as "[an ARN]" and each run
 * of 12 digits (an account id) as "<id>" (row 95: the line is logged and copied into L28), then cut to 160 characters.
 */
export function paneError(output: string): string | null {
  const m = CLI_ERROR.exec(screenText(output));
  return m ? maskArns(m[1]!.replace(/\bhttps?:\/\/\S+/g, "<url>")).replace(/\d{12,}/g, "<id>").trim().slice(0, 160) : null;
}

/**
 * LV-W4's verdict on one resume command typed in a Terminal pane (FIX-W25b section 2): "accepted" when the pane's
 * claude started (`seen`), its Claude Code session record named the chat's session (`record`) and no error line showed;
 * else why not, in a few words.
 */
export function paneVerdict(o: { seen: boolean; output: string; record: string | null; session: string }): string {
  const err = paneError(o.output);
  if (err !== null) return `refused (${err})`;
  if (trustAsked(o.output)) return "asked whether to trust the folder";
  if (!o.seen) return "no claude started";
  if (o.record === null) return "no session record within 20 s";
  if (o.record !== o.session) return "its session record names another session";
  return "accepted";
}

/** The one line that the lead copies into L28: the CLI's version and each command's verdict. */
export function l28Line(version: string | null, plain: string, flagged: string): string {
  return `LV-W4 on Claude Code ${version ?? "(version unknown)"}: \`cd <worktree> && claude --resume <id>\`: ${plain}; with \`--project-config-root <project folder>\`: ${flagged}.`;
}
