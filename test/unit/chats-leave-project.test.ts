// Row 99, an environment's Remove in the registry (leaveProject): every chat of the project leaves kitespan as Delete
// takes it, but its Claude Code transcript stays (no deleteSession); an idle process ends at once, as Archive ends it;
// its ledger, draft, notes, queue file and upload records go; every page gets `gone`; the other projects' chats stay;
// and no chat starts in the project afterwards. projectBusy says when a chat there works or needs input.
import { describe, expect, test } from "bun:test";
import type { ChatDelta, ChatEvent, NewChatFrame, PermissionCard } from "../../shared/protocol";
import { ChatRegistry } from "../../server/chats/registry";
import { FakeBash, FakeDriver, MemoryStore, RecordingViewer, apply, autoReply, projectRecord, settle, uploadRecord } from "../../server/chats/testing";

const PROJECT = "k3m7q2x4ab";
const OTHER = "abcdefghij";
const rid = () => crypto.randomUUID();

async function setup() {
  const driver = new FakeDriver();
  const store = new MemoryStore();
  store.projects = [projectRecord(PROJECT, "/srv/work/app"), projectRecord(OTHER, "/srv/work/other")];
  const continued: string[] = [];
  const reg = new ChatRegistry({ driver, store, bash: new FakeBash(), continued: (id) => continued.push(id) }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500 });
  await reg.boot();
  const deltas: ChatDelta[] = [];
  reg.subscribe((d) => deltas.push(d));
  return { driver, store, reg, deltas, continued };
}

function newChatFrame(text: string, project = PROJECT): NewChatFrame {
  return { t: "new_chat", rid: rid(), project, uuid: rid(), text, picks: { model: null, effort: null, mode: null }, uploads: [] };
}

async function newChat(reg: ChatRegistry, text: string, project = PROJECT): Promise<string> {
  const o = await apply(reg, newChatFrame(text, project));
  if (!o.ok) throw new Error(`new_chat refused: ${o.code}`);
  return (o.result as { chat: string }).chat;
}

const turnEnd: ChatEvent = { k: "turn_end", ok: true, subtype: "success", durationMs: 3, error: null, uuids: [] };
const permission: PermissionCard = {
  kind: "permission",
  id: "toolu_1",
  toolUseId: "toolu_1",
  toolName: "Bash",
  title: null,
  displayName: null,
  description: null,
  reason: null,
  blockedPath: null,
  input: { command: "ls" },
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  sessionRule: true,
  parent: null,
};

describe("leaveProject (row 99)", () => {
  test("each chat of the project goes with its records, its transcript stays, and the other project's chat stays", async () => {
    const { reg, driver, store, deltas } = await setup();
    autoReply(driver);
    const live = await newChat(reg, "idle and live");
    const asleep = await newChat(reg, "goes to sleep");
    const other = await newChat(reg, "elsewhere", OTHER);
    await settle(10);
    // One chat sleeps, one keeps its idle process; one is archived.
    await apply(reg, { t: "archive", rid: rid(), chat: asleep, on: true, stop: false });
    await settle(10);
    const liveChat = driver.opens.find((c) => c.input.cwd === "/srv/work/app" && !c.isEnded)!;
    expect(liveChat).toBeDefined();
    const sids = [live, asleep].map((id) => store.chats.get(id)!.sessionId!);
    await reg.draftEdit({ t: "draft", chat: live, text: "unsent words", mode: "chat", command: null, link: false, uploads: [] }, "tab_a");
    await store.putUpload(uploadRecord("abcdefghijklmnop", live, PROJECT));
    const v = new RecordingViewer();
    await reg.attach(live, v);
    expect(reg.chatsIn(PROJECT).sort()).toEqual([live, asleep].sort());
    // Each with the folder that holds its transcript: these chats ran in their project's folder.
    expect(reg.sessionsIn(PROJECT).sort((a, b) => (a.id < b.id ? -1 : 1))).toEqual([...sids].sort().map((id) => ({ id, dir: "/srv/work/app" })));
    expect(reg.sessionsIn(OTHER)).toEqual([{ id: store.chats.get(other)!.sessionId!, dir: "/srv/work/other" }]);
    expect(reg.projectBusy(PROJECT)).toBe(false);

    expect(await reg.leaveProject(PROJECT)).toBe(true);
    // The idle process ended as Archive ends it: closed, never interrupted.
    expect(liveChat.calls).toContain("close");
    expect(liveChat.calls).not.toContain("interrupt");
    expect(driver.deletedSessions).toEqual([]);
    expect(driver.order).not.toContain("deleteSession");
    for (const sid of sids) expect(driver.sessions.has(sid)).toBe(true);
    for (const id of [live, asleep]) {
      expect(store.chats.has(id)).toBe(false);
      expect(store.drafts.has(id)).toBe(false);
      expect(store.notes.has(id)).toBe(false);
      expect(store.queues.has(id)).toBe(false);
      expect(deltas).toContainEqual({ chat: id, gone: true });
      expect(reg.has(id)).toBe(false);
    }
    expect(store.uploads.size).toBe(0);
    expect(v.goneCount).toBe(1);
    expect(reg.chatsIn(PROJECT)).toEqual([]);
    for (const sid of sids) expect(reg.chatForSession(sid)).toBeNull();
    expect(reg.list().map((r) => r.chat)).toEqual([other]);
    expect(store.chats.has(other)).toBe(true);
  });

  test("no chat starts in the project afterwards: new_chat and continue_session get not_found", async () => {
    const { reg, driver } = await setup();
    const sid = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    driver.transcript(sid, "From the terminal", "/srv/work/app");
    expect(await reg.leaveProject(PROJECT)).toBe(true);
    expect(await apply(reg, newChatFrame("too late"))).toEqual({ ok: false, code: "not_found" });
    expect(await apply(reg, { t: "continue_session", rid: rid(), project: PROJECT, session: sid })).toEqual({ ok: false, code: "not_found" });
    expect((await apply(reg, newChatFrame("still fine", OTHER))).ok).toBe(true);
  });

  test("projectBusy: a running turn or a waiting card makes it busy; an idle chat does not", async () => {
    const { reg, driver } = await setup();
    const chat = await newChat(reg, "long task");
    const c = driver.last;
    await settle();
    expect(reg.projectBusy(PROJECT)).toBe(true);
    expect(reg.projectBusy(OTHER)).toBe(false);
    c.emit(turnEnd);
    await settle(10);
    expect(reg.stateOf(chat)).toBe("idle");
    expect(reg.projectBusy(PROJECT)).toBe(false);
    await apply(reg, { t: "send", rid: rid(), chat, uuid: rid(), text: "again", draftRev: null, uploads: [] });
    await settle();
    c.emit(turnEnd);
    await settle(10);
    c.ask(permission);
    await settle();
    expect(reg.stateOf(chat)).toBe("waiting");
    expect(reg.projectBusy(PROJECT)).toBe(true);
  });

  test("a Continue here or a Continue in a copy that makes a chat tells the host its session (it is released no more)", async () => {
    const { reg, driver, continued } = await setup();
    const plain = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    const forked = "0b1e2a3c-4d5e-4f60-8172-93a4b5c6d7e8";
    driver.transcript(plain, "A removed chat", "/srv/work/app");
    driver.transcript(forked, "Another removed chat", "/srv/work/app");
    expect((await apply(reg, { t: "continue_session", rid: rid(), project: PROJECT, session: plain })).ok).toBe(true);
    // Continue here again opens the chat that holds it: no new chat, nothing more to tell.
    expect((await apply(reg, { t: "continue_session", rid: rid(), project: PROJECT, session: plain })).ok).toBe(true);
    expect((await apply(reg, { t: "continue_session", rid: rid(), project: PROJECT, session: forked, fork: true })).ok).toBe(true);
    expect(continued).toEqual([plain, forked]);
  });
});
