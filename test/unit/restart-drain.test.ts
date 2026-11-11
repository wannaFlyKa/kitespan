// The restart's own steps around the registry (DESIGN.md 4.10 steps 3 to 7; build checklist S9, S11, S13, L12, L14),
// with the real registry over the scripted driver and a host double that records each step: the drain notice to every
// page, with Cancel restart and Restart now, kept for a page that says hello later; the close once every chat sleeps
// (or at once for Restart now), whose notice takes the drain notice's id with "Restarting kitespan..." and no buttons
// (only Cancel restart takes the notice away): every ledger, draft and note written, no claude child left (SIGKILL
// after the wait), every pane's shell ended; then the successor, `bye`, the release and the health gate on a new
// epoch. An ask during that close is that restart. A gate that fails stops the successor, listens again and undoes the
// drain, and a successor that cannot start changes nothing that a page sees but the drain's end. SIGTERM or SIGINT
// (halt) during the close is a shutdown: no successor outlives it, and nothing listens again.
import { describe, expect, test } from "bun:test";
import { RESTART_FAILED_NOTICE, type ChatEvent, type NoticeFrame } from "../../shared/protocol";
import { CLOSE_LINE, DRAIN_LINE, DRAIN_NOTICE_ID, RESTART_FAILED_LINE, Restart, ensureGone, healthGate, type RestartHost, type RestartLimits } from "../../server/chats/drain";
import { ChatRegistry } from "../../server/chats/registry";
import type { ProcTable } from "../../server/chats/stops";
import { FakeBash, FakeDriver, MemoryStore, RecordingViewer, apply, projectRecord, settle } from "../../server/chats/testing";
import type { Outcome } from "../../server/chats/types";
import type { Successor } from "../../server/update/successor";

const PROJECT = "k3m7q2x4ab";
const CWD = "/srv/work/app";
/** The close's notice: the drain notice's id, its own line, no buttons. */
const CLOSING = { text: CLOSE_LINE, id: DRAIN_NOTICE_ID };
const rid = () => crypto.randomUUID();

class Procs implements ProcTable {
  readonly live = new Map<number, string>();
  readonly kills: [number, string][] = [];
  /** Pids that a SIGTERM does not end. */
  readonly stubborn = new Set<number>();
  async startOf(pid: number): Promise<string | null> {
    return this.live.get(pid) ?? null;
  }
  sameStart(a: string, b: string): boolean {
    return a === b;
  }
  kill(pid: number, signal: "SIGTERM" | "SIGKILL"): boolean {
    this.kills.push([pid, signal]);
    if (signal === "SIGKILL" || !this.stubborn.has(pid)) this.live.delete(pid);
    return true;
  }
}

interface Script {
  steps: string[];
  notices: Omit<NoticeFrame, "t">[];
  /** The epochs the health route answers, one per read (the last repeats); null: nothing answers. */
  health: (string | null)[];
  exit: number | null;
  spawnThrows: boolean;
  successor: { killed: boolean; exit: (code: number) => void } | null;
  /** The pids that still lived when the successor was spawned. */
  aliveAtSpawn: number[] | null;
  /** How long the end of the panes' shells takes (a window inside the close). */
  shellsMs: number;
  /** How long listening again takes (a window inside a failed restart's way back). */
  relistenMs: number;
  limits: Partial<RestartLimits>;
  /** Row 108: an update runs when the close reaches the successor's start (bin/update.sh, which holds the lock). */
  updating: boolean;
}

async function setup(script: Partial<Script> = {}, before?: (w: { driver: FakeDriver; store: MemoryStore; procs: Procs }) => void) {
  const driver = new FakeDriver();
  const store = new MemoryStore();
  store.projects = [projectRecord(PROJECT, CWD)];
  const procs = new Procs();
  before?.({ driver, store, procs });
  const reg = new ChatRegistry({ driver, store, bash: new FakeBash(), procs, orphanGraceMs: 60 }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 300, openCheckMs: 15, openFastMs: 15 });
  await reg.boot();
  const s: Script = { steps: [], notices: [], health: [null], exit: null, spawnThrows: false, successor: null, aliveAtSpawn: null, shellsMs: 0, relistenMs: 0, limits: {}, updating: false, ...script };
  let reads = 0;
  const host: RestartHost = {
    registry: reg,
    notice: (text, chat, more) => {
      s.steps.push(`notice${more?.gone ? " gone" : ""}`);
      s.notices.push({ text, ...(chat ? { chat } : {}), ...more });
    },
    bye: (reason) => void s.steps.push(`bye ${reason}`),
    closeShells: async () => {
      s.steps.push("shells");
      await Bun.sleep(s.shellsMs);
    },
    updates: { stop: () => void s.steps.push("updates stop"), start: () => void s.steps.push("updates start") },
    spawn: (): Successor => {
      s.steps.push("spawn");
      s.aliveAtSpawn = [...procs.live.keys()];
      if (s.spawnThrows) throw new Error("no successor");
      let exit!: (code: number) => void;
      const exited = new Promise<number>((r) => (exit = r));
      const own = { killed: false, exit };
      s.successor = own;
      return {
        pid: 31337,
        exited,
        kill: () => {
          s.steps.push("kill successor");
          own.killed = true;
          exit(137);
        },
      };
    },
    release: async () => void s.steps.push("release"),
    relisten: async () => {
      s.steps.push("relisten");
      await Bun.sleep(s.relistenMs);
    },
    // "OWN" stands for this server's own epoch (a read in the retry window that the old server answered).
    health: async () => {
      const e = s.health[Math.min(reads++, s.health.length - 1)] ?? null;
      return e === "OWN" ? reg.epoch : e;
    },
    done: (succ) => void s.steps.push(`done ${succ.pid}`),
    failed: () => void s.steps.push("failed"),
    updating: async () => s.updating,
    procs,
    limits: { childMs: 120, healthEveryMs: 5, healthPollMs: 20, healthMs: 300, releaseAfterMs: 0, ...s.limits },
  };
  const restart = new Restart(host);
  return { driver, store, procs, reg, restart, s };
}

const newChat = (text: string) => ({ t: "new_chat" as const, rid: rid(), project: PROJECT, uuid: rid(), text, picks: { model: null, effort: null, mode: null }, uploads: [] });
const send = (chat: string, text: string) => {
  const r = rid();
  return { t: "send" as const, rid: r, chat, uuid: r, text, draftRev: null, uploads: [] };
};
const chatOf = (o: Outcome) => (o.ok ? (o.result as { chat: string }).chat : "");
const turnEnd = (uuid: string): ChatEvent => ({ k: "turn_end", ok: true, subtype: "success", durationMs: 5, error: null, uuids: [uuid] });
async function until(pred: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
}

async function runningChat(reg: ChatRegistry, driver: FakeDriver) {
  const frame = newChat("a long task");
  const chat = chatOf(await apply(reg, frame));
  const fake = driver.last;
  fake.emit({ k: "session", sessionId: fake.input.sessionId!.value, model: "claude-haiku-5-5", mode: "default", version: "2.1.317", bypass: false });
  await settle();
  return { chat, fake, first: frame.uuid };
}

describe("Restart when they finish (S9, S13)", () => {
  test("the notice with Cancel restart and Restart now, kept for a later page; the close at the turn's end; then the successor, bye, the release and the gate", async () => {
    const { reg, driver, restart, s } = await setup({ health: [null, "OWN", "a-new-epoch"] });
    const a = await runningChat(reg, driver);
    expect(restart.ask("finish")).toEqual({ ok: true });
    expect(s.notices).toEqual([{ text: DRAIN_LINE, id: DRAIN_NOTICE_ID, actions: ["cancel_restart", "restart_now"] }]);
    expect(DRAIN_LINE).toBe("kitespan restarts when the running turns end.");
    expect(restart.standing()).toEqual([{ text: DRAIN_LINE, id: DRAIN_NOTICE_ID, actions: ["cancel_restart", "restart_now"] }]);
    // A second ask while it waits sends nothing more.
    expect(restart.ask("finish")).toEqual({ ok: true });
    expect(s.notices).toHaveLength(1);
    await Bun.sleep(40);
    expect(s.steps).toEqual(["notice"]);
    a.fake.emit(turnEnd(a.first));
    await until(() => s.steps.some((x) => x.startsWith("done")));
    expect(s.steps).toEqual(["notice", "notice", "updates stop", "shells", "spawn", "bye restart", "release", "done 31337"]);
    // The close replaces the drain notice: "Restarting kitespan..." with no buttons, never `gone` (that is Cancel's).
    expect(s.notices[1]).toEqual(CLOSING);
    expect(CLOSE_LINE).toBe("Restarting kitespan...");
    expect(a.fake.closed).toBe(true);
    expect(a.fake.calls).not.toContain("interrupt");
    // A page that says hello during the close gets it too.
    expect(restart.standing()).toEqual([CLOSING]);
    // Once the close runs, a new ask is that restart (its page sees it done, never refused), and Cancel is refused.
    expect(restart.closing).toBe(true);
    expect(restart.ask("now")).toEqual({ ok: true });
    expect(restart.ask("finish")).toEqual({ ok: true });
    expect(restart.cancel()).toBe(false);
    expect(s.steps.filter((x) => x === "spawn")).toHaveLength(1);
  });

  test("Restart now pressed while the drain waits, whose preflight ends after the last turn's end started the close: accepted", async () => {
    const { reg, driver, restart, s } = await setup({ health: ["a-new-epoch"], shellsMs: 40 });
    const a = await runningChat(reg, driver);
    restart.ask("finish");
    a.fake.emit(turnEnd(a.first));
    await until(() => s.steps.includes("shells"));
    expect(restart.ask("now")).toEqual({ ok: true });
    await until(() => s.steps.some((x) => x.startsWith("done")));
    expect(s.steps.filter((x) => x === "spawn")).toHaveLength(1);
  });

  test("with nothing to wait for, the close runs at once: no drain notice, only the close's", async () => {
    const { restart, s } = await setup({ health: ["a-new-epoch"] });
    expect(restart.ask("finish")).toEqual({ ok: true });
    await until(() => s.steps.some((x) => x.startsWith("done")));
    expect(s.notices).toEqual([CLOSING]);
    expect(s.steps).toEqual(["notice", "updates stop", "shells", "spawn", "bye restart", "release", "done 31337"]);
  });

  test("Cancel restart: the notice goes, sends work again, and a later ask can start", async () => {
    const { reg, driver, restart, s } = await setup();
    const a = await runningChat(reg, driver);
    restart.ask("finish");
    const held = send(a.chat, "held");
    expect(await apply(reg, held)).toEqual({ ok: true, result: { queued: true } });
    expect(restart.cancel()).toBe(true);
    expect(restart.cancel()).toBe(false);
    expect(s.notices.at(-1)).toEqual({ text: "", id: DRAIN_NOTICE_ID, gone: true });
    expect(restart.standing()).toEqual([]);
    await until(() => a.fake.sent.some((m) => m.uuid === held.uuid));
    expect(s.steps).toEqual(["notice", "notice gone"]);
    a.fake.emit(turnEnd(a.first));
    await settle();
    expect(s.steps).toEqual(["notice", "notice gone"]);
    expect(restart.ask("finish")).toEqual({ ok: true });
    expect(restart.cancel()).toBe(true);
    await reg.shutdown();
  });

  test("Restart now while it waits: the running turn is interrupted and the close follows", async () => {
    const { reg, driver, restart, s, store } = await setup({ health: ["a-new-epoch"] });
    const a = await runningChat(reg, driver);
    restart.ask("finish");
    expect(restart.ask("now")).toEqual({ ok: true });
    await until(() => s.steps.some((x) => x.startsWith("done")));
    expect(a.fake.calls).toContain("interrupt");
    expect(store.chats.get(a.chat)?.stop).toMatchObject({ why: "running", by: "restart" });
    expect(s.steps).toEqual(["notice", "notice", "updates stop", "shells", "spawn", "bye restart", "release", "done 31337"]);
    expect(s.notices.at(-1)).toEqual(CLOSING);
  });
});

describe("a shutdown while the drain waits", () => {
  test("SIGTERM's halt: the turn's end starts no close, and no restart can start", async () => {
    const { reg, driver, restart, s } = await setup({ health: ["a-new-epoch"] });
    const a = await runningChat(reg, driver);
    restart.ask("finish");
    restart.halt();
    await reg.shutdown();
    a.fake.emit(turnEnd(a.first));
    await Bun.sleep(60);
    expect(s.steps).toEqual(["notice"]);
    expect(restart.ask("finish")).toEqual({ ok: false, code: "restarting" });
    expect(restart.cancel()).toBe(false);
    // A shutdown is no restart: a page that says hello now gets neither line.
    expect(restart.standing()).toEqual([]);
  });
});

// DESIGN 4.10's Signals: SIGTERM and SIGINT are a shutdown, not a restart, also when they come during the close; the
// server's own stop() then ends this process, so no successor may outlive it and nothing listens again.
describe("a shutdown during the restart's close", () => {
  const after = ["spawn", "bye restart", "release", "failed", "relisten", "updates start"];

  test("SIGTERM's halt while the close ends the panes' shells: no successor, no bye, no relisten", async () => {
    const { reg, restart, s } = await setup({ health: ["a-new-epoch"], shellsMs: 60 });
    expect(restart.ask("now")).toEqual({ ok: true });
    await until(() => s.steps.includes("shells"));
    restart.halt();
    await Bun.sleep(150);
    expect(s.steps).toEqual(["notice", "updates stop", "shells"]);
    for (const x of after) expect(s.steps).not.toContain(x);
    // A shutdown's close is no restart: an ask is refused.
    expect(restart.closing).toBe(false);
    expect(restart.ask("now")).toEqual({ ok: false, code: "restarting" });
    expect(restart.standing()).toEqual([]);
    await reg.shutdown();
  });

  test("SIGTERM's halt between the successor's start and the bye: the successor is stopped at once", async () => {
    const { restart, s } = await setup({ health: ["a-new-epoch"], limits: { releaseAfterMs: 60 } });
    restart.ask("now");
    await until(() => s.steps.includes("spawn"));
    restart.halt();
    expect(s.successor!.killed).toBe(true);
    await Bun.sleep(150);
    expect(s.steps).toEqual(["notice", "updates stop", "shells", "spawn", "kill successor"]);
  });

  test("SIGTERM's halt during the health gate: the successor is stopped at once; no done, and nothing listens again", async () => {
    const { restart, s } = await setup({ health: [null] });
    restart.ask("now");
    await until(() => s.steps.includes("release"));
    restart.halt();
    expect(s.successor!.killed).toBe(true);
    await Bun.sleep(400);
    expect(s.steps).toEqual(["notice", "updates stop", "shells", "spawn", "bye restart", "release", "kill successor"]);
    expect(s.notices).toEqual([CLOSING]);
  });

  test("a halt after the gate passed leaves the successor running: it is the new kitespan", async () => {
    const { restart, s } = await setup({ health: ["a-new-epoch"] });
    restart.ask("now");
    await until(() => s.steps.some((x) => x.startsWith("done")));
    restart.halt();
    expect(s.successor!.killed).toBe(false);
  });
});

describe("a restart that did not happen (S13)", () => {
  test("the successor exits: it is stopped, the server listens again, the drain is undone and the held messages go", async () => {
    const { reg, driver, restart, s } = await setup({ health: [null] });
    const a = await runningChat(reg, driver);
    restart.ask("finish");
    const held = send(a.chat, "held by the drain");
    await apply(reg, held);
    a.fake.emit(turnEnd(a.first));
    await until(() => s.steps.includes("release"));
    s.successor!.exit(1);
    await until(() => s.steps.includes("updates start"));
    expect(s.steps.slice(-6)).toEqual(["release", "kill successor", "failed", "relisten", "notice", "updates start"]);
    expect(s.notices.at(-1)).toEqual({ text: RESTART_FAILED_LINE, id: RESTART_FAILED_NOTICE });
    // The close's line no longer stands; the failure's does, so a page that slept through it (its ask accepted, no
    // `bye` seen) learns it from its hello, until the next ask.
    expect(restart.standing()).toEqual([{ text: RESTART_FAILED_LINE, id: RESTART_FAILED_NOTICE }]);
    expect(s.steps.some((x) => x.startsWith("done"))).toBe(false);
    // The registry takes work again: the held message starts its chat again.
    await until(() => driver.opens.length === 2);
    await until(() => driver.last.sent.some((m) => m.uuid === held.uuid));
    expect((await apply(reg, newChat("works again"))).ok).toBe(true);
    // And a new restart can be asked: its drain notice stands in the failure's place, and after Cancel neither does.
    expect(restart.ask("finish")).toEqual({ ok: true });
    expect(restart.standing()).toEqual([{ text: DRAIN_LINE, id: DRAIN_NOTICE_ID, actions: ["cancel_restart", "restart_now"] }]);
    restart.cancel();
    expect(restart.standing()).toEqual([]);
    await reg.shutdown();
  });

  test("a gate that never sees a new epoch stops the successor after its time", async () => {
    const { reg, restart, s } = await setup({ health: [null, "OWN"] });
    restart.ask("now");
    // The old server's own epoch answers too (a retry window): it never counts. The notice and the update timer
    // come after the relisten, so wait for the last step before reading the list.
    await until(() => s.steps.includes("updates start"));
    expect(s.successor!.killed).toBe(true);
    expect(s.steps).toEqual(["notice", "updates stop", "shells", "spawn", "bye restart", "release", "kill successor", "failed", "relisten", "notice", "updates start"]);
    // A shutdown is no restart: after its halt the failure's line no longer stands either.
    expect(restart.standing()).toEqual([{ text: RESTART_FAILED_LINE, id: RESTART_FAILED_NOTICE }]);
    restart.halt();
    expect(restart.standing()).toEqual([]);
    await reg.shutdown();
  });

  test("an ask while the failed restart goes back to work is refused, never taken as that restart; then a new one starts", async () => {
    const { reg, restart, s } = await setup({ health: [null], relistenMs: 80 });
    restart.ask("now");
    await until(() => s.steps.includes("relisten"));
    // The close is over: an ask now would get its 202 with nothing left to restart it.
    expect(restart.closing).toBe(false);
    expect(restart.ask("finish")).toEqual({ ok: false, code: "restarting" });
    await until(() => s.steps.includes("updates start"));
    expect(s.steps.filter((x) => x === "spawn")).toHaveLength(1);
    expect(restart.ask("finish")).toEqual({ ok: true });
    await until(() => s.steps.filter((x) => x === "spawn").length === 2);
    await reg.shutdown();
  });

  test("a successor that cannot start: no bye, no release; every page is told; the drain is undone", async () => {
    const { reg, restart, s } = await setup({ spawnThrows: true });
    restart.ask("now");
    await until(() => s.steps.includes("updates start"));
    expect(s.steps).toEqual(["notice", "updates stop", "shells", "spawn", "failed", "notice", "updates start"]);
    // The pages never got `bye`, so this notice is what ends the page's ask (not done, Restart again) and its
    // Restarting line, which the close's notice started.
    expect(s.notices).toEqual([CLOSING, { text: RESTART_FAILED_LINE, id: RESTART_FAILED_NOTICE }]);
    expect(restart.standing()).toEqual([{ text: RESTART_FAILED_LINE, id: RESTART_FAILED_NOTICE }]);
    expect(RESTART_FAILED_LINE).toBe("kitespan did not restart. Its lines are in server-out.log.");
    // The next ask's close stands in its place.
    expect(restart.ask("finish")).toEqual({ ok: true });
    expect(restart.standing()).toEqual([CLOSING]);
    await reg.shutdown();
  });

  test("an update that began during the close (bin/update.sh): no successor on a half-updated checkout; every page is told", async () => {
    const { reg, restart, s } = await setup({ updating: true });
    restart.ask("now");
    await until(() => s.steps.includes("updates start"));
    expect(s.steps).toEqual(["notice", "updates stop", "shells", "failed", "notice", "updates start"]);
    expect(s.notices).toEqual([CLOSING, { text: RESTART_FAILED_LINE, id: RESTART_FAILED_NOTICE }]);
    await reg.shutdown();
  });

  test("Restart now that did not happen: the cut turn's and the cut card's lines say what happened, never that kitespan restarted", async () => {
    const { reg, driver, restart, s } = await setup({ health: [null] });
    const a = await runningChat(reg, driver);
    const b = await runningChat(reg, driver);
    void b.fake.ask({ kind: "permission", id: "toolu_w", toolUseId: "toolu_w", toolName: "Bash", title: null, displayName: null, description: null, reason: null, blockedPath: null, input: {}, defaultToNo: false, suppressAlwaysAllowRule: false, sessionRule: false, parent: null }).answer;
    await settle();
    const va = new RecordingViewer();
    const vb = new RecordingViewer();
    await reg.attach(a.chat, va);
    await reg.attach(b.chat, vb);
    restart.ask("now");
    await until(() => s.steps.includes("updates start"));
    const lines = (v: RecordingViewer) => v.of("notice").filter((n) => n.id !== undefined).map((n) => n.text);
    await until(() => lines(va).length > 0 && lines(vb).length > 0);
    expect(lines(va)).toEqual(["The restart stopped this turn, but kitespan did not restart. Send a message to continue."]);
    expect(lines(vb)).toEqual(["This chat was waiting for your answer when the restart stopped it, but kitespan did not restart. Send a message to continue."]);
    await reg.shutdown();
  });
});

describe("the close's check of the claude children (S11)", () => {
  test("one that is still there after the wait gets SIGKILL; one that went in time gets none", async () => {
    const procs = new Procs();
    procs.live.set(100, "a");
    procs.live.set(200, "b");
    procs.stubborn.add(200);
    setTimeout(() => procs.live.delete(100), 20);
    const t0 = Date.now();
    expect(await ensureGone(procs, [{ pid: 100, start: "a" }, { pid: 200, start: "b" }], 100)).toBe(1);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(90);
    expect(procs.kills).toEqual([[200, "SIGKILL"]]);
    expect(procs.live.size).toBe(0);
  });

  test("a pid that the system gave to another process (another start) is never killed", async () => {
    const procs = new Procs();
    procs.live.set(300, "new");
    expect(await ensureGone(procs, [{ pid: 300, start: "old" }], 50)).toBe(0);
    expect(procs.kills).toEqual([]);
  });

  test("the close kills a chat's claude that outlived its close, before the successor", async () => {
    const { reg, driver, procs, restart, s } = await setup({ health: ["a-new-epoch"] });
    procs.live.set(4321, "1700");
    procs.stubborn.add(4321);
    const a = await runningChat(reg, driver);
    a.fake.pid = 4321;
    a.fake.emit(turnEnd(a.first));
    await until(() => (reg.list().find((r) => r.chat === a.chat)?.state ?? "") === "idle");
    restart.ask("finish");
    await until(() => s.steps.some((x) => x.startsWith("done")));
    expect(procs.kills).toEqual([[4321, "SIGKILL"]]);
    expect(s.aliveAtSpawn).toEqual([]);
  });
});

describe("the health gate (S13)", () => {
  test("a new epoch passes; the old one never does; an exit ends it at once", async () => {
    const lim = { healthEveryMs: 5, healthPollMs: 20, healthMs: 200 };
    const never = new Promise<number>(() => {});
    let n = 0;
    expect(await healthGate(async () => (n++ < 3 ? "old" : "new"), "old", never, lim)).toBe(true);
    const t0 = Date.now();
    expect(await healthGate(async () => "old", "old", never, lim)).toBe(false);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(190);
    const t1 = Date.now();
    expect(await healthGate(async () => null, "old", Promise.resolve(1), lim)).toBe(false);
    expect(Date.now() - t1).toBeLessThan(100);
  });
});

// kitespan's own orphan (R16) is a running turn for the restart too: the dialog lists it (its row is running), so
// Restart when they finish waits for it, and Restart now ends it as Stop does, with Restart now's line.
describe("kitespan's own orphan and the restart (R16 with S9, S10)", () => {
  const ORPHAN = "q2x4abk3m7q2x4abk3m7";
  const SID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
  const orphan = ({ driver, store, procs }: { driver: FakeDriver; store: MemoryStore; procs: Procs }) => {
    const at = "2026-10-30T08:00:00.000Z";
    store.chats.set(ORPHAN, { v: 1, id: ORPHAN, project: PROJECT, cwd: CWD, agent: "claude-code", sessionId: SID, title: { text: "Long task", from: "first-prompt" }, picks: { model: null, effort: null, permissionMode: null }, createdAt: at, seenAt: at, lastActivityAt: at, lastSeq: 4, state: "running", lastExit: null, archivedAt: null, proc: { pid: 4242, start: "100" } });
    driver.transcript(SID);
    driver.histories.set(SID, [{ k: "user", uuid: rid(), text: "run the long one", queued: false }, { k: "tool_call", id: "toolu_cut", name: "Bash", input: { command: "sleep 20" }, parent: null }]);
    procs.live.set(4242, "100");
  };

  test("Restart when they finish waits for the orphan's turn; its exit lets the close run", async () => {
    const { reg, restart, s, procs } = await setup({ health: ["a-new-epoch"] }, orphan);
    expect(reg.list().find((r) => r.chat === ORPHAN)).toMatchObject({ state: "running", held: { kind: "finishing" } });
    expect(restart.ask("finish")).toEqual({ ok: true });
    await Bun.sleep(80);
    expect(s.steps).toEqual(["notice"]);
    procs.live.delete(4242);
    await until(() => s.steps.some((x) => x.startsWith("done")));
    expect(procs.kills).toEqual([]);
  });

  test("Restart now ends it as Stop does (SIGTERM to that pid, which had that start), before the successor; its line says restarted", async () => {
    const { restart, s, procs, store } = await setup({ health: ["a-new-epoch"] }, orphan);
    restart.ask("now");
    await until(() => s.steps.some((x) => x.startsWith("done")));
    expect(procs.kills[0]).toEqual([4242, "SIGTERM"]);
    expect(s.aliveAtSpawn).toEqual([]);
    expect(store.chats.get(ORPHAN)!.stop).toMatchObject({ why: "running", by: "restart" });
  });
});
