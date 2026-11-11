// The store's file layer (DESIGN.md 4.4, "How every file is written"): the one atomic writer, the read with checks,
// `.bad`, the stray `*.tmp` sweep, the folder fsync and the per-file queue. Everything here uses node:fs with explicit
// modes: `Bun.write` makes 0644 files and 0755 folders on Bun 1.3.14, so it is never used for the state folder.

import { constants } from "node:fs";
import { lstat, open, readdir, rename, unlink, type FileHandle } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { StoreProblem } from "./types";

export const FILE_MODE = 0o600;
export const DIR_MODE = 0o700;

/** O_EXCL with O_CREAT fails on any name that exists, a symbolic link included; O_NOFOLLOW says so twice. */
const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;

/** `.<name>.<16 hex characters>.tmp`: the atomic writer's temporary file, and what the start-up sweep removes. */
export const TMP_RE = /^\..+\.[0-9a-f]{16}\.tmp$/;

export type StoreErrorCode =
  /** open() refused the state folder; `problems` says which paths and why. */
  | "refused"
  /** A record or a value does not pass its check (a programming error in the caller, or a bad setting). */
  | "bad_value"
  /** A record is over its size cap. */
  | "too_large"
  /** A file the writer made is not this user's 0600 file. */
  | "mode"
  /** The store was used before open(). */
  | "not_open";

export class StoreError extends Error {
  readonly code: StoreErrorCode;
  readonly problems: StoreProblem[];
  constructor(code: StoreErrorCode, message: string, problems: StoreProblem[] = []) {
    super(message);
    this.name = "StoreError";
    this.code = code;
    this.problems = problems;
  }
}

export const errno = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code;

/** The server's own user id, or -1 where the platform has none (then the owner checks pass). */
export function ownUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : -1;
}

export const ownedBy = (fileUid: number, uid: number): boolean => uid < 0 || fileUid === uid;

export function tmpName(name: string): string {
  return `.${name}.${randomBytes(8).toString("hex")}.tmp`;
}

/** Open a new file for writing: exclusive, never through a symbolic link, mode 0600. EEXIST when the name exists. */
export function openExclusive(path: string): Promise<FileHandle> {
  return open(path, CREATE_FLAGS, FILE_MODE);
}

export async function writeAll(h: FileHandle, bytes: Uint8Array): Promise<void> {
  let at = 0;
  while (at < bytes.byteLength) {
    const { bytesWritten } = await h.write(bytes, at, bytes.byteLength - at);
    at += bytesWritten;
  }
}

/**
 * Set the open file to 0600 (a narrow umask can only make it narrower, so this changes nothing in the usual case) and
 * check that it is a regular file of this user with mode 0600.
 */
export async function sealFile(h: FileHandle, uid: number): Promise<void> {
  await h.chmod(FILE_MODE);
  const st = await h.stat();
  if (!st.isFile() || (st.mode & 0o777) !== FILE_MODE || !ownedBy(st.uid, uid)) {
    throw new StoreError("mode", "the new file is not this user's 0600 file");
  }
}

/** fsync a folder, so a rename or an unlink in it survives a crash. */
export async function fsyncDir(dir: string): Promise<void> {
  const h = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await h.sync();
  } finally {
    await h.close();
  }
}

/**
 * The one atomic writer: check the size, open `.<name>.<hex>.tmp` in the same folder (wx, 0600), write, fsync, check
 * the mode, close, rename it over `name`, then fsync the folder. A failure removes the temporary file and leaves the
 * old version intact.
 */
export async function writeAtomic(dir: string, name: string, data: string | Uint8Array, maxBytes: number, uid: number): Promise<void> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  if (bytes.byteLength > maxBytes) throw new StoreError("too_large", `${name} would be over ${maxBytes} bytes`);
  const tmp = join(dir, tmpName(name));
  const h = await openExclusive(tmp);
  try {
    try {
      await writeAll(h, bytes);
      await h.sync();
      await sealFile(h, uid);
    } finally {
      await h.close();
    }
    await rename(tmp, join(dir, name));
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
  await fsyncDir(dir);
}

/** Unlink `name` in `dir`, then fsync the folder. A missing file is not an error. Returns whether a file went. */
export async function unlinkSynced(dir: string, name: string): Promise<boolean> {
  try {
    await unlink(join(dir, name));
  } catch (e) {
    if (errno(e) === "ENOENT") return false;
    throw e;
  }
  await fsyncDir(dir);
  return true;
}

export type ReadResult = { kind: "absent" } | { kind: "bad" } | { kind: "ok"; value: unknown };

/**
 * Read one JSON file with the read checks: a regular file (never a symbolic link) of this user, no group or other
 * bit, at most `maxBytes`, valid UTF-8 and valid JSON. The record check is the caller's.
 */
export async function readJson(path: string, maxBytes: number, uid: number): Promise<ReadResult> {
  let st;
  try {
    st = await lstat(path);
  } catch (e) {
    if (errno(e) === "ENOENT") return { kind: "absent" };
    throw e;
  }
  if (!st.isFile() || st.size > maxBytes || (st.mode & 0o077) !== 0 || !ownedBy(st.uid, uid)) return { kind: "bad" };
  let h: FileHandle;
  try {
    h = await open(path, READ_FLAGS);
  } catch (e) {
    if (errno(e) === "ENOENT") return { kind: "absent" };
    if (errno(e) === "ELOOP") return { kind: "bad" };
    throw e;
  }
  try {
    const buf = await h.readFile();
    if (buf.byteLength > maxBytes) return { kind: "bad" };
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return { kind: "ok", value: JSON.parse(text) };
  } catch {
    return { kind: "bad" };
  } finally {
    await h.close();
  }
}

/** Set a file that failed its read check aside as `<name>.bad` (an older `.bad` is replaced), then fsync the folder. */
export async function setAside(dir: string, name: string): Promise<void> {
  try {
    await rename(join(dir, name), join(dir, `${name}.bad`));
  } catch (e) {
    if (errno(e) === "ENOENT") return;
    throw e;
  }
  await fsyncDir(dir);
}

/** Remove the stray `*.tmp` files that a crash left in `dir` (regular files only). Returns how many went. */
export async function sweepTmp(dir: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!TMP_RE.test(name)) continue;
    try {
      if (!(await lstat(join(dir, name))).isFile()) continue;
      await unlink(join(dir, name));
      removed++;
    } catch {
      // gone already
    }
  }
  if (removed > 0) await fsyncDir(dir);
  return removed;
}

/**
 * Check every folder and file under `root` with lstat, never following a link: a folder must be this user's with no
 * group or other bit (0700), a file this user's regular file with no group or other bit (0600), and nothing may be a
 * symbolic link. Paths in the result are relative to `root` ("." for the root itself). `opaque` (U1): a folder it names
 * is checked itself, and what it holds is not.
 */
export async function checkTree(root: string, uid: number, opaque?: (rel: string) => boolean): Promise<StoreProblem[]> {
  const problems: StoreProblem[] = [];
  const walk = async (abs: string, rel: string, depth: number): Promise<void> => {
    let st;
    try {
      st = await lstat(abs);
    } catch (e) {
      if (errno(e) === "ENOENT") return;
      throw e;
    }
    const where = rel || ".";
    if (st.isSymbolicLink()) return void problems.push({ path: where, why: "symlink" });
    if (depth === 0 && !st.isDirectory()) return void problems.push({ path: where, why: "not-a-folder" });
    if (!st.isDirectory() && !st.isFile()) return void problems.push({ path: where, why: "not-a-file" });
    if (!ownedBy(st.uid, uid)) return void problems.push({ path: where, why: "owner" });
    if ((st.mode & 0o077) !== 0) problems.push({ path: where, why: "wider-mode" });
    if (!st.isDirectory() || (opaque && rel && opaque(rel))) return;
    for (const name of (await readdir(abs)).sort()) {
      await walk(join(abs, name), rel ? `${rel}/${name}` : name, depth + 1);
    }
  };
  await walk(root, "", 0);
  return problems;
}

/** Runs jobs one after another per key (a file path), so two writes of one file never race. */
export class Serial {
  private tails = new Map<string, Promise<void>>();

  run<T>(key: string, job: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(job);
    const tail = next.then(
      () => {},
      () => {},
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }

  /** Resolves when every job queued so far has ended. */
  async idle(): Promise<void> {
    while (this.tails.size > 0) await Promise.all([...this.tails.values()]);
  }
}
