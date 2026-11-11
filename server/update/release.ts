// The update of a kitespan that install.sh installed (DESIGN-I1 3.2 to 3.4): the release kind of server/update/kind.ts.
//
// The check, read only, as the setting Check for updates says (the same schedule, update.json and Check now as a
// checkout's): one read of the latest release's SHA256SUMS. With an absolute KITESPAN_INSTALL_FROM in the start
// environment (never process.env, a request or a setting, so no page can set it) that is the local file: the folder's
// SHA256SUMS, or for one named archive its own line in the SHA256SUMS beside it (install.sh installs that one only); a
// relative value fails the check with no read at all. Else one GET
// of RELEASES_URL/latest/download/SHA256SUMS: redirects followed by hand, at most 5, each to https only; the header
// user-agent: kitespan and no other of kitespan's (no version, no cookie, no authorization, no query); 10 s in all; at
// most SUMS_MAX_BYTES of the body (a larger one fails, as install.sh refuses it). The user's proxy variables apply: the
// read goes to the network on purpose, as a checkout's git does. "Update available" when the newest version listed is
// above both the running version and the version that `<kit>/current` names; never "diverged".
//
// The steps: the running version's own install.sh (one copy of the rules: `curl | sh`, `sh install.sh`, the Update
// button and bin/update.sh all run it), with no argument, in the data folder, stdin ignored, in a process group of its
// own with one deadline, its output in logs/update.log; its "Step <n> of 3, <name>: " lines are the job's steps. It
// switches `current` when every step finished, so the restart then starts the new version (preflight.ts). Its
// environment is the start environment without KITESPAN_VERSION (Update means the newest), with XDG_DATA_HOME set to
// the folder above this install's data folder, so it works on the install that runs.

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { archiveName, compareVersions, INSTALLER_FILE, newestInSums, RELEASE_VERSION, RELEASES_URL, SUMS_FILE, SUMS_MAX_BYTES } from "../../shared/release";
import { UPDATE_STEPS, type UpdateRefusal, type UpdateStep } from "../../shared/update";
import { currentVersion, nextRoot, type Install } from "./kind";
import { versionsLockHeld } from "./lock";
import type { RemoteCheck, RemoteKind } from "./remote";
import type { ApplyOptions, ApplyResult, UpdateSource } from "./source";
import { runStep, UPDATE_LIMITS, type StepOutput } from "./steps";

export type ReleaseInstall = Extract<Install, { kind: "release" }>;

/** A check's answer for a release install: RemoteCheck, with the newest version that SHA256SUMS listed. */
export type ReleaseCheck = RemoteCheck & { release?: string };

export const RELEASE_CHECK = {
  timeoutMs: 10_000,
  /** The most redirects that the read follows. */
  redirects: 5,
  userAgent: "kitespan",
} as const;

/** The latest release's SHA256SUMS. */
export const SUMS_URL = `${RELEASES_URL}/latest/download/${SUMS_FILE}`;

/** The start of a step's line of install.sh (DESIGN-I1 2.9). */
export const INSTALL_STEP_LINE = /^Step ([1-3]) of 3, (fetch|install|build): /;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** "available" when `latest` is above both the running version and the version that current names; else "none". */
export function releaseLine(latest: string, running: string, current: string | null): RemoteKind {
  let top = running;
  if (current !== null && RELEASE_VERSION.test(current) && compareVersions(current, top) > 0) top = current;
  return compareVersions(latest, top) > 0 ? "available" : "none";
}

const ARCHIVE_FILE = /^kitespan-(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.tar\.gz$/;

/**
 * The SHA256SUMS that KITESPAN_INSTALL_FROM names: the folder's own, or the one beside a kitespan-<x.y.z>.tar.gz file;
 * null for a relative value or anything else.
 */
export function localSums(from: string): string | null {
  if (!isAbsolute(from)) return null;
  try {
    const st = statSync(from);
    if (st.isDirectory()) return join(from, SUMS_FILE);
    if (st.isFile() && ARCHIVE_FILE.test(basename(from))) return join(dirname(from), SUMS_FILE);
  } catch {
    // not there
  }
  return null;
}

/**
 * The version of the one archive that KITESPAN_INSTALL_FROM names, or null (a folder, or anything else): install.sh
 * installs that archive and no other (DESIGN-I1 2.5), so the check offers no other version from the SHA256SUMS beside it.
 */
export function localArchiveVersion(from: string): string | null {
  if (!isAbsolute(from)) return null;
  const m = ARCHIVE_FILE.exec(basename(from));
  if (!m) return null;
  try {
    return statSync(from).isFile() ? `${m[1]}.${m[2]}.${m[3]}` : null;
  } catch {
    return null;
  }
}

/** A regular file's text, at most `max` bytes; null when it is not one, cannot be read or is larger. */
export function readSmall(file: string, max: number = SUMS_MAX_BYTES): string | null {
  let fd: number;
  try {
    // Non-blocking, so a FIFO in its place never holds the server up; then only a regular file is read.
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    if (!fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(max + 1);
    let n = 0;
    for (;;) {
      const got = readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
      if (n > max) return null;
    }
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** The body, at most `max` bytes; null past it (the read stops there). */
async function bodyOf(r: Response, max: number): Promise<string | null> {
  if (!r.body) return "";
  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > max) {
        await reader.cancel().catch(() => {});
        return null;
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(parts));
}

/**
 * GET of the latest release's SHA256SUMS: by hand through at most RELEASE_CHECK.redirects redirects, each to an https
 * URL; only kitespan's user-agent; RELEASE_CHECK.timeoutMs in all. The text, or null for any failure.
 */
export async function fetchSums(fetchFn: FetchLike = fetch, o: { url?: string; timeoutMs?: number; redirects?: number; max?: number } = {}): Promise<string | null> {
  const signal = AbortSignal.timeout(o.timeoutMs ?? RELEASE_CHECK.timeoutMs);
  const max = o.max ?? SUMS_MAX_BYTES;
  let url = o.url ?? SUMS_URL;
  try {
    for (let hop = 0; hop <= (o.redirects ?? RELEASE_CHECK.redirects); hop++) {
      if (new URL(url).protocol !== "https:") return null;
      const r = await fetchFn(url, { method: "GET", redirect: "manual", headers: { "user-agent": RELEASE_CHECK.userAgent }, signal });
      if (r.status >= 300 && r.status < 400) {
        await r.body?.cancel().catch(() => {});
        const to = r.headers.get("location");
        if (!to) return null;
        url = new URL(to, url).href;
        continue;
      }
      if (r.status < 200 || r.status >= 300) {
        await r.body?.cancel().catch(() => {});
        return null;
      }
      return await bodyOf(r, max);
    }
  } catch {
    return null;
  }
  return null;
}

export interface ReleaseChecker {
  /** One check: the read, then the line. */
  check(): Promise<ReleaseCheck>;
  /** The line again from the newest version that the last check read (update.json), with no read. */
  local(latest: string): ReleaseCheck;
}

export function releaseChecker(o: { install: ReleaseInstall; env: Readonly<Record<string, string | undefined>>; fetch?: FetchLike; timeoutMs?: number }): ReleaseChecker {
  const read = async (): Promise<string | null> => {
    const from = o.env.KITESPAN_INSTALL_FROM;
    if (from !== undefined && from !== "") {
      const file = localSums(from);
      const text = file ? readSmall(file) : null;
      // One named archive: only its own line counts (install.sh installs that version, whatever else the file lists).
      const only = localArchiveVersion(from);
      if (text === null || only === null) return text;
      const name = `  ${archiveName(only)}`;
      return text
        .split("\n")
        .filter((l) => (l.endsWith("\r") ? l.slice(0, -1) : l).endsWith(name))
        .join("\n");
    }
    return fetchSums(o.fetch ?? fetch, { timeoutMs: o.timeoutMs });
  };
  const local = (latest: string): ReleaseCheck =>
    RELEASE_VERSION.test(latest) ? { kind: releaseLine(latest, o.install.version, currentVersion(o.install)), failed: false, release: latest } : { kind: "none", failed: false };
  return {
    async check() {
      let text: string | null;
      try {
        text = await read();
      } catch {
        text = null;
      }
      const latest = text === null ? null : newestInSums(text);
      return latest ? local(latest) : { kind: "none", failed: true };
    },
    local,
  };
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/** The installer's environment: the start environment without KITESPAN_VERSION, XDG_DATA_HOME this install's. */
export function installerEnv(install: ReleaseInstall, env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && k !== "KITESPAN_VERSION") out[k] = v;
  out.XDG_DATA_HOME = dirname(install.kit);
  return out;
}

export interface ReleaseSourceOptions {
  install: ReleaseInstall;
  /** The build folder that the server serves (its --dist). */
  dist: string;
  dev: boolean;
  /** The start environment. */
  env: Readonly<Record<string, string | undefined>>;
  checker: ReleaseChecker;
  /** The shell that runs install.sh (tests); default /bin/sh. */
  sh?: string;
  limits?: Partial<typeof UPDATE_LIMITS>;
}

/** A release install as the update's source. */
export function releaseSource(o: ReleaseSourceOptions): UpdateSource {
  const lim = { ...UPDATE_LIMITS, ...o.limits };
  const { install } = o;

  async function refusal(): Promise<UpdateRefusal | null> {
    if (o.dev) return "dev";
    // The new version serves its own page: a --dist of another folder would keep the old one.
    if (real(o.dist) !== real(join(install.root, "dist", "web"))) return "dist";
    // A `curl | sh` or an `sh install.sh` runs now.
    if (versionsLockHeld(install.versions)) return "busy";
    return null;
  }

  async function apply(a: ApplyOptions): Promise<ApplyResult> {
    let last: UpdateStep = "fetch";
    a.onStep("fetch");
    const seen = (line: string) => {
      const m = INSTALL_STEP_LINE.exec(line);
      const step = m ? UPDATE_STEPS[Number(m[1]) - 1] : undefined;
      if (!m || step === undefined || step !== m[2]) return;
      last = step;
      a.onStep(step);
    };
    const sink = a.output;
    const output: StepOutput =
      sink === "inherit"
        ? "inherit"
        : {
            line(text) {
              seen(text);
              sink.line(text);
            },
          };
    const r = await runStep([o.sh ?? "/bin/sh", join(install.root, INSTALLER_FILE)], {
      cwd: install.kit,
      env: installerEnv(install, o.env),
      timeoutMs: lim.fetchMs + lim.installMs + lim.buildMs,
      output,
      signal: a.signal,
      onSpawn: a.onSpawn,
    });
    if (r.code === 0) {
      const t = nextRoot(install);
      if (t && isFile(join(t, "dist", "web", "index.html"))) return { ok: true, head: null };
    }
    return { ok: false, step: last, ...(r.timeout ? { timeout: true } : {}) };
  }

  return { check: () => o.checker.check(), refusal, apply };
}
