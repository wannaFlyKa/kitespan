// A fresh home for one run of install.sh (DESIGN-I1 2.15): a mkdtemp folder with the home itself (HOME, the XDG
// folders and TMPDIR inside it), a PATH folder that holds the fakes of test/install/fakes and links to the few system
// tools the installer uses (nothing else: no /usr/bin on PATH, so the real curl, wget and claude can never run, and a
// test leaves a tool out by naming it), a folder the fake curl and wget serve the releases from, and their log. The
// release archives are real tar.gz files made here, good ones and bad ones.

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { archiveName, RELEASES_URL } from "../../shared/release";

export const ROOT = resolve(import.meta.dir, "..", "..");
export const INSTALL = join(ROOT, "install.sh");
const FAKES = join(import.meta.dir, "fakes");
const FAKE_NAMES = ["bun", "claude", "curl", "ps", "uname", "wget"] as const;
/** The system tools on the test's PATH (install.sh's, the fakes' and GNU tar's gzip). */
const TOOLS = ["awk", "cat", "chmod", "cp", "dd", "gzip", "grep", "ln", "mkdir", "mv", "readlink", "rm", "rmdir", "sed", "sleep", "sort", "tail", "tar", "tr", "wc"];
/**
 * install.sh's hashers: it takes sha256sum, else shasum (`shasum -a 256`). A system may have one of them only (macOS
 * has shasum and no sha256sum), so each one that the system has goes on PATH, and at least one must.
 */
export const HASHERS = ["sha256sum", "shasum"] as const;

const made: string[] = [];
/** Removes every home made so far. Each test file that makes homes calls it in its own afterAll (Bun loads this module
 * once for all the files of a run, so a hook registered here would run for the first file only). */
export function removeHomes(): void {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** The system's own copy of a tool (in /usr/bin or /bin), or null. */
export function systemToolOrNull(name: string): string | null {
  for (const d of ["/usr/bin", "/bin"]) if (existsSync(join(d, name))) return join(d, name);
  return null;
}

function systemTool(name: string): string {
  const at = systemToolOrNull(name);
  if (at === null) throw new Error(`the system has no ${name}`);
  return at;
}

export interface Home {
  /** The mkdtemp folder (a real path) that holds everything below. */
  dir: string;
  home: string;
  /** The test's whole PATH: the fakes and the system tools. */
  bin: string;
  /** What the fake curl and wget serve: <serve>/<the URL's path under RELEASES_URL>. */
  serve: string;
  /** The fakes' log: one line per curl, wget or bun call. */
  log: string;
  kit: string;
  versions: string;
  current: string;
  bindir: string;
  link: string;
  state: string;
  config: string;
  /** The environment of a run: HOME, the XDG folders, TMPDIR, PATH and the fakes' variables. */
  env: Record<string, string>;
}

/** A fresh home. `omit` leaves fakes or system tools off PATH (for example ["claude"], or ["curl", "wget"]). */
export function makeHome(o: { omit?: string[] } = {}): Home {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kitespan-install-")));
  made.push(dir);
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  const serve = join(dir, "serve");
  for (const d of [home, bin, serve, join(home, "tmp")]) mkdirSync(d, { recursive: true });
  const omit = new Set(o.omit ?? []);
  for (const n of FAKE_NAMES) if (!omit.has(n)) symlinkSync(join(FAKES, n), join(bin, n));
  for (const n of TOOLS) if (!omit.has(n)) symlinkSync(systemTool(n), join(bin, n));
  const hashers = HASHERS.filter((n) => !omit.has(n));
  const found = hashers.flatMap((n) => {
    const at = systemToolOrNull(n);
    return at === null ? [] : [[n, at] as const];
  });
  if (hashers.length > 0 && found.length === 0) throw new Error(`the system has none of ${hashers.join(", ")}`);
  for (const [n, at] of found) symlinkSync(at, join(bin, n));
  const kit = join(home, ".local", "share", "kitespan");
  const env: Record<string, string> = {
    HOME: home,
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CONFIG_HOME: join(home, ".config"),
    TMPDIR: join(home, "tmp"),
    PATH: bin,
    LANG: "C",
    FAKE_LOG: join(dir, "log"),
    FAKE_SERVE: serve,
    FAKE_RELEASES: RELEASES_URL,
  };
  guardClaude(env.PATH!, bin);
  return {
    dir,
    home,
    bin,
    serve,
    log: join(dir, "log"),
    kit,
    versions: join(kit, "versions"),
    current: join(kit, "current"),
    bindir: join(home, ".local", "bin"),
    link: join(home, ".local", "bin", "kitespan"),
    state: join(home, ".local", "state", "kitespan"),
    config: join(home, ".config", "kitespan"),
    env,
  };
}

/** Throws unless the only claude on PATH is the fake one, or there is none: the real claude never runs here. */
export function guardClaude(path: string, bin: string): void {
  const found = Bun.which("claude", { PATH: path });
  if (found !== null && found !== join(bin, "claude")) throw new Error(`a claude other than the fake is on the test's PATH: ${found}`);
  if (found !== null && realpathSync(found) !== join(FAKES, "claude")) throw new Error("the fake claude is not test/install/fakes/claude");
}

export interface Run {
  code: number;
  out: string;
  err: string;
  /** stdout's lines. */
  lines: string[];
}

/** `sh install.sh <args>` in the home, with the home's environment and `env` on top (an undefined value unsets). */
export function install(h: Home, args: string[] = [], env: Record<string, string | undefined> = {}, script = INSTALL): Run {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...h.env, ...env })) if (v !== undefined) e[k] = v;
  guardClaude(e.PATH ?? "", h.bin);
  const r = Bun.spawnSync(["/bin/sh", script, ...args], { cwd: h.dir, env: e, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 120_000, killSignal: "SIGKILL" });
  const out = r.stdout.toString();
  return { code: r.exitCode ?? -1, out, err: r.stderr.toString(), lines: out.split("\n").filter(Boolean) };
}

/** The fakes' log lines. */
export function calls(h: Home): string[] {
  return existsSync(h.log) ? readFileSync(h.log, "utf8").split("\n").filter(Boolean) : [];
}

// ---------------------------------------------------------------------------------------------------------------
// Archives: ustar entries, gzip-compressed

export interface Entry {
  name: string;
  type?: "file" | "dir" | "symlink" | "fifo" | "pax";
  mode?: number;
  body?: string;
  /** A file of this many zero bytes (in place of body). */
  zeros?: number;
  /**
   * A sparse file of this size, in the PAX format 1.0 of GNU tar (and libarchive): a pax header with GNU.sparse.realsize,
   * then a member that stores only its map and one byte at the end. Its tar stream is small whatever the size.
   */
  sparse?: number;
  target?: string;
}

const TYPE = { file: "0", symlink: "2", dir: "5", fifo: "6", pax: "x" } as const;

/** A pax record: its own length in decimal, a space, key=value and a line end. */
function paxRecord(key: string, value: string): string {
  const rest = ` ${key}=${value}\n`;
  let n = rest.length + 1;
  while (`${n}${rest}`.length !== n) n = `${n}${rest}`.length;
  return `${n}${rest}`;
}

/** The entries of a sparse file (Entry.sparse): its pax header, then the member with the map and the last byte. */
function sparseParts(e: Entry, size: number): Entry[] {
  const at = e.name.lastIndexOf("/");
  const pax = [paxRecord("GNU.sparse.major", "1"), paxRecord("GNU.sparse.minor", "0"), paxRecord("GNU.sparse.name", e.name), paxRecord("GNU.sparse.realsize", String(size))].join("");
  const map = `1\n${size - 1}\n1\n`.padEnd(512, "\0");
  return [
    { name: `${e.name.slice(0, at + 1)}PaxHeaders/${e.name.slice(at + 1)}`, type: "pax", body: pax },
    { name: `${e.name.slice(0, at + 1)}GNUSparseFile.0/${e.name.slice(at + 1)}`, body: `${map}\0` },
  ];
}

function header(e: Entry, size: number): Uint8Array {
  const h = new Uint8Array(512);
  const enc = new TextEncoder();
  const put = (s: string, at: number, len: number) => h.set(enc.encode(s).subarray(0, len), at);
  const oct = (n: number, len: number) => `${n.toString(8).padStart(len - 1, "0")}\0`;
  let name = e.name;
  let prefix = "";
  if (enc.encode(name).length > 100) {
    const cut = name.lastIndexOf("/", name.length - 2);
    prefix = name.slice(0, cut);
    name = name.slice(cut + 1);
  }
  const type = e.type ?? "file";
  put(name, 0, 100);
  put(oct(e.mode ?? (type === "dir" ? 0o755 : 0o644), 8), 100, 8);
  put(oct(0, 8), 108, 8);
  put(oct(0, 8), 116, 8);
  put(oct(size, 12), 124, 12);
  put(oct(1_762_560_000, 12), 136, 12);
  put("        ", 148, 8);
  put(TYPE[type], 156, 1);
  put(e.target ?? "", 157, 100);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  put(prefix, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return h;
}

/** A .tar.gz of these entries, in this order. */
export function tarGz(entries: Entry[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: { head: Uint8Array; body: Uint8Array | number }[] = entries.flatMap((e) => (e.sparse === undefined ? [e] : sparseParts(e, e.sparse))).map((e) => {
    const body = e.zeros ?? (e.type === undefined || e.type === "file" || e.type === "pax" ? enc.encode(e.body ?? "") : new Uint8Array(0));
    return { head: header(e, typeof body === "number" ? body : body.length), body };
  });
  let total = 1024;
  for (const p of parts) {
    const n = typeof p.body === "number" ? p.body : p.body.length;
    total += 512 + Math.ceil(n / 512) * 512;
  }
  const tar = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    tar.set(p.head, at);
    at += 512;
    const n = typeof p.body === "number" ? p.body : p.body.length;
    if (typeof p.body !== "number") tar.set(p.body, at);
    at += Math.ceil(n / 512) * 512;
  }
  return Bun.gzipSync(tar, { level: 9 });
}

/** A good release tree for version v: its folders, package.json, install.sh and a bin/kitespan that says its version. */
export function releaseEntries(v: string, o: { top?: string; pkgVersion?: string; installer?: boolean } = {}): Entry[] {
  const top = o.top ?? `kitespan-${v}`;
  const entries: Entry[] = [
    { name: `${top}/`, type: "dir" },
    { name: `${top}/bin/`, type: "dir" },
    { name: `${top}/bin/kitespan`, mode: 0o755, body: `#!/bin/sh\nprintf 'kitespan ${v}\\n'\n` },
    { name: `${top}/package.json`, body: `{\n  "name": "kitespan",\n  "version": "${o.pkgVersion ?? v}",\n  "private": true\n}\n` },
    { name: `${top}/README.md`, body: "kitespan\n" },
  ];
  if (o.installer !== false) entries.push({ name: `${top}/install.sh`, mode: 0o755, body: "#!/bin/sh\n" });
  return entries;
}

export function sha256(data: Uint8Array | string): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

/** SHA256SUMS's text for these archives (and install.sh's line, as a release has it). */
export function sumsText(archives: { v: string; data: Uint8Array }[]): string {
  return `${archives.map((a) => `${sha256(a.data)}  ${archiveName(a.v)}\n`).join("")}${sha256("#!/bin/sh\n")}  install.sh\n`;
}

/** Serves a release the way GitHub does: download/v<v>/{archive, SHA256SUMS}, and latest/download/SHA256SUMS when `latest`. */
export function serveRelease(h: Home, v: string, data: Uint8Array, o: { latest?: boolean; sums?: string } = {}): void {
  const d = join(h.serve, "download", `v${v}`);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, archiveName(v)), data);
  const sums = o.sums ?? sumsText([{ v, data }]);
  writeFileSync(join(d, "SHA256SUMS"), sums);
  if (o.latest !== false) {
    mkdirSync(join(h.serve, "latest", "download"), { recursive: true });
    writeFileSync(join(h.serve, "latest", "download", "SHA256SUMS"), sums);
  }
}

/** A local release folder (KITESPAN_INSTALL_FROM) with these archives and one SHA256SUMS that lists them all. */
export function localRelease(h: Home, name: string, archives: { v: string; data: Uint8Array }[], sums?: string): string {
  const d = join(h.dir, name);
  mkdirSync(d, { recursive: true });
  for (const a of archives) writeFileSync(join(d, archiveName(a.v)), a.data);
  writeFileSync(join(d, "SHA256SUMS"), sums ?? sumsText(archives));
  return d;
}

/** A good archive of version v. */
export const good = (v: string) => ({ v, data: tarGz(releaseEntries(v)) });

// ---------------------------------------------------------------------------------------------------------------
// What a folder holds

/** Every path under `dir`, with its kind and mode; a link's target; a file's size and mtime. */
export function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let names: string[];
    try {
      names = readdirSync(d).sort();
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(d, n);
      const st = lstatSync(p);
      const rel = p.slice(dir.length + 1);
      const mode = (st.mode & 0o7777).toString(8);
      if (st.isSymbolicLink()) out.push(`${rel} link ${mode} -> ${readlinkSync(p)} ${st.mtimeMs}`);
      else if (st.isDirectory()) {
        out.push(`${rel} dir ${mode}`);
        walk(p);
      } else out.push(`${rel} file ${mode} ${st.size} ${st.mtimeMs}`);
    }
  };
  walk(dir);
  return out;
}
