// The agent seam (DESIGN.md 4.2): the only types the chat layer knows about an agent. Only server/agents/claude/
// imports the Agent SDK; everything else talks to an AgentDriver and reads neutral ChatEvents (shared/protocol.ts).

import type {
  BgStopAnswer,
  BgWait,
  Card,
  CardAnswer,
  ChatEvent,
  ClaudeBelow,
  CommandInfo,
  ConnectorInfo,
  ContextInfo,
  EffortId,
  ModeId,
  ModelInfo,
  SessionOpen,
} from "../../shared/protocol";

export type {
  Card,
  CardAnswer,
  ChatEvent,
  CommandInfo,
  ConnectorInfo,
  ContextInfo,
  ModelInfo,
  OpenApp,
  Question,
  SessionOpen,
  TaskEvent,
  WorkflowStep,
} from "../../shared/protocol";

/** The agent that kitespan runs: Claude Code only (row 117). */
export type AgentKind = "claude-code";

/** What the driver found when it looked for the agent's binary (4.7, D18: the PATH claude only, no fallback). */
export interface BinaryProbe {
  ok: boolean;
  /** The binary that chats will run (server-side; shown in Settings > Claude Code). */
  path: string | null;
  realpath: string | null;
  /** From `<binary> --version` (15 s timeout, no model call). */
  version: string | null;
  source: "path";
  refused: { path: string; reason: "missing" | "not-executable" | "inside-node_modules" }[];
  /** SDK platform packages found in the install tree (4.7, negative case 10); any one makes `ok` false. */
  platformPackages: string[];
  /** One line when the version differs from the one the pinned SDK names (4.10), else null. */
  drift: string | null;
  /** Below kitespan's minimum Claude Code version (rows 118, 119), else null; null too when the version cannot be read. */
  belowMinimum: ClaudeBelow | null;
}

/** What a driver can do; the page shows only the controls that a driver supports. */
export interface AgentCapabilities {
  models: boolean;
  effort: boolean;
  modes: ModeId[];
  /** A `/` menu. */
  commands: boolean;
  /** `!` records. */
  bash: boolean;
  contextUsage: boolean;
  /** MCP status and Reconnect. */
  connectors: boolean;
  /** Per-task Stop. */
  backgroundTasks: boolean;
  /** Run in background on one running task. */
  runInBackground: boolean;
  /** Take back a queued message (an untyped method, D6: feature-detected on a live chat). */
  takeBack: boolean;
  /** The agent's own title generation (an untyped method, D13: feature-detected). */
  titles: boolean;
  rename: boolean;
  /** Delete a chat's transcript (D48). */
  deleteSession: boolean;
  /** R124: side questions (an untyped method, D6: feature-detected on a live chat), the side chat. */
  sideQuestions: boolean;
  /**
   * R127: the agent can record a folder's trust itself (for Claude: the SDK's untyped host attestation, on the pinned
   * SDK only); off, a refused folder's line offers Open in terminal instead.
   */
  trustFolder: boolean;
}

/** R124: one earlier side exchange as the agent reads it with a side question (the SDK's `{question, response}`). */
export interface SideTurn {
  question: string;
  response: string;
}

/** R124: a side question's progress (`control_request_progress`): taken on, or an API retry (6.3's numbers). */
export type SideProgress = { status: "started" } | { status: "api_retry"; attempt: number; max: number; delayMs: number };

/**
 * R124: a side question's answer. `synthetic`: Claude Code made it, not the model. `fallback`: a fallback model
 * answered after a refusal, with Claude Code's notice (sideFallback: cut, never a provider's ARN); the model names of
 * a fallback are never passed on.
 */
export interface SideAnswer {
  response: string;
  synthetic: boolean;
  fallback: string | null;
}

/** A value with the mark that the raw-options gate checks (4.7): `<phrase> on <ISO 8601 time ending in Z>`. */
export interface Marked<T> {
  value: T;
  mark: string;
}

/**
 * The mark phrases (4.7). The gate passes a marked key only with one of these, and only the phrases its row allows.
 * `newSession` is the D41 row the build brief adds (`sessionId`, first start only, never with `resume`); its words
 * are a proposal for the gate's owner to confirm.
 */
export const MARK_PHRASES = {
  pick: "the user's pick in this chat",
  remembered: "remembered from the user's pick",
  resume: "the user opened this past chat",
  newSession: "the user started this new chat",
  bypass: "the user allowed bypass permissions mode in Settings",
  suggestions: "the user turned on prompt suggestions",
  /** D60 (L43): the variables the user set for the chat's environment; the user's, not kitespan's. */
  env: "the user set these variables for this environment",
} as const;
export type MarkPhrase = (typeof MARK_PHRASES)[keyof typeof MARK_PHRASES];

/** A mark string for `phrase` at `at`. */
export function markOf(phrase: MarkPhrase, at: Date): string {
  return `${phrase} on ${at.toISOString()}`;
}

/** The shape of a mark: a known phrase, " on ", and an ISO 8601 UTC time with milliseconds. */
export const MARK_RE = new RegExp(
  `^(${Object.values(MARK_PHRASES).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")}) on (\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z)$`,
);

/** The user's own picks for this chat, each with its mark. */
export interface MarkedPicks {
  model?: Marked<string>;
  effort?: Marked<EffortId>;
  permissionMode?: Marked<ModeId>;
}

/** The Switch rows of 4.7, each present only when the user's own choice turns it on. */
export interface MarkedSwitches {
  /** allowDangerouslySkipPermissions, while Settings > Chats "Allow bypass permissions mode" is on (D12). */
  allowBypass?: Marked<true>;
  /** promptSuggestions, while the user's own promptSuggestionEnabled is true (an absent setting counts as off). */
  promptSuggestions?: Marked<true>;
}

/**
 * How a driver asks the user (the card callbacks of 4.1 and 4.2). The registry keeps the card in memory, sends it to
 * every viewer (`card_open`, and in `attached`), and resolves with the first answer; a second answer gets `stale`.
 * It resolves with null when the card closes with no answer: the signal aborted (Claude Code cancelled the request),
 * Stop answered it as dismissed, or the chat is ending. The driver turns null into the dismissal that 6.3 names: a
 * denial for a permission, plan or question card, Cancel for an elicitation, `cancelled` for a dialog.
 */
export interface CardHost {
  ask(card: Card, signal: AbortSignal): Promise<CardAnswer | null>;
}

/**
 * The reasons a driver gives when it aborts a card's signal itself (`signal.reason`), so the record says how the card
 * closed (5.4): its process ended or was closed (`ended`: the card is lost), or the user finished it elsewhere
 * (`completed`: a URL-mode elicitation that its server reported done). Any other abort is Claude Code withdrawing it.
 */
export const CARD_ABORT = { ended: "kitespan:card-ended", completed: "kitespan:card-completed" } as const;

export interface OpenInput {
  /** kitespan's own chat id (4.4). */
  chatId: string;
  /** The project folder; never sent to the browser in a URL. */
  cwd: string;
  /** The agent's session id, when the chat has a transcript (marked "the user opened this past chat"). */
  resume: Marked<string> | null;
  /**
   * D41: the session id that kitespan picks, passed on the chat's first start only, while no transcript exists for it,
   * and never together with `resume` (live L1: a second start with the same id and no resume is refused).
   */
  sessionId: Marked<string> | null;
  /** The session id in the chat's ledger: the gate passes `sessionId` or `resume` only when it is this id (null: neither). */
  ledgerSessionId: string | null;
  picks: MarkedPicks;
  switches: MarkedSwitches;
  /**
   * D60: the variables the user set for the chat's environment, in the user's order, read right before this start;
   * null when it has none (then the agent gets the server's environment as before).
   */
  env?: Marked<EnvVar[]> | null;
  /**
   * Row 73: `cwd` is a linked worktree of the chat's project folder `root` (the gate's worktree case of `cwd`, G4).
   * `own`: kitespan made it for this chat (W3), so the agent reads the project's config from `root` (G3,
   * `projectConfigRoot`); false: the worktree that a terminal session ran in (W12). Absent or null: no worktree.
   */
  worktree?: { path: string; root: string; own: boolean } | null;
  cards: CardHost;
}

/** One variable of an environment (D60). Its value never leaves the server: no log, frame, API answer or URL. */
export interface EnvVar {
  name: string;
  value: string;
}

/** One Claude Code session in a folder, as the session list reports it. */
export interface SessionInfo {
  sessionId: string;
  /** The custom title (a rename or the agent's own), else the first prompt; never the summary. */
  title: string;
  /** The custom title alone (a /rename, a rename in the terminal or in kitespan), null when it has none. */
  customTitle: string | null;
  lastModified: number;
  cwd: string | null;
  /** W6, L31: the git branch at the session's end, as the agent recorded it; absent or null when it names none. */
  gitBranch?: string | null;
  /** R131: the transcript's size in bytes, when the agent reports it (with `lastModified`, the view's lite read). */
  fileSize?: number;
}

/**
 * R131: a background session's record in the agent's registry of running sessions (for Claude: `kind: "bg"`), with only
 * the fields kitespan reads, each by its rule: the short id, the session id, its name (control characters out, at most
 * 120), its folder (absolute, at most 4,096 bytes, else null), its status (`waiting` with what it waits for), its start
 * time and its process (pid and start, the liveness check that every record gets). Never sent or logged as is.
 */
export interface BgRecord {
  jobId: string;
  sessionId: string;
  name: string | null;
  cwd: string | null;
  status: "busy" | "waiting" | "idle";
  waitingFor: BgWait | null;
  startedAt: number | null;
  pid: number;
  procStart: string | null;
}

/** R131: the agent's own list's state of a background session (for Claude: `claude agents --json --all`'s `state`). */
export type BgListState = "working" | "blocked" | "done" | "failed" | "stopped";

/** R131: one background session of the agent's list, of an id that a chat's book holds, each field by its rule. */
export interface BgListRow {
  id: string;
  sessionId: string | null;
  name: string | null;
  cwd: string | null;
  /** null: a state that kitespan does not know. */
  state: BgListState | null;
  /** null: no live process. */
  status: "busy" | "waiting" | "idle" | null;
  waitingFor: BgWait | null;
  startedAt: number | null;
}

/**
 * R131: one read of the agent's list. `at`: when the read began (ms since the epoch), so an answer kept from before a
 * change is known as such. `ran`: the run's duration and exit code, or null when a kept answer (about 5 s) answered.
 */
export interface BgList {
  rows: BgListRow[];
  at: number;
  ran: { ms: number; code: number | null } | null;
}

/** The user's own Claude Code settings that kitespan reads, never writes (A13, D10, D15, 6.4). */
export interface AgentSettings {
  /** `respondToBashCommands`: whether Claude replies to `!` output (D10). */
  respondToBash: boolean;
  /** `cleanupPeriodDays` (D15), null when unset. */
  cleanupPeriodDays: number | null;
  /** `promptSuggestionEnabled === true`: an absent setting counts as off (6.4). */
  promptSuggestions: boolean;
  /** `defaultMode`, null when unset. */
  defaultMode: string | null;
  /** L29: the settings name a WorktreeCreate hook, which kitespan's own worktrees would not run. Absent: none. */
  worktreeHook?: boolean;
}

/**
 * A provider's resource name (`arn:...`) where a model id goes: Bedrock reports the default model as its inference
 * profile's ARN, which holds the AWS account id. The seam never passes one on (row 95): it is never kept, logged, sent
 * to the page or shown.
 */
export const isProviderArn = (v: unknown): boolean => typeof v === "string" && /^arn:/i.test(v);

/**
 * A text with each provider's ARN in it (a token that starts with `arn:`, any case, up to the next space or closing
 * parenthesis) as "[an ARN]": Claude Code's default model row names the model it resolves to in its description.
 */
export const maskArns = (text: string): string => text.replace(/(?<![A-Za-z0-9])arn:[^\s)]*/gi, "[an ARN]");

/** Row 94: the transcript's last reply's token use (its request's input, cached or not, and its output) and model. */
export interface TranscriptUsage {
  model: string | null;
  usedTokens: number;
}

export interface HistoryPageRequest {
  before: string | null;
  maxBytes: number;
  decorate?: (events: ChatEvent[]) => ChatEvent[];
}

export interface AgentDriver {
  readonly kind: AgentKind;
  capabilities(): AgentCapabilities;
  /** The binary pin and the platform-package scan; runs again for every new chat and every probe (4.7). */
  probe(): Promise<BinaryProbe>;
  /** Starts the agent process (for Claude: one `query()` with the raw options, 4.7). */
  open(input: OpenInput): AgentChat;
  // These work on a sleeping chat too: they read or change the agent's own session files.
  /**
   * One page of history, newest first, at most `maxBytes` of JSON; `more` is the cursor of the next older page.
   * `decorate` gets the whole transcript's events, oldest first, before the page is cut from them: the host merges in
   * what it knows itself (the closed cards, the `!` rows' own ids, the calls a turn's end stopped), so a page's cursor
   * counts the merged events.
   */
  history(sessionId: string, cwd: string, page: HistoryPageRequest): Promise<{ events: ChatEvent[]; more: string | null }>;
  /**
   * U5 (the message search): every event of the session's transcript, oldest first, as history maps them, with no
   * page cut and nothing merged in (the search keeps only the messages' text, server/search/text.ts), and with no
   * reply that the agent wrote itself (Claude Code's synthetic API error and notice lines, which history keeps).
   * Throws as history does; a transcript that is gone gives no events.
   */
  transcriptEvents(sessionId: string, cwd: string): Promise<ChatEvent[]>;
  /**
   * T-26: the whole text of one tool use's result in the session's transcript, before the cap of 4.3, as history maps
   * it (the page holds its first LIMITS.toolResult characters); null when the transcript, or a result for that id in
   * it, is not there. Absent: the agent cannot read one.
   */
  toolOutput?(sessionId: string, cwd: string, toolUseId: string): Promise<string | null>;
  /** The session's info, or null when its transcript does not exist (D41 and the start-up sweep). */
  sessionInfo(sessionId: string, cwd: string): Promise<SessionInfo | null>;
  /**
   * Row 94: the usage of the main session's last reply in the transcript (the context ring of a chat with no live
   * process and no kept read), or null when there is none.
   */
  lastUsage(sessionId: string, cwd: string): Promise<TranscriptUsage | null>;
  /** The sessions in a folder that are not the SDK's own (From the terminal, `includeProgrammatic: false`). */
  listSessions(cwd: string): Promise<SessionInfo[]>;
  /**
   * Row 99: of every session filed under the folder (no other worktree's), the SDK's own too (`includeProgrammatic:
   * true`), exactly those with these ids: the sessions that a removed environment's chats released, asked for under the
   * folder that holds their transcripts (store/released.ts). A gone transcript is not there.
   */
  listReleased(cwd: string, ids: readonly string[]): Promise<SessionInfo[]>;
  /**
   * The folders (cwd) of the newest sessions in every folder, the SDK's own left out as in listSessions; newest
   * first, each folder once, absolute paths only (New environment's Suggested, D54). Whether each still exists is
   * the caller's check.
   */
  sessionFolders(): Promise<string[]>;
  rename(sessionId: string, title: string, cwd: string): Promise<void>;
  /**
   * D48: removes the session's transcript. An error whose `keepChat` is true says that the transcript is gone but
   * something of the session is still on disk, which a second call may remove: the chat stays.
   */
  deleteSession(sessionId: string, cwd: string): Promise<void>;
  /**
   * D58 Continue in a copy: a copy of the session's transcript under a new session id, titled `title`; resolves with
   * the new id. The original is left as it is, so the app that has it open keeps it.
   */
  forkSession(sessionId: string, cwd: string, title: string | null): Promise<string>;
  /**
   * D58: the sessions that another process has open now, by session id (for Claude: Claude Code's own registry of
   * running sessions). The driver's own processes never count, and anything unknown or unreadable counts as not
   * open. A read is kept for about 1.5 s, under the registry's 2 s check (row 78).
   */
  openSessions(): Promise<ReadonlyMap<string, SessionOpen>>;
  /** The user's own settings for a folder (`resolveSettings` only, never `updateSettings`). */
  settings(cwd: string): Promise<AgentSettings>;
  /**
   * D59: the folder's command list before a chat exists (the new-chat form's `/` menu). One idle agent process for
   * the folder that answers its list and ends, at most 20 s: no message, no model turn, no session option; not a chat.
   * Throws when the agent cannot start or does not answer in time. `env`: D60, the folder's environment's variables,
   * which that process gets as a chat's does (L38); null or absent when it has none.
   */
  readCommands(cwd: string, env?: Marked<EnvVar[]> | null): Promise<CommandInfo[]>;
  /**
   * Row 81: the agent's model list with no chat (the pickers of a sleeping or held chat, the new-chat form, the project
   * page). The same idle process as readCommands, which answers both lists: a read of either while one runs for the
   * folder takes its answer, and a model read while any folder's read runs takes that one's (the list is the agent's,
   * the same in every folder), so a model read never starts a second process. Throws as readCommands does. D60 (L37):
   * a read with `env` is its environment's own, so it takes only its own folder's read with variables, and a read
   * without takes none that has them.
   */
  readModels(cwd: string, env?: Marked<EnvVar[]> | null): Promise<ModelInfo[]>;
  /**
   * D60: the names that the user's own Claude Code settings `env` sets for the folder (names only, never a value), so
   * the environment's editor can say that their value wins. Absent: none are known.
   */
  settingsEnvNames?(cwd: string): Promise<string[]>;
  /**
   * Row 94: each model row's context window in tokens, by the row's value ("default" for the default row), from the
   * same idle process as readModels (it shares a read that runs): no message, so no model turn; one control call at a
   * time, within the read's cap; a row whose read fails is left out. Throws as readModels does. D60: `env` as
   * readModels has it, so the windows of an environment with variables come from its own read.
   */
  readWindows(cwd: string, env?: Marked<EnvVar[]> | null): Promise<Record<string, number>>;
  /**
   * R17, S11 (the shutdown and the restart's close): every short read in flight ends now, and fails as one with no
   * answer in time; resolves once each one's process has exited. R127: a trust start in flight ends the same way.
   */
  endReads(): Promise<void>;
  /**
   * R127: record `path` (a folder's real path, checked by the caller: there, a folder, no link, not home) as trusted by
   * the agent itself, after the user's own Yes in kitespan's confirm. For Claude: one short start in that folder with the
   * SDK's host attestation and no message (so no model turn), at most 20 s, then closed. `recorded`: the agent says
   * that the folder's trust is now saved (or already was). Throws DriverError `no_claude` when there is no agent to
   * start, and `failed` when it did not answer (an exit, the cap, `signal` or endReads). Absent: the agent cannot.
   */
  trustFolder?(path: string, signal?: AbortSignal): Promise<{ recorded: boolean }>;
  /**
   * R131: the records of the agent's background sessions that run now, of the ids in `ids` only (the chats' books),
   * from the same look as openSessions (no new file read; kept as long). Of any other background session nothing is
   * kept. Absent: the agent has none.
   */
  backgroundRecords?(ids: ReadonlySet<string>): Promise<BgRecord[]>;
  /**
   * R131: the agent's own list of background sessions, only the rows whose id is in `ids` (every other row is dropped
   * before anything else is done: never kept, sent or logged). For Claude: `claude agents --json --all`, the pinned
   * binary with an argv array, the clean start environment, its own process group, a timeout and a capped output; one
   * run at a time, its answer kept about 5 s; only on a Claude Code with agent view. Null: the list cannot be read (an
   * older Claude Code, no claude, a failed or refused run). Never throws.
   */
  listBackground?(ids: ReadonlySet<string>): Promise<BgList | null>;
  /**
   * R131: stop the background session with this short id (the caller checked that a launch row of its chat printed it).
   * For Claude: `claude stop <id>`, run as listBackground runs its call. Throws DriverError `bad_request` for an id that
   * is not a short id, `no_claude` when there is no agent, and `unsupported` for a Claude Code without agent view; each
   * before any process of the stop starts.
   */
  stopBackground?(id: string): Promise<BgStopAnswer>;
  /**
   * R131: a background session's permission mode, from its transcript under `dir` (for Claude: the last
   * `permission-mode` record in a capped tail of the file, which the SDK's reader drops); null when none is known.
   */
  backgroundMode?(sessionId: string, dir: string): Promise<ModeId | null>;
}

export interface AgentChat {
  /** Ends when the agent process is gone; never throws. */
  readonly events: AsyncIterable<ChatEvent>;
  /**
   * The agent process's id while it runs, so that the next server knows a process left by this one as kitespan's own
   * (R16); null when it is not known (not started yet, ended, or not readable).
   */
  readonly pid: number | null;
  /** One user message on the input iterable, with the host's uuid and `origin: {kind: 'human'}`. */
  send(turn: { uuid: string; text: string }): Promise<void>;
  /**
   * A `!` record; `reply` is the `shouldQuery` that D10 decides. `uuid` is the `bash` row's uuid, sent as the
   * message's uuid; Claude Code writes the record to the transcript under an id of its own (a live check found the
   * host's uuid in no transcript), so the registry matches the transcript's copy to the row by its content.
   */
  bashRecord(rec: { uuid: string; input: string; stdout: string; stderr: string; reply: boolean }): Promise<void>;
  /** null `stillQueued`: the CLI sent no receipt. */
  interrupt(): Promise<{ stillQueued: string[] | null }>;
  /** null: back to the user's default (the SDK's undefined). */
  setModel(model: string | null): Promise<void>;
  setEffort(level: EffortId | null): Promise<void>;
  setMode(mode: ModeId): Promise<void>;
  commands(): Promise<CommandInfo[]>;
  models(): Promise<ModelInfo[]>;
  context(): Promise<ContextInfo | null>;
  connectors(): Promise<ConnectorInfo[]>;
  reconnect(server: string): Promise<void>;
  /** 6.7, once its check passes. */
  setAlwaysAsk(server: string, on: boolean): Promise<{ warning: string | null }>;
  /** 6.7, only after the check of section 12, question 11. */
  setEnabled(server: string, enabled: boolean): Promise<void>;
  stopTask(taskId: string): Promise<void>;
  /** false: no foreground task had that tool use. */
  runInBackground(toolUseId: string): Promise<boolean>;
  /**
   * Row 111 (Send now): every foreground task of the running turn (a Bash command, a subagent) moves to the
   * background, as the terminal's Ctrl+B: each one's tool call returns at once and the turn goes on, so Claude reads
   * what waits in its queue; the tasks keep running. false: the agent could not (background tasks are off for this
   * session).
   */
  backgroundAll(): Promise<boolean>;
  /** false: the agent had already taken it off its queue. */
  takeBack(uuid: string): Promise<{ cancelled: boolean }>;
  /** Skills, plugins and output styles, from disk (6.8). */
  reload(): Promise<void>;
  /** Once after the first reply (D13); null: no title. */
  generateTitle(): Promise<string | null>;
  /**
   * kitespan's own Rename, told to the running agent (for Claude: the `rename_session` control request, as a rename
   * in the host), so it keeps the new name and never sends the old one back. false: this agent has no way to take
   * one (feature-detected) or is not running; throws when it refused it.
   */
  rename(title: string, sessionId: string): Promise<boolean>;
  /** The provider only (Account, 6.8): `accountInfo().apiProvider`. */
  account(): Promise<{ provider: string | null }>;
  /**
   * R124: a side question on this process, about the conversation so far, with the earlier exchanges as `history`
   * (oldest first; none: the conversation only). Nothing goes into the conversation or its transcript, and a turn that
   * runs goes on. It works while a turn runs and while none does, after the process's start. Resolves with the answer,
   * or null when Claude Code had none. Throws DriverError `unsupported` when this agent has no side question (feature
   * test), and on a failure or once `signal` aborted (the agent is told to cancel). One at a time per chat: every
   * progress of the process's side question goes to `onProgress`.
   */
  sideQuestion(question: string, opts: { history: readonly SideTurn[]; signal: AbortSignal; onProgress?: (p: SideProgress) => void }): Promise<SideAnswer | null>;
  /** Resolves when the process is gone (the SDK's `close()` returns nothing, so the driver waits for the exit). */
  close(): Promise<void>;
}

/**
 * The clean start environment (4.7). bin/kitespan removes these before Bun starts, and the server refuses to boot when
 * any of them is set (test/unit/package.test.ts keeps this list and the script's equal).
 */
export const CLEAN_ENV = {
  /** A Claude Code session the server was started from (D21, plus AI_AGENT, D31). */
  always: [
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_PID",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_EFFORT",
    "CLAUDE_CODE_ENTRYPOINT",
    "AI_AGENT",
  ],
  alwaysPrefixes: ["CLAUDE_CODE_MESSAGING_"],
  /** Any one of these marks a Claude Desktop host; then `desktop` goes too (D31). */
  desktopMarkers: ["CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "CLAUDE_CODE_HOST_AUTH_ENV_VAR", "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH"],
  desktop: [
    "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
    "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
    "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
    "ANTHROPIC_BASE_URL",
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
  ],
  /** Removed only when the start environment holds CLAUDECODE, CLAUDE_CODE_SESSION_ID or CLAUDE_CODE_CHILD_SESSION. */
  traceAfterSession: ["TRACEPARENT", "TRACESTATE"],
} as const;

/** The names of `env` that the boot check refuses (4.7, "Checked at boot"). Names only, never values. */
export function dirtyStartNames(env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  for (const name of Object.keys(env)) {
    if (env[name] === undefined) continue;
    if (
      (CLEAN_ENV.always as readonly string[]).includes(name) ||
      CLEAN_ENV.alwaysPrefixes.some((p) => name.startsWith(p)) ||
      (CLEAN_ENV.desktopMarkers as readonly string[]).includes(name)
    )
      out.push(name);
  }
  return out.sort();
}
