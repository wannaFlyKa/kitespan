// Row 116 (R116): the seen flag, held by the server (FIX-R116 section 2; DESIGN-R116 sections 5 and 6). A turn's end
// that no page has on screen sets the chat's `unseen` (`done`, or `failed` for an error or an exit by itself); a
// page's `on_screen` with `on` clears it for every page; a turn that ends while a page has the chat on screen is seen
// at once; a Stop and Restart now's cut set nothing; the flag is in the ledger, so it survives a restart; an on counts
// only while its socket was heard from in the last 20 s. The scripted driver, MemoryStore, a scripted process table
// and fake sockets stand in for Claude Code, the disk, the system and the pages.
import { describe, expect, test } from "bun:test";
import { WIRE, type ChatDelta, type ChatEvent, type ChatRow, type NewChatFrame } from "../../shared/protocol";
import { ChatRegistry } from "../../server/chats/registry";
import type { ProcTable } from "../../server/chats/stops";
import { FakeBash, FakeChat, FakeDriver, MemoryStore, RecordingViewer, apply, projectRecord, settle } from "../../server/chats/testing";
import type { RegistryOptions } from "../../server/chats/types";
import type { ChatLedger } from "../../server/store/types";
import { wsHandlers, type ChatSock } from "../../server/ws/handlers";

const PROJECT = "k3m7q2x4ab";
const CHAT = "k3m7q2x4abk3m7q2x4ab";
const SID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const rid = () => crypto.randomUUID();

/** The system's processes as a test scripts them (chats-stop.test.ts): pid to start time. */
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

/** A page whose socket the test makes quiet (no frame for `quiet` ms). */
class QuietViewer extends RecordingViewer {
  quiet = 0;
  quietMs(): number {
    return this.quiet;
  }
}

function world() {
  const driver = new FakeDriver();
  const store = new MemoryStore();
  store.projects = [projectRecord(PROJECT)];
  return { driver, store, procs: new Procs() };
}

async function life(w: ReturnType<typeof world>, opts: RegistryOptions = {}) {
  const reg = new ChatRegistry({ driver: w.driver, store: w.store, bash: new FakeBash(), procs: w.procs, orphanGraceMs: 60 }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500, openCheckMs: 15, openFastMs: 15, ...opts });
  await reg.boot();
  const deltas: ChatDelta[] = [];
  reg.subscribe((d) => deltas.push(d));
  await settle();
  return { reg, deltas };
}

async function setup(opts: RegistryOptions = {}) {
  const w = world();
  return { ...w, ...(await life(w, opts)) };
}

function newChatFrame(text: string): NewChatFrame {
  return { t: "new_chat", rid: rid(), project: PROJECT, uuid: rid(), text, picks: { model: null, effort: null, mode: null }, uploads: [] };
}

/** A new chat whose first turn ended while a page had it on screen (seen), with no page left on it. */
async function newChat(reg: ChatRegistry, driver: FakeDriver, text = "Plan the upload feature"): Promise<string> {
  const o = await apply(reg, newChatFrame(text));
  if (!o.ok) throw new Error(`new_chat refused: ${o.code}`);
  const chat = (o.result as { chat: string }).chat;
  const first = new RecordingViewer("tab_first");
  await reg.attach(chat, first);
  reg.onScreen(chat, first, true);
  driver.last.emit(ended());
  await settle();
  reg.detach(chat, first);
  return chat;
}

const ended = (ok = true): ChatEvent => ({ k: "turn_end", ok, subtype: ok ? "success" : "error_during_execution", durationMs: 2, error: ok ? null : "The API returned an error.", uuids: [] });
const rowOf = (reg: ChatRegistry, chat: string): ChatRow => reg.list().find((r) => r.chat === chat)!;
/** Every value the deltas gave the chat's `unseen`, in order. */
const unseenDeltas = (deltas: readonly ChatDelta[], chat: string, from = 0) => deltas.slice(from).flatMap((d) => (d.chat === chat && "unseen" in d ? [d.unseen] : []));

/** One turn of the live chat: its start (the turn's seq, for Stop) and, unless `open`, its end. */
async function turn(c: FakeChat, v: RecordingViewer, end: ChatEvent | null = ended()): Promise<number> {
  c.emit({ k: "turn_start", by: "user" });
  await settle();
  const seq = v.items.filter((i) => i.e.k === "turn_start").at(-1)!.seq;
  if (end) {
    c.emit(end);
    await settle();
  }
  return seq;
}

describe("a turn's end and the pages", () => {
  test("a turn that ends with no page on screen sets unseen in the row, one delta and the ledger; an error sets failed", async () => {
    const { reg, driver, store, deltas } = await setup();
    const chat = await newChat(reg, driver);
    const c = driver.last;
    // A page that is attached but does not say the chat is on screen (a background tab, the list) does not see it.
    const v = new RecordingViewer("tab_a");
    await reg.attach(chat, v);
    expect(rowOf(reg, chat).unseen).toBeUndefined();
    await turn(c, v);
    expect(rowOf(reg, chat).unseen).toBe("done");
    expect(unseenDeltas(deltas, chat)).toEqual(["done"]);
    expect(store.chats.get(chat)!.unseen).toBe("done");
    await turn(c, v, ended(false));
    expect(rowOf(reg, chat).unseen).toBe("failed");
    expect(unseenDeltas(deltas, chat)).toEqual(["done", "failed"]);
    expect(store.chats.get(chat)!.unseen).toBe("failed");
    await reg.shutdown();
  });

  test("a page's on clears it for every page and the ledger at once; a turn that ends while a page has it on screen is seen", async () => {
    const { reg, driver, store, deltas } = await setup();
    const chat = await newChat(reg, driver);
    const c = driver.last;
    const a = new RecordingViewer("tab_a");
    const b = new RecordingViewer("tab_b");
    await reg.attach(chat, a);
    await reg.attach(chat, b);
    await turn(c, a);
    expect(rowOf(reg, chat).unseen).toBe("done");
    const n = deltas.length;
    reg.onScreen(chat, b, true);
    // The delta goes to every socket (the registry's subscribers), so the laptop's list loses the dot too.
    expect(deltas.slice(n)).toEqual([{ chat, unseen: null }]);
    expect(rowOf(reg, chat).unseen).toBeUndefined();
    await settle();
    expect(store.chats.get(chat)!.unseen).toBeUndefined();
    // While b says on, the next end is seen at once: no delta sets it, so no other page ever shows the dot.
    const m = deltas.length;
    await turn(c, a);
    await turn(c, a, ended(false));
    expect(unseenDeltas(deltas, chat, m)).toEqual([]);
    expect(store.chats.get(chat)!.unseen).toBeUndefined();
    // An on that says nothing new (no flag) sends nothing.
    const k = deltas.length;
    reg.onScreen(chat, a, true);
    expect(deltas.slice(k)).toEqual([]);
    await reg.shutdown();
  });

  test("two pages at once: any page on screen keeps it seen; a page that says off, detaches or closes loses its on", async () => {
    const { reg, driver, deltas } = await setup();
    const chat = await newChat(reg, driver);
    const c = driver.last;
    const a = new RecordingViewer("tab_a");
    const b = new RecordingViewer("tab_b");
    await reg.attach(chat, a);
    await reg.attach(chat, b);
    reg.onScreen(chat, a, true);
    reg.onScreen(chat, b, false);
    await turn(c, a);
    expect(rowOf(reg, chat).unseen).toBeUndefined();
    // a goes to the background: off. The end is not seen; b coming on screen clears it for both.
    reg.onScreen(chat, a, false);
    await turn(c, a);
    expect(rowOf(reg, chat).unseen).toBe("done");
    reg.onScreen(chat, b, true);
    expect(rowOf(reg, chat).unseen).toBeUndefined();
    // b leaves the chat (detach, or its socket closed): its on goes with it.
    reg.detach(chat, b);
    await turn(c, a);
    expect(rowOf(reg, chat).unseen).toBe("done");
    // An on from a page that did not attach the chat counts for nothing.
    reg.onScreen(chat, b, true);
    expect(rowOf(reg, chat).unseen).toBe("done");
    reg.onScreen(chat, a, true);
    expect(rowOf(reg, chat).unseen).toBeUndefined();
    expect(unseenDeltas(deltas, chat)).toEqual(["done", null, "done", null]);
    await reg.shutdown();
  });

  test("a Stop, Send now's stop and a new turn's start set nothing; the flag stays until a page sees it", async () => {
    const { reg, driver, deltas } = await setup();
    const chat = await newChat(reg, driver);
    const c = driver.last;
    const v = new RecordingViewer("tab_a");
    await reg.attach(chat, v);
    // A Stop from any page: the user's own act is seen.
    const seq = await turn(c, v, null);
    expect(await apply(reg, { t: "interrupt", rid: rid(), chat, turn: seq })).toEqual({ ok: true, result: { stillQueued: null } });
    c.emit({ k: "turn_end", ok: false, subtype: "error_during_execution", durationMs: 2, error: "Request was aborted.", uuids: [] });
    await settle();
    expect(rowOf(reg, chat).unseen).toBeUndefined();
    // A turn that ends unseen, then a new turn: while it runs the flag stays (the page shows the running dot first).
    await turn(c, v);
    await turn(c, v, null);
    expect(rowOf(reg, chat).state).toBe("running");
    expect(rowOf(reg, chat).unseen).toBe("done");
    expect(unseenDeltas(deltas, chat)).toEqual(["done"]);
    await reg.shutdown();
  });

  test("Claude Code's exit by itself (the exit line) sets failed; a close that kitespan asked for (the idle rule) sets nothing", async () => {
    const { reg, driver, store } = await setup({ idleMs: 30 });
    const chat = await newChat(reg, driver);
    const c = driver.last;
    const v = new RecordingViewer("tab_a");
    await reg.attach(chat, v);
    reg.onScreen(chat, v, true);
    await turn(c, v);
    reg.detach(chat, v);
    // No viewer, idle: D2 ends the process after 30 ms, with no exit line.
    for (let i = 0; i < 50 && !c.closed; i++) await Bun.sleep(10);
    await settle();
    expect(c.closed).toBe(true);
    expect(rowOf(reg, chat).unseen).toBeUndefined();
    // The next start dies by itself: the exit line, and failed.
    expect((await apply(reg, { t: "send", rid: rid(), chat, uuid: rid(), text: "again", draftRev: null, uploads: [] })).ok).toBe(true);
    const d = driver.last;
    expect(d).not.toBe(c);
    d.end({ code: 1, signal: null });
    await settle(10);
    expect(rowOf(reg, chat).state).toBe("sleeping");
    expect(rowOf(reg, chat).unseen).toBe("failed");
    expect(store.chats.get(chat)!.unseen).toBe("failed");
    await reg.shutdown();
  });

  test("on_screen is a state report: an unknown chat is ignored, an archived chat changes nothing, and Archive clears the flag", async () => {
    const { reg, driver, store, deltas } = await setup();
    const chat = await newChat(reg, driver);
    const c = driver.last;
    const v = new RecordingViewer("tab_a");
    await reg.attach(chat, v);
    reg.onScreen("zzzzzzzzzzzzzzzzzzzz", v, true);
    await turn(c, v);
    expect(rowOf(reg, chat).unseen).toBe("done");
    expect((await apply(reg, { t: "archive", rid: rid(), chat, on: true, stop: false })).ok).toBe(true);
    await settle();
    expect(rowOf(reg, chat).archived).toBe(true);
    expect(rowOf(reg, chat).unseen).toBeUndefined();
    expect(store.chats.get(chat)!.unseen).toBeUndefined();
    const n = deltas.length;
    reg.onScreen(chat, v, true);
    reg.onScreen(chat, v, false);
    expect(deltas.slice(n)).toEqual([]);
    await reg.shutdown();
  });
});

describe("an on counts while its socket was heard from in the last 20 s", () => {
  test("a page whose socket went quiet (a phone that froze its page) does not see the end; heard again, still on, it does", async () => {
    const { reg, driver, deltas } = await setup();
    const chat = await newChat(reg, driver);
    const c = driver.last;
    const v = new QuietViewer("tab_phone");
    await reg.attach(chat, v);
    reg.onScreen(chat, v, true);
    v.quiet = WIRE.onScreenFreshMs;
    await turn(c, v);
    expect(rowOf(reg, chat).unseen).toBeUndefined();
    v.quiet = WIRE.onScreenFreshMs + 1;
    await turn(c, v);
    expect(rowOf(reg, chat).unseen).toBe("done");
    // Its socket is heard again and it never said off (its frames come in order): the chat is on screen there.
    v.quiet = 0;
    reg.heardAgain(chat, v);
    expect(rowOf(reg, chat).unseen).toBeUndefined();
    // One that said off is not on screen when it is heard again.
    reg.onScreen(chat, v, false);
    v.quiet = WIRE.onScreenFreshMs + 1;
    await turn(c, v);
    v.quiet = 0;
    reg.heardAgain(chat, v);
    expect(rowOf(reg, chat).unseen).toBe("done");
    expect(unseenDeltas(deltas, chat)).toEqual(["done", null, "done"]);
    await reg.shutdown();
  });
});

const ledger = (over: Partial<ChatLedger>): ChatLedger => ({
  v: 1,
  id: CHAT,
  project: PROJECT,
  cwd: "/srv/work/app",
  agent: "claude-code",
  sessionId: SID,
  title: { text: "Old chat", from: "first-prompt" },
  picks: { model: null, effort: null, permissionMode: null },
  createdAt: "2026-10-30T08:00:00.000Z",
  seenAt: "2026-10-30T08:00:00.000Z",
  lastActivityAt: "2026-10-30T08:00:00.000Z",
  lastSeq: 7,
  state: "sleeping",
  lastExit: null,
  archivedAt: null,
  ...over,
});

const user = (text: string): ChatEvent => ({ k: "user", uuid: rid(), text, queued: false });
const reply = (text: string): ChatEvent => ({ k: "block", key: `msg_${text.length}:0`, kind: "text", text, parent: null });
/** A transcript whose last turn was cut in a tool call, and one whose last turn ended in a reply. */
const cut = (): ChatEvent[] => [user("first"), reply("Done."), user("run the long one"), { k: "tool_call", id: "toolu_cut", name: "Bash", input: { command: "sleep 20" }, parent: null }];
const finished = (): ChatEvent[] => [user("first"), reply("Done."), user("again"), reply("All done.")];

async function until(pred: () => boolean, ms = 4_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

describe("over a restart", () => {
  test("the flag is in the ledger: the next server's rows carry it, and a page's on clears it there", async () => {
    const w = world();
    const first = await life(w);
    const chat = await newChat(first.reg, w.driver);
    const v = new RecordingViewer("tab_a");
    await first.reg.attach(chat, v);
    await turn(w.driver.last, v, ended(false));
    await first.reg.shutdown();
    expect(w.store.chats.get(chat)!.unseen).toBe("failed");
    const next = await life(w);
    expect(rowOf(next.reg, chat).unseen).toBe("failed");
    const phone = new RecordingViewer("tab_phone");
    await next.reg.attach(chat, phone);
    next.reg.onScreen(chat, phone, true);
    await settle();
    expect(rowOf(next.reg, chat).unseen).toBeUndefined();
    expect(w.store.chats.get(chat)!.unseen).toBeUndefined();
    // The server forgets every page's on at a restart: each page says it again after its new attach is drawn.
    await next.reg.shutdown();
  });

  test("a crash's stop line sets failed; a crash whose turn finished meanwhile sets done; Restart now's line sets nothing", async () => {
    for (const [stop, history, want] of [
      [{ why: "running", by: "crash" }, cut(), "failed"],
      [{ why: "waiting", by: "crash" }, finished(), "failed"],
      [{ why: "running", by: "crash" }, finished(), "done"],
      [{ why: "running", by: "shutdown" }, cut(), "failed"],
      [{ why: "running", by: "shutdown" }, finished(), undefined],
      [{ why: "running", by: "restart" }, cut(), undefined],
      [{ why: "running", by: "restart_failed" }, cut(), undefined],
    ] as const) {
      const w = world();
      w.store.chats.set(CHAT, ledger({ stop: { ...stop, at: "2026-10-30T08:00:00.000Z" } }));
      w.driver.transcript(SID);
      w.driver.histories.set(SID, history);
      const { reg } = await life(w);
      await settle(10);
      expect([stop, rowOf(reg, CHAT).unseen]).toEqual([stop, want]);
      expect([stop, w.store.chats.get(CHAT)!.unseen]).toEqual([stop, want]);
      await reg.shutdown();
    }
  });

  test("a ledger with no stop keeps its flag as it is; Restart now's cut of a live turn sets nothing after the new boot", async () => {
    const w = world();
    w.store.chats.set(CHAT, ledger({ unseen: "done" }));
    const first = await life(w);
    expect(rowOf(first.reg, CHAT).unseen).toBe("done");
    await first.reg.shutdown();
    const other = world();
    const { reg } = await life(other);
    const chat = await newChat(reg, other.driver);
    const v = new RecordingViewer("tab_a");
    await reg.attach(chat, v);
    await turn(other.driver.last, v, null);
    await reg.shutdown({ by: "restart", interrupt: true });
    expect(other.store.chats.get(chat)!.unseen).toBeUndefined();
    const next = await life(other);
    await settle(10);
    expect(rowOf(next.reg, chat).unseen).toBeUndefined();
    await next.reg.shutdown();
  });

  test("kitespan's own orphan: its end sets done when it finished the turn, failed when the turn was cut, nothing after a Stop", async () => {
    for (const [after, stop, want] of [
      [finished(), false, "done"],
      [cut(), false, "failed"],
      [cut(), true, undefined],
    ] as const) {
      const w = world();
      w.store.chats.set(CHAT, ledger({ state: "running", proc: { pid: 4242, start: "100" } }));
      w.driver.histories.set(SID, cut());
      w.procs.live.set(4242, "100");
      const { reg } = await life(w);
      expect(rowOf(reg, CHAT).held?.kind).toBe("finishing");
      expect(rowOf(reg, CHAT).unseen).toBeUndefined();
      if (stop) expect((await apply(reg, { t: "interrupt", rid: rid(), chat: CHAT, turn: 0 })).ok).toBe(true);
      w.driver.histories.set(SID, after);
      w.procs.live.delete(4242);
      await until(() => rowOf(reg, CHAT).held === undefined);
      await settle(10);
      expect([after.length, stop, rowOf(reg, CHAT).unseen]).toEqual([after.length, stop, want]);
      await reg.shutdown();
    }
  });

  test("a page that has the chat on screen when the orphan ends sees it", async () => {
    const w = world();
    w.store.chats.set(CHAT, ledger({ state: "running", proc: { pid: 4242, start: "100" } }));
    w.driver.histories.set(SID, cut());
    w.procs.live.set(4242, "100");
    const { reg } = await life(w);
    const v = new RecordingViewer("tab_a");
    await reg.attach(CHAT, v);
    reg.onScreen(CHAT, v, true);
    w.driver.histories.set(SID, finished());
    w.procs.live.delete(4242);
    await until(() => rowOf(reg, CHAT).held === undefined);
    await settle(10);
    expect(rowOf(reg, CHAT).unseen).toBeUndefined();
    await reg.shutdown();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The chat socket: on_screen goes to the registry only for a chat the socket attached; its last frame times the on.

class FakeSock implements ChatSock {
  data: { state: unknown } = { state: null };
  readonly sent: string[] = [];
  send(s: string): number {
    this.sent.push(s);
    return s.length;
  }
  close(): void {}
  getBufferedAmount(): number {
    return 0;
  }
}

describe("on_screen on the chat socket", () => {
  test("only for an attached chat, no ack; a detach or a closed socket drops the on; a quiet socket's on counts again once heard", async () => {
    const { reg, driver } = await setup();
    let now = 1_000_000;
    const hub = wsHandlers(reg, { pumpMs: 5, clock: () => now });
    const msg = (ws: FakeSock, f: Record<string, unknown>) => hub.message(ws, JSON.stringify(f));
    const connect = (tab: string): FakeSock => {
      const ws = new FakeSock();
      hub.open(ws);
      msg(ws, { t: "hello", v: 1, tab });
      return ws;
    };
    const chat = await newChat(reg, driver);
    const c = driver.last;
    const recorder = new RecordingViewer("tab_rec");
    await reg.attach(chat, recorder);
    const laptop = connect("tab_laptop");
    const phone = connect("tab_phone");
    // Not attached yet: the report is ignored.
    msg(phone, { t: "on_screen", chat, on: true });
    await turn(c, recorder);
    expect(rowOf(reg, chat).unseen).toBe("done");
    msg(laptop, { t: "attach", chat, since: 0, epoch: null });
    msg(phone, { t: "attach", chat, since: 0, epoch: null });
    await settle(10);
    const before = phone.sent.length;
    msg(phone, { t: "on_screen", chat, on: true });
    expect(rowOf(reg, chat).unseen).toBeUndefined();
    // No ack: the delta to every socket is the answer.
    const after = phone.sent.slice(before).map((s) => JSON.parse(s) as Record<string, unknown>);
    expect(after).toEqual([{ t: "chats", delta: { chat, unseen: null } }]);
    expect(laptop.sent.map((s) => JSON.parse(s))).toContainEqual({ t: "chats", delta: { chat, unseen: null } });
    // The phone locks and its page freezes before it can say off: 20 s with no frame, and its on stops counting.
    now += WIRE.onScreenFreshMs + 1;
    msg(laptop, { t: "ping", n: 1 });
    await turn(c, recorder);
    expect(rowOf(reg, chat).unseen).toBe("done");
    // Unlocked, its socket is heard again (a ping): it never said off, so the chat is on screen there.
    msg(phone, { t: "ping", n: 2 });
    expect(rowOf(reg, chat).unseen).toBeUndefined();
    // A page that said off before its quiet spell: heard again, nothing changes.
    msg(phone, { t: "on_screen", chat, on: false });
    now += WIRE.onScreenFreshMs + 1;
    await turn(c, recorder);
    msg(phone, { t: "ping", n: 3 });
    expect(rowOf(reg, chat).unseen).toBe("done");
    // The laptop says on, then detaches: the next end is not seen.
    msg(laptop, { t: "on_screen", chat, on: true });
    expect(rowOf(reg, chat).unseen).toBeUndefined();
    msg(laptop, { t: "detach", chat });
    await turn(c, recorder);
    expect(rowOf(reg, chat).unseen).toBe("done");
    // The phone says on, then its socket closes.
    msg(phone, { t: "on_screen", chat, on: true });
    expect(rowOf(reg, chat).unseen).toBeUndefined();
    hub.close(phone);
    await turn(c, recorder);
    expect(rowOf(reg, chat).unseen).toBe("done");
    // A bad report (no `on`) is no frame; nothing comes back.
    const n = laptop.sent.length;
    msg(laptop, { t: "on_screen", chat });
    expect(laptop.sent.length).toBe(n);
    hub.dispose();
    await reg.shutdown();
  });
});
