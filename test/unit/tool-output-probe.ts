// Runs the Claude driver's toolOutput (the real SDK transcript reader) and prints the result as JSON. tool-output.test.ts
// starts it with HOME and CLAUDE_CONFIG_DIR pointing at a mkdtemp folder that holds a fixture transcript, so the user's
// own Claude Code folders are never read or written.
//
//   bun tool-output-probe.ts '{"id": "<session>", "cwd": "<folder>", "tool": "<tool use id>"}'

import { createClaudeDriver } from "../../server/agents/claude/driver";

const a = JSON.parse(process.argv[2] ?? "{}") as { id: string; cwd: string; tool: string };
const d = createClaudeDriver({ knownFolders: () => [], allowBypass: () => false, pathEnv: () => "" });

try {
  process.stdout.write(JSON.stringify({ ok: true, value: await d.toolOutput!(a.id, a.cwd, a.tool) }));
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, code: (e as { code?: string }).code ?? null, error: String((e as Error).message) }));
}
