// Downloads (DESIGN.md 6.4, D37; build checklist C3): a file in a chat's folder or an upload, sent with an RFC 6266
// name, and a folder as one .tar.gz, within caps. A download is a read: it changes nothing. A path is resolved inside
// its folder only, one segment at a time, and a path that steps outside (by `..` or a link) is outside at once, so the
// answer never depends on what is outside; the file is opened without following a link and checked again on the open
// descriptor, so a link swapped in afterwards reads nothing outside. A folder archive is walked first (the HEAD probe
// gives its size) and holds links as links, never their targets; fifos, sockets and devices are left out.

import { constants, readlinkSync } from "node:fs";
import { lstat, open, readdir, readlink, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

/** A folder's archive holds at most this much (design values; the HEAD probe says when a folder is over). */
export interface FolderLimits {
  entries: number;
  bytes: number;
}
export const FOLDER_LIMITS: Readonly<FolderLimits> = { entries: 20_000, bytes: 1024 * 1024 * 1024 };

const READ_CHUNK = 64 * 1024;
const OPEN_READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

// ---------------------------------------------------------------------------------------------------------------
// Names (RFC 6266, RFC 8187)

/** RFC 8187 attr-char: everything else is percent-encoded from UTF-8. */
function encode8187(s: string): string {
  return encodeURIComponent(s).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * `attachment` with an ASCII `filename` for old clients and the exact UTF-8 name in `filename*` (RFC 6266 section
 * 4.3). The ASCII form keeps printable ASCII but the quote, the backslash and the percent sign.
 */
export function contentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\%]/g, "_").trim() || "download";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encode8187(name)}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Resolving a path inside its folder

const inside = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * Where `root/rel` is inside the folder, by the walk of walkInside (it looks at nothing past the folder), or why it is
 * not: gone inside, or a path that steps outside (by `..` or a link), whether or not what it names outside exists.
 */
async function locate(root: string, rel: string | null): Promise<{ rootReal: string; real: string } | { reason: "missing" | "outside" }> {
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    return { reason: "missing" };
  }
  if (rel === null) return { rootReal, real: rootReal };
  const given = resolve(root);
  const walked = await walkInside(rootReal, given === rootReal || given === sep ? [] : [given], rel);
  if ("reason" in walked) return walked;
  return inside(walked.real, rootReal) ? { rootReal, real: walked.real } : { reason: "outside" };
}

/**
 * The real path of `root/rel` when it is `root` or under it, else null (gone, or a path that steps outside). It is
 * the probe's walk, never realpath: realpath follows a link through folders outside, so a link that leaves the
 * folder and comes back in would be served or not by what is outside.
 */
export async function resolveInside(root: string, rel: string | null): Promise<{ rootReal: string; real: string } | null> {
  const at = await locate(root, rel);
  return "reason" in at ? null : at;
}

/** The path that an open descriptor names now; null where the system cannot say. */
function fdPath(fd: number): string | null {
  try {
    return readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    return null;
  }
}

/** Open a regular file for reading, never through a link, and check that the open file is still inside `rootReal`. */
async function openInside(path: string, rootReal: string, expect?: { dev: number; ino: number }): Promise<{ fh: FileHandle; size: number } | null> {
  let fh: FileHandle;
  try {
    fh = await open(path, OPEN_READ);
  } catch {
    return null;
  }
  try {
    const st = await fh.stat();
    const now = fdPath(fh.fd);
    if (st.isFile() && (now === null || inside(now, rootReal)) && (!expect || (st.dev === expect.dev && st.ino === expect.ino))) {
      return { fh, size: st.size };
    }
  } catch {
    // fall through
  }
  await fh.close().catch(() => {});
  return null;
}

/** A stream of exactly `size` bytes from `fh` (zeros if the file got shorter); the handle closes at the end. */
async function* fileBytes(fh: FileHandle, size: number): AsyncGenerator<Uint8Array> {
  let pos = 0;
  try {
    while (pos < size) {
      const n = Math.min(READ_CHUNK, size - pos);
      const buf = new Uint8Array(n);
      const { bytesRead } = await fh.read(buf, 0, n, pos);
      if (bytesRead === 0) {
        while (pos < size) {
          const z = Math.min(READ_CHUNK, size - pos);
          yield new Uint8Array(z);
          pos += z;
        }
        break;
      }
      yield bytesRead === n ? buf : buf.subarray(0, bytesRead);
      pos += bytesRead;
    }
  } finally {
    await fh.close().catch(() => {});
  }
}

/** A ReadableStream over an async generator; a cancel (the browser stopped the download) ends the generator. */
function streamOf(gen: AsyncGenerator<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const r = await gen.next();
        if (r.done) controller.close();
        else controller.enqueue(r.value);
      } catch (e) {
        controller.error(e);
      }
    },
    async cancel() {
      await gen.return(undefined);
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------
// What a path is

export interface FolderEntry {
  /** The path under the folder, with `/` between parts; "" for the folder itself. */
  rel: string;
  kind: "dir" | "file" | "link";
  size: number;
  mode: number;
  mtimeS: number;
  dev: number;
  ino: number;
  /** A link's target, as the link holds it. */
  link?: string;
}

export type DownloadTarget =
  | { kind: "file"; name: string; real: string; rootReal: string; size: number }
  | { kind: "folder"; name: string; real: string; rootReal: string; entries: FolderEntry[]; bytes: number; over: boolean };

/**
 * Row 100: the folder of git worktrees inside a project's folder (`.claude/worktrees`, Claude Code's and kitespan's),
 * which a walk of the project's files leaves out: each worktree there is another checkout of the repository.
 */
export const isWorktreesFolder = (parent: string, name: string): boolean => name === "worktrees" && basename(parent) === ".claude";

/**
 * Walk a folder without following links, in name order, and stop once it is over a cap (`over`). `bytes` is the sum
 * of the regular files' sizes. A `.claude/worktrees` folder under it is left out (isWorktreesFolder).
 */
export async function walkFolder(folder: string, limits: FolderLimits = FOLDER_LIMITS): Promise<{ entries: FolderEntry[]; bytes: number; over: boolean }> {
  const entries: FolderEntry[] = [];
  let bytes = 0;
  const top = await lstat(folder);
  entries.push({ rel: "", kind: "dir", size: 0, mode: top.mode & 0o777, mtimeS: Math.floor(top.mtimeMs / 1000), dev: top.dev, ino: top.ino });
  const stack: string[] = [""];
  while (stack.length) {
    const rel = stack.pop()!;
    let names: string[];
    try {
      names = (await readdir(rel ? join(folder, rel) : folder)).sort();
    } catch {
      continue;
    }
    const subdirs: string[] = [];
    for (const name of names) {
      const childRel = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = await lstat(join(folder, childRel));
      } catch {
        continue;
      }
      const base = { rel: childRel, size: 0, mode: st.mode & 0o777, mtimeS: Math.floor(st.mtimeMs / 1000), dev: st.dev, ino: st.ino };
      if (st.isDirectory() && isWorktreesFolder(rel ? join(folder, rel) : folder, name)) continue;
      if (st.isDirectory()) {
        entries.push({ ...base, kind: "dir" });
        subdirs.push(childRel);
      } else if (st.isFile()) {
        entries.push({ ...base, kind: "file", size: st.size });
        bytes += st.size;
      } else if (st.isSymbolicLink()) {
        let link: string;
        try {
          link = await readlink(join(folder, childRel));
        } catch {
          continue;
        }
        entries.push({ ...base, kind: "link", link });
      } else continue;
      if (entries.length > limits.entries || bytes > limits.bytes) return { entries, bytes, over: true };
    }
    // Depth first, in name order.
    for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i]!);
  }
  return { entries, bytes, over: false };
}

/** Why a path has nothing to download (the existence probe, 5.4): not there, a link that leads outside, not a file. */
export type MissingReason = "missing" | "outside" | "not_a_file";

/** As many links as one walk follows (the system's own limit): more is a loop. */
const MAX_LINKS = 40;

/**
 * Resolve `rel` under the folder one segment at a time, as realpath does, without looking at anything past the folder,
 * so that the answer never depends on what is outside it. A segment is looked up (lstat, readlink) only while the walk
 * is inside. Above the folder, the walk goes on only along the folder's own real path (each part of it is a real
 * folder, so nothing needs a look); any other step leads outside, and the answer is `outside` at once. An absolute link
 * target is read from the root of the system, or from one of `aliases` (the folder as its chat names it). A segment
 * that is not there inside the folder, or a loop of links, is `missing`.
 */
async function walkInside(rootReal: string, aliases: readonly string[], rel: string): Promise<{ real: string } | { reason: "missing" | "outside" }> {
  const under = rootReal === sep ? sep : rootReal + sep;
  const isInside = (p: string) => p === rootReal || p.startsWith(under);
  const onRootPath = (p: string) => p === sep || rootReal.startsWith(p + sep);
  let cur = rootReal;
  let isDir = true;
  let links = 0;
  const pending = rel.split("/");
  while (pending.length > 0) {
    const seg = pending.shift()!;
    if (!isDir) return { reason: "missing" };
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      cur = dirname(cur);
      continue;
    }
    const next = join(cur, seg);
    if (!isInside(cur)) {
      if (isInside(next) || onRootPath(next)) {
        cur = next;
        continue;
      }
      return { reason: "outside" };
    }
    let st;
    try {
      st = await lstat(next);
    } catch {
      return { reason: "missing" };
    }
    if (!st.isSymbolicLink()) {
      cur = next;
      isDir = st.isDirectory();
      continue;
    }
    if (++links > MAX_LINKS) return { reason: "missing" };
    let target: string;
    try {
      target = await readlink(next);
    } catch {
      return { reason: "missing" };
    }
    if (target.startsWith(sep)) {
      const alias = aliases.find((a) => target === a || target.startsWith(a + sep));
      cur = alias ? rootReal : sep;
      pending.unshift(...(alias ? target.slice(alias.length) : target).split("/"));
    } else pending.unshift(...target.split("/"));
  }
  return isInside(cur) ? { real: cur } : { reason: "outside" };
}

/**
 * The existence probe of `root/rel` (5.4): what a download would send, or why there is nothing. A path that is not
 * there inside the folder (or a link whose target inside is not) is `missing`; one that leads outside the folder, by
 * `..` or a link, is `outside` whether or not its target outside exists (walkInside); a fifo, a socket or a device is
 * `not_a_file`. It reads as much as the HEAD probe does, and opens nothing.
 */
export async function probeTarget(
  root: string,
  rel: string | null,
  name?: string,
  limits: FolderLimits = FOLDER_LIMITS,
): Promise<{ exists: true; target: DownloadTarget } | { exists: false; reason: MissingReason }> {
  const at = await locate(root, rel);
  if ("reason" in at) return { exists: false, reason: at.reason };
  const target = await targetAt(at, rel, name, limits);
  if (target) return { exists: true, target };
  try {
    await lstat(at.real);
    return { exists: false, reason: "not_a_file" };
  } catch {
    return { exists: false, reason: "missing" };
  }
}

/**
 * What `root/rel` is (`rel` null: `root` itself, for an upload's own file), or null when it is not there or steps
 * outside the folder. It resolves the path as the existence probe does, so the two always agree.
 */
export async function downloadTarget(root: string, rel: string | null, name?: string, limits: FolderLimits = FOLDER_LIMITS): Promise<DownloadTarget | null> {
  const at = await resolveInside(root, rel);
  return at ? targetAt(at, rel, name, limits) : null;
}

async function targetAt(at: { rootReal: string; real: string }, rel: string | null, name: string | undefined, limits: FolderLimits): Promise<DownloadTarget | null> {
  let st;
  try {
    st = await lstat(at.real);
  } catch {
    return null;
  }
  const shown = name ?? basename(rel ?? at.real);
  if (st.isFile()) return { kind: "file", name: shown, real: at.real, rootReal: at.rootReal, size: st.size };
  if (st.isDirectory()) {
    const walk = await walkFolder(at.real, limits);
    return { kind: "folder", name: shown, real: at.real, rootReal: at.rootReal, ...walk };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// The archive: POSIX ustar blocks, with a pax record for a long or non-ASCII name, gzipped

const utf8 = new TextEncoder();
const isAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);

function octal(buf: Uint8Array, at: number, len: number, n: number): void {
  const s = Math.max(0, Math.floor(n)).toString(8).padStart(len - 1, "0").slice(-(len - 1));
  buf.set(utf8.encode(s), at);
  buf[at + len - 1] = 0;
}

function putText(buf: Uint8Array, at: number, len: number, s: string): void {
  buf.set(utf8.encode(s).subarray(0, len), at);
}

/** An ASCII name of at most 100 bytes for the ustar field when a pax record holds the real one. */
const shortName = (s: string) => s.replace(/[^\x20-\x7e]/g, "_").slice(-100);

function ustarBlock(name: string, type: "0" | "2" | "5" | "x", size: number, mode: number, mtimeS: number, link = ""): Uint8Array {
  const b = new Uint8Array(512);
  putText(b, 0, 100, name);
  octal(b, 100, 8, mode);
  octal(b, 108, 8, 0);
  octal(b, 116, 8, 0);
  octal(b, 124, 12, size);
  octal(b, 136, 12, mtimeS);
  b.fill(0x20, 148, 156);
  b[156] = type.charCodeAt(0);
  putText(b, 157, 100, link);
  putText(b, 257, 6, "ustar");
  putText(b, 263, 2, "00");
  let sum = 0;
  for (const x of b) sum += x;
  putText(b, 148, 6, sum.toString(8).padStart(6, "0"));
  b[154] = 0;
  b[155] = 0x20;
  return b;
}

/** One pax record, `<length> <key>=<value>\n`, where the length counts the whole record. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  const bodyLen = utf8.encode(body).length;
  let len = bodyLen + 1;
  while (String(len).length + bodyLen !== len) len = String(len).length + bodyLen;
  return `${len}${body}`;
}

const pad512 = (n: number) => new Uint8Array((512 - (n % 512)) % 512);

function entryHeader(name: string, type: "0" | "2" | "5", size: number, mode: number, mtimeS: number, link = ""): Uint8Array[] {
  const records: string[] = [];
  if (utf8.encode(name).length > 100 || !isAscii(name)) records.push(paxRecord("path", name));
  if (utf8.encode(link).length > 100 || !isAscii(link)) records.push(paxRecord("linkpath", link));
  const out: Uint8Array[] = [];
  if (records.length) {
    const body = utf8.encode(records.join(""));
    out.push(ustarBlock(shortName(`PaxHeaders/${name}`), "x", body.length, 0o644, mtimeS), body, pad512(body.length));
  }
  out.push(ustarBlock(shortName(name), type, size, mode, mtimeS, shortName(link)));
  return out;
}

/** The tar bytes of a walked folder, under the top name `top`. */
async function* tarChunks(folderReal: string, rootReal: string, top: string, entries: readonly FolderEntry[]): AsyncGenerator<Uint8Array> {
  for (const e of entries) {
    const name = e.rel ? `${top}/${e.rel}` : top;
    if (e.kind === "dir") {
      yield* entryHeader(`${name}/`, "5", 0, e.mode, e.mtimeS);
    } else if (e.kind === "link") {
      yield* entryHeader(name, "2", 0, e.mode, e.mtimeS, e.link ?? "");
    } else {
      const opened = await openInside(join(folderReal, e.rel), rootReal, { dev: e.dev, ino: e.ino });
      if (!opened) continue; // gone or changed since the walk: left out
      yield* entryHeader(name, "0", e.size, e.mode, e.mtimeS);
      yield* fileBytes(opened.fh, e.size);
      yield pad512(e.size);
    }
  }
  yield new Uint8Array(1024);
}

/** The folder as a gzipped tar stream. Each file holds the bytes it had in the walk (cut or zero-filled after). */
export function folderArchive(target: Extract<DownloadTarget, { kind: "folder" }>): ReadableStream<Uint8Array> {
  const tar = streamOf(tarChunks(target.real, target.rootReal, target.name, target.entries));
  return tar.pipeThrough(new CompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
}

/** The file's bytes, or null when it cannot be opened as a regular file inside its folder now. */
export async function fileDownload(target: Extract<DownloadTarget, { kind: "file" }>): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null> {
  const opened = await openInside(target.real, target.rootReal);
  if (!opened) return null;
  return { body: streamOf(fileBytes(opened.fh, opened.size)), size: opened.size };
}
