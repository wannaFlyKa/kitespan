// The raw-options gate (DESIGN.md 4.7). rawOptions() is the only place where query() options are built, and it runs
// checkOptions() before it returns: a chat whose options fail the check does not start (fail closed). The tests in
// test/gate/ run the same check on tampered options, one negative case per refused key or value.
//
// The table: the Always keys with their exact values, the Marked keys that carry the user's own pick (each with its
// mark), and the Switch keys that the user's own choice turns on. Every other key is refused.

import type { CanUseTool, OnElicitation, OnUserDialog, Options } from "@anthropic-ai/claude-agent-sdk";
import { realpathSync, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { EFFORT_IDS, MODE_IDS } from "../../../shared/protocol";
import { childEnv } from "../../env/child";
import { envProblems, envSnapshot, type EnvGateContext } from "../../env/gate";
import { worktreeHere } from "../../worktree/check";
import { MARK_PHRASES, MARK_RE, isProviderArn, type EnvVar, type Marked, type MarkedPicks, type MarkedSwitches, type MarkPhrase } from "../types";

/** The SDK version this gate was written for (package.json pins it exactly). */
export const SDK_VERSION = "0.3.322";

/** Always passed, each with its one exact value. */
export const ALWAYS_KEYS = [
  "cwd",
  "pathToClaudeCodeExecutable",
  "systemPrompt",
  "includePartialMessages",
  "forwardSubagentText",
  "canUseTool",
  "onElicitation",
  "onUserDialog",
  "stderr",
  "includeHookEvents",
] as const;

/**
 * `perTaskStopAffordance` is in DESIGN 4.7's Always rows, but the build brief keeps it undeclared until Stop on a live
 * background task is checked (DESIGN 11.2 row 95). While this is false the gate refuses the key; the day it turns true,
 * rawOptions() passes it and the gate requires the value `true`.
 */
export const PER_TASK_STOP_DECLARED = false;

/** The callbacks among the Always keys. In a snapshot they read "[function]". */
export const CALLBACK_KEYS = ["canUseTool", "onElicitation", "onUserDialog", "stderr"] as const;

/** Keys whose only allowed value is `true`. */
export const TRUE_ONLY_KEYS = [
  "includePartialMessages",
  "forwardSubagentText",
  "includeHookEvents",
  "perTaskStopAffordance",
  "allowDangerouslySkipPermissions",
  "promptSuggestions",
] as const;

/**
 * Marked keys and the mark phrases each may carry. `sessionId` is D41's row: first start only, never with resume.
 * `env` is D60's (L43): the variables the user set for the chat's environment, passed only when it has some
 * (server/env/gate.ts checks the value).
 */
export const MARKED_KEYS: Readonly<Record<"model" | "effort" | "permissionMode" | "resume" | "sessionId" | "env", readonly MarkPhrase[]>> = {
  model: [MARK_PHRASES.pick, MARK_PHRASES.remembered],
  effort: [MARK_PHRASES.pick, MARK_PHRASES.remembered],
  permissionMode: [MARK_PHRASES.pick, MARK_PHRASES.remembered],
  resume: [MARK_PHRASES.resume],
  sessionId: [MARK_PHRASES.newSession],
  env: [MARK_PHRASES.env],
};
export type MarkedKey = keyof typeof MARKED_KEYS;

/** Switch keys and their one mark phrase. */
export const SWITCH_KEYS: Readonly<Record<"allowDangerouslySkipPermissions" | "promptSuggestions", MarkPhrase>> = {
  allowDangerouslySkipPermissions: MARK_PHRASES.bypass,
  promptSuggestions: MARK_PHRASES.suggestions,
};
export type SwitchKey = keyof typeof SWITCH_KEYS;

/** Every key the gate lets through. */
export function allowedKeys(): string[] {
  return [
    ...ALWAYS_KEYS,
    ...(PER_TASK_STOP_DECLARED ? ["perTaskStopAffordance"] : []),
    ...Object.keys(MARKED_KEYS),
    ...Object.keys(SWITCH_KEYS),
    ...WORKTREE_KEYS,
  ];
}

/**
 * Row 73 (W-host, L21, G3): the key with one exact value, the chat's project folder, passed only when `cwd` is that
 * project's own kitespan worktree (the context's `worktree`, `own`), so Claude Code reads the project's config from the
 * main checkout, as Desktop's worktree sessions do. `extraArgs` stays refused (G5).
 */
export const WORKTREE_KEYS = ["projectConfigRoot"] as const;

/** The worktree in the chat's ledger, as the gate checks it (G3, G4). */
export interface GateWorktree {
  /** The worktree's real path: the only `cwd` it allows besides the folders of projects.json. */
  path: string;
  /** The main checkout it is a linked worktree of: a folder of projects.json. */
  root: string;
  /** kitespan made it for this chat (W3): only then `projectConfigRoot` may be passed, and only as `root`. */
  own: boolean;
}

/**
 * The 32 options that conflict with raw Claude Code (DESIGN 13.1, group 1): each adds a prompt, a tool, a setting or a
 * flag of kitespan's own. The `hooks` callback row is the same key as the `hooks` option. `env` left the group with
 * D60: it is a Marked row that carries the user's own variables (MARKED_KEYS).
 */
export const RAW_CONFLICT_OPTIONS = [
  "additionalDirectories",
  "agent",
  "agents",
  "allowedTools",
  "disallowedTools",
  "toolAliases",
  "tools",
  "extraArgs",
  "fallbackModel",
  "toolConfig",
  "betas",
  "hooks",
  "verbatimPrompts",
  "thinking",
  "maxThinkingTokens",
  "maxTurns",
  "maxBudgetUsd",
  "taskBudget",
  "mcpServers",
  "outputFormat",
  "planModeInstructions",
  "permissionPromptToolName",
  "permissionPrompts",
  "plugins",
  "pluginDelivery",
  "agentProgressSummaries",
  "sandbox",
  "settings",
  "managedSettings",
  "settingSources",
  "skills",
  "strictMcpConfig",
] as const;

/** Two keys the SDK's runtime reads that sdk.d.ts does not declare (R-sdk 2.4). */
export const UNTYPED_RUNTIME_OPTIONS = ["rapidFollowupPreempt", "workspaceTrust"] as const;

/** The raw-conflict endpoints that are not options: a source scan keeps them out of the app (test/gate/). */
export const RAW_CONFLICT_FUNCTIONS = ["createSdkMcpServer", "tool"] as const;
export const RAW_CONFLICT_QUERY_METHODS = ["updateSettings", "setMcpServers"] as const;

/** The names that the SDK puts into or takes out of the claude child's environment (sdk-env.ts). */
export { SDK_CHILD_ENV } from "./sdk-env";

/** The exact system prompt: the CLI's own preset, with nothing appended or replaced. */
export const SYSTEM_PROMPT = { type: "preset", preset: "claude_code" } as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A model row value: the CLI's own value, never a path or an option. */
const MODEL_RE = /^(?!-)[A-Za-z0-9._:/[\]-]{1,120}$/;
const NODE_MODULES_RE = /(^|\/)node_modules(\/|$)/;

/**
 * What the gate needs to know besides the options themselves. D60's two fields (EnvGateContext): `startEnv`, the start
 * environment that `env` spreads, and `envVars`, the variables stored for the chat's environment.
 */
export interface GateContext extends EnvGateContext {
  /** The path the binary pin chose for this start, or null when it found none. */
  pinnedPath: string | null;
  /** The real paths of the folders in projects.json. */
  knownFolders: readonly string[];
  /** SDK platform packages found in the install tree (any one fails the gate). */
  platformPackages: readonly string[];
  /** Settings > Chats, "Allow bypass permissions mode" (D12). */
  allowBypass: boolean;
  /** The user's own `promptSuggestionEnabled` is exactly true (an absent setting counts as off, 6.4). */
  promptSuggestionEnabled: boolean;
  /** The session id in the chat's ledger, or null when it has none: a `sessionId` or `resume` must be this id. */
  ledgerSessionId: string | null;
  /** True when a transcript is known to exist for the `sessionId` being passed (D41: then only `resume` may start it). */
  sessionExists: boolean;
  /** Row 73: the worktree in the chat's ledger (G3, G4); absent or null: none, so `cwd` is a folder of projects.json. */
  worktree?: GateWorktree | null;
}

/** The callbacks a chat brings; the gate requires all four. */
export interface GateCallbacks {
  canUseTool: CanUseTool;
  onElicitation: OnElicitation;
  onUserDialog: OnUserDialog;
  stderr: (data: string) => void;
}

/** The input of rawOptions(): only the chat's folder, the pinned binary, the callbacks and the marked user choices. */
export interface RawInput {
  cwd: string;
  binary: string;
  callbacks: GateCallbacks;
  resume: Marked<string> | null;
  sessionId: Marked<string> | null;
  picks: MarkedPicks;
  switches: MarkedSwitches;
  /** D60: the environment's variables; `env` is then the context's start environment with these over it. */
  env?: Marked<EnvVar[]> | null;
  /** Row 73: the chat's own worktree (`cwd` is its path); `projectConfigRoot` is then its root (G3). */
  worktree?: GateWorktree | null;
}

export interface BuiltOptions {
  options: Options;
  /** The mark of every Marked and Switch key passed. */
  marks: Record<string, string>;
  /** D60: the names of the environment's variables in `env`, in the user's order (the snapshot keeps names only). */
  envNames: string[];
}

/** The gate refused the options: the chat does not start. `problems` holds one line per refusal. */
export class GateError extends Error {
  readonly code = "failed" as const;
  constructor(readonly problems: string[]) {
    super(`The raw-options gate refused this start: ${problems.join("; ")}`);
    this.name = "GateError";
  }
}

/**
 * Build the options of one chat start. Throws GateError when the result fails checkOptions(), so nothing that fails
 * the gate ever reaches query().
 */
export function rawOptions(input: RawInput, ctx: GateContext): BuiltOptions {
  const options: Record<string, unknown> = {
    cwd: input.cwd,
    pathToClaudeCodeExecutable: input.binary,
    systemPrompt: { ...SYSTEM_PROMPT },
    includePartialMessages: true,
    forwardSubagentText: true,
    canUseTool: input.callbacks.canUseTool,
    onElicitation: input.callbacks.onElicitation,
    onUserDialog: input.callbacks.onUserDialog,
    stderr: input.callbacks.stderr,
    includeHookEvents: true,
  };
  if (input.worktree?.own) options.projectConfigRoot = input.worktree.root;
  if (PER_TASK_STOP_DECLARED) options.perTaskStopAffordance = true;
  const marks: Record<string, string> = {};
  const mark = (key: string, m: Marked<unknown> | undefined | null) => {
    if (!m) return;
    options[key] = m.value;
    marks[key] = m.mark;
  };
  mark("model", input.picks.model);
  mark("effort", input.picks.effort);
  mark("permissionMode", input.picks.permissionMode);
  mark("resume", input.resume);
  mark("sessionId", input.sessionId);
  mark("allowDangerouslySkipPermissions", input.switches.allowBypass);
  mark("promptSuggestions", input.switches.promptSuggestions);
  // D60: the start environment with the environment's variables over it, in a fresh object (the SDK's `env` replaces
  // the child's whole environment). No variables, no key.
  const env = input.env ?? null;
  mark("env", env ? { value: childEnv(ctx.startEnv ?? {}, env.value), mark: env.mark } : null);
  const problems = checkOptions(options, marks, ctx);
  if (problems.length) throw new GateError(problems);
  return { options: options as Options, marks, envNames: env ? env.value.map((v) => v.name) : [] };
}

const isCallback = (v: unknown) => typeof v === "function" || v === "[function]";

/** A mark's time is a real UTC instant (2026-02-30 is not), written as markOf() writes it or without milliseconds. */
function validMarkTime(t: string): boolean {
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return false;
  const iso = d.toISOString();
  return iso === t || iso.replace(/\.\d{3}Z$/, "Z") === t;
}

/** Why `mark` does not fit `key`, or null when it does. */
export function markProblem(key: string, mark: unknown, phrases: readonly MarkPhrase[]): string | null {
  if (typeof mark !== "string" || mark === "") return `"${key}" is passed without a mark`;
  const m = MARK_RE.exec(mark);
  if (!m) return `"${key}" has a malformed mark or an unknown phrase`;
  if (!phrases.includes(m[1] as MarkPhrase)) return `"${key}" carries a mark phrase that its row does not allow`;
  if (!validMarkTime(m[2]!)) return `"${key}" has a mark with a bad time`;
  return null;
}

function realpathOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every reason why `options` (with `marks`) is not raw Claude Code, as one line each; empty when it passes. Works on
 * the live object (callbacks as functions) and on a snapshot (callbacks as "[function]").
 */
export function checkOptions(options: Record<string, unknown>, marks: Record<string, string>, ctx: GateContext): string[] {
  const problems: string[] = [];
  const allowed = new Set(allowedKeys());
  const conflicts = new Set<string>(RAW_CONFLICT_OPTIONS);
  const untyped = new Set<string>(UNTYPED_RUNTIME_OPTIONS);

  // 1. Any key outside the table.
  for (const key of Object.keys(options)) {
    if (allowed.has(key)) continue;
    if (conflicts.has(key)) problems.push(`"${key}" conflicts with raw Claude Code and is never passed`);
    else if (untyped.has(key)) problems.push(`"${key}" is an untyped SDK option and is never passed`);
    else if (key === "perTaskStopAffordance") problems.push(`"perTaskStopAffordance" is not declared until Stop on a live background task is checked`);
    else problems.push(`"${key}" is not an allowed key`);
  }

  // 8. The Always keys, each present.
  for (const key of ALWAYS_KEYS) if (!(key in options)) problems.push(`"${key}" is missing`);
  for (const key of CALLBACK_KEYS) if (key in options && !isCallback(options[key])) problems.push(`"${key}" is not a callback`);

  // 9. Keys whose only value is true.
  for (const key of TRUE_ONLY_KEYS) if (key in options && options[key] !== true) problems.push(`"${key}" must be exactly true`);

  // 6. The prompt: exactly the claude_code preset.
  if ("systemPrompt" in options) {
    const sp = options.systemPrompt;
    const ok =
      typeof sp === "object" &&
      sp !== null &&
      !Array.isArray(sp) &&
      Object.keys(sp).length === 2 &&
      (sp as Record<string, unknown>).type === "preset" &&
      (sp as Record<string, unknown>).preset === "claude_code";
    if (!ok) problems.push(`"systemPrompt" must be exactly the claude_code preset, with nothing added`);
  }

  // 7. The folder: an absolute real path of a folder in projects.json, or (row 73, G4) the worktree in the chat's
  // ledger, a linked worktree of a folder in projects.json as its own git files show it (file reads, W4).
  const wt = ctx.worktree ?? null;
  if ("cwd" in options) {
    const cwd = options.cwd;
    if (typeof cwd !== "string" || !isAbsolute(cwd)) problems.push(`"cwd" must be an absolute path`);
    else if (realpathOrNull(cwd) !== cwd || !isDirectory(cwd)) problems.push(`"cwd" must be the real path of a folder`);
    else if (ctx.knownFolders.includes(cwd)) {
      // a project's own folder
    } else if (!wt || wt.path !== cwd) problems.push(`"cwd" is not a folder of projects.json`);
    else if (!ctx.knownFolders.includes(wt.root)) problems.push(`"cwd" is a worktree of a folder that is not in projects.json`);
    else if (!worktreeHere(cwd, wt.root)) problems.push(`"cwd" is not a linked worktree of its project's folder`);
  }

  // 11. projectConfigRoot (G3): exactly the chat's project folder, and only while `cwd` is that project's own
  // kitespan worktree.
  if ("projectConfigRoot" in options) {
    const root = options.projectConfigRoot;
    if (typeof root !== "string" || !isAbsolute(root)) problems.push(`"projectConfigRoot" must be an absolute path`);
    else if (!wt || !wt.own || options.cwd !== wt.path) problems.push(`"projectConfigRoot" is passed only for the chat's own worktree`);
    else if (root !== wt.root || root === options.cwd) problems.push(`"projectConfigRoot" is not the chat's project folder`);
    else if (!ctx.knownFolders.includes(root)) problems.push(`"projectConfigRoot" is not a folder of projects.json`);
  }

  // 5. The binary: exactly the path the pin chose, absolute, never inside node_modules, never a wrapper.
  if ("pathToClaudeCodeExecutable" in options) {
    const exe = options.pathToClaudeCodeExecutable;
    if (typeof exe !== "string" || exe === "") problems.push(`"pathToClaudeCodeExecutable" must be a path`);
    else {
      // The SDK starts it from the chat's folder: a relative path would run a different file than the pin checked.
      if (!isAbsolute(exe)) problems.push(`"pathToClaudeCodeExecutable" must be an absolute path`);
      if (ctx.pinnedPath === null) problems.push(`"pathToClaudeCodeExecutable" is set, but the binary pin found no claude`);
      else if (exe !== ctx.pinnedPath) problems.push(`"pathToClaudeCodeExecutable" is not the path the binary pin chose`);
      if (basename(exe) !== "claude") problems.push(`"pathToClaudeCodeExecutable" is not a claude binary (a wrapper is refused)`);
      if (NODE_MODULES_RE.test(exe)) problems.push(`"pathToClaudeCodeExecutable" is inside node_modules`);
      else {
        const real = realpathOrNull(exe);
        if (real && NODE_MODULES_RE.test(real)) problems.push(`"pathToClaudeCodeExecutable" links into node_modules`);
      }
    }
  }

  // 10. No SDK platform package in the install tree.
  if (ctx.platformPackages.length) problems.push(`an SDK platform package is installed (${ctx.platformPackages.join(", ")})`);

  // 2, 3. Marked keys: the mark, the phrase its row allows, a valid time, and a value of the right kind.
  for (const [key, phrases] of Object.entries(MARKED_KEYS) as [MarkedKey, readonly MarkPhrase[]][]) {
    if (!(key in options)) continue;
    const why = markProblem(key, marks[key], phrases);
    if (why) problems.push(why);
    const v = options[key];
    if (key === "model" && (typeof v !== "string" || !MODEL_RE.test(v))) problems.push(`"model" is not a model row value`);
    if (key === "effort" && !(EFFORT_IDS as readonly unknown[]).includes(v)) problems.push(`"effort" is not an effort level`);
    if (key === "permissionMode") {
      if (!(MODE_IDS as readonly unknown[]).includes(v)) problems.push(`"permissionMode" is not one of Desktop's modes`);
      if (v === "plan" && typeof marks.permissionMode === "string" && marks.permissionMode.startsWith(`${MARK_PHRASES.remembered} on `))
        problems.push(`"permissionMode" plan is never remembered (D11)`);
    }
    if (key === "resume" || key === "sessionId") {
      if (typeof v !== "string" || !UUID_RE.test(v)) problems.push(`"${key}" is not a session id`);
      if (typeof ctx.ledgerSessionId !== "string" || v !== ctx.ledgerSessionId) problems.push(`"${key}" is not the session id in the chat's ledger`);
    }
    if (key === "env") problems.push(...envProblems(v, ctx));
  }
  if ("sessionId" in options && "resume" in options) problems.push(`"sessionId" is never passed together with "resume" (D41)`);
  // Fail closed: a context that does not say whether the transcript exists cannot clear a sessionId.
  if ("sessionId" in options && typeof ctx.sessionExists !== "boolean") problems.push(`"sessionId" is passed, but the gate was not told whether a transcript exists for it`);
  if ("sessionId" in options && ctx.sessionExists === true) problems.push(`"sessionId" is passed for a session that has a transcript: start it with "resume" (D41)`);

  // 4. Switch keys: the mark, and the user's own choice behind it.
  for (const [key, phrase] of Object.entries(SWITCH_KEYS) as [SwitchKey, MarkPhrase][]) {
    if (!(key in options)) continue;
    const why = markProblem(key, marks[key], [phrase]);
    if (why) problems.push(why);
  }
  if ("allowDangerouslySkipPermissions" in options && !ctx.allowBypass)
    problems.push(`"allowDangerouslySkipPermissions" is passed while the Settings switch is off`);
  if ("promptSuggestions" in options && !ctx.promptSuggestionEnabled)
    problems.push(`"promptSuggestions" is passed while the user's promptSuggestionEnabled is not true`);
  if (options.permissionMode === "bypassPermissions" && options.allowDangerouslySkipPermissions !== true)
    problems.push(`"permissionMode" bypassPermissions needs "allowDangerouslySkipPermissions"`);

  // A mark for a key that is not passed.
  for (const key of Object.keys(marks)) if (!(key in options)) problems.push(`a mark is recorded for "${key}", which is not passed`);

  return problems;
}

/**
 * The options with every callback as "[function]": what last-options.json records (4.7). `env` (D60) keeps names only:
 * `{"[inherited]": true, "NAME": "[set]", ...}` for `envNames`, never a value of the server's or the environment's. A
 * provider's ARN where a model row value goes (row 95: it holds the account id) is recorded as "[an ARN]".
 */
export function snapshotOptions(options: Options | Record<string, unknown>, envNames: readonly string[] = []): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(options).map(([k, v]) => [k, k === "env" ? envSnapshot(envNames) : typeof v === "function" ? "[function]" : isProviderArn(v) ? "[an ARN]" : v]),
  );
}
