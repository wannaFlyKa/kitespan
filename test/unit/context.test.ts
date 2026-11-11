// Row 94 (the owner: some chats show no context use until a message runs their agent): a chat's context figure with
// no live Claude Code. A live read answers as before and is kept: with the chat (its notes) and its model's window with
// the chat's project. A sleeping chat, and every chat after a restart, answers the kept read; a chat with none (an
// older chat, a session from another app) answers its transcript's last usage against the window that the last live
// read of that model reported, as one used part, and null when that window is not known. No read starts a Claude Code
// process. The scripted driver stands in for Claude Code; the real claude never runs.

import { describe, expect, test } from "bun:test";
import type { ChatEvent, ContextInfo } from "../../shared/protocol";
import { lastReplyUsage } from "../../server/agents/claude/events";
import { ChatContexts, TRANSCRIPT_PART, transcriptFigure, windowOf, windowsWith } from "../../server/chats/context";
import { ChatRegistry } from "../../server/chats/registry";
import { FakeBash, FakeDriver, MemoryStore, apply, projectRecord, settle } from "../../server/chats/testing";
import { contextNoteFrom, contextNoteOf, contextWindowsFrom } from "../../server/store/context";
import { notesForSave, notesFrom } from "../../server/store/notes";
import { projectFrom } from "../../server/store/records";
import { STORE_LIMITS } from "../../server/store/types";

const PROJECT = "k3m7q2x4ab";
const OTHER = "abcdefghij";
const CWD = "/srv/work/app";
const CWD2 = "/srv/work/other";
const rid = () => crypto.randomUUID();

/** A live read as Claude Code's getContextUsage gives it (driver.ts context()). */
const READ: ContextInfo = {
  model: "claude-opus-5-5",
  usedTokens: 46_000,
  maxTokens: 200_000,
  percent: 23,
  parts: [
    { name: "System prompt", tokens: 6_000, kind: "used" },
    { name: "Messages", tokens: 40_000, kind: "used" },
    { name: "Free space", tokens: 154_000, kind: "free" },
  ],
};

async function setup(prep?: (d: FakeDriver, s: MemoryStore) => void) {
  const driver = new FakeDriver();
  const store = new MemoryStore();
  const bash = new FakeBash();
  store.projects = [projectRecord(PROJECT, CWD), projectRecord(OTHER, CWD2)];
  prep?.(driver, store);
  const reg = new ChatRegistry({ driver, store, bash }, { idleMs: 30, closeGraceMs: 10, shutdownMs: 500, openCheckMs: 60_000, openFastMs: 60_000 });
  await reg.boot();
  return { driver, store, bash, reg };
}

async function restart(reg: ChatRegistry, driver: FakeDriver, store: MemoryStore, bash: FakeBash): Promise<ChatRegistry> {
  await reg.shutdown();
  const next = new ChatRegistry({ driver, store, bash }, { idleMs: 30, closeGraceMs: 10, shutdownMs: 500, openCheckMs: 60_000, openFastMs: 60_000 });
  await next.boot();
  return next;
}

const turnEnd = (): ChatEvent => ({ k: "turn_end", ok: true, subtype: "success", durationMs: 3, error: null, uuids: [] });
const getContext = (chat: string) => ({ t: "get" as const, rid: rid(), chat, what: "context" as const });
const context = async (reg: ChatRegistry, chat: string) => {
  const o = await apply(reg, getContext(chat));
  if (!o.ok) throw new Error(`get context refused: ${o.code}`);
  return (o.result ?? null) as ContextInfo | null;
};

/** A new chat whose first turn has ended: its Claude Code process is live and idle. */
async function liveChat(reg: ChatRegistry, driver: FakeDriver, project = PROJECT) {
  const o = await apply(reg, { t: "new_chat", rid: rid(), project, uuid: rid(), text: "first", picks: { model: null, effort: null, mode: null }, uploads: [] });
  if (!o.ok) throw new Error(`new_chat refused: ${o.code}`);
  const c = driver.last;
  c.emit(turnEnd());
  await settle();
  return { chat: (o.result as { chat: string }).chat, c };
}

/** A chat on a past session of `cwd` (its transcript exists), sleeping: no Claude Code process. */
async function sleepingChat(reg: ChatRegistry, driver: FakeDriver, project = PROJECT, cwd = CWD) {
  const sid = rid();
  driver.transcript(sid, "A past chat", cwd);
  const o = await apply(reg, { t: "continue_session", rid: rid(), project, session: sid });
  if (!o.ok) throw new Error(`continue_session refused: ${o.code}`);
  return { chat: (o.result as { chat: string }).chat, sid };
}

/** Wait until the chat's idle Claude Code has closed (idleMs 30). */
async function untilAsleep(reg: ChatRegistry, chat: string) {
  for (let i = 0; i < 100 && reg.stateOf(chat) !== "sleeping"; i++) await new Promise((r) => setTimeout(r, 10));
  expect(reg.stateOf(chat)).toBe("sleeping");
}

describe("get context for a chat with no live Claude Code (the registry)", () => {
  test("the owner's case: a live read answers as before, and after the chat sleeps its ring still has the kept read", async () => {
    const { reg, driver, store } = await setup();
    const { chat, c } = await liveChat(reg, driver);
    c.contextInfo = READ;
    expect(await context(reg, chat)).toEqual(READ);
    await settle();
    expect(store.notes.get(chat)?.context?.info).toEqual(READ);
    await untilAsleep(reg, chat);
    const opens = driver.opens.length;
    expect(await context(reg, chat)).toEqual(READ);
    // The read starts no Claude Code process (DESIGN 4.1).
    expect(driver.opens.length).toBe(opens);
  });

  test("after a restart (a new registry over the same store) the chat still answers its kept read", async () => {
    const { reg, driver, store, bash } = await setup();
    const { chat, c } = await liveChat(reg, driver);
    c.contextInfo = READ;
    await context(reg, chat);
    await settle();
    const next = await restart(reg, driver, store, bash);
    expect(next.stateOf(chat)).toBe("sleeping");
    const opens = driver.opens.length;
    expect(await context(next, chat)).toEqual(READ);
    expect(driver.opens.length).toBe(opens);
  });

  test("a live read replaces the kept one", async () => {
    const { reg, driver, store } = await setup();
    const { chat, c } = await liveChat(reg, driver);
    c.contextInfo = READ;
    await context(reg, chat);
    const later: ContextInfo = { ...READ, usedTokens: 90_000, percent: 45 };
    c.contextInfo = later;
    expect(await context(reg, chat)).toEqual(later);
    await settle();
    expect(store.notes.get(chat)?.context?.info).toEqual(later);
  });

  test("a chat with only a transcript: its last usage against its model's window, once a live read of that model reported one", async () => {
    const { reg, driver } = await setup();
    const past = await sleepingChat(reg, driver, OTHER, CWD2);
    driver.usages.set(past.sid, { model: "claude-opus-5-5", usedTokens: 45_000 });
    // No window known for the model yet: no figure, so no ring (never a made-up value).
    expect(await context(reg, past.chat)).toBeNull();
    // A live chat of that model in another project reads its context; its window is kept.
    const { chat, c } = await liveChat(reg, driver, PROJECT);
    c.contextInfo = READ;
    await context(reg, chat);
    await settle();
    const opens = driver.opens.length;
    expect(await context(reg, past.chat)).toEqual({ model: "claude-opus-5-5", usedTokens: 45_000, maxTokens: 200_000, percent: 22.5, parts: [{ name: TRANSCRIPT_PART, tokens: 45_000, kind: "used" }] });
    expect(driver.opens.length).toBe(opens);
    expect(reg.stateOf(past.chat)).toBe("sleeping");
    // A transcript of a model whose window is not known, and a chat with no transcript usage: null.
    const other = await sleepingChat(reg, driver, OTHER, CWD2);
    driver.usages.set(other.sid, { model: "claude-haiku-5-5", usedTokens: 1_000 });
    expect(await context(reg, other.chat)).toBeNull();
    const none = await sleepingChat(reg, driver, OTHER, CWD2);
    expect(await context(reg, none.chat)).toBeNull();
  });

  test("the windows survive a restart with the project (projects.json)", async () => {
    const { reg, driver, store, bash } = await setup();
    const { chat, c } = await liveChat(reg, driver, PROJECT);
    c.contextInfo = READ;
    await context(reg, chat);
    await settle();
    expect(store.projects.find((p) => p.id === PROJECT)?.contextWindows).toEqual({ "claude-opus-5-5": 200_000 });
    const next = await restart(reg, driver, store, bash);
    const past = await sleepingChat(next, driver, OTHER, CWD2);
    driver.usages.set(past.sid, { model: "claude-opus-5-5", usedTokens: 10_000 });
    expect((await context(next, past.chat))?.percent).toBe(5);
  });
});

describe("the rules (context.ts)", () => {
  test("a window is kept per model, the newest last, the oldest going past the cap; nothing new keeps nothing", () => {
    expect(windowsWith(undefined, { "claude-opus-5-5": 200_000 })).toEqual({ "claude-opus-5-5": 200_000 });
    expect(windowsWith({ "claude-opus-5-5": 200_000 }, { "claude-opus-5-5": 200_000 })).toBeNull();
    expect(windowsWith({ "claude-opus-5-5": 200_000, a: 1 }, { "claude-opus-5-5": 1_000_000 })).toEqual({ a: 1, "claude-opus-5-5": 1_000_000 });
    expect(windowsWith({}, {})).toBeNull();
    // An entry that cannot be kept is left out, and the others are kept.
    expect(windowsWith({}, { "x\u0000y": 200_000, "": 5, zero: 0, ok: 7 })).toEqual({ ok: 7 });
    const full = Object.fromEntries(Array.from({ length: STORE_LIMITS.contextWindows }, (_, i) => [`m${i}`, 1000 + i]));
    const next = windowsWith(full, { new: 5 })!;
    expect(Object.keys(next)).toHaveLength(STORE_LIMITS.contextWindows);
    expect(next.m0).toBeUndefined();
    expect(next.new).toBe(5);
  });
  test("the window of a model: the chat's project's first, else another project's", () => {
    const projects: { id: string; contextWindows: Record<string, number> }[] = [
      { id: "a", contextWindows: { m: 100 } },
      { id: "b", contextWindows: { m: 200, n: 300 } },
    ];
    expect(windowOf(projects, "a", "m")).toBe(100);
    expect(windowOf(projects, "a", "n")).toBe(300);
    expect(windowOf(projects, "a", "z")).toBeNull();
    expect(windowOf(projects, "a", null)).toBeNull();
  });
  test("a transcript's figure: one used part, never past the window", () => {
    expect(transcriptFigure({ model: "m", usedTokens: 50 }, 200)).toEqual({ model: "m", usedTokens: 50, maxTokens: 200, percent: 25, parts: [{ name: TRANSCRIPT_PART, tokens: 50, kind: "used" }] });
    expect(transcriptFigure({ model: "m", usedTokens: 500 }, 200)?.percent).toBe(100);
    expect(transcriptFigure(null, 200)).toBeNull();
    expect(transcriptFigure({ model: "m", usedTokens: 50 }, null)).toBeNull();
  });
  test("a read that fails answers null, never throws", async () => {
    const c = new ChatContexts({ store: { listProjects: async () => [], putProject: async () => {} }, usage: async () => Promise.reject(new Error("unreadable")) });
    expect(await c.answer(undefined, { project: PROJECT, sessionId: rid(), cwd: CWD })).toBeNull();
    expect(await c.answer(undefined, { project: PROJECT, sessionId: null, cwd: CWD })).toBeNull();
  });
});

describe("the transcript's last usage (events.ts lastReplyUsage)", () => {
  const sm = (type: "user" | "assistant", message: unknown, parent: string | null = null) => ({ type, uuid: rid(), session_id: rid(), message, parent_tool_use_id: parent, parent_agent_id: null });
  const reply = (model: string, usage: Record<string, unknown> | undefined) => sm("assistant", { role: "assistant", model, content: [], usage });
  test("the main session's last reply that counted any tokens, its four counts summed", () => {
    expect(
      lastReplyUsage([
        reply("claude-haiku-5-5", { input_tokens: 10, output_tokens: 5 }),
        reply("claude-opus-5-5", { input_tokens: 3, cache_creation_input_tokens: 1200, cache_read_input_tokens: 40_000, output_tokens: 797 }),
        // A subagent's reply, and Claude Code's own line with nothing counted, are passed over.
        { ...reply("claude-sonnet-5-5", { input_tokens: 99_999 }), parent_tool_use_id: "toolu_01" },
        reply("<synthetic>", { input_tokens: 0, output_tokens: 0 }),
        sm("user", { role: "user", content: "next" }),
      ]),
    ).toEqual({ model: "claude-opus-5-5", usedTokens: 42_000 });
  });
  test("none with no reply that has a usage; odd counts count as none", () => {
    expect(lastReplyUsage([])).toBeNull();
    expect(lastReplyUsage([reply("m", undefined), sm("user", { content: "hi" })])).toBeNull();
    expect(lastReplyUsage([reply("m", { input_tokens: -5, output_tokens: "7", cache_read_input_tokens: 1.5 })])).toBeNull();
    expect(lastReplyUsage([reply("", { input_tokens: 7 })])).toEqual({ model: null, usedTokens: 7 });
  });
});

describe("on disk: read defensively (store/context.ts)", () => {
  const AT = "2026-11-03T10:00:00.000Z";
  test("the notes keep the last read; a bad one reads as none and the notes keep the rest", () => {
    const note = contextNoteOf(READ, AT)!;
    expect(note).toEqual({ at: AT, info: READ });
    const saved = notesForSave({ v: 1, id: "k3m7q2x4abk3m7q2x4ab", cards: [], bash: [], notRun: [], context: note });
    expect(notesFrom(JSON.parse(JSON.stringify(saved))).context).toEqual(note);
    for (const bad of [{ at: "yesterday", info: READ }, { at: AT, info: { ...READ, maxTokens: 0 } }, { at: AT, info: { ...READ, percent: 140 } }, { at: AT, info: { ...READ, parts: [{ name: "x", tokens: -1, kind: "used" }] } }, "x", null]) {
      const n = notesFrom({ v: 1, id: "k3m7q2x4abk3m7q2x4ab", cards: [], bash: [], notRun: [], context: bad });
      expect(n.context).toBeUndefined();
      expect(n.id).toBe("k3m7q2x4abk3m7q2x4ab");
    }
    expect(contextNoteFrom({ at: AT, info: { ...READ, parts: Array.from({ length: STORE_LIMITS.contextParts + 1 }, () => READ.parts[0]) } })).toBeUndefined();
  });
  test("a write cuts what a read would not take back: long names, the parts past the cap, odd counts", () => {
    const n = contextNoteOf({ ...READ, model: "m".repeat(300), usedTokens: 12.6, percent: 101, parts: Array.from({ length: 40 }, (_, i) => ({ name: `p${i}\u0007`.padEnd(200, "x"), tokens: i, kind: "used" as const })) }, AT)!;
    expect(n.info.model!.length).toBeLessThanOrEqual(120);
    expect(n.info.usedTokens).toBe(13);
    expect(n.info.percent).toBe(100);
    expect(n.info.parts).toHaveLength(STORE_LIMITS.contextParts);
    expect(n.info.parts.every((p) => p.name.length <= 120 && !p.name.includes("\u0007"))).toBe(true);
  });
  test("a project keeps its windows; a bad map reads as none and the project keeps the rest", () => {
    const base = projectRecord(PROJECT, CWD);
    expect(projectFrom({ ...base, contextWindows: { "claude-opus-5-5": 200_000 } }).contextWindows).toEqual({ "claude-opus-5-5": 200_000 });
    for (const bad of [{ m: 0 }, { m: 1.5 }, { "": 5 }, [], "x", {}]) {
      const p = projectFrom({ ...base, contextWindows: bad });
      expect(p.contextWindows).toBeUndefined();
      expect(p.id).toBe(PROJECT);
    }
    expect(contextWindowsFrom(Object.fromEntries(Array.from({ length: STORE_LIMITS.contextWindows + 1 }, (_, i) => [`m${i}`, 1])))).toBeUndefined();
  });
});
