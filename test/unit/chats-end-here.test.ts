// End it here and copy in the registry (DESIGN.md 6.10, 9.4; build checklist S16, L16). `end_here` ends the chat's
// Claude Code at its first quiet moment, as a chat that gives its session up does (row 78), so a running turn is never
// cut, and what waits in Claude Code's own queue comes back to kitespan's queue; the answer is `{ending: true}`, or
// `{ended: true}` when the chat sleeps already. Then the chat is held as handed to the terminal (the row's `held` with
// `kind` "handed", app "terminal"): a send is refused and nothing starts, until Claude Code's registry shows the session
// open in a terminal (D58's hold takes over), for at most the hand-over's time (10 minutes), or until Send again. The
// errors: `not_found`, `archived`, `restarting`. The scripted driver stands in for Claude Code and its registry.
import { describe, expect, test } from "bun:test";
import type { ChatDelta, ChatEvent } from "../../shared/protocol";
import { HAND_OVER_MS } from "../../server/chats/drain";
import { ChatRegistry } from "../../server/chats/registry";
import { FakeBash, FakeDriver, MemoryStore, RecordingViewer, apply, autoReply, projectRecord, settle } from "../../server/chats/testing";
import type { Outcome, RegistryOptions } from "../../server/chats/types";

const PROJECT = "k3m7q2x4ab";
const CWD = "/srv/work/app";
const rid = () => crypto.randomUUID();

async function setup(opts: RegistryOptions = {}, handOverMs = 60_000) {
  const driver = new FakeDriver();
  const store = new MemoryStore();
  store.projects = [projectRecord(PROJECT, CWD)];
  const reg = new ChatRegistry({ driver, store, bash: new FakeBash(), handOverMs }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500, openCheckMs: 15, openFastMs: 15, ...opts });
  await reg.boot();
  const deltas: ChatDelta[] = [];
  reg.subscribe((d) => deltas.push(d));
  return { driver, store, reg, deltas };
}

const send = (chat: string, text: string) => {
  const r = rid();
  return { t: "send" as const, rid: r, chat, uuid: r, text, draftRev: null, uploads: [] };
};
const endHere = (chat: string) => ({ t: "end_here" as const, rid: rid(), chat });
const chatOf = (o: Outcome) => (o.ok ? (o.result as { chat: string }).chat : "");
const heldOf = (reg: ChatRegistry, chat: string) => reg.list().find((r) => r.chat === chat)?.held ?? null;
const turnEnd = (uuid: string): ChatEvent => ({ k: "turn_end", ok: true, subtype: "success", durationMs: 5, error: null, uuids: [uuid] });
async function until(pred: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
}

/** A sleeping chat on a past session (its transcript exists, so a start resumes it). */
async function sleeping(reg: ChatRegistry, driver: FakeDriver) {
  const sid = rid();
  driver.transcript(sid, "Plan the release", CWD);
  const chat = chatOf(await apply(reg, { t: "continue_session", rid: rid(), project: PROJECT, session: sid }));
  return { chat, sid };
}

/** The same chat with its Claude Code running a turn now. */
async function running(reg: ChatRegistry, driver: FakeDriver) {
  const s = await sleeping(reg, driver);
  const first = send(s.chat, "a long task");
  expect((await apply(reg, first)).ok).toBe(true);
  const fake = driver.last;
  fake.emit({ k: "session", sessionId: s.sid, model: "claude-haiku-5-5", mode: "default", version: "2.1.317", bypass: false });
  await settle();
  return { ...s, fake, first: first.uuid };
}

describe("End it here and copy (S16)", () => {
  test("the hand-over is ten minutes", () => {
    expect(HAND_OVER_MS).toBe(10 * 60_000);
  });

  test("a sleeping chat answers ended; it is held as handed to the terminal: a send is refused and nothing starts", async () => {
    const { reg, driver, deltas } = await setup();
    const { chat, sid } = await sleeping(reg, driver);
    expect(await apply(reg, endHere(chat))).toEqual({ ok: true, result: { ended: true } });
    expect(heldOf(reg, chat)).toEqual({ app: "terminal", session: sid, kind: "handed" });
    expect(deltas.filter((d) => d.chat === chat && "held" in d).at(-1)).toEqual({ chat, held: { app: "terminal", session: sid, kind: "handed" } });
    expect(await apply(reg, send(chat, "not yet"))).toEqual({ ok: false, code: "session_held" });
    // The other apps' check sees no terminal session yet: the hold stays.
    const reads = driver.openReads;
    await until(() => driver.openReads > reads + 2);
    expect(heldOf(reg, chat)?.kind).toBe("handed");
    expect(driver.opens).toHaveLength(0);
    await reg.shutdown();
  });

  test("a running chat answers ending; its turn is never cut; Claude Code's queue comes back; the process ends after the turn", async () => {
    const { reg, driver } = await setup();
    const r = await running(reg, driver);
    const queued = send(r.chat, "queued behind the turn");
    expect((await apply(reg, queued)).ok).toBe(true);
    expect(await apply(reg, endHere(r.chat))).toEqual({ ok: true, result: { ending: true } });
    expect(heldOf(reg, r.chat)).toEqual({ app: "terminal", session: r.sid, kind: "handed" });
    await until(() => r.fake.calls.includes(`takeBack:${queued.uuid}`));
    await Bun.sleep(30);
    expect(r.fake.closed).toBe(false);
    expect(r.fake.calls).not.toContain("interrupt");
    expect(reg.stateOf(r.chat)).toBe("running");
    r.fake.emit(turnEnd(r.first));
    await until(() => r.fake.closed);
    await until(() => reg.stateOf(r.chat) === "sleeping");
    // What came back waits, Queued: nothing starts while the session is handed over.
    await Bun.sleep(30);
    expect(driver.opens).toHaveLength(1);
    expect(r.fake.calls).not.toContain("interrupt");
    expect(heldOf(reg, r.chat)?.kind).toBe("handed");
    await reg.shutdown();
  });

  test("the terminal opens the session: D58's hold takes over, with its own line", async () => {
    const { reg, driver } = await setup();
    const { chat, sid } = await sleeping(reg, driver);
    await apply(reg, endHere(chat));
    driver.openNow.set(sid, { app: "terminal", busy: false });
    await until(() => heldOf(reg, chat) !== null && heldOf(reg, chat)!.kind === undefined);
    expect(heldOf(reg, chat)).toEqual({ app: "terminal", session: sid });
    // When the terminal closes it, the chat sends again (D58's rule).
    driver.openNow.delete(sid);
    await until(() => heldOf(reg, chat) === null);
    autoReply(driver);
    expect((await apply(reg, send(chat, "back here"))).ok).toBe(true);
    expect(driver.opens).toHaveLength(1);
    await reg.shutdown();
  });

  test("the hold ends after the hand-over's time, counted from the process's end: nothing starts, and what waits is Not sent", async () => {
    const { reg, driver } = await setup({}, 80);
    const r = await running(reg, driver);
    const queued = send(r.chat, "queued behind the turn");
    await apply(reg, queued);
    const page = new RecordingViewer();
    await reg.attach(r.chat, page);
    await apply(reg, endHere(r.chat));
    // While the turn still runs, the time does not: the user has not been told to paste yet.
    await Bun.sleep(200);
    expect(heldOf(reg, r.chat)?.kind).toBe("handed");
    r.fake.emit(turnEnd(r.first));
    await until(() => heldOf(reg, r.chat) === null, 3_000);
    await Bun.sleep(30);
    expect(driver.opens).toHaveLength(1);
    expect(page.of("user").filter((e) => e.uuid === queued.uuid).at(-1)?.notSent).toBe(true);
    await reg.shutdown();
  });

  test("Send again ends the hold; with nothing waiting it starts nothing, and the next send works", async () => {
    const { reg, driver } = await setup();
    const { chat } = await sleeping(reg, driver);
    await apply(reg, endHere(chat));
    expect(await apply(reg, { t: "send_queued", rid: rid(), chat })).toEqual({ ok: true, result: { started: false } });
    expect(heldOf(reg, chat)).toBeNull();
    expect(driver.opens).toHaveLength(0);
    autoReply(driver);
    expect((await apply(reg, send(chat, "here again"))).ok).toBe(true);
    expect(driver.opens).toHaveLength(1);
    await reg.shutdown();
  });

  test("Send again with messages that wait: the hold ends and they go", async () => {
    const { reg, driver } = await setup();
    const r = await running(reg, driver);
    const queued = send(r.chat, "queued behind the turn");
    await apply(reg, queued);
    await apply(reg, endHere(r.chat));
    r.fake.emit(turnEnd(r.first));
    await until(() => reg.stateOf(r.chat) === "sleeping");
    expect(await apply(reg, { t: "send_queued", rid: rid(), chat: r.chat })).toEqual({ ok: true, result: { started: true } });
    await until(() => driver.opens.length === 2);
    await until(() => driver.last.sent.some((m) => m.uuid === queued.uuid));
    await reg.shutdown();
  });

  test("the errors: not_found, archived and restarting", async () => {
    const { reg, driver } = await setup();
    const a = await sleeping(reg, driver);
    const b = await sleeping(reg, driver);
    expect(await apply(reg, endHere("k3m7q2x4abk3m7q2x4ab"))).toEqual({ ok: false, code: "not_found" });
    await apply(reg, { t: "archive", rid: rid(), chat: a.chat, on: true, stop: false });
    expect(await apply(reg, endHere(a.chat))).toEqual({ ok: false, code: "archived" });
    reg.drain("finish");
    expect(await apply(reg, endHere(b.chat))).toEqual({ ok: false, code: "restarting" });
    expect(heldOf(reg, b.chat)).toBeNull();
    await reg.shutdown();
  });
});

// L16 across a restart or a crash: the hand-over is in the ledger, so the next server holds the chat as handed until
// the hand-over's time from that moment, and a send from another page cannot start a second writer before the paste.
describe("the hand-over across a restart (L16)", () => {
  async function next(driver: FakeDriver, store: MemoryStore, handOverMs: number) {
    const reg = new ChatRegistry({ driver, store, bash: new FakeBash(), handOverMs }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500, openCheckMs: 15, openFastMs: 15 });
    await reg.boot();
    return reg;
  }

  test("end_here, then a new registry over the same store: held as handed, a send is refused, and the hold ends at its time", async () => {
    const { driver, store, reg } = await setup();
    const { chat, sid } = await sleeping(reg, driver);
    expect(await apply(reg, endHere(chat))).toEqual({ ok: true, result: { ended: true } });
    await settle();
    await reg.shutdown();
    expect(store.chats.get(chat)!.handedAt).toBeDefined();
    const after = await next(driver, store, 400);
    expect(heldOf(after, chat)).toEqual({ app: "terminal", session: sid, kind: "handed" });
    expect(await apply(after, send(chat, "not yet"))).toEqual({ ok: false, code: "session_held" });
    expect(driver.opens).toHaveLength(0);
    await until(() => heldOf(after, chat) === null, 3_000);
    await settle();
    expect(store.chats.get(chat)!.handedAt).toBeUndefined();
    await after.shutdown();
  });

  test("a hand-over whose time has passed holds nothing after the restart; the terminal's session takes over as D58's hold", async () => {
    const { driver, store, reg } = await setup();
    const a = await sleeping(reg, driver);
    const b = await sleeping(reg, driver);
    await apply(reg, endHere(a.chat));
    await apply(reg, endHere(b.chat));
    await settle();
    await reg.shutdown();
    await Bun.sleep(60);
    driver.openNow.set(b.sid, { app: "terminal", busy: false });
    const after = await next(driver, store, 50);
    expect(heldOf(after, a.chat)).toBeNull();
    await until(() => heldOf(after, b.chat)?.kind === undefined && heldOf(after, b.chat)?.app === "terminal");
    await settle();
    expect(store.chats.get(a.chat)!.handedAt).toBeUndefined();
    expect(store.chats.get(b.chat)!.handedAt).toBeUndefined();
    await after.shutdown();
  });
});
