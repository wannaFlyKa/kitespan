// Row 81 (FIX-W19f): Claude Code's model list for every picker. The server keeps the last list on disk (with the
// project whose chat or read gave it, projects.json; the newest one kept answers for every project) and updates it from
// every live chat's read. When none is kept, or the newest is over 24 h old, one short read goes through the agent
// seam (the idle query of D59's command read, `supportedModels`: no model turn, not a chat, one at a time, 20 s at
// most), and shares D59's process when a project needs both. A sleeping or held chat's `get models`, the new-chat
// form and the project page (GET /api/projects/:project/models) answer from it, so a model always shows by its name.
// The scripted driver stands in for Claude Code in the registry and the route; the driver's read runs through the real
// Agent SDK and the fake CLI. The real claude never runs.

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChatEvent, ModelInfo } from "../../shared/protocol";
import { PUBLIC_ADAPTERS } from "../../server/adapters/adapters";
import { DriverError } from "../../server/agents/claude/driver";
import { MODEL_LIST, MODELS_ROUTE, ModelList, newestModels } from "../../server/chats/models";
import { ChatRegistry } from "../../server/chats/registry";
import { FakeBash, FakeDriver, MemoryStore, RecordingViewer, apply, projectRecord, settle } from "../../server/chats/testing";
import { createGate } from "../../server/gate/guards";
import { API_ROUTE_PATTERNS, createApi, type ApiDeps } from "../../server/http/api";
import type { ProjectModelsReply } from "../../server/http/api-types";
import { createApp, logRouteOf } from "../../server/http/app";
import { loadSite } from "../../server/http/static";
import type { LogEvent, LogFields } from "../../server/log";
import { rig, type Rig } from "../fake-claude/harness";

const PROJECT = "k3m7q2x4ab";
const OTHER = "abcdefghij";
const CWD = "/srv/work/app";
const CWD2 = "/srv/work/other";
const rid = () => crypto.randomUUID();
const ALL = ["low", "medium", "high", "xhigh", "max"] as const;

const row = (value: string, displayName: string, over: Partial<ModelInfo> = {}): ModelInfo => ({
  value,
  displayName,
  description: `${displayName} it`,
  efforts: ["low", "medium", "high"],
  supportsAutoMode: false,
  ...over,
});
/** The rows of the owner's demo, as a live chat's Claude Code lists them. */
const LIST: ModelInfo[] = [
  row("default", "Default (recommended)"),
  row("claude-opus-5-5", "Opus 5.5", { efforts: [...ALL], supportsAutoMode: true }),
  row("claude-sonnet-5-5", "Sonnet 5.5", { efforts: [...ALL], supportsAutoMode: true }),
  row("claude-haiku-5-5", "Haiku 5.5"),
];

let clock = Date.parse("2026-11-02T10:00:00.000Z");
afterEach(() => {
  clock = Date.parse("2026-11-02T10:00:00.000Z");
});

async function setup(prep?: (d: FakeDriver, s: MemoryStore) => void) {
  const driver = new FakeDriver();
  const store = new MemoryStore();
  const bash = new FakeBash();
  store.projects = [projectRecord(PROJECT, CWD), projectRecord(OTHER, CWD2)];
  prep?.(driver, store);
  const lines: ({ ev: LogEvent } & LogFields)[] = [];
  const log = { log: (ev: LogEvent, f: LogFields = {}) => void lines.push({ ev, ...f }), sweep: () => 0, close: () => {}, failures: 0 };
  const reg = new ChatRegistry({ driver, store, bash, log, now: () => new Date(clock) }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500, openCheckMs: 60_000, openFastMs: 60_000 });
  await reg.boot();
  return { driver, store, bash, reg, lines };
}

async function restart(reg: ChatRegistry, driver: FakeDriver, store: MemoryStore, bash: FakeBash): Promise<ChatRegistry> {
  await reg.shutdown();
  const next = new ChatRegistry({ driver, store, bash, now: () => new Date(clock) }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500, openCheckMs: 60_000, openFastMs: 60_000 });
  await next.boot();
  return next;
}

const turnEnd = (): ChatEvent => ({ k: "turn_end", ok: true, subtype: "success", durationMs: 3, error: null, uuids: [] });
const getModels = (chat: string) => ({ t: "get" as const, rid: rid(), chat, what: "models" as const });
const models = (o: unknown) => ((o as { ok: boolean; result?: unknown }).ok ? ((o as { result: ModelInfo[] }).result ?? null) : null);

/** A chat on a past session of `cwd` (its transcript exists), sleeping: no Claude Code process. */
async function sleepingChat(reg: ChatRegistry, driver: FakeDriver, project = PROJECT, cwd = CWD) {
  const sid = rid();
  driver.transcript(sid, "A past chat", cwd);
  const o = await apply(reg, { t: "continue_session", rid: rid(), project, session: sid });
  if (!o.ok) throw new Error(`continue_session refused: ${o.code}`);
  return { chat: (o.result as { chat: string }).chat, sid };
}

/** A new chat whose first turn has ended: its Claude Code process is live and idle. */
async function liveChat(reg: ChatRegistry, driver: FakeDriver, project = PROJECT) {
  const o = await apply(reg, { t: "new_chat", rid: rid(), project, uuid: rid(), text: "first", picks: { model: null, effort: null, mode: null }, uploads: [] });
  if (!o.ok) throw new Error(`new_chat refused: ${o.code}`);
  const c = driver.last;
  c.emit(turnEnd());
  await settle();
  return { chat: (o.result as { chat: string }).chat, c };
}

/** A gate that the test opens: the scripted driver's short read waits for it. */
function gate(driver: FakeDriver): () => void {
  let open!: () => void;
  driver.modelsWait = new Promise<void>((r) => (open = r));
  return () => {
    driver.modelsWait = null;
    open();
  };
}

describe("get models for a chat with no live process (the registry)", () => {
  test("the owner's case: after a restart, a sleeping chat's picker listed only Default; it lists the models a live chat read", async () => {
    const { reg, driver, store, bash } = await setup();
    const { chat, c } = await liveChat(reg, driver);
    c.modelList = LIST;
    expect(models(await apply(reg, getModels(chat)))).toEqual(LIST);
    await settle();
    const next = await restart(reg, driver, store, bash);
    // Every chat sleeps after a restart; none has a Claude Code process.
    expect(next.stateOf(chat)).toBe("sleeping");
    expect(models(await apply(next, getModels(chat)))).toEqual(LIST);
    const other = await sleepingChat(next, driver, OTHER, CWD2);
    expect(models(await apply(next, getModels(other.chat)))).toEqual(LIST);
    // The kept list is fresh: no short read, and no chat process started.
    expect(driver.modelReads).toEqual([]);
    expect(driver.opens).toHaveLength(1);
    await next.shutdown();
  });

  test("none kept: one short read for the chat's folder, awaited and kept with its project; the next asks read nothing", async () => {
    const { reg, driver, store } = await setup((d) => (d.modelsAnswer = LIST));
    const { chat } = await sleepingChat(reg, driver);
    expect(models(await apply(reg, getModels(chat)))).toEqual(LIST);
    expect(driver.modelReads).toEqual([CWD]);
    expect(store.projects[0]!.models).toEqual({ at: new Date(clock).toISOString(), list: LIST });
    expect(models(await apply(reg, getModels(chat)))).toEqual(LIST);
    expect(driver.modelReads).toEqual([CWD]);
    // Not a chat: nothing was opened, and the chat still sleeps.
    expect(driver.opens).toHaveLength(0);
    expect(reg.stateOf(chat)).toBe("sleeping");
    await reg.shutdown();
  });

  test("a held chat's picker (another app has its session open) gets the list too, and nothing starts", async () => {
    const { reg, driver } = await setup((d) => (d.modelsAnswer = LIST));
    const { chat, sid } = await sleepingChat(reg, driver);
    driver.openNow.set(sid, { app: "terminal", busy: false });
    expect(await apply(reg, { t: "send", rid: rid(), chat, uuid: rid(), text: "go on", draftRev: null, uploads: [] })).toEqual({ ok: false, code: "session_held" });
    expect(reg.list().find((r) => r.chat === chat)?.held).toEqual({ app: "terminal", session: sid });
    expect(models(await apply(reg, getModels(chat)))).toEqual(LIST);
    expect(driver.opens).toHaveLength(0);
    await reg.shutdown();
  });

  test("one read at a time: chats of two projects ask at once, and one read answers both", async () => {
    const { reg, driver, store } = await setup((d) => (d.modelsAnswer = LIST));
    const a = await sleepingChat(reg, driver);
    const b = await sleepingChat(reg, driver, OTHER, CWD2);
    const open = gate(driver);
    const asks = [apply(reg, getModels(a.chat)), apply(reg, getModels(b.chat)), apply(reg, getModels(a.chat))];
    await settle();
    expect(driver.modelReads).toEqual([CWD]);
    open();
    expect((await Promise.all(asks)).map(models)).toEqual([LIST, LIST, LIST]);
    expect(driver.modelReads).toEqual([CWD]);
    expect(store.projects.map((p) => p.models?.list ?? null)).toEqual([LIST, null]);
    await reg.shutdown();
  });

  test("a list over 24 h old answers at once, and one read in the background replaces it", async () => {
    const old = [row("default", "Default (recommended)"), row("claude-opus-4-6", "Opus 4.6")];
    const { reg, driver, store } = await setup((d, s) => {
      d.modelsAnswer = LIST;
      s.projects[1] = { ...s.projects[1]!, models: { at: new Date(clock - MODEL_LIST.staleMs - 60_000).toISOString(), list: old } };
    });
    const { chat } = await sleepingChat(reg, driver);
    const open = gate(driver);
    expect(models(await apply(reg, getModels(chat)))).toEqual(old);
    expect(driver.modelReads).toEqual([CWD]);
    open();
    await settle(10);
    expect(store.projects[0]!.models).toEqual({ at: new Date(clock).toISOString(), list: LIST });
    expect(models(await apply(reg, getModels(chat)))).toEqual(LIST);
    expect(driver.modelReads).toEqual([CWD]);
    // Under 24 h: no read.
    clock += MODEL_LIST.staleMs - 60_000;
    expect(models(await apply(reg, getModels(chat)))).toEqual(LIST);
    expect(driver.modelReads).toEqual([CWD]);
    await reg.shutdown();
  });

  test("a read that failed: no rows (the page shows its Default row), an error line with the code only, no new read for a minute", async () => {
    const { reg, driver, lines } = await setup((d) => {
      d.modelsAnswer = LIST;
      d.modelsThrows = "failed";
    });
    const { chat } = await sleepingChat(reg, driver);
    expect(models(await apply(reg, getModels(chat)))).toEqual([]);
    expect(models(await apply(reg, getModels(chat)))).toEqual([]);
    expect(driver.modelReads).toEqual([CWD]);
    expect(lines.filter((l) => l.ev === "error")).toEqual([{ ev: "error", chat: null, err: "sdk_error" }]);
    expect(JSON.stringify(lines)).not.toContain("/srv/work");
    clock += MODEL_LIST.retryMs + 1;
    driver.modelsThrows = null;
    expect(models(await apply(reg, getModels(chat)))).toEqual(LIST);
    expect(driver.modelReads).toEqual([CWD, CWD]);
    // No usable claude reads as a failed start.
    const { reg: r2, driver: d2, lines: l2 } = await setup((d) => (d.modelsThrows = "no_claude"));
    const c2 = await sleepingChat(r2, d2);
    expect(models(await apply(r2, getModels(c2.chat)))).toEqual([]);
    expect(l2.filter((l) => l.ev === "error")).toEqual([{ ev: "error", chat: null, err: "spawn_failed" }]);
    await reg.shutdown();
    await r2.shutdown();
  });

  test("an empty answer is never kept (it would hide the Default row's names for a day) and is not asked again at once", async () => {
    const { reg, driver, store } = await setup();
    const { chat } = await sleepingChat(reg, driver);
    expect(models(await apply(reg, getModels(chat)))).toEqual([]);
    expect(models(await apply(reg, getModels(chat)))).toEqual([]);
    expect(driver.modelReads).toEqual([CWD]);
    expect(store.projects.every((p) => p.models === undefined)).toBe(true);
    await reg.shutdown();
  });

  test("every live chat's read keeps its list: the newest answers chats of every project; the same list is written again only after an hour", async () => {
    const { reg, driver, store } = await setup();
    const sleeping = await sleepingChat(reg, driver, OTHER, CWD2);
    const { chat, c } = await liveChat(reg, driver);
    c.modelList = LIST;
    await apply(reg, getModels(chat));
    await settle();
    expect(store.projects[0]!.models).toEqual({ at: new Date(clock).toISOString(), list: LIST });
    expect(models(await apply(reg, getModels(sleeping.chat)))).toEqual(LIST);
    // The same list within the hour: not written again.
    clock += 30 * 60_000;
    await apply(reg, getModels(chat));
    await settle();
    expect(store.projects[0]!.models?.at).toBe(new Date(clock - 30 * 60_000).toISOString());
    clock += MODEL_LIST.refreshMs;
    await apply(reg, getModels(chat));
    await settle();
    expect(store.projects[0]!.models?.at).toBe(new Date(clock).toISOString());
    // A changed list is kept at once, and a sleeping chat of the other project gets it.
    const more = [...LIST, row("claude-fable-5-1", "Fable 5.1")];
    c.modelList = more;
    await apply(reg, getModels(chat));
    await settle();
    expect(models(await apply(reg, getModels(sleeping.chat)))).toEqual(more);
    expect(driver.modelReads).toEqual([]);
    // The project's picks and its last use stay as they were.
    expect(store.projects[0]!.picks).toEqual(projectRecord(PROJECT, CWD).picks);
    await reg.shutdown();
  });

  test("an agent with no model picker answers no rows and reads nothing", async () => {
    const { reg, driver } = await setup((d) => {
      d.caps = { ...d.caps, models: false };
      d.modelsAnswer = LIST;
    });
    const { chat } = await sleepingChat(reg, driver);
    expect(models(await apply(reg, getModels(chat)))).toEqual([]);
    expect(driver.modelReads).toEqual([]);
    await reg.shutdown();
  });

  test("a page attached to the sleeping chat sees no event from the read: it is not a chat", async () => {
    const { reg, driver } = await setup((d) => (d.modelsAnswer = LIST));
    const { chat } = await sleepingChat(reg, driver);
    const v = new RecordingViewer();
    await reg.attach(chat, v);
    const before = v.events.length;
    await apply(reg, getModels(chat));
    await settle();
    expect(v.events.length).toBe(before);
    await reg.shutdown();
  });

  test("no short read starts while the restart drains (R17, S11); Cancel restart lets one start again", async () => {
    const { reg, driver } = await setup((d) => (d.modelsAnswer = LIST));
    const { chat } = await sleepingChat(reg, driver);
    expect(reg.mayRead).toBe(true);
    expect(reg.drain("finish")).toEqual({ ok: true });
    expect(reg.mayRead).toBe(false);
    expect(models(await apply(reg, getModels(chat)))).toEqual([]);
    expect(driver.modelReads).toEqual([]);
    expect(reg.undrain()).toBe(true);
    expect(reg.mayRead).toBe(true);
    expect(models(await apply(reg, getModels(chat)))).toEqual(LIST);
    expect(driver.modelReads).toEqual([CWD]);
    await reg.shutdown();
  });

  test("the shutdown ends the short reads in flight (R17), and none starts after it", async () => {
    const { reg, driver } = await setup((d) => (d.modelsAnswer = LIST));
    expect(driver.endReadsCalls).toBe(0);
    await reg.shutdown();
    expect(driver.endReadsCalls).toBe(1);
    expect(reg.mayRead).toBe(false);
  });
});

describe("the kept list (server/chats/models.ts)", () => {
  test("the newest list kept with any project; none when none is kept", () => {
    const a = projectRecord(PROJECT, CWD);
    const b = projectRecord(OTHER, CWD2);
    expect(newestModels([a, b])).toBeNull();
    const older = { at: "2026-11-01T10:00:00.000Z", list: [row("default", "Default")] };
    const newer = { at: "2026-11-02T09:00:00.000Z", list: LIST };
    expect(newestModels([{ ...a, models: newer }, { ...b, models: older }])).toBe(newer);
    expect(newestModels([{ ...a, models: older }, { ...b, models: newer }])).toBe(newer);
    expect(MODEL_LIST.staleMs).toBe(24 * 60 * 60_000);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// GET /api/projects/:project/models (the new-chat form and the project page)

const PORT = 7942;
const OWN = `http://127.0.0.1:${PORT}`;
const PATH = `/api/projects/${PROJECT}/models`;
const PAGE = { "x-kitespan": "1" };

/** A short read the test answers by hand. */
class HandRead {
  readonly asked: string[] = [];
  private pending: { resolve: (l: ModelInfo[]) => void; reject: (e: unknown) => void }[] = [];
  read = (cwd: string): Promise<ModelInfo[]> => {
    this.asked.push(cwd);
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  };
  answer(list: ModelInfo[]): void {
    this.pending.shift()!.resolve(list);
  }
  fail(e: unknown = new DriverError("failed", "no")): void {
    this.pending.shift()!.reject(e);
  }
}

function makeApp(opts: { store?: MemoryStore; read?: ((cwd: string) => Promise<ModelInfo[]>) | null; now?: () => Date; modelList?: ModelList; mayRead?: () => boolean } = {}) {
  const store = opts.store ?? new MemoryStore();
  if (!opts.store) store.projects = [projectRecord(PROJECT, CWD), projectRecord(OTHER, CWD2)];
  const lines: ({ ev: LogEvent } & LogFields)[] = [];
  const logger = { log: (ev: LogEvent, f: LogFields = {}) => void lines.push({ ev, ...f }) };
  const gate = createGate(PORT);
  const site = loadSite(join(tmpdir(), "kitespan-no-build"), gate.origins);
  const driver: ApiDeps["driver"] = {
    probe: async () => {
      throw new Error("unused");
    },
    settings: async () => {
      throw new Error("unused");
    },
    listSessions: async () => [],
    history: async () => ({ events: [], more: null }),
    sessionInfo: async () => null,
    ...(opts.read ? { readModels: opts.read } : {}),
  };
  const api = createApi({
    gate,
    safe: site.safe,
    store,
    driver,
    uploadFolder: async () => ({ ok: true, choice: "temp", path: "/tmp" }),
    chatForSession: () => null,
    heldSessions: () => new Set<string>(),
    info: { port: PORT, version: "0.3.0", adapters: PUBLIC_ADAPTERS },
    logger,
    ...(opts.modelList ? { modelList: opts.modelList } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.mayRead ? { mayRead: opts.mayRead } : {}),
  });
  const app = createApp({ gate, site, api, sockets: {}, logger });
  const get = async (path: string, headers: Record<string, string> = {}, method = "GET") =>
    (await app.fetch(new Request(`${OWN}${path}`, { method, headers: { host: `127.0.0.1:${PORT}`, ...headers } }), { upgrade: () => false }))!;
  const reply = async (path = PATH) => (await (await get(path, PAGE)).json()) as ProjectModelsReply;
  return { get, reply, store, lines };
}

describe("GET /api/projects/:project/models", () => {
  test("its route and log pattern; the Host allowlist and the Origin check; a read only; 404 for an unknown project", async () => {
    expect(API_ROUTE_PATTERNS).toContain(MODELS_ROUTE);
    expect(MODELS_ROUTE).toBe("/api/projects/:project/models");
    expect(logRouteOf(PATH)).toBe(MODELS_ROUTE);
    const hand = new HandRead();
    const { get } = makeApp({ read: hand.read });
    expect((await get(PATH, { host: "evil.invalid" })).status).toBe(403);
    expect((await get(PATH, { origin: "https://evil.invalid", ...PAGE })).status).toBe(403);
    expect((await get(PATH, { origin: OWN })).status).toBe(200);
    expect((await get(PATH, { origin: OWN, "content-type": "application/json", "x-kitespan": "1" }, "POST")).status).toBe(405);
    expect((await get("/api/projects/zzzzzzzzzz/models", PAGE)).status).toBe(404);
    const res = await get(PATH);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(hand.asked).toEqual([]);
  });

  test("none kept: the page's read waits for one short read of the project's folder, then answers the list with its time", async () => {
    const hand = new HandRead();
    const at = new Date("2026-11-02T10:00:00.000Z");
    const { reply, store } = makeApp({ read: hand.read, now: () => at });
    const first = reply();
    const second = reply();
    await settle(10);
    expect(hand.asked).toEqual([CWD]);
    hand.answer(LIST);
    expect(await first).toEqual({ models: LIST, at: at.toISOString() });
    expect(await second).toEqual({ models: LIST, at: at.toISOString() });
    expect(store.projects[0]!.models).toEqual({ at: at.toISOString(), list: LIST });
    // Kept: the next read answers at once, for any project, and reads nothing.
    expect(await reply(`/api/projects/${OTHER}/models`)).toEqual({ models: LIST, at: at.toISOString() });
    expect(hand.asked).toEqual([CWD]);
  });

  test("while the restart drains or the server closes (mayRead false), the page's read answers none and starts nothing", async () => {
    const hand = new HandRead();
    let may = false;
    const { reply } = makeApp({ read: hand.read, mayRead: () => may });
    expect(await reply()).toEqual({ models: [], at: null });
    expect(hand.asked).toEqual([]);
    may = true;
    const r = reply();
    await settle(10);
    expect(hand.asked).toEqual([CWD]);
    hand.answer(LIST);
    expect((await r).models).toEqual(LIST);
  });

  test("a read with no sender header (a cross-site image or prefetch) gets the kept list or none, and starts nothing", async () => {
    const hand = new HandRead();
    const { get } = makeApp({ read: hand.read });
    const plain = await get(PATH);
    expect(plain.status).toBe(200);
    expect(await plain.json()).toEqual({ models: [], at: null });
    expect(await (await get(PATH, { "x-kitespan": "0" })).json()).toEqual({ models: [], at: null });
    await settle();
    expect(hand.asked).toEqual([]);
  });

  test("a read that failed answers none, with an error line naming the route and the code only; an agent with no read answers none", async () => {
    const hand = new HandRead();
    const { reply, lines } = makeApp({ read: hand.read });
    const r = reply();
    await settle(10);
    hand.fail(new DriverError("failed", `the read ran out of time in ${CWD}`));
    expect(await r).toEqual({ models: [], at: null });
    expect(lines).toEqual([{ ev: "error", route: MODELS_ROUTE, err: "sdk_error" }]);
    const none = makeApp({ read: null });
    expect(await none.reply()).toEqual({ models: [], at: null });
    expect(none.lines).toEqual([]);
  });

  test("the registry's kept list answers the route: a live chat's read shows in the form at once", async () => {
    const { reg, driver, store } = await setup();
    const { chat, c } = await liveChat(reg, driver);
    c.modelList = LIST;
    await apply(reg, getModels(chat));
    await settle();
    const hand = new HandRead();
    // The route's clock is the registry's, so the kept list is as fresh as the read that kept it (never the wall's).
    const { reply } = makeApp({ store, read: hand.read, now: () => new Date(clock) });
    expect((await reply()).models).toEqual(LIST);
    expect(hand.asked).toEqual([]);
    await reg.shutdown();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The driver's short read through the fake claude

let rigs: Rig[] = [];
afterEach(async () => {
  await Promise.all(rigs.map((r) => r.cleanup()));
  rigs = [];
});
const use = (r: Rig) => (rigs.push(r), r);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("the short read through the fake claude", () => {
  test("an idle Claude Code answers supportedModels and ends: no message, no turn, no session option, no chat", async () => {
    const r = use(rig("text-thinking"));
    expect(await r.driver.readModels(r.fake.project)).toEqual([
      { value: "default", displayName: "Default (recommended)", description: "Use the default model", efforts: ["low", "medium", "high"], supportsAutoMode: false },
      { value: "claude-fake-1", displayName: "Fake 1", description: "A fake model row", efforts: ["low", "medium", "high", "xhigh", "max"], supportsAutoMode: true },
    ]);
    const trace = r.fake.trace();
    const starts = trace.filter((l) => l.t === "start");
    expect(starts).toHaveLength(1);
    const args = starts[0]!.args as string[];
    for (const a of ["--resume", "--session-id", "--fork-session", "--continue", "--model", "--permission-mode"]) expect(args).not.toContain(a);
    expect(trace.filter((l) => l.t === "user" || l.t === "turn_start")).toEqual([]);
    // Row 94: then each model row's window: the default row's as the query starts, then the other row's after a switch.
    expect(trace.filter((l) => l.t === "control").map((l) => l.subtype)).toEqual(["initialize", "get_context_usage", "set_model", "get_context_usage"]);
    expect(alive(starts[0]!.pid as number)).toBe(false);
    expect(r.lastOptions).toEqual([]);
  });

  test("D59's process is shared: the commands and the models of one folder read at once start one Claude Code", async () => {
    const r = use(rig("text-thinking"));
    const [commands, list] = await Promise.all([r.driver.readCommands(r.fake.project), r.driver.readModels(r.fake.project)]);
    expect(commands.map((c) => c.name)).toEqual(["compact", "context", "review-notes"]);
    expect(list.map((m) => m.value)).toEqual(["default", "claude-fake-1"]);
    expect(r.fake.trace().filter((l) => l.t === "start")).toHaveLength(1);
  });

  test("one at a time: a model read while another folder's read runs takes that one's answer and starts none", async () => {
    // The second folder is no project: a read of its own would be refused by the gate, so only the shared one answers.
    const r = use(rig("text-thinking"));
    const elsewhere = join(r.fake.project, "not-a-project");
    const [commands, list] = await Promise.all([r.driver.readCommands(r.fake.project), r.driver.readModels(elsewhere)]);
    expect(commands.length).toBe(3);
    expect(list.map((m) => m.value)).toEqual(["default", "claude-fake-1"]);
    const starts = r.fake.trace().filter((l) => l.t === "start");
    expect(starts.map((l) => l.cwd)).toEqual([r.fake.project]);
  });

  test("endReads (the shutdown, the restart's close) ends a read in flight at once: it fails, and its process is gone", async () => {
    const r = use(rig({ initializeDelayMs: 10_000 }));
    const t0 = Date.now();
    const read = r.driver.readModels(r.fake.project).catch((e) => e);
    await r.fake.waitFor((l) => l.t === "control" && l.subtype === "initialize", 5_000);
    await r.driver.endReads();
    const pid = r.fake.trace().find((l) => l.t === "start")!.pid as number;
    expect(alive(pid)).toBe(false);
    const err = await read;
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe("failed");
    expect(Date.now() - t0).toBeLessThan(8_000);
    // With none in flight it ends at once.
    await r.driver.endReads();
  });

  test("with no answer within the cap the process is ended and the read fails", async () => {
    const r = use(rig({ initializeDelayMs: 10_000 }, { commandsReadMs: 300 }));
    const t0 = Date.now();
    const err = await r.driver.readModels(r.fake.project).catch((e) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe("failed");
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(alive(r.fake.trace().find((l) => l.t === "start")!.pid as number)).toBe(false);
  });

  test("the route end to end: the fake's rows, kept with the project", async () => {
    const r = use(rig("text-thinking"));
    const store = new MemoryStore();
    store.projects = [projectRecord(PROJECT, r.fake.project)];
    const { reply } = makeApp({ store, read: (cwd) => r.driver.readModels(cwd) });
    const got = await reply();
    expect(got.models.map((m) => m.displayName)).toEqual(["Default (recommended)", "Fake 1"]);
    expect(got.at).not.toBeNull();
    expect(store.projects[0]!.models?.list.map((m) => m.value)).toEqual(["default", "claude-fake-1"]);
  });
});
