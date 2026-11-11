// The registry's `chatEnded` hook (iteration 7, the browser pane's tab mark: DESIGN-B1 2.13, the live run B3's D2). It
// tells when a chat's Claude Code process ends, by itself or by kitespan's own close (Archive, Delete, the idle rule),
// and at Archive and Delete, so that a chat's mark on a browser tab goes with it. The `tools` hook alone cannot tell:
// the registry draws no `exit` event for a close that kitespan asked for.
import { describe, expect, test } from "bun:test";
import { ChatRegistry } from "../../server/chats/registry";
import { FakeBash, FakeDriver, MemoryStore, apply, autoReply, projectRecord, settle } from "../../server/chats/testing";
import type { RegistryOptions } from "../../server/chats/types";
import type { ChatEvent, NewChatFrame } from "../../shared/protocol";

const PROJECT = "k3m7q2x4ab";
const rid = () => crypto.randomUUID();
const turnEnd: ChatEvent = { k: "turn_end", ok: true, subtype: "success", durationMs: 3, error: null, uuids: [] };

async function setup(opts: RegistryOptions = {}) {
  const driver = new FakeDriver();
  const store = new MemoryStore();
  store.projects = [projectRecord(PROJECT)];
  const ended: string[] = [];
  const tools: string[] = [];
  const reg = new ChatRegistry(
    { driver, store, bash: new FakeBash(), tools: (chat, e) => tools.push(`${chat}:${e.k}`), chatEnded: (chat) => ended.push(chat) },
    { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500, ...opts },
  );
  await reg.boot();
  return { driver, store, reg, ended, tools };
}

async function newChat(reg: ChatRegistry): Promise<string> {
  const frame: NewChatFrame = { t: "new_chat", rid: rid(), project: PROJECT, uuid: rid(), text: "Open the page", picks: { model: null, effort: null, mode: null }, uploads: [] };
  const o = await apply(reg, frame);
  if (!o.ok) throw new Error(`new_chat refused: ${o.code}`);
  return (o.result as { chat: string }).chat;
}

describe("the chatEnded hook (the browser pane's tab mark)", () => {
  test("Archive: told at the archive, and again once its process has ended; the tools hook saw no exit", async () => {
    const { reg, driver, ended, tools } = await setup();
    const chat = await newChat(reg);
    driver.last.emit(turnEnd);
    await settle();
    expect(ended).toEqual([]);
    expect(await apply(reg, { t: "archive", rid: rid(), chat, on: true, stop: false })).toEqual({ ok: true, result: null });
    await settle(10);
    expect(driver.last.closed).toBe(true);
    expect(ended).toEqual([chat, chat]);
    expect(tools).not.toContain(`${chat}:exit`);
  });

  test("Delete: told before the chat goes", async () => {
    const { reg, driver, ended } = await setup();
    const chat = await newChat(reg);
    driver.last.emit(turnEnd);
    await settle();
    expect(await apply(reg, { t: "delete", rid: rid(), chat })).toEqual({ ok: true, result: null });
    await settle(10);
    expect(ended).toContain(chat);
  });

  test("a process that ends by itself: told after its exit event", async () => {
    const { reg, driver, ended, tools } = await setup();
    const chat = await newChat(reg);
    driver.last.end({ code: 1, signal: null });
    await settle(10);
    expect(tools).toContain(`${chat}:exit`);
    expect(ended).toEqual([chat]);
  });

  test("the idle rule's close of a chat that no page views: told", async () => {
    const { reg, driver, ended } = await setup({ idleMs: 30 });
    autoReply(driver);
    const chat = await newChat(reg);
    await settle();
    expect(ended).toEqual([]);
    await Bun.sleep(80);
    expect(driver.last.closed).toBe(true);
    expect(ended).toEqual([chat]);
  });
});
