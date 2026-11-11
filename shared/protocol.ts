// The wire protocol (DESIGN.md 4.3) and the neutral chat events (4.2), as the server and the page both import them.
// BUILD-BRIEF section 2 adds: archive and delete (D48), the server's per-chat draft (D49), upload chips on send (D50)
// and the Terminal pane's socket (D52). v0.3 search (DESIGN.md 9.3) adds the mention chips: files of the chat's folder
// picked with `@`. Plain types plus small pure helpers; no runtime dependency, no DOM, no Bun API.
//
// Every frame on `/ws` is one JSON text object with a `t` field. `parseClientFrame` is the only way the server reads a
// frame from a page: it checks every field's type, id pattern and cap, and returns a clean copy that holds only the
// known fields. It never throws.

import { AGENT_REF, BG_ID, CHAT_ID, EPOCH, PROJECT_ID, TAB_ID, UPLOAD_ID, UUID } from "./ids";
import type { ChangesCard, EditHunk } from "./changes";

// ---------------------------------------------------------------------------------------------------------------
// Versions, limits and wire numbers

/**
 * The protocol version that `hello` and `welcome` carry. A page whose `v` differs reloads. Raised once per iteration
 * (D61). 3 since v0.4 resume: the snapshot's `tail`, the replay's `cursor`, `send_queued`, `end_here` and `send_now`,
 * `notSent` on a `user` event, a notice's `code`, `welcome.update.kind`, notices with an `id`, `actions` and `gone`, a
 * hold's `kind`, a session's `waiting`, and the ack codes of the queue, the variables and the worktrees (4.3). 4 since
 * iteration 5: `on_screen` and the row's `unseen` (row 116), so a page from before them, which would never report a
 * chat on screen, reloads; the side chat's frames, events and `get side` (R124) came in the same iteration, and so did
 * the side box's server-held draft (FIX-U2: `box` on the `draft` frame, `attached.sideDraft` and
 * `side_question.draftRev`), and Trust this folder (R127: `trust` on a tool result, the `trust` event, `attached.trust`,
 * `trust_folder` and its ack, the code `trust_refused`, `welcome.capabilities.trustFolder` and the pane's `type_trust`),
 * and the background sessions that a chat starts (R131: `background` on a tool result, the `background` event,
 * `attached.background`, the row's `background`, `on_screen.background`, `background_stop` and its ack, and the pane's
 * `type_attach`). 5 since iteration 7: the browser pane's socket (`WIRE.browserPath`, whose `open` carries this
 * version, shared/browser.ts), its routes and its side panel kind, so a page from before the pane reloads. v0.6 touch
 * adds one optional field with no raise, a tool result's `cut`: the page takes a frame's JSON as it is and reads a
 * tool result's named fields only, so a page of version 5 ignores it.
 */
export const PROTOCOL_VERSION = 5;

/** Text caps (4.3, 4.4, D20). A frame the server sends never holds a longer text field. */
export const LIMITS = {
  /** User text in the frames the server sends; the draft's text (4.4). */
  userText: 20_000,
  /** The draft's text (4.4): the server keeps the first 20,000 UTF-16 units, never cut inside a surrogate pair. */
  draftText: 20_000,
  draftCommand: 120,
  draftUploads: 100,
  /** The uploads one `send`, `bash` or `new_chat` may name (D50). */
  sendUploads: 100,
  /** The mention chips (9.3): files of the chat's folder that the draft, and one `send` or `bash`, may name. */
  draftMentions: 100,
  sendMentions: 100,
  toolResult: 6_000,
  /** A subagent's hand-back report on its Agent tool result (the spike's cap). */
  report: 3_000,
  localOutput: 8_000,
  /** `!` output per stream (D20). */
  bashOutput: 30_000,
  /** `!` input (D20, guard 6): at most 10,000 characters. */
  bashInput: 10_000,
  /** A chat's title (the rename limit, 4.4 and 6.10). */
  title: 120,
  /** A card answer's free text: the deny note, the plan feedback, a question's answer (A10). */
  answerText: 2_000,
  /** One string inside a tool call's or a permission card's input. */
  inputString: 8_000,
  /** All the strings and keys inside one tool call's or card's input, together. */
  inputBudget: 100_000,
  /** A model row value, a connector name, a slash command (picker and connector frames). */
  name: 120,
  /** The history cursor of a `get` (an opaque string the server made). */
  cursor: 512,
  /** A line of a task's or an agent's text (descriptions, summaries, prompts). */
  taskText: 1_200,
  /** One piece of a whole text or thinking block that is sent as a stream (splitBlock): its JSON stays under 256 KiB. */
  blockPiece: 32_000,
  /** The stderr lines kept for a chat's exit line (4.7, the `stderr` row): the last 4, each cut. */
  stderrLines: 4,
  stderrLine: 500,
  /** The skills, and the plugins, that one `session` event lists (each name cut at `name`). */
  loaded: 500,
  /** A plugin's version as its manifest declares it (author-controlled, so it is cut). */
  pluginVersion: 40,
} as const;

/** The numbers of the transport (4.3). Both sides read them, so they live here. */
export const WIRE = {
  path: "/ws",
  shellPath: "/ws/shell",
  /** Iteration 7: the browser pane's socket (DESIGN-B1 3; shared/browser.ts). */
  browserPath: "/ws/browser",
  /** Bun's `maxPayloadLength`: 1 MiB is enough for every client frame; uploads use HTTP. */
  maxPayloadBytes: 1024 * 1024,
  /** Bun's `idleTimeout`, in seconds, with `sendPings: true`. */
  idleTimeoutS: 60,
  /** A snapshot or a history page holds at most this much JSON. */
  pageBytes: 256 * 1024,
  pingEveryMs: 15_000,
  /** After this long with no frame from the server, the page treats the socket as half-open. */
  silenceMs: 35_000,
  wakeWaitMs: 600,
  dialDeadlineMs: 5_000,
  backoffFirstMs: 500,
  backoffMaxMs: 10_000,
  backoffJitter: 0.2,
  ringEvents: 2_000,
  ringBytes: 4 * 1024 * 1024,
  ackKeepMs: 10 * 60_000,
  ackKeepMax: 1_000,
  /** Bun's `backpressureLimit`, with `closeOnBackpressureLimit: true`. */
  backpressureBytes: 4 * 1024 * 1024,
  /** Over this buffered amount a socket is lagging; under `lagLowBytes` it catches up again. */
  lagHighBytes: 1024 * 1024,
  lagLowBytes: 256 * 1024,
  /**
   * Row 116: a page's `on_screen` counts only while its socket was heard from this recently (a visible page pings
   * every 15 s), so a phone that froze its page before the page could say `off` does not keep its chats seen.
   */
  onScreenFreshMs: 20_000,
} as const;

// ---------------------------------------------------------------------------------------------------------------
// Enumerations

/** Desktop's five permission modes, in the mode picker's order (6.6). The CLI's `dontAsk` is not one of them. */
export const MODE_IDS = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"] as const;
export type ModeId = (typeof MODE_IDS)[number];

/** The SDK's effort levels (sdk.d.ts 0.3.322 line 730). A model row offers some of them. */
export const EFFORT_IDS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortId = (typeof EFFORT_IDS)[number];

/** The states of a chat (4.1). */
export const CHAT_STATES = ["sleeping", "starting", "idle", "running", "waiting", "ending"] as const;
export type ChatState = (typeof CHAT_STATES)[number];

/**
 * Row 116: how the chat's last end that no page has seen went (agent view's words): `done`, a turn that ended well;
 * `failed`, a turn that ended in an error, or Claude Code's exit by itself.
 */
export const UNSEEN_KINDS = ["done", "failed"] as const;
export type Unseen = (typeof UNSEEN_KINDS)[number];

/** The composer's modes (6.4), as the draft keeps them (4.4). */
export const DRAFT_MODES = ["chat", "slash", "bash"] as const;
export type DraftMode = (typeof DRAFT_MODES)[number];

/**
 * D49: the boxes whose draft the server holds per chat: the message box's (`main`) and, from iteration 5, the side
 * chat's box (`side`, FIX-U2 section 2). On the wire the side box's frames carry `box: "side"`; no `box` is the message
 * box's. Both follow one set of rules (nextDraft, draftAfterSend, the store's caps and write window); the side box's
 * draft is plain text: chat mode, no `/` chip, no upload or mention chips.
 */
export type DraftBox = "main" | "side";

/** What a `get` reads (4.3). `side` (R124): the chat's side thread, kitespan's own; it never starts the chat. */
export const GET_WHAT = ["context", "connectors", "commands", "models", "history", "side"] as const;
export type GetWhat = (typeof GET_WHAT)[number];

export const TITLE_FROM = ["renamed", "generated", "first-prompt"] as const;
export type TitleFrom = (typeof TITLE_FROM)[number];

/** The `turn_end` subtype of a turn that a Stop ended (the server's own; Claude Code's result has no such subtype). */
export const TURN_INTERRUPTED = "interrupted";
/**
 * The `turn_end` subtype of a turn that kitespan's own stop cut (Restart now, live; any stop line under it, in
 * history): the stop line says what happened, so the page draws no "Interrupted" for it (`ok` false, `error` null).
 */
export const TURN_CUT = "cut";

/**
 * How a card closed, as its record says it (5.4): a permission's Allow once (`once`), Allow for this session
 * (`session`) or Deny (`denied`, also a plan's No, keep planning and an elicitation's Decline); any other answer
 * (`answered`); or no answer (`cancelled`: Stop, Claude Code withdrew it, Cancel, or its process ended).
 */
export const CARD_ANSWER_KINDS = ["once", "session", "denied", "answered", "cancelled"] as const;
export type CardAnswerKind = (typeof CARD_ANSWER_KINDS)[number];

/** The CLI's fast-mode states (`fast_mode_state` in `system/init`, sdk.d.ts 0.3.322 line 817). */
export const FAST_MODE_STATES = ["off", "cooldown", "on"] as const;
export type FastModeState = (typeof FAST_MODE_STATES)[number];

/**
 * The error codes of an `ack` (4.3). The page shows its own line for a code; `message` is a fixed sentence, never a
 * path, a stack or a value from the request (4.9, guard 5).
 */
export const ERROR_CODES = [
  "stale", // the card, the turn or the queued message that the request names is no longer open
  "busy", // archive without stop while Claude Code is busy (a turn runs, a card waits, a non-ambient task runs)
  "restarting", // the server drains for a restart and starts no new turn
  "bad_request", // the frame failed parseClientFrame, or names something of the wrong kind
  "no_claude", // the binary pin found no usable claude (4.7)
  "not_found", // no such chat, project, session or upload
  "upload_gone", // a file chip of the message names an upload that is not the chat's (removed meanwhile, or never its)
  "mention_gone", // a mention chip names a path that is not a file in the chat's folder (gone, or a link leads outside)
  "session_open", // D58: Continue here (no fork) of a session that another app has open now; Continue in a copy works
  "session_held", // row 78: a send or a `!` command while another app has the chat's session open (kitespan gave it up)
  "archived", // a composer action on an archived chat (D48)
  "queue_full", // RD-8: a send past the 50 messages or 4 MiB that may wait in one chat
  "env_unreadable", // D60: the environment's variables could not be read, so its chats do not start
  "worktree_gone", // row 73: kitespan's check before a start: the chat's worktree is gone, or not its project's
  "worktree_unverified", // Claude Code refused the start: it could not verify the session's worktree now
  "worktree_resume_refused", // Claude Code refused to resume the session in its worktree
  "cwd_unavailable", // Claude Code refused the start: the chat's folder was deleted or moved, or cannot be read
  "worktree_failed", // row 73: kitespan could not make (or make again) the chat's worktree
  "trust_refused", // R127: kitespan refused to ask Claude Code to trust that folder (its `reason` says why)
  "unsupported", // the driver lacks the capability (an untyped method that the feature test did not find)
  "failed", // the agent's call failed
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  stale: "That request is no longer open.",
  busy: "Claude Code is busy in this chat.",
  restarting: "kitespan is restarting.",
  bad_request: "That request could not be read.",
  no_claude: "Claude Code is not available. See Settings > Claude Code.",
  not_found: "That chat is not here. It may have been deleted.",
  upload_gone: "A file in the message box is not there any more. Remove it and try again.",
  // The line fits a chat's box and the new-chat form's, where no chat exists yet (W19d): the form's folder is the project's.
  mention_gone: "A file in the message box is not in this folder any more. Remove it and try again.",
  session_open: "That session is open in another app now. Continue it in a copy.",
  session_held: "This session is open in another app. You can send here again when it is closed there.",
  archived: "This chat is archived.",
  queue_full: "Too many messages wait in this chat. Take one back, or wait for Claude.",
  env_unreadable: "kitespan could not read this environment's variables, so its chats do not start. Enter them again, or remove the unreadable file.",
  worktree_gone: "This chat's worktree is not there any more.",
  worktree_unverified: "Claude Code could not check this chat's worktree just now. Try again.",
  worktree_resume_refused: "Claude Code would not continue this chat in its worktree.",
  cwd_unavailable: "This chat's folder was deleted or moved, or it cannot be read.",
  worktree_failed: "kitespan could not make a worktree for this chat.",
  trust_refused: "kitespan did not trust that folder.",
  unsupported: "This version of Claude Code cannot do that.",
  failed: "Claude Code could not do that.",
};

/**
 * Why a folder gets no worktree (row 73; build checklist W2, L29, L33): not in a git repository, not the top folder of
 * a repository's main checkout (a subfolder, or a linked worktree of the user's), a repository with no commit, a
 * WorktreeCreate hook in the project's Claude Code settings, which kitespan's worktrees would not run, a repository
 * config that could run a program (W1), or (row 100) a `.claude` or `.claude/worktrees` in the folder that is a
 * symbolic link or not a folder (`link`), or the top of another git repository's working tree (`nested`: a submodule,
 * or a clone that the project ignores). The one list of the server and the page; each has its line.
 */
export const WORKTREE_OFF = ["not_git", "not_top", "no_commit", "hook", "config", "link", "nested"] as const;
export type WorktreeOff = (typeof WORKTREE_OFF)[number];

export function isWorktreeOff(v: unknown): v is WorktreeOff {
  return typeof v === "string" && (WORKTREE_OFF as readonly string[]).includes(v);
}

/**
 * R127 (owner rows 126, 127, 129): Trust this folder. The state of a folder that Claude Code refused a background
 * session in (shared/trust.ts matches its line), the same on every page (D49): `trusting`, a trust start runs for it;
 * then one of the five answers. A folder with no state is offered (the page's Trust this folder).
 */
export const TRUST_STATES = ["trusting", "trusted", "already", "not_recorded", "failed", "gone"] as const;
export type TrustState = (typeof TRUST_STATES)[number];
/**
 * The answer of a `trust_folder` that passed every check: `trusted`, Claude Code recorded the trust
 * (`workspace_trust_recorded` true); `already`, this server trusted the folder before and no refusal of it came since;
 * `not_recorded`, Claude Code answered false or nothing; `failed`, Claude Code did not start or did not answer; `gone`,
 * the folder is not there.
 */
export const TRUST_ANSWERS = ["trusted", "already", "not_recorded", "failed", "gone"] as const;
export type TrustAnswer = (typeof TRUST_ANSWERS)[number];
/**
 * Why kitespan refused a `trust_folder` (the ack error `trust_refused` carries it as `reason`): the path is a symbolic
 * link or holds one (`link`), is not a folder (`not_folder`), is the home folder, which Claude Code never saves trust
 * for (`home`), holds the home folder (`holds_home`: a trust outside a repository covers the folders under it), or is
 * longer than 4,096 bytes (`too_long`).
 */
export const TRUST_REFUSALS = ["link", "not_folder", "home", "holds_home", "too_long"] as const;
export type TrustRefusal = (typeof TRUST_REFUSALS)[number];
export const TRUST_LIMITS = {
  /** A folder that kitespan asks Claude Code to trust: at most 4,096 bytes of UTF-8 (the system's PATH_MAX). */
  pathBytes: 4096,
  /** The longest path that an event or a `trust_folder` frame carries, in UTF-16 units. */
  pathChars: 16_384,
} as const;

export function isTrustState(v: unknown): v is TrustState {
  return typeof v === "string" && (TRUST_STATES as readonly string[]).includes(v);
}

export function isTrustRefusal(v: unknown): v is TrustRefusal {
  return typeof v === "string" && (TRUST_REFUSALS as readonly string[]).includes(v);
}

/**
 * R127: the folder that a tool result's refusal names (Claude Code's line, matched on the whole text before the cap),
 * and the repository root that holds it when that root is another folder (a subfolder or a linked worktree: trusting
 * it trusts the whole repository), else null. The server's own file reads find the root; it never runs git.
 */
export interface TrustRef {
  path: string;
  root: string | null;
}

/** An ack's error. `reason`, only on `worktree_failed` (F5: why the folder gets no worktree) and `trust_refused` (R127). */
export interface AckError {
  code: ErrorCode;
  message: string;
  reason?: WorktreeOff | TrustRefusal;
}

export function ackError(code: ErrorCode, reason?: WorktreeOff | TrustRefusal): AckError {
  const kept = (code === "worktree_failed" && isWorktreeOff(reason)) || (code === "trust_refused" && isTrustRefusal(reason));
  return { code, message: ERROR_MESSAGES[code], ...(kept ? { reason } : {}) };
}

/** The page's read of a `trust_refused` error's `reason` (R127): a known refusal, else null. */
export function ackTrustReason(error: unknown): TrustRefusal | null {
  if (!isObj(error) || get(error, "code") !== "trust_refused") return null;
  const r = get(error, "reason");
  return isTrustRefusal(r) ? r : null;
}

/**
 * The page's read of an ack error's `reason` (F5): a known worktree off reason on a `worktree_failed` error, else null
 * (the page then shows the code's own line).
 */
export function ackReason(error: unknown): WorktreeOff | null {
  if (!isObj(error) || get(error, "code") !== "worktree_failed") return null;
  const r = get(error, "reason");
  return isWorktreeOff(r) ? r : null;
}

// ---------------------------------------------------------------------------------------------------------------
// R131 (owner row 131): background sessions that a chat starts with `claude --bg`

/**
 * The state of a background session that a chat's own tool row printed (shared/background.ts matches its launch line),
 * the same on every page (D49), in agent view's words: `starting`, the line came and Claude Code has no record of the
 * session yet; `working`; `needs_input` (agent view's "Needs input", the list's `blocked`); `idle`, its record says idle
 * and Claude Code's list cannot be read; `completed` (the list's `done`); `failed`; `stopped`.
 */
export const BG_STATES = ["starting", "working", "needs_input", "idle", "completed", "failed", "stopped"] as const;
export type BgState = (typeof BG_STATES)[number];
/**
 * What a session that needs input waits for: Claude Code's own `waitingFor` values (the docs' five and the binary's
 * `goal proposal`), and `other` for one that kitespan does not know.
 */
export const BG_WAITS = ["permission prompt", "input needed", "sandbox request", "worker request", "dialog open", "goal proposal", "other"] as const;
export type BgWait = (typeof BG_WAITS)[number];
/**
 * The chat row's own field for its background sessions (not `needsYou`, which means a card waits): `needs_input` while
 * one needs input; else `failed` while one failed and no page saw it; else `done` while one completed unseen.
 */
export const BG_ROW_STATES = ["needs_input", "failed", "done"] as const;
export type BgRowState = (typeof BG_ROW_STATES)[number];
/** The answer of a `background_stop` that passed the checks: `claude stop <id>` said stopped, found none, or neither. */
export const BG_STOP_ANSWERS = ["stopped", "not_found", "failed"] as const;
export type BgStopAnswer = (typeof BG_STOP_ANSWERS)[number];
export const BG_LIMITS = {
  /** The launch lines one tool result carries (one per id). */
  perResult: 16,
  /** The ids a chat's book keeps (the newest). */
  perChat: 64,
  /** A session's name: its control characters out, cut at this many UTF-16 units. */
  name: 120,
  /** A session's folder (absolute): at most 4,096 bytes of UTF-8 on the server, this many UTF-16 units on the wire. */
  folderChars: 4096,
} as const;

/** One launch line of a tool result: the short id, the `-n` name (null without one), and the idle suffix. */
export interface BgLaunch {
  id: string;
  name: string | null;
  idle: boolean;
}

/**
 * A background session as every page of the chat that printed it gets it. `waitingFor` only with `needs_input`, when
 * Claude Code names it. `idleLaunch`: the launch line had the idle suffix (the reason "send a prompt to start").
 * `name`: the launch's `-n` name, else Claude Code's own name for it, else null (the page shows the short id).
 * `folder`: its real folder. `view`: the folder is the chat's project folder or under it, or the chat's worktree, so the
 * read-only view may show its transcript. `startedAt`: ms since the epoch. `unseen`: it completed or failed while no
 * page had its line or its view on screen.
 */
export interface BgWorker {
  state: BgState;
  waitingFor?: BgWait;
  idleLaunch?: true;
  name: string | null;
  folder: string | null;
  view: boolean;
  startedAt: number | null;
  unseen?: true;
}

const isBgIdText = (v: unknown): v is string => typeof v === "string" && BG_ID.test(v);
const bgNameOf = (v: unknown): string | null => (typeof v === "string" && v !== "" ? capText(v, BG_LIMITS.name) : null);

/** A tool result's `background` as a frame carries it: at most 16 well-formed launches, else null (no key). */
export function bgLaunchesOf(v: unknown): BgLaunch[] | null {
  if (!Array.isArray(v)) return null;
  const out: BgLaunch[] = [];
  for (const x of v) {
    if (!isObj(x) || !isBgIdText(get(x, "id")) || typeof get(x, "idle") !== "boolean") continue;
    const name = get(x, "name");
    if (name !== null && typeof name !== "string") continue;
    if (out.some((l) => l.id === get(x, "id"))) continue;
    out.push({ id: get(x, "id") as string, name: bgNameOf(name), idle: get(x, "idle") as boolean });
    if (out.length >= BG_LIMITS.perResult) break;
  }
  return out.length ? out : null;
}

/** A `background` event's worker as a frame carries it: each field by its rule; null for one with no known state. */
export function bgWorkerOf(v: unknown): BgWorker | null {
  if (!isObj(v)) return null;
  const state = get(v, "state");
  if (typeof state !== "string" || !(BG_STATES as readonly string[]).includes(state)) return null;
  const wait = get(v, "waitingFor");
  const folder = get(v, "folder");
  const started = get(v, "startedAt");
  return {
    state: state as BgState,
    ...(state === "needs_input" && typeof wait === "string" && (BG_WAITS as readonly string[]).includes(wait) ? { waitingFor: wait as BgWait } : {}),
    ...(get(v, "idleLaunch") === true ? { idleLaunch: true as const } : {}),
    name: bgNameOf(get(v, "name")),
    folder: typeof folder === "string" && folder.startsWith("/") && folder.length <= BG_LIMITS.folderChars && !CONTROL_CHARS.test(folder) ? folder : null,
    view: get(v, "view") === true,
    startedAt: typeof started === "number" && Number.isSafeInteger(started) && started > 0 ? started : null,
    ...(get(v, "unseen") === true ? { unseen: true as const } : {}),
  };
}

/**
 * GET /api/chats/:chat/background/:id (`?since=<stamp>&before=<cursor>`), the read-only view's read of the session's
 * transcript. `same`: `since` matched the transcript's size and time (or BG_NO_STAMP while there is still none),
 * nothing else. `outside`: the session's folder is not the chat's project folder or under it, nor the chat's worktree,
 * so nothing was read. Else the newest page (or the page before `before`), its `more` cursor, the `stamp` to send as
 * `since` next (BG_NO_STAMP while no transcript can be read) and the session's permission mode from its transcript
 * (null: none known). Only a read with neither `since` nor `before` is a view's opening.
 */
/**
 * R131: the stamp of a background session's view read that found no transcript (Starting, a file that is missing or
 * gone, a folder or history that cannot be read). The page sends it back as `since` like any stamp, so its later ticks
 * are later reads (never a view's opening, which asks Claude Code's list), answered `same` while there is still none.
 */
export const BG_NO_STAMP = "none";

export interface BackgroundViewReply {
  same?: true;
  outside?: true;
  history?: ChatEvent[];
  more?: string | null;
  stamp?: string | null;
  mode?: ModeId | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Plain records

/** The user's own picks for a chat (null: the user's Claude Code default). Effort shows "Default" when null. */
export interface Picks {
  model: string | null;
  effort: EffortId | null;
  mode: ModeId | null;
}

export interface ChatTitle {
  text: string;
  from: TitleFrom;
}

/** One question of an AskUserQuestion card. */
export interface Question {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string }[];
}

/** A `/` menu row (sdk.d.ts `SlashCommand`, plus D47's terminal-only mark from `system/init`). */
export interface CommandInfo {
  name: string;
  description: string;
  argumentHint: string;
  aliases: string[];
  /** Claude Code's own command; one that is not is tagged "yours" (6.4). */
  builtin: boolean;
  /** Listed in `terminal_slash_commands`: greyed, with Open in terminal (D47). */
  terminalOnly: boolean;
}

/** A model picker row (sdk.d.ts `ModelInfo`). `value` is what `set_model` sends: the row value, never a bare alias. */
export interface ModelInfo {
  value: string;
  displayName: string;
  description: string;
  efforts: EffortId[];
  supportsAutoMode: boolean;
}

/** The Context detail (sdk.d.ts `getContextUsage`). */
export interface ContextInfo {
  model: string | null;
  usedTokens: number;
  maxTokens: number;
  percent: number;
  parts: { name: string; tokens: number; kind: "used" | "free" | "buffer" | "deferred" }[];
}

/** A Connectors row (sdk.d.ts `McpServerStatus`). */
export interface ConnectorInfo {
  name: string;
  status: "connected" | "failed" | "needs-auth" | "pending" | "disabled";
  error: string | null;
  tools: number;
  /** Where the user configured it (user, project, local, plugin), when Claude Code says. */
  scope: string | null;
  /** A tool declares an MCP Apps view (6.3): the row says kitespan does not show it. */
  hasView: boolean;
}

export interface TaskUsage {
  totalTokens: number;
  toolUses: number;
  durationMs: number;
}

/** One entry of a workflow's progress (the spike's `workflow_progress` mapping): a phase or an agent row. */
export type WorkflowStep =
  | { kind: "phase"; index: number; title: string | null }
  | {
      kind: "agent";
      index: number;
      label: string | null;
      phaseIndex: number | null;
      phaseTitle: string | null;
      state: string | null;
      attempt: number | null;
      prompt: string | null;
      result: string | null;
      error: string | null;
      model: string | null;
    };

// ---------------------------------------------------------------------------------------------------------------
// Cards and their answers (4.2, 6.3)

/** A permission card. The Workflow launch card (CA-4) is a permission card whose `toolName` is `Workflow`. */
export interface PermissionCard {
  kind: "permission";
  /** The request id: the tool-use id of the call that waits (5.1 rule 2). */
  id: string;
  toolUseId: string;
  toolName: string;
  /** Claude Code's own prompt sentence, when it sends one. */
  title: string | null;
  /** A short noun phrase for the action, when Claude Code sends one. */
  displayName: string | null;
  description: string | null;
  /** Why the request came (the reason line). */
  reason: string | null;
  /** The path that triggered the request, when one did. */
  blockedPath: string | null;
  input: unknown;
  /** Open on the decline button and offer no one-key approve (sdk.d.ts 0.3.322 line 285). */
  defaultToNo: boolean;
  /** Offer no persistent choice: no Allow for this session (sdk.d.ts 0.3.322 line 290). */
  suppressAlwaysAllowRule: boolean;
  /** Claude Code suggested a rule that the `session` destination can hold, so Allow for this session can show. */
  sessionRule: boolean;
  /** The subagent's tool-use id when the call runs inside a subagent, else null. */
  parent: string | null;
}

export interface QuestionCard {
  kind: "question";
  id: string;
  toolUseId: string;
  questions: Question[];
}

export interface PlanCard {
  kind: "plan";
  id: string;
  toolUseId: string;
  /** The plan as markdown. */
  plan: string;
}

export interface ElicitationCard {
  kind: "elicitation";
  /** The control request's requestId. */
  id: string;
  server: string;
  displayName: string | null;
  title: string | null;
  description: string | null;
  message: string;
  mode: "form" | "url";
  url: string | null;
  /** URL mode only: pairs the request with its completion notice. */
  elicitationId: string | null;
  schema: unknown;
}

export interface DialogCard {
  kind: "dialog";
  id: string;
  dialogKind: string;
  payload: unknown;
  expiresAt: string | null;
}

export type Card = PermissionCard | QuestionCard | PlanCard | ElicitationCard | DialogCard;
export type CardKind = Card["kind"];

export type CardAnswer =
  /** `session`: Claude Code's own suggested rule with the `session` destination, so no settings file is written. */
  | { kind: "permission"; allow: true; scope: "once" | "session" }
  /** "Tell Claude what to do instead"; may be "". */
  | { kind: "permission"; allow: false; message: string }
  /** Keyed by the question's text; a multi-select answer is the ticked labels joined with ", ". */
  | { kind: "question"; answers: Record<string, string> }
  | { kind: "plan"; approve: true; mode: "auto" | "acceptEdits" | "bypassPermissions" | "default" }
  /** "No, keep planning" and what to change. */
  | { kind: "plan"; approve: false; feedback: string }
  | { kind: "elicitation"; action: "accept"; content?: Record<string, ElicitationValue> }
  | { kind: "elicitation"; action: "decline" | "cancel" }
  /** Its shape depends on dialogKind. */
  | { kind: "dialog"; behavior: "completed"; result: unknown }
  /** Claude Code applies the dialog's default. */
  | { kind: "dialog"; behavior: "cancelled" };

/** A form value of an elicitation (the MCP `ElicitResult` content). */
export type ElicitationValue = string | number | boolean | string[];

export const PLAN_MODES = ["auto", "acceptEdits", "bypassPermissions", "default"] as const;
export type PlanMode = (typeof PLAN_MODES)[number];

/** A plugin that Claude Code loaded in a chat (`plugins` in `system/init`; its path stays on the server). */
export interface PluginInfo {
  name: string;
  /** The version its manifest declares, or null when it declares none. */
  version: string | null;
}

/** The fast-mode line of Settings > Models (D35, AR-7): the CLI's state and, when it says one, its reason. */
export interface FastModeInfo {
  state: FastModeState;
  /** `fast_mode_disabled_reason` as the CLI sends it (for example `not_first_party`), or null. */
  reason: string | null;
}

// ---------------------------------------------------------------------------------------------------------------
// The neutral chat events (4.2). `parent` is the tool-use id of the subagent or workflow block, or null.

export type TaskEvent =
  | {
      k: "task";
      ev: "started";
      taskId: string;
      toolUseId: string | null;
      taskType: string | null;
      subagentType: string | null;
      description: string;
      workflowName: string | null;
      /** Registered in the background (`is_backgrounded`). */
      background: boolean;
      /** The task's prompt; null for a workflow. */
      prompt: string | null;
      parentTaskId: string | null;
    }
  | {
      k: "task";
      ev: "progress";
      taskId: string;
      toolUseId: string | null;
      description: string;
      lastTool: string | null;
      summary: string | null;
      usage: TaskUsage | null;
      /** A workflow's phases and agents, when the message carries them. */
      workflow: WorkflowStep[] | null;
    }
  | {
      k: "task";
      ev: "updated";
      taskId: string;
      toolUseId: string | null;
      status: "pending" | "running" | "completed" | "failed" | "killed" | "paused" | null;
      error: string | null;
      /** A later move to the background, when the patch has it. */
      background: boolean | null;
    }
  | {
      k: "task";
      ev: "done";
      taskId: string;
      toolUseId: string | null;
      status: "completed" | "failed" | "stopped";
      summary: string | null;
      usage: TaskUsage | null;
    };

export type ChatEvent =
  /**
   * From `system/init`. `bypass`: this Claude Code started with the bypass flag (D12), so Bypass can be picked. The
   * rest are what Settings and the + menu read (6.5, 6.8: AR-7, SE-3, SE-4): `fastMode` (null when the CLI sends no
   * state), the skills and the plugins that the chat loaded, and its output style (null when the CLI names none). The
   * server sends all four; they are optional only so that an event made without them still reads. A chat with no
   * `session` event yet has not started: the page says so in one line ("Start a chat to read it").
   */
  | {
      k: "session";
      sessionId: string;
      model: string | null;
      mode: string | null;
      version: string | null;
      bypass: boolean;
      fastMode?: FastModeInfo | null;
      skills?: string[];
      plugins?: PluginInfo[];
      outputStyle?: string | null;
      /**
       * L34: the folder that Claude Code says it runs in (`system/init`'s `cwd`): the chat's own folder, or another one
       * when Claude moved the session into a worktree (EnterWorktree). Absent or null: it named none.
       */
      cwd?: string | null;
    }
  /** Host-derived (4.1): a turn starts, on the user's message or by itself (a background task, a wake-up). */
  | { k: "turn_start"; by: "user" | "agent" }
  /**
   * The user's own message, made by the server when it puts the message on the input iterable (D49, live L2: the CLI
   * does not echo it), and from history. The text is what Claude Code gets, with the upload references (D50).
   * `queued`: sent while a turn runs (or while a `!` command sent before it waits or runs), so the page shows Queued
   * until a turn starts on it. `mentions` (9.3): the paths, relative to the chat's folder, of the mention chips it was
   * sent with, in chip order (userMentions), whose references (messageRef) end the text after the uploads';
   * the page makes exactly these tiles. An empty list: this server sent it with no chips, so no reference of its text
   * is a tile. Absent: a message with no record of them (from before v0.3, from the terminal, or one whose note the
   * notes' cap dropped), which the page reads as before. `notSent` (RD-8): a message that waited when the server
   * stopped, restored at boot from the chat's queue file: the page shows Not sent in Queued's place, with Send again
   * (`send_queued`) and Take back, until a `user` event with `queued: false` says that it went. Absent: false.
   */
  | { k: "user"; uuid: string; text: string; queued: boolean; mentions?: string[]; notSent?: boolean }
  /**
   * A queued message was taken back (Take back, or a start, a process or the server that ended before it ran): every
   * page removes its row, and the server puts its text back in the draft where it fits (6.3). A `!` command that never
   * ran keeps its row (`bash` state `not_run`). `uuid` may also be a `notice` line's `id`: that line goes from every
   * page.
   */
  | { k: "taken_back"; uuid: string }
  | { k: "block_start"; key: string; kind: "text" | "thinking"; parent: string | null }
  | { k: "block_delta"; key: string; text: string }
  | { k: "block_end"; key: string }
  /** A whole block, not streamed (subagent text, history, a reply that did not stream). */
  | { k: "block"; key: string; kind: "text" | "thinking"; text: string; parent: string | null }
  /**
   * A tool call. It may come twice for one id: at the stream's block start with `input: null`, then with the whole
   * input; the later replaces the earlier.
   */
  | { k: "tool_call"; id: string; name: string; input: unknown; parent: string | null }
  /**
   * `report`: a subagent's hand-back report (`handbackReport` as a string or `{text}`), else null. `trust` (R127): the
   * result's whole text (before the cap) holds Claude Code's refusal of a background session in a folder that is not
   * trusted (shared/trust.ts), live and in history, of the main thread or of a subagent; absent otherwise. `background`
   * (R131): the launch lines of Claude Code's background sessions in the result's whole text (shared/background.ts),
   * in their order, one per id; absent when it holds none, and never on an Agent or Task result. `cut` (v0.6 touch,
   * T-26): the whole text's length when the server cut `text` at LIMITS.toolResult, so the page can say that it holds
   * the first part only (toolOutputPath serves the whole); absent when nothing was cut.
   */
  | { k: "tool_result"; id: string; text: string; isError: boolean; parent: string | null; report: string | null; trust?: TrustRef; background?: BgLaunch[]; cut?: number }
  /**
   * A tool call that will get no result: its turn ended (a Stop, an error) or its process exited while it ran, so the
   * page tags its row Stopped. Live it comes before the turn's `turn_end` (or on the exit); in history it follows the
   * call's turn. A call inside a subagent that outlives the turn (in the background) stops only when its task ends.
   */
  | { k: "tool_stopped"; id: string; parent: string | null }
  /** A running tool's elapsed time (`tool_progress`). */
  | { k: "tool_progress"; id: string; seconds: number; parent: string | null }
  /**
   * A tool call denied with no prompt (`permission_denied`): the row's tag. `reasonType` is Claude Code's
   * discriminator, for example `classifier` for auto mode ("Denied by auto mode").
   */
  | { k: "denied"; id: string; tool: string; reasonType: string | null; reason: string | null; parent: string | null }
  /**
   * A `!` command (D10, D20). It comes once when the command waits (`queued`: for a turn to end, for the turn of a
   * message sent before it, or for the chat's start), once when it starts (`running`) and once with its record
   * (`done`); the later replaces the earlier. From history, a row that kitespan ran has the `code`, `ms`, `timedOut`
   * and `capped` that it had live (the server's notes keep them); a `!` typed in the terminal has null `code` and `ms`.
   * `not_run`: a command that waited and will never run (its chat's start failed, the chat was archived, its process
   * ended first, or the server stopped): the row stays, with no output and null `code` and `ms`, live, in history and
   * after a restart (the server's notes keep it where it was). Its text also goes back to the message box when the box
   * is empty.
   */
  | {
      k: "bash";
      uuid: string;
      input: string;
      state: "queued" | "running" | "done" | "not_run";
      stdout: string;
      stderr: string;
      code: number | null;
      ms: number | null;
      timedOut: boolean;
      capped: boolean;
    }
  | { k: "card_open"; card: Card }
  /**
   * `lost`: the card ended unanswered with its Claude Code process (5.4). `answer` is how it closed, for its record
   * (the server always sends it; it is optional only so that an event made without it still reads); `answers` is a
   * question card's picked answers, keyed by the question's text; `mode` an approved plan's mode; `note` the text of a
   * Deny or of No, keep planning, when there is one. History carries each closed card of the transcript's turns as its
   * `card_open` and this `card_close`, right after the card's tool call, from the server's own record (it survives a
   * reload and a restart), so a page draws the answered record and knows the card was answered.
   */
  | {
      k: "card_close";
      id: string;
      why: "answered" | "cancelled" | "lost";
      answer?: CardAnswerKind;
      answers?: Record<string, string>;
      mode?: PlanMode;
      note?: string;
    }
  | TaskEvent
  /** Replaces the whole set of running background tasks (`background_tasks_changed`). */
  | { k: "tasks"; running: { taskId: string; description: string; ambient: boolean }[] }
  /** Replaces the whole `/` menu (`commands_changed`). */
  | { k: "commands"; list: CommandInfo[] }
  /** A local slash command's output; the stream comes from its `<local-command-stdout>` or `-stderr` tag. */
  | { k: "local_output"; stream: "stdout" | "stderr"; text: string }
  | { k: "hook"; phase: "started" | "progress" | "response"; event: string; name: string; outcome: string | null; output: string | null }
  | { k: "compacted"; trigger: string }
  | { k: "reset"; trigger: string }
  /** The user's picks after a picker change, once the agent confirmed it. */
  | { k: "picks"; model: string | null; effort: string | null; mode: string | null }
  | { k: "title"; title: string; from: TitleFrom }
  /**
   * `uuids`: the user messages this turn answered (`user_message_uuids`; several sent close together may share one).
   * `subtype` is Claude Code's result subtype, or TURN_INTERRUPTED for a turn that a Stop ended (then `ok` is false
   * and `error` null), so every page shows the same end ("Interrupted"), whichever page pressed Stop; TURN_CUT for one
   * that kitespan's own stop cut, whose stop line says so.
   */
  | { k: "turn_end"; ok: boolean; subtype: string; durationMs: number; error: string | null; uuids: string[] }
  /**
   * A server line in the chat, for example "This chat waits for a free slot." A line with an `id` may go: a later
   * `taken_back` with that id removes it (the free-slot line, once the wait ends, with a start or without one). The
   * stop lines of D32 ("kitespan stopped while this chat was running. Send a message to continue.") have an id too, so
   * a page that gets one in the tail and in history draws it once. `code`: the line of a refused start (an ErrorCode,
   * for example `worktree_unverified`), so the page can draw that code's buttons under it (Try again, for one).
   */
  | { k: "notice"; text: string; id?: string; code?: ErrorCode }
  | { k: "status"; status: "compacting" | "requesting" | null; compact: "success" | "failed" | null; error: string | null }
  | { k: "retry"; attempt: number; max: number; delayMs: number; error: string }
  /** null `fallback`: no retry ran. An absent SDK `scope` counts as `session`. */
  | { k: "refusal"; uuid: string; text: string; retracted: string[]; fallback: { model: string; scope: "session" | "local" } | null }
  | { k: "info"; uuid: string; text: string; level: "info" | "notice" | "suggestion" | "warning"; toolUseId: string | null }
  | { k: "memory"; uuid: string; items: { scope: "personal" | "team" | "organization"; path: string; text: string | null }[] }
  | { k: "plugin_install"; uuid: string; status: "started" | "installed" | "failed" | "completed"; name: string | null; error: string | null }
  | { k: "toast"; key: string; text: string; priority: "low" | "medium" | "high" | "immediate"; timeoutMs: number | null }
  /** The running total of the live thinking block. */
  | { k: "thinking_estimate"; tokens: number }
  /** The suggested next prompt (6.4). */
  | { k: "suggestion"; text: string }
  /**
   * An assistant message's `error` (sdk.d.ts 0.3.322 line 3832): the error row. `authentication_failed` and
   * `cloud_credential_error` show the sign-in line (6.3).
   */
  | { k: "agent_error"; uuid: string; error: string; parent: string | null }
  /**
   * The agent process ended by itself, or its start failed. A close that kitespan asked for (the idle timer, the cap,
   * Archive, Stop and archive, Delete, shutdown) sends no `exit`: the row turns `sleeping` (or goes), each message still
   * in the agent's own queue gets `taken_back`, and running tasks end with an empty `tasks`. `stderr`: its last lines,
   * for the exit line only (never logged). `startup` (W5): Claude Code refused the start itself (an error result with
   * `startup_failure_reason`), with that result's first error line; absent for any other end.
   */
  | { k: "exit"; code: number | null; signal: string | null; stderr: string[]; startup?: StartupFailure }
  /**
   * The side chat (R124): an exchange of the chat's side thread was added or changed (asked, a retry, answered,
   * failed). `rev` is the thread's: one higher at each change, never lower while the chat exists. Not a part of the
   * conversation: the page's transcript ignores the three side kinds, and `get side` reads the whole thread.
   */
  | { k: "side"; rev: number; x: SideExchange }
  /** A side question that Stop ended left the thread. */
  | { k: "side_gone"; rev: number; id: string }
  /** Clear: the side thread is empty. */
  | { k: "side_clear"; rev: number }
  /**
   * R127: the state of a refused folder changed (a trust start began, or answered), or `null`: a live refusal of it
   * cleared its answer, so its line offers Trust this folder again. The server puts it in the ring of every chat that
   * holds a refused row of `path`, so every page of each shows it (D49). Not a transcript row.
   */
  | { k: "trust"; path: string; state: TrustState | null }
  /**
   * R131: the state of a background session that a launch row of this chat printed changed, or `null`: Claude Code no
   * longer lists it (its line goes). The server puts it in the ring of every chat whose book holds the id. Not a
   * transcript row.
   */
  | { k: "background"; id: string; worker: BgWorker | null }
  /**
   * The agent's own word that its running turn took these user messages in (`user_message_uuids` on a reply's first
   * frames, sdk.d.ts 0.3.322 line 3757). The server's alone: it turns each one that waited into a `user` event with
   * `queued: false` and never sends this to a page.
   */
  | { k: "taken_in"; uuids: string[] }
  /**
   * Claude Code's word that a user message it was given will not run: its `command_lifecycle` frame with the state
   * `cancelled` (Claude Code's own internal stream-json frame; sdk.d.ts 0.3.322 has no type for it, and the SDK hands
   * it on). sdk.d.ts 0.3.322 line 4901 (SDKControlInterruptResponse.still_queued): a message that Claude Code still
   * holds behind a model change or start-up work answers cancel_async_message with `cancelled: false`, gets a
   * cancel-pending mark, and the drain drops it later, with this frame ("caught by a pending cancel just before
   * dispatch"). The server's alone: a Take back that got `cancelled: false` finishes on it; never sent to a page.
   */
  | { k: "dropped"; uuid: string }
  /**
   * U1 (DESIGN-U1 5): what a finished turn changed in the chat's folder (shared/changes.ts ChangesCard), the card under
   * its answer. It comes after the turn's `turn_end` (about 30 ms to 10 s later), into the ring for every page, and
   * history gives it right after that turn's end from the server's store, so every page draws the same card (D49); a
   * page places it by its `at`, the turn's first rows. A turn that changed nothing gets none. Paths and counts only.
   */
  | ({ k: "changes" } & ChangesCard)
  /**
   * U1: a file tool's own patch (an Edit, MultiEdit or Write result's `structuredPatch`, sdk-tools.d.ts FileEditOutput
   * and FileWriteOutput) for the turn's fallback when it has no git marks: the file's absolute path as the tool named
   * it, whether a Write created it, its counts and its hunks (cut to fit, `cut`). The server's alone: never sent to a page.
   */
  | { k: "edit_patch"; id: string; path: string; create: boolean; added: number; removed: number; hunks: EditHunk[]; cut: boolean; parent: string | null };

/**
 * W5: the start-up refusals that kitespan tells apart (sdk.d.ts 0.3.322 lines 6058-6061, 6319-6322; their text grew
 * since 0.3.312); every other value reads as `unknown`, also the three that 0.3.322 adds (`sandbox_required_unavailable`,
 * `initialize_not_first`, `config_file_invalid`) and one that the pinned SDK does not know yet.
 */
export const STARTUP_REASONS = ["worktree_unverified", "worktree_resume_refused", "cwd_unavailable", "unknown"] as const;
export type StartupReason = (typeof STARTUP_REASONS)[number];
export interface StartupFailure {
  reason: StartupReason;
  /** The result's first error line (Claude Code's own words), cut at 500 characters; null when it had none. */
  line: string | null;
}

export type ChatEventKind = ChatEvent["k"];
export type ChatEventOf<K extends ChatEventKind> = Extract<ChatEvent, { k: K }>;

// ---------------------------------------------------------------------------------------------------------------
// The chat's draft (D49, 4.4)

/** The chat's draft as the `draft` frame and `attached` carry it. */
export interface DraftState {
  /** Grows by one on every change and never goes back while the chat exists. */
  rev: number;
  text: string;
  mode: DraftMode;
  /** The `/` chip, in slash mode only. */
  command: string | null;
  /** The text came from a link and has not been sent or cleared: every page shows "Prompt from an external link". */
  link: boolean;
  /** Upload ids of this chat that the draft refers to. */
  uploads: string[];
  /** The mention chips (9.3): paths relative to the chat's folder, picked with `@`. Absent: none. */
  mentions?: string[];
  /** The `tab` of the page that made the last change. */
  by: string | null;
  /** When the server took the last change (ISO 8601 UTC). */
  at: string;
}

// ---------------------------------------------------------------------------------------------------------------
// The side chat (owner rows 124 and 125; DESIGN-R124 sections 9 and 10)
//
// A side question asks Claude about the chat without adding anything to the conversation (Claude Code's /btw, the
// desktop app's side chat). The server asks it on the chat's live process (a sleeping chat wakes with no turn) and
// keeps each question and its answer in the chat's side thread: kitespan's own state (side/<chat id>.json), the same on
// every device and kept across a restart. Nothing of it goes into Claude Code's transcript, the queue or a turn.

export const SIDE_LIMITS = {
  /** A side question: 1 to 5,000 UTF-16 units after trimming. */
  question: 5_000,
  /** An answer, as Claude Code gave it. */
  answer: 20_000,
  /** A refusal fallback's notice. */
  fallback: 500,
  /** The answered exchanges a thread keeps (the CLI's and VS Code's 20): the oldest goes when a 21st lands. */
  kept: 20,
  /** A `get side` holds at most this much JSON: the oldest exchanges are left out of a larger one. */
  readBytes: 256 * 1024,
  /** kitespan's own bound on one side question, above the CLI's 11 minutes: then it fails. */
  deadlineMs: 12 * 60_000,
} as const;

export const SIDE_STATES = ["asking", "answered", "failed"] as const;
export type SideState = (typeof SIDE_STATES)[number];

/** Claude Code's last `api_retry` progress of a side question that still asks (6.3's retry line). */
export interface SideRetry {
  attempt: number;
  max: number;
  delayMs: number;
}

/** One side question and its answer. */
export interface SideExchange {
  /** The exchange's uuid, made by the page; Try again asks again under the same id. */
  id: string;
  question: string;
  /** When it was asked (ISO 8601 UTC). */
  at: string;
  state: SideState;
  /** `answered`: the answer as Claude Code gave it ("" is allowed). */
  answer?: string;
  /** `answered`: Claude Code made the answer, not the model. */
  synthetic?: true;
  /** `answered`: a fallback model answered (Claude Code's notice), never holding a provider's ARN. */
  fallback?: string;
  /** `asking`: the last retry. */
  retry?: SideRetry;
  /** `failed`: why. */
  error?: ErrorCode;
}

/** A `get side`: the thread's rev and its exchanges, oldest first (at most 20 answered, then one asking or failed). */
export interface SideRead {
  rev: number;
  exchanges: SideExchange[];
}

/** A refusal fallback's notice that names a provider's resource (`arn:`) reads as this line instead (row 95's rule). */
export const SIDE_FALLBACK_ARN = "Another model answered this question.";

/** The CLI's command (`/btw [question]`): the side chat's way in from the message box. */
export const BTW_COMMAND = "btw";
const BTW_RE = /^\/btw(?=\s|$)/i;

/**
 * A message box text that is the `/btw` command (a slash and `btw`, then white space or the end, after leading white
 * space): its question, trimmed ("" for a bare /btw), else null. Such a text is a side question and never a prompt.
 */
export function btwQuestion(text: string): string | null {
  const t = text.trimStart();
  return BTW_RE.test(t) ? t.slice(1 + BTW_COMMAND.length).trim() : null;
}

/** The control characters a side question never holds: Unicode's controls, but the line feed and the tab. */
const SIDE_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

/**
 * A side question as the server keeps it: line ends as line feeds, trimmed, 1 to 5,000 UTF-16 units, and no control
 * character but a line feed or a tab; null when the text is not one.
 */
export function sideQuestionText(raw: string): string | null {
  const t = raw.replace(/\r\n?/g, "\n").trim();
  return t && t.length <= SIDE_LIMITS.question && !SIDE_CONTROL.test(t) ? t : null;
}

/**
 * A refusal fallback's notice as the thread keeps it: trimmed and cut at 500, or SIDE_FALLBACK_ARN when it names a
 * provider's resource; null when there is none.
 */
export function sideFallback(content: unknown): string | null {
  if (typeof content !== "string") return null;
  const t = content.trim();
  if (!t) return null;
  return /(?<![A-Za-z0-9])arn:/i.test(t) ? SIDE_FALLBACK_ARN : capText(t, SIDE_LIMITS.fallback);
}

/** An exchange with the caps of SIDE_LIMITS applied (capEvent's rule). Idempotent. */
export function capSideExchange(x: SideExchange): SideExchange {
  const out: SideExchange = { ...x, question: capText(x.question, SIDE_LIMITS.question) };
  if (x.answer !== undefined) out.answer = capText(x.answer, SIDE_LIMITS.answer);
  if (x.fallback !== undefined) {
    const f = sideFallback(x.fallback);
    if (f === null) delete out.fallback;
    else out.fallback = f;
  }
  return out;
}

const isCount = (v: unknown, max: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max;

/**
 * One exchange as a record holds it (the side file's read check): every field of its type and cap, each state's own
 * fields only, and a clean copy that holds only those; null when it is not one.
 */
export function sideExchangeOf(v: unknown): SideExchange | null {
  if (!isObj(v)) return null;
  const id = get(v, "id");
  const question = get(v, "question");
  const at = get(v, "at");
  const state = get(v, "state");
  if (typeof id !== "string" || !UUID.test(id)) return null;
  if (typeof question !== "string" || sideQuestionText(question) !== question) return null;
  if (typeof at !== "string" || at.length > 40 || !Number.isFinite(Date.parse(at))) return null;
  if (typeof state !== "string" || !(SIDE_STATES as readonly string[]).includes(state)) return null;
  const out: SideExchange = { id, question, at, state: state as SideState };
  const answer = get(v, "answer");
  const synthetic = get(v, "synthetic");
  const fallback = get(v, "fallback");
  const retry = get(v, "retry");
  const error = get(v, "error");
  if (state === "answered") {
    if (typeof answer !== "string" || answer.length > SIDE_LIMITS.answer) return null;
    out.answer = answer;
    if (synthetic !== undefined && synthetic !== true) return null;
    if (synthetic === true) out.synthetic = true;
    if (fallback !== undefined) {
      if (typeof fallback !== "string" || sideFallback(fallback) !== fallback) return null;
      out.fallback = fallback;
    }
  } else if (answer !== undefined || synthetic !== undefined || fallback !== undefined) return null;
  if (retry !== undefined) {
    if (state !== "asking" || !isObj(retry)) return null;
    const attempt = get(retry, "attempt");
    const max = get(retry, "max");
    const delayMs = get(retry, "delayMs");
    if (!isCount(attempt, 1_000) || !isCount(max, 1_000) || !isCount(delayMs, 24 * 3_600_000)) return null;
    out.retry = { attempt, max, delayMs };
  }
  if (error !== undefined) {
    if (state !== "failed" || typeof error !== "string" || !(ERROR_CODES as readonly string[]).includes(error)) return null;
    out.error = error as ErrorCode;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Client to server

export interface HelloFrame {
  t: "hello";
  v: number;
  tab: string;
}
export interface PingFrame {
  t: "ping";
  n: number;
}
export interface AttachFrame {
  t: "attach";
  chat: string;
  /**
   * The highest `seq` the tab has drawn for this chat, 0 if none. 0 always gets a snapshot: the page asks for one when
   * the chat's history changed outside the ring (a D58 hold that ended).
   */
  since: number;
  /** The epoch of those events, or null. */
  epoch: string | null;
}
export interface DetachFrame {
  t: "detach";
  chat: string;
}
/**
 * Row 116: whether the chat is on screen on this page now: the page is visible, its route shows the chat's
 * conversation, the chat's newest history is drawn, and the view is at its end. A state report, not an action: no
 * `rid`, no `ack`, never a URL. The server takes it only for a chat that this socket has attached. `on` marks the
 * chat seen for every page, and while a page says `on` a turn that ends there is seen at once; the page says `off` at
 * each change away, and `on` again after each reattach is drawn. `background` (R131): the report is that background
 * session of the chat (its short id) on screen, by its line under the launch row (at least half of it in view) or by
 * its read-only view, not the chat's conversation: it marks that session's end seen, never the chat itself.
 */
export interface OnScreenFrame {
  t: "on_screen";
  chat: string;
  on: boolean;
  background?: string;
}
export interface NewChatFrame {
  t: "new_chat";
  rid: string;
  project: string;
  uuid: string;
  text: string;
  /** Only the user's own picks. */
  picks: Picks;
  /** Uploads made on the new-chat form (D50): the server adds their references to the first message. */
  uploads: string[];
  /**
   * The new-chat form's mention chips (D59): paths relative to the project's folder, checked and referenced as a
   * send's are (the first user event names them). Absent: none.
   */
  mentions?: string[];
}
export interface SendFrame {
  t: "send";
  rid: string;
  chat: string;
  /** The SDK message `uuid`; it equals `rid`. */
  uuid: string;
  text: string;
  /** The `rev` of the chat's draft that the message box showed, or null. */
  draftRev: number | null;
  /** The upload chips (D50): the server adds each one's reference (messageRef), at the end of the text. */
  uploads: string[];
  /**
   * The mention chips (9.3): paths relative to the chat's folder. The server checks each inside it and adds the
   * reference of its absolute path, as for an upload. Absent: none.
   */
  mentions?: string[];
}
export interface BashFrame {
  t: "bash";
  rid: string;
  chat: string;
  input: string;
  draftRev: number | null;
  /** The upload chips: in `!` mode each reference is the single-quoted path (D45, D50). */
  uploads: string[];
  /** The mention chips, referenced as the uploads are (the single-quoted absolute path). Absent: none. */
  mentions?: string[];
}
export interface AnswerFrame {
  t: "answer";
  rid: string;
  chat: string;
  card: string;
  answer: CardAnswer;
}
export interface InterruptFrame {
  t: "interrupt";
  rid: string;
  chat: string;
  /**
   * The `seq` of the turn's `turn_start`. 0 on a chat held as `finishing` (HOLD_KINDS), whose turn started under the
   * server before this one: Stop then ends that Claude Code.
   */
  turn: number;
}
export interface StopTaskFrame {
  t: "stop_task";
  rid: string;
  chat: string;
  task: string;
}
export interface BackgroundFrame {
  t: "background";
  rid: string;
  chat: string;
  toolUse: string;
}
export interface TakeBackFrame {
  t: "take_back";
  rid: string;
  chat: string;
  /** The queued message's uuid. */
  uuid: string;
}
export interface SetModelFrame {
  t: "set_model";
  rid: string;
  chat: string;
  /** A model row value; null: back to the user's default. */
  value: string | null;
}
export interface SetEffortFrame {
  t: "set_effort";
  rid: string;
  chat: string;
  value: EffortId | null;
}
export interface SetModeFrame {
  t: "set_mode";
  rid: string;
  chat: string;
  value: ModeId | null;
}
export interface ReconnectMcpFrame {
  t: "reconnect_mcp";
  rid: string;
  chat: string;
  server: string;
}
/** Exactly one of `alwaysAsk` and `enabled` (6.7, each once its check passes). */
export type SetConnectorFrame =
  | { t: "set_connector"; rid: string; chat: string; server: string; alwaysAsk: boolean }
  | { t: "set_connector"; rid: string; chat: string; server: string; enabled: boolean };
export interface ContinueSessionFrame {
  t: "continue_session";
  rid: string;
  project: string;
  session: string;
  /**
   * D58 Continue in a copy: the chat continues a fork of the session (a new session id), so the app that has the
   * session open keeps the original. Absent: false.
   */
  fork?: boolean;
}

/** D58: the app that has a Claude Code session open now (Claude Code's own registry of running sessions). */
export const OPEN_APPS = ["terminal", "desktop", "other"] as const;
export type OpenApp = (typeof OPEN_APPS)[number];
/** D58: a session that another process has open now; `busy` while that process says it is. */
export interface SessionOpen {
  app: OpenApp;
  busy: boolean;
  /**
   * Claude Code's registry says `waiting`: the session waits for an answer (a card). It counts as busy for D58's
   * rules, so `busy` is true too; the lists may say "Waiting for an answer" where they say busy. Absent: false.
   */
  waiting?: boolean;
}

/**
 * The holds that are kitespan's own, beside D58's (another app has the session open, by its `app`). The box is locked
 * as in D58's hold (row 80).
 * - `finishing`: the Claude Code of the server before a kill -9 or a crash still runs the turn that was running then;
 *   the line is "Claude Code is finishing the turn that was running when kitespan stopped."; Stop (an `interrupt` with
 *   `turn` 0) ends it; the hold ends when it exits, and the page reads the history again.
 * - `handed`: End it here and copy handed the session to the terminal; the line is "This chat's session was handed to
 *   your terminal."; it ends when Claude Code's registry shows the session open there (D58's hold then), after 10
 *   minutes, or on Send again.
 */
export const HOLD_KINDS = ["finishing", "handed"] as const;
export type HoldKind = (typeof HOLD_KINDS)[number];
export interface RenameFrame {
  t: "rename";
  rid: string;
  chat: string;
  /** Trimmed, 1 to 120 characters. */
  title: string;
}
/** D48: Archive (`on`), Stop and archive (`on` and `stop`) or Unarchive (`on` false). */
export interface ArchiveFrame {
  t: "archive";
  rid: string;
  chat: string;
  on: boolean;
  stop: boolean;
}
/** D48: the chat's process ends, kitespan removes the chat, and Claude Code's transcript is deleted. */
export interface DeleteFrame {
  t: "delete";
  rid: string;
  chat: string;
}
/** D49: the message box's draft. No `rid` and no `ack`: the server's `draft` frame to every viewer is the answer. */
export interface DraftEditFrame {
  t: "draft";
  chat: string;
  /**
   * FIX-U2: the side chat's box (DraftBox): its text in chat mode, with no chip, upload or mention. Absent: the
   * message box's.
   */
  box?: "side";
  text: string;
  mode: DraftMode;
  command: string | null;
  link: boolean;
  uploads: string[];
  /** Absent: none. */
  mentions?: string[];
}
/**
 * RD-8 Send again: start the chat for the messages that wait in it (restored after a restart, `notSent`), which go
 * first and in order. Ack `{started}`; the codes `session_held`, `archived`, `restarting`, `no_claude`, `not_found`.
 */
export interface SendQueuedFrame {
  t: "send_queued";
  rid: string;
  chat: string;
}
/**
 * Row 111 (CO-4) Send now, the terminal's Ctrl+Enter: every message of the chat that waits in Claude Code's queue
 * reaches Claude now, in send order. A Bash call or a subagent that runs in the foreground moves to the background
 * and Claude reads them in the same turn (`background`); else the turn stops as for Stop, keeping them, and they run
 * next (`interrupt`). `uuid`: the queued message that the press was on; once it waits no more (Claude took it in,
 * Take back), or after a press acted on what waits, nothing is done (`none`). Ack `{acted}`; the code `not_found`.
 */
export interface SendNowFrame {
  t: "send_now";
  rid: string;
  chat: string;
  uuid: string;
}
export const SEND_NOW_ACTS = ["background", "interrupt", "none"] as const;
export type SendNowAct = (typeof SEND_NOW_ACTS)[number];
/**
 * AR-5 End it here and copy (6.10): the chat's Claude Code ends at its first quiet moment, as for a chat that gives its
 * session up (row 78), so a turn is never cut, and the chat is held as `handed`. Ack `{ending: true}`, or `{ended:
 * true}` when it sleeps already; the codes `not_found`, `archived`, `restarting`.
 */
export interface EndHereFrame {
  t: "end_here";
  rid: string;
  chat: string;
}
/**
 * The buttons under a refused start's line (W4, W5; row 73): `again`, Make it again from its branch (the chat's own
 * worktree is gone: kitespan adds it again at its path from its branch); `project`, Continue in the project folder (the
 * chat runs in its project's folder from now on); `start`, Try again (`worktree_unverified`) and Continue without the
 * worktree (`worktree_resume_refused`, only as this explicit choice): the chat's Claude Code starts again. Nothing of
 * these happens by itself. Ack `{started}`; the codes `not_found`, `archived`, `restarting`, `stale` (no such refusal
 * now), `worktree_failed` (the worktree could not be made again), and a start's own.
 */
export const WORKTREE_ACTS = ["again", "project", "start"] as const;
export type WorktreeAct = (typeof WORKTREE_ACTS)[number];
export interface WorktreeFrame {
  t: "worktree";
  rid: string;
  chat: string;
  act: WorktreeAct;
}
/**
 * R124: a side question on the chat (its side thread is kitespan's own; nothing goes into the conversation). `id`: the
 * exchange's uuid, made by the page; Try again sends the same id with a new `rid`, and a resend of the id that runs
 * joins it. `text`: the question (sideQuestionText). Ack `{answered}`, or `{stopped: true}` after a Stop; the codes
 * `not_found`, `archived`, `restarting`, `busy` (another side question runs in the chat), `session_held`,
 * `bad_request`, `unsupported`, `failed`, and a start's own (`no_claude`, `env_unreadable`, the worktree codes).
 */
export interface SideQuestionFrame {
  t: "side_question";
  rid: string;
  chat: string;
  id: string;
  text: string;
  /**
   * FIX-U2: only on a question sent from the side box: the `rev` of the side box's draft that the box showed, or null.
   * The server clears that draft as a `send` clears the message box's (draftAfterSend) when it takes the question.
   * Absent (Try again, `/btw` in the message box): the side box's draft stays.
   */
  draftRev?: number | null;
}
/** R124: Stop on the side question `id`. Ack `{stopped}`: false when it had settled already. */
export interface SideStopFrame {
  t: "side_stop";
  rid: string;
  chat: string;
  id: string;
}
/** R124: Clear the chat's side thread. Ack null; `busy` while a side question runs. */
export interface SideClearFrame {
  t: "side_clear";
  rid: string;
  chat: string;
}
/**
 * R127: Trust this folder, from the confirm's own button only (a link only opens the confirm, DESIGN 5.2). `toolUse`:
 * the refused row; `path`: the folder its refusal names, which must equal the server's own match of that row. The
 * server starts Claude Code briefly in the folder with the SDK's trust attestation and no message. Ack `{trust}` (one of
 * TRUST_ANSWERS) for every request that passed the checks; the codes `not_found`, `archived`, `restarting`,
 * `bad_request`, `stale` (no refused row with that tool use and path), `busy` (a trust start runs for that folder),
 * `no_claude`, `unsupported` (the agent cannot), and `trust_refused` with its `reason`.
 */
export interface TrustFolderFrame {
  t: "trust_folder";
  rid: string;
  chat: string;
  toolUse: string;
  path: string;
}
/**
 * R131: Stop a background session that a launch row of this chat printed, from the Stop confirm's own button only (a
 * link only opens the confirm, DESIGN 5.2). `id`: the short id. The server checks its book, then runs `claude stop
 * <id>` once. Ack `{background}` (one of BG_STOP_ANSWERS); the codes `not_found`, `archived`, `restarting`,
 * `bad_request`, `stale` (no launch row of this chat printed that id), `busy` (a stop of that id runs), `no_claude` and
 * `unsupported` (no Claude Code with agent view).
 */
export interface BackgroundStopFrame {
  t: "background_stop";
  rid: string;
  chat: string;
  id: string;
}
export type GetFrame =
  | { t: "get"; rid: string; chat: string; what: Exclude<GetWhat, "history"> }
  /** One page of history: `before` is the cursor `more` of the last page, or null for the newest page. */
  | { t: "get"; rid: string; chat: string; what: "history"; before: string | null };

export type ClientFrame =
  | HelloFrame
  | PingFrame
  | AttachFrame
  | DetachFrame
  | NewChatFrame
  | SendFrame
  | BashFrame
  | AnswerFrame
  | InterruptFrame
  | StopTaskFrame
  | BackgroundFrame
  | TakeBackFrame
  | SetModelFrame
  | SetEffortFrame
  | SetModeFrame
  | ReconnectMcpFrame
  | SetConnectorFrame
  | ContinueSessionFrame
  | RenameFrame
  | ArchiveFrame
  | DeleteFrame
  | DraftEditFrame
  | GetFrame
  | SendQueuedFrame
  | EndHereFrame
  | WorktreeFrame
  | SendNowFrame
  | OnScreenFrame
  | SideQuestionFrame
  | SideStopFrame
  | SideClearFrame
  | TrustFolderFrame
  | BackgroundStopFrame;

export type ClientFrameType = ClientFrame["t"];
export type ClientFrameOf<T extends ClientFrameType> = Extract<ClientFrame, { t: T }>;

/** Every client frame that carries a `rid` and gets exactly one `ack` (all but hello, ping, attach, detach, draft, on_screen). */
export type RequestFrame = Extract<ClientFrame, { rid: string }>;
export type RequestType = RequestFrame["t"];

export const CLIENT_FRAME_TYPES = [
  "hello", "ping", "attach", "detach", "new_chat", "send", "bash", "answer", "interrupt", "stop_task", "background",
  "take_back", "set_model", "set_effort", "set_mode", "reconnect_mcp", "set_connector", "continue_session", "rename",
  "archive", "delete", "draft", "get", "send_queued", "end_here", "worktree", "send_now", "on_screen", "side_question",
  "side_stop", "side_clear", "trust_folder", "background_stop",
] as const satisfies readonly ClientFrameType[];

export const REQUEST_TYPES = [
  "new_chat", "send", "bash", "answer", "interrupt", "stop_task", "background", "take_back", "set_model", "set_effort",
  "set_mode", "reconnect_mcp", "set_connector", "continue_session", "rename", "archive", "delete", "get", "send_queued",
  "end_here", "worktree", "send_now", "side_question", "side_stop", "side_clear", "trust_folder", "background_stop",
] as const satisfies readonly RequestType[];

export function isRequestFrame(f: ClientFrame): f is RequestFrame {
  return "rid" in f;
}

/** A `get` changes nothing, so its ack is not kept in the ack store: a resent `get` reads again (4.3). */
export function ackIsStored(t: RequestType): boolean {
  return t !== "get";
}

// ---------------------------------------------------------------------------------------------------------------
// Server to client

export interface ClaudeStatus {
  ok: boolean;
  version: string | null;
  /** One line when the version differs from the one the pinned SDK names (4.10), else null. */
  drift: string | null;
  /** Below kitespan's minimum Claude Code version (rows 118, 119). Absent or null: not below, or not readable. */
  belowMinimum?: ClaudeBelow | null;
}

/** A Claude Code older than kitespan's minimum (rows 118 (3), 119), compared on its first three numbers. */
export interface ClaudeBelow {
  /** The version as the CLI prints it, up to a space or a parenthesis ("2.1.250", "2.1.250-acme.2"). */
  version: string;
  /** kitespan's minimum ("2.1.296"). */
  minimum: string;
  /** Claude Code's own build: exactly three numbers. A company's own build (anything after them) is false. */
  stock: boolean;
}

/**
 * The minimum version's line (rows 118, 119), the same in Settings > Claude Code, the new-chat form and the start
 * output. A stock build gets the command, which the page draws as a code span; a company's own build gets no command,
 * because its update is the company's. kitespan never runs the command itself.
 */
export const CLAUDE_MINIMUM_WORDS = {
  lead: (b: ClaudeBelow) => `Claude Code ${b.version} runs here; kitespan supports ${b.minimum} and later.`,
  command: "claude update",
  company: "Update it the way your company provides it.",
  /** The whole line as plain text (the terminal's). */
  plain: (b: ClaudeBelow) => `${CLAUDE_MINIMUM_WORDS.lead(b)} ${b.stock ? `Run ${CLAUDE_MINIMUM_WORDS.command}.` : CLAUDE_MINIMUM_WORDS.company}`,
} as const;

/**
 * About's update line (4.10): `available`, origin has a commit that this checkout lacks ("Update available", with
 * Update, row 108); `apply`, the build on disk is the checkout's and not the running server's (Restart to apply);
 * `unfinished`, the checkout moved and the build did not ("The update did not finish.", with Update);
 * `diverged`, this checkout and origin have diverged; `none`, no line.
 */
export const UPDATE_KINDS = ["none", "available", "apply", "unfinished", "diverged"] as const;
export type UpdateKind = (typeof UPDATE_KINDS)[number];

export interface WelcomeFrame {
  t: "welcome";
  epoch: string;
  /** kitespan's own version. */
  version: string;
  v: number;
  claude: ClaudeStatus;
  /** `available` is true when `kind` is `available`. An absent `kind` reads as `none`. */
  update: { available: boolean; kind?: UpdateKind };
  auth: "none" | "token";
  /**
   * The machine's own name (D54): its hostname's first label, at most 63 characters, read by the server at run time,
   * so the page names the machine by it and never by the browser's address; null when the system gives no name that
   * can be shown. The server always sends it; it is optional only so that a frame made without it still reads.
   */
  host?: string | null;
  /**
   * What this server's agent can do that the page shows a way into only when it can: `sideQuestions`, the side chat
   * (R124). The server always sends it; it is optional only so that a frame made without it still reads (absent: no
   * side chat). `trustFolder` (R127): the agent can start Claude Code with the trust attestation, so a refused folder's
   * line offers Trust this folder; false or absent: the line offers Open in terminal instead.
   */
  capabilities?: { sideQuestions: boolean; trustFolder?: boolean };
}

/** A row of the chat list (`chats`). */
export interface ChatRow {
  chat: string;
  title: string | null;
  project: string;
  state: ChatState;
  /** A card waits. */
  needsYou: boolean;
  /** ISO 8601 UTC. */
  lastActivity: string;
  /** D48: the chat shows only under the Archived row. */
  archived: boolean;
  /**
   * D48: a turn runs (or the chat's start does), a card waits, or a background task that is not ambient runs, so the
   * row's Archive reads "Stop and archive" (an `archive` without `stop` gets `busy`). The server always sends it; it is
   * optional only so that a row made without it still reads (absent counts as false).
   */
  busy?: boolean;
  /**
   * Row 78: another process has this chat's session open now, so kitespan has given the session up (its own turn ends
   * first, then its process): the chat's box shows one line in place of Send, with Continue in a copy of `session`.
   * Absent from a row when no other process has it; a delta takes it away with null, and the chat's pages then read
   * its history again. kitespan's own holds come here too, with their `kind`.
   */
  held?: ChatHold | null;
  /**
   * W5, D58: the chat's Claude Code session id (the ledger's), so a page that never saw the chat's `session` event (a
   * reload, a second device, a restart) can fork it (Continue in a copy) and name it. Only once the session's
   * transcript is known to exist (a first start that failed before Claude Code's init wrote none); absent before that.
   * A delta carries it when it changes, and null when it goes.
   */
  session?: string | null;
  /**
   * Row 73 (W3, W6): the chat runs in a git worktree of its project's folder: kitespan's own (W3), or the linked
   * worktree that a terminal session ran in (Continue here, W12). Absent from a chat in its project's folder; a delta
   * takes it away with null (Continue in the project folder).
   */
  worktree?: ChatWorktree | null;
  /**
   * Row 116: the chat's last turn ended (`done`), or ended in an error or with Claude Code's exit by itself
   * (`failed`), and no page has had the chat on screen since (`on_screen`). One state for every device (D49), kept
   * over a restart. Absent from a row whose last end is seen; a delta sets it, and takes it away with null.
   */
  unseen?: Unseen | null;
  /**
   * R131: the chat's background sessions (those its own launch rows printed), for its dot: `needs_input` while one
   * needs input; else `failed` while one failed and no page had that session's line or view on screen since; else
   * `done` while one completed so. Not `needsYou` (a card waits), so the Needs input filter keeps its meaning. In
   * memory only. Absent when none; a delta sets it, and takes it away with null.
   */
  background?: BgRowState | null;
}

/** A chat's worktree, as the chat list shows it (W6). */
export interface ChatWorktree {
  /** The worktree's real path: the chat's folder. */
  path: string;
  /** Its branch now: kitespan's, refreshed from Claude Code's session info, since Claude can switch it; null: unknown. */
  branch: string | null;
  /** L25: Archive kept it on disk because it had changes; the archived chat says so. */
  kept: boolean;
}

/** Row 78: the app that has a chat's session open now, and that session's id (Continue in a copy forks it). */
export interface ChatHold {
  app: OpenApp;
  session: string;
  /**
   * One of kitespan's own holds (HOLD_KINDS), whose line replaces D58's; `app` is then `other` for `finishing` and
   * `terminal` for `handed`. Absent: D58's hold.
   */
  kind?: HoldKind;
}

/** A change of one chat: its id and the changed fields (a new chat sends them all), or `{chat, gone: true}` (D48). */
export type ChatDelta = ({ chat: string } & Partial<Omit<ChatRow, "chat">>) | { chat: string; gone: true };

/** The whole list after `welcome`; then one delta per change. */
export type ChatsFrame = { t: "chats"; list: ChatRow[] } | { t: "chats"; delta: ChatDelta };

export interface PongFrame {
  t: "pong";
  n: number;
}

export interface AttachedFrame {
  t: "attached";
  chat: string;
  epoch: string;
  state: ChatState;
  /** The chat's last `seq`. */
  seq: number;
  /** Every open card, authoritative: a replayed `card_open` not in this list is history. */
  cards: Card[];
  picks: Picks;
  title: ChatTitle | null;
  /** The chat's draft (D49). */
  draft: DraftState;
  /**
   * FIX-U2: the side chat's box's draft (DraftBox `side`). The server always sends it; it is optional only so that a
   * frame made without it still reads (the page then keeps the side draft it has).
   */
  sideDraft?: DraftState;
  archived: boolean;
  /**
   * R127: the state of each folder that a refused row of this chat names and that has one on this server now (a trust
   * start runs, or answered since the last live refusal of it), by the folder's path; absent when none has.
   */
  trust?: Record<string, TrustState>;
  /**
   * R131: the state of each background session that a launch row of this chat printed and that has one now, by its
   * short id; absent when none has.
   */
  background?: Record<string, BgWorker>;
  /**
   * `events`: the missed `ev` frames follow (the attach's `since` was in the ring of this epoch), with no snapshot;
   * `none`: nothing was missed; `snapshot`: a `snapshot` follows.
   */
  replay: "events" | "snapshot" | "none";
  /** With `events` or `none`: the `seq` that the replayed `ev` frames follow (the attach's `since`). */
  cursor?: number;
}

export interface EvFrame {
  t: "ev";
  chat: string;
  seq: number;
  e: ChatEvent;
}

export interface SnapshotFrame {
  t: "snapshot";
  chat: string;
  /** The `ev` frames that follow have higher numbers. */
  seq: number;
  /**
   * How many `ev` frames follow it before the live ones, all at or below `attached.seq`. The tail leaves out what the
   * history page holds, so after the last of them the page's cursor is `attached.seq`. The server always sends it; it
   * is optional only so that a frame made without it still reads (the page then waits for an `ev` at `attached.seq`).
   */
  tail?: number;
  /** The newest page of Claude Code's own transcript, at most 256 KiB of JSON. */
  history: ChatEvent[];
  /** The cursor of the next older page, or null. */
  more: string | null;
}

/**
 * D49: to every socket attached to the chat, the sender included, at each change. Never in the ring buffer. `box:
 * "side"` (FIX-U2): the side chat's box's draft; absent: the message box's.
 */
export type DraftFrame = { t: "draft"; chat: string; box?: "side" } & DraftState;

/** What `get` returns, by `what`. */
export interface GetResults {
  context: ContextInfo | null;
  connectors: ConnectorInfo[];
  commands: CommandInfo[];
  models: ModelInfo[];
  history: { history: ChatEvent[]; more: string | null };
  /** R124: the chat's side thread, at most 256 KiB of JSON (the oldest exchanges left out of a larger one). */
  side: SideRead;
}

/** The `result` of a successful `ack`, by request type (null: nothing to return). */
export interface AckResults {
  new_chat: { chat: string };
  /** `queued`: the chat's start waits for a free slot (the cap, D3). */
  send: { queued: boolean };
  bash: null;
  answer: null;
  /** The uuids of queued messages that will still run, or null when the CLI sends no receipt. */
  interrupt: { stillQueued: string[] | null };
  stop_task: null;
  /** false: no foreground task had that tool use. */
  background: { backgrounded: boolean };
  /** false: Claude Code had already started on it, and the bubble stays. */
  take_back: { cancelled: boolean };
  set_model: null;
  set_effort: null;
  set_mode: null;
  reconnect_mcp: null;
  set_connector: { warning: string | null };
  /** A new chat, or the chat that already has that session (D49). */
  continue_session: { chat: string };
  rename: null;
  archive: null;
  delete: null;
  get: GetResults[GetWhat];
  /** false: nothing waited in the chat. */
  send_queued: { started: boolean };
  /** `ended`: the chat's Claude Code was not running. */
  end_here: { ending: true } | { ended: true };
  /** false: nothing started (Make it again, Continue in the project folder; or a start that waits). */
  worktree: { started: boolean };
  /** What the press did: moved the foreground work to the background, stopped the turn, or nothing. */
  send_now: { acted: SendNowAct };
  /** The answered exchange, or `stopped` when a Stop ended it (the exchange left the thread). */
  side_question: { answered: SideExchange } | { stopped: true };
  /** false: the side question had settled already. */
  side_stop: { stopped: boolean };
  side_clear: null;
  /** R127: how the trust start (or the check before it) answered. */
  trust_folder: { trust: TrustAnswer };
  /** R131: what `claude stop <id>` answered. */
  background_stop: { background: BgStopAnswer };
}

export type AckFrame =
  | { t: "ack"; rid: string; ok: true; result: unknown }
  | { t: "ack"; rid: string; ok: false; error: AckError };

/**
 * The buttons that a notice may offer: the drain notice's Cancel restart and Restart now (4.10), and Update on the
 * notice of an update that origin has (row 108: it opens /settings/about/update, whose button acts).
 */
export const NOTICE_ACTIONS = ["cancel_restart", "restart_now", "update"] as const;
/**
 * The `id` of the notice that every page gets when an asked restart did not happen (4.10 step 7, S13: the successor
 * could not start, or the health gate failed), so the page that asked shows its ask as not done.
 */
export const RESTART_FAILED_NOTICE = "restart_failed";
/**
 * The `id` of the restart's own notice on every page: the drain's line with Cancel restart and Restart now while it
 * waits, then from the close to the `bye` "Restarting kitespan..." with no buttons. `gone` for it is Cancel restart only.
 */
export const RESTART_NOTICE = "restart";
/**
 * The `id` of the update's notice on every page (row 108, 4.10): the step line while an update runs, the line of one
 * that did not finish, Restart to apply, or origin's line ("Update available." with Update); a later one replaces it.
 */
export const UPDATE_NOTICE = "update";
export type NoticeAction = (typeof NOTICE_ACTIONS)[number];

export interface NoticeFrame {
  t: "notice";
  text: string;
  chat?: string;
  /**
   * A notice that may change or go (the drain notice, the update line): a later notice with the same `id` replaces it
   * on every page, and one with `gone: true` takes it away (its `text` is then empty).
   */
  id?: string;
  actions?: NoticeAction[];
  gone?: true;
}

export interface ByeFrame {
  t: "bye";
  reason: "restart" | "shutdown";
}

/**
 * Row 99: the project table changed (an environment added, renamed, moved or removed), to every page: it reads GET
 * /api/projects again. `removed`: that environment is being removed, before its chats' `gone`, so a page on it or on
 * one of its chats goes to / with no line, and its chats leave the lists at once.
 */
export interface ProjectsFrame {
  t: "projects";
  removed?: string;
}

export type ServerFrame =
  | WelcomeFrame
  | ChatsFrame
  | PongFrame
  | AttachedFrame
  | EvFrame
  | SnapshotFrame
  | DraftFrame
  | AckFrame
  | NoticeFrame
  | ByeFrame
  | ProjectsFrame;

export function ackOk<T extends RequestType>(rid: string, result: AckResults[T]): AckFrame {
  return { t: "ack", rid, ok: true, result };
}

export function ackFail(rid: string, code: ErrorCode, reason?: WorktreeOff | TrustRefusal): AckFrame {
  return { t: "ack", rid, ok: false, error: ackError(code, reason) };
}

// ---------------------------------------------------------------------------------------------------------------
// The Terminal pane's socket, /ws/shell (D38, D52)
//
// The shell belongs to the chat: every page that opens the pane attaches to the same shell. Output goes out as
// binary frames (the PTY's bytes as they come); keys come in as binary frames (UTF-8), written once each. Control
// frames are JSON text. The first frame on a new socket is `open`; the server answers `opened`, then sends the replay
// ring (at most 256 KiB) as binary frames, then live output. A socket that falls more than 1 MiB behind gets `reset`
// and the ring again.

export const SHELL_LIMITS = {
  ringBytes: 256 * 1024,
  lagBytes: 1024 * 1024,
  /** One binary input frame; the page splits a longer paste. */
  inputFrameBytes: 64 * 1024,
  maxCols: 1000,
  maxRows: 500,
} as const;

export type ShellClientFrame =
  | { t: "open"; chat: string; cols: number; rows: number }
  | { t: "resize"; cols: number; rows: number }
  /** Type the chat's own command at the prompt (the resume command, or the fork command while it is open), never Enter. */
  | { t: "type_resume" }
  /**
   * R127, Open in terminal on a refused folder's line: type `cd <folder> && claude` at the prompt, never Enter, so
   * Claude Code asks its own trust question. `toolUse` names the refused row; the server takes the folder from its own
   * match of that row, never from the page.
   */
  | { t: "type_trust"; toolUse: string }
  /**
   * R131, Open in terminal for a background session: type `claude attach <id>` at the prompt, never Enter, so the user
   * answers its prompts in Claude Code's own UI. `id` is the short id that a launch row of the chat printed; the server
   * types it only for an id in the chat's book.
   */
  | { t: "type_attach"; id: string };

/**
 * The answer to `type_resume`, `type_trust` and `type_attach` (one per request; the pane shows its line from it):
 * `plain` or `fork`, the resume command is at the prompt; `trust` (R127), `cd <folder> && claude` is; `attach` (R131),
 * `claude attach <id>` is; `none`, nothing to type (no message yet, no refused row of that tool use, no background
 * session of that id in the chat); `busy`, nothing typed because the prompt is not free.
 */
export const SHELL_TYPED_CASES = ["plain", "fork", "none", "busy", "trust", "attach"] as const;
export type ShellTypedCase = (typeof SHELL_TYPED_CASES)[number];
export interface ShellTypedFrame {
  t: "typed";
  case: ShellTypedCase;
}

export const SHELL_ERROR_CODES = ["bad_request", "not_found", "archived", "no_shell"] as const;
export type ShellErrorCode = (typeof SHELL_ERROR_CODES)[number];

export type ShellServerFrame =
  /** `fresh`: this open started the chat's shell; false: the page joined a running shell and the ring follows. */
  | { t: "opened"; chat: string; cols: number; rows: number; fresh: boolean }
  /** The PTY's size changed (another page resized it). */
  | { t: "size"; cols: number; rows: number }
  /** The page clears its terminal; the ring follows as binary frames. */
  | { t: "reset" }
  /** The shell exited; an `open` starts a new one. */
  | { t: "exit"; code: number | null; signal: string | null }
  | { t: "error"; code: ShellErrorCode; message: string };

// ---------------------------------------------------------------------------------------------------------------
// Parsing incoming frames

export type ParseResult<F> =
  | { ok: true; frame: F }
  /** `rid`: the frame's request id when it had a valid one, so the server can answer `bad_request` to it. */
  | { ok: false; rid: string | null; reason: string };

/**
 * The characters a short label never holds: the C0 and C1 controls, DEL, the bidirectional marks, embeddings,
 * overrides and isolates (U+061C, U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069), and the line and paragraph
 * separators. A title or a name with one could read differently on screen from what Save acts on.
 */
export const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

class FrameError extends Error {}

type Obj = Record<string, unknown>;

function fail(reason: string): never {
  throw new FrameError(reason);
}

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function get(o: Obj, k: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
}

function str(o: Obj, k: string, max: number): string {
  const v = get(o, k);
  if (typeof v !== "string") fail(`${k}: not a string`);
  if (v.length > max) fail(`${k}: too long`);
  return v;
}

/** A short label: no control characters, not blank. */
function label(o: Obj, k: string, max: number): string {
  const v = str(o, k, max);
  if (!v.trim() || CONTROL_CHARS.test(v)) fail(`${k}: not a label`);
  return v;
}

function nullableLabel(o: Obj, k: string, max: number): string | null {
  return get(o, k) === null ? null : label(o, k, max);
}

function matching(o: Obj, k: string, re: RegExp): string {
  const v = get(o, k);
  if (typeof v !== "string" || !re.test(v)) fail(`${k}: bad id`);
  return v;
}

function int(o: Obj, k: string, min: number, max: number): number {
  const v = get(o, k);
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) fail(`${k}: not an integer in range`);
  return v;
}

function bool(o: Obj, k: string): boolean {
  const v = get(o, k);
  if (typeof v !== "boolean") fail(`${k}: not a boolean`);
  return v;
}

function oneOf<T extends string>(o: Obj, k: string, values: readonly T[]): T {
  const v = get(o, k);
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) fail(`${k}: not an allowed value`);
  return v as T;
}

function nullableOneOf<T extends string>(o: Obj, k: string, values: readonly T[]): T | null {
  return get(o, k) === null ? null : oneOf(o, k, values);
}

/** An absent or null draftRev is null. */
function draftRev(o: Obj): number | null {
  const v = get(o, "draftRev");
  return v === undefined || v === null ? null : int(o, "draftRev", 0, Number.MAX_SAFE_INTEGER);
}

/** Upload ids: absent is none; each must be an upload id; repeats are dropped, the order kept. */
function uploads(o: Obj, max: number): string[] {
  const v = get(o, "uploads");
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > max) fail("uploads: not a list of upload ids");
  const out: string[] = [];
  for (const id of v) {
    if (typeof id !== "string" || !UPLOAD_ID.test(id)) fail("uploads: bad id");
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * A path relative to the chat's folder: not empty, at most 1,024 characters, no leading slash, no empty, `.` or `..`
 * segment, no control character. The download route, the file route of the URL scheme and the mentions use it.
 */
export function isSafeRelativePath(p: string): boolean {
  if (!p || p.length > 1024 || p.startsWith("/") || CONTROL_CHARS.test(p)) return false;
  return p.split("/").every((s) => s.length > 0 && s !== "." && s !== "..");
}

/**
 * The mention chips (9.3) of a frame or a draft record: absent (undefined) is none; else a list of at most `max` paths
 * relative to the chat's folder, each passing `isSafeRelativePath`, with repeats dropped and the order kept. null: not
 * such a list. The server's draft record reader uses it too, so an old record with no `mentions` reads as none.
 */
export function mentionsOf(v: unknown, max: number = LIMITS.draftMentions): string[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > max) return null;
  const seen = new Set<string>();
  for (const p of v) {
    if (typeof p !== "string" || !isSafeRelativePath(p)) return null;
    seen.add(p);
  }
  return [...seen];
}

/**
 * The `mentions` key of a `user` event (9.3): the list as mentionsOf reads it (at most LIMITS.sendMentions paths),
 * also an empty one (sent with no chips). Absent, or any value that is not such a list, is no key, so the message reads
 * as one with no record. The server's capEvent and the page's reducer both use it.
 */
export function userMentions(v: unknown): { mentions?: string[] } {
  const list = Array.isArray(v) ? mentionsOf(v, LIMITS.sendMentions) : null;
  return list ? { mentions: list } : {};
}

/** The `mentions` key of a frame: only when it names some. */
function mentions(o: Obj, max: number): { mentions?: string[] } {
  const list = mentionsOf(get(o, "mentions"), max);
  if (list === null) fail(`mentions: not a list of at most ${max} paths relative to the chat's folder`);
  return list.length ? { mentions: list } : {};
}

const MAX_INT = Number.MAX_SAFE_INTEGER;

function picks(o: Obj): Picks {
  const v = get(o, "picks");
  if (v === undefined) return { model: null, effort: null, mode: null };
  if (!isObj(v)) fail("picks: not an object");
  const opt = <T>(k: string, read: () => T): T | null => (get(v, k) === undefined || get(v, k) === null ? null : read());
  return {
    model: opt("model", () => label(v, "model", LIMITS.name)),
    effort: opt("effort", () => oneOf(v, "effort", EFFORT_IDS)),
    mode: opt("mode", () => oneOf(v, "mode", MODE_IDS)),
  };
}

/** The base fields of a request frame. */
function request(o: Obj): { rid: string } {
  return { rid: matching(o, "rid", UUID) };
}

function chatRequest(o: Obj): { rid: string; chat: string } {
  return { rid: matching(o, "rid", UUID), chat: matching(o, "chat", CHAT_ID) };
}

function elicitationContent(v: unknown): Record<string, ElicitationValue> {
  if (!isObj(v)) fail("answer.content: not an object");
  const entries: [string, ElicitationValue][] = [];
  const keys = Object.keys(v);
  if (keys.length > 100) fail("answer.content: too many fields");
  for (const k of keys) {
    const x = v[k];
    if (k.length > LIMITS.name) fail("answer.content: key too long");
    if (typeof x === "string" || typeof x === "boolean" || (typeof x === "number" && Number.isFinite(x))) entries.push([k, x]);
    else if (Array.isArray(x) && x.length <= 100 && x.every((s) => typeof s === "string")) entries.push([k, [...(x as string[])]]);
    else fail("answer.content: bad value");
  }
  return Object.fromEntries(entries);
}

/** Check a card answer's shape (4.2). Whether it fits the card that waits is the registry's check. */
export function parseCardAnswer(v: unknown): CardAnswer {
  if (!isObj(v)) fail("answer: not an object");
  const kind = get(v, "kind");
  switch (kind) {
    case "permission": {
      if (get(v, "allow") === true) return { kind, allow: true, scope: oneOf(v, "scope", ["once", "session"] as const) };
      if (get(v, "allow") === false) return { kind, allow: false, message: str(v, "message", WIRE.maxPayloadBytes) };
      return fail("answer.allow: not a boolean");
    }
    case "question": {
      const a = get(v, "answers");
      if (!isObj(a)) fail("answer.answers: not an object");
      const keys = Object.keys(a);
      if (keys.length === 0 || keys.length > 16) fail("answer.answers: bad count");
      const entries: [string, string][] = [];
      for (const k of keys) {
        const x = a[k];
        if (typeof x !== "string") fail("answer.answers: not a string");
        entries.push([k, x]);
      }
      return { kind, answers: Object.fromEntries(entries) };
    }
    case "plan": {
      if (get(v, "approve") === true) return { kind, approve: true, mode: oneOf(v, "mode", PLAN_MODES) };
      if (get(v, "approve") === false) return { kind, approve: false, feedback: str(v, "feedback", WIRE.maxPayloadBytes) };
      return fail("answer.approve: not a boolean");
    }
    case "elicitation": {
      const action = oneOf(v, "action", ["accept", "decline", "cancel"] as const);
      if (action !== "accept") return { kind, action };
      const content = get(v, "content");
      return content === undefined ? { kind, action } : { kind, action, content: elicitationContent(content) };
    }
    case "dialog": {
      const behavior = oneOf(v, "behavior", ["completed", "cancelled"] as const);
      if (behavior === "cancelled") return { kind, behavior };
      if (!Object.prototype.hasOwnProperty.call(v, "result")) fail("answer.result: missing");
      return { kind, behavior, result: structuredJson(get(v, "result")) };
    }
    default:
      return fail("answer.kind: not a card kind");
  }
}

/** A copy of a JSON value (the frame came from JSON.parse, so it is plain JSON already). */
function structuredJson(v: unknown): unknown {
  return v === undefined ? null : JSON.parse(JSON.stringify(v));
}

function parseObj(o: Obj): ClientFrame {
  const t = get(o, "t");
  switch (t) {
    case "hello":
      return { t, v: int(o, "v", 1, 1_000_000), tab: matching(o, "tab", TAB_ID) };
    case "ping":
      return { t, n: int(o, "n", 0, MAX_INT) };
    case "attach": {
      const epoch = get(o, "epoch");
      return {
        t,
        chat: matching(o, "chat", CHAT_ID),
        since: int(o, "since", 0, MAX_INT),
        epoch: epoch === null || epoch === undefined ? null : matching(o, "epoch", EPOCH),
      };
    }
    case "detach":
      return { t, chat: matching(o, "chat", CHAT_ID) };
    case "on_screen":
      // R131: `background` names the view of one background session of the chat (its short id).
      return { t, chat: matching(o, "chat", CHAT_ID), on: bool(o, "on"), ...(get(o, "background") === undefined ? {} : { background: matching(o, "background", BG_ID) }) };
    case "new_chat": {
      const f: NewChatFrame = {
        t,
        ...request(o),
        project: matching(o, "project", PROJECT_ID),
        uuid: matching(o, "uuid", UUID),
        text: str(o, "text", WIRE.maxPayloadBytes),
        picks: picks(o),
        uploads: uploads(o, LIMITS.sendUploads),
        ...mentions(o, LIMITS.sendMentions),
      };
      if (!f.text.trim() && f.uploads.length === 0 && !f.mentions) fail("text: empty");
      return f;
    }
    case "send": {
      const f: SendFrame = {
        t,
        ...chatRequest(o),
        uuid: matching(o, "uuid", UUID),
        text: str(o, "text", WIRE.maxPayloadBytes),
        draftRev: draftRev(o),
        uploads: uploads(o, LIMITS.sendUploads),
        ...mentions(o, LIMITS.sendMentions),
      };
      if (f.uuid !== f.rid) fail("uuid: differs from rid");
      if (!f.text.trim() && f.uploads.length === 0 && !f.mentions) fail("text: empty");
      return f;
    }
    case "bash": {
      const f: BashFrame = {
        t,
        ...chatRequest(o),
        input: str(o, "input", LIMITS.bashInput),
        draftRev: draftRev(o),
        uploads: uploads(o, LIMITS.sendUploads),
        ...mentions(o, LIMITS.sendMentions),
      };
      if (!f.input.trim()) fail("input: empty");
      return f;
    }
    case "answer":
      return { t, ...chatRequest(o), card: matching(o, "card", AGENT_REF), answer: parseCardAnswer(get(o, "answer")) };
    case "interrupt":
      return { t, ...chatRequest(o), turn: int(o, "turn", 0, MAX_INT) };
    case "stop_task":
      return { t, ...chatRequest(o), task: matching(o, "task", AGENT_REF) };
    case "background":
      return { t, ...chatRequest(o), toolUse: matching(o, "toolUse", AGENT_REF) };
    case "take_back":
    case "send_now":
      return { t, ...chatRequest(o), uuid: matching(o, "uuid", UUID) };
    case "set_model":
      return { t, ...chatRequest(o), value: nullableLabel(o, "value", LIMITS.name) };
    case "set_effort":
      return { t, ...chatRequest(o), value: nullableOneOf(o, "value", EFFORT_IDS) };
    case "set_mode":
      return { t, ...chatRequest(o), value: nullableOneOf(o, "value", MODE_IDS) };
    case "reconnect_mcp":
      return { t, ...chatRequest(o), server: label(o, "server", LIMITS.name) };
    case "set_connector": {
      const base = { t, ...chatRequest(o), server: label(o, "server", LIMITS.name) };
      const hasAsk = get(o, "alwaysAsk") !== undefined;
      const hasEnabled = get(o, "enabled") !== undefined;
      if (hasAsk === hasEnabled) fail("set_connector: needs exactly one of alwaysAsk and enabled");
      return hasAsk ? { ...base, alwaysAsk: bool(o, "alwaysAsk") } : { ...base, enabled: bool(o, "enabled") };
    }
    case "continue_session": {
      const fork = get(o, "fork") === undefined ? {} : { fork: bool(o, "fork") };
      return { t, ...request(o), project: matching(o, "project", PROJECT_ID), session: matching(o, "session", UUID), ...fork };
    }
    case "rename": {
      const raw = str(o, "title", WIRE.maxPayloadBytes);
      const title = raw.trim();
      if (!title || title.length > LIMITS.title || CONTROL_CHARS.test(title)) fail("title: not a title");
      return { t, ...chatRequest(o), title };
    }
    case "archive": {
      const f: ArchiveFrame = { t, ...chatRequest(o), on: bool(o, "on"), stop: get(o, "stop") === undefined ? false : bool(o, "stop") };
      if (f.stop && !f.on) fail("stop: only with on");
      return f;
    }
    case "delete":
    case "send_queued":
    case "end_here":
    case "side_clear":
      return { t, ...chatRequest(o) };
    case "side_question": {
      const text = sideQuestionText(str(o, "text", WIRE.maxPayloadBytes));
      if (text === null) fail("text: not a side question (1 to 5,000 characters, no control character but a line feed or a tab)");
      // FIX-U2: the key only on a question from the side box (null or a rev); absent, the side box's draft stays.
      const fromBox = get(o, "draftRev") === undefined ? {} : { draftRev: draftRev(o) };
      return { t, ...chatRequest(o), id: matching(o, "id", UUID), text, ...fromBox };
    }
    case "side_stop":
      return { t, ...chatRequest(o), id: matching(o, "id", UUID) };
    case "trust_folder":
      // R127: the path's own rules (absolute, its bytes, no control character) are the server's checks, after it found
      // the row (so a path that is too long gets its own answer); here only its type and an outer cap.
      return { t, ...chatRequest(o), toolUse: matching(o, "toolUse", AGENT_REF), path: str(o, "path", TRUST_LIMITS.pathChars) };
    case "background_stop":
      // R131: the short id only; whether a launch row of the chat printed it is the server's check.
      return { t, ...chatRequest(o), id: matching(o, "id", BG_ID) };
    case "worktree":
      return { t, ...chatRequest(o), act: oneOf(o, "act", WORKTREE_ACTS) };
    case "draft": {
      const mode = oneOf(o, "mode", DRAFT_MODES);
      const command = get(o, "command") === null || get(o, "command") === undefined ? null : label(o, "command", LIMITS.draftCommand);
      if (command !== null && mode !== "slash") fail("command: only in slash mode");
      // FIX-U2: `box: "side"` is the side chat's box, whose draft is plain text; no `box` is the message box's.
      const side = get(o, "box") === undefined ? {} : { box: oneOf(o, "box", ["side"] as const) };
      const f: DraftEditFrame = {
        t,
        chat: matching(o, "chat", CHAT_ID),
        ...side,
        text: str(o, "text", WIRE.maxPayloadBytes),
        mode,
        command,
        link: bool(o, "link"),
        uploads: uploads(o, LIMITS.draftUploads),
        ...mentions(o, LIMITS.draftMentions),
      };
      if (f.box === "side" && (f.mode !== "chat" || f.uploads.length > 0 || f.mentions)) fail("box: the side box's draft is plain text, with no chip, upload or mention");
      return f;
    }
    case "get": {
      const base = { t, ...chatRequest(o) };
      const what = oneOf(o, "what", GET_WHAT);
      if (what !== "history") return { ...base, what };
      const before = get(o, "before");
      return { ...base, what, before: before === undefined || before === null ? null : label(o, "before", LIMITS.cursor) };
    }
    default:
      return fail("t: not a client frame");
  }
}

/**
 * Read one frame from a page. `raw` is the socket message (a string; a binary message is refused) or an already
 * parsed value. Never throws.
 */
export function parseClientFrame(raw: unknown): ParseResult<ClientFrame> {
  let o: unknown = raw;
  if (typeof raw === "string") {
    if (raw.length > WIRE.maxPayloadBytes) return { ok: false, rid: null, reason: "frame: too large" };
    try {
      o = JSON.parse(raw);
    } catch {
      return { ok: false, rid: null, reason: "frame: not JSON" };
    }
  } else if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
    return { ok: false, rid: null, reason: "frame: binary" };
  }
  if (!isObj(o)) return { ok: false, rid: null, reason: "frame: not an object" };
  const rid = typeof o.rid === "string" && UUID.test(o.rid) ? o.rid : null;
  try {
    return { ok: true, frame: parseObj(o) };
  } catch (e) {
    if (e instanceof FrameError) return { ok: false, rid, reason: e.message };
    return { ok: false, rid, reason: "frame: unreadable" };
  }
}

function size(o: Obj): { cols: number; rows: number } {
  return { cols: int(o, "cols", 1, SHELL_LIMITS.maxCols), rows: int(o, "rows", 1, SHELL_LIMITS.maxRows) };
}

/** Read one JSON control frame from the Terminal pane's socket. Binary frames are keys and never come here. */
export function parseShellControl(raw: unknown): ParseResult<ShellClientFrame> {
  if (typeof raw !== "string") return { ok: false, rid: null, reason: "frame: not text" };
  if (raw.length > 4096) return { ok: false, rid: null, reason: "frame: too large" };
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return { ok: false, rid: null, reason: "frame: not JSON" };
  }
  if (!isObj(o)) return { ok: false, rid: null, reason: "frame: not an object" };
  try {
    switch (o.t) {
      case "open":
        return { ok: true, frame: { t: "open", chat: matching(o, "chat", CHAT_ID), ...size(o) } };
      case "resize":
        return { ok: true, frame: { t: "resize", ...size(o) } };
      case "type_resume":
        return { ok: true, frame: { t: "type_resume" } };
      case "type_trust":
        return { ok: true, frame: { t: "type_trust", toolUse: matching(o, "toolUse", AGENT_REF) } };
      case "type_attach":
        return { ok: true, frame: { t: "type_attach", id: matching(o, "id", BG_ID) } };
      default:
        return fail("t: not a shell frame");
    }
  } catch (e) {
    return { ok: false, rid: null, reason: e instanceof FrameError ? e.message : "frame: unreadable" };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Text caps

/** Cut `s` to at most `max` UTF-16 units, never inside a surrogate pair. */
export function capText(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = Math.max(0, max);
  const c = s.charCodeAt(end - 1);
  if (end > 0 && c >= 0xd800 && c <= 0xdbff) end--;
  return s.slice(0, end);
}

const capNullable = (s: string | null, max: number): string | null => (s === null ? null : capText(s, max));

/**
 * T-26: a tool result's `cut` as a frame carries it: a whole length above the length of the text it came with (the
 * cut text is shorter than the whole), else no cut (null). capEvent and the page read it so.
 */
export function toolCutOf(v: unknown, text: string): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v > text.length ? v : null;
}

/** T-26: GET of one tool use's whole result, from the session's transcript (`text/plain`, an attachment). */
export function toolOutputPath(chat: string, toolUse: string): string {
  return `/api/chats/${encodeURIComponent(chat)}/tools/${encodeURIComponent(toolUse)}/output`;
}

/**
 * R127: a tool result's `trust` as a frame carries it: an absolute path of at most TRUST_LIMITS.pathChars, and a root
 * that is one too or null; anything else is no refusal (null). The server's capEvent and the page's reducer use it.
 */
export function trustRefOf(v: unknown): TrustRef | null {
  if (!isObj(v)) return null;
  const path = get(v, "path");
  const root = get(v, "root");
  const ok = (p: unknown): p is string => typeof p === "string" && p.startsWith("/") && p.length <= TRUST_LIMITS.pathChars;
  if (!ok(path) || (root !== null && root !== undefined && !ok(root))) return null;
  return { path, root: ok(root) ? root : null };
}

/** A card answer with its free text cut at 2,000 characters (A10). */
export function capAnswer(a: CardAnswer): CardAnswer {
  const max = LIMITS.answerText;
  if (a.kind === "permission" && !a.allow) return { ...a, message: capText(a.message, max) };
  if (a.kind === "plan" && !a.approve) return { ...a, feedback: capText(a.feedback, max) };
  if (a.kind === "question") {
    return { ...a, answers: Object.fromEntries(Object.entries(a.answers).map(([k, v]) => [k, capText(v, max)])) };
  }
  return a;
}

/**
 * A tool call's or a card's input, bounded for a frame: every string cut at 8,000 characters, and all strings and
 * keys together held to 100,000 characters (later strings become empty, later array items and keys are dropped).
 * Arrays keep at most 500 items, and nesting stops at depth 12.
 */
export function capInput(value: unknown, limits: { string: number; budget: number } = { string: LIMITS.inputString, budget: LIMITS.inputBudget }): unknown {
  let budget: number = limits.budget;
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") {
      const s = capText(v, Math.min(limits.string, Math.max(0, budget)));
      budget -= s.length;
      return s;
    }
    if (v === null || typeof v === "number" || typeof v === "boolean") return v;
    if (depth >= 12 || typeof v !== "object") return null;
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      for (const item of v.slice(0, 500)) {
        if (budget <= 0) break;
        out.push(walk(item, depth + 1));
      }
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Obj)) {
      if (budget <= k.length) break;
      budget -= k.length;
      out[k] = walk(x, depth + 1);
    }
    return out;
  };
  return walk(value, 0);
}

/**
 * One event with the text caps of 4.3 applied. Idempotent: an event that fits comes back equal. Claude's own text is
 * never cut: a whole block that is too long for one frame goes out through splitBlock.
 */
export function capEvent(e: ChatEvent): ChatEvent {
  switch (e.k) {
    case "user": {
      const { mentions, ...rest } = e;
      return { ...rest, text: capText(e.text, LIMITS.userText), ...userMentions(mentions) };
    }
    case "tool_call":
      return { ...e, input: capInput(e.input) };
    case "tool_result": {
      // R127: a refusal's folder is never cut (a cut path would name another folder): one past the cap is no refusal.
      // R131: the launches of the whole text stay with it, each checked. T-26: a text cut here says its whole length;
      // one that came cut keeps the length it says, so a second cap changes nothing.
      const { trust, background, cut, ...rest } = e;
      const ref = trustRefOf(trust);
      const launches = bgLaunchesOf(background);
      const text = capText(e.text, LIMITS.toolResult);
      const whole = text.length < e.text.length ? e.text.length : toolCutOf(cut, text);
      return {
        ...rest,
        text,
        report: capNullable(e.report, LIMITS.report),
        ...(ref ? { trust: ref } : {}),
        ...(launches ? { background: launches } : {}),
        ...(whole !== null ? { cut: whole } : {}),
      };
    }
    case "background":
      return { k: "background", id: e.id, worker: e.worker === null ? null : bgWorkerOf(e.worker) };
    case "local_output":
      return { ...e, text: capText(e.text, LIMITS.localOutput) };
    case "bash":
      return {
        ...e,
        input: capText(e.input, LIMITS.bashInput),
        stdout: capText(e.stdout, LIMITS.bashOutput),
        stderr: capText(e.stderr, LIMITS.bashOutput),
      };
    case "card_open":
      return e.card.kind === "permission" ? { ...e, card: { ...e.card, input: capInput(e.card.input) } } : e;
    case "card_close": {
      const out: ChatEventOf<"card_close"> = { ...e };
      if (e.answers !== undefined) out.answers = Object.fromEntries(Object.entries(e.answers).slice(0, 16).map(([q, a]) => [capText(q, LIMITS.inputString), capText(a, LIMITS.answerText)]));
      if (e.note !== undefined) out.note = capText(e.note, LIMITS.answerText);
      return out;
    }
    case "session": {
      const out: ChatEventOf<"session"> = { ...e };
      if (e.skills !== undefined) out.skills = e.skills.slice(0, LIMITS.loaded).map((s) => capText(s, LIMITS.name));
      if (e.plugins !== undefined)
        out.plugins = e.plugins.slice(0, LIMITS.loaded).map((p) => ({ name: capText(p.name, LIMITS.name), version: capNullable(p.version, LIMITS.pluginVersion) }));
      if (e.outputStyle !== undefined) out.outputStyle = capNullable(e.outputStyle, LIMITS.name);
      if (e.fastMode) out.fastMode = { state: e.fastMode.state, reason: capNullable(e.fastMode.reason, LIMITS.name) };
      return out;
    }
    case "hook":
      return { ...e, output: capNullable(e.output, LIMITS.localOutput) };
    case "exit":
      return { ...e, stderr: e.stderr.slice(-LIMITS.stderrLines).map((l) => capText(l, LIMITS.stderrLine)) };
    case "side":
      return { ...e, x: capSideExchange(e.x) };
    default:
      return e;
  }
}

/**
 * A whole `block` whose text is too long for one frame, as `block_start`, `block_delta` pieces and `block_end`, which
 * the page draws the same way; a block that fits comes back alone. Nothing is cut.
 */
export function splitBlock(e: ChatEventOf<"block">, max: number = LIMITS.blockPiece): ChatEvent[] {
  if (e.text.length <= max) return [e];
  const out: ChatEvent[] = [{ k: "block_start", key: e.key, kind: e.kind, parent: e.parent }];
  for (let i = 0; i < e.text.length; ) {
    let end = Math.min(e.text.length, i + max);
    const c = e.text.charCodeAt(end - 1);
    if (end < e.text.length && c >= 0xd800 && c <= 0xdbff) end--;
    out.push({ k: "block_delta", key: e.key, text: e.text.slice(i, end) });
    i = end;
  }
  out.push({ k: "block_end", key: e.key });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// File references (D50, D45): the one rule for the server, which writes them, and the page, which reads them back

/** One single-quoted shell word: a name such as `$(touch x);y.txt` never becomes shell code. */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

const WHITE_SPACE = /\s/;
/** The last characters that a bare reference keeps: an ASCII letter, a digit or an underscore. */
const BARE_END = /[A-Za-z0-9_]$/;
/** A path that Claude Code reads as a file name, the text before its first #, and a line range or a heading. */
const HASH_CUT = /^[^#]+(?:#L\d+(?:-\d+)?)?(?:#[^#]*)?$/;

/**
 * A file's reference in a message, in the form that Claude Code attaches (D50). The reference probe of 2026-11-01 on
 * Claude Code 2.1.311 (a reference counts when the transcript has a "file" attachment and the file's text is in the
 * request) and its code (read on 2026-11-02):
 * - a bare `@<path>` runs to the next white space, and loses every last character that is not an ASCII letter, a digit
 *   or an underscore (`file_(1)` is read as `file_(1`, `café` as `caf`); a double quote inside it is fine;
 * - `@"<path>"` runs to the next double quote (an apostrophe in it is fine), so a path with a double quote has no
 *   quoted form (a backslash before the quote does not help); one that ends with " (agent)" names an agent;
 * - in both, a path with one # part (the name, then `#L<n>` or `#L<n>-<m>`, then # and text, each optional) is read
 *   as the text before its first #, with a line range or a heading; a path with two # parts or more is kept whole.
 * So: `@<path>` for a path with no white space whose last character is one that a bare reference keeps; else
 * `@"<path>"` for one with no double quote; else, and for a path that Claude Code cuts at a #, no @ form is attached,
 * so the path goes as plain text in backticks, and Claude reads the file with its Read tool if it may.
 * Two limits that no form avoids, because Claude Code reads the user's words and the references as one text: an @
 * and a double quote at a word's start with no double quote after them (in the user's words, or in a path that holds
 * them) run on to the next double quote, so a quoted reference after them is not attached (Claude gets its path as
 * text); and inside a path with white space, an @ at a word's start reads as one more reference, relative to the
 * chat's folder.
 */
export function messageRef(path: string): string {
  if (!(path.includes("#") && HASH_CUT.test(path))) {
    if (!WHITE_SPACE.test(path) && BARE_END.test(path)) return `@${path}`;
    if (!path.includes('"') && !path.endsWith(" (agent)")) return `@"${path}"`;
  }
  return codeSpan(path);
}

/**
 * The text as one Markdown code span: a fence of one backtick more than the longest run in it, and a space inside each
 * end when it starts or ends with a backtick or a space (Markdown takes one such pair of spaces off).
 */
function codeSpan(s: string): string {
  const fence = "`".repeat(Math.max(0, ...(s.match(/`+/g) ?? []).map((r) => r.length)) + 1);
  const pad = /^[ `]|[ `]$/.test(s) ? " " : "";
  return `${fence}${pad}${s}${pad}${fence}`;
}

/**
 * The forms of a known path's reference that a message may hold, for the page's reading back: messageRef's, then the
 * bare `@<path>` that iteration 2 (v0.1) sent for every path (one with white space, a last character that a bare
 * reference loses, or a # too).
 */
export function messageRefForms(path: string): string[] {
  const ref = messageRef(path);
  return ref === `@${path}` ? [ref] : [ref, `@${path}`];
}

/**
 * The reference that starts at `at`, for a reader that knows no path: at the text's start or after white space, in a
 * form that messageRef writes, and followed by white space or the end. `@"<path>"` runs to the next double quote;
 * `@<path>` to the next white space (so an old bare reference to a path with white space reads only up to it, and a
 * known path is looked for whole, messageRefForms); backticks hold a reference only when messageRef would write them
 * so, for a path that no @ form attaches. Null when none starts there.
 */
export function refAt(text: string, at: number): { path: string; end: number } | null {
  if (at > 0 && !WHITE_SPACE.test(text[at - 1]!)) return null;
  let path: string;
  let end: number;
  if (text.startsWith('@"', at)) {
    const close = text.indexOf('"', at + 2);
    if (close < 0) return null;
    path = text.slice(at + 2, close);
    end = close + 1;
  } else if (text[at] === "@") {
    end = at + 1;
    while (end < text.length && !WHITE_SPACE.test(text[end]!)) end++;
    path = text.slice(at + 1, end);
  } else if (text[at] === "`") {
    const n = backticksAt(text, at);
    const fence = "`".repeat(n);
    // The closing fence: the next run of exactly as many backticks.
    let close = text.indexOf(fence, at + n);
    while (close >= 0 && backticksAt(text, close) !== n) close = text.indexOf(fence, close + backticksAt(text, close));
    if (close < 0) return null;
    end = close + n;
    const inner = text.slice(at + n, close);
    path = inner.length > 2 && inner.startsWith(" ") && inner.endsWith(" ") ? inner.slice(1, -1) : inner;
    if (messageRef(path) !== text.slice(at, end)) return null;
  } else return null;
  if (!path || (end < text.length && !WHITE_SPACE.test(text[end]!))) return null;
  return { path, end };
}

/** How many backticks run from `at`. */
function backticksAt(text: string, at: number): number {
  let n = 0;
  while (text[at + n] === "`") n++;
  return n;
}

/** Every reference that refAt reads in the text, in text order (one inside a code span's path too). */
export function refsIn(text: string): { at: number; end: number; path: string }[] {
  const out: { at: number; end: number; path: string }[] = [];
  for (let at = 0; at < text.length; at++) {
    if (text[at] !== "@" && text[at] !== "`") continue;
    const r = refAt(text, at);
    if (r) out.push({ at, ...r });
  }
  return out;
}

/** An upload's reference (or a mention's): messageRef in a message, the single-quoted path in a `!` command. */
export function uploadRef(path: string, mode: "message" | "bash"): string {
  return mode === "bash" ? shellQuote(path) : messageRef(path);
}

/**
 * The text that Claude Code (or the shell) gets: the user's text, then each chip's reference, separated by spaces
 * (D50: the field holds chips only, and the server adds the references at send).
 */
export function withUploadRefs(text: string, paths: readonly string[], mode: "message" | "bash"): string {
  if (paths.length === 0) return text;
  const refs = paths.map((p) => uploadRef(p, mode)).join(" ");
  if (text === "") return refs;
  return /\s$/.test(text) ? text + refs : `${text} ${refs}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Draft rules (D49, 4.3 "A send clears the draft")

export function emptyDraft(at: string): DraftState {
  return { rev: 0, text: "", mode: "chat", command: null, link: false, uploads: [], by: null, at };
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function sameContent(a: Omit<DraftState, "rev" | "by" | "at">, b: Omit<DraftState, "rev" | "by" | "at">): boolean {
  return (
    a.text === b.text &&
    a.mode === b.mode &&
    a.command === b.command &&
    a.link === b.link &&
    sameList(a.uploads, b.uploads) &&
    sameList(a.mentions ?? [], b.mentions ?? [])
  );
}

/**
 * The chat's draft after a `draft` frame from `tab`: the text cut at 20,000 (never inside a surrogate pair), the chip
 * kept in slash mode only, at most 100 uploads and 100 mentions (the key only when there are some), and `rev` one
 * higher. Returns `prev` itself when nothing changed, so the server sends nothing.
 */
export function nextDraft(prev: DraftState, edit: Omit<DraftEditFrame, "t" | "chat">, tab: string | null, at: string): DraftState {
  const mentions = (edit.mentions ?? []).slice(0, LIMITS.draftMentions);
  const content = {
    text: capText(edit.text, LIMITS.draftText),
    mode: edit.mode,
    command: edit.mode === "slash" && edit.command !== null ? capText(edit.command, LIMITS.draftCommand) : null,
    link: edit.link,
    uploads: edit.uploads.slice(0, LIMITS.draftUploads),
    ...(mentions.length ? { mentions } : {}),
  };
  if (sameContent(prev, content)) return prev;
  return { ...content, rev: prev.rev + 1, by: tab, at };
}

/**
 * The chat's draft after the server applied a `send` or a `bash` from `tab`: emptied (a new `rev`, `by` the sender)
 * when the sender's tab changed it last or its `rev` equals `draftRev`; null when it stays as it is (another page has
 * typed since). A draft that is empty already (Send came before the box's save) still gets a new `rev`: a reload
 * that missed the ack tells by the `rev` that the send arrived, and does not put its text back in the box (7.5).
 */
export function draftAfterSend(prev: DraftState, tab: string | null, draftRev: number | null, at: string): DraftState | null {
  const sendersOwn = prev.by !== null && prev.by === tab;
  if (!sendersOwn && prev.rev !== draftRev) return null;
  return { ...emptyDraft(at), rev: prev.rev + 1, by: tab };
}

// ---------------------------------------------------------------------------------------------------------------
// The chat list on the page

/** The chat list after one `chats` frame: the whole list, or one delta applied (a gone chat removed). */
export function applyChatsFrame(list: readonly ChatRow[], frame: ChatsFrame): ChatRow[] {
  if ("list" in frame) return [...frame.list];
  const d = frame.delta;
  if ("gone" in d) return list.filter((r) => r.chat !== d.chat);
  const i = list.findIndex((r) => r.chat === d.chat);
  if (i >= 0) {
    const out = [...list];
    out[i] = { ...list[i]!, ...d };
    return out;
  }
  const row: ChatRow = {
    title: null,
    project: "",
    state: "sleeping",
    needsYou: false,
    lastActivity: "",
    archived: false,
    busy: false,
    unseen: null,
    ...d,
  };
  return [...list, row];
}
