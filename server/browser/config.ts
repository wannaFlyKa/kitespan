// The shared browser's program and port (DESIGN-B1 2.1, D-3): `$XDG_CONFIG_HOME/kitespan/browser.json`, which
// kitespan reads at boot and at every Start and never writes. It is checked as adapters.json is: a regular file of
// this user that no one else can write, at most 4 KiB, strict JSON with only known keys. A file that fails a check
// gives the defaults and one line for Settings > Browser (the file and the bad key). No key can add a flag to Chrome's
// command line.
//
//   { "v": 1, "chrome": "/usr/bin/google-chrome-stable", "port": 9340, "loopbackOnly": false }
//
// With no `chrome`, the first that exists of the user's own Chrome or Chromium on PATH, then the newest Chrome for
// Testing in the installers' caches. Before a start the binary's real path must be a regular, executable file owned by
// root or this user that no group or other user can write.

import { accessSync, closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export const BROWSER_FILE = "browser.json";
export const BROWSER_DEFAULT_PORT = 9340;
export const BROWSER_CONFIG_LIMITS = { fileBytes: 4 * 1024, path: 4096 } as const;

export interface BrowserConfig {
  /** browser.json's program (an absolute path), or null: the first one found on this host. */
  chrome: string | null;
  port: number;
  portFrom: "config" | "default";
  /** Chrome then also gets the flags that keep every request on this host (tests set it). */
  loopbackOnly: boolean;
  /** One line for Settings when the file failed a check (its defaults then apply), else null. */
  problem: string | null;
}

export const DEFAULT_BROWSER_CONFIG: Readonly<BrowserConfig> = { chrome: null, port: BROWSER_DEFAULT_PORT, portFrom: "default", loopbackOnly: false, problem: null };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The first key of a browser.json record that fails, or null. `refusedPorts`: kitespan's own port and the ports of its
 * allowed origins, which the browser's port may not take.
 */
export function browserConfigProblemKey(raw: unknown, refusedPorts: readonly number[]): string | null {
  if (!isObject(raw)) return "(the top level)";
  for (const key of Object.keys(raw)) if (!["v", "chrome", "port", "loopbackOnly"].includes(key)) return key;
  if (raw.v !== 1) return "v";
  if (raw.chrome !== undefined) {
    const c = raw.chrome;
    if (typeof c !== "string" || !isAbsolute(c) || c.length > BROWSER_CONFIG_LIMITS.path || /[\u0000-\u001f\u007f]/.test(c)) return "chrome";
  }
  if (raw.port !== undefined) {
    const p = raw.port;
    if (typeof p !== "number" || !Number.isInteger(p) || p < 1024 || p > 65535 || refusedPorts.includes(p)) return "port";
  }
  if (raw.loopbackOnly !== undefined && typeof raw.loopbackOnly !== "boolean") return "loopbackOnly";
  return null;
}

const problem = (file: string, what: string): BrowserConfig => ({ ...DEFAULT_BROWSER_CONFIG, problem: `${file}: ${what}, so kitespan uses its defaults.` });

/**
 * Read browser.json (an absolute path). A missing file gives the defaults with no line. The file is opened without
 * following a symbolic link, and its type, owner and mode are checked on the open file.
 */
export function readBrowserConfig(file: string, refusedPorts: readonly number[], uid: number | null = typeof process.getuid === "function" ? process.getuid() : null): BrowserConfig {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ...DEFAULT_BROWSER_CONFIG };
    if (code === "ELOOP") return problem(file, "the file is a symbolic link");
    return problem(file, "the file cannot be read");
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return problem(file, "the file is not a regular file");
    if (uid !== null && st.uid !== uid) return problem(file, "the file belongs to another user");
    if ((st.mode & 0o022) !== 0) return problem(file, "other users can change the file (chmod 600 it)");
    if (st.size > BROWSER_CONFIG_LIMITS.fileBytes) return problem(file, "the file is too large");
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, got);
      if (n === 0) break;
      got += n;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(buf.subarray(0, got).toString("utf8"));
    } catch {
      return problem(file, "the file is not JSON");
    }
    const key = browserConfigProblemKey(raw, refusedPorts);
    if (key !== null) return problem(file, `${key} is not valid`);
    const r = raw as { chrome?: string; port?: number; loopbackOnly?: boolean };
    return {
      chrome: r.chrome ?? null,
      port: r.port ?? BROWSER_DEFAULT_PORT,
      portFrom: r.port === undefined ? "default" : "config",
      loopbackOnly: r.loopbackOnly ?? false,
      problem: null,
    };
  } finally {
    closeSync(fd);
  }
}

/** Why a binary may not run, or null (SERVER-B1 2.1): its real path is a regular, executable file of root or this user, writable by no one else. */
export function binaryProblem(path: string, uid: number | null = typeof process.getuid === "function" ? process.getuid() : null): string | null {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return "missing";
  }
  let st;
  try {
    st = statSync(real);
  } catch {
    return "missing";
  }
  if (!st.isFile()) return "not_file";
  try {
    accessSync(real, constants.X_OK);
  } catch {
    return "not_executable";
  }
  if (uid !== null && st.uid !== 0 && st.uid !== uid) return "owner";
  if ((st.mode & 0o022) !== 0) return "writable";
  return null;
}

/** Newest first: the runs of digits in two paths compared as numbers. */
function byVersionDesc(a: string, b: string): number {
  const na = a.match(/\d+/g)?.map(Number) ?? [];
  const nb = b.match(/\d+/g)?.map(Number) ?? [];
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (nb[i] ?? -1) - (na[i] ?? -1);
    if (d) return d;
  }
  return b.localeCompare(a);
}

/** The program names looked for on PATH, the user's own browser first. */
export const BROWSER_NAMES = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "chrome"] as const;

/**
 * The places a browser is looked for, in order (SERVER-B1 2.1): each name on PATH, then the newest Chrome for Testing
 * in `~/.cache/puppeteer/chrome/` and `~/.cache/ms-playwright/`. `path` is the start environment's PATH.
 */
export function browserCandidates(path: string, home: string): string[] {
  const out: string[] = [];
  const dirs = path.split(delimiter).filter((d) => isAbsolute(d));
  for (const name of BROWSER_NAMES) for (const d of dirs) out.push(join(d, name));
  const caches: [string, string][] = [
    [join(home, ".cache", "puppeteer", "chrome"), "*/chrome-linux64/chrome"],
    [join(home, ".cache", "ms-playwright"), "chromium-*/chrome-linux64/chrome"],
  ];
  for (const [cwd, pattern] of caches) {
    let found: string[] = [];
    try {
      found = [...new Bun.Glob(pattern).scanSync({ cwd, onlyFiles: true, followSymlinks: false })].sort(byVersionDesc);
    } catch {
      found = [];
    }
    out.push(...found.map((f) => join(cwd, f)));
  }
  return out;
}

export type BinaryChoice = { path: string; from: "config" | "found" } | { path: null; from: null; reason: "none" | "bad_path"; tried: string | null };

/** The binary for the next start: browser.json's, which must pass its checks; else the first candidate that does. */
export function chooseBinary(config: Pick<BrowserConfig, "chrome">, path: string, home: string, uid?: number | null): BinaryChoice {
  if (config.chrome !== null) {
    return binaryProblem(config.chrome, uid) === null ? { path: config.chrome, from: "config" } : { path: null, from: null, reason: "bad_path", tried: config.chrome };
  }
  for (const c of browserCandidates(path, home)) if (binaryProblem(c, uid) === null) return { path: c, from: "found" };
  return { path: null, from: null, reason: "none", tried: null };
}
