// D58 Continue in a copy: the driver's forkSession, through the real SDK's forkSession, in a child process whose HOME
// and CLAUDE_CONFIG_DIR are a mkdtemp folder with a fixture transcript. The copy gets a new session id and the copy's
// title; the original transcript stays byte for byte as it was, so the other app keeps its session. The user's own
// Claude Code folders are never touched.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROBE = join(import.meta.dir, "..", "fake-claude", "sessions-probe.ts");
const HOME = realpathSync(mkdtempSync(join(tmpdir(), "claude-fork-")));
const CONFIG = join(HOME, ".claude");
const PROJECT = join(HOME, "work", "demo");
const PROJECTS = join(CONFIG, "projects", PROJECT.replace(/[^a-zA-Z0-9]/g, "-"));
const TERMINAL = "1b0f5c1e-1d2a-4c3b-8d4e-5f6a7b8c9d0e";
const MISSING = "3d2f7e3a-3f4c-4e5d-8f6a-7b8c9d0e1f2a";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function transcript(id: string, rows: { type: "user" | "assistant"; uuid: string; content: unknown }[]): string {
  let parent: string | null = null;
  let out = "";
  let i = 0;
  for (const r of rows) {
    out +=
      JSON.stringify({
        type: r.type,
        message: r.type === "user" ? { role: "user", content: r.content } : { id: `msg_${r.uuid}`, type: "message", role: "assistant", model: "claude-fake-1", content: r.content },
        uuid: r.uuid,
        parentUuid: parent,
        sessionId: id,
        timestamp: new Date(Date.UTC(2026, 9, 31, 12, 0, i++)).toISOString(),
        cwd: PROJECT,
        isSidechain: false,
        userType: "external",
        entrypoint: "cli",
        version: "2.1.322",
      }) + "\n";
    parent = r.uuid;
  }
  return out;
}

async function probe(op: string, args: Record<string, unknown>): Promise<{ ok: boolean; value?: any; code?: string | null; error?: string }> {
  const proc = Bun.spawn([process.execPath, "--no-env-file", PROBE, op, JSON.stringify({ cwd: PROJECT, ...args })], {
    cwd: HOME,
    env: { HOME, CLAUDE_CONFIG_DIR: CONFIG, PATH: "/usr/bin:/bin" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return JSON.parse(out);
}

const ORIGINAL = join(PROJECTS, `${TERMINAL}.jsonl`);

beforeAll(() => {
  mkdirSync(PROJECT, { recursive: true });
  mkdirSync(PROJECTS, { recursive: true });
  writeFileSync(
    ORIGINAL,
    transcript(TERMINAL, [
      { type: "user", uuid: "aaaaaaaa-0000-4000-8000-000000000001", content: "Fix the flaky upload test" },
      { type: "assistant", uuid: "aaaaaaaa-0000-4000-8000-000000000002", content: [{ type: "text", text: "It waits on a timer." }] },
    ]),
  );
});
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

describe("forkSession (Continue in a copy, D58)", () => {
  test("a new session id, the copy's title, the same conversation; the original transcript is unchanged", async () => {
    const before = readFileSync(ORIGINAL);
    const r = await probe("fork", { id: TERMINAL, title: "Fix the flaky upload test (copy)" });
    expect(r.ok).toBe(true);
    const id = r.value.id as string;
    expect(id).toMatch(UUID);
    expect(id).not.toBe(TERMINAL);
    expect(r.value.info).toMatchObject({ sessionId: id, title: "Fix the flaky upload test (copy)", customTitle: "Fix the flaky upload test (copy)" });
    expect(existsSync(join(PROJECTS, `${id}.jsonl`))).toBe(true);
    expect(readFileSync(ORIGINAL).equals(before)).toBe(true);
    const copy = await probe("history", { id });
    const original = await probe("history", { id: TERMINAL });
    const said = (events: { k: string; text?: string }[]) => events.filter((e) => e.k === "user" || e.k === "block").map((e) => e.text);
    expect(said(copy.value.events)).toEqual(said(original.value.events));
    expect(said(copy.value.events)).toEqual(["Fix the flaky upload test", "It waits on a timer."]);
    // The original's own title is untouched.
    expect((await probe("info", { id: TERMINAL })).value).toMatchObject({ customTitle: null });
  });

  test("a session that does not exist is not_found; a bad id is a bad request", async () => {
    expect(await probe("fork", { id: MISSING, title: "x (copy)" })).toMatchObject({ ok: false, code: "not_found" });
    expect(await probe("fork", { id: "not-a-uuid", title: "x (copy)" })).toMatchObject({ ok: false, code: "bad_request" });
  });
});
