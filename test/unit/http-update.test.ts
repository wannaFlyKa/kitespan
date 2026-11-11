// The update's HTTP routes (owner row 108; DESIGN.md 4.10, 4.9): GET /api/update gives About's update facts and
// changes nothing; POST /api/update passes the sender gate, starts the job (or joins the running one) and answers 202
// at once, or 409 `update_refused` with the refusal's one line; POST /api/update/check is Check now. And the setting
// Check for updates goes through POST /api/settings with the store's rule. No server is started: the handler is called.

import { describe, expect, test } from "bun:test";
import { PUBLIC_ADAPTERS } from "../../server/adapters/adapters";
import type { AgentDriver } from "../../server/agents/types";
import { createGate } from "../../server/gate/guards";
import { API_ROUTE_PATTERNS, createApi, type UpdateDeps } from "../../server/http/api";
import { createApp, logRouteOf, type Upgrader } from "../../server/http/app";
import type { UpdateReply } from "../../server/http/api-types";
import { loadSite } from "../../server/http/static";
import { settingOk, settingsFrom } from "../../server/store/records";
import { SETTINGS_DEFAULTS, type Settings } from "../../server/store/types";

const PORT = 7944;
const OWN = `http://127.0.0.1:${PORT}`;
const SENDER: Record<string, string> = { "x-kitespan": "1", "content-type": "application/json", origin: OWN };
const noServer: Upgrader = { upgrade: () => false };

const driver: Pick<AgentDriver, "probe" | "settings" | "listSessions" | "history" | "sessionInfo"> = {
  probe: async () => ({ ok: false, path: null, realpath: null, version: null, source: "path", refused: [], platformPackages: [], drift: null, belowMinimum: null }),
  settings: async () => ({ respondToBash: true, cleanupPeriodDays: null, promptSuggestions: false, defaultMode: null }),
  listSessions: async () => [],
  sessionInfo: async () => null,
  history: async () => ({ events: [], more: null }),
};

const FACTS: UpdateReply = { update: "available", build: "none", check: { at: "2026-11-04T07:00:00.000Z", ok: true, why: null, running: false }, job: { state: "idle" }, can: true, kind: "checkout", latest: null, next: null };

function makeApp(over: Partial<UpdateDeps> = {}) {
  const calls = { facts: 0, checks: 0, starts: 0, writes: [] as Partial<Settings>[] };
  let settings: Settings = { ...SETTINGS_DEFAULTS };
  const update: UpdateDeps = {
    facts: async () => {
      calls.facts++;
      return FACTS;
    },
    check: async () => {
      calls.checks++;
      return { ...FACTS, check: { ...FACTS.check, at: "2026-11-04T09:00:00.000Z" } };
    },
    start: async () => {
      calls.starts++;
      return { ok: true, job: { state: "running", step: "fetch" } };
    },
    ...over,
  };
  const gate = createGate(PORT);
  const site = loadSite("/nonexistent/kitespan-dist", gate.origins);
  const api = createApi({
    gate,
    safe: site.safe,
    store: {
      listProjects: async () => [],
      putProject: async () => {},
      readSettings: async () => settings,
      readChat: async () => null,
      listUploads: async () => [],
      putUpload: async () => {},
      removeUpload: async () => null,
    },
    driver,
    uploadFolder: async () => ({ ok: true, path: "/tmp/kitespan-uploads-x", choice: "temp" }),
    chatForSession: () => null,
    heldSessions: () => new Set(),
    info: { port: PORT, version: "0.1.0", adapters: PUBLIC_ADAPTERS },
    settingsWriter: {
      write: async (change) => {
        for (const [k, v] of Object.entries(change)) if (!settingOk(k, v)) throw new Error("bad value");
        calls.writes.push(change);
        settings = { ...settings, ...change } as Settings;
        return settings;
      },
      reload: async () => {},
    },
    update,
  });
  return { app: createApp({ gate, site, api, sockets: {} }), calls };
}

async function call(app: ReturnType<typeof makeApp>["app"], path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
  const req = new Request(`${OWN}${path}`, { method: init.method ?? "GET", headers: { host: `127.0.0.1:${PORT}`, ...init.headers }, body: init.body });
  return (await app.fetch(req, noServer))!;
}
const post = (app: ReturnType<typeof makeApp>["app"], path: string, body: unknown, headers = SENDER) => call(app, path, { method: "POST", headers, body: JSON.stringify(body) });

describe("the update routes (row 108)", () => {
  test("the patterns are the API's and the log's", () => {
    expect(API_ROUTE_PATTERNS).toContain("/api/update");
    expect(API_ROUTE_PATTERNS).toContain("/api/update/check");
    expect(logRouteOf("/api/update")).toBe("/api/update");
    expect(logRouteOf("/api/update/check")).toBe("/api/update/check");
  });

  test("GET /api/update gives About's facts and starts nothing", async () => {
    const { app, calls } = makeApp();
    const r = await call(app, "/api/update");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(FACTS);
    expect(calls).toMatchObject({ facts: 1, checks: 0, starts: 0 });
  });

  test("POST /api/update: behind the sender gate; 202 with the job; a refusal is 409 with its one line", async () => {
    const { app, calls } = makeApp();
    const refusedHeaders: Record<string, string>[] = [
      { "content-type": "application/json", origin: OWN },
      { "x-kitespan": "1", "content-type": "application/json", origin: "https://evil.example" },
      { "x-kitespan": "1", "content-type": "text/plain", origin: OWN },
    ];
    for (const headers of refusedHeaders) expect((await post(app, "/api/update", {}, headers)).status).toBe(403);
    expect(calls.starts).toBe(0);
    const r = await post(app, "/api/update", {});
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ job: { state: "running", step: "fetch" } });
    expect(calls.starts).toBe(1);
    const refused = makeApp({ start: async () => ({ ok: false, line: "This checkout has local changes." }) });
    const no = await post(refused.app, "/api/update", {});
    expect(no.status).toBe(409);
    expect(await no.json()).toEqual({ error: { code: "update_refused", message: "This checkout has local changes." } });
    expect((await call(app, "/api/update", { method: "DELETE", headers: SENDER })).status).toBe(405);
  });

  test("POST /api/update/check is Check now: one check, then the facts; never a GET", async () => {
    const { app, calls } = makeApp();
    expect((await call(app, "/api/update/check")).status).toBe(405);
    expect((await post(app, "/api/update/check", {}, { "content-type": "application/json", origin: OWN })).status).toBe(403);
    const r = await post(app, "/api/update/check", {});
    expect(r.status).toBe(200);
    expect(((await r.json()) as UpdateReply).check.at).toBe("2026-11-04T09:00:00.000Z");
    expect(calls.checks).toBe(1);
  });

  test("Check for updates: settings.json's `updates.check`, Daily by default; only Manually, Daily and Every 3 hours", async () => {
    expect(SETTINGS_DEFAULTS["updates.check"]).toBe("daily");
    for (const v of ["manual", "daily", "3h"]) expect(settingOk("updates.check", v)).toBe(true);
    for (const v of ["stable", "latest", "hourly", "", 3, null]) expect(settingOk("updates.check", v)).toBe(false);
    expect(settingsFrom({ "updates.check": "3h" })).toEqual({ "updates.check": "3h" });
    expect(() => settingsFrom({ "updates.check": "stable" })).toThrow();
    const { app, calls } = makeApp();
    const r = await post(app, "/api/settings", { "updates.check": "manual" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { settings: Record<string, unknown> }).settings["updates.check"]).toBe("manual");
    expect(calls.writes).toEqual([{ "updates.check": "manual" }]);
  });
});
