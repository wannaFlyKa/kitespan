// U1 (DESIGN-U1 5): where a chat's turn summaries live, `$XDG_STATE_HOME/kitespan/changes/<chat id>/` (0700):
//
// - `turns.json`: the chat's summaries (TurnRecord), oldest first, at most 1,000 and 4 MiB of JSON (the oldest go
//   first, with their hunks);
// - `edits-<summary id>.json`: a fallback turn's hunks from Claude's own edits, at most 256 KiB;
// - `objects/`: the marks' new git objects, git's own (server/changes/git.ts), which the boot's tree check leaves alone;
// - `mark/`: while a mark runs, its private index, git's lock of it and the pathspec file (emptied before each mark and
//   at the start); the tree check looks at the folder and not into it (git writes its lock at git's own file mode).
//
// Every file goes through the store's atomic writer and its read checks (server/store/files.ts). Deleting a chat
// removes its folder; archiving keeps it.

import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { CHANGES_HOW, CHANGES_LIMITS, CHANGES_WHY, changedFileOf, type ChangedFile, type ChangesHow, type ChangesWhy, type EditHunk } from "../../shared/changes";
import { CHAT_ID, isChangesId } from "../../shared/ids";
import { readJson, setAside, sweepTmp, unlinkSynced, writeAtomic } from "../store/files";

/** One turn's summary as the server keeps it. */
export interface TurnRecord {
  id: string;
  /** The page's row ids of the turn's first rows (ChangesCard `at`). */
  at: string[];
  how: ChangesHow;
  why?: ChangesWhy;
  /** The marks' trees (`git`). */
  from?: string;
  to?: string;
  total: number;
  added: number;
  removed: number;
  others: number;
  /** Another chat's changes in the folder, counted apart (review); absent when none. */
  elsewhere?: number;
  /** At most CHANGES_LIMITS.files, in path order. */
  files: ChangedFile[];
  /** When it was made (ISO). */
  made: string;
}

export interface TurnsFile {
  v: 1;
  chat: string;
  turns: TurnRecord[];
}

/** A fallback turn's hunks, by path. */
export interface EditsFile {
  v: 1;
  id: string;
  files: Record<string, EditHunk[]>;
}

const TREE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const ROW_ID = /^[A-Za-z0-9_-]{1,64}$/;
const count = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A record as read from disk, checked, or null. */
export function turnRecordOf(v: unknown): TurnRecord | null {
  if (!isObj(v)) return null;
  const { id, at, how, why, from, to, total, added, removed, others, elsewhere, files, made } = v;
  if (!isChangesId(id) || typeof how !== "string" || !(CHANGES_HOW as readonly string[]).includes(how)) return null;
  if (!Array.isArray(at) || at.length === 0 || at.length > 2 || !at.every((x) => typeof x === "string" && ROW_ID.test(x))) return null;
  if (!count(total) || !count(added) || !count(removed) || !count(others) || typeof made !== "string" || made.length > 40) return null;
  if (why !== undefined && (typeof why !== "string" || !(CHANGES_WHY as readonly string[]).includes(why))) return null;
  if (elsewhere !== undefined && !count(elsewhere)) return null;
  if (how === "git" && (typeof from !== "string" || !TREE.test(from) || typeof to !== "string" || !TREE.test(to))) return null;
  if (!Array.isArray(files) || files.length > CHANGES_LIMITS.files) return null;
  const rows = files.map(changedFileOf);
  if (rows.some((r) => r === null)) return null;
  return {
    id,
    at: [...(at as string[])],
    how: how as ChangesHow,
    ...(why !== undefined ? { why: why as ChangesWhy } : {}),
    ...(how === "git" ? { from: from as string, to: to as string } : {}),
    total,
    added,
    removed,
    others,
    ...(elsewhere ? { elsewhere: elsewhere as number } : {}),
    files: rows as ChangedFile[],
    made,
  };
}

function hunkOf(v: unknown): EditHunk | null {
  if (!isObj(v)) return null;
  const { oldStart, oldLines, newStart, newLines, lines } = v;
  if (!count(oldStart) || !count(oldLines) || !count(newStart) || !count(newLines) || !Array.isArray(lines) || !lines.every((l) => typeof l === "string")) return null;
  return { oldStart, oldLines, newStart, newLines, lines: [...(lines as string[])] };
}

export class ChangesStore {
  /** The turns of each chat read so far (the newest state). */
  private readonly turns = new Map<string, TurnRecord[]>();
  private readonly loads = new Map<string, Promise<TurnRecord[]>>();
  private readonly gone = new Set<string>();

  constructor(
    /** `changes/` under the state folder. */
    readonly root: string,
    private readonly uid: number,
    private readonly onSetAside?: () => void,
  ) {}

  /** The chat's folder; a bad id throws (never a path outside `changes/`). */
  dirOf(chat: string): string {
    if (!CHAT_ID.test(chat)) throw new Error("not a chat id");
    return join(this.root, chat);
  }

  /** The chat's summaries, oldest first (a bad file is set aside and reads as none). */
  read(chat: string): Promise<TurnRecord[]> {
    const have = this.turns.get(chat);
    if (have) return Promise.resolve(have);
    let load = this.loads.get(chat);
    if (!load) {
      load = this.load(chat).then((list) => {
        this.loads.delete(chat);
        if (!this.turns.has(chat)) this.turns.set(chat, list);
        return this.turns.get(chat)!;
      });
      this.loads.set(chat, load);
    }
    return load;
  }

  private async load(chat: string): Promise<TurnRecord[]> {
    const dir = this.dirOf(chat);
    const r = await readJson(join(dir, "turns.json"), CHANGES_LIMITS.turnsBytes + 64 * 1024, this.uid);
    if (r.kind === "absent") return [];
    if (r.kind === "ok" && isObj(r.value) && r.value.v === 1 && r.value.chat === chat && Array.isArray(r.value.turns)) {
      const list = r.value.turns.map(turnRecordOf);
      if (list.every((t) => t !== null)) {
        await sweepTmp(dir).catch(() => 0);
        return list as TurnRecord[];
      }
    }
    // A file that fails its check is set aside as `turns.json.bad`, as the store's own records are.
    await setAside(dir, "turns.json").catch(() => {});
    this.onSetAside?.();
    return [];
  }

  /** One summary of the chat, or null. */
  async get(chat: string, id: string): Promise<TurnRecord | null> {
    if (!isChangesId(id)) return null;
    return (await this.read(chat)).find((t) => t.id === id) ?? null;
  }

  /**
   * Keep a new summary (and a fallback's hunks): the oldest go past 1,000 summaries or 4 MiB of JSON, with their hunks.
   * A deleted chat's write is dropped.
   */
  async add(chat: string, rec: TurnRecord, edits?: Record<string, EditHunk[]>): Promise<boolean> {
    if (this.gone.has(chat)) return false;
    const dir = this.dirOf(chat);
    const list = [...(await this.read(chat)), rec];
    const dropped: TurnRecord[] = [];
    while (list.length > CHANGES_LIMITS.turns) dropped.push(list.shift()!);
    let json = JSON.stringify({ v: 1, chat, turns: list } satisfies TurnsFile);
    while (Buffer.byteLength(json) > CHANGES_LIMITS.turnsBytes && list.length > 1) {
      dropped.push(list.shift()!);
      json = JSON.stringify({ v: 1, chat, turns: list } satisfies TurnsFile);
    }
    if (Buffer.byteLength(json) > CHANGES_LIMITS.turnsBytes) return false;
    if (this.gone.has(chat)) return false;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (edits && Object.keys(edits).length) {
      const body = JSON.stringify({ v: 1, id: rec.id, files: edits } satisfies EditsFile);
      if (Buffer.byteLength(body) <= CHANGES_LIMITS.editsBytes + 1024) await writeAtomic(dir, `edits-${rec.id}.json`, body, CHANGES_LIMITS.editsBytes + 1024, this.uid);
    }
    await writeAtomic(dir, "turns.json", json, CHANGES_LIMITS.turnsBytes, this.uid);
    this.turns.set(chat, list);
    for (const d of dropped) await unlinkSynced(dir, `edits-${d.id}.json`).catch(() => false);
    return true;
  }

  /** A fallback turn's hunks, by path (none when it kept none). */
  async edits(chat: string, id: string): Promise<Record<string, EditHunk[]>> {
    if (!isChangesId(id)) return {};
    const r = await readJson(join(this.dirOf(chat), `edits-${id}.json`), CHANGES_LIMITS.editsBytes + 1024, this.uid);
    if (r.kind !== "ok" || !isObj(r.value) || r.value.v !== 1 || r.value.id !== id || !isObj(r.value.files)) return {};
    const out: Record<string, EditHunk[]> = {};
    for (const [path, list] of Object.entries(r.value.files)) {
      if (!Array.isArray(list)) continue;
      out[path] = list.map(hunkOf).filter((h): h is EditHunk => h !== null);
    }
    return out;
  }

  /** The chats that have a changes folder (their ids). */
  async chatDirs(): Promise<string[]> {
    const out: string[] = [];
    for (const name of await readdir(this.root).catch(() => [] as string[])) if (CHAT_ID.test(name)) out.push(name);
    return out;
  }

  /** The bytes of the chat's folder that are not git's objects (the summaries and the hunks). */
  async ownBytes(chat: string): Promise<number> {
    const dir = this.dirOf(chat);
    let n = 0;
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (name === "objects" || name === "mark") continue;
      const st = await lstat(join(dir, name)).catch(() => null);
      if (st?.isFile()) n += st.size;
    }
    return n;
  }

  /**
   * Delete: the chat's folder goes, with everything in it, and no later write brings it back. Only a real folder under
   * `changes/` named by the chat's id (never a link, never a path given from outside).
   */
  async remove(chat: string): Promise<void> {
    this.gone.add(chat);
    this.turns.delete(chat);
    const dir = this.dirOf(chat);
    const st = await lstat(dir).catch(() => null);
    if (!st) return;
    if (!st.isDirectory()) {
      await rm(dir, { force: true });
      return;
    }
    await rm(dir, { recursive: true, force: true });
  }

  /** The chat was deleted. */
  isGone(chat: string): boolean {
    return this.gone.has(chat);
  }
}
