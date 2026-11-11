// D58 in the registry: Continue in a copy (continue_session with `fork`) makes a chat on a fork of the session, a new
// session id with the copy's title, so the other app keeps the original; and every chat's session is checked on a
// timer against the sessions that another process has open (row 78 gives such a session up:
// test/unit/chats-held.test.ts). The scripted driver stands in for Claude Code.
import { describe, expect, test } from "bun:test";
import { parseClientFrame, type ChatDelta } from "../../shared/protocol";
import { ChatRegistry } from "../../server/chats/registry";
import { FakeDriver, MemoryStore, apply, autoReply, projectRecord, settle } from "../../server/chats/testing";
import type { Outcome, RegistryOptions } from "../../server/chats/types";

const PROJECT = "k3m7q2x4ab";
const CWD = "/srv/work/app";
const rid = () => crypto.randomUUID();

async function setup(opts: RegistryOptions = {}) {
  const driver = new FakeDriver();
  const store = new MemoryStore();
  store.projects = [projectRecord(PROJECT, CWD)];
  const reg = new ChatRegistry({ driver, store }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500, openCheckMs: 60_000, ...opts });
  await reg.boot();
  const deltas: ChatDelta[] = [];
  reg.subscribe((d) => deltas.push(d));
  return { driver, store, reg, deltas };
}

const cont = (session: string, fork?: boolean) => ({ t: "continue_session" as const, rid: rid(), project: PROJECT, session, ...(fork === undefined ? {} : { fork }) });
const chatOf = (o: Outcome) => (o.ok ? (o.result as { chat: string }).chat : "");
const send = (chat: string, text: string) => {
  const r = rid();
  return { t: "send" as const, rid: r, chat, uuid: r, text, draftRev: null, uploads: [] };
};

describe("the frames (section 4)", () => {
  test("continue_session takes an optional boolean fork, and nothing else for it", () => {
    const base = { t: "continue_session", rid: rid(), project: PROJECT, session: rid() };
    expect(parseClientFrame(JSON.stringify(base))).toMatchObject({ ok: true });
    expect((parseClientFrame(JSON.stringify(base)) as { frame: object }).frame).not.toHaveProperty("fork");
    expect(parseClientFrame(JSON.stringify({ ...base, fork: true }))).toMatchObject({ ok: true, frame: { fork: true } });
    expect(parseClientFrame(JSON.stringify({ ...base, fork: false }))).toMatchObject({ ok: true, frame: { fork: false } });
    expect(parseClientFrame(JSON.stringify({ ...base, fork: "yes" }))).toMatchObject({ ok: false });
  });
});

describe("Continue in a copy (D58)", () => {
  test("the chat holds a fork's new session id, titled as a copy; the original stays out of kitespan's hands", async () => {
    const { reg, driver, store, deltas } = await setup();
    const sid = rid();
    driver.transcript(sid, "Fix the flaky test", CWD);
    driver.openNow.set(sid, { app: "terminal", busy: true });
    const o = await apply(reg, cont(sid, true));
    expect(o.ok).toBe(true);
    const chat = chatOf(o);
    expect(driver.forks).toHaveLength(1);
    const fork = driver.forks[0]!;
    expect(fork).toMatchObject({ sessionId: sid, cwd: CWD, title: "Copy of Fix the flaky test" });
    expect(fork.id).not.toBe(sid);
    expect(store.chats.get(chat)!.sessionId).toBe(fork.id);
    // The ledger names the session it copies, so the preview can offer the copy (W19d).
    expect(store.chats.get(chat)!.copyOf).toBe(sid);
    expect(reg.copyForSession(sid)).toBe(chat);
    // The mark comes first, so a title cut in the sidebar or the title bar still says it is a copy (W19d).
    expect(reg.list()[0]).toMatchObject({ chat, title: "Copy of Fix the flaky test", state: "sleeping" });
    expect(deltas.find((d) => d.chat === chat && "title" in d)).toMatchObject({ title: "Copy of Fix the flaky test" });
    expect(reg.chatForSession(sid)).toBeNull();
    expect(reg.chatForSession(fork.id)).toBe(chat);
    expect(reg.heldSessions().has(sid)).toBe(false);
    // The copy is not open anywhere else, so its row is not held.
    expect(reg.list()[0]!.held ?? null).toBeNull();
    // Its first start resumes the fork (its transcript exists), never the original.
    autoReply(driver);
    await apply(reg, send(chat, "go on"));
    expect(driver.last.input.resume?.value).toBe(fork.id);
    expect(driver.last.input.sessionId).toBeNull();
  });

  test("two presses at once make one copy", async () => {
    const { reg, driver } = await setup();
    const sid = rid();
    driver.transcript(sid, "Plan the release", CWD);
    const [a, b] = await Promise.all([apply(reg, cont(sid, true)), apply(reg, cont(sid, true))]);
    expect(chatOf(a)).toBe(chatOf(b));
    expect(driver.forks).toHaveLength(1);
    expect(reg.list()).toHaveLength(1);
  });

  test("a long title keeps the copy's mark within 120 characters", async () => {
    const { reg, driver } = await setup();
    const sid = rid();
    driver.transcript(sid, "x".repeat(130), CWD);
    const chat = chatOf(await apply(reg, cont(sid, true)));
    const title = reg.list().find((r) => r.chat === chat)!.title!;
    expect(title.length).toBeLessThanOrEqual(120);
    expect(title.startsWith("Copy of xxx")).toBe(true);
    expect(driver.forks[0]!.title).toBe(title);
  });

  test("a press after the first copy is made makes a second copy, numbered; the preview's copy is the newest one", async () => {
    const { reg, driver, store } = await setup();
    const sid = rid();
    driver.transcript(sid, "Plan the release", CWD);
    expect(reg.copyForSession(sid)).toBeNull();
    const first = chatOf(await apply(reg, cont(sid, true)));
    const second = chatOf(await apply(reg, cont(sid, true)));
    expect(second).not.toBe(first);
    expect(driver.forks).toHaveLength(2);
    const title = (c: string) => reg.list().find((r) => r.chat === c)!.title;
    expect(title(first)).toBe("Copy of Plan the release");
    expect(title(second)).toBe("Copy 2 of Plan the release");
    expect(reg.copyForSession(sid)).toBe(second);
    // An archived copy is not offered; a deleted one is not counted.
    await apply(reg, { t: "archive", rid: rid(), chat: second, on: true, stop: false });
    expect(reg.copyForSession(sid)).toBe(first);
    await apply(reg, { t: "delete", rid: rid(), chat: second });
    const third = chatOf(await apply(reg, cont(sid, true)));
    expect(title(third)).toBe("Copy 2 of Plan the release");
    expect(reg.copyForSession(sid)).toBe(third);
    // The copies stay known after a restart (the ledger's copyOf).
    await reg.shutdown();
    const again = new ChatRegistry({ driver, store }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500, openCheckMs: 60_000 });
    await again.boot();
    expect(again.copyForSession(sid)).toBe(third);
    expect(again.copyForSession(rid())).toBeNull();
    await again.shutdown();
  });

  test("a fork that fails makes no chat; the driver's code is the ack's", async () => {
    const { reg, driver } = await setup();
    const sid = rid();
    driver.transcript(sid, "Plan the release", CWD);
    driver.forkThrows = "not_found";
    expect(await apply(reg, cont(sid, true))).toEqual({ ok: false, code: "not_found" });
    driver.forkThrows = "failed";
    expect(await apply(reg, cont(sid, true))).toEqual({ ok: false, code: "failed" });
    expect(reg.list()).toHaveLength(0);
    expect(await apply(reg, cont(rid(), true))).toEqual({ ok: false, code: "not_found" });
  });

  test("a session that a chat already holds: Continue here opens that chat (D49); Continue in a copy opens its copy, made once (row 78)", async () => {
    const { reg, driver } = await setup();
    const sid = rid();
    driver.transcript(sid, "Plan the release", CWD);
    const chat = chatOf(await apply(reg, cont(sid)));
    expect(await apply(reg, cont(sid))).toEqual({ ok: true, result: { chat } });
    expect(driver.forks).toHaveLength(0);
    const copy = chatOf(await apply(reg, cont(sid, true)));
    expect(copy).not.toBe(chat);
    expect(driver.forks).toHaveLength(1);
    expect(await apply(reg, cont(sid, true))).toEqual({ ok: true, result: { chat: copy } });
    expect(driver.forks).toHaveLength(1);
  });

  test("Continue here without fork still continues the same session", async () => {
    const { reg, driver, store } = await setup();
    const sid = rid();
    driver.transcript(sid, "Plan the release", CWD);
    const chat = chatOf(await apply(reg, cont(sid, false)));
    expect(store.chats.get(chat)!.sessionId).toBe(sid);
    expect(reg.list()[0]!.title).toBe("Plan the release");
    expect(driver.forks).toHaveLength(0);
  });
});

describe("a session that another process has open (D58)", () => {
  test("a plain Continue here of a session that another app opened after the preview was read is refused: no chat, no resume", async () => {
    const { reg, driver, store } = await setup();
    const sid = rid();
    driver.transcript(sid, "Plan the release", CWD);
    // The preview's read saw the session closed; the terminal opens it before the press.
    driver.openNow.set(sid, { app: "terminal", busy: false });
    const reads = driver.openReads;
    expect(await apply(reg, cont(sid))).toEqual({ ok: false, code: "session_open" });
    expect(await apply(reg, cont(sid, false))).toEqual({ ok: false, code: "session_open" });
    expect(driver.openReads).toBeGreaterThan(reads);
    expect(reg.list()).toHaveLength(0);
    expect(store.chats.size).toBe(0);
    expect(reg.chatForSession(sid)).toBeNull();
    expect(driver.opens).toHaveLength(0);
    // Continue in a copy still works, and the terminal keeps the original.
    const copy = chatOf(await apply(reg, cont(sid, true)));
    expect(store.chats.get(copy)!.sessionId).not.toBe(sid);
    // Once the other app has closed it, Continue here continues the same session.
    driver.openNow.delete(sid);
    const here = chatOf(await apply(reg, cont(sid)));
    expect(store.chats.get(here)!.sessionId).toBe(sid);
  });

  test("an unreadable registry counts as none open: Continue here continues the session", async () => {
    const { reg, driver, store } = await setup();
    const sid = rid();
    driver.transcript(sid, "Plan the release", CWD);
    driver.openSessionsThrows = true;
    const chat = chatOf(await apply(reg, cont(sid)));
    expect(store.chats.get(chat)!.sessionId).toBe(sid);
  });

  test("the timer stops with the registry", async () => {
    const { reg, driver } = await setup({ openCheckMs: 10 });
    await settle();
    await reg.shutdown();
    const reads = driver.openReads;
    await Bun.sleep(60);
    expect(driver.openReads).toBe(reads);
  });
});
