// R130 (FIX-R130 1, DESIGN-R130 4.1): the notify rule in the chat registry. A moment notifies only while no page has
// the chat on screen: a card opens (permission, or the input of a question or a plan), a turn ends unseen (done, or
// failed for an error or Claude Code's exit by itself), and a background session that the chat started needs input or
// ends unseen while neither its chat nor its line or view is on screen. Never a Stop, Restart now's cut, an archived
// chat or boot. A page's `on` reports the chat seen, a session's line or view that session; Archive and Delete forget
// the chat. Then the whole path: the registry, the notifier and a stub push service that decrypts what it gets. The
// scripted driver, MemoryStore and fake pages stand in for Claude Code, the disk and the browsers.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BgLaunch, ChatEvent, NewChatFrame, PermissionCard, QuestionCard } from "../../shared/protocol";
import type { PushMomentInput, PushPayload } from "../../shared/push";
import type { BgListRow, BgRecord } from "../../server/agents/types";
import { ChatRegistry } from "../../server/chats/registry";
import { FakeDriver, MemoryStore, RecordingViewer, apply, autoReply, projectRecord, settle } from "../../server/chats/testing";
import type { RegistryOptions, RegistryPush } from "../../server/chats/types";
import { createPush } from "../../server/push/service";
import type { ChatLedger } from "../../server/store/types";
import { ownUid } from "../../server/store/files";
import { startPushStub } from "../click/push-stub";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "chats-push-")));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const SHOP = join(ROOT, "srv", "you", "shop");
const WORKER = join(SHOP, "worktrees", "investigate");
mkdirSync(WORKER, { recursive: true });

const PROJECT = "k3m7q2x4ab";
const CHAT = "k3m7q2x4abk3m7q2x4ab";
const SID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const WSID = "7e682626-781a-4916-b942-8fa4f25780e9";
const B = "8a56ad66";
const rid = () => crypto.randomUUID();
const OPTS: RegistryOptions = { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500, openCheckMs: 15, openFastMs: 10, bgLaunchWaitMs: 80, bgListKeepMs: 60 };

type Call = ["moment", PushMomentInput] | ["seen", string] | ["seenBg", string, string] | ["forget", string];

class FakePush implements RegistryPush {
  readonly calls: Call[] = [];
  moment(m: PushMomentInput): void {
    this.calls.push(["moment", structuredClone(m)]);
  }
  seen(chat: string): void {
    this.calls.push(["seen", chat]);
  }
  seenBg(chat: string, id: string): void {
    this.calls.push(["seenBg", chat, id]);
  }
  forget(chat: string): void {
    this.calls.push(["forget", chat]);
  }
  moments(): PushMomentInput[] {
    return this.calls.flatMap((c) => (c[0] === "moment" ? [c[1]] : []));
  }
  kinds(): string[] {
    return this.moments().map((m) => m.moment);
  }
}

function ledger(over: Partial<ChatLedger> = {}): ChatLedger {
  return {
    v: 1,
    id: CHAT,
    project: PROJECT,
    cwd: SHOP,
    agent: "claude-code",
    sessionId: SID,
    transcript: true,
    title: { text: "Fix the flaky upload test", from: "first-prompt" },
    picks: { model: null, effort: null, permissionMode: null },
    createdAt: "2026-11-05T08:00:00.000Z",
    seenAt: "2026-11-05T08:00:00.000Z",
    lastActivityAt: "2026-11-05T08:00:00.000Z",
    lastSeq: 0,
    state: "sleeping",
    lastExit: null,
    archivedAt: null,
    ...over,
  };
}

async function setup(push: RegistryPush, over: Partial<ChatLedger> = {}, history: ChatEvent[] = []) {
  const driver = new FakeDriver();
  const store = new MemoryStore();
  store.projects = [projectRecord(PROJECT, SHOP)];
  store.chats.set(CHAT, ledger(over));
  driver.transcript(SID, "Fix it", SHOP);
  driver.histories.set(SID, history);
  driver.bgList = [];
  const reg = new ChatRegistry({ driver, store, push }, OPTS);
  await reg.boot();
  await settle();
  return { driver, store, reg };
}

/** The chat live, its first turn over while a page had it on screen; the page then gone. */
async function live(w: Awaited<ReturnType<typeof setup>>) {
  autoReply(w.driver);
  const v = new RecordingViewer("tab_first");
  await w.reg.attach(CHAT, v);
  w.reg.onScreen(CHAT, v, true);
  await apply(w.reg, { t: "send", rid: rid(), chat: CHAT, uuid: rid(), text: "go", draftRev: null, uploads: [] });
  await settle(20);
  w.reg.detach(CHAT, v);
  return w.driver.last;
}

const ended = (ok = true): ChatEvent => ({ k: "turn_end", ok, subtype: ok ? "success" : "error_during_execution", durationMs: 2, error: ok ? null : "The API returned an error.", uuids: [] });
const permission = (id: string): PermissionCard => ({ kind: "permission", id, toolUseId: id, toolName: "Bash", title: null, displayName: null, description: null, reason: null, blockedPath: null, input: {}, defaultToNo: false, suppressAlwaysAllowRule: false, sessionRule: false, parent: null });
const question = (id: string): QuestionCard => ({ kind: "question", id, toolUseId: id, questions: [] });

async function turn(c: FakeDriver["last"], end: ChatEvent | null = ended()) {
  c.emit({ k: "turn_start", by: "user" });
  await settle();
  if (end) {
    c.emit(end);
    await settle();
  }
}

describe("a chat's moments", () => {
  test("a turn that ends with no page on screen is one moment with the chat's title; on screen, none; the same kind again, none", async () => {
    const push = new FakePush();
    const w = await setup(push);
    const c = await live(w);
    expect(push.moments()).toEqual([]);
    const v = new RecordingViewer("tab_a");
    await w.reg.attach(CHAT, v);
    await turn(c);
    expect(push.moments()).toEqual([{ chat: CHAT, moment: "done", title: "Fix the flaky upload test" }]);
    // Still unseen: a second end of the same kind changes nothing, so it notifies nothing either.
    await turn(c);
    expect(push.kinds()).toEqual(["done"]);
    await turn(c, ended(false));
    expect(push.kinds()).toEqual(["done", "failed"]);
    w.reg.onScreen(CHAT, v, true);
    expect(push.calls.at(-1)).toEqual(["seen", CHAT]);
    await turn(c);
    await turn(c, ended(false));
    expect(push.kinds()).toEqual(["done", "failed"]);
    // A page that says off: the next end notifies again.
    w.reg.onScreen(CHAT, v, false);
    await turn(c);
    expect(push.kinds()).toEqual(["done", "failed", "done"]);
    await w.reg.shutdown();
  });

  test("a card that opens with no page on screen: the permission's own path; a question is Claude needs your input; on screen, none", async () => {
    const push = new FakePush();
    const w = await setup(push);
    const c = await live(w);
    c.emit({ k: "turn_start", by: "user" });
    await settle();
    c.ask(permission("toolu_01AbCdEf"));
    await settle();
    expect(push.moments()).toEqual([{ chat: CHAT, moment: "permission", title: "Fix the flaky upload test", card: { kind: "permission", id: "toolu_01AbCdEf" } }]);
    c.ask(question("toolu_02Question"));
    await settle();
    expect(push.moments()[1]).toMatchObject({ moment: "input", card: { kind: "question", id: "toolu_02Question" } });
    const v = new RecordingViewer("tab_a");
    await w.reg.attach(CHAT, v);
    w.reg.onScreen(CHAT, v, true);
    c.ask(permission("toolu_03Seen"));
    await settle();
    expect(push.moments().length).toBe(2);
    await w.reg.shutdown();
  });

  test("a Stop and Restart now's cut notify nothing; Claude Code's exit by itself is failed", async () => {
    const push = new FakePush();
    const w = await setup(push);
    const c = await live(w);
    const v = new RecordingViewer("tab_a");
    await w.reg.attach(CHAT, v);
    c.emit({ k: "turn_start", by: "user" });
    await settle();
    const seq = v.items.filter((i) => i.e.k === "turn_start").at(-1)!.seq;
    expect((await apply(w.reg, { t: "interrupt", rid: rid(), chat: CHAT, turn: seq })).ok).toBe(true);
    c.emit({ k: "turn_end", ok: false, subtype: "error_during_execution", durationMs: 2, error: "Request was aborted.", uuids: [] });
    await settle();
    expect(push.moments()).toEqual([]);
    c.end({ code: 1, signal: null });
    await settle(10);
    expect(push.kinds()).toEqual(["failed"]);
    await w.reg.shutdown();
  });

  test("a page heard again with its on reports the chat seen; Archive and Delete forget the chat", async () => {
    const push = new FakePush();
    const w = await setup(push);
    const v = new RecordingViewer("tab_a");
    await w.reg.attach(CHAT, v);
    w.reg.heardAgain(CHAT, v);
    expect(push.calls).toEqual([]);
    w.reg.onScreen(CHAT, v, true);
    w.reg.heardAgain(CHAT, v);
    expect(push.calls).toEqual([
      ["seen", CHAT],
      ["seen", CHAT],
    ]);
    expect((await apply(w.reg, { t: "archive", rid: rid(), chat: CHAT, on: true, stop: false })).ok).toBe(true);
    expect(push.calls.at(-1)).toEqual(["forget", CHAT]);
    expect((await apply(w.reg, { t: "delete", rid: rid(), chat: CHAT })).ok).toBe(true);
    expect(push.calls.at(-1)).toEqual(["forget", CHAT]);
    await w.reg.shutdown();
  });

  test("boot sets the flag that a crash's stop line gives, and notifies nothing", async () => {
    const push = new FakePush();
    const cut: ChatEvent[] = [
      { k: "user", uuid: rid(), text: "run the long one", queued: false },
      { k: "tool_call", id: "toolu_cut", name: "Bash", input: { command: "sleep 20" }, parent: null },
    ];
    const w = await setup(push, { stop: { why: "running", by: "crash", at: "2026-11-05T08:00:00.000Z" } }, cut);
    await settle(10);
    expect(w.reg.list().find((r) => r.chat === CHAT)?.unseen).toBe("failed");
    expect(push.moments()).toEqual([]);
    await w.reg.shutdown();
  });

  test("a chat that a new_chat frame made notifies with its first prompt's title", async () => {
    const push = new FakePush();
    const w = await setup(push);
    autoReply(w.driver);
    const frame: NewChatFrame = { t: "new_chat", rid: rid(), project: PROJECT, uuid: rid(), text: "Plan the upload feature", picks: { model: null, effort: null, mode: null }, uploads: [] };
    const o = await apply(w.reg, frame);
    await settle(20);
    const chat = (o as { result: { chat: string } }).result.chat;
    expect(push.moments().filter((m) => m.chat === chat)).toEqual([{ chat, moment: "done", title: "Plan the upload feature" }]);
    await w.reg.shutdown();
  });
});

describe("a background session's moments", () => {
  const launch = (id: string): BgLaunch => ({ id, name: "investigate", idle: false });
  const rec = (over: Partial<BgRecord> = {}): BgRecord => ({ jobId: B, sessionId: WSID, name: "investigate", cwd: WORKER, status: "busy", waitingFor: null, startedAt: 1_762_300_000_000, pid: 4242, procStart: "777", ...over });
  const row = (over: Partial<BgListRow> = {}): BgListRow => ({ id: B, sessionId: WSID, name: "investigate", cwd: WORKER, state: "working", status: "busy", waitingFor: null, startedAt: 1_762_300_000_000, ...over });
  const launchRow = (id: string): ChatEvent[] => [
    { k: "tool_call", id, name: "Bash", input: { command: "claude --bg" }, parent: null },
    { k: "tool_result", id, text: `backgrounded · ${B}`, isError: false, parent: null, report: null, background: [launch(B)] },
  ];
  async function until(pred: () => boolean, ms = 3_000): Promise<void> {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error("timed out");
      await Bun.sleep(5);
    }
  }
  async function working(push: FakePush) {
    const w = await setup(push);
    const c = await live(w);
    w.driver.bgRecords = [rec()];
    c.emit(...launchRow("bg-1"));
    await settle(10);
    await until(() => w.reg.backgroundHas(CHAT, B));
    await Bun.sleep(40);
    return { w, c };
  }

  test("needs input with nothing on screen: one moment with the session's own path and name; then it ends unseen: done", async () => {
    const push = new FakePush();
    const { w } = await working(push);
    w.driver.bgRecords = [rec({ status: "waiting", waitingFor: "permission prompt" })];
    await until(() => push.kinds().includes("bg_needs"));
    expect(push.moments()).toEqual([{ chat: CHAT, moment: "bg_needs", title: "Fix the flaky upload test", bg: { id: B, name: "investigate" } }]);
    w.driver.bgList = [row({ state: "done", status: null })];
    w.driver.bgRecords = [];
    await until(() => push.kinds().includes("bg_done"));
    expect(push.moments().at(-1)).toMatchObject({ moment: "bg_done", bg: { id: B } });
    // Its line on screen: that session is seen.
    const v = new RecordingViewer("tab_a");
    await w.reg.attach(CHAT, v);
    w.reg.onScreen(CHAT, v, true, B);
    expect(push.calls.at(-1)).toEqual(["seenBg", CHAT, B]);
    await w.reg.shutdown();
  });

  test("no moment while the chat is on screen anywhere, or while the session's line or view is", async () => {
    for (const how of ["chat", "line"] as const) {
      const push = new FakePush();
      const { w } = await working(push);
      const v = new RecordingViewer("tab_a");
      await w.reg.attach(CHAT, v);
      if (how === "chat") w.reg.onScreen(CHAT, v, true);
      else w.reg.onScreen(CHAT, v, true, B);
      w.driver.bgRecords = [rec({ status: "waiting", waitingFor: "input needed" })];
      await until(() => w.reg.list().find((r) => r.chat === CHAT)?.background === "needs_input");
      w.driver.bgList = [row({ state: "failed", status: null })];
      w.driver.bgRecords = [];
      await Bun.sleep(200);
      expect([how, push.moments()]).toEqual([how, []]);
      await w.reg.shutdown();
    }
  });

  test("a session that Claude Code no longer lists is seen", async () => {
    const push = new FakePush();
    const { w } = await working(push);
    w.driver.bgList = [];
    w.driver.bgRecords = [];
    await until(() => push.calls.some((c) => c[0] === "seenBg"));
    expect(push.calls.filter((c) => c[0] === "seenBg")).toEqual([["seenBg", CHAT, B]]);
    await w.reg.shutdown();
  });
});

describe("the whole path: the registry, the notifier and a stub push service", () => {
  test("one encrypted push when a turn ends unseen, none when the chat is on screen, one per chat until seen, a card's path", async () => {
    const stub = startPushStub();
    const push = createPush({ dir: mkdtempSync(join(ROOT, "state-")), uid: ownUid(), testOrigin: stub.origin, sender: { fetch: stub.fetch } });
    await push.store.makeKey();
    const sub = stub.subscribe("phone");
    expect((await push.api.add({ subscription: sub, name: "iPhone" })).ok).toBe(true);
    const w = await setup(push.hooks);
    const c = await live(w);
    await push.hooks.idle();
    expect(stub.received.length).toBe(0);
    const v = new RecordingViewer("tab_a");
    await w.reg.attach(CHAT, v);
    await turn(c);
    await push.hooks.idle();
    expect(stub.received.length).toBe(1);
    expect(JSON.parse(stub.received[0]!.plain!) as PushPayload).toEqual({ v: 1, title: "Claude finished", body: "", tag: `c:${CHAT}`, url: `/c/${CHAT}` });
    expect(stub.received[0]!.vapid).toBe("ok");
    expect(stub.received[0]!.headers).toMatchObject({ ttl: "86400", urgency: "normal", topic: CHAT, "content-encoding": "aes128gcm" });
    // One per chat until it is seen: a failed end replaces it (another kind), a second done does not.
    await turn(c, ended(false));
    await turn(c);
    await push.hooks.idle();
    expect(stub.received.map((r) => JSON.parse(r.plain!).title)).toEqual(["Claude finished", "Claude did not finish", "Claude finished"]);
    // On screen: seen, and nothing while it stays so.
    w.reg.onScreen(CHAT, v, true);
    await turn(c);
    await push.hooks.idle();
    expect(stub.received.length).toBe(3);
    // Off screen again: a card opens.
    w.reg.onScreen(CHAT, v, false);
    c.emit({ k: "turn_start", by: "user" });
    await settle();
    c.ask(permission("toolu_01AbCdEf"));
    await settle();
    await push.hooks.idle();
    expect(stub.received.length).toBe(4);
    expect(JSON.parse(stub.received[3]!.plain!)).toEqual({ v: 1, title: "Claude needs your permission", body: "", tag: `c:${CHAT}`, url: `/c/${CHAT}/permission/toolu_01AbCdEf` });
    expect(stub.received[3]!.headers.urgency).toBe("high");
    await w.reg.shutdown();
  });
});
