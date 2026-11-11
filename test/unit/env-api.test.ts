// D60's API (build checklist E5, E7; R-env 5.8): GET /api/projects/:project/env answers names only, with `inSettings`
// and `unreadable`; POST takes {set, remove, discardUnreadable?}, checked whole, nothing written on any problem, each
// refused line by its index and a fixed code. The sender gate guards the POST, the read guard the GET. Every answer is
// grepped for a planted value: none holds it, nor its length. No server is started: the handler is called.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PUBLIC_ADAPTERS } from "../../server/adapters/adapters";
import type { AgentDriver, BinaryProbe } from "../../server/agents/types";
import { createEnvStore } from "../../server/env/store";
import { createGate } from "../../server/gate/guards";
import { ModelList } from "../../server/chats/models";
import { API_ROUTE_PATTERNS, createApi, type ApiDeps } from "../../server/http/api";
import { createApp, type Upgrader } from "../../server/http/app";
import { loadSite } from "../../server/http/static";
import { createStore } from "../../server/store/store";
import { SETTINGS_DEFAULTS, type ProjectRecord, type Settings } from "../../server/store/types";

const PORT = 7942;
const OWN = `http://127.0.0.1:${PORT}`;
const PROJECT = "k3m7q2x4ab";
const OTHER = "a2b3c4d5e6";
const SECRET = "planted-env-api-value-W8q";
const ROUTE = `/api/projects/${PROJECT}/env`;
const root = mkdtempSync(join(tmpdir(), "kitespan-env-api-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const work = realpathSync(root);

const PROBE: BinaryProbe = { ok: true, path: "/opt/bin/claude", realpath: "/opt/bin/claude", version: "2.1.317", source: "path", refused: [], platformPackages: [], drift: null, belowMinimum: null };
const noServer: Upgrader = { upgrade: () => false };
/** Every answer's text, for the grep at the end. */
const answers: string[] = [];

function projectsStore(projects: ProjectRecord[]) {
  return {
    projects,
    async listProjects() {
      return projects.map((p) => structuredClone(p));
    },
    async putProject(rec: ProjectRecord) {
      const i = projects.findIndex((p) => p.id === rec.id);
      if (i >= 0) projects[i] = structuredClone(rec);
      else projects.push(structuredClone(rec));
    },
    async readSettings(): Promise<Settings> {
      return { ...SETTINGS_DEFAULTS };
    },
    async readChat() {
      return null;
    },
    async listUploads() {
      return [];
    },
    async putUpload() {},
    async removeUpload() {
      return null;
    },
  };
}

const project = (id: string, cwd: string): ProjectRecord => ({
  id,
  cwd,
  name: "work",
  createdAt: "2026-11-01T08:00:00.000Z",
  lastUsedAt: "2026-11-01T09:00:00.000Z",
  picks: { model: null, effort: null, permissionMode: null },
  models: { at: "2026-11-03T08:00:00.000Z", list: [{ value: "default", displayName: "Default", description: "", efforts: [], supportsAutoMode: false }] },
});

async function setup(dir = mkdtempSync(join(work, "state-")), extra: Partial<ApiDeps> = {}) {
  const state = createStore({ root: dir });
  await state.open();
  const env = createEnvStore({ dir: state.dirs.env, now: () => new Date("2026-11-03T12:00:00.000Z") });
  await env.open();
  const store = projectsStore([project(PROJECT, work), project(OTHER, join(work, "other"))]);
  const logs: unknown[] = [];
  const driver: Pick<AgentDriver, "probe" | "settings" | "listSessions" | "history" | "sessionInfo" | "settingsEnvNames"> = {
    probe: async () => PROBE,
    settings: async () => ({ respondToBash: true, cleanupPeriodDays: null, promptSuggestions: false, defaultMode: null }),
    listSessions: async () => [],
    sessionInfo: async () => null,
    history: async () => ({ events: [], more: null }),
    settingsEnvNames: async () => ["IN_SETTINGS"],
  };
  const gate = createGate(PORT, []);
  const site = loadSite(join(dir, "no-dist"), gate.origins);
  const api = createApi({
    gate,
    safe: site.safe,
    store,
    driver,
    env,
    uploadFolder: async () => ({ ok: true, path: "/tmp/x", choice: "temp" }),
    chatForSession: () => null,
    heldSessions: () => new Set(),
    info: { port: PORT, version: "0.1.0", adapters: PUBLIC_ADAPTERS },
    logger: { log: (ev, fields) => void logs.push({ ev, ...fields }) },
    ...extra,
  });
  const app = createApp({ gate, site, api, sockets: {} });
  return { app, env, store, dir, state, logs };
}

async function call(app: Awaited<ReturnType<typeof setup>>["app"], path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: any }> {
  const req = new Request(`${OWN}${path}`, { method: init.method ?? "GET", headers: { host: `127.0.0.1:${PORT}`, ...init.headers }, body: init.body });
  const res = (await app.fetch(req, noServer))!;
  const text = await res.text();
  answers.push(text);
  return { status: res.status, body: res.headers.get("content-type")?.includes("json") && text ? JSON.parse(text) : text };
}
const SENDER = { "x-kitespan": "1", "content-type": "application/json", origin: OWN };
const post = (app: Awaited<ReturnType<typeof setup>>["app"], body: unknown, path = ROUTE) => call(app, path, { method: "POST", headers: SENDER, body: JSON.stringify(body) });

describe("GET and POST /api/projects/:project/env (E5)", () => {
  test("the route is in the table; a project with no variables reads as none", async () => {
    expect(API_ROUTE_PATTERNS as readonly string[]).toContain("/api/projects/:project/env");
    const { app } = await setup();
    expect(await call(app, ROUTE)).toEqual({ status: 200, body: { vars: [], unreadable: false } });
    expect((await call(app, "/api/projects/zzzzzzzzzz/env")).status).toBe(404);
  });

  test("a save answers names, times and inSettings, never a value or its length; GET answers the same; the count shows in the project", async () => {
    const { app, env } = await setup();
    const r = await post(app, { set: [{ name: "MY_TOKEN", value: SECRET }, { name: "IN_SETTINGS", value: "x" }], remove: [] });
    expect(r).toEqual({
      status: 200,
      body: {
        vars: [
          { name: "MY_TOKEN", at: "2026-11-03T12:00:00.000Z", inSettings: false },
          { name: "IN_SETTINGS", at: "2026-11-03T12:00:00.000Z", inSettings: true },
        ],
        unreadable: false,
      },
    });
    expect(await call(app, ROUTE)).toEqual(r);
    expect(env.vars(PROJECT)).toEqual([
      { name: "MY_TOKEN", value: SECRET },
      { name: "IN_SETTINGS", value: "x" },
    ]);
    const projects = (await call(app, "/api/projects")).body.projects as { id: string; env: number }[];
    expect(projects.find((p) => p.id === PROJECT)!.env).toBe(2);
    expect(projects.find((p) => p.id === OTHER)!.env).toBe(0);
    // Remove takes a name; the set is checked whole.
    expect((await post(app, { set: [], remove: ["IN_SETTINGS"] })).body.vars.map((v: { name: string }) => v.name)).toEqual(["MY_TOKEN"]);
  });

  test("a refused line: 400 with each line's index and fixed code, never the value; nothing is written", async () => {
    const { app, env } = await setup();
    await post(app, { set: [{ name: "KEPT", value: "1" }], remove: [] });
    const r = await post(app, { set: [{ name: "GOOD", value: SECRET }, { name: "path", value: SECRET }, { name: "GOOD", value: SECRET }, { name: "X", value: `${SECRET}\n` }], remove: ["KEPT"] });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({
      error: {
        code: "bad_request",
        message: "The variables were not saved.",
        lines: [
          { i: 1, why: "path" },
          { i: 2, why: "twice" },
          { i: 3, why: "bad_char" },
        ],
      },
    });
    expect(env.vars(PROJECT)).toEqual([{ name: "KEPT", value: "1" }]);
    const big = Array.from({ length: 101 }, (_, i) => ({ name: `V${i}`, value: "1" }));
    expect((await post(app, { set: big, remove: [] })).body.error.lines).toEqual([{ i: -1, why: "too_many" }]);
  });

  test("a body of the wrong shape, or over 160 KiB, is a plain 400", async () => {
    const { app, env } = await setup();
    for (const body of [null, [], { set: "A=1" }, { set: [{ name: "A" }] }, { set: [["A", "1"]] }, { remove: [5] }, { set: [], remove: [], discardUnreadable: "yes" }, { set: [{ name: "A", value: "1", extra: SECRET }] }]) {
      const r = await post(app, body);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("bad_request");
      expect(r.body.error.lines).toBeUndefined();
    }
    const huge = await post(app, { set: [{ name: "A", value: "x".repeat(170 * 1024) }], remove: [] });
    expect(huge.status).toBe(400);
    expect(env.vars(PROJECT)).toEqual([]);
  });

  test("the sender gate guards the POST, and the read guard the GET; a path names no variable", async () => {
    const { app, env } = await setup();
    expect((await call(app, ROUTE, { method: "POST", headers: { "content-type": "application/json", origin: OWN }, body: JSON.stringify({ set: [{ name: "A", value: SECRET }], remove: [] }) })).status).toBe(403);
    expect((await call(app, ROUTE, { method: "POST", headers: { ...SENDER, origin: "https://elsewhere.example" }, body: JSON.stringify({ set: [{ name: "A", value: SECRET }], remove: [] }) })).status).toBe(403);
    expect((await call(app, ROUTE, { headers: { origin: "https://elsewhere.example" } })).status).toBe(403);
    expect(env.vars(PROJECT)).toEqual([]);
    expect((await call(app, `${ROUTE}/A`)).status).toBe(404);
  });

  test("an unreadable file: GET says so; Remove (discardUnreadable) clears it", async () => {
    const first = await setup();
    writeFileSync(join(first.state.dirs.env, `${PROJECT}.json`), "{ broken", { mode: 0o600 });
    const { app, env } = await setup(first.dir);
    expect(env.vars(PROJECT)).toBeNull();
    expect((await call(app, ROUTE)).body).toEqual({ vars: [], unreadable: true });
    // The project view says so too, so its Environment row is not "None" while every start there is refused.
    const views = () => call(app, "/api/projects").then((r) => r.body.projects as { id: string; env: number; envUnreadable?: true }[]);
    expect((await views()).find((p) => p.id === PROJECT)).toMatchObject({ env: 0, envUnreadable: true });
    expect("envUnreadable" in (await views()).find((p) => p.id === OTHER)!).toBe(false);
    expect((await post(app, { set: [], remove: [], discardUnreadable: true })).body).toEqual({ vars: [], unreadable: false });
    expect(readdirSync(first.state.dirs.env)).toEqual([]);
    expect("envUnreadable" in (await views()).find((p) => p.id === PROJECT)!).toBe(false);
  });

  test("a change drops the project's kept model list (L37: its own list is read again); a save that changes nothing keeps it", async () => {
    const { app, store } = await setup();
    await post(app, { set: [{ name: "ANTHROPIC_BASE_URL", value: "https://models.example" }], remove: [] });
    expect(store.projects.find((p) => p.id === PROJECT)!.models).toBeUndefined();
    expect(store.projects.find((p) => p.id === OTHER)!.models).toBeDefined();
    store.projects[0]!.models = project(PROJECT, work).models;
    await post(app, { set: [], remove: ["NOT_SAVED"] });
    expect(store.projects.find((p) => p.id === PROJECT)!.models).toBeDefined();
  });

  test("a change drops all that the project kept under its old variables (the model list, the context windows, the provider, the start facts) and tells the model lists; a save that changes nothing keeps them", async () => {
    const told: string[] = [];
    const forgot: string[] = [];
    const store0 = projectsStore([]);
    const modelList = new ModelList({ store: store0, read: null });
    modelList.forget = (p: string) => void forgot.push(p);
    const { app, store } = await setup(undefined, { modelList, envChanged: (p: string) => void told.push(p) });
    const keptBefore = {
      contextWindows: { default: 200_000 },
      account: { at: "2026-11-03T11:00:00.000Z", provider: "firstParty" },
      facts: { at: "2026-11-03T11:00:00.000Z", fastMode: { state: "on" as const, reason: null }, skills: [], plugins: [], outputStyle: null },
    };
    for (const p of store.projects) Object.assign(p, keptBefore);
    const kept = (id: string) => {
      const p = store.projects.find((x) => x.id === id)!;
      return { models: p.models !== undefined, contextWindows: p.contextWindows ?? null, account: p.account ?? null, facts: p.facts !== undefined };
    };
    await post(app, { set: [{ name: "CLAUDE_CODE_USE_BEDROCK", value: "1" }], remove: [] });
    expect(kept(PROJECT)).toEqual({ models: false, contextWindows: null, account: null, facts: false });
    expect(kept(OTHER)).toEqual({ models: true, contextWindows: keptBefore.contextWindows, account: keptBefore.account, facts: true });
    expect([told, forgot]).toEqual([[PROJECT], [PROJECT]]);
    Object.assign(store.projects[0]!, keptBefore);
    await post(app, { set: [{ name: "CLAUDE_CODE_USE_BEDROCK", value: "1" }], remove: ["NOT_SAVED"] });
    expect(kept(PROJECT)).toEqual({ models: false, contextWindows: keptBefore.contextWindows, account: keptBefore.account, facts: true });
    expect([told, forgot]).toEqual([[PROJECT], [PROJECT]]);
  });

  test("a failed write is a 500 with a fixed line, and one log line with the code and the route only", async () => {
    const { app, state, logs } = await setup();
    rmdirSync(state.dirs.env);
    const r = await post(app, { set: [{ name: "A", value: SECRET }], remove: [] });
    expect(r.status).toBe(500);
    expect(logs).toEqual([{ ev: "error", route: "/api/projects/:project/env", err: "store_write" }]);
    expect(existsSync(state.dirs.env)).toBe(false);
  });
});

describe("no answer holds the value (E5, E7)", () => {
  // The exact shapes above hold no length either.
  test("every answer above", () => {
    expect(answers.length).toBeGreaterThan(20);
    for (const a of answers) expect(a).not.toContain(SECRET);
  });
});
