// R131 (owner row 131; DESIGN-R131 section 9): the background sessions that a chat starts, in the chat registry. A
// launch row (a tool result whose `background` the driver set) puts its ids in the chat's book: live (Starting at once,
// after the row) and from every history read (the book comes back after a restart). The state comes from the records
// of the D58 look (busy, waiting, idle) and from Claude Code's list (through the seam) only for what a record cannot say,
// by 9.3's table; an event goes to the chat's pages only on a change, `attached.background` serves a late page, and the
// chat row's own field lights the dot (needs input, or an end that no page saw). Stop checks the book before anything
// starts. The view reads the session's transcript with its own folder, only inside the chat's project or worktree. The
// scripted driver stands in for Claude Code; the folders are real, in a scratch folder.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BG_NO_STAMP, type BgLaunch, type BgWorker, type ChatDelta, type ChatEvent } from "../../shared/protocol";
import type { BgListRow, BgRecord } from "../../server/agents/types";
import { BackgroundBook } from "../../server/chats/background";
import { ChatRegistry } from "../../server/chats/registry";
import { FakeDriver, MemoryStore, RecordingViewer, apply, autoReply, projectRecord, settle } from "../../server/chats/testing";
import type { Outcome, RegistryOptions } from "../../server/chats/types";
import type { LogEvent, LogFields, Logger } from "../../server/log";
import type { ChatLedger } from "../../server/store/types";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "chats-background-")));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const SHOP = join(ROOT, "srv", "you", "shop");
const WORKER = join(SHOP, "worktrees", "remove-negative-qty");
const IN_TREE = join(SHOP, ".claude", "worktrees", "fix-qty");
const OUTSIDE = join(ROOT, "srv", "you", "elsewhere");
const LINKED = join(SHOP, "linked-out");
for (const d of [WORKER, IN_TREE, OUTSIDE]) mkdirSync(d, { recursive: true });
symlinkSync(OUTSIDE, LINKED);

const PROJECT = "k3m7q2x4ab";
const CHAT = "k3m7q2x4abk3m7q2x4ab";
const OTHER = "otherchat2abcdefghij";
const SID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const SID2 = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const WSID = "7e682626-781a-4916-b942-8fa4f25780e9";
const A = "7e682626";
const B = "8a56ad66";
const C = "0a1b2c3d";
const rid = () => crypto.randomUUID();
const START = 1_762_300_000_000;

function ledger(over: Partial<ChatLedger> = {}): ChatLedger {
  return {
    v: 1,
    id: CHAT,
    project: PROJECT,
    cwd: SHOP,
    agent: "claude-code",
    sessionId: SID,
    transcript: true,
    title: { text: "Negative quantity investigator", from: "first-prompt" },
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

/** A history whose Bash row printed these launch lines (the driver set `background` from its whole text). */
function launchHistory(prefix: string, rows: BgLaunch[][]): ChatEvent[] {
  const out: ChatEvent[] = [{ k: "user", uuid: `${prefix}-u`, text: "Start an investigator in the background.", queued: false }];
  rows.forEach((launches, i) => {
    const id = `${prefix}-bg-${i}`;
    out.push({ k: "tool_call", id, name: "Bash", input: { command: "claude --bg -n investigate" }, parent: null });
    out.push({ k: "tool_result", id, text: launches.map((l) => `backgrounded · ${l.id}`).join("\n"), isError: false, parent: null, report: null, background: launches });
  });
  out.push({ k: "block", key: `${prefix}-m:0`, kind: "text", text: "It runs in the background.", parent: null });
  out.push({ k: "turn_end", ok: true, subtype: "success", durationMs: 5, error: null, uuids: [`${prefix}-u`] });
  return out;
}

const launch = (id: string, name: string | null = "investigate", idle = false): BgLaunch => ({ id, name, idle });
const rec = (jobId: string, over: Partial<BgRecord> = {}): BgRecord => ({ jobId, sessionId: WSID, name: "investigate", cwd: WORKER, status: "busy", waitingFor: null, startedAt: START, pid: 4242, procStart: "777", ...over });
const row = (id: string, over: Partial<BgListRow> = {}): BgListRow => ({ id, sessionId: WSID, name: "investigate", cwd: WORKER, state: "working", status: "busy", waitingFor: null, startedAt: START, ...over });

class LogSpy implements Logger {
  readonly lines: { ev: LogEvent; f: LogFields }[] = [];
  failures = 0;
  log(ev: LogEvent, f: LogFields = {}): void {
    this.lines.push({ ev, f: { ...f } });
  }
  sweep(): number {
    return 0;
  }
  close(): void {}
}

async function setup(opts: RegistryOptions = {}, hist: { chat?: BgLaunch[][]; other?: BgLaunch[][] } = {}, chatOver: Partial<ChatLedger> = {}) {
  const driver = new FakeDriver();
  const store = new MemoryStore();
  const log = new LogSpy();
  store.projects = [projectRecord(PROJECT, SHOP)];
  store.chats.set(CHAT, ledger(chatOver));
  store.chats.set(OTHER, ledger({ id: OTHER, sessionId: SID2 }));
  driver.transcript(SID, "Start it", SHOP);
  driver.transcript(SID2, "Start it", SHOP);
  driver.histories.set(SID, launchHistory("c", hist.chat ?? [[launch(A)]]));
  driver.histories.set(SID2, launchHistory("o", hist.other ?? []));
  driver.bgList = [];
  const reg = new ChatRegistry({ driver, store, log }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500, openCheckMs: 15, openFastMs: 10, bgLaunchWaitMs: 80, bgListKeepMs: 60, ...opts });
  const deltas: ChatDelta[] = [];
  reg.subscribe((d) => deltas.push(d));
  await reg.boot();
  return { driver, store, log, reg, deltas };
}
type World = Awaited<ReturnType<typeof setup>>;

async function page(w: World, chat = CHAT) {
  const v = new RecordingViewer();
  const p = await w.reg.attach(chat, v);
  if (!p) throw new Error("no such chat");
  return { v, attached: p.attached, history: p.snapshot.history };
}

async function until<T>(get: () => T | undefined | null | false, ms = 3_000, what = "the condition"): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

const bgEvents = (v: RecordingViewer, id?: string) => v.of("background").filter((e) => id === undefined || e.id === id);
const lastWorker = (v: RecordingViewer, id: string): BgWorker | null | undefined => bgEvents(v, id).at(-1)?.worker;
const stateOf = (v: RecordingViewer, id: string) => {
  const w = lastWorker(v, id);
  return w === undefined ? undefined : w === null ? "gone" : w.state;
};
const rowField = (w: World, chat = CHAT) => w.reg.list().find((r) => r.chat === chat)?.background ?? null;
const stop = (w: World, id: string, chat = CHAT) => apply(w.reg, { t: "background_stop", rid: rid(), chat, id });
const answer = (o: Outcome) => (o.ok ? (o.result as { background: string }).background : `error ${o.code}`);

/** A live chat whose stream the test drives (its first message's turn ended). */
async function live(w: World) {
  autoReply(w.driver);
  await apply(w.reg, { t: "send", rid: rid(), chat: CHAT, uuid: crypto.randomUUID(), text: "go", draftRev: null, uploads: [] });
  await settle(20);
  return w.driver.last;
}
const launchRow = (id: string, launches: BgLaunch[], parent: string | null = null): ChatEvent[] => [
  { k: "tool_call", id, name: "Bash", input: { command: "claude --bg" }, parent },
  { k: "tool_result", id, text: launches.map((l) => `backgrounded · ${l.id}`).join("\n"), isError: false, parent, report: null, background: launches },
];

describe("the book", () => {
  test("history: the chat's launch rows put their ids in its book, and Claude Code's list gives each state once", async () => {
    const w = await setup();
    w.driver.bgList = [row(A)];
    const { v, attached, history } = await page(w);
    expect(history.find((e) => e.k === "tool_result" && e.background)).toMatchObject({ id: "c-bg-0", background: [launch(A)] });
    expect(attached.background).toBeUndefined();
    await until(() => lastWorker(v, A), 2_000, "the state from the list");
    expect(lastWorker(v, A)).toEqual({ state: "working", name: "investigate", folder: WORKER, view: true, startedAt: START });
    expect(w.driver.bgListAsks[0]).toEqual([A]);
    expect(w.reg.backgroundHas(CHAT, A)).toBe(true);
    expect(w.reg.backgroundHas(OTHER, A)).toBe(false);
    // A page that comes later gets every state in `attached`.
    expect((await page(w)).attached.background).toEqual({ [A]: lastWorker(v, A)! });
    expect((await page(w, OTHER)).attached.background).toBeUndefined();
    // The list's run is one log line: its time, its exit code and the count of its rows, nothing else.
    expect(w.log.lines.filter((l) => l.ev === "bg_list")[0]).toEqual({ ev: "bg_list", f: { ms: 3, code: 0, count: 1 } });
  });

  test("live: Starting at once after the row (main thread or subagent); busy is Working; waiting is Needs input and lights the row", async () => {
    const w = await setup({}, { chat: [] });
    const { v } = await page(w);
    const chat = await live(w);
    chat.emit(...launchRow("live-bg", [launch(B)]), ...launchRow("sub-bg", [launch(C, null, true)], "toolu_agent"));
    await settle(10);
    const kinds = v.events.map((e) => (e.k === "tool_result" ? `result ${e.id}` : e.k === "background" ? `background ${e.id}` : null)).filter(Boolean);
    expect(kinds).toEqual(["result live-bg", `background ${B}`, "result sub-bg", `background ${C}`]);
    expect(lastWorker(v, B)).toEqual({ state: "starting", name: "investigate", folder: null, view: false, startedAt: null });
    expect(lastWorker(v, C)).toMatchObject({ state: "starting", idleLaunch: true, name: null });
    w.driver.bgRecords = [rec(B)];
    await until(() => stateOf(v, B) === "working", 2_000, "working");
    expect(lastWorker(v, B)).toEqual({ state: "working", name: "investigate", folder: WORKER, view: true, startedAt: START });
    w.driver.bgRecords = [rec(B, { status: "waiting", waitingFor: "permission prompt" })];
    await until(() => stateOf(v, B) === "needs_input", 2_000, "needs input");
    expect(lastWorker(v, B)).toMatchObject({ state: "needs_input", waitingFor: "permission prompt" });
    expect(rowField(w)).toBe("needs_input");
    expect(w.deltas.some((d) => d.chat === CHAT && "background" in d && d.background === "needs_input")).toBe(true);
    // Many looks with the same record: no more events.
    const n = bgEvents(v, B).length;
    await Bun.sleep(80);
    expect(bgEvents(v, B).length).toBe(n);
  });

  test("idle asks the list: done is Completed, unseen until a page has its line or view on screen (the chat at its end alone does not see it)", async () => {
    const w = await setup({}, { chat: [] });
    const { v } = await page(w);
    const chat = await live(w);
    w.driver.bgRecords = [rec(B)];
    chat.emit(...launchRow("live-bg", [launch(B)]));
    await until(() => stateOf(v, B) === "working", 2_000, "working");
    const asked = w.driver.bgListAsks.length;
    w.driver.bgList = [row(B, { state: "done", status: "idle" })];
    w.driver.bgRecords = [rec(B, { status: "idle" })];
    await until(() => stateOf(v, B) === "completed", 2_000, "completed");
    expect(w.driver.bgListAsks.length).toBeGreaterThan(asked);
    expect(lastWorker(v, B)).toMatchObject({ state: "completed", unseen: true });
    expect(rowField(w)).toBe("done");
    // The chat on screen at its end, with the session's line out of sight (far up, or folded away): still unseen.
    w.reg.onScreen(CHAT, v, true);
    expect(lastWorker(v, B)?.unseen).toBe(true);
    expect(rowField(w)).toBe("done");
    // The line on screen (its own report, with the session's id): seen for every page; the row's field goes with null.
    w.reg.onScreen(CHAT, v, true, B);
    expect(lastWorker(v, B)).toEqual({ state: "completed", name: "investigate", folder: WORKER, view: true, startedAt: START });
    expect(rowField(w)).toBeNull();
    expect(w.deltas.filter((d) => d.chat === CHAT && "background" in d).at(-1)).toMatchObject({ background: null });
  });

  test("an end while that session's line or view is on screen waits for no one; the chat at its end does not stand for it; neither marks the chat seen", async () => {
    const w = await setup({}, { chat: [] }, { unseen: "done" });
    const a = await page(w);
    const chat = await live(w);
    w.driver.bgRecords = [rec(B), rec(C, { pid: 4343, sessionId: SID2 })];
    chat.emit(...launchRow("live-bg", [launch(B), launch(C)]));
    await until(() => stateOf(a.v, B) === "working" && stateOf(a.v, C) === "working", 2_000, "both working");
    // B's line (or view) is on screen on one page: it never marks the chat seen.
    w.reg.onScreen(CHAT, a.v, true, B);
    expect(w.reg.list().find((r) => r.chat === CHAT)?.unseen).toBe("done");
    // The chat itself is on screen at its end on another page, where C's line is out of sight.
    const other = await page(w);
    w.reg.onScreen(CHAT, other.v, true);
    w.driver.bgList = [row(B, { state: "failed", status: null }), row(C, { state: "failed", status: null })];
    w.driver.bgRecords = [];
    await until(() => stateOf(a.v, B) === "failed" && stateOf(a.v, C) === "failed", 2_000, "both failed");
    expect(lastWorker(a.v, B)?.unseen).toBeUndefined();
    expect(lastWorker(a.v, C)?.unseen).toBe(true);
    expect(rowField(w)).toBe("failed");
    // C's line or view on screen too (one page can have both lines on screen) sees it; B's report still stands.
    w.reg.onScreen(CHAT, a.v, true, C);
    expect(lastWorker(a.v, C)?.unseen).toBeUndefined();
    expect(rowField(w)).toBeNull();
    // The chat's own unseen end was seen by the page that had the chat on screen, never by a session's report.
    expect(w.reg.list().find((r) => r.chat === CHAT)?.unseen).toBeUndefined();
    // A view report names only the chat's own sessions.
    w.reg.onScreen(CHAT, a.v, true, "ffffffff");
    expect(bgEvents(a.v, "ffffffff")).toEqual([]);
  });

  test("the row's precedence: needs input, then failed, then done", async () => {
    const w = await setup({}, { chat: [] });
    const { v } = await page(w);
    const chat = await live(w);
    w.driver.bgRecords = [rec(A, { pid: 1 }), rec(B, { pid: 2 }), rec(C, { pid: 3 })];
    chat.emit(...launchRow("bg", [launch(A), launch(B), launch(C)]));
    await until(() => [A, B, C].every((id) => stateOf(v, id) === "working"), 2_000, "three working");
    w.driver.bgList = [row(A, { state: "done", status: null }), row(B, { state: "failed", status: null })];
    w.driver.bgRecords = [rec(C, { pid: 3, status: "waiting", waitingFor: "input needed" })];
    await until(() => stateOf(v, A) === "completed" && stateOf(v, B) === "failed" && stateOf(v, C) === "needs_input", 2_000, "the three states");
    expect(rowField(w)).toBe("needs_input");
    w.driver.bgRecords = [rec(C, { pid: 3 })];
    await until(() => stateOf(v, C) === "working", 2_000, "C working");
    expect(rowField(w)).toBe("failed");
    w.reg.onScreen(CHAT, v, true, B);
    expect(rowField(w)).toBe("done");
  });

  test("each look asks the agent for the records of the books' ids only (it keeps nothing of any other session)", async () => {
    const w = await setup({}, { other: [[launch(C)]] });
    await page(w);
    await page(w, OTHER);
    const from = w.driver.bgRecordAsks.length;
    await until(() => w.driver.bgRecordAsks.length > from + 2, 2_000, "the looks");
    expect(w.driver.bgRecordAsks.slice(from).every((ids) => JSON.stringify(ids) === JSON.stringify([A, C].sort()))).toBe(true);
  });

  test("the cap: 64 ids per chat, the newest kept", async () => {
    const ids = Array.from({ length: 70 }, (_, i) => (0x10000000 + i).toString(16));
    const w = await setup({}, { chat: ids.map((id) => [launch(id)]) });
    await page(w);
    expect(ids.filter((id) => w.reg.backgroundHas(CHAT, id))).toEqual(ids.slice(6));
    expect(w.driver.bgListAsks.at(-1)?.length ?? 64).toBeLessThanOrEqual(64);
  });

  test("a background session's record never holds a chat (D58's map counts it as another app's, for its own session only)", async () => {
    const w = await setup({}, { chat: [] });
    w.driver.openNow.set(WSID, { app: "other", busy: true });
    w.driver.bgRecords = [rec(A)];
    await page(w);
    await Bun.sleep(60);
    expect(w.reg.list().find((r) => r.chat === CHAT)?.held).toBeUndefined();
    expect(w.reg.list().find((r) => r.chat === OTHER)?.held).toBeUndefined();
  });
});

describe("the state table (9.3)", () => {
  async function working(w: World, id = B) {
    const { v } = await page(w);
    const chat = await live(w);
    w.driver.bgRecords = [rec(id)];
    chat.emit(...launchRow(`bg-${id}`, [launch(id)]));
    await until(() => stateOf(v, id) === "working", 2_000, "working");
    return v;
  }

  test("the record goes: the list's stopped, done or failed; not listed is gone; a list that cannot be read keeps the state", async () => {
    for (const [list, want] of [
      [[row(B, { state: "stopped", status: null })], "stopped"],
      [[row(B, { state: "done", status: null })], "completed"],
      [[], "gone"],
      [null, "working"],
    ] as const) {
      const w = await setup({}, { chat: [] });
      const v = await working(w);
      w.driver.bgList = list === null ? null : [...list];
      const asked = w.driver.bgListAsks.length;
      w.driver.bgRecords = [];
      await until(() => w.driver.bgListAsks.length > asked, 2_000, "a list read");
      await settle(10);
      await Bun.sleep(30);
      expect(stateOf(v, B)).toBe(want);
      if (want === "gone") expect(lastWorker(v, B)).toBeNull();
    }
  });

  test("an idle record: the list decides (blocked with the idle launch is Needs input), and Idle when it cannot be read", async () => {
    const w = await setup({}, { chat: [] });
    const { v } = await page(w);
    const chat = await live(w);
    w.driver.bgRecords = [rec(B, { status: "idle" }), rec(C, { status: "idle", pid: 9 })];
    w.driver.bgList = [row(B, { state: "blocked", status: "idle" })];
    chat.emit(...launchRow("bg", [launch(B, null, true)]));
    await until(() => stateOf(v, B) === "needs_input", 2_000, "needs input");
    expect(lastWorker(v, B)).toMatchObject({ state: "needs_input", idleLaunch: true, name: "investigate" });
    expect(lastWorker(v, B)?.waitingFor).toBeUndefined();
    w.driver.bgList = null;
    chat.emit(...launchRow("bg2", [launch(C)]));
    await until(() => stateOf(v, C) === "idle", 2_000, "idle");
  });

  test("a live launch with no record 5 s on: listed gives its state, not listed is gone", async () => {
    const w = await setup({}, { chat: [] });
    const { v } = await page(w);
    const chat = await live(w);
    w.driver.bgList = [row(B, { state: "working", status: null })];
    chat.emit(...launchRow("bg", [launch(B), launch(C)]));
    await settle(10);
    expect([stateOf(v, B), stateOf(v, C)]).toEqual(["starting", "starting"]);
    await until(() => stateOf(v, B) === "working" && stateOf(v, C) === "gone", 2_000, "working and gone");
  });

  test("a list answer kept from before a change is read again once it may run", async () => {
    const w = await setup({}, { chat: [] });
    const v = await working(w);
    // The driver answers from before the change for a while, then a fresh run says done.
    w.driver.bgListAt = Date.now() - 10_000;
    w.driver.bgList = [row(B, { state: "working" })];
    w.driver.bgRecords = [rec(B, { status: "idle" })];
    await until(() => w.driver.bgListAsks.length >= 2, 2_000, "a list read");
    w.driver.bgListAt = null;
    w.driver.bgList = [row(B, { state: "done" })];
    await until(() => stateOf(v, B) === "completed", 3_000, "completed after a fresh read");
  });
});

describe("Stop", () => {
  test("the checks, in order, before any stop runs", async () => {
    const w = await setup();
    await page(w);
    expect(answer(await stop(w, B))).toBe("error stale");
    expect(answer(await apply(w.reg, { t: "background_stop", rid: rid(), chat: CHAT, id: "NOPE" }))).toBe("error bad_request");
    w.driver.bgStopAnswer = "unsupported";
    expect(answer(await stop(w, A))).toBe("error unsupported");
    w.driver.bgStopAnswer = "no_claude";
    expect(answer(await stop(w, A))).toBe("error no_claude");
    expect(w.driver.bgStops).toEqual([A, A]);
    const archived = await setup({}, {}, { archivedAt: "2026-11-05T09:00:00.000Z" });
    await page(archived);
    expect(answer(await stop(archived, A))).toBe("error archived");
    expect(archived.driver.bgStops).toEqual([]);
    expect(w.log.lines.filter((l) => l.ev === "bg_stop")).toEqual([]);
  });

  test("one stop per id at a time: a second press while one runs is busy", async () => {
    const w = await setup();
    await page(w);
    let go = () => {};
    w.driver.bgStopWait = new Promise<void>((r) => (go = r));
    const first = stop(w, A);
    await settle(5);
    expect(answer(await stop(w, A))).toBe("error busy");
    go();
    expect(answer(await first)).toBe("stopped");
    expect(w.driver.bgStops).toEqual([A]);
  });

  test("stopped: Stopped at once on every page, one log line with the id and the answer; that process's record changes nothing, a new one's does", async () => {
    const w = await setup({}, { chat: [] }, {});
    const a = await page(w);
    const chat = await live(w);
    w.driver.bgRecords = [rec(B)];
    chat.emit(...launchRow("bg", [launch(B)]));
    await until(() => stateOf(a.v, B) === "working", 2_000, "working");
    const b = await page(w);
    expect(answer(await stop(w, B))).toBe("stopped");
    expect(stateOf(a.v, B)).toBe("stopped");
    expect(stateOf(b.v, B)).toBe("stopped");
    expect(lastWorker(a.v, B)?.unseen).toBeUndefined();
    expect(w.log.lines.filter((l) => l.ev === "bg_stop")).toEqual([{ ev: "bg_stop", f: { id: B, answer: "stopped" } }]);
    await Bun.sleep(60);
    expect(stateOf(a.v, B)).toBe("stopped");
    w.driver.bgRecords = [rec(B, { pid: 5151, procStart: "888" })];
    await until(() => stateOf(a.v, B) === "working", 2_000, "a new process works");
  });

  test("a Stop of a session that completed or failed keeps its end: Claude Code's list still says done after it (the lead's live run)", async () => {
    for (const [end, want] of [["done", "completed"], ["failed", "failed"]] as const) {
      const w = await setup({}, { chat: [] });
      const { v } = await page(w);
      const chat = await live(w);
      w.driver.bgRecords = [rec(B)];
      chat.emit(...launchRow("bg", [launch(B)]));
      await until(() => stateOf(v, B) === "working", 2_000, "working");
      w.driver.bgList = [row(B, { state: end, status: null })];
      w.driver.bgRecords = [];
      await until(() => stateOf(v, B) === want, 2_000, want);
      expect(answer(await stop(w, B))).toBe("stopped");
      await settle(10);
      expect(stateOf(v, B)).toBe(want);
      expect(w.log.lines.filter((l) => l.ev === "bg_stop")).toEqual([{ ev: "bg_stop", f: { id: B, answer: "stopped" } }]);
    }
  });

  test("not found: the line goes; failed: the state stays and the list is read", async () => {
    const w = await setup({}, { chat: [] });
    const { v } = await page(w);
    const chat = await live(w);
    w.driver.bgRecords = [rec(B), rec(C, { pid: 9 })];
    chat.emit(...launchRow("bg", [launch(B), launch(C)]));
    await until(() => stateOf(v, B) === "working" && stateOf(v, C) === "working", 2_000, "working");
    w.driver.bgStopAnswer = "not_found";
    expect(answer(await stop(w, B))).toBe("not_found");
    expect(lastWorker(v, B)).toBeNull();
    w.driver.bgStopAnswer = "failed";
    const asked = w.driver.bgListAsks.length;
    expect(answer(await stop(w, C))).toBe("failed");
    expect(stateOf(v, C)).toBe("working");
    await until(() => w.driver.bgListAsks.length > asked, 2_000, "a list read");
  });
});

describe("the view's read", () => {
  async function inBook(cwd: string, over: Partial<BgListRow> = {}) {
    const w = await setup();
    w.driver.bgList = [row(A, { cwd, ...over })];
    const { v } = await page(w);
    await until(() => lastWorker(v, A), 2_000, "the state");
    return { w, v };
  }

  test("a session in the project: the newest page with its stamp and mode; the same stamp answers same with no read", async () => {
    const { w, v } = await inBook(WORKER);
    w.driver.transcript(WSID, "Follow the brief", WORKER);
    w.driver.sessions.set(WSID, { ...w.driver.sessions.get(WSID)!, lastModified: START + 5, fileSize: 1234 });
    w.driver.histories.set(WSID, [{ k: "user", uuid: "w-u", text: "Follow BRIEF-investigate.md", queued: false }]);
    w.driver.bgModes.set(`${WSID} ${WORKER}`, "bypassPermissions");
    const asked = w.driver.bgListAsks.length;
    const first = await w.reg.backgroundView(CHAT, A, { since: null, before: null });
    expect(first).toEqual({ history: [{ k: "user", uuid: "w-u", text: "Follow BRIEF-investigate.md", queued: false }], more: null, stamp: `${START + 5}:1234`, mode: "bypassPermissions" });
    await until(() => w.driver.bgListAsks.length > asked, 2_000, "the view's list read");
    const reads = w.driver.sessionDirs.filter((d) => d.op === "history" && d.sessionId === WSID).length;
    expect(await w.reg.backgroundView(CHAT, A, { since: `${START + 5}:1234`, before: null })).toEqual({ same: true });
    expect(w.driver.sessionDirs.filter((d) => d.op === "history" && d.sessionId === WSID).length).toBe(reads);
    expect(w.driver.sessionDirs.filter((d) => d.sessionId === WSID).every((d) => d.cwd === WORKER)).toBe(true);
    expect(lastWorker(v, A)?.view).toBe(true);
  });

  test("a session in a worktree of the project, filed under the folder it came from: read there", async () => {
    const { w } = await inBook(IN_TREE);
    w.driver.transcript(WSID, "Fix it", SHOP);
    w.driver.infoOnlyIn.set(WSID, SHOP);
    w.driver.histories.set(WSID, [{ k: "user", uuid: "w-u", text: "Fix it", queued: false }]);
    const reply = await w.reg.backgroundView(CHAT, A, { since: null, before: null });
    expect(reply?.history?.length).toBe(1);
    expect(w.driver.sessionDirs.filter((d) => d.sessionId === WSID).map((d) => [d.op, d.cwd])).toEqual([
      ["info", IN_TREE],
      ["info", SHOP],
      ["history", SHOP],
    ]);
  });

  test("a session outside the project (here through a link) has no view: outside, and nothing is read", async () => {
    const { w, v } = await inBook(LINKED);
    expect(lastWorker(v, A)).toMatchObject({ view: false, folder: OUTSIDE });
    w.driver.transcript(WSID, "Elsewhere", LINKED);
    expect(await w.reg.backgroundView(CHAT, A, { since: null, before: null })).toEqual({ outside: true });
    expect(w.driver.sessionDirs.filter((d) => d.sessionId === WSID)).toEqual([]);
  });

  test("an id the chat did not print, another chat, an archived chat: none; no transcript yet: an empty page", async () => {
    const { w } = await inBook(WORKER);
    expect(await w.reg.backgroundView(CHAT, B, { since: null, before: null })).toBeNull();
    expect(await w.reg.backgroundView(OTHER, A, { since: null, before: null })).toBeNull();
    expect(await w.reg.backgroundView(CHAT, A, { since: null, before: null })).toEqual({ history: [], more: null, stamp: BG_NO_STAMP, mode: null });
    const archived = await setup({}, {}, { archivedAt: "2026-11-05T09:00:00.000Z" });
    await page(archived);
    expect(await archived.reg.backgroundView(CHAT, A, { since: null, before: null })).toBeNull();
  });

  test("no transcript yet (or none any more): one list read for the opening, never one per tick; a transcript that comes is read", async () => {
    const { w } = await inBook(WORKER);
    const asked = w.driver.bgListAsks.length;
    const first = await w.reg.backgroundView(CHAT, A, { since: null, before: null });
    expect(first).toEqual({ history: [], more: null, stamp: BG_NO_STAMP, mode: null });
    await until(() => w.driver.bgListAsks.length > asked, 2_000, "the opening's list read");
    const opened = w.driver.bgListAsks.length;
    // The page's later ticks send the stamp it got: each is a later read, which answers same while nothing is there.
    for (let i = 0; i < 6; i++) expect(await w.reg.backgroundView(CHAT, A, { since: first!.stamp!, before: null })).toEqual({ same: true });
    await Bun.sleep(150);
    expect(w.driver.bgListAsks.length).toBe(opened);
    // The transcript comes: the next tick reads it, with no list read either.
    w.driver.transcript(WSID, "Follow the brief", WORKER);
    w.driver.sessions.set(WSID, { ...w.driver.sessions.get(WSID)!, lastModified: START + 9, fileSize: 77 });
    w.driver.histories.set(WSID, [{ k: "user", uuid: "w-u", text: "Follow BRIEF-investigate.md", queued: false }]);
    const grown = await w.reg.backgroundView(CHAT, A, { since: BG_NO_STAMP, before: null });
    expect(grown).toMatchObject({ stamp: `${START + 9}:77`, history: [{ k: "user", uuid: "w-u" }] });
    await Bun.sleep(150);
    expect(w.driver.bgListAsks.length).toBe(opened);
  });

  test("the shutdown closes the book (nothing more is read); a restart that did not happen opens it again", async () => {
    const asks: string[][] = [];
    const events: ChatEvent[] = [];
    const book = new BackgroundBook({
      list: async (ids) => (asks.push([...ids]), { rows: [row(A)], at: Date.now(), ran: null }),
      roots: () => [SHOP],
      seen: () => false,
      emit: (_c, e) => events.push(e),
      changed: () => {},
      log: () => {},
    });
    book.close();
    book.note(CHAT, "bg", [launch(A)], true);
    book.records([rec(A)]);
    await Bun.sleep(20);
    expect([asks, events, book.has(CHAT, A)]).toEqual([[], [], false]);
    book.reopen();
    book.note(CHAT, "bg", [launch(A)], false);
    book.afterHistory(CHAT);
    await until(() => events.length > 0, 1_000, "the state after the reopen");
    expect(asks).toEqual([[A]]);
    expect(events.at(-1)).toMatchObject({ k: "background", id: A, worker: { state: "working" } });
    book.close();
  });

  test("Delete forgets the chat's book", async () => {
    const { w } = await inBook(WORKER);
    expect(w.reg.backgroundHas(CHAT, A)).toBe(true);
    expect((await apply(w.reg, { t: "delete", rid: rid(), chat: CHAT })).ok).toBe(true);
    expect(w.reg.backgroundHas(CHAT, A)).toBe(false);
  });
});
