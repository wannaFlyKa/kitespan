// A message is applied once by its uuid, whatever its request id (DESIGN.md 4.3; D49): the page sends a message that a
// reload put back in the box with that message's own uuid and a new rid (web/state/store.ts restoredSends), while its
// first copy may still be on its way in an old socket's stream. The ack store keys by rid, so both frames reach the
// registry; the registry runs the message once, whichever copy comes second and whatever the first is doing: on the
// input, in Claude Code's queue behind a turn, waiting for its chat's start, waiting for a free slot, or applied by the
// server before this one. The scripted driver stands in for Claude Code and MemoryStore for the disk.

import { describe, expect, test } from "bun:test";
import type { ChatEvent, NewChatFrame, SendFrame } from "../../shared/protocol";
import { ChatRegistry } from "../../server/chats/registry";
import { FakeBash, FakeDriver, MemoryStore, RecordingViewer, apply, projectRecord, settle } from "../../server/chats/testing";
import type { RegistryOptions } from "../../server/chats/types";

const PROJECT = "k3m7q2x4ab";
const rid = () => crypto.randomUUID();
const turnEnd = (uuids: string[] = []): ChatEvent => ({ k: "turn_end", ok: true, subtype: "success", durationMs: 3, error: null, uuids });
const newChatFrame = (text: string): NewChatFrame => ({ t: "new_chat", rid: rid(), project: PROJECT, uuid: rid(), text, picks: { model: null, effort: null, mode: null }, uploads: [] });
/** Two copies of one message: one uuid, two rids. */
function copies(chat: string, text: string): [SendFrame, SendFrame] {
  const uuid = rid();
  const one: SendFrame = { t: "send", rid: rid(), chat, uuid, text, draftRev: null, uploads: [] };
  return [one, { ...one, rid: rid() }];
}

async function life(driver: FakeDriver, store: MemoryStore, opts: RegistryOptions = {}) {
  const reg = new ChatRegistry({ driver, store, bash: new FakeBash() }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500, openCheckMs: 15, openFastMs: 15, ...opts });
  await reg.boot();
  await settle();
  return reg;
}
async function setup(opts: RegistryOptions = {}) {
  const driver = new FakeDriver();
  const store = new MemoryStore();
  store.projects = [projectRecord(PROJECT)];
  return { driver, store, reg: await life(driver, store, opts) };
}
async function newChat(reg: ChatRegistry, text: string): Promise<string> {
  const o = await apply(reg, newChatFrame(text));
  if (!o.ok) throw new Error(`new_chat refused: ${o.code}`);
  return (o.result as { chat: string }).chat;
}
/** Every message that every Claude Code of the test got with this uuid. */
const runs = (driver: FakeDriver, uuid: string) => driver.opens.flatMap((c) => c.sent).filter((m) => m.uuid === uuid).length;
const users = (v: RecordingViewer, uuid: string) => v.of("user").filter((e) => e.uuid === uuid);

describe("one uuid, two rids: the message runs once", () => {
  test("on an idle chat: one after the other, and both at once", async () => {
    const { driver, reg } = await setup();
    const chat = await newChat(reg, "first");
    driver.last.emit(turnEnd());
    await settle();
    const v = new RecordingViewer();
    await reg.attach(chat, v);
    const [a, b] = copies(chat, "once");
    expect(await apply(reg, a)).toEqual({ ok: true, result: { queued: false } });
    expect((await apply(reg, b)).ok).toBe(true);
    expect(runs(driver, a.uuid)).toBe(1);
    expect(users(v, a.uuid)).toHaveLength(1);
    driver.last.emit(turnEnd([a.uuid]));
    await settle();
    const [c, d] = copies(chat, "at once");
    const both = await Promise.all([apply(reg, c), apply(reg, d)]);
    expect(both.every((o) => o.ok)).toBe(true);
    expect(runs(driver, c.uuid)).toBe(1);
    expect(users(v, c.uuid)).toHaveLength(1);
    await reg.shutdown();
  });

  test("while the first copy sits in Claude Code's queue behind a running turn", async () => {
    const { driver, reg } = await setup();
    const chat = await newChat(reg, "a long task");
    const [a, b] = copies(chat, "after it");
    expect(await apply(reg, a)).toEqual({ ok: true, result: { queued: false } });
    expect((await apply(reg, b)).ok).toBe(true);
    expect(runs(driver, a.uuid)).toBe(1);
    await reg.shutdown();
  });

  test("while the first copy waits for its sleeping chat's start", async () => {
    const { driver, store } = await setup();
    const one = await life(driver, store);
    const chat = await newChat(one, "first");
    driver.last.emit(turnEnd());
    await settle();
    await one.shutdown();
    const reg = await life(driver, store);
    let go!: () => void;
    driver.probeWait = new Promise<void>((r) => (go = r));
    const [a, b] = copies(chat, "wake up");
    const first = apply(reg, a);
    await settle();
    const second = await apply(reg, b);
    expect(second.ok).toBe(true);
    go();
    expect((await first).ok).toBe(true);
    await settle();
    expect(runs(driver, a.uuid)).toBe(1);
    await reg.shutdown();
  });

  test("while the first copy waits for a free slot (Queued)", async () => {
    const { driver, reg } = await setup({ maxLive: 1 });
    await newChat(reg, "busy");
    const other = await newChat(reg, "other");
    expect(driver.opens).toHaveLength(1);
    const [a, b] = copies(other, "for the slot");
    expect(await apply(reg, a)).toEqual({ ok: true, result: { queued: true } });
    expect(await apply(reg, b)).toEqual({ ok: true, result: { queued: true } });
    // The busy chat's turn ends with no viewer, so it sleeps; the other chat starts with its messages, this one once.
    driver.opens[0]!.emit(turnEnd());
    await settle(10);
    expect(driver.opens).toHaveLength(2);
    expect(driver.opens[1]!.input.chatId).toBe(other);
    expect(driver.opens[1]!.sent.map((s) => s.text)).toEqual(["other", "for the slot"]);
    expect(runs(driver, a.uuid)).toBe(1);
    await reg.shutdown();
  });

  test("applied by the server before this one (its ack was lost in the restart)", async () => {
    const driver = new FakeDriver();
    const store = new MemoryStore();
    store.projects = [projectRecord(PROJECT)];
    const one = await life(driver, store);
    const chat = await newChat(one, "first");
    driver.last.emit(turnEnd());
    await settle();
    const [a, b] = copies(chat, "before the restart");
    expect((await apply(one, a)).ok).toBe(true);
    driver.last.emit(turnEnd([a.uuid]));
    await settle();
    await one.shutdown();
    const two = await life(driver, store);
    const opens = driver.opens.length;
    expect(await apply(two, b)).toEqual({ ok: true, result: { queued: false } });
    await settle();
    expect(driver.opens.length).toBe(opens);
    expect(runs(driver, a.uuid)).toBe(1);
    await two.shutdown();
  });
});
