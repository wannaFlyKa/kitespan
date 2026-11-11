// R127 (owner rows 126, 127, 129): the trust start's options and their own narrow check. This file is the only place
// in the app that sends the SDK's undocumented host attestation, `Options.workspaceTrust: {accepted: true, directory}`
// (sdk.mjs 0.3.312 puts it in the initialize request; the CLI's schema: "Only send true after showing the user a trust
// dialog for `directory`"). kitespan sends it only after the user's own Yes in its confirm, for the one folder that
// Claude Code refused a background session in, so that Claude Code records the trust itself (kitespan never writes
// Claude Code's config). The chat gate (options.ts) is unchanged and still refuses the key for every chat start.
//
// The start runs no turn: one query() in that folder with an input that yields nothing; the driver awaits the
// initialize answer, reads `workspace_trust_recorded`, and closes it (driver.ts trustFolder). Its options are exactly
// TRUST_OPTION_KEYS: no env key, so the child gets the server's clean start environment and never an environment's
// variables; no model, effort, mode, resume, session id or system prompt.

import type { CanUseTool, OnElicitation, OnUserDialog } from "@anthropic-ai/claude-agent-sdk";
import { realpathSync, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { holdsPath } from "../../../shared/trust";

/** The trust start's answer comes in about 0.8 s (the lead's probe, LIVE-NOTES item 11); it ends after this long. */
export const TRUST_READ_MS = 20_000;

/**
 * Lead decision (a): the trust start loads no settings file (`settingSources: []`, sdk.d.ts 0.3.312 line 2327, "SDK
 * isolation mode"), so a folder that the user has not trusted yet runs none of its own hooks and connects none of its
 * `.mcp.json` servers while Claude Code records the trust. Whether the record still lands this way is one live check
 * (test/live/trust.test.ts); when it does not, this turns false and the start loads the CLI's default sources.
 */
export const TRUST_SETTING_SOURCES_OFF = true;

/** Every key of a trust start, each required; any other key is refused. */
export const TRUST_OPTION_KEYS: readonly string[] = [
  "cwd",
  "pathToClaudeCodeExecutable",
  "workspaceTrust",
  "canUseTool",
  "onElicitation",
  "onUserDialog",
  "stderr",
  ...(TRUST_SETTING_SOURCES_OFF ? ["settingSources"] : []),
];

const CALLBACKS = ["canUseTool", "onElicitation", "onUserDialog", "stderr"] as const;
const NODE_MODULES_RE = /(^|\/)node_modules(\/|$)/;

/** What the trust start's check knows besides the options. */
export interface TrustGateContext {
  /** The folder that the user confirmed (its real path, as the registry checked it). */
  path: string;
  /** The path that the binary pin chose for this start, or null when it found none. */
  pinnedPath: string | null;
  /** SDK platform packages found in the install tree (any one fails the check). */
  platformPackages: readonly string[];
  /** The home folder as the system names it and as its real path: never trusted, nor a folder that holds it. */
  homes: readonly string[];
}

/** The trust start's check refused its options: nothing starts. */
export class TrustGateError extends Error {
  readonly code = "failed" as const;
  constructor(readonly problems: string[]) {
    super(`The trust start's check refused its options: ${problems.join("; ")}`);
    this.name = "TrustGateError";
  }
}

/**
 * The options of one trust start for `path` (the confirmed folder, its real path) with the pinned `binary`: the folder
 * as `cwd` and as the attested directory, callbacks that refuse whatever might come, stderr ignored, and (lead
 * decision a) no settings file.
 */
export function trustOptions(input: { path: string; binary: string }): Record<string, unknown> {
  const canUseTool: CanUseTool = async () => ({ behavior: "deny", message: "kitespan only records the folder's trust here." });
  const onElicitation: OnElicitation = async () => ({ action: "cancel" });
  const onUserDialog: OnUserDialog = async () => ({ behavior: "cancelled" });
  return {
    cwd: input.path,
    pathToClaudeCodeExecutable: input.binary,
    workspaceTrust: { accepted: true, directory: input.path },
    canUseTool,
    onElicitation,
    onUserDialog,
    stderr: () => {},
    ...(TRUST_SETTING_SOURCES_OFF ? { settingSources: [] } : {}),
  };
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

/** Every reason why `options` are not a trust start's for `ctx.path`, one line each; empty when they pass. */
export function checkTrustOptions(options: Record<string, unknown>, ctx: TrustGateContext): string[] {
  const problems: string[] = [];
  const allowed = new Set(TRUST_OPTION_KEYS);
  for (const key of Object.keys(options)) if (!allowed.has(key)) problems.push(`"${key}" is never passed on a trust start`);
  for (const key of TRUST_OPTION_KEYS) if (!(key in options)) problems.push(`"${key}" is missing`);
  for (const key of CALLBACKS) if (key in options && typeof options[key] !== "function") problems.push(`"${key}" is not a callback`);

  // The folder: an absolute real path of a folder (no link in it), the one that the user confirmed, never the home
  // folder (Claude Code keeps its trust for the session only) nor one that holds it.
  const cwd = options.cwd;
  if ("cwd" in options) {
    if (typeof cwd !== "string" || !isAbsolute(cwd)) problems.push(`"cwd" must be an absolute path`);
    else if (realpathOrNull(cwd) !== cwd || !isDirectory(cwd)) problems.push(`"cwd" must be the real path of a folder`);
    else if (cwd !== ctx.path) problems.push(`"cwd" is not the folder that the user confirmed`);
    if (typeof cwd === "string" && ctx.homes.some((h) => holdsPath(cwd, h))) problems.push(`"cwd" is the home folder or holds it`);
  }

  // The attestation: exactly {accepted: true, directory: cwd}.
  if ("workspaceTrust" in options) {
    const wt = options.workspaceTrust;
    const ok =
      typeof wt === "object" &&
      wt !== null &&
      !Array.isArray(wt) &&
      Object.keys(wt).sort().join(",") === "accepted,directory" &&
      (wt as Record<string, unknown>).accepted === true &&
      (wt as Record<string, unknown>).directory === cwd;
    if (!ok) problems.push(`"workspaceTrust" must be exactly {accepted: true, directory: cwd}`);
  }

  // The binary: as the chat gate's rule 5, the path that the pin chose, never a wrapper, never in node_modules.
  if ("pathToClaudeCodeExecutable" in options) {
    const exe = options.pathToClaudeCodeExecutable;
    if (typeof exe !== "string" || exe === "") problems.push(`"pathToClaudeCodeExecutable" must be a path`);
    else {
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

  if (TRUST_SETTING_SOURCES_OFF && "settingSources" in options) {
    const s = options.settingSources;
    if (!Array.isArray(s) || s.length !== 0) problems.push(`"settingSources" must be exactly []`);
  }

  if (ctx.platformPackages.length) problems.push(`an SDK platform package is installed (${ctx.platformPackages.join(", ")})`);
  return problems;
}

/**
 * The initialize answer's `workspace_trust_recorded` (the CLI's schema: true when the folder's trust key "is now
 * persisted as trusted (or already was)"; false when nothing durable was recorded; absent with no attestation or on a
 * CLI that predates the field). Only an exact true is recorded.
 */
export function recordedOf(init: unknown): boolean {
  return typeof init === "object" && init !== null && (init as Record<string, unknown>).workspace_trust_recorded === true;
}
