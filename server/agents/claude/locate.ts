// The binary pin (DESIGN.md 4.7, D18): the claude on the user's PATH only, the one the terminal runs, with no
// fallback. A candidate inside node_modules (its path or its real path) is refused, and then no later PATH entry is
// tried. The SDK's platform packages (its bundled claude) must not be installed anywhere in the install tree. The
// pin runs again for every probe and every chat start, so an install or an upgrade shows without a restart.

import { accessSync, constants, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type { ClaudeBelow } from "../../../shared/protocol";
import type { BinaryProbe } from "../types";
import { atLeast, CLAUDE_CODE_MINIMUM } from "./background";

/** The repository root: where package.json and node_modules are. */
export const INSTALL_ROOT = resolve(import.meta.dir, "..", "..", "..");

/** The CLI version that SDK 0.3.322 names (`claudeCodeVersion` in its package.json), when that file cannot be read. */
export const PINNED_CLAUDE_CODE_VERSION = "2.1.322";

const NODE_MODULES_RE = /(^|\/)node_modules(\/|$)/;
const PLATFORM_PREFIX = "claude-agent-sdk-";

/** The pin's answer without the version (no process started): what open() checks before every start. */
export interface Pin {
  ok: boolean;
  path: string | null;
  realpath: string | null;
  refused: BinaryProbe["refused"];
  platformPackages: string[];
}

export interface PinOptions {
  /** The PATH to search; the server's own PATH when absent. */
  pathEnv?: string;
  /** Where the platform-package scan starts; the repository root when absent. */
  installRoot?: string;
}

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The SDK platform packages in the install tree: under `node_modules/@anthropic-ai/`, under `node_modules/.bun/` (the
 * layout of `bun install --linker isolated`), and in every parent folder's `node_modules`.
 */
export function findPlatformPackages(installRoot: string = INSTALL_ROOT): string[] {
  const found: string[] = [];
  let dir = resolve(installRoot);
  for (;;) {
    const nm = join(dir, "node_modules");
    const scoped = join(nm, "@anthropic-ai");
    try {
      for (const n of readdirSync(scoped)) if (n.startsWith(PLATFORM_PREFIX)) found.push(join(scoped, n));
    } catch {}
    const isolated = join(nm, ".bun");
    try {
      for (const n of readdirSync(isolated)) if (n.startsWith(`@anthropic-ai+${PLATFORM_PREFIX}`)) found.push(join(isolated, n));
    } catch {}
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return found;
}

/** The pin, without reading the version. */
export function pinSync(opts: PinOptions = {}): Pin {
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? "";
  const platformPackages = findPlatformPackages(opts.installRoot ?? INSTALL_ROOT);
  const refused: BinaryProbe["refused"] = [];
  const done = (path: string | null, real: string | null): Pin => ({
    ok: path !== null && platformPackages.length === 0,
    path,
    realpath: real,
    refused,
    platformPackages,
  });
  // A relative PATH entry is found from the server's own folder, but the SDK starts the claude in the chat's folder:
  // the pin holds the absolute path, so the start runs the file that the pin and `claude --version` checked.
  let here: string;
  try {
    here = realpathSync(".");
  } catch {
    here = process.cwd();
  }
  const absolute = (p: string) => (isAbsolute(p) ? p : resolve(here, p));
  // The first claude that the PATH lookup finds, as the terminal runs it (Bun.which skips what it cannot run).
  const which = Bun.which("claude", { PATH: pathEnv });
  const found = which ? absolute(which) : null;
  if (!found) {
    // Say why when a claude is there but cannot run; nothing on PATH means nothing to report.
    for (const d of pathEnv.split(delimiter)) {
      if (!d) continue;
      const p = absolute(join(d, "claude"));
      if (existsSync(p)) {
        refused.push({ path: p, reason: "not-executable" });
        break;
      }
    }
    return done(null, null);
  }
  let real: string;
  try {
    real = realpathSync(found);
  } catch {
    refused.push({ path: found, reason: "missing" });
    return done(null, null);
  }
  if (!isExecutableFile(real)) {
    refused.push({ path: found, reason: "not-executable" });
    return done(null, null);
  }
  if (NODE_MODULES_RE.test(found) || NODE_MODULES_RE.test(real)) {
    // No fallback: a later PATH entry would be a different claude than the one the terminal runs.
    refused.push({ path: found, reason: "inside-node_modules" });
    return done(null, null);
  }
  return done(found, real);
}

let sdkCliVersion: string | null = null;
/** `claudeCodeVersion` from the installed SDK's package.json. */
export function sdkClaudeCodeVersion(): string {
  if (sdkCliVersion) return sdkCliVersion;
  try {
    const entry = Bun.resolveSync("@anthropic-ai/claude-agent-sdk", import.meta.dir);
    const pkg = JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8")) as { claudeCodeVersion?: unknown };
    sdkCliVersion = typeof pkg.claudeCodeVersion === "string" ? pkg.claudeCodeVersion : PINNED_CLAUDE_CODE_VERSION;
  } catch {
    sdkCliVersion = PINNED_CLAUDE_CODE_VERSION;
  }
  return sdkCliVersion;
}

/** `<binary> --version` (no model call), its first line, or null after `timeoutMs` or on any failure. */
export async function readVersion(path: string, timeoutMs = 15_000): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Its own process group, so the timeout also ends a child that would keep the pipe open. Only while the binary
    // has not been reaped: until then its pid, and the group of that id, cannot name another process.
    const proc = Bun.spawn([path, "--version"], { stdin: "ignore", stdout: "pipe", stderr: "ignore", detached: true });
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) {
          try {
            process.kill(-proc.pid, "SIGKILL");
          } catch {}
        }
        resolve(null);
      }, timeoutMs);
    });
    const read = Promise.all([new Response(proc.stdout).text(), proc.exited]).then(([out, code]) => {
      if (code !== 0) return null;
      return out.trim().split("\n")[0]?.trim().slice(0, 80) || null;
    });
    return await Promise.race([read, deadline]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The drift line of 4.10 when the CLI's version differs from the one the pinned SDK names, else null. A company's own
 * build adds its numbers after Claude Code's three (2.1.317.1, 2.1.317-acme.2; row 119): the line shows them, and only
 * the first three are compared.
 */
export function driftLine(version: string | null, sdkNames: string = sdkClaudeCodeVersion()): string | null {
  const m = version?.match(/(\d+\.\d+\.\d+)[^\s()]*/);
  if (!m || m[1] === sdkNames) return null;
  return `Claude Code ${m[0]} runs here; this SDK was built for ${sdkNames}.`;
}

/**
 * The minimum version's facts (rows 118, 119) when the CLI is older than `minimum` on its first three numbers, else
 * null; null too when the version cannot be read (it never blocks a chat). The version as the drift line shows it, up
 * to a space or a parenthesis; `stock` when it is exactly three numbers (Claude Code's own build).
 */
export function belowMinimum(version: string | null, minimum: string = CLAUDE_CODE_MINIMUM): ClaudeBelow | null {
  const m = version?.match(/(\d+\.\d+\.\d+)[^\s()]*/);
  if (!m || atLeast(m[1]!, minimum) !== false) return null;
  return { version: m[0], minimum, stock: m[0] === m[1] };
}

/** The whole probe: the pin, the platform-package scan and the version. */
export async function probeBinary(opts: PinOptions & { versionTimeoutMs?: number } = {}): Promise<BinaryProbe> {
  const pin = pinSync(opts);
  const version = pin.path ? await readVersion(pin.path, opts.versionTimeoutMs) : null;
  return {
    ok: pin.ok,
    path: pin.path,
    realpath: pin.realpath,
    version,
    source: "path",
    refused: pin.refused,
    platformPackages: pin.platformPackages,
    drift: pin.path ? driftLine(version) : null,
    belowMinimum: pin.path ? belowMinimum(version) : null,
  };
}
