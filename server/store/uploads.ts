// The upload folders and the upload writer (DESIGN.md 4.4 "The upload folders", D37, D42; 6.4 Files). Three of the
// four folders are outside the state folder, and the default one, the Temporary folder, has a fixed name in a folder
// that every user of the host can write. So a folder is checked with lstat before each upload, `recursive` is never
// used on one, each upload gets its own new mkdtemp folder (0700), and its file is written 0600 through an exclusive,
// no-follow open under a temporary name, then renamed to its own name once the measured size passed the cap.

import { lstat, mkdir, mkdtemp, readdir, rename, rm, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, join } from "node:path";
import { isUuid } from "../../shared/ids";
import { errno, fsyncDir, openExclusive, ownedBy, sealFile, writeAll } from "./files";
import { NAME_MAX_BYTES, UNSAFE_NAME, UPLOAD_DIR_RE, isSavedName } from "./records";
import type { UploadFolderChoice } from "./types";

export type UploadFolderProblem = "symlink" | "owner" | "mode" | "missing";

/** The one line that the attachment chip and Settings > Chats > Uploads show for a folder that fails (4.4). */
export const UPLOAD_FOLDER_LINES: Readonly<Record<UploadFolderProblem, string>> = {
  symlink: "The upload folder is a symbolic link, so kitespan does not use it. Pick another folder in Settings > Chats > Uploads.",
  owner: "The upload folder belongs to another user, so kitespan does not use it. Pick another folder in Settings > Chats > Uploads.",
  mode: "Other users can open or change the upload folder, so kitespan does not use it. Run chmod 700 on it, or pick another folder in Settings > Chats > Uploads.",
  missing: "The upload folder does not exist. Make it, or pick another folder in Settings > Chats > Uploads.",
};

/** One MB, as Finder counts it and as the size labels show it (the prototype's rule). */
export const MB = 1_000_000;

/** Largest upload (Settings > Chats > Uploads) in bytes. */
export const uploadCapBytes = (maxMB: number): number => maxMB * MB;

export function tooLargeLine(maxMB: number): string {
  return `That file is larger than the ${maxMB} MB limit.`;
}

/** What the folder check needs of an lstat result. */
export interface FolderFacts {
  isDirectory: boolean;
  isSymbolicLink: boolean;
  uid: number;
  mode: number;
}

/**
 * The folder rule of 4.4 as a pure function of an lstat result (null: nothing there) and the server's user id. The
 * Temporary folder and kitespan's own folder must be 0700 (no group or other bit at all, D42); Claude Code's uploads
 * folder and a custom folder must not be writable by the group or by others (0755 passes, because each upload sits in
 * its own 0700 folder).
 */
export function folderProblem(choice: UploadFolderChoice, st: FolderFacts | null, uid: number): UploadFolderProblem | null {
  if (st === null) return "missing";
  if (st.isSymbolicLink) return "symlink";
  if (!st.isDirectory) return "missing";
  if (!ownedBy(st.uid, uid)) return "owner";
  const forbidden = choice === "temp" || choice === "state" ? 0o077 : 0o022;
  return (st.mode & forbidden) !== 0 ? "mode" : null;
}

/** lstat (never stat, which follows a link) and the rule. */
export async function checkUploadFolder(choice: UploadFolderChoice, path: string, uid: number): Promise<UploadFolderProblem | null> {
  try {
    const st = await lstat(path);
    return folderProblem(choice, { isDirectory: st.isDirectory(), isSymbolicLink: st.isSymbolicLink(), uid: st.uid, mode: st.mode }, uid);
  } catch (e) {
    if (errno(e) === "ENOENT" || errno(e) === "ENOTDIR") return "missing";
    throw e;
  }
}

/** Where the four folders are. */
export interface UploadPlaces {
  /** The state folder's `uploads/`. */
  stateUploads: string;
  /** The folder that holds the Temporary folder (the system's temporary folder). */
  tmpRoot: string;
  /** The user's home folder (Claude Code's `~/.claude/uploads/`). */
  home: string;
  /** The user's name as the Temporary folder's name carries it. */
  user: string;
  uid: number;
}

/** A user name that is safe in a folder name; anything else gives the user id. */
export function userTag(name: string | null | undefined, uid: number): string {
  return typeof name === "string" && /^[A-Za-z0-9._-]{1,32}$/.test(name) && !/^\.+$/.test(name) ? name : `uid${Math.max(0, uid)}`;
}

/** `/tmp/kitespan-uploads-<user>/` (in the system's temporary folder). */
export const tempFolderPath = (p: UploadPlaces): string => join(p.tmpRoot, `kitespan-uploads-${p.user}`);

export type UploadFolderResult =
  | { ok: true; choice: UploadFolderChoice; path: string }
  | { ok: false; choice: UploadFolderChoice; path: string | null; problem: UploadFolderProblem; line: string };

const refused = (choice: UploadFolderChoice, path: string | null, problem: UploadFolderProblem): UploadFolderResult => ({
  ok: false,
  choice,
  path,
  problem,
  line: UPLOAD_FOLDER_LINES[problem],
});

/** mkdir one folder, never recursive; EEXIST is not an error, because the check that follows decides. */
async function makeOne(path: string): Promise<"made" | "there" | "missing"> {
  try {
    await mkdir(path, { mode: 0o700 });
    return "made";
  } catch (e) {
    if (errno(e) === "EEXIST") return "there";
    if (errno(e) === "ENOENT" || errno(e) === "ENOTDIR") return "missing";
    throw e;
  }
}

/**
 * The upload folder for a choice, made where the rule says so and checked: the Temporary folder is made 0700 (D42);
 * kitespan's own folder exists from open(); Claude Code's gets a missing `<session>` folder made 0700 (D41: the session
 * id kitespan picks for the chat); a custom folder must exist and is never made. Nothing is written into a folder that
 * fails.
 */
export async function prepareUploadFolder(
  choice: UploadFolderChoice,
  places: UploadPlaces,
  opts: { customFolder: string | null; sessionId: string | null },
): Promise<UploadFolderResult> {
  let path: string;
  if (choice === "temp") {
    path = tempFolderPath(places);
    if ((await makeOne(path)) === "missing") return refused(choice, path, "missing");
  } else if (choice === "state") {
    path = places.stateUploads;
  } else if (choice === "claude") {
    if (!isUuid(opts.sessionId)) throw new TypeError("Claude Code's uploads folder needs the chat's session id");
    const base = join(places.home, ".claude", "uploads");
    path = join(base, opts.sessionId);
    if ((await makeOne(base)) === "missing") return refused(choice, path, "missing");
    if ((await makeOne(path)) === "missing") return refused(choice, path, "missing");
  } else {
    if (opts.customFolder === null) return refused(choice, null, "missing");
    path = opts.customFolder;
  }
  const problem = await checkUploadFolder(choice, path, places.uid);
  return problem ? refused(choice, path, problem) : { ok: true, choice, path };
}

// ---------------------------------------------------------------------------------------------------------------
// Names

const utf8 = new TextEncoder();
const bytesOf = (s: string): number => utf8.encode(s).byteLength;
/** An extension a long name keeps whole: the part after its last dot, when that is at most this many bytes. */
const EXT_MAX_BYTES = 32;
/** Path separators, C0 and C1 controls, DEL, the bidirectional marks and the line and paragraph separators. */
const UNSAFE_NAME_ALL = new RegExp(UNSAFE_NAME.source, "g");

/** The longest start of `text` that is at most `max` UTF-8 bytes, cut between code points (never in a pair). */
function cutBytes(text: string, max: number): string {
  let used = 0;
  let out = "";
  for (const ch of text) {
    const n = bytesOf(ch);
    if (used + n > max) break;
    used += n;
    out += ch;
  }
  return out;
}

/**
 * The name a file is saved under: its own name with each slash, backslash, control or bidirectional character made an
 * underscore, at most 255 bytes of UTF-8 with its extension kept; a name of dots only becomes an underscore; a
 * nameless file (a pasted image) is `pasted.<subtype>` from its type ("image/png" gives pasted.png, "text/plain"
 * pasted.txt, no type plain "pasted").
 */
export function uploadName(name: string, type: string): string {
  let own = name.replace(UNSAFE_NAME_ALL, "_").trim();
  if (bytesOf(own) > NAME_MAX_BYTES) {
    const dot = own.lastIndexOf(".");
    const ext = dot > 0 && bytesOf(own.slice(dot)) <= EXT_MAX_BYTES ? own.slice(dot) : "";
    own = cutBytes(own.slice(0, own.length - ext.length), NAME_MAX_BYTES - bytesOf(ext)).trimEnd() + ext;
  }
  if (own && !/^\.+$/.test(own)) return own;
  if (own) return "_";
  const sub = /^[a-z0-9.+-]+\/([a-z0-9.-]+)/i.exec(type.trim())?.[1]?.toLowerCase();
  if (!sub) return "pasted";
  return `pasted.${sub === "plain" ? "txt" : sub}`;
}

// ---------------------------------------------------------------------------------------------------------------
// The writer

export type UploadErrorCode = "too_large" | "folder";

export class UploadError extends Error {
  readonly code: UploadErrorCode;
  constructor(code: UploadErrorCode, message: string) {
    super(message);
    this.name = "UploadError";
    this.code = code;
  }
}

export type UploadBody = Uint8Array | AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;

async function* chunksOf(body: UploadBody): AsyncGenerator<Uint8Array> {
  if (body instanceof Uint8Array) {
    yield body;
    return;
  }
  for await (const c of body as AsyncIterable<Uint8Array>) yield c;
}

export interface WrittenUpload {
  /** The saved name (uploadName). */
  name: string;
  /** The bytes written, as counted while they arrived. */
  size: number;
  /** The file's absolute path: its reference in a message is shared/protocol.ts messageRef. */
  path: string;
  /** The upload's own `u-XXXXXX` folder (0700); Remove deletes it. */
  dir: string;
}

/**
 * Write one upload into a folder that passed prepareUploadFolder: make its own folder with mkdtemp (`u-` and six
 * characters, 0700, a name no other folder has, so two files with one name never collide), open a temporary file in
 * it (exclusive, no-follow, 0600), count every byte as it arrives and stop at `maxBytes` + 1 (a measured cap, never
 * the declared length), fsync, check the mode, then rename the file to its saved name and fsync the folder. A failure
 * leaves nothing behind.
 */
export async function writeUpload(folder: string, rawName: string, type: string, body: UploadBody, maxBytes: number, uid: number): Promise<WrittenUpload> {
  const name = uploadName(rawName, type);
  if (!isSavedName(name)) throw new UploadError("folder", "the name cannot be saved");
  const dir = await mkdtemp(join(folder, "u-"));
  let h: FileHandle | null = null;
  let placed: string | null = null;
  const tmp = join(dir, `.${randomBytes(8).toString("hex")}.upload.tmp`);
  try {
    const st = await lstat(dir);
    if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o777) !== 0o700 || !ownedBy(st.uid, uid)) {
      throw new UploadError("folder", "the upload's own folder is not this user's 0700 folder");
    }
    h = await openExclusive(tmp);
    let size = 0;
    for await (const chunk of chunksOf(body)) {
      size += chunk.byteLength;
      if (size > maxBytes) throw new UploadError("too_large", "the file is over the upload limit");
      await writeAll(h, chunk);
    }
    await h.sync();
    await sealFile(h, uid);
    await h.close();
    h = null;
    // The folder is new and this user's alone, so the name is free unless it equals the temporary name.
    const path = join(dir, name);
    const taken = await lstat(path).then(
      () => true,
      (e: unknown) => (errno(e) === "ENOENT" ? false : Promise.reject(e)),
    );
    if (taken) throw new UploadError("folder", "the saved name is taken");
    await rename(tmp, path);
    placed = path;
    await fsyncDir(dir);
    return { name, size, path, dir };
  } catch (e) {
    if (h) await h.close().catch(() => {});
    await unlink(tmp).catch(() => {});
    if (placed) await unlink(placed).catch(() => {});
    await rmdir(dir).catch(() => {});
    throw e;
  }
}

/**
 * Remove one upload's own folder (Remove, and the sweep). Only a real `u-XXXXXX` folder of this user goes; a symbolic
 * link in its place is left alone, and nothing inside is followed (a link inside is removed as a link).
 */
export async function removeUploadDir(dir: string, uid: number): Promise<boolean> {
  if (!UPLOAD_DIR_RE.test(basename(dir))) return false;
  let st;
  try {
    st = await lstat(dir);
  } catch {
    return false;
  }
  if (st.isSymbolicLink() || !st.isDirectory() || !ownedBy(st.uid, uid)) return false;
  await rm(dir, { recursive: true, force: true });
  return true;
}

/**
 * The sweep of Delete uploads after (6.8; the kept folders only): remove the `u-XXXXXX` folders in `folder` whose last
 * change is older than `keepDays`. Each one is checked with lstat first; a symbolic link and its target are left
 * alone. Returns how many went.
 */
export async function sweepUploadDirs(folder: string, keepDays: number, nowMs: number, uid: number): Promise<number> {
  const cutoff = nowMs - keepDays * 86_400_000;
  let names: string[];
  try {
    names = await readdir(folder);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!UPLOAD_DIR_RE.test(name)) continue;
    const dir = join(folder, name);
    try {
      const st = await lstat(dir);
      if (st.isSymbolicLink() || !st.isDirectory() || st.mtimeMs >= cutoff) continue;
      if (await removeUploadDir(dir, uid)) removed++;
    } catch {
      // gone already
    }
  }
  return removed;
}
