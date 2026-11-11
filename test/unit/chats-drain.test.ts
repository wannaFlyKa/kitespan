// The restart's drain in the registry (DESIGN.md 4.10 steps 3 and 4; build checklist S9, S10, S11, L7, L14). While
// Restart when they finish waits, no new turn starts: a send is held, Queued, in its chat's queue file and never
// reaches Claude Code; a `!` command, a new chat, Send again and End it here get `restarting`. Each live chat that is
// quiet closes at once, each other one at its next quiet moment (its turn is never cut), and a card waits for its
// answer. Cancel restart takes work again: the held messages go, as at a hold's end, and the check of the other apps'
// sessions runs again. Restart now ends every live chat as Stop and archive does (interrupt, then close) and writes the
// stop lines with Restart now's words; a later boot draws them, and an answer to an old card is `stale`. A restart
// whose successor failed reopens the registry: work again, the cut chats' lines now, the held messages sent. The
// scripted driver and the in-memory store stand in for Claude Code and the disk.
import { describe, expect, test } from "bun:test";
import type { ChatEvent, PermissionCard } from "../../shared/protocol";
import { ChatRegistry } from "../../server/chats/registry";
import type { ProcTable } from "../../server/chats/stops";
import { FakeBash, FakeDriver, MemoryStore, RecordingViewer, apply, projectRecord, settle } from "../../server/chats/testing";
import type { Outcome, RegistryOptions } from "../../server/chats/types";

const PROJECT = "k3m7q2x4ab";
const CWD = "/srv/work/app";
const RESTARTED_TURN = "kitespan restarted during this turn. Send a message to continue.";
const UNRESTARTED_TURN = "The restart stopped this turn, but kitespan did not restart. Send a message to continue.";
const RESTARTED_CARD = "This chat was waiting for your answer when kitespan restarted. Send a message to continue.";
const rid = () => crypto.randomUUID();

class Procs implements ProcTable {
  readonly live = new Map<number, string>();
  async startOf(pid: number): Promise<string | null> {
    return this.live.get(pid) ?? null;
  }
  sameStart(a: string, b: string): boolean {
    return a === b;
  }
  kill(pid: number): boolean {
    this.live.delete(pid);
    return true;
  }
}

function world() {
  const driver = new FakeDriver();
  const store = new MemoryStore();
  store.projects = [projectRecord(PROJECT, CWD)];
  return { driver, store, procs: new Procs() };
}

async function life(w: ReturnType<typeof world>, opts: RegistryOptions = {}) {
  const reg = new ChatRegistry({ driver: w.driver, store: w.store, bash: new FakeBash(), procs: w.procs }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500, openCheckMs: 15, openFastMs: 15, ...opts });
  await reg.boot();
  await settle();
  return reg;
}

const newChat = (text: string) => ({ t: "new_chat" as const, rid: rid(), project: PROJECT, uuid: rid(), text, picks: { model: null, effort: null, mode: null }, uploads: [] });
const send = (chat: string, text: string) => {
  const r = rid();
  return { t: "send" as const, rid: r, chat, uuid: r, text, draftRev: null, uploads: [] };
};
const chatOf = (o: Outcome) => (o.ok ? (o.result as { chat: string }).chat : "");
const session = (sid: string): ChatEvent => ({ k: "session", sessionId: sid, model: "claude-haiku-5-5", mode: "default", version: "2.1.317", bypass: false });
const turnEnd = (uuid: string): ChatEvent => ({ k: "turn_end", ok: true, subtype: "success", durationMs: 5, error: null, uuids: [uuid] });
const card = (id: string): PermissionCard => ({ kind: "permission", id, toolUseId: id, toolName: "Bash", title: null, displayName: null, description: null, reason: null, blockedPath: null, input: {}, defaultToNo: false, suppressAlwaysAllowRule: false, sessionRule: false, parent: null });
async function until(pred: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
}

/** A chat whose first message runs a turn now: its fake Claude Code, its id and its session. */
async function running(reg: ChatRegistry, driver: FakeDriver, text = "a long task") {
  const frame = newChat(text);
  const chat = chatOf(await apply(reg, frame));
  const fake = driver.last;
  const sid = fake.input.sessionId!.value;
  fake.emit(session(sid));
  await settle();
  return { chat, fake, sid, first: frame.uuid };
}

/** A chat whose first turn ended: its process lives, idle. */
async function idle(reg: ChatRegistry, driver: FakeDriver, text = "a short task") {
  const r = await running(reg, driver, text);
  driver.transcript(r.sid, text, CWD);
  r.fake.emit(turnEnd(r.first));
  await settle();
  return r;
}

/** A sleeping chat on a past session (a start resumes it). */
async function sleeping(reg: ChatRegistry, driver: FakeDriver, title = "Plan the release") {
  const sid = rid();
  driver.transcript(sid, title, CWD);
  const chat = chatOf(await apply(reg, { t: "continue_session", rid: rid(), project: PROJECT, session: sid }));
  return { chat, sid };
}

describe("Restart when they finish (S9, L7)", () => {
  test("a send is held Queued in its queue file and never reaches Claude Code; `!`, a new chat, Send again and End it here get restarting", async () => {
    const w = world();
    const reg = await life(w);
    const a = await running(reg, w.driver);
    const c = await sleeping(reg, w.driver);
    const page = new RecordingViewer();
    await reg.attach(c.chat, page);
    const opens = w.driver.opens.length;

    expect(reg.drain("finish")).toEqual({ ok: true });
    const toSleeping = send(c.chat, "for the sleeping chat");
    expect(await apply(reg, toSleeping)).toEqual({ ok: true, result: { queued: true } });
    const toRunning = send(a.chat, "for the running chat");
    expect(await apply(reg, toRunning)).toEqual({ ok: true, result: { queued: true } });
    await settle();
    // Nothing started and nothing reached a Claude Code: each message is in its chat's queue file, and Queued.
    expect(w.driver.opens).toHaveLength(opens);
    expect(a.fake.sent.map((m) => m.uuid)).toEqual([a.first]);
    expect(w.store.queues.get(c.chat)?.msgs.map((m) => m.uuid)).toEqual([toSleeping.uuid]);
    expect(w.store.queues.get(a.chat)?.msgs.map((m) => m.uuid)).toContain(toRunning.uuid);
    expect(page.of("user").find((e) => e.uuid === toSleeping.uuid)?.queued).toBe(true);

    expect(await apply(reg, { t: "bash", rid: rid(), chat: c.chat, input: "ls", draftRev: null, uploads: [] })).toEqual({ ok: false, code: "restarting" });
    expect(await apply(reg, newChat("another task"))).toEqual({ ok: false, code: "restarting" });
    expect(await apply(reg, { t: "send_queued", rid: rid(), chat: c.chat })).toEqual({ ok: false, code: "restarting" });
    expect(await apply(reg, { t: "end_here", rid: rid(), chat: a.chat })).toEqual({ ok: false, code: "restarting" });
    expect(w.driver.opens).toHaveLength(opens);
    // A second ask of the same drain changes nothing.
    expect(reg.drain("finish")).toEqual({ ok: true });
    await reg.shutdown({ by: "restart" });
  });

  test("a quiet chat closes at once; a running turn is never cut and its chat closes at the turn's end; a card waits for its answer", async () => {
    const w = world();
    const reg = await life(w);
    const a = await running(reg, w.driver, "the running one");
    const b = await idle(reg, w.driver, "the idle one");
    const q = await running(reg, w.driver, "the asking one");
    const asked = q.fake.ask(card("toolu_ask"));
    await settle();
    expect(reg.asleep()).toBe(false);

    reg.drain("finish");
    await until(() => b.fake.closed);
    expect(b.fake.calls).not.toContain("interrupt");
    await settle();
    expect(a.fake.closed).toBe(false);
    expect(q.fake.closed).toBe(false);
    expect(reg.asleep()).toBe(false);

    // The turn ends by itself: then its chat closes, with no interrupt.
    w.driver.transcript(a.sid, "the running one", CWD);
    a.fake.emit(turnEnd(a.first));
    await until(() => a.fake.closed);
    expect(a.fake.calls).not.toContain("interrupt");
    expect(reg.stateOf(a.chat)).toBe("sleeping");

    // The card waits; once answered, its turn ends and the chat closes.
    await Bun.sleep(30);
    expect(q.fake.closed).toBe(false);
    expect((await apply(reg, { t: "answer", rid: rid(), chat: q.chat, card: "toolu_ask", answer: { kind: "permission", allow: true, scope: "once" } })).ok).toBe(true);
    expect((await asked.answer)?.kind).toBe("permission");
    q.fake.emit(turnEnd(q.first));
    await until(() => q.fake.closed);
    await until(() => reg.asleep());
    await reg.shutdown({ by: "restart" });
  });

  test("Cancel restart: work again, the held messages go as at a hold's end, and the other apps' sessions are checked again", async () => {
    const w = world();
    const reg = await life(w);
    const a = await running(reg, w.driver);
    const c = await sleeping(reg, w.driver);
    expect(reg.undrain()).toBe(false);
    reg.drain("finish");
    const toRunning = send(a.chat, "after this turn");
    const toSleeping = send(c.chat, "wake up");
    await apply(reg, toRunning);
    await apply(reg, toSleeping);
    // The check of the other apps' sessions waits with the drain.
    await settle();
    const reads = w.driver.openReads;
    await Bun.sleep(60);
    expect(w.driver.openReads).toBe(reads);
    const opens = w.driver.opens.length;

    expect(reg.undrain()).toBe(true);
    expect(reg.undrain()).toBe(false);
    await until(() => w.driver.opens.length === opens + 1);
    // The running chat takes its message on its input (Claude Code queues it behind the turn); the sleeping one starts.
    expect(a.fake.sent.map((m) => m.uuid)).toEqual([a.first, toRunning.uuid]);
    expect(a.fake.closed).toBe(false);
    expect(w.driver.last.input.resume?.value).toBe(c.sid);
    await until(() => w.driver.last.sent.length === 1);
    expect(w.driver.last.sent[0]!.uuid).toBe(toSleeping.uuid);
    await until(() => w.driver.openReads > reads);
    // Sends and new chats work again.
    expect((await apply(reg, { t: "bash", rid: rid(), chat: a.chat, input: "ls", draftRev: null, uploads: [] })).ok).toBe(true);
    expect((await apply(reg, newChat("one more"))).ok).toBe(true);
    await reg.shutdown();
  });

  test("Cancel restart sends what came back from Claude Code's queue, after the turn that was running", async () => {
    const w = world();
    const reg = await life(w);
    const a = await running(reg, w.driver);
    // Sent before the drain, during the turn: in Claude Code's own queue.
    const before = send(a.chat, "queued in Claude Code");
    await apply(reg, before);
    expect(a.fake.sent.map((m) => m.uuid)).toEqual([a.first, before.uuid]);
    reg.drain("finish");
    // The drain takes it back to kitespan's queue, so the chat can close after its own turn.
    await until(() => a.fake.calls.includes(`takeBack:${before.uuid}`));
    expect(reg.undrain()).toBe(true);
    await until(() => a.fake.sent.length === 3);
    expect(a.fake.sent.map((m) => m.uuid)).toEqual([a.first, before.uuid, before.uuid]);
    await reg.shutdown();
  });
});

describe("Restart now (S10)", () => {
  test("every live chat is interrupted, then closed; the stop lines have Restart now's words; an answer to an old card is stale", async () => {
    const w = world();
    const reg = await life(w);
    const a = await running(reg, w.driver, "the running one");
    const q = await running(reg, w.driver, "the asking one");
    q.fake.ask(card("toolu_old"));
    await settle();
    const b = await idle(reg, w.driver, "the idle one");

    reg.drain("now");
    await reg.shutdown({ by: "restart", interrupt: true });
    expect(a.fake.calls.indexOf("interrupt")).toBeGreaterThanOrEqual(0);
    expect(a.fake.calls.indexOf("interrupt")).toBeLessThan(a.fake.calls.indexOf("close"));
    expect(q.fake.calls).toContain("interrupt");
    expect(b.fake.calls).not.toContain("interrupt");
    expect(b.fake.closed).toBe(true);
    expect(w.store.chats.get(a.chat)?.stop).toMatchObject({ why: "running", by: "restart" });
    expect(w.store.chats.get(q.chat)?.stop).toMatchObject({ why: "waiting", by: "restart" });
    expect(w.store.chats.get(b.chat)?.stop).toBeUndefined();

    // The next server: the lines under the cut turns, and the old card is stale. The running one's transcript ends
    // in the interrupt that Restart now sent (history reads it as the turn's end): its line shows all the same.
    w.driver.histories.set(a.sid, [
      { k: "user", uuid: a.first, text: "the running one", queued: false },
      { k: "turn_end", ok: false, subtype: "interrupted", durationMs: 5, error: null, uuids: [] },
    ]);
    const next = await life(w);
    const pa = new RecordingViewer();
    const pq = new RecordingViewer();
    const sa = await next.attach(a.chat, pa);
    const sq = await next.attach(q.chat, pq);
    await settle();
    const lines = (p: { snapshot: { history: ChatEvent[] } } | null, v: RecordingViewer) => [...(p?.snapshot.history ?? []), ...v.events].flatMap((e) => (e.k === "notice" ? [e.text] : []));
    expect(lines(sa, pa)).toContain(RESTARTED_TURN);
    expect(lines(sq, pq)).toContain(RESTARTED_CARD);
    expect(await apply(next, { t: "answer", rid: rid(), chat: q.chat, card: "toolu_old", answer: { kind: "permission", allow: true, scope: "once" } })).toEqual({ ok: false, code: "stale" });
    await next.shutdown();
  });
});

describe("a restart that did not happen (S13): the registry opens again", () => {
  test("work again, a cut chat's line now, and the held messages sent", async () => {
    const w = world();
    const reg = await life(w);
    const a = await running(reg, w.driver, "the running one");
    const c = await sleeping(reg, w.driver);
    reg.drain("finish");
    const held = send(c.chat, "held by the drain");
    await apply(reg, held);
    const page = new RecordingViewer();
    await reg.attach(a.chat, page);
    // Restart now while it waits: the close cuts the running turn.
    reg.drain("now");
    await reg.shutdown({ by: "restart", interrupt: true });
    expect(reg.asleep()).toBe(true);
    expect(await apply(reg, send(c.chat, "during the close"))).toEqual({ ok: false, code: "restarting" });
    const opens = w.driver.opens.length;

    await reg.reopen();
    // kitespan did not restart: the cut turn's line says what happened, not Restart now's words.
    await until(() => page.of("notice").some((e) => e.text === UNRESTARTED_TURN));
    expect(page.of("notice").some((e) => e.text === RESTARTED_TURN)).toBe(false);
    await until(() => w.driver.opens.length === opens + 1);
    expect(w.driver.last.input.resume?.value).toBe(c.sid);
    await until(() => w.driver.last.sent.some((m) => m.uuid === held.uuid));
    expect(w.store.chats.get(a.chat)?.stop).toBeUndefined();
    expect((await apply(reg, newChat("works again"))).ok).toBe(true);
    // A second drain can start.
    expect(reg.drain("finish")).toEqual({ ok: true });
    expect(reg.undrain()).toBe(true);
    await reg.shutdown();
  });
});

describe("the claude processes the close checks (S11)", () => {
  test("each live chat's process, with its start, until it is gone", async () => {
    const w = world();
    const reg = await life(w);
    w.procs.live.set(4321, "1700");
    const frame = newChat("with a pid");
    const chat = chatOf(await apply(reg, frame));
    const fake = w.driver.last;
    fake.pid = 4321;
    fake.emit(session(fake.input.sessionId!.value));
    await until(() => w.store.chats.get(chat)?.proc?.pid === 4321);
    expect(await reg.claudeProcs()).toEqual([{ pid: 4321, start: "1700" }]);
    fake.emit(turnEnd(frame.uuid));
    await reg.shutdown({ by: "restart" });
    // The fake process still lives after its close: the close's check finds it.
    expect(await reg.claudeProcs()).toEqual([{ pid: 4321, start: "1700" }]);
    w.procs.live.delete(4321);
    expect(await reg.claudeProcs()).toEqual([]);
  });
});
