// The JSON API under /api/ (DESIGN.md 4.3, 4.9; the shapes are in api-types.ts). Mutating routes pass the sender gate
// (guard 3); reads pass the Origin check of D52 when they carry an Origin (the Host allowlist ran before, in app.ts).
// No GET changes anything the user made (principle 3); the two GETs that start work, a project's command list (D59)
// and Claude Code's model list (row 81), only fill a cache. A path never goes into a log: a line holds at most the
// route pattern.

import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { isAgentRef, isBgId, isBrowserDownloadId, isChangesId, isChatId, isProjectId, isUploadId, isUuid, newProjectId, newUploadId } from "../../shared/ids";
import type { BrowserDownloadsReply, BrowserDownloadView, BrowserReply } from "../../shared/browser";
import { otherSite } from "../browser/guard";
import { CHANGES_MISSING, type ChangesMissing, type ChangesMissingState, type ChangesSummary, type FileDiff } from "../../shared/changes";
import type { ChangesBook } from "../changes/book";
import { CONTROL_CHARS, ERROR_MESSAGES, LIMITS, WIRE, type BackgroundViewReply } from "../../shared/protocol";
import { readCorpusQuery, readSearchQuery } from "../../shared/corpus";
import { readMessageSearchQuery, type MessageSearchReply } from "../../shared/message-search";
import { isSafeRelativePath } from "../../shared/route";
import { PUSH_LIMITS, isPushDeviceId } from "../../shared/push";
import { accessHint, allowedOrigins, type Adapters, type AllowedOrigin } from "../adapters/adapters";
import type { AgentDriver, EnvVar, SessionOpen } from "../agents/types";
import { fromTerminal } from "../chats/lists";
import { readOriginPasses, senderHeader, senderPasses, type BodyKind, type Gate } from "../gate/guards";
import type { Logger } from "../log";
import { StoreError } from "../store/files";
import type { ChatLedger, ProjectRecord, Settings, Store, UploadRecord } from "../store/types";
import { STORE_LIMITS } from "../store/types";
import type {
  ApiErrorCode,
  DrainAnswer,
  ExistsReply,
  HealthReply,
  ProjectCommandsReply,
  ProjectModelsReply,
  ProjectView,
  PushDeviceReply,
  PushKeyReply,
  PushRemovedReply,
  PushReply,
  RestartAccepted,
  RestartCancelReply,
  RestartReply,
  RestartWhen,
  SessionHidden,
  SessionPreviewReply,
  SessionsReply,
  SessionView,
  SettingsReply,
  SuggestedFolder,
  SuggestedFoldersReply,
  UpdateAccepted,
  UpdateReply,
  UploadFolderView,
  UploadView,
  ChatWorktreeReply,
  WorktreeCanReply,
  WorktreeOff,
} from "./api-types";
import { contentDisposition, downloadTarget, fileDownload, folderArchive, FOLDER_LIMITS, probeTarget, type DownloadTarget } from "./files";
import { forbidden, jsonResponse, type SafeHeaders } from "./headers";
import { ownUid } from "../store/files";
import { folderPath, listFolders } from "../folders/list";
import { removeUploadDir, tooLargeLine, uploadCapBytes, UploadError, writeUpload, type UploadFolderResult } from "../store/uploads";
import { CorpusCache, type CorpusService } from "../search/cache";
import type { MessageSearch } from "../search/messages";
import { abortedResponse, corpusListResponse } from "../search/http";
import { ProjectCommands } from "../chats/project-commands";
import { ModelList, MODELS_ROUTE } from "../chats/models";
import { factsFor, newestAccount } from "../chats/facts";
import { WorktreeHost, sessionFolder } from "../worktree/host";
import { WORKTREE_OFF_LINES } from "../worktree/ops";
import { ENV_NOT_SAVED, ENV_ROUTE, envChangeOf, envReply, type EnvBook } from "../env/api";
import { markedVars } from "../env/child";
import { ENV_LIMITS } from "../env/names";
import { REMOVE_BUSY, folderSessions, type EditResult, type Environments } from "../chats/environments";
import { projectOrder, topOrder } from "../store/order";
import type { ReleasedSession } from "../store/released";
import type { PushApi } from "../push/service";

export const API_ROUTE_PATTERNS = [
  "/api/projects",
  "/api/projects/:project/forget",
  "/api/projects/:project/worktree",
  "/api/projects/:project/env",
  "/api/projects/:project/rename",
  "/api/projects/:project/move",
  "/api/projects/:project/remove",
  "/api/projects/:project/sessions",
  "/api/projects/:project/sessions/:session",
  "/api/projects/:project/commands",
  "/api/projects/:project/models",
  "/api/projects/:project/corpus",
  "/api/projects/:project/corpus/search",
  "/api/settings",
  "/api/upload-folder",
  "/api/uploads",
  "/api/uploads/:upload",
  "/api/chats/:chat/uploads",
  "/api/chats/:chat/uploads/:upload/file",
  "/api/chats/:chat/uploads/:upload/exists",
  "/api/chats/:chat/files/*",
  "/api/chats/:chat/exists/*",
  "/api/chats/:chat/corpus",
  "/api/chats/:chat/corpus/search",
  "/api/chats/:chat/worktree",
  "/api/chats/:chat/background/:id",
  "/api/chats/:chat/changes/:turn",
  "/api/chats/:chat/changes/:turn/files/*",
  "/api/chats/:chat/tools/:tool/output",
  "/api/chats/:chat/tools/:tool/output/exists",
  "/api/search",
  "/api/folders",
  "/api/folders/suggested",
  "/api/folders/worktree",
  "/api/health",
  "/api/restart",
  "/api/restart/cancel",
  "/api/update",
  "/api/update/check",
  "/api/push",
  "/api/push/key",
  "/api/push/devices",
  "/api/push/devices/:device",
  "/api/push/devices/:device/remove",
  "/api/browser",
  "/api/browser/start",
  "/api/browser/stop",
  "/api/browser/clear",
  "/api/browser/downloads",
  "/api/browser/downloads/:download/file",
  "/api/browser/downloads/:download/remove",
] as const;

export interface ApiDeps {
  gate: Gate;
  safe: SafeHeaders;
  store: Pick<Store, "listProjects" | "putProject" | "readSettings" | "readChat" | "listUploads" | "putUpload" | "removeUpload">;
  /**
   * `readCommands` is the new-chat form's short command-list read (D59), `readModels` the model-list read (row 81);
   * absent: none is read.
   */
  driver: Pick<AgentDriver, "probe" | "settings" | "listSessions" | "history" | "sessionInfo"> &
    Partial<Pick<AgentDriver, "readCommands" | "readModels" | "readWindows" | "openSessions" | "settingsEnvNames" | "listReleased" | "toolOutput">>;
  /**
   * The store's upload folder for an upload of this chat (or of the new-chat form, `chat` null): made where its rule
   * says and checked now (4.4), or the line of 4.4 that says why not.
   */
  uploadFolder(input: { chat: ChatLedger | null; project: ProjectRecord | null; settings: Settings }): Promise<UploadFolderResult>;
  /** The kitespan chat that has this Claude Code session (the registry's index, D49), or null. */
  chatForSession(sessionId: string): string | null;
  /** D58: the newest chat that holds a copy of this session (Continue in a copy), or null; absent: none known. */
  copyForSession?(sessionId: string): string | null;
  /** Every session id that a kitespan chat has ("From the terminal" leaves them out). */
  heldSessions(): ReadonlySet<string>;
  /**
   * R131: the read-only view's read of a background session that a launch row of the chat printed (the registry's
   * backgroundView); null when the chat or the session is not there. Absent: no such route answers.
   */
  backgroundView?(chat: string, id: string, q: { since: string | null; before: string | null }): Promise<BackgroundViewReply | null>;
  /** `allowed`: the origins in force beyond kitespan's own (`--origin`'s, then the file's); absent, the file's. */
  info: { port: number; version: string; adapters: Adapters; allowed?: readonly AllowedOrigin[] };
  /**
   * Settings writes (POST /api/settings): the store's checked write of kitespan's own settings, then `reload`, which
   * makes the registry read them again (the idle limit and the cap apply at once). Absent: settings are read only.
   */
  settingsWriter?: { write(change: Partial<Settings>): Promise<Settings>; reload(): Promise<void> };
  /**
   * Settings > Account: the provider that a live chat's Claude Code reports, or null when no chat is live. `project`:
   * the Settings' project (`?project=`), or null for the host's (D60: a project with variables answers for itself).
   */
  account?: (project: string | null) => Promise<{ provider: string | null } | null>;
  logger?: Pick<Logger, "log"> | null;
  now?: () => Date;
  folderLimits?: { entries: number; bytes: number };
  /** The user's home folder, for a folder typed from it as `~/...` and the start of Browse; default: the system's. */
  home?: string;
  /** New environment's Suggested (D54, server/folders/suggest.ts); absent: no suggestions. */
  suggestedFolders?: () => Promise<SuggestedFolder[]>;
  /** The chat folders' corpora (9.3, server/search/cache.ts); absent: a cache of this API's own, logging to `logger`. */
  corpus?: CorpusService;
  /** U5: the message search over every chat's text (server/search/messages.ts); absent: GET /api/search is not here. */
  messages?: MessageSearch;
  /**
   * The projects' last command lists (D59, server/chats/project-commands.ts); absent: one of this API's own, on its
   * store, reading through `driver.readCommands`.
   */
  projectCommands?: ProjectCommands;
  /**
   * Claude Code's model list (row 81, server/chats/models.ts), kept with the projects; absent: one of this API's own, on
   * its store, reading through `driver.readModels`.
   */
  modelList?: ModelList;
  /**
   * Whether the API's own lists (projectCommands, modelList absent) may start a short read now: none while the restart
   * drains or the server closes (the registry's mayRead); absent: always.
   */
  mayRead?: () => boolean;
  /** The boot epoch, for GET /api/health (the restart's health gate); absent: the route is not here. */
  epoch?: () => string;
  /** The restart (4.10): About's lines, the panes, the preflight and the registry's drain; absent: no restart route. */
  restart?: RestartDeps;
  /** Row 73: kitespan's own worktree git (server/worktree/host.ts); absent: one of this API's own, on the start environment. */
  worktrees?: WorktreeHost;
  /**
   * D60: the environments' variables (server/env/store.ts): the env routes, each project view's count, and the short
   * reads' variables. Absent: no environment has any, and the env routes are not here.
   */
  env?: EnvBook;
  /** D60: a project's variables changed (the env route's save): the registry's model list forgets its reads (L37). */
  envChanged?: (project: string) => void;
  /** Row 99: an environment's Rename, Move and Remove (chats/environments.ts); absent: those routes are not here. */
  environments?: Environments;
  /**
   * Row 99: the sessions that a removed environment released from this folder, each with the folder that holds its
   * transcript (store/released.ts); absent: none.
   */
  releasedOf?: (cwd: string) => readonly ReleasedSession[];
  /** Row 108: the update (server/update/): About's facts, Check now and the Update button's job; absent: no update route. */
  update?: UpdateDeps;
  /** R130: notifications (server/push/service.ts): the key and the devices; absent: the push routes are not here. */
  push?: PushApi;
  /** U1: the turns' changes (server/changes/book.ts): a summary and a file's diff; absent: no turn's changes are kept. */
  changes?: ChangesBook;
  /** Iteration 7: the shared browser (server/browser/): Settings > Browser and its downloads; absent: no browser route. */
  browser?: BrowserApi;
}

/** What the browser routes need (main.ts wires them to server/browser/host.ts and downloads.ts). */
export interface BrowserApi {
  reply(): BrowserReply;
  /** The user's Start: browser.enabled on, then the start, which goes on after the answer (the socket says how it went). */
  start(): Promise<BrowserReply>;
  stop(): Promise<BrowserReply>;
  /** Clear browsing data; null: the browser did not stop, so nothing was cleared. */
  clear(): Promise<BrowserReply | null>;
  downloads(): BrowserDownloadView[];
  /** A saved download's file: its path in the downloads folder, its shown name. */
  downloadFile(id: string): { path: string; name: string } | null;
  removeDownload(id: string): Promise<boolean>;
}

/** What the update routes need from the server (main.ts wires them to server/update/updates.ts and job.ts). */
export interface UpdateDeps {
  /** About's update facts now. */
  facts(): Promise<UpdateReply>;
  /** Check now: one check of origin, then the facts. */
  check(): Promise<UpdateReply>;
  /** The Update button: the job starts, or the one that runs is joined; else the refusal's one line. */
  start(): Promise<{ ok: true; job: UpdateAccepted["job"] } | { ok: false; line: string }>;
}

/** What the restart routes need from the server (main.ts wires them; the drain is the registry's). */
export interface RestartDeps {
  /** About's lines now: origin's from the last check, the build stamp's against the checkout's HEAD (S3, S4). */
  facts(): Promise<Pick<RestartReply, "update" | "build">>;
  /** S15: the chats whose Terminal pane runs a program, or may. */
  panes(): RestartReply["panes"];
  /**
   * A restart's close runs now (not a shutdown's): an ask is that restart, answered at once without the preflight,
   * which would replace the successor's server-out.log. Absent: never.
   */
  closing?(): boolean;
  /**
   * Row 108: an ask begins (before its preflight); the release it returns ends it (after the drain's answer, or a
   * refusal). Meanwhile no update starts (main.ts: the update job's `restarting`), so none can begin between the
   * preflight's look for one and the drain. Absent: nothing to tell.
   */
  asking?(): () => void;
  /** S8: null when the code on disk can start; else the one line of the refusal. */
  preflight(): Promise<string | null>;
  /** S9 (the registry's): start the drain for `when`. */
  drain(when: RestartWhen): DrainAnswer | Promise<DrainAnswer>;
  /** Cancel restart: true when a drain that waited was undone. */
  undrain(): boolean | Promise<boolean>;
}

export interface Api {
  handle(req: Request, url: URL): Promise<Response>;
}

interface Ctx {
  req: Request;
  url: URL;
  params: Record<string, string>;
  head: boolean;
}
type Run = (c: Ctx) => Promise<Response>;
interface Route {
  pattern: (typeof API_ROUTE_PATTERNS)[number];
  /** The `*` takes any rest of the path, unsafe ones too, which its handler answers itself (the existence probe). */
  anyPath?: boolean;
  get?: Run;
  post?: { body: BodyKind; run: Run };
  del?: Run;
}

const PARAMS: Record<string, (v: string) => boolean> = { project: isProjectId, chat: isChatId, upload: isUploadId, session: isUuid, id: isBgId, device: isPushDeviceId, turn: isChangesId, download: isBrowserDownloadId, tool: isAgentRef };

/** The name a tool output's download is saved under. */
const toolOutputName = (tool: string) => `${tool}-output.txt`;

const MESSAGES = {
  route: "There is no such kitespan API route.",
  chat: "That chat is not here. It may have been deleted.",
  project: "That project is not here.",
  folder: "That folder does not exist.",
  session: "That session is not in this project's folder.",
  file: "That file is not in this chat's folder.",
  /** T-26: the 5.4 line of a tool id that is not in the chat (a tool output that the transcript does not hold). */
  tool: "That message is not in this chat.",
  upload: "That upload is not here.",
  /** R131: the 5.4 line of a link to a background session that the chat did not print, or that Claude Code no longer lists. */
  background: "That background session is not in this chat.",
  folderTooLarge: `That folder is too large to download as one archive (at most ${FOLDER_LIMITS.entries.toLocaleString("en-US")} files and ${FOLDER_LIMITS.bytes / 1024 ** 3} GB).`,
  saveFailed: "kitespan could not save that file.",
  failed: "That did not work.",
  method: "That method is not allowed here.",
  bad: "That request could not be read.",
  /** U1: the 5.4 lines of a turn's changes and of a file's diff that are not there, and the diff's failed read. */
  noTurn: "These changes are no longer kept.",
  noFile: "That file is not in this turn's changes.",
  diffGone: "This diff is no longer available.",
  diffFailed: "This diff could not be read.",
  /** R130: a device id that the server does not have (turned off, or gone at its push service). */
  device: "That device is not here.",
  /** R130: a subscription whose push service is not one of the list (DESIGN-R130 4.5's turn-on line). */
  pushService: "kitespan does not send to this browser's push service.",
  pushDevices: `kitespan sends notifications to at most ${PUSH_LIMITS.devices} devices. Turn one off first.`,
  /** Iteration 7 (DESIGN-B1 4.14): Clear browsing data when the browser did not stop. */
  browserRunning: "The browser did not stop, so nothing was cleared.",
  download: "That download is not here.",
};

const STATUS: Partial<Record<ApiErrorCode, number>> = { bad_request: 400, not_found: 404, archived: 409, busy: 409, upload_folder: 409, preflight: 409, update_refused: 409, restarting: 409, too_large: 413, failed: 500, push_service: 400, gone: 410, browser_running: 409 };

const NONE_OPEN: ReadonlyMap<string, SessionOpen> = new Map();
/** D58: a session row's `open` while another process has the session open; nothing when none has. */
function openOf(open: ReadonlyMap<string, SessionOpen>, sessionId: string): { open?: SessionOpen } {
  const o = open.get(sessionId);
  return o ? { open: { app: o.app, busy: o.busy, ...(o.waiting ? { waiting: true } : {}) } } : {};
}

/** Row 77: the preview of a session that a setting in Settings > Chats hides: which setting, and nothing of the session. */
function hiddenPreview(hidden: SessionHidden): SessionPreviewReply {
  return { history: [], more: null, chat: null, copy: null, hidden };
}

/** `env`: D60, how many variables the project's environment has; `envUnreadable`: its file cannot be read (L39). */
function projectView(p: ProjectRecord, worktreeOff: WorktreeOff | null, env = 0, envUnreadable = false): ProjectView {
  return {
    id: p.id,
    name: p.name,
    cwd: p.cwd,
    createdAt: p.createdAt,
    lastUsedAt: p.lastUsedAt,
    picks: { model: p.picks.model?.value ?? null, effort: p.picks.effort?.value ?? null, permissionMode: p.picks.permissionMode?.value ?? null },
    worktree: p.worktree === true,
    worktreeOff,
    env,
    ...(envUnreadable ? { envUnreadable: true as const } : {}),
  };
}

function uploadView(u: UploadRecord): UploadView {
  return { id: u.id, chat: u.chat, project: u.project, name: u.name, size: u.size, type: u.type, path: u.path, ...(u.was !== undefined ? { was: u.was } : {}) };
}

const folderView = (f: UploadFolderResult | UploadFolderView): UploadFolderView => (f.ok ? { ok: true, path: f.path } : { ok: false, line: f.line });

/** A browser's MIME type when it has the plain `type/subtype` form, lowercase; else "". */
export function uploadType(raw: string | null): string {
  const t = (raw ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/.test(t) ? t : "";
}

/** Decode a path's segments; null when one does not decode. */
function segments(pathname: string): string[] | null {
  try {
    return pathname.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
}

/** The largest JSON body a mutating route reads, in bytes. */
export const JSON_BODY_CAP = 16 * 1024;

/**
 * A request body of at most `max` bytes, or null when it is longer or breaks off. It is read as a stream and the read
 * stops at the first byte over `max`, so a body with no Content-Length (chunked) is never held whole.
 */
export async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        return null;
      }
      parts.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** A locked body's chunks; stopping early (the cap, a failed write) cancels the rest. */
async function* readerChunks(reader: { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void>; releaseLock(): void }): AsyncGenerator<Uint8Array> {
  let done = false;
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done || !r.value) {
        done = true;
        return;
      }
      yield r.value;
    }
  } finally {
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function matchRoute(pattern: string, segs: readonly string[], anyPath = false): Record<string, string> | null {
  const pat = pattern.split("/").filter(Boolean);
  const params: Record<string, string> = {};
  for (let i = 0; i < pat.length; i++) {
    const p = pat[i]!;
    if (p === "*") {
      const rest = segs.slice(i).join("/");
      if (!anyPath && !isSafeRelativePath(rest)) return null;
      params.path = rest;
      return params;
    }
    const s = segs[i];
    if (s === undefined) return null;
    if (p.startsWith(":")) {
      if (!PARAMS[p.slice(1)]?.(s)) return null;
      params[p.slice(1)] = s;
    } else if (p !== s) return null;
  }
  return segs.length === pat.length ? params : null;
}

export function createApi(deps: ApiDeps): Api {
  const { gate, safe, store, driver } = deps;
  const now = deps.now ?? (() => new Date());
  const limits = deps.folderLimits ?? FOLDER_LIMITS;
  const log = deps.logger ?? null;
  const uid = ownUid();
  const corpus = deps.corpus ?? new CorpusCache({ log });
  // D60 (L38): a short read gets its project's variables (one project per folder); a project whose variables cannot
  // be read starts none (L39), and the read fails as one that did not start.
  const envOfFolder = async (cwd: string) => {
    const p = deps.env ? (await store.listProjects()).find((x) => x.cwd === cwd) : undefined;
    const vars = p ? deps.env!.vars(p.id) : [];
    if (vars === null) throw Object.assign(new Error("env_unreadable"), { code: "env_unreadable" });
    return markedVars(vars, now());
  };
  const readCommands = driver.readCommands ? async (cwd: string) => driver.readCommands!(cwd, await envOfFolder(cwd)) : null;
  const projectCommands = deps.projectCommands ?? new ProjectCommands({ store, read: readCommands, ...(deps.mayRead ? { may: deps.mayRead } : {}), now, log });
  const readModels = driver.readModels ? (cwd: string, vars: readonly EnvVar[]) => driver.readModels!(cwd, markedVars(vars, now())) : null;
  // Row 94: the same read's context windows are kept too (ChatRegistry's ModelList reads them as well), with the same
  // variables (D60).
  const windows = driver.readWindows ? (cwd: string, vars: readonly EnvVar[]) => driver.readWindows!(cwd, markedVars(vars, now())) : null;
  const modelList =
    deps.modelList ??
    new ModelList({
      store,
      read: readModels,
      windows,
      ...(deps.env ? { vars: (p: string) => deps.env!.vars(p) } : {}),
      ...(deps.mayRead ? { may: deps.mayRead } : {}),
      now,
      onError: (err) => log?.log("error", { route: MODELS_ROUTE, err }),
    });

  const ok = (body: unknown, status = 200) => jsonResponse(safe, body, status);
  const fail = (code: ApiErrorCode, message: string, extra: Record<string, string> = {}) =>
    jsonResponse(safe, { error: { code, message } }, STATUS[code] ?? 400, extra);
  const badRequest = () => fail("bad_request", MESSAGES.bad);
  /** U1: a turn's changes, or a file of them, that are not there: the error, with its case for the page (shared/changes.ts). */
  const changesMissing = (state: ChangesMissingState) => {
    const message = state === "no_turn" ? MESSAGES.noTurn : state === "no_file" ? MESSAGES.noFile : MESSAGES.diffGone;
    const body: ChangesMissing = { error: { code: state === "gone" ? "gone" : "not_found", message }, state };
    return jsonResponse(safe, body, CHANGES_MISSING[state]);
  };

  /** D58: the sessions open in other processes; a registry that cannot be read counts as none open. */
  const openSessions = async (): Promise<ReadonlyMap<string, SessionOpen>> => {
    try {
      return (await driver.openSessions?.()) ?? NONE_OPEN;
    } catch {
      return NONE_OPEN;
    }
  };

  /** Project table changes, one after another (two adds of one folder at once make one project). */
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };

  const findProject = async (id: string) => (await store.listProjects()).find((p) => p.id === id) ?? null;

  // Row 73 (W2): the Worktree option's off reasons are read for each project view: git's reads of its folder and its
  // Claude Code settings' WorktreeCreate hook.
  const worktrees = deps.worktrees ?? new WorktreeHost();
  const offOf = (cwd: string) => worktrees.off(cwd, () => driver.settings(cwd)).catch((): WorktreeOff => "not_git");
  const envCount = (id: string) => deps.env?.count(id) ?? 0;
  /** D60: the project's variables, or a file that cannot be read, can change the provider (ModelList.own's rule). */
  const ownEnv = (id: string) => {
    const vars = deps.env ? deps.env.vars(id) : [];
    return vars === null || vars.length > 0;
  };
  const envUnreadable = (id: string) => deps.env?.view(id).unreadable === true;
  const view = async (p: ProjectRecord): Promise<ProjectView> => projectView(p, await offOf(p.cwd), envCount(p.id), envUnreadable(p.id));

  /** Row 99: an environment edit's answer, or its refusal with the route's own line. */
  const edited = async <T>(r: EditResult<T>, body: (value: T) => unknown): Promise<Response> => {
    if (r.ok) return ok(await body(r.value));
    if (r.code === "busy") return fail("busy", REMOVE_BUSY);
    return fail(r.code, r.code === "not_found" ? MESSAGES.project : r.code === "failed" ? MESSAGES.failed : MESSAGES.bad);
  };

  /** The Settings reply (GET, and the answer to a write): `?project=` adds that folder's own Claude Code settings. */
  async function settingsReply(url: URL): Promise<Response> {
    const settings = await store.readSettings();
    const projectId = url.searchParams.get("project");
    const projects = await store.listProjects();
    const project = projectId !== null && isProjectId(projectId) ? (projects.find((p) => p.id === projectId) ?? null) : null;
    const [probe, folder, agent, account] = await Promise.all([
      driver.probe().catch(() => null),
      deps.uploadFolder({ chat: null, project, settings }).catch((): UploadFolderView => ({ ok: false, line: MESSAGES.failed })),
      project ? driver.settings(project.cwd).catch(() => null) : Promise.resolve(null),
      deps.account ? deps.account(project?.id ?? null).catch(() => null) : Promise.resolve(null),
    ]);
    const { adapters } = deps.info;
    const allowed = deps.info.allowed ?? allowedOrigins(deps.info.port, [], adapters.origins);
    const reply: SettingsReply = {
      settings: settings as unknown as Record<string, unknown>,
      server: { host: "127.0.0.1", port: deps.info.port, auth: "none", version: deps.info.version },
      access: { origins: allowed.map((a) => a.origin), hint: accessHint(deps.info.port, adapters, allowed), phoneLink: adapters.phoneLink },
      adaptersProblem: adapters.problem,
      phoneNotes: adapters.phoneNotes,
      claude: {
        ok: probe?.ok ?? false,
        path: probe?.path ?? null,
        realpath: probe?.realpath ?? null,
        version: probe?.version ?? null,
        drift: probe?.drift ?? null,
        ...(probe?.belowMinimum ? { belowMinimum: probe.belowMinimum } : {}),
      },
      uploads: folderView(folder),
      agent,
      // Row 97: with no chat live, the provider and the start facts kept last (server/chats/facts.ts); D60: a project
      // with variables answers for itself alone.
      account: account ? { provider: account.provider, at: null } : (newestAccount(projects, project?.id ?? null, ownEnv) ?? null),
      facts: factsFor(projects, project?.id ?? null, ownEnv),
    };
    return ok(reply);
  }

  /** Settings writes, one after another, so two pages that save at once both land (the last one wins per key). */
  let settingsChain: Promise<unknown> = Promise.resolve();

  /** Restart requests, one after another: a second one waits for the first one's preflight and drain. */
  let restartChain: Promise<unknown> = Promise.resolve();
  const restartSerial = (fn: () => Promise<Response>): Promise<Response> => {
    const p = restartChain.then(fn, fn);
    restartChain = p.catch(() => {});
    return p;
  };

  /** A small JSON body (a mutating route's), or undefined when it is not one. */
  async function readJson(req: Request, max = JSON_BODY_CAP): Promise<unknown> {
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > max) return undefined;
    const bytes = await readCapped(req.body, max);
    if (!bytes) return undefined;
    const text = new TextDecoder().decode(bytes);
    if (!text.trim()) return {};
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  /**
   * The chat (`?chat=`) or the new-chat form's project (`?project=`) an upload belongs to, or (iteration 7,
   * `?browser=1`) the browser pane's own: a file chooser's answer with no chat in reach, owned by no chat or project.
   */
  async function uploadOwner(url: URL): Promise<{ chat: ChatLedger | null; project: ProjectRecord | null } | Response> {
    const chatId = url.searchParams.get("chat");
    const projectId = url.searchParams.get("project");
    const browser = url.searchParams.get("browser");
    if ([chatId, projectId, browser].filter((x) => x !== null).length !== 1) return badRequest();
    if (browser !== null) return browser === "1" ? { chat: null, project: null } : badRequest();
    if (chatId !== null) {
      if (!isChatId(chatId)) return badRequest();
      const chat = await store.readChat(chatId);
      if (!chat) return fail("not_found", MESSAGES.chat);
      if (chat.archivedAt !== null) return fail("archived", "This chat is archived.");
      const project = await findProject(chat.project);
      if (!project) return fail("not_found", MESSAGES.project);
      return { chat, project };
    }
    if (!isProjectId(projectId)) return badRequest();
    const project = await findProject(projectId!);
    return project ? { chat: null, project } : fail("not_found", MESSAGES.project);
  }

  /** The existence probe's answer for a target (the HEAD probe's facts), always a 200 read. */
  /** T-26: one tool use's whole result in the chat's own session (its main chain, then its subagents'), or null. */
  async function toolOutputOf(chat: ChatLedger, tool: string): Promise<string | null> {
    return chat.sessionId && driver.toolOutput ? await driver.toolOutput(chat.sessionId, sessionFolder(chat), tool) : null;
  }

  function existsReply(r: Awaited<ReturnType<typeof probeTarget>>): Response {
    if (!r.exists) return ok({ exists: false, reason: r.reason } satisfies ExistsReply);
    const t = r.target;
    const reply: ExistsReply =
      t.kind === "file"
        ? { exists: true, kind: "file", name: t.name, size: t.size }
        : { exists: true, kind: "folder", name: t.name, entries: t.entries.length, bytes: t.bytes, over: t.over };
    return ok(reply);
  }

  async function sendDownload(target: DownloadTarget, head: boolean): Promise<Response> {
    const base = { ...safe.base, "cache-control": "no-store" };
    if (target.kind === "file") {
      const headers = { ...base, "content-type": "application/octet-stream", "content-disposition": contentDisposition(target.name), "x-kitespan-kind": "file" };
      if (head) return new Response(null, { headers: { ...headers, "content-length": String(target.size) } });
      const file = await fileDownload(target);
      if (!file) return fail("not_found", MESSAGES.file);
      return new Response(file.body, { headers: { ...headers, "content-length": String(file.size) } });
    }
    const headers = {
      ...base,
      "content-type": "application/gzip",
      "content-disposition": contentDisposition(`${target.name}.tar.gz`),
      "x-kitespan-kind": "folder",
      "x-kitespan-entries": String(target.entries.length),
      "x-kitespan-bytes": String(target.bytes),
    };
    if (target.over) return fail("too_large", MESSAGES.folderTooLarge, { "x-kitespan-kind": "folder" });
    if (head) return new Response(null, { headers });
    return new Response(folderArchive(target), { headers });
  }

  const routes: Route[] = [
    {
      pattern: "/api/projects",
      async get() {
        // Row 99: the user's order once an environment was moved, else the last used first (store/order.ts).
        return ok({ projects: await Promise.all(projectOrder(await store.listProjects()).map(view)) });
      },
      post: {
        body: "json",
        async run({ req }) {
          const body = await readJson(req);
          const typed = (body as { cwd?: unknown } | undefined)?.cwd;
          // Row 73: New environment's Worktree checkbox, for a project that this add makes (a known one keeps its own).
          const wantWorktree = (body as { worktree?: unknown } | undefined)?.worktree;
          if (wantWorktree !== undefined && typeof wantWorktree !== "boolean") return badRequest();
          // "~/" is the user's home folder, as New environment's filter takes it (D54); "~name" and a bare "~" are
          // not paths.
          const cwd = typeof typed === "string" && typed.startsWith("~/") ? join(deps.home ?? homedir(), typed.slice(2)) : typed;
          if (typeof cwd !== "string" || !cwd || cwd.length > STORE_LIMITS.cwd || !isAbsolute(cwd) || CONTROL_CHARS.test(cwd)) return badRequest();
          let real: string;
          try {
            real = await realpath(cwd);
            if (!(await lstat(real)).isDirectory()) return fail("not_found", MESSAGES.folder);
          } catch {
            return fail("not_found", MESSAGES.folder);
          }
          // A link may lead to a path that the project table cannot hold.
          if (real.length > STORE_LIMITS.cwd || CONTROL_CHARS.test(real)) return badRequest();
          return serial(async () => {
            const list = await store.listProjects();
            const known = list.find((p) => p.cwd === real);
            if (known) return ok({ project: await view(known) });
            const at = now().toISOString();
            const off = await offOf(real);
            const rec: ProjectRecord = {
              id: newProjectId(),
              cwd: real,
              name: (basename(real) || real).slice(0, STORE_LIMITS.projectName),
              createdAt: at,
              lastUsedAt: at,
              picks: { model: null, effort: null, permissionMode: null },
              ...(wantWorktree === true && off === null ? { worktree: true as const } : {}),
              // Row 99: once the user ordered the environments, a new one goes at the top.
              ...topOrder(list),
            };
            await store.putProject(rec);
            deps.environments?.changed();
            return ok({ project: projectView(rec, off) }, 201);
          });
        },
      },
    },
    {
      // D60 (E5, server/env/api.ts): the environment's variables, names only; a save is checked whole and writes
      // nothing on any problem. A change drops what the project kept from Claude Code under its old variables, which
      // can change the provider: its model list (L37), its context windows (row 94), its provider and start facts (row
      // 97); and the model lists forget their reads of it.
      pattern: ENV_ROUTE,
      async get({ params }) {
        const env = deps.env;
        if (!env) return fail("not_found", MESSAGES.route);
        const project = await findProject(params.project!);
        if (!project) return fail("not_found", MESSAGES.project);
        return ok(await envReply(env, project.id, () => driver.settingsEnvNames?.(project.cwd) ?? Promise.resolve([])));
      },
      post: {
        body: "json",
        async run({ params, req }) {
          const env = deps.env;
          if (!env) return fail("not_found", MESSAGES.route);
          const change = envChangeOf(await readJson(req, ENV_LIMITS.requestBytes));
          if (!change) return badRequest();
          return serial(async () => {
            const project = await findProject(params.project!);
            if (!project) return fail("not_found", MESSAGES.project);
            let r;
            try {
              r = await env.change(project.id, change);
              if (r.ok && r.changed) {
                modelList.forget(project.id);
                deps.envChanged?.(project.id);
                const now = await findProject(project.id);
                if (now && (now.models || now.contextWindows || now.account || now.facts)) {
                  const { models: _m, contextWindows: _w, account: _a, facts: _f, ...rest } = now;
                  await store.putProject(rest);
                }
              }
            } catch {
              log?.log("error", { route: ENV_ROUTE, err: "store_write" });
              return fail("failed", MESSAGES.failed);
            }
            if (!r.ok) return jsonResponse(safe, { error: { code: "bad_request", message: ENV_NOT_SAVED, lines: r.lines } }, 400);
            return ok(await envReply(env, project.id, () => driver.settingsEnvNames?.(project.cwd) ?? Promise.resolve([])));
          });
        },
      },
    },
    {
      pattern: "/api/projects/:project/forget",
      post: {
        body: "json",
        async run({ params }) {
          return serial(async () => {
            const project = await findProject(params.project!);
            if (!project) return fail("not_found", MESSAGES.project);
            const rec: ProjectRecord = { ...project, picks: { model: null, effort: null, permissionMode: null } };
            await store.putProject(rec);
            return ok({ project: await view(rec) });
          });
        },
      },
    },
    {
      // Row 73 (W2): the project's Worktree option. It turns on only where a worktree can be made now; the reply's
      // `worktreeOff` says why not.
      pattern: "/api/projects/:project/worktree",
      post: {
        body: "json",
        async run({ req, params }) {
          const on = ((await readJson(req)) as { on?: unknown } | undefined)?.on;
          if (typeof on !== "boolean") return badRequest();
          return serial(async () => {
            const project = await findProject(params.project!);
            if (!project) return fail("not_found", MESSAGES.project);
            const off = await offOf(project.cwd);
            const { worktree: _was, ...rest } = project;
            const rec: ProjectRecord = on && off === null ? { ...rest, worktree: true } : rest;
            if ((rec.worktree === true) !== (project.worktree === true)) await store.putProject(rec);
            return ok({ project: projectView(rec, off, envCount(rec.id), envUnreadable(rec.id)) });
          });
        },
      },
    },
    {
      // Row 99: the name only, 1 to 80 characters after trimming; the folder never changes.
      pattern: "/api/projects/:project/rename",
      post: {
        body: "json",
        async run({ req, params }) {
          const env = deps.environments;
          if (!env) return fail("not_found", MESSAGES.route);
          const body = await readJson(req);
          return serial(async () => edited(await env.rename(params.project!, (body as { name?: unknown } | undefined)?.name), async (p) => ({ project: await view(p) })));
        },
      },
    },
    {
      // Row 99: one move, just before the project `before` (null: to the end); the answer is the list in its new order.
      pattern: "/api/projects/:project/move",
      post: {
        body: "json",
        async run({ req, params }) {
          const env = deps.environments;
          if (!env) return fail("not_found", MESSAGES.route);
          const body = await readJson(req);
          if (typeof body !== "object" || body === null || !("before" in body)) return badRequest();
          return serial(async () => edited(await env.move(params.project!, (body as { before: unknown }).before), async (list) => ({ projects: await Promise.all(list.map(view)) })));
        },
      },
    },
    {
      // Row 99: refused while a chat there works or needs input; the chats leave kitespan, their transcripts stay.
      pattern: "/api/projects/:project/remove",
      post: {
        body: "json",
        async run({ params }) {
          const env = deps.environments;
          if (!env) return fail("not_found", MESSAGES.route);
          return serial(async () => edited(await env.remove(params.project!), () => ({ removed: params.project! })));
        },
      },
    },
    {
      pattern: "/api/projects/:project/sessions",
      async get({ params }) {
        const project = await findProject(params.project!);
        if (!project) return fail("not_found", MESSAGES.project);
        // Row 77: Settings > Chats decides here, so every page shows the same list.
        const settings = await store.readSettings();
        if (!settings["chats.sessionsFromOtherApps"]) return ok({ sessions: [], hidden: "all" } satisfies SessionsReply);
        // Row 99: with the sessions a removed environment released from this folder (and no other of the SDK's own).
        const [list, open] = await Promise.all([folderSessions(driver, project.cwd, deps.releasedOf?.(project.cwd) ?? []), openSessions()]);
        const showOpen = settings["chats.sessionsOpenElsewhere"];
        const sessions: SessionView[] = [];
        const hiddenOpen: string[] = [];
        for (const s of fromTerminal(list, deps.heldSessions())) {
          if (!showOpen && open.has(s.sessionId)) hiddenOpen.push(s.sessionId);
          else
            sessions.push({
              sessionId: s.sessionId,
              title: s.title,
              lastModified: s.lastModified,
              ...openOf(open, s.sessionId),
              // L31: a session of another worktree of the repository shows its branch there.
              ...(s.cwd && s.cwd !== project.cwd && s.gitBranch ? { branch: s.gitBranch } : {}),
            });
        }
        return ok({ sessions, ...(hiddenOpen.length ? { hiddenOpen } : {}) } satisfies SessionsReply);
      },
    },
    {
      pattern: "/api/projects/:project/sessions/:session",
      async get({ params, url }) {
        const project = await findProject(params.project!);
        if (!project) return fail("not_found", MESSAGES.project);
        const before = url.searchParams.get("before");
        if (before !== null && (!before || before.length > LIMITS.cursor || CONTROL_CHARS.test(before))) return badRequest();
        // Row 77: a session that a setting hides has no preview; the reply says which setting, and no transcript is read.
        const settings = await store.readSettings();
        if (!settings["chats.sessionsFromOtherApps"]) return ok(hiddenPreview("all"));
        // Row 99: a session that a removed environment released is read under the folder that holds its transcript.
        const dir = deps.releasedOf?.(project.cwd).find((s) => s.id === params.session)?.dir ?? project.cwd;
        if (!(await driver.sessionInfo(params.session!, dir))) return fail("not_found", MESSAGES.session);
        const opened = openSessions();
        if (!settings["chats.sessionsOpenElsewhere"] && (await opened).has(params.session!)) return ok(hiddenPreview("open"));
        const [page, open] = await Promise.all([driver.history(params.session!, dir, { before, maxBytes: WIRE.pageBytes }), opened]);
        const copy = deps.copyForSession?.(params.session!) ?? null;
        return ok({ history: page.events, more: page.more, chat: deps.chatForSession(params.session!), copy, ...openOf(open, params.session!) } satisfies SessionPreviewReply);
      },
    },
    {
      // The new-chat form's `/` menu (D59): the project's last command list; none known starts the short read, but
      // only for the page's own read, with the sender header: a read with no Origin may come from another site (W19d).
      pattern: "/api/projects/:project/commands",
      async get({ params, req }) {
        const project = await findProject(params.project!);
        if (!project) return fail("not_found", MESSAGES.project);
        return ok(projectCommands.answer(project, senderHeader(req.headers)) satisfies ProjectCommandsReply);
      },
    },
    {
      // The new-chat form's and the project page's model rows (row 81): Claude Code's list as the server keeps it. With
      // none kept, the page's own read (the sender header) waits for one short read of the project's folder; any other
      // read gets what is kept and starts nothing.
      pattern: MODELS_ROUTE,
      async get({ params, req }) {
        const project = await findProject(params.project!);
        if (!project) return fail("not_found", MESSAGES.project);
        return ok((await modelList.answer(project, senderHeader(req.headers))) satisfies ProjectModelsReply);
      },
    },
    {
      // The new-chat form's `@` picker (D59): the project folder's files, as a chat's corpus routes read its folder.
      pattern: "/api/projects/:project/corpus",
      async get({ params, url, req, head }) {
        const query = readCorpusQuery(url.searchParams);
        if (!query) return badRequest();
        const project = await findProject(params.project!);
        if (!project) return fail("not_found", MESSAGES.project);
        return corpusListResponse(safe, req, await corpus.read(project.cwd, null), query, head);
      },
    },
    {
      pattern: "/api/projects/:project/corpus/search",
      async get({ params, url, req }) {
        const query = readSearchQuery(url.searchParams);
        if (!query) return badRequest();
        const project = await findProject(params.project!);
        if (!project) return fail("not_found", MESSAGES.project);
        const reply = await corpus.search(project.cwd, null, query.q, req.signal);
        return reply ? ok(reply) : abortedResponse(safe);
      },
    },
    {
      pattern: "/api/settings",
      get: ({ url }) => settingsReply(url),
      post: {
        body: "json",
        async run({ req, url }) {
          const writer = deps.settingsWriter;
          if (!writer) return jsonResponse(safe, { error: { code: "bad_request", message: MESSAGES.method } }, 405, { allow: "GET, HEAD" });
          const body = await readJson(req);
          if (typeof body !== "object" || body === null || Array.isArray(body)) return badRequest();
          const change = body as Partial<Settings>;
          // Iteration 7: the browser's switch is the browser routes' own (Start, Stop), never a settings write.
          if ("browser.enabled" in change) return badRequest();
          const run = async (): Promise<Response> => {
            try {
              await writer.write(change);
            } catch (e) {
              if (e instanceof StoreError && e.code === "bad_value") return "uploads.customFolder" in change ? fail("bad_request", MESSAGES.folder) : badRequest();
              throw e;
            }
            await writer.reload();
            return settingsReply(url);
          };
          const p = settingsChain.then(run, run);
          settingsChain = p.catch(() => {});
          return p;
        },
      },
    },
    {
      pattern: "/api/upload-folder",
      async get({ url }) {
        const owner = await uploadOwner(url);
        if (owner instanceof Response) return owner;
        const settings = await store.readSettings();
        return ok({ folder: folderView(await deps.uploadFolder({ ...owner, settings })) });
      },
    },
    {
      pattern: "/api/uploads",
      post: {
        body: "bytes",
        async run({ req, url }) {
          const owner = await uploadOwner(url);
          if (owner instanceof Response) return owner;
          const rawName = url.searchParams.get("name");
          if (rawName !== null && rawName.length > 1024) return badRequest();
          const settings = await store.readSettings();
          const maxMB = settings["uploads.maxMB"];
          const cap = uploadCapBytes(maxMB);
          const declared = req.headers.get("content-length");
          if (declared !== null && Number(declared) > cap) return fail("too_large", tooLargeLine(maxMB));
          const folder = await deps.uploadFolder({ ...owner, settings });
          if (!folder.ok) return fail("upload_folder", folder.line);
          const type = uploadType(url.searchParams.get("type"));
          // Lock the body as soon as it is read: under Bun 1.3.14 a served request's body stream that stays unlocked
          // across a later await (writeUpload makes its folder and file first) fails on its first read.
          const body = req.body;
          if (!body) return badRequest();
          const reader = body.getReader();
          let written;
          try {
            written = await writeUpload(folder.path, rawName ?? "", type, readerChunks(reader), cap, uid);
          } catch (e) {
            // A write that failed before the first read leaves the body unread: drop it.
            await reader.cancel().catch(() => {});
            if (e instanceof UploadError && e.code === "too_large") return fail("too_large", tooLargeLine(maxMB));
            log?.log("error", { route: "/api/uploads", err: "upload" });
            return fail("failed", MESSAGES.saveFailed);
          }
          const rec: UploadRecord = {
            v: 1,
            id: newUploadId(),
            chat: owner.chat?.id ?? null,
            project: owner.project?.id ?? null,
            name: written.name,
            size: written.size,
            type,
            path: written.path,
            folder: folder.choice,
            dir: written.dir,
            at: now().toISOString(),
          };
          try {
            await store.putUpload(rec);
          } catch {
            await removeUploadDir(written.dir, uid);
            log?.log("error", { route: "/api/uploads", err: "upload" });
            return fail("failed", MESSAGES.saveFailed);
          }
          return ok({ upload: uploadView(rec) }, 201);
        },
      },
    },
    {
      pattern: "/api/uploads/:upload",
      async del({ params }) {
        const rec = await store.removeUpload(params.upload!);
        if (!rec) return fail("not_found", MESSAGES.upload);
        if (!(await removeUploadDir(rec.dir, uid).catch(() => false))) log?.log("error", { route: "/api/uploads/:upload", err: "upload" });
        return ok({ removed: rec.id });
      },
    },
    {
      pattern: "/api/chats/:chat/uploads",
      async get({ params }) {
        if (!(await store.readChat(params.chat!))) return fail("not_found", MESSAGES.chat);
        return ok({ uploads: (await store.listUploads(params.chat!)).map(uploadView) });
      },
    },
    {
      pattern: "/api/chats/:chat/uploads/:upload/file",
      async get({ params, head }) {
        if (!(await store.readChat(params.chat!))) return fail("not_found", MESSAGES.chat);
        const rec = (await store.listUploads(params.chat!)).find((u) => u.id === params.upload);
        if (!rec) return fail("not_found", MESSAGES.upload);
        const target = await downloadTarget(rec.dir, basename(rec.path), rec.name, limits);
        if (!target || target.kind !== "file") return fail("not_found", MESSAGES.upload);
        return sendDownload(target, head);
      },
    },
    {
      pattern: "/api/chats/:chat/uploads/:upload/exists",
      async get({ params }) {
        if (!(await store.readChat(params.chat!))) return ok({ exists: false, reason: "no_chat" } satisfies ExistsReply);
        const rec = (await store.listUploads(params.chat!)).find((u) => u.id === params.upload);
        if (!rec) return ok({ exists: false, reason: "missing" } satisfies ExistsReply);
        const r = await probeTarget(rec.dir, basename(rec.path), rec.name, limits);
        return existsReply(r.exists && r.target.kind !== "file" ? { exists: false, reason: "not_a_file" } : r);
      },
    },
    {
      pattern: "/api/chats/:chat/files/*",
      async get({ params, head }) {
        const chat = await store.readChat(params.chat!);
        if (!chat) return fail("not_found", MESSAGES.chat);
        const target = await downloadTarget(chat.cwd, params.path!, undefined, limits);
        if (!target) return fail("not_found", MESSAGES.file);
        return sendDownload(target, head);
      },
    },
    {
      // T-26: one tool use's whole result, which the page holds cut at LIMITS.toolResult: read from the session's
      // transcript through the agent seam (before any cap) and sent as a text/plain attachment, under the files
      // route's guards (a read: an allowed Origin or none). A chat with no session, a driver that cannot read one, or a
      // transcript with no such result answers 404 with 5.4's line.
      pattern: "/api/chats/:chat/tools/:tool/output",
      async get({ params, head }) {
        const chat = await store.readChat(params.chat!);
        if (!chat) return fail("not_found", MESSAGES.chat);
        const text = await toolOutputOf(chat, params.tool!);
        if (text === null) return fail("not_found", MESSAGES.tool);
        const body = Buffer.from(text, "utf8");
        const headers = {
          ...safe.base,
          "cache-control": "no-store",
          "content-type": "text/plain; charset=utf-8",
          "content-disposition": contentDisposition(toolOutputName(params.tool!)),
          "content-length": String(body.byteLength),
        };
        return new Response(head ? null : body, { headers });
      },
    },
    {
      // Before the output's download, as the files route's probe: a result that is not there is a normal read, so the
      // page shows its 5.4 line with no failed request (and no console error).
      pattern: "/api/chats/:chat/tools/:tool/output/exists",
      async get({ params }) {
        const chat = await store.readChat(params.chat!);
        if (!chat) return ok({ exists: false, reason: "no_chat" } satisfies ExistsReply);
        const text = await toolOutputOf(chat, params.tool!);
        if (text === null) return ok({ exists: false, reason: "missing" } satisfies ExistsReply);
        return ok({ exists: true, kind: "file", name: toolOutputName(params.tool!), size: Buffer.byteLength(text, "utf8") } satisfies ExistsReply);
      },
    },
    {
      // Before any HEAD or GET of a download: a missing or outside path is a normal read, so the page shows its 5.4
      // line with no failed request (and no console error).
      pattern: "/api/chats/:chat/exists/*",
      anyPath: true,
      async get({ params }) {
        const chat = await store.readChat(params.chat!);
        if (!chat) return ok({ exists: false, reason: "no_chat" } satisfies ExistsReply);
        if (!isSafeRelativePath(params.path!)) return ok({ exists: false, reason: "outside" } satisfies ExistsReply);
        return existsReply(await probeTarget(chat.cwd, params.path!, undefined, limits));
      },
    },
    {
      // v0.3 search (9.3): the chat folder's files, for the page's own filter. A chat id, never a path; an archived
      // chat can be read (a read changes nothing).
      pattern: "/api/chats/:chat/corpus",
      async get({ params, url, req, head }) {
        const query = readCorpusQuery(url.searchParams);
        if (!query) return badRequest();
        const chat = await store.readChat(params.chat!);
        if (!chat) return fail("not_found", MESSAGES.chat);
        return corpusListResponse(safe, req, await corpus.read(chat.cwd, chat.id), query, head);
      },
    },
    {
      // Over the page's limit: the best 120 rows for each keystroke, ranked by the shared matcher (shared/match.ts).
      pattern: "/api/chats/:chat/corpus/search",
      async get({ params, url, req }) {
        const query = readSearchQuery(url.searchParams);
        if (!query) return badRequest();
        const chat = await store.readChat(params.chat!);
        if (!chat) return fail("not_found", MESSAGES.chat);
        const reply = await corpus.search(chat.cwd, chat.id, query.q, req.signal);
        return reply ? ok(reply) : abortedResponse(safe);
      },
    },
    {
      // U5: the Messages group of the search surface (DESIGN-U5 10): the words of every chat's messages, archived ones
      // too. Only the page's own read (the sender header) starts disk reads; any other read answers from what is held.
      // An ask that a newer one of its tab replaced, or whose page went away, answers 204 and logs nothing.
      pattern: "/api/search",
      async get({ url, req }) {
        const query = readMessageSearchQuery(url.searchParams);
        if (!query) return badRequest();
        const messages = deps.messages;
        if (!messages) return fail("not_found", MESSAGES.route);
        const reply = await messages.search({ q: query.q, tab: query.tab, read: senderHeader(req.headers), signal: req.signal });
        return reply ? ok(reply satisfies MessageSearchReply) : abortedResponse(safe);
      },
    },
    {
      // W7, W9 (L26): Archive's and Delete's facts about the chat's own worktree, read when their dialog opens.
      pattern: "/api/chats/:chat/worktree",
      async get({ params }) {
        const chat = await store.readChat(params.chat!);
        const w = chat?.worktree;
        if (!chat || !w) return fail("not_found", MESSAGES.chat);
        const facts = await worktrees.facts(w);
        return ok({ path: w.path, branch: w.branch, ...facts } satisfies ChatWorktreeReply);
      },
    },
    {
      // R131: the read-only view of a background session that a launch row of the chat printed: the newest page of its
      // transcript (or the page before `before`), `same` when `since` is the transcript's stamp still, `outside` for a
      // session whose folder is not the chat's project or worktree. Only the chat and the short id name it, never a
      // path or a session id. A read: nothing changes (it may ask Claude Code's list once, a read too).
      pattern: "/api/chats/:chat/background/:id",
      async get({ params, url }) {
        const view = deps.backgroundView;
        if (!view) return fail("not_found", MESSAGES.background);
        const read = (k: string): string | null | false => {
          const v = url.searchParams.get(k);
          return v === null ? null : v && v.length <= LIMITS.cursor && !CONTROL_CHARS.test(v) ? v : false;
        };
        const since = read("since");
        const before = read("before");
        if (since === false || before === false) return badRequest();
        const reply = await view(params.chat!, params.id!, { since, before });
        return reply ? ok(reply satisfies BackgroundViewReply) : fail("not_found", MESSAGES.background);
      },
    },
    {
      // U1 (DESIGN-U1 9): one turn's changes summary: every file (at most 1,000) with its counts, the fallback's reason
      // and the count of changes left out. Only the chat's id and the summary's id name it, never a path; an archived
      // chat's can be read. A read: nothing changes, and git does not run.
      pattern: "/api/chats/:chat/changes/:turn",
      async get({ params }) {
        const chat = await store.readChat(params.chat!);
        const s = chat && deps.changes ? await deps.changes.summary(chat.id, params.turn!) : null;
        return s ? ok(s satisfies ChangesSummary) : changesMissing("no_turn");
      },
    },
    {
      // U1: one file's diff in that turn, read on the host with kitespan's own git (sizes first, then the patch, each
      // capped, within 5 s), only on this read: its text reaches no page that does not open it.
      pattern: "/api/chats/:chat/changes/:turn/files/*",
      async get({ params }) {
        const chat = await store.readChat(params.chat!);
        if (!chat || !deps.changes) return changesMissing("no_turn");
        const r = await deps.changes.file(chat.id, chat.cwd, params.turn!, params.path!);
        if (r.state === "diff") return ok(r.diff satisfies FileDiff);
        if (r.state === "failed") return fail("failed", MESSAGES.diffFailed);
        return changesMissing(r.state);
      },
    },
    {
      // New environment's Worktree option (W2) for the folder it would add, before that project exists.
      pattern: "/api/folders/worktree",
      async get({ url }) {
        const typed = url.searchParams.get("path");
        const home = deps.home ?? homedir();
        const path = typed !== null && typed.startsWith("~/") ? join(home, typed.slice(2)) : typed;
        if (typeof path !== "string" || !path || path.length > STORE_LIMITS.cwd || !isAbsolute(path) || CONTROL_CHARS.test(path)) return badRequest();
        let real: string;
        try {
          real = await realpath(path);
        } catch {
          return fail("not_found", MESSAGES.folder);
        }
        const why = await offOf(real);
        return ok((why ? { ok: false, why, line: WORKTREE_OFF_LINES[why] } : { ok: true }) satisfies WorktreeCanReply);
      },
    },
    {
      // New environment's Browse (D54): a folder that cannot be read is a normal read, with its one line.
      pattern: "/api/folders",
      async get({ url }) {
        const home = deps.home ?? homedir();
        const path = folderPath(url.searchParams.get("path"), home);
        if (path === null) return badRequest();
        const q = url.searchParams.get("q") ?? undefined;
        return ok(await listFolders(path, { home, hidden: url.searchParams.get("hidden") === "1", q }));
      },
    },
    {
      pattern: "/api/folders/suggested",
      async get() {
        return ok({ folders: deps.suggestedFolders ? await deps.suggestedFolders() : [] } satisfies SuggestedFoldersReply);
      },
    },
    {
      // The restart's health gate (4.10 step 5) polls this on 127.0.0.1 for a new epoch. A read like every other:
      // the Host allowlist ran before, and an Origin, when there is one, must be an allowed one.
      pattern: "/api/health",
      async get() {
        if (!deps.epoch) return fail("not_found", MESSAGES.route);
        return ok({ epoch: deps.epoch() } satisfies HealthReply);
      },
    },
    {
      // About's update lines and the restart dialog's panes, read when they open (a GET: it changes nothing). The POST
      // asks for the restart (Settings > About > Restart, bin/kitespan restart): the preflight first, then the
      // registry's drain, and 202 at once, because the restart closes this request's own connection.
      pattern: "/api/restart",
      async get() {
        const r = deps.restart;
        if (!r) return fail("not_found", MESSAGES.route);
        const facts = await r.facts();
        return ok({ update: facts.update, build: facts.build, panes: r.panes() } satisfies RestartReply);
      },
      post: {
        body: "json",
        async run({ req }) {
          const r = deps.restart;
          if (!r) return fail("not_found", MESSAGES.route);
          const when = ((await readJson(req)) as { when?: unknown } | undefined)?.when;
          if (when !== "finish" && when !== "now") return badRequest();
          return restartSerial(async () => {
            if (r.closing?.()) return ok({ when } satisfies RestartAccepted, 202);
            const done = r.asking?.();
            try {
              const line = await r.preflight();
              if (line !== null) {
                log?.log("restart", { ok: false });
                return fail("preflight", line);
              }
              const answer = await r.drain(when);
              if (!answer.ok) return fail(answer.code, ERROR_MESSAGES[answer.code]);
              return ok({ when } satisfies RestartAccepted, 202);
            } finally {
              done?.();
            }
          });
        },
      },
    },
    {
      // Cancel restart, while Restart when they finish waits (L14).
      pattern: "/api/restart/cancel",
      post: {
        body: "json",
        async run() {
          const r = deps.restart;
          if (!r) return fail("not_found", MESSAGES.route);
          return ok({ cancelled: await r.undrain() } satisfies RestartCancelReply);
        },
      },
    },
    {
      // Row 108: About's update facts (a GET: it changes nothing, and never checks origin), and the Update button:
      // the job's start, or the running job joined, and 202 at once; it runs while the server goes on serving.
      pattern: "/api/update",
      async get() {
        const u = deps.update;
        if (!u) return fail("not_found", MESSAGES.route);
        return ok((await u.facts()) satisfies UpdateReply);
      },
      post: {
        body: "json",
        async run({ req }) {
          const u = deps.update;
          if (!u) return fail("not_found", MESSAGES.route);
          if ((await readJson(req)) === undefined) return badRequest();
          const answer = await u.start();
          if (!answer.ok) return fail("update_refused", answer.line);
          return ok({ job: answer.job } satisfies UpdateAccepted, 202);
        },
      },
    },
    {
      // R130 (DESIGN-R130 4.4): notifications. The read makes nothing; the key is made at the first opt-in (after the
      // page's own tap asked the browser), then the device's subscription comes. A device's endpoint is a capability:
      // no answer holds it, only the device's id (its hash).
      pattern: "/api/push",
      async get() {
        const p = deps.push;
        if (!p) return fail("not_found", MESSAGES.route);
        return ok((await p.read()) satisfies PushReply);
      },
    },
    {
      pattern: "/api/push/key",
      post: {
        body: "json",
        async run({ req }) {
          const p = deps.push;
          if (!p) return fail("not_found", MESSAGES.route);
          if ((await readJson(req)) === undefined) return badRequest();
          return ok({ key: await p.makeKey() } satisfies PushKeyReply);
        },
      },
    },
    {
      // A device turns on: 201 for a new one, 200 for the same endpoint again (its new keys; its name and titles stay).
      pattern: "/api/push/devices",
      post: {
        body: "json",
        async run({ req }) {
          const p = deps.push;
          if (!p) return fail("not_found", MESSAGES.route);
          const body = await readJson(req);
          if (body === undefined) return badRequest();
          const r = await p.add(body);
          if (r.ok) return ok({ device: r.device } satisfies PushDeviceReply, r.added ? 201 : 200);
          if (r.code === "push_service") return fail("push_service", MESSAGES.pushService);
          return r.code === "too_many" ? fail("too_large", MESSAGES.pushDevices) : badRequest();
        },
      },
    },
    {
      // A device's name (1 to 40 characters) or its Show chat titles.
      pattern: "/api/push/devices/:device",
      post: {
        body: "json",
        async run({ req, params }) {
          const p = deps.push;
          if (!p) return fail("not_found", MESSAGES.route);
          const body = await readJson(req);
          if (body === undefined) return badRequest();
          const d = await p.update(params.device!, body);
          if (d === "bad") return badRequest();
          return d ? ok({ device: d } satisfies PushDeviceReply) : fail("not_found", MESSAGES.device);
        },
      },
    },
    {
      // Turn off: this device's own (after its unsubscribe) or another's from this one's list.
      pattern: "/api/push/devices/:device/remove",
      post: {
        body: "json",
        async run({ req, params }) {
          const p = deps.push;
          if (!p) return fail("not_found", MESSAGES.route);
          if ((await readJson(req)) === undefined) return badRequest();
          return (await p.remove(params.device!)) ? ok({ removed: params.device! } satisfies PushRemovedReply) : fail("not_found", MESSAGES.device);
        },
      },
    },
    // Iteration 7: the shared browser (DESIGN-B1 3.9). Every one also refuses Sec-Fetch-Site cross-site and
    // same-site (handle() below).
    {
      pattern: "/api/browser",
      async get() {
        const b = deps.browser;
        return b ? ok(b.reply() satisfies BrowserReply) : fail("not_found", MESSAGES.route);
      },
    },
    ...(["start", "stop"] as const).map(
      (what): Route => ({
        pattern: `/api/browser/${what}`,
        post: {
          body: "json",
          async run({ req }) {
            const b = deps.browser;
            if (!b) return fail("not_found", MESSAGES.route);
            if ((await readJson(req)) === undefined) return badRequest();
            return ok((await (what === "start" ? b.start() : b.stop())) satisfies BrowserReply);
          },
        },
      }),
    ),
    {
      pattern: "/api/browser/clear",
      post: {
        body: "json",
        async run({ req }) {
          const b = deps.browser;
          if (!b) return fail("not_found", MESSAGES.route);
          if ((await readJson(req)) === undefined) return badRequest();
          const r = await b.clear();
          return r ? ok(r satisfies BrowserReply) : fail("browser_running", MESSAGES.browserRunning);
        },
      },
    },
    {
      pattern: "/api/browser/downloads",
      async get() {
        const b = deps.browser;
        return b ? ok({ downloads: b.downloads() } satisfies BrowserDownloadsReply) : fail("not_found", MESSAGES.route);
      },
    },
    {
      pattern: "/api/browser/downloads/:download/file",
      async get({ params, head }) {
        const f = deps.browser?.downloadFile(params.download!);
        if (!f) return fail("not_found", MESSAGES.download);
        const target = await downloadTarget(join(f.path, ".."), basename(f.path), f.name, limits);
        if (!target || target.kind !== "file") return fail("not_found", MESSAGES.download);
        return sendDownload(target, head);
      },
    },
    {
      pattern: "/api/browser/downloads/:download/remove",
      post: {
        body: "json",
        async run({ req, params }) {
          const b = deps.browser;
          if (!b) return fail("not_found", MESSAGES.route);
          if ((await readJson(req)) === undefined) return badRequest();
          if (!(await b.removeDownload(params.download!))) return fail("not_found", MESSAGES.download);
          return ok({ downloads: b.downloads() } satisfies BrowserDownloadsReply);
        },
      },
    },
    {
      // Check now (row 108), in every mode of Check for updates: one read of origin, then About's facts.
      pattern: "/api/update/check",
      post: {
        body: "json",
        async run({ req }) {
          const u = deps.update;
          if (!u) return fail("not_found", MESSAGES.route);
          if ((await readJson(req)) === undefined) return badRequest();
          return ok((await u.check()) satisfies UpdateReply);
        },
      },
    },
  ];

  return {
    async handle(req, url) {
      const segs = segments(url.pathname);
      let route: Route | undefined;
      let params: Record<string, string> | null = null;
      if (segs) {
        for (const r of routes) {
          params = matchRoute(r.pattern, segs, r.anyPath === true);
          if (params) {
            route = r;
            break;
          }
        }
      }
      if (!route || !params) return fail("not_found", MESSAGES.route);
      // Iteration 7 (DESIGN-B1 2.16 point 21): the browser's routes answer no load that another site started.
      if (route.pattern.startsWith("/api/browser") && otherSite(req)) {
        log?.log("origin_refused", { route: route.pattern });
        return forbidden(safe);
      }
      const allow = [route.get && "GET, HEAD", route.post && "POST", route.del && "DELETE"].filter(Boolean).join(", ");
      const method = req.method === "HEAD" ? "GET" : req.method;
      let run: Run | undefined;
      if (method === "GET" && route.get) {
        if (!readOriginPasses(req, gate)) {
          log?.log("origin_refused", { route: route.pattern });
          return forbidden(safe);
        }
        run = route.get;
      } else if ((method === "POST" && route.post) || (method === "DELETE" && route.del)) {
        if (!senderPasses(req, gate, method === "POST" ? route.post!.body : "json")) {
          log?.log("origin_refused", { route: route.pattern });
          return forbidden(safe);
        }
        run = method === "POST" ? route.post!.run : route.del;
      }
      if (!run) return jsonResponse(safe, { error: { code: "bad_request", message: MESSAGES.method } }, 405, { allow });
      try {
        return await run({ req, url, params, head: req.method === "HEAD" });
      } catch {
        log?.log("error", { route: route.pattern, err: "unknown" });
        return fail("failed", MESSAGES.failed);
      }
    },
  };
}
