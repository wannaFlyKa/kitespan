// The one-time move of the old name's folders (iteration 6, round K1; FIX-K1.md 1; shared/legacy.ts): at the first
// start of a kitespan server from the terminal, each of the state, config and data folders of the old name moves to
// the new name (places.ts), in that order, stopping at the first one that fails, so a build of the old name never
// finds its config moved while its state stays. The three folders are one install: the config and data folders move
// only with a state folder of the old name under the state base (moved now, moved before and its note left, or there
// still), so a start whose XDG_STATE_HOME names a fresh or scratch folder moves nothing under the home folder's other
// bases. Of two starts at once, the one whose rename comes second finds the new name taken and goes on as if it had
// found it so. main.ts runs it after the options and the start environment's check, before the store, the logger, the
// adapters and the worktree records; a restart's `--check`, a restart's successor (its server of the old name may go
// on writing the old folder after a failed health gate, DESIGN 4.10 step 7) and bin/update.sh never move. Claude
// Code's own files are never touched.
//
// A folder moves only when nothing is at the new name and the old one is a real folder of this user (a config folder
// may also be a link to a folder: the link moves). The state folder must pass the store's own check first (else it
// stays, and the store refuses it by its own path, as the old build did); a state folder that is a link refuses the
// start; the data folder stays while it holds a worktree made under it or a record in the making (their absolute paths
// are in the ledgers, in git and in Claude Code's folder names). Nothing moves while it is in use: bin/update.sh's lock
// in the state folder; anything that listens on this start's port (every system); on Linux a process of this user
// with its working folder or an open file in it (a server holds its state folder open from its boot: holdFolder), or a
// server of this product, of either name, whose XDG folders are these (procUsers).
//
// On one file system the folder is renamed whole (atomic; every inode, mode, owner and time kept). Across file
// systems (EXDEV) it is copied into a staging folder beside it, with lstat and no link followed, each file through an
// exclusive no-follow open with its own mode and times; the copy is checked (names, kinds, sizes, modes and SHA-256,
// and no file of the old folder changed meanwhile), then switched in with a rename, the switch synced to disk, and
// only then the old folder's entries go one by one. A staging folder that a crash left goes at the next move only
// while the old folder still holds all it holds (a copy cut short); one that holds more stays, and the move waits. A
// failure leaves the old folder as it was and the start says so in one line, and kitespan uses it in place this time.
// The old path then holds a 0600 note that says where the folder went (a link would turn a later `rm -rf <old>/` into
// a delete of the new folder). Both there (a move that another way made, or a crash after the switch): the new one is
// used, the old one is never read, written or moved, and each start says so in one line.

import { closeSync, constants, existsSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, statSync, type Stats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rename as fsRename, rmdir, unlink, utimes } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { LEGACY_BIN, LEGACY_FOLDER, LEGACY_NOTE_HEAD, legacyNote } from "../../shared/legacy";
import { lockHeld } from "../update/lock";
import { listening } from "../update/loopback";
import { checkTree, errno, fsyncDir, openExclusive, ownedBy, ownUid, writeAll } from "./files";
import { FOLDER_KINDS, FOLDER_NAME, xdgBase, type FolderKind } from "./places";
import { leftOpaque } from "./store";

/** One folder's end: nothing to do; renamed; copied; both there; kept in place by rule; failed; refused; not tried. */
export type MoveOutcome = "none" | "moved" | "copied" | "both" | "stays" | "failed" | "refused" | "skipped";

export interface MoveReport {
  state: MoveOutcome;
  config: MoveOutcome;
  data: MoveOutcome;
  /** The line that refuses the start (an old state folder that is a symbolic link), or null. */
  refuse: string | null;
}

export interface MoveOptions {
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  /** A terminal line: a folder moved. */
  say: (line: string) => void;
  /** A terminal line about a problem: a move that failed, or both folders there. */
  complain: (line: string) => void;
  uid?: number;
  now?: () => Date;
  /** The rename (tests plug in a failure, or EXDEV for the copy). */
  rename?: (from: string, to: string) => Promise<void>;
  /** A live process of this user that uses the folder: its pid, or null. By default /proc on Linux, none elsewhere. */
  inUse?: (folder: string) => Promise<number | null>;
  /** This start's port: while anything listens on it (another server, maybe on these folders), nothing moves. */
  port?: number;
  /** Whether anything listens on 127.0.0.1:<port> (by default a TCP connect, at most 1 s). */
  portInUse?: (port: number) => Promise<boolean>;
  /** fsync of a folder (tests watch the order). */
  syncDir?: (dir: string) => Promise<void>;
}

/** The staging folder of a copy, a mkdtemp folder in the same XDG base; one that a crash left goes at the next move. */
const STAGING = `.${FOLDER_NAME}-move-`;
const STALE_STAGING = new RegExp(`^\\.${FOLDER_NAME}-move-[A-Za-z0-9]{6}$`);

/** A copy's own refusal, with the words of the line. */
class Why extends Error {}

const lstatOrNull = (p: string): Stats | null => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};

const linkToFolder = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Move the old folders that are pending, in order, stopping at the first that fails or that the server refuses. */
export async function moveOldFolders(o: MoveOptions): Promise<MoveReport> {
  const report: MoveReport = { state: "skipped", config: "skipped", data: "skipped", refuse: null };
  const ctx: Ctx = {
    say: o.say,
    complain: o.complain,
    uid: o.uid ?? ownUid(),
    inUse: o.inUse ?? procUsers(o.home),
    rename: o.rename ?? fsRename,
    now: o.now ?? (() => new Date()),
    port: o.port ?? null,
    portInUse: o.portInUse ?? ((port) => listening(port, PORT_PROBE_MS)),
    syncDir: o.syncDir ?? fsyncDir,
  };
  for (const kind of FOLDER_KINDS) {
    const base = xdgBase(kind, o.env, o.home);
    const r = await moveOne(kind, base, ctx);
    report[kind] = r.outcome;
    if (r.refuse) report.refuse = r.refuse;
    if (r.outcome === "failed" || r.outcome === "refused") break;
    // No state folder of the old name here, now or before: the other bases' old folders are another install's.
    if (kind === "state" && (r.outcome === "stays" || (r.outcome === "none" && !holdsNote(join(base, LEGACY_FOLDER), ctx.uid)))) break;
  }
  return report;
}

/** How long the port's check waits for an answer. */
const PORT_PROBE_MS = 1_000;

interface Ctx {
  say: (line: string) => void;
  complain: (line: string) => void;
  uid: number;
  inUse: (folder: string) => Promise<number | null>;
  rename: (from: string, to: string) => Promise<void>;
  now: () => Date;
  port: number | null;
  portInUse: (port: number) => Promise<boolean>;
  syncDir: (dir: string) => Promise<void>;
}

/** `path` is the note of an earlier move: a file of this user that starts with the note's words. */
function holdsNote(path: string, uid: number): boolean {
  const st = lstatOrNull(path);
  if (!st?.isFile() || !ownedBy(st.uid, uid)) return false;
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const head = Buffer.alloc(Buffer.byteLength(LEGACY_NOTE_HEAD));
    return readSync(fd, head, 0, head.length, 0) === head.length && head.toString("utf8") === LEGACY_NOTE_HEAD;
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

async function moveOne(kind: FolderKind, base: string, o: Ctx): Promise<{ outcome: MoveOutcome; refuse?: string }> {
  const to = join(base, FOLDER_NAME);
  const from = join(base, LEGACY_FOLDER);
  const st = lstatOrNull(from);
  if (lstatOrNull(to)) {
    if (st && (st.isDirectory() || (kind === "config" && st.isSymbolicLink() && linkToFolder(from)))) {
      o.complain(`${from} is from before the rename and is not used: ${to} is.`);
      return { outcome: "both" };
    }
    return { outcome: "none" };
  }
  if (!st) return { outcome: "none" };
  if (st.isSymbolicLink()) {
    if (kind === "state") return { outcome: "refused", refuse: `${from} is a symbolic link, so it is not moved: move its folder to ${to}, then start kitespan again.` };
    // The old build never used a data folder that is a link; a config folder that links to a folder moves as a link.
    if (kind === "data" || !linkToFolder(from)) return { outcome: "none" };
  } else if (!st.isDirectory() || !ownedBy(st.uid, o.uid)) {
    // The note of an earlier move, or something that was never a folder of this user's: the new name is the folder.
    return { outcome: "none" };
  }
  if (kind === "state" && (await checkTree(from, o.uid, leftOpaque)).length > 0) return { outcome: "stays" };
  if (kind === "data" && holdsWorktrees(from)) return { outcome: "stays" };

  const fail = (why: string) => {
    o.complain(`could not move ${from} to ${to} (${why}), so kitespan uses ${from} this time.`);
    return { outcome: "failed" as const };
  };
  const both = () => {
    o.complain(`${from} is from before the rename and is not used: ${to} is.`);
    return { outcome: "both" as const };
  };
  if (kind === "state" && (await lockHeld(from).catch(() => true))) return fail("an update runs");
  const pid = await o.inUse(from);
  if (pid !== null) return fail(`process ${pid} uses it`);
  if (o.port !== null && (await o.portInUse(o.port))) return fail(`port ${o.port} is in use`);

  const kept = await sweepStaging(base, from, o.uid);
  if (kept) return fail(`${kept} holds files from an earlier start that ${from} does not`);
  let outcome: "moved" | "copied" = "moved";
  try {
    await o.rename(from, to);
  } catch (e) {
    // Another start moved it meanwhile (two at once): the new name is the folder now (places.ts).
    if (lstatOrNull(to)) return lstatOrNull(from)?.isDirectory() ? both() : { outcome: "none" };
    if (errno(e) !== "EXDEV" || st.isSymbolicLink()) return fail(errno(e) ?? "error");
    const r = await copyOver(from, to, base, o.rename, o.syncDir);
    if (r.kind === "failed") return fail(r.why);
    if (r.kind === "both") return both();
    outcome = "copied";
  }
  await o.syncDir(base).catch(() => {});
  await leaveNote(from, to, o.now().toISOString().slice(0, 10), o.syncDir).catch(() => {});
  o.say(`kitespan moved ${from} to ${to}.`);
  return { outcome };
}

/** The data folder holds a worktree made under it or a record in the making (or a project's folder is unreadable). */
function holdsWorktrees(data: string): boolean {
  const worktrees = join(data, "worktrees");
  let projects: string[];
  try {
    projects = readdirSync(worktrees);
  } catch (e) {
    return errno(e) !== "ENOENT";
  }
  for (const p of projects) {
    if (!lstatOrNull(join(worktrees, p))?.isDirectory()) continue;
    let names: string[];
    try {
      names = readdirSync(join(worktrees, p));
    } catch {
      return true;
    }
    if (names.some((n) => n.endsWith(".making") || lstatOrNull(join(worktrees, p, n))?.isDirectory())) return true;
  }
  return false;
}

/**
 * The staging folders that a crash left in `base` (ours: by name, a real folder of this user) go, each one only while
 * `from` still holds every entry that it holds: a copy cut short. One that holds more is the checked copy of a switch
 * that a crash lost after the old folder began to empty: it stays, and its path is returned.
 */
async function sweepStaging(base: string, from: string, uid: number): Promise<string | null> {
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return null;
  }
  for (const n of names) {
    const st = STALE_STAGING.test(n) ? lstatOrNull(join(base, n)) : null;
    if (!st?.isDirectory() || !ownedBy(st.uid, uid)) continue;
    const staging = join(base, n);
    if (await holdsMore(staging, from)) return staging;
    await removeTree(staging).catch(() => {});
  }
  return null;
}

/** An entry under `staging` that `from` does not have, by its relative path (lstat); a read that fails counts as one. */
async function holdsMore(staging: string, from: string): Promise<boolean> {
  const walk = async (rel: string): Promise<boolean> => {
    for (const n of await readdir(join(staging, rel))) {
      const r = join(rel, n);
      const there = lstatOrNull(join(from, r));
      if (!there) return true;
      if ((await lstat(join(staging, r))).isDirectory() && (!there.isDirectory() || (await walk(r)))) return true;
    }
    return false;
  };
  try {
    return await walk("");
  } catch {
    return true;
  }
}

type CopyResult = { kind: "done" } | { kind: "failed"; why: string } | { kind: "both" };

/**
 * EXDEV: copy `from` into a staging folder in `base`, check it, switch it in as `to`, sync the switch, then empty and
 * remove `from`.
 */
async function copyOver(from: string, to: string, base: string, rename: (a: string, b: string) => Promise<void>, syncDir: (dir: string) => Promise<void>): Promise<CopyResult> {
  let staging: string;
  try {
    staging = await mkdtemp(join(base, STAGING));
  } catch (e) {
    return { kind: "failed", why: errno(e) ?? "error" };
  }
  let switching = false;
  try {
    const before = await facts(from, false);
    await copyTree(from, staging, true);
    const after = await facts(from, true);
    if (!same(before, after, "mtime")) throw new Why("a file changed during the copy");
    if (!same(after, await facts(staging, true), "sha")) throw new Why("the copy does not match");
    await syncFolders(staging, syncDir);
    switching = true;
    await rename(staging, to);
  } catch (e) {
    await removeTree(staging).catch(() => {});
    // The new name appeared meanwhile: it is the folder now, and the old one stays as it was.
    if (switching && (errno(e) === "EEXIST" || errno(e) === "ENOTEMPTY")) return { kind: "both" };
    return { kind: "failed", why: e instanceof Why ? e.message : (errno(e) ?? "error") };
  }
  // The old folder is a mount point of another file system, so its removals and this rename are not ordered on disk:
  // the switch goes to disk first. If it cannot, both folders stay (the new one is used).
  try {
    await syncDir(base);
  } catch {
    return { kind: "both" };
  }
  try {
    await removeContents(from);
    await rmdir(from);
  } catch {
    return { kind: "both" };
  }
  return { kind: "done" };
}

/** Copy `src` to `dst` (made here, or the staging folder itself at the top), never through a link. */
async function copyTree(src: string, dst: string, top = false): Promise<void> {
  const st = await lstat(src);
  if (st.isDirectory()) {
    if (!top) await mkdir(dst, { mode: 0o700 });
    for (const name of (await readdir(src)).sort()) await copyTree(join(src, name), join(dst, name));
    // The folder's own mode and times once its entries are in (they change its time; a read-only one takes none).
    await chmod(dst, st.mode & 0o7777);
    await utimes(dst, st.atime, st.mtime);
    return;
  }
  if (!st.isFile()) throw new Why("a link or a special file is inside it");
  const r = await open(src, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const w = await openExclusive(dst);
    try {
      const buf = Buffer.alloc(64 * 1024);
      for (;;) {
        const { bytesRead } = await r.read(buf, 0, buf.length, null);
        if (bytesRead === 0) break;
        await writeAll(w, buf.subarray(0, bytesRead));
      }
      await w.sync();
      await w.chmod(st.mode & 0o7777);
    } finally {
      await w.close();
    }
  } finally {
    await r.close();
  }
  // Each file's own times: the upload sweep goes by them (uploads.ts).
  await utimes(dst, st.atime, st.mtime);
}

interface Facts {
  dir: boolean;
  mode: number;
  size: number;
  mtime: number;
  sha: string;
}

/** Every entry under `root` by its relative path (lstat; a link or a special file stops the copy). */
async function facts(root: string, hash: boolean): Promise<Map<string, Facts>> {
  const out = new Map<string, Facts>();
  const walk = async (abs: string, rel: string): Promise<void> => {
    const st = await lstat(abs);
    if (st.isDirectory()) {
      out.set(rel, { dir: true, mode: st.mode & 0o7777, size: 0, mtime: 0, sha: "" });
      for (const n of (await readdir(abs)).sort()) await walk(join(abs, n), rel ? `${rel}/${n}` : n);
    } else if (st.isFile()) {
      out.set(rel, { dir: false, mode: st.mode & 0o7777, size: st.size, mtime: st.mtimeMs, sha: hash ? await sha256(abs) : "" });
    } else throw new Why("a link or a special file is inside it");
  };
  await walk(root, "");
  return out;
}

function same(a: Map<string, Facts>, b: Map<string, Facts>, also: "mtime" | "sha"): boolean {
  if (a.size !== b.size) return false;
  for (const [rel, x] of a) {
    const y = b.get(rel);
    if (!y || x.dir !== y.dir || x.mode !== y.mode || x.size !== y.size || x[also] !== y[also]) return false;
  }
  return true;
}

async function sha256(path: string): Promise<string> {
  const h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return createHash("sha256").update(await h.readFile()).digest("hex");
  } finally {
    await h.close();
  }
}

/** fsync every folder of the copy, so the switch's rename finds its entries on disk after a crash. */
async function syncFolders(root: string, syncDir: (dir: string) => Promise<void>): Promise<void> {
  for (const n of await readdir(root)) {
    if ((await lstat(join(root, n))).isDirectory()) await syncFolders(join(root, n), syncDir);
  }
  await syncDir(root);
}

/** Remove `p` and what it holds, one entry at a time by lstat, never following a link. */
async function removeTree(p: string): Promise<void> {
  const st = await lstat(p).catch((e) => {
    if (errno(e) === "ENOENT") return null;
    throw e;
  });
  if (!st) return;
  if (!st.isDirectory()) return unlink(p);
  await removeContents(p);
  await rmdir(p);
}

async function removeContents(dir: string): Promise<void> {
  const st = await lstat(dir);
  // A read-only folder of git's (a mark's objects) lets its entries go once its owner may write it.
  if ((st.mode & 0o700) !== 0o700) await chmod(dir, (st.mode & 0o7777) | 0o700);
  for (const n of await readdir(dir)) await removeTree(join(dir, n));
}

/** The note at the old folder's own path: a new 0600 file (exclusive, no link followed). */
async function leaveNote(from: string, to: string, day: string, syncDir: (dir: string) => Promise<void>): Promise<void> {
  const h = await openExclusive(from);
  try {
    await writeAll(h, new TextEncoder().encode(legacyNote(to, day)));
    await h.sync();
  } finally {
    await h.close();
  }
  await syncDir(dirname(from));
}

/** This process's open descriptors on its state folder (holdFolder), kept until it exits. */
const held: number[] = [];

/**
 * Keep the state folder open for the life of the process, so that another start's move sees this server use it from
 * its boot (procUsers reads each process's open files), not only from its first log line.
 */
export function holdFolder(dir: string): void {
  try {
    held.push(openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
  } catch {
    // The store's own checks decide about the folder.
  }
}

/** A use that counts for every folder: a server of this product whose environment cannot be read. */
const ANY = "\0";
/** The environment names that say where a server's folders are (xdgBase); no other name of a process is read. */
const XDG_NAMES = new Set(["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]);
const MAIN = "server/main.ts";

/**
 * Linux: this user's other processes that use a folder, read once from /proc (read only; another user's entries are
 * skipped): one whose working folder or an open file is in it, and a server of this product, of either name, whose
 * XDG folders are this one (serverFolders). Elsewhere, and when /proc cannot be read, none.
 */
function procUsers(home: string, self: number = process.pid): (folder: string) => Promise<number | null> {
  let seen: [number, string][] | null = null;
  const scan = (): [number, string][] => {
    const out: [number, string][] = [];
    let names: string[];
    try {
      names = readdirSync("/proc");
    } catch {
      return out;
    }
    const uid = ownUid();
    for (const name of names) {
      if (!/^[0-9]+$/.test(name) || Number(name) === self) continue;
      const pid = Number(name);
      const dir = `/proc/${name}`;
      try {
        if (!ownedBy(statSync(dir).uid, uid)) continue;
      } catch {
        continue; // gone
      }
      try {
        out.push([pid, readlinkSync(`${dir}/cwd`)]);
      } catch {
        // gone, or not ours to read
      }
      let fds: string[] = [];
      try {
        fds = readdirSync(`${dir}/fd`);
      } catch {
        // gone, or not ours to read
      }
      for (const fd of fds) {
        try {
          out.push([pid, readlinkSync(`${dir}/fd/${fd}`)]);
        } catch {
          // closed meanwhile
        }
      }
      for (const folder of serverFolders(dir, home)) out.push([pid, folder]);
    }
    return out;
  };
  return async (folder) => {
    // An open file's path is its real one; a server's folder is named by its real base (a config link is not followed).
    let real = folder;
    let named = folder;
    try {
      real = realpathSync(folder);
    } catch {
      // as given
    }
    try {
      named = join(realpathSync(dirname(folder)), basename(folder));
    } catch {
      // as given
    }
    seen ??= scan();
    return seen.find(([, p]) => p === ANY || p === real || p === named || p.startsWith(`${real}/`))?.[0] ?? null;
  };
}

/**
 * The old name's folders of a server of this product, the process of /proc entry `dir`: its command line runs Bun on
 * `server/main.ts` of a checkout with bin/kitespan or the old start command (the old name's build and this one start
 * the same way); one folder per XDG base, by its own HOME and XDG variables (the only names read from its environment,
 * never kept or logged; xdgBase's rule). A renamed server also holds its state folder open from its boot (holdFolder),
 * an old build only from its first log line, hence this rule. ANY when its environment cannot be read; none for any
 * other process.
 */
function serverFolders(dir: string, home: string): string[] {
  let argv: string[];
  try {
    argv = readFileSync(`${dir}/cmdline`, "utf8").split("\0");
  } catch {
    return [];
  }
  if (!/^bun/.test(basename(argv[0] ?? ""))) return [];
  const main = argv.slice(1).find((a) => a === MAIN || a.endsWith(`/${MAIN}`));
  if (!main) return [];
  let root = main.slice(0, -MAIN.length) || ".";
  try {
    if (!isAbsolute(root)) root = resolve(readlinkSync(`${dir}/cwd`), root);
  } catch {
    return [];
  }
  if (!existsSync(join(root, "bin", "kitespan")) && !existsSync(join(root, LEGACY_BIN))) return [];
  const env: Record<string, string> = {};
  try {
    for (const pair of readFileSync(`${dir}/environ`, "utf8").split("\0")) {
      const at = pair.indexOf("=");
      if (at > 0 && XDG_NAMES.has(pair.slice(0, at))) env[pair.slice(0, at)] = pair.slice(at + 1);
    }
  } catch (e) {
    return errno(e) === "ENOENT" || errno(e) === "ESRCH" ? [] : [ANY];
  }
  return FOLDER_KINDS.map((kind) => {
    const base = xdgBase(kind, env, env.HOME || home);
    try {
      return join(realpathSync(base), LEGACY_FOLDER);
    } catch {
      return join(base, LEGACY_FOLDER);
    }
  });
}
