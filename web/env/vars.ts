// D60 on the page, the parts without React: the words, the KEY=value field's reading (each line's problem named before
// Save), the page's copy of the names the server refuses, and the API calls. The page never holds a saved value: the
// API answers names only (GET and POST /api/projects/:project/env, E5), a typed value lives only in the open field's
// own state until Save sends it (once, in the POST's body), and nothing here writes local storage or a URL.
//
// The server checks everything again (E2); this file names a line's problem early. The refused names are the
// server's list (E2): kitespan's clean start, the Agent SDK's own names, the names that move Claude Code's files,
// PATH and git's folder names (L40), compared after upper-casing both sides.

import { ERROR_MESSAGES } from "../../shared/protocol";
import { ApiError, apiGet, apiSend } from "../net/api";

/** Desktop's words (DESIGN 6.12) and kitespan's own for the rest (EN 5.3, 5.7, 5.10, 5.11). */
export const ENV_WORDS = {
  title: "Environment variables",
  none: "None for this environment",
  /** One fixed mask for every value: no length, no last characters. */
  mask: "••••••••",
  add: "Add variables",
  /** The KEY=value field's placeholder and accessible name. */
  field: "One KEY=value per line",
  newValue: "New value",
  edit: "Edit",
  remove: "Remove",
  save: "Save",
  cancel: "Cancel",
  done: "Done",
  replaces: "Replaces the saved value",
  running: "Chats get these the next time their Claude Code starts. A chat that runs now keeps the values it started with.",
  /** L39: the server's own sentence for it (the chat's line and the editor's). */
  unreadable: ERROR_MESSAGES.env_unreadable,
  /** L39: the project page's and New environment's cell while the file cannot be read (its link opens the editor). */
  unreadableCell: "Could not be read",
  removeUnreadable: "Remove the unreadable file",
  /** The unreadable file's Remove asks in place, as a variable's does. */
  discardAsk: "Remove the unreadable file? This environment's chats then start without its variables.",
  /** The copy dialog's line (6.10): a terminal of the user's own does not get them. */
  terminal: "A terminal of your own does not have this environment's variables.",
  notSaved: "The variables were not saved.",
} as const;

export const removeAsk = (name: string) => `Remove ${name}? Chats stop getting it from their next start.`;
export const inSettingsLine = (name: string) => `Your Claude Code settings set ${name} too, and their value wins.`;
export const countWords = (n: number) => (n === 1 ? "1 variable" : `${n} variables`);
/** The summary of an environment's variables: Desktop's "None for this environment", or the count. */
export const envSummary = (n: number | undefined) => (n ? countWords(n) : ENV_WORDS.none);
/** A project's Environment variables cell: the summary, or "Could not be read" while its file cannot be (L39). */
export const envCell = (p: { env?: number; envUnreadable?: boolean }) => (p.envUnreadable ? ENV_WORDS.unreadableCell : envSummary(p.env));

/** E2's limits. */
export const ENV_LIMITS = { count: 100, name: 128, valueBytes: 16_384, totalBytes: 64 * 1024 } as const;

/** A variable as the API names it: never its value or its length (E5). */
export interface EnvVarView {
  name: string;
  /** When it was saved (ISO 8601 UTC). */
  at: string;
  /** The user's Claude Code settings `env` sets the same name, and that value wins (EN 3). */
  inSettings: boolean;
}

/** GET /api/projects/:project/env, and the POST's answer. */
export interface EnvReply {
  vars: EnvVarView[];
  /** The environment's file could not be read: its chats do not start (L39). */
  unreadable: boolean;
}

/** POST /api/projects/:project/env: checked whole, nothing written on any problem. */
export interface EnvChange {
  set: { name: string; value: string }[];
  remove: string[];
  /** Remove the unreadable file (with or without new variables). */
  discardUnreadable?: true;
}

/** A refused POST's lines: `i` is the index in `set`, `why` a fixed code, never the value. */
export interface EnvLineError {
  i: number;
  why: string;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ---- the names kitespan refuses (E2), with the line each kind shows (EN 5.3)

/** The clean start removes these, and the boot refuses them (server/agents/types.ts CLEAN_ENV). */
export const CLEAN_NAMES = [
  "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_PID", "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_EFFORT", "CLAUDE_CODE_ENTRYPOINT", "AI_AGENT",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "CLAUDE_CODE_HOST_AUTH_ENV_VAR", "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
] as const;
export const CLEAN_PREFIXES = ["CLAUDE_CODE_MESSAGING_"] as const;
/** The Agent SDK sets, reads or removes these for its own protocol (server/agents/claude/options.ts SDK_CHILD_ENV). */
export const SDK_NAMES = [
  "NODEFAULTCURRENTDIRECTORYINEXEPATH", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_SDK_READS_SESSION_STATE",
  "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING", "CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH", "CLAUDE_CODE_QUESTION_PREVIEW_FORMAT",
  "CLAUDE_CODE_QUESTION_EXTENDED", "CLAUDE_CODE_QUESTION_OPTIONAL_DESCRIPTIONS", "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  "TRACEPARENT", "TRACESTATE", "DEBUG", "CLAUDE_CODE_SDK_READS_STARTUP_MARKS", "NODE_OPTIONS",
  "CLAUDE_CODE_AGENT_PROGRESS_SUMMARIES", "DEBUG_CLAUDE_AGENT_SDK",
] as const;
/** Claude Code's own list of names that move its files (settings-reference), and every XDG_ name. */
export const FILE_NAMES = ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_TMPDIR", "HOME", "TMPDIR", "TMP", "TEMP"] as const;
export const FILE_PREFIXES = ["XDG_"] as const;
/** L40: under W-host the chat's git must be its worktree's. */
export const GIT_NAMES = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"] as const;

export type RefusedKind = "clean" | "sdk" | "files" | "path" | "git";

/** Why kitespan refuses a name, compared without case, or null for a name it takes. */
export function refusedKind(name: string): RefusedKind | null {
  const n = name.toUpperCase();
  const has = (list: readonly string[]) => list.includes(n);
  const starts = (list: readonly string[]) => list.some((p) => n.startsWith(p));
  if (has(CLEAN_NAMES) || starts(CLEAN_PREFIXES)) return "clean";
  if (has(FILE_NAMES) || starts(FILE_PREFIXES)) return "files";
  if (n === "PATH") return "path";
  if (has(GIT_NAMES)) return "git";
  if (has(SDK_NAMES)) return "sdk";
  return null;
}

/** The line of a refused name: where to set it instead (EN 5.3; L40's is kitespan's own). */
export function refusedLine(kind: RefusedKind, name: string): string {
  switch (kind) {
    case "clean":
      return `kitespan removes ${name} when it starts, so it cannot be set here.`;
    case "sdk":
      return `The Agent SDK sets or removes ${name} itself.`;
    case "files":
      return `${name} moves Claude Code's own files. Set it in your start-env file, then restart kitespan.`;
    case "path":
      return "Set PATH in your shell profile or your start-env file, then restart kitespan.";
    case "git":
      return `${name} would point git away from the chat's folder, so it cannot be set here.`;
  }
}

/** The lines of the field's other problems. A line is named by its number, never by its text: it may hold a value. */
export const PROBLEM = {
  noEquals: "No = on this line.",
  badName: "A name holds letters, digits and _ only, and does not start with a digit.",
  tooLong: "Too long.",
  twice: (name: string) => `${name} is twice.`,
  badChar: "A value cannot hold a line end or a NUL character.",
  tooMany: `An environment holds at most ${ENV_LIMITS.count} variables.`,
  tooBig: "These values are more than one environment holds (64 KB).",
  server: "kitespan cannot save this line.",
} as const;

/** The line of a code that the server's POST names for a line (E5); an unknown code reads as PROBLEM.server. */
export function serverLine(why: string, name: string): string {
  switch (why) {
    case "no_equals":
      return PROBLEM.noEquals;
    case "bad_name":
    case "name":
      return PROBLEM.badName;
    case "too_long":
    case "long":
      return PROBLEM.tooLong;
    case "twice":
    case "repeat":
      return PROBLEM.twice(name);
    case "bad_char":
    case "control":
      return PROBLEM.badChar;
    case "too_many":
      return PROBLEM.tooMany;
    case "too_big":
      return PROBLEM.tooBig;
    case "clean":
    case "sdk":
    case "files":
    case "path":
    case "git":
      return refusedLine(why, name);
    default: {
      const kind = refusedKind(name);
      return kind ? refusedLine(kind, name) : PROBLEM.server;
    }
  }
}

// ---- the KEY=value field

export interface FieldLine {
  /** The line's number in the field, from 1. */
  n: number;
  /** The name as typed (empty when the line has no `=`). */
  name: string;
  /** Its problem, or null. */
  problem: string | null;
  /** The name is saved already: Save replaces its value. */
  replaces: boolean;
}

export interface FieldRead {
  /** Every line that is not blank and not a comment, in order. */
  lines: FieldLine[];
  /** What Save sends, in the user's order: only when no line has a problem. */
  set: { name: string; value: string }[];
  /** The field's own problem (the count, the size), beside the lines'. */
  problem: string | null;
  /** True when Save may send: some line, and no problem. */
  ok: boolean;
}

const bytes = (s: string) => new TextEncoder().encode(s).length;
/** A value the server refuses as `bad_char` (E2): NUL, CR or LF, or text that is not well formed (a lone surrogate). */
function badChars(value: string): boolean {
  if (/[\0\r\n]/.test(value)) return true;
  const wf = (value as { isWellFormed?: () => boolean }).isWellFormed;
  return typeof wf === "function" ? !wf.call(value) : false;
}

/**
 * Read the KEY=value field: one variable per line, split at the first `=`, blank lines and `#` lines skipped. The
 * name is trimmed; the value is kept as typed (Claude Code takes values literally), less a pasted line end. `saved`:
 * the names the environment has, so a line marks that it replaces one, and the count stays under the limit.
 */
export function readField(text: string, saved: readonly string[] = []): FieldRead {
  const lines: FieldLine[] = [];
  const set: { name: string; value: string }[] = [];
  const seen = new Set<string>();
  const savedSet = new Set(saved);
  let total = 0;
  text.split("\n").forEach((raw, idx) => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line.trim() || line.trimStart().startsWith("#")) return;
    const n = idx + 1;
    const eq = line.indexOf("=");
    if (eq < 0) {
      lines.push({ n, name: "", problem: PROBLEM.noEquals, replaces: false });
      return;
    }
    const name = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    let problem: string | null = null;
    if (!NAME.test(name)) problem = name.length > ENV_LIMITS.name ? PROBLEM.tooLong : PROBLEM.badName;
    else if (name.length > ENV_LIMITS.name) problem = PROBLEM.tooLong;
    else if (seen.has(name)) problem = PROBLEM.twice(name);
    else {
      const kind = refusedKind(name);
      if (kind) problem = refusedLine(kind, name);
      else if (badChars(value)) problem = PROBLEM.badChar;
      else if (bytes(value) > ENV_LIMITS.valueBytes) problem = PROBLEM.tooLong;
    }
    // A bad name is not shown back: it may be a value pasted on its own (a token with an "=" in it).
    const shown = NAME.test(name) && name.length <= ENV_LIMITS.name ? name : "";
    lines.push({ n, name: shown, problem, replaces: problem === null && savedSet.has(name) });
    if (shown) seen.add(name);
    if (problem === null) {
      set.push({ name, value });
      total += bytes(name) + bytes(value);
    }
  });
  const added = set.filter((v) => !savedSet.has(v.name)).length;
  const problem = savedSet.size + added > ENV_LIMITS.count ? PROBLEM.tooMany : total > ENV_LIMITS.totalBytes ? PROBLEM.tooBig : null;
  const ok = lines.length > 0 && problem === null && lines.every((l) => l.problem === null);
  return { lines, set: ok ? set : [], problem, ok };
}

/** One value for Edit's "New value" field: its problem, or null (the name is a saved one). */
export function valueProblem(value: string): string | null {
  if (badChars(value)) return PROBLEM.badChar;
  if (bytes(value) > ENV_LIMITS.valueBytes) return PROBLEM.tooLong;
  return null;
}

// ---- the API (E5)

const envPath = (project: string) => `/api/projects/${encodeURIComponent(project)}/env`;

/** A read of the environment's names (never a value). */
export function readEnv(project: string, fetcher?: typeof fetch): Promise<EnvReply> {
  return apiGet<EnvReply>(envPath(project), fetcher).then(cleanReply);
}

/** The answer of a save: the new names, or the lines the server refused, or its fixed sentence. */
export type SaveAnswer = { ok: true; reply: EnvReply } | { ok: false; lines: EnvLineError[]; message: string };

/** One save (Save, Remove, Remove the unreadable file). Call it only in a click, tap, key or submit handler. */
export async function saveEnv(project: string, change: EnvChange, fetcher?: typeof fetch): Promise<SaveAnswer> {
  try {
    const reply = await apiSend<EnvReply>("POST", envPath(project), change, fetcher);
    return { ok: true, reply: cleanReply(reply) };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, lines: e.lines.map((l) => ({ i: l.i, why: l.why })), message: e.message };
    return { ok: false, lines: [], message: "That did not work." };
  }
}

/** The reply's names, with any field the page does not draw left out (a value never belongs here). */
export function cleanReply(r: unknown): EnvReply {
  const o = (r && typeof r === "object" ? r : {}) as { vars?: unknown; unreadable?: unknown };
  const vars = Array.isArray(o.vars)
    ? o.vars.flatMap((v): EnvVarView[] => {
        const x = (v && typeof v === "object" ? v : {}) as { name?: unknown; at?: unknown; inSettings?: unknown };
        return typeof x.name === "string" && NAME.test(x.name) ? [{ name: x.name, at: typeof x.at === "string" ? x.at : "", inSettings: x.inSettings === true }] : [];
      })
    : [];
  return { vars, unreadable: o.unreadable === true };
}
