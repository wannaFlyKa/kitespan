// The side chat in the chat registry (owner rows 124 and 125; FIX-R124 sections 1 to 3; DESIGN-R124 sections 9 and
// 10): a side question goes to the chat's live process (a sleeping chat wakes with no turn), never into the
// conversation; its history is the thread's answered exchanges; one runs at a time per chat; Stop takes it out of the
// thread, every other cut fails it; every page gets the thread's events; the thread is kept in kitespan's own side file
// after a close and across a restart, and goes with Delete; the idle rule and the cap keep the process while it runs;
// `/btw` typed as a message never reaches Claude Code. The scripted driver and MemoryStore stand in for Claude Code
// and the disk.
import { describe, expect, test } from "bun:test";
import { SIDE_LIMITS, type ChatEvent, type SideExchange, type SideRead } from "../../shared/protocol";
import { ChatRegistry } from "../../server/chats/registry";
import { sideHistory, sidePut } from "../../server/chats/side";
import { FakeDriver, MemoryStore, RecordingViewer, apply, autoReply, projectRecord, settle, type FakeChat } from "../../server/chats/testing";
import type { Outcome, RegistryOptions } from "../../server/chats/types";
import { SIDE_FILE_BYTES } from "../../server/store/side";
import type { ChatLedger } from "../../server/store/types";

const PROJECT = "k3m7q2x4ab";
const CHAT = "k3m7q2x4abk3m7q2x4ab";
const OTHER = "otherchat2abcdefghij";
const SID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const SID2 = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const AT = "2026-11-04T12:00:00.000Z";
const rid = () => crypto.randomUUID();

function ledger(over: Partial<ChatLedger> = {}): ChatLedger {
  return {
    v: 1,
    id: CHAT,
    project: PROJECT,
    cwd: "/srv/work/app",
    agent: "claude-code",
    sessionId: SID,
    transcript: true,
    title: { text: "Fix the flaky upload test", from: "first-prompt" },
    picks: { model: null, effort: null, permissionMode: null },
    createdAt: "2026-11-04T08:00:00.000Z",
    seenAt: "2026-11-04T08:00:00.000Z",
    lastActivityAt: "2026-11-04T08:00:00.000Z",
    lastSeq: 0,
    state: "sleeping",
    lastExit: null,
    archivedAt: null,
    ...over,
  };
}

/** Two sleeping chats with transcripts: CHAT and OTHER. */
function world() {
  const driver = new FakeDriver();
  const store = new MemoryStore();
  store.projects = [projectRecord(PROJECT)];
  store.chats.set(CHAT, ledger());
  store.chats.set(OTHER, ledger({ id: OTHER, sessionId: SID2, title: { text: "Plan the search index", from: "first-prompt" } }));
  driver.transcript(SID);
  driver.transcript(SID2);
  return { driver, store };
}

async function life(w: ReturnType<typeof world>, opts: RegistryOptions = {}): Promise<ChatRegistry> {
  const reg = new ChatRegistry({ driver: w.driver, store: w.store }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500, ...opts });
  await reg.boot();
  return reg;
}

async function setup(opts: RegistryOptions = {}) {
  const w = world();
  return { ...w, reg: await life(w, opts) };
}

const askFrame = (text: string, id: string = rid(), chat = CHAT) => ({ t: "side_question" as const, rid: rid(), chat, id, text });
const answered = (o: Outcome): SideExchange => {
  if (!o.ok) throw new Error(`refused: ${o.code}`);
  return (o.result as { answered: SideExchange }).answered;
};
const sideEvents = (v: RecordingViewer) => v.events.filter((e) => e.k === "side" || e.k === "side_gone" || e.k === "side_clear");
const read = async (reg: ChatRegistry, chat = CHAT) => (await apply(reg, { t: "get", rid: rid(), chat, what: "side" })) as { ok: true; result: SideRead };

/** A reply that waits until the test releases it (or the signal aborts it). */
function gate<T>() {
  let release!: (v: T) => void;
  const p = new Promise<T>((r) => (release = r));
  return { p, release };
}

async function until(pred: () => boolean, what: string, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

/** CHAT live and idle: a first turn ran (autoReply), so its process stays. */
async function liveChat(reg: ChatRegistry, driver: FakeDriver): Promise<FakeChat> {
  autoReply(driver);
  const u = rid();
  const o = await apply(reg, { t: "send", rid: u, chat: CHAT, uuid: u, text: "Run the upload test.", draftRev: null, uploads: [] });
  expect(o.ok).toBe(true);
  await until(() => reg.stateOf(CHAT) === "idle", "the first turn's end");
  driver.script = null;
  return driver.last;
}

describe("a side question", () => {
  test("on a sleeping chat: its Claude Code starts with no turn and answers; nothing is sent as a message, and the chat stays idle", async () => {
    const { reg, driver, store } = await setup();
    const page = new RecordingViewer();
    await reg.attach(CHAT, page);
    const id = rid();
    const o = await apply(reg, askFrame("Which file holds the cap?", id));
    const x = answered(o);
    expect(x).toEqual({ id, question: "Which file holds the cap?", at: expect.any(String), state: "answered", answer: "Side answer to: Which file holds the cap?" });
    // One process, resumed, with no message: the side question was its only call of the kind.
    expect(driver.opens).toHaveLength(1);
    expect(driver.last.input.resume?.value).toBe(SID);
    expect(driver.last.sent).toEqual([]);
    expect(driver.last.sideAsks.map((a) => [a.question, a.history])).toEqual([["Which file holds the cap?", []]]);
    // Every page sees asking, then answered; no turn, no user message, no line in the main chat.
    expect(sideEvents(page)).toEqual([
      { k: "side", rev: 1, x: { id, question: "Which file holds the cap?", at: x.at, state: "asking" } },
      { k: "side", rev: 2, x },
    ]);
    expect(page.events.filter((e) => !["side", "side_gone", "side_clear"].includes(e.k))).toEqual([]);
    expect(reg.stateOf(CHAT)).toBe("idle");
    expect(reg.list().find((r) => r.chat === CHAT)?.busy).toBe(false);
    // kitespan's own file, and `get side`.
    expect(store.sides.get(CHAT)).toEqual({ v: 1, id: CHAT, rev: 2, exchanges: [x] });
    expect((await read(reg)).result).toEqual({ rev: 2, exchanges: [x] });
  });

  test("a follow-up goes with the thread as its history: the answered exchanges that the model answered, oldest first", async () => {
    const { reg, driver } = await setup();
    const chat = await liveChat(reg, driver);
    answered(await apply(reg, askFrame("What is the capital of France?")));
    chat.sideReply = () => ({ response: "(No answer available for this side question.)", synthetic: true, fallback: null });
    const s = answered(await apply(reg, askFrame("And of Spain?")));
    expect(s.synthetic).toBe(true);
    chat.sideReply = () => ({ response: "France", synthetic: false, fallback: "Sonnet 5.5 answered after Opus 5.5 declined." });
    const f = answered(await apply(reg, askFrame("Which country is the city you named first the capital of?")));
    expect(f.fallback).toBe("Sonnet 5.5 answered after Opus 5.5 declined.");
    expect(chat.sideAsks.map((a) => a.history)).toEqual([
      [],
      [{ question: "What is the capital of France?", response: "Side answer to: What is the capital of France?" }],
      [{ question: "What is the capital of France?", response: "Side answer to: What is the capital of France?" }],
    ]);
    // The main conversation got nothing.
    expect(chat.sent).toHaveLength(1);
  });

  test("the thread keeps the newest 20 answered exchanges, and a question goes with those 20", async () => {
    const { reg, driver, store } = await setup();
    const chat = await liveChat(reg, driver);
    for (let i = 1; i <= 22; i++) answered(await apply(reg, askFrame(`Question ${i}`)));
    const thread = (await read(reg)).result;
    expect(thread.exchanges.map((x) => x.question)).toEqual(Array.from({ length: 20 }, (_, i) => `Question ${i + 3}`));
    expect(thread.rev).toBe(44);
    // The 22nd went with the 20 the thread held then: questions 2 to 21.
    expect(chat.sideAsks.at(-1)!.history.map((h) => h.question)).toEqual(Array.from({ length: 20 }, (_, i) => `Question ${i + 2}`));
    expect(store.sides.get(CHAT)?.exchanges).toHaveLength(20);
  });

  test("one at a time: another id is busy, a resend of the id that runs joins it, and an answered id answers again", async () => {
    const { reg, driver } = await setup();
    const chat = await liveChat(reg, driver);
    const g = gate<{ response: string; synthetic: boolean; fallback: null }>();
    chat.sideReply = () => g.p;
    const id = rid();
    const first = apply(reg, askFrame("Slow one", id));
    await until(() => chat.sideAsks.length === 1, "the ask");
    expect(await apply(reg, askFrame("Another"))).toEqual({ ok: false, code: "busy" });
    const again = apply(reg, askFrame("Slow one", id));
    g.release({ response: "Done slowly.", synthetic: false, fallback: null });
    const [a, b] = await Promise.all([first, again]);
    expect(answered(a)).toEqual(answered(b));
    expect(answered(await apply(reg, askFrame("Slow one", id)))).toEqual(answered(a));
    expect(chat.sideAsks).toHaveLength(1);
    // While it ran the chat was no turn: idle, not busy.
    expect(reg.stateOf(CHAT)).toBe("idle");
  });

  test("Stop: the question leaves the thread for every page, its ack says stopped, the process is told, and the turn is untouched", async () => {
    const { reg, driver } = await setup();
    const chat = await liveChat(reg, driver);
    const a = new RecordingViewer("tab_a");
    const b = new RecordingViewer("tab_b");
    await reg.attach(CHAT, a);
    await reg.attach(CHAT, b);
    chat.sideReply = () => new Promise(() => {});
    const id = rid();
    const q = reg.request(askFrame("Walk me through the whole retry rule.", id), { tab: "tab_a" });
    await until(() => chat.sideAsks.length === 1, "the ask");
    expect(await apply(reg, { t: "side_stop", rid: rid(), chat: CHAT, id }, { tab: "tab_b" })).toEqual({ ok: true, result: { stopped: true } });
    expect(await q).toEqual({ ok: true, result: { stopped: true } });
    expect(chat.sideAsks[0]!.signal.aborted).toBe(true);
    expect(chat.sideAsks[0]!.signal.reason).toBe("stop");
    for (const v of [a, b]) expect(sideEvents(v).map((e) => (e.k === "side" ? `side ${e.x.state}` : e.k))).toEqual(["side asking", "side_gone"]);
    expect(sideEvents(a).at(-1)).toEqual({ k: "side_gone", rev: 2, id });
    expect((await read(reg)).result).toEqual({ rev: 2, exchanges: [] });
    expect(await apply(reg, { t: "side_stop", rid: rid(), chat: CHAT, id })).toEqual({ ok: true, result: { stopped: false } });
    expect(chat.calls).not.toContain("interrupt");
  });

  test("a failure: the exchange fails with its code; Try again asks under the same id; a new question takes a failed one's place", async () => {
    const { reg, driver } = await setup();
    const chat = await liveChat(reg, driver);
    chat.sideReply = () => new Error("Query closed before response received");
    const id = rid();
    expect(await apply(reg, askFrame("Which test is flaky?", id))).toEqual({ ok: false, code: "failed" });
    expect((await read(reg)).result.exchanges).toEqual([{ id, question: "Which test is flaky?", at: expect.any(String), state: "failed", error: "failed" }]);
    chat.sideReply = () => null;
    expect(await apply(reg, askFrame("Which test is flaky?", id))).toEqual({ ok: false, code: "failed" });
    chat.sideReply = (s) => ({ response: `Answer to ${s.question}`, synthetic: false, fallback: null });
    expect(answered(await apply(reg, askFrame("Which test is flaky?", id))).answer).toBe("Answer to Which test is flaky?");
    expect((await read(reg)).result.exchanges.map((x) => [x.id, x.state])).toEqual([[id, "answered"]]);
    chat.sideReply = () => new Error("Failed to get response");
    const broken = rid();
    expect(await apply(reg, askFrame("Is the fix in?", broken))).toEqual({ ok: false, code: "failed" });
    chat.sideReply = () => ({ response: "Yes.", synthetic: false, fallback: null });
    const next = rid();
    answered(await apply(reg, askFrame("Is the build green?", next)));
    expect((await read(reg)).result.exchanges.map((x) => [x.id, x.state])).toEqual([
      [id, "answered"],
      [next, "answered"],
    ]);
    // An agent with no side question after all (the feature test) says so.
    chat.sideReply = () => Object.assign(new Error("Query.askSideQuestion is not in this Agent SDK"), { name: "DriverError", code: "unsupported" });
    expect(await apply(reg, askFrame("One more?"))).toEqual({ ok: false, code: "unsupported" });
  });

  test("a retry shows on the exchange while it asks, and goes with the answer", async () => {
    const { reg, driver } = await setup();
    const chat = await liveChat(reg, driver);
    const page = new RecordingViewer();
    await reg.attach(CHAT, page);
    const g = gate<{ response: string; synthetic: boolean; fallback: null }>();
    chat.sideReply = () => g.p;
    const q = apply(reg, askFrame("Is it the retry rule?"));
    await until(() => chat.sideAsks.length === 1, "the ask");
    chat.sideAsks[0]!.progress({ status: "started" });
    chat.sideAsks[0]!.progress({ status: "api_retry", attempt: 2, max: 10, delayMs: 4000 });
    await until(() => sideEvents(page).length === 2, "the retry");
    expect((sideEvents(page)[1] as Extract<ChatEvent, { k: "side" }>).x).toMatchObject({ state: "asking", retry: { attempt: 2, max: 10, delayMs: 4000 } });
    g.release({ response: "Yes.", synthetic: false, fallback: null });
    const x = answered(await q);
    expect(x).not.toHaveProperty("retry");
    // A late progress changes nothing.
    chat.sideAsks[0]!.progress({ status: "api_retry", attempt: 3, max: 10, delayMs: 8000 });
    await settle();
    expect(sideEvents(page)).toHaveLength(3);
  });

  test("Clear is busy while a question runs; then the thread empties for every page, also in the file", async () => {
    const { reg, driver, store } = await setup();
    const chat = await liveChat(reg, driver);
    answered(await apply(reg, askFrame("First?")));
    const g = gate<{ response: string; synthetic: boolean; fallback: null }>();
    chat.sideReply = () => g.p;
    const q = apply(reg, askFrame("Second?"));
    await until(() => chat.sideAsks.length === 2, "the ask");
    expect(await apply(reg, { t: "side_clear", rid: rid(), chat: CHAT })).toEqual({ ok: false, code: "busy" });
    g.release({ response: "Yes.", synthetic: false, fallback: null });
    answered(await q);
    const page = new RecordingViewer();
    await reg.attach(CHAT, page);
    expect(await apply(reg, { t: "side_clear", rid: rid(), chat: CHAT })).toEqual({ ok: true, result: null });
    expect(sideEvents(page)).toEqual([{ k: "side_clear", rev: 5 }]);
    expect((await read(reg)).result).toEqual({ rev: 5, exchanges: [] });
    expect(store.sides.get(CHAT)).toEqual({ v: 1, id: CHAT, rev: 5, exchanges: [] });
    // An empty thread clears to itself: no event.
    expect(await apply(reg, { t: "side_clear", rid: rid(), chat: CHAT })).toEqual({ ok: true, result: null });
    expect(sideEvents(page)).toHaveLength(1);
    // The next question has no history.
    chat.sideReply = (s) => ({ response: s.question, synthetic: false, fallback: null });
    answered(await apply(reg, askFrame("Third?")));
    expect(chat.sideAsks.at(-1)!.history).toEqual([]);
  });

  test("refused with nothing stored: an archived, deleted or held chat, the restart's drain, an agent with no side question", async () => {
    const { reg, driver, store } = await setup({ openCheckMs: 10, openFastMs: 10 });
    expect(await apply(reg, askFrame("Gone?", rid(), "nosuchchat2abcdefghi"))).toEqual({ ok: false, code: "not_found" });
    expect(await apply(reg, { t: "archive", rid: rid(), chat: OTHER, on: true, stop: false })).toEqual({ ok: true, result: null });
    expect(await apply(reg, askFrame("Archived?", rid(), OTHER))).toEqual({ ok: false, code: "archived" });
    expect(await apply(reg, { t: "side_clear", rid: rid(), chat: OTHER })).toEqual({ ok: false, code: "archived" });
    driver.openNow.set(SID, { app: "terminal", busy: false });
    await until(() => reg.list().find((r) => r.chat === CHAT)?.held != null, "the hold");
    expect(await apply(reg, askFrame("Held?"))).toEqual({ ok: false, code: "session_held" });
    driver.openNow.delete(SID);
    await until(() => reg.list().find((r) => r.chat === CHAT)?.held == null, "the hold's end");
    expect(reg.drain("finish")).toEqual({ ok: true });
    expect(await apply(reg, askFrame("Draining?"))).toEqual({ ok: false, code: "restarting" });
    reg.undrain();
    expect(driver.opens).toHaveLength(0);
    expect(store.sides.size).toBe(0);
    const w = world();
    w.driver.caps = { ...w.driver.caps, sideQuestions: false };
    const off = await life(w);
    expect(await apply(off, askFrame("No side questions?"))).toEqual({ ok: false, code: "unsupported" });
    expect(w.driver.opens).toHaveLength(0);
  });

  test("a start that would wait for a free slot fails at once: no line in the main chat, and nothing starts later", async () => {
    const { reg, driver } = await setup({ maxLive: 1 });
    autoReply(driver);
    // OTHER is live, idle and on a page, so it is no victim.
    const keep = new RecordingViewer();
    await reg.attach(OTHER, keep);
    const u = rid();
    expect((await apply(reg, { t: "send", rid: u, chat: OTHER, uuid: u, text: "Plan it.", draftRev: null, uploads: [] })).ok).toBe(true);
    await until(() => reg.stateOf(OTHER) === "idle", "OTHER's turn");
    const page = new RecordingViewer();
    await reg.attach(CHAT, page);
    expect(await apply(reg, askFrame("Can you answer now?"))).toEqual({ ok: false, code: "failed" });
    expect(driver.opens).toHaveLength(1);
    expect(page.events.filter((e) => e.k === "notice" || e.k === "taken_back")).toEqual([]);
    expect(sideEvents(page).map((e) => (e.k === "side" ? e.x.state : e.k))).toEqual(["asking", "failed"]);
    // A free slot later starts nothing for it.
    reg.detach(OTHER, keep);
    expect(await apply(reg, { t: "archive", rid: rid(), chat: OTHER, on: true, stop: false })).toEqual({ ok: true, result: null });
    await settle(10);
    expect(driver.opens).toHaveLength(1);
    expect(reg.stateOf(CHAT)).toBe("sleeping");
  });

  test("the process's end while it asks fails it; Archive cuts one in flight and keeps the thread", async () => {
    const { reg, driver } = await setup();
    let chat = await liveChat(reg, driver);
    chat.sideReply = () => new Promise(() => {});
    const q = apply(reg, askFrame("Still there?"));
    await until(() => chat.sideAsks.length === 1, "the ask");
    chat.end({ code: 1, signal: null });
    expect(await q).toEqual({ ok: false, code: "failed" });
    expect((await read(reg)).result.exchanges.map((x) => x.state)).toEqual(["failed"]);
    chat = await liveChat(reg, driver);
    chat.sideReply = () => new Promise(() => {});
    const q2 = apply(reg, askFrame("Before the archive?"));
    await until(() => chat.sideAsks.length === 1, "the ask");
    expect(await apply(reg, { t: "archive", rid: rid(), chat: CHAT, on: true, stop: false })).toEqual({ ok: true, result: null });
    expect(await q2).toEqual({ ok: false, code: "archived" });
    expect((await read(reg)).result.exchanges).toEqual([{ id: expect.any(String), question: "Before the archive?", at: expect.any(String), state: "failed", error: "archived" }]);
  });

  test("Delete takes the thread and its file with the chat, also with a question in flight", async () => {
    const { reg, driver, store } = await setup();
    const chat = await liveChat(reg, driver);
    answered(await apply(reg, askFrame("Kept?")));
    expect(store.sides.has(CHAT)).toBe(true);
    chat.sideReply = () => new Promise(() => {});
    const q = apply(reg, askFrame("In flight?"));
    await until(() => chat.sideAsks.length === 2, "the ask");
    const writes = store.sideWrites.length;
    expect(await apply(reg, { t: "delete", rid: rid(), chat: CHAT })).toEqual({ ok: true, result: null });
    expect(await q).toEqual({ ok: false, code: "not_found" });
    await settle();
    expect(store.sides.has(CHAT)).toBe(false);
    expect(store.sideWrites.length).toBe(writes);
  });

  test("the idle rule and the cap keep a chat's process while its side question runs, as no turn", async () => {
    const { reg, driver } = await setup({ idleMs: 40, maxLive: 1 });
    const chat = await liveChat(reg, driver);
    const g = gate<{ response: string; synthetic: boolean; fallback: null }>();
    chat.sideReply = () => g.p;
    const q = apply(reg, askFrame("Slow?"));
    await until(() => chat.sideAsks.length === 1, "the ask");
    await Bun.sleep(120);
    expect(chat.closed).toBe(false);
    // A send to OTHER waits for a free slot: CHAT is no victim while its side question runs.
    autoReply(driver);
    const u = rid();
    expect(await apply(reg, { t: "send", rid: u, chat: OTHER, uuid: u, text: "Plan it.", draftRev: null, uploads: [] })).toEqual({ ok: true, result: { queued: true } });
    expect(chat.closed).toBe(false);
    g.release({ response: "Yes.", synthetic: false, fallback: null });
    answered(await q);
    // Then it may go: the cap ends it for OTHER's start.
    await until(() => chat.closed, "CHAT's close for the cap");
    await until(() => reg.stateOf(OTHER) === "idle", "OTHER's start");
  });

  test("kitespan's own bound ends a side question that never answers", async () => {
    const { reg, driver } = await setup({ sideDeadlineMs: 60 });
    const chat = await liveChat(reg, driver);
    chat.sideReply = () => new Promise(() => {});
    expect(await apply(reg, askFrame("Forever?"))).toEqual({ ok: false, code: "failed" });
    expect(chat.sideAsks[0]!.signal.reason).toBe("deadline");
  });
});

describe("the thread over a restart", () => {
  test("kept after a close and across a restart; one that was asking reads as failed, and the rev goes on", async () => {
    const w = world();
    const reg = await life(w);
    const chat = await liveChat(reg, w.driver);
    const x = answered(await apply(reg, askFrame("Which file holds the cap?")));
    chat.sideReply = () => new Promise(() => {});
    const q = apply(reg, askFrame("And the second one?"));
    await until(() => chat.sideAsks.length === 2, "the ask");
    await reg.shutdown();
    expect(await q).toEqual({ ok: false, code: "failed" });
    const after = await life(w);
    const thread = (await read(after)).result;
    expect(thread.exchanges).toEqual([x, { id: expect.any(String), question: "And the second one?", at: expect.any(String), state: "failed", error: "failed" }]);
    // A file written while it asked (a crash): asking reads as failed.
    w.store.sides.set(CHAT, { v: 1, id: CHAT, rev: 9, exchanges: [x, { id: rid(), question: "Mid-crash?", at: AT, state: "asking", retry: { attempt: 1, max: 10, delayMs: 500 } }] });
    const third = await life(w);
    const t3 = (await read(third)).result;
    expect(t3.rev).toBe(9);
    expect(t3.exchanges[1]).toEqual({ id: expect.any(String), question: "Mid-crash?", at: AT, state: "failed", error: "failed" });
    // Reading it starts no chat.
    expect(w.driver.opens).toHaveLength(1);
    const page = new RecordingViewer();
    await third.attach(CHAT, page);
    w.driver.script = null;
    answered(await apply(third, askFrame("After the restart?")));
    expect(sideEvents(page).map((e) => e.k === "side" && e.rev)).toEqual([10, 11]);
    expect(w.driver.last.sideAsks[0]!.history).toEqual([{ question: x.question, response: x.answer! }]);
  });
});

describe("/btw typed in the message box", () => {
  test("is never a prompt: a send or a new chat with it is refused, and Claude Code gets nothing", async () => {
    const { reg, driver } = await setup();
    const chat = await liveChat(reg, driver);
    for (const text of ["/btw which file holds the cap?", "/btw", "  /btw\nwhy"]) {
      const u = rid();
      expect(await apply(reg, { t: "send", rid: u, chat: CHAT, uuid: u, text, draftRev: null, uploads: [] })).toEqual({ ok: false, code: "bad_request" });
    }
    expect(chat.sent.map((s) => s.text)).toEqual(["Run the upload test."]);
    expect(await apply(reg, { t: "new_chat", rid: rid(), project: PROJECT, uuid: rid(), text: "/btw hi", picks: { model: null, effort: null, mode: null }, uploads: [] })).toEqual({ ok: false, code: "bad_request" });
    expect(driver.opens).toHaveLength(1);
    // A message that only starts with the letters is a message.
    const u = rid();
    expect((await apply(reg, { t: "send", rid: u, chat: CHAT, uuid: u, text: "/btwx is a typo", draftRev: null, uploads: [] })).ok).toBe(true);
    // With no side questions, the code says the agent cannot.
    const w = world();
    w.driver.caps = { ...w.driver.caps, sideQuestions: false };
    const off = await life(w);
    const v = rid();
    expect(await apply(off, { t: "send", rid: v, chat: CHAT, uuid: v, text: "/btw why", draftRev: null, uploads: [] })).toEqual({ ok: false, code: "unsupported" });
  });
});

describe("the thread's shape and its history", () => {
  const ex = (i: number, over: Partial<SideExchange> = {}): SideExchange => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, question: `Q${i}`, at: AT, state: "answered", answer: `A${i}`, ...over });
  test("an answered exchange joins the answered ones; one that asks or failed is the last, in a failed one's place", () => {
    const list = [ex(1), ex(2), ex(3, { state: "failed", answer: undefined, error: "failed" })];
    expect(sidePut(list, ex(4, { state: "asking", answer: undefined })).map((x) => [x.question, x.state])).toEqual([
      ["Q1", "answered"],
      ["Q2", "answered"],
      ["Q4", "asking"],
    ]);
    expect(sidePut(list, ex(3)).map((x) => x.question)).toEqual(["Q1", "Q2", "Q3"]);
    expect(sidePut(list, null, ex(2).id).map((x) => x.question)).toEqual(["Q1", "Q3"]);
    const many = Array.from({ length: 20 }, (_, i) => ex(i + 1));
    expect(sidePut(many, ex(21)).map((x) => x.question)).toEqual(Array.from({ length: 20 }, (_, i) => `Q${i + 2}`));
    expect(sidePut(many, ex(21, { state: "asking", answer: undefined }))).toHaveLength(21);
  });
  test("the file stays at most 1 MiB: the oldest answered go first", () => {
    const big = (i: number) => ex(i, { question: "问".repeat(SIDE_LIMITS.question), answer: "答".repeat(SIDE_LIMITS.answer) });
    const list = sidePut(Array.from({ length: 19 }, (_, i) => big(i + 1)), big(20));
    expect(Buffer.byteLength(JSON.stringify({ v: 1, id: CHAT, rev: 1, exchanges: list }))).toBeLessThanOrEqual(SIDE_FILE_BYTES);
    expect(list.at(-1)!.id).toBe(big(20).id);
    expect(list.length).toBeLessThan(20);
  });
  test("history: answered and not synthetic, oldest first, the newest 20, never the one asked", () => {
    const list = [ex(1), ex(2, { synthetic: true }), ex(3), ex(4, { state: "failed", answer: undefined, error: "failed" })];
    expect(sideHistory(list, ex(3).id)).toEqual([{ question: "Q1", response: "A1" }]);
    expect(sideHistory(list, ex(9).id)).toEqual([
      { question: "Q1", response: "A1" },
      { question: "Q3", response: "A3" },
    ]);
    expect(sideHistory(Array.from({ length: 25 }, (_, i) => ex(i + 1)), ex(99).id).map((h) => h.question)).toEqual(Array.from({ length: 20 }, (_, i) => `Q${i + 6}`));
  });
});
