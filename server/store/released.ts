// Row 99: `released.json`, the Claude Code sessions that an environment's Remove released, by folder (the project's real
// path). A removed chat's transcript is kitespan's own (the SDK's, sdk-ts), which From the terminal never lists (L5);
// these are the exceptions, so a folder added again lists its removed chats' conversations. Each id is kept once, in
// the folder that released it last, with the folder that holds its transcript when that is not the project's (a
// worktree chat's: its worktree's, or the sessionDir of W4's Continue in the project folder, which may be gone); a
// folder keeps its newest RELEASED_LIMITS.perFolder ids, the file its newest folders and ids, the oldest going first.
// A Continue here or a Continue in a copy of one takes it out (unrelease). The file is checked on every read (a bad
// one is set aside as `.bad`), and written through the store's atomic writer (0600, fsync, rename), one write at a
// time.

import { join } from "node:path";
import { UUID } from "../../shared/ids";
import { Serial, readJson, setAside, writeAtomic } from "./files";
import { RecordError, isCleanPath } from "./records";

export const RELEASED = "released.json";

export const RELEASED_LIMITS = {
  /** The ids a folder keeps (the oldest go first). */
  perFolder: 2_000,
  /** The ids and the folders the file keeps (the oldest folder's oldest ids go first). */
  total: 20_000,
  folders: 500,
  bytes: 4 * 1024 * 1024,
} as const;

/** One folder's released sessions, the oldest first. */
export interface ReleasedFolder {
  cwd: string;
  ids: string[];
  /** The folder that holds the transcript of each id whose is not `cwd` (Claude Code files it where it ran). */
  at?: Record<string, string>;
}

/** A released session, and the folder that Claude Code filed its transcript under (the chat's sessionFolder). */
export interface ReleasedSession {
  id: string;
  dir: string;
}

/** `released.json`: the folders, the one released from longest ago first. */
export interface ReleasedFile {
  v: 1;
  folders: ReleasedFolder[];
}

const fail = (why: string): never => {
  throw new RecordError(why);
};

/**
 * The record check: version 1, clean absolute paths each once, session ids each once in the file, within the caps; a
 * transcript's folder only for an id of its own folder, a clean absolute path that is not that folder.
 */
export function releasedFrom(raw: unknown): ReleasedFile {
  const o = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : fail("released: not an object");
  if (o.v !== 1) fail("released: not version 1");
  const list = o.folders;
  if (!Array.isArray(list) || list.length > RELEASED_LIMITS.folders) fail("released: folders is not a list within its cap");
  const cwds = new Set<string>();
  const seen = new Set<string>();
  const folders: ReleasedFolder[] = [];
  for (const f of list as unknown[]) {
    const r = typeof f === "object" && f !== null ? (f as Record<string, unknown>) : fail("released: a folder is not an object");
    if (!isCleanPath(r.cwd) || cwds.has(r.cwd)) fail("released: a folder is not a clean absolute path, or comes twice");
    const ids = r.ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > RELEASED_LIMITS.perFolder) fail("released: ids is not a list within its cap");
    for (const id of ids as unknown[]) {
      if (typeof id !== "string" || !UUID.test(id) || seen.has(id)) fail("released: an id is not a session id, or comes twice");
      seen.add(id as string);
    }
    const at = r.at === undefined ? undefined : typeof r.at === "object" && r.at !== null && !Array.isArray(r.at) ? (r.at as Record<string, unknown>) : fail("released: at is not an object");
    const own = new Set(ids as string[]);
    for (const [id, dir] of Object.entries(at ?? {})) if (!own.has(id) || !isCleanPath(dir) || dir === r.cwd) fail("released: a transcript's folder is not one of the folder's ids, or not a clean path");
    cwds.add(r.cwd as string);
    folders.push(folderOf(r.cwd as string, [...(ids as string[])], at as Record<string, string> | undefined));
  }
  if (seen.size > RELEASED_LIMITS.total) fail("released: more ids than the cap");
  return { v: 1, folders };
}

/** A folder's record: its ids, and the transcript folders of those ids only (none at all when it has none). */
function folderOf(cwd: string, ids: string[], at: Readonly<Record<string, string>> | undefined): ReleasedFolder {
  const kept = Object.fromEntries(ids.flatMap((id) => (at?.[id] !== undefined ? [[id, at[id]!]] : [])));
  return Object.keys(kept).length ? { cwd, ids, at: kept } : { cwd, ids };
}

/**
 * The file with `sessions` released from `cwd` (each id once, in this folder, the newest last, with its transcript's
 * folder when that is not `cwd`), cut to the caps.
 */
export function withReleased(file: ReleasedFile, cwd: string, sessions: readonly ReleasedSession[]): ReleasedFile {
  const dirs = new Map(sessions.filter((s) => UUID.test(s.id)).map((s) => [s.id, s.dir]));
  const fresh = [...dirs.keys()];
  if (!fresh.length) return file;
  const out = new Set(fresh);
  const others = file.folders.filter((f) => f.cwd !== cwd).map((f) => folderOf(f.cwd, f.ids.filter((id) => !out.has(id)), f.at));
  const was = file.folders.find((f) => f.cwd === cwd);
  const kept = (was?.ids ?? []).filter((id) => !out.has(id));
  const at: Record<string, string> = { ...was?.at };
  for (const [id, dir] of dirs) {
    if (dir !== cwd && isCleanPath(dir)) at[id] = dir;
    else delete at[id];
  }
  const folders = [...others, folderOf(cwd, [...kept, ...fresh].slice(-RELEASED_LIMITS.perFolder), at)].filter((f) => f.ids.length > 0).slice(-RELEASED_LIMITS.folders);
  let total = folders.reduce((n, f) => n + f.ids.length, 0);
  while (total > RELEASED_LIMITS.total) {
    const oldest = folders[0]!;
    const drop = Math.min(oldest.ids.length, total - RELEASED_LIMITS.total);
    folders[0] = folderOf(oldest.cwd, oldest.ids.slice(drop), oldest.at);
    total -= drop;
    if (!folders[0].ids.length) folders.shift();
  }
  return { v: 1, folders };
}

/** The file with `ids` released no more. */
export function withoutReleased(file: ReleasedFile, ids: readonly string[]): ReleasedFile {
  const out = new Set(ids);
  return { v: 1, folders: file.folders.map((f) => folderOf(f.cwd, f.ids.filter((id) => !out.has(id)), f.at)).filter((f) => f.ids.length > 0) };
}

export class ReleasedSessions {
  private file: ReleasedFile = { v: 1, folders: [] };
  private readonly serial = new Serial();

  /** `dir`: the store's state folder, opened (checked and swept) by the store first; `uid`: its owner's. */
  constructor(private readonly opts: { dir: string; uid: number; onSetAside?: (path: string) => void }) {}

  /** Read the file with its check; a bad one is set aside as `.bad` and reads as none. */
  async open(): Promise<void> {
    const r = await readJson(join(this.opts.dir, RELEASED), RELEASED_LIMITS.bytes, this.opts.uid);
    if (r.kind === "absent") return;
    if (r.kind === "ok") {
      try {
        this.file = releasedFrom(r.value);
        return;
      } catch (e) {
        if (!(e instanceof RecordError)) throw e;
      }
    }
    await setAside(this.opts.dir, RELEASED);
    this.opts.onSetAside?.(RELEASED);
  }

  /** The sessions released from this folder, the oldest first, each with the folder that holds its transcript. */
  of(cwd: string): ReleasedSession[] {
    const f = this.file.folders.find((x) => x.cwd === cwd);
    return (f?.ids ?? []).map((id) => ({ id, dir: f?.at?.[id] ?? cwd }));
  }

  /** The folder that holds the transcript of a session released from `cwd`; null when `cwd` released none such. */
  folderOf(cwd: string, id: string): string | null {
    return this.of(cwd).find((s) => s.id === id)?.dir ?? null;
  }

  /** Remove's step: these sessions of `cwd` are released (written before it resolves). */
  release(cwd: string, sessions: readonly ReleasedSession[]): Promise<void> {
    return this.write(withReleased(this.file, cwd, sessions));
  }

  /** A new chat holds the session now (Continue here, Continue in a copy): it is released no more. */
  unrelease(ids: readonly string[]): Promise<void> {
    if (!this.file.folders.some((f) => f.ids.some((id) => ids.includes(id)))) return Promise.resolve();
    return this.write(withoutReleased(this.file, ids));
  }

  private write(next: ReleasedFile): Promise<void> {
    if (next === this.file) return Promise.resolve();
    const text = JSON.stringify(releasedFrom(next));
    this.file = next;
    return this.serial.run(RELEASED, () => writeAtomic(this.opts.dir, RELEASED, text, RELEASED_LIMITS.bytes, this.opts.uid));
  }
}
