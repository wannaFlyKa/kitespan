// The page draws messages in the order Claude Code runs them (6.3, R13): the registry (the scripted driver) feeds the
// page's store through a fake socket. Restored Not sent messages go first with the chat's next send, so this page's new
// message goes after them; with two tabs during a cut, the message that reached the server first is drawn first on
// both, as a reload draws it. This page's own message waits at the end until the server's first event for it places it.
import { afterAll, describe, expect, test } from "bun:test";
import { ChatRegistry } from "../../server/chats/registry";
import { FakeBash, FakeDriver, MemoryStore, RecordingViewer, apply, projectRecord, settle } from "../../server/chats/testing";
import type { RegistryOptions } from "../../server/chats/types";
import { PROTOCOL_VERSION, type ChatEvent, type ClientFrame, type ServerFrame } from "../../shared/protocol";
import { Connection, type SocketLike } from "../../web/net/socket";
import { act, connectWith, getState, resetState } from "../../web/state/store";

const g = globalThis as unknown as { window?: Record<string, unknown>; localStorage?: unknown };
const own = { window: !g.window, storage: !g.localStorage };
class MemoryStorage {
  map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}
g.window ??= {};
g.localStorage ??= new MemoryStorage();
afterAll(() => {
  if (own.window) delete g.window;
  if (own.storage) delete g.localStorage;
  connectWith(null);
  resetState();
});

class FakeSocket implements SocketLike {
  readyState = 1;
  sent: ClientFrame[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data) as ClientFrame);
  }
  close() {}
  receive(f: unknown) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
}

const PROJECT = "k3m7q2x4ab";
const rid = () => crypto.randomUUID();
const turnEnd = (uuids: string[]): ChatEvent => ({ k: "turn_end", ok: true, subtype: "success", durationMs: 3, error: null, uuids });
const reply = (key: string, text: string): ChatEvent => ({ k: "block", key, kind: "text", text, parent: null });

async function life(driver: FakeDriver, store: MemoryStore, opts: RegistryOptions = {}) {
  const reg = new ChatRegistry({ driver, store, bash: new FakeBash() }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500, openCheckMs: 15, openFastMs: 15, ...opts });
  await reg.boot();
  await settle();
  return reg;
}
async function newChat(reg: ChatRegistry, text: string): Promise<{ chat: string; uuid: string }> {
  const uuid = rid();
  const o = await apply(reg, { t: "new_chat", rid: rid(), project: PROJECT, uuid, text, picks: { model: null, effort: null, mode: null }, uploads: [] });
  if (!o.ok) throw new Error(`new_chat refused: ${o.code}`);
  return { chat: (o.result as { chat: string }).chat, uuid };
}

/**
 * This page (tab_me) on the registry's chat: the welcome, the list, the open, and the attach's frames. `deliver` hands
 * the page each event the registry gave its viewer since the last call, and `sendOf` applies the page's own send.
 */
async function page(reg: ChatRegistry, chat: string) {
  resetState();
  const sock = new FakeSocket();
  const conn = new Connection({ url: "ws://127.0.0.1:7946/ws", tab: "tab_me", open: () => sock, now: () => 0, setTimer: () => 0, clearTimer: () => {}, random: () => 0.5, reload: () => {} });
  connectWith(conn);
  conn.start();
  sock.onopen?.({});
  sock.receive({ t: "welcome", epoch: reg.epoch, version: "0.1.0", v: PROTOCOL_VERSION, claude: { ok: true, version: "2.1.317", drift: null }, update: { available: false }, auth: "none" });
  sock.receive({ t: "chats", list: reg.list() });
  act.open(chat);
  const v = new RecordingViewer("tab_me");
  const p = (await reg.attach(chat, v))!;
  sock.receive(p.attached);
  if (p.snapshot) sock.receive(p.snapshot);
  for (const it of p.tail) sock.receive(JSON.parse(it.json));
  let given = 0;
  const deliver = async () => {
    await settle();
    for (const it of v.items.slice(given)) sock.receive(JSON.parse(it.json));
    given = v.items.length;
  };
  /** The page's last `send` reaches the server now; its events and its ack come back. */
  const sendOf = async () => {
    const f = sock.sent.filter((x) => x.t === "send").at(-1) as Extract<ClientFrame, { t: "send" }>;
    const o = await apply(reg, f, { tab: "tab_me" });
    await deliver();
    sock.receive({ t: "ack", rid: f.rid, ok: true, result: o.ok ? (o.result ?? null) : null } satisfies ServerFrame);
    return f;
  };
  return { sock, deliver, sendOf };
}

/** The chat's rows as the page draws them: a message's text with its marks, another row's kind. */
function rows(chat: string): string[] {
  return getState()
    .chats.find((c) => c.id === chat)!
    .items.map((i) => (i.kind === "user" ? `${i.text}${i.queued ? " (Queued)" : ""}${i.notSent ? " (Not sent)" : ""}` : i.kind === "assistant" ? `reply: ${i.markdown}` : i.kind));
}

describe("the page's order is the server's (6.3, R13)", () => {
  test("restored Not sent messages, then a plain send: the new message goes after them, and the first reply goes under the first message", async () => {
    const driver = new FakeDriver();
    const store = new MemoryStore();
    store.projects = [projectRecord(PROJECT)];
    // maxLive 1: the first chat's turn holds the slot, so the second chat's messages wait; a stop keeps them (RD-8).
    const reg = await life(driver, store, { maxLive: 1 });
    await newChat(reg, "busy");
    const { chat } = await newChat(reg, "other");
    expect(await apply(reg, { t: "send", rid: rid(), chat, uuid: rid(), text: "for the slot", draftRev: null, uploads: [] })).toEqual({ ok: true, result: { queued: true } });
    await reg.shutdown();
    const next = await life(driver, store, { maxLive: 1 });
    const { deliver, sendOf } = await page(next, chat);
    expect(rows(chat)).toEqual(["other (Queued) (Not sent)", "for the slot (Queued) (Not sent)"]);

    void act.send(chat, "a new one");
    // It waits behind them on the server, so it shows there at once.
    expect(rows(chat)).toEqual(["other (Queued) (Not sent)", "for the slot (Queued) (Not sent)", "a new one (Queued)"]);
    await sendOf();
    expect(driver.last.sent.map((s) => s.text)).toEqual(["other", "for the slot", "a new one"]);
    expect(rows(chat)).toEqual(["other", "for the slot (Queued)", "a new one (Queued)"]);
    driver.last.emit(reply("msg_r1:0", "to the first"));
    await deliver();
    expect(rows(chat)).toEqual(["other", "reply: to the first", "for the slot (Queued)", "a new one (Queued)"]);
  });

  test("two tabs during a cut, while a turn runs: the other tab's message reached the server first, so this page draws it first", async () => {
    const driver = new FakeDriver();
    const store = new MemoryStore();
    store.projects = [projectRecord(PROJECT)];
    const reg = await life(driver, store);
    const first = await newChat(reg, "the long one");
    const { sock, deliver, sendOf } = await page(reg, first.chat);
    // This page sends during the cut; the other tab's message gets to the server first.
    void act.send(first.chat, "from B");
    const fromA = { t: "send" as const, rid: rid(), chat: first.chat, uuid: rid(), text: "from A", draftRev: null, uploads: [] };
    await apply(reg, fromA, { tab: "tab_a" });
    expect(rows(first.chat)).toEqual(["the long one", "from B (Queued)"]);
    await sendOf();
    expect(rows(first.chat)).toEqual(["the long one", "from A (Queued)", "from B (Queued)"]);
    // The long turn ends; Claude Code starts on the other tab's message, and replies to it.
    driver.last.emit(turnEnd([first.uuid]), { k: "turn_start", by: "user" }, reply("msg_a:0", "to A"));
    await deliver();
    expect(rows(first.chat)).toEqual(["the long one", "from A", "reply: to A", "from B (Queued)"]);
    void sock;
  });

  test("two tabs during a cut, on an idle chat: the other tab's turn ran and ended first; this page's message goes under it", async () => {
    const driver = new FakeDriver();
    const store = new MemoryStore();
    store.projects = [projectRecord(PROJECT)];
    const reg = await life(driver, store);
    const first = await newChat(reg, "hello");
    driver.last.emit(turnEnd([first.uuid]));
    const { deliver, sendOf } = await page(reg, first.chat);
    void act.send(first.chat, "from B");
    expect(rows(first.chat)).toEqual(["hello", "from B"]);
    const fromA = { t: "send" as const, rid: rid(), chat: first.chat, uuid: rid(), text: "from A", draftRev: null, uploads: [] };
    await apply(reg, fromA, { tab: "tab_a" });
    driver.last.emit(reply("msg_a:0", "to A"), turnEnd([fromA.uuid]));
    await deliver();
    // The server's rows go above this page's message, which the server has not shown yet.
    expect(rows(first.chat)).toEqual(["hello", "from A", "reply: to A", "from B"]);
    await sendOf();
    driver.last.emit(reply("msg_b:0", "to B"));
    await deliver();
    expect(rows(first.chat)).toEqual(["hello", "from A", "reply: to A", "from B", "reply: to B"]);
  });

  test("two sends of this page while a turn runs keep their order at each event (no jump)", async () => {
    const driver = new FakeDriver();
    const store = new MemoryStore();
    store.projects = [projectRecord(PROJECT)];
    const reg = await life(driver, store);
    const first = await newChat(reg, "the long one");
    const { sock, deliver } = await page(reg, first.chat);
    void act.send(first.chat, "one");
    void act.send(first.chat, "two");
    const [one, two] = sock.sent.filter((x) => x.t === "send") as Extract<ClientFrame, { t: "send" }>[];
    await apply(reg, one!, { tab: "tab_me" });
    await deliver();
    expect(rows(first.chat)).toEqual(["the long one", "one (Queued)", "two (Queued)"]);
    await apply(reg, two!, { tab: "tab_me" });
    await deliver();
    expect(rows(first.chat)).toEqual(["the long one", "one (Queued)", "two (Queued)"]);
  });
});

describe("a page that opens after the ring dropped what still waits (the server keeps its event outside the ring)", () => {
  test("a message in Claude Code's queue behind a long turn, then more events than the ring holds: a new page draws it once, Queued, with Take back", async () => {
    const driver = new FakeDriver();
    const store = new MemoryStore();
    store.projects = [projectRecord(PROJECT)];
    const reg = await life(driver, store);
    const first = await newChat(reg, "a long turn");
    const c = driver.last;
    c.emit({ k: "block_start", key: "m1:0", kind: "text", parent: null });
    const behind = { t: "send" as const, rid: rid(), chat: first.chat, uuid: rid(), text: "behind the long turn", draftRev: null, uploads: [] };
    expect(await apply(reg, behind, { tab: "tab_a" })).toEqual({ ok: true, result: { queued: false } });
    await settle();
    for (let i = 0; i < 2_500; i++) c.emit({ k: "block_delta", key: "m1:0", text: "word " });
    await settle();
    const { sock } = await page(reg, first.chat);
    expect(rows(first.chat).filter((r) => r.startsWith("behind the long turn"))).toEqual(["behind the long turn (Queued)"]);
    // Another page's message: not this page's outgoing one, so the bubble offers Take back (Text.tsx), which sends it.
    const item = getState().chats.find((x) => x.id === first.chat)!.items.find((i) => i.kind === "user" && i.text === "behind the long turn")!;
    expect(getState().outgoing[first.chat] ?? []).not.toContain(item.id);
    act.takeBack(first.chat, item.id);
    expect(sock.sent.filter((f) => f.t === "take_back").map((f) => (f as Extract<ClientFrame, { t: "take_back" }>).uuid)).toEqual([behind.uuid]);
    await reg.shutdown();
  });
});
