// Row 94's safety rule: on Bedrock, Claude Code reports the default model as its inference profile's ARN, which holds
// the AWS account id (the lead's live probe: the "default" row's getContextUsage().model). A model string that starts
// with "arn:" is never kept, logged, sent to the page or shown: a Default chat's context read stands for the default
// row ("default", or the chat's own row), its window is kept under "default", the session event and the refusal's
// fallback carry no model, a workflow row's model drops it, a transcript's record on it reads as "default", and
// last-options.json records "[an ARN]". The store's readers take none back from a planted file. End to end, a fake
// claude whose default model is an ARN drives the real driver and the registry: the ARN reaches no frame, no note, no
// project, no last-options record and no log line. The ARN is put together at run time (no account id in the source).

import { afterEach, describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ContextInfo, ModelInfo } from "../../shared/protocol";
import { isProviderArn } from "../../server/agents/types";
import { EventMapper, lastReplyUsage, workflowSteps } from "../../server/agents/claude/events";
import { snapshotOptions } from "../../server/agents/claude/options";
import { windowsWith } from "../../server/chats/context";
import { ChatRegistry } from "../../server/chats/registry";
import { FakeBash, MemoryStore, RecordingViewer, apply, projectRecord, settle } from "../../server/chats/testing";
import { contextNoteFrom, contextNoteOf, contextWindowsFrom } from "../../server/store/context";
import { projectModelsForSave, projectModelsFrom } from "../../server/store/models";
import { notesFrom } from "../../server/store/notes";
import { projectFrom } from "../../server/store/records";
import type { LogEvent, LogFields } from "../../server/log";
import { rig, type Rig } from "../fake-claude/harness";
import { loadFixture } from "../fake-claude/install";

const ACCOUNT = "4321".repeat(3);
const ARN = ["arn", "aws", "bedrock", "us-west-2", ACCOUNT, "application-inference-profile/fdtestprofile"].join(":");
const BARE = ["arn", "aws", "bedrock", "us-west-2", ACCOUNT, "default-profile"].join(":");
const clean = (v: unknown) => {
  const text = JSON.stringify(v);
  expect([text.includes("arn:"), text.includes(ACCOUNT)]).toEqual([false, false]);
};

describe("the rule", () => {
  test("an ARN is one; a model id is not", () => {
    expect([isProviderArn(ARN), isProviderArn("ARN:aws:x"), isProviderArn("claude-opus-5-5"), isProviderArn("default"), isProviderArn(null)]).toEqual([true, true, false, false, false]);
  });
});

describe("the driver's mapping (events.ts, options.ts)", () => {
  const map = (m: Record<string, unknown>) => new EventMapper({ bypass: false }).map({ session_id: "s", uuid: "u-1", ...m } as unknown as SDKMessage);
  test("the session event carries no ARN as the live model; a model id goes through", () => {
    const session = (m: Record<string, unknown>) => map({ type: "system", subtype: "init", permissionMode: "default", claude_code_version: "2.1.317", ...m }).find((e) => e.k === "session");
    expect(session({ model: ARN })).toMatchObject({ k: "session", model: null });
    expect(session({ model: "claude-opus-5-5" })).toMatchObject({ k: "session", model: "claude-opus-5-5" });
  });
  test("a refusal's fallback and a workflow row carry no ARN", () => {
    const refusal = map({ type: "system", subtype: "model_refusal_fallback", content: "Refused", fallback_model: ARN, scope: "session" }).find((e) => e.k === "refusal");
    expect(refusal).toMatchObject({ k: "refusal", fallback: { model: "" } });
    const steps = workflowSteps([
      { type: "workflow_agent", index: 0, model: BARE },
      { type: "workflow_agent", index: 1, model: ARN },
    ]);
    clean(steps);
    expect(steps?.map((s) => (s.kind === "agent" ? s.model : null))).toEqual([null, "fdtestprofile"]);
  });
  test("a transcript's reply on the ARN reads as the default row", () => {
    const reply = { type: "assistant", uuid: "u", session_id: "s", parent_tool_use_id: null, parent_agent_id: null, message: { role: "assistant", model: ARN, content: [], usage: { input_tokens: 5 } } };
    expect(lastReplyUsage([reply] as never)).toEqual({ model: "default", usedTokens: 5 });
  });
  test("last-options.json records [an ARN] where one was a model", () => {
    expect(snapshotOptions({ model: ARN, cwd: "/srv/work/app", canUseTool: () => {} })).toEqual({ model: "[an ARN]", cwd: "/srv/work/app", canUseTool: "[function]" });
  });
  test("with an environment's variables (D60) too: env keeps names only, and an ARN as a value goes nowhere", () => {
    const snap = snapshotOptions({ model: ARN, env: { PATH: "/usr/bin", ANTHROPIC_MODEL: ARN }, canUseTool: () => {} }, ["ANTHROPIC_MODEL"]);
    expect(snap).toEqual({ model: "[an ARN]", env: { "[inherited]": true, ANTHROPIC_MODEL: "[set]" }, canUseTool: "[function]" });
    clean(snap);
  });
});

describe("on disk: none kept, none taken back (store/context.ts)", () => {
  const read: ContextInfo = { model: ARN, usedTokens: 10, maxTokens: 1_000_000, percent: 0, parts: [] };
  const AT = "2026-11-03T10:00:00.000Z";
  test("a note keeps no ARN, and a planted one reads as none", () => {
    expect(contextNoteOf(read, AT)?.info.model).toBeNull();
    expect(contextNoteFrom({ at: AT, info: read })).toBeUndefined();
    expect(notesFrom({ v: 1, id: "k3m7q2x4abk3m7q2x4ab", cards: [], bash: [], notRun: [], context: { at: AT, info: read } }).context).toBeUndefined();
  });
  test("no window is kept under an ARN, and a planted map reads as none", () => {
    expect(windowsWith({}, { [ARN]: 1_000_000, default: 1_000_000 })).toEqual({ default: 1_000_000 });
    expect(contextWindowsFrom({ [ARN]: 1_000_000 })).toBeUndefined();
    expect(projectFrom({ ...projectRecord("k3m7q2x4ab"), contextWindows: { [ARN]: 1_000_000 } }).contextWindows).toBeUndefined();
  });
  test("a model row whose value is an ARN is not kept, and a planted one reads as none (an environment's ANTHROPIC_MODEL, D60)", () => {
    const row = (value: string): ModelInfo => ({ value, displayName: "Row", description: "", efforts: [], supportsAutoMode: false });
    const saved = projectModelsForSave([row("default"), row(ARN), row("claude-fake-1")], AT);
    expect(saved.list.map((m) => m.value)).toEqual(["default", "claude-fake-1"]);
    clean(saved);
    expect(projectModelsFrom({ at: AT, list: [row("default"), row(ARN)] })).toBeUndefined();
    expect(projectFrom({ ...projectRecord("k3m7q2x4ab"), models: { at: AT, list: [row(ARN)] } }).models).toBeUndefined();
  });
  test("a model row's name and description hold no ARN: each one reads as [an ARN], on a write and on a read (the default row's description names the model it resolves to)", () => {
    const row: ModelInfo = { value: "default", displayName: `Default (${ARN})`, description: `Use the default model (currently ${ARN}), or ${BARE.toUpperCase()} as well`, efforts: [], supportsAutoMode: false };
    const masked = { displayName: "Default ([an ARN])", description: "Use the default model (currently [an ARN]), or [an ARN] as well" };
    const saved = projectModelsForSave([row], AT);
    expect(saved.list).toEqual([{ ...row, ...masked }]);
    const read = projectModelsFrom({ at: AT, list: [row] });
    expect(read?.list).toEqual([{ ...row, ...masked }]);
    clean({ saved, read, project: projectFrom({ ...projectRecord("k3m7q2x4ab"), models: { at: AT, list: [row] } }).models });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// End to end: the real driver on a fake claude whose default model is the ARN, under the registry

let rigs: Rig[] = [];
afterEach(async () => {
  await Promise.all(rigs.map((r) => r.cleanup()));
  rigs = [];
});

describe("a planted ARN reaches nothing (the real driver, the fake claude, the registry)", () => {
  test("the frames of a Default chat, its context read, the kept note and windows, last-options and the log", async () => {
    const text = loadFixture("text-thinking");
    const r = rig({ ...text, model: ARN, contextWindows: { [ARN]: 1_000_000, "claude-fake-1": 200_000 } });
    rigs.push(r);
    const store = new MemoryStore();
    const PROJECT = "k3m7q2x4ab";
    store.projects = [projectRecord(PROJECT, r.fake.project)];
    const lines: ({ ev: LogEvent } & LogFields)[] = [];
    const log = { log: (ev: LogEvent, f: LogFields = {}) => void lines.push({ ev, ...f }), sweep: () => 0, close: () => {}, failures: 0 };
    const reg = new ChatRegistry({ driver: r.driver, store, bash: new FakeBash(), log }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 2_000, openCheckMs: 60_000, openFastMs: 60_000 });
    await reg.boot();
    try {
      const o = await apply(reg, { t: "new_chat", rid: crypto.randomUUID(), project: PROJECT, uuid: crypto.randomUUID(), text: "hello", picks: { model: null, effort: null, mode: null }, uploads: [] });
      if (!o.ok) throw new Error(`new_chat refused: ${o.code}`);
      const chat = (o.result as { chat: string }).chat;
      const viewer = new RecordingViewer();
      const attached = await reg.attach(chat, viewer);
      for (let i = 0; i < 400 && !viewer.of("turn_end").length; i++) await Bun.sleep(20);
      expect(viewer.of("turn_end")).toHaveLength(1);
      // The session event's live model: the ARN is not one.
      const sessions = [...viewer.of("session"), ...(attached?.tail ?? []).map((i) => i.e).filter((e) => e.k === "session")];
      expect(sessions.length).toBeGreaterThan(0);
      for (const s of sessions) expect(s).toMatchObject({ model: null });
      // The context read: the default row stands for the ARN, with its window.
      const got = await apply(reg, { t: "get", rid: crypto.randomUUID(), chat, what: "context" });
      const ctx = got.ok ? (got.result as ContextInfo) : null;
      expect(ctx).toMatchObject({ model: "default", maxTokens: 1_000_000 });
      // The model list's short read keeps every row's window, the default row's under "default".
      const models = await apply(reg, { t: "get", rid: crypto.randomUUID(), chat, what: "models" });
      expect(models.ok && (models.result as ModelInfo[]).map((m) => m.value)).toEqual(["default", "claude-fake-1"]);
      await settle(20);
      await Bun.sleep(300);
      const project = store.projects.find((p) => p.id === PROJECT)!;
      expect(project.contextWindows?.default).toBe(1_000_000);
      expect(store.notes.get(chat)?.context?.info.model).toBe("default");
      clean({ frames: viewer.items, attached, ctx, models, notes: [...store.notes.values()], projects: store.projects, ledgers: [...store.chats.values()], lastOptions: r.lastOptions, log: lines });
    } finally {
      await reg.shutdown();
    }
  }, 30_000);

  test("a model row whose value is an ARN is left out of the list that the page gets and the project keeps", async () => {
    const text = loadFixture("text-thinking");
    const rows = [
      { value: "default", displayName: "Default (recommended)", description: "Use the default model", supportedEffortLevels: ["low"] },
      { value: ARN, displayName: "Profile", description: "An inference profile", supportedEffortLevels: ["low"] },
      { value: "claude-fake-1", displayName: "Fake 1", description: "A fake model row", supportedEffortLevels: ["low"] },
    ];
    const r = rig({ ...text, initialize: { models: rows } });
    rigs.push(r);
    const store = new MemoryStore();
    const PROJECT = "k3m7q2x4ab";
    store.projects = [projectRecord(PROJECT, r.fake.project)];
    const reg = new ChatRegistry({ driver: r.driver, store, bash: new FakeBash() }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 2_000, openCheckMs: 60_000, openFastMs: 60_000 });
    await reg.boot();
    try {
      const o = await apply(reg, { t: "new_chat", rid: crypto.randomUUID(), project: PROJECT, uuid: crypto.randomUUID(), text: "hello", picks: { model: null, effort: null, mode: null }, uploads: [] });
      if (!o.ok) throw new Error(`new_chat refused: ${o.code}`);
      const chat = (o.result as { chat: string }).chat;
      const viewer = new RecordingViewer();
      await reg.attach(chat, viewer);
      for (let i = 0; i < 400 && !viewer.of("turn_end").length; i++) await Bun.sleep(20);
      const models = await apply(reg, { t: "get", rid: crypto.randomUUID(), chat, what: "models" });
      expect(models.ok && (models.result as ModelInfo[]).map((m) => m.value)).toEqual(["default", "claude-fake-1"]);
      await settle(20);
      await Bun.sleep(300);
      clean({ models, projects: store.projects, frames: viewer.items });
    } finally {
      await reg.shutdown();
    }
  }, 30_000);

  test("the default row's description names the ARN it resolves to: no answer, frame or project holds it (a live chat's list and the short read)", async () => {
    const text = loadFixture("text-thinking");
    const rows = [
      { value: "default", displayName: "Default (recommended)", description: `Use the default model (currently ${ARN})`, supportedEffortLevels: ["low"] },
      { value: "claude-fake-1", displayName: `Fake 1 on ${BARE}`, description: "A fake model row", supportedEffortLevels: ["low"] },
    ];
    const r = rig({ ...text, initialize: { models: rows } });
    rigs.push(r);
    const store = new MemoryStore();
    const PROJECT = "k3m7q2x4ab";
    store.projects = [projectRecord(PROJECT, r.fake.project)];
    const reg = new ChatRegistry({ driver: r.driver, store, bash: new FakeBash() }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 2_000, openCheckMs: 60_000, openFastMs: 60_000 });
    await reg.boot();
    try {
      const o = await apply(reg, { t: "new_chat", rid: crypto.randomUUID(), project: PROJECT, uuid: crypto.randomUUID(), text: "hello", picks: { model: null, effort: null, mode: null }, uploads: [] });
      if (!o.ok) throw new Error(`new_chat refused: ${o.code}`);
      const chat = (o.result as { chat: string }).chat;
      const viewer = new RecordingViewer();
      await reg.attach(chat, viewer);
      for (let i = 0; i < 400 && !viewer.of("turn_end").length; i++) await Bun.sleep(20);
      const models = await apply(reg, { t: "get", rid: crypto.randomUUID(), chat, what: "models" });
      const live = models.ok ? (models.result as ModelInfo[]) : [];
      expect(live.map((m) => [m.value, m.displayName, m.description])).toEqual([
        ["default", "Default (recommended)", "Use the default model (currently [an ARN])"],
        ["claude-fake-1", "Fake 1 on [an ARN]", "A fake model row"],
      ]);
      // The short read with no chat (the new-chat form, a sleeping chat) maps the same rows the same way.
      const short = await r.driver.readModels(r.fake.project, null);
      expect(short).toEqual(live);
      await settle(20);
      await Bun.sleep(300);
      expect(store.projects.find((p) => p.id === PROJECT)?.models?.list).toEqual(live);
      clean({ models, short, projects: store.projects, frames: viewer.items });
    } finally {
      await reg.shutdown();
    }
  }, 30_000);
});
