// The record checks (DESIGN.md 4.4, "Every read checks the record again"): each returns a clean copy that holds only
// the known fields, or throws RecordError. The store runs them on every read (a failure sets the file aside as
// `.bad`) and on every write (a failure is the caller's programming error, so the bad record is never written).

import { basename, isAbsolute, join } from "node:path";
import { CHAT_ID, PROJECT_ID, TAB_ID, UPLOAD_ID, UUID } from "../../shared/ids";
import { CHAT_STATES, CONTROL_CHARS, DRAFT_MODES, EFFORT_IDS, LIMITS, MODE_IDS, TITLE_FROM, UNSEEN_KINDS, capText, mentionsOf, type DraftBox, type Unseen } from "../../shared/protocol";
import { UPDATE_CHECKS } from "../../shared/update";
import { LEGACY_BRANCH_PREFIX } from "../../shared/legacy";
import {
  SETTINGS_DEFAULTS,
  STORE_LIMITS,
  ledgerProcOf,
  ledgerStopOf,
  type ChatLedger,
  type DraftRecord,
  type LastOptionsRecord,
  type LedgerPicks,
  type LedgerWorktree,
  type LookId,
  type MarkedValue,
  type ProjectRecord,
  type ProjectsFile,
  type Settings,
  type UploadFolderChoice,
  type UploadRecord,
} from "./types";
import { projectCommandsFrom } from "./commands";
import { contextWindowsFrom } from "./context";
import { keptAccountFrom, keptFactsFrom } from "./facts";
import { projectModelsFrom } from "./models";

export class RecordError extends Error {
  constructor(why: string) {
    super(why);
    this.name = "RecordError";
  }
}

type Obj = Record<string, unknown>;

const fail = (why: string): never => {
  throw new RecordError(why);
};

const own = (o: Obj, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

function obj(v: unknown, what: string): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(`${what}: not an object`);
  return v as Obj;
}

function int(v: unknown, what: string, min: number): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min) fail(`${what}: not an integer of ${min} or more`);
  return v as number;
}

function bool(v: unknown, what: string): boolean {
  if (typeof v !== "boolean") fail(`${what}: not a boolean`);
  return v as boolean;
}

function oneOf<T extends string>(v: unknown, list: readonly T[], what: string): T {
  if (typeof v !== "string" || !(list as readonly string[]).includes(v)) fail(`${what}: not a known value`);
  return v as T;
}

function matches(v: unknown, re: RegExp, what: string): string {
  if (typeof v !== "string" || !re.test(v)) fail(`${what}: bad shape`);
  return v as string;
}

/** C0 and C1 controls and DEL: never in a path. */
const PATH_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/;

/** A short label: a string of at most `max` UTF-16 units with no control or bidirectional character. */
function label(v: unknown, what: string, max: number, min = 0): string {
  if (typeof v !== "string" || v.length < min || v.length > max || CONTROL_CHARS.test(v)) fail(`${what}: bad label`);
  return v as string;
}

/** An absolute path of at most 4,096 characters with no control character. */
export function isCleanPath(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= STORE_LIMITS.cwd && isAbsolute(v) && !PATH_CONTROLS.test(v);
}

function path(v: unknown, what: string): string {
  if (!isCleanPath(v)) fail(`${what}: not a clean absolute path`);
  return v as string;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/** An ISO 8601 UTC time. */
export function isIsoTime(v: unknown): v is string {
  return typeof v === "string" && ISO.test(v) && !Number.isNaN(Date.parse(v));
}

function time(v: unknown, what: string): string {
  if (!isIsoTime(v)) fail(`${what}: not an ISO 8601 UTC time`);
  return v as string;
}

const nullable = <T>(v: unknown, f: (v: unknown) => T): T | null => (v === null ? null : f(v));

const MARK_MAX = 200;

function marked(v: unknown, what: string, values?: readonly string[]): MarkedValue {
  const o = obj(v, what);
  const value = values ? oneOf(own(o, "value"), values, `${what}.value`) : label(own(o, "value"), `${what}.value`, LIMITS.name, 1);
  return { value, mark: label(own(o, "mark"), `${what}.mark`, MARK_MAX, 1) };
}

/** The picks; `rememberable` refuses a `plan` mode (D11: the project table never remembers Plan). */
function picks(v: unknown, what: string, rememberable: boolean): LedgerPicks {
  const o = obj(v, what);
  const modes = rememberable ? MODE_IDS.filter((m) => m !== "plan") : MODE_IDS;
  return {
    model: nullable(own(o, "model"), (x) => marked(x, `${what}.model`)),
    effort: nullable(own(o, "effort"), (x) => marked(x, `${what}.effort`, EFFORT_IDS)),
    permissionMode: nullable(own(o, "permissionMode"), (x) => marked(x, `${what}.permissionMode`, modes)),
  };
}

const v1 = (o: Obj, what: string) => {
  if (own(o, "v") !== 1) fail(`${what}: not version 1`);
};

const SIGNAL = /^SIG[A-Z0-9]{1,12}$/;

/** `chats/<id>.json`. `fileId`, when given, must equal the record's id (the file name check). */
export function ledgerFrom(raw: unknown, fileId?: string): ChatLedger {
  const o = obj(raw, "ledger");
  v1(o, "ledger");
  const id = matches(own(o, "id"), CHAT_ID, "id");
  if (fileId !== undefined && id !== fileId) fail("id: does not match the file name");
  const title = nullable(own(o, "title"), (x) => {
    const t = obj(x, "title");
    return { text: label(own(t, "text"), "title.text", LIMITS.title, 1), from: oneOf(own(t, "from"), TITLE_FROM, "title.from") };
  });
  const lastExit = nullable(own(o, "lastExit"), (x) => {
    const e = obj(x, "lastExit");
    return {
      code: nullable(own(e, "code"), (c) => (typeof c === "number" && Number.isSafeInteger(c) ? c : fail("lastExit.code: bad"))),
      signal: nullable(own(e, "signal"), (s) => matches(s, SIGNAL, "lastExit.signal")),
      at: time(own(e, "at"), "lastExit.at"),
    };
  });
  if (own(o, "agent") !== "claude-code") fail("agent: unknown");
  const applied = own(o, "applied");
  const copyOf = own(o, "copyOf");
  // D32's stop and the chat's claude process (R15, R16): a bad one reads as none, so it never sets the ledger aside.
  const stop = ledgerStopOf(own(o, "stop"));
  const proc = ledgerProcOf(own(o, "proc"));
  // S16's hand-over (L16): a bad time reads as none, as above.
  const handedAt = own(o, "handedAt");
  const handed = isIsoTime(handedAt) ? handedAt : null;
  // Row 73: the chat's worktree is checked as `cwd` is (a bad one fails the ledger), and the chat runs in it.
  const worktree = own(o, "worktree");
  const refused = own(o, "refused");
  const sessionDir = own(o, "sessionDir");
  if (sessionDir !== undefined && path(sessionDir, "sessionDir") === own(o, "cwd")) fail("sessionDir: the chat's folder");
  return {
    v: 1,
    id,
    project: matches(own(o, "project"), PROJECT_ID, "project"),
    cwd: path(own(o, "cwd"), "cwd"),
    agent: "claude-code",
    sessionId: nullable(own(o, "sessionId"), (x) => matches(x, UUID, "sessionId")),
    title,
    picks: picks(own(o, "picks"), "picks", false),
    createdAt: time(own(o, "createdAt"), "createdAt"),
    seenAt: time(own(o, "seenAt"), "seenAt"),
    lastActivityAt: time(own(o, "lastActivityAt"), "lastActivityAt"),
    lastSeq: int(own(o, "lastSeq"), "lastSeq", 0),
    state: oneOf(own(o, "state"), CHAT_STATES, "state"),
    lastExit,
    archivedAt: nullable(own(o, "archivedAt"), (x) => time(x, "archivedAt")),
    ...(applied === undefined ? {} : { applied: appliedIds(applied) }),
    ...(copyOf === undefined ? {} : { copyOf: matches(copyOf, UUID, "copyOf") }),
    ...(stop ? { stop } : {}),
    ...(proc ? { proc } : {}),
    ...(handed ? { handedAt: handed } : {}),
    ...(worktree === undefined ? {} : { worktree: ledgerWorktree(worktree, own(o, "cwd")) }),
    ...(refused === "worktree_resume_refused" ? { refused } : {}),
    ...(own(o, "linked") === true && worktree === undefined ? { linked: true as const } : {}),
    ...(sessionDir === undefined ? {} : { sessionDir: sessionDir as string }),
    // FIX-W25b 1.5: a bad value reads as none (the row then names no session until the transcript is known again).
    ...(own(o, "transcript") === true && own(o, "sessionId") !== null ? { transcript: true as const } : {}),
    // Row 116: a bad value reads as seen, so it never sets the ledger aside.
    ...((UNSEEN_KINDS as readonly unknown[]).includes(own(o, "unseen")) ? { unseen: own(o, "unseen") as Unseen } : {}),
  };
}

/**
 * A kitespan branch (L24): `kitespan/` and the 8 symbols of a chat id, with `-2` up to `-99` on a taken name; or the
 * old name's prefix (shared/legacy.ts), for good: a worktree made under it keeps its branch, and a ledger that failed
 * this check would be set aside with its chat.
 */
export const WORKTREE_BRANCH = new RegExp(`^(?:kitespan/|${LEGACY_BRANCH_PREFIX})[a-z2-7]{8}(?:-[1-9][0-9]?)?$`);
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const BASE_REF = /^(?:HEAD|refs\/heads\/[^\u0000-\u0020\u007f~^:?*[\\]{1,240})$/;

/** The ledger's `worktree` (W3): its folder is the chat's `cwd`, unless the chat continues in its project's folder. */
function ledgerWorktree(v: unknown, cwd: unknown): LedgerWorktree {
  const o = obj(v, "worktree");
  const w: LedgerWorktree = {
    path: path(own(o, "path"), "worktree.path"),
    root: path(own(o, "root"), "worktree.root"),
    branch: matches(own(o, "branch"), WORKTREE_BRANCH, "worktree.branch"),
    baseRef: matches(own(o, "baseRef"), BASE_REF, "worktree.baseRef"),
    baseCommit: matches(own(o, "baseCommit"), COMMIT, "worktree.baseCommit"),
    ...(own(o, "kept") === true ? { kept: true as const } : {}),
    ...(own(o, "removed") === true ? { removed: true as const } : {}),
    ...(own(o, "left") === true ? { left: true as const } : {}),
  };
  if (w.path === w.root) fail("worktree: the path is its root");
  if (cwd !== (w.left ? w.root : w.path)) fail("worktree: not the chat's folder");
  return w;
}

/** The applied request ids (ChatLedger.applied): uuids only, the newest 100 kept. */
function appliedIds(v: unknown): string[] {
  if (!Array.isArray(v)) fail("applied: not a list");
  return (v as unknown[]).map((x) => matches(x, UUID, "applied")).slice(-STORE_LIMITS.applied);
}

/** A ledger as a caller hands it to writeChat: a longer title is cut to 120 when it is stored (4.4), then checked. */
export function ledgerForWrite(rec: ChatLedger): ChatLedger {
  const title = rec?.title && typeof rec.title.text === "string" ? { ...rec.title, text: capText(rec.title.text, LIMITS.title) } : rec?.title;
  return ledgerFrom({ ...rec, title });
}

/** The fields that alone are written at most once per 30 s. */
export function sameButActivity(a: ChatLedger, b: ChatLedger): boolean {
  const strip = (r: ChatLedger) => JSON.stringify({ ...r, seenAt: "", lastActivityAt: "", lastSeq: 0 });
  return strip(a) === strip(b);
}

export function projectFrom(raw: unknown): ProjectRecord {
  const o = obj(raw, "project");
  return {
    id: matches(own(o, "id"), PROJECT_ID, "id"),
    cwd: path(own(o, "cwd"), "cwd"),
    name: label(own(o, "name"), "name", STORE_LIMITS.projectName, 1),
    createdAt: time(own(o, "createdAt"), "createdAt"),
    lastUsedAt: time(own(o, "lastUsedAt"), "lastUsedAt"),
    picks: picks(own(o, "picks"), "picks", true),
    // Row 99: the sidebar's place; a bad one reads as none (the last used order), and never fails the project.
    ...orderOf(own(o, "order")),
    // The last command list (D59), model list (row 81), context windows (row 94), provider and start facts (row 97)
    // are caches: one that fails its checks reads as none, and never fails the project.
    ...commandsOf(own(o, "commands")),
    ...modelsOf(own(o, "models")),
    ...(own(o, "worktree") === true ? { worktree: true as const } : {}),
    ...windowsOf(own(o, "contextWindows")),
    ...keptOf(own(o, "account"), own(o, "facts")),
  };
}

function orderOf(v: unknown): Pick<ProjectRecord, "order"> {
  return typeof v === "number" && Number.isSafeInteger(v) ? { order: v } : {};
}

function keptOf(a: unknown, f: unknown): Pick<ProjectRecord, "account" | "facts"> {
  const account = keptAccountFrom(a);
  const facts = keptFactsFrom(f);
  return { ...(account ? { account } : {}), ...(facts ? { facts } : {}) };
}

function windowsOf(v: unknown): Pick<ProjectRecord, "contextWindows"> {
  const contextWindows = contextWindowsFrom(v);
  return contextWindows ? { contextWindows } : {};
}

function commandsOf(v: unknown): Pick<ProjectRecord, "commands"> {
  const commands = projectCommandsFrom(v);
  return commands ? { commands } : {};
}

function modelsOf(v: unknown): Pick<ProjectRecord, "models"> {
  const models = projectModelsFrom(v);
  return models ? { models } : {};
}

/** `projects.json`: one project per id and per folder. */
export function projectsFrom(raw: unknown): ProjectsFile {
  const o = obj(raw, "projects file");
  v1(o, "projects file");
  const list = own(o, "projects");
  if (!Array.isArray(list)) fail("projects: not an array");
  const projects = (list as unknown[]).map(projectFrom);
  if (new Set(projects.map((p) => p.id)).size !== projects.length) fail("projects: an id twice");
  if (new Set(projects.map((p) => p.cwd)).size !== projects.length) fail("projects: a folder twice");
  return { v: 1, projects };
}

// ---------------------------------------------------------------------------------------------------------------
// settings.json

type FixedKey = Exclude<keyof Settings, `chats.untypedMethods.${string}`>;

const intAtLeast = (min: number) => (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= min;
const isBool = (v: unknown) => typeof v === "boolean";
const inList = (list: readonly unknown[]) => (v: unknown) => list.includes(v);

const SETTING_RULES: Record<FixedKey, (v: unknown) => boolean> = {
  "chats.keepIdleMinutes": intAtLeast(0),
  "chats.maxLive": intAtLeast(1),
  "chats.allowBypass": isBool,
  "chats.generateTitles": isBool,
  "chats.bashReply": inList(["follow-cli", "always", "never"]),
  "chats.rememberMode": isBool,
  "chats.newChats": inList(["last", "defaults"]),
  "chats.sessionsFromOtherApps": isBool,
  "chats.sessionsOpenElsewhere": isBool,
  "claudeCode.prefer": inList(["path"]),
  "appearance.look": inList(["glass", "paper", "mono", "editor"] satisfies LookId[]),
  "uploads.folder": inList(["temp", "state", "claude", "custom"] satisfies UploadFolderChoice[]),
  "uploads.customFolder": (v) => v === null || isCleanPath(v),
  "uploads.maxMB": intAtLeast(1),
  "uploads.keepDays": intAtLeast(1),
  "updates.check": inList([...UPDATE_CHECKS]),
  "browser.enabled": isBool,
};

/** `chats.untypedMethods.<name>`: one switch per untyped Claude Code method (D6). */
const UNTYPED_KEY = /^chats\.untypedMethods\.[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** Whether `key` is a setting and `value` passes its rule. */
export function settingOk(key: string, value: unknown): boolean {
  if (UNTYPED_KEY.test(key)) return typeof value === "boolean";
  const rule = Object.prototype.hasOwnProperty.call(SETTING_RULES, key) ? SETTING_RULES[key as FixedKey] : undefined;
  return rule !== undefined && rule(value);
}

export function isSettingKey(key: string): boolean {
  return UNTYPED_KEY.test(key) || Object.prototype.hasOwnProperty.call(SETTING_RULES, key);
}

/**
 * `settings.json`: the keys the file sets (an absent key has its default). A bad value fails the file; a key that this
 * version does not know is dropped, so a setting that a later version removes never fails an older file.
 */
export function settingsFrom(raw: unknown): Partial<Settings> {
  const o = obj(raw, "settings");
  const out: Record<string, unknown> = {};
  for (const [k, kept] of Object.entries(o)) {
    if (!isSettingKey(k)) continue;
    if (!settingOk(k, kept)) fail(`${k}: bad value`);
    out[k] = kept;
  }
  return out as Partial<Settings>;
}

export function withDefaults(explicit: Partial<Settings>): Settings {
  return { ...SETTINGS_DEFAULTS, ...explicit } as Settings;
}

// ---------------------------------------------------------------------------------------------------------------
// drafts/<id>.json

export function draftFrom(raw: unknown, fileId?: string, fileBox?: DraftBox): DraftRecord {
  const o = obj(raw, "draft");
  v1(o, "draft");
  const id = matches(own(o, "id"), CHAT_ID, "id");
  if (fileId !== undefined && id !== fileId) fail("id: does not match the file name");
  // FIX-U2: the side chat's box's draft says so (its own file, next to the side thread); one that does not is the
  // message box's. A record read from a file must be that file's box.
  const rawBox = own(o, "box");
  const box: DraftBox = rawBox === undefined ? "main" : oneOf(rawBox, ["side"] as const, "box");
  if (fileBox !== undefined && box !== fileBox) fail("box: not the box of this file");
  const text = own(o, "text");
  if (typeof text !== "string" || text.length > LIMITS.draftText) fail("text: not a string of at most 20,000 units");
  const mode = oneOf(own(o, "mode"), DRAFT_MODES, "mode");
  const command = nullable(own(o, "command"), (x) => label(x, "command", LIMITS.draftCommand));
  if (command !== null && mode !== "slash") fail("command: only in slash mode");
  const uploads = own(o, "uploads");
  if (!Array.isArray(uploads) || uploads.length > LIMITS.draftUploads) fail("uploads: not an array of at most 100");
  // A file from before v0.3 has no mentions key: none. Repeats are dropped, the order kept; the reason names no path.
  const mentions = mentionsOf(own(o, "mentions"), LIMITS.draftMentions) ?? fail("mentions: not a list of at most 100 paths relative to the chat's folder");
  if (box === "side" && (mode !== "chat" || (uploads as unknown[]).length > 0 || mentions.length > 0)) fail("box: the side box's draft is plain text, with no chip, upload or mention");
  return {
    v: 1,
    id,
    ...(box === "side" ? { box } : {}),
    rev: int(own(o, "rev"), "rev", 0),
    text: text as string,
    mode,
    command,
    link: bool(own(o, "link"), "link"),
    uploads: (uploads as unknown[]).map((u) => matches(u, UPLOAD_ID, "uploads[]")),
    ...(mentions.length ? { mentions } : {}),
    by: nullable(own(o, "by"), (x) => matches(x, TAB_ID, "by")),
    at: time(own(o, "at"), "at"),
  };
}

/**
 * A draft as a caller hands it to saveDraft, held to its caps: the text cut at 20,000 UTF-16 units (never inside a
 * surrogate pair), the `/` chip in slash mode only and cut at 120, at most 100 uploads and 100 mentions. Then checked.
 */
export function draftForSave(rec: DraftRecord): DraftRecord {
  const text = typeof rec?.text === "string" ? capText(rec.text, LIMITS.draftText) : rec?.text;
  const command = rec?.mode === "slash" && typeof rec.command === "string" ? capText(rec.command, LIMITS.draftCommand) : null;
  const uploads = Array.isArray(rec?.uploads) ? rec.uploads.slice(0, LIMITS.draftUploads) : rec?.uploads;
  const mentions = Array.isArray(rec?.mentions) ? rec.mentions.slice(0, LIMITS.draftMentions) : rec?.mentions;
  return draftFrom({ ...rec, text, command, uploads, mentions });
}

// ---------------------------------------------------------------------------------------------------------------
// uploads.json (the upload records; the files themselves are in their u-XXXXXX folders)

/** A folder that mkdtemp made for one upload: `u-` and six letters or digits. */
export const UPLOAD_DIR_RE = /^u-[A-Za-z0-9]{6}$/;
/** The longest file name most file systems take (Linux, macOS): 255 bytes of UTF-8. */
export const NAME_MAX_BYTES = 255;
/** What a saved name never holds: a slash, a backslash, or a character of CONTROL_CHARS (C0, DEL, C1, bidi marks). */
export const UNSAFE_NAME = new RegExp(`[/\\\\]|${CONTROL_CHARS.source}`);

export function isSavedName(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length > 0 &&
    !/^\.+$/.test(v) &&
    !UNSAFE_NAME.test(v) &&
    new TextEncoder().encode(v).byteLength <= NAME_MAX_BYTES
  );
}

export function uploadFrom(raw: unknown): UploadRecord {
  const o = obj(raw, "upload");
  v1(o, "upload");
  const name = own(o, "name");
  if (!isSavedName(name)) fail("name: not a saved name");
  const dir = path(own(o, "dir"), "dir");
  if (!UPLOAD_DIR_RE.test(basename(dir))) fail("dir: not an upload folder");
  const filePath = path(own(o, "path"), "path");
  if (filePath !== join(dir, name as string)) fail("path: not the name inside dir");
  // Round K1: the path before the folder move, which earlier messages' references hold; the same name.
  const was = own(o, "was") === undefined ? undefined : path(own(o, "was"), "was");
  if (was !== undefined && basename(was) !== name) fail("was: not the same name");
  const chat = nullable(own(o, "chat"), (x) => matches(x, CHAT_ID, "chat"));
  // Iteration 7: the browser pane's own upload has no project, and so no chat.
  const project = nullable(own(o, "project"), (x) => matches(x, PROJECT_ID, "project"));
  if (project === null && chat !== null) fail("project: a chat's upload names its project");
  return {
    v: 1,
    id: matches(own(o, "id"), UPLOAD_ID, "id"),
    chat,
    project,
    name: name as string,
    size: int(own(o, "size"), "size", 0),
    type: label(own(o, "type"), "type", 255),
    path: filePath,
    folder: oneOf(own(o, "folder"), ["temp", "state", "claude", "custom"] as const, "folder"),
    dir,
    at: time(own(o, "at"), "at"),
    ...(was !== undefined ? { was } : {}),
  };
}

export interface UploadsFile {
  v: 1;
  uploads: UploadRecord[];
}

export function uploadsFileFrom(raw: unknown): UploadsFile {
  const o = obj(raw, "uploads file");
  v1(o, "uploads file");
  const list = own(o, "uploads");
  if (!Array.isArray(list)) fail("uploads: not an array");
  const uploads = (list as unknown[]).map(uploadFrom);
  if (new Set(uploads.map((u) => u.id)).size !== uploads.length) fail("uploads: an id twice");
  return { v: 1, uploads };
}

// ---------------------------------------------------------------------------------------------------------------
// last-options.json

export function lastOptionsFrom(raw: unknown): LastOptionsRecord {
  const o = obj(raw, "last options");
  v1(o, "last options");
  const marks = obj(own(o, "marks"), "marks");
  for (const [k, m] of Object.entries(marks)) label(m, `marks.${k}`, MARK_MAX, 1);
  return {
    v: 1,
    writtenAt: time(own(o, "writtenAt"), "writtenAt"),
    sdk: label(own(o, "sdk"), "sdk", 40, 1),
    chat: matches(own(o, "chat"), CHAT_ID, "chat"),
    options: obj(own(o, "options"), "options"),
    marks: marks as Record<string, string>,
  };
}
