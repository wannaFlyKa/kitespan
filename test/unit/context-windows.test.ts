// Row 94, after the deploy (the owner: a very old chat showed an empty ring, since no live read had given its model's
// window yet): row 81's short read gives every model row's context window too. On the idle query that answered the
// lists, the "default" row's window as the query starts, then each other row's after a switch to it (setModel and
// getContextUsage, the lead's live probe: 889 ms for eight rows): no message, so no model turn; one call at a time,
// within the read's cap; a row whose read fails is left out. The windows are kept with the project, and a chat whose
// model's window no project keeps asks for the read (at most once a day per server) and gets its figure from it, with
// no live read. The scripted driver stands in for Claude Code in the registry; the driver's read runs through the real
// Agent SDK and the fake CLI. The real claude never runs.

import { afterEach, describe, expect, test } from "bun:test";
import type { ContextInfo, ModelInfo } from "../../shared/protocol";
import type { EnvVar } from "../../server/agents/types";
import { ChatRegistry } from "../../server/chats/registry";
import { FakeBash, FakeDriver, MemoryStore, apply, projectRecord, settle } from "../../server/chats/testing";
import { rig, type Rig } from "../fake-claude/harness";
import type { Fixture } from "../fake-claude/install";

const PROJECT = "k3m7q2x4ab";
const OTHER = "abcdefghij";
const CWD = "/srv/work/app";
const CWD2 = "/srv/work/other";
const rid = () => crypto.randomUUID();
const row = (value: string, displayName: string): ModelInfo => ({ value, displayName, description: displayName, efforts: ["low", "medium", "high"], supportsAutoMode: true });
const LIST: ModelInfo[] = [row("default", "Default (recommended)"), row("claude-opus-4-6", "Opus 4.6"), row("claude-opus-5-5", "Opus 5.5")];
/** What the probe read on the owner's machine (CLI 2.1.317), for these rows. */
const WINDOWS = { default: 1_000_000, "claude-opus-4-6": 200_000, "claude-opus-5-5": 1_000_000 };

let clock = Date.parse("2026-11-03T12:00:00.000Z");
afterEach(() => {
  clock = Date.parse("2026-11-03T12:00:00.000Z");
});

async function setup(prep?: (d: FakeDriver, s: MemoryStore) => void) {
  const driver = new FakeDriver();
  const store = new MemoryStore();
  store.projects = [projectRecord(PROJECT, CWD), projectRecord(OTHER, CWD2)];
  driver.modelsAnswer = LIST;
  driver.windowsAnswer = { ...WINDOWS };
  prep?.(driver, store);
  const reg = new ChatRegistry({ driver, store, bash: new FakeBash(), now: () => new Date(clock) }, { idleMs: 60_000, closeGraceMs: 10, shutdownMs: 500, openCheckMs: 60_000, openFastMs: 60_000 });
  await reg.boot();
  return { driver, store, reg };
}

const context = async (reg: ChatRegistry, chat: string) => {
  const o = await apply(reg, { t: "get", rid: rid(), chat, what: "context" });
  if (!o.ok) throw new Error(`get context refused: ${o.code}`);
  return (o.result ?? null) as ContextInfo | null;
};

/** A chat on a past session (its transcript exists, its last reply on `model`), sleeping: no Claude Code process. */
async function oldChat(reg: ChatRegistry, driver: FakeDriver, model: string, usedTokens: number, project = PROJECT, cwd = CWD) {
  const sid = rid();
  driver.transcript(sid, "A very old chat", cwd);
  driver.usages.set(sid, { model, usedTokens });
  const o = await apply(reg, { t: "continue_session", rid: rid(), project, session: sid });
  if (!o.ok) throw new Error(`continue_session refused: ${o.code}`);
  return (o.result as { chat: string }).chat;
}

describe("the window table from row 81's short read (the registry)", () => {
  test("the owner's case: a very old chat right after the deploy, with no live read ever, gets its figure from the short read", async () => {
    const { reg, driver, store } = await setup();
    const chat = await oldChat(reg, driver, "claude-opus-4-6", 50_000);
    expect(await context(reg, chat)).toEqual({ model: "claude-opus-4-6", usedTokens: 50_000, maxTokens: 200_000, percent: 25, parts: [{ name: "Used", tokens: 50_000, kind: "used" }] });
    // One short read (the model list's, which the windows ride on), and no chat's Claude Code started.
    expect([driver.modelReads.length, driver.windowReads.length]).toEqual([1, 1]);
    expect(driver.opens).toHaveLength(0);
    expect(reg.stateOf(chat)).toBe("sleeping");
    await settle();
    expect(store.projects.find((p) => p.id === PROJECT)?.contextWindows).toEqual(WINDOWS);
  });

  test("the next chats use the kept windows: no second read, also for a model no row has (null, as before)", async () => {
    const { reg, driver } = await setup();
    await context(reg, await oldChat(reg, driver, "claude-opus-4-6", 50_000));
    expect((await context(reg, await oldChat(reg, driver, "claude-opus-5-5", 100_000, OTHER, CWD2)))?.maxTokens).toBe(1_000_000);
    expect(await context(reg, await oldChat(reg, driver, "claude-gone-1", 1_000))).toBeNull();
    expect(driver.windowReads).toHaveLength(1);
    // A day later a model still unknown asks for the read again, once.
    clock += 24 * 60 * 60_000 + 1;
    expect(await context(reg, await oldChat(reg, driver, "claude-gone-1", 1_000))).toBeNull();
    expect(await context(reg, await oldChat(reg, driver, "claude-gone-1", 1_000))).toBeNull();
    expect(driver.windowReads).toHaveLength(2);
  });

  test("the model list's own read keeps the windows too (a sleeping chat's picker, with none kept)", async () => {
    const { reg, driver, store } = await setup();
    const chat = await oldChat(reg, driver, "claude-opus-5-5", 10_000);
    const o = await apply(reg, { t: "get", rid: rid(), chat, what: "models" });
    expect(o.ok && (o.result as ModelInfo[]).map((m) => m.value)).toEqual(LIST.map((m) => m.value));
    await settle();
    expect(store.projects.find((p) => p.id === PROJECT)?.contextWindows).toEqual(WINDOWS);
    expect((await context(reg, chat))?.maxTokens).toBe(1_000_000);
    expect(driver.windowReads).toHaveLength(1);
  });

  test("a Default chat: its live read's window is kept under default, and a transcript on the default model is measured by it", async () => {
    const { reg, driver, store } = await setup((d) => (d.windowsAnswer = {}));
    const o = await apply(reg, { t: "new_chat", rid: rid(), project: PROJECT, uuid: rid(), text: "first", picks: { model: null, effort: null, mode: null }, uploads: [] });
    if (!o.ok) throw new Error("new_chat refused");
    const c = driver.last;
    c.emit({ k: "turn_end", ok: true, subtype: "success", durationMs: 3, error: null, uuids: [] });
    await settle();
    // The driver gives a Default chat's read as the default row (driver.ts context(): never the provider's ARN).
    c.contextInfo = { model: "default", usedTokens: 20_000, maxTokens: 1_000_000, percent: 2, parts: [] };
    await context(reg, (o.result as { chat: string }).chat);
    await settle();
    expect(store.projects.find((p) => p.id === PROJECT)?.contextWindows).toEqual({ default: 1_000_000 });
    // A transcript whose model is the provider's ARN reads as "default" (events.ts lastReplyUsage).
    expect((await context(reg, await oldChat(reg, driver, "default", 250_000)))?.percent).toBe(25);
  });

  test("a read that fails: null, and no read again for a minute", async () => {
    const { reg, driver } = await setup((d) => (d.modelsThrows = "failed"));
    expect(await context(reg, await oldChat(reg, driver, "claude-opus-4-6", 1_000))).toBeNull();
    clock += 30_000;
    expect(await context(reg, await oldChat(reg, driver, "claude-opus-4-6", 1_000))).toBeNull();
    expect(driver.modelReads).toHaveLength(1);
    driver.modelsThrows = null;
    clock += 31_000;
    expect((await context(reg, await oldChat(reg, driver, "claude-opus-4-6", 1_000)))?.maxTokens).toBe(200_000);
    expect(driver.modelReads).toHaveLength(2);
  });
});

describe("D60: an environment's variables change (the registry)", () => {
  const ONE: EnvVar[] = [{ name: "ANTHROPIC_BASE_URL", value: "https://one.example" }];
  const TWO: EnvVar[] = [{ name: "ANTHROPIC_BASE_URL", value: "https://two.example" }];
  async function envSetup() {
    const vars = { now: ONE };
    const driver = new FakeDriver();
    const store = new MemoryStore();
    store.projects = [projectRecord(PROJECT, CWD), projectRecord(OTHER, CWD2)];
    driver.modelsAnswer = LIST;
    driver.windowsAnswer = { "claude-opus-4-6": 200_000 };
    const env = { vars: (p: string) => (p === PROJECT ? vars.now : []) };
    const reg = new ChatRegistry({ driver, store, bash: new FakeBash(), env, now: () => new Date(clock) }, { idleMs: 60_000, closeGraceMs: 10, shutdownMs: 500, openCheckMs: 60_000, openFastMs: 60_000 });
    await reg.boot();
    /** The env route's change (api.ts): the new values, the project's records of the old ones dropped, the registry told. */
    const change = (next: EnvVar[]) => {
      vars.now = next;
      store.projects = store.projects.map((p) => {
        if (p.id !== PROJECT) return p;
        const { models: _m, contextWindows: _w, account: _a, facts: _f, ...rest } = p;
        return rest;
      });
      reg.envChanged(PROJECT);
    };
    return { driver, store, reg, change };
  }

  test("windows read with the old values: after the change, a sleeping chat's figure reads them again, with the new ones", async () => {
    const { driver, reg, change } = await envSetup();
    expect((await context(reg, await oldChat(reg, driver, "claude-opus-4-6", 50_000)))?.maxTokens).toBe(200_000);
    driver.windowsAnswer = { "claude-opus-4-6": 1_000_000 };
    change(TWO);
    expect((await context(reg, await oldChat(reg, driver, "claude-opus-4-6", 50_000)))?.maxTokens).toBe(1_000_000);
    expect(driver.windowReads).toEqual([CWD, CWD]);
  });

  test("a chat that still runs with the old values keeps none of its reads with the project: its list, its window, its start facts, its provider", async () => {
    const { driver, store, reg, change } = await envSetup();
    const o = await apply(reg, { t: "new_chat", rid: rid(), project: PROJECT, uuid: rid(), text: "first", picks: { model: null, effort: null, mode: null }, uploads: [] });
    if (!o.ok) throw new Error("new_chat refused");
    const chat = (o.result as { chat: string }).chat;
    const c = driver.last;
    c.emit({ k: "turn_end", ok: true, subtype: "success", durationMs: 3, error: null, uuids: [] });
    await settle();
    change(TWO);
    c.modelList = [LIST[0]!];
    c.contextInfo = { model: "claude-opus-4-6", usedTokens: 20_000, maxTokens: 200_000, percent: 10, parts: [] };
    c.provider = "firstParty";
    const models = await apply(reg, { t: "get", rid: rid(), chat, what: "models" });
    expect(models.ok && (models.result as ModelInfo[]).map((m) => m.value)).toEqual(["default"]);
    expect((await context(reg, chat))?.maxTokens).toBe(200_000);
    c.emit({ k: "session", sessionId: c.input.sessionId?.value ?? rid(), model: null, mode: "default", version: "2.1.317", bypass: false, fastMode: { state: "on", reason: null }, skills: [], plugins: [], outputStyle: null });
    // Its provider is the old values' too: it answers for no Settings, and is not kept.
    expect(await reg.account(PROJECT)).toBeNull();
    await settle();
    const p = store.projects.find((x) => x.id === PROJECT)!;
    expect([p.models, p.contextWindows, p.facts, p.account]).toEqual([undefined, undefined, undefined, undefined]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The driver's read through the fake CLI

/** The fake's model rows (its initialize answer) and its window per model. */
const ROWS = ["default", "claude-opus-4-6", "claude-opus-5-5", "claude-haiku-5-5"];
const fakeRows = ROWS.map((value) => ({ value, displayName: value, description: value, supportedEffortLevels: ["low", "medium", "high"] }));
const fixture = (over: Fixture = {}): Fixture => ({
  model: "claude-sonnet-5-5",
  initialize: { models: fakeRows },
  contextWindows: { "claude-sonnet-5-5": 1_000_000, "claude-opus-4-6": 200_000, "claude-opus-5-5": 1_000_000, "claude-haiku-5-5": 1_000_000 },
  ...over,
});

let rigs: Rig[] = [];
afterEach(async () => {
  await Promise.all(rigs.map((r) => r.cleanup()));
  rigs = [];
});
const use = (r: Rig) => (rigs.push(r), r);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("the short read's windows through the fake claude", () => {
  test("each row's window: the default row's as the query starts, then each other row's after a switch; no message, no turn", async () => {
    const r = use(rig(fixture()));
    expect(await r.driver.readWindows(r.fake.project)).toEqual({ default: 1_000_000, "claude-opus-4-6": 200_000, "claude-opus-5-5": 1_000_000, "claude-haiku-5-5": 1_000_000 });
    const trace = r.fake.trace();
    expect(trace.filter((l) => l.t === "user" || l.t === "turn_start")).toEqual([]);
    // One call at a time, in the rows' order: each read after its switch.
    const calls = trace.filter((l) => l.t === "control").map((l) => (l.subtype === "set_model" ? `set_model ${(l.request as { model?: string }).model}` : String(l.subtype)));
    expect(calls).toEqual(["initialize", "get_context_usage", "set_model claude-opus-4-6", "get_context_usage", "set_model claude-opus-5-5", "get_context_usage", "set_model claude-haiku-5-5", "get_context_usage"]);
    const starts = trace.filter((l) => l.t === "start");
    expect(starts).toHaveLength(1);
    expect(alive(starts[0]!.pid as number)).toBe(false);
    expect(r.lastOptions).toEqual([]);
  });

  test("the lists and the windows read at once share one process", async () => {
    const r = use(rig(fixture()));
    const [list, windows] = await Promise.all([r.driver.readModels(r.fake.project), r.driver.readWindows(r.fake.project)]);
    expect(list.map((m) => m.value)).toEqual(ROWS);
    expect(Object.keys(windows)).toEqual(ROWS);
    expect(r.fake.trace().filter((l) => l.t === "start")).toHaveLength(1);
  });

  test("a row whose read fails is left out; the others are kept", async () => {
    const r = use(rig(fixture({ contextRefusedFor: ["claude-opus-5-5"] })));
    expect(await r.driver.readWindows(r.fake.project)).toEqual({ default: 1_000_000, "claude-opus-4-6": 200_000, "claude-haiku-5-5": 1_000_000 });
  });

  test("within the read's cap: the lists answer, with the windows read by then", async () => {
    const r = use(rig(fixture({ contextDelayMs: 500 }), { commandsReadMs: 1_400 }));
    const t0 = Date.now();
    const [list, windows] = await Promise.all([r.driver.readModels(r.fake.project), r.driver.readWindows(r.fake.project)]);
    expect(list.map((m) => m.value)).toEqual(ROWS);
    expect(Object.keys(windows).length).toBeLessThan(ROWS.length);
    expect(Date.now() - t0).toBeLessThan(6_000);
    expect(alive(r.fake.trace().find((l) => l.t === "start")!.pid as number)).toBe(false);
  });
});
