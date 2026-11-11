// The on-disk data model (DESIGN.md 4.4) and the Store interface that the registry, the socket layer and the JSON API
// use. Every write under the state folder goes through the store's one atomic writer (open wx 0600, fsync, rename,
// fsync of the folder); the daily logs are server/log.ts's own. Claude Code's transcripts are never read or written
// here: the driver reads them through the SDK.

import { CHAT_ID, UPLOAD_ID, UUID } from "../../shared/ids";
import { LIMITS, mentionsOf, type Card, type ChatEventOf, type ChatState, type CommandInfo, type ContextInfo, type DraftBox, type DraftMode, type FastModeInfo, type ModeId, type ModelInfo, type PluginInfo, type TitleFrom, type Unseen } from "../../shared/protocol";
import type { UpdateCheck } from "../../shared/update";
import type { Marked } from "../agents/types";
import type { SideRecord } from "./side";

export type { SideRecord } from "./side";

/** A pick as the ledger and the project table keep it: the value with its mark (4.7), or null. */
export type MarkedValue = Marked<string>;

export interface LedgerPicks {
  model: MarkedValue | null;
  effort: MarkedValue | null;
  /** In the project table, never `plan` (D11). */
  permissionMode: MarkedValue | null;
}

/** `chats/<chat id>.json`: one ledger file per chat, at most 64 KB. */
export interface ChatLedger {
  v: 1;
  /** 20 characters of [a-z2-7]; it must match the file name. */
  id: string;
  /** The project id (`projects.json`). */
  project: string;
  /** The chat's folder: an absolute path of at most 4,096 characters, no control characters. Never in a URL. */
  cwd: string;
  agent: "claude-code";
  /**
   * Claude Code's session id. kitespan picks it at the chat's first start (D41); it is taken again from every
   * `system/init` and `result`, and a different id replaces the stored one.
   */
  sessionId: string | null;
  /** At most 120 characters; a rename always wins (D13). */
  title: { text: string; from: TitleFrom } | null;
  picks: LedgerPicks;
  /** ISO 8601 UTC. */
  createdAt: string;
  /** The last time a viewer attached or the user acted in the chat (written at most once per 30 s). */
  seenAt: string;
  /** The later of the last user action and the last frame from the CLI; the cap rule uses it (D3). */
  lastActivityAt: string;
  /** The last event sequence number when the record was written (4.3). */
  lastSeq: number;
  /** The registry state when the record was written; at start-up every chat is sleeping. */
  state: ChatState;
  lastExit: { code: number | null; signal: string | null; at: string } | null;
  /** D48: when the user archived the chat; null while the chat is in the lists. An archived chat never starts. */
  archivedAt: string | null;
  /**
   * The ids of the newest requests that the chat applied, at most 100, oldest first: the messages that reached Claude
   * Code, the `!` commands that ran, the messages and `!` commands that a shutdown took back to the draft, and the
   * `new_chat` that made the chat. A tab resends a request whose ack it did not
   * see, also to the next server after a restart; one of these is answered and not applied again (4.3, "Request ids
   * and acks"). Absent from a ledger that has none.
   */
  applied?: string[];
  /**
   * D58 Continue in a copy: the Claude Code session that this chat's session is a fork of (the session preview offers
   * the copy, and a later copy is numbered). Absent from a chat that is no copy.
   */
  copyOf?: string;
  /** D32: a stop of the server cut this chat's turn or card; boot notes its line and clears it. Absent: none did. */
  stop?: LedgerStop;
  /** The chat's claude process while it lives, so that the next server knows it as kitespan's own. Absent: none. */
  proc?: LedgerProc;
  /**
   * S16 (L16): End it here and copy handed the chat's session to the terminal; the time its hand-over runs from (the
   * end of the chat's Claude Code; while that still runs, the time of the ask). The next server holds the chat as
   * handed until the hand-over's time after it, or until Claude Code's registry shows the session open. Absent: none.
   */
  handedAt?: string;
  /**
   * Row 73 (W3): the git worktree that kitespan made for this chat before its first start; `cwd` is its path. Absent:
   * the chat runs in its project's folder, or (Continue here of a terminal session, W12) in that session's own linked
   * worktree of it, which kitespan never removes.
   */
  worktree?: LedgerWorktree;
  /**
   * W12 (L31): `cwd` is the linked worktree of the project's folder that a terminal session ran in (Continue here of
   * it): the chat starts there, and kitespan never removes it. Absent: no such worktree.
   */
  linked?: true;
  /**
   * W5: Claude Code refused to resume this chat's session in its worktree, so a plain new start could run without the
   * worktree; nothing starts until the user picks Continue without the worktree. Absent: none.
   */
  refused?: "worktree_resume_refused";
  /**
   * W4 Continue in the project folder: the folder the chat's session ran in before (its own worktree, or the linked
   * worktree of W12), which may be gone. Claude Code keeps the session's transcript under that folder's name in its
   * projects folder, also after a resume in the project's folder, and a fork goes beside it, so the session functions
   * (history, session info, rename, delete, fork) look there; a copy of such a chat has it too. Absent: `cwd`.
   */
  sessionDir?: string;
  /**
   * FIX-W25b 1.5: the transcript of `sessionId` is known to exist (Claude Code's init of that session arrived, a turn
   * ended in it, a start's check found it, or the chat continues a session that has one), so the chat's row names the
   * session. A new id, or a new transcript under the same id (the sessionId rule), clears it. Absent: not known yet.
   */
  transcript?: true;
  /**
   * Row 116: the chat's last end that no page has seen (`done`, or `failed`), which the rows carry as `unseen`.
   * Written at once when it changes (it is not an activity field), so it survives a restart. Absent: seen.
   */
  unseen?: Unseen;
}

/** A chat's own worktree (W3), as kitespan made it. */
export interface LedgerWorktree {
  /** The worktree's real path. */
  path: string;
  /** The main checkout it is a linked worktree of: the project's folder. */
  root: string;
  /** The branch that kitespan made for it (`kitespan/<name>`, L24). */
  branch: string;
  /** What the main checkout's HEAD named at the add (`refs/heads/<name>`, or `HEAD` when detached), and its commit (L22). */
  baseRef: string;
  baseCommit: string;
  /** L25: Archive kept it on disk because it had changes; the archived chat says so. Absent: it did not. */
  kept?: true;
  /**
   * L25, row 100: Archive removed it (it was clean). The name is free again in the project's `.claude/worktrees`,
   * which the CLI and Desktop share, so a worktree found at `path` later is the chat's own only on the chat's own
   * branch; until Unarchive or Make it again brings it back, nothing starts there and nothing hands it to git.
   * Absent: kitespan did not remove it.
   */
  removed?: true;
  /** W4 Continue in the project folder: the worktree was gone, and the chat runs in its project's folder now. */
  left?: true;
}

/** Why a chat gets a stop line (D32): a turn ran (or the chat's start did), or a card waited for an answer. */
export const STOP_WHYS = ["running", "waiting"] as const;
export type StopWhy = (typeof STOP_WHYS)[number];
/**
 * What stopped the chat: a crash or a kill -9 of the server (boot reads the ledger's old `state`), a shutdown, Restart
 * now, or Restart now whose restart did not happen (its successor failed, S13: the same server works on).
 */
export const STOP_BYS = ["crash", "shutdown", "restart", "restart_failed"] as const;
export type StopBy = (typeof STOP_BYS)[number];

export interface LedgerStop {
  why: StopWhy;
  by: StopBy;
  at: string;
}

/**
 * A claude process: its pid and its start time (field 22 of `/proc/<pid>/stat`, then `@` and the boot's id, since
 * those ticks count from the boot; where there is no /proc, its start in ms since the epoch), so that a pid the
 * system gave again never counts, also after a reboot.
 */
export interface LedgerProc {
  pid: number;
  /** 1 to 20 digits, then optionally `@` and a boot id (a lower-case UUID). */
  start: string;
}

/** The chat's stop line (DESIGN 9.4; 4.10 for Restart now). */
export function stopLine(stop: Pick<LedgerStop, "why" | "by">): string {
  if (stop.by === "restart_failed")
    return stop.why === "running"
      ? "The restart stopped this turn, but kitespan did not restart. Send a message to continue."
      : "This chat was waiting for your answer when the restart stopped it, but kitespan did not restart. Send a message to continue.";
  const restart = stop.by === "restart";
  if (stop.why === "running") return restart ? "kitespan restarted during this turn. Send a message to continue." : "kitespan stopped while this chat was running. Send a message to continue.";
  return `This chat was waiting for your answer when kitespan ${restart ? "restarted" : "stopped"}. Send a message to continue.`;
}

type Obj = Record<string, unknown>;
const objOf = (v: unknown): Obj | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : null);
const ownOf = (o: Obj, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const isTime = (v: unknown): v is string => typeof v === "string" && ISO_UTC.test(v) && !Number.isNaN(Date.parse(v));

/** A ledger's `stop`; null when it is absent or not one, so a bad field never sets the ledger aside. */
export function ledgerStopOf(v: unknown): LedgerStop | null {
  const o = objOf(v);
  if (!o) return null;
  const why = ownOf(o, "why");
  const by = ownOf(o, "by");
  const at = ownOf(o, "at");
  if (!(STOP_WHYS as readonly unknown[]).includes(why) || !(STOP_BYS as readonly unknown[]).includes(by) || !isTime(at)) return null;
  return { why: why as StopWhy, by: by as StopBy, at };
}

/** A ledger's `proc`; null when it is absent or not one. */
export function ledgerProcOf(v: unknown): LedgerProc | null {
  const o = objOf(v);
  if (!o) return null;
  const pid = ownOf(o, "pid");
  const start = ownOf(o, "start");
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 1 || pid > 2 ** 31 - 1) return null;
  if (typeof start !== "string" || !/^[0-9]{1,20}(?:@[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/.test(start)) return null;
  return { pid, start };
}

/**
 * RD-8: one message that waits in a chat (for the cap, behind a turn or a `!` command, in a held chat, during a
 * drain), as the queue file keeps it from before its ack until a `turn_end` lists its uuid, Take back, Delete or
 * Archive. The fields are the registry's pending message's.
 */
export interface QueuedNote {
  uuid: string;
  /** What Claude Code gets: the user's text with the chips' references (D50, 9.3). */
  text: string;
  /** What the user typed, for Take back. */
  userText: string;
  uploads: string[];
  /** Paths relative to the chat's folder, in chip order. */
  mentions: string[];
  at: string;
}

/** `queue/<chat id>.json` (folder 0700, file 0600): the messages that wait, in send order. */
export interface QueueRecord {
  v: 1;
  /** The chat id; it must match the file name. */
  id: string;
  /** At most STORE_LIMITS.queueMessages; the file at most STORE_LIMITS.queueBytes. */
  msgs: QueuedNote[];
}

function queuedNoteOf(v: unknown): QueuedNote | null {
  const o = objOf(v);
  if (!o) return null;
  const uuid = ownOf(o, "uuid");
  const text = ownOf(o, "text");
  const userText = ownOf(o, "userText");
  const uploads = ownOf(o, "uploads");
  const mentions = ownOf(o, "mentions");
  const at = ownOf(o, "at");
  if (typeof uuid !== "string" || !UUID.test(uuid) || !isTime(at)) return null;
  if (typeof text !== "string" || typeof userText !== "string" || text.length > STORE_LIMITS.queueBytes || userText.length > STORE_LIMITS.queueBytes) return null;
  if (!Array.isArray(uploads) || uploads.length > LIMITS.sendUploads || !uploads.every((u) => typeof u === "string" && UPLOAD_ID.test(u))) return null;
  const paths = Array.isArray(mentions) ? mentionsOf(mentions, LIMITS.sendMentions) : null;
  if (paths === null) return null;
  return { uuid, text, userText, uploads: [...(uploads as string[])], mentions: paths, at };
}

/** A queue file's record; null when it fails its check (the store then sets the file aside). */
export function queueRecordOf(raw: unknown, fileId?: string): QueueRecord | null {
  const o = objOf(raw);
  if (!o || ownOf(o, "v") !== 1) return null;
  const id = ownOf(o, "id");
  const msgs = ownOf(o, "msgs");
  if (typeof id !== "string" || !CHAT_ID.test(id) || (fileId !== undefined && id !== fileId)) return null;
  if (!Array.isArray(msgs) || msgs.length > STORE_LIMITS.queueMessages) return null;
  const out: QueuedNote[] = [];
  for (const m of msgs) {
    const note = queuedNoteOf(m);
    if (!note || out.some((n) => n.uuid === note.uuid)) return null;
    out.push(note);
  }
  return { v: 1, id, msgs: out };
}

/** One row of `projects.json`. */
export interface ProjectRecord {
  /** 10 characters of [a-z2-7]. */
  id: string;
  /** The real path (symbolic links resolved); one project per real path; at most 4,096 characters. */
  cwd: string;
  /** At most 80 characters; the folder's last part by default. */
  name: string;
  createdAt: string;
  lastUsedAt: string;
  /** The picks remembered per folder for new chats; `permissionMode` is never `plan` (D11). */
  picks: LedgerPicks;
  /**
   * Row 99: the project's place in the sidebar, the smallest first (store/order.ts). Absent on every project until the
   * user moves an environment (the last used then comes first); a bad value reads as none.
   */
  order?: number;
  /** The project's last command list (D59), for the new-chat form's `/` menu; absent while none is known. */
  commands?: ProjectCommandsRecord;
  /**
   * Row 81: Claude Code's model list as this project's chat or short read last gave it; absent while none did. The
   * newest one kept with any project is the host's list, for every picker (server/chats/models.ts).
   */
  models?: ProjectModelsRecord;
  /** Row 73 (W2): each new chat here gets its own git worktree. Absent: off, the default, as in Desktop. */
  worktree?: true;
  /**
   * Row 94: each model's context window in tokens, as this project's chats' last live reads gave it (model id to
   * size); absent while none did. A chat with no kept context figure is measured against it (server/chats/context.ts).
   */
  contextWindows?: Record<string, number>;
  /**
   * Row 97: the provider that this project's chat's Claude Code last reported (`accountInfo().apiProvider`), and when;
   * absent while none did. The newest one kept with any project answers Settings > Account while no chat is live.
   */
  account?: KeptAccount;
  /**
   * Row 97: what this project's chat's Claude Code last loaded at its start (its `session` event's facts), and when;
   * absent while none did. Settings shows them while no live chat has its own (server/chats/facts.ts).
   */
  facts?: KeptFacts;
}

/** Row 97: Settings > Account's provider as a live chat's Claude Code last reported it (null: it reported none). */
export interface KeptAccount {
  at: string;
  provider: string | null;
}

/** Row 97: the facts Claude Code loaded at a chat's start (fast mode, skills, plugins, output style), as last kept. */
export interface KeptFacts {
  at: string;
  fastMode: FastModeInfo | null;
  skills: string[];
  plugins: PluginInfo[];
  outputStyle: string | null;
}

/**
 * A project's last command list (D59): the newest `commands` of any of its chats, or the answer of the short read
 * (the seam's readCommands) when none was known or it was over 24 h old. A cache, read defensively: a list that fails
 * its checks reads as none, and the oldest lists are dropped first when projects.json would pass its cap.
 */
export interface ProjectCommandsRecord {
  /** When the list was read (ISO 8601 UTC). */
  at: string;
  /** At most STORE_LIMITS.projectCommands rows, in Claude Code's order; its JSON at most projectCommandsBytes. */
  list: CommandInfo[];
}

/**
 * Claude Code's model list (row 81): a live chat's `get models`, or the short read (the seam's readModels) when none was
 * kept or the newest was over 24 h old. A cache, read defensively as ProjectCommandsRecord is (store/models.ts).
 */
export interface ProjectModelsRecord {
  /** When the list was read (ISO 8601 UTC). */
  at: string;
  /** At most STORE_LIMITS.projectModels rows, in Claude Code's order; its JSON at most projectModelsBytes. */
  list: ModelInfo[];
}

export interface ProjectsFile {
  v: 1;
  projects: ProjectRecord[];
}

export type UploadFolderChoice = "temp" | "state" | "claude" | "custom";
export type BashReply = "follow-cli" | "always" | "never";
export type LookId = "glass" | "paper" | "mono" | "editor";

/**
 * `settings.json`: a flat object of kitespan's own settings, each with its default when absent (4.4). The bind
 * address, the port and the auth mode are never here (4.9).
 */
export interface Settings {
  "chats.keepIdleMinutes": number;
  "chats.maxLive": number;
  "chats.allowBypass": boolean;
  "chats.generateTitles": boolean;
  "chats.bashReply": BashReply;
  "chats.rememberMode": boolean;
  /** Settings > Chats, "New chats start with": the project's last picks, or the user's Claude Code defaults. */
  "chats.newChats": "last" | "defaults";
  /**
   * Settings > Chats, "Show sessions from other apps" (row 77): off, the session lists (Home's and each project's From
   * the terminal) are empty, and a session's preview says that this setting hides it.
   */
  "chats.sessionsFromOtherApps": boolean;
  /**
   * Settings > Chats, "Show sessions open in another app" (row 77): off, a session that another process has open now,
   * busy or idle, is left out of the lists and its preview says so; on, it shows marked, with Continue in a copy (D58).
   */
  "chats.sessionsOpenElsewhere": boolean;
  "claudeCode.prefer": "path";
  "appearance.look": LookId;
  "uploads.folder": UploadFolderChoice;
  "uploads.customFolder": string | null;
  "uploads.maxMB": number;
  "uploads.keepDays": number;
  /**
   * Settings > About, "Check for updates" (row 108): Manually (Check now only), Daily (the default) or Every 3 hours;
   * here, so it is the same on every device.
   */
  "updates.check": UpdateCheck;
  /**
   * Iteration 7 (DESIGN-B1 2.1, D-2): the shared browser runs. Off by default, because its profile collects the user's
   * sign-ins; the browser routes' Start turns it on, and Stop and kitespan's quit turn it off (S4). The settings route
   * never writes it.
   */
  "browser.enabled": boolean;
  /** One switch per untyped Claude Code method that a feature uses (D6), true by default. */
  [method: `chats.untypedMethods.${string}`]: boolean;
}

export const SETTINGS_DEFAULTS: Readonly<Settings> = {
  "chats.keepIdleMinutes": 30,
  "chats.maxLive": 10,
  "chats.allowBypass": false,
  "chats.generateTitles": true,
  "chats.bashReply": "follow-cli",
  "chats.rememberMode": true,
  "chats.newChats": "last",
  "chats.sessionsFromOtherApps": true,
  "chats.sessionsOpenElsewhere": false,
  "claudeCode.prefer": "path",
  "appearance.look": "glass",
  "uploads.folder": "temp",
  "uploads.customFolder": null,
  "uploads.maxMB": 100,
  "uploads.keepDays": 7,
  "updates.check": "daily",
  "browser.enabled": false,
};

/** `last-options.json`: the options of the last chat start, written before `query()` is called (4.7). */
export interface LastOptionsRecord {
  v: 1;
  writtenAt: string;
  /** The SDK version, "0.3.322". */
  sdk: string;
  chat: string;
  /** Every key passed to `query()`, with its value; callbacks as "[function]". */
  options: Record<string, unknown>;
  /** The mark of each marked key and of each Switch key that was passed. */
  marks: Record<string, string>;
}

/**
 * `drafts/<chat id>.json`: the message box's draft (D49), at most 128 KiB. From iteration 5 (FIX-U2) the side chat's
 * box has one too, next to the side thread: `side/<chat id>.draft.json`, with `box: "side"`, the same caps and write
 * window, and plain text only (chat mode, no chip, no uploads, no mentions).
 */
export interface DraftRecord {
  v: 1;
  /** The chat id; it must match the file name. */
  id: string;
  /** `side`: the side chat's box's draft (its own file); absent: the message box's. It must match the file read. */
  box?: "side";
  rev: number;
  /** At most 20,000 UTF-16 units, never cut inside a surrogate pair. */
  text: string;
  mode: DraftMode;
  /** At most 120 characters, slash mode only. */
  command: string | null;
  link: boolean;
  /** At most 100 upload ids of this chat. */
  uploads: string[];
  /**
   * The `@` picker's chips (v0.3 search): at most 100 paths relative to the chat's folder, in chip order, no repeats.
   * Absent means none, as in a file from before v0.3; an empty list is not written.
   */
  mentions?: string[];
  /** At most 64 characters: the tab of the page that made the last change. */
  by: string | null;
  at: string;
}

/**
 * One closed card of a chat, as the server keeps it for history (5.4): the card (cut smaller than a live card, since
 * the record shows only its tool, its target, its questions or its plan), how it closed, and the tool call that its
 * record follows in history (the card's own tool use; for an elicitation, the call that ran when it opened; null when
 * none did, and then history leaves the record out).
 */
export interface CardNote {
  card: Card;
  close: ChatEventOf<"card_close">;
  after: string | null;
}

/**
 * One `!` row whose record went to Claude Code (D10): the row's uuid, and a digest of its record's content (the input,
 * stdout and stderr as the transcript holds them). Claude Code writes the record under an id of its own, so history
 * finds the record by this digest and shows it under the row's uuid, the id the live row had. The transcript's record
 * holds no exit code and no duration, so the note keeps what the live row showed: the exit code, the milliseconds, the
 * timeout and the cap (a note written without them reads as null, null, false, false).
 */
export interface BashNote {
  uuid: string;
  digest: string;
  code: number | null;
  ms: number | null;
  timedOut: boolean;
  capped: boolean;
}

/**
 * One `!` row that never ran (the `bash` event's `not_run`): the transcript holds nothing of it, so the note keeps the
 * command and the row's place, which is where the transcript ended when the row was noted: after the event with the
 * id `after` (eventId; null: the transcript was empty) and the `skip` events that followed it, none of which had an
 * id. History puts the row there; a row whose `after` is no longer in the transcript (a rewind) is left out.
 */
export interface NotRunNote {
  uuid: string;
  input: string;
  after: string | null;
  skip: number;
}

/**
 * One message that the user sent through this server (9.3): its uuid (the transcript keeps the message under it, a live
 * check), and its mention chips' paths relative to the chat's folder, in chip order, or none. The transcript holds only
 * the text, where nothing marks where a path with white space in it ends, or whether a reference came from a chip, so
 * history gives the message's `user` event these paths and the page makes exactly them tiles (none for an empty list).
 */
export interface MentionNote {
  uuid: string;
  /** 0 to LIMITS.sendMentions paths, each passing isSafeRelativePath, no repeats. */
  paths: string[];
}

/**
 * One stop line (D32, stopLine): its notice id and text, and its place, as a NotRunNote's: after the event with the
 * id `after` and the `skip` events with no id that followed it, where the transcript ended when the line was noted.
 */
/**
 * U2 (DESIGN 4.4, 6.3 The turn fold): one turn that ran live on this server, noted at its end, so that history gives
 * every page the same turns as the page that saw them live (D49). The ids are history event ids (ring.ts eventId): `ids`
 * names the turn's first rows, oldest first (its opening message, `!` row or first block or call; the next one in case
 * the first is not in the transcript), `last` its newest rows, newest first. `uuids`: the messages it took in (turn_end's).
 * `error`: the end's own line, or null (also for a line that names a provider's resource, 4.2).
 */
export interface TurnNote {
  ids: string[];
  last: string[];
  by: "user" | "agent";
  ok: boolean;
  subtype: string;
  durationMs: number;
  uuids: string[];
  error: string | null;
}

export interface StopNote {
  id: string;
  text: string;
  after: string | null;
  skip: number;
}

/**
 * `notes/<chat id>.json`: what the server knows about a chat's history that Claude Code's transcript does not hold
 * (the closed cards, the `!` rows' own ids, the rows that never ran and the messages' mention paths), so that it
 * survives a reload and a restart. At most 1 MiB; the oldest entries go first.
 */
export interface NotesRecord {
  v: 1;
  /** The chat id; it must match the file name. */
  id: string;
  /** Oldest first, at most STORE_LIMITS.noteCards. */
  cards: CardNote[];
  /** Oldest first, at most STORE_LIMITS.noteBash. */
  bash: BashNote[];
  /** Oldest first, at most STORE_LIMITS.noteNotRun (a file written before the field reads as none). */
  notRun: NotRunNote[];
  /**
   * Oldest first, at most STORE_LIMITS.noteMentions; the key only when there are some (a file written before the field
   * reads as none).
   */
  mentions?: MentionNote[];
  /** Oldest first, at most STORE_LIMITS.noteStops; the key only when there are some. */
  stops?: StopNote[];
  /** U2: oldest first, at most STORE_LIMITS.noteTurns; the key only when there are some. */
  turns?: TurnNote[];
  /** Row 94: the chat's last live context read, for the times no Claude Code runs for it; the key only when one came. */
  context?: ContextNote;
}

/** Row 94: a chat's last live context read (`get context` of a live chat) and when it came. */
export interface ContextNote {
  at: string;
  /** At most STORE_LIMITS.contextParts parts, each name at most LIMITS.name characters. */
  info: ContextInfo;
}

/** One uploaded file (D37, D50). Its reference is messageRef's form (the single-quoted path in `!` mode). */
export interface UploadRecord {
  v: 1;
  /** 16 characters of [a-z2-7]. */
  id: string;
  /** The chat it belongs to; null while it waits on the new-chat form, until `new_chat` names it. */
  chat: string | null;
  /**
   * The chat's project, or the new-chat form's. Iteration 7: null for the browser pane's own upload (a file chooser's
   * answer with no chat in reach, `?browser=1`), whose chat is null too; no chat or form ever claims it.
   */
  project: string | null;
  /** The saved name: the original name with slashes, backslashes and control characters as underscores. */
  name: string;
  size: number;
  /** The MIME type the browser gave ("" when none). */
  type: string;
  /** The absolute path of the file. */
  path: string;
  folder: UploadFolderChoice;
  /** The upload's own `u-XXXXXX` folder (0700); Remove deletes it. */
  dir: string;
  at: string;
  /**
   * Round K1: an upload of the state folder's own upload folder that the folder move took: its path before the move,
   * which the messages sent before it name (Claude Code's transcripts are never rewritten). The same name as `path`.
   */
  was?: string;
}

/** The state folder's layout (4.4), absolute paths. */
export interface StoreDirs {
  /** `$XDG_STATE_HOME/kitespan` (default `~/.local/state/kitespan`), 0700. */
  state: string;
  /** `$XDG_CONFIG_HOME/kitespan` (default `~/.config/kitespan`): the user's own files, never written by kitespan. */
  config: string;
  chats: string;
  drafts: string;
  /** `notes/`: each chat's NotesRecord. */
  notes: string;
  uploads: string;
  logs: string;
  /** `queue/`: each chat's QueueRecord (RD-8). */
  queue: string;
  /** `env/`: each environment's variables (D60), one file per project that has some (server/env/store.ts). */
  env: string;
  /** `side/`: each chat's side thread (R124, store/side.ts). */
  side: string;
  /**
   * `changes/`: U1's per-chat folders (server/changes/store.ts): the turns' changes summaries, and the git objects of
   * the turns' marks, which git writes itself (so the boot's tree check does not walk into `objects/`).
   */
  changes: string;
}

/** Why the store refused to open: the path is relative to the state folder; nothing else is said. */
export interface StoreProblem {
  path: string;
  why: "wider-mode" | "symlink" | "not-a-folder" | "not-a-file" | "owner";
}

export interface StoreOpenResult {
  /** Every ledger that passed its read check. */
  chats: ChatLedger[];
  /** Files that failed their read check and were renamed to `<name>.bad` (reported once). */
  setAside: string[];
  /** Stray `*.tmp` files removed. */
  swept: number;
}

export const STORE_LIMITS = {
  ledgerBytes: 64 * 1024,
  draftBytes: 128 * 1024,
  /** A draft is written at most once a second per chat, and at shutdown. */
  draftWriteMs: 1_000,
  /** `seenAt` and `lastActivityAt` alone are written at most once per 30 s. */
  activityWriteMs: 30_000,
  cwd: 4_096,
  projectName: 80,
  /** The applied request ids a ledger keeps (ChatLedger.applied). */
  applied: 100,
  notesBytes: 1024 * 1024,
  /** The closed cards a chat's notes keep, and the `!` rows. */
  noteCards: 200,
  noteBash: 2_000,
  /** The `!` rows that never ran. */
  noteNotRun: 200,
  /** The messages sent through this server, with their mention chips' paths or none. */
  noteMentions: 2_000,
  /** The stop lines (D32). */
  noteStops: 200,
  /** U2: the turns that ran on this server (TurnNote). */
  noteTurns: 1_000,
  /** RD-8: the messages that may wait in one chat, and its queue file's JSON in bytes; one more gets `queue_full`. */
  queueMessages: 50,
  queueBytes: 4 * 1024 * 1024,
  /** The notes are written at most once a second per chat, and at shutdown. */
  notesWriteMs: 1_000,
  /** A project's kept command list (D59): its rows, its aliases per row, and its JSON in bytes. */
  projectCommands: 500,
  commandAliases: 20,
  projectCommandsBytes: 64 * 1024,
  /** A kept model list (row 81): its rows and its JSON in bytes. */
  projectModels: 100,
  projectModelsBytes: 32 * 1024,
  /** Row 94: a kept context read's parts, and the context windows a project keeps (one per model). */
  contextParts: 32,
  contextWindows: 50,
} as const;

/**
 * The store. Reads check every record (the id matches the file name, every field has its type and cap) and set a bad
 * file aside as `.bad`; writes go through the one atomic writer and are serialised per file.
 */
export interface Store {
  readonly dirs: StoreDirs;
  /**
   * Boot: make the folders 0700 (never wider), refuse a folder or file with a wider mode or a symbolic link (rejects
   * with a StoreProblem list), sweep stray `*.tmp` files, and read every ledger.
   */
  open(): Promise<StoreOpenResult>;

  readChat(id: string): Promise<ChatLedger | null>;
  writeChat(rec: ChatLedger): Promise<void>;
  /** D48: unlink the ledger, the draft, the notes and the chat's upload records (each with an fsync of its folder). */
  deleteChat(id: string): Promise<void>;

  listProjects(): Promise<ProjectRecord[]>;
  /** Add or replace one project (by id) in `projects.json`. */
  putProject(rec: ProjectRecord): Promise<void>;
  /** Row 99: add or replace several projects (by id) in one write of `projects.json` (a move's new order). */
  putProjects(recs: readonly ProjectRecord[]): Promise<void>;
  /**
   * Row 99: take one project out of `projects.json`, with the upload records of its new-chat form (those no chat holds;
   * its chats go first, through deleteChat). A later write of that id is dropped, so a cache write that read the
   * project before never brings it back; ids are never used again. Returns the record, or null when there was none.
   */
  removeProject(id: string): Promise<ProjectRecord | null>;

  readSettings(): Promise<Settings>;
  /** Apply a change and return the whole settings object with defaults. */
  writeSettings(change: Partial<Settings>): Promise<Settings>;

  writeLastOptions(rec: LastOptionsRecord): Promise<void>;

  /**
   * The chat's draft of one box (`main` by default; FIX-U2 `side`, the side chat's box): from memory, else its file,
   * else an empty draft (rev 0). A bad file is set aside.
   */
  readDraft(chat: string, box?: DraftBox): Promise<DraftRecord>;
  /**
   * Keep the draft (of the box its record names) in memory at once; write its file at most once a second (the newest
   * state then).
   */
  saveDraft(rec: DraftRecord): void;

  /** The chat's notes: from memory, else its file, else empty ones. A bad file is set aside. */
  readNotes(chat: string): Promise<NotesRecord>;
  /** Keep the notes in memory at once (the oldest entries dropped to the caps); write the file at most once a second. */
  saveNotes(rec: NotesRecord): void;

  /** RD-8: the messages that wait in the chat (its queue file), or null when none does. A bad file is set aside. */
  readQueue(chat: string): Promise<QueueRecord | null>;
  /** RD-8: write the chat's queue file at once (a record with no message removes it); resolves once it is on disk. */
  writeQueue(rec: QueueRecord): Promise<void>;

  /** R124: the chat's side thread (store/side.ts), or null when it has none. A bad file is set aside. */
  readSide(chat: string): Promise<SideRecord | null>;
  /** R124: write the chat's side file at once; resolves once it is on disk. A deleted chat's write is dropped. */
  writeSide(rec: SideRecord): Promise<void>;

  listUploads(chat: string | null): Promise<UploadRecord[]>;
  putUpload(rec: UploadRecord): Promise<void>;
  /** Forget one upload; the caller removes its folder. Returns the record, or null when there was none. */
  removeUpload(id: string): Promise<UploadRecord | null>;

  /** Write every pending draft and ledger (shutdown). */
  flush(): Promise<void>;
}

/** A remembered permission mode is never `plan` (D11). */
export function rememberableMode(mode: ModeId): boolean {
  return mode !== "plan";
}
