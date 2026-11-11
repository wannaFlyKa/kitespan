// The chat registry (DESIGN.md 4.1 and 4.3; BUILD-BRIEF section 2: D48, D49, D50, the sessionId rule, live L2).
//
// One entry per known chat: its ledger, its state, its live agent chat (one `open()` per live chat, however many
// pages view it), its ring of numbered events, its open cards, its viewers, its draft and its timers. The registry
// derives each chat's state from the neutral events, runs D2's idle timer and D3's cap with its first-in, first-out
// queue, makes the server-side events (the user's own message, the cards, `!` rows, notices), and applies every chat
// action. It never sees a socket (the socket layer gives it a Viewer per attached page) and never imports the SDK.

import { UUID, newChatId, newEpoch } from "../../shared/ids";
import {
  CONTROL_CHARS,
  EFFORT_IDS,
  ERROR_MESSAGES,
  LIMITS,
  BG_NO_STAMP,
  MODE_IDS,
  TURN_CUT,
  TURN_INTERRUPTED,
  WIRE,
  btwQuestion,
  capAnswer,
  capEvent,
  capText,
  draftAfterSend,
  emptyDraft,
  nextDraft,
  splitBlock,
  withUploadRefs,
  type AttachedFrame,
  type BackgroundStopFrame,
  type BackgroundViewReply,
  type BgStopAnswer,
  type BashFrame,
  type Card,
  type CardAnswer,
  type ChatDelta,
  type ChatHold,
  type ChatEvent,
  type ChatEventOf,
  type ChatRow,
  type ChatState,
  type ChatWorktree,
  type ClaudeStatus,
  type CommandInfo,
  type ContinueSessionFrame,
  type DraftBox,
  type DraftEditFrame,
  type DraftState,
  type EffortId,
  type ErrorCode,
  type ModeId,
  type NewChatFrame,
  type OpenApp,
  type Picks,
  type RequestFrame,
  type SendFrame,
  type SideQuestionFrame,
  type TrustFolderFrame,
  type TrustRefusal,
  type Unseen,
  type WorktreeAct,
  type WorktreeOff,
} from "../../shared/protocol";
import {
  CARD_ABORT,
  MARK_PHRASES,
  markOf,
  type AgentCapabilities,
  type AgentChat,
  type AgentSettings,
  type BgRecord,
  type BinaryProbe,
  type CardHost,
  type EnvVar,
  type Marked,
  type MarkedPicks,
  type MarkedSwitches,
  type OpenInput,
  type SessionInfo,
  type SessionOpen,
} from "../agents/types";
import type { TurnChanges } from "../changes/book";
import { markedVars } from "../env/child";
import type { EnvDeps } from "../env/store";
import type { LogError, LogEvent, LogFields } from "../log";
import { emptyNotes, noteCard, turnErrorNote } from "../store/notes";
import { ChatQueue } from "./queue";
import { ORPHAN_GRACE_MS, bootStop, cutStop, endOrphan, insertStops, procLives, systemProcs, transcriptFacts, type ProcTable, type SurviveDeps, type TranscriptFacts } from "./stops";
import { mentionPaths } from "../search/mention";
import {
  SETTINGS_DEFAULTS,
  STORE_LIMITS,
  rememberableMode,
  type ChatLedger,
  type DraftRecord,
  type LedgerPicks,
  type LedgerProc,
  type LedgerWorktree,
  type NotesRecord,
  type ProjectRecord,
  type QueuedNote,
  type Settings,
  type TurnNote,
  type UploadRecord,
  stopLine,
} from "../store/types";
import { bashDigest, cardClose, decorateHistory, notRunAnchor } from "./history";
import { insertTurns, turnRowId } from "./turns";
import { ModelList } from "./models";
import { ChatContexts } from "./context";
import { KeptSettings } from "./facts";
import { keepProjectCommands } from "./project-commands";
import { Ring, eventId, fitEvent } from "./ring";
import { SEND_NOW_WAIT_MS, SendNowWatch, sendNowAct } from "./send-now";
import { bootUnseen, endUnseen, onScreenNow } from "./seen";
import { SideThreads } from "./side";
import { TrustBook } from "./trust";
import { folderRef } from "./trust-folder";
import { BackgroundBook } from "./background";
import { originFolder } from "../../shared/background";
import type { PushMoment, PushMomentInput } from "../../shared/push";
import { isBgId } from "../../shared/ids";
import { homeFolders } from "../home";
import type { AttachPayload, AttachWant, BashResult, Outcome, RegistryDeps, RegistryOptions, RequestContext, RingItem, SnapshotPayload, Viewer } from "./types";
import type { DrainAnswer, RestartWhen } from "../http/api-types";
import { HAND_OVER_MS, type HandOverDeps } from "./drain";
import { linkedRootOf, worktreeHere } from "../worktree/check";
import { WorktreeHost, configFolder, openWorktree, rowWorktree, sessionFolder, startCheck, startupCode, type WorktreeHostDeps } from "../worktree/host";
import type { ReleasedSession } from "../store/released";

/**
 * The line of a start that failed. D60 (L39): the unreadable environment's line keeps its code, so the page draws its
 * way to the environment by the code, not by the words.
 */
function startNotice(code: ErrorCode): ChatEvent {
  return { k: "notice", text: ERROR_MESSAGES[code], ...(code === "env_unreadable" ? { code } : {}) };
}

/** The chat line while a start waits for a free slot (D3); it goes when the wait ends, with a start or without one. */
export const CAP_NOTICE = "This chat waits for a free slot.";
/** A chat's first-prompt title is cut at 80 characters (6.10). */
export const FIRST_PROMPT_TITLE = 80;
/** How long boot waits for the session titles of chats whose ledger has none (a later answer still applies). */
const BOOT_TITLES_MS = 3_000;
/** R16: how often kitespan's own orphan is looked for while it holds its chat. */
const ORPHAN_POLL_MS = 500;
/** A history page for a snapshot or a `get`: 256 KiB of JSON, less room for the frame's other fields. */
export const PAGE_BUDGET = WIRE.pageBytes - 4096;
/** How often a chat-list delta may carry only a newer `lastActivity`. */
const ACTIVITY_DELTA_MS = 30_000;
/** The applied ids kept per chat in memory (Entry.made); the newest STORE_LIMITS.applied of them go to the ledger. */
const MADE_KEEP = 4_096;
/** The state events whose latest copy follows every snapshot (the chat's current model, `/` menu and tasks). */
const STATE_KINDS = new Set<ChatEvent["k"]>(["session", "commands", "tasks"]);
const CONTROL_ALL = new RegExp(CONTROL_CHARS.source, "g");
/** Claude Code's refusal of a `sessionId` whose transcript exists (live L1: "Session ID ... is already in use."). */
const SESSION_IN_USE = /already in use/i;
/** D58: how often every chat's session is checked against the sessions that other processes have open. */
const OPEN_CHECK_MS = 10_000;
/** Row 78: how often while a chat has a viewer or a live process, so kitespan gives a session up within about 2 s. */
const OPEN_FAST_MS = 2_000;
/** L11: how long a sleeping chat with no viewer keeps its ring (a starting point; the live smoke tunes it). */
const RING_KEEP_MS = 30 * 60_000;
/**
 * D58: a copy's title (Continue in a copy): the mark first, so a title cut in the sidebar or a title bar still says it
 * is a copy; a later copy of the same session is numbered (W19d).
 */
export function copyTitle(title: string, n: number): string {
  const mark = n > 1 ? `Copy ${n} of ` : "Copy of ";
  return `${mark}${capText(title || "Untitled", LIMITS.title - mark.length).trimEnd()}`;
}

type Phase = "sleeping" | "starting" | "live" | "ending";
/**
 * `held` (row 78): another process has the chat's session open, so nothing starts; what waits stays, Queued.
 * `env_unreadable` (D60, L39): the environment's variables could not be read, so nothing starts.
 */
type StartResult = "started" | "queued" | "held" | "no_claude" | "env_unreadable" | "failed" | "gone" | "refused";

interface Live {
  gen: number;
  chat: AgentChat;
  startedAt: number;
  /** The CLI has sent its first frame (starting moves to running, 4.1). */
  firstEvent: boolean;
  exitSeen: boolean;
  /** kitespan asked for the close (the idle rule, the cap, Archive, Delete, a shutdown): no exit line (4.1). */
  requested: boolean;
  /** The session id this process was started with as `sessionId` (a first start, D41), else null. */
  sessionIdStart: string | null;
  /** R16: the process's pid and start are in the ledger (noteProc). */
  procNoted: boolean;
  /** W5: Claude Code refused this start itself (`startup_failure_reason`); nothing starts again by itself. */
  startRefused?: boolean;
  /** W5: the messages this process got before its first event (a refused start ran none of them). */
  unseen?: PendingMsg[];
  /** D60: the environment's variables this process started with; its `!` commands get the same set (L38). */
  env: readonly EnvVar[];
  /**
   * Row 111: this Claude Code names the messages a turn takes in (a `taken_in` came), so a turn that names none took
   * none in (a task's notification), and no oldest-first guess runs at its start.
   */
  stamps?: boolean;
  done: Promise<void>;
  closing: Promise<void> | null;
}

/**
 * The user's own message as every page gets it: with the paths of its mention chips (9.3), an empty list when it had
 * none, so the page makes exactly those tiles and no other reference of the text one.
 */
function userEvent(msg: PendingMsg, queued: boolean): ChatEvent {
  return { k: "user", uuid: msg.uuid, text: msg.text, queued, mentions: [...msg.mentions], ...(msg.notSent ? { notSent: true } : {}) };
}

/** A message the user sent that no turn has started on yet. */
interface PendingMsg {
  uuid: string;
  /** What Claude Code gets: the user's text plus the upload references (D50). */
  text: string;
  /** What the user typed, for Take back. */
  userText: string;
  uploads: string[];
  /** The mention chips (9.3): paths relative to the chat's folder, for Take back and the `user` event's tiles. */
  mentions: string[];
  /**
   * `cap`: waits for the chat's start (D3); `cli`: in Claude Code's own queue behind a running turn; `bash`: waits in
   * the server behind a `!` command that was sent before it (`bashQueue`), so it goes to Claude Code after that
   * command's record.
   */
  where: "cap" | "cli" | "bash";
  /** Its `user` event went out. */
  announced: boolean;
  /** RD-8 (R12): restored from the queue file at boot; "Not sent" until it goes (or a send or Send again starts it). */
  notSent?: boolean;
  /**
   * R12 with R16: restored at boot under a `finishing` hold, Queued: the orphan may still run it, so the transcript's
   * dedupe and Not sent come when the orphan exits (restoreQueue).
   */
  underHold?: boolean;
  /**
   * Row 111: Claude Code took it into the running turn at a tool boundary (SendNowWatch), so its Queued label went; it
   * leaves `pending` at a turn's end that lists it, and is Queued again at one that does not.
   */
  read?: boolean;
  /** Its newest `user` event, kept for a snapshot after the ring dropped it (see `dropped`). */
  item?: RingItem;
}

interface BashJob {
  uuid: string;
  /** What runs: the user's command plus the upload references (D50). */
  input: string;
  /** What the user typed and the chips, for the draft when the command never runs. */
  userInput: string;
  uploads: string[];
  mentions: string[];
  abort: AbortController;
  announced: boolean;
  /** Its newest `bash` event, kept for a snapshot after the ring dropped it (see `dropped`). */
  item?: RingItem;
}

type Waiting = { kind: "send"; msg: PendingMsg } | { kind: "bash"; job: BashJob };

interface OpenCard {
  card: Card;
  resolve: (a: CardAnswer | null) => void;
  /** The tool call that the card's record follows in history (CardNote.after); null: found when it closes. */
  after: string | null;
}

/** A streamed block that has not ended: its start and each delta, kept while the ring may drop them (4.3). */
interface OpenBlock {
  start: RingItem;
  deltas: { seq: number; text: string }[];
}

/** D49: one box's draft as the server holds it (null until it is read), its one read, and its chain of changes. */
interface DraftSlot {
  cur: DraftState | null;
  load: Promise<DraftState> | null;
  chain: Promise<void>;
}

interface StartRequest {
  entry: Entry;
  probe: BinaryProbe | undefined;
  promise: Promise<StartResult>;
  settled: boolean;
  settle(r: StartResult): void;
}

interface Entry {
  readonly id: string;
  ledger: ChatLedger;
  phase: Phase;
  /** The state last computed (for the ledger and the cap); `row` is the row last sent. */
  state: ChatState;
  row: ChatRow;
  activitySentAt: number;
  live: Live | null;
  starting: Promise<StartResult> | null;
  ring: Ring;
  /** L11: drops the ring of a sleeping chat that has had no viewer for RING_KEEP_MS (reviewRing). */
  ringTimer: ReturnType<typeof setTimeout> | null;
  seq: number;
  /**
   * R4: the history changed outside the ring at this `seq` (the boot, the end of a D58 hold), so an attach whose cursor
   * is not above it gets a snapshot.
   */
  resyncSeq: number;
  /**
   * The turn in flight; `item` is its `turn_start`, kept for a snapshot after the ring dropped it. `cut`: Restart now
   * stopped it, and its stop line says so (TURN_CUT). U2: who started it, and the history ids of its first and newest
   * rows (turns.ts turnRowId), which the notes keep at its end and history marks it by.
   */
  turn: { seq: number; interrupted: boolean; cut?: boolean; item: RingItem; by: "user" | "agent"; ids: string[]; last: string[] } | null;
  lastTurnEndSeq: number;
  /** The streamed blocks of the turn in flight that have not ended, by key. */
  openBlocks: Map<string, OpenBlock>;
  /** The newest event of each state kind (STATE_KINDS), kept for a snapshot after the ring dropped it. */
  states: Map<ChatEvent["k"], RingItem>;
  /**
   * A session id whose transcript is known to exist in this server run (a turn ended in it, or Claude Code refused
   * a start with it as `sessionId`): its next start resumes it (D41).
   */
  transcript: string | null;
  cards: Map<string, OpenCard>;
  viewers: Set<Viewer>;
  /** D49: the chat's drafts, the message box's and (FIX-U2) the side box's, each read once and changed in turn. */
  drafts: Record<DraftBox, DraftSlot>;
  intake: Promise<unknown>;
  writeChain: Promise<void>;
  lastWriteAt: number;
  pending: Map<string, PendingMsg>;
  waiting: Waiting[];
  /**
   * A live chat's `!` commands that wait (typed during a turn, or behind a message in Claude Code's queue) and the
   * messages sent after one of them, in the order sent: each command runs, and its record reaches Claude Code, in that
   * order (6.3), so the transcript holds them as every page drew them.
   */
  bashQueue: Waiting[];
  bashRunning: BashJob | null;
  /** The chat's notes (its closed cards and its `!` rows' own ids), once read; changes go through `notesChain`. */
  notes: NotesRecord | null;
  notesLoad: Promise<NotesRecord> | null;
  notesChain: Promise<void>;
  /**
   * U2: the seq of each turn's end that this server life noted (its TurnNote), so a page whose snapshot's tail holds
   * that end gets the turn from the tail alone, not from history too.
   */
  turnEnds: WeakMap<TurnNote, number>;
  /** The live process's tool calls that have no result yet, by tool-use id, with their parent and tool name. */
  openCalls: Map<string, { parent: string | null; name: string }>;
  /** Each task's tool use (the Agent or Workflow call that runs it), from its task events. */
  taskCalls: Map<string, string>;
  tasks: { taskId: string; description: string; ambient: boolean }[];
  seenTasks: Set<string>;
  /**
   * The ids this chat applied: each message's uuid once it is on the input (a CLI echo of one is dropped, D49), each
   * `!` command's rid once it runs, each of either that a shutdown took back to the draft, and the uuid of the
   * new_chat that made the chat. The newest go into the ledger
   * (`applied`), so a tab's resend after a restart is answered and not applied again (4.3).
   */
  made: Set<string>;
  /** Plan applies to the current session only (D11): kept here, never in the ledger or the project. */
  modeOverride: ModeId | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** The `id` of the free-slot line (CAP_NOTICE) of the start that waits now, or null. */
  capLine: string | null;
  /**
   * Row 78: the app that has this chat's session open now (the last check, or the read before a start), or null.
   * While it is set the chat sends nothing and starts no process.
   */
  held: OpenApp | null;
  /**
   * Row 78: kitespan gives this chat's session up: its process ends at its first quiet moment (no turn, no card, no
   * `!` command, no task that is not ambient, nothing in Claude Code's own queue), as the idle timer would end it,
   * also when the other app closed the session meanwhile, so the next start reads the transcript again. What waits
   * meanwhile waits for that start. Set while the process exists; it goes with the process.
   */
  yielding: boolean;
  titleTried: boolean;
  commands: CommandInfo[] | null;
  /** While above 0, chat-list deltas wait (an action whose ack must go first). */
  hold: number;
  deleting: boolean;
  deleted: boolean;
  /** RD-8: the chat's queue file, the messages that wait (queue.ts). */
  queue: ChatQueue;
  /**
   * R16: the claude that the server before this one started for the chat, still running after a kill -9 or a crash:
   * the chat is held as `finishing` (`held` is `other`) until it exits (watchOrphan).
   */
  orphan: LedgerProc | null;
  /**
   * Row 73 (W4, W5): the code of the start that kitespan's check or Claude Code refused last, whose line has buttons;
   * null once a start went through or the user picked one (the `worktree` frame).
   */
  refusal: ErrorCode | null;
  /** The id of that refusal's line, which a `taken_back` removes once the refusal clears (no stale buttons). */
  refusalLine: string | null;
  /** W6: the chat's git branch as Claude Code's session info last named it (Claude can switch it), or null. */
  branch: string | null;
  /** Row 111: what Send now knows about the live process (send-now.ts). */
  sendNow: SendNowWatch;
  /** Row 116: the attached pages that say the chat is on screen (`on_screen`); in memory only (seen.ts). */
  onScreen: Set<Viewer>;
  /** Row 116: a Stop ended kitespan's own orphan (R16), so the end of its turn is the user's own act and is seen. */
  orphanStopped: boolean;
  /**
   * R131: the attached pages that say a background session of this chat is on screen, with the short ids each has on
   * screen: the session's line under its launch row, or its view (DESIGN-R131 9.5; FIX-R131 2: "its line or view").
   */
  bgViews: Map<Viewer, Set<string>>;
  /** U1: the turn in flight's changes marks and tool activity (server/changes/book.ts); none without a changes book. */
  marks?: TurnChanges | null;
  /**
   * U1: what goes on the live chat's input after a turn's start mark (a message that starts a turn waits for it, at
   * most 3 s), and everything sent after it, in order; null when nothing waits.
   */
  inputWait?: Promise<void> | null;
}

const ok = (result: unknown, after?: () => void): Outcome => (after ? { ok: true, result, after } : { ok: true, result });
const fail = (code: ErrorCode, reason?: WorktreeOff | TrustRefusal): Outcome => ({ ok: false, code, ...(reason ? { reason } : {}) });
/** Resolves after `ms`; its timer never keeps the process alive. */
function nap(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    (t as { unref?: () => void }).unref?.();
  });
}
/** `p`, or undefined after `ms`; the timer is cleared either way, so a quick close leaves nothing pending. */
function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((r) => {
    t = setTimeout(() => r(undefined), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}
const isEffort = (v: string): v is EffortId => (EFFORT_IDS as readonly string[]).includes(v);
const isMode = (v: string): v is ModeId => (MODE_IDS as readonly string[]).includes(v);

/** The codes that a driver failure carries through to the `ack` (4.3); every other failure is `failed`. */
export const DRIVER_ACK_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(["no_claude", "bad_request", "unsupported", "stale", "not_found"]);

/**
 * The ack code of an error a driver call threw: a driver error's own code (server/agents/claude/driver.ts DriverError,
 * read by its name, since the registry never imports the driver) when it is one of DRIVER_ACK_CODES, else `failed`.
 */
export function driverErrorCode(e: unknown): ErrorCode {
  if (!(e instanceof Error) || e.name !== "DriverError") return "failed";
  const code = (e as Error & { code?: unknown }).code;
  return typeof code === "string" && DRIVER_ACK_CODES.has(code as ErrorCode) ? (code as ErrorCode) : "failed";
}

/** The welcome's Claude Code facts; the minimum's field only when the version is below it (optional on the wire). */
export function statusOf(p: BinaryProbe): ClaudeStatus {
  return { ok: p.ok, version: p.version, drift: p.drift, ...(p.belowMinimum ? { belowMinimum: p.belowMinimum } : {}) };
}

/** A one-line label: control characters become spaces, runs of white space one space. */
export function cleanLabel(s: string): string {
  return s.replace(CONTROL_ALL, " ").replace(/\s+/g, " ").trim();
}

/** The first-prompt title (6.10): the message's text on one line, cut at 80 characters; null when it has none. */
export function firstPromptTitle(text: string): string | null {
  const t = cleanLabel(text);
  return t ? capText(t, FIRST_PROMPT_TITLE) : null;
}

/**
 * The newest events of a history page that fit `budget` bytes of JSON (oldest dropped first). A newest event that is
 * alone over the budget is kept, cut to fit, so a page is never empty because of one event.
 */
export function trimPage(events: ChatEvent[], budget: number = PAGE_BUDGET): ChatEvent[] {
  const sizes = events.map((e) => Buffer.byteLength(JSON.stringify(e)) + 1);
  let total = 2 + sizes.reduce((a, b) => a + b, 0);
  let i = 0;
  while (total > budget && i < events.length) total -= sizes[i++]!;
  if (i === 0) return events;
  if (i < events.length) return events.slice(i);
  const last = events[events.length - 1];
  return last ? [fitEvent("", 0, last, budget - 64).e] : [];
}

function toDraftState(r: DraftRecord): DraftState {
  const mentions = r.mentions?.length ? { mentions: [...r.mentions] } : {};
  return { rev: r.rev, text: r.text, mode: r.mode, command: r.command, link: r.link, uploads: [...r.uploads], ...mentions, by: r.by, at: r.at };
}

function startsActivity(e: ChatEvent): boolean {
  return (e.k === "block_start" || e.k === "block" || e.k === "tool_call") && e.parent === null;
}

/** U2: a row of the turn in flight, by its history id: its first two (TurnNote `ids`) and its newest two (`last`). */
function trackTurnRow(turn: { ids: string[]; last: string[] }, e: ChatEvent): void {
  const id = turnRowId(e);
  if (id === null) return;
  if (turn.ids.length < 2 && !turn.ids.includes(id)) turn.ids.push(id);
  if (turn.last[0] !== id) turn.last = [id, ...turn.last.filter((x) => x !== id)].slice(0, 2);
}

export class ChatRegistry {
  readonly epoch: string;
  private readonly entries = new Map<string, Entry>();
  private readonly bySession = new Map<string, string>();
  private readonly continuing = new Map<string, Promise<Outcome>>();
  private openTimer: ReturnType<typeof setInterval> | null = null;
  private openChecks = 0;
  /** When the last check of every chat's session began (performance.now()). */
  private openCheckAt = 0;
  private readonly listeners = new Set<(d: ChatDelta) => void>();
  private capQueue: StartRequest[] = [];
  private settings: Settings = { ...SETTINGS_DEFAULTS };
  private claude: ClaudeStatus = { ok: false, version: null, drift: null };
  private readonly caps: AgentCapabilities;
  private gen = 0;
  private draining = false;
  private pumping = false;
  private pumpAgain = false;
  /** The registry's writes of a project, one after another (projectWrite). */
  private projectChain: Promise<unknown> = Promise.resolve();
  /** Row 81: Claude Code's model list, kept with the projects, for the pickers of chats with no live process. */
  private readonly models: ModelList;
  /** Row 94: the context figure of a chat with no live read. */
  private readonly contexts: ChatContexts;
  /** Row 97: the provider and start facts that Settings shows while no chat is live. */
  private readonly kept: KeptSettings;
  /** R16: the system's processes. */
  private readonly procs: ProcTable;
  /** The drain's rule for sends (setQueueOnly). */
  private queueOnly = false;
  /** S9: Restart when they finish waits (drain), until Cancel (undrain) or the close (shutdown). */
  private restartDrain = false;
  /** S11: the claude process of each chat start (its pid and start), until it is seen gone (claudeProcs). */
  private readonly ownProcs = new Map<number, string>();
  /**
   * S16: the chats held as handed to the terminal (End it here and copy), with the timer of their hand-over's end; null
   * while the chat's Claude Code still runs (the time starts when it ends).
   */
  private readonly handed = new Map<string, ReturnType<typeof setTimeout> | null>();
  /** The chats whose orphan is being looked for (watchOrphanOnce): a close and a reopen never start a second look. */
  private readonly orphanWatches = new Set<string>();
  /** Row 73: kitespan's own worktree git, one call after another per worktree (server/worktree/host.ts). */
  private readonly wt: WorktreeHost;
  /** Each project's folder, as the store had it last (the chat list's `worktree` and the short reads need it at once). */
  private readonly projectCwds = new Map<string, string>();
  /** W3: the new chats' worktrees in the making (makeWorktree), which a shutdown waits for. */
  private readonly making = new Set<Promise<unknown>>();
  /** Row 99: the projects whose Remove runs or ran (beginLeave, leaveProject): no chat starts in them. */
  private readonly leaving = new Set<string>();
  /**
   * Row 99 with W3: how many worktrees are in the making in each project (a Start's until its ledger holds it, an
   * Unarchive's or a Make it again's remake), each with its record in the making: Remove waits for them (projectBusy).
   */
  private readonly makingIn = new Map<string, number>();
  /** R124: every chat's side thread and its side question in flight (side.ts). */
  private readonly side: SideThreads;
  /** R127: each chat's refused rows and each refused folder's state (trust.ts). */
  private readonly trust: TrustBook;
  /** R131: each chat's background sessions (the ids its launch rows printed) and their states (background.ts). */
  private readonly bg: BackgroundBook;
  /** R131: the number of the newest check whose records the book takes (checkOpen). */
  private bgLooks = 0;

  constructor(
    private readonly deps: RegistryDeps & SurviveDeps & HandOverDeps & EnvDeps & WorktreeHostDeps,
    private readonly opts: RegistryOptions = {},
  ) {
    this.epoch = opts.epoch ?? newEpoch();
    this.procs = deps.procs ?? systemProcs;
    this.wt = new WorktreeHost(deps);
    this.caps = { ...deps.driver.capabilities() };
    // R127: the agent's trust start, when it has one and says so.
    const trustStart = this.caps.trustFolder === true && typeof deps.driver.trustFolder === "function" ? (p: string, s: AbortSignal) => deps.driver.trustFolder!(p, s) : null;
    this.caps.trustFolder = trustStart !== null;
    this.trust = new TrustBook({
      start: trustStart,
      homes: deps.trustHomes ?? homeFolders,
      emit: (chat, e) => {
        const entry = this.entries.get(chat);
        if (entry && !entry.deleted && !entry.deleting) this.emit(entry, e);
      },
      log: (path, answer) => this.log("trust", { path, answer }),
      codeOf: driverErrorCode,
    });
    // R131: the background sessions' book; Claude Code's list only through the seam's method, when the agent has one.
    const listBackground = deps.driver.listBackground;
    this.bg = new BackgroundBook({
      list: typeof listBackground === "function" ? (ids) => listBackground.call(deps.driver, ids) : null,
      roots: (chat) => this.bgRoots(chat),
      seen: (chat, id) => this.bgSeen(chat, id),
      emit: (chat, e) => {
        const entry = this.entries.get(chat);
        if (entry && !entry.deleted && !entry.deleting) this.emit(entry, e);
      },
      changed: (chat) => {
        const entry = this.entries.get(chat);
        if (entry && !entry.deleted && !entry.deleting && entry.hold === 0) this.sendDelta(entry);
      },
      log: (f) => this.log("bg_list", { ms: f.ms, code: f.code, count: f.count }),
      // R130: a session that needs input, or an end that no page saw, notifies; one that is gone is seen.
      moment: (chat, id, kind) => this.bgMoment(chat, id, kind),
      gone: (chat, id) => this.pushCall((p) => p.seenBg(chat, id)),
      ...(opts.bgLaunchWaitMs !== undefined ? { launchWaitMs: opts.bgLaunchWaitMs } : {}),
      ...(opts.bgListKeepMs !== undefined ? { listKeepMs: opts.bgListKeepMs } : {}),
    });
    this.models = new ModelList({
      store: deps.store,
      // D60 (L37, L38): a project with variables has its own list and its own read, which gets them; row 94's windows
      // come from that same read.
      read: (cwd, vars) => deps.driver.readModels(cwd, markedVars(vars, this.now())),
      windows: (cwd, vars) => deps.driver.readWindows(cwd, markedVars(vars, this.now())),
      ...(deps.env ? { vars: (p: string) => deps.env!.vars(p) } : {}),
      may: () => this.mayRead,
      now: () => this.now(),
      write: (fn) => this.projectWrite(fn),
      onError: (err) => this.error(err, null),
    });
    this.contexts = new ChatContexts({
      store: deps.store,
      usage: (sessionId, cwd) => deps.driver.lastUsage(sessionId, cwd),
      refresh: (chat) => this.models.refreshWindows({ id: chat.project, cwd: chat.cwd }, !this.draining),
      own: (p) => this.models.own(p),
      now: () => this.now(),
      write: (fn) => this.projectWrite(fn),
      onError: (err) => this.error(err, null),
    });
    this.kept = new KeptSettings({ store: deps.store, now: () => this.now(), write: (fn) => this.projectWrite(fn), onError: (err) => this.error(err, null) });
    this.side = new SideThreads({
      store: deps.store,
      now: () => this.now(),
      emit: (chat, e) => {
        const entry = this.entries.get(chat);
        if (entry && !entry.deleted && !entry.deleting) this.emit(entry, e);
      },
      // A side question keeps its process from the idle rule and the cap while it runs (idleEligible, pickVictim).
      changed: (chat) => {
        const entry = this.entries.get(chat);
        if (entry && !entry.deleted) this.reviewIdle(entry);
        this.pump();
      },
      codeOf: driverErrorCode,
      log: (ev, f) => this.log(ev, f),
      error: (err, chat) => this.error(err, chat),
      ...(opts.sideDeadlineMs !== undefined ? { deadlineMs: opts.sideDeadlineMs } : {}),
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Boot, settings, status

  /**
   * Rebuild the registry from the ledgers, every chat asleep (4.1), and probe the binary for `welcome`. A ledger whose
   * old state says a stop cut its turn or card keeps that as its `stop` (D32) until its line is noted (survive).
   */
  async boot(): Promise<{ setAside: string[]; swept: number }> {
    const opened = await this.deps.store.open();
    this.settings = await this.deps.store.readSettings();
    const projects = await this.deps.store.listProjects();
    for (const p of projects) this.projectCwds.set(p.id, p.cwd);
    const at = this.iso();
    for (const rec of opened.chats) {
      if (this.entries.has(rec.id)) continue;
      const stop = bootStop(rec, at);
      this.addEntry({ ...rec, state: "sleeping", ...(stop ? { stop } : {}) });
    }
    // W3: a worktree that a server which died during a Start left in the making goes, unless a ledger holds it; a
    // remake's (Unarchive, Make it again) cut part way goes too. Every project's records, whatever its Worktree option
    // says now, so a record never outlives a crash because the option changed.
    const held = new Set([...this.entries.values()].flatMap((e) => (e.ledger.worktree ? [e.ledger.worktree.path] : [])));
    await this.wt.sweep(projects, (path) => held.has(path)).catch(() => 0);
    await within(Promise.all([...this.entries.values()].flatMap((e) => [this.sessionTitle(e), this.bootTranscript(e)])), BOOT_TITLES_MS);
    await this.survive();
    await this.probe();
    this.watchOpen();
    return { setAside: opened.setAside, swept: opened.swept };
  }

  /** The binary pin again (Settings > Claude Code, and every chat start). */
  async probe(): Promise<ClaudeStatus> {
    try {
      this.claude = statusOf(await this.deps.driver.probe());
    } catch {
      this.claude = { ok: false, version: null, drift: null };
    }
    return this.claude;
  }

  /** Read Settings again after the JSON API changed them (the idle limit and the cap apply at once). */
  async reloadSettings(): Promise<void> {
    this.settings = await this.deps.store.readSettings();
    for (const e of this.entries.values()) {
      this.clearIdle(e);
      this.reviewIdle(e);
    }
    this.pump();
  }

  get claudeStatus(): ClaudeStatus {
    return this.claude;
  }

  get capabilities(): AgentCapabilities {
    return this.caps;
  }

  get isDraining(): boolean {
    return this.draining;
  }

  /** Whether a short read (D59, row 81) may start now: none while the restart drains or the server closes (R17, S11). */
  get mayRead(): boolean {
    return !this.draining && !this.restartDrain;
  }

  /** Every chat's row, newest first (the `chats` list after `welcome`). */
  list(): ChatRow[] {
    const rows: ChatRow[] = [];
    for (const e of this.entries.values()) if (!e.deleted && !e.deleting) rows.push(this.rowOf(e));
    return rows.sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : a.lastActivity > b.lastActivity ? -1 : 0));
  }

  /**
   * U5: every chat with its session, for the message search (server/search/messages.ts), archived ones too: the folder
   * that the session functions read (sessionFolder) and the chat's last activity in ms. Nothing goes to a page.
   */
  searchChats(): { chat: string; sessionId: string | null; dir: string; activity: number }[] {
    const out: { chat: string; sessionId: string | null; dir: string; activity: number }[] = [];
    for (const e of this.entries.values()) {
      if (e.deleted || e.deleting) continue;
      out.push({ chat: e.id, sessionId: e.ledger.sessionId, dir: sessionFolder(e.ledger), activity: Date.parse(e.ledger.lastActivityAt) || 0 });
    }
    return out;
  }

  /** Every chat-list change, as one delta (to every socket, attached or not). */
  subscribe(fn: (d: ChatDelta) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  has(chat: string): boolean {
    const e = this.entries.get(chat);
    return !!e && !e.deleted && !e.deleting;
  }

  stateOf(chat: string): ChatState | null {
    const e = this.entries.get(chat);
    return e ? this.computeState(e) : null;
  }

  /**
   * Whether a Claude Code of this chat may be writing its session now (DESIGN 6.10, D49): the chat's own process, from
   * its start to its end, and kitespan's own orphan of a server before this one (R16). Open in terminal then types the
   * fork command, never the plain one.
   */
  processLives(chat: string): boolean {
    const e = this.entries.get(chat);
    return !!e && (e.phase !== "sleeping" || e.orphan !== null);
  }

  /** The session ids that kitespan chats hold ("From the terminal" leaves them out). */
  heldSessions(): Set<string> {
    return new Set(this.bySession.keys());
  }

  /** The chat that holds a session, or null (D49: one kitespan chat per session id). */
  chatForSession(sessionId: string): string | null {
    return this.bySession.get(sessionId) ?? null;
  }

  /** D58: the newest copy of a session (Continue in a copy) that is in the lists, or null; the preview offers it. */
  copyForSession(sessionId: string): string | null {
    let best: Entry | null = null;
    for (const e of this.copiesOf(sessionId)) {
      if (e.ledger.archivedAt !== null) continue;
      if (!best || e.ledger.createdAt >= best.ledger.createdAt) best = e;
    }
    return best?.id ?? null;
  }

  private copiesOf(sessionId: string): Entry[] {
    return [...this.entries.values()].filter((e) => !e.deleted && !e.deleting && e.ledger.copyOf === sessionId);
  }

  /** Chats whose claude process exists: starting, idle, running, waiting and ending (D3's count). */
  liveCount(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.phase !== "sleeping") n++;
    return n;
  }

  /** The chat's draft of one box as the server holds it, or null when it was never read. */
  draftOf(chat: string, box: DraftBox = "main"): DraftState | null {
    return this.entries.get(chat)?.drafts[box].cur ?? null;
  }

  /**
   * The ring event right after `seq` (the paced catch-up of 4.3): null when none yet, "gap" when it was dropped, also
   * by a ring that went whole (R8): a `seq` below the chat's last one is never caught up.
   */
  next(chat: string, seq: number): RingItem | null | "gap" {
    const e = this.entries.get(chat);
    if (!e) return null;
    const n = e.ring.next(seq);
    return n === null && seq < e.seq ? "gap" : n;
  }

  /** The chat's last `seq`. */
  seq(chat: string): number {
    return this.entries.get(chat)?.seq ?? 0;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Viewers

  /**
   * A socket attaches (4.3 "Attach and replay"). The viewer counts at once (it stops D2's timer); the payload comes
   * once the draft is read. `want`, the page's cursor, takes the replay path when the ring holds every event after it
   * (canReplay): no history read, and the catch-up sends the ring after `since`. Else the snapshot path reads the
   * newest history page. Null: no such chat, or the viewer left meanwhile.
   */
  attach(chat: string, viewer: Viewer): Promise<SnapshotPayload | null>;
  attach(chat: string, viewer: Viewer, want: AttachWant | undefined): Promise<AttachPayload | null>;
  async attach(chat: string, viewer: Viewer, want?: AttachWant): Promise<AttachPayload | null> {
    const entry = this.entries.get(chat);
    if (!entry || entry.deleted || entry.deleting) return null;
    entry.viewers.add(viewer);
    entry.ledger.seenAt = this.iso();
    this.reviewIdle(entry);
    // The boundary as it is before the reads: a turn that ends while the transcript is read moves the entry's
    // boundary past events that the read may not hold, so the tail keeps everything after this one (the page's ids
    // drop what the read holds). The last turn's calls are drawn stopped only if no turn ran at any point of the read
    // (kitespan's own orphan, R16, still runs its turn).
    const since = entry.lastTurnEndSeq;
    const flight = entry.turn;
    const idle = entry.turn === null && entry.orphan === null;
    await Promise.all([this.loadDraft(entry, "main"), this.loadDraft(entry, "side")]);
    if (want && this.canReplay(entry, want)) {
      if (entry.deleted || entry.deleting || !entry.viewers.has(viewer)) return null;
      const replay = want.since === entry.seq ? "none" : "events";
      return { attached: { ...this.attachedOf(entry, replay), cursor: want.since }, tail: [], cursor: want.since };
    }
    const page = await this.historyPage(entry, null, () => idle && entry.turn === null && entry.lastTurnEndSeq === since, { since, flight });
    if (entry.deleted || entry.deleting || !entry.viewers.has(viewer)) return null;
    const pageIds = new Set<string>();
    for (const e of page.events) {
      const id = eventId(e);
      if (id !== null) pageIds.add(id);
    }
    const tail = this.tail(entry, pageIds, since);
    return {
      attached: this.attachedOf(entry, "snapshot"),
      snapshot: { t: "snapshot", chat, seq: tail.length > 0 ? tail[0]!.seq - 1 : entry.seq, tail: tail.length, history: page.events, more: page.more },
      tail,
      cursor: entry.seq,
    };
  }

  /**
   * R2: the page's cursor can be caught up from the ring alone: it is this epoch's, above 0 (0 always asks for a
   * snapshot), not above the last seq, above the last resync (history that changed outside the ring, R4), and the ring
   * holds the event after it (or nothing was missed).
   */
  private canReplay(entry: Entry, want: AttachWant): boolean {
    const { since, epoch } = want;
    if (epoch !== this.epoch || since <= 0 || since > entry.seq || since <= entry.resyncSeq) return false;
    return since === entry.seq || entry.ring.holds(since + 1);
  }

  /** The `attached` frame, once both drafts are read (attach). */
  private attachedOf(entry: Entry, replay: AttachedFrame["replay"]): AttachedFrame {
    const empty = () => emptyDraft(this.iso());
    // R127: the state of each refused folder of this chat that has one now.
    const trust = this.trust.stateMap(entry.id);
    // R131: the state of each background session that a launch row of this chat printed and that has one now.
    const background = this.bg.attached(entry.id);
    return {
      t: "attached",
      chat: entry.id,
      epoch: this.epoch,
      state: this.shownState(entry),
      seq: entry.seq,
      cards: [...entry.cards.values()].map((c) => c.card),
      picks: this.picksOf(entry),
      title: entry.ledger.title ? { ...entry.ledger.title } : null,
      draft: entry.drafts.main.cur ?? empty(),
      sideDraft: entry.drafts.side.cur ?? empty(),
      archived: entry.ledger.archivedAt !== null,
      ...(trust ? { trust } : {}),
      ...(background ? { background } : {}),
      replay,
    };
  }

  detach(chat: string, viewer: Viewer): void {
    const entry = this.entries.get(chat);
    if (!entry) return;
    // Row 116: a page that leaves the chat (detach, a closed socket) no longer has it on screen (R131: nor a session's
    // line or view).
    entry.onScreen.delete(viewer);
    entry.bgViews.delete(viewer);
    if (!entry.viewers.delete(viewer)) return;
    this.reviewIdle(entry);
    this.pump();
  }

  /**
   * Row 116: a page's `on_screen`, a state report and never an action, taken only from a page that has the chat
   * attached. `on` marks the chat seen for every page (the ledger at once, a delta to every socket), and while it holds
   * a turn's end there is seen at once; `off` takes it back. An archived chat has no flag to clear: the report is only
   * noted, so it counts again after an Unarchive.
   */
  onScreen(chat: string, viewer: Viewer, on: boolean, background?: string): void {
    const entry = this.entries.get(chat);
    if (!entry || entry.deleted || entry.deleting || !entry.viewers.has(viewer)) return;
    // R131: one background session of the chat on screen (its line under the launch row, or its read-only view): that
    // session's end is seen, never the chat's. A page may have several sessions' lines on screen at once.
    if (background !== undefined) {
      const ids = entry.bgViews.get(viewer);
      if (!on) {
        ids?.delete(background);
        if (ids && ids.size === 0) entry.bgViews.delete(viewer);
        return;
      }
      if (!isBgId(background) || !this.bg.has(chat, background)) return;
      if (ids) ids.add(background);
      else entry.bgViews.set(viewer, new Set([background]));
      this.bg.seenView(chat, background);
      this.pushCall((p) => p.seenBg(chat, background));
      return;
    }
    if (!on) {
      entry.onScreen.delete(viewer);
      return;
    }
    entry.onScreen.add(viewer);
    // R131: the chat at its end does not see its sessions' ends: a session's line may be far up or folded out of sight,
    // so only its own line or view on screen does (FIX-R131 2).
    this.markSeen(entry);
    // R130: the chat on screen is seen for notifications too, also with no unseen flag (a card is not R116's flag).
    this.pushCall((p) => p.seen(chat));
  }

  /**
   * Row 116: the page's socket is heard again after more than WIRE.onScreenFreshMs with no frame (a phone that froze
   * its page, a link that stalled). Its frames come in order, so an `off` it sent meanwhile came first: an `on` it
   * still holds stands, and a turn that ended while its `on` did not count is seen now.
   */
  heardAgain(chat: string, viewer: Viewer): void {
    const entry = this.entries.get(chat);
    if (!entry || entry.deleted || entry.deleting || !entry.viewers.has(viewer)) return;
    // R131: a background session's line or view that it still has on screen sees that session's end now.
    for (const id of entry.bgViews.get(viewer) ?? []) {
      this.bg.seenView(chat, id);
      this.pushCall((p) => p.seenBg(chat, id));
    }
    if (!entry.onScreen.has(viewer)) return;
    this.markSeen(entry);
    this.pushCall((p) => p.seen(chat));
  }

  /** Row 116: no end waits to be seen any more (a page has the chat on screen, or Archive). */
  private markSeen(entry: Entry): void {
    if (entry.ledger.unseen === undefined || entry.ledger.archivedAt !== null) return;
    delete entry.ledger.unseen;
    void this.persist(entry);
    this.refresh(entry);
  }

  /**
   * Row 116: an end that no page has on screen now waits to be seen, for every page (`kind`; null: one that sets
   * nothing, a Stop or Restart now's cut). The newest end says how it went. Never on an archived chat. The ledger is
   * written at once; the caller's refresh sends the delta. R130: an end that sets the flag notifies, except at boot
   * (`notify` false: no page has had time to report, and the dots say it).
   */
  private markUnseen(entry: Entry, kind: Unseen | null, notify = true): void {
    if (kind === null || entry.deleted || entry.deleting || entry.ledger.archivedAt !== null) return;
    if (onScreenNow(entry.onScreen) || entry.ledger.unseen === kind) return;
    entry.ledger.unseen = kind;
    void this.persist(entry);
    if (notify) this.pushMoment(entry, { moment: kind });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Notifications (R130, server/push/notify.ts)

  /** One call of the notifications hook, if there is one; its failure never reaches the chat. */
  private pushCall(fn: (p: NonNullable<RegistryDeps["push"]>) => void): void {
    const p = this.deps.push;
    if (!p) return;
    try {
      fn(p);
    } catch {
      this.error("unknown", null);
    }
  }

  /**
   * R130: a moment of the chat (a card opens, a turn ended unseen) while no page has the chat on screen, never for an
   * archived or a deleted chat. The title goes with it for the devices with Show chat titles.
   */
  private pushMoment(entry: Entry, m: Pick<PushMomentInput, "moment" | "card" | "bg">): void {
    if (!this.deps.push || entry.deleted || entry.deleting || entry.ledger.archivedAt !== null || onScreenNow(entry.onScreen)) return;
    this.pushCall((p) => p.moment({ chat: entry.id, title: entry.ledger.title?.text ?? null, ...m }));
  }

  /**
   * R131 with R130: a background session that the chat started needs input, or ended while no page saw it (the book's
   * rule). No push while its chat is on screen anywhere (its bar's mark shows it), or while its line or view is.
   */
  private bgMoment(chat: string, id: string, kind: "needs" | "done" | "failed"): void {
    const entry = this.entries.get(chat);
    if (!entry || this.bgSeen(chat, id)) return;
    const moment: PushMoment = kind === "needs" ? "bg_needs" : kind === "done" ? "bg_done" : "bg_failed";
    this.pushMoment(entry, { moment, bg: { id, name: this.bg.workerOf(chat, id)?.name ?? null } });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Drafts (D49)

  /**
   * A `draft` frame from a page: no ack; every viewer, the sender included, gets the server's `draft` frame. `box:
   * "side"` (FIX-U2) is the side chat's box's draft, under the same rules (it has no uploads to check).
   */
  async draftEdit(frame: DraftEditFrame, tab: string | null): Promise<void> {
    const entry = this.entries.get(frame.chat);
    if (!entry || entry.deleting || entry.deleted || entry.ledger.archivedAt !== null) return;
    await this.updateDraft(entry, frame.box ?? "main", async (cur) => {
      let uploads = frame.uploads;
      if (uploads.length > 0) {
        const mine = new Set((await this.deps.store.listUploads(entry.id)).filter((u) => u.chat === entry.id).map((u) => u.id));
        uploads = uploads.filter((id) => mine.has(id));
      }
      const next = nextDraft(cur, { text: frame.text, mode: frame.mode, command: frame.command, link: frame.link, uploads, mentions: frame.mentions }, tab, this.iso());
      return next === cur ? null : next;
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Requests

  /** Apply one request frame. Never throws: an unexpected error is `failed`. */
  async request(frame: RequestFrame, ctx: RequestContext): Promise<Outcome> {
    try {
      if (frame.t === "new_chat") return await this.newChat(frame, ctx);
      if (frame.t === "continue_session") return await this.continueSession(frame);
      const entry = this.entries.get(frame.chat);
      if (!entry || entry.deleting || entry.deleted) return fail("not_found");
      switch (frame.t) {
        case "send":
          return await this.send(entry, frame, ctx);
        case "bash":
          return await this.bash(entry, frame, ctx);
        case "answer":
          return this.answer(entry, frame.card, frame.answer);
        case "interrupt":
          return await this.interrupt(entry, frame.turn);
        case "take_back":
          return await this.intake(entry, () => this.takeBack(entry, frame.uuid, ctx));
        case "send_now":
          return await this.sendNow(entry, frame.uuid);
        case "stop_task": {
          if (!this.caps.backgroundTasks) return fail("unsupported");
          const live = this.liveOf(entry);
          if (!live || !entry.seenTasks.has(frame.task)) return fail("stale");
          await live.chat.stopTask(frame.task);
          return ok(null);
        }
        case "background": {
          if (!this.caps.runInBackground) return fail("unsupported");
          const live = this.liveOf(entry);
          if (!live) return ok({ backgrounded: false });
          return ok({ backgrounded: await live.chat.runInBackground(frame.toolUse) });
        }
        case "set_model":
        case "set_effort":
        case "set_mode":
          return await this.intake(entry, () => this.setPick(entry, frame));
        case "reconnect_mcp": {
          if (!this.caps.connectors) return fail("unsupported");
          const live = this.liveOf(entry);
          if (!live) return fail("stale");
          await live.chat.reconnect(frame.server);
          return ok(null);
        }
        case "set_connector": {
          if (!this.caps.connectors) return fail("unsupported");
          const live = this.liveOf(entry);
          if (!live) return fail("stale");
          if ("alwaysAsk" in frame) return ok(await live.chat.setAlwaysAsk(frame.server, frame.alwaysAsk));
          await live.chat.setEnabled(frame.server, frame.enabled);
          return ok({ warning: null });
        }
        case "rename":
          return await this.rename(entry, frame.title);
        case "archive":
          return await this.archive(entry, frame.on, frame.stop, ctx);
        case "delete":
          return await this.remove(entry);
        case "get":
          return await this.get(entry, frame);
        case "send_queued":
          return await this.sendQueued(entry);
        case "end_here": // End it here and copy (S16)
          return this.endHere(entry);
        case "worktree": // W4, W5: the buttons under a refused start's line
          return await this.intake(entry, () => this.worktreeAct(entry, frame.act));
        case "side_question": // R124: the side chat (side.ts)
          return await this.sideQuestion(entry, frame, ctx);
        case "side_stop":
          return ok({ stopped: await this.side.stop(entry.id, frame.id) });
        case "side_clear": {
          const refused = this.composerRefusal(entry);
          if (refused) return fail(refused);
          return (await this.side.clear(entry.id)) ? ok(null) : fail("busy");
        }
        case "trust_folder": // R127: Trust this folder (trust.ts)
          return await this.trustFolder(entry, frame);
        case "background_stop": // R131: Stop a background session that this chat started (background.ts)
          return await this.backgroundStop(entry, frame);
      }
    } catch (e) {
      const code = driverErrorCode(e);
      if (code === "failed") this.error("unknown", "chat" in frame ? frame.chat : null);
      return fail(code);
    }
  }

  /**
   * The restart's drain (4.10 step 3, build checklist S9, L7; drain.ts runs the restart around it): no new turn starts.
   * A send is held, Queued, in its chat's queue file and never given to Claude Code (setQueueOnly); a `!` command, a new
   * chat, Send again and End it here get `restarting`. Every chat gives its process up as one whose session another
   * app opens (row 78's giveUp): it ends at its next quiet moment, so a running turn is never cut and a card waits for
   * its answer, and what waits in Claude Code's own queue comes back to kitespan's. The check of the other apps'
   * sessions waits with it. With `now` the close (shutdown with `interrupt`) follows at once. `restarting` once a close
   * runs.
   */
  drain(_when: RestartWhen): DrainAnswer {
    if (this.draining) return { ok: false, code: "restarting" };
    if (this.restartDrain) return { ok: true };
    this.restartDrain = true;
    this.setQueueOnly(true);
    if (this.openTimer) clearInterval(this.openTimer);
    this.openTimer = null;
    for (const e of this.entries.values()) {
      if (e.deleted || e.deleting) continue;
      this.giveUp(e);
      this.refresh(e);
    }
    this.pump();
    return { ok: true };
  }

  /**
   * Cancel restart (L14): work again. The chats that gave their process up only for the drain keep it, the held
   * messages go as at a hold's end (sendWaiting), and the check of the other apps' sessions runs again. False when no
   * drain waits (none, or its close runs).
   */
  undrain(): boolean {
    if (!this.restartDrain || this.draining) return false;
    this.restartDrain = false;
    this.setQueueOnly(false);
    for (const e of this.entries.values()) {
      if (e.deleted || e.deleting || e.held || !e.yielding || e.phase !== "live" || e.live?.closing) continue;
      e.yielding = false;
      this.nextBash(e);
      this.refresh(e);
    }
    this.sendWaiting();
    this.watchOpen();
    this.pump();
    return true;
  }

  /**
   * S9: every chat sleeps (no claude process of a chat starts, runs or ends now, and no orphan of kitespan's own still
   * runs a turn), so the restart's close may run.
   */
  asleep(): boolean {
    if (this.liveCount() > 0) return false;
    for (const e of this.entries.values()) if (this.orphanRuns(e)) return false;
    return true;
  }

  /**
   * S13: the restart did not happen (its successor failed after the close): work again, as after Cancel. Each chat
   * that the close cut gets its stop line now (it would have at the next boot), what the queue files hold comes back,
   * and the held messages go.
   */
  async reopen(): Promise<void> {
    this.draining = false;
    this.restartDrain = false;
    this.setQueueOnly(false);
    // R131: the background sessions' book reads again.
    this.bg.reopen();
    // What Restart now cut: its line says that the restart did not happen (also for a chat whose orphan ends later).
    for (const e of this.entries.values()) if (e.ledger.stop?.by === "restart") e.ledger.stop = { ...e.ledger.stop, by: "restart_failed" };
    await Promise.all(
      [...this.entries.values()].map((e) => {
        if (e.deleted || e.deleting) return null;
        if (e.orphan) return void this.watchOrphanOnce(e, e.orphan);
        return this.intake(e, () => this.afterBoot(e, false));
      }),
    );
    this.sendWaiting();
    this.watchOpen();
    this.pump();
  }

  /**
   * S11: the claude processes of this server's chats that may still live, each with its start time (so a pid that the
   * system gave again never counts): every live chat's, and every one noted since that has not been seen gone.
   */
  async claudeProcs(): Promise<LedgerProc[]> {
    for (const e of this.entries.values()) {
      const pid = e.live?.chat.pid ?? null;
      if (pid !== null && !this.ownProcs.has(pid)) {
        const start = await this.procs.startOf(pid);
        if (start !== null) this.ownProcs.set(pid, start);
      }
    }
    const out: LedgerProc[] = [];
    for (const [pid, start] of [...this.ownProcs]) {
      if (await procLives(this.procs, { pid, start })) out.push({ pid, start });
      else this.ownProcs.delete(pid);
    }
    // kitespan's own orphans of a server before this one (R16), each with its recorded start.
    for (const e of this.entries.values()) if (e.orphan && !out.some((p) => p.pid === e.orphan!.pid) && (await procLives(this.procs, e.orphan))) out.push({ ...e.orphan });
    return out;
  }

  /**
   * SIGTERM or SIGINT: start no new turn, close every live chat, wait about 8 s at most, write every ledger. Each chat
   * whose turn, start or card the close cuts gets its stop (D32; `by` "restart" for Restart now's words). `interrupt`
   * (Restart now, S10): a busy chat is interrupted first, as Stop and archive does.
   */
  async shutdown(opts: { by?: "shutdown" | "restart"; interrupt?: boolean } = {}): Promise<void> {
    this.draining = true;
    if (this.openTimer) clearInterval(this.openTimer);
    this.openTimer = null;
    for (const req of this.capQueue.splice(0)) req.settle("gone");
    // R124: a side question in flight does not finish (its thread says so before the store's last write).
    this.side.abortAll("shutdown");
    // R127: a trust start in flight ends too (it answers failed); endReads below waits for its process.
    this.trust.abortAll();
    // R131: no list read of the background sessions starts any more.
    this.bg.close();
    const ends: Promise<void>[] = [this.side.idle()];
    const at = this.iso();
    for (const e of this.entries.values()) {
      this.clearIdle(e);
      e.bashRunning?.abort.abort();
      const stop = e.deleted || e.deleting ? null : cutStop(this.computeState(e), opts.by ?? "shutdown", at);
      if (stop) e.ledger.stop = stop;
      if (e.live) ends.push(this.endChat(e, { interrupt: opts.interrupt === true && this.isBusy(e), cut: opts.interrupt === true }));
      // Restart now stops kitespan's own orphan's turn too, as Stop does (R16); a plain shutdown leaves it to finish, and
      // the next server holds the chat again while it does.
      if (opts.interrupt === true && e.orphan && this.orphanRuns(e)) {
        e.ledger.stop = { why: "running", by: opts.by ?? "shutdown", at };
        ends.push(endOrphan(this.procs, e.orphan, this.deps.orphanGraceMs ?? ORPHAN_GRACE_MS).then(() => undefined));
      }
    }
    // R17: a short read in flight (D59, row 81) ends too, so no claude of this server outlives the close.
    ends.push(this.deps.driver.endReads().catch(() => {}));
    // W3: a new chat's worktree in the making is discarded once its add ends (makeWorktree sees the close).
    for (const m of this.making) ends.push(m.then(() => undefined, () => undefined));
    await within(Promise.all(ends), this.opts.shutdownMs ?? 8_000);
    // U1: the end marks of the turns that this close ended (Restart now's cut) are kept before the server goes.
    if (this.deps.changes) await within(this.deps.changes.idle(), 2_000);
    // What waited for a start never runs now. A message stays Queued in its queue file, so the next server shows it Not
    // sent (L6); a `!` command keeps its row as Not run and goes back to an empty box (L5), and its id counts as
    // applied, so a resend after the restart is not applied a second time (4.3).
    for (const e of this.entries.values()) {
      if (e.waiting.length === 0 || e.deleted || e.deleting) continue;
      this.unqueue(e);
      const back = this.takeBackAll(e, this.shutdownSplit(e, e.waiting));
      for (const j of back.jobs) this.remember(e.made, j.uuid);
      void this.returnToDraft(e, [], null, back.jobs);
    }
    await Promise.all([...this.entries.values()].filter((e) => !e.deleted).map((e) => this.persist(e)));
    // A card that the close lost and a `!` command that never ran are in the notes, and what waits is in its queue
    // file, before the drafts and the notes are written.
    await Promise.all([...this.entries.values()].map((e) => Promise.all([e.drafts.main.chain, e.drafts.side.chain, e.notesChain, e.queue.idle()])));
    await this.deps.store.flush().catch(() => this.error("store_write", null));
  }

  /** D60: the project's variables changed (the env route dropped what it kept): its model list forgets its reads. */
  envChanged(project: string): void {
    this.models.forget(project);
  }

  /**
   * Settings > Account (6.8): the provider that a live chat's Claude Code reports (`accountInfo().apiProvider`), with
   * null when it reports none. Null when no chat is live (the row reads "Start a chat to read it"). D60: `project` is
   * the Settings' project (null: the host's); a project with variables gets only its own chats' provider, and the
   * others only that of a chat in a project with none. A chat that runs with its variables' old values answers none.
   */
  async account(project: string | null = null): Promise<{ provider: string | null } | null> {
    const own = project !== null && this.models.own(project);
    for (const e of this.entries.values()) {
      const live = this.liveOf(e);
      if (!live || !this.envNow(e, live)) continue;
      if (own ? e.ledger.project !== project : this.models.own(e.ledger.project)) continue;
      try {
        const read = await live.chat.account();
        this.kept.account(e.ledger.project, read);
        return read;
      } catch {
        // the next live chat may answer
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Send, the queue and Take back

  private async send(entry: Entry, frame: SendFrame, ctx: RequestContext): Promise<Outcome> {
    // R124: `/btw` is the side chat's (side_question), never a prompt: Claude Code would only answer that it is not here.
    if (btwQuestion(frame.text) !== null) return fail(this.caps.sideQuestions ? "bad_request" : "unsupported");
    const draftAtArrival = entry.drafts.main.cur;
    const step = await this.intake(entry, async (): Promise<Outcome | { msg: PendingMsg; start: Promise<StartResult> | null; kept?: true }> => {
      const refused = this.composerRefusal(entry);
      if (refused) return fail(refused);
      if (entry.made.has(frame.uuid) || entry.pending.has(frame.uuid)) return ok({ queued: entry.pending.get(frame.uuid)?.where === "cap" });
      if (await this.heldNow(entry)) return fail("session_held");
      const paths = await this.uploadPaths(entry.id, frame.uploads);
      if (!paths) return fail("upload_gone");
      const mentions = frame.mentions ?? [];
      const mentioned = await mentionPaths(entry.ledger.cwd, mentions);
      if (!mentioned) return fail("mention_gone");
      const again = this.composerRefusal(entry) ?? (entry.held ? "session_held" : null);
      if (again) return fail(again);
      const msg: PendingMsg = {
        uuid: frame.uuid,
        text: withUploadRefs(frame.text, [...paths, ...mentioned], "message"),
        userText: frame.text,
        uploads: [...frame.uploads],
        mentions: [...mentions],
        where: "cap",
        announced: false,
      };
      // RD-8 (R11): a message that will wait is in the chat's queue file before Claude Code or the ack has it.
      if (this.queueOnly || entry.phase !== "live" || entry.yielding || this.waitsBehind(entry)) {
        const note = this.noteOf(msg);
        if (!entry.queue.fits(note)) return fail("queue_full");
        if (!(await entry.queue.add(note))) return fail("failed");
        const late = this.composerRefusal(entry) ?? (entry.held ? "session_held" : null);
        if (late) {
          await entry.queue.drop([msg.uuid]);
          return fail(late);
        }
      }
      // The restored messages go first, in order (R13).
      this.unmarkNotSent(entry);
      if (this.queueOnly) {
        entry.waiting.push({ kind: "send", msg });
        entry.pending.set(msg.uuid, msg);
        return { msg, start: null, kept: true };
      }
      if (entry.phase === "live" && !entry.yielding) {
        this.submit(entry, { kind: "send", msg });
        return { msg, start: null };
      }
      entry.waiting.push({ kind: "send", msg });
      entry.pending.set(msg.uuid, msg);
      return { msg, start: this.requestStart(entry) };
    });
    if ("ok" in step) return step;
    let queued = false;
    // The drain holds it, Queued, and gives it to no Claude Code (setQueueOnly).
    if (step.kept) {
      queued = true;
      step.msg.announced = true;
      this.announce(entry, step.msg, true);
    }
    if (step.start) {
      const r = await step.start;
      // Waiting for a free slot, or for the other app to close the session (row 78): Queued on every page.
      if (r === "queued" || r === "held") {
        queued = true;
        if (!step.msg.announced) {
          step.msg.announced = true;
          this.announce(entry, step.msg, true);
        }
        if (r === "queued") this.capNotice(entry);
      } else if (r !== "started") {
        // The failed start took it out of what waits; its page keeps the text (the ack fails).
        await entry.queue.drop([step.msg.uuid]);
        return fail(this.startError(entry, r));
      }
    }
    await this.clearDraftAfterSend(entry, "main", ctx.tab, frame.draftRev, draftAtArrival);
    this.setFirstPromptTitle(entry, frame.text);
    // The message's id is in the ledger before its ack goes out (4.3: a resend after a restart is not applied again).
    if (entry.made.has(frame.uuid)) await entry.writeChain;
    return ok({ queued });
  }

  /**
   * Put one message on the live chat's input and show it to every viewer (D49, live L2: the CLI does not echo it). Its
   * mention paths go into the notes before any history read can start, also an empty list, so history gives the
   * transcript's copy of the message (under the same uuid) the same paths as the live event (9.3).
   */
  private deliver(entry: Entry, msg: PendingMsg): void {
    const live = entry.live!;
    this.remember(entry.made, msg.uuid);
    void this.persist(entry);
    this.note(entry, (n) => (n.mentions ??= []).push({ uuid: msg.uuid, paths: [...msg.mentions] }));
    const startsTurn = entry.turn === null;
    // U1: the turn's start mark comes first; the message goes on the input once it is taken (at most 3 s).
    if (startsTurn) this.turnStart(entry, "user");
    this.toInput(entry, startsTurn ? (entry.marks?.ready ?? null) : null, () => live.chat.send({ uuid: msg.uuid, text: msg.text }));
    if (!live.firstEvent) (live.unseen ??= []).push(msg);
    // A restored message (R12) goes now: Not sent goes from every page.
    const wasNotSent = msg.notSent === true;
    msg.notSent = false;
    if (!msg.announced || startsTurn || wasNotSent) this.announce(entry, msg, !startsTurn);
    msg.announced = true;
    if (startsTurn) entry.pending.delete(msg.uuid);
    else {
      msg.where = "cli";
      entry.pending.set(msg.uuid, msg);
      // Row 111: in Claude Code's queue again (after a hold or the restart's drain held it back): a press acts for it.
      entry.sendNow.pressed.delete(msg.uuid);
    }
    this.touch(entry, true);
  }

  /**
   * What a live chat gets (a send, a `!` command, or what waited for its start), in the order sent: a message sent
   * while a command waits or runs waits behind it in the server, Queued on every page (6.3).
   */
  private submit(entry: Entry, w: Waiting): void {
    if (w.kind === "bash") return this.deliverBash(entry, w.job);
    if (!entry.bashRunning && entry.bashQueue.length === 0) return this.deliver(entry, w.msg);
    const msg = w.msg;
    msg.where = "bash";
    entry.pending.set(msg.uuid, msg);
    entry.bashQueue.push(w);
    const wasNotSent = msg.notSent === true;
    msg.notSent = false;
    if (!msg.announced || wasNotSent) this.announce(entry, msg, true);
    msg.announced = true;
    this.touch(entry, true);
  }

  /** A message's `user` event to every page; the message keeps it while it waits (see `dropped`). */
  private announce(entry: Entry, msg: PendingMsg, queued: boolean): void {
    msg.item = this.emit(entry, userEvent(msg, queued));
  }

  /** A message of this chat waits in Claude Code's own queue: the CLI starts its turn before anything sent after it. */
  private cliQueued(entry: Entry): boolean {
    for (const m of entry.pending.values()) if (m.where === "cli") return true;
    return false;
  }

  /** The oldest messages in Claude Code's queue that a turn started on: their Queued label goes. */
  private consumeQueued(entry: Entry, uuids: readonly string[] | null): void {
    const picked: PendingMsg[] = [];
    if (uuids === null) {
      for (const m of entry.pending.values())
        if (m.where === "cli" && !m.read) {
          picked.push(m);
          break;
        }
    } else for (const u of uuids) {
      const m = entry.pending.get(u);
      if (m && m.where === "cli") picked.push(m);
    }
    for (const m of picked) {
      entry.pending.delete(m.uuid);
      if (!m.read) this.announce(entry, m, false);
    }
  }

  /** Row 111: the messages in Claude Code's queue that Claude has not taken in, in send order. */
  private cliWaiting(entry: Entry): string[] {
    const out: string[] = [];
    for (const m of entry.pending.values()) if (m.where === "cli" && !m.read) out.push(m.uuid);
    return out;
  }

  /** Row 111: Claude took these queued messages into the running turn at a tool boundary: their Queued label goes. */
  private markRead(entry: Entry, uuids: readonly string[]): void {
    for (const u of uuids) {
      const m = entry.pending.get(u);
      if (!m || m.where !== "cli" || m.read) continue;
      m.read = true;
      this.announce(entry, m, false);
    }
  }

  /**
   * Row 111, at a turn's end, after what it lists went: a message drawn as taken in that the end does not list still
   * waits (Claude Code lists each message that it took in), so it is Queued again; with no list from Claude Code, it
   * went with the turn.
   */
  private settleRead(entry: Entry, listed: readonly string[]): void {
    for (const m of [...entry.pending.values()]) {
      if (!m.read) continue;
      if (listed.length === 0) {
        entry.pending.delete(m.uuid);
        continue;
      }
      m.read = false;
      this.announce(entry, m, true);
    }
  }

  private async takeBack(entry: Entry, uuid: string, ctx: RequestContext): Promise<Outcome> {
    const msg = entry.pending.get(uuid);
    if (!msg) return ok({ cancelled: false });
    if (msg.where === "cli" && !this.caps.takeBack) return fail("unsupported");
    const draft = await this.loadDraft(entry, "main");
    // 6.3: while the message box holds a `!` or `/` command, Take back takes nothing back.
    if (draft.mode !== "chat") return fail("bad_request");
    if (msg.where === "cli") {
      const live = this.liveOf(entry);
      if (!live) return ok({ cancelled: false });
      // U1: a message that still waits for a start mark before it reaches Claude Code's queue first.
      if (entry.inputWait) await entry.inputWait;
      const r = await live.chat.takeBack(uuid);
      if (!r.cancelled) return ok({ cancelled: false });
    } else if (msg.where === "bash") {
      entry.bashQueue = entry.bashQueue.filter((w) => !(w.kind === "send" && w.msg === msg));
    } else {
      entry.waiting = entry.waiting.filter((w) => !(w.kind === "send" && w.msg === msg));
      if (entry.waiting.length === 0) this.unqueue(entry);
    }
    entry.pending.delete(uuid);
    this.emit(entry, { k: "taken_back", uuid });
    // A command that waited behind that message in Claude Code's queue may run now.
    this.nextBash(entry);
    await this.returnToDraft(entry, [msg], ctx.tab);
    await entry.queue.drop([uuid]);
    return ok({ cancelled: true });
  }

  // -------------------------------------------------------------------------------------------------------------
  // `!` commands (D10, D20)

  private async bash(entry: Entry, frame: BashFrame, ctx: RequestContext): Promise<Outcome> {
    if (!this.deps.bash) return fail("unsupported");
    const draftAtArrival = entry.drafts.main.cur;
    const step = await this.intake(entry, async (): Promise<Outcome | { job: BashJob; start: Promise<StartResult> | null }> => {
      const refused = this.composerRefusal(entry) ?? this.drainRefusal();
      if (refused) return fail(refused);
      // The command ran already (its ack was lost, maybe before a restart): it never runs twice (4.3).
      if (entry.made.has(frame.rid)) return ok(null);
      if (await this.heldNow(entry)) return fail("session_held");
      const paths = await this.uploadPaths(entry.id, frame.uploads);
      if (!paths) return fail("upload_gone");
      const mentions = frame.mentions ?? [];
      const mentioned = await mentionPaths(entry.ledger.cwd, mentions);
      if (!mentioned) return fail("mention_gone");
      const again = this.composerRefusal(entry) ?? this.drainRefusal() ?? (entry.held ? "session_held" : null);
      if (again) return fail(again);
      const job: BashJob = {
        uuid: frame.rid,
        input: withUploadRefs(frame.input, [...paths, ...mentioned], "bash"),
        userInput: frame.input,
        uploads: [...frame.uploads],
        mentions: [...mentions],
        abort: new AbortController(),
        announced: false,
      };
      if (entry.phase === "live" && !entry.yielding) {
        this.submit(entry, { kind: "bash", job });
        return { job, start: null };
      }
      entry.waiting.push({ kind: "bash", job });
      return { job, start: this.requestStart(entry) };
    });
    if ("ok" in step) return step;
    if (step.start) {
      const r = await step.start;
      if (r === "queued" || r === "held") {
        if (!step.job.announced) {
          step.job.announced = true;
          this.showBash(entry, step.job, "queued");
        }
        if (r === "queued") this.capNotice(entry);
      } else if (r !== "started") return fail(this.startError(entry, r));
    }
    await this.clearDraftAfterSend(entry, "main", ctx.tab, frame.draftRev, draftAtArrival);
    if (entry.made.has(frame.rid)) await entry.writeChain;
    return ok(null);
  }

  private bashEvent(job: BashJob, state: "queued" | "running" | "not_run"): ChatEvent {
    return { k: "bash", uuid: job.uuid, input: job.input, state, stdout: "", stderr: "", code: null, ms: null, timedOut: false, capped: false };
  }

  /** A `!` row's event to every page; the job keeps it while it waits or runs (see `dropped`). */
  private showBash(entry: Entry, job: BashJob, state: "queued" | "running" | "not_run"): void {
    job.item = this.emit(entry, this.bashEvent(job, state));
  }

  /**
   * Typed during a turn, a command waits as Queued and runs after the turn (6.4); commands run one at a time, in the
   * order sent, and after every message that is ahead of them in Claude Code's queue (see nextBash).
   */
  private deliverBash(entry: Entry, job: BashJob): void {
    if (entry.turn || entry.bashRunning || entry.bashQueue.length > 0 || this.cliQueued(entry)) {
      entry.bashQueue.push({ kind: "bash", job });
      if (!job.announced) this.showBash(entry, job, "queued");
      job.announced = true;
      return;
    }
    void this.runBash(entry, job);
  }

  /**
   * Go on with what waits behind a `!` command, in the order sent. A command runs once no turn runs and no message is
   * ahead of it in Claude Code's queue: at a turn's end, the CLI starts a queued message's turn at once, and a command
   * run then would run during that turn and reach the transcript after its reply. A message goes on Claude Code's
   * input once every command ahead of it has put its record there.
   */
  private nextBash(entry: Entry): void {
    // A process that gives its session up (row 78) takes nothing more: what waits goes to the next start.
    if (entry.bashRunning || entry.phase !== "live" || entry.yielding) return;
    while (entry.bashQueue.length > 0) {
      const head = entry.bashQueue[0]!;
      if (head.kind === "send") {
        entry.bashQueue.shift();
        this.deliver(entry, head.msg);
        continue;
      }
      if (entry.turn || this.cliQueued(entry)) return;
      entry.bashQueue.shift();
      void this.runBash(entry, head.job);
      return;
    }
  }

  private async runBash(entry: Entry, job: BashJob): Promise<void> {
    const runner = this.deps.bash;
    if (!runner) return;
    const live = entry.live;
    entry.bashRunning = job;
    job.announced = true;
    this.remember(entry.made, job.uuid);
    void this.persist(entry);
    this.showBash(entry, job, "running");
    this.refresh(entry);
    let res: BashResult;
    // U1 review: the command's run window, for the changes summaries of other chats' turns in this folder.
    const ran = this.deps.changes?.command(entry.id, entry.ledger.cwd);
    try {
      // D60 (L38): the live chat's start set, as a `!` inside Claude Code would have it.
      res = await runner.run({ command: job.input, cwd: entry.ledger.cwd, signal: job.abort.signal, env: live?.env ?? [] });
    } catch {
      this.error("bash_spawn", entry.id);
      res = { stdout: "", stderr: "", code: null, ms: 0, timedOut: false, capped: false };
    } finally {
      ran?.();
    }
    if (entry.deleted) {
      if (entry.bashRunning === job) entry.bashRunning = null;
      return;
    }
    const stdout = capText(res.stdout, LIMITS.bashOutput);
    const stderr = capText(res.stderr, LIMITS.bashOutput);
    const capped = res.capped || stdout.length < res.stdout.length || stderr.length < res.stderr.length;
    this.emit(entry, { k: "bash", uuid: job.uuid, input: job.input, state: "done", stdout, stderr, code: res.code, ms: res.ms, timedOut: res.timedOut, capped });
    this.log("bash", { chat: entry.id, code: res.code, ms: res.ms, timeout: res.timedOut, capped });
    // The command still counts as running until its record is on the input (the idle rule and the cap wait for it).
    if (live && entry.live === live && entry.phase === "live" && !job.abort.signal.aborted) {
      const reply = await this.bashReply(entry);
      if (entry.live === live) {
        // Claude Code writes the record under an id of its own (a live check found the host's uuid in no transcript),
        // so the notes keep the row's uuid with a digest of its content, and history gives the record that uuid. The
        // record holds no exit code or duration: the note keeps them, so history draws the row as it was drawn live.
        const digest = bashDigest(job.input, stdout, stderr);
        const note = { uuid: job.uuid, digest, code: res.code, ms: Math.max(0, Math.round(res.ms)), timedOut: res.timedOut, capped };
        this.note(entry, (n) => n.bash.push(note));
        // Claude replies to the output: that turn starts now, as a message's does (Stop, the queue, the idle rule), and
        // (U1) the record waits for its start mark.
        const startsTurn = reply && entry.turn === null && entry.phase === "live";
        if (startsTurn) this.turnStart(entry, "user", job.uuid);
        this.toInput(entry, startsTurn ? (entry.marks?.ready ?? null) : null, () => live.chat.bashRecord({ uuid: job.uuid, input: job.input, stdout, stderr, reply }));
      }
    }
    if (entry.bashRunning === job) entry.bashRunning = null;
    this.nextBash(entry);
    this.refresh(entry);
  }

  /**
   * D10: whether Claude replies to the output (Settings > Chats, else the user's own `respondToBashCommands`, read in
   * the folder whose settings the chat's Claude Code uses: its project's for its own worktree, G3).
   */
  private async bashReply(entry: Entry): Promise<boolean> {
    const pick = this.settings["chats.bashReply"];
    if (pick === "always") return true;
    if (pick === "never") return false;
    try {
      return (await this.deps.driver.settings(configFolder(entry.ledger))).respondToBash;
    } catch {
      return true;
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Cards (4.1 "Cards live in memory")

  private cardHost(entry: Entry, gen: number): CardHost {
    return { ask: (card, signal) => this.ask(entry, gen, card, signal) };
  }

  private ask(entry: Entry, gen: number, card: Card, signal: AbortSignal): Promise<CardAnswer | null> {
    if (entry.live?.gen !== gen || entry.phase !== "live" || signal.aborted || entry.deleted) return Promise.resolve(null);
    return new Promise((resolve) => {
      const capped = (capEvent({ k: "card_open", card }) as ChatEventOf<"card_open">).card;
      if (entry.cards.has(capped.id)) this.closeCard(entry, capped.id, null, "cancelled");
      const open: OpenCard = { card: capped, resolve, after: "toolUseId" in capped ? capped.toolUseId : null };
      entry.cards.set(capped.id, open);
      // The driver's own reasons (CARD_ABORT) say whether the process ended (lost) or the user finished the card
      // elsewhere (a URL-mode elicitation: answered); any other abort is Claude Code withdrawing the request.
      signal.addEventListener("abort", () => {
        if (entry.cards.get(capped.id) !== open) return;
        if (signal.reason === CARD_ABORT.ended) this.closeCard(entry, capped.id, null, "lost");
        else if (signal.reason === CARD_ABORT.completed && capped.kind === "elicitation") this.closeCard(entry, capped.id, { kind: "elicitation", action: "accept" }, "answered");
        else this.closeCard(entry, capped.id, null, "cancelled");
      }, { once: true });
      this.emit(entry, { k: "card_open", card: capped });
      // U1 review: a permission card holds its call: the call's run window shuts until the Allow (changes/activity.ts).
      if (entry.marks) this.deps.changes?.note(entry.marks, { k: "card_open", card: capped });
      this.refresh(entry);
      // R130: Claude needs you: the card's own path opens with the push (it focuses the card and answers nothing).
      this.pushMoment(entry, { moment: capped.kind === "permission" ? "permission" : "input", card: { kind: capped.kind, id: capped.id } });
    });
  }

  /** The card closes for every page, with how it closed; the notes keep it for history (5.4). */
  private closeCard(entry: Entry, id: string, answer: CardAnswer | null, why: "answered" | "cancelled" | "lost"): boolean {
    const open = entry.cards.get(id);
    if (!open) return false;
    entry.cards.delete(id);
    open.resolve(answer);
    const close = cardClose(open.card, answer, why);
    // U1 review: an Allow opens the call's run window again, before the call runs (the answer's own microtask).
    if (entry.marks) this.deps.changes?.note(entry.marks, close);
    if (!entry.deleted) {
      this.emit(entry, close);
      const card = noteCard(open.card);
      const after = open.after ?? this.callOf(entry, open.card);
      this.note(entry, (n) => n.cards.push({ card, close, after }));
    }
    this.refresh(entry);
    return true;
  }

  /**
   * The call that an elicitation or a dialog came in (it has no tool use of its own), found when it closes, since the
   * call waits for it: the newest open call of the elicitation's MCP server (`mcp__<server>__<tool>`), else the newest
   * open call, else none.
   */
  private callOf(entry: Entry, card: Card): string | null {
    const calls = [...entry.openCalls].reverse();
    if (card.kind === "elicitation") {
      const prefix = `mcp__${card.server.replace(/[^A-Za-z0-9_-]/g, "_")}__`;
      const own = calls.find(([, c]) => c.name.startsWith(prefix));
      if (own) return own[0];
    }
    return calls[0]?.[0] ?? null;
  }

  /** The first answer wins; a second, or one for a closed card, gets `stale` (D49). */
  private answer(entry: Entry, cardId: string, a: CardAnswer): Outcome {
    const open = entry.cards.get(cardId);
    if (!open) return fail("stale");
    const card = open.card;
    if (a.kind !== card.kind) return fail("bad_request");
    if (card.kind === "permission" && a.kind === "permission" && a.allow && a.scope === "session" && (card.suppressAlwaysAllowRule || !card.sessionRule))
      return fail("bad_request");
    if (a.kind === "plan" && a.approve && a.mode === "bypassPermissions" && !this.settings["chats.allowBypass"]) return fail("bad_request");
    this.closeCard(entry, cardId, capAnswer(a), "answered");
    this.touch(entry, true);
    return ok(null);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Stop

  /** Stop: open cards are dismissed, then `interrupt()`; queued messages stay queued (Stop keeps the queue). */
  private async interrupt(entry: Entry, turnSeq: number): Promise<Outcome> {
    // Stop on a chat held as `finishing` (turn 0) ends kitespan's own orphan (R16).
    if (turnSeq === 0 && entry.orphan) return this.stopOrphan(entry, entry.orphan);
    const turn = entry.turn;
    const live = this.liveOf(entry);
    if (!turn || !live || turn.seq !== turnSeq || turn.interrupted) return fail("stale");
    return ok({ stillQueued: (await this.stopTurn(entry, live)).stillQueued });
  }

  /** Stop's steps on the running turn: it ends as interrupted on every page, its cards are dismissed, the queue stays. */
  private stopTurn(entry: Entry, live: Live): Promise<{ stillQueued: string[] | null }> {
    entry.turn!.interrupted = true;
    for (const id of [...entry.cards.keys()]) this.closeCard(entry, id, null, "cancelled");
    this.touch(entry, true);
    // U1: a message that waits for its turn's start mark goes first, so the interrupt reaches the turn it started.
    const wait = entry.inputWait;
    return wait ? wait.then(() => live.chat.interrupt()) : live.chat.interrupt();
  }

  /**
   * Row 111 Send now (send-now.ts): one press, read in order after the chat's other actions (a Ctrl+Enter's send is in
   * the queue first), on what waits now; the wait for a Bash call's task runs outside that order. A press whose message
   * waits no more, or one on messages that a press acted on, does nothing; so does one while a press runs. After a wait
   * the same checks run again before it acts: a Take back, a hold or the restart's drain (giveUp takes what waits in
   * Claude Code's queue back to the server's) leaves it nothing to act on, and the drain's turn is never cut.
   */
  private async sendNow(entry: Entry, uuid: string): Promise<Outcome> {
    const watch = entry.sendNow;
    // A message waits for the running turn: in Claude Code's queue and not taken in, or behind a `!` command.
    const waits = (m: PendingMsg) => entry.pending.get(m.uuid) === m && ((m.where === "cli" && !m.read) || m.where === "bash");
    const press = await this.intake(entry, async () => {
      const live = this.liveOf(entry);
      const turn = entry.turn;
      if (!live || !turn || turn.interrupted || entry.yielding || watch.acting) return null;
      const msgs = [...entry.pending.values()].filter(waits);
      if (!msgs.some((m) => m.uuid === uuid)) return null;
      for (const u of [...watch.pressed]) if (!msgs.some((m) => m.uuid === u)) watch.pressed.delete(u);
      if (msgs.every((m) => watch.pressed.has(m.uuid))) return null;
      for (const m of msgs) watch.pressed.add(m.uuid);
      watch.acting = true;
      return { live, turn, msgs };
    });
    if (!press) return ok({ acted: "none" });
    const { live, turn, msgs } = press;
    try {
      const acted = await sendNowAct({
        watch,
        behindCommand: msgs.some((m) => m.where === "bash"),
        canBackground: this.caps.backgroundTasks,
        cardFor: (id) => [...entry.cards.values()].some((c) => "toolUseId" in c.card && c.card.toolUseId === id),
        stillWaiting: () => entry.live === live && entry.turn === turn && !turn.interrupted && !entry.yielding && msgs.some(waits),
        background: () => (entry.live === live ? live.chat.backgroundAll() : Promise.resolve(false)),
        interrupt: async () => {
          if (entry.live !== live || entry.turn !== turn || turn.interrupted) return false;
          await this.stopTurn(entry, live);
          return true;
        },
        waitMs: this.opts.sendNowWaitMs ?? SEND_NOW_WAIT_MS,
      });
      return ok({ acted });
    } catch (e) {
      for (const m of msgs) watch.pressed.delete(m.uuid);
      throw e;
    } finally {
      watch.acting = false;
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Pickers (6.6, D11, D12)

  private async setPick(entry: Entry, frame: Extract<RequestFrame, { t: "set_model" | "set_effort" | "set_mode" }>): Promise<Outcome> {
    if (entry.ledger.archivedAt !== null) return fail("archived");
    const at = this.now();
    const live = this.liveOf(entry);
    const picks: LedgerPicks = { ...entry.ledger.picks };
    if (frame.t === "set_model") {
      if (!this.caps.models) return fail("unsupported");
      if (live) await live.chat.setModel(frame.value);
      picks.model = frame.value === null ? null : { value: frame.value, mark: markOf(MARK_PHRASES.pick, at) };
      await this.rememberPick(entry, "model", frame.value, at);
    } else if (frame.t === "set_effort") {
      if (!this.caps.effort) return fail("unsupported");
      if (live) await live.chat.setEffort(frame.value);
      picks.effort = frame.value === null ? null : { value: frame.value, mark: markOf(MARK_PHRASES.pick, at) };
      await this.rememberPick(entry, "effort", frame.value, at);
    } else {
      const v = frame.value;
      if (v !== null && !this.caps.modes.includes(v)) return fail("unsupported");
      if (v === "bypassPermissions" && !this.settings["chats.allowBypass"]) return fail("bad_request");
      if (live) await live.chat.setMode(v ?? (await this.defaultMode(entry)));
      if (v === "plan") entry.modeOverride = "plan";
      else {
        entry.modeOverride = null;
        picks.permissionMode = v === null ? null : { value: v, mark: markOf(MARK_PHRASES.pick, at) };
        await this.rememberPick(entry, "permissionMode", v, at);
      }
    }
    entry.ledger.picks = picks;
    this.touch(entry, true);
    void this.persist(entry);
    return ok(null, () => {
      if (!entry.deleted) this.emit(entry, { k: "picks", ...this.picksOf(entry) });
    });
  }

  /** The mode a "back to the default" pick means on a live chat: the user's own `defaultMode` (G3), else Manual. */
  private async defaultMode(entry: Entry): Promise<ModeId> {
    try {
      const m = (await this.deps.driver.settings(configFolder(entry.ledger))).defaultMode;
      return m !== null && isMode(m) && m !== "bypassPermissions" ? m : "default";
    } catch {
      return "default";
    }
  }

  /** A pick is remembered per folder for new chats, except Plan (D11); a mode only while Remember mode is on. */
  private async rememberPick(entry: Entry, key: keyof LedgerPicks, value: string | null, at: Date): Promise<void> {
    if (key === "permissionMode" && (!this.settings["chats.rememberMode"] || (value !== null && (!isMode(value) || !rememberableMode(value))))) return;
    await this.projectWrite(async () => {
      const p = await this.project(entry.ledger.project);
      if (!p) return;
      const picks: LedgerPicks = { ...p.picks };
      picks[key] = value === null ? null : { value, mark: markOf(MARK_PHRASES.remembered, at) };
      await this.deps.store.putProject({ ...p, picks, lastUsedAt: at.toISOString() });
    });
  }

  private picksOf(entry: Entry): Picks {
    const p = entry.ledger.picks;
    const effort = p.effort && isEffort(p.effort.value) ? p.effort.value : null;
    const stored = p.permissionMode && isMode(p.permissionMode.value) ? p.permissionMode.value : null;
    return { model: p.model?.value ?? null, effort, mode: entry.modeOverride ?? stored };
  }

  /** The picks passed at a start: each with its mark (4.7). Plan only as this session's pick; Bypass only with the switch. */
  private markedPicks(entry: Entry, at: Date): MarkedPicks {
    const p = entry.ledger.picks;
    const out: MarkedPicks = {};
    if (p.model) out.model = { value: p.model.value, mark: p.model.mark };
    if (p.effort && isEffort(p.effort.value)) out.effort = { value: p.effort.value, mark: p.effort.mark };
    const bypassOk = this.settings["chats.allowBypass"];
    if (entry.modeOverride && (entry.modeOverride !== "bypassPermissions" || bypassOk)) {
      out.permissionMode = { value: entry.modeOverride, mark: markOf(MARK_PHRASES.pick, at) };
    } else if (p.permissionMode && isMode(p.permissionMode.value) && p.permissionMode.value !== "plan" && (p.permissionMode.value !== "bypassPermissions" || bypassOk)) {
      out.permissionMode = { value: p.permissionMode.value, mark: p.permissionMode.mark };
    }
    return out;
  }

  private switches(agent: AgentSettings | null, at: Date): MarkedSwitches {
    const out: MarkedSwitches = {};
    if (this.settings["chats.allowBypass"]) out.allowBypass = { value: true, mark: markOf(MARK_PHRASES.bypass, at) };
    if (agent?.promptSuggestions === true) out.promptSuggestions = { value: true, mark: markOf(MARK_PHRASES.suggestions, at) };
    return out;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Rename, archive and delete (6.10, D48)

  private async rename(entry: Entry, title: string): Promise<Outcome> {
    const sid = entry.ledger.sessionId;
    if (sid && this.caps.rename) {
      // A live chat's Claude Code takes the name first, so it keeps it and never sends the old one back (a rename it
      // refuses still goes to the transcript); then the transcript, which a sleeping chat's next start reads.
      const live = this.liveOf(entry);
      const told = live ? await live.chat.rename(title, sid).catch(() => false) : false;
      try {
        await this.deps.driver.rename(sid, title, sessionFolder(entry.ledger));
      } catch (e) {
        // A chat whose transcript does not exist yet keeps the name in its ledger (and its Claude Code) only.
        if (!told && (await this.sessionInfo(entry, sid)) !== null) return fail(driverErrorCode(e));
      }
    }
    if (entry.deleted || entry.deleting) return fail("not_found");
    entry.ledger.title = { text: title, from: "renamed" };
    entry.hold++;
    void this.persist(entry);
    return ok(null, () => {
      entry.hold--;
      if (entry.deleted) return;
      this.emit(entry, { k: "title", title, from: "renamed" });
      this.refresh(entry);
    });
  }

  private isBusy(entry: Entry): boolean {
    if (entry.phase === "starting" || this.orphanRuns(entry)) return true;
    if (entry.phase === "live" && (entry.turn !== null || entry.cards.size > 0)) return true;
    return entry.phase !== "sleeping" && this.busyTasks(entry);
  }

  /**
   * Archive (D48): an idle chat's process ends at once; a busy chat needs `stop` (Stop and archive: interrupt, then
   * close). An archived chat never starts and never counts toward the cap. Unarchive only clears the mark.
   */
  private async archive(entry: Entry, on: boolean, stop: boolean, ctx: RequestContext): Promise<Outcome> {
    if (!on) {
      if (entry.ledger.archivedAt === null) return ok(null);
      entry.ledger.archivedAt = null;
      await this.unarchiveWorktree(entry);
      entry.hold++;
      await this.persist(entry);
      return ok(null, () => {
        entry.hold--;
        this.refresh(entry);
      });
    }
    if (entry.ledger.archivedAt !== null) return ok(null);
    const busy = this.isBusy(entry);
    if (busy && !stop) return fail("busy");
    // Stop and archive of a chat held as finishing ends kitespan's own orphan, as Stop does (R16).
    if (entry.orphan && this.orphanRuns(entry)) void endOrphan(this.procs, entry.orphan, this.deps.orphanGraceMs ?? ORPHAN_GRACE_MS);
    entry.ledger.archivedAt = this.iso();
    this.ended(entry);
    // R124: a side question in flight does not finish; the thread is kept.
    this.side.abort(entry.id, "archived");
    // Row 116: Archive is the user's own act on the chat, so what waited to be seen is seen (R130: and notifies no more).
    delete entry.ledger.unseen;
    this.pushCall((p) => p.forget(entry.id));
    // An archived chat never starts, so no other app holds it from kitespan (row 78); the next check after an
    // Unarchive looks again.
    entry.held = null;
    this.dropHandOver(entry);
    entry.hold++;
    const dropped = this.dropStarts(entry);
    const behind = this.dropBehindBash(entry);
    entry.bashRunning?.abort.abort();
    // W7 (L25): once the process is gone, a clean worktree goes and one with changes stays on disk.
    void (entry.live ? this.endChat(entry, { interrupt: busy }) : Promise.resolve()).then(() => this.archiveWorktree(entry));
    await this.persist(entry);
    await this.returnToDraft(entry, [...dropped.msgs, ...behind.msgs], ctx.tab, [...dropped.jobs, ...behind.jobs]);
    await entry.queue.idle();
    return ok(null, () => {
      entry.hold--;
      this.refresh(entry);
    });
  }

  /** L27: another chat runs in this chat's own worktree (Continue in a copy); `listed`: one that is not archived. */
  private sharesWorktree(entry: Entry, listed: boolean): boolean {
    const path = entry.ledger.worktree?.path;
    if (!path) return false;
    for (const e of this.entries.values()) {
      if (e === entry || e.deleted || e.deleting || (listed && e.ledger.archivedAt !== null)) continue;
      const w = e.ledger.worktree;
      if (w && !w.left && w.path === path) return true;
    }
    return false;
  }

  /** W7 (L25): an archived chat's clean worktree goes (its branch stays); one with changes stays, and the row says so. */
  private async archiveWorktree(entry: Entry): Promise<void> {
    const w = entry.ledger.worktree;
    if (!w || w.left || this.sharesWorktree(entry, true)) return;
    const still = () => entry.ledger.archivedAt !== null && !entry.deleted && !entry.deleting && entry.ledger.worktree === w;
    const r = await this.wt.archive(w, still).catch(() => null);
    if (r === "removed") return this.markRemoved(w.path, true);
    if (r !== "kept" || !still()) return;
    entry.ledger.worktree = { ...w, kept: true };
    await this.persist(entry);
    this.refresh(entry);
  }

  /**
   * Row 100: Archive removed the worktree at `path` (`on`), so its name is free in the project's `.claude/worktrees`
   * and a worktree found there later is not the chat's own (LedgerWorktree.removed); or a remake brought it back. Every
   * chat whose own worktree it is gets the mark (a copy shares it, L27).
   */
  private async markRemoved(path: string, on: boolean): Promise<void> {
    for (const e of this.entries.values()) {
      const w = e.ledger.worktree;
      if (e.deleted || e.deleting || !w || w.left || w.path !== path || (w.removed === true) === on) continue;
      if (on) e.ledger.worktree = { ...w, removed: true };
      else {
        const { removed: _removed, ...rest } = w;
        e.ledger.worktree = rest;
      }
      await this.persist(e);
    }
  }

  /** W8: Unarchive makes a missing worktree again from its branch (after a pending archive's removal, if one runs). */
  private async unarchiveWorktree(entry: Entry): Promise<void> {
    const w = entry.ledger.worktree;
    if (!w || w.left) return;
    const { kept: _kept, ...rest } = w;
    entry.ledger.worktree = rest;
    const project = await this.project(entry.ledger.project);
    if (project) await this.remake(rest, project.id).catch(() => false);
  }

  /** W4, W8: the chat's worktree made again from its branch; Remove waits for it as for a Start's (row 99). */
  private async remake(w: LedgerWorktree, projectId: string): Promise<boolean> {
    const unhold = this.holdMaking(projectId);
    try {
      const back = await this.wt.again(w, projectId);
      if (back) await this.markRemoved(w.path, false);
      return back;
    } finally {
      unhold();
    }
  }

  /** Row 99: a worktree of the project is in the making until the function returned is called (once). */
  private holdMaking(project: string): () => void {
    this.makingIn.set(project, (this.makingIn.get(project) ?? 0) + 1);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      const n = (this.makingIn.get(project) ?? 1) - 1;
      if (n > 0) this.makingIn.set(project, n);
      else this.makingIn.delete(project);
    };
  }

  /**
   * Delete (D48, the brief): the process ends first, then the transcript (`deleteSession`), then the ledger and draft.
   * `leaving` (row 99, an environment's Remove): the chat leaves kitespan and its transcript stays, and its own
   * worktree follows Archive's rule (L25) instead of Delete's, unless a copy shares it (`shared`, read before any chat
   * went).
   */
  private async remove(entry: Entry, leaving?: { shared: boolean }): Promise<Outcome> {
    const keepTranscript = leaving !== undefined;
    entry.deleting = true;
    this.ended(entry);
    // R124: the side thread goes with the chat (its file with the store's deleteChat), and a question in flight with it.
    this.side.forget(entry.id);
    this.unqueue(entry);
    entry.waiting = [];
    entry.pending.clear();
    entry.bashQueue = [];
    entry.bashRunning?.abort.abort();
    this.clearIdle(entry);
    if (entry.live) await this.endChat(entry, { interrupt: this.isBusy(entry) });
    else if (entry.starting) await entry.starting;
    if (entry.live) await this.endChat(entry);
    // kitespan's own orphan (R16) would write the session again after its transcript went: it ends first, as on Stop.
    if (entry.orphan) await endOrphan(this.procs, entry.orphan, this.deps.orphanGraceMs ?? ORPHAN_GRACE_MS);
    const sid = entry.ledger.sessionId;
    if (sid && this.caps.deleteSession && !keepTranscript) {
      try {
        await this.deps.driver.deleteSession(sid, sessionFolder(entry.ledger));
      } catch (e) {
        if ((await this.sessionInfo(entry, sid)) !== null) {
          entry.deleting = false;
          this.refresh(entry);
          return fail(driverErrorCode(e));
        }
      }
    }
    // W9 (L26): the user confirmed Delete, so the chat's own worktree goes with its changes, then its branch unless it
    // holds a commit of its own; a copy that runs in the same worktree keeps both (L27). Row 99: Remove confirmed no
    // loss of work, so a clean worktree goes and its branch stays, and one with changes or ignored work stays on disk.
    const w = entry.ledger.worktree;
    if (w && leaving) {
      if (!w.left && !leaving.shared) await this.wt.archive(w).catch(() => null);
    } else if (w && !this.sharesWorktree(entry, false)) await this.wt.delete(w, !w.left).catch(() => {});
    // U1: the chat's changes folder goes with it (its marks' git ends first).
    if (entry.marks) this.deps.changes?.drop(entry.marks);
    entry.marks = null;
    await this.deps.changes?.forget(entry.id).catch(() => this.error("store_write", entry.id));
    entry.deleted = true;
    await entry.writeChain;
    try {
      await this.deps.store.deleteChat(entry.id);
    } catch {
      entry.deleted = false;
      entry.deleting = false;
      this.error("store_write", entry.id);
      this.refresh(entry);
      return fail("failed");
    }
    this.entries.delete(entry.id);
    this.trust.forget(entry.id);
    this.bg.forget(entry.id);
    this.pushCall((p) => p.forget(entry.id));
    if (sid && this.bySession.get(sid) === entry.id) this.bySession.delete(sid);
    return ok(null, () => {
      for (const v of [...entry.viewers]) {
        try {
          v.gone();
        } catch {
          // a viewer that is already gone
        }
      }
      entry.viewers.clear();
      this.broadcast({ chat: entry.id, gone: true });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // An environment's Remove (row 99, chats/environments.ts)

  /** The chats of a project, archived ones too. */
  chatsIn(project: string): string[] {
    return [...this.entries.values()].filter((e) => e.ledger.project === project && !e.deleted && !e.deleting).map((e) => e.id);
  }

  /**
   * The Claude Code sessions of a project's chats (Remove releases them, store/released.ts), each with the folder that
   * holds its transcript (sessionFolder: a worktree chat's is its worktree's, or W4's sessionDir).
   */
  sessionsIn(project: string): ReleasedSession[] {
    return [...this.entries.values()].flatMap((e) => (e.ledger.project === project && !e.deleted && !e.deleting && e.ledger.sessionId ? [{ id: e.ledger.sessionId, dir: sessionFolder(e.ledger) }] : []));
  }

  /**
   * A chat of the project is busy now: its start runs, a turn runs, a card waits, a task that is not ambient runs, or
   * another app or the finishing hold holds it (row 78, R16); or a worktree is in the making there (W3, a remake).
   */
  projectBusy(project: string): boolean {
    if (this.makingIn.has(project)) return true;
    return [...this.entries.values()].some((e) => e.ledger.project === project && !e.deleted && !e.deleting && (this.isBusy(e) || e.held !== null));
  }

  /** Remove's first step: false while the project is busy (projectBusy); else no chat starts in it from now on. */
  beginLeave(project: string): boolean {
    if (this.projectBusy(project)) return false;
    this.leaving.add(project);
    return true;
  }

  /** Remove stopped (its release, or the project's own files, could not be written): chats may start there again. */
  cancelLeave(project: string): void {
    this.leaving.delete(project);
  }

  /**
   * Remove: every chat of the project leaves kitespan as Delete takes it, with its Claude Code transcript kept: its
   * process ends (an idle one at once, as Archive ends it), then its own worktree follows Archive's rule (L25; one that
   * a copy shares, L27, or a terminal session's linked one, W12, stays), then its ledger, draft, notes, queue file and
   * upload records go, and every page gets `gone`. Then the project's records of worktrees in the making go as the
   * boot's sweep takes them (no later boot reads a removed project's). No chat starts in the project from now on. False
   * when a chat could not be removed, or a record is left: the rest is gone, and the project may be removed again.
   */
  async leaveProject(project: string): Promise<boolean> {
    this.leaving.add(project);
    const chats = [...this.entries.values()].filter((e) => e.ledger.project === project && !e.deleted && !e.deleting);
    // Read before any chat goes: each remove marks its chat as deleting, which sharesWorktree skips.
    const shared = new Map(chats.map((e) => [e, this.sharesWorktree(e, false)]));
    const held = new Set([...this.entries.values()].flatMap((e) => (e.ledger.worktree && !e.deleted ? [e.ledger.worktree.path] : [])));
    const outs = await Promise.all(chats.map((e) => this.remove(e, { shared: shared.get(e) === true })));
    for (const o of outs) if (o.ok) o.after?.();
    let ok = outs.every((o) => o.ok);
    const cwd = this.projectCwds.get(project) ?? (await this.project(project))?.cwd;
    if (ok && cwd !== undefined) ok = await this.wt.sweepProject({ id: project, cwd }, (path) => held.has(path)).catch(() => false);
    if (!ok) this.leaving.delete(project);
    return ok;
  }

  // -------------------------------------------------------------------------------------------------------------
  // New chat and Continue here

  private async newChat(frame: NewChatFrame, ctx: RequestContext): Promise<Outcome> {
    // A resend of the new_chat that made a chat (its ack was lost, maybe before a restart): that chat, made once.
    for (const e of this.entries.values()) if (!e.deleted && !e.deleting && e.made.has(frame.uuid)) return ok({ chat: e.id });
    // R124: a chat's first message is never `/btw` (a side question needs a conversation, and is never a prompt).
    if (btwQuestion(frame.text) !== null) return fail(this.caps.sideQuestions ? "bad_request" : "unsupported");
    if (this.draining || this.restartDrain) return fail("restarting");
    const project = this.leaving.has(frame.project) ? null : await this.project(frame.project);
    if (!project) return fail("not_found");
    const claimed: UploadRecord[] = [];
    if (frame.uploads.length > 0) {
      const free = new Map((await this.deps.store.listUploads(null)).map((u) => [u.id, u]));
      for (const id of frame.uploads) {
        const u = free.get(id);
        if (!u || u.chat !== null || u.project !== project.id) return fail("upload_gone");
        claimed.push(u);
      }
    }
    // The form's mention chips (D59): files of the project's folder, by a send's rules, before any chat is made.
    const mentions = frame.mentions ?? [];
    let mentioned = await mentionPaths(project.cwd, mentions);
    if (!mentioned) return fail("mention_gone");
    if (frame.picks.mode === "bypassPermissions" && !this.settings["chats.allowBypass"]) return fail("bad_request");
    if (frame.picks.mode !== null && !this.caps.modes.includes(frame.picks.mode)) return fail("unsupported");
    // With no usable claude, Start refuses and makes no chat (6.9).
    const probe = await this.deps.driver.probe();
    this.claude = statusOf(probe);
    if (!probe.ok) return fail("no_claude");
    // D60 (L39): neither while the environment's variables cannot be read.
    if (this.deps.env && this.deps.env.vars(project.id) === null) return fail("env_unreadable");
    if (this.draining || this.restartDrain) return fail("restarting");
    // Row 99: an environment's Remove began meanwhile.
    if (this.leaving.has(project.id)) return fail("not_found");
    // Row 73 (W3): with the project's Worktree on, the chat's worktree is made once its id is, before Claude Code starts
    // (L22 to L24), and the form's mentions are files of that worktree; with a missing one, the worktree goes again.
    let place: { id: string; worktree: LedgerWorktree } | undefined;
    let unhold: (() => void) | null = null;
    if (project.worktree) {
      // A shutdown waits for a worktree in the making (and its discard, as the server closes); one that a kill -9 cut
      // is undone at the next boot (its record in the making, server/worktree/pending.ts). Remove waits until the
      // chat's ledger holds it (row 99).
      unhold = this.holdMaking(project.id);
      const making = this.makeWorktree(project, mentions);
      this.making.add(making);
      const got = await making.finally(() => this.making.delete(making)).catch((e: unknown) => {
        unhold!();
        throw e;
      });
      if ("code" in got) {
        unhold();
        return fail(got.code, got.reason);
      }
      mentioned = got.mentioned;
      place = { id: got.id, worktree: got.worktree };
    }
    const at = this.now();
    const entry = this.createChat(project, null, firstPromptTitle(frame.text), "first-prompt", frame.picks, at, place);
    if (frame.picks.mode === "plan") entry.modeOverride = "plan";
    this.remember(entry.made, frame.uuid);
    await this.persist(entry);
    if (place) await this.wt.settled(place.worktree, project.id).catch(() => {});
    unhold?.();
    this.broadcast({ ...entry.row });
    for (const u of claimed) await this.deps.store.putUpload({ ...u, chat: entry.id }).catch(() => this.error("store_write", entry.id));
    await this.rememberNewChat(project, frame.picks, at);
    const msg: PendingMsg = {
      uuid: frame.uuid,
      text: withUploadRefs(frame.text, [...claimed.map((u) => u.path), ...mentioned], "message"),
      userText: frame.text,
      uploads: [...frame.uploads],
      mentions: [...mentions],
      where: "cap",
      announced: false,
    };
    // RD-8 (R11): the first message waits for the chat's start, so it is in the queue file before the ack.
    await entry.queue.add(this.noteOf(msg));
    entry.waiting.push({ kind: "send", msg });
    entry.pending.set(msg.uuid, msg);
    const r = await this.requestStart(entry, probe);
    if (r === "queued" || r === "held") {
      if (!msg.announced) {
        msg.announced = true;
        this.announce(entry, msg, true);
      }
      if (r === "queued") this.capNotice(entry);
    } else if (r !== "started" && !entry.deleted) {
      // The chat exists; its first message goes back to its draft, so nothing typed is lost.
      entry.pending.delete(msg.uuid);
      // A refused start (W4) has drawn its own line already.
      if (r !== "refused") this.emit(entry, startNotice(this.startError(entry, r)));
      await this.returnToDraft(entry, [msg], ctx.tab);
      await entry.queue.drop([msg.uuid]);
    }
    return ok({ chat: entry.id });
  }

  /**
   * Row 73 (W3): the new chat's worktree, made once its id is, before Claude Code starts (L22 to L24), and the form's
   * mentions as files of that worktree. A missing file, or a close that began meanwhile, discards the worktree again.
   * A worktree that cannot be made names why when the project's folder is the cause (F5: the page shows its line).
   */
  private async makeWorktree(
    project: ProjectRecord,
    mentions: readonly string[],
  ): Promise<{ id: string; worktree: LedgerWorktree; mentioned: string[] } | { code: ErrorCode; reason?: WorktreeOff }> {
    let id = newChatId();
    while (this.entries.has(id)) id = newChatId();
    const made = await this.wt.make(project, id, () => this.deps.driver.settings(project.cwd));
    if (!made.ok) return made.why === "failed" ? { code: "worktree_failed" } : { code: "worktree_failed", reason: made.why };
    const inTree = await mentionPaths(made.worktree.path, mentions);
    if (!inTree || this.draining || this.restartDrain) {
      await this.wt.discard(made.worktree, project.id).catch(() => {});
      return { code: inTree ? "restarting" : "mention_gone" };
    }
    return { id, worktree: made.worktree, mentioned: inTree };
  }

  /**
   * Continue here (6.9): one kitespan chat per session (D49), so a second press, from any page, gets the same chat.
   * D58 Continue in a copy (`fork`): the chat holds a fork of the session, a new session id titled as a copy, and the
   * app that has the session open keeps the original; two presses at once make one copy, a later press one more,
   * numbered. A session that a chat already holds: Continue here opens that chat; Continue in a copy (the button of a
   * chat whose session another app holds, row 78) opens the newest copy of it in the lists, else makes one. Continue
   * here without `fork` is refused (`session_open`) while another app has the session open now: the page read the
   * preview earlier, and two processes on one session write two branches into one transcript (W19d). A registry that
   * cannot be read counts as none open.
   */
  private continueSession(frame: ContinueSessionFrame): Promise<Outcome> {
    // A resend of the frame that made a copy (its ack was lost, maybe before a restart): that copy, made once (R10).
    for (const e of this.entries.values()) if (!e.deleted && !e.deleting && e.made.has(frame.rid)) return Promise.resolve(ok({ chat: e.id }));
    const fork = frame.fork === true;
    const holder = () => {
      const c = this.bySession.get(frame.session);
      return c && this.has(c) ? c : null;
    };
    const held = holder();
    if (held && !fork) return Promise.resolve(ok({ chat: held }));
    const copy = held && fork ? this.copyForSession(frame.session) : null;
    if (copy) return Promise.resolve(ok({ chat: copy }));
    const key = fork ? `copy:${frame.session}` : frame.session;
    const running = this.continuing.get(key);
    if (running) return running;
    const p = (async (): Promise<Outcome> => {
      const project = this.leaving.has(frame.project) ? null : await this.project(frame.project);
      if (!project) return fail("not_found");
      // A chat's own session is filed under its session folder (W4's Continue in the project folder, sessionDir), and
      // one that a removed environment released under the folder it recorded (row 99: a worktree chat's, maybe gone).
      const holding = holder();
      const released = holding ? null : (this.deps.releasedFolder?.(project.cwd, frame.session) ?? null);
      const dir = holding ? sessionFolder(this.entries.get(holding)!.ledger) : (released ?? project.cwd);
      let info: SessionInfo | null;
      try {
        info = await this.deps.driver.sessionInfo(frame.session, dir);
      } catch (e) {
        return fail(driverErrorCode(e));
      }
      if (!info) return fail("not_found");
      const again = holder();
      if (again && !fork) return ok({ chat: again });
      const made = again && fork ? this.copyForSession(frame.session) : null;
      if (made) return ok({ chat: made });
      if (!fork && (await this.openNow()).has(frame.session)) return fail("session_open");
      // Row 73: a copy of a kitespan chat's session runs in that chat's own folder, its worktree too (W10, L27); a
      // terminal session that ran in a linked worktree of the project's folder continues there (W12, L31).
      const src = again ? (this.entries.get(again) ?? null) : null;
      const srcTree = src?.ledger.worktree && !src.ledger.worktree.left ? src.ledger.worktree : null;
      // A fork goes beside its original, so a copy of a chat that went on in its project's folder keeps its sessionDir.
      const place = src
        ? {
            cwd: src.ledger.cwd,
            ...(src.ledger.linked ? { linked: true as const } : {}),
            // Archive's removal of the worktree holds for the copy too (row 100: what is at the path is not it).
            ...(srcTree
              ? { worktree: { path: srcTree.path, root: srcTree.root, branch: srcTree.branch, baseRef: srcTree.baseRef, baseCommit: srcTree.baseCommit, ...(srcTree.removed ? { removed: true as const } : {}) } }
              : {}),
            ...(src.ledger.sessionDir !== undefined ? { sessionDir: src.ledger.sessionDir } : {}),
          }
        : typeof info.cwd === "string" && info.cwd !== project.cwd && linkedRootOf(info.cwd) === project.cwd
          ? { cwd: info.cwd, linked: true as const }
          : released !== null && released !== project.cwd
            ? { cwd: project.cwd, sessionDir: released }
            : undefined;
      const title = cleanLabel(info.title);
      let sessionId = frame.session;
      let text = title ? capText(title, LIMITS.title) : null;
      if (fork) {
        text = copyTitle(title, this.copiesOf(frame.session).length + 1);
        try {
          sessionId = await this.deps.driver.forkSession(frame.session, src ? sessionFolder(src.ledger) : (released ?? place?.cwd ?? project.cwd), text);
        } catch (e) {
          return fail(driverErrorCode(e));
        }
      }
      // Row 99: an environment's Remove began meanwhile.
      if (this.leaving.has(project.id)) return fail("not_found");
      const entry = this.createChat(project, sessionId, text, "generated", { model: null, effort: null, mode: null }, this.now(), place);
      // The fork's transcript exists, so its first start resumes it (D41). The frame's rid is in its ledger (R10).
      if (fork) {
        entry.transcript = sessionId;
        entry.ledger.copyOf = frame.session;
        this.remember(entry.made, frame.rid);
      }
      await this.persist(entry);
      this.broadcast({ ...entry.row });
      // Row 99: a session that a removed environment released is a chat's again.
      this.deps.continued?.(frame.session);
      // A session that is open elsewhere gets the chat's line now, not at the next check.
      void this.checkOpen();
      return ok({ chat: entry.id });
    })().finally(() => this.continuing.delete(key));
    this.continuing.set(key, p);
    return p;
  }

  /** D58: the sessions that other processes have open now; a registry that cannot be read counts as none open. */
  private async openNow(): Promise<ReadonlyMap<string, SessionOpen>> {
    try {
      return await this.deps.driver.openSessions();
    } catch {
      return new Map();
    }
  }

  /**
   * R131: the background sessions' records of this look, of the ids in the chats' books only (the driver keeps nothing of
   * any other), or null when the agent has none or they cannot be read.
   */
  private async bgRecordsNow(): Promise<BgRecord[] | null> {
    const read = this.deps.driver.backgroundRecords;
    if (typeof read !== "function") return null;
    try {
      return await read.call(this.deps.driver, this.bg.ids());
    } catch {
      return null;
    }
  }

  /**
   * D58 and row 78: the check of every chat's session, at boot and then until the shutdown: about every 2 s
   * (OPEN_FAST_MS) while a chat has a viewer or a live process, else every OPEN_CHECK_MS.
   */
  private watchOpen(): void {
    if (this.openTimer || this.draining) return;
    void this.checkOpen();
    const slow = Math.max(1, this.opts.openCheckMs ?? OPEN_CHECK_MS);
    const fast = Math.max(1, Math.min(slow, this.opts.openFastMs ?? OPEN_FAST_MS));
    const t = setInterval(() => {
      // Half a tick of slack, so a tick that fires a little early does not wait for the next one.
      if (performance.now() - this.openCheckAt >= (this.watched() ? fast : slow) - fast / 2) void this.checkOpen();
    }, fast);
    (t as { unref?: () => void }).unref?.();
    this.openTimer = t;
  }

  /** Row 78: a chat that could start or send soon has a viewer or a live process: its session is checked often. */
  private watched(): boolean {
    for (const e of this.entries.values()) {
      if (e.deleted || e.deleting || !e.ledger.sessionId || e.ledger.archivedAt !== null) continue;
      if (e.viewers.size > 0 || e.phase !== "sleeping") return true;
    }
    return false;
  }

  /**
   * D58 and row 78: each chat whose session another process has open (Claude Code's registry, read by the driver) is
   * held (setHeld), sleeping chats too, since their next start resumes the same session; an archived chat never
   * starts, so it never is. A registry that cannot be read counts as none open. Only the newest check applies.
   */
  private async checkOpen(): Promise<void> {
    const n = ++this.openChecks;
    const look = ++this.bgLooks;
    this.openCheckAt = performance.now();
    // R131: the same look gives the background sessions' records (the driver reads the folder once for both); only the
    // newest look of these checks applies.
    const [open, bg] = await Promise.all([this.openNow(), this.bgRecordsNow()]);
    if (this.draining) return;
    if (bg && look === this.bgLooks) this.bg.records(bg);
    if (n !== this.openChecks) return;
    for (const e of this.entries.values()) {
      if (e.deleted || e.deleting) continue;
      const sid = e.ledger.sessionId;
      // S16: a session handed to the terminal stays held until Claude Code's registry shows it open (D58's hold then).
      // The orphan's own record (R16) is not a terminal's: the hand-over waits for its exit.
      if (this.handed.has(e.id) && !e.orphan) {
        if (sid && e.ledger.archivedAt === null && !open.has(sid)) continue;
        this.dropHandOver(e);
        this.refresh(e);
      }
      // R16: kitespan's own orphan holds its chat (`finishing`) until it exits (watchOrphan), whatever the registry says.
      this.setHeld(e, sid && e.ledger.archivedAt === null ? (e.orphan ? "other" : (open.get(sid)?.app ?? null)) : null);
    }
  }

  /**
   * Row 78: whether the chat may not send now because another process has its session open: held already, or, for a
   * chat with no process of its own, the registry read again before a start (the last check may be up to 10 s old),
   * which holds the chat when it finds the session open. A live chat's process already holds the session; the
   * checks above watch it.
   */
  private async heldNow(entry: Entry): Promise<boolean> {
    if (entry.held) return true;
    const sid = entry.ledger.sessionId;
    if (entry.phase === "live" || !sid || entry.ledger.archivedAt !== null) return false;
    // A check that began before this read must not take back what this read finds.
    ++this.openChecks;
    const app = (await this.openNow()).get(sid)?.app ?? null;
    if (app && entry.ledger.sessionId === sid && !this.gone(entry)) this.setHeld(entry, app);
    return entry.held !== null;
  }

  /**
   * Row 78: the app that holds the chat's session now, or null. Held, kitespan gives the session up (giveUp); released,
   * what waited starts again (release). Every page gets the row's `held`, and a page on the chat reads its history
   * again when it goes.
   */
  private setHeld(entry: Entry, app: OpenApp | null): void {
    if (entry.held === app) return;
    const was = entry.held;
    entry.held = app;
    if (was === null) this.giveUp(entry);
    else if (app === null) {
      // The other app's turns are in the transcript, not in the ring (R4).
      entry.resyncSeq = entry.seq;
      this.release(entry);
    }
    this.refresh(entry);
  }

  /**
   * Row 78: kitespan gives the session up. A start that waits for a slot does not start (its messages stay, Queued, and
   * the free-slot line goes); a live process ends at its first quiet moment (`yielding`, see refresh), after its own
   * turn, which is never cut; the messages in Claude Code's own queue are taken back from it, so they wait in the
   * server for the start after the hold, Queued, as they were.
   */
  private giveUp(entry: Entry): void {
    const i = this.capQueue.findIndex((r) => r.entry === entry);
    if (i >= 0) this.capQueue.splice(i, 1)[0]!.settle("held");
    this.endCapWait(entry);
    // A start in progress has no process yet: it reads `held` right before it opens one (doStart).
    if (entry.phase !== "live" && entry.phase !== "ending") return;
    entry.yielding = true;
    if (entry.phase === "live") void this.intake(entry, () => this.holdQueue(entry));
  }

  /**
   * Row 78: the messages in Claude Code's own queue come back to the server's queue, in the order sent; one that a
   * turn has started on stays where it is.
   */
  private async holdQueue(entry: Entry): Promise<void> {
    const live = entry.live;
    if (!live || entry.phase !== "live" || !this.caps.takeBack) return;
    for (const m of [...entry.pending.values()]) {
      if (m.where !== "cli") continue;
      const r = await live.chat.takeBack(m.uuid).catch(() => ({ cancelled: false }));
      if (!r.cancelled || entry.live !== live || entry.pending.get(m.uuid) !== m || m.where !== "cli") continue;
      m.where = "cap";
      entry.waiting.push({ kind: "send", msg: m });
    }
    this.refresh(entry);
  }

  /**
   * Row 78: the other process ended. What waited starts again (a new process resumes the transcript, with the other
   * app's turns). A process that still gives the session up ends first; its end starts what waits (onExit).
   */
  private release(entry: Entry): void {
    // The end of a `finishing` hold starts nothing: what waits was restored after a stop, and waits for the user (L4).
    // Nor does the end of a `handed` one (S16): the user may still paste the command in a terminal.
    if (this.gone(entry) || entry.orphan || this.handed.has(entry.id) || entry.yielding || entry.phase !== "sleeping" || entry.waiting.length === 0) return;
    void this.requestStart(entry).then((r) => {
      if (r === "queued") this.capNotice(entry);
    });
  }

  /** Row 78: a process that gives its session up has nothing running that ending it would cut. */
  private quiet(entry: Entry): boolean {
    return (
      entry.phase === "live" &&
      !entry.live?.closing &&
      this.computeState(entry) === "idle" &&
      !this.busyTasks(entry) &&
      !entry.bashRunning &&
      !this.cliQueued(entry)
    );
  }

  private createChat(
    project: ProjectRecord,
    sessionId: string | null,
    title: string | null,
    from: "first-prompt" | "generated",
    own: Picks,
    at: Date,
    place?: { id?: string; cwd?: string; worktree?: LedgerWorktree; linked?: true; sessionDir?: string },
  ): Entry {
    let id = place?.id ?? newChatId();
    while (!place?.id && this.entries.has(id)) id = newChatId();
    const iso = at.toISOString();
    const remembered: LedgerPicks = this.settings["chats.newChats"] === "last" ? project.picks : { model: null, effort: null, permissionMode: null };
    const mine = (v: string | null) => (v === null ? null : { value: v, mark: markOf(MARK_PHRASES.pick, at) });
    const picks: LedgerPicks = {
      model: own.model !== null ? mine(own.model) : remembered.model,
      effort: own.effort !== null ? mine(own.effort) : remembered.effort,
      permissionMode: own.mode !== null ? (own.mode === "plan" ? null : mine(own.mode)) : this.settings["chats.rememberMode"] ? remembered.permissionMode : null,
    };
    return this.addEntry({
      v: 1,
      id,
      project: project.id,
      // Row 73: the chat's own worktree (W3), or the linked worktree its session ran in (W12).
      cwd: place?.worktree?.path ?? place?.cwd ?? project.cwd,
      agent: "claude-code",
      sessionId,
      title: title ? { text: title, from } : null,
      picks,
      createdAt: iso,
      seenAt: iso,
      lastActivityAt: iso,
      lastSeq: 0,
      state: "sleeping",
      lastExit: null,
      archivedAt: null,
      ...(place?.worktree ? { worktree: { ...place.worktree } } : {}),
      ...(place?.linked && !place.worktree ? { linked: true as const } : {}),
      ...(place?.sessionDir !== undefined ? { sessionDir: place.sessionDir } : {}),
      // Only Continue here and a copy give a session id here, and its transcript exists (FIX-W25b 1.5).
      ...(sessionId !== null ? { transcript: true as const } : {}),
    });
  }

  /** A new chat starts in the project: its last use, and the user's own picks remembered (never Plan, D11). */
  private async rememberNewChat(project: ProjectRecord, own: Picks, at: Date): Promise<void> {
    const mark = (v: string) => ({ value: v, mark: markOf(MARK_PHRASES.remembered, at) });
    await this.projectWrite(async () => {
      // The project as the store has it now: a command list kept since it was read stays (D59).
      const now = (await this.project(project.id)) ?? project;
      const picks: LedgerPicks = { ...now.picks };
      if (own.model !== null) picks.model = mark(own.model);
      if (own.effort !== null) picks.effort = mark(own.effort);
      if (own.mode !== null && rememberableMode(own.mode) && this.settings["chats.rememberMode"]) picks.permissionMode = mark(own.mode);
      await this.deps.store.putProject({ ...now, picks, lastUsedAt: at.toISOString() });
    }).catch(() => this.error("store_write", null));
  }

  /**
   * The registry's writes of a project, one at a time, each on the project as the store has it when it runs: a new
   * chat's remembered picks, a pick, and a chat's command list never write over each other.
   */
  private projectWrite<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.projectChain.then(fn, fn);
    this.projectChain = p.catch(() => {});
    return p;
  }

  /** D59: a chat's command list is its project's last one, for the new-chat form's `/` menu. */
  private keepCommands(entry: Entry, list: CommandInfo[]): void {
    const project = entry.ledger.project;
    void this.projectWrite(() => keepProjectCommands(this.deps.store, project, list, this.now())).catch(() => this.error("store_write", entry.id));
  }

  private async project(id: string): Promise<ProjectRecord | null> {
    const p = (await this.deps.store.listProjects()).find((p) => p.id === id) ?? null;
    if (p) this.projectCwds.set(p.id, p.cwd);
    return p;
  }

  /** The folder of the chat's short reads (D59, row 81): its project's, which a worktree chat's Claude Code reads too. */
  private readFolder(entry: Entry): string {
    return this.projectCwds.get(entry.ledger.project) ?? configFolder(entry.ledger);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Reads

  private async get(entry: Entry, frame: Extract<RequestFrame, { t: "get" }>): Promise<Outcome> {
    const live = this.liveOf(entry);
    switch (frame.what) {
      case "history": {
        const page = await this.historyPage(entry, frame.before);
        return ok({ history: page.events, more: page.more });
      }
      case "context": {
        // Row 94: a live read is kept with the chat and its model's window with the project (D60: not while the chat
        // runs with its variables' old values); a chat with none answers the kept read, or its transcript's last usage
        // against that window (context.ts).
        const read = live && this.caps.contextUsage ? await live.chat.context() : null;
        if (read) {
          const note = this.contexts.keep(read, live && this.envNow(entry, live) ? entry.ledger.project : null);
          if (note) this.note(entry, (n) => void (n.context = note));
          return ok(read);
        }
        await entry.notesChain;
        // The transcript where Claude Code filed it (sessionFolder); the windows' short read in the project's folder (G3).
        const { project, sessionId } = entry.ledger;
        return ok(await this.contexts.answer((await this.loadNotes(entry)).context, { project, sessionId, cwd: sessionFolder(entry.ledger), readCwd: this.readFolder(entry) }));
      }
      case "connectors":
        return ok(live && this.caps.connectors ? await live.chat.connectors() : []);
      case "commands": {
        if (!live || !this.caps.commands) return ok(entry.commands ?? []);
        entry.commands = await live.chat.commands();
        this.keepCommands(entry, entry.commands);
        return ok(entry.commands);
      }
      case "models": {
        // Row 81: a live chat's Claude Code answers, and its list is kept; a chat with no live process (sleeping,
        // starting, held) gets the kept list, or one short read's for its folder when none is kept (none starts while
        // the server shuts down).
        if (!this.caps.models) return ok([]);
        if (live) {
          const list = await live.chat.models();
          if (this.envNow(entry, live)) void this.models.keep(entry.ledger.project, list).catch(() => this.error("store_write", entry.id));
          return ok(list);
        }
        return ok((await this.models.answer({ id: entry.ledger.project, cwd: this.readFolder(entry) }, !this.draining)).models);
      }
      case "side":
        // R124: kitespan's own thread; the read never starts the chat.
        return ok(await this.side.read(entry.id));
    }
  }

  /**
   * One page of the chat's history: Claude Code's transcript with the chat's notes merged in (history.ts): each closed
   * card after its tool call, each `!` record under its row's uuid, each message's mention paths, and, while no turn
   * runs, the last turn's calls that got no result as stopped. A page that attaches late, reloads or comes after a
   * restart then draws what a live page drew. `ended`: no turn runs, so the last turn's calls with no result will get
   * none (by default, no turn runs now, and no orphan of kitespan's own runs one, R16).
   */
  private async historyPage(
    entry: Entry,
    before: string | null,
    ended: () => boolean = () => entry.turn === null && entry.orphan === null,
    at?: { since: number; flight: Entry["turn"] },
  ): Promise<{ events: ChatEvent[]; more: string | null }> {
    const sid = entry.ledger.sessionId;
    await entry.notesChain;
    const notes = await this.loadNotes(entry);
    // U1: each noted turn's changes card, after its end.
    const cards = await this.deps.changes?.cards(entry.id).catch(() => undefined);
    // No session yet: no transcript, but a `!` row that never ran is in the notes.
    // D32: the chat's stop lines go under the turns they cut (stops.ts).
    if (!sid) return { events: trimPage(insertStops(decorateHistory([], notes, { ended: true }), notes.stops).map(capEvent)), more: null };
    try {
      const page = await this.deps.driver.history(sid, sessionFolder(entry.ledger), {
        before,
        maxBytes: PAGE_BUDGET,
        decorate: (events) => {
          // U2: each turn's start and end (turns.ts), and the start of the turn in flight where its first row is. For
          // an attach, as they were at its boundary (`at`): a turn that ended since then is in the snapshot's tail.
          const done = ended();
          const t = at ? at.flight : entry.turn;
          const turns = at ? notes.turns?.filter((n) => (entry.turnEnds.get(n) ?? 0) <= at.since) : notes.turns;
          const rows = insertTurns(insertStops(decorateHistory(events, notes, { ended: done }), notes.stops), turns, t && t.ids.length ? { ids: t.ids, by: t.by } : null, done, cards);
          // R127: the history's refused rows are noted (a page may press on them) and get their roots. R131: its launch
          // rows go in the chat's book, which comes back this way after a restart.
          return rows.map((e) => {
            const row = this.trustRow(entry, e, false);
            this.noteLaunches(entry, row, false);
            return row;
          });
        },
      });
      // R131: the ids this read noted that have no state yet ask Claude Code's list once.
      this.bg.afterHistory(entry.id);
      return { events: trimPage(page.events.map(capEvent)), more: page.more };
    } catch {
      return { events: [], more: null };
    }
  }

  /**
   * The `ev` frames that follow a snapshot (4.3 step 5): every event after the last turn's end (the turn in flight,
   * and lines such as an exit or a notice), the newest of each state event, the rows of messages and `!` commands
   * that still wait, and for each task that still runs (a background workflow or subagent that outlived its turn)
   * its newest event of each kind, minus every event whose agent id the history page already holds (history gives a
   * `!` record its row's uuid, and holds each closed card and each stopped call, see `historyPage`); then what the ring
   * dropped of these (see `dropped`). `since`: the last turn's end as it was when the page's history read began.
   */
  private tail(entry: Entry, pageIds: ReadonlySet<string>, since: number): RingItem[] {
    const items = entry.ring.all();
    const out = new Map<number, RingItem>();
    const latest = new Map<string, RingItem>();
    const waitingIds = new Set<string>(entry.pending.keys());
    if (entry.bashRunning) waitingIds.add(entry.bashRunning.uuid);
    for (const w of [...entry.waiting, ...entry.bashQueue]) waitingIds.add(w.kind === "send" ? w.msg.uuid : w.job.uuid);
    const runningTasks = new Set(entry.tasks.map((t) => t.taskId));
    // A tool's progress is its elapsed time: only the newest counts, and none once the page holds the tool's result.
    const progress = new Map<string, number>();
    for (const it of items) if (it.e.k === "tool_progress" && it.seq > since) progress.set(it.e.id, it.seq);
    for (const it of items) {
      const id = eventId(it.e);
      if (it.seq > since) {
        if (it.e.k === "tool_progress" && (progress.get(it.e.id) !== it.seq || pageIds.has(`result:${it.e.id}`))) continue;
        if (id === null || !pageIds.has(id)) out.set(it.seq, it);
      } else if (STATE_KINDS.has(it.e.k)) latest.set(it.e.k, it);
      else if (it.e.k === "task" && runningTasks.has(it.e.taskId)) latest.set(`task:${it.e.taskId}:${it.e.ev}`, it);
      else if (id !== null && waitingIds.has(id)) latest.set(`id:${id}`, it);
    }
    // A waiting message's newest `user` event only (each one says all of it): a later one replaces an earlier one.
    const newest = new Map<string, number>();
    for (const it of [...out.values(), ...latest.values()]) if (it.e.k === "user" && waitingIds.has(it.e.uuid)) newest.set(it.e.uuid, Math.max(it.seq, newest.get(it.e.uuid) ?? 0));
    for (const it of latest.values()) out.set(it.seq, it);
    for (const [seq, it] of out) if (it.e.k === "user" && newest.has(it.e.uuid) && newest.get(it.e.uuid) !== seq) out.delete(seq);
    for (const it of this.dropped(entry, pageIds)) out.set(it.seq, it);
    return [...out.values()].sort((a, b) => a.seq - b.seq);
  }

  /**
   * What the ring dropped that no history page holds: the newest state events, the `turn_start` of the turn in flight
   * (a Stop names its seq), the newest event of each message and `!` command that still waits or runs (the transcript
   * holds no message that waits in Claude Code's queue, LV-R4, so a long turn's deltas would take its Queued row from
   * a page that attaches now) and, for each streamed block that has not ended, its `block_start` and the text of its
   * dropped deltas. That text goes in pieces of at most 32,000 characters, each numbered with the seq of the last
   * delta it holds, so the numbers stay unique and in order.
   */
  private dropped(entry: Entry, pageIds: ReadonlySet<string>): RingItem[] {
    const first = entry.ring.first ?? entry.seq + 1;
    const out: RingItem[] = [];
    for (const it of entry.states.values()) if (it.seq < first) out.push(it);
    if (entry.turn && entry.turn.item.seq < first) out.push(entry.turn.item);
    const rows = new Set<RingItem | undefined>([...entry.pending.values()].map((m) => m.item));
    for (const w of [...entry.waiting, ...entry.bashQueue]) rows.add(w.kind === "send" ? w.msg.item : w.job.item);
    rows.add(entry.bashRunning?.item);
    for (const it of rows) if (it && it.seq < first) out.push(it);
    for (const [key, b] of entry.openBlocks) {
      if (b.start.seq >= first || pageIds.has(key)) continue;
      out.push(b.start);
      let text = "";
      let seq = 0;
      const flush = () => {
        if (text === "") return;
        const fit = fitEvent(entry.id, seq, { k: "block_delta", key, text });
        out.push({ seq, e: fit.e, json: fit.json, bytes: fit.bytes });
        text = "";
      };
      for (const d of b.deltas) {
        if (d.seq >= first) break;
        if (text !== "" && text.length + d.text.length > LIMITS.blockPiece) flush();
        text += d.text;
        seq = d.seq;
      }
      flush();
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Starting and ending a chat (the cap rule, D3)

  private composerRefusal(entry: Entry): ErrorCode | null {
    if (entry.deleting || entry.deleted) return "not_found";
    if (entry.ledger.archivedAt !== null) return "archived";
    if (this.draining) return "restarting";
    return null;
  }

  /** S9: while the restart's drain waits, every composer action but a send (held, Queued) is refused. */
  private drainRefusal(): ErrorCode | null {
    return this.restartDrain ? "restarting" : null;
  }

  // -------------------------------------------------------------------------------------------------------------
  // R127: Trust this folder

  /**
   * One `trust_folder`: the chat exists, is not archived and no restart drains (or the server closes); then the book's
   * checks and the agent's trust start (trust.ts). The trust start is not the chat's Claude Code: the chat's own state,
   * its idle timer and the cap are untouched.
   */
  private async trustFolder(entry: Entry, frame: TrustFolderFrame): Promise<Outcome> {
    const refused = this.composerRefusal(entry) ?? this.drainRefusal();
    if (refused) return fail(refused);
    const o = await this.trust.trust(entry.id, frame.toolUse, frame.path);
    return o.ok ? ok({ trust: o.answer }) : fail(o.code, o.reason);
  }

  /** A refused row as every page gets it: noted in the book, with the repository root that the confirm names. */
  private trustRow(entry: Entry, e: ChatEvent, live: boolean): ChatEvent {
    if (e.k !== "tool_result" || !e.trust) return e;
    this.trust.note(entry.id, e.id, e.trust.path, live);
    return { ...e, trust: folderRef(e.trust.path) };
  }

  /** R127: the folder that a refused row of `chat` names (Open in terminal types `cd <it> && claude`), or null. */
  trustRowPath(chat: string, toolUse: string): string | null {
    return this.has(chat) ? this.trust.rowPath(chat, toolUse) : null;
  }

  // -------------------------------------------------------------------------------------------------------------
  // R131: the background sessions that a chat starts

  /** A launch row as every page gets it (it already carries its launches): its sessions go in the chat's book. */
  private noteLaunches(entry: Entry, e: ChatEvent, live: boolean): void {
    if (e.k !== "tool_result" || !e.background?.length) return;
    this.bg.note(entry.id, e.id, e.background, live);
  }

  /** The folders whose sessions the chat's view may read: its project's folder, its own folder, its worktree. */
  private bgRoots(chat: string): string[] {
    const e = this.entries.get(chat);
    if (!e) return [];
    const out = [this.projectCwds.get(e.ledger.project), e.ledger.cwd, e.ledger.worktree?.path];
    return [...new Set(out.filter((p): p is string => typeof p === "string" && p.startsWith("/")))];
  }

  /**
   * Whether a page has that background session of the chat on screen now: its line or its view (R116's freshness). The
   * chat on screen at its end does not count: the session's line may be far up, or folded out of sight.
   */
  private bgSeen(chat: string, id: string): boolean {
    const e = this.entries.get(chat);
    if (!e) return false;
    return onScreenNow([...e.bgViews].filter(([, ids]) => ids.has(id)).map(([v]) => v));
  }

  /** Whether a launch row of `chat` printed `id` (Open in terminal types `claude attach <id>` only then). */
  backgroundHas(chat: string, id: string): boolean {
    return this.has(chat) && isBgId(id) && this.bg.has(chat, id);
  }

  /**
   * One `background_stop`: the chat exists, is not archived and no restart drains; the id is one that a launch row of
   * the chat printed (`stale` otherwise); no stop of it runs (`busy`); then the agent's stop, whose gate (`unsupported`,
   * `no_claude`) runs before its process does. One log line: the short id and the answer.
   */
  private async backgroundStop(entry: Entry, frame: BackgroundStopFrame): Promise<Outcome> {
    const refused = this.composerRefusal(entry) ?? this.drainRefusal();
    if (refused) return fail(refused);
    if (!isBgId(frame.id)) return fail("bad_request");
    if (!this.bg.has(entry.id, frame.id)) return fail("stale");
    const stop = this.deps.driver.stopBackground;
    if (typeof stop !== "function") return fail("unsupported");
    if (!this.bg.stopBegins(frame.id)) return fail("busy");
    let answer: BgStopAnswer | null = null;
    try {
      answer = await stop.call(this.deps.driver, frame.id);
    } catch (e) {
      const code = driverErrorCode(e);
      // The gate's codes are refusals; anything else is a stop that Claude Code did not confirm.
      if (code !== "failed") return fail(code);
      answer = "failed";
    } finally {
      this.bg.stopEnded(frame.id, answer);
    }
    this.log("bg_stop", { id: frame.id, answer });
    return ok({ background: answer });
  }

  /**
   * GET /api/chats/:chat/background/:id (DESIGN-R131 9.6): the read-only view's read of a background session that a
   * launch row of the chat printed. Null: no such chat (or archived), or no such session in its book. `outside`: its
   * folder is not the chat's project folder or under it, nor the chat's worktree, and nothing is read. The transcript
   * is read with the session's own folder, then the folder its worktree came from; `since` equal to the lite read's
   * stamp answers `same`. A read that finds no transcript answers BG_NO_STAMP as its stamp, and a later read with that
   * stamp answers `same` while there is still none. Only the view's opening (no `since`, no `before`) asks Claude Code's
   * list once: the page's later ticks always send the stamp they got, so a view that stays open asks no more.
   */
  async backgroundView(chat: string, id: string, q: { since: string | null; before: string | null }): Promise<BackgroundViewReply | null> {
    const entry = this.entries.get(chat);
    if (!entry || entry.deleted || entry.deleting || entry.ledger.archivedAt !== null || !isBgId(id)) return null;
    const v = this.bg.viewOf(chat, id);
    if (!v) return null;
    if (q.since === null && q.before === null) this.bg.viewOpened(id);
    if (v.known && !v.view) return { outside: true };
    const none: BackgroundViewReply = q.since === BG_NO_STAMP && q.before === null ? { same: true } : { history: [], more: null, stamp: BG_NO_STAMP, mode: null };
    if (!v.known || !v.sessionId || !v.cwd) return none;
    const origin = originFolder(v.cwd);
    for (const dir of origin && origin !== v.cwd ? [v.cwd, origin] : [v.cwd]) {
      const info = await this.deps.driver.sessionInfo(v.sessionId, dir).catch(() => null);
      if (!info) continue;
      const stamp = `${info.lastModified}:${info.fileSize ?? 0}`;
      if (q.before === null && q.since === stamp) return { same: true };
      try {
        const page = await this.deps.driver.history(v.sessionId, dir, { before: q.before, maxBytes: PAGE_BUDGET });
        const mode = (await this.deps.driver.backgroundMode?.(v.sessionId, dir).catch(() => null)) ?? null;
        return { history: trimPage(page.events.map(capEvent)), more: page.more, stamp, mode };
      } catch {
        return none;
      }
    }
    return none;
  }

  private startError(entry: Entry, r: StartResult): ErrorCode {
    if (r === "no_claude") return "no_claude";
    if (r === "env_unreadable") return "env_unreadable";
    if (r === "refused") return entry.refusal ?? "failed";
    if (r === "gone") return this.composerRefusal(entry) ?? "failed";
    return "failed";
  }

  /**
   * Row 73 (W4, W5): a start that kitespan's check refused, or that Claude Code refused itself: its line, with the
   * code whose buttons go under it (the server's text: Claude Code's first error line, else the code's own), and the
   * code on the chat until a start goes through or the user picks a button. Nothing starts again by itself.
   */
  private refuseStart(entry: Entry, code: ErrorCode, line: string | null = null): void {
    this.clearRefusal(entry); // a newer refusal takes the open line's place
    entry.refusal = code;
    if (entry.deleted || entry.deleting) return;
    entry.refusalLine = crypto.randomUUID();
    this.emit(entry, { k: "notice", text: line ?? ERROR_MESSAGES[code], code, id: entry.refusalLine });
  }

  /** The refusal is done with (a start went through, or the user's choice): its line goes from every page. */
  private clearRefusal(entry: Entry): void {
    entry.refusal = null;
    const line = entry.refusalLine;
    entry.refusalLine = null;
    if (line && !entry.deleting && !entry.deleted) this.emit(entry, { k: "taken_back", uuid: line });
  }

  private capNotice(entry: Entry): void {
    if (entry.capLine || entry.phase !== "sleeping") return;
    entry.capLine = crypto.randomUUID();
    this.emit(entry, { k: "notice", text: CAP_NOTICE, id: entry.capLine });
  }

  /** The wait for a slot ended (a start, a failed start, Archive, Take back, a shutdown): its line goes from every page. */
  private endCapWait(entry: Entry): void {
    const line = entry.capLine;
    entry.capLine = null;
    if (line && !entry.deleting && !entry.deleted) this.emit(entry, { k: "taken_back", uuid: line });
  }

  private requestStart(entry: Entry, probe?: BinaryProbe): Promise<StartResult> {
    // Row 78: no start while another process holds the session, nor on a process that gives it up (its end starts).
    if (entry.held || (entry.yielding && entry.live)) return Promise.resolve("held");
    if (entry.phase === "live") return Promise.resolve("started");
    if (entry.phase === "starting" && entry.starting) return entry.starting;
    const queued = this.capQueue.find((r) => r.entry === entry);
    if (queued) return queued.promise;
    if (entry.phase === "ending" && entry.live) {
      // The close is bounded (endChat's timeouts), so a send to an ending chat always gets its start.
      const live = entry.live;
      return (live.closing ?? live.done).then(() => this.requestStart(entry, probe));
    }
    let resolve!: (r: StartResult) => void;
    const promise = new Promise<StartResult>((r) => (resolve = r));
    const req: StartRequest = {
      entry,
      probe,
      promise,
      settled: false,
      settle(r) {
        if (req.settled) return;
        req.settled = true;
        resolve(r);
      },
    };
    this.capQueue.push(req);
    this.pump();
    return promise;
  }

  /** Take a chat out of the cap queue (archive, delete, Take back of its only message). */
  private unqueue(entry: Entry): void {
    const i = this.capQueue.findIndex((r) => r.entry === entry);
    if (i >= 0) this.capQueue.splice(i, 1)[0]!.settle("gone");
    this.endCapWait(entry);
  }

  /** Check the queue on every state change (D3): start what fits, put idle chats to sleep for the rest. */
  private pump(): void {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        this.pumpOnce();
      } while (this.pumpAgain);
    } finally {
      this.pumping = false;
    }
  }

  private pumpOnce(): void {
    const max = Math.max(1, this.opts.maxLive ?? this.settings["chats.maxLive"]);
    while (this.capQueue.length > 0) {
      const req = this.capQueue[0]!;
      const e = req.entry;
      if (e.deleted || e.deleting || e.ledger.archivedAt !== null || this.draining) {
        this.capQueue.shift();
        req.settle("gone");
        continue;
      }
      // The restart's drain (S9) starts nothing either: what waits stays, Queued.
      if (e.held || this.restartDrain) {
        this.capQueue.shift();
        req.settle("held");
        continue;
      }
      if (this.liveCount() >= max) break;
      this.capQueue.shift();
      this.startChat(req);
    }
    if (this.capQueue.length === 0) return;
    let prospects = 0;
    for (const e of this.entries.values()) if (e.phase === "ending") prospects++;
    for (let k = 0; k < this.capQueue.length; k++) {
      if (k < prospects) continue;
      const victim = this.pickVictim();
      if (victim) {
        prospects++;
        void this.endChat(victim);
        continue;
      }
      this.capQueue[k]!.settle("queued");
    }
  }

  /** The least recently used chat that is idle, has no viewer, no open card and no running task that is not ambient. */
  private pickVictim(): Entry | null {
    let best: Entry | null = null;
    for (const e of this.entries.values()) {
      if (e.phase !== "live" || this.computeState(e) !== "idle" || e.live?.closing) continue;
      if (e.viewers.size > 0 || e.cards.size > 0 || this.busyTasks(e) || e.bashRunning || e.bashQueue.length > 0 || e.waiting.length > 0) continue;
      // R124: nor one whose side question runs.
      if (this.side.running(e.id)) continue;
      if (!best || e.ledger.lastActivityAt < best.ledger.lastActivityAt) best = e;
    }
    return best;
  }

  private startChat(req: StartRequest): void {
    const entry = req.entry;
    entry.phase = "starting";
    const p: Promise<StartResult> = this.doStart(entry, req.probe).then((r) => {
      if (entry.starting === p) entry.starting = null;
      req.settle(r);
      return r;
    });
    entry.starting = p;
    this.refresh(entry);
  }

  private gone(entry: Entry): boolean {
    return entry.deleted || entry.deleting || entry.ledger.archivedAt !== null || this.draining;
  }

  private async doStart(entry: Entry, given: BinaryProbe | undefined): Promise<StartResult> {
    const fallBack = (r: StartResult, notice: ErrorCode | null): StartResult => {
      entry.phase = "sleeping";
      this.endCapWait(entry);
      this.dropWaiting(entry, notice);
      this.refresh(entry);
      this.pump();
      return r;
    };
    let probe: BinaryProbe;
    try {
      probe = given ?? (await this.deps.driver.probe());
    } catch {
      return fallBack("failed", "failed");
    }
    this.claude = statusOf(probe);
    if (this.gone(entry)) return fallBack("gone", null);
    if (!probe.ok) return fallBack("no_claude", "no_claude");
    let agent: AgentSettings | null = null;
    try {
      // A chat in its own worktree reads its project's settings, as its Claude Code does (projectConfigRoot, G3).
      agent = await this.deps.driver.settings(configFolder(entry.ledger));
    } catch {
      agent = null;
    }
    // Row 73 (W4, L35): before every start, the chat's worktree is checked with file reads, and a gone one starts
    // nothing; after Claude Code's own refusal to resume it in its worktree (W5), nothing starts until the user's choice.
    const projectCwd = (await this.project(entry.ledger.project))?.cwd ?? null;
    const refusal = entry.ledger.refused ?? startCheck(entry.ledger, projectCwd);
    if (refusal) {
      const r = fallBack("refused", null);
      this.refuseStart(entry, refusal);
      return r;
    }
    if (this.gone(entry)) return fallBack("gone", null);
    const at = this.now();
    // The brief's sessionId rule (D41, live L1): kitespan's own id on the first start, while no transcript exists for
    // it; `resume` once the transcript exists. Never both.
    let resume: Marked<string> | null = null;
    let sessionId: Marked<string> | null = null;
    const sid = entry.ledger.sessionId;
    if (sid === null) {
      const id = crypto.randomUUID();
      this.setSession(entry, id);
      await this.persist(entry);
      sessionId = { value: id, mark: markOf(MARK_PHRASES.newSession, at) };
    } else if (!(await this.hasTranscript(entry, sid))) {
      sessionId = { value: sid, mark: markOf(MARK_PHRASES.newSession, at) };
      // A new transcript is filed under the chat's own folder, and the row names the session once it exists.
      if (entry.ledger.sessionDir !== undefined || entry.ledger.transcript) {
        delete entry.ledger.sessionDir;
        delete entry.ledger.transcript;
        await this.persist(entry);
      }
    } else {
      resume = { value: sid, mark: markOf(MARK_PHRASES.resume, at) };
    }
    if (this.gone(entry)) return fallBack("gone", null);
    // Row 78: right before a resume the registry is read again. A session that another process has open starts
    // nothing; what waited stays, Queued, for the start after the hold. So for the restart's drain (S9).
    if (entry.held || (resume && (await this.heldNow(entry))) || this.restartDrain) {
      if (this.gone(entry)) return fallBack("gone", null);
      entry.phase = "sleeping";
      entry.yielding = false;
      this.endCapWait(entry);
      this.refresh(entry);
      this.pump();
      return "held";
    }
    if (this.gone(entry)) return fallBack("gone", null);
    // D60: the environment's variables, read right before every start (a resume gets the set as it is now); a file
    // that could not be read starts nothing (L39).
    const vars = this.deps.env ? this.deps.env.vars(entry.ledger.project) : [];
    if (vars === null) return fallBack("env_unreadable", "env_unreadable");
    const gen = ++this.gen;
    const input: OpenInput = {
      chatId: entry.id,
      cwd: entry.ledger.cwd,
      resume,
      sessionId,
      ledgerSessionId: entry.ledger.sessionId,
      picks: this.markedPicks(entry, at),
      switches: this.switches(agent, at),
      env: markedVars(vars, at),
      worktree: openWorktree(entry.ledger, projectCwd),
      cards: this.cardHost(entry, gen),
    };
    let chat: AgentChat;
    try {
      chat = this.deps.driver.open(input);
    } catch {
      this.error("spawn_failed", entry.id);
      return fallBack("failed", "failed");
    }
    const live: Live = {
      gen,
      chat,
      startedAt: this.ms(),
      firstEvent: false,
      exitSeen: false,
      requested: false,
      sessionIdStart: sessionId?.value ?? null,
      procNoted: false,
      env: input.env?.value ?? [],
      done: Promise.resolve(),
      closing: null,
    };
    entry.live = live;
    entry.phase = "live";
    this.endCapWait(entry);
    entry.titleTried = entry.ledger.title !== null && entry.ledger.title.from !== "first-prompt";
    live.done = this.run(entry, live);
    this.log("claude_start", { chat: entry.id });
    for (const w of entry.waiting.splice(0)) this.submit(entry, w);
    this.refresh(entry);
    return "started";
  }

  /**
   * A start that failed or was cancelled: what waited for it goes back (a message's row goes, a command's row stays as
   * Not run, and the text goes to the draft).
   */
  private dropWaiting(entry: Entry, code: ErrorCode | null): void {
    // A start that a shutdown cancelled keeps the messages for the next server (L6).
    const back = this.takeBackAll(entry, this.draining ? this.shutdownSplit(entry, entry.waiting) : entry.waiting.splice(0));
    if (back.shown && code) this.emit(entry, startNotice(code));
    void this.returnToDraft(entry, back.msgs, null, back.jobs);
  }

  /**
   * Archive: what waited for a start is dropped. A message or a `!` command that every page already shows goes back
   * to the draft (the command's row stays, Not run); one whose request still waits for its ack gets `archived`, and
   * its page keeps the text.
   */
  private dropStarts(entry: Entry): { msgs: PendingMsg[]; jobs: BashJob[] } {
    this.unqueue(entry);
    return this.takeBackAll(entry, entry.waiting.splice(0));
  }

  /** What waited behind a `!` command on a live chat whose process ends (archive, an exit): it goes back, as above. */
  private dropBehindBash(entry: Entry): { msgs: PendingMsg[]; jobs: BashJob[] } {
    return this.takeBackAll(entry, entry.bashQueue.splice(0));
  }

  /**
   * Each message's row goes from every page (`taken_back`); each `!` command's row stays, as Not run, live and in
   * history (the notes keep it). The ones that a page shows are returned for the draft.
   */
  private takeBackAll(entry: Entry, items: readonly Waiting[]): { msgs: PendingMsg[]; jobs: BashJob[]; shown: boolean } {
    const out = { msgs: [] as PendingMsg[], jobs: [] as BashJob[], shown: false };
    const dropped: string[] = [];
    for (const w of items) {
      if (w.kind === "send") {
        entry.pending.delete(w.msg.uuid);
        dropped.push(w.msg.uuid);
      }
      if (!(w.kind === "send" ? w.msg.announced : w.job.announced)) continue;
      out.shown = true;
      if (w.kind === "send") {
        this.emit(entry, { k: "taken_back", uuid: w.msg.uuid });
        out.msgs.push(w.msg);
      } else {
        this.showBash(entry, w.job, "not_run");
        out.jobs.push(w.job);
      }
    }
    this.noteNotRun(entry, out.jobs);
    // RD-8: a message that goes back to its draft, or to its page, no longer waits.
    if (dropped.length > 0) void entry.queue.drop(dropped);
    return out;
  }

  /**
   * Keep `!` rows that never ran in the chat's notes, each placed where the transcript ends now (where the live row
   * is), so history draws them there after a reload and after a restart. A transcript that cannot be read leaves them
   * out of history.
   */
  private noteNotRun(entry: Entry, jobs: readonly BashJob[]): void {
    if (jobs.length === 0) return;
    const rows = jobs.map((j) => ({ uuid: j.uuid, input: capText(j.input, LIMITS.bashInput) }));
    this.note(entry, async (n) => {
      const at = await this.transcriptEnd(entry);
      if (at) n.notRun.push(...rows.map((r) => ({ ...r, ...at })));
    });
  }

  /** Where the chat's transcript ends now (history.ts notRunAnchor); null when it cannot be read. */
  private async transcriptEnd(entry: Entry): Promise<{ after: string | null; skip: number } | null> {
    const sid = entry.ledger.sessionId;
    if (!sid) return { after: null, skip: 0 };
    let at: { after: string | null; skip: number } | null = null;
    try {
      await this.deps.driver.history(sid, sessionFolder(entry.ledger), {
        before: null,
        maxBytes: PAGE_BUDGET,
        decorate: (events) => {
          at = notRunAnchor(events);
          return [];
        },
      });
    } catch {
      this.error("sdk_error", entry.id);
      return null;
    }
    return at;
  }

  /** The message loop: it never leaves while the agent lives, whatever the sockets do (4.1). */
  private async run(entry: Entry, live: Live): Promise<void> {
    try {
      for await (const e of live.chat.events) {
        try {
          this.onAgentEvent(entry, live, e);
        } catch {
          this.error("unknown", entry.id);
        }
      }
    } catch {
      this.error("sdk_error", entry.id);
    }
    this.onExit(entry, live);
  }

  private onAgentEvent(entry: Entry, live: Live, e: ChatEvent): void {
    if (entry.live !== live || entry.deleted) return;
    live.firstEvent = true;
    this.noteProc(entry, live);
    this.touch(entry, false);
    // Row 111: what Send now needs to know, and the queued messages that this reply frame shows Claude took in.
    const read = entry.sendNow.note(e, () => this.cliWaiting(entry));
    if (read.length) this.markRead(entry, read);
    switch (e.k) {
      case "card_open":
      case "card_close":
        break; // the registry makes these from the CardHost
      case "edit_patch":
      case "changes":
        break; // U1: the turn's marks read a file tool's patch (below); a card is the registry's own
      case "taken_in":
        live.stamps = true;
        this.consumeQueued(entry, e.uuids);
        break;
      case "user":
        if (!entry.made.has(e.uuid)) this.emit(entry, e); // else the CLI's echo of the server's own event (D49)
        break;
      case "turn_start":
        if (entry.turn) break;
        this.turnStart(entry, e.by);
        // A Claude Code that stamps names what this turn takes in (taken_in); with one that does not, the oldest goes.
        if (e.by === "user" && !live.stamps) this.consumeQueued(entry, null);
        break;
      case "turn_end": {
        // A turn that a Stop ended (a page's Stop, Stop and archive): every page shows the same end, not the error
        // that Claude Code reports for it, whichever page pressed Stop (D49).
        // Restart now's cut: its stop line says what happened, so no page draws Interrupted for it (DESIGN 4.10).
        const end: ChatEventOf<"turn_end"> = entry.turn?.interrupted ? { ...e, ok: false, subtype: entry.turn.cut ? TURN_CUT : TURN_INTERRUPTED, error: null } : e;
        // The turn's calls that got no result will get none: every page tags them Stopped.
        this.stopCalls(entry, null);
        const it = this.emit(entry, end);
        if (entry.turn) this.noteTurn(entry, entry.turn, end, it.seq);
        entry.turn = null;
        entry.lastTurnEndSeq = it.seq;
        entry.openBlocks.clear();
        // A turn ran, so Claude Code has written the session's transcript: its next start resumes it (D41).
        if (entry.ledger.sessionId) entry.transcript = entry.ledger.sessionId;
        this.markTranscript(entry, entry.ledger.sessionId);
        this.consumeQueued(entry, end.uuids);
        this.settleRead(entry, end.uuids);
        // RD-8: what ran leaves the queue file; what still waits stays.
        void entry.queue.keepOnly((u) => entry.pending.has(u));
        this.log("turn_end", { chat: entry.id, ok: end.ok, ms: end.durationMs });
        this.nextBash(entry);
        void this.maybeTitle(entry, live, end.ok);
        void this.refreshBranch(entry);
        // Row 116: an end that no page has on screen waits to be seen (a Stop's and Restart now's set nothing).
        this.markUnseen(entry, endUnseen(end));
        break;
      }
      case "session":
        if (e.sessionId && e.sessionId !== entry.ledger.sessionId) {
          this.setSession(entry, e.sessionId);
          void this.persist(entry);
        }
        // Claude Code's init of the session: its transcript exists from here on, so the row names it.
        this.markTranscript(entry, entry.ledger.sessionId);
        // A start that went through: a refused start's buttons are done with (W4, W5).
        this.clearRefusal(entry);
        if (this.envNow(entry, live)) this.kept.session(entry.ledger.project, e);
        this.emit(entry, e);
        break;
      case "tasks":
        entry.tasks = e.running.map((t) => ({ ...t }));
        this.emit(entry, e);
        break;
      case "task": {
        if (e.ev === "started") entry.seenTasks.add(e.taskId);
        else if (e.ev === "done") entry.seenTasks.delete(e.taskId);
        if (e.toolUseId) entry.taskCalls.set(e.taskId, e.toolUseId);
        this.emit(entry, e);
        // A subagent or a workflow that ended: its own calls that got no result will get none.
        const call = e.toolUseId ?? entry.taskCalls.get(e.taskId);
        if (e.ev === "done" && call) this.stopCalls(entry, call);
        if (e.ev === "done") entry.taskCalls.delete(e.taskId);
        break;
      }
      case "commands":
        entry.commands = e.list;
        this.emit(entry, e);
        this.keepCommands(entry, e.list);
        break;
      case "title": {
        // A rename always wins (D13): the user's own (a /rename typed in the chat, a rename in the terminal) replaces
        // any title before it, and nothing else replaces a rename. Claude Code sends a name again at a start and after
        // a change of its own: the same name is no change.
        const was = entry.ledger.title;
        if (was?.from === "renamed" && e.from !== "renamed") break;
        const text = capText(cleanLabel(e.title), LIMITS.title);
        if (!text || (was?.text === text && was.from === e.from)) break;
        entry.ledger.title = { text, from: e.from };
        void this.persist(entry);
        this.emit(entry, { k: "title", title: text, from: e.from });
        break;
      }
      case "exit":
        live.exitSeen = true;
        // The cards go with the process (lost), then its calls stop, then the exit line.
        for (const id of [...entry.cards.keys()]) this.closeCard(entry, id, null, "lost");
        this.stopCalls(entry, "all");
        entry.ledger.lastExit = { code: e.code, signal: e.signal, at: this.iso() };
        // Claude Code refused this start's `sessionId` because its transcript exists: the next start resumes (live L1).
        if (live.sessionIdStart && e.stderr.some((l) => SESSION_IN_USE.test(l))) {
          entry.transcript = live.sessionIdStart;
          this.markTranscript(entry, live.sessionIdStart);
        }
        // W5: Claude Code refused the start itself: one line with its buttons in the exit line's place, and nothing
        // starts again by itself. After `worktree_resume_refused` a new start could run without the worktree, so the
        // ledger keeps the refusal until the user's explicit choice (the `worktree` frame).
        {
          const code = e.startup ? startupCode(e.startup.reason, entry.ledger) : null;
          if (e.startup) {
            live.startRefused = true;
            // The message that the registry drew as starting a turn never ran either: it goes back with the rest
            // (onExit), first, in the order sent.
            const starters = (live.unseen ?? []).filter((m) => !entry.pending.has(m.uuid));
            const rest = [...entry.pending];
            entry.pending.clear();
            for (const m of starters) entry.pending.set(m.uuid, Object.assign(m, { where: "cli" as const }));
            for (const [u, m] of rest) entry.pending.set(u, m);
          }
          if (code) {
            // The turn that the registry drew ends with no line of its own: the refusal's line says what happened.
            if (entry.turn) {
              const it = this.emit(entry, { k: "turn_end", ok: false, subtype: TURN_CUT, durationMs: 0, error: null, uuids: [] });
              this.noteTurn(entry, entry.turn, { ok: false, subtype: TURN_CUT, durationMs: 0, error: null, uuids: [] }, it.seq);
              entry.turn = null;
              entry.lastTurnEndSeq = it.seq;
            }
            if (code === "worktree_resume_refused") {
              entry.ledger.refused = code;
              void this.persist(entry);
            }
            this.refuseStart(entry, code, e.startup!.line);
            break;
          }
        }
        // The exit line is for a process that ended by itself (4.1); a close that kitespan asked for draws none. Row
        // 116: the line is an end that failed, which waits to be seen.
        if (!live.requested) {
          this.emit(entry, e);
          this.markUnseen(entry, "failed");
        }
        break;
      default:
        if (!entry.turn && startsActivity(e)) this.turnStart(entry, "agent");
        if (e.k === "tool_call") entry.openCalls.set(e.id, { parent: e.parent, name: e.name });
        else if (e.k === "tool_result" || e.k === "denied" || e.k === "tool_stopped") entry.openCalls.delete(e.id);
        // R127: a refused row is noted (a live refusal clears its folder's answer) and gets its root. R131: a launch
        // row's sessions go in the chat's book after the row, so every page has the row before its line.
        {
          const row = this.trustRow(entry, e, true);
          this.emit(entry, row);
          this.noteLaunches(entry, row, true);
        }
    }
    // U1: the turn's tools' windows and targets, and the file tools' own patches (`edit_patch`, never a page's).
    if (entry.marks && this.deps.changes) this.deps.changes.note(entry.marks, e);
    this.refresh(entry);
  }

  /**
   * The process's calls that will get no result, as `tool_stopped` for every page: at a turn's end (`null`) the main
   * thread's calls and the calls inside them; when a task ends (its tool-use id) the calls inside its block; at the
   * process's end (`all`) every call. A call inside a subagent that runs on in the background is not the turn's.
   */
  private stopCalls(entry: Entry, under: string | null | "all"): void {
    const open = entry.openCalls;
    if (open.size === 0 || entry.deleted) return;
    const stop = new Set<string>();
    if (under === "all") for (const id of open.keys()) stop.add(id);
    else {
      for (const [id, c] of open) if (c.parent === under) stop.add(id);
      for (let grew = stop.size > 0; grew; ) {
        grew = false;
        for (const [id, c] of open)
          if (!stop.has(id) && c.parent !== null && stop.has(c.parent)) {
            stop.add(id);
            grew = true;
          }
      }
    }
    for (const [id, c] of [...open]) {
      if (!stop.has(id)) continue;
      open.delete(id);
      this.emit(entry, { k: "tool_stopped", id, parent: c.parent });
    }
  }

  /** A turn starts. `first`: the history id of its first row when that row came before its start (a `!` row). */
  private turnStart(entry: Entry, by: "user" | "agent", first?: string): void {
    const it = this.emit(entry, { k: "turn_start", by });
    entry.turn = { seq: it.seq, interrupted: false, item: it, by, ids: first ? [first] : [], last: first ? [first] : [] };
    // U1: the turn's start mark (a user's message waits for it in deliver); one left from a turn that went is dropped.
    if (entry.marks) this.deps.changes?.drop(entry.marks);
    entry.marks = this.deps.changes?.begin(entry.id, entry.ledger.cwd, by) ?? null;
  }

  /**
   * U1: put something on the live chat's input: now when nothing waits, else after what waits (in order), and after
   * `wait` (a turn's start mark). A failed put is the SDK's error, as a send's.
   */
  private toInput(entry: Entry, wait: Promise<void> | null, put: () => Promise<void>): void {
    const before = entry.inputWait ?? null;
    if (!wait && !before) {
      put().catch(() => this.error("sdk_error", entry.id));
      return;
    }
    const next = Promise.all([before, wait])
      .then(() => put())
      .catch(() => this.error("sdk_error", entry.id));
    entry.inputWait = next;
    void next.then(() => {
      if (entry.inputWait === next) entry.inputWait = null;
    });
  }

  /** U1: the turn's end mark and summary; its card goes to every page (`changes`) when the turn changed files. */
  private async endChanges(entry: Entry, marks: TurnChanges, ids: readonly string[]): Promise<void> {
    const book = this.deps.changes;
    if (!book) return;
    let card;
    try {
      card = await book.end(entry.id, entry.ledger.cwd, marks, ids);
    } catch {
      return;
    }
    if (!card || entry.deleted || entry.deleting || this.entries.get(entry.id) !== entry) return;
    this.emit(entry, { k: "changes", ...card });
  }

  /**
   * U2: the turn that ends, in the chat's notes (TurnNote), so history gives every page its start and end (turns.ts
   * insertTurns, D49). A turn with no row has nothing to place.
   */
  private noteTurn(entry: Entry, turn: NonNullable<Entry["turn"]>, end: Pick<ChatEventOf<"turn_end">, "ok" | "subtype" | "durationMs" | "error" | "uuids">, seq: number): void {
    // U1: the turn's end mark (every end: an Interrupted or failed one too); a turn with no row has no card.
    const marks = entry.marks;
    entry.marks = null;
    if (!turn.ids.length) {
      if (marks) this.deps.changes?.drop(marks);
      return;
    }
    if (marks) void this.endChanges(entry, marks, turn.ids.slice(0, 2));
    const note: TurnNote = {
      ids: turn.ids.slice(0, 2),
      last: turn.last.slice(0, 2),
      by: turn.by,
      ok: end.ok,
      subtype: capText(end.subtype || "success", 64),
      durationMs: Math.min(7 * 86_400_000, Math.max(0, Math.round(Number.isFinite(end.durationMs) ? end.durationMs : 0))),
      uuids: end.uuids.filter((u) => UUID.test(u)).slice(0, STORE_LIMITS.queueMessages),
      error: turnErrorNote(end.error),
    };
    entry.turnEnds.set(note, seq);
    this.note(entry, (n) => void (n.turns ??= []).push(note));
  }

  /** D13: the agent's own title, once after the first reply, unless the user renamed the chat. */
  private async maybeTitle(entry: Entry, live: Live, okTurn: boolean): Promise<void> {
    if (!okTurn || entry.titleTried || !this.caps.titles || !this.settings["chats.generateTitles"]) return;
    entry.titleTried = true;
    let text: string | null;
    try {
      text = await live.chat.generateTitle();
    } catch {
      return;
    }
    const clean = text === null ? "" : cleanLabel(text);
    if (!clean || entry.deleted || entry.ledger.title?.from === "renamed") return;
    entry.ledger.title = { text: capText(clean, LIMITS.title), from: "generated" };
    void this.persist(entry);
    this.emit(entry, { k: "title", title: entry.ledger.title.text, from: "generated" });
    this.refresh(entry);
  }

  private onExit(entry: Entry, live: Live): void {
    if (entry.live !== live) return;
    this.ended(entry);
    // R124: the side question that went to this process does not finish.
    this.side.abort(entry.id, "ended", live.chat);
    const requested = live.requested;
    if (!live.exitSeen && !entry.deleted) {
      if (!requested) {
        this.emit(entry, { k: "exit", code: null, signal: null, stderr: [] });
        // Row 116: as the exit line of the `exit` event; the refresh below sends the delta.
        this.markUnseen(entry, "failed");
      }
      entry.ledger.lastExit = { code: null, signal: null, at: this.iso() };
    }
    for (const id of [...entry.cards.keys()]) this.closeCard(entry, id, null, "lost");
    this.stopCalls(entry, "all");
    entry.openCalls.clear();
    entry.taskCalls.clear();
    entry.sendNow.reset();
    // U2: a turn that ran when its Claude Code ended by itself ends as every page drew it at the exit line, failed
    // (reduce.ts `exit`). A close that kitespan asked for (a restart, a shutdown) notes none: its own stop line says
    // it, and an orphan of kitespan's own may still finish the turn (R16).
    if (entry.turn && !requested) this.noteTurn(entry, entry.turn, { ok: false, subtype: "exit", durationMs: 0, error: null, uuids: [] }, entry.seq);
    entry.turn = null;
    // U1: a turn that a close of kitespan's own cut has no end mark this round (DESIGN-U1 19).
    if (entry.marks) this.deps.changes?.drop(entry.marks);
    entry.marks = null;
    entry.openBlocks.clear();
    // Messages in Claude Code's own queue are gone with its process. After an exit by itself, the page drops their
    // Queued labels at `exit`; a close that kitespan asked for draws no exit line, so they are taken back to the draft.
    const lost: PendingMsg[] = [];
    for (const [uuid, m] of [...entry.pending]) {
      if (m.where !== "cli") continue;
      entry.pending.delete(uuid);
      lost.push(m);
    }
    // Row 78: a close that gives the session up keeps what waits, Queued, for the start after the hold, in the order
    // sent: what is in the server's own queue already, then Claude Code's queue, then what waited behind a `!` command.
    const keep = requested && entry.yielding && !this.gone(entry);
    entry.yielding = false;
    if (keep) {
      for (const m of lost) {
        m.where = "cap";
        entry.pending.set(m.uuid, m);
        entry.waiting.push({ kind: "send", msg: m });
      }
      for (const w of entry.bashQueue.splice(0)) {
        if (w.kind === "send") w.msg.where = "cap";
        entry.waiting.push(w);
      }
    } else if (this.draining && !entry.deleted && !entry.deleting) {
      // L6: a shutdown keeps the messages of Claude Code's queue and those behind a `!` command in the queue file, for
      // the next server; a `!` command that waits keeps today's rule (L5).
      const behind = this.takeBackAll(entry, this.shutdownSplit(entry, entry.bashQueue));
      void this.returnToDraft(entry, [], null, behind.jobs);
    } else {
      // W5: what a refused start had on its input never ran, so it goes back to the draft too.
      const back = (requested || live.startRefused) && lost.length > 0 ? lost : [];
      for (const m of back) if (!entry.deleted && !entry.deleting) this.emit(entry, { k: "taken_back", uuid: m.uuid });
      // What waited behind a `!` command never reached Claude Code: it goes back too, however the process ended.
      if (entry.deleted || entry.deleting) entry.bashQueue = [];
      const behind = this.dropBehindBash(entry);
      if (!entry.deleted && !entry.deleting) void this.returnToDraft(entry, [...back, ...behind.msgs], null, behind.jobs);
    }
    // RD-8: the process is gone, and with it what ran and what Claude Code's queue held; a shutdown keeps all of it.
    if (!this.draining) void entry.queue.keepOnly((u) => entry.pending.has(u));
    // R16: no process of the chat's own lives now.
    delete entry.ledger.proc;
    // No process, no running task (4.1); a page that attaches later reads the empty set as the newest.
    if (entry.tasks.length > 0 && !entry.deleted) this.emit(entry, { k: "tasks", running: [] });
    entry.tasks = [];
    entry.seenTasks.clear();
    entry.modeOverride = null;
    entry.live = null;
    entry.phase = "sleeping";
    this.clearIdle(entry);
    this.log("claude_exit", { chat: entry.id, code: entry.ledger.lastExit?.code ?? null, signal: entry.ledger.lastExit?.signal ?? null, ms: this.ms() - live.startedAt });
    if (!entry.deleted) {
      void this.persist(entry);
      this.refresh(entry);
    }
    // W5: never a new start by itself after Claude Code refused one; what waited goes back to the draft.
    if (live.startRefused && entry.waiting.length > 0 && !this.gone(entry)) this.dropWaiting(entry, null);
    // A message sent while the chat was ending, or what waited while it gave its session up, waits for a new start
    // (none while another process holds the session: the hold's end starts it, row 78).
    if (entry.waiting.length > 0 && !this.gone(entry) && !entry.held && !this.capQueue.some((r) => r.entry === entry)) {
      void this.requestStart(entry).then((r) => {
        if (r === "queued" && keep) this.capNotice(entry);
      });
    }
    this.pump();
  }

  /**
   * End a live chat with `close()` only (4.1); with `interrupt`, open cards are dismissed and the turn is stopped
   * first (Stop and archive, a delete of a busy chat). `cut` (Restart now): the turn ends as cut, and its cards go with
   * the process (lost), since the chat's stop line says what happened. Resolves when the process is gone.
   */
  private endChat(entry: Entry, opts: { interrupt?: boolean; cut?: boolean } = {}): Promise<void> {
    const live = entry.live;
    if (!live) return Promise.resolve();
    if (!live.closing) {
      live.requested = true;
      entry.phase = "ending";
      this.clearIdle(entry);
      if (opts.interrupt) {
        if (entry.turn) {
          entry.turn.interrupted = true;
          if (opts.cut) entry.turn.cut = true;
        }
        for (const id of [...entry.cards.keys()]) this.closeCard(entry, id, null, opts.cut ? "lost" : "cancelled");
      }
      this.refresh(entry);
      const grace = this.opts.closeGraceMs ?? 2_000;
      live.closing = (async () => {
        if (opts.interrupt) await within(live.chat.interrupt().catch(() => null), grace);
        await within(live.chat.close().catch(() => this.error("sdk_error", entry.id)), this.opts.shutdownMs ?? 8_000);
        await within(live.done, grace);
        if (entry.live === live) this.onExit(entry, live);
      })();
    }
    return live.closing;
  }

  // -------------------------------------------------------------------------------------------------------------
  // The idle rule (D2)

  private busyTasks(entry: Entry): boolean {
    return entry.tasks.some((t) => !t.ambient);
  }

  private idleMs(): number {
    return Math.max(0, this.opts.idleMs ?? this.settings["chats.keepIdleMinutes"] * 60_000);
  }

  private idleEligible(entry: Entry): boolean {
    return (
      entry.phase === "live" &&
      !entry.live?.closing &&
      this.computeState(entry) === "idle" &&
      entry.viewers.size === 0 &&
      !this.busyTasks(entry) &&
      !entry.bashRunning &&
      entry.bashQueue.length === 0 &&
      entry.waiting.length === 0 &&
      // R124: a side question in flight needs the process (it is no turn: the chat stays idle).
      !this.side.running(entry.id)
    );
  }

  /** A live chat with no viewer and nothing running sleeps after the limit; anything else stops the timer. */
  private reviewIdle(entry: Entry): void {
    this.reviewRing(entry);
    if (!this.idleEligible(entry)) {
      this.clearIdle(entry);
      return;
    }
    if (entry.idleTimer) return;
    const t = setTimeout(() => {
      entry.idleTimer = null;
      if (this.idleEligible(entry)) void this.endChat(entry);
    }, this.idleMs());
    (t as { unref?: () => void }).unref?.();
    entry.idleTimer = t;
  }

  private clearIdle(entry: Entry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }

  /** L11: a chat that sleeps, with no viewer and nothing that waits or runs, may lose its ring (an attach then snapshots). */
  private ringIdle(entry: Entry): boolean {
    return entry.phase === "sleeping" && entry.viewers.size === 0 && !entry.bashRunning && entry.bashQueue.length === 0 && entry.waiting.length === 0;
  }

  /** R8: the ring of a chat that has been ringIdle for RING_KEEP_MS goes; anything else stops the timer. */
  private reviewRing(entry: Entry): void {
    if (!this.ringIdle(entry) || entry.ring.size === 0) {
      if (entry.ringTimer) clearTimeout(entry.ringTimer);
      entry.ringTimer = null;
      return;
    }
    if (entry.ringTimer) return;
    const t = setTimeout(() => {
      entry.ringTimer = null;
      if (this.ringIdle(entry)) entry.ring.clear();
    }, RING_KEEP_MS);
    (t as { unref?: () => void }).unref?.();
    entry.ringTimer = t;
  }

  // -------------------------------------------------------------------------------------------------------------
  // State, rows, events

  private computeState(entry: Entry): ChatState {
    if (entry.phase !== "live") return entry.phase;
    if (entry.cards.size > 0) return "waiting";
    if (entry.turn) return entry.live?.firstEvent ? "running" : "starting";
    return "idle";
  }

  /**
   * The state the pages show: the chat's own, except while kitespan's own orphan finishes its turn (R16), which is a
   * running turn for the lists, the Working filter and the restart dialog. The ledger keeps the chat's own (sleeping).
   */
  private shownState(entry: Entry): ChatState {
    return this.orphanRuns(entry) ? "running" : this.computeState(entry);
  }

  /** R16: kitespan's own orphan of a server before this one still runs this chat's turn (an archived chat's is ending). */
  private orphanRuns(entry: Entry): boolean {
    return entry.orphan !== null && entry.ledger.archivedAt === null && !entry.deleted && !entry.deleting;
  }

  private liveOf(entry: Entry): Live | null {
    return entry.phase === "live" ? entry.live : null;
  }

  /**
   * D60: the live chat runs with its environment's variables as they are now. One that started before a change keeps
   * the old values (E3), so what its Claude Code reports is another environment's: none of it is kept with the project.
   */
  private envNow(entry: Entry, live: Live): boolean {
    if (!this.deps.env) return true;
    const now = this.deps.env.vars(entry.ledger.project);
    return now !== null && now.length === live.env.length && now.every((v, i) => v.name === live.env[i]!.name && v.value === live.env[i]!.value);
  }

  private rowOf(entry: Entry): ChatRow {
    const held = this.holdOf(entry);
    return {
      chat: entry.id,
      title: entry.ledger.title?.text ?? null,
      project: entry.ledger.project,
      state: this.shownState(entry),
      needsYou: entry.cards.size > 0,
      lastActivity: entry.ledger.lastActivityAt,
      archived: entry.ledger.archivedAt !== null,
      busy: this.isBusy(entry),
      ...(held ? { held } : {}),
      // FIX-W25b 1.5: the session only once its transcript is known to exist (a page forks it, or resumes it).
      ...(entry.ledger.sessionId && entry.ledger.transcript ? { session: entry.ledger.sessionId } : {}),
      ...this.worktreeRow(entry),
      // Row 116: only while an end waits to be seen.
      ...(entry.ledger.unseen ? { unseen: entry.ledger.unseen } : {}),
      // R131: only while one of the chat's background sessions needs input, or ended unseen; never on an archived chat.
      ...this.bgRow(entry),
    };
  }

  /** R131: the row's `background` (background.ts rowState); none on an archived chat. */
  private bgRow(entry: Entry): { background?: ChatRow["background"] } {
    const state = entry.ledger.archivedAt === null ? this.bg.rowState(entry.id) : null;
    return state ? { background: state } : {};
  }

  /** Row 73 (W6): the row's `worktree` while the chat runs in one. */
  private worktreeRow(entry: Entry): { worktree?: ChatWorktree } {
    const w = rowWorktree(entry.ledger, this.projectCwds.get(entry.ledger.project) ?? null, entry.branch);
    return w ? { worktree: w } : {};
  }

  /** Row 78: the row's `held`: the app that has the chat's session open now, and that session. */
  private holdOf(entry: Entry): ChatHold | null {
    const sid = entry.ledger.sessionId;
    if (!entry.held || !sid || entry.ledger.archivedAt !== null) return null;
    if (entry.orphan) return { app: entry.held, session: sid, kind: "finishing" };
    return this.handed.has(entry.id) ? { app: entry.held, session: sid, kind: "handed" } : { app: entry.held, session: sid };
  }

  /**
   * After any change: a chat-list delta with the changed fields, the ledger on a state change, the timers, the cap.
   * While starts wait for a slot, every change is checked (D3): the end of a task or of a `!` command frees a chat
   * for the cap without changing its state.
   */
  private refresh(entry: Entry): void {
    if (entry.deleted) return;
    const state = this.computeState(entry);
    const stateChanged = state !== entry.state;
    entry.state = state;
    // While a delete runs, no delta goes out: a page would add the row back before `{chat, gone: true}`.
    if (entry.hold === 0 && !entry.deleting) this.sendDelta(entry);
    if (stateChanged) void this.persist(entry);
    this.reviewIdle(entry);
    // Row 78: a process that gives its session up ends at its first quiet moment, as the idle timer would end it.
    if (entry.yielding && this.quiet(entry)) void this.endChat(entry);
    if (entry.phase === "sleeping" && !entry.orphan && this.handed.get(entry.id) === null) this.armHandOver(entry);
    if (stateChanged || this.capQueue.length > 0) this.pump();
  }

  private sendDelta(entry: Entry): void {
    const row = this.rowOf(entry);
    const prev = entry.row;
    const delta: Record<string, unknown> = {};
    let changed = false;
    for (const k of ["title", "project", "state", "needsYou", "archived", "busy"] as const) {
      if (row[k] !== prev[k]) {
        delta[k] = row[k];
        changed = true;
      }
    }
    // W5: the session id once the chat has one (a page that never saw its `session` event forks it from the row).
    if (row.session !== prev.session) {
      delta.session = row.session ?? null;
      changed = true;
    }
    // A row has held only while it is set; the delta that takes it away says null (row 78).
    if (row.held?.app !== prev.held?.app || row.held?.session !== prev.held?.session || row.held?.kind !== prev.held?.kind) {
      delta.held = row.held ?? null;
      changed = true;
    }
    // Row 73: the worktree only while the chat runs in one; the delta that takes it away says null.
    if (row.worktree?.path !== prev.worktree?.path || row.worktree?.branch !== prev.worktree?.branch || row.worktree?.kept !== prev.worktree?.kept) {
      delta.worktree = row.worktree ?? null;
      changed = true;
    }
    // Row 116: the seen flag only while an end waits to be seen; the delta that takes it away says null.
    if (row.unseen !== prev.unseen) {
      delta.unseen = row.unseen ?? null;
      changed = true;
    }
    // R131: the background sessions' field the same way.
    if (row.background !== prev.background) {
      delta.background = row.background ?? null;
      changed = true;
    }
    const at = this.ms();
    if (row.lastActivity !== prev.lastActivity && (changed || at - entry.activitySentAt >= ACTIVITY_DELTA_MS)) {
      delta.lastActivity = row.lastActivity;
      entry.activitySentAt = at;
      changed = true;
    } else row.lastActivity = prev.lastActivity;
    entry.row = row;
    if (changed) this.broadcast({ chat: entry.id, ...delta } as ChatDelta);
  }

  private broadcast(d: ChatDelta): void {
    for (const fn of this.listeners) {
      try {
        fn(d);
      } catch {
        this.error("ws_send", null);
      }
    }
  }

  /** Iteration 7: the browser pane's tab mark of the chat goes (its process ended, or it was archived or deleted). */
  private ended(entry: Entry): void {
    try {
      this.deps.chatEnded?.(entry.id);
    } catch {
      this.error("unknown", entry.id);
    }
  }

  /** Number the event, cap it (4.3), put it in the ring and give it to every viewer. Returns the last ring item. */
  private emit(entry: Entry, e: ChatEvent): RingItem {
    // U5: a turn's end, a compaction and a reset change the transcript: the message search reads it again.
    if (e.k === "turn_end" || e.k === "compacted" || e.k === "reset") this.deps.transcriptChanged?.(entry.id);
    // Iteration 7: the browser pane's signal sees each tool event whole, before the cap.
    if (this.deps.tools && (e.k === "tool_call" || e.k === "tool_result" || e.k === "tool_stopped" || e.k === "turn_end" || e.k === "exit")) {
      try {
        this.deps.tools(entry.id, e);
      } catch {
        this.error("unknown", entry.id);
      }
    }
    const capped = capEvent(e);
    const pieces = capped.k === "block" ? splitBlock(capped) : [capped];
    let last: RingItem | null = null;
    for (const piece of pieces) {
      const seq = entry.seq + 1;
      const fit = fitEvent(entry.id, seq, piece);
      entry.seq = seq;
      last = entry.ring.push(seq, fit.e, fit.json, fit.bytes);
      this.keep(entry, last);
      if (entry.turn) trackTurnRow(entry.turn, piece);
      for (const v of entry.viewers) {
        try {
          v.event(last);
        } catch {
          this.error("ws_send", entry.id);
        }
      }
    }
    return last!;
  }

  /**
   * Keep, beside the ring, what a snapshot needs after the ring dropped it: the newest state events, and each streamed
   * block that has not ended (its start and its deltas). The turn's `turn_start` is kept by turnStart.
   */
  private keep(entry: Entry, it: RingItem): void {
    const e = it.e;
    if (STATE_KINDS.has(e.k)) entry.states.set(e.k, it);
    else if (e.k === "block_start") entry.openBlocks.set(e.key, { start: it, deltas: [] });
    else if (e.k === "block_delta") entry.openBlocks.get(e.key)?.deltas.push({ seq: it.seq, text: e.text });
    else if (e.k === "block_end" || e.k === "block") entry.openBlocks.delete(e.key);
  }

  private touch(entry: Entry, byUser: boolean): void {
    const iso = this.iso();
    entry.ledger.lastActivityAt = iso;
    if (byUser) entry.ledger.seenAt = iso;
    if (this.ms() - entry.lastWriteAt >= STORE_LIMITS.activityWriteMs) void this.persist(entry);
  }

  private setFirstPromptTitle(entry: Entry, text: string): void {
    if (entry.ledger.title !== null || entry.deleted) return;
    const t = firstPromptTitle(text);
    if (!t) return;
    entry.ledger.title = { text: t, from: "first-prompt" };
    void this.persist(entry);
    this.emit(entry, { k: "title", title: t, from: "first-prompt" });
    this.refresh(entry);
  }

  /**
   * A chat whose ledger has no title takes its session's, so the lists name it after a restart: the transcript's
   * custom title (a /rename that the ledger missed, a rename in the terminal) as the user's own rename, else its first
   * prompt as a first-prompt title, never as a rename.
   */
  private async sessionTitle(entry: Entry): Promise<void> {
    const sid = entry.ledger.sessionId;
    if (entry.ledger.title !== null || !sid) return;
    const info = await this.sessionInfo(entry, sid);
    if (!info) return;
    const custom = info.customTitle ? capText(cleanLabel(info.customTitle), LIMITS.title) : "";
    const first = custom ? null : firstPromptTitle(info.title);
    if ((!custom && !first) || entry.ledger.title !== null || entry.deleted || entry.deleting) return;
    entry.ledger.title = custom ? { text: custom, from: "renamed" } : { text: first!, from: "first-prompt" };
    this.refresh(entry);
    await this.persist(entry);
  }

  /** W6: the chat's branch as Claude Code's session info names it now (Claude can switch it), for a worktree chat. */
  private async refreshBranch(entry: Entry): Promise<void> {
    const sid = entry.ledger.sessionId;
    if (!sid || !openWorktree(entry.ledger, this.projectCwds.get(entry.ledger.project) ?? null)) return;
    const branch = (await this.sessionInfo(entry, sid))?.gitBranch ?? null;
    if (!branch || branch === entry.branch || entry.deleted || entry.deleting) return;
    entry.branch = branch;
    this.refresh(entry);
  }

  /**
   * R124: a side question (side.ts) on the chat's live process; a sleeping chat wakes with no turn first. Refused with
   * nothing stored on a chat that is deleted, archived, closing or draining for a restart, held by another app, or
   * whose agent has no side question.
   */
  private async sideQuestion(entry: Entry, frame: SideQuestionFrame, ctx: RequestContext): Promise<Outcome> {
    if (!this.caps.sideQuestions) return fail("unsupported");
    const refused = this.composerRefusal(entry) ?? this.drainRefusal() ?? (entry.held ? "session_held" : null);
    if (refused) return fail(refused);
    // FIX-U2: a question from the side box clears that box's draft on every page as a send clears the message box's,
    // once it is taken: not when another one runs (busy) or this one runs already (a resend joins it).
    const atArrival = entry.drafts.side.cur;
    const taken = !this.side.running(entry.id);
    const done = this.side.ask(entry.id, frame.id, frame.text, () => this.sideChat(entry));
    if (taken && frame.draftRev !== undefined) await this.clearDraftAfterSend(entry, "side", ctx.tab, frame.draftRev, atArrival);
    return done;
  }

  /**
   * R124: the process a side question goes to: the live one, else a start with nothing waiting, as worktreeAct's
   * Try again starts one. A side question never waits for a free slot: a start that would (`queued`) is taken out of
   * the queue (when nothing else waits for it), so the main chat gets no free-slot line, and the question fails.
   */
  private async sideChat(entry: Entry): Promise<AgentChat | ErrorCode> {
    const live = this.liveOf(entry);
    if (live && !live.closing && !entry.yielding) return live.chat;
    const r = await this.requestStart(entry);
    if (r === "queued") {
      if (entry.waiting.length === 0) this.unqueue(entry);
      return "failed";
    }
    if (r === "held") return "session_held";
    if (r !== "started") return this.startError(entry, r);
    return this.liveOf(entry)?.chat ?? "failed";
  }

  /**
   * W4, W5: a button under a refused start's line. `again`: the chat's own worktree is made again at its path from its
   * branch. `project`: the chat runs in its project's folder from now on (its worktree is gone; its branch stays for
   * Delete's rule). `start`: Try again, or Continue without the worktree after Claude Code refused to resume the chat
   * in it: the refusal is cleared and the chat's Claude Code starts. Each one only on the user's press.
   */
  private async worktreeAct(entry: Entry, act: WorktreeAct): Promise<Outcome> {
    const refused = this.composerRefusal(entry) ?? this.drainRefusal() ?? (entry.held ? "session_held" : null);
    if (refused) return fail(refused);
    const project = await this.project(entry.ledger.project);
    if (!project) return fail("not_found");
    const w = entry.ledger.worktree;
    const at = openWorktree(entry.ledger, project.cwd);
    if (act === "start") {
      if (entry.refusal !== "worktree_unverified" && entry.refusal !== "worktree_resume_refused" && !entry.ledger.refused) return fail("stale");
      this.clearRefusal(entry);
      delete entry.ledger.refused;
      await this.persist(entry);
      const r = await this.requestStart(entry);
      if (r === "queued") this.capNotice(entry);
      if (r === "started" || r === "queued" || r === "held") return ok({ started: r === "started" });
      return fail(this.startError(entry, r));
    }
    if (!at) return fail("stale");
    // After Archive's removal a worktree at the path is not the chat's own until a remake says so (row 100).
    if (!(at.own && w?.removed) && worktreeHere(at.path, at.root)) {
      // The worktree is there (made again meanwhile): nothing is left to do.
      if (entry.refusal === "worktree_gone" || entry.refusal === "cwd_unavailable") this.clearRefusal(entry);
      return act === "again" ? ok({ started: false }) : fail("stale");
    }
    // A process that still runs in a folder that went keeps its folder until it ends.
    if (entry.phase !== "sleeping") return fail("busy");
    if (act === "again") {
      if (!at.own || !w) return fail("stale");
      if (!(await this.remake(w, project.id))) return fail("worktree_failed");
    } else {
      // The chat's folder is its project's now: its own worktree's record stays (`left`), for Delete's branch rule, and
      // the session's transcript stays filed under the folder it ran in (sessionDir), where Delete and a copy find it.
      if (w && !w.left) entry.ledger.worktree = { ...w, left: true };
      delete entry.ledger.linked;
      if (entry.ledger.sessionId !== null) entry.ledger.sessionDir ??= entry.ledger.cwd;
      entry.ledger.cwd = project.cwd;
      entry.branch = null;
    }
    this.clearRefusal(entry);
    await this.persist(entry);
    this.refresh(entry);
    return ok({ started: false });
  }

  private setSession(entry: Entry, id: string): void {
    const old = entry.ledger.sessionId;
    if (old && this.bySession.get(old) === entry.id) this.bySession.delete(old);
    // A new id has no transcript known yet (FIX-W25b 1.5).
    if (old !== id) delete entry.ledger.transcript;
    entry.ledger.sessionId = id;
    if (!this.bySession.has(id)) this.bySession.set(id, entry.id);
  }

  /**
   * Whether the session's transcript exists, for the sessionId rule (D41). The session info alone is not the test: it
   * is missing for a transcript with no summary to read (for example a first message longer than the part it reads),
   * so the history is asked too (an empty list when there is no transcript). A history read that fails counts as no
   * transcript; if one exists, Claude Code refuses the start and the next start resumes (the `exit` case).
   */
  private async hasTranscript(entry: Entry, sid: string): Promise<boolean> {
    if (entry.transcript === sid) return true;
    const info = await this.sessionInfo(entry, sid);
    // A session info that could not be read counts as a transcript, but is no news for the row.
    if (info === undefined) return true;
    let found = info !== null;
    if (!found) {
      try {
        const page = await this.deps.driver.history(sid, sessionFolder(entry.ledger), { before: null, maxBytes: 4096 });
        found = page.events.length > 0;
      } catch {
        return false;
      }
    }
    // A transcript that the check found: the row names the session (FIX-W25b 1.5).
    if (found && this.markTranscript(entry, sid)) this.refresh(entry);
    return found;
  }

  /**
   * FIX-W25b 1.5: the ledger's session has a transcript, so its row names the session, also for the next server. True
   * when that is news (the caller refreshes the row, unless an agent event's own refresh follows).
   */
  private markTranscript(entry: Entry, sid: string | null): boolean {
    if (!sid || sid !== entry.ledger.sessionId || entry.ledger.transcript || entry.deleted) return false;
    entry.ledger.transcript = true;
    void this.persist(entry);
    return true;
  }

  /**
   * At boot, a ledger with a session id and no `transcript` flag (one written before the flag, or a first start that
   * failed before init, whose transcript a terminal may have written since) is checked, so its row names a session
   * that has a transcript.
   */
  private async bootTranscript(entry: Entry): Promise<void> {
    const sid = entry.ledger.sessionId;
    if (sid && !entry.ledger.transcript) await this.hasTranscript(entry, sid);
  }

  private async sessionInfo(entry: Entry, sid: string): Promise<SessionInfo | null | undefined> {
    try {
      return await this.deps.driver.sessionInfo(sid, sessionFolder(entry.ledger));
    } catch {
      return undefined;
    }
  }

  private addEntry(ledger: ChatLedger): Entry {
    const entry: Entry = {
      id: ledger.id,
      ledger,
      phase: "sleeping",
      state: "sleeping",
      row: null as unknown as ChatRow,
      activitySentAt: 0,
      live: null,
      starting: null,
      ring: new Ring(ledger.id),
      ringTimer: null,
      seq: ledger.lastSeq,
      resyncSeq: ledger.lastSeq,
      turn: null,
      lastTurnEndSeq: ledger.lastSeq,
      openBlocks: new Map(),
      states: new Map(),
      transcript: null,
      cards: new Map(),
      viewers: new Set(),
      drafts: { main: { cur: null, load: null, chain: Promise.resolve() }, side: { cur: null, load: null, chain: Promise.resolve() } },
      intake: Promise.resolve(),
      writeChain: Promise.resolve(),
      lastWriteAt: 0,
      pending: new Map(),
      waiting: [],
      bashQueue: [],
      bashRunning: null,
      notes: null,
      notesLoad: null,
      notesChain: Promise.resolve(),
      turnEnds: new WeakMap(),
      openCalls: new Map(),
      taskCalls: new Map(),
      tasks: [],
      seenTasks: new Set(),
      made: new Set(ledger.applied ?? []),
      modeOverride: null,
      idleTimer: null,
      capLine: null,
      held: null,
      yielding: false,
      titleTried: false,
      commands: null,
      hold: 0,
      deleting: false,
      deleted: false,
      queue: new ChatQueue(ledger.id, this.deps.store, () => this.error("store_write", ledger.id)),
      orphan: null,
      refusal: null,
      refusalLine: null,
      branch: null,
      sendNow: new SendNowWatch(),
      onScreen: new Set(),
      orphanStopped: false,
      bgViews: new Map(),
    };
    entry.row = this.rowOf(entry);
    this.entries.set(ledger.id, entry);
    if (ledger.sessionId && !this.bySession.has(ledger.sessionId)) this.bySession.set(ledger.sessionId, ledger.id);
    return entry;
  }

  /** Write the ledger (serialised per chat); a deleted chat is never written again. */
  private persist(entry: Entry): Promise<void> {
    if (entry.deleted) return entry.writeChain;
    entry.lastWriteAt = this.ms();
    const rec: ChatLedger = { ...entry.ledger, state: this.computeState(entry), lastSeq: entry.seq };
    if (entry.made.size > 0) rec.applied = [...entry.made].slice(-STORE_LIMITS.applied);
    entry.writeChain = entry.writeChain.then(() => (entry.deleted ? undefined : this.deps.store.writeChat(rec))).catch(() => this.error("store_write", entry.id));
    return entry.writeChain;
  }

  /** Requests whose order matters (send, `!`, Take back, the pickers) run one after another per chat. */
  private intake<T>(entry: Entry, fn: () => Promise<T>): Promise<T> {
    const run = entry.intake.then(fn);
    entry.intake = run.catch(() => undefined);
    return run;
  }

  private async uploadPaths(chat: string, ids: readonly string[]): Promise<string[] | null> {
    if (ids.length === 0) return [];
    const mine = new Map((await this.deps.store.listUploads(chat)).filter((u) => u.chat === chat).map((u) => [u.id, u.path]));
    const out: string[] = [];
    for (const id of ids) {
      const p = mine.get(id);
      if (p === undefined) return null;
      out.push(p);
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Notes (store/types.ts NotesRecord): the closed cards, the `!` rows' own ids and the messages' mention paths, for
  // history

  private loadNotes(entry: Entry): Promise<NotesRecord> {
    if (entry.notes) return Promise.resolve(entry.notes);
    if (!entry.notesLoad) {
      entry.notesLoad = this.deps.store
        .readNotes(entry.id)
        .catch(() => emptyNotes(entry.id))
        .then((n) => {
          if (!entry.notes) entry.notes = n;
          return entry.notes;
        });
    }
    return entry.notesLoad;
  }

  /** Change the chat's notes, one change after another, and hand them to the store (it writes them within a second). */
  private note(entry: Entry, change: (n: NotesRecord) => unknown): void {
    entry.notesChain = entry.notesChain
      .then(async () => {
        if (entry.deleted || entry.deleting) return;
        const n = await this.loadNotes(entry);
        await change(n);
        if (n.cards.length > STORE_LIMITS.noteCards) n.cards.splice(0, n.cards.length - STORE_LIMITS.noteCards);
        if (n.bash.length > STORE_LIMITS.noteBash) n.bash.splice(0, n.bash.length - STORE_LIMITS.noteBash);
        if (n.notRun.length > STORE_LIMITS.noteNotRun) n.notRun.splice(0, n.notRun.length - STORE_LIMITS.noteNotRun);
        if (n.mentions && n.mentions.length > STORE_LIMITS.noteMentions) n.mentions.splice(0, n.mentions.length - STORE_LIMITS.noteMentions);
        if (n.stops && n.stops.length > STORE_LIMITS.noteStops) n.stops.splice(0, n.stops.length - STORE_LIMITS.noteStops);
        if (n.turns && n.turns.length > STORE_LIMITS.noteTurns) n.turns.splice(0, n.turns.length - STORE_LIMITS.noteTurns);
        if (!entry.deleted && !entry.deleting) this.deps.store.saveNotes(n);
      })
      .catch(() => this.error("store_write", entry.id));
  }

  // -------------------------------------------------------------------------------------------------------------
  // Draft helpers

  /** One box's draft: from memory, else the store's (read once). */
  private loadDraft(entry: Entry, box: DraftBox): Promise<DraftState> {
    const slot = entry.drafts[box];
    if (slot.cur) return Promise.resolve(slot.cur);
    if (!slot.load) {
      slot.load = this.deps.store
        .readDraft(entry.id, box)
        .then(toDraftState, () => emptyDraft(this.iso()))
        .then((d) => {
          if (!slot.cur) slot.cur = d;
          return slot.cur;
        });
    }
    return slot.load;
  }

  /** Draft changes run one after another per chat and box. */
  private updateDraft(entry: Entry, box: DraftBox, f: (cur: DraftState) => DraftState | null | Promise<DraftState | null>): Promise<void> {
    const slot = entry.drafts[box];
    const run = slot.chain.then(async () => {
      if (entry.deleted) return;
      const cur = await this.loadDraft(entry, box);
      const next = await f(cur);
      if (next && next !== cur && !entry.deleted) this.setDraft(entry, box, next);
    });
    slot.chain = run.catch(() => undefined);
    return slot.chain;
  }

  private setDraft(entry: Entry, box: DraftBox, d: DraftState): void {
    entry.drafts[box].cur = d;
    this.deps.store.saveDraft({ v: 1, id: entry.id, ...(box === "side" ? { box } : {}), ...d, uploads: [...d.uploads] });
    for (const v of entry.viewers) {
      try {
        v.draft(d, box);
      } catch {
        this.error("ws_send", entry.id);
      }
    }
  }

  /**
   * 4.3 "A send clears the draft", unless the draft changed after the send arrived (another page typed since). The
   * side box's draft (FIX-U2) follows the same rule when a side question from it is taken.
   */
  private clearDraftAfterSend(entry: Entry, box: DraftBox, tab: string | null, draftRev: number | null, atArrival: DraftState | null): Promise<void> {
    return this.updateDraft(entry, box, (cur) => {
      if (atArrival && cur.rev !== atArrival.rev) return null;
      return draftAfterSend(cur, tab, draftRev, this.iso());
    });
  }

  /**
   * Text that never reached Claude Code goes back to the draft, before what is typed there and on its own line (6.3).
   * It goes back in chat mode, which keeps a message that starts with "!" a message (the mode is the draft's own
   * field). It is not link text: the external-link line stays only for the box's own link text that no one changed
   * (5.1 rule 7). `!` commands that never ran (`jobs`) go back after the messages, in Bash mode with their chips, as a
   * refused command does on its page, when the box is empty then: a command cannot join a message or the box's text.
   */
  private returnToDraft(entry: Entry, msgs: readonly PendingMsg[], tab: string | null, jobs: readonly BashJob[] = []): Promise<void> {
    if (msgs.length === 0 && jobs.length === 0) return Promise.resolve();
    const empty = (d: DraftState) => d.text === "" && d.command === null && d.uploads.length === 0 && !d.mentions?.length;
    // The mention chips go back with their text, as the upload chips do (the key only when there are some).
    const withMentions = (lists: readonly (readonly string[])[]) => {
      const mentions = [...new Set(lists.flat())].slice(0, LIMITS.draftMentions);
      return mentions.length ? { mentions } : {};
    };
    return this.updateDraft(entry, "main", (cur) => {
      let next = cur;
      // A `!` or `/` command in the message box stays as it is (6.3); the text would turn it into a message.
      if (msgs.length > 0 && (cur.mode === "chat" || empty(cur))) {
        const back = msgs.map((m) => m.userText).filter((t) => t !== "").join("\n");
        const text = capText(back && cur.text ? `${back}\n${cur.text}` : back || cur.text, LIMITS.draftText);
        const uploads = [...new Set([...msgs.flatMap((m) => m.uploads), ...cur.uploads])].slice(0, LIMITS.draftUploads);
        const mentions = withMentions([...msgs.map((m) => m.mentions), cur.mentions ?? []]);
        next = { rev: cur.rev + 1, text, mode: "chat", command: null, link: cur.link && cur.text !== "", uploads, ...mentions, by: tab, at: this.iso() };
      }
      if (jobs.length > 0 && empty(next)) {
        const text = capText(jobs.map((j) => j.userInput).join("\n"), LIMITS.draftText);
        const uploads = [...new Set(jobs.flatMap((j) => j.uploads))].slice(0, LIMITS.draftUploads);
        next = { rev: cur.rev + 1, text, mode: "bash", command: null, link: false, uploads, ...withMentions(jobs.map((j) => j.mentions)), by: tab, at: this.iso() };
      }
      return next === cur ? null : next;
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // What survives a stop: the queue file (RD-8, queue.ts), the stop line (D32) and kitespan's own orphans (R16, stops.ts)

  /**
   * The drain's rule for sends (L7, S9): while on, a send is kept Queued in its chat's queue file before its ack and is
   * never given to Claude Code; nothing starts for it. `!` commands and new chats are not changed by it. sendWaiting
   * then sends what waits, as a hold's end does; a restart instead keeps it for the next server (Not sent there).
   */
  setQueueOnly(on: boolean): void {
    this.queueOnly = on;
  }

  /**
   * Send what waits, as a hold's end does: a sleeping chat starts (the messages go first, in order), a live chat takes
   * them on its input. A held, archived or draining chat keeps them, and so does a chat where only restored messages
   * (Not sent) wait: those wait for the user (L4).
   */
  sendWaiting(): void {
    for (const e of this.entries.values()) {
      if (this.gone(e) || e.held || !e.waiting.some((w) => w.kind !== "send" || !w.msg.notSent)) continue;
      this.unmarkNotSent(e);
      if (e.phase === "live" && !e.yielding) {
        for (const w of e.waiting.splice(0)) this.submit(e, w);
        this.refresh(e);
      } else if (e.phase === "sleeping" && !this.capQueue.some((r) => r.entry === e)) {
        void this.requestStart(e).then((r) => {
          if (r === "queued") this.capNotice(e);
        });
      }
    }
  }

  /** R11: a message sent now waits instead of starting a turn: a turn runs, or a `!` command or a message is ahead of it. */
  private waitsBehind(entry: Entry): boolean {
    return entry.turn !== null || entry.bashRunning !== null || entry.bashQueue.length > 0 || this.cliQueued(entry);
  }

  private noteOf(msg: PendingMsg): QueuedNote {
    return { uuid: msg.uuid, text: msg.text, userText: msg.userText, uploads: [...msg.uploads], mentions: [...msg.mentions], at: this.iso() };
  }

  /** R13: the restored messages go with this start, first: each shows Queued in place of Not sent until it goes. */
  private unmarkNotSent(entry: Entry): void {
    for (const w of entry.waiting) {
      if (w.kind !== "send" || !w.msg.notSent) continue;
      w.msg.notSent = false;
      this.announce(entry, w.msg, true);
    }
  }

  /**
   * L5 and L6, at a shutdown: of what waits in `list`, a message whose `user` event went out stays (in the queue file,
   * Queued; the next server shows it Not sent); one whose ack has not gone leaves, since its page keeps the text (the
   * ack fails); a `!` command is taken out and returned, for its Not run row and the box (takeBackAll).
   */
  private shutdownSplit(entry: Entry, list: Waiting[]): Waiting[] {
    const jobs: Waiting[] = [];
    const kept: Waiting[] = [];
    const gone: string[] = [];
    for (const w of list) {
      if (w.kind === "bash") jobs.push(w);
      else if (w.msg.announced) kept.push(w);
      else {
        entry.pending.delete(w.msg.uuid);
        gone.push(w.msg.uuid);
      }
    }
    list.splice(0, list.length, ...kept);
    if (gone.length > 0) void entry.queue.drop(gone);
    return jobs;
  }

  /**
   * Boot (R16, R12, R15): a chat whose ledger names a claude that still lives with that start is held as `finishing`
   * until it exits (watchOrphan); every other chat reads its queue file and notes its stop line now, in the background
   * and before any request of the chat (its intake). Nothing starts.
   */
  private async survive(): Promise<void> {
    await Promise.all(
      [...this.entries.values()].map(async (e) => {
        const proc = e.ledger.proc;
        if (proc && e.ledger.sessionId && (await procLives(this.procs, proc))) {
          e.orphan = proc;
          e.held = "other";
          // What waited behind the cut turn shows now, Queued under the hold's locked box, so a resend of it is
          // answered as one that waits; the dedupe and Not sent come at the orphan's exit (restoreQueue).
          e.queue.load(await this.deps.store.readQueue(e.id).catch(() => null));
          this.restoreUnderHold(e);
          this.restoreHandOver(e);
          this.refresh(e);
          this.watchOrphanOnce(e, proc);
          return;
        }
        if (proc) delete e.ledger.proc;
        this.restoreHandOver(e);
        void this.intake(e, () => this.afterBoot(e, proc !== undefined));
      }),
    );
  }

  /**
   * After boot, or after the chat's orphan exited: what waited in the queue file comes back (R12), the stop line is
   * noted (R15), the end that no page saw waits to be seen (row 116), and the ledger forgets its stop and its process.
   */
  private async afterBoot(entry: Entry, changed: boolean): Promise<void> {
    const stop = entry.ledger.stop ?? null;
    entry.queue.load(await this.deps.store.readQueue(entry.id).catch(() => null));
    if (stop || entry.queue.size > 0) {
      const facts = await this.readFacts(entry);
      if (entry.deleted || entry.deleting) return;
      // Restart now (S10) interrupted the turn itself: the transcript's end is that interrupt, so its line always shows.
      const lined = !!stop && (stop.why === "waiting" || stop.by === "restart" || stop.by === "restart_failed" || !facts?.ended);
      if (lined) this.noteStop(entry, stopLine(stop), facts);
      // Row 116 (seen.ts bootUnseen); a Stop of kitespan's own orphan is the user's own act.
      const was = entry.ledger.unseen;
      // R130: no push for what boot finds (DESIGN-R130 4.1: a lead decision).
      if (!entry.orphanStopped) this.markUnseen(entry, bootUnseen(stop, lined), false);
      if (entry.ledger.unseen !== was) this.refresh(entry);
      // An archived chat keeps no message waiting (R11: it leaves at Archive, its text back to the draft).
      if (entry.queue.size > 0 && entry.ledger.archivedAt !== null) await this.archiveQueue(entry);
      if (entry.queue.size > 0) this.restoreQueue(entry, facts);
    }
    if (!stop && !changed) return;
    delete entry.ledger.stop;
    await this.persist(entry);
  }

  /** The whole transcript, read once: its users' uuids, where it ends and whether its last turn ended; null: unreadable. */
  private async readFacts(entry: Entry): Promise<TranscriptFacts | null> {
    const sid = entry.ledger.sessionId;
    if (!sid) return transcriptFacts([]);
    let facts: TranscriptFacts | null = null;
    try {
      await this.deps.driver.history(sid, sessionFolder(entry.ledger), {
        before: null,
        maxBytes: PAGE_BUDGET,
        decorate: (events) => {
          facts = transcriptFacts(events);
          return [];
        },
      });
    } catch {
      this.error("sdk_error", entry.id);
      return null;
    }
    return facts;
  }

  /**
   * R15: the line, under the cut turn in history from now on (the notes), and for a page that shows the chat now (the
   * ring). History holds it, so a later snapshot's tail leaves it out: the boundary of what history holds moves past it.
   * A transcript that cannot be read leaves it out of history.
   */
  private noteStop(entry: Entry, text: string, facts: TranscriptFacts | null): void {
    const id = crypto.randomUUID();
    if (facts) this.note(entry, (n) => (n.stops ??= []).push({ id, text, after: facts.after, skip: facts.skip }));
    const it = this.emit(entry, { k: "notice", text, id });
    if (facts && entry.turn === null && entry.lastTurnEndSeq < it.seq) entry.lastTurnEndSeq = it.seq;
  }

  /**
   * R12: a message that the transcript holds ran (its id counts as applied); every other one waits again, Not sent and
   * Queued on every page, in send order, for the next send, Send again or a hold's end (L4). A transcript that cannot be
   * read drops nothing: the user decides.
   */
  private restoreQueue(entry: Entry, facts: TranscriptFacts | null): void {
    const ran = new Set(facts ? entry.queue.list().flatMap((n) => (facts.uuids.has(n.uuid) ? [n.uuid] : [])) : []);
    for (const u of ran) this.remember(entry.made, u);
    if (ran.size > 0) {
      // In the ledger before the file forgets them, so a resend after another stop is not applied either.
      void this.persist(entry).then(() => entry.queue.drop(ran));
      // One that showed Queued under a finishing hold and that the orphan ran: it waits no more, and its label goes.
      entry.waiting = entry.waiting.filter((w) => !(w.kind === "send" && w.msg.underHold && ran.has(w.msg.uuid)));
      for (const u of ran) {
        const m = entry.pending.get(u);
        if (!m?.underHold) continue;
        entry.pending.delete(u);
        this.announce(entry, m, false);
      }
    }
    for (const n of entry.queue.list()) {
      if (ran.has(n.uuid)) continue;
      const shown = entry.pending.get(n.uuid);
      if (shown?.underHold) {
        // The hold ended: Not sent now, with Send again (L4).
        shown.underHold = false;
        shown.notSent = true;
        this.announce(entry, shown, true);
      }
      if (shown) continue;
      const msg: PendingMsg = { uuid: n.uuid, text: n.text, userText: n.userText, uploads: [...n.uploads], mentions: [...n.mentions], where: "cap", announced: true, notSent: true };
      entry.waiting.push({ kind: "send", msg });
      entry.pending.set(msg.uuid, msg);
      this.announce(entry, msg, true);
    }
    this.refresh(entry);
  }

  /** R11: the queue file of an archived chat goes back to the draft, in send order, and is emptied. */
  private async archiveQueue(entry: Entry): Promise<void> {
    const notes = entry.queue.list().filter((n) => !entry.pending.has(n.uuid));
    const msgs = notes.map((n): PendingMsg => ({ uuid: n.uuid, text: n.text, userText: n.userText, uploads: [...n.uploads], mentions: [...n.mentions], where: "cap", announced: false }));
    await this.returnToDraft(entry, msgs, null);
    await entry.queue.drop(notes.map((n) => n.uuid));
  }

  /** R12 under a finishing hold (survive): each message of the queue file waits, Queued on every page, in send order. */
  private restoreUnderHold(entry: Entry): void {
    for (const n of entry.queue.list()) {
      if (entry.pending.has(n.uuid)) continue;
      const msg: PendingMsg = { uuid: n.uuid, text: n.text, userText: n.userText, uploads: [...n.uploads], mentions: [...n.mentions], where: "cap", announced: true, underHold: true };
      entry.waiting.push({ kind: "send", msg });
      entry.pending.set(msg.uuid, msg);
      this.announce(entry, msg, true);
    }
  }

  /**
   * R16: the chat's own orphan is looked for until it exits; then, past the registry read's cache (row 78's fast
   * check), so no later read still sees the orphan's own record, the queue and the stop line come (afterBoot) and the
   * hold ends: the pages read the history again (R4), and nothing starts.
   */
  private async watchOrphan(entry: Entry, proc: LedgerProc): Promise<void> {
    const live = () => !this.draining && !entry.deleted && entry.orphan === proc;
    while (live() && (await procLives(this.procs, proc))) await nap(ORPHAN_POLL_MS);
    if (!live()) return;
    await nap(Math.max(1, this.opts.openFastMs ?? OPEN_FAST_MS));
    if (!live()) return;
    delete entry.ledger.proc;
    await this.intake(entry, () => this.afterBoot(entry, true));
    if (!live()) return;
    // One delta for the hold's end and the turn's (release starts nothing while `orphan` is still set). A chat handed
    // to the terminal meanwhile (End it here and copy) is held as handed from now (L16).
    entry.hold++;
    entry.resyncSeq = entry.seq;
    this.setHeld(entry, this.handed.has(entry.id) ? "terminal" : null);
    entry.orphan = null;
    entry.hold--;
    this.refresh(entry);
    void this.checkOpen();
  }

  /** R16: Stop on a `finishing` hold: SIGTERM, then SIGKILL after 5 s, each only to the recorded pid with its start. */
  private async stopOrphan(entry: Entry, proc: LedgerProc): Promise<Outcome> {
    if (!(await procLives(this.procs, proc))) return fail("stale");
    entry.orphanStopped = true;
    void endOrphan(this.procs, proc, this.deps.orphanGraceMs ?? ORPHAN_GRACE_MS);
    this.touch(entry, true);
    return ok({ stillQueued: null });
  }

  /** R16: the chat's claude process, with its start time, goes into the ledger once its pid is known. */
  private noteProc(entry: Entry, live: Live): void {
    if (live.procNoted) return;
    const pid = live.chat.pid;
    if (pid === null) return;
    live.procNoted = true;
    void this.procs.startOf(pid).then((start) => {
      // The pid still names the chat's claude: one that ended meanwhile is never noted (its pid may be another's now).
      if (start === null || entry.live !== live || live.chat.pid !== pid || entry.deleted) return;
      entry.ledger.proc = { pid, start };
      this.ownProcs.set(pid, start);
      void this.persist(entry);
    });
  }

  /**
   * R13 Send again: the chat starts for what waits, the restored messages first and in order. `started` false: nothing
   * waited. Refused while another app holds the session (`session_held`), and as a send is.
   */
  private async sendQueued(entry: Entry): Promise<Outcome> {
    const step = await this.intake(entry, async (): Promise<Outcome | { start: Promise<StartResult> }> => {
      const refused = this.composerRefusal(entry) ?? this.drainRefusal();
      if (refused) return fail(refused);
      // S16: Send again also ends the hand-over hold (L16); the registry is read again below before a start.
      this.endHandOver(entry, false);
      if (!entry.waiting.some((w) => w.kind === "send")) return ok({ started: false });
      if (await this.heldNow(entry)) return fail("session_held");
      this.unmarkNotSent(entry);
      return { start: this.requestStart(entry) };
    });
    if ("ok" in step) return step;
    const r = await step.start;
    if (r === "queued") this.capNotice(entry);
    if (r === "started" || r === "queued") return ok({ started: true });
    return fail(r === "held" ? "session_held" : this.startError(entry, r));
  }

  /** R16: look for the chat's orphan, once: a close and a reopen of the registry never start a second look. */
  private watchOrphanOnce(entry: Entry, proc: LedgerProc): void {
    if (this.orphanWatches.has(entry.id)) return;
    this.orphanWatches.add(entry.id);
    void this.watchOrphan(entry, proc).finally(() => this.orphanWatches.delete(entry.id));
  }

  // -------------------------------------------------------------------------------------------------------------
  // End it here and copy (S16, L16; DESIGN.md 6.10)

  /**
   * The copy dialog copied the plain command; now the chat's Claude Code ends at its first quiet moment, as a chat
   * that gives its session up does (row 78: its turn is never cut, a card waits, Claude Code's queue comes back to
   * kitespan's), and the chat is held as handed to the terminal, so a send from another page cannot start a second
   * writer before the paste. A chat whose session another app has open already keeps D58's hold.
   */
  private endHere(entry: Entry): Outcome {
    if (entry.ledger.archivedAt !== null) return fail("archived");
    if (this.draining || this.restartDrain) return fail("restarting");
    const ending = entry.phase !== "sleeping" || entry.orphan !== null;
    // kitespan's own orphan (R16) holds the chat as finishing until it exits; the hand-over's hold follows it then.
    if ((!entry.held || entry.orphan) && entry.ledger.sessionId && !this.handed.has(entry.id)) {
      this.handed.set(entry.id, null);
      // In the ledger, so the next server holds it too (L16).
      entry.ledger.handedAt = this.iso();
      void this.persist(entry);
      if (entry.orphan) this.refresh(entry);
      else this.setHeld(entry, "terminal");
    }
    return ok(ending ? { ending: true } : { ended: true });
  }

  /**
   * The hand-over's time runs from the end of the chat's Claude Code ("Ended. Paste the command..."), at most 10 minutes;
   * the ledger keeps that moment. `leftMs`: what is left of a hand-over that a server before this one began (boot).
   */
  private armHandOver(entry: Entry, leftMs?: number): void {
    const t = setTimeout(() => this.endHandOver(entry, true), Math.max(1, leftMs ?? this.deps.handOverMs ?? HAND_OVER_MS));
    (t as { unref?: () => void }).unref?.();
    this.handed.set(entry.id, t);
    if (leftMs === undefined) {
      entry.ledger.handedAt = this.iso();
      void this.persist(entry);
    }
  }

  /**
   * Boot (L16): a hand-over that a server before this one began holds the chat again, as handed, for what is left of
   * its time; one whose time has passed is forgotten. Under a finishing hold (R16) it waits for the orphan's exit.
   */
  private restoreHandOver(entry: Entry): void {
    const at = entry.ledger.handedAt;
    if (at === undefined) return;
    const left = Date.parse(at) + (this.deps.handOverMs ?? HAND_OVER_MS) - this.ms();
    if (left <= 0 || !entry.ledger.sessionId || entry.ledger.archivedAt !== null) {
      delete entry.ledger.handedAt;
      void this.persist(entry);
      return;
    }
    if (entry.orphan) this.handed.set(entry.id, null);
    else {
      entry.held = "terminal";
      this.armHandOver(entry, left);
    }
    this.refresh(entry);
  }

  /**
   * The hand-over hold ends: at its time (`timedOut`) or on Send again. Nothing starts by itself (release), the pages
   * read the history again, and at its time what waits shows Not sent, with Send again (R13).
   */
  private endHandOver(entry: Entry, timedOut: boolean): void {
    if (!this.handed.has(entry.id)) return;
    if (!entry.deleted && !entry.deleting) {
      this.setHeld(entry, null);
      if (timedOut)
        for (const w of entry.waiting) {
          if (w.kind !== "send" || w.msg.notSent) continue;
          w.msg.notSent = true;
          this.announce(entry, w.msg, true);
        }
    }
    this.dropHandOver(entry);
  }

  /** The hand-over's mark and timer go (D58's hold took over, or an archive), in the ledger too. */
  private dropHandOver(entry: Entry): void {
    const t = this.handed.get(entry.id);
    if (t) clearTimeout(t);
    this.handed.delete(entry.id);
    if (entry.ledger.handedAt === undefined) return;
    delete entry.ledger.handedAt;
    void this.persist(entry);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Small helpers

  private remember(set: Set<string>, v: string): void {
    set.add(v);
    if (set.size > MADE_KEEP) set.delete(set.values().next().value as string);
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private ms(): number {
    return this.now().getTime();
  }

  private iso(): string {
    return this.now().toISOString();
  }

  private log(ev: LogEvent, f: LogFields): void {
    try {
      this.deps.log?.log(ev, f);
    } catch {
      // the log never stops a chat
    }
  }

  private error(err: LogError, chat: string | null): void {
    this.log("error", { chat, err });
  }
}
