// The restart's HTTP routes (DESIGN.md 4.9, 4.10; build checklist S5, S6, S8, S12): GET /api/health answers the boot
// epoch only and passes the Host allowlist like every read; POST /api/restart passes the sender gate, runs the
// preflight first (a refusal is one line and starts nothing), then asks the registry for its drain and answers 202 at
// once; GET /api/restart gives About's lines and the panes that run a program; Cancel restart. And the bind that
// waits for a port that the old server still holds. No server is started for the routes: the handler is called.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PUBLIC_ADAPTERS } from "../../server/adapters/adapters";
import type { AgentDriver } from "../../server/agents/types";
import { createGate } from "../../server/gate/guards";
import { createApi, type RestartDeps } from "../../server/http/api";
import { createApp, logRouteOf, type Upgrader } from "../../server/http/app";
import type { RestartReply, RestartWhen } from "../../server/http/api-types";
import { listenWithWait } from "../../server/http/listen";
import { loadSite } from "../../server/http/static";
import { SETTINGS_DEFAULTS } from "../../server/store/types";
import { createUpdateJobs } from "../../server/update/job";
import type { UpdateSource } from "../../server/update/source";

const PORT = 7944;
const OWN = `http://127.0.0.1:${PORT}`;
const EPOCH = "e-0123456789abcdef";
const SENDER: Record<string, string> = { "x-kitespan": "1", "content-type": "application/json", origin: OWN };
const noServer: Upgrader = { upgrade: () => false };

const driver: Pick<AgentDriver, "probe" | "settings" | "listSessions" | "history" | "sessionInfo"> = {
  probe: async () => ({ ok: false, path: null, realpath: null, version: null, source: "path", refused: [], platformPackages: [], drift: null, belowMinimum: null }),
  settings: async () => ({ respondToBash: true, cleanupPeriodDays: null, promptSuggestions: false, defaultMode: null }),
  listSessions: async () => [],
  sessionInfo: async () => null,
  history: async () => ({ events: [], more: null }),
};

interface Calls {
  preflight: number;
  drains: RestartWhen[];
  undrains: number;
}

function makeApp(over: Partial<RestartDeps> = {}, withRestart = true) {
  const calls: Calls = { preflight: 0, drains: [], undrains: 0 };
  const restart: RestartDeps = {
    facts: async () => ({ update: "available", build: "apply" }),
    panes: () => [{ chat: "k3m7q2x4abk3m7q2x4ab", known: true }],
    preflight: async () => {
      calls.preflight++;
      return null;
    },
    drain: (when) => {
      calls.drains.push(when);
      return { ok: true };
    },
    undrain: () => {
      calls.undrains++;
      return true;
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
      readSettings: async () => ({ ...SETTINGS_DEFAULTS }),
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
    epoch: () => EPOCH,
    restart: withRestart ? restart : undefined,
  });
  return { app: createApp({ gate, site, api, sockets: {} }), calls };
}

async function call(app: ReturnType<typeof makeApp>["app"], path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
  const req = new Request(`${OWN}${path}`, { method: init.method ?? "GET", headers: { host: `127.0.0.1:${PORT}`, ...init.headers }, body: init.body });
  return (await app.fetch(req, noServer))!;
}
const post = (app: ReturnType<typeof makeApp>["app"], path: string, body: unknown, headers = SENDER) => call(app, path, { method: "POST", headers, body: JSON.stringify(body) });

describe("GET /api/health (S5)", () => {
  test("answers the boot epoch only", async () => {
    const { app } = makeApp();
    const r = await call(app, "/api/health");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ epoch: EPOCH });
    expect(r.headers.get("cache-control")).not.toBeNull();
  });

  test("a wrong Host is refused, as for every read (D52), and so is a foreign Origin", async () => {
    const { app } = makeApp();
    expect((await call(app, "/api/health", { headers: { host: "evil.example:7944" } })).status).toBe(403);
    expect((await call(app, "/api/health", { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await call(app, "/api/health", { headers: { origin: OWN } })).status).toBe(200);
  });

  test("its log line names the pattern", () => {
    expect(logRouteOf("/api/health")).toBe("/api/health");
    expect(logRouteOf("/api/restart")).toBe("/api/restart");
    expect(logRouteOf("/api/restart/cancel")).toBe("/api/restart/cancel");
  });
});

describe("POST /api/restart (S6, S8)", () => {
  test("no sender header, a plain-text body or a foreign Origin is refused, and nothing is asked of the registry", async () => {
    const { app, calls } = makeApp();
    const refused: Record<string, string>[] = [
      { "content-type": "application/json", origin: OWN },
      { "x-kitespan": "1", "content-type": "text/plain", origin: OWN },
      { "x-kitespan": "1", "content-type": "application/json", origin: "https://evil.example" },
      { "x-kitespan": "1", "content-type": "application/json" },
    ];
    for (const headers of refused) expect((await post(app, "/api/restart", { when: "now" }, headers)).status).toBe(403);
    expect(calls).toEqual({ preflight: 0, drains: [], undrains: 0 });
  });

  test("a good request runs the preflight, starts the drain and gets 202 at once", async () => {
    const { app, calls } = makeApp();
    const r = await post(app, "/api/restart", { when: "finish" });
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ when: "finish" });
    const now = await post(app, "/api/restart", { when: "now" });
    expect(now.status).toBe(202);
    expect(calls).toEqual({ preflight: 2, drains: ["finish", "now"], undrains: 0 });
  });

  test("a `when` that is not finish or now is a bad request", async () => {
    const { app, calls } = makeApp();
    for (const body of [{}, { when: "later" }, { when: 1 }, []]) expect((await post(app, "/api/restart", body)).status).toBe(400);
    expect(calls.drains).toEqual([]);
  });

  test("a failed preflight refuses with its one line and changes nothing", async () => {
    const line = "The update did not finish. Update again first.";
    const { app, calls } = makeApp({ preflight: async () => line });
    const r = await post(app, "/api/restart", { when: "now" });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: { code: "preflight", message: line } });
    expect(calls.drains).toEqual([]);
  });

  test("row 108: no update starts from the preflight's start to the drain's answer (the job reads `asking`)", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "kitespan-restart-ask-")));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, "logs"), { recursive: true, mode: 0o700 });
    let applied = 0;
    const source: UpdateSource = { check: async () => ({ kind: "none", failed: false }), refusal: async () => null, apply: () => (applied++, new Promise(() => {})) };
    let asks = 0;
    const jobs = createUpdateJobs({ source, state: dir, logs: join(dir, "logs"), restarting: () => asks > 0 });
    let pass!: () => void;
    const slow = new Promise<void>((r) => (pass = r));
    const { app, calls } = makeApp({
      asking: () => {
        asks++;
        let on = true;
        return () => {
          if (on) asks--;
          on = false;
        };
      },
      preflight: async () => {
        calls.preflight++;
        await slow;
        return null;
      },
    });
    const asked = post(app, "/api/restart", { when: "now" });
    for (let i = 0; i < 100 && calls.preflight === 0; i++) await Bun.sleep(2);
    expect(await jobs.start()).toEqual({ ok: false, refusal: "restarting", line: "kitespan is restarting." });
    pass();
    expect((await asked).status).toBe(202);
    expect(calls.drains).toEqual(["now"]);
    expect(applied).toBe(0);
    // The ask is over: the restart's own phase says from here (main.ts: restarter.active).
    expect(asks).toBe(0);
    // A refused preflight ends the ask too.
    const refused = makeApp({ asking: () => (asks++, () => void asks--), preflight: async () => "The update did not finish. Update again first." });
    expect((await post(refused.app, "/api/restart", { when: "now" })).status).toBe(409);
    expect(asks).toBe(0);
  });

  test("a drain that the registry refuses answers its code and fixed sentence", async () => {
    const { app } = makeApp({ drain: () => ({ ok: false, code: "restarting" }) });
    const r = await post(app, "/api/restart", { when: "finish" });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: { code: "restarting", message: "kitespan is restarting." } });
  });

  test("while a restart's close runs, an ask is that restart: 202 at once, with no preflight (which would replace the successor's server-out.log) and no new drain", async () => {
    let closing = true;
    const { app, calls } = makeApp({ closing: () => closing });
    const r = await post(app, "/api/restart", { when: "now" });
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ when: "now" });
    expect(calls).toEqual({ preflight: 0, drains: [], undrains: 0 });
    // A bad request is still one.
    expect((await post(app, "/api/restart", { when: "later" })).status).toBe(400);
    closing = false;
    expect((await post(app, "/api/restart", { when: "finish" })).status).toBe(202);
    expect(calls).toEqual({ preflight: 1, drains: ["finish"], undrains: 0 });
  });

  test("two requests at once run one after the other", async () => {
    const order: string[] = [];
    let open = 0;
    const { app } = makeApp({
      preflight: async () => {
        open++;
        order.push(`start ${open}`);
        await Bun.sleep(30);
        open--;
        return null;
      },
    });
    const [a, b] = await Promise.all([post(app, "/api/restart", { when: "finish" }), post(app, "/api/restart", { when: "now" })]);
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(order).toEqual(["start 1", "start 1"]);
  });

  test("without a restart (a server that has none) the routes are not here", async () => {
    const { app } = makeApp({}, false);
    expect((await post(app, "/api/restart", { when: "now" })).status).toBe(404);
    expect((await call(app, "/api/restart")).status).toBe(404);
  });
});

describe("GET /api/restart and Cancel restart", () => {
  test("About's two lines and the panes that run a program, read now", async () => {
    const { app } = makeApp();
    const r = await call(app, "/api/restart");
    expect(r.status).toBe(200);
    expect((await r.json()) as RestartReply).toEqual({ update: "available", build: "apply", panes: [{ chat: "k3m7q2x4abk3m7q2x4ab", known: true }] });
  });

  test("Cancel restart passes the sender gate and asks the registry to undo the drain", async () => {
    const { app, calls } = makeApp();
    expect((await post(app, "/api/restart/cancel", {}, { "content-type": "application/json", origin: OWN })).status).toBe(403);
    const r = await post(app, "/api/restart/cancel", {});
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ cancelled: true });
    expect(calls.undrains).toBe(1);
  });
});

describe("the bind that waits (S12's --bind-wait)", () => {
  const serveOn = (port: number) => () => Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("new") });

  test("with no wait a busy port fails at once", async () => {
    const holder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("old") });
    try {
      const t0 = Date.now();
      await expect(listenWithWait(serveOn(holder.port!), 0)).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(Date.now() - t0).toBeLessThan(500);
    } finally {
      void holder.stop(true);
    }
  });

  test("with a wait it binds once the old listener lets the port go", async () => {
    const holder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("old") });
    const port = holder.port!;
    setTimeout(() => void holder.stop(true), 300);
    const server = await listenWithWait(serveOn(port), 5);
    try {
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("new");
    } finally {
      void server.stop(true);
    }
  });

  test("a wait that runs out throws the busy port's error", async () => {
    const holder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("old") });
    try {
      await expect(listenWithWait(serveOn(holder.port!), 1, 100)).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      void holder.stop(true);
    }
  });
});
