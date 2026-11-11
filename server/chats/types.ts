// The chat registry's own types (DESIGN.md 4.1, 4.3): what the socket layer gives it (a Viewer per attached socket,
// a request context), what it gives back (an Outcome per request, an attach payload), and what main.ts plugs in (the
// driver, the store, the `!` runner, the logger). The registry never sees a socket; the socket layer never sees a
// driver.

import type { AttachedFrame, ChatEvent, DraftBox, DraftState, ErrorCode, SnapshotFrame, TrustRefusal, WorktreeOff } from "../../shared/protocol";
import type { PushMomentInput } from "../../shared/push";
import type { AgentDriver, EnvVar } from "../agents/types";
import type { ChangesBook } from "../changes/book";
import type { Logger } from "../log";
import type { Store } from "../store/types";

/** One event in a chat's ring buffer: its number, the event, and the whole `ev` frame as JSON (made once). */
export interface RingItem {
  seq: number;
  e: ChatEvent;
  /** `{"t":"ev","chat":...,"seq":...,"e":...}`, sent as is to every viewer. */
  json: string;
  /** The frame's size in UTF-8 bytes. */
  bytes: number;
}

/**
 * A socket attached to a chat (D49: every page is a live viewer). The registry calls it synchronously; the socket
 * layer decides whether the frame goes out now (a live socket) or later from the ring (a socket that catches up).
 */
export interface Viewer {
  /** The `tab` of the socket's `hello`. */
  readonly tab: string | null;
  /** A new event of the chat, already in its ring. */
  event(item: RingItem): void;
  /** The chat's draft of one box changed (never a ring event): the message box's, or (FIX-U2) the side chat's box's. */
  draft(d: DraftState, box: DraftBox): void;
  /** The chat was deleted: the viewer is dropped (the `{chat, gone: true}` delta goes to every socket). */
  gone(): void;
  /**
   * Row 116: how long ago the page's socket sent its last frame, in ms; a page's `on_screen` counts only while this is
   * at most WIRE.onScreenFreshMs. Absent: always heard (a viewer with no socket).
   */
  quietMs?(): number;
}

/** What one request from a socket carries besides its frame. */
export interface RequestContext {
  tab: string | null;
}

/**
 * The answer to one request frame. `after` runs once, right after the `ack` went to the sender: the events and deltas
 * that DESIGN 4.3 orders after the ack (a `title`, a `picks`, the `{chat, gone: true}` delta).
 */
export type Outcome = { ok: true; result: unknown; after?: () => void } | { ok: false; code: ErrorCode; reason?: WorktreeOff | TrustRefusal };

/** The page's cursor of an `attach` frame: the highest `seq` it drew, and that seq's epoch. */
export interface AttachWant {
  since: number;
  epoch: string | null;
}

/**
 * What an attach answers (4.3 step 5): the snapshot path, or the replay path (`attached.replay` is `events` or `none`),
 * which has no snapshot and no tail: the ring after `cursor` (the attach's `since`) follows.
 */
export interface AttachPayload {
  attached: AttachedFrame;
  snapshot?: SnapshotFrame;
  /** The `ev` frames that follow the snapshot: the turn in flight and the chat's current state, minus the page's ids. */
  tail: RingItem[];
  /** The `seq` that the socket has after the tail; the catch-up goes on from the ring after it. */
  cursor: number;
}

/** An attach that names no cursor: always the snapshot path. */
export type SnapshotPayload = AttachPayload & { snapshot: SnapshotFrame };

/** The result of one `!` command (D10, D20). The runner applies the 120 s limit and the 30,000-character caps. */
export interface BashResult {
  stdout: string;
  stderr: string;
  code: number | null;
  ms: number;
  timedOut: boolean;
  capped: boolean;
}

/**
 * Runs one `!` command in the chat's folder, in its own process group (A12); `signal` ends it early. `env` (D60): the
 * variables of the live chat's start, over the server's start environment.
 */
export interface BashRunner {
  run(input: { command: string; cwd: string; signal: AbortSignal; env?: readonly EnvVar[] }): Promise<BashResult>;
}

export interface RegistryDeps {
  driver: AgentDriver;
  store: Store;
  /** Absent: a `bash` frame gets `unsupported`. */
  bash?: BashRunner;
  log?: Logger;
  /** The clock (tests). */
  now?: () => Date;
  /** Row 99: a Continue here or a Continue in a copy made a chat of this session (it is released no more). */
  continued?: (sessionId: string) => void;
  /**
   * Row 99: the folder that holds the transcript of a session that a removed environment released from this folder
   * (store/released.ts; a worktree chat's is its worktree's, which may be gone), or null when none released it.
   */
  releasedFolder?: (cwd: string, sessionId: string) => string | null;
  /** R127: the home folder by its names, which no trust start may name or hold (tests); server/home.ts by default. */
  trustHomes?: () => readonly string[];
  /**
   * R130: notifications (server/push/notify.ts). The registry reports a moment only while no page has the chat (or the
   * background session) on screen, and never for an archived chat, a Stop, Restart now's cut or boot; it reports each
   * chat and session seen, and each chat archived or deleted. Absent: no push.
   */
  push?: RegistryPush;
  /**
   * U5: the chat's transcript changed (a turn's end, a compaction or a reset that the registry relays), so the message
   * search (server/search/messages.ts) reads it again on its next pass. Absent: nothing to tell.
   */
  transcriptChanged?: (chat: string) => void;
  /**
   * U1: each turn's changes (server/changes/book.ts): a start mark at a turn's start (a user's message waits for it,
   * at most 3 s), the turn's tool events, an end mark and a summary at its end (the `changes` event), the cards for
   * history, and the chat's changes folder at Delete. Absent: no marks, and a message goes on the input at once.
   */
  changes?: ChangesBook;
  /**
   * Iteration 7 (DESIGN-B1 2.13): each tool event of every chat (`tool_call`, `tool_result`, `tool_stopped`,
   * `turn_end`, `exit`), live and before any cap, for the browser pane's "Claude is acting" (server/browser/acting.ts).
   * It is not a viewer, so no chat is kept awake by it. Absent: nothing to tell.
   */
  tools?: (chat: string, e: ChatEvent) => void;
  /**
   * Iteration 7 (DESIGN-B1 2.13): a chat ended, for the browser pane's tab mark: its Claude Code process ended, by
   * itself or by kitespan's own close (which draws no `exit` event), or the chat was archived or deleted. It may come
   * more than once for one end. Absent: nothing to tell.
   */
  chatEnded?: (chat: string) => void;
}

/** R130: what the registry tells notifications (the PushNotifier's part). */
export interface RegistryPush {
  moment(m: PushMomentInput): void;
  seen(chat: string): void;
  seenBg(chat: string, id: string): void;
  forget(chat: string): void;
}

export interface RegistryOptions {
  /** D2's idle limit in ms; default: Settings > Chats "Keep an idle chat running for" (30 minutes). */
  idleMs?: number;
  /** D3's cap; default: Settings > Chats "Live chats at most" (10). */
  maxLive?: number;
  /** How long a shutdown waits for the claude processes (4.1: the SDK's 2 s plus 5 s plus a margin). */
  shutdownMs?: number;
  /** How long `close()` may take before the registry stops waiting for the event stream's end. */
  closeGraceMs?: number;
  /** The boot epoch (tests); default: a new one. */
  epoch?: string;
  /** D58: how often every chat's session is checked against the sessions open in other processes (default 10 s). */
  openCheckMs?: number;
  /** Row 78: how often while a chat has a viewer or a live process (default 2 s). */
  openFastMs?: number;
  /** Row 111: how long Send now waits for a Bash call's task to start (default SEND_NOW_WAIT_MS, 5 s). */
  sendNowWaitMs?: number;
  /** R124: kitespan's own bound on one side question (default SIDE_LIMITS.deadlineMs, 12 minutes). */
  sideDeadlineMs?: number;
  /** R131: how long after a live launch line with no record Claude Code's list is asked (default 5 s). */
  bgLaunchWaitMs?: number;
  /** R131: how long the driver keeps a list's answer, so a stale one is read again after it (default 5 s). */
  bgListKeepMs?: number;
}
