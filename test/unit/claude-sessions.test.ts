// The driver's session functions on a sleeping chat (DESIGN.md 4.2, D41, D48, 6.9), through the real SDK functions,
// each run in a child process whose HOME and CLAUDE_CONFIG_DIR are a mkdtemp folder with fixture transcripts. The
// user's own Claude Code folders are never touched.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROBE = join(import.meta.dir, "..", "fake-claude", "sessions-probe.ts");
const HOME = realpathSync(mkdtempSync(join(tmpdir(), "claude-sessions-")));
const CONFIG = join(HOME, ".claude");
const PROJECT = join(HOME, "work", "demo");
const PROJECTS = join(CONFIG, "projects", PROJECT.replace(/[^a-zA-Z0-9]/g, "-"));
const TERMINAL = "1b0f5c1e-1d2a-4c3b-8d4e-5f6a7b8c9d0e";
const SDK_SESSION = "2c1e6d2f-2e3b-4d4c-9e5f-6a7b8c9d0e1f";
const MISSING = "3d2f7e3a-3f4c-4e5d-8f6a-7b8c9d0e1f2a";

function line(o: Record<string, unknown>): string {
  return JSON.stringify(o) + "\n";
}
function transcript(id: string, entrypoint: string, rows: { type: "user" | "assistant"; uuid: string; content: unknown }[], cwd = PROJECT): void {
  let parent: string | null = null;
  let out = "";
  let i = 0;
  for (const r of rows) {
    out += line({
      type: r.type,
      message: r.type === "user" ? { role: "user", content: r.content } : { id: `msg_${r.uuid}`, type: "message", role: "assistant", model: "claude-fake-1", content: r.content },
      uuid: r.uuid,
      parentUuid: parent,
      sessionId: id,
      timestamp: new Date(Date.UTC(2026, 9, 31, 12, 0, i++)).toISOString(),
      cwd,
      isSidechain: false,
      userType: "external",
      entrypoint,
      version: "2.1.322",
    });
    parent = r.uuid;
  }
  const dir = join(CONFIG, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), out);
}

/** A transcript's file time, which the SDK's newest-first order reads. */
function touch(id: string, cwd: string, ms: number): void {
  utimesSync(join(CONFIG, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${id}.jsonl`), ms / 1000, ms / 1000);
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

beforeAll(() => {
  mkdirSync(PROJECT, { recursive: true });
  mkdirSync(PROJECTS, { recursive: true });
  writeFileSync(join(CONFIG, "settings.json"), JSON.stringify({ respondToBashCommands: false, cleanupPeriodDays: 21, permissions: { defaultMode: "acceptEdits" } }));
  transcript(TERMINAL, "cli", [
    { type: "user", uuid: "aaaaaaaa-0000-4000-8000-000000000001", content: "What is   in this\nfolder?" },
    { type: "assistant", uuid: "aaaaaaaa-0000-4000-8000-000000000002", content: [{ type: "text", text: "A README." }] },
    { type: "user", uuid: "aaaaaaaa-0000-4000-8000-000000000003", content: "<bash-input>ls</bash-input><bash-stdout>README.md</bash-stdout><bash-stderr></bash-stderr>" },
  ]);
  transcript(SDK_SESSION, "sdk-ts", [
    { type: "user", uuid: "bbbbbbbb-0000-4000-8000-000000000001", content: "From kitespan" },
    { type: "assistant", uuid: "bbbbbbbb-0000-4000-8000-000000000002", content: [{ type: "text", text: "ok" }] },
  ]);
});
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

describe("history (getSessionMessages)", () => {
  test("a transcript as events, the ! record parsed back", async () => {
    const r = await probe("history", { id: TERMINAL });
    expect(r.ok).toBe(true);
    expect(r.value.more).toBeNull();
    expect(r.value.events).toEqual([
      { k: "user", uuid: "aaaaaaaa-0000-4000-8000-000000000001", text: "What is   in this\nfolder?", queued: false },
      { k: "block", key: "msg_aaaaaaaa-0000-4000-8000-000000000002:0", kind: "text", text: "A README.", parent: null },
      { k: "bash", uuid: "aaaaaaaa-0000-4000-8000-000000000003", input: "ls", state: "done", stdout: "README.md", stderr: "", code: null, ms: null, timedOut: false, capped: false },
    ]);
  });
  test("small pages walk back with the cursor", async () => {
    const p1 = await probe("history", { id: TERMINAL, maxBytes: 10 });
    expect(p1.value.events).toHaveLength(1);
    expect(p1.value.more).toBe("h1:2");
    const p2 = await probe("history", { id: TERMINAL, maxBytes: 10, before: p1.value.more });
    expect(p2.value.events[0].k).toBe("block");
  });
  test("a session that does not exist gives an empty page; a bad id is a bad request", async () => {
    expect((await probe("history", { id: MISSING })).value).toEqual({ events: [], more: null });
    expect(await probe("history", { id: "not-a-uuid" })).toMatchObject({ ok: false, code: "bad_request" });
  });
});

describe("lastUsage (row 94: a chat's context figure from its transcript)", () => {
  const USAGE = "8e7f2d8a-8e9b-4d0c-9e1f-2a3b4c5d6e7f";
  // kitespan's own kind of session (sdk-ts), so the other lists here leave it out.
  const row = (uuid: string, parent: string | null, o: Record<string, unknown>) => line({ uuid, parentUuid: parent, sessionId: USAGE, timestamp: "2026-11-03T10:00:00.000Z", cwd: PROJECT, isSidechain: false, userType: "external", entrypoint: "sdk-ts", version: "2.1.322", ...o });
  const reply = (id: string, model: string, usage: Record<string, number>) => ({ type: "assistant", message: { id, type: "message", role: "assistant", model, content: [{ type: "text", text: "ok" }], usage } });
  test("the main session's last reply with a usage: its input, cached or not, and its output, with its model", async () => {
    const u = (n: number) => `dddddddd-0000-4000-8000-00000000000${n}`;
    writeFileSync(
      join(PROJECTS, `${USAGE}.jsonl`),
      row(u(1), null, { type: "user", message: { role: "user", content: "hi" } }) +
        row(u(2), u(1), reply("msg_1", "claude-haiku-5-5", { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 })) +
        row(u(3), u(2), { type: "user", message: { role: "user", content: "and now?" } }) +
        row(u(4), u(3), reply("msg_2", "claude-opus-5-5", { input_tokens: 3, cache_creation_input_tokens: 1200, cache_read_input_tokens: 40000, output_tokens: 797 })) +
        // A line of Claude Code's own after it counts nothing.
        row(u(5), u(4), reply("msg_3", "<synthetic>", { input_tokens: 0, output_tokens: 0 })),
    );
    expect((await probe("usage", { id: USAGE })).value).toEqual({ model: "claude-opus-5-5", usedTokens: 42000 });
  });
  test("a reply on a provider's ARN (the default model on Bedrock) reads as the default row, never the ARN", async () => {
    const id = "9f8a3e9b-9fac-4e1d-8f2a-3b4c5d6e7f80";
    // Put together here, so the source holds no account id.
    const arn = ["arn", "aws", "bedrock", "us-west-2", "4321".repeat(3), "application-inference-profile/fdtestprofile"].join(":");
    const at = (o: Record<string, unknown>) => row("eeeeeeee-0000-4000-8000-000000000001", null, { ...o, sessionId: id });
    writeFileSync(join(PROJECTS, `${id}.jsonl`), at(reply("msg_arn", arn, { input_tokens: 100, output_tokens: 20 })));
    const r = await probe("usage", { id });
    expect(r.value).toEqual({ model: "default", usedTokens: 120 });
    expect(JSON.stringify(r)).not.toContain("arn:");
  });
  test("none for a transcript with no reply, a session that does not exist and a bad id", async () => {
    expect((await probe("usage", { id: TERMINAL })).value).toBeNull();
    expect((await probe("usage", { id: MISSING })).value).toBeNull();
    expect((await probe("usage", { id: "not-a-uuid" })).value).toBeNull();
  });
});

describe("sessionInfo, listSessions (From the terminal), rename and delete", () => {
  test("sessionInfo: the title is the first prompt with whitespace folded; null when no transcript exists (D41)", async () => {
    expect((await probe("info", { id: TERMINAL })).value).toMatchObject({ sessionId: TERMINAL, title: "What is in this folder?", customTitle: null });
    expect((await probe("info", { id: MISSING })).value).toBeNull();
  });

  test("listSessions leaves the SDK's own sessions out (includeProgrammatic false, live L5)", async () => {
    const r = await probe("list", {});
    expect(r.ok).toBe(true);
    expect(r.value.map((s: { sessionId: string }) => s.sessionId)).toEqual([TERMINAL]);
  });

  test("rename writes the custom title that the title then shows; a blank or long title is refused", async () => {
    const r = await probe("rename", { id: TERMINAL, title: "  Folder tour  " });
    expect(r.value).toMatchObject({ title: "Folder tour", customTitle: "Folder tour" });
    expect(readFileSync(join(PROJECTS, `${TERMINAL}.jsonl`), "utf8")).toContain('"customTitle":"Folder tour"');
    expect(await probe("rename", { id: TERMINAL, title: "   " })).toMatchObject({ ok: false, code: "bad_request" });
    expect(await probe("rename", { id: TERMINAL, title: "x".repeat(121) })).toMatchObject({ ok: false, code: "bad_request" });
  });

  test("delete removes the transcript (D48), and deleting it again is not an error", async () => {
    expect(existsSync(join(PROJECTS, `${SDK_SESSION}.jsonl`))).toBe(true);
    expect((await probe("delete", { id: SDK_SESSION })).value).toBeNull();
    expect(existsSync(join(PROJECTS, `${SDK_SESSION}.jsonl`))).toBe(false);
    expect(await probe("delete", { id: SDK_SESSION })).toEqual({ ok: true, value: null });
  });
});

describe("sessionFolders (New environment's Suggested, D54)", () => {
  test("the folders of the newest sessions in every folder, newest first, each once, the SDK's own left out", async () => {
    const older = join(HOME, "work", "older");
    const newer = join(HOME, "work", "newer");
    const sdkOnly = join(HOME, "work", "sdk-only");
    const ids = ["4e3a8f4b-4a5d-4f6e-9a7b-8c9d0e1f2a3b", "5f4b9a5c-5b6e-4a7f-8b8c-9d0e1f2a3b4c", "6a5c0b6d-6c7f-4b8a-9c9d-0e1f2a3b4c5d", "7b6d1c7e-7d8a-4c9b-8d0e-1f2a3b4c5d6e"];
    transcript(ids[0]!, "cli", [{ type: "user", uuid: "cccccccc-0000-4000-8000-000000000001", content: "old" }], older);
    transcript(ids[1]!, "cli", [{ type: "user", uuid: "cccccccc-0000-4000-8000-000000000002", content: "new" }], newer);
    transcript(ids[2]!, "cli", [{ type: "user", uuid: "cccccccc-0000-4000-8000-000000000003", content: "new again" }], newer);
    transcript(ids[3]!, "sdk-ts", [{ type: "user", uuid: "cccccccc-0000-4000-8000-000000000004", content: "from kitespan" }], sdkOnly);
    const t = Date.UTC(2026, 9, 31, 12);
    touch(TERMINAL, PROJECT, t - 60_000);
    touch(ids[0]!, older, t - 3 * 60_000);
    touch(ids[1]!, newer, t);
    touch(ids[2]!, newer, t - 2 * 60_000);
    touch(ids[3]!, sdkOnly, t + 60_000);
    const r = await probe("folders", {});
    expect(r.ok).toBe(true);
    expect(r.value).toEqual([newer, PROJECT, older]);
  });
});

describe("settings (resolveSettings only, never a write)", () => {
  test("respondToBashCommands, cleanupPeriodDays, promptSuggestionEnabled absent counts as off, defaultMode", async () => {
    const before = readFileSync(join(CONFIG, "settings.json"), "utf8");
    const r = await probe("settings", {});
    expect(r.value).toEqual({ respondToBash: false, cleanupPeriodDays: 21, promptSuggestions: false, defaultMode: "acceptEdits" });
    expect(readFileSync(join(CONFIG, "settings.json"), "utf8")).toBe(before);
  });
});

describe("listReleased (row 99: the sessions that a removed environment released)", () => {
  test("the SDK's own too, only the ids asked for, read under the folder that holds them: a gone worktree's too", async () => {
    // A worktree chat's transcript is filed under its worktree's name; the worktree may be gone (never made here).
    const gone = join(HOME, "data", "kitespan", "worktrees", "k3m7q2x4ab", "abcdefgh");
    const inTree = "a1b2c3d4-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
    const inProject = "b2c3d4e5-2b3c-4d4e-9f5a-6b7c8d9e0f1a";
    transcript(inTree, "sdk-ts", [{ type: "user", uuid: "ffffffff-0000-4000-8000-000000000001", content: "In the worktree" }], gone);
    transcript(inProject, "sdk-ts", [{ type: "user", uuid: "ffffffff-0000-4000-8000-000000000002", content: "In the project" }]);
    const ids = (r: { value?: { sessionId: string }[] }) => (r.value ?? []).map((x) => x.sessionId).sort();
    expect(ids(await probe("released", { cwd: gone, ids: [inTree, inProject, MISSING] }))).toEqual([inTree]);
    expect(ids(await probe("released", { cwd: PROJECT, ids: [inTree, inProject] }))).toEqual([inProject]);
    expect((await probe("released", { cwd: PROJECT, ids: [] })).value).toEqual([]);
    // From the terminal's own list never shows either.
    expect(ids(await probe("list", {}))).not.toContain(inProject);
  });
});
