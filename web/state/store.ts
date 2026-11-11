// The page's store: one state object, small selector slices (useStore), and the act.* functions the components call.
// It is a view of the server (DESIGN.md 4.3): the chat list from the `chats` frames, a chat's items from its snapshot
// and its `ev` frames (state/reduce.ts), the open cards and the picks from `attached`, the message box's draft from
// the server (D49), the uploads through /api/uploads (D50) and the settings from /api/settings.
//
// Principle 3: the act.* functions send a frame or a mutating request only when a click, tap, key or submit handler
// calls them; opening a URL never calls one. act.open (attach and detach), act.load (a `get`) and Settings' read of a
// live chat's init facts (an attach until the facts come, then a detach) only read. The net layer records every
// mutating frame in window.__kitespanFrames (net/frames.ts).
//
// The draft (D49, 7.5): the store keeps the server's own fields (mode, command, text, link, uploads, mentions:
// ChatDraft), so a draft's mode never comes from its text's first character: a message that starts with "!" stays a
// message after a reload, on another page, after Take back and after a refused send. The mention chips (9.3) are files
// of the chat's folder picked with `@` (act.addMention, act.removeMention): draft changes only, never a request to
// /api/uploads, and they go with send and `!` as the upload chips do. act.setDraft keeps the draft here at once and
// sends a `draft` frame 250 ms after the last change, and at once on blur, a chat switch and a hidden page
// (flushDrafts). A draft from the server shows unless this page's box is being typed in (input in the last 2 s); a held
// draft shows when the typing stops, unless this page saved a newer one or the server has a newer one. The draft that
// answers this page's own Take back shows at once (showPutBack). Until the server confirms a save, local
// storage keeps a pending copy (the fields, with the `rev` it was typed on, 24 hours); after a reload, a copy whose
// `rev` is still the server's wins and is sent at once. A send or a `!` command empties the box and removes the copy
// at once, so its text is in one place; until its ack, local storage keeps its draft under the request's id instead,
// and a reload before the ack puts it back in the box unless the chat shows that it went through (restoreSent). A
// refused one gives the draft back, with its own mode, and saves it again. The side chat's box has a draft of its own
// on the server, under the same rules (FIX-U2; the side chat's section below).
//
// The notice (4.3): one plain line, and where it belongs (`noticeChat`): a chat's screen shows only a line about that
// chat (chatNotice); a refused list action on a chat that is not open, and a line about no chat, show by the list or
// on the screen that is open (listNotice).

import { useSyncExternalStore } from "react";
import {
  CONTROL_CHARS,
  DRAFT_MODES,
  LIMITS,
  RESTART_FAILED_NOTICE,
  RESTART_NOTICE,
  UPDATE_NOTICE,
  applyChatsFrame,
  ackTrustReason,
  capText,
  isSafeRelativePath,
  mentionsOf,
  messageRefForms,
  refsIn,
  userMentions,
  type AckFrame,
  type AttachedFrame,
  type CardAnswer,
  type ChatEvent,
  type ChatRow,
  type ClaudeStatus,
  type CommandInfo,
  type ConnectorInfo,
  type ContextInfo as WireContext,
  type DraftEditFrame,
  type DraftMode,
  type DraftState,
  type EffortId,
  type ErrorCode,
  type GetWhat,
  type ModeId as WireModeId,
  type ModelInfo,
  type NoticeAction,
  type NoticeFrame,
  type RequestFrame,
  type ServerFrame,
  type SideClearFrame,
  type SideQuestionFrame,
  type SideStopFrame,
  type UpdateKind,
  type WorktreeAct,
} from "../../shared/protocol";
import type {
  ProjectCommandsReply,
  ProjectView,
  ProjectsReply,
  ProjectReply,
  RemovedProjectReply,
  RestartAccepted,
  RestartCancelReply,
  RestartWhen,
  SessionView,
  SessionsReply,
  SettingsReply,
  UploadReply,
  UploadView,
  UploadsReply,
} from "../../server/http/api-types";
import { ApiError, apiGet, apiSend, uploadBytes } from "../net/api";
import { newUuid } from "../net/frames";
import { isUuid } from "../../shared/ids";
import { replayBegins, replayEnds, resetReplays } from "../net/replay";
import { OnScreen } from "../net/onScreen";
import { browserConnection, type Connection, type NetStatus } from "../net/socket";
import { cleanSplit, cleanWidths } from "../layout/panes";
import { DEFAULT_MODEL_ROW, DEFAULT_SETTINGS, DEFAULT_VIEW, EFFORTS, LOOK_IDS, MODELS, TEXT_SIZES, UPLOAD_FOLDERS, lookOf } from "./catalog";
import { applyEvent, applyHistory, cardOf, cardWithFolder, listState, picksView, settledStarts, unseenOf, withFolder, type AnsweredAs } from "./reduce";
import { leaveRemoved, reordered } from "./environments";
import { pressStands, queuedIds, sendNowTarget, type SendNowPress } from "./sendNow";
import type { AppSettings, Card, Chat, CommandRow, Connector, ContextInfo, InitFacts, Item, LookId, ModeId, ModelRow, PlanAnswer, Project, Toast, Upload, UploadFolder, ViewPrefs, WireChatState } from "./types";
import { chatFolder, isStartCode, isWorktreeOff, refusalLine, worktreeOfRow } from "../worktree/worktree";
import { EMPTY_THREAD, applySideEvent, askingOf, beginRead, isSideEvent, localAsk, readFailed, settleAsk, takeRead, type SideExchange, type SideRead, type SideThread } from "../side/thread";
import { BRING_TOO_LONG, bringInto } from "../side/bring";
import { closeShown, notificationTag } from "../notify/worker";
import { originNotice } from "../update/state";
import { attachedTrust, isTrustState, withTrust, type TrustState } from "../chat/trust";
import { STOP_ANSWERS, attachedBackground, bgDotOf, type BgStopAnswer } from "../chat/background";
import { mergeChanges } from "../changes/model";

export { beforeQueue } from "./reduce";

/**
 * Row 77: what Settings > Chats left out of a project's list of Claude Code sessions, as the server said: every session
 * (Show sessions from other apps is off), or these sessions that another app has open now.
 */
export interface SessionsHidden {
  all: boolean;
  open: readonly string[];
}

/** A restart this page asked for (State.restart). */
export interface RestartAsk {
  when: RestartWhen;
  /** The epoch of the server that was asked. */
  epoch: string | null;
  state: "sending" | "accepted" | "refused" | "done" | "not_done";
  /** The refusal's line (the preflight's, or the server's fixed sentence). */
  line: string | null;
}

export interface State {
  projects: Project[];
  /** Every chat the server lists, newest first; an archived one has `archived` (the lists leave it out, D48). */
  chats: Chat[];
  settings: AppSettings;
  /**
   * D49: the message box's draft per chat, the server's own fields (a chat with none has no entry: draftOf). Its mode
   * is its own field: the composer reads it from here, never from the text's first character.
   */
  draft: Record<string, ChatDraft>;
  /**
   * The draft in the one-string form that the first readers used ("!" or "/" first for the modes), kept from `draft`.
   * A chat-mode text that starts with "!" shows here as link text (`draftLink`), so a reader of this form never takes
   * it for Bash mode. Transitional: for the readers that have not moved to `draft` (composer/linkDrafts.ts); it goes
   * with them, as do `draftUploads`, `draftLink`, act.setDraft's string form and readLinkModesWith.
   */
  drafts: Record<string, string>;
  /** D50: the upload ids whose chips the message box shows, per chat (`draft[chat].uploads`, for the same readers). */
  draftUploads: Record<string, string[]>;
  /** D49: the chat's draft came from a link and no one changed it (`draft[chat].link`; see `drafts`). */
  draftLink: Record<string, boolean>;
  /** One plain line (a refused request's line, the server's notice). Where it shows: `noticeChat`. */
  notice: string | null;
  /**
   * The chat whose screen shows `notice` (chatNotice), or null: the line belongs by the chat list or on the screen
   * that is open, which is not a chat (listNotice). A refused list action on a chat that is not open is the list's.
   */
  noticeChat: string | null;
  view: ViewPrefs; // view preferences (local storage; not URL state, not recorded)
  toasts: Toast[]; // live state: Claude Code's notifications; the Toasts host shows one at a time
  /**
   * The restart that this page asked for (4.10, the restart dialog): `when`, the epoch it was asked under, and how it
   * went: its request on its way, accepted (202), refused with the server's line, done (a welcome of another epoch), or
   * not done (a welcome of the same epoch after the `bye`: the old server listens again; or the server's notice that
   * it did not restart). null: none asked here, or the ask was called off (Cancel restart).
   */
  restart: RestartAsk | null;
  /**
   * From the close's notice ("Restarting kitespan..." in the drain notice's place, 4.10 step 4) or a `bye {reason:
   * "restart"}` to the next `welcome`: every screen says Restarting kitespan...
   */
  restarting: boolean;
  /** The drain notice while Restart when they finish waits (a notice that offers Cancel restart), until it goes. */
  restartWait: { id: string; text: string } | null;
  /** Origin's line from `welcome` (About's Update available, 4.10). */
  update: UpdateKind;
  /**
   * The update's notice (row 108; the server's notice with the id `update`, 4.3): the step line while an update runs,
   * the line of one that did not finish, Restart to apply, or origin's line, with the notice's actions (Update). From
   * `welcome`'s origin line, then each notice of that id until `gone`. Never the screen's `notice`, so no timer and no
   * screen that opens takes it away (web/update/UpdateLine.tsx draws it).
   */
  updateNotice: { text: string; actions: readonly NoticeAction[] } | null;
  uploads: Record<string, Upload[]>; // per chat, oldest first (D37); select with `s.uploads[id] ?? NO_UPLOADS`
  /** A Take back that waits because the message box holds a command (act.takeBack); view state, not recorded. */
  takeBackWait: { chatId: string; messageId: string } | null;
  /**
   * R130: a side answer's Bring back that the message box refused because it holds a command (act.bringBack): its line
   * shows above the composer, in Take back's place, until the box holds no command. View state, not recorded.
   */
  bringBackWait: { chatId: string } | null;
  /** The socket (net/socket.ts): the sidebar foot says "Reconnecting..." only while it is not open (M4). */
  net: NetStatus;
  /** The first chat list has come, so a chat link never shows "not here" before the list is known. */
  ready: boolean;
  /** From `welcome`: kitespan's version, the claude status and the boot epoch. */
  server: { version: string | null; claude: ClaudeStatus | null; epoch: string | null };
  /**
   * From `welcome` (D54): the machine's own name, its hostname as the server reads it. The page names the machine by
   * it and never by the browser's address, which may name a forward or a proxy instead. null until welcome, or when
   * the server has no name to show.
   */
  machine: string | null;
  /** The read-only part of /api/settings (the claude binary, the access lines, the upload folder, Account), or null. */
  host: (SettingsReply & { account?: { provider: string | null } | null }) | null;
  /** From the terminal (6.9): each project's sessions once read (act.loadSessions). */
  sessions: Record<string, SessionView[]>;
  /** Row 77: why each project's list, as last read, is empty or short (the server applies Settings > Chats). */
  sessionsHidden: Record<string, SessionsHidden>;
  /**
   * D59: each project's `/` commands for the new-chat form, once read (act.loadProjectCommands): the list and when the
   * server read it (`at` null, with an empty list, while its first read runs or after it failed).
   */
  projectCommands: Record<string, ProjectCommandsReply>;
  /**
   * Row 81: Claude Code's model list, the same in every chat and project, as the server last gave it (the form's and the
   * project page's read, act.loadModels, or any chat's `get models`), or null while the page has none with rows.
   */
  modelList: ModelInfo[] | null;
  /**
   * Settings' reads of a live chat's init facts (readInitFacts), by chat: `reading` while one is on its way, `none`
   * once one ended with no facts. Settings waits quietly while a read can still bring them (settingsInit).
   */
  factsReads: Record<string, "reading" | "none">;
  /**
   * This page's sends, `!` commands and Send agains whose ack has not come, by chat (their ids: a message's uuid, a
   * command's rid, a Send again's rid and its Not sent messages' uuids): while the socket is not open, or while its ack
   * is overdue (`overdue`), such a message's bubble is drawn as not sent yet, and the chat says Reconnecting... (4.3).
   */
  outgoing: Record<string, readonly string[]>;
  /** The ids (as `outgoing`'s) whose ack is overdue on an open socket: the link may be silent (net/socket.ts). */
  overdue: readonly string[];
  /** The chats whose Send again (`send_queued`) waits for its ack: Send again is off there, so a press sends one. */
  sendAgainOut: readonly string[];
  /** Row 111: this page's last Send now per chat (sendNow.ts): Send now stays away from what it sent, so a press acts once. */
  sendNowPressed: Record<string, SendNowPress>;
  /**
   * The new-chat form's sessions whose Start (`new_chat`) waits for its ack (W3: in a worktree project the ack comes
   * after git checked the worktree out): Start is off meanwhile, so a second press makes no second chat or worktree.
   */
  newChatOut: readonly string[];
  /** The projects' list came from the server at least once (GET /api/projects, or a project's own answer). */
  projectsRead: boolean;
  /**
   * The refused request's code and project behind `notice`, while that line shows (it goes with the line): a line with
   * env_unreadable (L39) links to that project's environment.
   */
  noticeFor: { code: ErrorCode; project: string | null } | null;
  /**
   * R124 (row 124): each chat's side thread as the page holds it (side/thread.ts): read with `get side` while the side
   * chat is open, and kept current by the ring's side events. Select with `s.side[id] ?? EMPTY_THREAD`.
   */
  side: Record<string, SideThread>;
  /**
   * R124: the server's agent answers side questions (`welcome.capabilities`). Off: every way into the side chat is
   * hidden (the `/btw` row, the title bar tool, the pane bar button, the session menu item and the key); an
   * `unsupported` ack turns it off too.
   */
  sideQuestions: boolean;
  /**
   * R127: the server's agent can trust a folder itself (`welcome.capabilities.trustFolder`: Claude Code records the
   * trust from kitespan's attestation). Off: the Trust this folder line offers Open in terminal instead, and no confirm
   * offers the press; an `unsupported` ack turns it off too.
   */
  trustFolder: boolean;
  /**
   * FIX-U2 (D49): each chat's side box as the page holds it: the server's side draft (`attached.sideDraft`, the `draft`
   * frames with `box: "side"`), or this page's own typing until the server has it. Select with sideBoxOf.
   */
  sideDraft: Record<string, SideBoxDraft>;
}

/** The parts of the Storage interface the store uses, so a test can hand it a memory copy. */
export type KeyValueStore = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

function storage(): KeyValueStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The local storage key of this device's appearance settings; index.html's inline script reads the look from it. */
export const SETTINGS_KEY = "kitespan.settings";
const VIEW_KEY = "kitespan.view";
/** + the chat id: the pending copy of a draft that the server has not confirmed (7.5). */
export const DRAFT_COPY_KEY = "kitespan.draft.";
/** + the chat id: the drafts of this tab's sends and `!` commands whose ack has not come (4.3, 7.5; SentCopy). */
export const SENT_COPY_KEY = "kitespan.sent.";
export const DRAFT_LIFE_MS = 24 * 60 * 60 * 1000;
export const DRAFT_WRITE_MS = 250;
/** A page whose box had input this recently is being typed in: a draft from the server waits (7.5, a design value). */
export const TYPING_MS = 2_000;

function readJson(kv: KeyValueStore | null, key: string): unknown {
  try {
    const raw = kv?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(kv: KeyValueStore | null, key: string, value: unknown) {
  try {
    kv?.setItem(key, JSON.stringify(value));
  } catch {} // full or blocked storage: the value stays in memory
}

/**
 * The settings this device keeps (look, theme, text size, Reduce motion, the Return key) over the defaults. A look
 * kept under its old id (row 105) reads as its new one; the next save writes the new id.
 */
export function loadSettings(kv: KeyValueStore | null = storage()): AppSettings {
  const raw = readJson(kv, SETTINGS_KEY);
  const stored = raw && typeof raw === "object" ? (raw as Partial<AppSettings>) : {};
  const out: AppSettings = { ...DEFAULT_SETTINGS };
  out.look = lookOf(stored.look) ?? out.look;
  if (stored.theme === "dark" || stored.theme === "light" || stored.theme === "system") out.theme = stored.theme;
  if ((TEXT_SIZES as readonly number[]).includes(stored.textSize as number)) out.textSize = stored.textSize as number;
  if (stored.reduceMotion === "system" || stored.reduceMotion === "on") out.reduceMotion = stored.reduceMotion;
  if (stored.returnKey === "send" || stored.returnKey === "newline") out.returnKey = stored.returnKey;
  return out;
}

const DEVICE_KEYS = ["look", "theme", "textSize", "reduceMotion", "returnKey"] as const satisfies readonly (keyof AppSettings)[];

function saveDeviceSettings(s: AppSettings) {
  writeJson(storage(), SETTINGS_KEY, Object.fromEntries(DEVICE_KEYS.map((k) => [k, s[k]])));
}

export function loadView(kv: KeyValueStore | null = storage()): ViewPrefs {
  const raw = readJson(kv, VIEW_KEY) as Partial<Record<keyof ViewPrefs, unknown>> | null;
  const split = cleanSplit(raw?.split);
  return {
    railHidden: raw?.railHidden === true ? true : DEFAULT_VIEW.railHidden,
    sidebarHidden: raw?.sidebarHidden === true ? true : DEFAULT_VIEW.sidebarHidden,
    widths: cleanWidths(raw?.widths),
    ...(split === undefined ? {} : { split }),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The state and its subscribers

function initialState(): State {
  return {
    projects: [],
    chats: [],
    settings: loadSettings(),
    draft: {},
    drafts: {},
    draftUploads: {},
    draftLink: {},
    notice: null,
    noticeChat: null,
    view: loadView(),
    toasts: [],
    restart: null,
    restarting: false,
    restartWait: null,
    update: "none",
    updateNotice: null,
    uploads: {},
    takeBackWait: null,
    bringBackWait: null,
    net: "down",
    ready: false,
    server: { version: null, claude: null, epoch: null },
    machine: null,
    host: null,
    sessions: {},
    sessionsHidden: {},
    projectCommands: {},
    modelList: null,
    factsReads: {},
    outgoing: {},
    overdue: [],
    sendAgainOut: [],
    sendNowPressed: {},
    newChatOut: [],
    projectsRead: false,
    noticeFor: null,
    side: {},
    sideQuestions: false,
    trustFolder: false,
    sideDraft: {},
  };
}

let state: State = initialState();
const listeners = new Set<() => void>();

function set(next: State) {
  state = next;
  for (const l of listeners) l();
}
function patch(p: Partial<State>) {
  // A new line (or none) that does not name its code has none: noticeFor belongs to the line it came with.
  set({ ...state, ...("notice" in p && !("noticeFor" in p) ? { noticeFor: null } : {}), ...p });
}

export function getState(): State {
  return state;
}

/** S1: one subscribe function for every hook, so React does not subscribe again after each render. */
function subscribeStore(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useStore<T>(select: (s: State) => T): T {
  return useSyncExternalStore(
    subscribeStore,
    () => select(state),
    () => select(state),
  );
}

/** Tests only: start again from `p` over an empty state (no socket). */
export function resetState(p: Partial<State> = {}) {
  for (const t of syncs.values()) if (t.timer) clearTimeout(t.timer);
  syncs.clear();
  chatMeta.clear();
  inFlight.clear();
  sentRids.clear();
  restoredSends.clear();
  rows = [];
  openChat = null;
  for (const t of initReads.values()) if (t) clearTimeout(t);
  initReads.clear();
  resetReplays();
  screen.reset();
  uploadsRead = null;
  uploadReads.clear();
  sought.clear();
  reading.clear();
  commandReads.clear();
  listFilter = null;
  sessionReads.clear();
  shownNotice = null;
  byeForRestart = false;
  failedShown = null;
  leaving.clear();
  trustOut.clear();
  bgStopOut.clear();
  projectsGen = 0;
  welcomed = false;
  sideViews.clear();
  for (const t of sideSyncs.values()) for (const timer of [t.timer, t.holdTimer]) if (timer) clearTimeout(timer);
  sideSyncs.clear();
  set({ ...initialState(), ...p });
}

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers the components use

/** The uploads of a chat with none, for a selector: `useStore((s) => s.uploads[chatId] ?? NO_UPLOADS)`. */
export const NO_UPLOADS: readonly Upload[] = Object.freeze([]);
/** One MB, as Finder counts it (and as the size labels show it). */
export const MB = 1_000_000;

/** The chats that the lists show: the archived ones only under the Archived row (D48). */
export function visibleChats(chats: readonly Chat[]): Chat[] {
  return chats.filter((c) => !c.archived);
}

export function tooLargeLine(maxMB: number): string {
  return `That file is larger than the ${maxMB} MB limit.`;
}

/** The machine's name from `welcome`: a non-empty string of at most 63 characters with no control character. */
export function machineOf(host: unknown): string | null {
  return typeof host === "string" && host.trim() && host.length <= 63 && !/[\u0000-\u001f\u007f]/.test(host) ? host.trim() : null;
}

/** New environment's line for a folder that is neither absolute nor under the home folder (act.addFolder). */
export const FOLDER_NOT_FULL = "That is not a full path. Start it with / or ~/.";
/** act.addFolder's line for a full path that cleanFolder refuses: `/`, an empty, "." or ".." part, a control character. */
export const FOLDER_REFUSED = "That folder cannot be used.";

/** The line of DESIGN.md 4.4 for a Custom folder with no saved path that can be used. */
export const FOLDER_MISSING_LINE = "The upload folder does not exist. Make it, or pick another folder in Settings > Chats > Uploads.";

/**
 * A folder for a new project: an absolute path (or one under ~), without trailing slashes, "." or ".." parts, or
 * control characters. Null when it is not one.
 */
export function cleanFolder(input: string): string | null {
  const s = input.trim().replace(/\/+$/, "");
  if (!s || s.length > 1024 || /[\u0000-\u001f\u007f]/.test(s)) return null;
  if (!s.startsWith("/") && !s.startsWith("~/")) return null;
  const parts = s.split("/").slice(1);
  if (!parts.length || parts.some((p) => p === "" || p === "." || p === "..")) return null;
  return s;
}

export interface UploadRoot {
  folder: UploadFolder;
  path: string;
  refused: string | null;
}

/**
 * The upload folder now: the server's checked path for the chosen folder when it sent one (/api/settings), else the
 * choice's own label. A Custom folder with no usable saved path is refused (FOLDER_MISSING_LINE).
 */
export function uploadRoot(settings: Pick<AppSettings, "uploadFolder" | "customFolder">, sessionId: string): UploadRoot {
  const pick = (id: UploadFolder) => UPLOAD_FOLDERS.find((f) => f.id === id)!.path.replace(/\/+$/, "");
  const known = state.host?.uploads;
  const fromServer = known && state.settings.uploadFolder === settings.uploadFolder ? known : null;
  if (fromServer && !fromServer.ok) return { folder: settings.uploadFolder, path: "", refused: fromServer.line };
  if (settings.uploadFolder === "custom") {
    const custom = cleanFolder(settings.customFolder);
    return custom ? { folder: "custom", path: custom, refused: null } : { folder: "custom", path: "", refused: FOLDER_MISSING_LINE };
  }
  if (fromServer?.ok && settings.uploadFolder !== "claude") return { folder: settings.uploadFolder, path: fromServer.path.replace(/\/+$/, ""), refused: null };
  if (settings.uploadFolder === "claude") return { folder: "claude", path: pick("claude").replace("<session>", sessionId || "<session>"), refused: null };
  return { folder: settings.uploadFolder, path: pick(settings.uploadFolder), refused: null };
}

export function uploadRootLabel(root: UploadRoot): string {
  return root.refused ?? `${root.path}/`;
}

/**
 * True when the box holds a `!` command or a `/` command with something in it (its mode, never its text's first
 * character). The one-string form ("!" or "/" first) is read as that form says.
 */
export function isCommandDraft(draft: ChatDraft | string): boolean {
  if (typeof draft === "string") return (draft.startsWith("!") || draft.startsWith("/")) && draft.slice(1).trim() !== "";
  return draft.mode !== "chat" && (draft.command !== null || draft.text.trim() !== "");
}

/** The notice line a chat's screen shows: only one about that chat. */
export function chatNotice(s: Pick<State, "notice" | "noticeChat">, chatId: string): string | null {
  return s.noticeChat === chatId ? s.notice : null;
}

/** The notice line by the chat list, and on a screen that is not a chat (Home, /new, Settings, the phone's list). */
export function listNotice(s: Pick<State, "notice" | "noticeChat">): string | null {
  return s.noticeChat === null ? s.notice : null;
}

/** The line above the message box while a Take back waits for a command there (ChatScreen shows it). */
export function takeBackWaitLine(cardWaits: boolean): string {
  return cardWaits
    ? "To take that message back, first answer the request, then run or clear the command in the message box."
    : "To take that message back, first run or clear the command in the message box.";
}

/** A new session id, which the new-chat form names its uploads' key with (act.uploadForNewChat). */
export function newSessionId(): string {
  return newUuid();
}

/** Where the new-chat form's uploads wait in `state.uploads` until Start gives them to the chat. */
export function newChatUploadsKey(sessionId: string): string {
  return `new:${sessionId}`;
}

/**
 * The mode a link gave a chat's draft, or undefined for typed text. The composer keeps these marks
 * (composer/linkDrafts.ts) and main.tsx hands its reader to the store, so the store never imports the composer.
 * Transitional: only act.setDraft's string form reads it (State.drafts).
 */
let linkModeOf: (chatId: string) => string | undefined = () => undefined;
export function readLinkModesWith(read: (chatId: string) => string | undefined) {
  linkModeOf = read;
}

/** What act.upload needs of a file: its name, size and type, and the bytes (a File) to send. */
export type FileFacts = { name: string; size: number; type: string; file?: Blob };

/** The model rows a chat offers (6.6): its `get models` answer, else Claude Code's default only. */
export function modelRows(chat: Pick<Chat, "models"> | undefined): ModelRow[] {
  const rows = chat?.models;
  if (!rows || rows.length === 0) return [{ ...DEFAULT_MODEL_ROW, efforts: [...DEFAULT_MODEL_ROW.efforts] }];
  return rows.map((m) => ({ id: m.value, label: m.displayName, hint: m.description, efforts: [...m.efforts], supportsAutoMode: m.supportsAutoMode }));
}

/** The `/` menu's rows of a chat (6.4, D47): Claude Code's own list, with "yours" for a command that is not built in. */
export function commandRowsOf(chat: Pick<Chat, "commands"> | undefined): CommandRow[] {
  return (chat?.commands ?? []).map((c) => ({
    name: c.name,
    hint: c.description,
    args: c.argumentHint || undefined,
    source: c.builtin ? "built-in" : "user",
    terminalOnly: c.terminalOnly || undefined,
  }));
}

const EFFORT_ORDER = EFFORTS.map((e) => e.id);

/**
 * What a chat on this model reports after a model switch: an effort the model does not offer becomes its highest
 * level at or under the one picked (its lowest when all are higher), and Auto becomes Manual on a model that cannot
 * run Auto. A model `rows` does not know changes nothing.
 */
export function fitToModel(model: string, effort: string, mode: ModeId, rows: readonly ModelRow[] = MODELS): { effort: string; mode: ModeId } {
  const row = rows.find((m) => m.id === model);
  if (!row) return { effort, mode };
  let fit = effort;
  if (!row.efforts.includes(effort)) {
    const at = EFFORT_ORDER.indexOf(effort);
    const under = row.efforts.filter((e) => EFFORT_ORDER.indexOf(e) <= at);
    fit = (under.length ? under[under.length - 1] : row.efforts[0]) ?? effort;
  }
  return { effort: fit, mode: mode === "auto" && !row.supportsAutoMode ? "default" : mode };
}

// ---------------------------------------------------------------------------------------------------------------
// The draft (D49): the server's fields (4.3 `draft`), and the one-string form of the first readers

/**
 * A chat's message box draft as the store keeps it: the server's own fields. The mode is a field of its own and never
 * comes from the text's first character, so a message that starts with "!" stays a message (5.1 rule 7).
 */
export interface ChatDraft {
  mode: DraftMode;
  /** The `/` chip, in slash mode only. */
  command: string | null;
  /** What the field holds, after the mode and the chip. */
  text: string;
  /** The text came from a link and has not been sent or cleared: every page shows the warning line. */
  link: boolean;
  /** D50: the upload ids whose chips the box shows. */
  uploads: string[];
  /**
   * 9.3: the mention chips, files of the chat's folder picked with `@`, as paths relative to it, in the order picked.
   * Absent: none, as on the wire.
   */
  mentions?: string[];
}

/** No draft: an empty message box. */
export const EMPTY_DRAFT: Readonly<ChatDraft> = Object.freeze({ mode: "chat", command: null, text: "", link: false, uploads: Object.freeze([]) as unknown as string[] });

/**
 * What the composer gives act.setDraft: the box's mode, chip and text (the chips are the store's own: act.upload).
 * `link` left out: as the draft had it, until the box is empty.
 */
export interface DraftInput {
  mode: DraftMode;
  command: string | null;
  text: string;
  link?: boolean;
}

/** A chat's draft, for a selector: `useStore((s) => draftOf(s, chatId))` (EMPTY_DRAFT when it has none). */
export function draftOf(s: Pick<State, "draft">, chatId: string): ChatDraft {
  return s.draft[chatId] ?? EMPTY_DRAFT;
}

/** The `mentions` key of a draft or a frame: only when it names some (absent is none, 4.3). */
function mentionsKey(list: readonly string[] | undefined, max: number = LIMITS.draftMentions): { mentions?: string[] } {
  return list?.length ? { mentions: list.slice(0, max) } : {};
}

const NO_MENTIONS: readonly string[] = Object.freeze([]);

/** A draft's mention chips (none when it has no `mentions`), for a selector too: the same empty list each time. */
export function mentionsIn(d: Pick<ChatDraft, "mentions">): readonly string[] {
  return d.mentions ?? NO_MENTIONS;
}

/** The draft as the `draft` frame carries it. `wireToDraft` gives back the same draft, field for field. */
export function draftToWire(d: ChatDraft): Omit<DraftEditFrame, "t" | "chat"> {
  return { text: d.text, mode: d.mode, command: d.command, link: d.link, uploads: [...d.uploads], ...mentionsKey(d.mentions) };
}

/** The server's draft (a `draft` frame, `attached`) as the store keeps it; `draftToWire` gives back the same fields. */
export function wireToDraft(d: Pick<DraftState, "text" | "mode" | "command" | "link" | "uploads" | "mentions">): ChatDraft {
  return { mode: d.mode, command: d.command, text: d.text, link: d.link, uploads: [...d.uploads], ...mentionsKey(d.mentions) };
}

/** A draft as the server keeps it (protocol nextDraft): the chip in slash mode only. */
function cleanDraft(d: Omit<ChatDraft, "uploads" | "mentions"> & { uploads: readonly string[]; mentions?: readonly string[] }): ChatDraft {
  return { mode: d.mode, command: d.mode === "slash" ? d.command : null, text: d.text, link: d.link, uploads: [...d.uploads], ...mentionsKey(d.mentions) };
}

/** The same draft with these mention chips (the key left out for none). */
function withMentions(d: ChatDraft, list: readonly string[]): ChatDraft {
  const { mentions: _was, ...rest } = d;
  return { ...rest, ...mentionsKey(list) };
}

/** Two drafts' mention chips together, each once, in order, at most the draft's 100. */
function joinMentions(a: Pick<ChatDraft, "mentions">, b: Pick<ChatDraft, "mentions">): string[] {
  return [...new Set([...mentionsIn(a), ...mentionsIn(b)])].slice(0, LIMITS.draftMentions);
}

const isEmptyDraft = (d: ChatDraft) => d.mode === "chat" && d.text === "" && d.command === null && d.uploads.length === 0 && !d.mentions?.length;

/**
 * The draft in the first readers' one-string form: "!" and the command in Bash mode, "/" and the chip in slash mode,
 * else the text. `draftString(parseDraftString(s))` is `s` for every string.
 */
export function draftString(d: Pick<ChatDraft, "mode" | "command" | "text">): string {
  if (d.mode === "bash") return `!${d.text}`;
  if (d.mode === "slash") return d.command ? `/${d.command} ${d.text}` : `/${d.text}`;
  return d.text;
}

/**
 * The one-string form as fields. `link` is the mode a link gave exactly this text (the composer's mark): link text in
 * chat mode is a message, whatever its first character. Without it, the first character picks the mode.
 */
export function parseDraftString(s: string, link?: string): Omit<ChatDraft, "uploads" | "mentions"> {
  const fromLink = link !== undefined;
  if (link === "chat") return { mode: "chat", command: null, text: s, link: true };
  if (s.startsWith("!")) return { mode: "bash", command: null, text: s.slice(1), link: fromLink };
  if (s.startsWith("/")) {
    const m = /^\/(\S+) ([\s\S]*)$/.exec(s);
    const cmd = m?.[1];
    if (m && cmd && cmd.length <= LIMITS.draftCommand && !CONTROL_CHARS.test(cmd)) return { mode: "slash", command: cmd, text: m[2]!, link: fromLink };
    return { mode: "slash", command: null, text: s.slice(1), link: fromLink };
  }
  return { mode: "chat", command: null, text: s, link: fromLink };
}

/** The message that Send sends for a draft, or the command that Run runs (the composer's rule, composer/draft.ts). */
function outgoingOf(d: ChatDraft): string {
  if (d.mode === "slash") {
    if (!d.command) return d.text.trim() ? `/${d.text.trimEnd()}` : "";
    const args = d.text.trim();
    return args ? `/${d.command} ${args}` : `/${d.command}`;
  }
  if (d.mode === "bash") return d.text.trim();
  return d.text.trim() ? d.text.trimEnd() : "";
}

/** One key for a draft's content, to tell this page's own save from a change the server made (Take back, Send). */
function draftKey(d: { text: string; mode: DraftMode; command: string | null; link: boolean; uploads: readonly string[]; mentions?: readonly string[] }): string {
  return JSON.stringify([d.text, d.mode, d.command, d.link, d.uploads, d.mentions ?? []]);
}

/** The pending copy: the draft's fields, the server's `rev` they were typed on, and when. */
interface DraftCopy extends ChatDraft {
  rev: number;
  at: number;
}

function readCopy(kv: KeyValueStore | null, chatId: string, now = Date.now()): DraftCopy | null {
  const v = readJson(kv, DRAFT_COPY_KEY + chatId) as Partial<DraftCopy> | null;
  if (!v || typeof v.text !== "string" || typeof v.rev !== "number" || typeof v.at !== "number" || now - v.at >= DRAFT_LIFE_MS) return null;
  // A copy without its mode (an older page's) is not read: its mode would have to come from its text.
  if (!DRAFT_MODES.includes(v.mode as DraftMode) || typeof v.link !== "boolean" || !(v.command === null || typeof v.command === "string")) return null;
  const uploads = Array.isArray(v.uploads) ? v.uploads.filter((u): u is string => typeof u === "string") : [];
  // An older page's copy has no mentions; a list that is not one of safe relative paths is left out.
  const mentions = mentionsOf(v.mentions) ?? [];
  return { ...cleanDraft({ mode: v.mode!, command: v.command, text: v.text, link: v.link, uploads, mentions }), rev: v.rev, at: v.at };
}

/**
 * A send or a `!` command on its way (4.3, "the tab's pending copy"): its draft as a refusal would put it back, the
 * request's id (the message's uuid, the command's row id), the tab that sent it (a reload keeps the tab id; this
 * browser's other tabs share local storage and leave it alone), the server's draft `rev` the box was typed on, and
 * when. The ack ends it; after a reload it is decided once the chat's replay is in (restoreSent).
 */
interface SentCopy extends ChatDraft {
  id: string;
  tab: string;
  rev: number;
  at: number;
}

function readSent(kv: KeyValueStore | null, chatId: string, now = Date.now()): SentCopy[] {
  const v = readJson(kv, SENT_COPY_KEY + chatId);
  if (!Array.isArray(v)) return [];
  const out: SentCopy[] = [];
  for (const c of v as Partial<SentCopy>[]) {
    if (!c || typeof c.id !== "string" || typeof c.tab !== "string" || typeof c.text !== "string" || typeof c.rev !== "number" || typeof c.at !== "number" || now - c.at >= DRAFT_LIFE_MS) continue;
    if (!DRAFT_MODES.includes(c.mode as DraftMode) || typeof c.link !== "boolean" || !(c.command === null || typeof c.command === "string")) continue;
    const uploads = Array.isArray(c.uploads) ? c.uploads.filter((u): u is string => typeof u === "string") : [];
    const mentions = mentionsOf(c.mentions) ?? [];
    out.push({ ...cleanDraft({ mode: c.mode!, command: c.command, text: c.text, link: c.link, uploads, mentions }), id: c.id, tab: c.tab, rev: c.rev, at: c.at });
  }
  return out;
}

function writeSent(kv: KeyValueStore | null, chatId: string, list: readonly SentCopy[]) {
  if (list.length) writeJson(kv, SENT_COPY_KEY + chatId, list);
  else
    try {
      kv?.removeItem(SENT_COPY_KEY + chatId);
    } catch {} // blocked storage
}

/** The pending copies and the sent copies at start: the expired and the unreadable ones go (7.5, the sweep). */
export function sweepDraftCopies(kv: KeyValueStore | null = storage(), now = Date.now()): number {
  if (!kv) return 0;
  let n = 0;
  try {
    const keys: string[] = [];
    for (let i = 0; i < kv.length; i++) {
      const k = kv.key(i);
      if (k?.startsWith(DRAFT_COPY_KEY) || k?.startsWith(SENT_COPY_KEY) || k?.startsWith(SIDE_COPY_KEY)) keys.push(k);
    }
    for (const k of keys) {
      if (k.startsWith(SENT_COPY_KEY)) {
        const chatId = k.slice(SENT_COPY_KEY.length);
        const raw = readJson(kv, k);
        const kept = readSent(kv, chatId, now);
        if (!Array.isArray(raw) || kept.length !== raw.length) writeSent(kv, chatId, kept);
      } else if (k.startsWith(SIDE_COPY_KEY)) {
        // FIX-U2: the side box's pending copy.
        if (!readSideCopy(kv, k.slice(SIDE_COPY_KEY.length), now)) {
          kv.removeItem(k);
          n++;
        }
      } else if (!readCopy(kv, k.slice(DRAFT_COPY_KEY.length), now)) {
        kv.removeItem(k);
        n++;
      }
    }
  } catch {} // blocked storage
  return n;
}

/**
 * The page's draft rule after the server's draft arrives (7.5) as a pure function: show it, hold it while the box is
 * being typed in, or keep it out (this page's own save coming back).
 */
export function draftDecision(input: { own: boolean; typedAt: number; composing: boolean; linkUnchanged: boolean; now: number }): "show" | "hold" | "own" {
  if (input.own) return "own";
  if (input.composing || input.linkUnchanged || input.now - input.typedAt < TYPING_MS) return "hold";
  return "show";
}

/** Whether a pending copy wins after a reload: its `rev` is still the server's and it says something else (7.5). */
export function copyWins(copy: DraftCopy | null, server: DraftState, now = Date.now()): boolean {
  if (!copy || now - copy.at >= DRAFT_LIFE_MS || copy.rev !== server.rev) return false;
  return draftKey(copy) !== draftKey(server);
}

// ---------------------------------------------------------------------------------------------------------------
// The connection

let conn: Connection | null = null;
/**
 * Row 116, the seen report (net/onScreen.ts): which attached chat this page has on screen at its end. The chat's view
 * says so (act.onScreen); the page's visibility, each attach (`attaching`) and each drawn attach are told here. R130:
 * an `on` that went out also closes this device's own notifications of that chat, or of that background session.
 */
const screen = new OnScreen({
  write: (chat, on, background) => {
    const went = conn?.onScreen(chat, on, background) ?? false;
    if (went && on) void closeShown(notificationTag(chat, background));
    return went;
  },
  visible: () => typeof document === "undefined" || document.visibilityState === "visible",
});
/** The chat list as the server sends it. */
let rows: ChatRow[] = [];

interface ChatMeta {
  epoch: string | null;
  /** The highest `seq` drawn. */
  seq: number;
  /** `attached.seq`: the events up to it are a replay. */
  attachedSeq: number;
  answers: Map<string, AnsweredAs>;
  interrupted: Set<number>;
  /** The cards of replayed `card_open` events, so their replayed `card_close` leaves the record (reduce.ts). */
  seen: Map<string, Card>;
  pageN: number;
  /**
   * The last attach's draft `rev`, and whether a pending copy won on it (text typed after a send), until the replay is
   * in: then the sent copies of an earlier page life are decided (restoreSent).
   */
  sentCheck: { rev: number; typed: boolean } | null;
  /** The `ev` frames of the last snapshot's tail that have not come yet (`snapshot.tail`); null when it gave none. */
  tailLeft: number | null;
  /** The path of the last attach while its replay is not in (afterReplay), else null. */
  replay: AttachedFrame["replay"] | null;
}
const chatMeta = new Map<string, ChatMeta>();
function metaOf(chatId: string): ChatMeta {
  let m = chatMeta.get(chatId);
  if (!m) chatMeta.set(chatId, (m = { epoch: null, seq: 0, attachedSeq: 0, answers: new Map(), interrupted: new Set(), seen: new Map(), pageN: 0, sentCheck: null, tailLeft: null, replay: null }));
  return m;
}
/**
 * The ids of this page life's sends and `!` commands whose ack has not come (a message's uuid, a command's rid): the
 * outbox still holds them.
 */
const inFlight = new Set<string>();
/**
 * The ids that a request's rid stands for when they are not its rid (a restored message's uuid; a Send again's rid
 * and its messages' uuids): an overdue rid names its bubbles' ids.
 */
const sentRids = new Map<string, readonly string[]>();
/**
 * The messages that restoreSent put back in the box (no ack ever came for them), by chat: each one's uuid and the
 * message as it went (its text and chips). Its first copy may still be on its way in an old socket's stream (a silent
 * link), so a Send of the same message reuses the uuid, with a new rid, and the server's uuid check runs it once,
 * whichever copy comes second. When that first copy lands (its `user` event) while the box still holds the message,
 * the box empties.
 */
interface RestoredSend {
  uuid: string;
  text: string;
  uploads: readonly string[];
  mentions: readonly string[];
}
const restoredSends = new Map<string, RestoredSend[]>();
const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
/** The restored message that this send is, taken from the list (a refusal puts it back), or null. */
function takeRestored(chatId: string, text: string, uploads: readonly string[], mentions: readonly string[]): RestoredSend | null {
  const list = restoredSends.get(chatId);
  const at = list?.findIndex((r) => r.text === text && sameList(r.uploads, uploads) && sameList(r.mentions, mentions)) ?? -1;
  if (!list || at < 0) return null;
  const [r] = list.splice(at, 1);
  if (!list.length) restoredSends.delete(chatId);
  return r!;
}
/** A restored message's first copy ran (its `user` event): the box that still holds it, as it went, empties. */
function restoredRan(chatId: string, uuid: string) {
  const list = restoredSends.get(chatId);
  const at = list?.findIndex((r) => r.uuid === uuid) ?? -1;
  if (!list || at < 0) return;
  const [r] = list.splice(at, 1);
  if (!list.length) restoredSends.delete(chatId);
  const box = fieldsOf(chatId);
  if (outgoingOf(box) !== r!.text || !sameList(box.uploads, r!.uploads) || !sameList(mentionsIn(box), r!.mentions)) return;
  putDraft(chatId, { ...EMPTY_DRAFT, uploads: [] });
  changedDraft(chatId, true, false);
}

interface DraftSync {
  /** The newest draft the server sent. */
  server: DraftState | null;
  /** The rev of the draft the box last showed (or this page's own save): what a Send clears (F2). */
  shownRev: number | null;
  /** A server draft that waits for the typing to stop. */
  held: { d: DraftState; at: number } | null;
  typedAt: number;
  composing: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  holdTimer: ReturnType<typeof setTimeout> | null;
  /** A change that is not sent yet. */
  dirty: boolean;
  lastSentKey: string | null;
  lastSentAt: number;
  /**
   * The one-string form the box last gave (act.setDraft with a string), while the draft's fields come from it: they
   * are read again with the composer's link mark, which it writes just after the change (fieldsOf).
   */
  oneString: string | null;
  /**
   * This page's Take backs whose draft has not come (act.takeBack): the request's rid, the message, and the box's
   * text that the server puts the message before. The server sends the message's `taken_back` event, then that
   * draft, then the ack: `armed` from the event on, so the echo of the save just before the take_back is never taken
   * for it, and the ack ends the wait.
   */
  putBacks: { rid: string; uuid: string; base: string; armed: boolean }[];
}
const syncs = new Map<string, DraftSync>();
function syncOf(chatId: string): DraftSync {
  let s = syncs.get(chatId);
  if (!s) syncs.set(chatId, (s = { server: null, shownRev: null, held: null, typedAt: 0, composing: false, timer: null, holdTimer: null, dirty: false, lastSentKey: null, lastSentAt: 0, oneString: null, putBacks: [] }));
  return s;
}

/**
 * Keep this draft as the chat's, with its one-string views (`drafts`, `draftUploads`, `draftLink`). `oneString`: the
 * box gave the draft in that form (DraftSync.oneString); any other write ends it.
 */
function putDraft(chatId: string, d: ChatDraft, more: Partial<State> = {}, oneString: string | null = null) {
  syncOf(chatId).oneString = oneString;
  const { [chatId]: _draft, ...draft } = state.draft;
  const { [chatId]: _text, ...drafts } = state.drafts;
  const text = draftString(d);
  patch({
    draft: isEmptyDraft(d) && !d.link ? draft : { ...draft, [chatId]: d },
    drafts: text === "" ? drafts : { ...drafts, [chatId]: text },
    draftUploads: { ...state.draftUploads, [chatId]: [...d.uploads] },
    // A message that starts with "!" is link text in the one-string form, so its readers keep it a message.
    draftLink: { ...state.draftLink, [chatId]: d.link || (d.mode === "chat" && d.text.startsWith("!")) },
    ...more,
  });
}

/**
 * The chat's draft now. While the box's last change came in the one-string form, its fields are read again with the
 * composer's link mark for exactly that text (the mark is written just after the change), and kept.
 */
function fieldsOf(chatId: string): ChatDraft {
  const cur = draftOf(state, chatId);
  const s = syncs.get(chatId)?.oneString ?? null;
  if (s === null) return cur;
  const fresh: ChatDraft = { ...parseDraftString(s, s !== "" ? linkModeOf(chatId) : undefined), uploads: [...cur.uploads], ...mentionsKey(cur.mentions) };
  if (draftKey(fresh) === draftKey(cur)) return cur;
  putDraft(chatId, fresh, {}, s);
  return fresh;
}

/** After a one-string change: its fields with the mark the composer wrote since, and the pending copy with them. */
function rereadOneString(chatId: string) {
  const st = syncs.get(chatId);
  if (!st || st.oneString === null) return;
  const before = state.draft[chatId];
  fieldsOf(chatId);
  if (st.dirty && state.draft[chatId] !== before) writeCopy(chatId);
}

/** The chat on screen (act.open). */
let openChat: string | null = null;

/**
 * Settings' reads of a live chat's init facts (readInitFacts), by chat: its timer, once the snapshot came, that ends
 * a read whose tail held no `session` event.
 */
const initReads = new Map<string, ReturnType<typeof setTimeout> | null>();
/** How long a read waits after its snapshot for the tail, which the server sends right after it. */
const INIT_READ_MS = 1_000;
/** The server's states of a chat whose Claude Code runs and has said its facts. */
const LIVE_STATES: ReadonlySet<WireChatState> = new Set(["idle", "running", "waiting"]);

/**
 * Settings shows what a chat's Claude Code loaded at its start (6.5, 6.8: skills and plugins, output style, fast
 * mode), from the chat's `session` event, which a page has only for a chat it attached. So a chat is attached only
 * until its `session` event comes in the snapshot's tail: `chatId` (the chat the user came from) while its Claude
 * Code runs, else, while no chat in the lists has the facts, the newest live chat. Only a live chat with no known
 * facts is read. attach and detach only read, and the read takes no draft.
 */
function readInitFacts(chatId?: string) {
  if (!conn) return;
  const shown = visibleChats(state.chats);
  const asked = chatId ? shown.find((c) => c.id === chatId) : undefined;
  if (asked?.init) return;
  const chat = asked && LIVE_STATES.has(asked.serverState) ? asked : shown.some((c) => c.init) ? undefined : shown.find((c) => LIVE_STATES.has(c.serverState));
  if (!chat || chat.init || !LIVE_STATES.has(chat.serverState) || initReads.has(chat.id) || conn.isAttached(chat.id)) return;
  initReads.set(chat.id, null);
  patch({ factsReads: { ...state.factsReads, [chat.id]: "reading" } });
  const m = metaOf(chat.id);
  screen.attaching(chat.id);
  conn.attach(chat.id, m.seq, m.epoch);
}

/** The read is over: the chat is detached, unless it is on screen now (`detach` false: act.open keeps it). */
function endInitRead(chatId: string, detach = true) {
  if (!initReads.has(chatId)) return;
  const t = initReads.get(chatId);
  if (t) clearTimeout(t);
  initReads.delete(chatId);
  const { [chatId]: _was, ...rest } = state.factsReads;
  patch({ factsReads: findChat(chatId)?.init || !detach ? rest : { ...rest, [chatId]: "none" } });
  if (detach && chatId !== openChat) conn?.detach(chatId);
}

/**
 * The init facts Settings shows (6.5, 6.8): those of the chat the user came from (`fromId`), else of the newest chat
 * in the lists that has them. `waiting` while they can still come: the chat list has not come, or the chat they are
 * read from runs and no read of it ended with none (readInitFacts). Then the rows wait quietly, with no "Start a chat
 * to read it." before the value.
 */
export function settingsInit(s: Pick<State, "chats" | "ready" | "factsReads">, fromId?: string): { init: InitFacts | null; waiting: boolean } {
  if (!s.ready) return { init: null, waiting: true };
  const shown = visibleChats(s.chats);
  const comes = (c: Chat | undefined) => !!c && LIVE_STATES.has(c.serverState) && s.factsReads[c.id] !== "none";
  const asked = fromId ? shown.find((c) => c.id === fromId) : undefined;
  if (asked?.init) return { init: asked.init, waiting: false };
  if (comes(asked)) return { init: null, waiting: true };
  const newest = shown.find((c) => c.init)?.init ?? null;
  if (newest) return { init: newest, waiting: false };
  return { init: null, waiting: comes(shown.find((c) => LIVE_STATES.has(c.serverState))) };
}
/** The open chat whose uploads were read; a chat the list does not have yet waits (a dead link reads nothing). */
let uploadsRead: string | null = null;

function readOpenUploads() {
  if (!openChat || uploadsRead === openChat || !rows.some((r) => r.chat === openChat)) return;
  uploadsRead = openChat;
  refreshUploads(openChat, true);
}

/** The chats whose uploads are being read, and whether a newer reason to read came while the read ran. */
const uploadReads = new Map<string, { again: boolean }>();
/** Per chat, the upload ids and messages that made this page read the uploads again, so each does it once. */
const sought = new Map<string, Set<string>>();

/**
 * Read a chat's uploads into the store, one read at a time per chat. `fresh`: a read in flight answers this reason
 * too (it started after what is looked for was made); else the chat is read once more when it ends.
 */
function refreshUploads(chatId: string, fresh = false) {
  if (!rows.some((r) => r.chat === chatId)) return;
  const was = uploadReads.get(chatId);
  if (was) {
    if (!fresh) was.again = true;
    return;
  }
  const job = { again: false };
  uploadReads.set(chatId, job);
  void loadUploads(chatId).finally(() => {
    uploadReads.delete(chatId);
    if (job.again) refreshUploads(chatId);
  });
}

/**
 * True when the text holds a reference to an absolute path (or one under ~), in a form that refAt reads (`@<path>`,
 * `@"<path>"`, or the path in backticks: shared/protocol.ts messageRef), that none of the list's uploads' references
 * and none of `known` (the message's mention references) starts: the server added it for an upload this page has not
 * read (D50).
 */
export function hasUnknownRef(text: string, uploads: readonly Upload[], known: readonly string[] = []): boolean {
  const refs = [...known, ...uploads.flatMap((u) => (u.state === "done" && u.path ? uploadRefForms(u) : []))];
  return refsIn(text).some((r) => (r.path.startsWith("/") || r.path.startsWith("~/")) && !refs.some((ref) => text.startsWith(ref, r.at)));
}

/**
 * The forms of an upload's reference that a message may hold: its path's, then (round K1) the path's from before
 * kitespan's folder move, which the messages sent before the move hold.
 */
export function uploadRefForms(u: Upload): string[] {
  return u.was ? [...messageRefForms(u.path), ...messageRefForms(u.was)] : messageRefForms(u.path);
}

/** The references of the mention chips that a `user` event names (9.3), in every form: files, not uploads. */
function mentionRefs(mentions: unknown, chatId: string): string[] {
  const list = userMentions(mentions).mentions;
  const root = list ? cwdOf(findChat(chatId))?.replace(/\/+$/, "") : undefined;
  return list && root ? list.flatMap((rel) => messageRefForms(`${root}/${rel}`)) : [];
}

/**
 * Another page added an upload (D50): a draft names an id this page has not read, or a message holds a reference it
 * cannot match. The chat's uploads are read again, so the chip, the message's file tile and the Uploads panel share
 * the one list. Each id or message (`keys`) asks once.
 */
function seekUploads(chatId: string, keys: readonly string[], fresh = false) {
  const asked = sought.get(chatId) ?? new Set<string>();
  const known = state.uploads[chatId] ?? NO_UPLOADS;
  const ask = keys.filter((k) => !asked.has(k) && !known.some((u) => u.id === k));
  if (!ask.length) return;
  for (const k of ask) asked.add(k);
  sought.set(chatId, asked);
  refreshUploads(chatId, fresh);
}

/**
 * The chat's Claude Code session id as its row gives it (the ledger's), or null: none yet, or a server that sends none.
 * A chat that has not run on this page (a reload, a second device, a restart) has no `session` event here, and its
 * session is what Continue in a copy forks (W5) and what Copy the command resumes.
 */
function sessionOfRow(row: ChatRow): string | null {
  return isUuid(row.session) ? row.session : null;
}

/** Row 116: the row's seen flag (absent, or a value the page does not know: seen). */
const rowUnseen = (row: ChatRow) => unseenOf(row.unseen);
/** R131: the row's own field for its background sessions (absent, null, or a value the page does not know: none). */
const rowBgDot = (row: ChatRow) => bgDotOf(row.background);

function blankChat(row: ChatRow): Chat {
  const unseen = rowUnseen(row);
  return {
    id: row.chat,
    projectId: row.project,
    title: row.title ?? "New chat",
    titleSource: "first-prompt",
    state: listState(row.state, unseen),
    unseen,
    bgDot: rowBgDot(row),
    updatedAt: row.lastActivity,
    sessionId: sessionOfRow(row) ?? "",
    model: "default",
    effort: "default",
    mode: "default",
    items: [],
    pending: [],
    context: { usedPct: 0, usedTokens: 0, windowTokens: 0, parts: [] },
    connectors: [],
    outputs: [],
    bypassFlag: false,
    lostRequests: [],
    archived: row.archived,
    needsYou: row.needsYou,
    busy: row.busy ?? false,
    held: row.held ?? null,
    worktree: worktreeOfRow(row),
    init: null,
    picks: { model: null, effort: null, mode: null },
    serverState: row.state,
    loaded: false,
    more: null,
    turn: null,
    liveModel: null,
    version: null,
    commands: null,
    models: null,
    connectorInfo: null,
    tasks: [],
    suggestion: null,
  };
}

/** The chats from the rows: a known chat keeps what the page drew of it; the list is newest first. */
function chatsFromRows(next: readonly ChatRow[]): Chat[] {
  const known = new Map(state.chats.map((c) => [c.id, c]));
  const out = next.map((row): Chat => {
    const was = known.get(row.chat);
    if (!was) return blankChat(row);
    const worktree = worktreeOfRow(row);
    const unseen = rowUnseen(row);
    const next: Chat = {
      ...was,
      projectId: row.project,
      title: row.title ?? was.title,
      state: listState(row.state, unseen),
      unseen,
      bgDot: rowBgDot(row),
      serverState: row.state,
      updatedAt: row.lastActivity || was.updatedAt,
      archived: row.archived,
      needsYou: row.needsYou,
      busy: row.busy ?? false,
      held: row.held ?? null,
      worktree,
      sessionId: sessionOfRow(row) ?? was.sessionId,
    };
    // The chat's folder moved (a worktree that the row names now, or a chat that continues in the project's folder):
    // its rows are drawn again with their paths relative to the new one.
    return worktree?.path !== was.worktree?.path ? withFolder(next, cwdOf(next)) : next;
  });
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

function updateChat(id: string, f: (c: Chat) => Chat) {
  let hit = false;
  const chats = state.chats.map((c) => {
    if (c.id !== id) return c;
    hit = true;
    return f(c);
  });
  if (hit) patch({ chats });
}

const findChat = (id: string) => state.chats.find((c) => c.id === id);
/** The chat's folder in a state: its worktree's (row 73), else its project's; undefined while neither is known. */
export function chatFolderIn(s: Pick<State, "projects">, chat: Pick<Chat, "projectId" | "worktree"> | undefined): string | undefined {
  if (!chat) return undefined;
  return chatFolder(chat.worktree, s.projects.find((p) => p.id === chat.projectId)?.folder) ?? undefined;
}

/** The chat's folder: its worktree's (row 73), else its project's. */
const cwdOf = (chat: Chat | undefined) => (chat ? chatFolder(chat.worktree, state.projects.find((p) => p.id === chat.projectId)?.folder) : null);

/**
 * The fields of a project view that row 73 and D60 add (the Worktree option, why it is off, the count of variables,
 * the unreadable variables file), read with care: a server without them gives a project with none.
 */
interface ProjectViewMore {
  env?: unknown;
  envUnreadable?: unknown;
  worktree?: unknown;
  worktreeOff?: unknown;
}

export function projectOf(v: ProjectView): Project {
  const mode = v.picks.permissionMode;
  const more = v as ProjectView & ProjectViewMore;
  const env = typeof more.env === "number" && Number.isInteger(more.env) && more.env > 0 ? more.env : 0;
  return {
    id: v.id,
    name: v.name,
    folder: v.cwd,
    branch: "",
    picks: {
      ...(v.picks.model ? { model: v.picks.model } : {}),
      ...(v.picks.effort ? { effort: v.picks.effort } : {}),
      ...(mode === "default" || mode === "acceptEdits" || mode === "auto" || mode === "bypassPermissions" ? { mode } : {}),
    },
    env,
    ...(more.envUnreadable === true ? { envUnreadable: true } : {}),
    worktree: more.worktree === true,
    worktreeOff: isWorktreeOff(more.worktreeOff) ? more.worktreeOff : null,
  };
}

/**
 * The projects as the server lists them now. A chat's rows are drawn with its folder as the page knows it then
 * (cwdOf), so a chat whose folder this changes is drawn again with it (withFolder): at boot the page asks for the
 * projects while the socket attaches the open chat, and the chat's snapshot may come first.
 */
function takeProjects(all: Project[]) {
  // Row 99: an environment that the server is removing stays out, also from a list read before its removal ended.
  const projects = leaving.size ? all.filter((p) => !leaving.has(p.id)) : all;
  // The chat's folder as cwdOf reads it: a worktree chat's is its worktree (row 73), which no project list changes.
  const folderIn = (list: readonly Project[], c: Chat) => chatFolder(c.worktree, list.find((p) => p.id === c.projectId)?.folder);
  let changed = false;
  const chats = state.chats.map((c) => {
    const cwd = folderIn(projects, c);
    if (cwd === folderIn(state.projects, c)) return c;
    // The cards kept aside for a replayed close leave their record with the folder too.
    const seen = chatMeta.get(c.id)?.seen;
    if (seen) for (const [id, card] of seen) seen.set(id, cardWithFolder(card, cwd));
    const next = withFolder(c, cwd);
    if (next !== c) changed = true;
    return next;
  });
  patch(changed ? { projects, chats, projectsRead: true } : { projects, projectsRead: true });
}

let projectsAsked = 0;
/** The newest read of the projects (or move): an answer to an older one is left out (row 99). */
let projectsGen = 0;
async function loadProjects(): Promise<void> {
  projectsAsked = Date.now();
  const gen = ++projectsGen;
  try {
    const r = await apiGet<ProjectsReply>("/api/projects");
    if (gen === projectsGen) takeProjects(r.projects.map(projectOf));
  } catch {
    // the list stays as it was; the next chat list asks again
  }
}

/** Row 99: the environments whose removal the server announced (`projects` with `removed`), until its end. */
const leaving = new Set<string>();
/** A welcome came already: a later one (a reconnect) reads the projects again, since a change may have been missed. */
let welcomed = false;

/** Row 99: the server removes this environment: its pages go to / with no line, and it and its chats leave the lists. */
function leaveProject(id: string) {
  leaving.add(id);
  leaveRemoved(id, state.chats.filter((c) => c.projectId === id).map((c) => c.id));
  patch({ projects: state.projects.filter((p) => p.id !== id), chats: state.chats.filter((c) => c.projectId !== id) });
}

/** Row 99: the project table changed, or a removal ended (its chats' `gone` came before): the list again. */
function projectsChanged() {
  if (leaving.size) {
    leaving.clear();
    patch({ chats: chatsFromRows(rows) });
  }
  void loadProjects();
}

const BASH_REPLY: Record<string, AppSettings["bashReply"]> = { "follow-cli": "follow", always: "always", never: "never" };

/** The server's settings over this device's own (the look comes from the server once it answers). */
function settingsFrom(server: Record<string, unknown>, device: AppSettings): AppSettings {
  const n = (k: string, d: number) => (typeof server[k] === "number" ? (server[k] as number) : d);
  const b = (k: string, d: boolean) => (typeof server[k] === "boolean" ? (server[k] as boolean) : d);
  const look = server["appearance.look"];
  const folder = server["uploads.folder"];
  return {
    ...device,
    look: lookOf(look) ?? device.look,
    liveChats: n("chats.maxLive", DEFAULT_SETTINGS.liveChats),
    idleMinutes: n("chats.keepIdleMinutes", DEFAULT_SETTINGS.idleMinutes),
    allowBypass: b("chats.allowBypass", DEFAULT_SETTINGS.allowBypass),
    nameChats: b("chats.generateTitles", DEFAULT_SETTINGS.nameChats),
    bashReply: BASH_REPLY[String(server["chats.bashReply"])] ?? DEFAULT_SETTINGS.bashReply,
    newChats: server["chats.newChats"] === "defaults" ? "defaults" : "last",
    sessionsFromOtherApps: b("chats.sessionsFromOtherApps", DEFAULT_SETTINGS.sessionsFromOtherApps),
    sessionsOpenElsewhere: b("chats.sessionsOpenElsewhere", DEFAULT_SETTINGS.sessionsOpenElsewhere),
    uploadFolder: folder === "temp" || folder === "state" || folder === "claude" || folder === "custom" ? folder : DEFAULT_SETTINGS.uploadFolder,
    customFolder: typeof server["uploads.customFolder"] === "string" ? (server["uploads.customFolder"] as string) : "",
    maxUploadMB: n("uploads.maxMB", DEFAULT_SETTINGS.maxUploadMB),
    keepDays: n("uploads.keepDays", DEFAULT_SETTINGS.keepDays),
  };
}

/** The server's key for each of the page's settings that kitespan keeps on the host (4.4). */
const SERVER_KEYS: Partial<Record<keyof AppSettings, string>> = {
  look: "appearance.look",
  liveChats: "chats.maxLive",
  idleMinutes: "chats.keepIdleMinutes",
  allowBypass: "chats.allowBypass",
  nameChats: "chats.generateTitles",
  bashReply: "chats.bashReply",
  newChats: "chats.newChats",
  sessionsFromOtherApps: "chats.sessionsFromOtherApps",
  sessionsOpenElsewhere: "chats.sessionsOpenElsewhere",
  uploadFolder: "uploads.folder",
  customFolder: "uploads.customFolder",
  maxUploadMB: "uploads.maxMB",
  keepDays: "uploads.keepDays",
};

function serverValue(key: keyof AppSettings, value: unknown): unknown {
  if (key === "bashReply") return value === "follow" ? "follow-cli" : value;
  if (key === "customFolder") return value === "" ? null : value;
  return value;
}

/**
 * Row 77: the two settings that filter the session lists, as the last settings reply had them (null before the first),
 * so a reply that changes either one, from this page's save or from another page's, reads the lists again.
 */
let listFilter: string | null = null;

function takeSettingsReply(r: SettingsReply & { account?: { provider: string | null } | null }) {
  const settings = settingsFrom(r.settings, state.settings);
  saveDeviceSettings(settings);
  // A save's reply reads no project, so it has no agent settings: the last ones read stay, and the start facts kept for
  // that project too (row 97).
  patch({ settings, host: r.agent === null && state.host?.agent ? { ...r, agent: state.host.agent, facts: state.host.facts ?? r.facts ?? null } : r });
  const filter = `${settings.sessionsFromOtherApps} ${settings.sessionsOpenElsewhere}`;
  if (listFilter !== null && filter !== listFilter) for (const id of Object.keys(state.sessions)) void act.loadSessions(id);
  listFilter = filter;
}

async function loadSettingsFromServer(projectId?: string): Promise<void> {
  try {
    takeSettingsReply(await apiGet<SettingsReply>(`/api/settings${projectId ? `?project=${encodeURIComponent(projectId)}` : ""}`));
  } catch {
    // the defaults stay until the next read
  }
}

/** Start the page's connection to its server: the socket, the projects and the settings (main.tsx calls it once). */
export function start(c: Connection = browserConnection()): Connection {
  if (conn) return conn;
  conn = c;
  sweepDraftCopies();
  listen(c);
  c.start();
  void loadProjects();
  void loadSettingsFromServer();
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushDrafts();
      screen.visibility();
    });
    window.addEventListener("pagehide", () => {
      flushDrafts();
      screen.hide();
    });
    window.addEventListener("pageshow", () => screen.show());
  }
  return c;
}

/** Tests only: use this connection (a fake socket) without the browser's window events. */
export function connectWith(c: Connection | null) {
  conn = c;
  if (c) listen(c);
}

function listen(c: Connection) {
  c.onStatus((s) => {
    // A socket that is not open has no on (the server forgets a closed socket's): each comes again once drawn.
    if (s !== "open") screen.lost();
    patch({ net: s });
  });
  c.onOverdue((rids) => patch({ overdue: [...rids].flatMap((r) => sentRids.get(r) ?? [r]) }));
  c.on(onFrame);
}

function onFrame(f: ServerFrame) {
  switch (f.t) {
    case "welcome": {
      if (welcomed) projectsChanged();
      welcomed = true;
      const restart = restartAfterWelcome(state.restart, f.epoch, byeForRestart);
      byeForRestart = false;
      const update = f.update.kind ?? (f.update.available ? "available" : "none");
      patch({
        server: { version: f.version, claude: f.claude, epoch: f.epoch },
        machine: machineOf(f.host),
        update,
        // Origin's line; an update that runs or ended comes right after, as the standing notice that replaces it.
        updateNotice: originNotice(update),
        // A drain notice belongs to the socket that got it: a server that still drains, or closes, sends it again after
        // hello.
        restarting: false,
        restartWait: null,
        restart,
        sideQuestions: f.capabilities?.sideQuestions === true,
        trustFolder: f.capabilities?.trustFolder === true,
      });
      // An accepted ask that this welcome did not end: the same epoch, with no bye seen (a phone that slept). Right
      // after the list, a drain that still waits sends its notice, one that closes its notice of the close, and a
      // restart that did not happen its notice that says so (which ends the ask, not done; 4.10 step 9). Once every
      // frame of the hello is in (sync's pong) with none of them, the ask was called off (Cancel restart on another
      // page): it is over, and the dialog asks again.
      if (restart?.state === "accepted" && restart.epoch === f.epoch)
        void conn?.sync().then(() => {
          if (state.restart === restart && state.server.epoch === f.epoch && !state.restartWait && !state.restarting) patch({ restart: null });
        });
      return;
    }
    case "chats": {
      // Row 78: whether another app held the open chat's session before this frame (see readAgain).
      const wasHeld = openChat !== null && !!rows.find((r) => r.chat === openChat)?.held;
      rows = applyChatsFrame(rows, f);
      const unknown = rows.some((r) => !leaving.has(r.project) && !state.projects.some((p) => p.id === r.project));
      patch({ chats: chatsFromRows(leaving.size ? rows.filter((r) => !leaving.has(r.project)) : rows), ready: true });
      if (unknown && Date.now() - projectsAsked > 2_000) void loadProjects();
      readOpenUploads();
      for (const id of [...initReads.keys()]) if (!rows.some((r) => r.chat === id)) endInitRead(id);
      if (wasHeld && openChat && rows.some((r) => r.chat === openChat && !r.held)) readAgain(openChat);
      return;
    }
    case "attached":
      onAttached(f);
      return;
    case "projects":
      if (f.removed) leaveProject(f.removed);
      else projectsChanged();
      return;
    case "snapshot": {
      const m = metaOf(f.chat);
      m.seq = f.seq;
      m.pageN = 0;
      m.seen.clear();
      m.tailLeft = f.tail ?? null;
      // No cursor yet: the tail leaves out what the history page holds, so its seqs have gaps, and a reattach from one
      // of them would replay events on top of the history drawn (the Connection counts none until replayIn).
      updateChat(f.chat, (c) => {
        // The snapshot is the chat as the server has it now. The turn and the suggestion come again from its tail (a
        // turn in flight sends its turn_start there), so a turn that ended while the page was away, or before a
        // restart, leaves no Stop behind (4.3 step 5). So do the session's facts: a chat whose Claude Code started in
        // this server life sends its `session` event there again; one that sleeps since a restart has none.
        const base = { ...c, items: [] as Item[], outputs: [] as Chat["outputs"], turn: null, suggestion: null, init: null, marks: [], changes: [] };
        // With no turn running now, a tool call in the history that has no result has ended (reduce.ts stopCalls). While
        // kitespan's own orphan finishes its turn (the finishing hold, R16), that turn still runs: its calls run on.
        const ended = c.serverState !== "running" && c.serverState !== "waiting" && c.held?.kind !== "finishing";
        const drawn = applyHistory(base, f.history, { cwd: cwdOf(c), now: Date.now(), answers: m.answers, seen: m.seen, ended }, "s");
        // A message this page sent that the server has not shown yet stays at the end.
        const keep = c.items.filter((it) => it.kind === "user" && it.local && !drawn.items.some((d) => d.id === it.id));
        return { ...drawn, items: [...drawn.items, ...keep], more: f.more, loaded: true };
      });
      // A message in it may name an upload another page made while this one was away (D50). A read in flight (the
      // open's own) is new enough.
      const known = state.uploads[f.chat] ?? NO_UPLOADS;
      if (f.history.some((e) => e.k === "user" && hasUnknownRef(e.text, known, mentionRefs(e.mentions, f.chat)))) seekUploads(f.chat, [`snapshot ${f.seq}`], true);
      // Settings' read: a snapshot at the attach's seq has no tail, so no `session` event comes.
      if (initReads.has(f.chat)) {
        if (f.seq >= m.attachedSeq) endInitRead(f.chat);
        else {
          const was = initReads.get(f.chat);
          if (was) clearTimeout(was);
          initReads.set(f.chat, setTimeout(() => endInitRead(f.chat), INIT_READ_MS));
        }
      }
      if (m.tailLeft === 0) tailIn(f.chat, m);
      afterReplay(f.chat);
      return;
    }
    case "ev": {
      const m = metaOf(f.chat);
      if (m.tailLeft !== null && f.seq <= m.attachedSeq) m.tailLeft--;
      if (f.seq > m.seq) {
        m.seq = f.seq;
        conn?.cursor(f.chat, f.seq, m.epoch);
        // U2: an event of the snapshot's tail (reduce.ts ReduceContext.tail).
        onEvent(f.chat, f.seq, f.e, f.seq <= m.attachedSeq, m.tailLeft !== null && f.seq <= m.attachedSeq);
      }
      if (m.tailLeft === 0) tailIn(f.chat, m);
      afterReplay(f.chat);
      return;
    }
    case "draft": {
      const { t: _t, chat, box, ...d } = f;
      // FIX-U2: the side chat's box's draft, under the message box's rules.
      if (box === "side") takeServerSideDraft(chat, d);
      else takeServerDraft(chat, d);
      return;
    }
    case "notice":
      onNotice(f);
      return;
    case "bye":
      // A shutdown's bye ends a Restarting line that the close's notice started (a SIGTERM during the close).
      byeForRestart = f.reason === "restart";
      patch({ restarting: byeForRestart });
      return;
    case "ack":
    case "pong":
      return;
  }
}

/** The server notice that the line shows now (its id and line), so a notice with `gone` for it takes the line away. */
let shownNotice: { id: string; text: string } | null = null;
/** This socket got `bye {reason: "restart"}` (the close's notice alone is no bye): the next welcome reads it. */
let byeForRestart = false;
/** The server life (epoch) whose notice that a restart did not happen this page showed: each hello brings it again. */
let failedShown: string | null = null;

/**
 * A server notice (4.3): one line, by the list or in its chat; a later one with the same id replaces it on every page,
 * and one with `gone` takes it away. The drain's notice, which offers Cancel restart, is also kept while it waits, and
 * the update's notice for as long as it lasts.
 */
function onNotice(f: NoticeFrame) {
  // Row 108: the update's notice lives in updateNotice only (UpdateLine draws it), so it stands while it lasts.
  if (f.id === UPDATE_NOTICE) {
    patch({ updateNotice: f.gone ? null : { text: f.text, actions: f.actions ?? [] } });
    return;
  }
  if (f.gone) {
    // The drain's notice goes only at Cancel restart (on any page): an ask of this page that waited for it is over.
    if (f.id && state.restartWait?.id === f.id) {
      const r = state.restart;
      patch({ restartWait: null, ...(r?.state === "accepted" && r.when === "finish" ? { restart: null } : {}) });
    }
    if (f.id && shownNotice?.id === f.id) {
      if (state.notice === shownNotice.text) patch({ notice: null, noticeChat: null });
      shownNotice = null;
    }
    return;
  }
  // The drain's notice lives in restartWait only (DrainLine and the restart dialog draw it), never as the screen's
  // notice too, so its line shows once on every screen (principle 0).
  if (f.id && f.actions?.includes("cancel_restart")) {
    failedShown = null;
    // Row 111: the drain takes what waits in Claude Code's queue back, and Cancel restart sends it again: a press of
    // this page no longer stands for it.
    patch({ restartWait: { id: f.id, text: f.text }, sendNowPressed: {} });
    return;
  }
  // The close (4.10 step 4): the drain's notice, or none, becomes Restarting kitespan... with no buttons, on every
  // page, as the Restarting line of each screen and the restart dialog's (never the screen's notice as well).
  if (f.id === RESTART_NOTICE) {
    failedShown = null;
    patch({ restartWait: null, restarting: true });
    return;
  }
  // S13: the restart did not happen (the successor could not start, or the health gate failed): the ask is not done,
  // and the Restarting line ends (also the one the close's notice started on a page that never got the bye). Every page
  // shows the line; the notice stands until the next restart, so a page that asked nothing shows it once.
  if (f.id === RESTART_FAILED_NOTICE) {
    const r = state.restart;
    const asked = r?.state === "accepted" || r?.state === "sending";
    patch({ restarting: false, ...(asked ? { restart: { ...r, state: "not_done" as const } } : {}) });
    if (!asked && failedShown === state.server.epoch) return;
    failedShown = state.server.epoch;
  }
  // A chat's line shows in that chat only, so another chat's is not this page's to show now.
  if (!f.chat || f.chat === openChat) {
    shownNotice = f.id ? { id: f.id, text: f.text } : null;
    patch({ notice: f.text, noticeChat: f.chat ?? null });
  }
}

/**
 * The asked restart after a `welcome`: another epoch is its end; the same epoch after the `bye` is a restart that did
 * not happen (the old server listens again, 4.10 step 5). Any other welcome (a plain reconnect) changes nothing here
 * (onFrame then checks for the drain's notice). A not-done ask that a welcome of another epoch follows did happen (a
 * reconnect inside the close read as not done).
 */
function restartAfterWelcome(r: RestartAsk | null, epoch: string, afterBye: boolean): RestartAsk | null {
  if (r?.state === "not_done" && r.epoch !== null && epoch !== r.epoch) return { ...r, state: "done" };
  if (!r || (r.state !== "accepted" && r.state !== "sending")) return r;
  if (r.epoch !== null && epoch !== r.epoch) return { ...r, state: "done" };
  return afterBye ? { ...r, state: "not_done" } : r;
}

/**
 * kitespan is restarting: from the server's notice of its close (or the `bye`) to the next `welcome`, and from this
 * page's own Restart now until the restart ends, so every screen says Restarting.
 */
export function restartingNow(s: Pick<State, "restarting" | "restart">): boolean {
  return s.restarting || (s.restart?.when === "now" && (s.restart.state === "sending" || s.restart.state === "accepted"));
}

/** Row 111: the restart holds every chat's queue back (its drain waits or its close runs): no Send now. */
export function restartHoldsQueue(s: Pick<State, "restartWait" | "restarting">): boolean {
  return s.restartWait !== null || s.restarting;
}

/**
 * Row 78: the other app closed the open chat's session, which may hold that app's turns now: those are in the
 * transcript, not in the ring, so the chat is attached again with no cursor (R4) and the server sends its newest
 * history page as a snapshot (the page draws it at once, as any snapshot) and the turn that starts with a queued
 * message after it. A chat that is not on screen reads its history when it opens (the server's own rule, R4).
 */
function readAgain(chatId: string) {
  if (!conn?.isAttached(chatId)) return;
  screen.attaching(chatId);
  conn.reattach(chatId);
}

function onAttached(f: AttachedFrame) {
  const m = metaOf(f.chat);
  if (m.epoch !== f.epoch) m.answers.clear();
  m.epoch = f.epoch;
  m.attachedSeq = f.seq;
  m.tailLeft = null;
  // Until the page holds every event up to attached.seq, what comes is a load (row 79, R6), and the chat is not on
  // screen (row 116, rule 3: also an attach that the socket sent again after a welcome).
  m.replay = f.replay;
  replayBegins(f.chat);
  screen.attaching(f.chat);
  const replay = f.replay !== "snapshot";
  const was = findChat(f.chat);
  // A replay goes on from the rows drawn: a chat with none drawn in this page life (its row left a list and came
  // back) asks for a snapshot.
  if (replay && !was?.loaded) {
    conn?.reattach(f.chat);
    return;
  }
  // R5: a replay keeps the chat's items. A card this page had open that is not open now closed while the page was
  // away: kept aside, its replayed close draws the answered record.
  if (replay) for (const k of was?.pending ?? []) if (!f.cards.some((c) => c.id === k.id)) m.seen.set(k.id, k);
  updateChat(f.chat, (c) => ({
    ...c,
    pending: f.cards.map((k) => cardOf(k, cwdOf(c))),
    picks: { ...f.picks },
    ...picksView(f.picks),
    title: f.title?.text ?? c.title,
    titleSource: f.title ? ({ renamed: "rename", generated: "generated", "first-prompt": "first-prompt" } as const)[f.title.from] : c.titleSource,
    archived: f.archived,
    serverState: f.state,
    state: listState(f.state, c.unseen),
    // R127: the server's answers for this chat's refused folders now; the replayed events that follow go on from it.
    trust: attachedTrust(f.trust),
    // R131: its background sessions' states now, the same way.
    background: attachedBackground(f.background),
  }));
  // Settings' read takes no draft: the box is not on screen, and a pending copy goes out when the chat opens. On a
  // replay of a chat whose facts the page has, the read is over (R7).
  if (initReads.has(f.chat)) {
    if (replay && was?.init) endInitRead(f.chat);
  } else {
    // The draft: a pending copy whose rev is still the server's wins and goes out at once (7.5).
    const copy = readCopy(storage(), f.chat);
    const typed = !!copy && copyWins(copy, f.draft);
    if (typed) {
      const st = syncOf(f.chat);
      st.server = f.draft;
      st.dirty = true;
      const { rev: _rev, at: _at, ...fields } = copy!;
      putDraft(f.chat, fields);
      sendDraft(f.chat);
    } else {
      if (copy) storage()?.removeItem(DRAFT_COPY_KEY + f.chat);
      takeServerDraft(f.chat, f.draft, true);
    }
    m.sentCheck = { rev: f.draft.rev, typed };
    if (f.sideDraft) attachSideDraft(f.chat, f.sideDraft);
  }
  // R5: a replay with nothing missed, or one whose events the page holds already, is in now.
  if (replay) afterReplay(f.chat);
  // R124: while the side chat is open, each attach reads its thread again (a restart, another page's changes while
  // this socket was away).
  if (sideViews.has(f.chat)) readSide(f.chat);
}

/**
 * The snapshot's tail is in (R1). It leaves out what the history page holds, so the events up to `attached.seq` are
 * drawn: the cursor goes there (afterReplay tells the Connection), and a reattach's `since` never names an event that
 * the page drew from history.
 */
function tailIn(_chatId: string, m: ChatMeta) {
  m.tailLeft = null;
  if (m.seq < m.attachedSeq) m.seq = m.attachedSeq;
}

/**
 * The replay of the last attach is in (its snapshot and its tail, or the missed events, up to `attached.seq`): the
 * load ends (R6), so does Settings' read of a replay (R7), and the sent copies are decided.
 */
function afterReplay(chatId: string) {
  const m = metaOf(chatId);
  if (m.seq < m.attachedSeq || (m.tailLeft !== null && m.tailLeft > 0)) return;
  if (m.replay !== null) {
    const path = m.replay;
    m.replay = null;
    // A snapshot and its whole tail are in: from here the chat's cursor counts (R1).
    if (path === "snapshot") conn?.replayIn(chatId, m.seq, m.epoch);
    replayEnds(chatId);
    // Row 116, rule 3: the chat's newest history is drawn, so a chat on screen at its end says on now (also again on a
    // new socket: the server forgets an `on` with its socket).
    screen.drawn(chatId);
    // A replay holds the chat's `session` event only when its Claude Code started after the page's cursor.
    if (path !== "snapshot") endInitRead(chatId);
  }
  if (!m.sentCheck) return;
  const check = m.sentCheck;
  m.sentCheck = null;
  restoreSent(chatId, check);
}

function onEvent(chatId: string, seq: number, e: ChatEvent, replay: boolean, tail = false) {
  // R124: the side thread's events change the side chat only, never the transcript.
  if (isSideEvent(e)) {
    setThread(chatId, (t) => applySideEvent(t, e));
    return;
  }
  if (e.k === "toast") {
    if (!replay) act.showToast({ key: e.key, text: e.text, priority: e.priority, timeoutMs: e.timeoutMs, chatId });
    return;
  }
  const m = metaOf(chatId);
  // This page's Take back of the message went through: the next draft by this tab is the message coming back.
  if (e.k === "taken_back") for (const p of syncs.get(chatId)?.putBacks ?? []) if (p.uuid === e.uuid) p.armed = true;
  if (e.k === "user") {
    restoredRan(chatId, e.uuid);
    if (hasUnknownRef(e.text, state.uploads[chatId] ?? NO_UPLOADS, mentionRefs(e.mentions, chatId))) seekUploads(chatId, [`message ${e.uuid}`]);
  }
  updateChat(chatId, (c) => applyEvent(c, e, { seq, replay, tail, cwd: cwdOf(c), now: Date.now(), answers: m.answers, interrupted: m.interrupted, seen: m.seen }));
  if (e.k === "turn_end" || e.k === "card_close") {
    const wait = state.takeBackWait;
    if (wait?.chatId === chatId && !findChat(chatId)?.items.some((i) => i.id === wait.messageId && i.kind === "user" && i.queued)) patch({ takeBackWait: null });
  }
  if (e.k === "session") endInitRead(chatId);
}

// ---- drafts

function draftFrame(chatId: string): DraftEditFrame {
  const d = fieldsOf(chatId);
  return { t: "draft", chat: chatId, ...draftToWire(d), uploads: d.uploads.slice(0, LIMITS.draftUploads), ...mentionsKey(d.mentions) };
}

function writeCopy(chatId: string) {
  const st = syncOf(chatId);
  const copy: DraftCopy = { ...fieldsOf(chatId), rev: st.server?.rev ?? 0, at: Date.now() };
  writeJson(storage(), DRAFT_COPY_KEY + chatId, copy);
}

function sendDraft(chatId: string) {
  const st = syncOf(chatId);
  if (st.timer) clearTimeout(st.timer);
  st.timer = null;
  if (!st.dirty && st.lastSentKey !== null) return;
  st.dirty = false;
  const frame = draftFrame(chatId);
  st.lastSentKey = draftKey(frame);
  st.lastSentAt = Date.now();
  writeCopy(chatId);
  conn?.draft(frame);
}

/**
 * A change in the message box: kept now, sent 250 ms after the last change. `typed` false: the page changed the box
 * itself (Take back's switch to a message), which is no input, so the box is not being typed in for it.
 */
function changedDraft(chatId: string, atOnce: boolean, typed = true) {
  const st = syncOf(chatId);
  if (typed) st.typedAt = Date.now();
  st.dirty = true;
  writeCopy(chatId);
  if (st.timer) clearTimeout(st.timer);
  st.timer = null;
  if (atOnce) sendDraft(chatId);
  else st.timer = setTimeout(() => sendDraft(chatId), DRAFT_WRITE_MS);
}

function showServerDraft(chatId: string, d: DraftState) {
  syncOf(chatId).shownRev = d.rev;
  putDraft(chatId, wireToDraft(d));
}

function takeServerDraft(chatId: string, d: DraftState, fromAttach = false) {
  const st = syncOf(chatId);
  if (st.server && d.rev < st.server.rev && !fromAttach) return;
  st.server = d;
  // A chip another page added: its name and path come from the chat's list, read again (the open reads it at attach).
  if (d.uploads.length) seekUploads(chatId, d.uploads, fromAttach);
  // A held draft that is older than the server's newest is not the server's draft any more: it never shows.
  if (st.held && st.held.d.rev < d.rev) st.held = null;
  const mine = d.by === conn?.tab;
  // The answer to this page's own Take back: it shows at once, also while the box is being typed in (6.3). It may
  // have the fields of this page's last save (the message's own text, saved before Send), so it is read first.
  const armed = mine ? st.putBacks.findIndex((p) => p.armed) : -1;
  if (armed >= 0) {
    const [back] = st.putBacks.splice(armed, 1);
    showPutBack(chatId, d, back!.base);
    return;
  }
  const own = mine && st.lastSentKey === draftKey(d);
  if (own) {
    st.shownRev = d.rev;
    // This page's save came back: the pending copy can go when nothing newer waits.
    if (!st.dirty) storage()?.removeItem(DRAFT_COPY_KEY + chatId);
    return;
  }
  const decision = fromAttach && !st.dirty ? "show" : draftDecision({ own: false, typedAt: st.typedAt, composing: st.composing, linkUnchanged: false, now: Date.now() });
  if (decision === "show") {
    st.held = null;
    st.lastSentKey = null;
    showServerDraft(chatId, d);
    return;
  }
  st.held = { d, at: Date.now() };
  if (st.holdTimer) clearTimeout(st.holdTimer);
  st.holdTimer = setTimeout(() => releaseHeld(chatId), TYPING_MS);
}

/** The message part of a put-back draft: the server joined the message and the box's text `base` with a line break. */
function putBackHead(text: string, base: string): string {
  if (base === "") return text;
  if (text === base) return "";
  return text.endsWith(`\n${base}`) ? text.slice(0, text.length - base.length - 1) : text;
}

/**
 * This page's Take back came back as the server's draft: the message, on its own line before what the box held
 * (`base`, when the take_back went). It becomes the box's draft at once. Text typed since the take_back went, which
 * the server did not have, stays after the message and is saved at once; else nothing is sent.
 */
function showPutBack(chatId: string, d: DraftState, base: string) {
  const st = syncOf(chatId);
  st.held = null;
  const box = fieldsOf(chatId);
  // The server had the box's newer text already when a later save reached it first.
  const merged = box.text !== "" && (d.text === box.text || d.text.endsWith(`\n${box.text}`));
  const typedSince = box.mode === "chat" && box.text !== base && !merged;
  if (!typedSince) {
    if (st.timer) clearTimeout(st.timer);
    st.timer = null;
    st.dirty = false;
    st.lastSentKey = null;
    storage()?.removeItem(DRAFT_COPY_KEY + chatId);
    showServerDraft(chatId, d);
    return;
  }
  const head = putBackHead(d.text, base);
  const text = capText(head === "" ? box.text : box.text === "" ? head : `${head}\n${box.text}`, LIMITS.draftText);
  st.shownRev = d.rev;
  const back = wireToDraft(d);
  const uploads = [...new Set([...d.uploads, ...box.uploads])].slice(0, LIMITS.draftUploads);
  putDraft(chatId, withMentions({ ...back, text, uploads }, joinMentions(back, box)));
  st.dirty = true;
  sendDraft(chatId);
}

function releaseHeld(chatId: string) {
  const st = syncOf(chatId);
  st.holdTimer = null;
  const held = st.held;
  if (!held) return;
  if (Date.now() - st.typedAt < TYPING_MS || st.composing) {
    st.holdTimer = setTimeout(() => releaseHeld(chatId), TYPING_MS);
    return;
  }
  st.held = null;
  // This page saved after the held draft came: its own save is newer and wins on every page.
  if (st.dirty || st.lastSentAt > held.at) return;
  showServerDraft(chatId, held.d);
}

/** Send every draft that waits for its 250 ms now (blur, a chat switch, a hidden page). */
export function flushDrafts() {
  for (const [chatId, st] of syncs) if (st.dirty) sendDraft(chatId);
  for (const [chatId, st] of sideSyncs) if (st.dirty) sendSideDraft(chatId);
}

/**
 * Send or Run (4.3, 7.5): the box's text leaves the box at once, so it is in one place (the transcript; a `!` command
 * shows when the server runs it) and a second press, or one after a remount, has nothing to send. Nothing of it may go
 * out as a draft after it: its waiting save and its pending copy go (a send is not a save, and a copy with the sent
 * text at the server's `rev` would win on the next attach and put a message or a command that already ran back in the
 * box on every page, D49, F2). Until the ack, local storage keeps its draft under the request's id instead (SentCopy),
 * which a reload before the ack puts back in the box (restoreSent). `back`: the draft a refusal gives back.
 */
function sentDraft(chatId: string, id: string, back: ChatDraft) {
  const st = syncOf(chatId);
  if (st.timer) clearTimeout(st.timer);
  st.timer = null;
  st.dirty = false;
  st.held = null;
  conn?.dropDraft(chatId);
  const kv = storage();
  kv?.removeItem(DRAFT_COPY_KEY + chatId);
  writeSent(kv, chatId, [...readSent(kv, chatId), { ...back, uploads: [...back.uploads], id, tab: conn?.tab ?? "", rev: st.server?.rev ?? 0, at: Date.now() }]);
  inFlight.add(id);
  putDraft(chatId, { ...EMPTY_DRAFT, uploads: [] }, {
    takeBackWait: state.takeBackWait?.chatId === chatId ? null : state.takeBackWait,
    bringBackWait: state.bringBackWait?.chatId === chatId ? null : state.bringBackWait,
    outgoing: { ...state.outgoing, [chatId]: [...(state.outgoing[chatId] ?? []), id] },
  });
}

/** The ack of a send or a `!` command came (ok or not): its wait and its sent copy end (`id` as sentDraft's). */
function sentDone(chatId: string, id: string) {
  inFlight.delete(id);
  const kv = storage();
  writeSent(kv, chatId, readSent(kv, chatId).filter((c) => c.id !== id));
  const { [chatId]: was = [], ...rest } = state.outgoing;
  const left = was.filter((x) => x !== id);
  patch({ outgoing: left.length ? { ...rest, [chatId]: left } : rest });
}

/**
 * A draft that never reached Claude Code, put back in the box whose draft is `box`: into an empty box as it was (its
 * mode, chip, link mark and chips); a message before the box's own message text, on its own line, as the server's Take
 * back does (6.3). A command cannot join other text: null.
 */
function joinBack(d: ChatDraft, box: ChatDraft): ChatDraft | null {
  if (isEmptyDraft(box) && !box.link) return d;
  if (d.mode !== "chat" || box.mode !== "chat") return null;
  const text = capText(d.text && box.text ? `${d.text}\n${box.text}` : d.text || box.text, LIMITS.draftText);
  const uploads = [...new Set([...d.uploads, ...box.uploads])].slice(0, LIMITS.draftUploads);
  return { mode: "chat", command: null, text, link: box.link && box.text !== "", uploads, ...mentionsKey(joinMentions(d, box)) };
}

/**
 * After a reload (or any attach), once its replay is in: each sent copy of this tab's earlier page life (this one's
 * are still in the outbox; another tab's are that tab's) is decided and goes. One went through when the chat's
 * history holds its id (a message, a `!` row) or when the chat's draft is past the `rev` it was typed on (the server's
 * clear, or another page's typing since); else it never arrived, and its draft goes back to the box (joinBack): in
 * place of the server's draft at that rev, which the send would have replaced, or before text typed after the press (a
 * pending copy that won, `typed`). Then it is saved as the user's own (sent at once, with a pending copy), as a pending
 * copy that wins is (7.5).
 */
function restoreSent(chatId: string, check: { rev: number; typed: boolean }) {
  const kv = storage();
  const all = readSent(kv, chatId);
  const mine = (c: SentCopy) => c.tab === conn?.tab && !inFlight.has(c.id);
  const old = all.filter(mine);
  if (!old.length) return;
  writeSent(kv, chatId, all.filter((c) => !mine(c)));
  const ids = new Set((findChat(chatId)?.items ?? []).map((i) => i.id));
  const back = old.filter((c) => c.rev === check.rev && !ids.has(c.id));
  if (!back.length) return;
  const box = fieldsOf(chatId);
  let d: ChatDraft = check.typed ? box : { ...EMPTY_DRAFT, uploads: [] };
  for (const c of [...back].reverse()) {
    const { id, tab: _tab, rev: _rev, at: _at, ...fields } = c;
    d = joinBack(fields, d) ?? d;
    // A message (not a `!` command, whose row the server knows by its rid alone) keeps its uuid for its next Send.
    if (fields.mode !== "bash") restoredSends.set(chatId, [...(restoredSends.get(chatId) ?? []), { uuid: id, text: outgoingOf(fields), uploads: [...fields.uploads], mentions: [...mentionsIn(fields)] }]);
  }
  if (draftKey(d) === draftKey(box)) return;
  putDraft(chatId, d);
  changedDraft(chatId, true, false);
}

/**
 * The draft that a refused send or `!` command puts back: the one the composer names, else the box's own when it is
 * what went out (its mode, chip, link and chips as they were), else the text in the request's own mode. A message
 * that starts with "!" goes back in chat mode with no link mark, as the server's Take back gives it: its mode keeps it
 * a message on every page.
 */
function sentDraftOf(chatId: string, kind: "send" | "bash", text: string, box: DraftInput | undefined, chips: Pick<ChatDraft, "uploads" | "mentions">): ChatDraft {
  const uploads = [...chips.uploads];
  const mentions = mentionsIn(chips);
  if (box) return cleanDraft({ ...box, link: box.link ?? false, uploads, mentions });
  const held = fieldsOf(chatId);
  if ((held.mode === "bash") === (kind === "bash") && outgoingOf(held) === text) return withMentions({ ...held, uploads }, mentions);
  return cleanDraft({ mode: kind === "bash" ? "bash" : "chat", command: null, text, link: false, uploads, mentions });
}

/**
 * A refused send or `!` command: its draft goes back to the box (joinBack): as it was into an empty box, with its own
 * mode (a link's text keeps its mark), a message before text typed since. It is saved as the user's own (sent at once;
 * the pending copy keeps it until the server confirms the save).
 */
function giveBack(chatId: string, d: ChatDraft) {
  const box = fieldsOf(chatId);
  const next = joinBack(d, box);
  if (!next || draftKey(next) === draftKey(box)) return;
  putDraft(chatId, next);
  changedDraft(chatId, true);
}

// ---- requests

/** The requests a chat list row offers (D48, Rename): refused for a chat that is not open, the line is the list's. */
const LIST_REQUESTS: ReadonlySet<string> = new Set(["archive", "delete", "rename"]);

/** The project a request is about: its own (`new_chat`, `continue_session`), or its chat's. */
function projectOfFrame(frame: RequestFrame): string | null {
  if ("project" in frame && typeof frame.project === "string") return frame.project;
  return "chat" in frame ? (findChat(frame.chat)?.projectId ?? null) : null;
}

/** Where a refused request's line shows (State.noticeChat): its chat's screen, or by the list. */
function noticePlace(frame: RequestFrame): string | null {
  const chat = "chat" in frame ? frame.chat : null;
  if (!chat) return null;
  return LIST_REQUESTS.has(frame.t) && chat !== openChat ? null : chat;
}

/**
 * One request frame; a refused one shows its fixed line. Resolves with the ack, or null with no connection. A send
 * refused because another app holds the session (`session_held`, row 78) shows none: the server holds the chat before
 * it answers, so the box shows its own line with the app's name by then. Nor does a refused start of row 73 (W4, W5):
 * the server puts its line, with its buttons, in the chat before it answers.
 */
async function request(frame: RequestFrame, onFail?: (ack: Extract<AckFrame, { ok: false }>) => void): Promise<AckFrame | null> {
  if (!conn) return null;
  const ack = await conn.request(frame);
  if (!ack.ok) {
    onFail?.(ack);
    // A start that kitespan's check or Claude Code refused (W4, W5) has its own line in the chat, with its buttons. A
    // worktree that could not be made says why when the ack names the reason (F5).
    if (ack.error.code !== "session_held" && !isStartCode(ack.error.code)) patch({ notice: refusalLine(ack.error), noticeChat: noticePlace(frame), noticeFor: { code: ack.error.code, project: projectOfFrame(frame) } });
  }
  return ack;
}

/** act.newChat's frame and, once the chat exists, its uploads moved from the form's key to the chat. */
async function sendNewChat(input: { projectId: string; model?: string; effort?: string; mode?: ModeId; text: string; sessionId?: string; mentions?: readonly string[] }): Promise<string | null> {
  const key = input.sessionId ? newChatUploadsKey(input.sessionId) : null;
  const uploads = key ? (state.uploads[key] ?? []).filter((u) => u.state === "done").map((u) => u.id) : [];
  const picks = {
    model: input.model && input.model !== "default" ? input.model : null,
    effort: input.effort && isEffort(input.effort) ? input.effort : null,
    mode: (input.mode ?? null) as WireModeId | null,
  };
  const ack = await request({ t: "new_chat", rid: newUuid(), project: input.projectId, uuid: newUuid(), text: input.text, picks, uploads, ...mentionsKey(input.mentions, LIMITS.sendMentions) });
  if (!ack?.ok) return null;
  const chat = (ack.result as { chat: string }).chat;
  if (key && state.uploads[key]) {
    const moved = state.uploads[key]!.map((u) => ({ ...u, chatId: chat }));
    const { [key]: _form, ...rest } = state.uploads;
    patch({ uploads: { ...rest, [chat]: moved } });
  }
  return chat;
}

/**
 * R127: what a press of the confirm's Trust this folder came to: the server's answer for the folder, or the refusal's
 * code (and `reason` for `trust_refused`), which the confirm words itself (chat/trust.ts trustRefusalLine).
 */
export type TrustPress = { ok: true; trust: TrustState } | { ok: false; code: string; reason: string | null };
/** The folders whose `trust_folder` this page sent and waits for, by `<chat> <path>`: a second press sends nothing. */
const trustOut = new Set<string>();

/**
 * R131: what a press of the Stop confirm's Stop came to: Claude Code's answer (stopped, not_found, failed), or the
 * refusal's code, which the confirm words itself (chat/background.ts stopLine).
 */
export type BgStopPress = { ok: true; answer: BgStopAnswer } | { ok: false; code: string };
/** The sessions whose `background_stop` this page sent and waits for, by `<chat> <id>`: a second press sends nothing. */
const bgStopOut = new Set<string>();

/** True for an ok ack: the route that sent the request may close (a refused one keeps it, with its line). */
const okOf = (p: Promise<AckFrame | null>): Promise<boolean> => p.then((ack) => ack?.ok === true);

// ---- the side chat (R124, rows 124 and 125)

/** The chats whose side chat is on screen, with how many views show it (a reload of it reads again on each attach). */
const sideViews = new Map<string, number>();

function setThread(chatId: string, f: (t: SideThread) => SideThread) {
  const was = state.side[chatId] ?? EMPTY_THREAD;
  const next = f(was);
  if (next !== was) patch({ side: { ...state.side, [chatId]: next } });
}

/**
 * The side frames (DESIGN-R124 section 9). Their acks never show the chat's notice line: the side chat shows its own
 * failure line, and a refused start's line is in the chat already (the server puts it there). An `unsupported` ack
 * says the chat's agent answers no side question: the page hides every way in.
 */
type SideFrame = SideQuestionFrame | SideStopFrame | SideClearFrame | { t: "get"; rid: string; chat: string; what: "side" };
async function sideRequest(frame: SideFrame): Promise<AckFrame | null> {
  if (!conn) return null;
  const ack = await conn.request(frame);
  if (!ack.ok && ack.error.code === "unsupported" && state.sideQuestions) patch({ sideQuestions: false });
  return ack;
}

/** `get side` (a read: it never starts a sleeping chat); the events that come meanwhile wait for it. */
function readSide(chatId: string) {
  if (!conn) return;
  setThread(chatId, beginRead);
  void sideRequest({ t: "get", rid: newUuid(), chat: chatId, what: "side" }).then((ack) => {
    const r = ack?.ok ? (ack.result as Partial<SideRead> | null) : null;
    if (r && typeof r.rev === "number" && Array.isArray(r.exchanges)) {
      const read: SideRead = { rev: r.rev, exchanges: r.exchanges };
      setThread(chatId, (t) => takeRead(t, read));
    } else setThread(chatId, readFailed);
  });
}

/**
 * How an ask ended, for the box that asked: its answer, a Stop, a failure, `busy`: another side question runs in the
 * chat (one at a time), so nothing was asked and the box gets its question back, or `refused`: the server refused it
 * before it stored anything (a restart's drain, a hold), so only this page shows its failure, and the side box gets
 * the question back too (FIX-U2).
 */
export type SideAskEnd = "answered" | "stopped" | "failed" | "busy" | "refused";

// ---- the side box's draft (FIX-U2 section 2; D49): the server holds it per chat (`box: "side"` on the `draft`
// frame, `attached.sideDraft`), and the page keeps the message box's rules for it: the server's draft shows unless the
// box is being typed in (draftDecision); the user's typing is kept at once and saved DRAFT_WRITE_MS after the last
// change, at once on flushDrafts, with a pending copy until the server has it; Send empties the box and names the rev
// it showed. Plain text: no mode, chip, upload or mention. A link's fill is the box's own until the user edits it
// (SideChat.tsx): it is never saved by itself.

/** + the chat id: the side box's pending copy, text the server has not confirmed (DRAFT_COPY_KEY's rule). */
export const SIDE_COPY_KEY = "kitespan.sidedraft.";

/** The side box's text, and whether it came from a link and has not been sent or cleared (5.1 rule 7). */
export interface SideBoxDraft {
  text: string;
  link: boolean;
}
export const EMPTY_SIDE_BOX: Readonly<SideBoxDraft> = Object.freeze({ text: "", link: false });

/** A chat's side box, for a selector: `useStore((s) => sideBoxOf(s, chatId))` (EMPTY_SIDE_BOX when it has none). */
export function sideBoxOf(s: Pick<State, "sideDraft">, chatId: string): SideBoxDraft {
  return s.sideDraft[chatId] ?? EMPTY_SIDE_BOX;
}

/** One chat's side box against the server's side draft: the message box's DraftSync, less its chips and Take back. */
interface SideSync {
  /** The newest side draft the server sent. */
  server: DraftState | null;
  /** The rev of the side draft the box last showed: what a Send names (draftRev). */
  shownRev: number | null;
  /** A server side draft that waits for the typing to stop. */
  held: { d: DraftState; at: number } | null;
  typedAt: number;
  composing: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  holdTimer: ReturnType<typeof setTimeout> | null;
  /** A change that is not sent yet. */
  dirty: boolean;
  lastSentKey: string | null;
  lastSentAt: number;
}
const sideSyncs = new Map<string, SideSync>();
function sideSyncOf(chatId: string): SideSync {
  let s = sideSyncs.get(chatId);
  if (!s) sideSyncs.set(chatId, (s = { server: null, shownRev: null, held: null, typedAt: 0, composing: false, timer: null, holdTimer: null, dirty: false, lastSentKey: null, lastSentAt: 0 }));
  return s;
}
const sideKey = (d: SideBoxDraft) => JSON.stringify([d.text, d.link]);

function putSideBox(chatId: string, d: SideBoxDraft) {
  const { [chatId]: _was, ...rest } = state.sideDraft;
  patch({ sideDraft: d.text === "" ? rest : { ...rest, [chatId]: { text: d.text, link: d.link } } });
}

/** The side box's pending copy: its text and link mark, the server's rev it was typed on, and when. */
interface SideCopy extends SideBoxDraft {
  rev: number;
  at: number;
}
function readSideCopy(kv: KeyValueStore | null, chatId: string, now = Date.now()): SideCopy | null {
  const v = readJson(kv, SIDE_COPY_KEY + chatId) as Partial<SideCopy> | null;
  if (!v || typeof v.text !== "string" || typeof v.link !== "boolean" || typeof v.rev !== "number" || typeof v.at !== "number" || now - v.at >= DRAFT_LIFE_MS) return null;
  return { text: v.text, link: v.link, rev: v.rev, at: v.at };
}
function writeSideCopy(chatId: string) {
  writeJson(storage(), SIDE_COPY_KEY + chatId, { ...sideBoxOf(state, chatId), rev: sideSyncOf(chatId).server?.rev ?? 0, at: Date.now() } satisfies SideCopy);
}
function dropSideCopy(chatId: string) {
  try {
    storage()?.removeItem(SIDE_COPY_KEY + chatId);
  } catch {} // blocked storage
}

function sendSideDraft(chatId: string) {
  const st = sideSyncOf(chatId);
  if (st.timer) clearTimeout(st.timer);
  st.timer = null;
  if (!st.dirty && st.lastSentKey !== null) return;
  st.dirty = false;
  const d = sideBoxOf(state, chatId);
  st.lastSentKey = sideKey(d);
  st.lastSentAt = Date.now();
  writeSideCopy(chatId);
  conn?.draft({ t: "draft", chat: chatId, box: "side", text: d.text, mode: "chat", command: null, link: d.link, uploads: [] });
}

/** A change in the side box: kept now, sent 250 ms after the last change, or at once. `typed` false: no input. */
function changedSideDraft(chatId: string, atOnce: boolean, typed = true) {
  const st = sideSyncOf(chatId);
  if (typed) st.typedAt = Date.now();
  st.dirty = true;
  writeSideCopy(chatId);
  if (st.timer) clearTimeout(st.timer);
  st.timer = atOnce ? null : setTimeout(() => sendSideDraft(chatId), DRAFT_WRITE_MS);
  if (atOnce) sendSideDraft(chatId);
}

function showServerSideDraft(chatId: string, d: DraftState) {
  sideSyncOf(chatId).shownRev = d.rev;
  putSideBox(chatId, { text: d.text, link: d.link });
}

/** The server's side draft (a `draft` frame, or `attached`): it shows unless the side box is being typed in. */
function takeServerSideDraft(chatId: string, d: DraftState, fromAttach = false) {
  const st = sideSyncOf(chatId);
  if (st.server && d.rev < st.server.rev && !fromAttach) return;
  st.server = d;
  // A held draft that is older than the server's newest is not the server's draft any more: it never shows.
  if (st.held && st.held.d.rev < d.rev) st.held = null;
  if (d.by === conn?.tab && st.lastSentKey === sideKey(d)) {
    // This page's save came back: the pending copy can go when nothing newer waits.
    st.shownRev = d.rev;
    if (!st.dirty) dropSideCopy(chatId);
    return;
  }
  const decision = fromAttach && !st.dirty ? "show" : draftDecision({ own: false, typedAt: st.typedAt, composing: st.composing, linkUnchanged: false, now: Date.now() });
  if (decision === "show") {
    st.held = null;
    st.lastSentKey = null;
    showServerSideDraft(chatId, d);
    return;
  }
  st.held = { d, at: Date.now() };
  if (st.holdTimer) clearTimeout(st.holdTimer);
  st.holdTimer = setTimeout(() => releaseSideHeld(chatId), TYPING_MS);
}

function releaseSideHeld(chatId: string) {
  const st = sideSyncOf(chatId);
  st.holdTimer = null;
  const held = st.held;
  if (!held) return;
  if (Date.now() - st.typedAt < TYPING_MS || st.composing) {
    st.holdTimer = setTimeout(() => releaseSideHeld(chatId), TYPING_MS);
    return;
  }
  st.held = null;
  // This page saved after the held draft came: its own save is newer and wins on every page.
  if (st.dirty || st.lastSentAt > held.at) return;
  showServerSideDraft(chatId, held.d);
}

/** At attach: a pending side copy on the server's rev that says something else wins, and goes out at once. */
function attachSideDraft(chatId: string, d: DraftState) {
  const copy = readSideCopy(storage(), chatId);
  if (copy && copy.rev === d.rev && sideKey(copy) !== sideKey(d)) {
    const st = sideSyncOf(chatId);
    st.server = d;
    st.dirty = true;
    putSideBox(chatId, { text: copy.text, link: copy.link });
    sendSideDraft(chatId);
    return;
  }
  if (copy) dropSideCopy(chatId);
  takeServerSideDraft(chatId, d, true);
}

/** The side box's Send: its text leaves the box at once, and no save of it goes out after it (the server clears it). */
function sentSideDraft(chatId: string) {
  const st = sideSyncOf(chatId);
  if (st.timer) clearTimeout(st.timer);
  st.timer = null;
  st.dirty = false;
  st.held = null;
  conn?.dropDraft(chatId, "side");
  dropSideCopy(chatId);
  putSideBox(chatId, EMPTY_SIDE_BOX);
}

/** A side question that was not asked (busy, refused, stopped) goes back into an empty side box, saved at once. */
function sideBack(chatId: string, text: string) {
  if (sideBoxOf(state, chatId).text.trim() !== "") return;
  putSideBox(chatId, { text, link: false });
  changedSideDraft(chatId, true, false);
}

/** A side question (`side_question`); `draftRev` only from the side box (act.sideSend): the server clears its draft. */
function askSide(chatId: string, text: string, id: string, draftRev?: number | null): Promise<SideAskEnd> {
  // One side question per chat at a time: while another one asks, the server would answer `busy`.
  const running = askingOf(state.side[chatId] ?? EMPTY_THREAD);
  if (running && running.id !== id) return Promise.resolve("busy");
  setThread(chatId, (t) => localAsk(t, id, text, new Date().toISOString()));
  const fromBox = draftRev === undefined ? {} : { draftRev };
  return sideRequest({ t: "side_question", rid: newUuid(), chat: chatId, id, text, ...fromBox }).then((ack) => {
    if (!ack) {
      setThread(chatId, (t) => settleAsk(t, id, { error: "failed" }));
      return "failed";
    }
    if (!ack.ok) {
      // Still this page's own copy: the server stored nothing of it (an ask it stored fails by its own event).
      const local = !!(state.side[chatId] ?? EMPTY_THREAD).exchanges.find((x) => x.id === id)?.local;
      setThread(chatId, (t) => settleAsk(t, id, { error: ack.error.code }));
      return ack.error.code === "busy" ? "busy" : local ? "refused" : "failed";
    }
    const r = ack.result as Partial<{ answered: SideExchange; stopped: true }> | null;
    if (r?.answered) {
      const x = r.answered;
      setThread(chatId, (t) => settleAsk(t, id, { answered: x }));
      return x.state === "answered" ? "answered" : "failed";
    }
    setThread(chatId, (t) => settleAsk(t, id, { stopped: true }));
    return "stopped";
  });
}

/** Row 111: a press stands no more (its request, or the send it went with, was refused): Send now comes back. */
function dropPress(chatId: string, press: SendNowPress) {
  if (state.sendNowPressed[chatId] !== press) return;
  const { [chatId]: _gone, ...rest } = state.sendNowPressed;
  patch({ sendNowPressed: rest });
}

/**
 * Row 111: one `send_now` on `uuid` for the messages `ids` that wait. Send now goes from them at the press (a second
 * press has nothing to press) and stays away after the server's answer, whatever it did: it moved the work to the
 * background or stopped the turn, and the messages' own events then draw them as sent, or nothing was left to do.
 */
function pressNow(chatId: string, uuid: string, ids: readonly string[]): SendNowPress {
  const press: SendNowPress = { turn: findChat(chatId)?.turn ?? null, ids };
  patch({ sendNowPressed: { ...state.sendNowPressed, [chatId]: press } });
  void request({ t: "send_now", rid: newUuid(), chat: chatId, uuid }).then((ack) => {
    if (!ack?.ok) dropPress(chatId, press);
  });
  return press;
}

function apiFailed(e: unknown): string {
  return e instanceof ApiError ? e.message : "That did not work.";
}

/** S18: the line of an upload whose connection the restart's stop cut (the page got `bye` first). */
export const UPLOAD_CUT_LINE = "The restart stopped the upload. Try again.";

/** An upload's failure line: UPLOAD_CUT_LINE for a lost connection while kitespan restarts, else the failure's own. */
export function uploadFailedLine(e: unknown, restarting: boolean): string {
  return restarting && e instanceof ApiError && e.code === "network" ? UPLOAD_CUT_LINE : apiFailed(e);
}

function contextOf(c: WireContext | null): ContextInfo {
  if (!c) return { usedPct: 0, usedTokens: 0, windowTokens: 0, parts: [] };
  return { usedPct: Math.round(c.percent), usedTokens: c.usedTokens, windowTokens: c.maxTokens, parts: c.parts.filter((p) => p.kind === "used").map((p) => ({ label: p.name, tokens: p.tokens })) };
}

function connectorOf(c: ConnectorInfo): Connector {
  const status = c.status === "disabled" ? "failed" : c.status;
  return { name: c.name, status, tools: c.tools, source: c.scope ?? "" };
}

function uploadOf(u: UploadView): Upload {
  const dir = u.path.slice(0, Math.max(0, u.path.lastIndexOf("/")));
  return { id: u.id, chatId: u.chat ?? "", name: u.name, size: u.size, type: u.type, path: u.path, ...(u.was ? { was: u.was } : {}), folder: state.settings.uploadFolder, dir, at: "", state: "done", progress: 1 };
}

function setUploads(key: string, f: (list: Upload[]) => Upload[]) {
  const next = f(state.uploads[key] ?? []);
  const { [key]: _old, ...rest } = state.uploads;
  patch({ uploads: next.length ? { ...rest, [key]: next } : rest });
}

let tempN = 0;

/** Upload each file (POST /api/uploads with its progress); a done upload's chip joins the draft (D50). */
function addUploads(key: string, target: { chat?: string; project?: string }, files: readonly FileFacts[], onDone: (u: Upload) => void): Upload[] {
  const { settings } = state;
  const made: Upload[] = files.map((f) => {
    const id = `up-pending-${++tempN}`;
    const base: Upload = { id, chatId: target.chat ?? "", name: f.name || "pasted", size: f.size, type: f.type, path: "", folder: settings.uploadFolder, dir: "", at: new Date().toISOString(), state: "uploading", progress: 0 };
    if (!f.file) return { ...base, state: "failed", error: "That file could not be read." };
    if (f.size > settings.maxUploadMB * MB) return { ...base, state: "failed", error: tooLargeLine(settings.maxUploadMB) };
    return base;
  });
  setUploads(key, (list) => [...list, ...made]);
  made.forEach((u, i) => {
    const f = files[i]!;
    if (u.state !== "uploading" || !f.file) return;
    const move = (p: Partial<Upload>) => setUploads(key, (list) => list.map((x) => (x.id === u.id ? { ...x, ...p } : x)));
    const job = uploadBytes<UploadReply>(target, f.file, f.name, f.type, (progress) => move({ progress }));
    job.done.then(
      (r) => {
        const done = uploadOf(r.upload);
        setUploads(key, (list) => list.map((x) => (x.id === u.id ? done : x)));
        onDone(done);
      },
      (e) => move({ state: "failed", error: uploadFailedLine(e, state.restarting) }),
    );
  });
  return made;
}

async function loadUploads(chatId: string): Promise<void> {
  try {
    const r = await apiGet<UploadsReply>(`/api/chats/${chatId}/uploads`);
    setUploads(chatId, (list) => {
      const fromServer = r.uploads.map((u) => uploadOf(u));
      const local = list.filter((u) => u.state !== "done" && !fromServer.some((s) => s.id === u.id));
      return [...fromServer, ...local];
    });
  } catch {
    // the list stays as it was
  }
}

const PLAN_MODE: Record<Exclude<PlanAnswer, "keep-planning">, "auto" | "acceptEdits" | "bypassPermissions" | "default"> = {
  auto: "auto",
  "accept-edits": "acceptEdits",
  bypass: "bypassPermissions",
  manual: "default",
};

function answer(chatId: string, card: string, a: CardAnswer, as: AnsweredAs) {
  metaOf(chatId).answers.set(card, as);
  void request({ t: "answer", rid: newUuid(), chat: chatId, card, answer: a }, () => metaOf(chatId).answers.delete(card));
}

const isEffort = (v: string): v is EffortId => EFFORTS.some((e) => e.id === v);

/** The reads in flight (act.load), by chat and what. */
const reading = new Map<string, Promise<void>>();
/** The new-chat form's reads of a project's commands in flight (act.loadProjectCommands), by project. */
const commandReads = new Map<string, Promise<ProjectCommandsReply | null>>();
/** The newest read of each project's session list (act.loadSessions), by project: only that one lands. */
const sessionReads = new Map<string, number>();
/** Row 81: the read of Claude Code's model list in flight (act.loadModels); one at a time, for every project. */
let modelRead: Promise<ModelInfo[] | null> | null = null;

/** A model list as the route answers it (server/http/api-types.ts ProjectModelsReply): rows of another shape are left out. */
function modelListOf(r: unknown): ModelInfo[] {
  const list = (r as { models?: unknown } | null)?.models;
  if (!Array.isArray(list)) return [];
  return list.filter((m): m is ModelInfo => {
    const x = m as Partial<ModelInfo> | null;
    return !!x && typeof x.value === "string" && typeof x.displayName === "string" && typeof x.description === "string" && Array.isArray(x.efforts) && typeof x.supportsAutoMode === "boolean";
  });
}

/** A project's commands as the contract says (FIX-W19d 4): anything else reads as no list yet. */
function projectCommandsOf(r: unknown): ProjectCommandsReply {
  const v = (r ?? {}) as { commands?: unknown; at?: unknown };
  const commands = Array.isArray(v.commands) ? (v.commands as CommandInfo[]) : [];
  return { commands, at: typeof v.at === "string" && Array.isArray(v.commands) ? v.at : null };
}

async function loadNow(chatId: string, what: Exclude<GetWhat, "history">): Promise<void> {
  if (!conn) return;
  const ack = await conn.request({ t: "get", rid: newUuid(), chat: chatId, what });
  if (!ack.ok) return;
  const r = ack.result;
  updateChat(chatId, (c) => {
    if (what === "context") return { ...c, context: contextOf(r as WireContext | null) };
    if (what === "connectors") return { ...c, connectorInfo: r as ConnectorInfo[], connectors: (r as ConnectorInfo[]).map(connectorOf) };
    if (what === "commands") return { ...c, commands: r as CommandInfo[] };
    return { ...c, models: r as ModelInfo[] };
  });
  // Row 81: a chat's model rows are Claude Code's list, the same in every chat: the form and the project page use it.
  if (what === "models" && Array.isArray(r) && r.length > 0) patch({ modelList: r as ModelInfo[] });
}

export const act = {
  /**
   * R124: the side chat of `chatId` shows (`on`) or goes. While it shows, its thread is read now and after each attach
   * of the chat. A read only.
   */
  sideView(chatId: string, on: boolean) {
    const n = sideViews.get(chatId) ?? 0;
    if (on) {
      sideViews.set(chatId, n + 1);
      readSide(chatId);
    } else if (n <= 1) sideViews.delete(chatId);
    else sideViews.set(chatId, n - 1);
  },
  /**
   * R124: a side question (`side_question`), only from the user's own Send, Enter or Try again (which sends the same
   * `id`). It shows at once as asking; the ack brings the answer, a Stop, or a failure.
   */
  sideAsk(chatId: string, text: string, id: string = newUuid()): Promise<SideAskEnd> {
    return askSide(chatId, text, id);
  },
  /**
   * FIX-U2: Send in the side box: its text leaves the box at once, and the question names the side draft's rev that
   * the box showed, so the server clears that draft on every page. A busy or refused question goes back into the box.
   */
  sideSend(chatId: string, text: string): Promise<SideAskEnd> {
    const draftRev = sideSyncOf(chatId).shownRev;
    sentSideDraft(chatId);
    return askSide(chatId, text, newUuid(), draftRev).then((end) => {
      if (end === "busy" || end === "refused") sideBack(chatId, text);
      return end;
    });
  },
  /** FIX-U2: the user's own input in the side box: kept now, saved on the server 250 ms after the last change. */
  setSideDraft(chatId: string, d: SideBoxDraft) {
    const next = { text: d.text, link: d.link && d.text !== "" };
    const was = sideBoxOf(state, chatId);
    if (next.text === was.text && next.link === was.link) return;
    putSideBox(chatId, next);
    changedSideDraft(chatId, false);
  },
  /** FIX-U2: an input method composes in the side box: a side draft from the server waits until it ends. */
  setSideComposing(chatId: string, on: boolean) {
    sideSyncOf(chatId).composing = on;
  },
  /** FIX-U2: a side question that was not asked (a Stop, a busy ask) goes back into the side box when it is empty. */
  sideBack(chatId: string, text: string) {
    sideBack(chatId, text);
  },
  /** R124 Stop on the running side question (`side_stop`): true when it stopped it (false: it had already ended). */
  sideStop(chatId: string, id: string): Promise<boolean> {
    return sideRequest({ t: "side_stop", rid: newUuid(), chat: chatId, id }).then((ack) => {
      const stopped = !!ack?.ok && (ack.result as { stopped?: boolean } | null)?.stopped === true;
      if (stopped) setThread(chatId, (t) => settleAsk(t, id, { stopped: true }));
      return stopped;
    });
  },
  /** R124 Clear (`side_clear`): the thread empties on every page by its event. */
  sideClear(chatId: string): Promise<boolean> {
    return okOf(sideRequest({ t: "side_clear", rid: newUuid(), chat: chatId }));
  },
  /**
   * Row 116: whether the chat's view shows its conversation's end on a drawn chat (net/onScreen.ts rules 2 to 4); the
   * seen report adds the page's visibility and sends `on_screen` at each change. `false` with `leave` when the view goes.
   */
  onScreen(chatId: string, shows: boolean, leave = false) {
    if (leave) screen.leave(chatId);
    else screen.view(chatId, shows);
  },
  /**
   * The chat on screen (App calls it on every route change): attach it and detach the one before. It reads only:
   * `attach` and `detach` change nothing on the server.
   */
  open(chatId: string | null) {
    if (chatId === openChat) return;
    const was = openChat;
    openChat = chatId;
    if (was) {
      flushDrafts();
      conn?.detach(was);
    }
    if (chatId && conn) {
      endInitRead(chatId, false);
      const m = metaOf(chatId);
      // Row 116, rule 3: what the page drew of the chat earlier in its life is not this attach's history.
      screen.attaching(chatId);
      conn.attach(chatId, m.seq, m.epoch);
    }
    readOpenUploads();
  },
  /** A read for a side panel or a picker (`get`, 4.3): it never starts a sleeping chat. */
  load(chatId: string, what: Exclude<GetWhat, "history">): Promise<void> {
    // Two parts of the page that read the same thing at once (the Context card and the context ring) share one get.
    const key = `${chatId} ${what}`;
    const was = reading.get(key);
    if (was) return was;
    const p = loadNow(chatId, what).finally(() => reading.delete(key));
    reading.set(key, p);
    return p;
  },
  /**
   * The next older page of history, above the oldest one drawn (4.3 step 7). True when a page came; false with no page
   * left, no socket, or a refused read (U5: a /m/ link reads pages until its row is there, chat/older.ts).
   */
  async loadOlder(chatId: string): Promise<boolean> {
    const chat = findChat(chatId);
    if (!conn || !chat?.more) return false;
    const ack = await conn.request({ t: "get", rid: newUuid(), chat: chatId, what: "history", before: chat.more });
    if (!ack.ok) return false;
    const page = ack.result as { history: ChatEvent[]; more: string | null };
    const m = metaOf(chatId);
    updateChat(chatId, (c) => {
      // Every turn of an older page has ended; its closed cards leave their records (their open and close are in it).
      const ctx = { cwd: cwdOf(c), now: Date.now(), answers: m.answers, seen: new Map<string, Card>(), ended: true };
      const older = applyHistory({ ...c, items: [] as Item[], outputs: [] as Chat["outputs"], marks: [], changes: [] }, page.history, ctx, `p${++m.pageN}-`);
      const have = new Set(c.items.map((i) => i.id));
      // U2: the older page's turn marks go before the chat's own, as its rows do.
      // U1: and its changes notes before the chat's own.
      return { ...c, items: [...older.items.filter((i) => !have.has(i.id)), ...c.items], marks: [...(older.marks ?? []), ...(c.marks ?? [])], changes: mergeChanges(older.changes, c.changes), more: page.more };
    });
    return true;
  },
  /**
   * Settings again, for a project's own Claude Code settings when `projectId` is given, and a live chat's init facts
   * (readInitFacts): those of `chatId`, the chat the user came from, when it is given.
   */
  refreshSettings(projectId?: string, chatId?: string) {
    void loadSettingsFromServer(projectId);
    readInitFacts(chatId);
  },
  /**
   * The new-chat form's `/` menu (D59): the project's commands (GET /api/projects/:project/commands), a read that the
   * form makes when it shows the project and once more about 3 s later while the server has none yet (at null). Two
   * asks at once share one read; a failed read keeps what the page had and resolves null.
   */
  loadProjectCommands(projectId: string): Promise<ProjectCommandsReply | null> {
    const was = commandReads.get(projectId);
    if (was) return was;
    // With the sender header: only the page's own read may start the server's short read (W19d).
    const p = apiGet<unknown>(`/api/projects/${encodeURIComponent(projectId)}/commands`, undefined, true)
      .then(
        (r) => {
          const reply = projectCommandsOf(r);
          patch({ projectCommands: { ...state.projectCommands, [projectId]: reply } });
          return reply;
        },
        () => null,
      )
      .finally(() => {
        if (commandReads.get(projectId) === p) commandReads.delete(projectId);
      });
    commandReads.set(projectId, p);
    return p;
  },
  /**
   * Row 81: Claude Code's model list for the new-chat form and the project page (GET /api/projects/:project/models):
   * the server's kept list, or with none kept the answer of its one short read, which the server makes for this
   * project's folder. One read at a time; a list with rows replaces the page's, and an empty or failed read keeps it.
   */
  loadModels(projectId: string): Promise<ModelInfo[] | null> {
    if (modelRead) return modelRead;
    // With the sender header: only the page's own read may start the server's short read (as the / menu's, W19d).
    const p: Promise<ModelInfo[] | null> = apiGet<unknown>(`/api/projects/${encodeURIComponent(projectId)}/models`, undefined, true)
      .then(
        (r) => {
          const list = modelListOf(r);
          if (list.length > 0) patch({ modelList: list });
          return list;
        },
        () => null,
      )
      .finally(() => {
        if (modelRead === p) modelRead = null;
      });
    modelRead = p;
    return p;
  },
  /**
   * From the terminal (6.9): the project's sessions that no chat has, as the server's Settings > Chats filter them, and
   * what that filter left out (row 77). Only the newest read of a project lands, so a read made before a settings
   * change never overwrites one made after it.
   */
  async loadSessions(projectId: string): Promise<SessionView[]> {
    const n = (sessionReads.get(projectId) ?? 0) + 1;
    sessionReads.set(projectId, n);
    try {
      const r = await apiGet<SessionsReply>(`/api/projects/${projectId}/sessions`);
      if (sessionReads.get(projectId) !== n) return r.sessions;
      const hidden: SessionsHidden = { all: r.hidden === "all", open: Array.isArray(r.hiddenOpen) ? r.hiddenOpen.filter((id) => typeof id === "string") : [] };
      patch({ sessions: { ...state.sessions, [projectId]: r.sessions }, sessionsHidden: { ...state.sessionsHidden, [projectId]: hidden } });
      return r.sessions;
    } catch {
      return [];
    }
  },

  /**
   * Send a message (`send`). The box empties at once (sentDraft). `box`: the box's draft as it was sent, which a
   * refusal puts back as it was; without it, the store's own draft when it is what went out, else the text as a
   * message. Resolves true on the server's ok ack; false when it refused (its line shows, and the draft comes back).
   * `now` (row 111, Ctrl+Enter while a turn runs): Send now follows at once, on this message, queued behind the others;
   * the server reads it after the send (4.3).
   */
  send(chatId: string, text: string, box?: DraftInput, now = false): Promise<boolean> {
    const chat = findChat(chatId);
    const rid = newUuid();
    const chips = fieldsOf(chatId);
    const uploads = [...chips.uploads];
    const back = sentDraftOf(chatId, "send", text, box, chips);
    // A message that a reload put back (restoreSent), sent as it was: its own uuid, so an old copy still on its way runs
    // it once (the server's uuid check). Any other message is new: its uuid is its rid.
    const again = takeRestored(chatId, text, uploads, mentionsIn(chips));
    const uuid = again?.uuid ?? rid;
    // The draft the box showed, never a newer one held while this page typed: that one stays on the server.
    const draftRev = syncOf(chatId).shownRev;
    // The message shows at once, last: whatever waits is ahead of it on the server. The server's `user` event replaces
    // it (with the uploads' references, D50) where the server has it (reduce.ts). A `!` command that runs or waits
    // holds the message behind it on the server, and a queued message (one Not sent too, R13) goes first, so the chat
    // is busy then too (6.3).
    const busy =
      !!chat &&
      (chat.turn !== null ||
        chat.pending.length > 0 ||
        chat.serverState === "running" ||
        chat.serverState === "waiting" ||
        chat.items.some((i) => (i.kind === "bash" && (i.running || i.queued)) || (i.kind === "user" && i.queued)));
    const item: Item = { kind: "user", id: uuid, text, queued: busy || undefined, local: true };
    const waiting = now && chat && chat.turn !== null && !chat.held && !restartHoldsQueue(state) ? queuedIds(chat) : null;
    updateChat(chatId, (c) => ({ ...c, items: [...c.items.filter((i) => i.id !== uuid), item] }));
    sentDraft(chatId, uuid, back);
    if (uuid !== rid) sentRids.set(rid, [uuid]);
    // The mention chips (9.3): the server checks each in the chat's folder and adds its absolute path's reference
    // (shared/protocol.ts messageRef).
    const sending = request({ t: "send", rid, chat: chatId, uuid, text, draftRev, uploads, ...mentionsKey(chips.mentions, LIMITS.sendMentions) });
    const press = waiting ? pressNow(chatId, uuid, [...waiting, uuid]) : null;
    return sending.then((ack) => {
      sentDone(chatId, uuid);
      sentRids.delete(rid);
      if (ack?.ok) return true;
      if (press) dropPress(chatId, press);
      if (again) restoredSends.set(chatId, [...(restoredSends.get(chatId) ?? []), again]);
      updateChat(chatId, (c) => ({ ...c, items: c.items.filter((i) => i.id !== uuid) }));
      giveBack(chatId, back);
      return false;
    });
  },
  /**
   * A `!` command (D10). While Claude works it waits, marked Queued, and runs after the turn (6.3). A refused one
   * (no Claude Code, an archived chat, a restart) gives the command back to the box in Bash mode, with its chips, as
   * a refused send does (`box` and the promise as for send).
   */
  bash(chatId: string, command: string, box?: DraftInput): Promise<boolean> {
    const chips = fieldsOf(chatId);
    const uploads = [...chips.uploads];
    const back = sentDraftOf(chatId, "bash", command, box, chips);
    const draftRev = syncOf(chatId).shownRev;
    const rid = newUuid();
    sentDraft(chatId, rid, back);
    return request({ t: "bash", rid, chat: chatId, input: command, draftRev, uploads, ...mentionsKey(chips.mentions, LIMITS.sendMentions) }).then((ack) => {
      sentDone(chatId, rid);
      if (!ack?.ok) giveBack(chatId, back);
      return !!ack?.ok;
    });
  },
  answerPermission(chatId: string, requestId: string, answer_: "once" | "session" | "deny", denyNote?: string) {
    const a: CardAnswer = answer_ === "deny" ? { kind: "permission", allow: false, message: denyNote ?? "" } : { kind: "permission", allow: true, scope: answer_ };
    answer(chatId, requestId, a, { kind: "permission", answer: answer_, note: denyNote });
  },
  answerQuestion(chatId: string, requestId: string, answers: Record<string, string>) {
    answer(chatId, requestId, { kind: "question", answers }, { kind: "question", answers });
  },
  answerPlan(chatId: string, requestId: string, answer_: PlanAnswer, feedback = "") {
    const a: CardAnswer = answer_ === "keep-planning" ? { kind: "plan", approve: false, feedback } : { kind: "plan", approve: true, mode: PLAN_MODE[answer_] };
    answer(chatId, requestId, a, { kind: "plan", answer: answer_, ...(answer_ === "keep-planning" && feedback.trim() ? { note: feedback.trim() } : {}) });
  },
  answerElicitation(chatId: string, requestId: string, action: "accept" | "decline" | "cancel", values: Record<string, string | boolean | number> = {}) {
    const a: CardAnswer = action === "accept" ? { kind: "elicitation", action, content: values } : { kind: "elicitation", action };
    answer(chatId, requestId, a, { kind: "elicitation", action });
  },
  answerDialog(chatId: string, requestId: string, choice: string) {
    const a: CardAnswer = choice === "cancelled" ? { kind: "dialog", behavior: "cancelled" } : { kind: "dialog", behavior: "completed", result: choice };
    answer(chatId, requestId, a, { kind: "dialog", choice });
  },
  /**
   * Take back a queued message (`take_back`): the server puts its text back in the draft (D49). While the box holds a
   * command nothing is sent: the message stays queued and takeBackWait names it (6.3). A message in the box, also one
   * that starts with "!", is no command. An empty `!` or `/` box becomes an empty message first, since the server
   * takes a message back into a message only. The draft that answers it shows at once (showPutBack).
   */
  takeBack(chatId: string, messageId: string) {
    const msg = findChat(chatId)?.items.find((i) => i.id === messageId);
    if (!msg || msg.kind !== "user" || !msg.queued) return;
    const box = fieldsOf(chatId);
    if (isCommandDraft(box)) {
      patch({ takeBackWait: { chatId, messageId } });
      return;
    }
    if (box.mode !== "chat") {
      putDraft(chatId, { ...EMPTY_DRAFT, uploads: [...box.uploads], ...mentionsKey(box.mentions) });
      changedDraft(chatId, true, false);
    }
    flushDrafts();
    const rid = newUuid();
    const st = syncOf(chatId);
    st.putBacks.push({ rid, uuid: messageId, base: fieldsOf(chatId).text, armed: false });
    void request({ t: "take_back", rid, chat: chatId, uuid: messageId }).then(() => {
      st.putBacks = st.putBacks.filter((p) => p.rid !== rid);
    });
  },
  /**
   * R130 Bring back: a side answer goes into the message box's draft as a quote after the box's text (side/bring.ts),
   * the user's own change of the server-held draft (D49), so it is saved at once: one `draft` frame, and it never
   * sends. While the box holds a command nothing changes and bringBackWait names the chat (its line shows above the
   * composer until the box holds no command); over the draft's cap nothing changes and the chat's notice says so. An
   * archived or held chat has no box to take it (row 80). An empty `!` or `/` box becomes a message with the quote.
   */
  bringBack(chatId: string, answer: string): "brought" | "command" | "long" | "none" {
    const chat = findChat(chatId);
    if (!chat || chat.archived || chat.held) return "none";
    const box = fieldsOf(chatId);
    const r = bringInto(box, answer, isCommandDraft(box));
    if (!r.ok) {
      if (r.why === "command") patch({ bringBackWait: { chatId } });
      else if (r.why === "long") act.setNotice(BRING_TOO_LONG, chatId);
      return r.why === "empty" ? "none" : r.why;
    }
    putDraft(chatId, r.draft, state.bringBackWait?.chatId === chatId ? { bringBackWait: null } : {});
    // The page put the text in the box itself, which is no typing: a draft from another page shows as usual.
    changedDraft(chatId, true, false);
    return "brought";
  },
  /**
   * Row 111 Send now (`send_now`, DESIGN.md 6.3): every message of the chat that waits in Claude Code's queue reaches
   * Claude now; the server moves a foreground Bash call or subagent to the background, or stops the turn so that they
   * run next. Only from the user's own press, on the message under which Send now shows (`messageId`; by default that
   * one: Ctrl+Enter with an empty box). With none, nothing is sent.
   */
  sendNow(chatId: string, messageId?: string) {
    const chat = findChat(chatId);
    const target = chat ? sendNowTarget(chat, state.sendNowPressed[chatId], restartHoldsQueue(state)) : null;
    if (!chat || !target || (messageId !== undefined && messageId !== target)) return;
    const standing = state.sendNowPressed[chatId];
    const before = pressStands(chat, standing) ? standing.ids : [];
    pressNow(chatId, target, [...new Set([...before, ...queuedIds(chat)])]);
  },
  /**
   * RD-8 Send again (`send_queued`): the chat starts for the messages that waited when the server stopped (Not sent),
   * which go first and in order; their next events clear the mark. A refusal shows its line. One at a time: until its
   * ack, its messages are this page's outgoing ones (drawn as not sent yet while the socket is down or the ack is
   * overdue, with the chat's Reconnecting... line) and Send again is off.
   */
  sendQueued(chatId: string) {
    if (state.sendAgainOut.includes(chatId)) return;
    const rid = newUuid();
    const ids = [rid, ...(findChat(chatId)?.items ?? []).filter((i) => i.kind === "user" && i.notSent).map((i) => i.id)];
    sentRids.set(rid, ids);
    patch({ sendAgainOut: [...state.sendAgainOut, chatId], outgoing: { ...state.outgoing, [chatId]: [...(state.outgoing[chatId] ?? []), ...ids] } });
    void request({ t: "send_queued", rid, chat: chatId }).then(() => {
      sentRids.delete(rid);
      const { [chatId]: was = [], ...rest } = state.outgoing;
      const left = was.filter((x) => !ids.includes(x));
      patch({ sendAgainOut: state.sendAgainOut.filter((c) => c !== chatId), outgoing: left.length ? { ...rest, [chatId]: left } : rest });
    });
  },
  /**
   * S16 End it here and copy (`end_here`), after the click copied the plain command: the chat's Claude Code ends at its
   * first quiet moment, and the chat is held as handed to the terminal. True on the ok ack (a refusal shows its line).
   */
  endHere(chatId: string): Promise<boolean> {
    return okOf(request({ t: "end_here", rid: newUuid(), chat: chatId }));
  },
  /**
   * Row 73, the buttons under a refused start's line (`worktree`, W4 and W5): Make it again from its branch (`again`),
   * Continue in the project folder (`project`), and Try again or Continue without the worktree (`start`). Each acts
   * only on its own click. On the ok ack the line keeps its words and loses its buttons here (another page's go when the
   * chat's Claude Code starts, and a press there gets `stale`). True on the ok ack (a refusal shows its line).
   */
  async worktreeAct(chatId: string, what: WorktreeAct): Promise<boolean> {
    const ack = await request({ t: "worktree", rid: newUuid(), chat: chatId, act: what });
    if (!ack?.ok) return false;
    updateChat(chatId, (c) => {
      const items = settledStarts(c.items);
      return items ? { ...c, items } : c;
    });
    return true;
  },
  /** Run in background on a running Bash row or a subagent block (`background`). */
  runInBackground(chatId: string, toolUseId: string) {
    void request({ t: "background", rid: newUuid(), chat: chatId, toolUse: toolUseId });
  },
  /**
   * R127: the confirm's Trust this folder (`trust_folder`), sent on the user's own press only: the server starts Claude
   * Code briefly in that folder with the trust attestation, and Claude Code records the trust itself. One request per
   * press: a press while this page's request for that folder waits sends nothing (null, as with no connection). Resolves
   * with the answer (trusted, already, not_recorded, failed or gone), which every page's line shows, or with a refusal's
   * code and reason, which the confirm shows itself (no notice line above the composer).
   */
  async trustFolder(chatId: string, toolUse: string, path: string): Promise<TrustPress | null> {
    const key = `${chatId} ${path}`;
    if (!conn || trustOut.has(key)) return null;
    trustOut.add(key);
    try {
      const ack = await conn.request({ t: "trust_folder", rid: newUuid(), chat: chatId, toolUse, path });
      if (ack.ok) {
        const st = (ack.result as { trust?: unknown } | null)?.trust;
        if (!isTrustState(st)) return { ok: false, code: "failed", reason: null };
        updateChat(chatId, (c) => ({ ...c, trust: withTrust(c.trust, path, st) }));
        return { ok: true, trust: st };
      }
      if (ack.error.code === "unsupported" && state.trustFolder) patch({ trustFolder: false });
      return { ok: false, code: ack.error.code, reason: ackTrustReason(ack.error) };
    } finally {
      trustOut.delete(key);
    }
  },
  /**
   * R131: the Stop confirm's Stop (`background_stop`), sent on the user's own press only: the server checks the chat's
   * book and runs `claude stop <id>`. One request per press: a press while this page's request for that session waits
   * sends nothing (null, as with no connection). Resolves with Claude Code's answer, which the state shows on every page
   * (the server's event), or with a refusal's code, which the confirm shows itself (no notice line above the composer).
   */
  async stopBackground(chatId: string, id: string): Promise<BgStopPress | null> {
    const key = `${chatId} ${id}`;
    if (!conn || bgStopOut.has(key)) return null;
    bgStopOut.add(key);
    try {
      const ack = await conn.request({ t: "background_stop", rid: newUuid(), chat: chatId, id });
      if (!ack.ok) return { ok: false, code: ack.error.code };
      const answer = (ack.result as { background?: unknown } | null)?.background;
      return (STOP_ANSWERS as readonly unknown[]).includes(answer) ? { ok: true, answer: answer as BgStopAnswer } : { ok: false, code: "failed" };
    } finally {
      bgStopOut.delete(key);
    }
  },
  /**
   * R131: whether a background session's view is on screen (mounted, its session's state drawn); the seen report adds
   * the page's visibility and the chat's drawn attach, and sends `on_screen` with the session's id at each change. A
   * completed or failed session that a page views is seen, as R116's chat at its end. `leave` when the view goes.
   */
  bgOnScreen(chatId: string, id: string, shows: boolean, leave = false) {
    if (leave) screen.bgLeave(chatId, id);
    else screen.bgView(chatId, id, shows);
  },
  /** A per-task Stop (`stop_task`) on a subagent or workflow block: it names the block's task. */
  stopTask(chatId: string, toolUseId: string) {
    const find = (items: readonly Item[]): string | undefined => {
      for (const it of items) {
        if ((it.kind === "agent" || it.kind === "workflow") && it.id === toolUseId) return it.taskId;
        if (it.kind === "agent") {
          const hit = find(it.rows);
          if (hit) return hit;
        }
      }
      return undefined;
    };
    const task = find(findChat(chatId)?.items ?? []);
    if (!task) return;
    void request({ t: "stop_task", rid: newUuid(), chat: chatId, task });
  },
  /**
   * Continue here on a session preview (`continue_session`): resolves with the chat, a new one or the one that has it.
   * `fork` (D58): Continue in a copy, for a session that another app has open (the preview's button, and the held
   * chat's line, row 78, where the server opens the copy that the lists hold, or makes one). A refusal resolves null,
   * its line shows, and `onRefused` gets its code (`session_open`: another app opened the session after the page read
   * it, W19d).
   */
  async continueSession(projectId: string, sessionId: string, fork = false, onRefused?: (code: ErrorCode) => void): Promise<string | null> {
    const ack = await request({ t: "continue_session", rid: newUuid(), project: projectId, session: sessionId, ...(fork ? { fork: true } : {}) }, (a) => onRefused?.(a.error.code));
    return ack?.ok ? (ack.result as { chat: string }).chat : null;
  },
  /** Forget a project's remembered picks (POST /api/projects/:project/forget). */
  forgetPicks(projectId: string) {
    void apiSend<ProjectReply>("POST", `/api/projects/${projectId}/forget`).then(
      (r) => patch({ projects: state.projects.map((p) => (p.id === projectId ? projectOf(r.project) : p)) }),
      (e) => patch({ notice: apiFailed(e), noticeChat: null }),
    );
  },
  /**
   * Row 99, Rename's Save (POST /api/projects/:project/rename): resolves true on the server's ok, with the new name in
   * the lists at once (every other page reads it on the `projects` frame); false when it refused (its line shows).
   */
  renameProject(projectId: string, name: string): Promise<boolean> {
    return apiSend<ProjectReply>("POST", `/api/projects/${projectId}/rename`, { name }).then(
      (r) => {
        patch({ projects: state.projects.map((p) => (p.id === projectId ? { ...p, name: r.project.name } : p)) });
        return true;
      },
      (e) => {
        patch({ notice: apiFailed(e), noticeChat: null });
        return false;
      },
    );
  },
  /**
   * Row 99, Move up, Move down and a heading's drop (POST /api/projects/:project/move, one request): the page's order
   * at once, then the server's answer; a refusal shows its line and reads the list again.
   */
  moveProject(projectId: string, before: string | null) {
    const gen = ++projectsGen;
    takeProjects(reordered(state.projects, projectId, before));
    void apiSend<ProjectsReply>("POST", `/api/projects/${projectId}/move`, { before }).then(
      (r) => {
        if (gen === projectsGen) takeProjects(r.projects.map(projectOf));
      },
      (e) => {
        patch({ notice: apiFailed(e), noticeChat: null });
        void loadProjects();
      },
    );
  },
  /**
   * Row 99, Remove's named button (POST /api/projects/:project/remove): true once the environment and its chats left
   * kitespan; false when the server refused (a chat there works or needs input), with its line.
   */
  removeProject(projectId: string): Promise<boolean> {
    return apiSend<RemovedProjectReply>("POST", `/api/projects/${projectId}/remove`).then(
      () => true,
      (e) => {
        patch({ notice: apiFailed(e), noticeChat: null });
        return false;
      },
    );
  },
  /** Settings > Chats > Remembered choices > Clear: forget the remembered picks of every project that has some. */
  clearRemembered() {
    for (const p of state.projects) if (Object.keys(p.picks).length) act.forgetPicks(p.id);
  },
  /**
   * New environment's Use this folder (D54): a project for an absolute folder on the host, or one typed from the home
   * folder as `~/...`, which the server reads (POST /api/projects). Resolves with its id (an existing project's when
   * the folder is one), or with the line that says why not. Call it only in a click, tap or key handler.
   */
  async addFolder(folder: string, opts: { worktree?: boolean } = {}): Promise<{ id: string } | { line: string }> {
    const clean = cleanFolder(folder);
    if (!clean) return { line: /^(\/|~\/)/.test(folder.trim()) ? FOLDER_REFUSED : FOLDER_NOT_FULL };
    try {
      // Row 73: New environment's Worktree checkbox, sent only when it is on (off is every project's default).
      const r = await apiSend<ProjectReply>("POST", "/api/projects", { cwd: clean, ...(opts.worktree ? { worktree: true } : {}) });
      const p = projectOf(r.project);
      // A new environment is first in the sidebar, in the last used order and in the user's own (row 99).
      takeProjects(state.projects.some((x) => x.id === p.id) ? state.projects.map((x) => (x.id === p.id ? p : x)) : [p, ...state.projects]);
      return { id: p.id };
    } catch (e) {
      return { line: apiFailed(e) };
    }
  },
  /**
   * Row 73: the project's Worktree option (POST /api/projects/:project/worktree). Resolves true on the server's ok, or
   * with the line that says why not. Call it only in a click, tap or key handler.
   */
  async setWorktree(projectId: string, on: boolean): Promise<true | { line: string }> {
    try {
      const r = await apiSend<ProjectReply>("POST", `/api/projects/${projectId}/worktree`, { on });
      const p = projectOf(r.project);
      takeProjects(state.projects.map((x) => (x.id === p.id ? p : x)));
      return true;
    } catch (e) {
      return { line: apiFailed(e) };
    }
  },
  /**
   * D60: the count of a project's variables after a read or a save (the project page's and the chat's summary), and
   * whether its file could be read (L39: the project page's cell says so until a read or a save says otherwise).
   */
  tookEnvCount(projectId: string, count: number, unreadable = false) {
    const p = state.projects.find((x) => x.id === projectId);
    if (!p || ((p.env ?? 0) === count && (p.envUnreadable ?? false) === unreadable)) return;
    patch({ projects: state.projects.map((x) => (x.id === projectId ? { ...x, env: count, envUnreadable: unreadable } : x)) });
  },
  /** The model picker (`set_model`): "default" is back to the user's default (null). */
  setModel(chatId: string, model: string) {
    void request({ t: "set_model", rid: newUuid(), chat: chatId, value: model === "default" ? null : model });
  },
  setEffort(chatId: string, effort: string) {
    void request({ t: "set_effort", rid: newUuid(), chat: chatId, value: isEffort(effort) ? effort : null });
  },
  setMode(chatId: string, mode: ModeId) {
    void request({ t: "set_mode", rid: newUuid(), chat: chatId, value: mode as WireModeId });
  },
  /**
   * Stop (`interrupt` of the running turn): open cards are dismissed, the queue stays (6.3). Resolves true on the ok
   * ack, or at once when no turn runs (nothing to stop); false when the server refused (its line shows).
   */
  stop(chatId: string): Promise<boolean> {
    const c = findChat(chatId);
    // R16: a chat that kitespan's own orphan holds has no turn of this server; Stop (turn 0) ends that process.
    if (!c?.turn && c?.held?.kind === "finishing") return okOf(request({ t: "interrupt", rid: newUuid(), chat: chatId, turn: 0 }));
    const turn = c?.turn;
    if (turn === null || turn === undefined) return Promise.resolve(true);
    metaOf(chatId).interrupted.add(turn);
    return okOf(request({ t: "interrupt", rid: newUuid(), chat: chatId, turn }, () => metaOf(chatId).interrupted.delete(turn)));
  },
  /** Rename (`rename`): resolves true on the ok ack, false when the server refused (its line shows). */
  rename(chatId: string, title: string): Promise<boolean> {
    return okOf(request({ t: "rename", rid: newUuid(), chat: chatId, title }));
  },
  /** D48 Delete: the chat's process ends, kitespan removes the chat, and Claude Code's transcript is deleted. */
  remove(chatId: string) {
    void request({ t: "delete", rid: newUuid(), chat: chatId });
  },
  /** D48 Archive (`stop` for Stop and archive on a busy chat). */
  archive(chatId: string, opts: { stop?: boolean } = {}) {
    void request({ t: "archive", rid: newUuid(), chat: chatId, on: true, stop: opts.stop === true });
  },
  /** Unarchive (`archive` with `on` false): resolves as rename does. */
  unarchive(chatId: string): Promise<boolean> {
    return okOf(request({ t: "archive", rid: newUuid(), chat: chatId, on: false, stop: false }));
  },
  reconnect(chatId: string, server: string) {
    void request({ t: "reconnect_mcp", rid: newUuid(), chat: chatId, server });
  },
  /**
   * Start a chat (`new_chat`): only the user's own picks go (null for one left out), with the form's uploads and its
   * mention chips (D59: paths relative to the project's folder, which the server checks and references as a send's;
   * none: no key). Resolves with the new chat's id once the server made it, or null when it refused (its line shows).
   */
  async newChat(input: { projectId: string; model?: string; effort?: string; mode?: ModeId; text: string; sessionId?: string; mentions?: readonly string[] }): Promise<string | null> {
    // W3: one Start at a time per form: a press while the first waits for its ack (git may be checking a worktree out)
    // sends nothing, so it makes no second chat and no second worktree.
    const out = input.sessionId;
    if (out && state.newChatOut.includes(out)) return null;
    if (out) patch({ newChatOut: [...state.newChatOut, out] });
    try {
      return await sendNewChat(input);
    } finally {
      if (out) patch({ newChatOut: state.newChatOut.filter((x) => x !== out) });
    }
  },
  /** One setting: this device's own (look, theme, text size, motion, Return key) or kitespan's on the host (POST /api/settings). */
  setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    const settings = { ...state.settings, [key]: value };
    patch({ settings });
    saveDeviceSettings(settings);
    const serverKey = SERVER_KEYS[key];
    if (!serverKey) return;
    void apiSend<SettingsReply>("POST", "/api/settings", { [serverKey]: serverValue(key, value) }).then(takeSettingsReply, (e) => {
      patch({ notice: apiFailed(e), noticeChat: null });
      void loadSettingsFromServer();
    });
  },
  /** Settings > Appearance > Look: worn at once, kept on this device for the first paint and on the host. */
  setLook(look: LookId) {
    if (!LOOK_IDS.includes(look)) return;
    act.setSetting("look", look);
  },
  /**
   * Settings > About > Restart, Restart when they finish or Restart now (4.10): POST /api/restart, inside the click.
   * The server answers 202 once its preflight passed, or one line. Its answer can be lost in the restart itself (its
   * own connection closes): a lost answer after the `bye`, or under a new epoch, still counts as accepted.
   */
  restart(when: RestartWhen): Promise<void> {
    const epoch = state.server.epoch;
    patch({ restart: { when, epoch, state: "sending", line: null } });
    const mine = () => state.restart?.epoch === epoch && state.restart.when === when;
    return apiSend<RestartAccepted>("POST", "/api/restart", { when }).then(
      () => {
        if (mine() && state.restart!.state === "sending") patch({ restart: { ...state.restart!, state: "accepted" } });
      },
      (e) => {
        if (!mine() || state.restart!.state !== "sending") return;
        const lost = e instanceof ApiError && e.code === "network" && (state.restarting || state.server.epoch !== epoch);
        patch({ restart: lost ? { ...state.restart!, state: state.server.epoch !== epoch ? "done" : "accepted" } : { ...state.restart!, state: "refused", line: apiFailed(e) } });
      },
    );
  },
  /** Cancel restart, while Restart when they finish waits (L14): the drain is undone and the notice goes. */
  cancelRestart(): Promise<void> {
    return apiSend<RestartCancelReply>("POST", "/api/restart/cancel", {}).then(
      (r) => {
        if (r.cancelled) patch({ restart: null, restartWait: null });
      },
      (e) => patch({ notice: apiFailed(e), noticeChat: null }),
    );
  },
  /** The restart dialog closed: what this page asked for is forgotten once it ended (refused, done or not done). */
  forgetRestart() {
    const r = state.restart;
    if (r && r.state !== "sending" && r.state !== "accepted") patch({ restart: null });
  },
  /**
   * Files dropped on the chat, pasted into the composer or picked in the + menu (D37, D50): each one uploads (POST
   * /api/uploads) and, when it is done, its chip joins the chat's draft. Returns the new uploads (on their way).
   */
  upload(chatId: string, files: readonly FileFacts[]): Upload[] {
    const chat = findChat(chatId);
    if (!chat || !files.length) return [];
    return addUploads(chatId, { chat: chatId }, files, (u) => {
      const d = fieldsOf(chatId);
      if (d.uploads.includes(u.id)) return;
      putDraft(chatId, { ...d, uploads: [...d.uploads, u.id] });
      changedDraft(chatId, true);
    });
  },
  /** The new-chat form's files: uploaded for the project (`?project=`), kept under the form's key until Start. */
  uploadForNewChat(sessionId: string, files: readonly FileFacts[], projectId?: string): Upload[] {
    if (!files.length) return [];
    const project = projectId ?? state.projects[0]?.id;
    if (!project) return [];
    return addUploads(newChatUploadsKey(sessionId), { project }, files, () => {});
  },
  /** Remove (DELETE /api/uploads/:upload): the upload leaves the list and its chip leaves the draft. */
  removeUpload(key: string, id: string) {
    const up = state.uploads[key]?.find((u) => u.id === id);
    setUploads(key, (list) => list.filter((u) => u.id !== id));
    const d = fieldsOf(key);
    if (d.uploads.includes(id)) {
      putDraft(key, { ...d, uploads: d.uploads.filter((x) => x !== id) });
      changedDraft(key, true);
    }
    const place = rows.some((r) => r.chat === key) ? key : null;
    if (up && up.state === "done") void apiSend("DELETE", `/api/uploads/${id}`).catch((e) => patch({ notice: apiFailed(e), noticeChat: place }));
  },
  /**
   * A file of the chat's folder picked in the `@` picker (9.3, the owner's answer of 2026-11-01): its chip joins the
   * draft, after the others, and is saved as every change in the box is (250 ms), so the pick's text change and its
   * chip go in one `draft` frame. It is a path relative to the chat's folder; the server adds its absolute path's
   * reference (shared/protocol.ts messageRef) at send. No request: a mention is not an upload. A path that is not a
   * safe relative one, or a draft that holds 100 mentions already, changes nothing (false); a path the draft holds
   * already stays one chip (true).
   */
  addMention(chatId: string, path: string): boolean {
    if (!isSafeRelativePath(path)) return false;
    const d = fieldsOf(chatId);
    const list = mentionsIn(d);
    if (list.includes(path)) return true;
    if (list.length >= LIMITS.draftMentions) return false;
    putDraft(chatId, withMentions(d, [...list, path]));
    changedDraft(chatId, false);
    return true;
  },
  /** A mention chip's Remove (9.3): it leaves the draft, saved at once; nothing is deleted and no request goes out. */
  removeMention(chatId: string, path: string) {
    const d = fieldsOf(chatId);
    const list = mentionsIn(d);
    if (!list.includes(path)) return;
    putDraft(chatId, withMentions(d, list.filter((p) => p !== path)));
    changedDraft(chatId, true);
  },
  /**
   * The user's own input in the message box (D49): kept now, saved on the server 250 ms after the last change. The
   * box's fields (its mode is its own, DraftInput); or the one-string form ("!" or "/" first), whose fields come from
   * its first character and the composer's link mark for exactly that text (readLinkModesWith).
   */
  setDraft(chatId: string, input: DraftInput | string) {
    const was = fieldsOf(chatId);
    if (typeof input === "string") {
      if ((state.drafts[chatId] ?? "") === input) return;
      putDraft(chatId, { ...parseDraftString(input), uploads: [...was.uploads], ...mentionsKey(was.mentions) }, {}, input);
      fieldsOf(chatId);
      // The composer writes the link mark for the new text just after this call: the fields are read again then.
      queueMicrotask(() => rereadOneString(chatId));
    } else {
      const link = input.link ?? (input.text === "" && input.command === null ? false : was.link);
      const next = cleanDraft({ ...input, link, uploads: was.uploads, mentions: was.mentions });
      if (draftKey(next) === draftKey(was) && syncOf(chatId).oneString === null) return;
      putDraft(chatId, next);
    }
    if (state.takeBackWait?.chatId === chatId && !isCommandDraft(draftOf(state, chatId))) patch({ takeBackWait: null });
    if (state.bringBackWait?.chatId === chatId && !isCommandDraft(draftOf(state, chatId))) patch({ bringBackWait: null });
    changedDraft(chatId, false);
  },
  /** An input method composes in the box (7.5): a draft from the server waits until it ends. */
  setComposing(chatId: string, on: boolean) {
    syncOf(chatId).composing = on;
  },
  /**
   * The notice line: `chat` is where it shows (a chat's id, or null for the list and the screens that are not a chat);
   * left out, the open chat. A clear with no place clears the line wherever it shows; with one, only a line there.
   */
  setNotice(notice: string | null, chat?: string | null) {
    if (notice === null) {
      if (state.notice !== null && (chat === undefined || state.noticeChat === chat)) patch({ notice: null, noticeChat: null });
      return;
    }
    patch({ notice, noticeChat: chat === undefined ? openChat : chat });
  },
  /** A view preference, such as the session rail's Hide and Show: kept in local storage, never sent. */
  setView(p: Partial<ViewPrefs>) {
    const view = { ...state.view, ...p };
    patch({ view });
    writeJson(storage(), VIEW_KEY, view);
  },
  /** A toast from a chat's Claude Code (live state): one with the same key, for the same chat, replaces the one there. */
  showToast(toast: Omit<Toast, "id"> & { id?: string }): string {
    const t: Toast = { ...toast, id: toast.id ?? `t-${newUuid()}` };
    const at = state.toasts.findIndex((x) => x.key === t.key && x.chatId === t.chatId);
    patch({ toasts: at >= 0 ? state.toasts.map((x, i) => (i === at ? t : x)) : [...state.toasts, t] });
    return t.id;
  },
  closeToast(id: string) {
    if (!state.toasts.some((t) => t.id === id)) return;
    patch({ toasts: state.toasts.filter((t) => t.id !== id) });
  },
};
