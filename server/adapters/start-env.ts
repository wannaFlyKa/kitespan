// The start environment, the server's side (DESIGN.md 4.7 "Checked at boot", 4.8). bin/kitespan cleans the environment
// before Bun starts, from its built-in list and the user's own start-env file, which the server never reads. The
// server can only check that it was started that way: no name of the built-in removal list is set, and Bun loaded no
// .env file. A child (Claude Code, a ! command, the Terminal pane's shell) gets the environment as it was when Bun
// started, so a variable cannot be taken back out once the server runs.

import { dirtyStartNames } from "../agents/types";

/**
 * Why the server must not start, as lines for the terminal: names only, never a value. Empty when the start was
 * clean. `execArgv` is Bun's own flags (`process.execArgv`).
 */
export function startEnvProblems(env: Record<string, string | undefined>, execArgv: readonly string[]): string[] {
  const out: string[] = [];
  const names = dirtyStartNames(env);
  if (names.length) out.push(`These variables are set, so kitespan was not started by bin/kitespan: ${names.join(", ")}.`);
  if (!execArgv.includes("--no-env-file")) out.push("Bun was started without --no-env-file, so it may have loaded a .env file.");
  if (out.length) out.push("Start kitespan with bin/kitespan.");
  return out;
}
