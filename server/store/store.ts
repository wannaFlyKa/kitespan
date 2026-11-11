// The store (DESIGN.md 4.4): kitespan's own state under `$XDG_STATE_HOME/kitespan`. open() makes the folders 0700,
// refuses a wider mode, another owner or a symbolic link anywhere under the state folder, sweeps stray `*.tmp` files
// and reads every record with its checks (a bad file is set aside as `.bad`). After that the records live in memory
// and every write goes through the one atomic writer (files.ts), one write at a time per file.
//
// Three records are written later than they change: a draft (the message box's, and from iteration 5 the side chat's
// box's, next to the side thread) and a chat's notes at most once a second per chat (D49), and a ledger whose only
// change is `seenAt`, `lastActivityAt` or `lastSeq` at most once per 30 s. flush() writes them all at shutdown. A
// chat's queue file (RD-8) is written at once, before the send's ack.

import { lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, sep } from "node:path";
import { isChatId } from "../../shared/ids";
import { LEGACY_FOLDER } from "../../shared/legacy";
import { messageRef, type DraftBox } from "../../shared/protocol";
import { productFolder, xdgBase } from "./places";
import { Serial, StoreError, checkTree, ownUid, readJson, setAside, sweepTmp, unlinkSynced, writeAtomic } from "./files";
import {
  RecordError,
  draftForSave,
  draftFrom,
  isCleanPath,
  isSettingKey,
  lastOptionsFrom,
  ledgerForWrite,
  ledgerFrom,
  projectFrom,
  projectsFrom,
  sameButActivity,
  settingOk,
  settingsFrom,
  uploadFrom,
  uploadsFileFrom,
  withDefaults,
} from "./records";
import {
  STORE_LIMITS,
  queueRecordOf,
  type ChatLedger,
  type DraftRecord,
  type LastOptionsRecord,
  type NotesRecord,
  type ProjectRecord,
  type QueueRecord,
  type Settings,
  type Store,
  type StoreDirs,
  type StoreOpenResult,
  type UploadRecord,
} from "./types";
import { emptyNotes, notesForSave, notesFrom } from "./notes";
import { SIDE_FILE_BYTES, sideRecordOf, type SideRecord } from "./side";
import { prepareUploadFolder, userTag, type UploadFolderResult, type UploadPlaces } from "./uploads";

/** Size caps of the files that 4.4 gives none (design values); the ledger's and the draft's are STORE_LIMITS'. */
export const FILE_CAPS = {
  projects: 1024 * 1024,
  settings: 64 * 1024,
  uploads: 4 * 1024 * 1024,
  lastOptions: 1024 * 1024,
} as const;

const PROJECTS = "projects.json";
const SETTINGS = "settings.json";
const LAST_OPTIONS = "last-options.json";
/** The upload records (the files are in their own `u-XXXXXX` folders). */
const UPLOADS = "uploads.json";
const LEDGER_FILE = /^([a-z2-7]{20})\.json$/;
/**
 * U1: a chat's marks' git objects, and the working folder of a mark (its private index, git's lock of it, the pathspec
 * file; server/changes/git.ts), which the boot's tree check leaves to git: their own mode is checked, not what they hold.
 */
const CHANGES_GIT = /^changes\/[a-z2-7]{20}\/(objects|mark)$/;
/**
 * Iteration 7 (DESIGN-B1 2.5; SERVER-B1 1 item 2): the shared browser's profile (Chrome's own links and 0644 files),
 * its downloads (Chrome writes 0644 files under a GUID name) and Chrome's temporary folder (its singleton socket).
 */
const BROWSER_OPAQUE: ReadonlySet<string> = new Set(["browser/profile", "browser/downloads", "browser/tmp"]);
/**
 * The folders of the state folder whose contents the tree check leaves alone: the boot's and `--check`'s
 * (preflight.ts). Their own mode is still checked.
 */
export const leftOpaque = (rel: string): boolean => CHANGES_GIT.test(rel) || BROWSER_OPAQUE.has(rel);

export interface StoreOptions {
  /**
   * A folder root for tests (a mkdtemp folder): the state folder is `<root>/state`, the config folder
   * `<root>/config`, and unless given, the home folder (for `~/.claude/uploads/`) `<root>/home` and the system's
   * temporary folder `<root>/tmp`. Without it the XDG rules decide.
   */
  root?: string;
  /** The environment for the XDG variables (default: process.env). */
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
  /** Where the Temporary upload folder lives (default: the system's temporary folder). */
  tmpRoot?: string;
  /** The user name in the Temporary folder's name (default: the server's user). */
  user?: string;
  now?: () => number;
  /** Test values for the write windows of STORE_LIMITS. */
  draftWriteMs?: number;
  notesWriteMs?: number;
  activityWriteMs?: number;
  /** A test value for the projects file's cap (FILE_CAPS.projects), on read and on write. */
  projectsBytes?: number;
  /** Called after each file the store writes (the path relative to the state folder). */
  onWrite?: (path: string) => void;
  /** Called once for each file set aside as `.bad` after open() (open() returns its own list). */
  onSetAside?: (path: string) => void;
  /** Called when a write that no caller waits for fails (a timed draft or ledger write). */
  onError?: (err: unknown, path: string) => void;
}

/**
 * The XDG folders (an empty or relative variable is ignored, as the XDG rules say), by places.ts's rule: the folder of
 * the old name while it is pending (not moved yet), else the new name's.
 */
export function storeDirs(env: Readonly<Record<string, string | undefined>>, home: string): StoreDirs {
  return dirsUnder(productFolder("state", xdgBase("state", env, home)), productFolder("config", xdgBase("config", env, home)));
}

/**
 * After the move (move.ts), uploads.json still names each upload of the state folder's own upload folder by the old
 * folder's path: those paths now lead to the old path's note. Each is read as the same upload under `uploads`, and
 * keeps its old path as `was`: the messages sent before the move name it so.
 */
function movedUploads(list: UploadRecord[], uploads: string): UploadRecord[] | null {
  const oldPrefix = join(dirname(dirname(uploads)), LEGACY_FOLDER, "uploads") + sep;
  if (uploads + sep === oldPrefix) return null;
  let changed = false;
  const next = list.map((u) => {
    if (u.folder !== "state" || !u.dir.startsWith(oldPrefix) || !u.path.startsWith(oldPrefix)) return u;
    changed = true;
    return { ...u, dir: join(uploads, u.dir.slice(oldPrefix.length)), path: join(uploads, u.path.slice(oldPrefix.length)), was: u.path };
  });
  return changed ? next : null;
}

/**
 * A message that waits names each of its uploads by the path it had at the send (withUploadRefs): one that the folder
 * move took is named by its new path now, so Claude Code reads the file when the message goes. Only the message's own
 * uploads, and only where a reference stands (white space or an edge on each side).
 */
function queueAfterMove(rec: QueueRecord, uploads: readonly UploadRecord[]): QueueRecord {
  const moved = new Map(uploads.filter((u) => u.was !== undefined).map((u) => [u.id, u]));
  if (moved.size === 0) return rec;
  const msgs = rec.msgs.map((m) => {
    let text = m.text;
    for (const id of m.uploads) {
      const u = moved.get(id);
      if (u) text = swapRef(text, messageRef(u.was!), messageRef(u.path));
    }
    return text === m.text ? m : { ...m, text };
  });
  return msgs.every((m, i) => m === rec.msgs[i]) ? rec : { ...rec, msgs };
}

/** `text` with each reference `from` that stands on its own (white space or an edge on each side) as `to`. */
function swapRef(text: string, from: string, to: string): string {
  let out = "";
  let pos = 0;
  for (let at = text.indexOf(from); at >= 0; at = text.indexOf(from, at + from.length)) {
    const end = at + from.length;
    if ((at > 0 && !/\s/.test(text[at - 1]!)) || (end < text.length && !/\s/.test(text[end]!))) continue;
    out += text.slice(pos, at) + to;
    pos = end;
  }
  return out + text.slice(pos);
}

function dirsUnder(state: string, config: string): StoreDirs {
  return {
    state,
    config,
    chats: join(state, "chats"),
    drafts: join(state, "drafts"),
    notes: join(state, "notes"),
    uploads: join(state, "uploads"),
    logs: join(state, "logs"),
    queue: join(state, "queue"),
    env: join(state, "env"),
    side: join(state, "side"),
    changes: join(state, "changes"),
  };
}

interface LedgerEntry {
  rec: ChatLedger;
  dirty: boolean;
  lastWriteAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface DraftEntry {
  rec: DraftRecord;
  dirty: boolean;
  lastWriteAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface NotesEntry {
  rec: NotesRecord;
  dirty: boolean;
  lastWriteAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const copy = <T>(v: T): T => structuredClone(v);

/** The project with its kept command and model lists frozen, so reads may share them (listProjects). */
function frozenLists(p: ProjectRecord): ProjectRecord {
  const c = p.commands;
  if (c && !Object.isFrozen(c)) {
    for (const row of c.list) {
      Object.freeze(row.aliases);
      Object.freeze(row);
    }
    Object.freeze(c.list);
    Object.freeze(c);
  }
  const m = p.models;
  if (m && !Object.isFrozen(m)) {
    for (const row of m.list) {
      Object.freeze(row.efforts);
      Object.freeze(row);
    }
    Object.freeze(m.list);
    Object.freeze(m);
  }
  return p;
}

/** The project without one of its kept lists (projectsText). */
function without(p: ProjectRecord, list: "commands" | "models"): ProjectRecord {
  const { [list]: _dropped, ...rest } = p;
  return rest;
}

/** A read check's failure, which sets the file aside. */
function badRecord(why: string): never {
  throw new RecordError(why);
}

function badValue(e: unknown): never {
  if (e instanceof RecordError) throw new StoreError("bad_value", e.message);
  throw e;
}

/** A record checked for a write; a bad one is the caller's error. */
function checked<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    return badValue(e);
  }
}

/** JSON for last-options.json: callbacks as "[function]" (4.7), a bigint as its digits, undefined dropped. */
function optionsJson(rec: LastOptionsRecord): string {
  return JSON.stringify(rec, (_k, v) => (typeof v === "function" ? "[function]" : typeof v === "bigint" ? v.toString() : v), 2);
}

export class FileStore implements Store {
  readonly dirs: StoreDirs;
  readonly uploadPlaces: UploadPlaces;
  private readonly uid = ownUid();
  private readonly now: () => number;
  private readonly draftWriteMs: number;
  private readonly notesWriteMs: number;
  private readonly activityWriteMs: number;
  private readonly projectsBytes: number;
  private readonly opts: StoreOptions;
  private readonly serial = new Serial();
  private opened = false;
  private ledgers = new Map<string, LedgerEntry>();
  /** Each box's draft, by its file's path relative to the state folder (draftFile's `rel`). */
  private drafts = new Map<string, DraftEntry>();
  private notes = new Map<string, NotesEntry>();
  /** Deleted chats: a late write for one is dropped, so a deleted chat's files never come back. Ids are never reused. */
  private gone = new Set<string>();
  /** Row 99: removed projects, whose late writes are dropped as a deleted chat's are. */
  private goneProjects = new Set<string>();
  private projects: ProjectRecord[] = [];
  private settings: Partial<Settings> = {};
  private uploads: UploadRecord[] = [];

  constructor(opts: StoreOptions = {}) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.draftWriteMs = opts.draftWriteMs ?? STORE_LIMITS.draftWriteMs;
    this.notesWriteMs = opts.notesWriteMs ?? STORE_LIMITS.notesWriteMs;
    this.activityWriteMs = opts.activityWriteMs ?? STORE_LIMITS.activityWriteMs;
    this.projectsBytes = opts.projectsBytes ?? FILE_CAPS.projects;
    const root = opts.root;
    const home = opts.home ?? (root ? join(root, "home") : homedir());
    this.dirs = root ? dirsUnder(join(root, "state"), join(root, "config")) : storeDirs(opts.env ?? process.env, home);
    let name: string | undefined = opts.user;
    if (name === undefined) {
      try {
        name = userInfo().username;
      } catch {
        name = undefined;
      }
    }
    this.uploadPlaces = {
      stateUploads: this.dirs.uploads,
      tmpRoot: opts.tmpRoot ?? (root ? join(root, "tmp") : tmpdir()),
      home,
      user: userTag(name, this.uid),
      uid: this.uid,
    };
  }

  private need(): void {
    if (!this.opened) throw new StoreError("not_open", "the store is not open");
  }

  private wrote(rel: string): void {
    this.opts.onWrite?.(rel);
  }

  private failed(err: unknown, rel: string): void {
    this.opts.onError?.(err, rel);
  }

  /** Read one record file; a file that fails a check is set aside and reported. */
  private async readRecord<T>(dir: string, name: string, rel: string, max: number, check: (raw: unknown) => T, setAsideList?: string[]): Promise<T | null> {
    const r = await readJson(join(dir, name), max, this.uid);
    if (r.kind === "absent") return null;
    if (r.kind === "ok") {
      try {
        return check(r.value);
      } catch (e) {
        if (!(e instanceof RecordError)) throw e;
      }
    }
    await setAside(dir, name);
    if (setAsideList) setAsideList.push(rel);
    else this.opts.onSetAside?.(rel);
    return null;
  }

  async open(): Promise<StoreOpenResult> {
    if (this.opened) throw new StoreError("bad_value", "the store is open already");
    const { state, chats, drafts, notes, uploads, logs, queue, env, side, changes } = this.dirs;
    for (const dir of [state, chats, drafts, notes, uploads, logs, queue, env, side, changes]) {
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      } catch {
        // a file or a link in its place: the check below names it
      }
    }
    // U1: the git objects of a chat's marks are git's own files (read-only, in folders of git's making) inside the
    // chat's 0700 changes folder: the check stops at that folder.
    const problems = await checkTree(state, this.uid, leftOpaque);
    for (const name of ["chats", "drafts", "notes", "uploads", "logs", "queue", "env", "side", "changes"]) {
      const st = lstatSync(join(state, name), { throwIfNoEntry: false });
      if (st && !st.isDirectory() && !st.isSymbolicLink()) problems.push({ path: name, why: "not-a-folder" });
    }
    if (problems.length > 0) throw new StoreError("refused", "the state folder failed its checks", problems);

    // env/ (D60): a stray temporary file there may hold a variable's value. Its records are server/env/store.ts's.
    let swept = 0;
    for (const dir of [state, chats, drafts, notes, queue, env, side]) swept += await sweepTmp(dir);

    const setAsideList: string[] = [];
    this.projects = ((await this.readRecord(state, PROJECTS, PROJECTS, this.projectsBytes, projectsFrom, setAsideList))?.projects ?? []).map(frozenLists);
    this.settings = (await this.readRecord(state, SETTINGS, SETTINGS, FILE_CAPS.settings, settingsFrom, setAsideList)) ?? {};
    this.uploads = (await this.readRecord(state, UPLOADS, UPLOADS, FILE_CAPS.uploads, uploadsFileFrom, setAsideList))?.uploads ?? [];
    const moved = movedUploads(this.uploads, uploads);
    if (moved) {
      this.uploads = moved;
      await this.writeUploads();
    }

    const list: ChatLedger[] = [];
    for (const name of (await readdir(chats)).sort()) {
      const m = LEDGER_FILE.exec(name);
      if (!m) continue;
      const id = m[1]!;
      const rec = await this.readRecord(chats, name, `chats/${name}`, STORE_LIMITS.ledgerBytes, (raw) => ledgerFrom(raw, id), setAsideList);
      if (!rec) continue;
      this.ledgers.set(id, { rec, dirty: false, lastWriteAt: 0, timer: null });
      list.push(copy(rec));
    }
    this.opened = true;
    return { chats: list, setAside: setAsideList, swept };
  }

  // -------------------------------------------------------------------------------------------------------------
  // Ledgers

  async readChat(id: string): Promise<ChatLedger | null> {
    this.need();
    if (!isChatId(id)) return null;
    const e = this.ledgers.get(id);
    return e ? copy(e.rec) : null;
  }

  async writeChat(rec: ChatLedger): Promise<void> {
    this.need();
    const next = checked(() => ledgerForWrite(rec));
    if (this.gone.has(next.id)) return;
    if (Buffer.byteLength(JSON.stringify(next)) > STORE_LIMITS.ledgerBytes) throw new StoreError("too_large", "the ledger would be over 64 KB");
    const e = this.ledgers.get(next.id);
    if (e && sameButActivity(e.rec, next)) {
      e.rec = next;
      e.dirty = true;
      const wait = e.lastWriteAt + this.activityWriteMs - this.now();
      if (wait > 0) {
        if (!e.timer) e.timer = this.later(wait, () => this.writeLedgerNow(next.id), `chats/${next.id}.json`);
        return;
      }
    } else if (e) {
      e.rec = next;
      e.dirty = true;
    } else {
      this.ledgers.set(next.id, { rec: next, dirty: true, lastWriteAt: 0, timer: null });
    }
    await this.writeLedgerNow(next.id);
  }

  private later(ms: number, job: () => Promise<void>, rel: string): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => {
      job().catch((err) => this.failed(err, rel));
    }, ms);
    t.unref?.();
    return t;
  }

  /** Write the newest state of one ledger, if it still has a change (serialised per file). */
  private writeLedgerNow(id: string): Promise<void> {
    const rel = `chats/${id}.json`;
    return this.serial.run(rel, async () => {
      const e = this.ledgers.get(id);
      if (!e || this.gone.has(id)) return;
      if (e.timer) clearTimeout(e.timer);
      e.timer = null;
      if (!e.dirty) return;
      e.dirty = false;
      e.lastWriteAt = this.now();
      try {
        await writeAtomic(this.dirs.chats, `${id}.json`, JSON.stringify(e.rec), STORE_LIMITS.ledgerBytes, this.uid);
      } catch (err) {
        e.dirty = true;
        throw err;
      }
      this.wrote(rel);
    });
  }

  /**
   * D48: unlink the ledger, the drafts (the message box's and the side box's), the notes, the queue file and the side
   * file (each with an fsync of its folder) and forget the chat's upload records.
   * Pending writes of the chat are dropped first, and a later write for it is ignored.
   */
  async deleteChat(id: string): Promise<void> {
    this.need();
    if (!isChatId(id)) throw new StoreError("bad_value", "not a chat id");
    this.gone.add(id);
    for (const [map, key] of [
      [this.ledgers, id],
      [this.drafts, this.draftFile(id, "main").rel],
      [this.drafts, this.draftFile(id, "side").rel],
      [this.notes, id],
    ] as [Map<string, { timer: ReturnType<typeof setTimeout> | null }>, string][]) {
      const e = map.get(key);
      if (e?.timer) clearTimeout(e.timer);
      map.delete(key);
    }
    await this.serial.run(`chats/${id}.json`, () => unlinkSynced(this.dirs.chats, `${id}.json`));
    for (const box of ["main", "side"] as const) {
      const f = this.draftFile(id, box);
      await this.serial.run(f.rel, () => unlinkSynced(f.dir, f.name));
    }
    await this.serial.run(`notes/${id}.json`, () => unlinkSynced(this.dirs.notes, `${id}.json`));
    await this.serial.run(`queue/${id}.json`, () => unlinkSynced(this.dirs.queue, `${id}.json`));
    await this.serial.run(`side/${id}.json`, () => unlinkSynced(this.dirs.side, `${id}.json`));
    const kept = this.uploads.filter((u) => u.chat !== id);
    if (kept.length !== this.uploads.length) {
      this.uploads = kept;
      await this.writeUploads();
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Projects, settings, last options

  /** A copy of every project; a kept command or model list is shared, frozen, rather than copied at each read (D59). */
  async listProjects(): Promise<ProjectRecord[]> {
    this.need();
    return this.projects.map(({ commands, models, ...p }) => ({ ...copy(p), ...(commands ? { commands } : {}), ...(models ? { models } : {}) }));
  }

  async putProject(rec: ProjectRecord): Promise<void> {
    await this.putProjects([rec]);
  }

  async putProjects(recs: readonly ProjectRecord[]): Promise<void> {
    this.need();
    const nexts = recs.map((rec) => frozenLists(checked(() => projectFrom(rec)))).filter((p) => !this.goneProjects.has(p.id));
    if (nexts.length === 0) return;
    let list = this.projects;
    for (const next of nexts) {
      if (list.some((p) => p.cwd === next.cwd && p.id !== next.id)) throw new StoreError("bad_value", "another project has this folder");
      const i = list.findIndex((p) => p.id === next.id);
      list = i < 0 ? [...list, next] : list.map((p, j) => (j === i ? next : p));
    }
    this.projects = list;
    await this.writeProjects();
  }

  async removeProject(id: string): Promise<ProjectRecord | null> {
    this.need();
    const rec = this.projects.find((p) => p.id === id);
    this.goneProjects.add(id);
    if (!rec) return null;
    this.projects = this.projects.filter((p) => p.id !== id);
    await this.writeProjects();
    const kept = this.uploads.filter((u) => !(u.chat === null && u.project === id));
    if (kept.length !== this.uploads.length) {
      this.uploads = kept;
      await this.writeUploads();
    }
    return copy(rec);
  }

  private writeProjects(): Promise<void> {
    return this.serial.run(PROJECTS, async () => {
      await writeAtomic(this.dirs.state, PROJECTS, this.projectsText(), this.projectsBytes, this.uid);
      this.wrote(PROJECTS);
    });
  }

  /**
   * The text of projects.json. Past the file's cap, the oldest kept lists go first, command lists (D59) and model lists
   * (row 81) alike (caches), so a list never stops a project from being written; with none left, the write refuses as
   * before.
   */
  private projectsText(): string {
    for (;;) {
      const text = JSON.stringify({ v: 1, projects: this.projects }, null, 2);
      if (Buffer.byteLength(text) <= this.projectsBytes) return text;
      let oldest: { p: ProjectRecord; list: "commands" | "models"; at: string } | null = null;
      for (const p of this.projects) {
        for (const list of ["commands", "models"] as const) {
          const at = p[list]?.at;
          if (at !== undefined && (!oldest || at < oldest.at)) oldest = { p, list, at };
        }
      }
      if (!oldest) return text;
      const { p: drop, list } = oldest;
      this.projects = this.projects.map((p) => (p === drop ? without(p, list) : p));
    }
  }

  async readSettings(): Promise<Settings> {
    this.need();
    return withDefaults(copy(this.settings));
  }

  /**
   * Apply a change and return the whole settings object with defaults. A key set to undefined goes back to its
   * default. An unknown key or a bad value rejects with `bad_value` and changes nothing. A custom upload folder is
   * stored as its real path (symbolic links resolved) and must be an existing folder (4.4, Custom folder). An old look
   * id is stored as its new one (row 105).
   */
  async writeSettings(change: Partial<Settings>): Promise<Settings> {
    this.need();
    const next: Record<string, unknown> = { ...this.settings };
    for (const [key, value] of Object.entries(change)) {
      if (!isSettingKey(key)) throw new StoreError("bad_value", `${key}: not a setting`);
      if (value === undefined) {
        delete next[key];
        continue;
      }
      let v: unknown = value;
      if (key === "uploads.customFolder" && v !== null) {
        if (!isCleanPath(v)) throw new StoreError("bad_value", `${key}: not a clean absolute path`);
        v = this.realFolder(v);
      }
      if (!settingOk(key, v)) throw new StoreError("bad_value", `${key}: bad value`);
      next[key] = v;
    }
    this.settings = next as Partial<Settings>;
    await this.serial.run(SETTINGS, async () => {
      await writeAtomic(this.dirs.state, SETTINGS, JSON.stringify(this.settings, null, 2), FILE_CAPS.settings, this.uid);
      this.wrote(SETTINGS);
    });
    return withDefaults(copy(this.settings));
  }

  private realFolder(p: string): string {
    let real: string;
    try {
      real = realpathSync(p);
    } catch {
      throw new StoreError("bad_value", "uploads.customFolder: the folder does not exist");
    }
    if (!statSync(real).isDirectory()) throw new StoreError("bad_value", "uploads.customFolder: not a folder");
    return real;
  }

  /** Written at every chat start, before query() is called; it replaces the previous file. */
  async writeLastOptions(rec: LastOptionsRecord): Promise<void> {
    this.need();
    const text = optionsJson(rec);
    checked(() => lastOptionsFrom(JSON.parse(text)));
    await this.serial.run(LAST_OPTIONS, async () => {
      await writeAtomic(this.dirs.state, LAST_OPTIONS, text, FILE_CAPS.lastOptions, this.uid);
      this.wrote(LAST_OPTIONS);
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Drafts (D49): the message box's in drafts/, and (FIX-U2) the side chat's box's next to the side thread in side/,
  // under one set of rules: in memory at once, a file at most once per window and at flush, 128 KiB, a bad file set
  // aside

  /** Where a box's draft lives; `rel` (relative to the state folder) is also its key in `drafts`. */
  private draftFile(chat: string, box: DraftBox): { dir: string; name: string; rel: string } {
    return box === "side" ? { dir: this.dirs.side, name: `${chat}.draft.json`, rel: `side/${chat}.draft.json` } : { dir: this.dirs.drafts, name: `${chat}.json`, rel: `drafts/${chat}.json` };
  }

  private emptyDraft(chat: string, box: DraftBox): DraftRecord {
    return { v: 1, id: chat, ...(box === "side" ? { box } : {}), rev: 0, text: "", mode: "chat", command: null, link: false, uploads: [], by: null, at: new Date(this.now()).toISOString() };
  }

  async readDraft(chat: string, box: DraftBox = "main"): Promise<DraftRecord> {
    this.need();
    if (!isChatId(chat)) throw new StoreError("bad_value", "not a chat id");
    const { dir, name, rel } = this.draftFile(chat, box);
    const e = this.drafts.get(rel);
    if (e) return copy(e.rec);
    if (this.gone.has(chat)) return this.emptyDraft(chat, box);
    const rec =
      (await this.serial.run(rel, () => this.readRecord(dir, name, rel, STORE_LIMITS.draftBytes, (raw) => draftFrom(raw, chat, box)))) ?? this.emptyDraft(chat, box);
    // A save that came while the file was read is newer.
    const now = this.drafts.get(rel);
    if (now) return copy(now.rec);
    if (!this.gone.has(chat)) this.drafts.set(rel, { rec, dirty: false, lastWriteAt: 0, timer: null });
    return copy(rec);
  }

  saveDraft(rec: DraftRecord): void {
    this.need();
    const next = checked(() => draftForSave(rec));
    if (this.gone.has(next.id)) return;
    if (Buffer.byteLength(JSON.stringify(next)) > STORE_LIMITS.draftBytes) throw new StoreError("too_large", "the draft would be over 128 KiB");
    const { rel } = this.draftFile(next.id, next.box ?? "main");
    let e = this.drafts.get(rel);
    if (!e) {
      e = { rec: next, dirty: true, lastWriteAt: 0, timer: null };
      this.drafts.set(rel, e);
    } else {
      e.rec = next;
      e.dirty = true;
    }
    if (!e.timer) e.timer = this.later(Math.max(0, e.lastWriteAt + this.draftWriteMs - this.now()), () => this.writeDraftNow(rel), rel);
  }

  /** Write the draft kept under `rel` (draftFile's) now, when it changed since its last write. */
  private writeDraftNow(rel: string): Promise<void> {
    return this.serial.run(rel, async () => {
      const e = this.drafts.get(rel);
      if (!e || this.gone.has(e.rec.id)) return;
      if (e.timer) clearTimeout(e.timer);
      e.timer = null;
      if (!e.dirty) return;
      e.dirty = false;
      e.lastWriteAt = this.now();
      const { dir, name } = this.draftFile(e.rec.id, e.rec.box ?? "main");
      try {
        await writeAtomic(dir, name, JSON.stringify(e.rec), STORE_LIMITS.draftBytes, this.uid);
      } catch (err) {
        e.dirty = true;
        throw err;
      }
      this.wrote(rel);
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // A chat's notes: its closed cards and its `!` rows' own ids (notes.ts)

  async readNotes(chat: string): Promise<NotesRecord> {
    this.need();
    if (!isChatId(chat)) throw new StoreError("bad_value", "not a chat id");
    const e = this.notes.get(chat);
    if (e) return copy(e.rec);
    if (this.gone.has(chat)) return emptyNotes(chat);
    const rel = `notes/${chat}.json`;
    const rec =
      (await this.serial.run(rel, () => this.readRecord(this.dirs.notes, `${chat}.json`, rel, STORE_LIMITS.notesBytes, (raw) => notesFrom(raw, chat)))) ??
      emptyNotes(chat);
    // A save that came while the file was read is newer.
    const now = this.notes.get(chat);
    if (now) return copy(now.rec);
    if (!this.gone.has(chat)) this.notes.set(chat, { rec, dirty: false, lastWriteAt: 0, timer: null });
    return copy(rec);
  }

  saveNotes(rec: NotesRecord): void {
    this.need();
    const next = checked(() => notesForSave(rec));
    if (this.gone.has(next.id)) return;
    let e = this.notes.get(next.id);
    if (!e) {
      e = { rec: next, dirty: true, lastWriteAt: 0, timer: null };
      this.notes.set(next.id, e);
    } else {
      e.rec = next;
      e.dirty = true;
    }
    if (!e.timer) {
      const id = next.id;
      e.timer = this.later(Math.max(0, e.lastWriteAt + this.notesWriteMs - this.now()), () => this.writeNotesNow(id), `notes/${id}.json`);
    }
  }

  private writeNotesNow(id: string): Promise<void> {
    const rel = `notes/${id}.json`;
    return this.serial.run(rel, async () => {
      const e = this.notes.get(id);
      if (!e || this.gone.has(id)) return;
      if (e.timer) clearTimeout(e.timer);
      e.timer = null;
      if (!e.dirty) return;
      e.dirty = false;
      e.lastWriteAt = this.now();
      try {
        await writeAtomic(this.dirs.notes, `${id}.json`, JSON.stringify(e.rec), STORE_LIMITS.notesBytes, this.uid);
      } catch (err) {
        e.dirty = true;
        throw err;
      }
      this.wrote(rel);
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // A chat's queue file (RD-8): the messages that wait in it, read at boot, written before each send's ack

  async readQueue(chat: string): Promise<QueueRecord | null> {
    this.need();
    if (!isChatId(chat) || this.gone.has(chat)) return null;
    const rel = `queue/${chat}.json`;
    const check = (raw: unknown) => queueRecordOf(raw, chat) ?? badRecord("queue: fails its check");
    const rec = await this.serial.run(rel, () => this.readRecord(this.dirs.queue, `${chat}.json`, rel, STORE_LIMITS.queueBytes, check));
    return rec && rec.msgs.length > 0 ? queueAfterMove(rec, this.uploads) : null;
  }

  async writeQueue(rec: QueueRecord): Promise<void> {
    this.need();
    const next = queueRecordOf(rec);
    if (!next) throw new StoreError("bad_value", "the queue record fails its check");
    const text = JSON.stringify(next);
    if (Buffer.byteLength(text) > STORE_LIMITS.queueBytes) throw new StoreError("too_large", "the queue file would be over 4 MiB");
    const rel = `queue/${next.id}.json`;
    await this.serial.run(rel, async () => {
      if (this.gone.has(next.id)) return;
      if (next.msgs.length === 0) {
        await unlinkSynced(this.dirs.queue, `${next.id}.json`);
        return;
      }
      await writeAtomic(this.dirs.queue, `${next.id}.json`, text, STORE_LIMITS.queueBytes, this.uid);
      this.wrote(rel);
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // A chat's side thread (R124, side.ts): read when the chat's side chat is first needed, written at once at each change

  async readSide(chat: string): Promise<SideRecord | null> {
    this.need();
    if (!isChatId(chat) || this.gone.has(chat)) return null;
    const rel = `side/${chat}.json`;
    const check = (raw: unknown) => sideRecordOf(raw, chat) ?? badRecord("side: fails its check");
    return this.serial.run(rel, () => this.readRecord(this.dirs.side, `${chat}.json`, rel, SIDE_FILE_BYTES, check));
  }

  async writeSide(rec: SideRecord): Promise<void> {
    this.need();
    const next = sideRecordOf(rec);
    if (!next) throw new StoreError("bad_value", "the side record fails its check");
    const text = JSON.stringify(next);
    if (Buffer.byteLength(text) > SIDE_FILE_BYTES) throw new StoreError("too_large", "the side file would be over 1 MiB");
    const rel = `side/${next.id}.json`;
    await this.serial.run(rel, async () => {
      if (this.gone.has(next.id)) return;
      await writeAtomic(this.dirs.side, `${next.id}.json`, text, SIDE_FILE_BYTES, this.uid);
      this.wrote(rel);
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Upload records

  async listUploads(chat: string | null): Promise<UploadRecord[]> {
    this.need();
    return copy(this.uploads.filter((u) => u.chat === chat));
  }

  async putUpload(rec: UploadRecord): Promise<void> {
    this.need();
    const next = checked(() => uploadFrom(rec));
    if (next.chat !== null && this.gone.has(next.chat)) throw new StoreError("bad_value", "the chat was deleted");
    const i = this.uploads.findIndex((u) => u.id === next.id);
    this.uploads = i < 0 ? [...this.uploads, next] : this.uploads.map((u, j) => (j === i ? next : u));
    await this.writeUploads();
  }

  /** Iteration 7: one upload by its id, whatever its owner (a file chooser's answer names it). */
  async findUpload(id: string): Promise<UploadRecord | null> {
    this.need();
    const rec = this.uploads.find((u) => u.id === id);
    return rec ? copy(rec) : null;
  }

  async removeUpload(id: string): Promise<UploadRecord | null> {
    this.need();
    const rec = this.uploads.find((u) => u.id === id);
    if (!rec) return null;
    this.uploads = this.uploads.filter((u) => u.id !== id);
    await this.writeUploads();
    return copy(rec);
  }

  private writeUploads(): Promise<void> {
    return this.serial.run(UPLOADS, async () => {
      await writeAtomic(this.dirs.state, UPLOADS, JSON.stringify({ v: 1, uploads: this.uploads }), FILE_CAPS.uploads, this.uid);
      this.wrote(UPLOADS);
    });
  }

  /**
   * The upload folder of the current settings, made where its rule says and checked (uploads.ts). `sessionId` is the
   * chat's session id, which Claude Code's uploads folder needs (D41).
   */
  async uploadFolder(sessionId: string | null): Promise<UploadFolderResult> {
    const s = await this.readSettings();
    return prepareUploadFolder(s["uploads.folder"], this.uploadPlaces, { customFolder: s["uploads.customFolder"], sessionId });
  }

  // -------------------------------------------------------------------------------------------------------------

  /** Write every pending draft, notes file and ledger, and wait for every queued write (shutdown). */
  async flush(): Promise<void> {
    if (!this.opened) return;
    const jobs: Promise<void>[] = [];
    for (const [rel, e] of this.drafts) if (e.dirty) jobs.push(this.writeDraftNow(rel));
    for (const [id, e] of this.notes) if (e.dirty) jobs.push(this.writeNotesNow(id));
    for (const [id, e] of this.ledgers) if (e.dirty) jobs.push(this.writeLedgerNow(id));
    const results = await Promise.allSettled(jobs);
    await this.serial.idle();
    const bad = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (bad) throw bad.reason;
  }
}

export function createStore(opts: StoreOptions = {}): FileStore {
  return new FileStore(opts);
}
