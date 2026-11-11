// D60's store (build checklist E1, L39, L42; R-env 5.2, 5.11): one file per environment that has variables,
// `env/<project id>.json` (folder 0700, file 0600, plain JSON), never in projects.json. The state folder's store makes
// and checks env/ and sweeps its stray temporary files (server/store/store.ts); this module reads every file at open(),
// with the store's read checks and then the record check, and keeps the records in memory, as the store keeps
// projects.json. Every write goes through the one atomic writer, one at a time per file. A file that fails a check is
// set aside as `<id>.json.bad`: while that is there and no good file is, the environment reads as unreadable and its
// chats do not start (fail closed: a missing provider variable could send the work to another provider). Entering the
// variables again, or a save with `discardUnreadable`, removes it. Nothing here logs, or puts a name or a value in an
// error: a problem is a fixed code with the index of the request's line.

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { EnvVar } from "../agents/types";
import { ownUid, readJson, Serial, setAside, StoreError, unlinkSynced, writeAtomic } from "../store/files";
import { ENV_LIMITS, nameProblem, setProblem, valueProblem, type EnvProblem } from "./names";

/** One variable as the file keeps it: `at` is when the user saved it (ISO 8601 UTC). */
export interface EnvVarRecord extends EnvVar {
  at: string;
}

/** `env/<project id>.json`. No variables, no file. */
export interface EnvFile {
  v: 1;
  id: string;
  /** The user's order. */
  vars: EnvVarRecord[];
}

/** What a page may know of an environment: names and times, never a value or its length (E5). */
export interface EnvView {
  vars: { name: string; at: string }[];
  unreadable: boolean;
}

/** One save: the variables to set (a saved name keeps its place), the names to remove, and the unreadable file to drop. */
export interface EnvChange {
  set: readonly EnvVar[];
  remove: readonly string[];
  discardUnreadable?: boolean;
}

/** A problem of one line: `i` is the index in `set`, or -1 for the whole environment (its count or its size). */
export interface EnvLine {
  i: number;
  why: EnvProblem;
}

export type EnvChangeResult = { ok: true; changed: boolean } | { ok: false; lines: EnvLine[] };

/** What the chat start, the short reads, `!` and the Terminal pane read (sync: the records are in memory). */
export interface EnvSource {
  /** The project's variables in the user's order: [] when it has none; null when its file could not be read (L39). */
  vars(project: string): readonly EnvVar[] | null;
}

/** The registry's part of D60 (main.ts plugs the store in); absent: no environment has variables. */
export interface EnvDeps {
  env?: EnvSource;
}

const FILE = /^([a-z2-7]{10})\.json$/;
const BAD = /^([a-z2-7]{10})\.json\.bad$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const isTime = (v: unknown): v is string => typeof v === "string" && ISO_UTC.test(v) && !Number.isNaN(Date.parse(v));
const own = (o: Record<string, unknown>, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const objOf = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/**
 * The record check of `env/<fileId>.json`: `v` 1, `id` the file name's, every variable a name that may be set (E2), a
 * value within its limits, a time, no name twice, and the whole within the environment's limits. null when it fails.
 */
export function envFileFrom(raw: unknown, fileId: string): EnvVarRecord[] | null {
  const o = objOf(raw);
  if (!o || own(o, "v") !== 1 || own(o, "id") !== fileId) return null;
  const list = own(o, "vars");
  if (!Array.isArray(list) || list.length > ENV_LIMITS.vars) return null;
  const out: EnvVarRecord[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const v = objOf(item);
    if (!v) return null;
    const name = own(v, "name");
    const value = own(v, "value");
    const at = own(v, "at");
    if (nameProblem(name) !== null || valueProblem(value) !== null || !isTime(at) || seen.has(name as string)) return null;
    seen.add(name as string);
    out.push({ name: name as string, value: value as string, at });
  }
  return setProblem(out) === null ? out : null;
}

export interface EnvStoreOptions {
  /** The state folder's env/ (StoreDirs.env), made and checked by the store's open() first. */
  dir: string;
  now?: () => Date;
}

export class EnvStore implements EnvSource {
  private readonly uid = ownUid();
  private readonly now: () => Date;
  private readonly serial = new Serial();
  private opened = false;
  private readonly records = new Map<string, EnvVarRecord[]>();
  /** Projects with an `<id>.json.bad` file. */
  private readonly bad = new Set<string>();

  constructor(private readonly opts: EnvStoreOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Read every environment's file. Returns the files set aside (paths relative to the state folder, `env/<name>`).
   * A file that cannot be read for another reason (it went, or the system refused the read) is not set aside, and its
   * environment reads as unreadable.
   */
  async open(): Promise<{ setAside: string[] }> {
    const dir = this.opts.dir;
    const names = (await readdir(dir)).sort();
    const out: string[] = [];
    for (const name of names) {
      const id = FILE.exec(name)?.[1];
      if (!id) continue;
      let rec: EnvVarRecord[] | null = null;
      try {
        const r = await readJson(join(dir, name), ENV_LIMITS.fileBytes, this.uid);
        if (r.kind === "absent") continue;
        rec = r.kind === "ok" ? envFileFrom(r.value, id) : null;
        if (!rec) {
          await setAside(dir, name);
          out.push(`env/${name}`);
          this.bad.add(id);
          continue;
        }
      } catch {
        this.bad.add(id);
        continue;
      }
      if (rec.length > 0) this.records.set(id, rec);
    }
    for (const name of names) {
      const id = BAD.exec(name)?.[1];
      if (id) this.bad.add(id);
    }
    this.opened = true;
    return { setAside: out };
  }

  vars(project: string): readonly EnvVar[] | null {
    if (!this.opened) return null;
    const rec = this.records.get(project);
    if (rec) return rec.map(({ name, value }) => ({ name, value }));
    return this.bad.has(project) ? null : [];
  }

  view(project: string): EnvView {
    const rec = this.opened ? this.records.get(project) : undefined;
    return { vars: (rec ?? []).map(({ name, at }) => ({ name, at })), unreadable: this.vars(project) === null };
  }

  /** How many variables the project has (ProjectView.env); 0 when none, or while they cannot be read. */
  count(project: string): number {
    return this.opened ? (this.records.get(project)?.length ?? 0) : 0;
  }

  /**
   * One save, checked whole: every line of `set` (its name, its value, a name twice), then the environment that would
   * result. On any problem nothing is written and the answer names each line's problem. Removes go first, then each
   * set name replaces its saved value in place or comes last; a remove of a name that is not saved changes nothing.
   * The file is written, or removed when no variable is left; a save that leaves variables, or `discardUnreadable`,
   * also removes the unreadable file.
   */
  change(project: string, change: EnvChange): Promise<EnvChangeResult> {
    if (!this.opened) return Promise.reject(new StoreError("not_open", "the environment store is not open"));
    return this.serial.run(project, async (): Promise<EnvChangeResult> => {
      const lines: EnvLine[] = [];
      const seen = new Set<string>();
      change.set.forEach((v, i) => {
        const why = nameProblem(v.name) ?? (seen.has(v.name) ? "twice" : null) ?? valueProblem(v.value);
        if (typeof v.name === "string") seen.add(v.name);
        if (why) lines.push({ i, why });
      });
      if (lines.length > 0) return { ok: false, lines };

      const before = this.records.get(project) ?? [];
      const at = this.now().toISOString();
      const gone = new Set(change.remove);
      const setBy = new Map(change.set.map((v) => [v.name, v.value]));
      const next: EnvVarRecord[] = before.filter((v) => !gone.has(v.name)).map((v) => (setBy.has(v.name) ? { name: v.name, value: setBy.get(v.name)!, at } : v));
      for (const v of change.set) if (!next.some((n) => n.name === v.name)) next.push({ name: v.name, value: v.value, at });
      const whole = setProblem(next);
      if (whole) return { ok: false, lines: [{ i: -1, why: whole }] };

      const dir = this.opts.dir;
      const file = `${project}.json`;
      if (next.length > 0) {
        const text = JSON.stringify({ v: 1, id: project, vars: next } satisfies EnvFile);
        if (Buffer.byteLength(text) > ENV_LIMITS.fileBytes) return { ok: false, lines: [{ i: -1, why: "too_big" }] };
        await writeAtomic(dir, file, text, ENV_LIMITS.fileBytes, this.uid);
      } else await unlinkSynced(dir, file);
      if ((change.discardUnreadable === true || next.length > 0) && this.bad.has(project)) {
        await unlinkSynced(dir, `${file}.bad`);
        this.bad.delete(project);
      }
      const changed = JSON.stringify(before.map((v) => [v.name, v.value])) !== JSON.stringify(next.map((v) => [v.name, v.value]));
      if (next.length > 0) this.records.set(project, next);
      else this.records.delete(project);
      return { ok: true, changed };
    });
  }

  /** Row 99: the environment's Remove: its file goes, and an unreadable one set aside too; it reads as none then. */
  remove(project: string): Promise<void> {
    if (!this.opened) return Promise.reject(new StoreError("not_open", "the environment store is not open"));
    return this.serial.run(project, async () => {
      const file = `${project}.json`;
      await unlinkSynced(this.opts.dir, file);
      this.records.delete(project);
      await unlinkSynced(this.opts.dir, `${file}.bad`);
      this.bad.delete(project);
    });
  }
}

export function createEnvStore(opts: EnvStoreOptions): EnvStore {
  return new EnvStore(opts);
}
