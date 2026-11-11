// The environment of the pane's login shell (DESIGN.md 4.7, 6.10; R-pty 3.2). The shell starts from the same clean
// environment as the chat's Claude Code: the start script has already removed the variables of a Claude Code session,
// of a Claude Desktop host and the names of the user's start-env file, and this removes the built-in list once more
// (a server started some other way), the mark that the SDK sets on the server itself, plus any names the caller adds.
// TERM is set, because the PTY's `name` option does not export it and a server started without a terminal has none to
// pass on. Names only are handled here; no value is ever logged.

import { CLEAN_ENV } from "../agents/types";

export const SHELL_TERM = "xterm-256color";

/** The variables that show the start environment came from a Claude Code session; then the trace context goes too. */
const SESSION_MARKERS = ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION"] as const;

/**
 * Set by the SDK on the server's own process.env: NoDefaultCurrentDirectoryInExePath when the server imports it,
 * CLAUDE_AGENT_SDK_VERSION at each chat start (server/agents/claude/options.ts, SDK_CHILD_ENV.host). The user's own
 * `claude` in the shell is not started by the SDK.
 */
const SDK_HOST_NAMES = ["NoDefaultCurrentDirectoryInExePath", "CLAUDE_AGENT_SDK_VERSION"] as const;

export interface ShellEnvOptions {
  /** More names to leave out. */
  dropNames?: readonly string[];
  /** More name prefixes to leave out (for example the prefix of another terminal app's own variables). */
  dropPrefixes?: readonly string[];
  /**
   * D60 (L38): the chat's environment's variables, as its Claude Code gets them (Desktop's terminal "shares the same
   * environment as Claude"): set after the drop rules, before TERM.
   */
  vars?: readonly { name: string; value: string }[];
}

export function shellEnv(base: Readonly<Record<string, string | undefined>>, opts: ShellEnvOptions = {}): Record<string, string> {
  const has = (n: string) => typeof base[n] === "string";
  const drop = new Set<string>([...CLEAN_ENV.always, ...SDK_HOST_NAMES]);
  if (CLEAN_ENV.desktopMarkers.some(has)) for (const n of CLEAN_ENV.desktop) drop.add(n);
  if (SESSION_MARKERS.some(has)) for (const n of CLEAN_ENV.traceAfterSession) drop.add(n);
  for (const n of opts.dropNames ?? []) drop.add(n);
  const prefixes = [...CLEAN_ENV.alwaysPrefixes, ...(opts.dropPrefixes ?? [])].filter((p) => p.length > 0);
  const kept = Object.entries(base).filter((e): e is [string, string] => typeof e[1] === "string" && !drop.has(e[0]) && !prefixes.some((p) => e[0].startsWith(p)));
  return Object.fromEntries([...kept, ...(opts.vars ?? []).map((v): [string, string] => [v.name, v.value]), ["TERM", SHELL_TERM]]);
}
