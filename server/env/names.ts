// D60 (build checklist E2, L40; R-env 5.3, 5.4): the names an environment's variables may not use and the limits.
// Names are compared after upper-casing both sides, as the SDK's own check does. Refused: what kitespan's clean start
// removes and its boot check refuses, the SDK's own names, the names that move Claude Code's own files, PATH, and git's
// folder names. Everything else is the user's, provider settings included. A refusal is a fixed code, never a value.

import { SDK_CHILD_ENV } from "../agents/claude/sdk-env";
import { CLEAN_ENV, type EnvVar } from "../agents/types";

export const ENV_LIMITS = {
  /** Variables per environment. */
  vars: 100,
  /** Characters of a name. */
  name: 128,
  /** Bytes of UTF-8 of one value. */
  valueBytes: 16_384,
  /** Bytes of the names and values of one environment. */
  totalBytes: 64 * 1024,
  /** The file `env/<project id>.json`, with JSON's escapes and the fields. */
  fileBytes: 160 * 1024,
  /** One save request (POST /api/projects/:project/env). */
  requestBytes: 160 * 1024,
} as const;

/** A name: start-env's pattern (bin/kitespan). */
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Why a name is refused, each with its own line on the page: `clean`, kitespan's clean start removes it; `files`, it
 * moves Claude Code's own files; `path`, PATH; `git`, it moves git's folders; `sdk`, the Agent SDK sets, reads or
 * removes it itself.
 */
export type EnvRefusal = "clean" | "files" | "path" | "git" | "sdk";

/**
 * A variable's problem, as the API names it (E5): a refusal, or `bad_name` (not a name), `too_long` (a name over 128
 * characters, a value over 16,384 bytes), `bad_char` (a value with NUL, CR or LF, or not text), `twice` (the same name
 * again), `too_many` and `too_big` (the whole environment over 100 variables or 64 KiB).
 */
export type EnvProblem = EnvRefusal | "bad_name" | "too_long" | "bad_char" | "twice" | "too_many" | "too_big";

const upper = (list: readonly string[]) => new Set(list.map((n) => n.toUpperCase()));
const CLEAN = upper([...CLEAN_ENV.always, ...CLEAN_ENV.desktopMarkers]);
const CLEAN_PREFIXES = CLEAN_ENV.alwaysPrefixes.map((p) => p.toUpperCase());
/** Claude Code's own list of names that choose where it keeps its files (settings reference), and every XDG_ name. */
const FILES = upper(["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_TMPDIR", "HOME", "TMPDIR", "TMP", "TEMP"]);
const FILE_PREFIXES = ["XDG_"];
/** L40: under kitespan's own worktrees the chat's git must be its folder's. */
const GIT = upper(["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]);
const SDK = upper([...SDK_CHILD_ENV.host, ...SDK_CHILD_ENV.added, ...SDK_CHILD_ENV.conditional, ...SDK_CHILD_ENV.removed, "DEBUG_CLAUDE_AGENT_SDK"]);

/** Why kitespan refuses `name` (compared without case), or null for a name the user may set. */
export function refusedName(name: string): EnvRefusal | null {
  const n = name.toUpperCase();
  if (CLEAN.has(n) || CLEAN_PREFIXES.some((p) => n.startsWith(p))) return "clean";
  if (FILES.has(n) || FILE_PREFIXES.some((p) => n.startsWith(p))) return "files";
  if (n === "PATH") return "path";
  if (GIT.has(n)) return "git";
  if (SDK.has(n)) return "sdk";
  return null;
}

/** A name's problem, or null. */
export function nameProblem(name: unknown): EnvProblem | null {
  if (typeof name !== "string" || !ENV_NAME_RE.test(name)) return "bad_name";
  if (name.length > ENV_LIMITS.name) return "too_long";
  return refusedName(name);
}

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/** A value's problem, or null: text of at most 16,384 bytes with no NUL, CR or LF (Desktop takes one line each). */
export function valueProblem(value: unknown): EnvProblem | null {
  if (typeof value !== "string" || /[\0\r\n]/.test(value) || !value.isWellFormed()) return "bad_char";
  if (bytes(value) > ENV_LIMITS.valueBytes) return "too_long";
  return null;
}

/** The whole environment's problem (its count, its size), or null. */
export function setProblem(vars: readonly EnvVar[]): EnvProblem | null {
  if (vars.length > ENV_LIMITS.vars) return "too_many";
  let total = 0;
  for (const v of vars) total += bytes(v.name) + bytes(v.value);
  return total > ENV_LIMITS.totalBytes ? "too_big" : null;
}
