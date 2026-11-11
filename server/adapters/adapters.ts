// The adapter layer (DESIGN.md 4.8): generic code with a public default, and local values from the user's own
// `$XDG_CONFIG_HOME/kitespan/adapters.json`, which kitespan never writes. The file must be a regular file of this user
// that no one else can write. The file and every value are checked against a strict schema at boot; a file that
// fails makes the server use the public defaults and gives one line (the file and the bad key) for Settings.
//
// Adapters decide only who may reach kitespan and what help text it shows: no adapter adds anything to a chat.

import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { CONTROL_CHARS } from "../../shared/protocol";

export const ADAPTERS_FILE = "adapters.json";

/** Design values: enough for a few forwards and a short note, small enough to show in full. */
export const ADAPTER_LIMITS = { fileBytes: 64 * 1024, origins: 20, origin: 255, hint: 2_000, noteLines: 20, noteLine: 300, phoneLink: 300 } as const;

export interface Adapters {
  /** The access adapter's exact origins (the server's own loopback origin is not listed here). */
  origins: string[];
  /** The owner's own line about how to reach kitespan, or null for the public hint. */
  hint: string | null;
  /** The phone-browser notes for Settings > About: the public default's one line, or the owner's own lines. */
  phoneNotes: string[];
  /**
   * T-14 (owner question Q11): the form of a link that opens a URL in the owner's own phone browser, with one `{url}`
   * that Open on phone fills with the encoded link; null for the public default, whose code holds the plain link.
   */
  phoneLink: string | null;
  /** One line for Settings when the file failed a check (the defaults apply then), else null. */
  problem: string | null;
}

/** T-23: the public default's note, for a phone's own browser. The owner's own notes replace it (adapters.json). */
export const PUBLIC_PHONE_NOTE = "In your phone's browser, Add to Home Screen gives kitespan a window of its own and notifications.";

export const PUBLIC_ADAPTERS: Readonly<Adapters> = { origins: [], hint: null, phoneNotes: [PUBLIC_PHONE_NOTE], phoneLink: null, problem: null };

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOST_NAME = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);

/**
 * An exact origin (4.8 rules): `https://` and a host name (a port may follow), with no path, no wildcard, no leading
 * dot and no user part; `http://` only for a loopback host. The string must already be the origin's canonical form.
 */
export function isExactOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > ADAPTER_LIMITS.origin) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.origin !== value) return false;
  if (url.protocol === "http:") return LOOPBACK_HOSTS.has(url.hostname);
  return url.protocol === "https:" && (HOST_NAME.test(url.hostname) || url.hostname === "[::1]");
}

/** Text that may be printed in the terminal and shown on the page: no control character but the line break. */
function cleanText(v: unknown, max: number): v is string {
  return typeof v === "string" && v.length <= max && !CONTROL_CHARS.test(v.replace(/\n/g, ""));
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The one placeholder of `access.phoneLink`, which Open on phone fills with the encoded link. */
export const PHONE_LINK_SLOT = "{url}";
/** Schemes that run or read where they open: a link form never has one, filled or not. */
const REFUSED_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:"]);

/**
 * `access.phoneLink`: at most 300 characters with no control character and exactly one `{url}`, and filled with an
 * encoded link it parses as a URL whose scheme is not one of REFUSED_SCHEMES.
 */
export function isPhoneLink(v: unknown): v is string {
  if (typeof v !== "string" || v.length > ADAPTER_LIMITS.phoneLink || CONTROL_CHARS.test(v) || v.split(PHONE_LINK_SLOT).length !== 2) return false;
  let url: URL;
  try {
    url = new URL(v.replace(PHONE_LINK_SLOT, encodeURIComponent("https://kitespan.invalid/c/x")));
  } catch {
    return false;
  }
  return !REFUSED_SCHEMES.has(url.protocol);
}

/** The first key that fails the schema, or null when the whole record passes. */
export function adaptersProblemKey(raw: unknown): string | null {
  if (!isObject(raw)) return "(the top level)";
  for (const key of Object.keys(raw)) if (!["v", "access", "phoneNotes"].includes(key)) return key;
  if (raw.v !== 1) return "v";
  if (raw.access !== undefined) {
    const a = raw.access;
    if (!isObject(a)) return "access";
    for (const key of Object.keys(a)) if (!["origins", "hint", "phoneLink"].includes(key)) return `access.${key}`;
    if (a.origins !== undefined) {
      if (!Array.isArray(a.origins) || a.origins.length > ADAPTER_LIMITS.origins) return "access.origins";
      const bad = a.origins.findIndex((o) => !isExactOrigin(o));
      if (bad >= 0) return `access.origins[${bad}]`;
    }
    if (a.hint !== undefined && !cleanText(a.hint, ADAPTER_LIMITS.hint)) return "access.hint";
    if (a.phoneLink !== undefined && !isPhoneLink(a.phoneLink)) return "access.phoneLink";
  }
  if (raw.phoneNotes !== undefined) {
    const p = raw.phoneNotes;
    if (!isObject(p)) return "phoneNotes";
    for (const key of Object.keys(p)) if (key !== "lines") return `phoneNotes.${key}`;
    if (p.lines !== undefined) {
      if (!Array.isArray(p.lines) || p.lines.length > ADAPTER_LIMITS.noteLines) return "phoneNotes.lines";
      const bad = p.lines.findIndex((l) => !cleanText(l, ADAPTER_LIMITS.noteLine) || l.includes("\n"));
      if (bad >= 0) return `phoneNotes.lines[${bad}]`;
    }
  }
  return null;
}

/** The adapters of a record that passed `adaptersProblemKey`: a key the file leaves out keeps its public default. */
function fromRecord(raw: Record<string, unknown>): Adapters {
  const access = (raw.access ?? {}) as { origins?: string[]; hint?: string; phoneLink?: string };
  const notes = (raw.phoneNotes ?? {}) as { lines?: string[] };
  return { origins: [...new Set(access.origins ?? [])], hint: access.hint ?? null, phoneNotes: notes.lines ?? [...PUBLIC_ADAPTERS.phoneNotes], phoneLink: access.phoneLink ?? null, problem: null };
}

const problem = (file: string, what: string): Adapters => ({
  ...PUBLIC_ADAPTERS,
  problem: `${file}: ${what}, so kitespan uses its defaults.`,
});

/**
 * Read the adapters from `file` (an absolute path). A missing file gives the public defaults with no line. The file
 * is opened without following a symbolic link, and its type, owner and mode are checked on the open file.
 */
export function readAdapters(file: string, uid: number | null = typeof process.getuid === "function" ? process.getuid() : null): Adapters {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ...PUBLIC_ADAPTERS };
    if (code === "ELOOP") return problem(file, "the file is a symbolic link");
    return problem(file, "the file cannot be read");
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return problem(file, "the file is not a regular file");
    if (uid !== null && st.uid !== uid) return problem(file, "the file belongs to another user");
    if ((st.mode & 0o022) !== 0) return problem(file, "other users can change the file (chmod 600 it)");
    if (st.size > ADAPTER_LIMITS.fileBytes) return problem(file, "the file is too large");
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
    const key = adaptersProblemKey(raw);
    if (key !== null) return problem(file, `${key} is not valid`);
    return fromRecord(raw as Record<string, unknown>);
  } finally {
    closeSync(fd);
  }
}

/**
 * The remote-access disclaimer (row 104; launch/PLAN.md L12): the same sentence in the README, SECURITY.md and the
 * start output, where it shows once when an origin beyond the machine's own is allowed. The page has none.
 */
export const NO_SIGN_IN =
  "kitespan has no sign-in in this release: anyone who can open its page can run Claude Code as you, and you are responsible for how you connect it from another device.";

/** Where an allowed origin came from: `bin/kitespan --origin` (until kitespan stops) or the access adapter's file. */
export type OriginSource = "--origin" | typeof ADAPTERS_FILE;
export interface AllowedOrigin {
  origin: string;
  from: OriginSource[];
}

/**
 * Why a `--origin` value is refused, or null for an exact origin: the access adapter's own rule (isExactOrigin), so the
 * flag and the file never differ. The value is printed back only when it holds no control character and fits the
 * limit, so a terminal never gets escape codes from it.
 */
export function originFlagProblem(value: string): string | null {
  if (value === "") return "--origin needs a value";
  if (value.length > ADAPTER_LIMITS.origin || CONTROL_CHARS.test(value)) return `--origin takes an exact origin of at most ${ADAPTER_LIMITS.origin} characters`;
  if (isExactOrigin(value)) return null;
  let url: URL | null = null;
  try {
    url = new URL(value);
  } catch {}
  if (url?.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) return `--origin ${value}: http:// is only for 127.0.0.1, localhost or [::1]; use https://`;
  if (url && isExactOrigin(url.origin)) return `--origin ${value}: give the origin only, ${url.origin}`;
  return `--origin ${value}: not an exact origin (https://, a full host name and an optional port)`;
}

/**
 * The origins in force beyond kitespan's own three loopback origins on its port (createGate allows those always): the
 * flag's first, in the order given, then the file's, each once with every source it came from.
 */
export function allowedOrigins(port: number, flag: readonly string[], file: readonly string[]): AllowedOrigin[] {
  const own = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]);
  const found = new Map<string, OriginSource[]>();
  const add = (origin: string, from: OriginSource) => {
    if (own.has(origin)) return;
    const seen = found.get(origin);
    if (!seen) found.set(origin, [from]);
    else if (!seen.includes(from)) seen.push(from);
  };
  for (const o of flag) add(o, "--origin");
  for (const o of file) add(o, ADAPTERS_FILE);
  return [...found].map(([origin, from]) => ({ origin, from }));
}

/**
 * The lines the server prints at boot about how to reach it (4.8, the access hint). With origins beyond the
 * machine's own, one line lists them with their sources, then the disclaimer; else the public hint gives the `ssh -L`
 * way in and the public products. The owner's own hint replaces the public hint. `toFile`: the lines go to a file (a
 * restart's successor prints into logs/server-out.log), where `--origin`'s own values are counted, never named: the
 * flag's origins are never written anywhere (row 104's lead note). An origin of adapters.json is named all the same.
 */
export function accessHint(
  port: number,
  adapters: Pick<Adapters, "hint" | "origins">,
  allowed: readonly AllowedOrigin[] = allowedOrigins(port, [], adapters.origins),
  opts: { toFile?: boolean } = {},
): string[] {
  const own = `http://127.0.0.1:${port}`;
  const lines = [`kitespan listens on ${own}`];
  const unnamed = opts.toFile ? allowed.filter((a) => !a.from.includes(ADAPTERS_FILE)).length : 0;
  const named = allowed.filter((a) => !opts.toFile || a.from.includes(ADAPTERS_FILE)).map((a) => `${a.origin} (${a.from.join(", ")})`);
  if (unnamed) named.unshift(`${unnamed} origin${unnamed === 1 ? "" : "s"} from --origin`);
  if (allowed.length) lines.push(`Also allowed: ${named.join(", ")}`, NO_SIGN_IN);
  if (adapters.hint !== null) return [...lines, ...adapters.hint.split("\n")];
  if (allowed.length) return lines;
  return [
    ...lines,
    `From another device: ssh -L ${port}:127.0.0.1:${port} <this host>, then open ${own} there. Other ways in: Tailscale Serve, Cloudflare Tunnel with Access, a reverse proxy.`,
    `The browser must open kitespan on port ${port} of 127.0.0.1, localhost or [::1]; any other origin gets 403 unless --origin or access.origins in ${ADAPTERS_FILE} allows it.`,
  ];
}
