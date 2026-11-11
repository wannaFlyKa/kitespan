// The route table (DESIGN.md 4.6 "Serving", 4.9, 5.1 rule 1, D52): the page only for the app route families, built
// files with their cache headers and gzip, the 404 page, guard 9's headers on every answer, the Host allowlist on
// every request (a DNS-rebinding style Host reads nothing), the Origin check on reads, the sender gate on mutating
// routes, and the projects, sessions and settings reads of the JSON API. No server is started: the handler is called.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT_ID } from "../../shared/ids";
import { PUBLIC_ADAPTERS } from "../../server/adapters/adapters";
import type { AgentDriver, BinaryProbe } from "../../server/agents/types";
import { createGate } from "../../server/gate/guards";
import { createApi } from "../../server/http/api";
import { createApp, logRouteOf, type Upgrader } from "../../server/http/app";
import { IMMUTABLE, loadSite } from "../../server/http/static";
import { SETTINGS_DEFAULTS, type ChatLedger, type ProjectRecord, type Settings, type UploadRecord } from "../../server/store/types";

const PORT = 7943;
const OWN = `http://127.0.0.1:${PORT}`;
const ADAPTER = "https://forward.example.com";
const CHAT = "k3m7q2x4abk3m7q2x4ab";
const PROJECT = "k3m7q2x4ab";
const SESSION_A = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const SESSION_B = "0b1e2a3c-4d5e-4f60-8172-93a4b5c6d7e8";
const INLINE = "document.documentElement.dataset.look='glass'";

const dir = mkdtempSync(join(tmpdir(), "kitespan-http-"));
const dist = join(dir, "dist");
const work = join(dir, "work");
const JS = "console.log('kitespan');\n".repeat(200);

const noServer: Upgrader = { upgrade: () => false };

function fakeStore(projects: ProjectRecord[] = [], chats: ChatLedger[] = []) {
  const uploads: UploadRecord[] = [];
  return {
    projects,
    async listProjects() {
      return projects.map((p) => structuredClone(p));
    },
    async putProject(rec: ProjectRecord) {
      const i = projects.findIndex((p) => p.id === rec.id);
      if (i >= 0) projects[i] = rec;
      else projects.push(rec);
    },
    async readSettings(): Promise<Settings> {
      return { ...SETTINGS_DEFAULTS };
    },
    async readChat(id: string) {
      return chats.find((c) => c.id === id) ?? null;
    },
    async listUploads(chat: string | null) {
      return uploads.filter((u) => u.chat === chat);
    },
    async putUpload(rec: UploadRecord) {
      uploads.push(rec);
    },
    async removeUpload(id: string) {
      const i = uploads.findIndex((u) => u.id === id);
      return i >= 0 ? uploads.splice(i, 1)[0]! : null;
    },
  };
}

const PROBE: BinaryProbe = { ok: true, path: "/opt/bin/claude", realpath: "/opt/claude/2.1.311/claude", version: "2.1.311", source: "path", refused: [], platformPackages: [], drift: "Claude Code 2.1.311 runs here; this SDK was built for 2.1.312.", belowMinimum: null };

const driver: Pick<AgentDriver, "probe" | "settings" | "listSessions" | "history" | "sessionInfo"> = {
  probe: async () => PROBE,
  settings: async () => ({ respondToBash: true, cleanupPeriodDays: 30, promptSuggestions: false, defaultMode: null }),
  listSessions: async (cwd) => [
    { sessionId: SESSION_A, title: "Older", customTitle: null, lastModified: 1, cwd },
    { sessionId: SESSION_B, title: "Newer", customTitle: null, lastModified: 2, cwd },
    { sessionId: "11111111-2222-4333-8444-555555555555", title: "Has a chat", customTitle: null, lastModified: 3, cwd },
  ],
  sessionInfo: async (id, cwd) => (id === SESSION_A ? { sessionId: id, title: "Older", customTitle: null, lastModified: 1, cwd } : null),
  history: async (_id, _cwd, page) => ({ events: [], more: page.before === null ? "cursor-1" : null }),
};

function project(cwd: string): ProjectRecord {
  const marked = { value: "claude-haiku-5-5", mark: "remembered from the user's pick on 2026-10-30T08:00:00.000Z" };
  return { id: PROJECT, cwd, name: "work", createdAt: "2026-10-30T08:00:00Z", lastUsedAt: "2026-10-30T09:00:00Z", picks: { model: marked, effort: null, permissionMode: null } };
}

function makeApp(opts: { built?: boolean; store?: ReturnType<typeof fakeStore>; home?: string } = {}) {
  const gate = createGate(PORT, [ADAPTER]);
  const site = loadSite(opts.built === false ? join(dir, "nothing") : dist, gate.origins);
  const store = opts.store ?? fakeStore([project(realpathSync(work))]);
  const api = createApi({
    gate,
    safe: site.safe,
    store,
    driver,
    uploadFolder: async () => ({ ok: true, path: "/tmp/kitespan-uploads-x", choice: "temp" }),
    chatForSession: (id) => (id === "11111111-2222-4333-8444-555555555555" ? CHAT : null),
    heldSessions: () => new Set(["11111111-2222-4333-8444-555555555555"]),
    info: { port: PORT, version: "0.1.0", adapters: { ...PUBLIC_ADAPTERS, origins: [ADAPTER] } },
    home: opts.home,
  });
  return { app: createApp({ gate, site, api, sockets: {} }), store };
}

function request(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Request(`${OWN}${path}`, { method: init.method ?? "GET", headers: { host: `127.0.0.1:${PORT}`, ...init.headers }, body: init.body });
}

async function call(app: ReturnType<typeof makeApp>["app"], path: string, init: Parameters<typeof request>[1] = {}): Promise<Response> {
  return (await app.fetch(request(path, init), noServer))!;
}

const SENDER: Record<string, string> = { "x-kitespan": "1", "content-type": "application/json", origin: OWN };

/** A reply as plain JSON; each test checks the fields it needs. */
const json = async (r: Response): Promise<any> => r.json();

beforeAll(() => {
  mkdirSync(dist, { recursive: true });
  mkdirSync(work, { recursive: true });
  writeFileSync(
    join(dist, "index.html"),
    `<!doctype html><html><head><script>${INLINE}</script><link rel="stylesheet" href="/assets/index-fs0q8gwg.css"></head><body><script type="module" src="/assets/index-0ba8jk69.js"></script></body></html>`,
  );
  writeFileSync(join(dist, "index-0ba8jk69.js"), JS);
  writeFileSync(join(dist, "index-fs0q8gwg.css"), "body{margin:0}");
  writeFileSync(join(dist, "logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  writeFileSync(join(dist, "photo-a1b2c3d4.png"), new Uint8Array([137, 80, 78, 71]));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function expectSafe(res: Response) {
  expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("access-control-allow-origin")).toBe(null);
}

describe("built files", () => {
  test("a hashed name is immutable for a year; another name revalidates", async () => {
    const { app } = makeApp();
    const js = await call(app, "/assets/index-0ba8jk69.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("cache-control")).toBe(IMMUTABLE);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(await js.text()).toBe(JS);
    const svg = await call(app, "/assets/logo.svg");
    expect(svg.headers.get("cache-control")).toBe("no-cache");
    const png = await call(app, "/assets/photo-a1b2c3d4.png");
    expect(png.headers.get("cache-control")).toBe(IMMUTABLE);
    expect(png.headers.get("content-encoding")).toBe(null);
    expectSafe(js);
  });

  test("gzip when the browser accepts it, and only then", async () => {
    const { app } = makeApp();
    const gz = await call(app, "/assets/index-0ba8jk69.js", { headers: { "accept-encoding": "gzip, deflate, br" } });
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    expect(gz.headers.get("vary")).toBe("accept-encoding");
    const body = new Uint8Array(await gz.arrayBuffer());
    expect(body.length).toBeLessThan(JS.length);
    expect(new TextDecoder().decode(Bun.gunzipSync(body))).toBe(JS);
    for (const ae of ["gzip;q=0", "br", "identity", "*;q=0"]) {
      const plain = await call(app, "/assets/index-0ba8jk69.js", { headers: { "accept-encoding": ae } });
      expect(plain.headers.get("content-encoding")).toBe(null);
      expect(await plain.text()).toBe(JS);
    }
    const page = await call(app, "/c/" + CHAT, { headers: { "accept-encoding": "gzip" } });
    expect(page.headers.get("content-encoding")).toBe("gzip");
  });

  test("a missing or forbidden asset gets the 404 page, never the page", async () => {
    const { app } = makeApp();
    for (const p of ["/assets/missing-0ba8jk69.js", "/assets/index.html", "/assets/.hidden", "/assets/index-0ba8jk69.js.gz", "/assets/a%2F..%2Findex.html", "/assets/"]) {
      const res = await call(app, p);
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).toContain("There is no kitespan page at this address.");
      expect(text).not.toContain("type=\"module\"");
    }
  });
});

describe("the page and the 404 page", () => {
  test("every app route family gets the page, revalidated, with the inline script's hash in the policy", async () => {
    const { app } = makeApp();
    const hash = createHash("sha256").update(INLINE, "utf8").digest("base64");
    for (const p of ["/", "/new", "/chats", "/settings", "/settings/chats/live-max", `/c/${CHAT}`, `/c/${CHAT}/files/src/a.ts`, `/p/${PROJECT}`, "/search", "/browser"]) {
      const res = await call(app, p);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(res.headers.get("content-security-policy")).toContain(`'sha256-${hash}'`);
      // A CSP source has no IPv6 literal (Chrome ignores one with a console error); 'self' covers a page on [::1].
      expect(res.headers.get("content-security-policy")).toContain("connect-src 'self' ws://127.0.0.1:7943 ws://localhost:7943 wss://forward.example.com;");
      expect(res.headers.get("content-security-policy")).not.toContain("[");
      expect(await res.text()).toContain("/assets/index-0ba8jk69.js");
      expectSafe(res);
    }
  });

  test("paths outside the families get the 404 page with one link to Home and the user's look", async () => {
    const { app } = makeApp();
    for (const p of ["/c", "/p", "/favicon.ico", "/index.html", "/nope", "/ws/other", "/settingsx"]) {
      const res = await call(app, p);
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).toContain("There is no kitespan page at this address.");
      expect(text).toContain('<a href="/">Go to Home</a>');
      expect(text).toContain(INLINE);
      expect(text).toContain("/assets/index-fs0q8gwg.css");
      expectSafe(res);
    }
  });

  test("a method other than GET or HEAD outside /api/ gets 405, and OPTIONS gets no CORS answer", async () => {
    const { app } = makeApp();
    expect((await call(app, "/", { method: "POST", headers: SENDER, body: "{}" })).status).toBe(405);
    const opt = await call(app, "/api/projects", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    expect(opt.status).toBe(405);
    expect(opt.headers.get("access-control-allow-origin")).toBe(null);
    expect(opt.headers.get("access-control-allow-headers")).toBe(null);
  });

  test("before a build, an app path says how to build", async () => {
    const { app } = makeApp({ built: false });
    const res = await call(app, "/");
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("bun run build");
    expect((await call(app, "/nope")).status).toBe(404);
  });
});

describe("D52: the Host allowlist and the Origin check on reads", () => {
  test("a DNS-rebinding style Host reads nothing", async () => {
    const { app } = makeApp();
    for (const host of [`rebind.example:${PORT}`, `rebind.localhost:${PORT}`, `localhost:${PORT + 1}`, `127.0.0.1:${PORT + 1}`, "127.0.0.1"]) {
      for (const p of ["/api/projects", "/api/settings", `/api/chats/${CHAT}/files/a.txt`, "/", "/assets/index-0ba8jk69.js"]) {
        const res = await call(app, p, { headers: { host } });
        expect(res.status).toBe(403);
        expect(await res.text()).toBe("Forbidden\n");
        expectSafe(res);
      }
    }
  });

  test("the loopback host and an allowed origin's host read", async () => {
    const { app } = makeApp();
    expect((await call(app, "/api/projects")).status).toBe(200);
    expect((await call(app, "/api/projects", { headers: { host: "forward.example.com" } })).status).toBe(200);
  });

  test("a read with a foreign Origin is refused; none or an allowed one reads", async () => {
    const { app } = makeApp();
    expect((await call(app, "/api/projects", { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await call(app, "/api/projects", { headers: { origin: "null" } })).status).toBe(403);
    expect((await call(app, "/api/projects", { headers: { origin: ADAPTER } })).status).toBe(200);
    expect((await call(app, "/api/projects", { method: "HEAD", headers: { origin: "https://evil.example" } })).status).toBe(403);
  });
});

describe("guard 3 on the API", () => {
  test("each missing part of the sender gate gets 403 and changes nothing", async () => {
    const store = fakeStore([]);
    const { app } = makeApp({ store });
    const body = JSON.stringify({ cwd: work });
    const refused: Record<string, string>[] = [
      { "content-type": "application/json", origin: OWN },
      { "x-kitespan": "1", origin: OWN },
      { ...SENDER, "content-type": "text/plain" },
      { "x-kitespan": "1", "content-type": "application/json" },
      { ...SENDER, origin: "https://evil.example" },
      { ...SENDER, origin: `http://localhost:${PORT + 1}` },
    ];
    for (const headers of refused) {
      const res = await call(app, "/api/projects", { method: "POST", headers, body });
      expect(res.status).toBe(403);
    }
    expect(store.projects).toEqual([]);
    expect((await call(app, "/api/projects", { method: "POST", headers: SENDER, body })).status).toBe(201);
    expect(store.projects.length).toBe(1);
  });

  test("an unknown route is 404 and a wrong method is 405 with Allow", async () => {
    const { app } = makeApp();
    const nf = await call(app, "/api/nothing");
    expect(nf.status).toBe(404);
    expect((await json(nf)).error.code).toBe("not_found");
    const wrong = await call(app, "/api/uploads");
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("POST");
    expect((await call(app, "/api/projects/BAD/sessions")).status).toBe(404);
  });
});

describe("projects", () => {
  test("Add checks the folder on the server and keeps one project per real path", async () => {
    const store = fakeStore([]);
    const { app } = makeApp({ store });
    const add = (cwd: unknown) => call(app, "/api/projects", { method: "POST", headers: SENDER, body: JSON.stringify({ cwd }) });
    const first = await add(work);
    expect(first.status).toBe(201);
    const { project: p } = await json(first);
    expect(p.id).toMatch(PROJECT_ID);
    expect(p.cwd).toBe(realpathSync(work));
    expect(p.name).toBe("work");
    expect(p.picks).toEqual({ model: null, effort: null, permissionMode: null });
    symlinkSync(work, join(dir, "work-link"));
    const again = await add(join(dir, "work-link"));
    expect(again.status).toBe(200);
    expect((await json(again)).project.id).toBe(p.id);
    const [a, b] = await Promise.all([add(join(dir, "work-link")), add(work)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(store.projects.length).toBe(1);
    expect((await add("relative/path")).status).toBe(400);
    expect((await add(join(dir, "missing"))).status).toBe(404);
    expect((await add(join(dist, "index.html"))).status).toBe(404);
    expect((await add(42)).status).toBe(400);
    expect((await add(`${work}\u0007`)).status).toBe(400);
    expect((await call(app, "/api/projects", { method: "POST", headers: SENDER, body: "{" })).status).toBe(400);
  });

  test("a folder typed from the home folder (~/, as New environment's filter takes it) is that folder under the home", async () => {
    const store = fakeStore([]);
    const { app } = makeApp({ store, home: dir });
    const add = (cwd: unknown) => call(app, "/api/projects", { method: "POST", headers: SENDER, body: JSON.stringify({ cwd }) });
    const first = await add("~/work");
    expect(first.status).toBe(201);
    expect((await json(first)).project.cwd).toBe(realpathSync(work));
    expect((await add("~/missing")).status).toBe(404);
    // Only "~/" names the home folder: another user's (~name) and a bare "~" stay paths that are not absolute.
    expect((await add("~other/work")).status).toBe(400);
    expect((await add("~")).status).toBe(400);
    expect(store.projects.length).toBe(1);
  });

  test("a JSON body is read to 16 KiB and no further, with or without a Content-Length", async () => {
    const store = fakeStore([]);
    const { app } = makeApp({ store });
    // A chunked body (no Content-Length) of 1 MiB: valid JSON, so only the cap can refuse it.
    const chunk = new TextEncoder().encode(" ".repeat(4096));
    const head = new TextEncoder().encode(JSON.stringify({ cwd: work }).slice(0, -1));
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(head);
      },
      pull(c) {
        if (pulled >= 1024 * 1024) {
          c.enqueue(new TextEncoder().encode("}"));
          return c.close();
        }
        pulled += chunk.length;
        c.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const req = new Request(`${OWN}/api/projects`, { method: "POST", headers: { host: `127.0.0.1:${PORT}`, ...SENDER }, body, duplex: "half" } as RequestInit);
    expect(req.headers.get("content-length")).toBe(null);
    const res = (await app.fetch(req, noServer))!;
    expect(res.status).toBe(400);
    expect(pulled).toBeLessThanOrEqual(32 * 1024);
    expect(cancelled).toBe(true);
    expect(store.projects.length).toBe(0);
    // The cap counts bytes, not characters: 8,000 three-byte characters are 24,000 bytes.
    const wide = JSON.stringify({ cwd: work, pad: "€".repeat(8000) });
    expect(wide.length).toBeLessThan(16 * 1024);
    expect((await call(app, "/api/projects", { method: "POST", headers: SENDER, body: wide })).status).toBe(400);
    // A declared length over the cap is refused before a byte is read; a body at the cap is read.
    expect((await call(app, "/api/projects", { method: "POST", headers: { ...SENDER, "content-length": String(16 * 1024 + 1) }, body: "{}" })).status).toBe(400);
    const full = JSON.stringify({ cwd: work, pad: "" });
    const atCap = full.slice(0, -1) + " ".repeat(16 * 1024 - full.length) + "}";
    expect(new TextEncoder().encode(atCap).length).toBe(16 * 1024);
    expect((await call(app, "/api/projects", { method: "POST", headers: SENDER, body: atCap })).status).toBe(201);
    expect(store.projects.length).toBe(1);
  });

  test("the list shows the picks without their marks; Forget clears them", async () => {
    const { app } = makeApp();
    const list = await json(await call(app, "/api/projects"));
    expect(list.projects[0].picks).toEqual({ model: "claude-haiku-5-5", effort: null, permissionMode: null });
    expect(JSON.stringify(list)).not.toContain("remembered from");
    const forget = await call(app, `/api/projects/${PROJECT}/forget`, { method: "POST", headers: SENDER, body: "{}" });
    expect(forget.status).toBe(200);
    expect((await json(forget)).project.picks.model).toBe(null);
    expect((await call(app, `/api/projects/${"a".repeat(10)}/forget`, { method: "POST", headers: SENDER, body: "{}" })).status).toBe(404);
    expect((await call(app, `/api/projects/${PROJECT}/forget`)).status).toBe(405);
  });

  test("From the terminal leaves out a session that a chat has; the preview reads one page", async () => {
    const { app } = makeApp();
    const s = await json(await call(app, `/api/projects/${PROJECT}/sessions`));
    expect(s.sessions.map((x: { sessionId: string }) => x.sessionId)).toEqual([SESSION_B, SESSION_A]);
    const preview = await call(app, `/api/projects/${PROJECT}/sessions/${SESSION_A}`);
    expect(await json(preview)).toEqual({ history: [], more: "cursor-1", chat: null, copy: null });
    expect((await call(app, `/api/projects/${PROJECT}/sessions/${SESSION_B}`)).status).toBe(404);
    expect((await call(app, `/api/projects/${PROJECT}/sessions/${SESSION_A}?before=a%07b`)).status).toBe(400);
    expect((await json(await call(app, `/api/projects/${PROJECT}/sessions/${SESSION_A}?before=cursor-1`))).more).toBe(null);
  });
});

describe("settings reads", () => {
  test("kitespan's settings, the read-only server lines, the binary pin and the upload folder", async () => {
    const { app } = makeApp();
    const res = await call(app, "/api/settings");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const s = await json(res);
    expect(s.settings["uploads.maxMB"]).toBe(100);
    expect(s.server).toEqual({ host: "127.0.0.1", port: PORT, auth: "none", version: "0.1.0" });
    expect(s.access.origins).toEqual([ADAPTER]);
    expect(s.access.hint[0]).toBe(`kitespan listens on ${OWN}`);
    expect(s.claude).toEqual({ ok: true, path: PROBE.path, realpath: PROBE.realpath, version: "2.1.311", drift: PROBE.drift });
    expect(s.uploads).toEqual({ ok: true, path: "/tmp/kitespan-uploads-x" });
    expect(s.agent).toBe(null);
    const withProject = await json(await call(app, `/api/settings?project=${PROJECT}`));
    expect(withProject.agent).toEqual({ respondToBash: true, cleanupPeriodDays: 30, promptSuggestions: false, defaultMode: null });
  });

  test("a POST to settings is not a route (reads only)", async () => {
    const { app } = makeApp();
    expect((await call(app, "/api/settings", { method: "POST", headers: SENDER, body: "{}" })).status).toBe(405);
  });
});

test("a log line gets the route pattern, never the path", () => {
  expect(logRouteOf("/ws")).toBe("/ws");
  expect(logRouteOf(`/api/chats/${CHAT}/files/secret/plan.md`)).toBe("/api/chats/:chat/files/*");
  expect(logRouteOf(`/api/projects/${PROJECT}/sessions/${SESSION_A}`)).toBe("/api/projects/:project/sessions/:session");
  expect(logRouteOf(`/c/${CHAT}/files/secret/plan.md`)).toBe("/c/:chat/files/*");
  expect(logRouteOf("/assets/index-0ba8jk69.js")).toBe("/assets/*");
  expect(logRouteOf("/nope")).toBe(null);
});
