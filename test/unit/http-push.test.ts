// R130 (DESIGN-R130 4.4): the push routes of the JSON API. GET /api/push makes nothing (the key stays null before the
// first opt-in); POST /api/push/key makes the key once; a device turns on with its subscription and a name, and no
// answer ever holds its endpoint or its keys; a name or Show chat titles changes; Turn off removes it. Every POST passes
// the sender gate (guard 3) and the GET the Origin check (guard 10). The log has a `push_device` line per change and
// nothing of the device. No server is started: the handler is called, and the stub push service gives the receivers.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PUBLIC_ADAPTERS } from "../../server/adapters/adapters";
import type { AgentDriver, BinaryProbe } from "../../server/agents/types";
import { createGate } from "../../server/gate/guards";
import { API_ROUTE_PATTERNS, createApi } from "../../server/http/api";
import { createApp, type Upgrader } from "../../server/http/app";
import { loadSite } from "../../server/http/static";
import { createPush, type PushDeviceChange } from "../../server/push/service";
import { ownUid } from "../../server/store/files";
import { SETTINGS_DEFAULTS } from "../../server/store/types";
import { pushDeviceId } from "../../shared/push";
import { startPushStub } from "../click/push-stub";

const PORT = 7942;
const OWN = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), "kitespan-http-push-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const PROBE: BinaryProbe = { ok: true, path: "/opt/bin/claude", realpath: "/opt/bin/claude", version: "2.1.318", source: "path", refused: [], platformPackages: [], drift: null, belowMinimum: null };
const stub = startPushStub();

function makeApp(withPush = true) {
  const driver: Pick<AgentDriver, "probe" | "settings" | "listSessions" | "history" | "sessionInfo"> = {
    probe: async () => PROBE,
    settings: async () => ({ respondToBash: true, cleanupPeriodDays: 30, promptSuggestions: false, defaultMode: null }),
    listSessions: async () => [],
    sessionInfo: async () => null,
    history: async () => ({ events: [], more: null }),
  };
  const changes: PushDeviceChange[] = [];
  const state = mkdtempSync(join(dir, "state-"));
  const push = createPush({ dir: state, uid: ownUid(), testOrigin: stub.origin, log: { push: () => {}, gone: () => {}, device: (c) => changes.push(c) }, sender: { fetch: stub.fetch } });
  const gate = createGate(PORT, []);
  const site = loadSite(join(dir, "no-dist"), gate.origins);
  const api = createApi({
    gate,
    safe: site.safe,
    store: { listProjects: async () => [], putProject: async () => {}, readSettings: async () => ({ ...SETTINGS_DEFAULTS }), readChat: async () => null, listUploads: async () => [], putUpload: async () => {}, removeUpload: async () => null },
    driver,
    uploadFolder: async () => ({ ok: true, path: "/tmp/kitespan-uploads-x", choice: "temp" }),
    chatForSession: () => null,
    heldSessions: () => new Set(),
    info: { port: PORT, version: "0.1.0", adapters: { ...PUBLIC_ADAPTERS, origins: [] } },
    ...(withPush ? { push: push.api } : {}),
  });
  return { app: createApp({ gate, site, api, sockets: {} }), push, changes };
}

const noServer: Upgrader = { upgrade: () => false };
type App = ReturnType<typeof makeApp>["app"];

async function call(app: App, method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any; text: string }> {
  const init: RequestInit = {
    method,
    headers: { host: `127.0.0.1:${PORT}`, ...(method === "POST" ? { origin: OWN, "x-kitespan": "1", "content-type": "application/json" } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
  const res = (await app.fetch(new Request(`${OWN}${path}`, init), noServer))!;
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { status: res.status, body: parsed, text };
}

describe("the push routes", () => {
  test("they are the API's patterns", () => {
    for (const p of ["/api/push", "/api/push/key", "/api/push/devices", "/api/push/devices/:device", "/api/push/devices/:device/remove"]) expect((API_ROUTE_PATTERNS as readonly string[]).includes(p)).toBe(true);
  });

  test("the read makes nothing; the key comes at the first opt-in, once", async () => {
    const { app, push } = makeApp();
    expect(await call(app, "GET", "/api/push")).toMatchObject({ status: 200, body: { key: null, devices: [] } });
    expect(await push.store.key()).toBeNull();
    const made = await call(app, "POST", "/api/push/key", {});
    expect(made.status).toBe(200);
    expect(made.body.key).toMatch(/^B[A-Za-z0-9_-]{86}$/);
    expect((await call(app, "POST", "/api/push/key", {})).body.key).toBe(made.body.key);
    expect((await call(app, "GET", "/api/push")).body.key).toBe(made.body.key);
    // The private key never goes out.
    expect(made.text).not.toContain((await push.store.key())!.privateKey.d!);
  });

  test("a device turns on, then its name and titles change, then it turns off; no answer holds its endpoint or keys", async () => {
    const { app, changes } = makeApp();
    await call(app, "POST", "/api/push/key", {});
    const sub = stub.subscribe("laptop");
    const added = await call(app, "POST", "/api/push/devices", { subscription: { ...sub, expirationTime: null }, name: "Chrome" });
    expect(added.status).toBe(201);
    const id = await pushDeviceId(sub.endpoint);
    expect(added.body).toEqual({ device: { id, name: "Chrome", titles: false, at: expect.any(String), failing: false } });
    for (const secret of [sub.endpoint, "/push/laptop", sub.keys.p256dh, sub.keys.auth]) expect(added.text).not.toContain(secret);
    // The same endpoint again: 200, the same device.
    expect(await call(app, "POST", "/api/push/devices", { subscription: sub, name: "Chrome 2" })).toMatchObject({ status: 200, body: { device: { id, name: "Chrome" } } });
    expect(await call(app, "POST", `/api/push/devices/${id}`, { name: "  Work laptop " })).toMatchObject({ status: 200, body: { device: { name: "Work laptop" } } });
    expect(await call(app, "POST", `/api/push/devices/${id}`, { titles: true })).toMatchObject({ status: 200, body: { device: { titles: true } } });
    const list = await call(app, "GET", "/api/push");
    expect(list.body.devices).toEqual([{ id, name: "Work laptop", titles: true, at: expect.any(String), failing: false }]);
    for (const secret of [sub.endpoint, sub.keys.p256dh, sub.keys.auth]) expect(list.text).not.toContain(secret);
    expect(await call(app, "POST", `/api/push/devices/${id}/remove`, {})).toEqual({ status: 200, body: { removed: id }, text: expect.any(String) });
    expect(await call(app, "POST", `/api/push/devices/${id}/remove`, {})).toMatchObject({ status: 404, body: { error: { code: "not_found", message: "That device is not here." } } });
    expect(changes).toEqual(["added", "renamed", "removed"]);
  });

  test("the checks: no key yet, a bad name or subscription, a push service off the list, an unknown device, a bad change", async () => {
    const { app } = makeApp();
    const sub = stub.subscribe("phone");
    expect((await call(app, "POST", "/api/push/devices", { subscription: sub, name: "iPhone" })).status).toBe(400);
    await call(app, "POST", "/api/push/key", {});
    for (const name of ["", "x".repeat(41), 7, null]) expect((await call(app, "POST", "/api/push/devices", { subscription: sub, name })).body.error.code).toBe("bad_request");
    expect((await call(app, "POST", "/api/push/devices", { subscription: { endpoint: sub.endpoint }, name: "iPhone" })).body.error.code).toBe("bad_request");
    expect(await call(app, "POST", "/api/push/devices", { subscription: { ...sub, endpoint: "https://push.example.net/abc" }, name: "iPhone" })).toMatchObject({
      status: 400,
      body: { error: { code: "push_service", message: "kitespan does not send to this browser's push service." } },
    });
    expect((await call(app, "POST", "/api/push/devices", "nope")).status).toBe(400);
    expect((await call(app, "POST", "/api/push/devices/aaaaaaaaaaaaaaaa", { name: "x" })).status).toBe(404);
    const id = (await call(app, "POST", "/api/push/devices", { subscription: sub, name: "iPhone" })).body.device.id;
    for (const change of [{}, { titles: "yes" }, { name: "" }, []]) expect((await call(app, "POST", `/api/push/devices/${id}`, change)).status).toBe(400);
    // A device id is 16 characters of [a-z2-7]: anything else is not a route.
    expect((await call(app, "POST", "/api/push/devices/AAAA/remove", {})).body.error.message).toBe("There is no such kitespan API route.");
  });

  test("guard 3 on every POST, guard 10 on the read; no route without the push part", async () => {
    const { app, push } = makeApp();
    expect((await call(app, "POST", "/api/push/key", {}, { "x-kitespan": "0" })).status).toBe(403);
    expect((await call(app, "POST", "/api/push/key", {}, { origin: "https://evil.example" })).status).toBe(403);
    expect((await call(app, "POST", "/api/push/key", {}, { "content-type": "text/plain" })).status).toBe(403);
    expect(await push.store.key()).toBeNull();
    expect((await call(app, "GET", "/api/push", undefined, { origin: "https://evil.example" })).status).toBe(403);
    expect((await call(app, "GET", "/api/push", undefined, { host: "evil.example" })).status).toBe(403);
    const none = makeApp(false).app;
    expect((await call(none, "GET", "/api/push")).status).toBe(404);
  });
});
