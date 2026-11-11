// The drift line at start (DESIGN.md 4.10). The binary pin (server/agents/claude/locate.ts) reads `claude --version`
// at every probe and compares it with the CLI version that the pinned SDK names; the probe's `drift` is that one line,
// for example "Claude Code 2.1.311 runs here; this SDK was built for 2.1.312." Drift is normal (a native Claude Code
// updates itself), so the terminal gets one plain line at start, as Settings > Claude Code and the Environment panel
// do. "Update available" and "Restart to apply" are About's (updates.ts), and the restart is DESIGN 4.10's.
//
// Below kitespan's minimum Claude Code version (rows 118, 119), the minimum's line takes the drift line's place, in
// plain text, as Settings > Claude Code shows it: one line either way.

import { CLAUDE_MINIMUM_WORDS, type ClaudeStatus } from "../../shared/protocol";

/** The lines the server prints at start about the Claude Code that chats will run. */
export function claudeLines(status: ClaudeStatus): string[] {
  if (!status.ok) return ["Claude Code is not available, so no chat can start: see Settings > Claude Code."];
  const lines = [`Claude Code ${status.version ?? "(its version could not be read)"}`];
  if (status.belowMinimum) lines.push(CLAUDE_MINIMUM_WORDS.plain(status.belowMinimum));
  else if (status.drift) lines.push(status.drift);
  return lines;
}
