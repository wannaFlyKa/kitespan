// The new-chat form's `/` menu before a chat exists (D59): GET /api/projects/:project/commands answers the project's
// last command list, `{commands, at}`, with at null and an empty list while none is known. When none is known, or the
// kept one is over 24 h old, one short read goes through the agent seam: an idle Claude Code process for the project's
// folder that answers the list and ends (20 s at most), one at a time per project, never a chat and never a model turn.
// The driver's read runs through the real Agent SDK and the fake CLI; the real claude never runs.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandInfo } from "../../shared/protocol";
import { PUBLIC_ADAPTERS } from "../../server/adapters/adapters";
import { COMMANDS_READ_MS, DriverError } from "../../server/agents/claude/driver";
import { GateError } from "../../server/agents/claude/options";
import type { AgentDriver } from "../../server/agents/types";
import { PROJECT_COMMANDS, ProjectCommands } from "../../server/chats/project-commands";
import { MemoryStore, projectRecord, settle } from "../../server/chats/testing";
import { createGate } from "../../server/gate/guards";
import { API_ROUTE_PATTERNS, createApi, type ApiDeps } from "../../server/http/api";
import type { ProjectCommandsReply } from "../../server/http/api-types";
import { createApp, logRouteOf } from "../../server/http/app";
import { loadSite } from "../../server/http/static";
import type { LogEvent, LogFields } from "../../server/log";
import { rig, type Rig } from "../fake-claude/harness";

const PORT = 7942;
const OWN = `http://127.0.0.1:${PORT}`;
const PROJECT = "k3m7q2x4ab";
const PATH = `/api/projects/${PROJECT}/commands`;
const ROUTE = "/api/projects/:project/commands";

/** The header the page's read sends; a cross-site page cannot send it (no preflight is answered). */
const PAGE = { "x-kitespan": "1" };
const row = (name: string, over: Partial<CommandInfo> = {}): CommandInfo => ({ name, description: `${name} it`, argumentHint: "", aliases: [], builtin: false, terminalOnly: false, ...over });

let rigs: Rig[] = [];
const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(rigs.map((r) => r.cleanup()));
  rigs = [];
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
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

/** A short read the test answers by hand. */
class HandRead {
  readonly asked: string[] = [];
  private pending: { resolve: (l: CommandInfo[]) => void; reject: (e: unknown) => void }[] = [];
  read = (cwd: string): Promise<CommandInfo[]> => {
    this.asked.push(cwd);
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  };
  answer(list: CommandInfo[]): void {
    this.pending.shift()!.resolve(list);
  }
  fail(e: unknown = new DriverError("failed", "no")): void {
    this.pending.shift()!.reject(e);
  }
}

function makeApp(opts: { store?: MemoryStore; read?: AgentDriver["readCommands"] | null; now?: () => Date; projectCommands?: ProjectCommands; mayRead?: () => boolean } = {}) {
  const store = opts.store ?? new MemoryStore();
  if (!opts.store) store.projects = [projectRecord(PROJECT, "/srv/work/app")];
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
    ...(opts.read ? { readCommands: opts.read } : {}),
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
    ...(opts.projectCommands ? { projectCommands: opts.projectCommands } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.mayRead ? { mayRead: opts.mayRead } : {}),
  });
  const app = createApp({ gate, site, api, sockets: {}, logger });
  const get = async (path: string, headers: Record<string, string> = {}, method = "GET") =>
    (await app.fetch(new Request(`${OWN}${path}`, { method, headers: { host: `127.0.0.1:${PORT}`, ...headers } }), { upgrade: () => false }))!;
  // The page's read carries the sender header (web/state/store.ts loadProjectCommands); only such a read starts one.
  const reply = async () => (await (await get(PATH, PAGE)).json()) as ProjectCommandsReply;
  return { get, reply, store, lines };
}

describe("GET /api/projects/:project/commands", () => {
  test("its route and log pattern; the Host allowlist and the Origin check; a read only; 404 and no route", async () => {
    expect(API_ROUTE_PATTERNS).toContain(ROUTE);
    expect(logRouteOf(PATH)).toBe(ROUTE);
    const hand = new HandRead();
    const { get } = makeApp({ read: hand.read });
    expect((await get(PATH, { host: "evil.invalid" })).status).toBe(403);
    expect((await get(PATH, { origin: "https://evil.invalid" })).status).toBe(403);
    expect((await get(PATH, { origin: OWN })).status).toBe(200);
    expect((await get(PATH, { origin: OWN, "content-type": "application/json", "x-kitespan": "1" }, "POST")).status).toBe(405);
    expect((await get("/api/projects/zzzzzzzzzz/commands")).status).toBe(404);
    expect((await get("/api/projects/..%2Fetc/commands")).status).toBe(404);
    const res = await get(PATH);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("none known: an empty list with at null, and one short read for the project's folder; then the list with its time", async () => {
    const hand = new HandRead();
    const at = new Date("2026-11-02T10:00:00.000Z");
    const { reply, store } = makeApp({ read: hand.read, now: () => at });
    expect(await reply()).toEqual({ commands: [], at: null });
    // A second ask while it runs (the page's one ask again after about 3 s) starts no other read.
    expect(await reply()).toEqual({ commands: [], at: null });
    expect(hand.asked).toEqual(["/srv/work/app"]);
    const list = [row("compact", { builtin: true }), row("review-notes", { argumentHint: "[file]", aliases: ["rn"] })];
    hand.answer(list);
    await settle(10);
    expect(await reply()).toEqual({ commands: list, at: at.toISOString() });
    expect(store.projects[0]!.commands).toEqual({ at: at.toISOString(), list });
    expect(hand.asked.length).toBe(1);
  });

  test("a kept list under 24 h answers and starts nothing; an older one answers and is read again in the background", async () => {
    const hand = new HandRead();
    let now = Date.parse("2026-11-02T10:00:00.000Z");
    const store = new MemoryStore();
    const kept = { at: new Date(now - PROJECT_COMMANDS.staleMs + 60_000).toISOString(), list: [row("compact")] };
    store.projects = [{ ...projectRecord(PROJECT, "/srv/work/app"), commands: kept }];
    const { reply } = makeApp({ store, read: hand.read, now: () => new Date(now) });
    expect(await reply()).toEqual({ commands: kept.list, at: kept.at });
    expect(hand.asked).toEqual([]);
    now += 120_000;
    expect(await reply()).toEqual({ commands: kept.list, at: kept.at });
    expect(hand.asked.length).toBe(1);
    hand.answer([row("compact"), row("context")]);
    await settle(10);
    expect(await reply()).toEqual({ commands: [row("compact"), row("context")], at: new Date(now).toISOString() });
  });

  test("a read that failed: still none, an error line with the route only, and no new read for a while", async () => {
    const hand = new HandRead();
    let now = Date.parse("2026-11-02T10:00:00.000Z");
    const { reply, lines } = makeApp({ read: hand.read, now: () => new Date(now) });
    await reply();
    hand.fail(new DriverError("failed", "the read ran out of time in /srv/work/app"));
    await settle(10);
    expect(await reply()).toEqual({ commands: [], at: null });
    expect(hand.asked.length).toBe(1);
    expect(lines).toEqual([{ ev: "error", route: ROUTE, err: "sdk_error" }]);
    now += PROJECT_COMMANDS.retryMs + 1;
    await reply();
    expect(hand.asked.length).toBe(2);
    // No usable claude reads as a failed start.
    hand.fail(new DriverError("no_claude", "none"));
    await settle(10);
    expect(lines.at(-1)).toEqual({ ev: "error", route: ROUTE, err: "spawn_failed" });
    expect(JSON.stringify(lines)).not.toContain("/srv/work");
  });

  test("the read keeps the terminal-only marks the project's chats saw, and every other field of the project", async () => {
    const hand = new HandRead();
    const store = new MemoryStore();
    const base = { ...projectRecord(PROJECT, "/srv/work/app"), name: "My app", lastUsedAt: "2026-11-01T09:00:00.000Z" };
    store.projects = [{ ...base, commands: { at: "2026-10-01T00:00:00.000Z", list: [row("exit", { builtin: true, terminalOnly: true })] } }];
    const at = new Date("2026-11-02T10:00:00.000Z");
    const { reply } = makeApp({ store, read: hand.read, now: () => at });
    await reply();
    hand.answer([row("exit", { builtin: true }), row("compact", { builtin: true })]);
    await settle(10);
    expect(store.projects[0]).toEqual({ ...base, commands: { at: at.toISOString(), list: [row("exit", { builtin: true, terminalOnly: true }), row("compact", { builtin: true })] } });
  });

  test("one read at a time per project, each for its own folder; an agent with no read answers none", async () => {
    const hand = new HandRead();
    const store = new MemoryStore();
    store.projects = [projectRecord(PROJECT, "/srv/work/app"), projectRecord("abcdefghij", "/srv/work/other")];
    const { get } = makeApp({ store, read: hand.read });
    await Promise.all([get(PATH, PAGE), get(PATH, PAGE), get("/api/projects/abcdefghij/commands", PAGE), get("/api/projects/abcdefghij/commands", PAGE)]);
    expect(hand.asked.sort()).toEqual(["/srv/work/app", "/srv/work/other"]);
    const none = makeApp({ read: null });
    expect(await none.reply()).toEqual({ commands: [], at: null });
    expect(none.lines).toEqual([]);
  });
});

describe("the gate of the short read (W19d)", () => {
  test("a read with no Origin and no sender header (a cross-site image or prefetch) gets the kept list and starts nothing", async () => {
    const hand = new HandRead();
    const { get, reply, store } = makeApp({ read: hand.read });
    const plain = await get(PATH);
    expect(plain.status).toBe(200);
    expect(await plain.json()).toEqual({ commands: [], at: null });
    expect((await get(PATH, { "x-kitespan": "0" })).status).toBe(200);
    expect((await get(PATH, { "sec-fetch-site": "cross-site" })).status).toBe(200);
    await settle();
    expect(hand.asked).toEqual([]);
    // The page's read starts it; the kept list then answers every read, with the header or without.
    expect(await reply()).toEqual({ commands: [], at: null });
    expect(hand.asked).toEqual(["/srv/work/app"]);
    hand.answer([row("compact")]);
    await settle();
    expect(store.projects[0]!.commands?.list.map((c) => c.name)).toEqual(["compact"]);
    const kept = (await (await get(PATH)).json()) as ProjectCommandsReply;
    expect(kept.commands.map((c) => c.name)).toEqual(["compact"]);
  });
  test("while the restart drains or the server closes (mayRead false), the page's read gets the kept list and starts nothing", async () => {
    const hand = new HandRead();
    let may = false;
    const { reply } = makeApp({ read: hand.read, mayRead: () => may });
    expect(await reply()).toEqual({ commands: [], at: null });
    await settle();
    expect(hand.asked).toEqual([]);
    // Back to work (Cancel restart, a restart that did not happen): the next read starts one.
    may = true;
    await reply();
    expect(hand.asked).toEqual(["/srv/work/app"]);
  });
  test("a foreign Origin is refused with the header too", async () => {
    const hand = new HandRead();
    const { get } = makeApp({ read: hand.read });
    expect((await get(PATH, { origin: "https://evil.invalid", ...PAGE })).status).toBe(403);
    expect(hand.asked).toEqual([]);
  });
});

describe("the short read through the fake claude", () => {
  test("an idle Claude Code for the folder answers the list and ends: no message, no turn, no session option, no chat", async () => {
    const r = use(rig({ initMessage: { terminal_slash_commands: ["context"] } }));
    const list = await r.driver.readCommands(r.fake.project);
    expect(list).toEqual([
      { name: "compact", description: "Clear conversation history but keep a summary in context", argumentHint: "", aliases: [], builtin: true, terminalOnly: false },
      { name: "context", description: "Show current context usage", argumentHint: "", aliases: [], builtin: true, terminalOnly: false },
      { name: "review-notes", description: "A command of the user's own", argumentHint: "[file]", aliases: ["rn"], builtin: false, terminalOnly: false },
    ]);
    const trace = r.fake.trace();
    const start = trace.find((l) => l.t === "start")!;
    const args = start.args as string[];
    for (const a of ["--resume", "--session-id", "--fork-session", "--continue", "--model", "--permission-mode", "--allow-dangerously-skip-permissions"]) expect(args).not.toContain(a);
    expect(start.cwd).toBe(r.fake.project);
    expect(trace.filter((l) => l.t === "user" || l.t === "turn_start")).toEqual([]);
    // Row 94: the same process reads each model row's window (no message, so still no turn).
    expect(trace.filter((l) => l.t === "control").map((l) => l.subtype)).toEqual(["initialize", "get_context_usage", "set_model", "get_context_usage"]);
    expect(trace.some((l) => l.t === "stdin_end")).toBe(true);
    expect(alive(start.pid as number)).toBe(false);
    // Not a chat: nothing written for last-options.json.
    expect(r.lastOptions).toEqual([]);
  });

  test("with no answer within the cap, the process is ended and the read fails", async () => {
    expect(COMMANDS_READ_MS).toBe(20_000);
    const r = use(rig({ initializeDelayMs: 10_000 }, { commandsReadMs: 300 }));
    const t0 = Date.now();
    const err = await r.driver.readCommands(r.fake.project).catch((e) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe("failed");
    expect(Date.now() - t0).toBeLessThan(5_000);
    const pid = r.fake.trace().find((l) => l.t === "start")!.pid as number;
    expect(alive(pid)).toBe(false);
    expect(r.fake.trace().filter((l) => l.t === "user")).toEqual([]);
  });

  test("a refused initialize fails the read; no usable claude is no_claude; a folder of no project is refused by the gate", async () => {
    const refused = use(rig({ refuse: ["initialize"] }));
    expect(((await refused.driver.readCommands(refused.fake.project).catch((e) => e)) as DriverError).code).toBe("failed");
    const empty = realpathSync(mkdtempSync(join(tmpdir(), "kitespan-no-claude-")));
    scratch.push(empty);
    const none = use(rig("text-thinking", { pathEnv: () => empty }));
    expect(((await none.driver.readCommands(none.fake.project).catch((e) => e)) as DriverError).code).toBe("no_claude");
    expect(none.fake.trace()).toEqual([]);
    const other = use(rig("text-thinking", { knownFolders: () => [] }));
    expect(await other.driver.readCommands(other.fake.project).catch((e) => e)).toBeInstanceOf(GateError);
    expect(other.fake.trace()).toEqual([]);
  });

  test("the route end to end: none at first, then the fake's list, kept with the project", async () => {
    const r = use(rig("text-thinking"));
    const store = new MemoryStore();
    store.projects = [projectRecord(PROJECT, r.fake.project)];
    const { reply } = makeApp({ store, read: (cwd) => r.driver.readCommands(cwd) });
    expect(await reply()).toEqual({ commands: [], at: null });
    const end = Date.now() + 8_000;
    let got = await reply();
    while (got.at === null && Date.now() < end) {
      await Bun.sleep(50);
      got = await reply();
    }
    expect(got.commands.map((c) => c.name)).toEqual(["compact", "context", "review-notes"]);
    expect(store.projects[0]!.commands?.list.map((c) => c.name)).toEqual(["compact", "context", "review-notes"]);
    expect(r.fake.trace().filter((l) => l.t === "start").length).toBe(1);
  });
});
