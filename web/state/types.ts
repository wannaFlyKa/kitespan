// The page's data model: the shapes the components draw. state/reduce.ts makes them from the server's neutral
// ChatEvents (DESIGN.md 4.2) and frames (4.3); the wire types themselves are in shared/protocol.ts. Where the server
// says more than the prototype drew, a field was added here (each one says so); no prototype field changed its type.
import type {
  Card as WireCard,
  ChatHold,
  ChatState as WireChatState,
  CommandInfo,
  ConnectorInfo,
  FastModeInfo,
  ModelInfo,
  Picks as WirePicks,
  PluginInfo,
  TrustRef,
  TrustState,
  Unseen,
} from "../../shared/protocol";
import type { ChatWorktree, StartCode, WorktreeOff } from "../worktree/worktree";
import type { BgDot, BgWorker, Launch } from "../chat/background";
import type { ChangesNote } from "../changes/model";

export type { Unseen, WireCard, WireChatState, WirePicks };

export type ModeId = "default" | "acceptEdits" | "plan" | "auto" | "bypassPermissions";
/**
 * A chat's state as the lists show it (DESIGN.md 6.2 and 4.1). "starting": kitespan is starting the chat's Claude Code
 * (the first message waits for it). "failed": the last turn ended in an error, or the process died, and no device has
 * looked at the chat since; the next message starts a turn again. "unread" (owner row 116): a turn ended and no device
 * has looked at the chat since (Desktop's word; the seen flag below).
 */
export type ChatState = "starting" | "sleeping" | "idle" | "running" | "waiting" | "failed" | "unread";

export interface Picks {
  model?: string;
  effort?: string;
  mode?: ModeId;
}

export interface Project {
  id: string;
  name: string;
  folder: string; // shown in the UI; never in a URL
  branch: string;
  picks: Picks; // remembered per folder; never Plan
  /** D60: how many environment variables the environment has (the project view's `env`); absent or 0: none. */
  env?: number;
  /** D60 (L39): the environment's variables file cannot be read, so its chats do not start (`env` then says 0). */
  envUnreadable?: boolean;
  /** Row 73: each new chat here gets its own git worktree (the project's Worktree option, off by default). */
  worktree?: boolean;
  /** Row 73: why the Worktree option cannot be turned on here (W2), or null (absent) when it can. */
  worktreeOff?: WorktreeOff | null;
}

export interface ToolItem {
  kind: "tool";
  id: string;
  name: string; // Read, Grep, Bash, Edit, Write, ...
  summary: string; // the one-line form: a path, a command or a pattern
  input?: string;
  output?: string;
  /**
   * "auto-denied": the auto mode classifier denied the call (the tag "Denied by auto mode", DESIGN.md 6.3).
   * "stopped": the call had no result when its turn ended (a Stop) or its process exited (state/reduce.ts stopCalls).
   */
  status: "ok" | "error" | "running" | "denied" | "auto-denied" | "stopped";
  diff?: { path: string; removed: string[]; added: string[] };
  /** How long a running call has run, from Claude Code's tool_progress (DESIGN.md 6.3: "12 s"). */
  elapsedSeconds?: number;
  /** The call runs in the background (Run in background, or Claude started it there); the turn goes on. */
  background?: boolean;
  /** Added in iteration 2: the call's input as the server sent it (capped, 4.3), for the opened row. */
  raw?: unknown;
  /**
   * R127: the server matched Claude Code's "Workspace not trusted" refusal in the call's whole result: the folder it
   * names (its real path), and the root of the repository it sits in when that is another folder (else null).
   */
  trust?: TrustRef;
  /**
   * R131: the server matched Claude Code's launch line ("backgrounded · <id> · <name>") in the call's whole result: each
   * background session it started, in the order of the lines (chat/background.ts). Absent: none.
   */
  launches?: Launch[];
  /** T-26: the whole result's length when the server cut the text this row holds (4.3); absent when whole. */
  cut?: number;
}

export interface AgentItem {
  kind: "agent";
  id: string;
  agentType: string;
  /** The agent type's own description, shown inside the block (never a tooltip: touch has none). */
  typeDescription?: string;
  description: string;
  /** The prompt the subagent was given. */
  prompt?: string;
  status: "running" | "done" | "stopped" | "failed";
  rows: Item[];
  lastText?: string;
  report?: string;
  toolUses: number;
  /** Tokens the subagent used so far ("N tools, Xk tokens"). */
  tokens?: number;
  seconds: number;
  /** The subagent runs in the background: a Stop of the turn leaves it running ("In the background"). */
  background?: boolean;
  /** Added in iteration 2: Claude Code's task id, which a per-task Stop (`stop_task`) names. */
  taskId?: string;
}

export interface WorkflowAgent {
  label: string;
  status: "queued" | "running" | "done" | "failed";
  /** The attempt this row shows, from 1; a retried agent shows its latest attempt. */
  attempt?: number;
  /** What the agent was asked to do; its row opens to it. */
  task?: string;
  /** The agent's result, when it is done. */
  result?: string;
  /** Why the agent failed. */
  error?: string;
}

export interface WorkflowItem {
  kind: "workflow";
  id: string;
  name: string;
  description: string;
  status: "running" | "done" | "stopped" | "failed";
  phases: { title: string; agents: WorkflowAgent[] }[];
  /** The workflow kept running after a Stop of the turn (DESIGN.md 4.7): its block says "In the background". */
  background?: boolean;
  /** Added in iteration 2: Claude Code's task id, which a per-task Stop (`stop_task`) names. */
  taskId?: string;
}

/** A thinking block. While `live`, the row reads "Thinking..." with Claude Code's estimate, "about Nk tokens". */
export interface ThinkingItem {
  kind: "thinking";
  id: string;
  seconds: number;
  text: string;
  /** The block is still streaming. */
  live?: boolean;
  /** Claude Code's running estimate of the live block's tokens (thinking_tokens: progress, not the billed count). */
  tokenEstimate?: number;
  /** Added in iteration 2: when the live block started on this page (ms), so its end can say how long it took. */
  startedAt?: number;
}

/** A `!` command. A command typed while Claude works is `queued` (shown as "Queued") and runs after the turn. */
export interface BashItem {
  kind: "bash";
  id: string;
  command: string;
  stdout: string;
  stderr: string;
  code: number;
  ms: number;
  queued?: boolean;
  /** Added in iteration 2: the command runs now (the server's `running` state); `code` and `ms` are 0 until it ends. */
  running?: boolean;
  /** Added in iteration 2: the 120 s limit ended it (D20). */
  timedOut?: boolean;
  /** Added in iteration 2: an output stream was cut at 30,000 characters (D20). */
  capped?: boolean;
  /** Added in iteration 2: the command waited and will never run (the server's `not_run` state): no output, no code. */
  notRun?: boolean;
}

/**
 * Claude Code's status line (DESIGN.md 6.3): "Compacting the conversation..." while `status` is "compacting";
 * "Compaction failed" and `error` when `compact` is "failed". "requesting" adds nothing to the working mark. Live
 * state: the line goes away when the status clears.
 */
export interface StatusItem {
  kind: "status";
  id: string;
  status: "compacting" | "requesting" | null;
  compact?: "success" | "failed";
  error?: string;
}

/** "Retrying (attempt of max) in N s", with the error kind as text (api_retry). Live: the next retry replaces it. */
export interface RetryItem {
  kind: "retry";
  id: string;
  attempt: number;
  max: number;
  delayMs: number;
  error: string; // the error kind, for example "overloaded"
}

/** The refusal notice: Claude Code's own text. With a fallback, Claude Code retried the turn on that model. */
export interface RefusalItem {
  kind: "refusal";
  id: string; // the message's uuid, so /c/<chat>/m/<id> reaches it
  text: string;
  fallback?: { model: string; scope: "session" | "local" } | null;
  /** The rows the retry replaced; they leave the transcript. */
  retracted?: string[];
}

/** Claude Code's informational line, at its level: info (Verbose only), notice (dim), suggestion, warning. */
export interface InfoItem {
  kind: "info";
  id: string;
  text: string;
  level: "info" | "notice" | "suggestion" | "warning";
  /** The tool call the line is about; a newer line for the same call replaces the older one. */
  toolUseId?: string;
  /**
   * The line of a refused start (W4, W5): kitespan's own check (a notice's `code`) or Claude Code's refusal (an `exit`
   * event's `startup`). The line draws that code's buttons under it until the chat's Claude Code starts again (a later
   * `session` event takes it away), and only the newest such line has them.
   */
  start?: StartCode;
  /** Under a refused start's fixed sentence: Claude Code's own first error line (worktree_resume_refused, DESIGN 4.4). */
  detail?: string;
  /** D60 (L39): the line of a start that the environment's unreadable variables refused (the notice's code). */
  code?: "env_unreadable";
}

/** "Recalled from memory": a folded row that opens to one row per memory. */
export interface MemoryItem {
  kind: "memory";
  id: string;
  items: { scope: "personal" | "team" | "organization"; path: string; text?: string }[];
}

/**
 * One plugin install row: "Installing plugins...", "Installed <name>", "Could not install <name>" with the error,
 * then "Plugins installed".
 */
export interface PluginItem {
  kind: "plugin";
  id: string;
  status: "started" | "installed" | "failed" | "completed";
  name?: string;
  error?: string;
}

/**
 * The error row: the reason, then "Send a message to continue." With `signIn` (authentication_failed or
 * cloud_credential_error) the row shows the sign-in line instead: "Claude Code could not sign in to its provider.
 * Sign in again in your terminal, then send a message to continue."
 */
export interface ErrorItem {
  kind: "error";
  id: string;
  text: string;
  signIn?: boolean;
}

/** A hook row (Verbose only): the hook event and the hook's name; it opens to the hook's output. */
export interface HookItem {
  kind: "hook";
  id: string;
  event: string; // PreToolUse, PostToolUse, SessionStart, ...
  name: string;
  output?: string;
}

/**
 * A reconnect divider, in Desktop's words: "loading" is "Loading recent output...", "missing" is "Some output
 * produced while you were disconnected may be missing here."
 */
export interface ReconnectItem {
  kind: "reconnect";
  id: string;
  phase: "loading" | "missing";
}

/** Added in iteration 2: Claude Code reset the conversation (`conversation_reset`, CV-7): a divider. */
export interface ResetItem {
  kind: "reset";
  id: string;
  trigger: string;
}

/** One item of the to-do checklist. */
export interface TodoEntry {
  text: string;
  status: "pending" | "in_progress" | "completed";
  /** Added in iteration 2: Claude Code's task id, from TaskCreate's result ("Task #<n> created successfully"). */
  taskId?: string;
}

/** Added in iteration 2: one call of Claude Code's task tools (TaskCreate, TaskUpdate, TaskList, TaskGet). */
export interface TaskCall {
  id: string;
  name: string;
  input: unknown;
  /** The result's text, once it came. */
  result?: string;
  /** The call did not act: an error result, or a denial. */
  failed?: boolean;
}

/**
 * The to-do checklist row (CV-13): one TodoWrite call, or the task tools' calls of one turn (`tasks`: the list as the
 * turn found it and the turn's calls in order, from which `items` comes).
 */
export interface TodoItem {
  kind: "todo";
  id: string;
  items: TodoEntry[];
  tasks?: { base: TodoEntry[]; calls: TaskCall[] };
}

export type Item =
  /**
   * `mentions`: the paths of the mention chips that its event names (9.3), its tiles; an empty list when it was sent
   * with no chips (no reference of its text is a tile); absent when its event has no such list (an old message, or
   * one from the terminal), which splitRefs reads as before. `local`: this page's message that the server has not
   * shown yet; it stays below what the server sends until the server's first event for it places it (6.3).
   */
  | { kind: "user"; id: string; text: string; queued?: boolean; mentions?: string[]; notSent?: boolean; local?: boolean }
  | { kind: "assistant"; id: string; markdown: string; streaming?: boolean }
  | ThinkingItem
  | ToolItem
  | AgentItem
  | WorkflowItem
  | TodoItem
  | { kind: "slash"; id: string; command: string; output: string }
  | BashItem
  | { kind: "compact"; id: string }
  | { kind: "card"; id: string; card: Card }
  | StatusItem
  | RetryItem
  | RefusalItem
  | InfoItem
  | MemoryItem
  | PluginItem
  | ErrorItem
  | HookItem
  | ReconnectItem
  | ResetItem;

export interface PermissionCard {
  kind: "permission";
  id: string;
  tool: string;
  /** The title Claude Code sent, or "" when it sent none: the card then says "Allow Claude to use <tool>?" (6.3). */
  title: string;
  detail: string; // the command or the path
  diff?: { path: string; removed: string[]; added: string[] };
  reason?: string; // the reason line Claude Code sends
  answered?: "once" | "session" | "deny";
  denyNote?: string; // "Tell Claude what to do instead"
  /** Added in iteration 2: the card as the server sent it (defaultToNo, suppressAlwaysAllowRule, sessionRule, input). */
  wire?: WireCard;
}

export interface QuestionCard {
  kind: "question";
  id: string;
  questions: { question: string; header: string; multiSelect: boolean; options: { label: string; description: string }[] }[];
  answered?: Record<string, string>;
  /** Added in iteration 2: the card as the server sent it. */
  wire?: WireCard;
}

export type PlanAnswer = "auto" | "accept-edits" | "bypass" | "manual" | "keep-planning";

export interface PlanCard {
  kind: "plan";
  id: string;
  markdown: string;
  answered?: PlanAnswer;
  /** Added in iteration 2: the text sent with No, keep planning, when there was one (the record's `note`). */
  note?: string;
  /** Added in iteration 2: the card as the server sent it. */
  wire?: WireCard;
}

/** An MCP server asks for input (DESIGN.md 6.3): form mode has fields, URL mode has a URL to open on a click. */
export interface ElicitationCard {
  kind: "elicitation";
  id: string;
  server: string;
  title: string;
  message: string;
  mode: "form" | "url";
  fields?: { name: string; label: string; type: "string" | "boolean" | "number"; required?: boolean }[];
  url?: string;
  answered?: "accept" | "decline" | "cancel";
  /** Added in iteration 2: the card as the server sent it (the form's JSON schema, the elicitation id). */
  wire?: WireCard;
}

/** A Claude Code dialog the host draws (onUserDialog), for example the refusal fallback prompt. */
export interface DialogCard {
  kind: "dialog";
  id: string;
  dialogKind: string;
  title: string;
  body: string;
  choices: { id: string; label: string; primary?: boolean }[];
  answered?: string;
  /** Added in iteration 2: the card as the server sent it (its payload). */
  wire?: WireCard;
}

export type Card = PermissionCard | QuestionCard | PlanCard | ElicitationCard | DialogCard;

export interface ContextInfo {
  usedPct: number;
  usedTokens: number;
  windowTokens: number;
  parts: { label: string; tokens: number }[];
}

export interface Connector {
  name: string;
  status: "connected" | "failed" | "needs-auth" | "pending";
  tools: number;
  source: string; // where the owner configured it: user, project or local
}

export interface Output {
  path: string; // relative to the chat's folder
  kind: "file" | "doc";
}

export interface Chat {
  id: string;
  projectId: string;
  title: string;
  titleSource: "rename" | "generated" | "first-prompt";
  state: ChatState;
  updatedAt: string; // ISO
  sessionId: string;
  model: string; // a model id from MODELS
  effort: string;
  mode: ModeId;
  items: Item[];
  pending: Card[]; // the cards that wait for the user, oldest first; one shows at a time ("1 of 3")
  context: ContextInfo;
  connectors: Connector[];
  outputs: Output[];
  /** True when the chat's Claude Code started with the bypass flag, so Bypass permissions can be picked (D12). */
  bypassFlag?: boolean;
  /**
   * The request ids of cards that ended unanswered with their Claude Code process (it restarted or exited); a card
   * path that names one shows the DESIGN 5.4 lost line.
   */
  lostRequests?: string[];

  // Added in iteration 2, from the server (4.3):
  /** D48: the chat shows only under the Archived row; its page is read-only with Unarchive. */
  archived: boolean;
  /** A card waits (the chat list's `needsYou`). */
  needsYou: boolean;
  /** The user's own picks as the server holds them; null is the user's Claude Code default ("Default"). */
  picks: WirePicks;
  /** The server's state word for the chat (4.1); `state` above is the list's form of it. */
  serverState: WireChatState;
  /** The page has attached the chat and drawn its newest history page (the items are real, not empty yet). */
  loaded: boolean;
  /** The cursor of the next older history page (`get` with `what: "history"`), or null at the start. */
  more: string | null;
  /** The `seq` of the running turn's `turn_start`, which Stop (`interrupt`) names; null when no turn runs. */
  turn: number | null;
  /** The model Claude Code reports (`system/init`), or null before its first start in this server life. */
  liveModel: string | null;
  /** Claude Code's version (`system/init`), or null. */
  version: string | null;
  /** The `/` menu (`commands` events and `get`), or null before Claude Code sent one. */
  commands: CommandInfo[] | null;
  /** The model picker's rows (`get` with `what: "models"`), or null before the first read. */
  models: ModelInfo[] | null;
  /** The connectors as `get` read them (`connectors` above is the prototype's form of the same list). */
  connectorInfo: ConnectorInfo[] | null;
  /** The background tasks that run now (`tasks`). */
  tasks: { taskId: string; description: string; ambient: boolean }[];
  /** The suggested next prompt (6.4), or null. */
  suggestion: string | null;
  /**
   * D48, the chat list's `busy`: a turn runs (or the chat's start does), a card waits, or a background task that is not
   * ambient runs, so the chat's Archive reads "Stop and archive". Absent counts as false.
   */
  busy?: boolean;
  /**
   * Row 78, the chat list's `held`: another app has this chat's session open now, so its box shows one line in place
   * of Send, with Continue in a copy of `session`; null (or absent): none.
   */
  held?: ChatHold | null;
  /**
   * What the chat's Claude Code said at its start in this server life (`system/init`, the `session` event), for
   * Settings and the + menu; null (or absent) while it has not started: the page then says so in one line.
   */
  init?: InitFacts | null;
  /** Row 73: the chat runs in its own git worktree (the chat list's `worktree`); null (or absent): the project's folder. */
  worktree?: ChatWorktree | null;
  /**
   * L34: the folder Claude Code reported at its start (`system/init`'s cwd); the Environment detail shows it when it is
   * not the chat's own, for example after Claude moved the session into a worktree (EnterWorktree). Null (or absent):
   * none reported.
   */
  workingFolder?: string | null;
  /**
   * Row 116: the chat list's `unseen`, the chat's last end not seen yet ("done": a turn ended; "failed": it ended in an
   * error, or its Claude Code died), the list's unread or failed dot. The server holds it, the same on every device
   * (D49); a page that has the chat on screen at its end clears it (net/onScreen.ts). Null (or absent): seen.
   */
  unseen?: Unseen | null;
  /**
   * U2: each turn's start and end as the page got them, in order, beside the rows (not rows of their own: a mark that
   * came with a send would make the change read as a load, arrivals.ts). The turn model (chat/turns.ts) reads them.
   * Absent: none yet.
   */
  marks?: TurnMark[];
  /**
   * R127: the server's last answer for each folder that a refused row of this chat names (`attached.trust`, then the
   * `trust` events and this page's own acks), by its real path; a live refusal of a folder takes its answer away, so
   * its line offers again. Absent: none.
   */
  trust?: Readonly<Record<string, TrustState>>;
  /**
   * R131: the state of each background session that a launch row of this chat printed, by its short id, as the server
   * says it (`attached.background`, then the `background` events); a session that Claude Code no longer lists is not
   * here (its line goes). Absent: none.
   */
  background?: Readonly<Record<string, BgWorker>>;
  /**
   * R131: the chat row's own field for its sessions (ChatRow.background): one needs input, or one failed or completed
   * while nobody looked (R116's seen rule). It lights the chat's dot (chat/background.ts chatDot); it is not `needsYou`,
   * so the Needs input filter keeps meaning that a card waits here. Null (or absent): none.
   */
  bgDot?: BgDot | null;
  /**
   * U1 (DESIGN-U1 5): each turn's changes as the `changes` events brought them (live and from history), one note a
   * summary, in order: the card under that turn's answer. Paths and counts only, never a diff's text. Absent: none.
   */
  changes?: ChangesNote[];
}

/**
 * U2 (DESIGN-U2 3): a turn's `turn_start` or `turn_end` as the page got it. `at` names where it came among the rows:
 * the last row that did not wait then (after the rows the event itself added), and the two before it, newest first,
 * in case a row goes later (a line that a newer one replaces); empty when there was no row. `seq` is the event's (0
 * in history).
 * - A start: who started the turn. `loose`: it came in a snapshot's tail, whose history may already hold the turn's
 *   first rows, so the turn model may start it at the input before it.
 * - An end: how the turn ended (`subtype` TURN_INTERRUPTED for a Stop, also this page's own; TURN_CUT; "exit" when
 *   its Claude Code exited), how long it worked (`durationMs`, 0 when not known) and the messages it answered.
 *   `live`: it came live on this page, not in a replay or a history read.
 */
export type TurnMark =
  | { k: "start"; by: "user" | "agent"; at: string[]; seq: number; loose?: boolean }
  | { k: "end"; at: string[]; seq: number; ok: boolean; subtype: string; durationMs: number; uuids: string[]; live: boolean };

/** The facts of a chat's `system/init` (the `session` event, 4.2) that Settings and the + menu show (6.5, 6.8). */
export interface InitFacts {
  /** The fast-mode state and its reason, or null when Claude Code sent no state. */
  fastMode: FastModeInfo | null;
  /** The skills the chat loaded, by name. */
  skills: string[];
  /** The plugins the chat loaded. */
  plugins: PluginInfo[];
  /** The output style, or null when Claude Code named none. */
  outputStyle: string | null;
}

export interface ModelRow {
  id: string; // the alias the picker sends
  label: string;
  hint: string;
  efforts: string[];
  /** The model supports Auto (supportsAutoMode); else the mode picker shows Auto off (DESIGN.md 6.6). */
  supportsAutoMode: boolean;
}

export interface CommandRow {
  name: string;
  hint: string;
  args?: string;
  source: "built-in" | "plugin" | "user" | "project";
  terminalOnly?: boolean;
}

/**
 * Settings > Appearance > Look (prototype design plan v3, the owner's D36): the feel of the whole app, a token set in
 * styles/tokens.css. "glass" is the default; each look works in light and dark (the theme is its own setting).
 */
export type LookId = "glass" | "paper" | "mono" | "editor";

export interface AppSettings {
  /** look: the token set the page wears (data-look on the root; absent means glass). */
  look: LookId;
  /** theme: light, dark, or follow the device (data-theme on the root; absent means follow the device). */
  theme: "dark" | "light" | "system";
  liveChats: number; // live-max
  idleMinutes: number; // idle-minutes
  allowBypass: boolean; // allow-bypass
  nameChats: boolean; // auto-title
  bashReply: "follow" | "always" | "never"; // bash-reply
  returnKey: "send" | "newline"; // return-key: the phone's Return key (D28)
  /** new-chats: a new chat starts with the project's last picks, or with the user's Claude Code defaults. */
  newChats: "last" | "defaults";
  /** sessions-from-other-apps (row 77): Home and each project list Claude Code's sessions (From the terminal); on by default. */
  sessionsFromOtherApps: boolean;
  /** sessions-open-elsewhere (row 77): the lists keep a session that another app has open now, marked; off by default. */
  sessionsOpenElsewhere: boolean;
  /** text-size: every type size times this, one of TEXT_SIZES (0.9 to 1.3); touch fields never go under 16 px. */
  textSize: number;
  /** reduce-motion: follow the system's setting, or always reduce motion. */
  reduceMotion: "system" | "on";
  /**
   * Settings > Chats > Uploads > Upload folder (D37): where a dropped, pasted or picked file lands. The temporary
   * folder is the default; each upload gets its own new u-XXXXXX folder inside the chosen one.
   */
  uploadFolder: UploadFolder;
  /** The custom upload folder (absolute, or under ~), used while uploadFolder is "custom". */
  customFolder: string;
  /** Largest upload, in MB (1 MB is 1,000,000 bytes, as Finder counts); a larger file fails. 100 by default. */
  maxUploadMB: number;
  /** Delete uploads after this many days; for the kept folders only (not the temporary one). 7 by default. */
  keepDays: number;
}

/**
 * Where uploads land (D37): "temp" the temporary folder (/tmp/kitespan-uploads-<user>/, cleared when the machine
 * restarts), "state" kitespan's own folder (~/.local/state/kitespan/uploads/), "claude" Claude Code's uploads folder
 * (~/.claude/uploads/<session>/, where Claude Code saves photos sent from its phone app; the per-session folder is
 * unverified), "custom" the folder in customFolder.
 */
export type UploadFolder = "temp" | "state" | "claude" | "custom";

/**
 * A file the user dropped on the chat, pasted into the composer or picked with Add files or photos (D37). The host
 * saves it; its reference, "@" and the path, goes into the chat's draft for review and is never sent by itself.
 */
export interface Upload {
  id: string;
  chatId: string;
  /** The name it is saved under: the original name, or pasted.<subtype> for a nameless pasted image. */
  name: string;
  /** Bytes. */
  size: number;
  /** The MIME type the browser gave ("" when it gave none). */
  type: string;
  /** Where it is saved: the upload folder, a new u-XXXXXX folder, then the name (absolute, or under ~). */
  path: string;
  /** Its path before kitespan's folder move (round K1), which the messages sent before the move name. */
  was?: string;
  /** The upload folder it went to. */
  folder: UploadFolder;
  /** Its own folder: the upload folder and u-XXXXXX. Remove deletes this folder. */
  dir: string;
  at: string; // ISO
  state: "uploading" | "done" | "failed";
  /** How far it is, 0 to 1 (1 when done). */
  progress: number;
  /** Why it failed, as one sentence the user can act on. */
  error?: string;
}

/** View preferences: kept in local storage, never in the URL, and never recorded as actions. */
export interface ViewPrefs {
  /** The laptop's session rail (the side panel's column) is hidden: "Hide session rail" (DESIGN.md 6.2). */
  railHidden: boolean;
  /** The docked sidebar is hidden: its Hide sidebar, and Show sidebar in the title bar (row 82). */
  sidebarHidden: boolean;
  /** The widths the user dragged the panes to (row 82); a pane with none shows at its default. */
  widths: PaneWidths;
  /**
   * U4: where the user left the split side panel's divider, as the upper half's share of the column's height (0 to 1,
   * one number for every pair); none: equal halves. Never in a URL (DESIGN-U4 5).
   */
  split?: number;
}

/**
 * This device's pane widths in px (row 82, layout/panes.ts): the sidebar, the side pane (the cards, the search pane,
 * the uploads and files), and the Terminal pane, which keeps its own because its default is wider.
 */
export interface PaneWidths {
  sidebar?: number;
  side?: number;
  term?: number;
  /** Iteration 7 (DESIGN-B1 4.1): the Browser's own, never under 420 px. */
  browser?: number;
}

/**
 * A toast (DESIGN.md 6.3, the Toast row): Claude Code's notification, shown in a small panel at the top right of
 * the page. Live state in the store, never a transcript row and never a URL. One shows at a time, the highest
 * priority first; a toast with the same key replaces the one shown; it closes after `timeoutMs` (8 s when null) or
 * on its close button.
 */
export interface Toast {
  id: string;
  key: string;
  text: string; // plain text
  priority: "low" | "medium" | "high" | "immediate";
  timeoutMs: number | null;
  /** The chat whose Claude Code sent it: it shows while that chat is open. No chat: it shows on any screen. */
  chatId?: string;
}

/** A Claude Code session in a project's folder that kitespan has not opened (for example one started in a terminal). */
export interface PreviewSession {
  id: string; // the Claude Code session id
  projectId: string;
  title: string;
  startedIn: string; // "terminal", "another app"
  updatedAt: string;
  items: Item[];
}
