// U5 (DESIGN-U5 10 "Read through the seam"): the driver's transcriptEvents, through the real SDK reader, in a child
// process whose HOME and CLAUDE_CONFIG_DIR are a mkdtemp folder with a transcript in the fake claude's record shape
// (one assistant record per block, thinking, a tool call and its result, a `!` record): every event oldest first with
// no page cut, and the message search's extraction of them under the page's row ids. The user's own Claude Code
// folders are never touched.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatEvent } from "../../shared/protocol";
import { searchableMessages } from "../../server/search/text";

const PROBE = join(import.meta.dir, "..", "fake-claude", "sessions-probe.ts");
const HOME = realpathSync(mkdtempSync(join(tmpdir(), "claude-transcript-")));
const CONFIG = join(HOME, ".claude");
const PROJECT = join(HOME, "work", "demo");
const SESSION = "4e3a8f4b-4a5d-4f6e-8a7b-8c9d0e1f2a3b";
const BIG = "5f4b9a5c-5b6e-4a7f-9b8c-9d0e1f2a3b4c";
/** A compacted transcript: Claude Code's compact_boundary record, then its summary record (FIX-U5 review, finding 1). */
const COMPACT = "7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d";
/** Claude Code's own synthetic reply (an API error): its words are not Claude's reply (finding 4). */
const SYNTH = "8b7c6d5e-4f3a-4b2c-9d0e-1f2a3b4c5d6e";

/** Records as Claude Code writes them, each with its own fields (a compaction's records carry flags of their own). */
function rawTranscript(id: string, rows: Record<string, unknown>[]): void {
  const base = { sessionId: id, cwd: PROJECT, isSidechain: false, userType: "external", entrypoint: "sdk-ts", version: "2.1.318" };
  const out = rows.map((r, i) => `${JSON.stringify({ ...base, timestamp: new Date(Date.UTC(2026, 10, 6, 10, 0, i)).toISOString(), ...r })}\n`).join("");
  const dir = join(CONFIG, "projects", PROJECT.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), out);
}

/** A transcript in the fake claude's shape (test/fake-claude/fake-claude.ts record()). */
function transcript(id: string, rows: { type: "user" | "assistant"; uuid: string; message: unknown }[]): void {
  let parent: string | null = null;
  let out = "";
  rows.forEach((r, i) => {
    out += `${JSON.stringify({ type: r.type, message: r.message, uuid: r.uuid, parentUuid: parent, sessionId: id, timestamp: new Date(Date.UTC(2026, 10, 6, 9, 0, i)).toISOString(), cwd: PROJECT, isSidechain: false, userType: "external", entrypoint: "sdk-ts", version: "2.1.318" })}\n`;
    parent = r.uuid;
  });
  const dir = join(CONFIG, "projects", PROJECT.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), out);
}
const u = (n: number) => `cccccccc-0000-4000-8000-${String(n).padStart(12, "0")}`;
const assistant = (msgId: string, block: unknown) => ({ id: msgId, type: "message", role: "assistant", model: "claude-fake-1", content: [block], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });

async function probe(op: string, args: Record<string, unknown>): Promise<{ ok: boolean; value?: any; code?: string | null }> {
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
  transcript(SESSION, [
    { type: "user", uuid: u(1), message: { role: "user", content: "Where is the zebra cache?" } },
    { type: "assistant", uuid: u(2), message: assistant("msg_01T", { type: "thinking", thinking: "the walrus thinks", signature: "x" }) },
    { type: "assistant", uuid: u(3), message: assistant("msg_01T", { type: "text", text: "Let me **look**." }) },
    { type: "assistant", uuid: u(4), message: assistant("msg_01T", { type: "tool_use", id: "toolu_01Z", name: "Bash", input: { command: "grep -r ostrich ." } }) },
    { type: "user", uuid: u(5), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01Z", content: "src/ostrich.ts: ostrich" }] } },
    { type: "assistant", uuid: u(6), message: assistant("msg_02T", { type: "text", text: "The zebra cache is in `src/cache.ts`." }) },
    { type: "user", uuid: u(7), message: { role: "user", content: "<bash-input>echo penguin</bash-input><bash-stdout>penguin</bash-stdout><bash-stderr></bash-stderr>" } },
  ]);
  // A transcript over two history pages (252 KiB each): transcriptEvents has no page cut.
  const rows: { type: "user" | "assistant"; uuid: string; message: unknown }[] = [];
  for (let i = 0; i < 300; i++) {
    rows.push({ type: "user", uuid: u(1_000 + 2 * i), message: { role: "user", content: `question ${i} ${"q".repeat(1_000)}` } });
    rows.push({ type: "assistant", uuid: u(1_001 + 2 * i), message: assistant(`msg_big${i}`, { type: "text", text: `answer ${i} ${"a".repeat(1_000)}` }) });
  }
  transcript(BIG, rows);
  // Claude Code's compaction: the boundary (a root, its old parent only as logicalParentUuid), then the summary as a
  // user record that retells the earlier turns, a tool's output and Claude's thinking included.
  rawTranscript(COMPACT, [
    { type: "user", uuid: u(2_001), parentUuid: null, message: { role: "user", content: "Print the deploy settings" } },
    { type: "assistant", uuid: u(2_002), parentUuid: u(2_001), message: assistant("msg_c1", { type: "tool_use", id: "toolu_c1", name: "Bash", input: { command: "cat .env" } }) },
    { type: "user", uuid: u(2_003), parentUuid: u(2_002), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_c1", content: "RELEASE_TARGET=quokka-west" }] } },
    { type: "assistant", uuid: u(2_004), parentUuid: u(2_003), message: assistant("msg_c2", { type: "text", text: "Done." }) },
    { type: "system", uuid: u(2_005), parentUuid: null, logicalParentUuid: u(2_004), subtype: "compact_boundary", content: "Conversation compacted", isMeta: false, level: "info", compactMetadata: { trigger: "manual", preTokens: 12_345 } },
    {
      type: "user",
      uuid: u(2_006),
      parentUuid: u(2_005),
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
      message: { role: "user", content: "This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n1. The Bash tool printed RELEASE_TARGET=quokka-west from .env.\n2. Thinking: the walrus plan." },
    },
    { type: "user", uuid: u(2_007), parentUuid: u(2_006), message: { role: "user", content: "What comes next?" } },
    { type: "assistant", uuid: u(2_008), parentUuid: u(2_007), message: assistant("msg_c3", { type: "text", text: "Next, the release." }) },
  ]);
  rawTranscript(SYNTH, [
    { type: "user", uuid: u(3_001), parentUuid: null, message: { role: "user", content: "Run the release" } },
    {
      type: "assistant",
      uuid: u(3_002),
      parentUuid: u(3_001),
      isApiErrorMessage: true,
      message: { id: "d1b2c3d4-0000-4000-8000-000000000009", type: "message", role: "assistant", model: "<synthetic>", content: [{ type: "text", text: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' }], stop_reason: "stop_sequence", stop_sequence: "", usage: { input_tokens: 0, output_tokens: 0 } },
    },
    { type: "user", uuid: u(3_003), parentUuid: u(3_002), message: { role: "user", content: "Try again" } },
    { type: "assistant", uuid: u(3_004), parentUuid: u(3_003), message: assistant("msg_s1", { type: "text", text: "The release is out." }) },
  ]);
});
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

describe("transcriptEvents (getSessionMessages, historyEvents, no page cut)", () => {
  test("every event, oldest first, as history maps them", async () => {
    const r = await probe("transcript", { id: SESSION });
    expect(r.ok).toBe(true);
    const events = r.value as ChatEvent[];
    expect(events.map((e) => e.k)).toEqual(["user", "block", "block", "tool_call", "tool_result", "block", "bash"]);
    expect(events[2]).toMatchObject({ k: "block", key: "msg_01T:1", kind: "text", text: "Let me **look**." });
  });

  test("the search keeps the user's words and the replies, under the page's row ids, each with who said it", async () => {
    const events = (await probe("transcript", { id: SESSION })).value as ChatEvent[];
    expect(searchableMessages(events)).toEqual([
      { id: u(1), by: "user", text: "Where is the zebra cache?" },
      { id: "msg_01T-1", by: "agent", text: "Let me look." },
      { id: "msg_02T-0", by: "agent", text: "The zebra cache is in src/cache.ts." },
    ]);
  });

  test("a transcript longer than a history page comes whole", async () => {
    const page = await probe("history", { id: BIG });
    expect(page.value.more).not.toBeNull();
    const all = (await probe("transcript", { id: BIG })).value as ChatEvent[];
    expect(all).toHaveLength(600);
    expect(all[0]).toMatchObject({ k: "user", uuid: u(1_000) });
  });

  test("a compaction's summary is not the user's message: neither the chat nor the search shows its words", async () => {
    const events = (await probe("transcript", { id: COMPACT })).value as ChatEvent[];
    const kept = searchableMessages(events);
    expect(kept.map((m) => m.text)).toEqual(["What comes next?", "Next, the release."]);
    for (const word of ["quokka", "RELEASE_TARGET", "walrus", "being continued"]) expect(JSON.stringify(kept)).not.toContain(word);
    // The chat's history draws no bubble for it either (the live chat never did).
    const page = (await probe("history", { id: COMPACT })).value as { events: ChatEvent[] };
    expect(page.events.filter((e) => e.k === "user").map((e) => (e as { text: string }).text)).toEqual(["What comes next?"]);
    expect(JSON.stringify(page.events)).not.toContain("being continued");
  });

  test("Claude Code's own synthetic reply (an API error) is not searched; the chat still shows it", async () => {
    const kept = searchableMessages((await probe("transcript", { id: SYNTH })).value as ChatEvent[]);
    expect(kept.map((m) => m.text)).toEqual(["Run the release", "Try again", "The release is out."]);
    const page = (await probe("history", { id: SYNTH })).value as { events: ChatEvent[] };
    expect(page.events.some((e) => e.k === "block" && e.text.startsWith("API Error: 529"))).toBe(true);
  });

  test("a session id that is not one is refused; a transcript that is gone gives no events", async () => {
    expect(await probe("transcript", { id: "../../etc" })).toMatchObject({ ok: false, code: "bad_request" });
    expect(await probe("transcript", { id: "6a5c0b6d-6c7f-4b8a-8c9d-0e1f2a3b4c5d" })).toEqual({ ok: true, value: [] });
  });
});
