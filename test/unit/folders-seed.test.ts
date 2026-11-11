// The click-through seed holds what New environment reads (D54): folders under its home folder to browse, two git
// repositories for the walk, and terminal sessions whose folders Suggested lists newest first (the files' times are
// their last records'). The session list is the real SDK's, in a child process whose HOME and CLAUDE_CONFIG_DIR are
// the seed's, so the user's own Claude Code folder is never read.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listFolders } from "../../server/folders/list";
import { findRepos, suggestedFolders } from "../../server/folders/suggest";
import { IDS } from "../click/seed/ids";
import { writeSeed } from "../click/seed/write";

const ROOT = mkdtempSync(join(tmpdir(), "kitespan-folders-seed-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const seed = writeSeed(ROOT, "main");
const PROBE = join(import.meta.dir, "..", "fake-claude", "sessions-probe.ts");

async function sessionFolders(): Promise<string[]> {
  const proc = Bun.spawn([process.execPath, "--no-env-file", PROBE, "folders", JSON.stringify({ cwd: seed.home })], {
    cwd: seed.home,
    env: { HOME: seed.home, CLAUDE_CONFIG_DIR: seed.claudeConfig, PATH: "/usr/bin:/bin" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const r = JSON.parse(out) as { ok: boolean; value: string[] };
  expect(r.ok).toBe(true);
  return r.value;
}

describe("the seed's New environment", () => {
  test("Browse: the home folder's folders, and the two repositories under code", async () => {
    const home = await listFolders(seed.home, { home: seed.home });
    expect(home.ok && home.folders.map((f) => [f.name, f.git, f.subfolders])).toEqual([
      ["code", false, true],
      ["Documents", false, false],
    ]);
    const code = await listFolders(join(seed.home, "code"), { home: seed.home });
    expect(code.ok && code.folders.map((f) => [f.path, f.git])).toEqual([
      [seed.homeFolders.infra, true],
      [seed.homeFolders.website, true],
    ]);
  });

  test("Suggested: the terminal sessions' folders newest first, projects marked, then the repository not listed yet", async () => {
    expect(await findRepos(seed.home)).toEqual({ repos: [seed.homeFolders.infra, seed.homeFolders.website], complete: true });
    const projects = (JSON.parse(readFileSync(join(seed.state, "projects.json"), "utf8")) as { projects: { id: string; cwd: string }[] }).projects;
    const out = await suggestedFolders({
      sessionFolders,
      repos: { get: () => findRepos(seed.home) },
      projects: async () => projects,
    });
    expect(out.map((f) => [f.path, f.from, f.project, f.git])).toEqual([
      [seed.folders.kitespan, "session", IDS.projects.kitespan, expect.any(Boolean)],
      [seed.folders.notes, "session", IDS.projects.notes, false],
      [seed.homeFolders.website, "session", null, true],
      [seed.homeFolders.infra, "repo", null, true],
    ]);
  });
});
