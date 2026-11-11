// A fake Claude Code CLI for tests: the Agent SDK spawns it as `pathToClaudeCodeExecutable` (through the small `claude`
// script that install.ts writes into a mkdtemp PATH), and it speaks the CLI's stream-json protocol on stdin and stdout.
// It answers the SDK's control requests, asks the SDK's callbacks (can_use_tool, elicitation, request_user_dialog) and
// replays a fixture: one list of steps per user message that queries. It never calls a model and reads nothing of the
// user's own Claude Code. Every message, control request and answer it sees goes to the trace file (JSON lines), so a
// test can assert what the driver sent; the start line holds the arguments and the environment's names, never values.
// R131: it also answers two of Claude Code's scripting commands, `agents --json [--all]` and `stop <id>`, from the
// fixture, before any stream-json start (each with a trace line of its own); a verb that the fixture's `verbs` leaves
// out goes to the root command as on a CLI without it, where words are a print-mode prompt (traced, never a model call).
//
//   bun fake-claude.ts --fixture <file.json> --trace <file.jsonl> [the SDK's CLI arguments]

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { longReply, pacedOf } from "./long-reply";

type Json = Record<string, unknown>;

/** One step of a turn. */
export type Step =
  | { emit: Json }
  /** A whole assistant message, streamed the way the CLI streams it (see say()). */
  | { say: Say }
  | { sleep: number }
  /** A control request to the SDK; `then` picks the next steps by the answer (allow, deny, accept, ...). */
  | { ask: Json; then?: Record<string, Step[]>; wait?: boolean }
  /** The CLI's replay of the user message that started this turn (with its uuid and isReplay). */
  | { echoUser: true }
  /** End the process with this code, after writing `stderr` lines. */
  | { exit: number; stderr?: string[] }
  /** The foreground task of a tool call that a `say` step before it made (see TaskStep). */
  | { task: TaskStep }
  /** U1: change files of the fake's folder (the chat's), as a tool of the turn would (see FileOp). */
  | { files: FileOp[] };

/**
 * U1: one change of a file in the fake's own folder (its working folder, the chat's): a path relative to it, never
 * absolute and with no `..` segment (refused: the step writes a trace line and changes nothing). `bytes` writes that
 * many bytes: NUL-filled for a binary file, else lines of text (a large or long file). Folders are made as needed.
 */
export type FileOp =
  | { write: string; text: string }
  | { write: string; bytes: number; binary?: boolean }
  | { write: string; lines: number; prefix?: string }
  | { append: string; text: string }
  | { rm: string }
  | { mv: [string, string] };

/**
 * A Bash command or a subagent that a main-thread tool call runs in the foreground, as Claude Code 2.1.317 runs one
 * (the lead's live probe, LIVE-NOTES items 15 and 16): `system/task_started` after `startMs` (about 4 s for Bash on
 * the probe's host), then after `runMs` the task's end (task_notification) and the call's tool_result. A
 * `background_tasks` request while it runs, after its task_started, moves it: task_updated, background_tasks_changed,
 * and the call's tool_result at once (for Bash, Claude Code's own background line; for a subagent, a line of the
 * fake's own), so the turn goes on; the work ends `runMs` after its start as a background task, whose notification
 * starts a turn of its own (Fixture.notifyTurn). Before its task_started the request answers true and moves nothing.
 * An interrupt stops it with the turn.
 */
export interface TaskStep {
  /** The tool_use block that runs it. */
  toolUseId: string;
  taskId?: string;
  /** Default local_bash. */
  type?: "local_bash" | "local_agent";
  description?: string;
  /** Before task_started (default 50 ms). */
  startMs?: number;
  /** From task_started to the work's end. */
  runMs: number;
  /** The tool_result's text when the work ends in the foreground (default ""). */
  output?: string;
}

export interface Say {
  /** The API message id (`msg_...`). */
  id: string;
  thinking?: string;
  text?: string;
  /** More text blocks after the tools (the "thinking, text, tool_use, text" shape). */
  textAfter?: string;
  tools?: { id: string; name: string; input: Json }[];
  /** A subagent's message: no stream events, only whole records with this parent_tool_use_id. */
  parent?: string;
  /** One record holding every block, instead of one record per block. */
  oneRecord?: boolean;
  /** Pieces per text or thinking block in the stream (default 2). */
  chunks?: number;
  /** Wait this many milliseconds after each piece of a text or thinking block (a slow stream; default none). */
  paceMs?: number;
}

export interface Turn {
  /** Emit the per-turn system/init first (default true). */
  init?: boolean;
  steps: Step[];
  /**
   * At each main-thread tool_result of this turn, take every user message that waits in the queue into the turn, as
   * Claude Code does between tool rounds (live LIVE-NOTES item 15): each leaves the queue (an interrupt's receipt no
   * longer names it, cancel_async_message no longer finds it), goes into the transcript after the result, and is
   * listed in the result's user_message_uuids; none runs as a turn of its own. As a typed prompt's turn does, the turn
   * stamps no later frame with it (sdk.d.ts 0.3.312 line 3716). Default false: a queued message waits for the turn's end.
   */
  fold?: boolean;
}

export interface Fixture {
  /** `claude --version` output. */
  version?: string;
  model?: string;
  /** The initialize response (commands, models, account, ...), merged over the defaults. */
  initialize?: Json;
  /** Fields merged into every system/init. */
  initMessage?: Json;
  /** Canned control responses by subtype. */
  control?: Record<string, Json>;
  /** Control subtypes answered with an error, as the CLI answers a request it refuses. */
  refuse?: string[];
  /** Row 94: get_context_usage's maxTokens by the model in use (200,000 for one not named). */
  contextWindows?: Record<string, number>;
  /** Row 94: models in use for which get_context_usage answers an error. */
  contextRefusedFor?: string[];
  /** Row 94: answer each get_context_usage this many milliseconds late (the short read's cap). */
  contextDelayMs?: number;
  /** Steps emitted right after the initialize response (SessionStart hooks, for example). */
  onStart?: Step[];
  /** Answer the initialize request this many milliseconds late (a slow start; the short command-list read's cap). */
  initializeDelayMs?: number;
  turns?: Turn[];
  /**
   * Turns picked by the user's text: the first key that the message's text contains wins over `turns` (a scripted
   * click-through sends "subagent", "question", ... and gets that turn). Keys are tried in their order.
   */
  turnsByText?: Record<string, Turn>;
  /** The turn used once `turns` runs out. */
  defaultTurn?: Turn;
  /** Steps that end an interrupted turn (default: an error_during_execution result). */
  onInterrupt?: Step[];
  /** The turn that a background task's notification starts once it ends (default: one short reply). */
  notifyTurn?: Turn;
  /** Session ids whose transcript "exists": a start with `--session-id` for one of them is refused, as the CLI does. */
  inUse?: string[];
  /**
   * Write these lines to stderr and exit at start (a crash before init); `stderrParts` are written as they are, each
   * in a write of its own a moment after the last, so each reaches the host as a chunk of its own.
   */
  startup?: { stderr?: string[]; stderrParts?: string[]; exitCode?: number };
  /**
   * Refuse the start as Claude Code refuses a resume it cannot run (W5): the error line on stderr, then an
   * `error_during_execution` result with `startup_failure_reason` and that line in `errors`, then exit 1. Only for a
   * start with `--resume` when `onResume` is true.
   */
  startupFailure?: { reason: string; errors?: string[]; onResume?: boolean };
  /**
   * Test-only (D60): the start line also holds `envHashes`, a SHA-256 in hex of each named variable's value (null when
   * it is not set), so a test can prove a value arrived without any value in the trace.
   */
  envHash?: string[];
  /** Keep running after stdin ends (to test the SDK's SIGTERM); default: exit 0 at once. */
  ignoreStdinEnd?: boolean;
  /** Keep running after a SIGTERM too, so only a SIGKILL ends it (the restart's check of its children, S11). */
  ignoreSigterm?: boolean;
  /**
   * After stdin ends, finish the turn in flight (its records go to the transcript) and exit then, dropping what waits
   * in its own queue, as Claude Code 2.1.317 does when its host is killed (the lead's live checks LV-R2 and LV-R4); with
   * no turn in flight, exit at once. A write to a closed standard output is ignored.
   */
  finishTurnOnStdinEnd?: boolean;
  /**
   * Write the session's transcript as the CLI does: `$CLAUDE_CONFIG_DIR/projects/<folder>/<session>.jsonl`, one line
   * per user message and per main-thread assistant or tool-result record. Only when CLAUDE_CONFIG_DIR is set to an
   * absolute path (a test's scratch folder), so the user's own Claude Code folder is never written.
   */
  transcript?: boolean;
  /**
   * The id a `!` record goes into the transcript under: `own`, an id of the CLI's own, as the real CLI writes it (a
   * live check found the host's uuid in no transcript; the default), or `host`, the host's uuid.
   */
  bashRecordId?: "own" | "host";
  /**
   * R124: how a `side_question` control request (the SDK's askSideQuestion) is answered: a
   * `system/control_request_progress` with status `started` at once, then after the delay (default `sideDelayMs`, else
   * 30 ms) the answer. `sideByText`: the first key that the question contains picks its own way; `side` is the way of
   * every other question; with neither, the answer names the question and the history it came with. It answers while
   * a turn runs (which goes on) and while none does, and writes nothing to the transcript. A `control_cancel_request`
   * for one that has not answered gets the CLI's error, "Side question cancelled".
   */
  side?: SideWay;
  sideByText?: Record<string, SideWay>;
  sideDelayMs?: number;
  /**
   * R127: how an initialize request that carries the host's trust attestation (`workspaceTrust: {accepted: true,
   * directory}`, the SDK's undocumented option) is answered. By default as the CLI's schema says: when the directory
   * is the session's working directory (its real path) and not the home folder, `workspace_trust_recorded: true` and a
   * `trust_recorded` trace line (the fake's stand-in for Claude Code's own record); else false. An initialize without
   * the attestation gets no such field, as the CLI answers. Never reads or writes any file of the user's.
   */
  workspaceTrust?: TrustWay;
  /**
   * R131: `claude agents --json [--all]` prints these rows as Claude Code 2.1.318 does (`JSON.stringify(rows, null, 2)`
   * and a line feed), exits 0, and writes an `agents` trace line with its arguments, folder, process group and the
   * environment's names. A background row that a `stop` of this fake stopped is listed as stopped, with no process.
   * Absent: none.
   */
  agents?: Json[];
  agentsWay?: AgentsWay;
  /**
   * R131: `claude stop <id>`: a background row of `agents` with that id is known, and answers "stopped <id>" (exit 0);
   * any other id gets Claude Code's "No job matching '<id>'. Run 'claude agents' to list running sessions." on stderr
   * (exit 1). Each run writes a `stop` trace line with its arguments as it starts, and a `stop_answer` line with its
   * answer.
   */
  stopWay?: StopWay;
  /**
   * R131: the verbs of `agents` and `stop` that this CLI picks out before its root command parses (Claude Code 2.1.318
   * has both; default both). A verb not listed falls through to the root command, as on a CLI without it: there an
   * option the root does not know is commander's "unknown option" error (exit 1), and plain words are the prompt of a
   * print-mode turn (stdout is a pipe), which writes a `prompt` trace line with its arguments and folder and answers one
   * line (exit 0). Never a model call.
   */
  verbs?: ("agents" | "stop")[];
}

/** R131: how `claude agents --json` answers (Fixture.agentsWay). */
export interface AgentsWay {
  /** Print this instead of the rows (bad JSON, for one). */
  raw?: string;
  /** Pad the answer with spaces to this many bytes (an answer over the host's cap). */
  padBytes?: number;
  /** Answer this many milliseconds late (the host's timeout). */
  delayMs?: number;
  /** Exit with this code after the answer (default 0). */
  exitCode?: number;
  /** Agent view is off: Claude Code's one line on stderr, nothing on stdout, exit 0. */
  off?: boolean;
}

/** R131: how `claude stop <id>` answers a known id (Fixture.stopWay). */
export interface StopWay {
  /** `unconfirmed`: Claude Code's "couldn't confirm <id> was stopped" (exit 1). Default `stopped`. */
  answer?: "stopped" | "unconfirmed";
  /** Answer this many milliseconds late. */
  delayMs?: number;
  /** The job had a worktree of its own: Claude Code's two dim lines after "stopped <id>". */
  worktree?: string;
}

/** R127: one way of answering the trust attestation (Fixture.workspaceTrust). */
export interface TrustWay {
  /** The answer's `workspace_trust_recorded`: true, false, or null for none (absent, as an older CLI answers). */
  recorded?: boolean | null;
  /** Answer the attested initialize this many milliseconds late (the trust start's cap). */
  delayMs?: number;
  /** Exit with this code after the delay, before answering (a CLI that ends at start). */
  exitCode?: number;
}

/** R124: one way of answering a side question (Fixture.side). */
export interface SideWay {
  delayMs?: number;
  /**
   * The answer's text, with `$LAST_QUESTION` as the history's last question (so a test sees the history read); null:
   * a null response (the CLI's "No response received"); absent: the default text.
   */
  response?: string | null;
  synthetic?: boolean;
  /** A refusal fallback, in the CLI's shape (the SDK passes it on as `refusalFallback`). */
  refusal?: { original_model: string; fallback_model: string; content: string };
  /** `api_retry` progress, each sent before the answer, evenly through the delay. */
  retries?: { attempt: number; max_retries: number; retry_delay_ms: number; error_status?: number | null }[];
  /** Answer this error instead (the CLI's words, for example "Failed to get response"). */
  error?: string;
}

// ---------------------------------------------------------------------------------------------------------------

const argv = process.argv.slice(2);
function takeOwn(name: string): string | null {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1] ?? null;
  argv.splice(i, 2);
  return v;
}
const fixturePath = takeOwn("--fixture");
const tracePath = takeOwn("--trace");
const fixture: Fixture = fixturePath ? (JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture) : {};
const VERSION = fixture.version ?? "2.1.312 (Claude Code)";

function trace(o: Json): void {
  if (!tracePath) return;
  try {
    appendFileSync(tracePath, JSON.stringify({ ...o, at: Date.now() }) + "\n");
  } catch {}
}

function arg(name: string): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === name) return argv[i + 1] ?? null;
    if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
  }
  return null;
}
const flag = (name: string) => argv.includes(name);

if (flag("--version")) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

// R131: Claude Code's scripting commands for background sessions, answered before any stream-json start: `agents
// --json` (the list) and `stop <id>`. Each run writes one trace line with its arguments, its folder, its process group
// and the environment's names (never a value).
if (argv[0] === "agents" || argv[0] === "stop") {
  if ((fixture.verbs ?? ["agents", "stop"]).includes(argv[0])) await scriptCommand(argv[0]);
  else await rootCommand();
}

/**
 * R131: a verb this CLI does not pick out, at its root command (Fixture.verbs): an option the root does not know is
 * commander's error; else the words are a print-mode prompt (stdout is not a terminal), traced as `prompt`.
 */
async function rootCommand(): Promise<never> {
  const unknown = argv.find((a) => a.startsWith("-"));
  if (unknown) {
    trace({ t: "unknown_option", args: argv, cwd: process.cwd() });
    process.stderr.write(`error: unknown option '${unknown}'\n`, () => process.exit(1));
  } else {
    trace({ t: "prompt", args: argv, cwd: process.cwd(), print: !process.stdout.isTTY });
    process.stdout.write("I can help with that.\n", () => process.exit(0));
  }
  return new Promise<never>(() => {});
}

/** Field 5 of /proc/self/stat (the process group), or null without /proc. */
function processGroup(): number | null {
  try {
    const s = readFileSync("/proc/self/stat", "utf8");
    return Number(s.slice(s.lastIndexOf(")") + 2).split(" ")[2]);
  } catch {
    return null;
  }
}

/** The ids this fake's own `stop` stopped (its trace), which the list then shows as stopped. */
function stoppedIds(): Set<string> {
  const out = new Set<string>();
  if (!tracePath || !existsSync(tracePath)) return out;
  for (const l of readFileSync(tracePath, "utf8").split("\n")) {
    try {
      const o = JSON.parse(l) as Json;
      if (o.t === "stop_answer" && o.answer === "stopped" && typeof o.id === "string") out.add(o.id);
    } catch {}
  }
  return out;
}

async function scriptCommand(cmd: "agents" | "stop"): Promise<never> {
  const base = { args: argv, cwd: process.cwd(), pid: process.pid, pgrp: processGroup(), envNames: Object.keys(process.env).sort() };
  const rows = (fixture.agents ?? []).map((r) => ({ ...r }));
  const done = (out: string, err: string, code: number): Promise<never> =>
    new Promise<never>(() => {
      process.stderr.write(err, () => process.stdout.write(out, () => process.exit(code)));
    });
  if (cmd === "agents") {
    trace({ t: "agents", ...base });
    const way = fixture.agentsWay ?? {};
    if (way.delayMs) await Bun.sleep(way.delayMs);
    if (way.off) return done("", "'claude agents --json' is not available in this environment.\n", 0);
    const stopped = stoppedIds();
    for (const r of rows) {
      if (r.kind === "background" && typeof r.id === "string" && stopped.has(r.id)) {
        delete r.pid;
        delete r.status;
        delete r.waitingFor;
        r.state = "stopped";
      }
    }
    let out = way.raw ?? `${JSON.stringify(rows, null, 2)}\n`;
    if (way.padBytes && out.length < way.padBytes) out = out.replace(/\n$/, "") + " ".repeat(way.padBytes - out.length) + "\n";
    return done(out, "", way.exitCode ?? 0);
  }
  const id = argv[1] ?? "";
  trace({ t: "stop", ...base, id });
  const known = rows.some((r) => r.kind === "background" && r.id === id);
  const way = fixture.stopWay ?? {};
  if (way.delayMs) await Bun.sleep(way.delayMs);
  if (!known) {
    trace({ t: "stop_answer", id, answer: "not_found" });
    return done("", `No job matching '${id}'. Run 'claude agents' to list running sessions.\n`, 1);
  }
  if (way.answer === "unconfirmed") {
    trace({ t: "stop_answer", id, answer: "unconfirmed" });
    return done("", `couldn't confirm ${id} was stopped — the background service may be restarting. Try again in a moment.\n`, 1);
  }
  trace({ t: "stop_answer", id, answer: "stopped" });
  const tree = way.worktree ? `\x1b[2m  worktree retained at ${way.worktree}\x1b[22m\n\x1b[2m  run 'claude rm ${id}' to remove worktree and job state\x1b[22m\n` : "";
  return done(`stopped ${id}\n${tree}`, "", 0);
}

const envHashes = fixture.envHash
  ? Object.fromEntries(fixture.envHash.map((n) => [n, typeof process.env[n] === "string" ? new Bun.CryptoHasher("sha256").update(process.env[n]!).digest("hex") : null]))
  : undefined;
trace({ t: "start", pid: process.pid, args: argv, envNames: Object.keys(process.env).sort(), cwd: process.cwd(), ...(envHashes ? { envHashes } : {}) });

const askedSession = arg("--session-id");
const resume = arg("--resume");
if (askedSession && resume && !flag("--fork-session")) {
  process.stderr.write("Error: --session-id can only be used with --continue or --resume if --fork-session is also specified.\n");
  process.exit(1);
}
if (askedSession && (fixture.inUse ?? []).includes(askedSession)) {
  process.stderr.write(`Error: Session ID ${askedSession} is already in use.\n`);
  process.exit(1);
}
if (fixture.startup) {
  for (const l of fixture.startup.stderr ?? []) process.stderr.write(`${l}\n`);
  for (const part of fixture.startup.stderrParts ?? []) {
    await new Promise<void>((done) => process.stderr.write(part, () => done()));
    await Bun.sleep(80);
  }
  process.exit(fixture.startup.exitCode ?? 1);
}
if (fixture.startupFailure && (!fixture.startupFailure.onResume || resume)) {
  const errors = fixture.startupFailure.errors ?? [];
  for (const l of errors) process.stderr.write(`${l}\n`);
  const result = {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors,
    startup_failure_reason: fixture.startupFailure.reason,
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 0,
    stop_reason: null,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    session_id: askedSession ?? resume ?? randomUUID(),
    uuid: randomUUID(),
  };
  trace({ t: "startup_failure", reason: fixture.startupFailure.reason });
  process.stdout.write(JSON.stringify(result) + "\n", () => process.exit(1));
  // Nothing else runs: the process ends once the result is out.
  await new Promise<never>(() => {});
}

const sessionId = askedSession ?? resume ?? randomUUID();
let model: string = arg("--model") ?? fixture.model ?? "claude-fake-1";
let mode: string = arg("--permission-mode") ?? "default";

function write(m: Json): void {
  try {
    process.stdout.write(JSON.stringify(m) + "\n");
  } catch {
    // the host is gone (finishTurnOnStdinEnd)
  }
}
if (fixture.finishTurnOnStdinEnd) process.stdout.on("error", () => {});

// The transcript (fixture.transcript): the folder name is the cwd with every character outside [a-zA-Z0-9] as "-".
const configDir = process.env.CLAUDE_CONFIG_DIR;
const transcriptPath =
  fixture.transcript && configDir && isAbsolute(configDir)
    ? join(configDir, "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`)
    : null;
/** The parentUuid chain goes on from the last line when a resumed session's transcript exists. */
let lastRecord: string | null = (() => {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  const lines = readFileSync(transcriptPath, "utf8").split("\n").filter((l) => l.trim());
  try {
    return (JSON.parse(lines[lines.length - 1] ?? "null") as Json | null)?.uuid as string | null;
  } catch {
    return null;
  }
})();

function record(type: "user" | "assistant", uuid: string, message: unknown): void {
  if (!transcriptPath) return;
  mkdirSync(dirname(transcriptPath), { recursive: true });
  // A `!` command's record goes in under an id of the CLI's own, never the host's uuid, as the real CLI writes it (a
  // live check found the host's uuid in no transcript); every other user message keeps the host's uuid.
  const ownId = (fixture.bashRecordId ?? "own") === "own";
  const id = type === "user" && ownId && textOf(message).startsWith("<bash-input>") ? randomUUID() : uuid;
  const line = {
    type,
    message,
    uuid: id,
    parentUuid: lastRecord,
    sessionId,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
    isSidechain: false,
    userType: "external",
    entrypoint: "sdk-ts",
    version: VERSION.split(" ")[0],
  };
  appendFileSync(transcriptPath, JSON.stringify(line) + "\n");
  lastRecord = id;
}

interface QueuedUser {
  uuid: string;
  message: unknown;
  /** A background task's notification, which starts a turn of its own: no host uuid is stamped or listed for it. */
  meta?: boolean;
}
let current: QueuedUser | null = null;
/** The turn in flight. */
let currentTurn: Turn | null = null;
/** The user messages that the turn in flight took in at a tool boundary (Turn.fold). */
let folded: string[] = [];
/** The turn in flight stamped its first stream event and its first assistant record (sdk.d.ts 0.3.312 line 3716). */
const stamped = { stream: false, assistant: false };

function fill(v: unknown): unknown {
  if (typeof v === "string") {
    if (v === "$SESSION") return sessionId;
    if (v === "$USER_UUID") return current?.uuid ?? null;
    if (v === "$MODEL") return model;
    // U1: the fake's own folder (the chat's), for a file tool's absolute path.
    if (v.includes("$CWD")) return v.replaceAll("$CWD", process.cwd());
    // Inside a longer string (`toolu_$USER_UUID`): ids of their own on every run of a turn.
    if (v.includes("$USER_UUID") && current) return v.replaceAll("$USER_UUID", current.uuid.replace(/-/g, ""));
    return v;
  }
  if (Array.isArray(v)) return v.map(fill);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
  return v;
}

/** The main thread's tool calls of the turn in flight that have no result yet (for the line a Stop writes). */
const openTools = new Set<string>();

function noteTools(m: Json): void {
  if ((m.parent_tool_use_id ?? null) !== null) return;
  const content = (m.message as Json | undefined)?.content;
  if (!Array.isArray(content)) return;
  for (const b of content as Json[]) {
    if (m.type === "assistant" && b?.type === "tool_use" && typeof b.id === "string") openTools.add(b.id);
    if (m.type === "user" && b?.type === "tool_result" && typeof b.tool_use_id === "string") openTools.delete(b.tool_use_id);
  }
}

function emit(raw: Json): void {
  const m = fill(raw) as Json;
  noteTools(m);
  if (m.session_id === undefined) m.session_id = sessionId;
  if (m.uuid === undefined) m.uuid = randomUUID();
  if (m.type === "result") {
    m.duration_ms ??= 12;
    m.duration_api_ms ??= 10;
    m.num_turns ??= 1;
    m.is_error ??= false;
    m.subtype ??= "success";
    if (m.subtype === "success") m.result ??= "";
    else m.errors ??= [];
    m.stop_reason ??= null;
    m.total_cost_usd ??= 0;
    m.usage ??= { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    m.modelUsage ??= {};
    m.permission_denials ??= [];
    const took = [...(current && !current.meta ? [current.uuid] : []), ...folded];
    if (took.length && m.user_message_uuid === undefined) m.user_message_uuid = current && !current.meta ? current.uuid : took[took.length - 1];
    if (took.length && m.user_message_uuids === undefined) m.user_message_uuids = took;
  }
  const main = (m.parent_tool_use_id ?? null) === null;
  // A typed prompt's turn stamps its uuid on its first stream event and its first assistant record, once each.
  if (current && !current.meta && main) {
    const kind = m.type === "stream_event" && (m.event as Json | undefined)?.type !== "ping" ? "stream" : m.type === "assistant" ? "assistant" : null;
    if (kind && !stamped[kind]) {
      stamped[kind] = true;
      m.user_message_uuid ??= current.uuid;
      m.user_message_uuids ??= [current.uuid];
    }
  }
  if ((m.type === "assistant" || (m.type === "user" && m.isReplay !== true)) && main) {
    record(m.type, m.uuid as string, m.message);
  }
  write(m);
  if (m.type === "user" && main && currentTurn?.fold && hasToolResult(m.message)) foldQueue();
}

function hasToolResult(message: unknown): boolean {
  const c = (message as Json | undefined)?.content;
  return Array.isArray(c) && c.some((b) => (b as Json | null)?.type === "tool_result");
}

/** Turn.fold: what waits in the queue goes into the turn in flight, at this tool boundary. */
function foldQueue(): void {
  for (let i = 0; i < queue.length; ) {
    const u = queue[i]!;
    if (u.meta) {
      i++;
      continue;
    }
    queue.splice(i, 1);
    folded.push(u.uuid);
    record("user", u.uuid, u.message);
    trace({ t: "fold", uuid: u.uuid });
  }
}

function initMessage(): Json {
  const init = initializeResponse();
  return {
    type: "system",
    subtype: "init",
    cwd: process.cwd(),
    session_id: sessionId,
    tools: ["Bash", "Read", "Edit", "Write", "Agent", "AskUserQuestion", "ExitPlanMode", "Workflow"],
    mcp_servers: [],
    model,
    permissionMode: mode,
    slash_commands: ((init.commands as Json[]) ?? []).map((c) => c.name),
    apiKeySource: "none",
    claude_code_version: VERSION.split(" ")[0],
    output_style: "default",
    skills: [],
    plugins: [],
    capabilities: ["interrupt_receipt_v1"],
    ...(fixture.initMessage ?? {}),
  };
}

function initializeResponse(): Json {
  return {
    commands: [
      { name: "compact", description: "Clear conversation history but keep a summary in context", argumentHint: "", builtin: true },
      { name: "context", description: "Show current context usage", argumentHint: "", builtin: true },
      { name: "review-notes", description: "A command of the user's own", argumentHint: "[file]", aliases: ["rn"] },
    ],
    agents: [{ name: "general-purpose", description: "General-purpose agent" }],
    output_style: "default",
    available_output_styles: ["default"],
    models: [
      { value: "default", displayName: "Default (recommended)", description: "Use the default model", supportedEffortLevels: ["low", "medium", "high"] },
      { value: "claude-fake-1", displayName: "Fake 1", description: "A fake model row", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"], supportsAutoMode: true },
    ],
    account: { apiProvider: "firstParty" },
    ...(fixture.initialize ?? {}),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Streaming one assistant message the way the CLI does: per block, its stream events and then a record of its own.

function pieces(s: string, n: number): string[] {
  if (!s) return [];
  const size = Math.max(1, Math.ceil(s.length / Math.max(1, n)));
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

async function say(s: Say, signal: AbortSignal): Promise<void> {
  const blocks: Json[] = [];
  if (s.thinking) blocks.push({ type: "thinking", thinking: s.thinking, signature: "fake-signature" });
  if (s.text) blocks.push({ type: "text", text: s.text });
  for (const t of s.tools ?? []) blocks.push({ type: "tool_use", id: t.id, name: t.name, input: t.input });
  if (s.textAfter) blocks.push({ type: "text", text: s.textAfter });
  const parent = s.parent ?? null;
  const record = (content: Json[]): Json => ({
    type: "assistant",
    message: { id: s.id, type: "message", role: "assistant", model, content, stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
    parent_tool_use_id: parent,
  });
  if (parent) {
    // Subagents: whole records only (forwardSubagentText), one per block unless oneRecord.
    if (s.oneRecord) emit(record(blocks));
    else for (const b of blocks) emit(record([b]));
    return;
  }
  const n = s.chunks ?? 2;
  const ev = (event: Json) => emit({ type: "stream_event", event, parent_tool_use_id: null });
  // A paced stream waits after each piece; a Stop ends it where it is (the interrupt's own steps follow).
  const pace = async () => {
    if (s.paceMs) await sleep(s.paceMs, signal);
    return !signal.aborted;
  };
  ev({ type: "message_start", message: { id: s.id, type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  for (const [index, b] of blocks.entries()) {
    if (b.type === "thinking") {
      ev({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
      for (const p of pieces(b.thinking as string, n)) {
        ev({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: p } });
        if (!(await pace())) return;
      }
    } else if (b.type === "text") {
      ev({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (const p of pieces(b.text as string, n)) {
        ev({ type: "content_block_delta", index, delta: { type: "text_delta", text: p } });
        if (!(await pace())) return;
      }
    } else {
      ev({ type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      ev({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    ev({ type: "content_block_stop", index });
    if (!s.oneRecord) emit(record([b]));
  }
  ev({ type: "message_delta", delta: { stop_reason: s.tools?.length ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
  ev({ type: "message_stop" });
  if (s.oneRecord) emit(record(blocks));
}

// ---------------------------------------------------------------------------------------------------------------
// Control requests to the SDK (the callbacks), with cancel on interrupt.

let nextAsk = 0;
const pendingAsks = new Map<string, (r: { response?: Json; error?: string; cancelled?: boolean }) => void>();
let turnAbort = new AbortController();

function ask(request: Json): Promise<{ response?: Json; error?: string; cancelled?: boolean }> {
  const id = `fake-ask-${++nextAsk}`;
  const req = fill(request) as Json;
  trace({ t: "ask", id, subtype: req.subtype, request: req });
  write({ type: "control_request", request_id: id, request: req });
  return new Promise((resolve) => {
    pendingAsks.set(id, resolve);
    turnAbort.signal.addEventListener("abort", () => {
      if (!pendingAsks.delete(id)) return;
      write({ type: "control_cancel_request", request_id: id });
      trace({ t: "ask_cancelled", id });
      resolve({ cancelled: true });
    });
  });
}

function branchKey(subtype: unknown, r: { response?: Json; error?: string; cancelled?: boolean }): string {
  if (r.cancelled) return "cancelled";
  if (r.error !== undefined) return "error";
  const res = r.response ?? {};
  if (subtype === "can_use_tool") return String(res.behavior);
  if (subtype === "elicitation") return String(res.action);
  if (subtype === "request_user_dialog") return String(res.behavior);
  return "default";
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

async function runSteps(steps: Step[], signal: AbortSignal): Promise<void> {
  for (const step of steps) {
    if (signal.aborted) return;
    if ("emit" in step) emit(step.emit);
    else if ("say" in step) await say(step.say, signal);
    else if ("sleep" in step) await sleep(step.sleep, signal);
    else if ("echoUser" in step) {
      if (current) emit({ type: "user", message: current.message, parent_tool_use_id: null, uuid: current.uuid, isReplay: true });
    } else if ("exit" in step) {
      for (const l of step.stderr ?? []) process.stderr.write(`${l}\n`);
      trace({ t: "exit", code: step.exit });
      process.exit(step.exit);
    } else if ("task" in step) {
      await runTask(fill(step.task) as TaskStep, signal);
    } else if ("files" in step) {
      changeFiles(step.files);
    } else if ("ask" in step) {
      // wait false: send the request and go on (the answer is still traced), as a URL-mode elicitation needs.
      if (step.wait === false) {
        void ask(step.ask);
        continue;
      }
      const r = await ask(step.ask);
      const key = branchKey(step.ask.subtype, r);
      const next = step.then?.[key] ?? step.then?.default;
      if (next) await runSteps(next, signal);
    }
  }
}

/** U1: a path inside the fake's folder, or null for one that is absolute or leaves it. */
function ownPath(rel: string): string | null {
  if (!rel || isAbsolute(rel) || rel.split("/").some((s) => s === ".." || s === "")) return null;
  return join(process.cwd(), rel);
}

/** U1: the files step: each change in order (FileOp). */
function changeFiles(ops: FileOp[]): void {
  for (const op of ops) {
    const rel = "write" in op ? op.write : "append" in op ? op.append : "rm" in op ? op.rm : op.mv[0];
    const path = ownPath(rel);
    const to = "mv" in op ? ownPath(op.mv[1]) : null;
    if (!path || ("mv" in op && !to)) {
      trace({ t: "files_refused", path: rel });
      continue;
    }
    mkdirSync(dirname(to ?? path), { recursive: true });
    if ("write" in op) {
      if ("text" in op) writeFileSync(path, op.text);
      else if ("lines" in op) writeFileSync(path, Array.from({ length: op.lines }, (_, i) => `${op.prefix ?? "line"} ${i + 1}`).join("\n") + "\n");
      else writeFileSync(path, op.binary ? Buffer.alloc(op.bytes, 0) : Buffer.alloc(op.bytes, "kitespan seed line\n"));
    } else if ("append" in op) appendFileSync(path, op.text);
    else if ("rm" in op) rmSync(path, { force: true });
    else renameSync(path, to!);
    trace({ t: "files", op: Object.keys(op)[0], path: rel });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Foreground and background tasks (TaskStep)

/** The foreground tasks that run now, by task id: their tool use, and what moves one to the background. */
const foreground = new Map<string, { toolUseId: string; move: () => void }>();
/** The background tasks that run now, for background_tasks_changed. */
const background = new Map<string, { description: string; type: string }>();

function backgroundSet(): Json[] {
  return [...background].map(([task_id, b]) => ({ task_id, task_type: b.type, description: b.description }));
}

const toolResult = (id: string, content: string): Json => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] }, parent_tool_use_id: null });

async function runTask(t: TaskStep, signal: AbortSignal): Promise<void> {
  const taskId = t.taskId ?? `b${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const type = t.type ?? "local_bash";
  const description = t.description ?? "";
  const outputFile = `/tmp/fake-claude-tasks/${taskId}.output`;
  await sleep(t.startMs ?? 50, signal);
  if (signal.aborted) return;
  emit({ type: "system", subtype: "task_started", task_id: taskId, tool_use_id: t.toolUseId, description, task_type: type, is_backgrounded: false });
  trace({ t: "task_started", task: taskId });
  const startedAt = Date.now();
  let move = () => {};
  const moved = new Promise<"background">((r) => (move = () => r("background")));
  foreground.set(taskId, { toolUseId: t.toolUseId, move: () => move() });
  const how = await Promise.race([sleep(t.runMs, signal).then(() => (signal.aborted ? ("stopped" as const) : ("done" as const))), moved]);
  foreground.delete(taskId);
  if (how === "stopped") {
    emit({ type: "system", subtype: "task_notification", task_id: taskId, tool_use_id: t.toolUseId, status: "stopped", output_file: outputFile, summary: description });
    return;
  }
  if (how === "done") {
    emit({ type: "system", subtype: "task_notification", task_id: taskId, tool_use_id: t.toolUseId, status: "completed", output_file: outputFile, summary: description });
    emit(toolResult(t.toolUseId, t.output ?? ""));
    return;
  }
  // Moved: the call returns at once with Claude Code's line, and the work goes on to its own end.
  background.set(taskId, { description, type });
  emit({ type: "system", subtype: "background_tasks_changed", tasks: backgroundSet() });
  emit({ type: "system", subtype: "task_updated", task_id: taskId, patch: { is_backgrounded: true } });
  const line =
    type === "local_bash"
      ? `Command was manually backgrounded by user with ID: ${taskId}. Output is being written to: ${outputFile}`
      : `The agent was moved to the background with ID: ${taskId}.`;
  emit(toolResult(t.toolUseId, line));
  setTimeout(() => endBackground(taskId, t, description, outputFile), Math.max(0, t.runMs - (Date.now() - startedAt)));
}

/** A background task ends: its events, then its notification waits for a turn of its own. */
function endBackground(taskId: string, t: TaskStep, description: string, outputFile: string): void {
  background.delete(taskId);
  emit({ type: "system", subtype: "task_updated", task_id: taskId, patch: { status: "completed", end_time: Date.now() } });
  emit({ type: "system", subtype: "task_notification", task_id: taskId, tool_use_id: t.toolUseId, status: "completed", output_file: outputFile, summary: description });
  emit({ type: "system", subtype: "background_tasks_changed", tasks: backgroundSet() });
  const text = `<task-notification>\n<task-id>${taskId}</task-id>\n<status>completed</status>\n<summary>${description}</summary>\n</task-notification>`;
  queue.push({ uuid: randomUUID(), message: { role: "user", content: [{ type: "text", text }] }, meta: true });
  void loop();
}

// ---------------------------------------------------------------------------------------------------------------
// Turns: one per user message that queries, in order (live L3: two messages close together run as two turns).

const queue: QueuedUser[] = [];
let running = false;
let turnIndex = 0;
let turnCount = 0;
const DEFAULT_TURN: Turn = { steps: [{ say: { id: "msg_default", text: "ok" } }, { emit: { type: "result", subtype: "success", result: "ok" } }] };

/**
 * A message that names a paced stream (long-reply.ts pacedPrompt: "fake-stream <chars> <pieces> <ms>", and "thinking"
 * for a thinking block first) gets a long markdown reply of about that many characters, streamed in that many pieces
 * with that wait after each: the smooth-text checks' slow stream (row 79), whatever the fixture.
 */
function pacedTurn(text: string): Turn | null {
  const p = pacedOf(text);
  if (!p) return null;
  const reply = longReply(p.chars);
  const thinking = p.thinking ? longReply(Math.min(2000, p.chars)).replace(/[#*`|>-]/g, "") : undefined;
  return {
    steps: [
      { say: { id: "$USER_UUID", thinking, text: reply, chunks: p.pieces, paceMs: p.ms } },
      { emit: { type: "result", subtype: "success", result: reply } },
    ],
  };
}

function textOf(message: unknown): string {
  const c = (message as Json | undefined)?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.map((b) => (b && typeof b === "object" && (b as Json).type === "text" ? String((b as Json).text) : "")).join("\n");
}

/** A background task's notification: Claude says that it ended. */
const NOTIFY_TURN: Turn = { steps: [{ say: { id: "$USER_UUID", text: "The background task finished." } }, { emit: { type: "result", subtype: "success", result: "The background task finished." } }] };

async function runTurn(u: QueuedUser): Promise<void> {
  current = u;
  const text = textOf(u.message);
  const byText = u.meta ? undefined : (pacedTurn(text) ?? Object.entries(fixture.turnsByText ?? {}).find(([k]) => text.includes(k))?.[1]);
  // A turn picked by text does not use up the next turn in order, and neither does a notification's.
  const turn = u.meta ? (fixture.notifyTurn ?? NOTIFY_TURN) : (byText ?? fixture.turns?.[turnIndex++] ?? fixture.defaultTurn ?? DEFAULT_TURN);
  currentTurn = turn;
  folded = [];
  stamped.stream = stamped.assistant = false;
  const n = ++turnCount;
  turnAbort = new AbortController();
  const signal = turnAbort.signal;
  openTools.clear();
  trace({ t: "turn_start", n, uuid: u.uuid, ...(u.meta ? { meta: true } : {}) });
  record("user", u.uuid, u.message);
  if (turn.init !== false) emit(initMessage());
  await runSteps(turn.steps, signal);
  if (signal.aborted) {
    // A Stop: Claude Code writes its own line into the transcript ("for tool use" while a tool call has no result),
    // and history ends the turn there as interrupted, as the live turn ended. Only the transcript gets it here.
    const line = openTools.size > 0 ? "[Request interrupted by user for tool use]" : "[Request interrupted by user]";
    record("user", randomUUID(), { role: "user", content: [{ type: "text", text: line }] });
    await runSteps(fixture.onInterrupt ?? [{ emit: { type: "result", subtype: "error_during_execution", is_error: true, errors: [] } }], new AbortController().signal);
  }
  trace({ t: "turn_end", n, interrupted: signal.aborted, ...(folded.length ? { folded: [...folded] } : {}) });
  current = null;
  currentTurn = null;
  folded = [];
}

async function loop(): Promise<void> {
  if (running) return;
  running = true;
  while (queue.length) await runTurn(queue.shift()!);
  running = false;
}

// ---------------------------------------------------------------------------------------------------------------
// Control requests from the SDK.

function respond(id: string, response: Json): void {
  write({ type: "control_response", response: { subtype: "success", request_id: id, response } });
}
/** Run `fn` now, or `ms` milliseconds later. */
function later(ms: number | undefined, fn: () => void): void {
  if (ms) setTimeout(fn, ms);
  else fn();
}

function respondError(id: string, error: string): void {
  write({ type: "control_response", response: { subtype: "error", request_id: id, error } });
}

/** Requests that a raw host never sends: refused, and traced so a test can assert they never came. */
const NEVER = new Set(["update_settings", "mcp_set_servers"]);

/**
 * R127: the CLI's rule for the attestation, simplified: honored when the directory is the session's working directory
 * (both by their real paths) and not the home folder, whose trust is never saved.
 */
function trustRecorded(directory: string): boolean {
  const real = (p: string): string | null => {
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  };
  const cwd = real(process.cwd());
  return cwd !== null && real(directory) === cwd && directory === cwd && cwd !== real(homedir());
}

// ---------------------------------------------------------------------------------------------------------------
// R124: side questions (Fixture.side). Each one in flight, by its request id: the timers of its progress and answer.

const sides = new Map<string, ReturnType<typeof setTimeout>[]>();
const SIDE_SHAPE = "side_question: question must be a string and history an array of {question, response} strings";

function sideWayOf(question: string): SideWay {
  return Object.entries(fixture.sideByText ?? {}).find(([k]) => question.includes(k))?.[1] ?? fixture.side ?? {};
}

/** The default answer: the question, and each earlier exchange that came with it, so a test sees the history read. */
function sideText(question: string, history: { question: string; response: string }[]): string {
  const earlier = history.map((h) => `${h.question} -> ${h.response}`).join(" | ");
  return `Side answer to "${question}" (history ${history.length}${earlier ? `: ${earlier}` : ""}).`;
}

function sideQuestion(id: string, req: Json): void {
  const question = req.question;
  // The CLI's own check: a string, and history (when sent) an array of {question, response} strings.
  const raw = req.history ?? [];
  const pairs = Array.isArray(raw) && raw.every((h) => h && typeof h === "object" && typeof (h as Json).question === "string" && typeof (h as Json).response === "string");
  if (typeof question !== "string" || !pairs) return respondError(id, SIDE_SHAPE);
  const history = raw as { question: string; response: string }[];
  const way = sideWayOf(question);
  const delay = way.delayMs ?? fixture.sideDelayMs ?? 30;
  const progress = (extra: Json) => emit({ type: "system", subtype: "control_request_progress", request_id: id, ...extra });
  trace({ t: "side_question", id, question, history: history.length, duringTurn: currentTurn !== null });
  progress({ status: "started" });
  const retries = way.retries ?? [];
  const timers = retries.map((r, i) => setTimeout(() => progress({ status: "api_retry", attempt: r.attempt, max_retries: r.max_retries, retry_delay_ms: r.retry_delay_ms, error_status: r.error_status ?? null }), Math.floor((delay * (i + 1)) / (retries.length + 1))));
  timers.push(
    setTimeout(() => {
      sides.delete(id);
      trace({ t: "side_answer", id, error: way.error ?? null });
      if (way.error !== undefined) return respondError(id, way.error);
      const response = way.response === undefined ? sideText(question, history) : way.response === null ? null : way.response.replaceAll("$LAST_QUESTION", history.at(-1)?.question ?? "none");
      respond(id, { response, synthetic: way.synthetic === true, ...(way.refusal ? { refusal_fallback: way.refusal } : {}) });
    }, delay),
  );
  sides.set(id, timers);
}

/** A cancel of a side question that has not answered: its timers stop, and it answers the CLI's error. */
function cancelSide(id: string): boolean {
  const timers = sides.get(id);
  if (!timers) return false;
  for (const t of timers) clearTimeout(t);
  sides.delete(id);
  respondError(id, "Side question cancelled");
  trace({ t: "side_cancelled", id });
  return true;
}

function onControl(id: string, req: Json): void {
  const sub = String(req.subtype);
  trace({ t: "control", id, subtype: sub, request: req });
  if (NEVER.has(sub)) return respondError(id, `${sub} is not supported by the fake`);
  if (fixture.refuse?.includes(sub)) return respondError(id, `${sub} was refused`);
  const canned = fixture.control?.[sub];
  switch (sub) {
    case "initialize": {
      // R127: the host's trust attestation (Fixture.workspaceTrust).
      const wt = req.workspaceTrust as Json | undefined;
      const attested = !!wt && typeof wt === "object" && wt.accepted === true && typeof wt.directory === "string";
      const way: TrustWay = fixture.workspaceTrust ?? {};
      if (wt !== undefined) trace({ t: "workspace_trust", attested, directory: attested ? wt!.directory : null, cwd: process.cwd() });
      const recorded = attested ? (way.recorded === undefined ? trustRecorded(wt!.directory as string) : way.recorded) : null;
      const answer = () => {
        if (attested && way.exitCode !== undefined) {
          trace({ t: "exit", code: way.exitCode });
          process.exit(way.exitCode);
        }
        if (recorded === true) trace({ t: "trust_recorded", directory: wt!.directory });
        respond(id, { ...initializeResponse(), ...(recorded === null ? {} : { workspace_trust_recorded: recorded }) });
        if (fixture.onStart) void runSteps(fixture.onStart, new AbortController().signal);
      };
      const delay = (attested ? way.delayMs : undefined) ?? fixture.initializeDelayMs;
      if (delay) setTimeout(answer, delay);
      else answer();
      return;
    }
    case "interrupt": {
      // The receipt (interrupt_receipt_v1) names the user messages that will still run; a notification has no uuid.
      const still = queue.filter((u) => !u.meta).map((u) => u.uuid);
      turnAbort.abort();
      return respond(id, { still_queued: still });
    }
    case "set_model":
      model = typeof req.model === "string" ? req.model : (fixture.model ?? "claude-fake-1");
      return respond(id, {});
    case "set_permission_mode":
      mode = String(req.mode);
      return respond(id, {});
    case "cancel_async_message": {
      const i = queue.findIndex((u) => u.uuid === req.message_uuid);
      if (i >= 0) queue.splice(i, 1);
      return respond(id, { cancelled: i >= 0 });
    }
    case "generate_session_title":
      return respond(id, canned ?? { title: "A generated title" });
    case "mcp_status":
      return respond(id, canned ?? { mcpServers: [] });
    case "get_context_usage":
      if (fixture.contextRefusedFor?.includes(model)) return respondError(id, "get_context_usage was refused");
      return later(fixture.contextDelayMs, () =>
        respond(
          id,
          canned ?? {
            categories: [
              { name: "System prompt", tokens: 3000, color: "c1", kind: "used" },
              { name: "Messages", tokens: 1000, color: "c2", kind: "used" },
              { name: "Free space", tokens: 196000, color: "c3", kind: "free" },
            ],
            totalTokens: 4000,
            maxTokens: fixture.contextWindows?.[model] ?? 200000,
            rawMaxTokens: fixture.contextWindows?.[model] ?? 200000,
            percentage: 2,
            gridRows: [],
            model,
            memoryFiles: [],
            mcpTools: [],
          },
        ),
      );
    case "background_tasks": {
      if (canned) return respond(id, canned);
      // Without a tool use: every foreground task (Ctrl+B), and true even when none has started (live item 16).
      const want = typeof req.tool_use_id === "string" ? req.tool_use_id : null;
      const hit = [...foreground.values()].filter((f) => want === null || f.toolUseId === want);
      for (const f of hit) f.move();
      // Claude Code 2.1.317's order (the lead's live run): the moved task's events come before the answer.
      setTimeout(() => respond(id, { backgrounded: want === null || hit.length > 0 }), hit.length > 0 ? 10 : 0);
      return;
    }
    case "stop_task":
      respond(id, canned ?? {});
      emit({ type: "system", subtype: "task_notification", task_id: req.task_id, status: "stopped", output_file: "", summary: "Stopped" });
      return;
    case "side_question":
      return sideQuestion(id, req);
    default:
      return respond(id, canned ?? {});
  }
}

function onLine(line: string): void {
  let m: Json;
  try {
    m = JSON.parse(line) as Json;
  } catch {
    trace({ t: "bad_line" });
    return;
  }
  if (m.type === "control_request" && typeof m.request_id === "string" && m.request && typeof m.request === "object") return onControl(m.request_id, m.request as Json);
  if (m.type === "control_response" && m.response && typeof m.response === "object") {
    const r = m.response as Json;
    const id = String(r.request_id);
    const p = pendingAsks.get(id);
    trace({ t: "answer", id, subtype: r.subtype, response: r.response ?? null, error: r.error ?? null });
    if (!p) return;
    pendingAsks.delete(id);
    p(r.subtype === "success" ? { response: (r.response as Json) ?? {} } : { error: String(r.error ?? "error") });
    return;
  }
  if (m.type === "control_cancel_request") {
    trace({ t: "sdk_cancel", id: m.request_id });
    cancelSide(String(m.request_id));
    return;
  }
  if (m.type === "user") {
    const msg = m.message as Json | undefined;
    trace({ t: "user", uuid: m.uuid ?? null, origin: m.origin ?? null, shouldQuery: m.shouldQuery ?? null, priority: m.priority ?? null, content: msg?.content ?? null });
    const uuid = typeof m.uuid === "string" ? m.uuid : randomUUID();
    // A record with no query (a `!` command's output) goes into the transcript at once (record() gives it its own id).
    if (m.shouldQuery === false) return record("user", uuid, msg);
    queue.push({ uuid, message: msg });
    void loop();
    return;
  }
  trace({ t: "other", type: m.type ?? null });
}

process.on("SIGTERM", () => {
  trace({ t: "sigterm" });
  if (!fixture.ignoreSigterm) process.exit(143);
});

const decoder = new TextDecoder();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += decoder.decode(chunk, { stream: true });
  for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) onLine(line);
  }
}
trace({ t: "stdin_end" });
if (fixture.finishTurnOnStdinEnd) {
  queue.length = 0;
  while (running) await new Promise((r) => setTimeout(r, 20));
  trace({ t: "exit", code: 0 });
  process.exit(0);
}
if (!fixture.ignoreStdinEnd) process.exit(0);
// Stay alive, as a CLI that does not wind down on stdin end would, until a signal ends it.
setInterval(() => {}, 1 << 30);
