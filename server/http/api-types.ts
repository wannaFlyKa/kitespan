// The shapes of the JSON API under /api/ (DESIGN.md 4.3: app-level reads and writes, the uploads and downloads of
// D37). Types only, importing nothing but shared/, so the page may import them as types.
//
// Every mutating route (POST, PUT, DELETE) needs `x-kitespan: 1`, an allowed Origin and its body type: JSON, or for
// POST /api/uploads the file's raw bytes as application/octet-stream. Every read is GET (HEAD for a download probe).
// An error is `{error: {code, message}}`; `message` is a fixed sentence for the page, never a path or a value.
//
//   GET    /api/projects                                    -> ProjectsReply
//   POST   /api/projects                    {cwd}           -> ProjectReply (201 added, 200 already known)
//   POST   /api/projects/:project/forget    {}              -> ProjectReply (its remembered picks cleared)
//   POST   /api/projects/:project/worktree  {on}            -> ProjectReply (row 73: the Worktree option; off reasons stay off)
//   GET    /api/projects/:project/env                       -> EnvReply (D60: names only, server/env/api.ts)
//   POST   /api/projects/:project/env       {set, remove, discardUnreadable?} -> EnvReply, or 400 with each line's code
//   POST   /api/projects/:project/rename    {name}          -> ProjectReply (row 99: the name only, 1 to 80 characters)
//   POST   /api/projects/:project/move      {before}        -> ProjectsReply (row 99: just before that project, or null: last)
//   POST   /api/projects/:project/remove    {}              -> RemovedProjectReply, or 409 `busy` while a chat there works
//   GET    /api/projects/:project/sessions                  -> SessionsReply (From the terminal)
//   GET    /api/projects/:project/sessions/:session?before= -> SessionPreviewReply (read only; starts nothing)
//   GET    /api/projects/:project/commands                  -> ProjectCommandsReply (the new-chat form's / menu)
//   GET    /api/projects/:project/models                    -> ProjectModelsReply (the form's and the project page's model rows)
//   GET    /api/projects/:project/corpus?max=&chars=&v=     -> CorpusReply (the project folder's files, D59)
//   GET    /api/projects/:project/corpus/search?q=&v=       -> CorpusSearchReply
//   GET    /api/settings?project=                           -> SettingsReply
//   POST   /api/settings?project=           {<key>: value}  -> SettingsReply (kitespan's own settings written, 4.4)
//   GET    /api/upload-folder?chat= | ?project=             -> UploadFolderReply
//   POST   /api/uploads?chat= | ?project=, &name=, &type=   -> UploadReply (201); the body is the file
//   DELETE /api/uploads/:upload                 {}          -> RemovedReply
//   GET    /api/chats/:chat/uploads                         -> UploadsReply
//   GET    /api/chats/:chat/uploads/:upload/file            -> the file (HEAD: its name and size)
//   GET    /api/chats/:chat/uploads/:upload/exists          -> ExistsReply (always 200)
//   GET    /api/chats/:chat/files/<relative path>           -> the file, or a folder as .tar.gz (HEAD first)
//   GET    /api/chats/:chat/exists/<relative path>          -> ExistsReply (always 200)
//   GET    /api/chats/:chat/tools/:tool/output              -> one tool use's whole result, text/plain (T-26; HEAD too)
//   GET    /api/chats/:chat/tools/:tool/output/exists       -> ExistsReply (always 200)
//   GET    /api/chats/:chat/corpus?max=&chars=&v=           -> CorpusReply (the chat folder's files, v0.3 search)
//   GET    /api/chats/:chat/corpus/search?q=&v=             -> CorpusSearchReply (the best 120 rows)
//   GET    /api/chats/:chat/worktree                        -> ChatWorktreeReply (Archive's and Delete's facts, W7, W9)
//   GET    /api/search?q=&tab=                              -> MessageSearchReply (U5: the Messages group, shared/message-search.ts;
//                                                              204 when a newer ask of the tab replaced it; disk reads only with x-kitespan: 1)
//   GET    /api/folders?path=&hidden=1&q=                   -> FoldersReply (always 200 for a path)
//   GET    /api/folders/suggested                           -> SuggestedFoldersReply
//   GET    /api/folders/worktree?path=                      -> WorktreeCanReply (New environment's Worktree option, W2)
//   GET    /api/health                                      -> HealthReply (the restart's health gate: the boot epoch)
//   GET    /api/restart                                     -> RestartReply (About's update lines, the restart dialog's panes)
//   POST   /api/restart                     {when}          -> RestartAccepted (202), or 409 `preflight` or `restarting`
//   POST   /api/restart/cancel              {}              -> RestartCancelReply (Cancel restart while it waits)
//   GET    /api/update                                      -> UpdateReply (row 108: About's update facts and the job)
//   POST   /api/update                      {}              -> UpdateAccepted (202: started, or joined), or 409 `update_refused`
//   POST   /api/update/check                {}              -> UpdateReply (Check now: one check of origin, then the facts)
//   GET    /api/push                                        -> PushReply (R130: the public key or null, the devices; makes nothing)
//   POST   /api/push/key                    {}              -> PushKeyReply (the VAPID public key, made at the first opt-in)
//   POST   /api/push/devices                {subscription, name} -> PushDeviceReply (201 added, 200 the same endpoint again)
//   POST   /api/push/devices/:device        {name?, titles?} -> PushDeviceReply
//   POST   /api/push/devices/:device/remove {}              -> PushRemovedReply
//   GET    /api/browser                                     -> BrowserReply (iteration 7, shared/browser.ts: Settings > Browser)
//   POST   /api/browser/start               {}              -> BrowserReply (browser.enabled on; the start runs)
//   POST   /api/browser/stop                {}              -> BrowserReply (browser.enabled off; the stop order)
//   POST   /api/browser/clear               {}              -> BrowserReply, or 409 `browser_running` (nothing cleared)
//   GET    /api/browser/downloads                           -> BrowserDownloadsReply
//   GET    /api/browser/downloads/:download/file            -> the file, as an attachment
//   POST   /api/browser/downloads/:download/remove {}       -> BrowserDownloadsReply
//   (The browser routes also refuse Sec-Fetch-Site cross-site and same-site, and a mutating request from the shared
//   browser itself.)
//
// The existence probe answers before any HEAD or GET of a download, so the page shows its 5.4 line ("That file is not
// in this chat's folder.") without a request that would fail: a missing path, one that leaves the folder (`..`, an
// absolute path, a link that leads outside), a fifo, an unknown chat or upload are all a normal 200 read.
//
// A download's HEAD answer carries `content-disposition` (the RFC 6266 name), `x-kitespan-kind` (`file` or `folder`),
// for a file `content-length`, and for a folder `x-kitespan-entries` and `x-kitespan-bytes` (the files' total size);
// a folder over the caps answers 413 with the code `too_large`.

import type { ChatEvent, ClaudeBelow, CommandInfo, ErrorCode, ModelInfo, SessionOpen, UpdateKind, WorktreeOff } from "../../shared/protocol";
import type { UpdateJob, UpdateRefusal } from "../../shared/update";
import type { KeptFacts } from "../store/types";

// The corpus routes' shapes, limits and query readers live in shared/corpus.ts, which the page imports too.
export type { CorpusLimit, CorpusListReply, CorpusReply, CorpusSameReply, CorpusSearchReply, CorpusSearchRow, CorpusSource } from "../../shared/corpus";
export type { MessageHit, MessageSearchReply } from "../../shared/message-search";

/**
 * GET /api/projects/:project/commands (D59): the project's last command list, from any of its chats or from the short
 * read that the server starts when it knows none or the one it has is over 24 h old (it answers with that one
 * meanwhile). `at` is when the list was read; null, with an empty list, while the first read runs or after it failed:
 * the page asks once more about 3 s later.
 */
export interface ProjectCommandsReply {
  commands: CommandInfo[];
  at: string | null;
}

/**
 * Claude Code's model list (row 81): the newest one kept with any project. With none kept, the page's own read waits for
 * one short read of the project's folder (20 s at most). `at` is when the list was read; null, with no rows, when none
 * is known (the read failed, or the read may start none).
 */
export interface ProjectModelsReply {
  models: ModelInfo[];
  at: string | null;
}

/**
 * `preflight`: the restart's preflight refused it (the code on disk cannot start), with its one line. `update_refused`:
 * an update did not start (row 108: local changes, no checkout, another update runs...), with its one line.
 */
/**
 * R130: `push_service`, a subscription whose push service kitespan does not send to (not on the list of
 * shared/push.ts).
 */
/** `gone` (U1): a turn's diff whose marks are no longer there (410). */
/** `browser_running` (iteration 7): Clear browsing data found the shared browser still running after the stop, so nothing was cleared. */
export type ApiErrorCode = ErrorCode | "too_large" | "upload_folder" | "preflight" | "update_refused" | "push_service" | "gone" | "browser_running";

export interface ApiError {
  error: { code: ApiErrorCode; message: string };
}

export interface ProjectView {
  id: string;
  name: string;
  /** The folder (shown in the UI; never in a URL). */
  cwd: string;
  createdAt: string;
  lastUsedAt: string;
  /** The picks remembered for new chats here, without their marks. */
  picks: { model: string | null; effort: string | null; permissionMode: string | null };
  /** Row 73 (W2): the project's Worktree option, as the user set it (off by default). */
  worktree: boolean;
  /** Why the Worktree option cannot be on here now (L29, L33), or null when it can. */
  worktreeOff: WorktreeOff | null;
  /**
   * D60: how many variables the project's environment has (GET /api/projects/:project/env names them). The server
   * always sends it; absent reads as none.
   */
  env?: number;
  /**
   * D60 (L39): the environment's variables file cannot be read (it is set aside as `.bad`), so its chats do not start
   * and `env` (0) says nothing of it. Absent: it can be read.
   */
  envUnreadable?: true;
}

/** Why a folder gets no worktree (W2; shared/protocol.ts WORKTREE_OFF, the server's and the page's one list). */
export type { WorktreeOff };

/** GET /api/folders/worktree?path=: whether a worktree can be made for that folder, or why not, with its one line. */
export type WorktreeCanReply = { ok: true } | { ok: false; why: WorktreeOff; line: string };

/**
 * GET /api/chats/:chat/worktree (W7, W9, L26): the chat's own worktree as Archive and Delete name it: how many files
 * have changes (tracked and untracked; null when it is not there), and whether its branch holds a commit that no
 * other branch has, so Delete keeps it. Never a file's name. 404 for a chat with no worktree of its own.
 */
export interface ChatWorktreeReply {
  path: string;
  branch: string;
  changes: number | null;
  /**
   * W7 (L25): the worktree holds files that git ignores, other than unchanged copies of the project's own, which
   * Archive keeps as it keeps changes (null when it is not there or cannot be read).
   */
  ignored: boolean | null;
  branchStays: boolean;
}

export interface ProjectsReply {
  projects: ProjectView[];
}

export interface ProjectReply {
  project: ProjectView;
}

/** Row 99: the environment and its chats left kitespan (their Claude Code transcripts and the folder stay). */
export interface RemovedProjectReply {
  removed: string;
}

export interface SessionView {
  sessionId: string;
  title: string;
  lastModified: number;
  /** D58: another process has the session open now (the row's mark; Continue here becomes Continue in a copy). */
  open?: SessionOpen;
  /** L31: the session ran in another worktree of the project's repository: its branch there. Absent otherwise. */
  branch?: string;
}

export interface SessionsReply {
  /**
   * The Claude Code sessions in the folder that no kitespan chat has, less those that Settings > Chats hides (row 77):
   * the terminal's, and those that a removed environment released here (row 99); never another of the SDK's own.
   */
  sessions: SessionView[];
  /** Row 77: "all" while Show sessions from other apps is off (the list is then empty); absent otherwise. */
  hidden?: "all";
  /**
   * Row 77: the sessions left out because another process has them open now, while Show sessions open in another app
   * is off, so the preview of one says why it is not shown; absent when none is.
   */
  hiddenOpen?: string[];
}

/** Row 77: the setting that hides a session: Show sessions from other apps ("all") or open in another app ("open"). */
export type SessionHidden = "all" | "open";

export interface SessionPreviewReply {
  /** One page of the transcript, newest first, at most 256 KiB of JSON. */
  history: ChatEvent[];
  /** The cursor of the next older page (the `before` of the next read), or null. */
  more: string | null;
  /** The kitespan chat that already has this session (D49), or null. */
  chat: string | null;
  /** D58: the newest chat in the lists that holds a copy of this session (Continue in a copy), or null (W19d). */
  copy: string | null;
  /** D58: another process has the session open now; absent when none has. */
  open?: SessionOpen;
  /**
   * Row 77: a setting in Settings > Chats hides this session; the reply then holds no history (none was read), no chat
   * and no copy. Absent when the session shows.
   */
  hidden?: SessionHidden;
}

export type UploadFolderView = { ok: true; path: string } | { ok: false; line: string };

export interface UploadFolderReply {
  folder: UploadFolderView;
}

export interface UploadView {
  id: string;
  chat: string | null;
  /** Null for the browser pane's own upload (iteration 7, `?browser=1`). */
  project: string | null;
  name: string;
  size: number;
  type: string;
  /** The absolute path: its reference is messageRef's form in a message, or the single-quoted path in `!` mode (D50). */
  path: string;
  /** Round K1: its path before the folder move, which the messages sent before the move name; only for such an upload. */
  was?: string;
}

export interface UploadReply {
  upload: UploadView;
}

export interface UploadsReply {
  uploads: UploadView[];
}

export interface RemovedReply {
  removed: string;
}

/**
 * Why there is nothing to download: `missing` (gone, never there, a link whose target is gone, an unknown upload),
 * `outside` (the path leaves the chat's folder, or a link leads it outside, rule 2), `not_a_file` (a fifo, a socket,
 * a device), `no_chat` (no such chat).
 */
export type ExistsReason = "missing" | "outside" | "not_a_file" | "no_chat";

/** The existence probe's answer: what a download would send (the HEAD probe's facts), or why there is nothing. */
export type ExistsReply =
  | { exists: true; kind: "file"; name: string; size: number }
  /** `over`: the folder is over the archive's caps, so its download would be refused (`too_large`). */
  | { exists: true; kind: "folder"; name: string; entries: number; bytes: number; over: boolean }
  | { exists: false; reason: ExistsReason };

export interface SettingsReply {
  /** kitespan's own settings, each with its default when absent (4.4). */
  settings: Record<string, unknown>;
  /** Read only: they come from the start command and the local config, never from the page (4.4, 4.9). */
  server: { host: "127.0.0.1"; port: number; auth: "none"; version: string };
  /**
   * The access adapter's exact origins, and the lines about how to reach kitespan. `phoneLink` (v0.6 touch, T-14): the
   * link form that Open on phone's code fills with the encoded link, null when none is set; the server always sends it,
   * and a reply without it reads as null.
   */
  access: { origins: string[]; hint: string[]; phoneLink?: string | null };
  /** One line when adapters.json failed a check (the defaults apply then), else null. */
  adaptersProblem: string | null;
  /** The phone-browser notes for Settings > About (T-23): the public default's one line, or the owner's own. */
  phoneNotes: string[];
  /**
   * The binary pin (4.7), the drift line (4.10), and below kitespan's minimum Claude Code version its facts (rows 118,
   * 119; absent or null otherwise).
   */
  claude: { ok: boolean; path: string | null; realpath: string | null; version: string | null; drift: string | null; belowMinimum?: ClaudeBelow | null };
  /** The chosen upload folder, checked now (4.4). */
  uploads: UploadFolderView;
  /** The user's own Claude Code settings for `?project=`'s folder, read only (A13); null without a project. */
  agent: { respondToBash: boolean; cleanupPeriodDays: number | null; promptSuggestions: boolean; defaultMode: string | null } | null;
  /**
   * Settings > Account (6.8, A13): the provider that a live chat's Claude Code reports (`accountInfo().apiProvider`;
   * `provider` null when it reports none), `at` null. With no chat live, the one kept last (row 97), `at` when it was
   * read; null when none was kept: the row reads "Start a chat to read it".
   */
  account: { provider: string | null; at: string | null } | null;
  /**
   * Row 97: the start facts (fast mode, skills, plugins, output style) kept last with `?project=`'s project, else the
   * newest any project kept, and when they were read; null when none were. Settings shows them while no live chat has
   * its own.
   */
  facts: KeptFacts | null;
}

/** POST /api/settings: some of kitespan's own settings (server/store/types.ts Settings keys), each checked by the store. */
export type SettingsChange = Record<string, unknown>;

/** One folder inside the listed one (New environment's Browse, D54). Folders only: no file is ever named. */
export interface FolderEntry {
  name: string;
  /** Absolute, inside the listed folder. A symbolic link keeps its own path; POST /api/projects takes its real path. */
  path: string;
  /** It holds a `.git` entry (a repository, a worktree or a submodule). */
  git: boolean;
  /** It holds a subfolder (a dot folder counts only with `hidden=1`). */
  subfolders: boolean;
  /** A symbolic link to a folder. */
  link: boolean;
}

/** Why a folder has no listing: gone or never there, a file, no permission, any other read failure. */
export type FolderProblem = "missing" | "not_a_folder" | "denied" | "failed";

/**
 * GET /api/folders: `path` is absolute, `~`, or starts with `~/` (the home folder when absent); `hidden=1` adds the
 * dot folders; `q` keeps the folders whose name holds it (case and accents ignored, as the page's filter), before the
 * cap. `path` in the reply is the absolute, normalized folder (links kept as typed), `parent` its parent (null at
 * `/`), `home` the user's home folder. At most 500 folders, sorted by name; `truncated` when more matched. A folder
 * that cannot be read is still a 200 answer, with one plain line ("failed" when its read is later than 4 s). Any
 * other path is a 400.
 */
export type FoldersReply =
  | { ok: true; path: string; parent: string | null; home: string; folders: FolderEntry[]; truncated: boolean }
  | { ok: false; path: string; parent: string | null; home: string; reason: FolderProblem; line: string };

/** A folder that New environment suggests (D54). */
export interface SuggestedFolder {
  name: string;
  /** Absolute. */
  path: string;
  git: boolean;
  /** The kitespan project that already has this folder, or null. */
  project: string | null;
  /** A Claude Code session ran there, or a git repository under the home folder. */
  from: "session" | "repo";
}

/**
 * GET /api/folders/suggested: the folders of Claude Code's past sessions (newest first, at most 20, existing folders
 * only), then the git repositories under the home folder (depth 3 at most, by path, at most 200), each folder once.
 */
export interface SuggestedFoldersReply {
  folders: SuggestedFolder[];
}

/** GET /api/health (4.10 step 5): the boot epoch only, so the restart's health gate sees which server answers. */
export interface HealthReply {
  epoch: string;
}

/** Restart when they finish (the default) or Restart now (4.10). */
export type RestartWhen = "finish" | "now";

/** POST /api/restart's body. */
export interface RestartRequest {
  when: RestartWhen;
}

/** POST /api/restart's 202 answer: the preflight passed and the drain started; the restart follows on its own. */
export interface RestartAccepted {
  when: RestartWhen;
}

/** POST /api/restart/cancel: true when a restart that waited for the running turns was called off. */
export interface RestartCancelReply {
  cancelled: boolean;
}

/**
 * The registry's answer to a restart request (`ChatRegistry.drain`): the drain started (or, with `now`, a waiting one
 * went on at once), or the error code of its refusal (`restarting` while it cannot start one).
 */
export type DrainAnswer = { ok: true } | { ok: false; code: ErrorCode };

/**
 * GET /api/restart, read when the restart dialog opens (4.10, S3, S15): origin's line from the last check, the build's
 * line read now, and the chats whose Terminal pane runs a program (`known`) or may (the system did not say, which
 * counts as one in the clause under Restart now).
 */
export interface RestartReply {
  update: Extract<UpdateKind, "none" | "available" | "diverged">;
  build: Extract<UpdateKind, "none" | "apply" | "unfinished">;
  panes: { chat: string; known: boolean }[];
}

/**
 * GET /api/update (row 108), read when Settings > About opens, again while a job or a check runs, and after Check now:
 * origin's line from the last check, the build's line read now, the last check (when it ran, null for never; whether
 * it read origin; why it could not look, such as no upstream; whether one runs now), the server's update job, and
 * whether Update can run here at all (not in dev mode, and never for a Homebrew install). DESIGN-I1 3.6: how kitespan
 * was installed, and the versions an installed one names.
 */
export interface UpdateReply {
  update: RestartReply["update"];
  build: RestartReply["build"];
  check: { at: string | null; ok: boolean; why: UpdateRefusal | null; running: boolean };
  job: UpdateJob;
  can: boolean;
  /** How this kitespan was installed (server/update/kind.ts). */
  kind: "checkout" | "release" | "brew";
  /** A release install: the newest release the last check read, when it is newer than what runs and what current names; else null. */
  latest: string | null;
  /** A release or brew install: the version that the next start runs, when it is not the running one; else null. */
  next: string | null;
}

/** POST /api/update's 202 answer: the job that runs now (this press's, or the one it joined). */
export interface UpdateAccepted {
  job: UpdateJob;
}

/**
 * R130: one device that has notifications on, as every page sees it: never its endpoint (a capability) or its keys.
 * `id` is the hash of its endpoint (shared/push.ts pushDeviceId), so a page finds its own row; `titles` is its Show
 * chat titles; `failing`: the last notification did not go through.
 */
export interface PushDeviceView {
  id: string;
  name: string;
  titles: boolean;
  at: string;
  failing: boolean;
}

/** GET /api/push: the server's VAPID public key (base64url, the page's applicationServerKey), null before the first opt-in. */
export interface PushReply {
  key: string | null;
  devices: PushDeviceView[];
}

/** POST /api/push/key. */
export interface PushKeyReply {
  key: string;
}

/** POST /api/push/devices and /api/push/devices/:device. */
export interface PushDeviceReply {
  device: PushDeviceView;
}

/** POST /api/push/devices/:device/remove. */
export interface PushRemovedReply {
  removed: string;
}
