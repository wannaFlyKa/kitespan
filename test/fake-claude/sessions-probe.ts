// Runs one of the Claude driver's session functions (the real SDK ones) and prints the result as JSON. The test that
// uses it starts it with HOME and CLAUDE_CONFIG_DIR pointing at a mkdtemp folder that holds fixture transcripts and
// settings, so the user's own Claude Code folders are never read or written.
//
//   bun sessions-probe.ts <history|transcript|info|usage|list|released|folders|rename|delete|fork|settings> '<json arguments>'

import { createClaudeDriver } from "../../server/agents/claude/driver";

const [op, raw] = process.argv.slice(2);
const a = JSON.parse(raw ?? "{}") as { id?: string; ids?: string[]; cwd: string; before?: string | null; maxBytes?: number; title?: string };
const d = createClaudeDriver({ knownFolders: () => [], allowBypass: () => false, pathEnv: () => "" });

async function run(): Promise<unknown> {
  switch (op) {
    case "history":
      return d.history(a.id!, a.cwd, { before: a.before ?? null, maxBytes: a.maxBytes ?? 256 * 1024 });
    case "transcript":
      return d.transcriptEvents(a.id!, a.cwd);
    case "info":
      return d.sessionInfo(a.id!, a.cwd);
    case "usage":
      return d.lastUsage(a.id!, a.cwd);
    case "list":
      return d.listSessions(a.cwd);
    case "released":
      return d.listReleased(a.cwd, a.ids ?? []);
    case "folders":
      return d.sessionFolders();
    case "rename":
      await d.rename(a.id!, a.title!, a.cwd);
      return d.sessionInfo(a.id!, a.cwd);
    case "delete":
      await d.deleteSession(a.id!, a.cwd);
      return d.sessionInfo(a.id!, a.cwd);
    case "fork": {
      const id = await d.forkSession(a.id!, a.cwd, a.title ?? null);
      return { id, info: await d.sessionInfo(id, a.cwd) };
    }
    case "settings":
      return d.settings(a.cwd);
    default:
      throw new Error("unknown op");
  }
}

try {
  process.stdout.write(JSON.stringify({ ok: true, value: await run() }));
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, code: (e as { code?: string }).code ?? null, error: String((e as Error).message) }));
}
