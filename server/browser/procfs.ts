// The shared browser's process checks read /proc (DESIGN-B1 2.3; SERVER-B1 2.6): a process's start with the boot's
// id, its command line in both of its forms, its uid, the LISTEN rows of a TCP port, which process holds a socket's
// inode, a process's descendants, and the row of one loopback connection (the peer check). Every read goes through a
// ProcReader, so the unit tests feed fake tables; the system's reader never follows anything but /proc's own links and
// never throws. Without /proc (macOS, a later port) every read gives null, and the checks that need it fail closed.

import { readdirSync, readFileSync, readlinkSync } from "node:fs";

export interface ProcReader {
  /** A file's bytes, or null when it cannot be read. */
  read(path: string): Buffer | null;
  /** A folder's names, or null. */
  list(path: string): string[] | null;
  /** A link's target, or null. */
  link(path: string): string | null;
}

export const systemProc: ProcReader = {
  read(path) {
    try {
      return readFileSync(path);
    } catch {
      return null;
    }
  },
  list(path) {
    try {
      return readdirSync(path);
    } catch {
      return null;
    }
  },
  link(path) {
    try {
      return readlinkSync(path);
    } catch {
      return null;
    }
  },
};

const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const validPid = (pid: number): boolean => Number.isInteger(pid) && pid > 1 && pid < 2 ** 31;

/** This boot's id, or null. */
export function bootId(r: ProcReader): string | null {
  const id = r.read("/proc/sys/kernel/random/boot_id")?.toString("utf8").trim() ?? "";
  return BOOT_ID.test(id) ? id : null;
}

/** /proc/<pid>/stat's fields after the command's name: state, ppid and the start ticks (field 22). */
function statOf(r: ProcReader, pid: number): { state: string; ppid: number; start: string } | null {
  if (!validPid(pid)) return null;
  const s = r.read(`/proc/${pid}/stat`)?.toString("utf8");
  if (!s) return null;
  const close = s.lastIndexOf(")");
  if (close < 0) return null;
  const f = s.slice(close + 2).split(" ");
  const start = f[19];
  if (f[0] === undefined || start === undefined || !/^[0-9]{1,20}$/.test(start)) return null;
  return { state: f[0], ppid: Number(f[1]), start };
}

/**
 * Check 1's value: the start ticks of /proc/<pid>/stat, `@`, and the boot's id (the format of a ledger's LedgerProc),
 * so a record from before a reboot names no live process. Null when the process is gone, a zombie, or the boot's id is
 * unknown (then nothing is ever adopted or signalled).
 */
export function startOf(r: ProcReader, pid: number): string | null {
  const st = statOf(r, pid);
  const boot = bootId(r);
  if (!st || st.state === "Z" || st.state === "X" || !boot) return null;
  return `${st.start}@${boot}`;
}

/** Check 3's value: the real uid on /proc/<pid>/status's Uid line, or null. */
export function uidOf(r: ProcReader, pid: number): number | null {
  if (!validPid(pid)) return null;
  const m = /^Uid:\s+(\d+)/m.exec(r.read(`/proc/${pid}/status`)?.toString("utf8") ?? "");
  return m ? Number(m[1]) : null;
}

export type CmdlineForm = "argv" | "title" | "none";

/**
 * Check 2 (S2): whether a process's /proc/<pid>/cmdline holds every flag of `want` and none that starts with one of
 * `refused`, in both of the file's forms. More than one non-empty NUL-separated field: Chrome's own argv, and each flag
 * must be one whole field. One field: Chrome rewrote its title into one space-joined string, and each flag must stand
 * between spaces, or a space and an end, of it. A sanity check, not an identity check: a process of this user can set
 * any title (identity rests on checks 1, 3, 5 and 6).
 */
export function cmdlineCheck(buf: Buffer | Uint8Array | null, want: readonly string[], refused: readonly string[]): { form: CmdlineForm; ok: boolean } {
  if (!buf) return { form: "none", ok: false };
  const fields = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString("utf8").split("\0").filter((f) => f.length > 0);
  if (fields.length === 0) return { form: "none", ok: false };
  if (fields.length > 1) {
    const ok = want.every((f) => fields.includes(f)) && !fields.some((a) => refused.some((r) => a.startsWith(r)));
    return { form: "argv", ok };
  }
  const title = ` ${fields[0]} `;
  const ok = want.every((f) => title.includes(` ${f} `)) && !refused.some((r) => title.includes(` ${r}`));
  return { form: "title", ok };
}

/** A LISTEN row of /proc/net/tcp or tcp6. */
export interface ListenRow {
  uid: number;
  inode: string;
}

const NET_FILES = ["/proc/net/tcp", "/proc/net/tcp6"] as const;
/** The LISTEN state in /proc/net/tcp. */
const LISTEN = "0A";

/** Every LISTEN row for `port` (checks 4 and 5's rows; also how port_own and port_other are told apart). */
export function listenRows(r: ProcReader, port: number): ListenRow[] {
  const out: ListenRow[] = [];
  for (const file of NET_FILES) {
    const text = r.read(file)?.toString("utf8");
    if (!text) continue;
    for (const line of text.split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 10) continue;
      const local = f[1]!.split(":");
      if (local.length !== 2 || parseInt(local[1]!, 16) !== port || f[3] !== LISTEN) continue;
      if (!/^\d+$/.test(f[7]!) || !/^\d+$/.test(f[9]!)) continue;
      out.push({ uid: Number(f[7]), inode: f[9]! });
    }
  }
  return out;
}

/** The first of `pids` that holds the socket inode (a scan of /proc/<pid>/fd; only this user's processes can be read). */
export function holderOf(r: ProcReader, inode: string, pids: readonly number[]): number | null {
  const want = `socket:[${inode}]`;
  for (const pid of pids) {
    if (!validPid(pid)) continue;
    for (const fd of r.list(`/proc/${pid}/fd`) ?? []) if (r.link(`/proc/${pid}/fd/${fd}`) === want) return pid;
  }
  return null;
}

/** `root` and every process under it (from /proc/<pid>/task/<tid>/children), each once. */
export function treeOf(r: ProcReader, root: number): number[] {
  if (!validPid(root)) return [];
  const out = [root];
  const seen = new Set(out);
  for (let i = 0; i < out.length && out.length < 4096; i++) {
    for (const tid of r.list(`/proc/${out[i]}/task`) ?? []) {
      const kids = r.read(`/proc/${out[i]}/task/${tid}/children`)?.toString("utf8").trim();
      if (!kids) continue;
      for (const k of kids.split(/\s+/)) {
        const pid = Number(k);
        if (validPid(pid) && !seen.has(pid)) {
          seen.add(pid);
          out.push(pid);
        }
      }
    }
  }
  return out;
}

/** An IPv4 address as /proc/net/tcp writes it (the bytes in host order, little-endian here). */
function hexV4(addr: string): string | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (!m) return null;
  const b = m.slice(1).map(Number);
  if (b.some((x) => x > 255)) return null;
  return b.reverse().map((x) => x.toString(16).toUpperCase().padStart(2, "0")).join("");
}

const hexPort = (p: number) => p.toString(16).toUpperCase().padStart(4, "0");

/**
 * The inode of the one TCP connection whose local end is the peer's address and port and whose remote end is
 * kitespan's own 127.0.0.1:<serverPort> (the peer check, SERVER-B1 13 point 10), or null. An IPv4-mapped peer
 * (`::ffff:127.0.0.1`) is read from tcp6 too.
 */
export function connectionInode(r: ProcReader, peer: { address: string; port: number }, serverPort: number): string | null {
  const v4 = hexV4(peer.address.replace(/^::ffff:/i, ""));
  if (!v4) return null;
  const forms = [
    { file: "/proc/net/tcp", local: `${v4}:${hexPort(peer.port)}`, remote: `0100007F:${hexPort(serverPort)}` },
    { file: "/proc/net/tcp6", local: `0000000000000000FFFF0000${v4}:${hexPort(peer.port)}`, remote: `0000000000000000FFFF00000100007F:${hexPort(serverPort)}` },
  ];
  for (const form of forms) {
    const text = r.read(form.file)?.toString("utf8");
    if (!text) continue;
    for (const line of text.split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length >= 10 && f[1] === form.local && f[2] === form.remote && /^\d+$/.test(f[9]!) && f[9] !== "0") return f[9]!;
    }
  }
  return null;
}
