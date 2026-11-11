// Row 97 (the owner: Settings said "Start a chat to read it." in many places): the server keeps the last value that a
// live chat's Claude Code reported, on disk with the chat's project (projects.json), read defensively: the provider on
// every live account read (host-wide: the newest kept answers), the start facts (fast mode, skills, plugins, output
// style) on every `session` event (per project), each with its time. GET /api/settings answers them while no chat is
// live, with `at`; a live read answers as before (`at` null). Nothing starts a Claude Code process for them, and no
// string that starts with "arn:" is kept. The scripted driver stands in for Claude Code; the real claude never runs.

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChatEventOf } from "../../shared/protocol";
import { PUBLIC_ADAPTERS } from "../../server/adapters/adapters";
import { factsFor, factsOfSession, newestAccount } from "../../server/chats/facts";
import { ChatRegistry } from "../../server/chats/registry";
import { FakeBash, FakeDriver, MemoryStore, apply, projectRecord, settle } from "../../server/chats/testing";
import { createGate } from "../../server/gate/guards";
import type { EnvBook } from "../../server/env/api";
import { createApi, type ApiDeps } from "../../server/http/api";
import type { SettingsReply } from "../../server/http/api-types";
import { createApp } from "../../server/http/app";
import { loadSite } from "../../server/http/static";
import { keptAccountFrom, keptFactsFrom } from "../../server/store/facts";
import { projectFrom } from "../../server/store/records";

const PROJECT = "k3m7q2x4ab";
const OTHER = "abcdefghij";
const CWD = "/srv/work/app";
const CWD2 = "/srv/work/other";
const HOST_PORT = 7942;
const rid = () => crypto.randomUUID();
const ARN = ["arn", "aws", "bedrock", "us-west-2", "4321".repeat(3), "application-inference-profile/fdtestprofile"].join(":");

let clock = Date.parse("2026-11-03T09:00:00.000Z");
afterEach(() => {
  clock = Date.parse("2026-11-03T09:00:00.000Z");
});

const SESSION: ChatEventOf<"session"> = {
  k: "session",
  sessionId: "",
  model: null,
  mode: "default",
  version: "2.1.317",
  bypass: false,
  fastMode: { state: "off", reason: "not_first_party" },
  skills: ["review-notes", "ship-it"],
  plugins: [{ name: "notes-tools", version: "1.2.0" }],
  outputStyle: "Explanatory",
};
const FACTS = { fastMode: SESSION.fastMode!, skills: SESSION.skills!, plugins: SESSION.plugins!, outputStyle: SESSION.outputStyle! };

function boot(store: MemoryStore, driver = new FakeDriver(), env?: EnvBook) {
  return new ChatRegistry({ driver, store, bash: new FakeBash(), now: () => new Date(clock), ...(env ? { env } : {}) }, { idleMs: 60_000, closeGraceMs: 10, shutdownMs: 500, openCheckMs: 60_000, openFastMs: 60_000 });
}

/** A new chat whose Claude Code started (its `session` event came) in `project`. */
async function liveChat(reg: ChatRegistry, driver: FakeDriver, project = PROJECT, session: ChatEventOf<"session"> = SESSION) {
  const o = await apply(reg, { t: "new_chat", rid: rid(), project, uuid: rid(), text: "first", picks: { model: null, effort: null, mode: null }, uploads: [] });
  if (!o.ok) throw new Error(`new_chat refused: ${o.code}`);
  const c = driver.last;
  c.emit({ ...session, sessionId: rid() });
  c.emit({ k: "turn_end", ok: true, subtype: "success", durationMs: 3, error: null, uuids: [] });
  await settle();
  return { chat: (o.result as { chat: string }).chat, c };
}

/** GET /api/settings on the API (no socket, no port bound), with the registry's account read; `env`: D60's variables. */
function settingsApi(store: MemoryStore, reg: ChatRegistry, env?: EnvBook) {
  const gate = createGate(HOST_PORT);
  const site = loadSite(join(tmpdir(), "kitespan-no-build"), gate.origins);
  const driver: ApiDeps["driver"] = {
    probe: async () => Promise.reject(new Error("unused")),
    settings: async () => Promise.reject(new Error("unused")),
    listSessions: async () => [],
    history: async () => ({ events: [], more: null }),
    sessionInfo: async () => null,
  };
  const logger = { log: () => {} };
  const api = createApi({ gate, safe: site.safe, store, driver, uploadFolder: async () => ({ ok: true, choice: "temp", path: "/tmp" }), chatForSession: () => null, heldSessions: () => new Set<string>(), info: { port: HOST_PORT, version: "0.4.0", adapters: PUBLIC_ADAPTERS }, logger, account: (project) => reg.account(project), ...(env ? { env } : {}) });
  const app = createApp({ gate, site, api, sockets: {}, logger });
  return async (project?: string) => {
    const res = (await app.fetch(new Request(`http://127.0.0.1:${HOST_PORT}/api/settings${project ? `?project=${project}` : ""}`, { headers: { host: `127.0.0.1:${HOST_PORT}` } }), { upgrade: () => false }))!;
    return (await res.json()) as SettingsReply;
  };
}

describe("the last values a live chat reported, kept (the registry)", () => {
  test("a session event keeps its start facts with the chat's project, and an account read its provider, each with its time", async () => {
    const store = new MemoryStore();
    store.projects = [projectRecord(PROJECT, CWD), projectRecord(OTHER, CWD2)];
    const driver = new FakeDriver();
    const reg = boot(store, driver);
    await reg.boot();
    const { c } = await liveChat(reg, driver);
    c.provider = "bedrock";
    expect(await reg.account()).toEqual({ provider: "bedrock" });
    await settle();
    const p = store.projects.find((x) => x.id === PROJECT)!;
    expect(p.facts).toEqual({ at: "2026-11-03T09:00:00.000Z", ...FACTS });
    expect(p.account).toEqual({ at: "2026-11-03T09:00:00.000Z", provider: "bedrock" });
    expect(store.projects.find((x) => x.id === OTHER)!.facts).toBeUndefined();
    await reg.shutdown();
  });

  test("a new registry over the same store, no chat live: Settings gets the kept provider and facts with their times; nothing starts", async () => {
    const store = new MemoryStore();
    store.projects = [projectRecord(PROJECT, CWD), projectRecord(OTHER, CWD2)];
    const driver = new FakeDriver();
    const reg = boot(store, driver);
    await reg.boot();
    const { c } = await liveChat(reg, driver);
    c.provider = "bedrock";
    await reg.account();
    await settle();
    await reg.shutdown();
    clock += 3 * 60 * 60_000;
    const next = boot(store, driver);
    await next.boot();
    const opens = driver.opens.length;
    const read = settingsApi(store, next);
    const r = await read(PROJECT);
    expect(r.account).toEqual({ provider: "bedrock", at: "2026-11-03T09:00:00.000Z" });
    expect(r.facts).toEqual({ at: "2026-11-03T09:00:00.000Z", ...FACTS });
    // Another project with none of its own: the newest any project kept (it names "the last chat").
    expect((await read(OTHER)).facts?.skills).toEqual(FACTS.skills);
    expect(driver.opens).toHaveLength(opens);
    await next.shutdown();
  });

  test("a live read answers as before, with no time; a newer session event replaces the kept facts", async () => {
    const store = new MemoryStore();
    store.projects = [projectRecord(PROJECT, CWD)];
    const driver = new FakeDriver();
    const reg = boot(store, driver);
    await reg.boot();
    const { c } = await liveChat(reg, driver);
    c.provider = "vertex";
    const read = settingsApi(store, reg);
    expect((await read(PROJECT)).account).toEqual({ provider: "vertex", at: null });
    clock += 60_000;
    await liveChat(reg, driver, PROJECT, { ...SESSION, skills: ["only-this"], outputStyle: null });
    await settle();
    expect((await read(PROJECT)).facts).toMatchObject({ at: "2026-11-03T09:01:00.000Z", skills: ["only-this"], outputStyle: null });
    await reg.shutdown();
  });

  test("nothing kept: account and facts are null, as before", async () => {
    const store = new MemoryStore();
    store.projects = [projectRecord(PROJECT, CWD)];
    const reg = boot(store);
    await reg.boot();
    const r = await settingsApi(store, reg)(PROJECT);
    expect([r.account, r.facts]).toEqual([null, null]);
    await reg.shutdown();
  });
});

describe("no arn: string is kept, and the files are read defensively", () => {
  const AT = "2026-11-03T09:00:00.000Z";
  test("a session event's ARN names are left out; a provider that is an ARN is not kept", async () => {
    const f = factsOfSession({ ...SESSION, skills: ["ok", ARN], plugins: [{ name: ARN, version: null }, { name: "kept", version: ARN }], outputStyle: ARN, fastMode: { state: "on", reason: ARN } }, AT)!;
    expect(f).toEqual({ at: AT, fastMode: { state: "on", reason: null }, skills: ["ok"], plugins: [{ name: "kept", version: null }], outputStyle: null });
    expect(JSON.stringify(f)).not.toContain("arn:");
    const store = new MemoryStore();
    store.projects = [projectRecord(PROJECT, CWD)];
    const driver = new FakeDriver();
    const reg = boot(store, driver);
    await reg.boot();
    const { c } = await liveChat(reg, driver, PROJECT, { ...SESSION, outputStyle: ARN });
    c.provider = ARN;
    await reg.account();
    await settle();
    expect(JSON.stringify(store.projects)).not.toContain("arn:");
    expect(store.projects[0]!.account).toBeUndefined();
    await reg.shutdown();
  });
  test("a planted file: an ARN, an odd value or a bad time reads as none, and the project keeps the rest", () => {
    for (const bad of [{ at: AT, provider: ARN }, { at: "yesterday", provider: "bedrock" }, { provider: "bedrock" }, "bedrock", { at: AT, provider: "a\u0007b" }]) expect(keptAccountFrom(bad)).toBeUndefined();
    expect(keptAccountFrom({ at: AT, provider: null })).toEqual({ at: AT, provider: null });
    for (const bad of [{ at: AT, ...FACTS, skills: [ARN] }, { at: AT, ...FACTS, outputStyle: ARN }, { at: AT, ...FACTS, fastMode: { state: "maybe", reason: null } }, { at: AT, ...FACTS, plugins: [{ name: "x" }] }, { ...FACTS }]) expect(keptFactsFrom(bad)).toBeUndefined();
    const p = projectFrom({ ...projectRecord(PROJECT, CWD), account: { at: AT, provider: ARN }, facts: { at: AT, ...FACTS, skills: [ARN] } });
    expect([p.account, p.facts, p.id]).toEqual([undefined, undefined, PROJECT]);
    expect(projectFrom({ ...projectRecord(PROJECT, CWD), account: { at: AT, provider: "bedrock" }, facts: { at: AT, ...FACTS } }).facts).toEqual({ at: AT, ...FACTS });
  });
  test("the newest provider of any project; the facts of the project asked, else the newest", () => {
    const at = (h: number) => `2026-11-03T0${h}:00:00.000Z`;
    const projects = [
      { id: "a", account: { at: at(1), provider: "vertex" }, facts: { at: at(5), ...FACTS, skills: ["a"] } },
      { id: "b", account: { at: at(3), provider: "bedrock" }, facts: { at: at(2), ...FACTS, skills: ["b"] } },
      { id: "c" },
    ];
    expect(newestAccount(projects)?.provider).toBe("bedrock");
    expect(factsFor(projects, "b")?.skills).toEqual(["b"]);
    expect(factsFor(projects, "c")?.skills).toEqual(["a"]);
    expect(factsFor([{ id: "c" }], "c")).toBeNull();
  });
});

describe("D60: a project with variables answers for itself alone (ModelList.kept's rule)", () => {
  const P = PROJECT;
  const Q = OTHER;
  const R = "rrrrrrrrrr";
  const own = (id: string) => id === P;
  /** The environments' variables: P has one that changes the provider. */
  const envOf = (): EnvBook => ({
    vars: (id) => (own(id) ? [{ name: "CLAUDE_CODE_USE_BEDROCK", value: "1" }] : []),
    view: (id) => ({ vars: own(id) ? [{ name: "CLAUDE_CODE_USE_BEDROCK", at: "2026-11-03T08:00:00.000Z" }] : [], unreadable: false }),
    count: (id) => (own(id) ? 1 : 0),
    change: async () => ({ ok: true, changed: false }),
  });
  const at = (h: number) => `2026-11-03T${String(h).padStart(2, "0")}:00:00.000Z`;
  const kept = () => [
    { ...projectRecord(P, CWD), account: { at: at(12), provider: "bedrock" }, facts: { at: at(12), ...FACTS, skills: ["p-skill"] } },
    { ...projectRecord(Q, CWD2), account: { at: at(10), provider: "firstParty" }, facts: { at: at(10), ...FACTS, skills: ["q-skill"] } },
    projectRecord(R, "/srv/work/third"),
  ];

  test("newestAccount and factsFor: the host and a project with none take the newest of the projects with none; a project with variables only its own", () => {
    const projects = kept();
    expect([null, Q, R, P].map((id) => newestAccount(projects, id, own)?.provider ?? null)).toEqual(["firstParty", "firstParty", "firstParty", "bedrock"]);
    expect([null, Q, R, P].map((id) => factsFor(projects, id, own)?.skills ?? null)).toEqual([["q-skill"], ["q-skill"], ["q-skill"], ["p-skill"]]);
    const bare = projects.map((p) => (p.id === P ? projectRecord(P, CWD) : p));
    expect([newestAccount(bare, P, own), factsFor(bare, P, own)]).toEqual([null, null]);
  });

  test("GET /api/settings with no chat live: the host's Settings and ?project= of one with none never name the provider of the one with variables", async () => {
    const store = new MemoryStore();
    store.projects = kept();
    const env = envOf();
    const reg = boot(store, new FakeDriver(), env);
    await reg.boot();
    const read = settingsApi(store, reg, env);
    const host = await read();
    expect([host.account, host.facts?.skills]).toEqual([{ at: at(10), provider: "firstParty" }, ["q-skill"]]);
    const third = await read(R);
    expect([third.account, third.facts?.skills]).toEqual([{ at: at(10), provider: "firstParty" }, ["q-skill"]]);
    const mine = await read(P);
    expect([mine.account, mine.facts?.skills]).toEqual([{ at: at(12), provider: "bedrock" }, ["p-skill"]]);
    await reg.shutdown();
  });

  test("with a chat live: one in the project with variables answers for that project only", async () => {
    const store = new MemoryStore();
    store.projects = [projectRecord(P, CWD), projectRecord(Q, CWD2)];
    const driver = new FakeDriver();
    const env = envOf();
    const reg = boot(store, driver, env);
    await reg.boot();
    const read = settingsApi(store, reg, env);
    const { c } = await liveChat(reg, driver, P);
    c.provider = "bedrock";
    expect([(await read()).account, (await read(Q)).account, (await read(P)).account]).toEqual([null, null, { provider: "bedrock", at: null }]);
    const { c: d } = await liveChat(reg, driver, Q);
    d.provider = "firstParty";
    expect([(await read()).account, (await read(Q)).account, (await read(P)).account]).toEqual([
      { provider: "firstParty", at: null },
      { provider: "firstParty", at: null },
      { provider: "bedrock", at: null },
    ]);
    await reg.shutdown();
  });
});
