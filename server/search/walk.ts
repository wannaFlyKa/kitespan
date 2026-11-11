// The corpus outside git (DESIGN.md 9.3; build checklist B2): a bounded walk of the chat's folder. Breadth first, so a
// capped list keeps the files nearest the root; 8 folders read at once; dot entries and node_modules skipped; regular
// files only, and a symbolic link neither followed nor listed; it stays on the root's file system (each folder's
// device must be the root's), so it never reads another mount. The cap is counted per file, and the walk has a time
// budget: each readdir and lstat goes through one per path at a time (`once`) and has its own deadline
// (`timeBudget`), so a stalled mount holds one file system thread and the walk goes on without it.

import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { once, timeBudget } from "../folders/list";
import { keepPath } from "./git";

/** The file system calls the walk makes (a test stubs a stalled one in). */
export interface WalkFs {
  readdir(path: string): Promise<Dirent[]>;
  lstat(path: string): Promise<{ dev: number; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }>;
}

const NODE_FS: WalkFs = {
  readdir: (p) => readdir(p, { withFileTypes: true }),
  lstat: (p) => lstat(p),
};

export interface WalkOptions {
  /** The most files listed. */
  max: number;
  /** The whole walk's budget, in ms. */
  ms: number;
  /** One readdir's or lstat's own deadline, in ms. */
  probeMs?: number;
  /** Folders read at once. */
  atOnce?: number;
  fs?: WalkFs;
}

export interface WalkListing {
  /** The root is a folder that could be read. */
  ok: boolean;
  paths: string[];
  /** There were more files than `max`. */
  capped: boolean;
  /** The budget ran out, or a read was later than its deadline: some folders were not read. */
  timeout: boolean;
}

const SKIP = "node_modules";
const LATE = Symbol("late");

/** What one folder gives the walk. */
interface Read {
  files: string[];
  folders: string[];
}
const NOTHING: Read = { files: [], folders: [] };
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The files under `root` (a real path), relative to it. Never throws. */
export async function walkFiles(root: string, opts: WalkOptions): Promise<WalkListing> {
  const fs = opts.fs ?? NODE_FS;
  const atOnce = Math.max(1, opts.atOnce ?? 8);
  const end = performance.now() + opts.ms;
  const budget = timeBudget(opts.ms, opts.probeMs ?? Math.min(1_000, opts.ms));
  const out: WalkListing = { ok: false, paths: [], capped: false, timeout: false };
  // Each key names the call and its path, so a read that is still running is shared, never another kind of read.
  const look = (p: string) => budget<Awaited<ReturnType<WalkFs["lstat"]>> | null | typeof LATE>(() => once(`corpus-lstat:${p}`, () => fs.lstat(p)).catch(() => null), LATE);
  const list = (p: string) => budget<Dirent[] | null | typeof LATE>(() => once(`corpus-readdir:${p}`, () => fs.readdir(p)).catch(() => null), LATE);

  const top = await look(root);
  if (top === LATE) return { ...out, timeout: true };
  if (!top || !top.isDirectory()) return out;
  const dev = top.dev;
  out.ok = true;
  let stop = false;
  const late = () => {
    out.timeout = true;
    if (performance.now() >= end) stop = true;
  };

  /** One folder's files (kept, in name order) and the subfolders to enter (on the root's device), in name order. */
  async function readFolder(rel: string): Promise<Read> {
    const abs = rel ? join(root, rel) : root;
    const got = await list(abs);
    if (got === LATE) {
      late();
      return NOTHING;
    }
    if (!got || stop) return NOTHING;
    const entries = [...got].sort((a, b) => byCodeUnit(a.name, b.name));
    const files: string[] = [];
    const folders: string[] = [];
    for (const e of entries) {
      if (stop) return NOTHING;
      const name = e.name;
      if (name.startsWith(".") || name === SKIP) continue;
      const child = rel ? `${rel}/${name}` : name;
      let file = e.isFile();
      let folder = e.isDirectory();
      if (!file && !folder && !e.isSymbolicLink() && !e.isFIFO() && !e.isSocket() && !e.isCharacterDevice() && !e.isBlockDevice()) {
        // A file system that gives no type: ask it (lstat, so a link stays a link).
        const st = await look(join(root, child));
        if (st === LATE) {
          late();
          continue;
        }
        file = Boolean(st?.isFile());
        folder = Boolean(st?.isDirectory());
      }
      if (file) {
        if (keepPath(child)) files.push(child);
      } else if (folder) folders.push(child);
    }
    // The device rule: a folder on another file system (a mount point) is not entered.
    const enter: (string | null)[] = folders.map(() => null);
    let i = 0;
    const worker = async () => {
      for (let k = i++; k < folders.length && !stop; k = i++) {
        const st = await look(join(root, folders[k]!));
        if (st === LATE) late();
        else if (st && st.isDirectory() && !st.isSymbolicLink() && st.dev === dev) enter[k] = folders[k]!;
      }
    };
    await Promise.all(Array.from({ length: Math.min(atOnce, folders.length) }, worker));
    return { files, folders: enter.filter((f): f is string => f !== null) };
  }

  // Breadth first: a queue of folders, `atOnce` of them read at a time. Each folder's files and subfolders are taken
  // in queue order, whichever read ends first, so the same tree always gives the same list (and the cap cuts it at
  // the same place); a folder's subfolders join the queue's end when it is taken.
  const queue: string[] = [""];
  const ready = new Map<number, Read>();
  let started = 0;
  let taken = 0;
  await new Promise<void>((resolve) => {
    let active = 0;
    const pump = () => {
      while (!stop && ready.has(taken)) {
        const r = ready.get(taken)!;
        ready.delete(taken);
        taken++;
        for (const f of r.files) {
          if (out.paths.length >= opts.max) {
            out.capped = true;
            stop = true;
            break;
          }
          out.paths.push(f);
        }
        if (!stop) for (const d of r.folders) queue.push(d);
      }
      while (!stop && active < atOnce && started < queue.length) {
        const k = started++;
        active++;
        void readFolder(queue[k]!)
          .catch(() => NOTHING)
          .then((r) => {
            ready.set(k, r);
            active--;
            pump();
          });
      }
      if (active === 0 && (stop || taken >= queue.length)) resolve();
    };
    pump();
  });
  if (!stop && performance.now() >= end && taken < queue.length) out.timeout = true;
  return out;
}
