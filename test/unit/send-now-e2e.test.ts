// Row 111 end to end in one process: the chat registry, the real Claude driver and the Agent SDK, and the fake claude
// (test/fake-claude/), which runs the shapes of the lead's live probe (LIVE-NOTES items 15 to 17): A, a message queued
// during a foreground Bash call goes into the same turn at the call's end; B, Send now during a Bash call whose task has
// not started waits for its task_started, moves it to the background (backgroundTasks with no tool use), and Claude
// reads the message in the same turn while the command's end later starts a turn of its own; C, Send now while Claude
// only writes stops the turn with a plain interrupt, and the message runs next; Ctrl+Enter's message and press, sent
// together, reach Claude Code in that order. Each message reaches Claude Code once.
// The SDK's session reads are fakes, so no folder of the user's own Claude Code is read; the real claude never runs.
import { afterAll, describe, expect, test } from "bun:test";
import { TURN_INTERRUPTED, type NewChatFrame } from "../../shared/protocol";
import { ChatRegistry } from "../../server/chats/registry";
import { MemoryStore, RecordingViewer, apply, projectRecord } from "../../server/chats/testing";
import { rig, type Rig } from "../fake-claude/harness";
import type { Fixture, Step } from "../fake-claude/install";

const PROJECT = "k3m7q2x4ab";
const rid = () => crypto.randomUUID();
const result = (text: string): Step => ({ emit: { type: "result", subtype: "success", result: text } });
const STORY = "Kites rose over the city in the morning wind, red and gold above the roofs. ".repeat(12);

const fixture: Fixture = {
  turnsByText: {
    // A: a Bash call that ends by itself; what waits goes into the turn at its tool boundary.
    "case A": {
      fold: true,
      steps: [
        { say: { id: "msg_sn_a1", tools: [{ id: "toolu_sn_a", name: "Bash", input: { command: "sleep 1; echo SLEPT" } }] } },
        { task: { toolUseId: "toolu_sn_a", startMs: 100, runMs: 600, output: "SLEPT" } },
        { say: { id: "msg_sn_a2", text: "DONE-A QUEUED-B" } },
        result("DONE-A QUEUED-B"),
      ],
    },
    // B: a long Bash call whose task starts late (Claude Code took about 4 s on the probe's host).
    "case B": {
      fold: true,
      steps: [
        { say: { id: "msg_sn_b1", tools: [{ id: "toolu_sn_b", name: "Bash", input: { command: "sleep 18; echo SLEPT" } }] } },
        { task: { toolUseId: "toolu_sn_b", taskId: "bsnb0001", startMs: 1_500, runMs: 4_000, output: "SLEPT" } },
        { say: { id: "msg_sn_b2", text: "DONE-C QUEUED-D" } },
        result("DONE-C QUEUED-D"),
      ],
    },
    // Ctrl+Enter: a Bash call whose task is running when the message and the press go together.
    "case K": {
      fold: true,
      steps: [
        { say: { id: "msg_sn_k1", tools: [{ id: "toolu_sn_k", name: "Bash", input: { command: "sleep 18" } }] } },
        { task: { toolUseId: "toolu_sn_k", taskId: "bsnk0001", startMs: 50, runMs: 3_000, output: "" } },
        { say: { id: "msg_sn_k2", text: "QUEUED-K" } },
        result("QUEUED-K"),
      ],
    },
    // C: Claude only writes, slowly.
    "case C": { steps: [{ say: { id: "msg_sn_c1", text: STORY, chunks: 60, paceMs: 60 } }, result(STORY)] },
    "QUEUED-F": { steps: [{ say: { id: "msg_sn_f1", text: "QUEUED-F" } }, result("QUEUED-F")] },
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
const reg = new ChatRegistry({ driver: r.driver, store }, { idleMs: 60_000, closeGraceMs: 2_000, shutdownMs: 8_000 });
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
async function newChat(text: string): Promise<{ chat: string; uuid: string; v: RecordingViewer }> {
  const f: NewChatFrame = { t: "new_chat", rid: rid(), project: PROJECT, uuid: rid(), text, picks: { model: null, effort: null, mode: null }, uploads: [] };
  const o = await apply(reg, f);
  if (!o.ok) throw new Error(`new_chat refused: ${o.code}`);
  const chat = (o.result as { chat: string }).chat;
  const v = new RecordingViewer();
  await reg.attach(chat, v);
  return { chat, uuid: f.uuid, v };
}
async function send(chat: string, text: string): Promise<string> {
  const u = rid();
  const o = await apply(reg, { t: "send", rid: u, chat, uuid: u, text, draftRev: null, uploads: [] });
  if (!o.ok) throw new Error(`send refused: ${o.code}`);
  return u;
}
const ends = (v: RecordingViewer) => v.of("turn_end");
const queuedNow = (v: RecordingViewer, uuid: string) => v.of("user").filter((e) => e.uuid === uuid).at(-1)?.queued;
/** Each user message that the fake claude got, by uuid: every one exactly once. */
const sentOnce = () => {
  const uuids = r.fake.trace().filter((l) => l.t === "user").map((l) => l.uuid as string);
  return uuids.length === new Set(uuids).size;
};

describe("Send now with the fake claude", () => {
  test("A: a message queued during a Bash call goes into the same turn at the call's end, and leaves Queued then", async () => {
    await reg.boot();
    const { chat, uuid, v } = await newChat("case A: run the command");
    await until(() => v.events.some((e) => e.k === "tool_call" && e.id === "toolu_sn_a"), "the Bash call");
    const m2 = await send(chat, "Also reply with QUEUED-B.");
    expect(queuedNow(v, m2)).toBe(true);
    await until(() => ends(v).length >= 1, "the turn's end");
    // One turn answered both; the message went in before the reply that answered it.
    expect(ends(v)).toHaveLength(1);
    expect(ends(v)[0]!.uuids).toEqual([uuid, m2]);
    const kinds = v.events.map((e) => (e.k === "user" ? `user ${e.queued}` : e.k === "block_start" ? "reply" : e.k));
    expect(kinds.indexOf("user false")).toBeGreaterThan(kinds.indexOf("tool_result"));
    expect(kinds.indexOf("user false")).toBeLessThan(kinds.lastIndexOf("reply"));
    expect(r.fake.trace().filter((l) => l.t === "fold").map((l) => l.uuid)).toEqual([m2]);
    expect((await store.readQueue(chat))?.msgs ?? []).toEqual([]);
    expect(sentOnce()).toBe(true);
  }, 20_000);

  test("B: Send now before the Bash call's task starts waits for it, moves it to the background, and Claude reads the message in the same turn", async () => {
    const { chat, uuid, v } = await newChat("case B: run the long command");
    await until(() => v.events.some((e) => e.k === "tool_call" && e.id === "toolu_sn_b"), "the Bash call");
    const m2 = await send(chat, "Reply with the word QUEUED-D now.");
    const early = !r.fake.trace().some((l) => l.t === "task_started" && l.task === "bsnb0001");
    const o = await apply(reg, { t: "send_now", rid: rid(), chat, uuid: m2 });
    expect(o).toEqual({ ok: true, result: { acted: "background" } });
    // The press came before the task's start (1.5 s after the call), and its request waited for it.
    expect(early).toBe(true);
    const lines = r.fake.trace();
    const startAt = lines.findIndex((l) => l.t === "task_started" && l.task === "bsnb0001");
    const askAt = lines.findIndex((l) => l.t === "control" && l.subtype === "background_tasks");
    expect(startAt).toBeGreaterThanOrEqual(0);
    expect(askAt).toBeGreaterThan(startAt);
    const asks = lines.filter((l) => l.t === "control" && l.subtype === "background_tasks");
    expect(asks).toHaveLength(1);
    expect((asks[0]!.request as Record<string, unknown>).tool_use_id).toBeUndefined();
    await until(() => ends(v).length >= 1, "the turn's end");
    const result = v.of("tool_result").find((e) => e.id === "toolu_sn_b")!;
    expect(result.text).toStartWith("Command was manually backgrounded by user with ID: bsnb0001.");
    expect(ends(v)[0]!.uuids).toEqual([uuid, m2]);
    expect(queuedNow(v, m2)).toBe(false);
    // The work runs on in the background; its end starts a turn of its own, by the agent.
    expect(v.of("tasks").at(-1)?.running.map((t) => t.taskId)).toEqual(["bsnb0001"]);
    await until(() => ends(v).length >= 2, "the notification's turn", 10_000);
    expect(v.of("turn_start").at(-1)?.by).toBe("agent");
    expect(v.of("tasks").at(-1)?.running).toEqual([]);
    // A press after it was read does nothing and says nothing.
    expect(await apply(reg, { t: "send_now", rid: rid(), chat, uuid: m2 })).toEqual({ ok: true, result: { acted: "none" } });
    expect(sentOnce()).toBe(true);
  }, 30_000);

  test("Ctrl+Enter: the message and the press sent together; the message reaches Claude Code first and goes into the same turn", async () => {
    const { chat, uuid, v } = await newChat("case K: run the command");
    await until(() => v.of("task").some((e) => e.ev === "started" && e.taskId === "bsnk0001"), "the task's start");
    const u = rid();
    const [sent, pressed] = await Promise.all([
      apply(reg, { t: "send", rid: u, chat, uuid: u, text: "Reply with QUEUED-K.", draftRev: null, uploads: [] }),
      apply(reg, { t: "send_now", rid: rid(), chat, uuid: u }),
    ]);
    expect(sent.ok).toBe(true);
    expect(pressed).toEqual({ ok: true, result: { acted: "background" } });
    await until(() => ends(v).length >= 1, "the turn's end");
    expect(ends(v)[0]!.uuids).toEqual([uuid, u]);
    const lines = r.fake.trace();
    const userAt = lines.findIndex((l) => l.t === "user" && l.uuid === u);
    const askAt = lines.findIndex((l, i) => i > userAt - 1 && l.t === "control" && l.subtype === "background_tasks");
    expect(userAt).toBeGreaterThanOrEqual(0);
    expect(askAt).toBeGreaterThan(userAt);
    expect(sentOnce()).toBe(true);
  }, 20_000);

  test("C: Send now while Claude only writes stops the turn as Stop does, and the message runs next, once", async () => {
    const { chat, uuid, v } = await newChat("case C: write a story");
    await until(() => v.of("block_delta").length >= 3, "the story's stream");
    const m2 = await send(chat, "Stop the story. Reply with the word QUEUED-F only.");
    expect(await apply(reg, { t: "send_now", rid: rid(), chat, uuid: m2 })).toEqual({ ok: true, result: { acted: "interrupt" } });
    await until(() => ends(v).length >= 2, "the two turns' ends");
    const [stopped, next] = ends(v);
    expect(stopped).toMatchObject({ ok: false, subtype: TURN_INTERRUPTED, error: null, uuids: [uuid] });
    expect(next).toMatchObject({ ok: true, uuids: [m2] });
    // No request but the interrupt: B's and Ctrl+Enter's backgroundTasks are the only two.
    expect(r.fake.trace().filter((l) => l.t === "control" && l.subtype === "background_tasks")).toHaveLength(2);
    expect(r.fake.trace().filter((l) => l.t === "control" && l.subtype === "interrupt")).toHaveLength(1);
    expect(queuedNow(v, m2)).toBe(false);
    // The queued message's own reply, in the turn after the stop.
    expect(v.of("block_start").some((b) => b.key.startsWith("msg_sn_f1"))).toBe(true);
    expect(sentOnce()).toBe(true);
  }, 30_000);
});
