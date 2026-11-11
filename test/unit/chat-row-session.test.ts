// The chat list's `session` (W5, D58): a row carries the ledger's Claude Code session id once the chat's transcript is
// known to exist, so a page that never saw the chat's `session` event (a reload, a second device, a restart) can still
// fork it (Continue in a copy) and name it (Copy the command, the Session fact). A delta carries it when it changes.
// FIX-W25b 1.5: before the transcript exists (a first start that failed before Claude Code's init) the row names none:
// the ledger keeps a flag (`transcript`), set by the session's first init, by a transcript that a start's check
// finds, by Continue here and a copy, and cleared by a new transcript (the sessionId rule) with `sessionDir`.
import { describe, expect, test } from "bun:test";
import { applyChatsFrame, type ChatDelta, type ChatRow, type SendFrame } from "../../shared/protocol";
import { ChatRegistry } from "../../server/chats/registry";
import { FakeBash, FakeDriver, MemoryStore, apply, autoReply, projectRecord, settle } from "../../server/chats/testing";
import type { Outcome } from "../../server/chats/types";
import type { ChatLedger } from "../../server/store/types";

const PROJECT = "k3m7q2x4ab";
const CWD = "/srv/work/app";
const CHAT = "abcdefghijklmnopqrst";
const rid = () => crypto.randomUUID();
const chatOf = (o: Outcome) => (o.ok ? (o.result as { chat: string }).chat : "");
const rowOf = (reg: ChatRegistry, chat: string) => reg.list().find((r) => r.chat === chat);
const newChat = (text = "hello") => ({ t: "new_chat" as const, rid: rid(), project: PROJECT, uuid: rid(), text, picks: { model: null, effort: null, mode: null }, uploads: [] });
const send = (chat: string, text: string): SendFrame => {
  const r = rid();
  return { t: "send", rid: r, chat, uuid: r, text, draftRev: null, uploads: [] };
};
/** Claude Code exits before its init: the start failed, and no transcript was written. */
const failBeforeInit = (driver: FakeDriver) => {
  driver.script = (chat) => setTimeout(() => chat.end({ code: 1, signal: null }), 0);
};
const sessionDeltas = (deltas: ChatDelta[], chat: string) => deltas.flatMap((d) => (d.chat === chat && "session" in d ? [d.session] : []));

function ledger(over: Partial<ChatLedger>): ChatLedger {
  return {
    v: 1,
    id: CHAT,
    project: PROJECT,
    cwd: CWD,
    agent: "claude-code",
    sessionId: null,
    title: { text: "Old chat", from: "first-prompt" },
    picks: { model: null, effort: null, permissionMode: null },
    createdAt: "2026-10-30T08:00:00.000Z",
    seenAt: "2026-10-30T08:00:00.000Z",
    lastActivityAt: "2026-10-30T08:00:00.000Z",
    lastSeq: 0,
    state: "sleeping",
    lastExit: null,
    archivedAt: null,
    ...over,
  };
}

async function setup(store = new MemoryStore(), driver = new FakeDriver()) {
  store.projects = [projectRecord(PROJECT, CWD)];
  const reg = new ChatRegistry({ driver, store, bash: new FakeBash() }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500 });
  await reg.boot();
  const deltas: ChatDelta[] = [];
  reg.subscribe((d) => deltas.push(d));
  return { driver, store, reg, deltas };
}

describe("the chat row's session", () => {
  test("a chat on a past session: its row and the delta that adds it carry the session, and so does the list after a restart", async () => {
    const { reg, driver, store, deltas } = await setup();
    const sid = rid();
    driver.transcript(sid, "Plan the release", CWD);
    const chat = chatOf(await apply(reg, { t: "continue_session", rid: rid(), project: PROJECT, session: sid }));
    expect(rowOf(reg, chat)?.session).toBe(sid);
    expect(deltas.find((d) => d.chat === chat && "session" in d)).toMatchObject({ chat, session: sid });
    expect((await store.readChat(chat))!.transcript).toBe(true);
    await reg.shutdown();
    // A new server life, with a driver that knows no transcript: the row comes from the ledger alone.
    const next = await setup(store, new FakeDriver());
    expect(rowOf(next.reg, chat)?.session).toBe(sid);
    await next.reg.shutdown();
  });

  test("a new chat has none until Claude Code's init of its session; then a delta carries it", async () => {
    const { reg, driver, deltas } = await setup();
    autoReply(driver);
    const chat = chatOf(await apply(reg, newChat("first")));
    await settle(10);
    const sid = rowOf(reg, chat)?.session;
    expect(typeof sid).toBe("string");
    expect(sid).toBe(driver.last.input.sessionId?.value);
    const list = deltas.reduce<ChatRow[]>((rows, delta) => applyChatsFrame(rows, { t: "chats", delta }), []);
    expect(list.find((r) => r.chat === chat)?.session).toBe(sid);
    await reg.shutdown();
  });

  test("a first start that fails before init names no session; after init the row names it; after a restart it still does", async () => {
    const { reg, driver, store, deltas } = await setup();
    failBeforeInit(driver);
    const chat = chatOf(await apply(reg, newChat("first")));
    await settle(10);
    const sid = driver.last.input.sessionId!.value;
    // The ledger has the id that kitespan picked (D41), but no transcript is known: the row and every delta name none.
    expect((await store.readChat(chat))!.sessionId).toBe(sid);
    expect((await store.readChat(chat))!.transcript).toBeUndefined();
    expect(rowOf(reg, chat)?.session ?? null).toBeNull();
    expect(sessionDeltas(deltas, chat).every((s) => s === null)).toBe(true);
    await reg.shutdown();
    // Still none in the next server life.
    const next = await setup(store, driver);
    expect(rowOf(next.reg, chat)?.session ?? null).toBeNull();
    // The next start's init: the row names the session, and a delta carries it.
    autoReply(driver);
    expect((await apply(next.reg, send(chat, "again"))).ok).toBe(true);
    await settle(10);
    expect(driver.last.input.sessionId?.value).toBe(sid);
    expect(rowOf(next.reg, chat)?.session).toBe(sid);
    expect(sessionDeltas(next.deltas, chat)).toEqual([sid]);
    expect((await store.readChat(chat))!.transcript).toBe(true);
    await next.reg.shutdown();
    // A server restart, with a driver that knows no transcript: the ledger's flag names it.
    const third = await setup(store, new FakeDriver());
    expect(rowOf(third.reg, chat)?.session).toBe(sid);
    await third.reg.shutdown();
  });

  test("a start whose check finds the transcript sets the flag; a new transcript (the sessionId rule) clears it with sessionDir", async () => {
    const sid = rid();
    const store = new MemoryStore();
    store.chats.set(CHAT, ledger({ sessionId: sid, transcript: true, sessionDir: "/srv/work/app-gone" }));
    // The transcript is gone (no driver knows it), so the next start makes a new one under the same id.
    const { reg, driver, deltas } = await setup(store);
    expect(rowOf(reg, CHAT)?.session).toBe(sid);
    failBeforeInit(driver);
    expect((await apply(reg, send(CHAT, "hello"))).ok).toBe(true);
    await settle(10);
    expect(driver.last.input.sessionId?.value).toBe(sid);
    expect(driver.last.input.resume).toBeNull();
    const l = (await store.readChat(CHAT))!;
    expect(l.transcript).toBeUndefined();
    expect(l.sessionDir).toBeUndefined();
    expect(rowOf(reg, CHAT)?.session ?? null).toBeNull();
    expect(sessionDeltas(deltas, CHAT)).toEqual([null]);
    // The transcript exists now (written by a terminal's Claude Code, say): the next start's check finds it and resumes.
    driver.transcript(sid, "hello", CWD);
    driver.script = null;
    expect((await apply(reg, send(CHAT, "again"))).ok).toBe(true);
    await settle(10);
    expect(driver.last.input.resume?.value).toBe(sid);
    expect((await store.readChat(CHAT))!.transcript).toBe(true);
    expect(rowOf(reg, CHAT)?.session).toBe(sid);
    await reg.shutdown();
  });

  test("a ledger from before the flag: the boot's check names a session whose transcript exists, and only that one", async () => {
    const [had, never] = [rid(), rid()];
    const OTHER = "bcdefghijklmnopqrstu";
    const store = new MemoryStore();
    store.chats.set(CHAT, ledger({ sessionId: had }));
    store.chats.set(OTHER, ledger({ id: OTHER, sessionId: never }));
    const driver = new FakeDriver();
    driver.transcript(had, "Old chat", CWD);
    const { reg } = await setup(store, driver);
    expect(rowOf(reg, CHAT)?.session).toBe(had);
    expect(rowOf(reg, OTHER)?.session ?? null).toBeNull();
    expect((await store.readChat(CHAT))!.transcript).toBe(true);
    expect((await store.readChat(OTHER))!.transcript).toBeUndefined();
    await reg.shutdown();
  });

  test("Continue in a copy: the copy's transcript exists, so its row names its session at once", async () => {
    const { reg, driver, store } = await setup();
    const sid = rid();
    driver.transcript(sid, "Plan the release", CWD);
    const chat = chatOf(await apply(reg, { t: "continue_session", rid: rid(), project: PROJECT, session: sid, fork: true }));
    const copy = driver.forks[0]!.id;
    expect(rowOf(reg, chat)?.session).toBe(copy);
    expect((await store.readChat(chat))!.transcript).toBe(true);
    await reg.shutdown();
  });
});
