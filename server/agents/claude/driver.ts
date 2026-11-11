// The Claude driver (DESIGN.md 4.1, 4.2): one query() per live chat, fed by a streaming input that never ends while
// the chat lives and never throws; a host uuid and `origin: {kind: 'human'}` on every message; the card callbacks
// (canUseTool for permission, AskUserQuestion, ExitPlanMode and Workflow; onElicitation; onUserDialog); the session
// functions for sleeping chats. Only this folder imports the Agent SDK.
//
// The message loop never leaves early: the driver knows nothing about sockets, and a chat ends only with close(),
// which waits until the claude process is gone (the SDK's own close() returns nothing).

import {
  deleteSession as sdkDeleteSession,
  filterEscalatingDefaultMode,
  forkSession as sdkForkSession,
  getSessionInfo,
  getSessionMessages,
  getSubagentMessages,
  listSubagents,
  listSessions as sdkListSessions,
  query,
  renameSession,
  resolveSettings,
  type CanUseTool,
  type ElicitationResult,
  type OnElicitation,
  type OnUserDialog,
  type Options,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKSessionInfo,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import {
  capAnswer,
  capInput,
  capText,
  CONTROL_CHARS,
  EFFORT_IDS,
  LIMITS,
  MODE_IDS,
  PLAN_MODES,
  type Card,
  type CardAnswer,
  type ChatEvent,
  type CommandInfo,
  type ConnectorInfo,
  type ContextInfo,
  type EffortId,
  type ErrorCode,
  type StartupFailure,
  type ModeId,
  type ModelInfo,
  type Question,
} from "../../../shared/protocol";
import { maskValues } from "../../env/mask";
import { ENV_LIMITS } from "../../env/names";
import { START_ENV } from "../../start-env-copy";
import { STORE_LIMITS, type LastOptionsRecord } from "../../store/types";
import {
  CARD_ABORT,
  type AgentCapabilities,
  type AgentChat,
  type AgentDriver,
  type AgentSettings,
  type BinaryProbe,
  type EnvVar,
  type HistoryPageRequest,
  type Marked,
  type OpenInput,
  type SessionInfo,
  type SessionOpen,
  type SideAnswer,
  type SideProgress,
  type SideTurn,
  type TranscriptUsage,
  isProviderArn,
  maskArns,
} from "../types";
import { bashRecordText } from "./bash";
import { SIDE_MISSING, sideAnswerOf, sideProgressOf, sideQuestionOf, untilAborted } from "./side";
import { commandInfo, EventMapper, historyEvents, historyPage, lastReplyUsage, searchRecords, toolResultOf } from "./events";
import { INSTALL_ROOT, pinSync, probeBinary, type Pin } from "./locate";
import { rawOptions, SDK_VERSION, snapshotOptions, type BuiltOptions } from "./options";
import { childWithArg, claudeConfigDir, claudeSessionsDir, RunningSessions } from "./running";
import { checkTrustOptions, recordedOf, TRUST_READ_MS, TrustGateError, trustOptions } from "./trust";
import { BG_CLI, BackgroundCli, hasAgentView, readPermissionMode, type AgentViewBinary, type BgCliLimits } from "./background";
import { homeFolders } from "../../home";
import { linkedRootOf } from "../../worktree/check";
import { childEnv } from "../../env/child";
import { isBgId } from "../../../shared/ids";
import type { BgStopAnswer } from "../../../shared/protocol";
import type { BgList, BgRecord } from "../types";
import { homedir } from "node:os";

/** The answers Claude reads when the user says no or closes a card (D 12 question 1 keeps the spike's texts). */
export const DENY_TEXTS = {
  permission: "The user denied this tool use.",
  question: "The user dismissed the question.",
  plan: "The user chose to keep planning.",
  planDismissed: "The user dismissed the plan.",
} as const;

/** The SDK functions the driver uses; tests may swap the session functions for fakes. */
export interface SdkSurface {
  query: typeof query;
  listSessions: typeof sdkListSessions;
  getSessionInfo: typeof getSessionInfo;
  getSessionMessages: typeof getSessionMessages;
  listSubagents: typeof listSubagents;
  getSubagentMessages: typeof getSubagentMessages;
  renameSession: typeof renameSession;
  deleteSession: typeof sdkDeleteSession;
  forkSession: typeof sdkForkSession;
  resolveSettings: typeof resolveSettings;
  filterEscalatingDefaultMode: typeof filterEscalatingDefaultMode;
}

const REAL_SDK: SdkSurface = {
  query,
  listSessions: sdkListSessions,
  getSessionInfo,
  getSessionMessages,
  listSubagents,
  getSubagentMessages,
  renameSession,
  deleteSession: sdkDeleteSession,
  forkSession: sdkForkSession,
  resolveSettings,
  filterEscalatingDefaultMode,
};

/** A driver failure the registry turns into an `ack` error code. Its message is for logs of counts only, never shown. */
export class DriverError extends Error {
  constructor(
    readonly code: Extract<ErrorCode, "no_claude" | "bad_request" | "unsupported" | "failed" | "stale" | "not_found">,
    message: string,
  ) {
    super(message);
    this.name = "DriverError";
  }
}

/**
 * What open() takes: the seam's OpenInput, with the session id in the chat's ledger. The gate refuses a `sessionId` or
 * `resume` that is not that id (DESIGN 4.7 case 2).
 */
export type ClaudeOpenInput = OpenInput;

export interface ClaudeDriverOptions {
  /** The real paths of the folders in projects.json (the gate's `cwd` check). */
  knownFolders: () => readonly string[];
  /** Settings > Chats, "Allow bypass permissions mode" (D12). */
  allowBypass: () => boolean;
  /** Writes last-options.json (4.7); awaited before query() is called. A failed write does not stop the start. */
  writeLastOptions?: (rec: LastOptionsRecord) => Promise<void> | void;
  /** The PATH the binary pin searches (tests: a mkdtemp folder with a fake claude). The server's PATH by default. */
  pathEnv?: () => string | undefined;
  /** Where the platform-package scan starts; the repository root by default. */
  installRoot?: string;
  sdk?: Partial<SdkSurface>;
  now?: () => Date;
  versionTimeoutMs?: number;
  /** close(): how long to wait for the process after the SDK's own cleanup (SIGTERM at 2 s, SIGKILL 5 s later). */
  closeWaitMs?: number;
  /** readCommands() and readModels(): how long the idle process may take to answer (COMMANDS_READ_MS by default). */
  commandsReadMs?: number;
  /** D58: Claude Code's registry of running sessions (tests: a scratch folder); claudeSessionsDir() by default. */
  sessionsDir?: string;
  /** R127: how long a trust start may take to answer (TRUST_READ_MS by default). */
  trustReadMs?: number;
  /** R131: the limits of `claude agents --json --all` and `claude stop` (tests); BG_CLI by default. */
  bgLimits?: Partial<BgCliLimits>;
  /** R131: Claude Code's config folder, where a session's transcript is (tests); claudeConfigDir() by default. */
  claudeConfigDir?: string;
}

/** D59 and row 81: the short read of the command and model lists ends its process after this long with no answer. */
export const COMMANDS_READ_MS = 20_000;

/** The key prefix of a short read with an environment's variables (D60): no folder path starts with it. */
const ENV_READ = "env:";

/** What one idle Claude Code answers (readIdle). */
interface IdleLists {
  commands: CommandInfo[];
  models: ModelInfo[];
  /** Row 94: each model row's context window, by the row's value. */
  windows: Record<string, number>;
}

/**
 * The SDK's model rows as the seam's (a live chat's `get models`, the short read); a missing list is none. Row 95: a
 * row whose value is a provider's ARN is left out, and an ARN in a row's name or description reads as "[an ARN]".
 */
function modelInfos(rows: Awaited<ReturnType<Query["supportedModels"]>> | undefined): ModelInfo[] {
  const text = (v: unknown) => (typeof v === "string" ? maskArns(v) : "");
  return (Array.isArray(rows) ? rows : []).filter((r) => !isProviderArn(r?.value)).map((r) => ({
    value: r.value,
    displayName: text(r.displayName),
    description: text(r.description),
    efforts: (r.supportedEffortLevels ?? []).filter((e): e is EffortId => (EFFORT_IDS as readonly string[]).includes(e)),
    supportsAutoMode: r.supportsAutoMode === true,
  }));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let sdkPackageVersion: string | null | undefined;
/** The installed SDK's version, from its package.json. */
export function installedSdkVersion(): string | null {
  if (sdkPackageVersion !== undefined) return sdkPackageVersion;
  try {
    const entry = Bun.resolveSync("@anthropic-ai/claude-agent-sdk", import.meta.dir);
    const pkg = JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8")) as { version?: unknown };
    sdkPackageVersion = typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    sdkPackageVersion = null;
  }
  return sdkPackageVersion;
}

/** A title as the ledger keeps it: whitespace folded, at most 120 characters, or null when nothing is left. */
export function cleanTitle(t: unknown): string | null {
  if (typeof t !== "string") return null;
  const s = capText(t.replace(/\s+/g, " ").trim(), LIMITS.title).trim();
  return s || null;
}

function sessionInfoOf(s: SDKSessionInfo): SessionInfo {
  const customTitle = cleanTitle(s.customTitle);
  return {
    sessionId: s.sessionId,
    title: customTitle ?? cleanTitle(s.firstPrompt) ?? "",
    customTitle,
    lastModified: s.lastModified,
    cwd: s.cwd ?? null,
    // W6, L31: the branch that a row from another worktree shows, and the Environment detail's refresh.
    gitBranch: typeof s.gitBranch === "string" && s.gitBranch && s.gitBranch.length <= 255 && !CONTROL_CHARS.test(s.gitBranch) ? s.gitBranch : null,
    // R131: with lastModified, the background view's lite read (whether the transcript changed).
    ...(typeof s.fileSize === "number" && Number.isSafeInteger(s.fileSize) && s.fileSize >= 0 ? { fileSize: s.fileSize } : {}),
  };
}

/**
 * W5: the start-up refusal of an error result (`startup_failure_reason`), with its first error line; null for any
 * other result. Only the three that kitespan tells apart keep their name; every other value is `unknown`. D60 (E7):
 * each stored value of the chat's environment (`vars`) in the line reads as the mask, as in the stderr tail.
 */
export function startupFailureOf(m: Record<string, unknown>, vars: readonly EnvVar[] | null = null): StartupFailure | null {
  if (m.type !== "result" || typeof m.startup_failure_reason !== "string") return null;
  const r = m.startup_failure_reason;
  const reason = r === "worktree_unverified" || r === "worktree_resume_refused" || r === "cwd_unavailable" ? r : "unknown";
  const errs = Array.isArray(m.errors) ? m.errors.filter((e): e is string => typeof e === "string" && e.trim() !== "") : [];
  const first = (errs[0] ?? (typeof m.result === "string" ? m.result : "")).split("\n").map((l) => l.trim()).find((l) => l) ?? "";
  const line = capText(maskValues(first, vars).replace(new RegExp(CONTROL_CHARS.source, "g"), " "), LIMITS.stderrLine).trim();
  return { reason, line: line || null };
}

/**
 * The longest unfinished stderr line kept across chunks (more than an environment's values together, E2); a longer
 * line is dropped, since a value that it cut would show in part.
 */
const STDERR_REST_MAX = 2 * ENV_LIMITS.totalBytes;

/** The newest sessions that sessionFolders reads (the SDK reads only these transcripts' heads and tails). */
export const SESSION_FOLDERS_READ = 300;

export class ClaudeDriver implements AgentDriver {
  readonly kind = "claude-code" as const;
  readonly sdk: SdkSurface;
  /** Session ids known to have a transcript (D41: such a session starts with `resume`, never `sessionId`). */
  readonly knownSessions = new Set<string>();
  /** The last settings read per folder: the gate takes `promptSuggestionEnabled` from here, never from the input. */
  readonly settingsSeen = new Map<string, AgentSettings>();
  lastProbe: BinaryProbe | null = null;
  /**
   * D58: the sessions open in other processes. Every claude that this driver starts (a chat's, a short read's) is a
   * child of the server's own process, which the SDK spawns directly, so "kitespan's own" is the server and its
   * children: the SDK's process object gives no pid to name them one by one. A claude typed in the Terminal pane is
   * the pane's shell's child, so it counts as the terminal.
   */
  private readonly running: RunningSessions;
  /** D59, row 81: the idle reads in flight, by folder (idleRead). */
  private readonly idleReads = new Map<string, Promise<IdleLists>>();
  /** What ends each idle read in flight before its answer (endReads). */
  private readonly idleStops = new Set<() => void>();

  /** R131: Claude Code's two scripting commands for background sessions (background.ts). */
  private readonly bg: BackgroundCli;

  constructor(readonly opts: ClaudeDriverOptions) {
    this.sdk = { ...REAL_SDK, ...opts.sdk };
    this.running = new RunningSessions({ dir: opts.sessionsDir ?? claudeSessionsDir(), ownPids: () => [process.pid] });
    // The clean start environment, as bin/kitespan gave it to Bun (never a chat's variables), in the home folder.
    this.bg = new BackgroundCli({ env: () => childEnv(START_ENV), cwd: () => homedir(), limits: { ...BG_CLI, ...opts.bgLimits } });
  }

  now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  pinOptions(): { pathEnv?: string; installRoot: string } {
    const pathEnv = this.opts.pathEnv ? this.opts.pathEnv() : undefined;
    return { ...(pathEnv !== undefined ? { pathEnv } : {}), installRoot: this.opts.installRoot ?? INSTALL_ROOT };
  }

  capabilities(): AgentCapabilities {
    // The untyped methods (D6) exist on SDK 0.3.312's query object (R-sdk 3.1; askSideQuestion, the lead's R124 probe);
    // each chat checks again before a call.
    const untyped = installedSdkVersion() === SDK_VERSION;
    return {
      models: true,
      effort: true,
      modes: [...MODE_IDS],
      commands: true,
      bash: true,
      contextUsage: true,
      connectors: true,
      backgroundTasks: true,
      runInBackground: true,
      takeBack: untyped,
      titles: untyped,
      rename: true,
      deleteSession: true,
      sideQuestions: untyped,
      // R127: the host attestation is an untyped option of the pinned SDK (trust.ts); on another SDK, Open in terminal.
      trustFolder: untyped,
    };
  }

  async probe(): Promise<BinaryProbe> {
    const p = await probeBinary({ ...this.pinOptions(), ...(this.opts.versionTimeoutMs ? { versionTimeoutMs: this.opts.versionTimeoutMs } : {}) });
    this.lastProbe = p;
    return p;
  }

  /**
   * Start a chat's Claude Code. The binary pin and the platform-package scan run again first; the options are built
   * by rawOptions() and checked (fail closed). Throws DriverError `no_claude`, or GateError, before anything starts.
   */
  open(input: ClaudeOpenInput): ClaudeChat {
    const pin = pinSync(this.pinOptions());
    if (!pin.ok || !pin.path) throw new DriverError("no_claude", "No usable claude on PATH");
    return new ClaudeChat(this, input, pin);
  }

  async history(sessionId: string, cwd: string, page: HistoryPageRequest): Promise<{ events: ChatEvent[]; more: string | null }> {
    if (!UUID_RE.test(sessionId)) throw new DriverError("bad_request", "Not a session id");
    const messages = await this.sdk.getSessionMessages(sessionId, { dir: cwd, includeSystemMessages: true });
    const events = historyEvents(messages);
    return historyPage(page.decorate ? page.decorate(events) : events, page.before, page.maxBytes);
  }

  async transcriptEvents(sessionId: string, cwd: string): Promise<ChatEvent[]> {
    if (!UUID_RE.test(sessionId)) throw new DriverError("bad_request", "Not a session id");
    return historyEvents(searchRecords(await this.sdk.getSessionMessages(sessionId, { dir: cwd, includeSystemMessages: true })));
  }

  async toolOutput(sessionId: string, cwd: string, toolUseId: string): Promise<string | null> {
    if (!UUID_RE.test(sessionId)) return null;
    const own = toolResultOf(await this.sdk.getSessionMessages(sessionId, { dir: cwd, includeSystemMessages: true }), toolUseId);
    if (own !== null) return own;
    // A subagent's own calls are in its transcript, apart from the session's chain (a row with a parent).
    for (const agent of await this.sdk.listSubagents(sessionId, { dir: cwd })) {
      const text = toolResultOf(await this.sdk.getSubagentMessages(sessionId, agent, { dir: cwd }), toolUseId);
      if (text !== null) return text;
    }
    return null;
  }

  async lastUsage(sessionId: string, cwd: string): Promise<TranscriptUsage | null> {
    if (!UUID_RE.test(sessionId)) return null;
    return lastReplyUsage(await this.sdk.getSessionMessages(sessionId, { dir: cwd }));
  }

  async sessionInfo(sessionId: string, cwd: string): Promise<SessionInfo | null> {
    if (!UUID_RE.test(sessionId)) return null;
    const info = await this.sdk.getSessionInfo(sessionId, { dir: cwd });
    if (!info) return null;
    this.knownSessions.add(sessionId);
    return sessionInfoOf(info);
  }

  async listSessions(cwd: string): Promise<SessionInfo[]> {
    // includeProgrammatic false: the sessions the terminal's /resume shows, so kitespan's own (sdk-ts) never list (L5).
    const list = await this.sdk.listSessions({ dir: cwd, includeProgrammatic: false });
    return list.map(sessionInfoOf);
  }

  async listReleased(cwd: string, ids: readonly string[]): Promise<SessionInfo[]> {
    if (!ids.length) return [];
    // Row 99: the SDK's own sessions too, but only the ones a removed environment released; no other ever lists (L5).
    // Each is asked for under the folder that holds its transcript, so no other worktree's is read (git never runs).
    const want = new Set(ids);
    const list = await this.sdk.listSessions({ dir: cwd, includeProgrammatic: true, includeWorktrees: false });
    return list.filter((s) => want.has(s.sessionId)).map(sessionInfoOf);
  }

  async sessionFolders(): Promise<string[]> {
    // No dir: every project folder; a limit makes the SDK sort by the files' times and read only the newest.
    const list = await this.sdk.listSessions({ limit: SESSION_FOLDERS_READ, includeProgrammatic: false });
    const out = new Set<string>();
    for (const s of [...list].sort((a, b) => b.lastModified - a.lastModified)) {
      const cwd = s.cwd;
      // W12, L31: a session in a linked worktree suggests its main checkout (file reads only, no git).
      if (typeof cwd === "string" && isAbsolute(cwd) && cwd.length <= STORE_LIMITS.cwd && !CONTROL_CHARS.test(cwd)) out.add(linkedRootOf(resolve(cwd)) ?? resolve(cwd));
    }
    return [...out];
  }

  async rename(sessionId: string, title: string, cwd: string): Promise<void> {
    if (!UUID_RE.test(sessionId)) throw new DriverError("bad_request", "Not a session id");
    const t = typeof title === "string" ? title.trim() : "";
    if (!t || t.length > LIMITS.title) throw new DriverError("bad_request", "A title has 1 to 120 characters");
    await this.sdk.renameSession(sessionId, t, { dir: cwd });
  }

  async deleteSession(sessionId: string, cwd: string): Promise<void> {
    if (!UUID_RE.test(sessionId)) throw new DriverError("bad_request", "Not a session id");
    try {
      await this.sdk.deleteSession(sessionId, { dir: cwd });
    } catch (e) {
      // Already gone is what Delete wants; anything else is a failure.
      if (!/not found/i.test(String((e as Error)?.message ?? e))) throw new DriverError("failed", "deleteSession failed");
    }
    this.knownSessions.delete(sessionId);
  }

  async forkSession(sessionId: string, cwd: string, title: string | null): Promise<string> {
    if (!UUID_RE.test(sessionId)) throw new DriverError("bad_request", "Not a session id");
    const t = cleanTitle(title);
    let id: unknown;
    try {
      // The SDK's own fork: the transcript copied under a new session id with new message ids; the original file is
      // only read. No claude process starts; the chat's first start resumes the copy.
      id = (await this.sdk.forkSession(sessionId, { dir: cwd, ...(t ? { title: t } : {}) }))?.sessionId;
    } catch (e) {
      const why = String((e as Error)?.message ?? e);
      throw new DriverError(/not found|no messages/i.test(why) ? "not_found" : "failed", "forkSession failed");
    }
    if (typeof id !== "string" || !UUID_RE.test(id)) throw new DriverError("failed", "forkSession gave no session id");
    this.knownSessions.add(id);
    return id;
  }

  openSessions(): Promise<ReadonlyMap<string, SessionOpen>> {
    return this.running.read();
  }

  /** R131: the background sessions' records of these ids (the chats' books), from the same look as openSessions. */
  backgroundRecords(ids: ReadonlySet<string>): Promise<BgRecord[]> {
    return this.running.readBackground(ids);
  }

  /**
   * R131: the binary that may run Claude Code's background commands: the pin's, when the version that the probe read of
   * that very binary is agent view's or later (the probe runs again when the pin moved: `claude --version`, no model
   * call); else why not.
   */
  private async agentViewBinary(): Promise<AgentViewBinary> {
    const pin = pinSync(this.pinOptions());
    if (!pin.ok || !pin.path) return "no_claude";
    let probe = this.lastProbe;
    if (!probe || probe.path !== pin.path || probe.realpath !== pin.realpath || probe.version === null) probe = await this.probe();
    if (!probe.ok || probe.path !== pin.path) return "no_claude";
    return hasAgentView(probe.version) ? pin.path : "unsupported";
  }

  /** R131: `claude agents --json --all` for these ids (background.ts); null when it cannot be read. */
  listBackground(ids: ReadonlySet<string>): Promise<BgList | null> {
    return this.bg.list(ids, () => this.agentViewBinary());
  }

  /** R131: `claude stop <id>`, after the id's own check and the version gate (each before the stop's process starts). */
  async stopBackground(id: string): Promise<BgStopAnswer> {
    if (!isBgId(id)) throw new DriverError("bad_request", "Not a background session's id");
    const bin = await this.agentViewBinary();
    if (bin === "no_claude") throw new DriverError("no_claude", "No usable claude on PATH");
    if (bin === "unsupported") throw new DriverError("unsupported", "This Claude Code has no agent view");
    return this.bg.stop(bin, id);
  }

  /** R131: the session's permission mode from its transcript's tail (background.ts); null when none is known. */
  backgroundMode(sessionId: string, dir: string): Promise<ModeId | null> {
    return readPermissionMode(this.opts.claudeConfigDir ?? claudeConfigDir(), [dir], sessionId).catch(() => null);
  }

  async settings(cwd: string): Promise<AgentSettings> {
    const resolved = await this.sdk.resolveSettings({ cwd });
    const eff = resolved.effective as Record<string, unknown>;
    let defaultMode: string | null = null;
    try {
      const filtered = this.sdk.filterEscalatingDefaultMode(resolved) as { permissions?: { defaultMode?: unknown } };
      defaultMode = typeof filtered.permissions?.defaultMode === "string" ? filtered.permissions.defaultMode : null;
    } catch {}
    const s: AgentSettings = {
      respondToBash: eff.respondToBashCommands !== false,
      cleanupPeriodDays: typeof eff.cleanupPeriodDays === "number" ? eff.cleanupPeriodDays : null,
      promptSuggestions: eff.promptSuggestionEnabled === true,
      defaultMode,
      // L29: a WorktreeCreate hook that kitespan's own worktrees would not run turns the Worktree option off.
      ...(hasWorktreeHook(eff.hooks) ? { worktreeHook: true } : {}),
    };
    this.settingsSeen.set(cwd, s);
    return s;
  }

  /** D60: the names that the user's own settings `env` sets for the folder (resolveSettings; names only). */
  async settingsEnvNames(cwd: string): Promise<string[]> {
    const env = ((await this.sdk.resolveSettings({ cwd })).effective as Record<string, unknown>).env;
    return typeof env === "object" && env !== null && !Array.isArray(env) ? Object.keys(env) : [];
  }

  /** D59: the folder's command list with no chat (readIdle); D60: with its environment's variables. */
  async readCommands(cwd: string, env: Marked<EnvVar[]> | null = null): Promise<CommandInfo[]> {
    return (await this.idleRead(cwd, env)).commands;
  }

  /**
   * Row 81: Claude Code's model list with no chat (readIdle). While an idle read with no variables runs for any folder
   * it answers this one too, since the list is Claude Code's own and the same in every folder: a model read never
   * starts a second process. D60 (L37): variables can change the provider, so a read with them is its environment's
   * own: it takes only its own folder's read with variables, and a read without them never takes one with them.
   */
  async readModels(cwd: string, env: Marked<EnvVar[]> | null = null): Promise<ModelInfo[]> {
    return (await this.listsRead(cwd, env)).models;
  }

  /**
   * Row 94: each model row's context window with no chat (readIdle), from a read that runs as readModels does: D60,
   * one with variables only from its own folder's read with them, one without never from a read with them.
   */
  async readWindows(cwd: string, env: Marked<EnvVar[]> | null = null): Promise<Record<string, number>> {
    return (await this.listsRead(cwd, env)).windows;
  }

  /** The idle read that answers readModels and readWindows: any one without variables that runs, else the folder's own. */
  private listsRead(cwd: string, env: Marked<EnvVar[]> | null): Promise<IdleLists> {
    const running = env ? undefined : [...this.idleReads.entries()].find(([key]) => !key.startsWith(ENV_READ))?.[1];
    return running ?? this.idleRead(cwd, env);
  }

  /** R17, S11: every idle read in flight ends now; resolves once each one's process has exited. R127: and every trust start. */
  async endReads(): Promise<void> {
    for (const stop of this.idleStops) stop();
    await Promise.all([...this.idleReads.values(), ...this.trustRuns].map((r) => r.catch(() => {})));
  }

  /** R127: the trust starts in flight (one per folder is the registry's rule), which endReads ends. */
  private readonly trustRuns = new Set<Promise<unknown>>();

  /**
   * R127: the one trust start (trust.ts builds and checks its options; nothing else sends the attestation). One
   * query() in the folder with an input that yields nothing, so no turn runs; the initialize answer's
   * `workspace_trust_recorded` says whether Claude Code recorded the trust. Then, or after the cap, an exit, `signal`
   * or endReads, the input ends and the process is closed as readIdle closes it; the start returns once it has exited.
   */
  async trustFolder(path: string, signal?: AbortSignal): Promise<{ recorded: boolean }> {
    const pin = pinSync(this.pinOptions());
    if (!pin.ok || !pin.path) throw new DriverError("no_claude", "No usable claude on PATH");
    const options = trustOptions({ path, binary: pin.path });
    const problems = checkTrustOptions(options, { path, pinnedPath: pin.path, platformPackages: pin.platformPackages, homes: homeFolders() });
    if (problems.length) throw new TrustGateError(problems);
    let ended = false;
    let wake = () => {};
    async function* idle(): AsyncGenerator<SDKUserMessage, void> {
      while (!ended) await new Promise<void>((r) => (wake = r));
    }
    let stop = () => {};
    const stopped = new Promise<"stopped">((r) => (stop = () => r("stopped")));
    const run = (async (): Promise<{ recorded: boolean }> => {
      let q: Query;
      try {
        q = this.sdk.query({ prompt: idle(), options: options as Options });
      } catch {
        throw new DriverError("failed", "The trust start did not start");
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      this.idleStops.add(stop);
      signal?.addEventListener("abort", stop);
      if (signal?.aborted) stop();
      try {
        const late = new Promise<"late">((r) => (timer = setTimeout(() => r("late"), this.opts.trustReadMs ?? TRUST_READ_MS)));
        const init: unknown = await Promise.race([q.initializationResult(), late, stopped]).catch(() => "threw" as const);
        if (init === "late" || init === "stopped" || init === "threw") throw new DriverError("failed", "The trust start gave no answer");
        return { recorded: recordedOf(init) };
      } finally {
        clearTimeout(timer);
        this.idleStops.delete(stop);
        signal?.removeEventListener("abort", stop);
        ended = true;
        wake();
        try {
          q.close();
        } catch {}
        try {
          await q.return(undefined);
        } catch {}
        await waitForExit(childOf(q), this.opts.closeWaitMs ?? 8_000);
      }
    })();
    this.trustRuns.add(run);
    void run.then(
      () => this.trustRuns.delete(run),
      () => this.trustRuns.delete(run),
    );
    return run;
  }

  /**
   * One idle read per folder at a time: an ask while one runs takes its answer (D59's process, shared). A read with
   * variables (D60) is kept apart from one without, under its own key.
   */
  private idleRead(cwd: string, env: Marked<EnvVar[]> | null): Promise<IdleLists> {
    const key = env ? `${ENV_READ}${cwd}` : cwd;
    const was = this.idleReads.get(key);
    if (was) return was;
    const run: Promise<IdleLists> = this.readIdle(cwd, env).finally(() => {
      if (this.idleReads.get(key) === run) this.idleReads.delete(key);
    });
    this.idleReads.set(key, run);
    return run;
  }

  /**
   * D59 and row 81: the folder's command list and Claude Code's model list with no chat. One query() with the gate's
   * options for the folder and nothing else (no resume, no session id, no pick, no switch) and an input that yields
   * nothing: Claude Code starts and answers the SDK's initialize request with both lists, and since no message comes,
   * no turn runs. Then each model row's context window (contextWindows). After that, or after COMMANDS_READ_MS (or at
   * endReads), the input ends and the process is closed; the read returns once it has exited, with the windows read so
   * far. Not a chat: no last-options record and no events; the callbacks refuse whatever might come. D60 (L38): the
   * folder's environment's variables, as a chat's start gets them.
   */
  private async readIdle(cwd: string, env: Marked<EnvVar[]> | null): Promise<IdleLists> {
    const pin = pinSync(this.pinOptions());
    if (!pin.ok || !pin.path) throw new DriverError("no_claude", "No usable claude on PATH");
    const built = rawOptions(
      {
        cwd,
        binary: pin.path,
        callbacks: {
          canUseTool: async () => ({ behavior: "deny", message: DENY_TEXTS.permission }),
          onElicitation: async () => ({ action: "cancel" }),
          onUserDialog: async () => ({ behavior: "cancelled" }),
          stderr: () => {},
        },
        resume: null,
        sessionId: null,
        picks: {},
        switches: {},
        env,
      },
      {
        pinnedPath: pin.path,
        knownFolders: this.opts.knownFolders(),
        platformPackages: pin.platformPackages,
        allowBypass: this.opts.allowBypass(),
        promptSuggestionEnabled: false,
        ledgerSessionId: null,
        sessionExists: false,
        startEnv: START_ENV,
        envVars: env?.value ?? null,
      },
    );
    let ended = false;
    let wake = () => {};
    async function* idle(): AsyncGenerator<SDKUserMessage, void> {
      while (!ended) await new Promise<void>((r) => (wake = r));
    }
    const q = this.sdk.query({ prompt: idle(), options: built.options as Options });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop = () => {};
    const stopped = new Promise<null>((r) => (stop = () => r(null)));
    this.idleStops.add(stop);
    try {
      const late = new Promise<null>((r) => (timer = setTimeout(() => r(null), this.opts.commandsReadMs ?? COMMANDS_READ_MS)));
      // Both come from the one initialize answer.
      const lists = await Promise.race([Promise.all([q.supportedCommands(), q.supportedModels()]), late, stopped]).catch(() => undefined);
      if (!Array.isArray(lists) || !Array.isArray(lists[0])) throw new DriverError("failed", lists === null ? "No lists in time" : "The idle read failed");
      const models = modelInfos(lists[1]);
      return {
        commands: lists[0].map((c) => commandInfo(c, new Set())).filter((c): c is CommandInfo => c !== null),
        models,
        windows: await contextWindows(q, models, Promise.race([late, stopped])),
      };
    } finally {
      clearTimeout(timer);
      this.idleStops.delete(stop);
      ended = true;
      wake();
      try {
        q.close();
      } catch {}
      try {
        await q.return(undefined);
      } catch {}
      await waitForExit(childOf(q), this.opts.closeWaitMs ?? 8_000);
    }
  }
}

/** The settings' `hooks` hold at least one WorktreeCreate entry. */
function hasWorktreeHook(hooks: unknown): boolean {
  const list = typeof hooks === "object" && hooks !== null ? (hooks as Record<string, unknown>).WorktreeCreate : undefined;
  return Array.isArray(list) && list.length > 0;
}

/**
 * Row 94: each model row's context window on the idle query that answered the lists (the lead's live probe: 889 ms
 * for eight rows): first the "default" row's, as the query starts on the user's default model, then each other row's
 * after a switch to it (setModel), each a getContextUsage summary. No message is sent, so no model turn runs; one call
 * at a time, until `cut` (the read's cap, or endReads); a row whose switch or read fails is left out. Only the window
 * is kept: the model id that Claude Code reports with it (the default row's is a provider's ARN on Bedrock) is not.
 */
async function contextWindows(q: Query, models: readonly ModelInfo[], cut: Promise<null>): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  let over = false;
  void cut.then(() => (over = true));
  const read = async (row: string) => {
    const c = await Promise.race([q.getContextUsage({ detail: "summary" }), cut]);
    if (c && Number.isSafeInteger(c.maxTokens) && c.maxTokens > 0) out[row] = c.maxTokens;
  };
  const rows = models.map((m) => m.value).filter((v) => !isProviderArn(v));
  if (rows.includes("default")) await read("default").catch(() => {});
  for (const row of rows) {
    if (over) break;
    if (row === "default") continue;
    try {
      await Promise.race([q.setModel(row), cut]);
      if (!over) await read(row);
    } catch {
      // This row's window stays unknown.
    }
  }
  return out;
}

export function createClaudeDriver(opts: ClaudeDriverOptions): ClaudeDriver {
  return new ClaudeDriver(opts);
}

/** A single-consumer async queue: events wait until the registry reads them. */
class EventQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private ended = false;
  push(v: T): void {
    if (this.ended) return;
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false });
    else this.items.push(v);
  }
  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
    };
  }
}

type ChildLike = { pid?: number; exitCode: number | null; signalCode: string | null; once(ev: "exit", f: () => void): unknown };

/** The SDK keeps its child process on an untyped field; read it only when it looks like one (feature test). */
function childOf(q: Query | null): ChildLike | null {
  const p = (q as unknown as { transport?: { process?: unknown } } | null)?.transport?.process as ChildLike | undefined;
  return p && typeof p.once === "function" && "exitCode" in p ? p : null;
}

function waitForExit(p: ChildLike | null, ms: number): Promise<void> {
  if (!p || p.exitCode !== null || p.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    p.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

/** The exit code and signal the SDK names in the error it throws when the process ends badly. */
function exitOf(e: unknown): { code: number | null; signal: string | null } {
  const msg = String((e as Error)?.message ?? e);
  const code = /exited with code (\d+)/.exec(msg);
  if (code) return { code: Number(code[1]), signal: null };
  const sig = /terminated by signal (SIG[A-Z0-9]+)/.exec(msg);
  if (sig) return { code: null, signal: sig[1]! };
  return { code: null, signal: null };
}

function questionsOf(v: unknown): Question[] {
  if (!Array.isArray(v)) return [];
  const s = (x: unknown) => capText(typeof x === "string" ? x : "", LIMITS.inputString);
  return v
    .filter((q): q is Record<string, unknown> => typeof q === "object" && q !== null)
    .map((q) => ({
      question: s(q.question),
      header: s(q.header),
      multiSelect: q.multiSelect === true,
      options: (Array.isArray(q.options) ? q.options : [])
        .filter((o): o is Record<string, unknown> => typeof o === "object" && o !== null)
        .map((o) => ({ label: s(o.label), description: s(o.description) })),
    }));
}

/** Whether a tool_use input holds a `ui://` view (MCP Apps), which kitespan names but does not draw (6.3). */
function hasView(tools: unknown): boolean {
  if (!Array.isArray(tools)) return false;
  const deep = (v: unknown, depth: number): boolean => {
    if (typeof v === "string") return v.startsWith("ui://");
    if (depth > 3 || typeof v !== "object" || v === null) return false;
    return Object.values(v).some((x) => deep(x, depth + 1));
  };
  return tools.some((t) => typeof t === "object" && t !== null && deep((t as { _meta?: unknown })._meta, 0));
}

/** One live chat: one query(), one input iterable, one event stream. */
export class ClaudeChat implements AgentChat {
  private readonly queue = new EventQueue<ChatEvent>();
  readonly events: AsyncIterable<ChatEvent> = this.queue;
  private readonly mapper: EventMapper;
  private readonly built: BuiltOptions;
  private readonly bypass: boolean;
  private q: Query | null = null;
  private readonly started: Promise<void>;
  private pumpDone: Promise<void> = Promise.resolve();
  private closing: Promise<void> | null = null;
  private closed = false;
  // The input iterable's own queue.
  private readonly inbox: SDKUserMessage[] = [];
  private wake: () => void = () => {};
  private inputEnded = false;
  /** Every uuid the host put on the input (an echo with one of them is dropped). */
  private readonly sent = new Set<string>();
  /** Messages that should start a turn and have not been answered yet. */
  private readonly waiting = new Set<string>();
  private firstText: string | null = null;
  private readonly stderrTail: string[] = [];
  /** Task ids seen in task events: stopTask takes only these (the spike's id check). */
  private readonly tasks = new Set<string>();
  private readonly cardAborts = new Set<AbortController>();
  /** URL-mode elicitations by elicitationId, settled by `elicitation_complete`. */
  private readonly urlCards = new Map<string, { abort: AbortController; completed: boolean }>();
  /** The claude process's id, once found (findPid). */
  private childPid: number | null = null;
  /** The chat's model row value now (its pick, then each setModel); null: the default row. */
  private modelRow: string | null;

  constructor(
    private readonly driver: ClaudeDriver,
    private readonly input: ClaudeOpenInput,
    pin: Pin,
  ) {
    this.bypass = input.switches.allowBypass !== undefined;
    this.modelRow = input.picks.model?.value ?? null;
    this.mapper = new EventMapper({
      bypass: this.bypass,
      isOwnMessage: (uuid) => this.sent.has(uuid),
      userWaiting: () => this.waiting.size > 0,
    });
    const canUseTool: CanUseTool = (name, toolInput, o) => this.canUseTool(name, toolInput, o);
    const onElicitation: OnElicitation = (req, o) => this.onElicitation(req, o);
    // No dialog kind is declared (supportedDialogKinds is not passed), so the CLI sends none; one that still comes
    // gets `cancelled`, as the SDK asks for a kind the host cannot draw (S93).
    const onUserDialog: OnUserDialog = async () => ({ behavior: "cancelled" });
    const stderr = (data: string) => this.onStderr(data);
    // Row 73: a chat in its own worktree reads its project's settings (projectConfigRoot), so the registry read them there.
    const worktree = input.worktree ?? null;
    const settings = driver.settingsSeen.get(worktree?.own ? worktree.root : input.cwd);
    this.built = rawOptions(
      {
        cwd: input.cwd,
        binary: pin.path!,
        callbacks: { canUseTool, onElicitation, onUserDialog, stderr },
        resume: input.resume,
        sessionId: input.sessionId,
        picks: input.picks,
        switches: input.switches,
        worktree,
        // D60: the environment's variables over the start environment (never the server's process.env, which holds
        // the SDK's own names); the live chat keeps this set.
        env: input.env ?? null,
      },
      {
        pinnedPath: pin.path,
        knownFolders: driver.opts.knownFolders(),
        platformPackages: pin.platformPackages,
        allowBypass: driver.opts.allowBypass(),
        promptSuggestionEnabled: settings?.promptSuggestions === true,
        ledgerSessionId: input.ledgerSessionId,
        sessionExists: input.sessionId ? driver.knownSessions.has(input.sessionId.value) : false,
        worktree,
        startEnv: START_ENV,
        envVars: input.env?.value ?? null,
      },
    );
    this.started = this.start();
  }

  /** The claude process's id while it runs (R16), else null: not found yet, or the process is gone. */
  get pid(): number | null {
    const child = childOf(this.q);
    if (!child || child.exitCode !== null || child.signalCode !== null || this.finished) return null;
    return this.childPid;
  }

  /**
   * The SDK's process object has no pid, so the driver finds its chat's claude among the server's children by the
   * argument that names the chat's session (`--resume=<id>` or `--session-id=<id>`: one process per session, D49). A
   * few tries while the SDK spawns it; none found leaves it null, and then D58's hold covers the process after a kill.
   */
  private async findPid(): Promise<void> {
    const arg = this.input.resume ? `--resume=${this.input.resume.value}` : this.input.sessionId ? `--session-id=${this.input.sessionId.value}` : null;
    if (!arg) return;
    for (const wait of [0, 50, 250, 1_000, 3_000]) {
      if (wait) await Bun.sleep(wait);
      if (this.finished) return;
      const pid = await childWithArg(process.pid, arg).catch(() => null);
      if (pid !== null) {
        this.childPid = pid;
        return;
      }
    }
  }

  /** The options this chat started with, callbacks as "[function]", `env` as names only (G2). */
  get optionsSnapshot(): Record<string, unknown> {
    return snapshotOptions(this.built.options, this.built.envNames);
  }

  private async start(): Promise<void> {
    try {
      await this.driver.opts.writeLastOptions?.({
        v: 1,
        writtenAt: this.driver.now().toISOString(),
        sdk: SDK_VERSION,
        chat: this.input.chatId,
        options: snapshotOptions(this.built.options, this.built.envNames),
        marks: { ...this.built.marks },
      });
    } catch {}
    if (this.closed) {
      this.finish({ code: null, signal: null });
      return;
    }
    let q: Query;
    try {
      q = this.driver.sdk.query({ prompt: this.inputIterable(), options: this.built.options as Options });
    } catch (e) {
      this.finish(exitOf(e));
      return;
    }
    this.q = q;
    this.pumpDone = this.pump(q);
    void this.afterInitialize(q);
    void this.findPid();
  }

  private async afterInitialize(q: Query): Promise<void> {
    try {
      const init = await q.initializationResult();
      if (Array.isArray(init.commands) && !this.mapper.commands) this.queue.push(this.mapper.commandsEvent(init.commands));
    } catch {}
  }

  /** The streaming input: it yields the host's messages, waits while there are none, and never throws. */
  private async *inputIterable(): AsyncGenerator<SDKUserMessage, void> {
    try {
      for (;;) {
        const m = this.inbox.shift();
        if (m) {
          yield m;
          continue;
        }
        if (this.inputEnded) return;
        await new Promise<void>((r) => (this.wake = r));
        this.wake = () => {};
      }
    } catch {
      // Never raised into the SDK: a throw here would abort the query and end the CLI's stdin.
    }
  }

  private put(m: SDKUserMessage): void {
    this.inbox.push(m);
    this.wake();
  }

  private endInput(): void {
    this.inputEnded = true;
    this.wake();
  }

  private async pump(q: Query): Promise<void> {
    let exit: { code: number | null; signal: string | null } = { code: null, signal: null };
    try {
      for await (const m of q) this.onMessage(m);
    } catch (e) {
      exit = exitOf(e);
    }
    const child = childOf(q);
    if (child && exit.code === null && exit.signal === null) exit = { code: child.exitCode, signal: child.signalCode };
    this.finish(exit);
  }

  private finished = false;
  private finish(exit: { code: number | null; signal: string | null }): void {
    if (this.finished) return;
    this.finished = true;
    this.closed = true;
    this.endInput();
    // A card cannot outlive its claude process: every open one resolves as closed (the registry marks it lost).
    for (const a of this.cardAborts) a.abort(CARD_ABORT.ended);
    // The last stderr line, if the process ended in the middle of it.
    if (this.stderrRest) this.stderrLine(this.stderrRest, true);
    this.stderrRest = "";
    this.queue.push({ k: "exit", code: exit.code, signal: exit.signal, stderr: [...this.stderrTail], ...(this.startup ? { startup: this.startup } : {}) });
    this.queue.end();
  }

  /** W5: Claude Code refused this start itself (an error result with `startup_failure_reason`); its `exit` says so. */
  private startup: StartupFailure | null = null;

  private onMessage(m: SDKMessage): void {
    try {
      const o = m as unknown as Record<string, unknown>;
      // R124: a side question's progress goes to the one side question in flight; it is no event of the chat.
      const side = sideProgressOf(o);
      if (side || (o.type === "system" && o.subtype === "control_request_progress")) {
        if (side) this.sideProgress?.(side);
        return;
      }
      // W5: a refused start is no turn: the exit carries the refusal, and nothing else of the result shows.
      const refused = startupFailureOf(o, this.input.env?.value);
      if (refused) {
        this.startup = refused;
        return;
      }
      if (o.type === "system" && o.subtype === "elicitation_complete" && typeof o.elicitation_id === "string") {
        const c = this.urlCards.get(o.elicitation_id);
        if (c) {
          c.completed = true;
          c.abort.abort(CARD_ABORT.completed);
        }
      }
      if (o.type === "system" && typeof o.subtype === "string" && o.subtype.startsWith("task_") && typeof o.task_id === "string") {
        this.tasks.add(o.task_id);
        this.mapper.noteTask(o.task_id, typeof o.tool_use_id === "string" ? o.tool_use_id : null);
      }
      const events = this.mapper.map(m);
      for (const e of events) {
        if (e.k === "turn_end") this.settleWaiting(e.uuids);
        this.queue.push(e);
      }
      // Claude Code has written the transcript once a turn ran (D41: the next start of this session is a resume).
      if (o.type === "result" && this.mapper.sessionId) this.driver.knownSessions.add(this.mapper.sessionId);
    } catch {}
  }

  private settleWaiting(uuids: string[]): void {
    if (uuids.length) for (const u of uuids) this.waiting.delete(u);
    else {
      const first = this.waiting.values().next();
      if (!first.done) this.waiting.delete(first.value);
    }
  }

  /**
   * D60 (E7): the stderr line that the last chunk left unfinished (the SDK hands each chunk of the child's stderr on
   * as it comes, and a chunk can end in the middle of a line and of a value). `stderrSkip`: the rest of a line that
   * grew past STDERR_REST_MAX is dropped up to its end.
   */
  private stderrRest = "";
  private stderrSkip = false;

  private onStderr(data: string): void {
    let text = String(data);
    if (this.stderrSkip) {
      const end = text.indexOf("\n");
      if (end < 0) return;
      this.stderrSkip = false;
      text = text.slice(end + 1);
    }
    const lines = (this.stderrRest + text).split("\n");
    this.stderrRest = lines.pop()!;
    for (const line of lines) this.stderrLine(line);
    if (this.stderrRest.length > STDERR_REST_MAX) {
      this.stderrRest = "";
      this.stderrSkip = true;
    }
  }

  /** One whole stderr line into the tail; `cut`: the process ended in the middle of it. */
  private stderrLine(line: string, cut = false): void {
    // D60 (E7): each stored value reads as the mask, before the line is trimmed and cut. A value has no line end (E2),
    // so a whole line holds it whole; a line that the process's end cut also masks the start of a value at its end.
    const t = maskValues(line, this.input.env?.value, cut).trim();
    if (!t) return;
    this.stderrTail.push(capText(t, LIMITS.stderrLine));
    if (this.stderrTail.length > LIMITS.stderrLines) this.stderrTail.shift();
  }

  // -------------------------------------------------------------------------------------------------------------
  // The card callbacks

  /**
   * Ask the user through the registry. null: the card closed with no answer (the SDK cancelled, Stop, the end). The
   * card's signal says why it aborted (CARD_ABORT): the SDK also aborts every waiting request when its query ends (its
   * cleanup), and such a card is lost with its process, not withdrawn by Claude Code.
   */
  private async ask(card: Card, sdkSignal: AbortSignal, own = new AbortController()): Promise<CardAnswer | null> {
    this.cardAborts.add(own);
    const onSdkAbort = () => own.abort(this.queryEnded() ? CARD_ABORT.ended : sdkSignal.reason);
    if (sdkSignal.aborted) onSdkAbort();
    else sdkSignal.addEventListener("abort", onSdkAbort, { once: true });
    try {
      if (this.closed) return null;
      const a = await this.input.cards.ask(card, own.signal);
      return a ? capAnswer(a) : null;
    } catch {
      return null;
    } finally {
      sdkSignal.removeEventListener("abort", onSdkAbort);
      this.cardAborts.delete(own);
    }
  }

  /** The chat is closing or its query has ended (the SDK's own untyped `cleanupPerformed`, read only when it is a boolean). */
  private queryEnded(): boolean {
    if (this.closed || this.finished) return true;
    return (this.q as unknown as { cleanupPerformed?: unknown } | null)?.cleanupPerformed === true;
  }

  private async canUseTool(toolName: string, input: Record<string, unknown>, o: Parameters<CanUseTool>[2]): Promise<PermissionResult> {
    const toolUseId = o.toolUseID || o.requestId;
    if (toolName === "AskUserQuestion") {
      const questions = questionsOf(input.questions);
      const a = await this.ask({ kind: "question", id: toolUseId, toolUseId, questions }, o.signal);
      if (!a || a.kind !== "question") return { behavior: "deny", message: DENY_TEXTS.question };
      const known = new Set(questions.map((q) => q.question));
      const answers = Object.fromEntries(Object.entries(a.answers).filter(([k, v]) => known.has(k) && typeof v === "string"));
      if (!Object.keys(answers).length) return { behavior: "deny", message: DENY_TEXTS.question };
      return { behavior: "allow", updatedInput: { ...input, answers } };
    }
    if (toolName === "ExitPlanMode") {
      const plan = typeof input.plan === "string" ? input.plan : "";
      const a = await this.ask({ kind: "plan", id: toolUseId, toolUseId, plan }, o.signal);
      if (!a || a.kind !== "plan") return { behavior: "deny", message: DENY_TEXTS.planDismissed };
      if (!a.approve) return { behavior: "deny", message: a.feedback.trim() || DENY_TEXTS.plan };
      // The bypass variant only in a chat whose Claude Code started with the bypass flag (D12, 6.3).
      const mode: ModeId = (PLAN_MODES as readonly string[]).includes(a.mode) && (a.mode !== "bypassPermissions" || this.bypass) ? a.mode : "default";
      // Also set the mode once the answer is out (CA-3): the CLI applies the setMode rule, and this makes sure.
      setTimeout(() => void this.q?.setPermissionMode(mode).catch(() => {}), 0);
      return { behavior: "allow", updatedInput: input, updatedPermissions: [{ type: "setMode", mode, destination: "session" }] };
    }
    // Every other tool, the Workflow launch included (CA-4: a permission card whose toolName is Workflow).
    const suggestions: PermissionUpdate[] = Array.isArray(o.suggestions) ? o.suggestions : [];
    const suppress = o.suppressAlwaysAllowRule === true;
    const sessionRule = !suppress && suggestions.length > 0;
    const parent = o.agentID ? this.mapper.toolUseOfTask(o.agentID) : null;
    const a = await this.ask(
      {
        kind: "permission",
        id: toolUseId,
        toolUseId,
        toolName,
        title: o.title ?? null,
        displayName: o.displayName ?? null,
        description: o.description ?? null,
        reason: o.decisionReason ?? null,
        blockedPath: o.blockedPath ?? null,
        input: capInput(input),
        defaultToNo: o.defaultToNo === true,
        suppressAlwaysAllowRule: suppress,
        sessionRule,
        parent,
      },
      o.signal,
    );
    if (!a || a.kind !== "permission") return { behavior: "deny", message: DENY_TEXTS.permission };
    if (!a.allow) return { behavior: "deny", message: a.message.trim() || DENY_TEXTS.permission };
    // Allow for this session: Claude Code's own suggested rules with the `session` destination, so no settings file
    // is written; never when the request forbids a persistent choice (a session answer then counts as once).
    if (a.scope === "session" && sessionRule)
      return { behavior: "allow", updatedInput: input, updatedPermissions: suggestions.map((s) => ({ ...s, destination: "session" }) as PermissionUpdate) };
    return { behavior: "allow", updatedInput: input };
  }

  private async onElicitation(req: Parameters<OnElicitation>[0], o: Parameters<OnElicitation>[1]): Promise<ElicitationResult> {
    const mode = req.mode === "url" ? "url" : "form";
    const own = new AbortController();
    const entry = { abort: own, completed: false };
    if (mode === "url" && req.elicitationId) this.urlCards.set(req.elicitationId, entry);
    try {
      const a = await this.ask(
        {
          kind: "elicitation",
          id: o.requestId,
          server: req.serverName,
          displayName: req.displayName ?? null,
          title: req.title ?? null,
          description: req.description ?? null,
          message: req.message,
          mode,
          url: mode === "url" ? (req.url ?? null) : null,
          elicitationId: req.elicitationId ?? null,
          schema: req.requestedSchema ?? null,
        },
        o.signal,
        own,
      );
      // The server said the URL flow is done: the user completed it in the other tab.
      if (!a && entry.completed) return { action: "accept" };
      if (!a || a.kind !== "elicitation") return { action: "cancel" };
      if (a.action === "accept") return mode === "form" && a.content ? { action: "accept", content: a.content } : { action: "accept" };
      return { action: a.action };
    } finally {
      if (req.elicitationId) this.urlCards.delete(req.elicitationId);
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // The chat's actions

  private async live(): Promise<Query> {
    await this.started;
    if (!this.q || this.closed) throw new DriverError("failed", "This chat's Claude Code is not running");
    return this.q;
  }

  async send(turn: { uuid: string; text: string }): Promise<void> {
    if (this.closed) throw new DriverError("failed", "This chat's Claude Code has ended");
    if (!UUID_RE.test(turn.uuid)) throw new DriverError("bad_request", "A message needs a uuid");
    if (typeof turn.text !== "string") throw new DriverError("bad_request", "A message needs text");
    if (this.firstText === null) this.firstText = turn.text;
    this.sent.add(turn.uuid);
    this.waiting.add(turn.uuid);
    this.put({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: turn.text }] },
      parent_tool_use_id: null,
      uuid: turn.uuid as SDKUserMessage["uuid"],
      origin: { kind: "human" },
    });
  }

  async bashRecord(rec: { uuid: string; input: string; stdout: string; stderr: string; reply: boolean }): Promise<void> {
    if (this.closed) throw new DriverError("failed", "This chat's Claude Code has ended");
    if (!UUID_RE.test(rec.uuid)) throw new DriverError("bad_request", "A record needs a uuid");
    const uuid = rec.uuid;
    this.sent.add(uuid);
    if (rec.reply) this.waiting.add(uuid);
    this.put({
      type: "user",
      message: { role: "user", content: bashRecordText(rec.input, rec.stdout, rec.stderr) },
      parent_tool_use_id: null,
      shouldQuery: rec.reply,
      uuid: uuid as SDKUserMessage["uuid"],
      origin: { kind: "human" },
    });
  }

  async interrupt(): Promise<{ stillQueued: string[] | null }> {
    if (!this.q || this.closed) return { stillQueued: null };
    try {
      const r = await this.q.interrupt();
      return { stillQueued: Array.isArray(r?.still_queued) ? r.still_queued : null };
    } catch {
      throw new DriverError("failed", "interrupt failed");
    }
  }

  async setModel(model: string | null): Promise<void> {
    const q = await this.live();
    // The SDK's "back to the default" is undefined; a null would go out as JSON null (V-sdk C4).
    await q.setModel(model ?? undefined);
    this.modelRow = model;
  }

  async setEffort(level: EffortId | null): Promise<void> {
    if (level !== null && !(EFFORT_IDS as readonly string[]).includes(level)) throw new DriverError("bad_request", "Not an effort level");
    const q = await this.live();
    await q.applyFlagSettings({ effortLevel: level });
  }

  async setMode(mode: ModeId): Promise<void> {
    if (!(MODE_IDS as readonly string[]).includes(mode)) throw new DriverError("bad_request", "Not a mode");
    if (mode === "bypassPermissions" && !this.bypass) throw new DriverError("unsupported", "Bypass needs the Settings switch and a new start");
    const q = await this.live();
    await q.setPermissionMode(mode);
  }

  async commands(): Promise<CommandInfo[]> {
    const q = await this.live();
    const list = await q.supportedCommands();
    return list.map((c) => commandInfo(c, this.mapper.terminalOnly)).filter((c): c is CommandInfo => c !== null);
  }

  async models(): Promise<ModelInfo[]> {
    const q = await this.live();
    return modelInfos(await q.supportedModels());
  }

  async context(): Promise<ContextInfo | null> {
    if (!this.q || this.closed) return null;
    try {
      const c = await this.q.getContextUsage({ detail: "summary" });
      // Row 94: a provider's ARN (the default model on Bedrock) goes no further: the chat's model row stands for it.
      const row = this.modelRow ?? "default";
      return {
        model: isProviderArn(c.model) ? (isProviderArn(row) ? null : row) : typeof c.model === "string" ? c.model : null,
        usedTokens: c.totalTokens,
        maxTokens: c.maxTokens,
        percent: c.percentage,
        parts: (c.categories ?? []).map((x) => ({ name: x.name, tokens: x.tokens, kind: x.kind })),
      };
    } catch {
      return null;
    }
  }

  async connectors(): Promise<ConnectorInfo[]> {
    const q = await this.live();
    const list = await q.mcpServerStatus();
    return list.map((s) => ({
      name: s.name,
      status: s.status,
      error: s.error ?? null,
      tools: Array.isArray(s.tools) ? s.tools.length : 0,
      scope: s.scope ?? s.source ?? null,
      hasView: hasView(s.tools),
    }));
  }

  async reconnect(server: string): Promise<void> {
    const q = await this.live();
    const known = await q.mcpServerStatus().catch(() => []);
    if (!known.some((s) => s.name === server)) throw new DriverError("not_found", "No such MCP server");
    await q.reconnectMcpServer(server);
  }

  async setAlwaysAsk(_server: string, _on: boolean): Promise<{ warning: string | null }> {
    // setMcpPermissionModeOverride says the override "is stored", not where (DESIGN 6.7): no call until the
    // throwaway-home check of DESIGN 12 question 11 shows that it writes no file.
    throw new DriverError("unsupported", "Always ask waits for its check");
  }

  async setEnabled(_server: string, _enabled: boolean): Promise<void> {
    // toggleMcpServer likely writes the user's own config (DESIGN 12 question 11): not used until its check passes.
    throw new DriverError("unsupported", "Turning a connector on or off waits for its check");
  }

  async stopTask(taskId: string): Promise<void> {
    if (!this.tasks.has(taskId)) throw new DriverError("stale", "Not a task of this chat");
    const q = await this.live();
    await q.stopTask(taskId);
  }

  async runInBackground(toolUseId: string): Promise<boolean> {
    const q = await this.live();
    try {
      return (await q.backgroundTasks(toolUseId)) === true;
    } catch {
      // Background tasks are off for this session.
      return false;
    }
  }

  async backgroundAll(): Promise<boolean> {
    const q = await this.live();
    try {
      // No tool-use id: every foreground task, as Ctrl+B (sdk.d.ts 0.3.312 lines 3310-3324).
      return (await q.backgroundTasks()) === true;
    } catch {
      // Background tasks are off for this session.
      return false;
    }
  }

  async takeBack(uuid: string): Promise<{ cancelled: boolean }> {
    const q = await this.live();
    const fn = (q as unknown as { cancelAsyncMessage?: unknown }).cancelAsyncMessage;
    if (typeof fn !== "function") throw new DriverError("unsupported", "cancelAsyncMessage is not available");
    const cancelled = (await (fn as (u: string) => Promise<unknown>).call(q, uuid)) === true;
    if (cancelled) this.waiting.delete(uuid);
    return { cancelled };
  }

  async reload(): Promise<void> {
    const q = await this.live();
    const r = await Promise.allSettled([q.reloadSkills(), q.reloadPlugins(), q.reloadOutputStyles()]);
    if (r.every((x) => x.status === "rejected")) throw new DriverError("failed", "reload failed");
  }

  async generateTitle(): Promise<string | null> {
    if (!this.q || this.closed) return null;
    const fn = (this.q as unknown as { generateSessionTitle?: unknown }).generateSessionTitle;
    if (typeof fn !== "function") return null;
    try {
      // persist false: the title goes into kitespan's ledger; Claude Code's transcript is written only by a rename.
      const t = await (fn as (d: string, o: { persist: boolean }) => Promise<unknown>).call(this.q, capText(this.firstText ?? "", LIMITS.answerText), { persist: false });
      return cleanTitle(t);
    } catch {
      return null;
    }
  }

  async rename(title: string, sessionId: string): Promise<boolean> {
    const t = cleanTitle(title);
    if (!t || !UUID_RE.test(sessionId)) throw new DriverError("bad_request", "A rename needs a title and a session id");
    if (!this.q || this.closed) return false;
    // The SDK's untyped renameSession sends `rename_session` with `source: 'host'` (the CLI counts it as a user
    // rename) and the session id, so a process that has moved to another session refuses it.
    const fn = (this.q as unknown as { renameSession?: unknown }).renameSession;
    if (typeof fn !== "function") return false;
    try {
      await (fn as (title: string, sessionId: string) => Promise<unknown>).call(this.q, t, sessionId);
    } catch {
      throw new DriverError("failed", "rename_session failed");
    }
    return true;
  }

  async account(): Promise<{ provider: string | null }> {
    if (!this.q || this.closed) return { provider: null };
    try {
      const a = await this.q.accountInfo();
      return { provider: typeof a?.apiProvider === "string" ? a.apiProvider : null };
    } catch {
      return { provider: null };
    }
  }

  /** R124: where the side question in flight takes its progress (one per chat, the registry's rule). */
  private sideProgress: ((p: SideProgress) => void) | null = null;

  /**
   * R124: the SDK's untyped askSideQuestion (side.ts), after the process's initialize answer. History goes only when
   * there is some (the SDK's own rule). The CLI answers it while a turn runs and while none does.
   */
  async sideQuestion(question: string, opts: { history: readonly SideTurn[]; signal: AbortSignal; onProgress?: (p: SideProgress) => void }): Promise<SideAnswer | null> {
    const q = await untilAborted(this.live(), opts.signal);
    const ask = sideQuestionOf(q);
    if (!ask) throw new DriverError("unsupported", SIDE_MISSING);
    await untilAborted(q.initializationResult(), opts.signal);
    if (this.closed) throw new DriverError("failed", "This chat's Claude Code has ended");
    const onProgress = opts.onProgress ?? null;
    this.sideProgress = onProgress;
    try {
      const history = opts.history.map((h) => ({ question: h.question, response: h.response }));
      return sideAnswerOf(await ask(question, { ...(history.length ? { history } : {}), signal: opts.signal }));
    } finally {
      if (this.sideProgress === onProgress) this.sideProgress = null;
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      this.closed = true;
      for (const a of this.cardAborts) a.abort(CARD_ABORT.ended);
      await this.started;
      const q = this.q;
      if (!q) {
        this.finish({ code: null, signal: null });
        return;
      }
      // The SDK ends stdin, sends SIGTERM 2 s later and SIGKILL 5 s after that (4.1).
      try {
        q.close();
      } catch {}
      this.endInput();
      await this.pumpDone;
      try {
        await q.return(undefined); // awaits the SDK's own cleanup, which waits up to 2 s for the exit
      } catch {}
      await waitForExit(childOf(q), this.driver.opts.closeWaitMs ?? 8_000);
    })();
    return this.closing;
  }
}
