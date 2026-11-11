// D32 and kitespan's own orphans in the registry (R15, R16; BUILD-BRIEF section 2 items 1 and 2). A stop of the server
// that cut a chat's turn or card gives one line, placed under the cut turn in history (the notes) and drawn once on
// every page, but only when the turn did not finish: a chat whose last turn ended in a reply gets none, and one that
// waited for an answer always gets the waiting line. A claude that the server before this one started and that still
// runs (a kill -9 does not end a running turn) holds its chat as `finishing`, never as another app's; Stop sends it
// SIGTERM, then SIGKILL after the grace, only while the pid has the recorded start; when it exits the hold ends, the
// line comes if its turn did not finish, and nothing starts. The scripted driver, MemoryStore and a scripted process
// table stand in for Claude Code, the disk and the system.
import { describe, expect, test } from "bun:test";
import { TURN_CUT, TURN_INTERRUPTED, type ChatDelta, type ChatEvent, type PermissionCard, type SendFrame } from "../../shared/protocol";
import { ChatRegistry } from "../../server/chats/registry";
import { existsSync, readFileSync } from "node:fs";
import { procLives, systemProcs, type ProcTable } from "../../server/chats/stops";
import { FakeBash, FakeDriver, MemoryStore, RecordingViewer, apply, projectRecord, settle } from "../../server/chats/testing";
import type { RegistryOptions } from "../../server/chats/types";
import { resumeCommand } from "../../server/shell/command";
import { ledgerProcOf, type ChatLedger } from "../../server/store/types";
import { LINUX_ONLY } from "../linux";

const PROJECT = "k3m7q2x4ab";
const CHAT = "k3m7q2x4abk3m7q2x4ab";
const RUNNING = "kitespan stopped while this chat was running. Send a message to continue.";
const WAITING = "This chat was waiting for your answer when kitespan stopped. Send a message to continue.";
const rid = () => crypto.randomUUID();

/** The system's processes as a test scripts them: pid to start time; SIGTERM ends one unless it ignores it. */
class Procs implements ProcTable {
  readonly live = new Map<number, string>();
  readonly kills: [number, string][] = [];
  ignoresTerm = new Set<number>();
  async startOf(pid: number): Promise<string | null> {
    return this.live.get(pid) ?? null;
  }
  sameStart(a: string, b: string): boolean {
    return a === b;
  }
  kill(pid: number, signal: "SIGTERM" | "SIGKILL"): boolean {
    this.kills.push([pid, signal]);
    if (signal === "SIGKILL" || !this.ignoresTerm.has(pid)) this.live.delete(pid);
    return true;
  }
}

function ledger(over: Partial<ChatLedger>): ChatLedger {
  return {
    v: 1,
    id: CHAT,
    project: PROJECT,
    cwd: "/srv/work/app",
    agent: "claude-code",
    sessionId: null,
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
  };
}

async function life(driver: FakeDriver, store: MemoryStore, procs: Procs, opts: RegistryOptions = {}) {
  const reg = new ChatRegistry({ driver, store, bash: new FakeBash(), procs, orphanGraceMs: 60 }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500, openCheckMs: 15, openFastMs: 15, ...opts });
  await reg.boot();
  const deltas: ChatDelta[] = [];
  reg.subscribe((d) => deltas.push(d));
  await settle();
  return { reg, deltas };
}
function world() {
  const driver = new FakeDriver();
  const store = new MemoryStore();
  store.projects = [projectRecord(PROJECT)];
  return { driver, store, procs: new Procs() };
}

const SID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const user = (text: string, uuid = rid()): ChatEvent => ({ k: "user", uuid, text, queued: false });
const reply = (text: string): ChatEvent => ({ k: "block", key: `msg_${text.length}:0`, kind: "text", text, parent: null });
const call = (id: string): ChatEvent => ({ k: "tool_call", id, name: "Bash", input: { command: "sleep 20" }, parent: null });
/** A transcript whose first turn ended and whose second was cut in a tool call. */
const cut = (): ChatEvent[] => [user("first"), reply("Done."), user("run the long one"), call("toolu_cut")];
/** A transcript whose last turn ended in a reply. */
const finished = (): ChatEvent[] => [user("first"), reply("Done."), user("again"), call("toolu_ok"), { k: "tool_result", id: "toolu_ok", text: "ok", isError: false, parent: null, report: null }, reply("All done.")];

const lines = (events: readonly ChatEvent[]) => events.filter((e): e is Extract<ChatEvent, { k: "notice" }> => e.k === "notice" && e.id !== undefined).map((e) => e.text);
const send = (chat: string, text: string): SendFrame => {
  const r = rid();
  return { t: "send", rid: r, chat, uuid: r, text, draftRev: null, uploads: [] };
};

describe("the stop line (R15)", () => {
  test("a ledger that a crash left `running` gives the line once, under the cut turn, on every later attach; its stop goes", async () => {
    const { driver, store, procs } = world();
    store.chats.set(CHAT, ledger({ state: "running", sessionId: SID }));
    driver.transcript(SID);
    driver.histories.set(SID, cut());
    const { reg } = await life(driver, store, procs);
    for (const tab of ["tab_a", "tab_b"]) {
      const p = (await reg.attach(CHAT, new RecordingViewer(tab)))!;
      const history = p.snapshot.history;
      expect(lines(history)).toEqual([RUNNING]);
      // Under the cut turn: after its call, which history tags stopped.
      expect(history.slice(-3).map((e) => e.k)).toEqual(["tool_call", "tool_stopped", "notice"]);
      // History holds it, so the tail leaves it out: a page draws it once.
      expect(lines(p.tail.map((i) => i.e))).toEqual([]);
    }
    expect(store.chats.get(CHAT)!.stop).toBeUndefined();
    expect(store.notes.get(CHAT)!.stops).toHaveLength(1);
    expect(driver.opens).toHaveLength(0);
  });

  test("`waiting` gives the waiting line, even when the transcript's turn ended; `idle` and `sleeping` give none", async () => {
    for (const [state, want] of [["waiting", [WAITING]], ["idle", []], ["sleeping", []]] as const) {
      const { driver, store, procs } = world();
      store.chats.set(CHAT, ledger({ state, sessionId: SID }));
      driver.histories.set(SID, finished());
      const { reg } = await life(driver, store, procs);
      expect(lines((await reg.attach(CHAT, new RecordingViewer()))!.snapshot.history)).toEqual([...want]);
    }
  });

  test("a `running` chat whose last turn finished gets no line (its claude wrote the turn's end)", async () => {
    const { driver, store, procs } = world();
    store.chats.set(CHAT, ledger({ state: "running", sessionId: SID }));
    driver.histories.set(SID, finished());
    const { reg } = await life(driver, store, procs);
    expect(lines((await reg.attach(CHAT, new RecordingViewer()))!.snapshot.history)).toEqual([]);
    expect(store.chats.get(CHAT)!.stop).toBeUndefined();
  });

  test("shutdown() during a turn, and during a card, gives the line after a new boot; Restart now says restarted", async () => {
    for (const [by, card, want] of [
      ["shutdown", false, RUNNING],
      ["shutdown", true, WAITING],
      ["restart", false, "kitespan restarted during this turn. Send a message to continue."],
    ] as const) {
      const { driver, store, procs } = world();
      const { reg } = await life(driver, store, procs);
      const o = await apply(reg, { t: "new_chat", rid: rid(), project: PROJECT, uuid: rid(), text: "a long task", picks: { model: null, effort: null, mode: null }, uploads: [] });
      const chat = (o as { result: { chat: string } }).result.chat;
      const c = driver.last;
      if (card) {
        const p: PermissionCard = { kind: "permission", id: "toolu_w", toolUseId: "toolu_w", toolName: "Bash", title: null, displayName: null, description: null, reason: null, blockedPath: null, input: {}, defaultToNo: false, suppressAlwaysAllowRule: false, sessionRule: false, parent: null };
        void c.ask(p).answer;
        await settle();
        expect(reg.stateOf(chat)).toBe("waiting");
      }
      await reg.shutdown({ by });
      expect(store.chats.get(chat)!.stop).toMatchObject({ why: card ? "waiting" : "running", by });
      const next = (await life(driver, store, procs)).reg;
      expect(lines((await next.attach(chat, new RecordingViewer()))!.snapshot.history)).toEqual([want]);
    }
  });

  test("a page that is on the chat when the line is noted gets it live, and a later attach from history only", async () => {
    const { driver, store, procs } = world();
    store.chats.set(CHAT, ledger({ state: "running", sessionId: SID, proc: { pid: 4242, start: "100" } }));
    driver.histories.set(SID, cut());
    procs.live.set(4242, "100");
    const { reg } = await life(driver, store, procs);
    const v = new RecordingViewer();
    await reg.attach(CHAT, v);
    procs.live.delete(4242);
    await until(() => lines(v.events).length > 0);
    const p = (await reg.attach(CHAT, new RecordingViewer("tab_b")))!;
    expect(lines(p.snapshot.history)).toEqual([RUNNING]);
    expect(lines(p.tail.map((i) => i.e))).toEqual([]);
    const id = (v.events.find((e) => e.k === "notice") as { id: string }).id;
    expect(p.snapshot.history.find((e) => e.k === "notice")).toEqual({ k: "notice", text: RUNNING, id });
  });
});

async function until(pred: () => boolean, ms = 4_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

describe("kitespan's own orphan (R16, BUILD-BRIEF section 2 item 1)", () => {
  test("the ledger keeps the chat's claude pid and start while it runs, and forgets them when it exits", async () => {
    const { driver, store, procs } = world();
    const { reg } = await life(driver, store, procs);
    procs.live.set(5151, "777");
    const o = await apply(reg, { t: "new_chat", rid: rid(), project: PROJECT, uuid: rid(), text: "hello", picks: { model: null, effort: null, mode: null }, uploads: [] });
    const chat = (o as { result: { chat: string } }).result.chat;
    const c = driver.last;
    c.pid = 5151;
    c.emit({ k: "turn_end", ok: true, subtype: "success", durationMs: 1, error: null, uuids: [] });
    await settle();
    expect(store.chats.get(chat)!.proc).toEqual({ pid: 5151, start: "777" });
    c.end();
    await settle();
    expect(store.chats.get(chat)!.proc).toBeUndefined();
  });

  test("a pid read just before its process ended is never noted: the start is noted only while the pid still names the chat's claude", async () => {
    const { driver, store, procs } = world();
    let open!: () => void;
    const late = new Promise<void>((r) => (open = r));
    procs.startOf = async (pid) => {
      await late;
      return pid === 5252 ? "888" : null;
    };
    const { reg } = await life(driver, store, procs);
    const o = await apply(reg, { t: "new_chat", rid: rid(), project: PROJECT, uuid: rid(), text: "hello", picks: { model: null, effort: null, mode: null }, uploads: [] });
    const chat = (o as { result: { chat: string } }).result.chat;
    const c = driver.last;
    c.pid = 5252;
    c.emit({ k: "turn_end", ok: true, subtype: "success", durationMs: 1, error: null, uuids: [] });
    await settle();
    // The process ends (its pid is no longer known) before its start was read.
    c.pid = null;
    open();
    await settle();
    expect(store.chats.get(chat)!.proc).toBeUndefined();
    await reg.shutdown();
  });

  test("a live orphan holds its chat as finishing, never as another app; sends wait for it; Stop ends it with SIGTERM, then SIGKILL", async () => {
    const { driver, store, procs } = world();
    store.chats.set(CHAT, ledger({ state: "running", sessionId: SID, proc: { pid: 4242, start: "100" } }));
    driver.transcript(SID);
    driver.histories.set(SID, cut());
    // Claude Code's registry lists the orphan's own record (its parent is no longer the server).
    driver.openNow.set(SID, { app: "other", busy: true });
    procs.live.set(4242, "100");
    procs.ignoresTerm.add(4242);
    // A message that waited behind the cut turn (RD-8): after the hold it waits for the user.
    const waiting = rid();
    store.queues.set(CHAT, { v: 1, id: CHAT, msgs: [{ uuid: waiting, text: "next", userText: "next", uploads: [], mentions: [], at: "2026-10-30T08:00:00.000Z" }] });
    const { reg, deltas } = await life(driver, store, procs);
    await settle(10);
    expect(reg.list()[0]!.held).toEqual({ app: "other", session: SID, kind: "finishing" });
    // Claude Code works in that chat: the lists show it Working, and so does the chat itself.
    expect(reg.list()[0]!.state).toBe("running");
    expect((await reg.attach(CHAT, new RecordingViewer("tab_c")))!.attached.state).toBe("running");
    expect(await apply(reg, send(CHAT, "more"))).toEqual({ ok: false, code: "session_held" });
    expect(lines((await reg.attach(CHAT, new RecordingViewer()))!.snapshot.history)).toEqual([]);
    // Stop (turn 0): SIGTERM, which this one ignores, then SIGKILL after the grace, only to that pid.
    expect(await apply(reg, { t: "interrupt", rid: rid(), chat: CHAT, turn: 0 })).toEqual({ ok: true, result: { stillQueued: null } });
    await until(() => procs.kills.length === 2);
    expect(procs.kills).toEqual([
      [4242, "SIGTERM"],
      [4242, "SIGKILL"],
    ]);
    driver.openNow.delete(SID);
    await until(() => reg.list()[0]!.held === undefined);
    expect(deltas.filter((d) => "held" in d).at(-1)).toEqual({ chat: CHAT, held: null, state: "sleeping", busy: false });
    expect(reg.list()[0]!.state).toBe("sleeping");
    // The line (the turn did not finish), the restored message Not sent, and nothing started.
    const p = (await reg.attach(CHAT, new RecordingViewer("tab_b")))!;
    expect(lines(p.snapshot.history)).toEqual([RUNNING]);
    expect(p.tail.map((i) => i.e)).toContainEqual({ k: "user", uuid: waiting, text: "next", queued: true, mentions: [], notSent: true });
    expect(driver.opens).toHaveLength(0);
    expect(store.chats.get(CHAT)!.proc).toBeUndefined();
    expect(await apply(reg, { t: "interrupt", rid: rid(), chat: CHAT, turn: 0 })).toEqual({ ok: false, code: "stale" });
  });

  test("an orphan that finishes its turn by itself ends the hold with no line; a pid with another start is no orphan", async () => {
    const { driver, store, procs } = world();
    store.chats.set(CHAT, ledger({ state: "running", sessionId: SID, proc: { pid: 4242, start: "100" } }));
    driver.histories.set(SID, cut());
    procs.live.set(4242, "100");
    const { reg } = await life(driver, store, procs);
    expect(reg.list()[0]!.held?.kind).toBe("finishing");
    // It writes the turn's end, then exits.
    driver.histories.set(SID, finished());
    procs.live.delete(4242);
    await until(() => reg.list()[0]!.held === undefined);
    expect(lines((await reg.attach(CHAT, new RecordingViewer()))!.snapshot.history)).toEqual([]);
    expect(procs.kills).toEqual([]);

    const other = world();
    other.store.chats.set(CHAT, ledger({ state: "running", sessionId: SID, proc: { pid: 4242, start: "100" } }));
    other.procs.live.set(4242, "999");
    const again = (await life(other.driver, other.store, other.procs)).reg;
    expect(again.list()[0]!.held).toBeUndefined();
    expect(other.store.chats.get(CHAT)!.proc).toBeUndefined();
    expect(await apply(again, { t: "interrupt", rid: rid(), chat: CHAT, turn: 0 })).toEqual({ ok: false, code: "stale" });
    expect(other.procs.kills).toEqual([]);
  });

  test("history read during the finishing hold keeps the orphan's open call running; after a cut exit it is stopped", async () => {
    const { driver, store, procs } = world();
    store.chats.set(CHAT, ledger({ state: "running", sessionId: SID, proc: { pid: 4242, start: "100" } }));
    driver.histories.set(SID, cut());
    procs.live.set(4242, "100");
    const { reg } = await life(driver, store, procs);
    expect(reg.list()[0]!.held?.kind).toBe("finishing");
    const kinds = (events: readonly ChatEvent[]) => events.map((e) => e.k);
    expect(kinds((await reg.attach(CHAT, new RecordingViewer()))!.snapshot.history)).not.toContain("tool_stopped");
    const page = (await apply(reg, { t: "get", rid: rid(), chat: CHAT, what: "history", before: null })) as { ok: true; result: { history: ChatEvent[] } };
    expect(kinds(page.result.history)).not.toContain("tool_stopped");
    // The orphan exits with the turn cut: the call gets no result, so now it is stopped.
    procs.live.delete(4242);
    await until(() => reg.list()[0]!.held === undefined);
    expect(kinds((await reg.attach(CHAT, new RecordingViewer("tab_b")))!.snapshot.history).slice(-3)).toEqual(["tool_call", "tool_stopped", "notice"]);
  });
});

// A message that waited behind the cut turn (RD-8) while kitespan's own orphan finishes that turn: it shows Queued
// under the hold's locked box at once, a resend of it (a page whose ack the kill -9 lost) is answered as one that
// waits, so no page gives its text back to the box, and when the orphan exits the transcript's dedupe runs again: one
// that the orphan ran leaves the queue and counts as applied; the rest is Not sent, once. Claude Code gets each message
// once.
describe("a message queued behind the cut turn, while the orphan finishes it (R12 with R16)", () => {
  const U = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
  const note = { uuid: U, text: "next step", userText: "next step", uploads: [], mentions: [], at: "2026-10-30T08:00:00.000Z" };
  const resend = (): SendFrame => ({ t: "send", rid: rid(), chat: CHAT, uuid: U, text: "next step", draftRev: null, uploads: [] });
  function held() {
    const w = world();
    w.store.chats.set(CHAT, ledger({ state: "running", sessionId: SID, proc: { pid: 4242, start: "100" } }));
    w.driver.transcript(SID);
    w.driver.histories.set(SID, cut());
    w.procs.live.set(4242, "100");
    w.store.queues.set(CHAT, { v: 1, id: CHAT, msgs: [{ ...note }] });
    return w;
  }
  const usersOf = (p: { snapshot: { history: ChatEvent[] }; tail: { e: ChatEvent }[] }) =>
    [...p.snapshot.history, ...p.tail.map((i) => i.e)].filter((e): e is Extract<ChatEvent, { k: "user" }> => e.k === "user" && e.uuid === U);

  test("Queued during the hold; a resend is answered queued and gives nothing back; Not sent once after the exit; Send again gives it once", async () => {
    const { driver, store, procs } = held();
    const { reg } = await life(driver, store, procs);
    expect(reg.list()[0]!.held?.kind).toBe("finishing");
    expect(usersOf((await reg.attach(CHAT, new RecordingViewer()))!)).toEqual([{ k: "user", uuid: U, text: "next step", queued: true, mentions: [] }]);
    expect(await apply(reg, resend())).toEqual({ ok: true, result: { queued: true } });
    expect(reg.draftOf(CHAT)?.text ?? "").toBe("");
    procs.live.delete(4242);
    await until(() => reg.list()[0]!.held === undefined);
    const after = usersOf((await reg.attach(CHAT, new RecordingViewer("tab_b")))!);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ queued: true, notSent: true });
    expect(store.queues.get(CHAT)?.msgs.map((m) => m.uuid)).toEqual([U]);
    expect(driver.opens).toHaveLength(0);
    // The resend after the hold is the same message: answered, never a second copy.
    expect(await apply(reg, resend())).toEqual({ ok: true, result: { queued: true } });
    expect(await apply(reg, { t: "send_queued", rid: rid(), chat: CHAT })).toEqual({ ok: true, result: { started: true } });
    await until(() => driver.opens.length === 1 && driver.last.sent.length > 0);
    await settle();
    expect(driver.last.sent.map((m) => m.uuid)).toEqual([U]);
  });

  test("one that the orphan ran (the transcript holds it at the exit) leaves the queue, counts as applied and shows once", async () => {
    const { driver, store, procs } = held();
    const { reg } = await life(driver, store, procs);
    const live = new RecordingViewer();
    await reg.attach(CHAT, live);
    // The orphan finished the cut turn, ran the message from its own queue, and exited.
    driver.histories.set(SID, [...finished(), user("next step", U), reply("Next done.")]);
    procs.live.delete(4242);
    await until(() => reg.list()[0]!.held === undefined);
    // The page that watched it: its Queued label goes (the history it reads again holds the message).
    expect(live.of("user").filter((e) => e.uuid === U).at(-1)).toMatchObject({ queued: false });
    expect(live.of("user").some((e) => e.uuid === U && e.notSent)).toBe(false);
    const after = usersOf((await reg.attach(CHAT, new RecordingViewer("tab_b")))!);
    expect(after).toEqual([{ k: "user", uuid: U, text: "next step", queued: false }]);
    await settle();
    expect(store.queues.get(CHAT)).toBeUndefined();
    expect(store.chats.get(CHAT)!.applied).toContain(U);
    expect(await apply(reg, resend())).toEqual({ ok: true, result: { queued: false } });
    await settle();
    expect(driver.opens).toHaveLength(0);
  });
});

// DESIGN 6.10 (D49, one process per session): while kitespan's own orphan still writes the session, Open in terminal
// types the fork command, never the plain one (the shell asks the registry whether a process of the chat lives).
describe("Open in terminal during a finishing hold", () => {
  test("the orphan counts as the chat's live process: the pane types --fork-session until it exits", async () => {
    const { driver, store, procs } = world();
    store.chats.set(CHAT, ledger({ state: "running", sessionId: SID, proc: { pid: 4242, start: "100" } }));
    driver.histories.set(SID, cut());
    procs.live.set(4242, "100");
    const { reg } = await life(driver, store, procs);
    expect(reg.list()[0]!.held?.kind).toBe("finishing");
    const typed = () => resumeCommand({ cwd: "/srv/work/app", sessionId: SID, processOpen: reg.processLives(CHAT) });
    expect(typed()).toEqual({ case: "fork", command: `cd /srv/work/app && claude --resume ${SID} --fork-session` });
    procs.live.delete(4242);
    await until(() => reg.list()[0]!.held === undefined);
    expect(typed().case).toBe("plain");
  });
});

// R11 for a chat held as finishing: a message leaves at Archive (its text goes back to the draft), and Archive needs
// Stop and archive, which ends the orphan as Stop does; the orphan's exit restores nothing into the archived chat.
describe("Archive of a chat held as finishing", () => {
  test("Archive alone is refused; Stop and archive ends the orphan, takes what waits back to the draft, and the exit restores nothing", async () => {
    const { driver, store, procs } = world();
    store.chats.set(CHAT, ledger({ state: "running", sessionId: SID, proc: { pid: 4242, start: "100" } }));
    driver.histories.set(SID, cut());
    procs.live.set(4242, "100");
    const U = rid();
    store.queues.set(CHAT, { v: 1, id: CHAT, msgs: [{ uuid: U, text: "next step", userText: "next step", uploads: [], mentions: [], at: "2026-10-30T08:00:00.000Z" }] });
    const { reg } = await life(driver, store, procs);
    expect(reg.list()[0]!.busy).toBe(true);
    expect(await apply(reg, { t: "archive", rid: rid(), chat: CHAT, on: true, stop: false })).toEqual({ ok: false, code: "busy" });
    expect(await apply(reg, { t: "archive", rid: rid(), chat: CHAT, on: true, stop: true })).toEqual({ ok: true, result: null });
    await until(() => procs.kills.length > 0);
    expect(procs.kills[0]).toEqual([4242, "SIGTERM"]);
    await settle();
    expect(reg.draftOf(CHAT)?.text).toBe("next step");
    expect(store.queues.get(CHAT)).toBeUndefined();
    await until(() => !reg.processLives(CHAT));
    await settle();
    const p = (await reg.attach(CHAT, new RecordingViewer("tab_b")))!;
    expect(p.tail.map((i) => i.e).filter((e) => e.k === "user" && e.uuid === U && e.notSent)).toEqual([]);
    expect(store.queues.get(CHAT)).toBeUndefined();
    expect(reg.list()[0]).toMatchObject({ archived: true, state: "sleeping", busy: false });
    expect(driver.opens).toHaveLength(0);
  });

  test("Delete of a chat held as finishing ends the orphan first, so no process writes the session after its transcript went", async () => {
    const { driver, store, procs } = world();
    store.chats.set(CHAT, ledger({ state: "running", sessionId: SID, proc: { pid: 4242, start: "100" } }));
    driver.transcript(SID);
    driver.histories.set(SID, cut());
    procs.live.set(4242, "100");
    const { reg } = await life(driver, store, procs);
    let aliveAtDelete = null as boolean | null;
    const del = driver.deleteSession.bind(driver);
    driver.deleteSession = async (sid: string, cwd: string) => {
      aliveAtDelete = procs.live.has(4242);
      return del(sid, cwd);
    };
    expect(await apply(reg, { t: "delete", rid: rid(), chat: CHAT })).toEqual({ ok: true, result: null });
    expect(procs.kills[0]).toEqual([4242, "SIGTERM"]);
    expect(aliveAtDelete).toBe(false);
    expect(driver.deletedSessions).toEqual([SID]);
  });

  test("an archived chat whose queue file still holds a message (a kill -9 before its write): boot takes it back to the draft", async () => {
    const { driver, store, procs } = world();
    store.chats.set(CHAT, ledger({ sessionId: SID, archivedAt: "2026-10-30T09:00:00.000Z" }));
    driver.histories.set(SID, finished());
    store.queues.set(CHAT, { v: 1, id: CHAT, msgs: [{ uuid: rid(), text: "left over", userText: "left over", uploads: [], mentions: [], at: "2026-10-30T08:00:00.000Z" }] });
    const { reg } = await life(driver, store, procs);
    await settle();
    expect(reg.draftOf(CHAT)?.text).toBe("left over");
    expect(store.queues.get(CHAT)).toBeUndefined();
    expect((await reg.attach(CHAT, new RecordingViewer()))!.tail.some((i) => i.e.k === "user")).toBe(false);
  });
});

// DESIGN 4.10 (one line for a cut turn): Restart now's stop line says what happened, so the turn it cut shows no
// Interrupted row (live and in history), and the card it closed leaves no Denied record: the card went with its
// process. A Stop the user pressed still ends its turn as Interrupted.
describe("one mark for a turn that Restart now cut", () => {
  const PERMISSION: PermissionCard = { kind: "permission", id: "toolu_w", toolUseId: "toolu_w", toolName: "Bash", title: null, displayName: null, description: null, reason: null, blockedPath: null, input: {}, defaultToNo: false, suppressAlwaysAllowRule: false, sessionRule: false, parent: null };

  test("live: the cut turn ends with no Interrupted, and the cut card closes as lost (no record); a Stop still says Interrupted", async () => {
    const { driver, store, procs } = world();
    const { reg } = await life(driver, store, procs);
    const newChat = async (text: string) => {
      const o = await apply(reg, { t: "new_chat", rid: rid(), project: PROJECT, uuid: rid(), text, picks: { model: null, effort: null, mode: null }, uploads: [] });
      const chat = (o as { result: { chat: string } }).result.chat;
      const c = driver.last;
      // Claude Code ends the interrupted turn with an error result, as it does.
      c.interrupt = async () => {
        c.calls.push("interrupt");
        c.emit({ k: "turn_end", ok: false, subtype: "error_during_execution", durationMs: 1, error: "aborted", uuids: [] });
        return { stillQueued: null };
      };
      c.emit({ k: "session", sessionId: c.input.sessionId!.value, model: "claude-haiku-5-5", mode: "default", version: "2.1.317", bypass: false });
      await settle();
      const v = new RecordingViewer();
      const turn = (await reg.attach(chat, v))!.tail.find((i) => i.e.k === "turn_start")!.seq;
      return { chat, c, v, turn };
    };
    const stopped = await newChat("stop me");
    const a = await newChat("a long task");
    const b = await newChat("ask me");
    void b.c.ask(PERMISSION).answer;
    await settle();
    // The user's own Stop first: Interrupted, as before.
    expect(reg.stateOf(stopped.chat)).toBe("running");
    expect((await apply(reg, { t: "interrupt", rid: rid(), chat: stopped.chat, turn: stopped.turn })).ok).toBe(true);
    await settle();
    expect(stopped.v.of("turn_end").at(-1)).toMatchObject({ subtype: TURN_INTERRUPTED });
    await reg.shutdown({ by: "restart", interrupt: true });
    expect(a.v.of("turn_end").at(-1)).toMatchObject({ ok: false, subtype: TURN_CUT, error: null });
    expect(b.v.of("card_close")).toEqual([expect.objectContaining({ id: "toolu_w", why: "lost" })]);
    expect(store.notes.get(b.chat)!.cards.map((n) => n.close.why)).toEqual(["lost"]);
  });

  test("history: the Interrupted end that Claude Code wrote for the cut turn gives way to the stop line under it", async () => {
    const { driver, store, procs } = world();
    store.chats.set(CHAT, ledger({ state: "sleeping", sessionId: SID, stop: { why: "running", by: "restart", at: "2026-10-30T08:00:00.000Z" } }));
    driver.transcript(SID);
    const interrupted: ChatEvent = { k: "turn_end", ok: false, subtype: TURN_INTERRUPTED, durationMs: 0, error: null, uuids: [] };
    // An earlier turn that the user stopped keeps its Interrupted end.
    driver.histories.set(SID, [user("first"), call("toolu_a"), { k: "tool_stopped", id: "toolu_a", parent: null }, { ...interrupted }, user("run the long one"), call("toolu_cut"), { k: "tool_stopped", id: "toolu_cut", parent: null }, { ...interrupted }]);
    const { reg } = await life(driver, store, procs);
    const h = (await reg.attach(CHAT, new RecordingViewer()))!.snapshot.history;
    expect(h.filter((e) => e.k === "turn_end").map((e) => (e as { subtype: string }).subtype)).toEqual([TURN_INTERRUPTED, TURN_CUT]);
    expect(h.slice(-2).map((e) => e.k)).toEqual(["turn_end", "notice"]);
    expect(lines(h)).toEqual(["kitespan restarted during this turn. Send a message to continue."]);
  });
});

// The system's own table (stops.ts systemProcs): with /proc, the start in ticks counts from the boot, so a start names
// a process only with the boot's id; a ledger kept across a power loss never names a process of the new boot.
const BOOT_ID = "/proc/sys/kernel/random/boot_id";
describe.if(existsSync(BOOT_ID))(`the system's process table: a start names its boot (R16) ${LINUX_ONLY}`, () => {
  // Bun runs a skipped block's body too (to name its tests), so the id is read only where it exists.
  const boot = existsSync(BOOT_ID) ? readFileSync(BOOT_ID, "utf8").trim() : "";

  test("a start is the ticks and this boot's id; the store keeps it as read", async () => {
    const start = (await systemProcs.startOf(process.pid))!;
    expect(start).toMatch(/^[0-9]{1,20}@/);
    expect(start.slice(start.indexOf("@") + 1)).toBe(boot);
    expect(await procLives(systemProcs, { pid: process.pid, start })).toBe(true);
    expect(ledgerProcOf({ pid: process.pid, start })).toEqual({ pid: process.pid, start });
  });

  test("the same pid and ticks of another boot, or the ticks alone, never name this process", async () => {
    const start = (await systemProcs.startOf(process.pid))!;
    const ticks = start.slice(0, start.indexOf("@"));
    const other = boot.replace(/^./, (ch) => (ch === "0" ? "1" : "0"));
    expect(await procLives(systemProcs, { pid: process.pid, start: `${ticks}@${other}` })).toBe(false);
    expect(await procLives(systemProcs, { pid: process.pid, start: ticks })).toBe(false);
  });
});
