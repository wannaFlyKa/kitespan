// R124 end to end in one process: the chat registry, the real Claude driver and the Agent SDK, and the fake claude
// (test/fake-claude/), which answers `side_question` as the lead's probe found Claude Code 2.1.317 does. A side question
// on a chat whose Claude Code sleeps starts it with `--resume` and no message, and answers; a follow-up goes with the
// first exchange as history; one asked while a Bash call runs answers and the turn goes on; Stop cancels it in Claude
// Code ("Side question cancelled") and takes it out of the thread; the process's end fails one in flight. No message of
// a side question reaches Claude Code. The SDK's session reads are fakes, so no folder of the user's own Claude Code is
// read; the real claude never runs.
import { afterAll, describe, expect, test } from "bun:test";
import type { NewChatFrame, SideExchange } from "../../shared/protocol";
import { ChatRegistry } from "../../server/chats/registry";
import { MemoryStore, RecordingViewer, apply, projectRecord } from "../../server/chats/testing";
import type { Outcome } from "../../server/chats/types";
import { rig, type Rig } from "../fake-claude/harness";
import type { Fixture } from "../fake-claude/install";

const PROJECT = "k3m7q2x4ab";
const rid = () => crypto.randomUUID();

const fixture: Fixture = {
  sideByText: { "the slow one": { delayMs: 30_000 } },
  turnsByText: {
    "long bash": {
      steps: [
        { say: { id: "msg_se_1", tools: [{ id: "toolu_se_1", name: "Bash", input: { command: "sleep 2; echo SLEPT" } }] } },
        { sleep: 1_500 },
        { emit: { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_se_1", content: "SLEPT" }] }, parent_tool_use_id: null } },
        { say: { id: "msg_se_2", text: "MAIN-DONE" } },
        { emit: { type: "result", subtype: "success", result: "MAIN-DONE" } },
      ],
    },
  },
};

const fakes = {
  resolveSettings: (async () => ({ effective: {} })) as never,
  filterEscalatingDefaultMode: ((x: unknown) => x) as never,
  getSessionInfo: (async () => undefined) as never,
  getSessionMessages: (async () => []) as never,
};
const r: Rig = rig(fixture, { sdk: fakes });
const store = new MemoryStore();
store.projects = [projectRecord(PROJECT, r.fake.project)];
const reg = new ChatRegistry({ driver: r.driver, store }, { idleMs: 300, closeGraceMs: 2_000, shutdownMs: 8_000 });
afterAll(async () => {
  await reg.shutdown();
  await r.cleanup();
});

async function until(pred: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}
async function newChat(text: string): Promise<string> {
  const f: NewChatFrame = { t: "new_chat", rid: rid(), project: PROJECT, uuid: rid(), text, picks: { model: null, effort: null, mode: null }, uploads: [] };
  const o = await apply(reg, f);
  if (!o.ok) throw new Error(`new_chat refused: ${o.code}`);
  return (o.result as { chat: string }).chat;
}
const ask = (chat: string, text: string, id = rid()) => apply(reg, { t: "side_question", rid: rid(), chat, id, text });
const answered = (o: Outcome): SideExchange => {
  if (!o.ok) throw new Error(`refused: ${o.code}`);
  return (o.result as { answered: SideExchange }).answered;
};
const starts = () => r.fake.trace().filter((l) => l.t === "start");
const userLines = () => r.fake.trace().filter((l) => l.t === "user");

describe("the side chat with the fake claude", () => {
  test("a sleeping chat's side question starts its Claude Code with --resume and no message, and a follow-up reads the first", async () => {
    await reg.boot();
    const chat = await newChat("Plan the upload feature");
    await until(() => reg.stateOf(chat) === "idle", "the first turn's end");
    // No page and no work: the idle rule puts it to sleep.
    await until(() => reg.stateOf(chat) === "sleeping", "the idle close", 8_000);
    const before = { starts: starts().length, users: userLines().length };
    const page = new RecordingViewer();
    await reg.attach(chat, page);
    const a = answered(await ask(chat, "Which file holds the cap?"));
    expect(a.answer).toBe('Side answer to "Which file holds the cap?" (history 0).');
    expect(starts().length).toBe(before.starts + 1);
    expect((starts().at(-1)!.args as string[]).some((x) => x.startsWith("--resume"))).toBe(true);
    expect(userLines().length).toBe(before.users);
    expect(reg.stateOf(chat)).toBe("idle");
    const b = answered(await ask(chat, "Which test reads it?"));
    expect(b.answer).toBe('Side answer to "Which test reads it?" (history 1: Which file holds the cap? -> Side answer to "Which file holds the cap?" (history 0).).');
    // Only side events reached the page: no turn, no message.
    expect(page.events.filter((e) => e.k === "turn_start" || e.k === "user" || e.k === "notice")).toEqual([]);
    expect(page.events.filter((e) => e.k === "side").map((e) => e.k === "side" && e.x.state)).toEqual(["asking", "answered", "asking", "answered"]);
    reg.detach(chat, page);
  }, 30_000);

  test("while a Bash call runs: the side question answers, and the turn goes on to its end", async () => {
    const chat = await newChat("long bash: run it");
    const page = new RecordingViewer();
    await reg.attach(chat, page);
    await until(() => page.events.some((e) => e.k === "tool_call" && e.id === "toolu_se_1" && e.input !== null), "the Bash call");
    const a = answered(await ask(chat, "What colour is a clear daytime sky?"));
    expect(a.answer).toContain("What colour is a clear daytime sky?");
    expect(page.events.some((e) => e.k === "turn_end")).toBe(false);
    await until(() => page.events.some((e) => e.k === "turn_end"), "the turn's end");
    expect(page.events.find((e) => e.k === "turn_end")).toMatchObject({ ok: true });
    expect(r.fake.trace().filter((l) => l.t === "side_question").at(-1)).toMatchObject({ duringTurn: true });
    reg.detach(chat, page);
  }, 30_000);

  test("Stop cancels it in Claude Code and takes it out of the thread; the process's end fails one in flight", async () => {
    const chat = await newChat("Plan the search index");
    const page = new RecordingViewer();
    await reg.attach(chat, page);
    await until(() => reg.stateOf(chat) === "idle", "the first turn's end");
    const id = rid();
    const q = ask(chat, "Walk me through the slow one", id);
    const asked = await r.fake.waitFor((l) => l.t === "side_question" && l.question === "Walk me through the slow one");
    expect(await apply(reg, { t: "side_stop", rid: rid(), chat, id })).toEqual({ ok: true, result: { stopped: true } });
    expect(await q).toEqual({ ok: true, result: { stopped: true } });
    await r.fake.waitFor((l) => l.t === "side_cancelled" && l.id === asked.id);
    const thread = (await apply(reg, { t: "get", rid: rid(), chat, what: "side" })) as { ok: true; result: { exchanges: SideExchange[] } };
    expect(thread.result.exchanges).toEqual([]);
    // Another one in flight when the chat's Claude Code is closed (Archive): it does not finish, and the thread says so.
    const q2 = ask(chat, "Is the slow one done yet?");
    await r.fake.waitFor((l) => l.t === "side_question" && l.question === "Is the slow one done yet?");
    expect((await apply(reg, { t: "archive", rid: rid(), chat, on: true, stop: false })).ok).toBe(true);
    expect(await q2).toEqual({ ok: false, code: "archived" });
    await until(() => reg.stateOf(chat) === "sleeping", "the archive's close");
    reg.detach(chat, page);
  }, 30_000);
});
