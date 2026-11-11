// U5 (DESIGN-U5 10 "Cache"): the registry's part of the message search. searchChats lists every chat it holds,
// archived ones too, with its session, the folder its session functions read (a chat's sessionDir) and its last
// activity; transcriptChanged is told on each turn's end, compaction and reset that it relays, so the index reads the
// chat again; and the index over the registry and the scripted driver finds an archived chat's words.
import { describe, expect, test } from "bun:test";
import type { ChatEvent } from "../../shared/protocol";
import { ChatRegistry } from "../../server/chats/registry";
import { FakeBash, FakeDriver, MemoryStore, RecordingViewer, apply, projectRecord, settle } from "../../server/chats/testing";
import { MessageIndex } from "../../server/search/messages";
import type { ChatLedger } from "../../server/store/types";

const PROJECT = "k3m7q2x4ab";
const OLD = "k3m7q2x4abk3m7q2x4ab";
const ARCHIVED = "abcdefghijabcdefghij";
const SID_OLD = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const SID_ARCHIVED = "8d0f7780-8536-41ef-a55c-f18ad2a01bf8";

function ledger(id: string, sessionId: string | null, at: string, more: Partial<ChatLedger> = {}): ChatLedger {
  return { v: 1, id, project: PROJECT, cwd: "/srv/work/app", agent: "claude-code", sessionId, title: { text: "A title", from: "renamed" }, picks: { model: null, effort: null, permissionMode: null }, createdAt: at, seenAt: at, lastActivityAt: at, lastSeq: 0, state: "sleeping", lastExit: null, archivedAt: null, ...more };
}

async function setup() {
  const driver = new FakeDriver();
  const store = new MemoryStore();
  store.projects = [projectRecord(PROJECT)];
  store.chats.set(OLD, ledger(OLD, SID_OLD, "2026-11-05T08:00:00.000Z", { sessionDir: "/srv/work/app-worktree" }));
  store.chats.set(ARCHIVED, ledger(ARCHIVED, SID_ARCHIVED, "2026-11-01T08:00:00.000Z", { archivedAt: "2026-11-02T08:00:00.000Z" }));
  const changed: string[] = [];
  const reg = new ChatRegistry({ driver, store, bash: new FakeBash(), transcriptChanged: (chat) => changed.push(chat) }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500, openCheckMs: 15, openFastMs: 15 });
  await reg.boot();
  await settle();
  return { reg, driver, store, changed };
}

const ended: ChatEvent = { k: "turn_end", ok: true, subtype: "success", durationMs: 2, error: null, uuids: [] };

describe("the registry's part", () => {
  test("searchChats: every chat, archived ones too, with the session's folder and the last activity", async () => {
    const { reg } = await setup();
    const rows = reg.searchChats().sort((a, b) => a.chat.localeCompare(b.chat));
    expect(rows).toEqual([
      { chat: ARCHIVED, sessionId: SID_ARCHIVED, dir: "/srv/work/app", activity: Date.parse("2026-11-01T08:00:00.000Z") },
      { chat: OLD, sessionId: SID_OLD, dir: "/srv/work/app-worktree", activity: Date.parse("2026-11-05T08:00:00.000Z") },
    ]);
    await reg.shutdown();
  });

  test("transcriptChanged on a turn's end, a compaction and a reset; not on the turn's other events", async () => {
    const { reg, driver, changed } = await setup();
    const o = await apply(reg, { t: "new_chat", rid: crypto.randomUUID(), project: PROJECT, uuid: crypto.randomUUID(), text: "hello", picks: { model: null, effort: null, mode: null }, uploads: [] });
    if (!o.ok) throw new Error("new_chat refused");
    const chat = (o.result as { chat: string }).chat;
    const v = new RecordingViewer("tab_a");
    await reg.attach(chat, v);
    const c = driver.last;
    c.emit({ k: "turn_start", by: "user" }, { k: "block", key: "msg_1:0", kind: "text", text: "hi", parent: null });
    await settle();
    expect(changed).toEqual([]);
    c.emit(ended);
    await settle();
    c.emit({ k: "compacted", trigger: "manual" });
    await settle();
    c.emit({ k: "reset", trigger: "clear" });
    await settle();
    expect(changed).toEqual([chat, chat, chat]);
    await reg.shutdown();
  });
});

describe("the index over the registry", () => {
  test("an archived chat's words are found; a deleted chat's are not", async () => {
    const { reg, driver } = await setup();
    for (const [sid, text] of [
      [SID_OLD, "the zebra in the worktree"],
      [SID_ARCHIVED, "the archived zebra"],
    ] as const) {
      driver.sessions.set(sid, { sessionId: sid, title: "", customTitle: null, lastModified: 1, cwd: "/srv/work/app", fileSize: 10 });
      driver.histories.set(sid, [{ k: "user", uuid: crypto.randomUUID(), text, queued: false }]);
    }
    const index = new MessageIndex({
      chats: () => reg.searchChats(),
      stamp: async (sid, dir) => {
        const info = await driver.sessionInfo(sid, dir);
        return info ? { size: info.fileSize ?? -1, mtime: info.lastModified } : null;
      },
      events: (sid, dir) => driver.transcriptEvents(sid, dir),
      timer: false,
    });
    const r = await index.search({ q: "zebra", tab: null, read: true });
    expect(r?.hits.map((h) => [h.chat, h.snippet])).toEqual([
      [OLD, "the zebra in the worktree"],
      [ARCHIVED, "the archived zebra"],
    ]);
    // The folder that the session functions read: the chat's sessionDir.
    expect(driver.transcriptReads).toContainEqual({ sessionId: SID_OLD, cwd: "/srv/work/app-worktree" });
    index.forget(ARCHIVED);
    expect(index.heldChats()).toEqual([OLD]);
    await reg.shutdown();
  });
});
