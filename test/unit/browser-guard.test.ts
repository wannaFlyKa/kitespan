// kitespan's own page never runs in the shared browser (DESIGN-B1 D-21, 2.16 points 10, 21 and 22, S1, 7.1, 7.2), and
// the pane's socket and routes keep the app's guards: the document rule over each Sec-Fetch-Site value and none, the
// shell's vary, /ws/browser's Origin and Sec-Fetch-Site refusals, the /api/browser routes behind the sender gate and
// the Sec-Fetch-Site rule, the settings route that never writes browser.enabled, the peer check against fake /proc
// tables and as the route table applies it, and the log lines, which never hold a URL. The handler is called; no
// server, no Chrome.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PUBLIC_ADAPTERS } from "../../server/adapters/adapters";
import type { AgentDriver } from "../../server/agents/types";
import { PeerCheck, SELF_REFUSED_TEXT, otherSite, selfRefused } from "../../server/browser/guard";
import type { ProcReader } from "../../server/browser/procfs";
import { createGate } from "../../server/gate/guards";
import { createApi, type BrowserApi } from "../../server/http/api";
import { createApp, type SocketRoute, type Upgrader } from "../../server/http/app";
import { loadSite } from "../../server/http/static";
import { BROWSER_LOG_ANSWERS, logLine } from "../../server/log";
import { SETTINGS_DEFAULTS, type Settings } from "../../server/store/types";
import type { BrowserReply } from "../../shared/browser";
import { ROUTE_PATTERNS } from "../../shared/route";

const PORT = 7945;
const OWN = `http://127.0.0.1:${PORT}`;
const FORWARD = "https://kite.example.net";
const dir = mkdtempSync(join(tmpdir(), "kbg-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
mkdirSync(join(dir, "dist"), { recursive: true });
writeFileSync(join(dir, "dist", "index.html"), "<!doctype html><html><head><script>window.shell=1</script></head><body>the shell</body></html>");

const REPLY: BrowserReply = { host: { state: "off", port: 9340, saved: 0 }, program: { path: null, from: null }, port: { value: 9340, from: "default" }, problem: null, profile: "/s/browser/profile", mcp: "claude mcp add ..." };

function makeApp(o: { shared?: boolean } = {}) {
  const gate = createGate(PORT, [FORWARD]);
  const site = loadSite(join(dir, "dist"), gate.origins);
  const calls: string[] = [];
  const written: Partial<Settings>[] = [];
  const browser: BrowserApi = {
    reply: () => REPLY,
    start: async () => (calls.push("start"), REPLY),
    stop: async () => (calls.push("stop"), REPLY),
    clear: async () => (calls.push("clear"), null),
    downloads: () => [],
    downloadFile: () => null,
    removeDownload: async () => false,
  };
  const api = createApi({
    gate,
    safe: site.safe,
    store: { listProjects: async () => [], putProject: async () => {}, readSettings: async () => ({ ...SETTINGS_DEFAULTS }), readChat: async () => null, listUploads: async () => [], putUpload: async () => {}, removeUpload: async () => null },
    driver: {} as Pick<AgentDriver, "probe" | "settings" | "listSessions" | "history" | "sessionInfo">,
    uploadFolder: async () => ({ ok: true, path: "/tmp/x", choice: "temp" }),
    chatForSession: () => null,
    heldSessions: () => new Set(),
    info: { port: PORT, version: "0.1.0", adapters: { ...PUBLIC_ADAPTERS, origins: [FORWARD] } },
    settingsWriter: {
      write: async (c) => {
        written.push(c);
        return { ...SETTINGS_DEFAULTS };
      },
      reload: async () => {},
    },
    browser,
  });
  const upgraded: string[] = [];
  const route = (name: string): SocketRoute => ({
    upgrade: () => (upgraded.push(name), undefined),
    websocket: { open: () => false, message: () => false, drain: () => false, close: () => false },
  });
  const app = createApp({ gate, site, api, sockets: { "/ws": route("/ws"), "/ws/browser": route("/ws/browser") }, peer: { shared: () => o.shared === true } });
  return { app, calls, written, upgraded };
}

const server: Upgrader = { upgrade: () => true, requestIP: () => ({ address: "127.0.0.1", port: 50_000 }) };
const req = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string; host?: string } = {}) =>
  new Request(`${OWN}${path}`, { method: init.method ?? "GET", headers: { host: init.host ?? `127.0.0.1:${PORT}`, ...init.headers }, body: init.body });
const SENDER = { "x-kitespan": "1", "content-type": "application/json", origin: OWN };

describe("the document rule (S1)", () => {
  test("every app path: 403 and the fixed page for cross-site and same-site; the shell for none, same-origin and no header", async () => {
    const { app } = makeApp();
    for (const path of ["/", "/c/k3m7q2x4abk3m7q2x4ab", "/browser", "/browser/q2x4abk3m7", "/settings/browser", "/c/k3m7q2x4abk3m7q2x4ab/browser?url=x"]) {
      for (const site of ["cross-site", "same-site"]) {
        const r = (await app.fetch(req(path, { headers: { "sec-fetch-site": site, "sec-fetch-dest": "document" } }), server))!;
        expect([path, site, r.status]).toEqual([path, site, 403]);
        const body = await r.text();
        expect(body).toContain(SELF_REFUSED_TEXT);
        expect(body).not.toContain("<script");
        expect(body).not.toContain("<a ");
        expect(body).not.toContain("href");
        expect(r.headers.get("content-security-policy")).toBe("default-src 'none'");
        expect(r.headers.get("cache-control")).toBe("no-store");
      }
      for (const site of ["none", "same-origin", null]) {
        const r = (await app.fetch(req(path, { headers: site ? { "sec-fetch-site": site } : {} }), server))!;
        expect([path, site, r.status]).toEqual([path, site, 200]);
        expect(await r.text()).toContain("the shell");
        expect(r.headers.get("vary")).toBe("accept-encoding, sec-fetch-site");
      }
    }
  });
  test("a HEAD gets the refusal with no body; the rule reads the header only", () => {
    const head = selfRefused(true);
    expect(head.status).toBe(403);
    expect(otherSite(new Request("http://x/", { headers: { "sec-fetch-site": "cross-site" } }))).toBe(true);
    expect(otherSite(new Request("http://x/", { headers: { "sec-fetch-site": "CROSS-SITE" } }))).toBe(false);
  });
});

describe("/ws/browser before its upgrade (DESIGN-B1 3.1)", () => {
  test("no Origin, null, a foreign Origin, cross-site and same-site are refused; kitespan's own and the forward's pass", async () => {
    const { app, upgraded } = makeApp();
    const up = (headers: Record<string, string>, host?: string) => app.fetch(req("/ws/browser", { headers, host }), server);
    const refused: Record<string, string>[] = [{}, { origin: "null" }, { origin: "https://evil.example" }, { origin: "http://127.0.0.1:7946" }, { origin: OWN, "sec-fetch-site": "cross-site" }, { origin: OWN, "sec-fetch-site": "same-site" }];
    for (const h of refused) {
      expect([h, (await up(h))!.status]).toEqual([h, 403]);
    }
    expect(upgraded).toEqual([]);
    expect(await up({ origin: OWN, "sec-fetch-site": "same-origin" })).toBeUndefined();
    expect(await up({ origin: FORWARD }, "kite.example.net")).toBeUndefined();
    expect(upgraded).toEqual(["/ws/browser", "/ws/browser"]);
    expect((await app.fetch(req("/ws/browser", { method: "POST", headers: { origin: OWN } }), server))!.status).toBe(405);
  });
});

describe("the /api/browser routes (DESIGN-B1 3.9)", () => {
  test("reads pass with no Origin or kitespan's own; Sec-Fetch-Site cross-site and same-site are refused on every route", async () => {
    const { app, calls } = makeApp();
    expect((await app.fetch(req("/api/browser"), server))!.status).toBe(200);
    expect(await (await app.fetch(req("/api/browser"), server))!.json()).toEqual(REPLY);
    for (const path of ["/api/browser", "/api/browser/downloads", "/api/browser/downloads/abcdefghijk23456/file"]) {
      for (const site of ["cross-site", "same-site"]) expect([path, site, (await app.fetch(req(path, { headers: { "sec-fetch-site": site } }), server))!.status]).toEqual([path, site, 403]);
    }
    for (const path of ["/api/browser/start", "/api/browser/stop", "/api/browser/clear", "/api/browser/downloads/abcdefghijk23456/remove"]) {
      expect((await app.fetch(req(path, { method: "POST", headers: { ...SENDER, "sec-fetch-site": "same-site" }, body: "{}" }), server))!.status).toBe(403);
    }
    expect(calls).toEqual([]);
  });
  test("every POST behind the sender gate: the header, the JSON type and an allowed Origin", async () => {
    const { app, calls } = makeApp();
    const post = (path: string, headers: Record<string, string>) => app.fetch(req(path, { method: "POST", headers, body: "{}" }), server);
    const refused: Record<string, string>[] = [{ "content-type": "application/json", origin: OWN }, { "x-kitespan": "1", "content-type": "text/plain", origin: OWN }, { "x-kitespan": "1", "content-type": "application/json" }, { "x-kitespan": "1", "content-type": "application/json", origin: "https://evil.example" }];
    for (const h of refused) {
      expect((await post("/api/browser/start", h))!.status).toBe(403);
    }
    expect(calls).toEqual([]);
    expect((await post("/api/browser/start", SENDER))!.status).toBe(200);
    expect((await post("/api/browser/stop", { ...SENDER, "sec-fetch-site": "same-origin" }))!.status).toBe(200);
    const clear = (await post("/api/browser/clear", SENDER))!;
    expect(clear.status).toBe(409);
    expect(await clear.json()).toEqual({ error: { code: "browser_running", message: "The browser did not stop, so nothing was cleared." } });
    expect(calls).toEqual(["start", "stop", "clear"]);
    expect((await app.fetch(req("/api/browser/downloads/bad/file"), server))!.status).toBe(404);
  });
  test("the settings route never writes browser.enabled", async () => {
    const { app, written } = makeApp();
    const r = (await app.fetch(req("/api/settings", { method: "POST", headers: SENDER, body: JSON.stringify({ "browser.enabled": true }) }), server))!;
    expect(r.status).toBe(400);
    expect(written).toEqual([]);
  });
});

describe("the peer check (DESIGN-B1 2.16 point 10)", () => {
  test("from the shared browser: the shell, every upgrade and every mutating request get 403; reads and assets do not", async () => {
    const { app, upgraded, calls } = makeApp({ shared: true });
    expect((await app.fetch(req("/"), server))!.status).toBe(403);
    expect(await (await app.fetch(req("/c/k3m7q2x4abk3m7q2x4ab"), server))!.text()).toContain(SELF_REFUSED_TEXT);
    expect((await app.fetch(req("/ws", { headers: { origin: OWN } }), server))!.status).toBe(403);
    expect((await app.fetch(req("/ws/browser", { headers: { origin: OWN } }), server))!.status).toBe(403);
    expect(upgraded).toEqual([]);
    expect((await app.fetch(req("/api/browser/stop", { method: "POST", headers: SENDER, body: "{}" }), server))!.status).toBe(403);
    expect((await app.fetch(req("/api/settings", { method: "POST", headers: SENDER, body: "{}" }), server))!.status).toBe(403);
    expect(calls).toEqual([]);
    expect((await app.fetch(req("/api/browser"), server))!.status).toBe(200);
  });

  test("the check: the peer's loopback connection held by a process of the shared Chrome's tree", () => {
    const rows = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      `   1: 0100007F:C350 0100007F:${PORT.toString(16).toUpperCase().padStart(4, "0")} 01 00000000:00000000 00:00000000 00000000  1000        0 7777 1 0`,
      `   2: 0100007F:C351 0100007F:${PORT.toString(16).toUpperCase().padStart(4, "0")} 01 00000000:00000000 00:00000000 00000000  1000        0 8888 1 0`,
    ].join("\n");
    const proc: ProcReader = {
      read: (p) => (p === "/proc/net/tcp" ? Buffer.from(rows) : p === "/proc/net/tcp6" ? Buffer.from("") : p === "/proc/100/task/100/children" ? Buffer.from("101") : p === "/proc/101/task/101/children" ? Buffer.from("") : null),
      list: (p) => (p === "/proc/100/task" ? ["100"] : p === "/proc/101/task" ? ["101"] : p === "/proc/101/fd" ? ["5"] : p === "/proc/100/fd" ? [] : null),
      link: (p) => (p === "/proc/101/fd/5" ? "socket:[7777]" : null),
    };
    let pid: number | null = 100;
    const check = new PeerCheck({ serverPort: PORT, browserPid: () => pid, proc });
    expect(check.shared({ address: "127.0.0.1", port: 0xc350 })).toBe(true);
    expect(check.shared({ address: "::ffff:127.0.0.1", port: 0xc350 })).toBe(true);
    expect(check.shared({ address: "127.0.0.1", port: 0xc351 })).toBe(false);
    expect(check.shared({ address: "10.0.0.5", port: 0xc350 })).toBe(false);
    expect(check.shared(null)).toBe(false);
    pid = null;
    expect(new PeerCheck({ serverPort: PORT, browserPid: () => pid, proc }).shared({ address: "127.0.0.1", port: 0xc350 })).toBe(false);
  });
});

describe("the browser's log lines (DESIGN-B1 2.15)", () => {
  const routes = new Set(ROUTE_PATTERNS);
  test("browser: an answer of its list, a route pattern, a time and a code; never a URL, a path or a title", () => {
    expect(BROWSER_LOG_ANSWERS).toContain("self_refused");
    const line = logLine("browser", { answer: "self_refused", route: "/c/:chat", ms: 12, code: 0, path: "/srv/you/x", host: "evil.example", chat: "k3m7q2x4abk3m7q2x4ab" }, new Date(0), routes);
    expect(line).toMatchObject({ ev: "browser", answer: "self_refused", route: "/c/:chat", ms: 12, code: 0, chat: null });
    expect(JSON.stringify(line)).not.toContain("evil");
    expect(JSON.stringify(line)).not.toContain("/home");
    expect(logLine("browser", { answer: "https://example.com/?q=secret" }, new Date(0), routes).answer).toBeNull();
    expect(logLine("browser", { route: "/c/k3m7q2x4abk3m7q2x4ab" }, new Date(0), routes).route).toBeNull();
  });
  test("browser_view: the time, the frames, capped and the refused presses; browser_download: ok and the time", () => {
    expect(logLine("browser_view", { ms: 5000, count: 300, capped: true, stale: 2, route: "/browser" }, new Date(0), routes)).toMatchObject({ ms: 5000, count: 300, capped: true, stale: 2, route: null });
    expect(logLine("browser_download", { ok: true, ms: 40, count: 5 }, new Date(0), routes)).toMatchObject({ ok: true, ms: 40, code: null });
  });
});
