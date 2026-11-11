// W4's Continue in the project folder, with the SDK's own session functions (build checklist W4, W9, W10): the
// driver's history, sessionInfo, forkSession and deleteSession in a child process whose HOME and CLAUDE_CONFIG_DIR are
// a mkdtemp folder. A chat whose worktree is gone and forgotten by git has its transcript filed under the worktree's
// path (the lead's live probe: a resume in the main checkout kept writing that file), which `dir` = that path finds
// although the folder is gone: Delete removes the file and a copy goes beside it. `dir` = the project's folder finds
// nothing, and nothing reads every folder instead. The user's own Claude Code folders are never touched.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROBE = join(import.meta.dir, "..", "fake-claude", "sessions-probe.ts");
const HOME = realpathSync(mkdtempSync(join(tmpdir(), "claude-gone-wt-")));
const CONFIG = join(HOME, ".claude");
const PROJECT = join(HOME, "work", "demo");
/** A kitespan worktree's path that is not there any more. */
const GONE = join(HOME, "data", "kitespan", "worktrees", "k3m7q2x4ab", "abcdefgh");
const FILED = join(CONFIG, "projects", GONE.replace(/[^a-zA-Z0-9]/g, "-"));
const SID = "5c2d9e1a-7b3f-4a6e-9d8c-1f2e3a4b5c6d";

function record(type: "user" | "assistant", uuid: string, parent: string | null, cwd: string, i: number): string {
  return JSON.stringify({
    type,
    message: type === "user" ? { role: "user", content: `message ${i}` } : { id: `msg_${uuid}`, type: "message", role: "assistant", model: "claude-fake-1", content: [{ type: "text", text: `reply ${i}` }] },
    uuid,
    parentUuid: parent,
    sessionId: SID,
    timestamp: new Date(Date.UTC(2026, 10, 2, 12, 0, i)).toISOString(),
    cwd,
    isSidechain: false,
    userType: "external",
    entrypoint: "sdk-ts",
    version: "2.1.317",
  });
}

async function probe(op: string, args: Record<string, unknown>): Promise<{ ok: boolean; value?: any; code?: string | null; error?: string }> {
  const proc = Bun.spawn([process.execPath, "--no-env-file", PROBE, op, JSON.stringify(args)], {
    cwd: HOME,
    env: { HOME, CLAUDE_CONFIG_DIR: CONFIG, PATH: "/usr/bin:/bin" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return JSON.parse(out);
}

beforeAll(() => {
  mkdirSync(PROJECT, { recursive: true });
  mkdirSync(FILED, { recursive: true });
  const ids = ["a1000000-0000-4000-8000-000000000001", "a1000000-0000-4000-8000-000000000002", "a1000000-0000-4000-8000-000000000003", "a1000000-0000-4000-8000-000000000004"];
  // Two records from the worktree, then two from the resume in the project's folder, in the same file.
  const rows = [record("user", ids[0]!, null, GONE, 0), record("assistant", ids[1]!, ids[0]!, GONE, 1), record("user", ids[2]!, ids[1]!, PROJECT, 2), record("assistant", ids[3]!, ids[2]!, PROJECT, 3)];
  writeFileSync(join(FILED, `${SID}.jsonl`), rows.join("\n") + "\n");
});
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

describe("a transcript filed under a worktree that is gone", () => {
  test("the worktree's path finds it; the project's folder does not, and no read of every folder follows", async () => {
    expect(existsSync(GONE)).toBe(false);
    expect((await probe("info", { id: SID, cwd: GONE })).value).toMatchObject({ sessionId: SID });
    expect((await probe("info", { id: SID, cwd: PROJECT })).value).toBeNull();
    const page = (await probe("history", { id: SID, cwd: GONE })).value as { events: { k: string }[] };
    expect(page.events.filter((e) => e.k === "user")).toHaveLength(2);
    expect(((await probe("history", { id: SID, cwd: PROJECT })).value as { events: unknown[] }).events).toEqual([]);
  });

  test("a copy goes beside it, and Delete removes it", async () => {
    const fork = await probe("fork", { id: SID, cwd: GONE, title: "Copy" });
    expect(fork.ok).toBe(true);
    expect(existsSync(join(FILED, `${fork.value.id}.jsonl`))).toBe(true);
    expect(fork.value.info).toMatchObject({ sessionId: fork.value.id });
    // Asked with the project's folder, the SDK finds nothing to delete, and the file would stay.
    expect((await probe("delete", { id: SID, cwd: PROJECT })).ok).toBe(true);
    expect(existsSync(join(FILED, `${SID}.jsonl`))).toBe(true);
    expect(await probe("delete", { id: SID, cwd: GONE })).toEqual({ ok: true, value: null });
    expect(existsSync(join(FILED, `${SID}.jsonl`))).toBe(false);
    expect((await probe("delete", { id: fork.value.id, cwd: GONE })).ok).toBe(true);
    expect(existsSync(join(FILED, `${fork.value.id}.jsonl`))).toBe(false);
  });
});
