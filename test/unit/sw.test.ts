// R130 (FIX-R130 1: "the service worker leaves page loads alone: no fetch handler"; DESIGN-R130 4.5): the built
// service worker, run in a stand-in for a worker's scope. It listens for push and notificationclick and nothing else
// (no fetch, install or activate handler, no cache, no claim); a push shows the payload's notification, or "kitespan"
// opening Home for one it cannot read; a click closes it and opens its path in a window of the app's own origin (the
// focused one, else a visible one, else the first), or a new window; a refused waitUntil or focus changes nothing. Then
// /sw.js on the server: from the build folder only, as JavaScript that revalidates, with guard 9's headers, behind the
// Host check, never under /assets/.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createGate } from "../../server/gate/guards";
import type { Api } from "../../server/http/api";
import { createApp, type Upgrader } from "../../server/http/app";
import { loadSite } from "../../server/http/static";
import { buildWorker } from "../../server/http/worker";
import { PUSH_ICON } from "../../shared/push";

const ROOT = resolve(import.meta.dir, "..", "..");
const CHAT = "k3m7q2x4abk3m7q2x4ab";
const ORIGIN = "http://127.0.0.1:7942";
let code = "";
beforeAll(async () => {
  code = new TextDecoder().decode(await buildWorker(ROOT));
});

type Listener = (e: any) => void;
interface Shown {
  title: string;
  options: Record<string, any>;
}
interface FakeWindow {
  url: string;
  focused?: boolean;
  visibilityState?: string;
  posted: unknown[];
  focuses: number;
  refuseFocus?: boolean;
  postMessage(m: unknown): void;
  focus(): Promise<unknown>;
}

function win(url: string, extra: Partial<FakeWindow> = {}): FakeWindow {
  const w: FakeWindow = {
    url,
    posted: [],
    focuses: 0,
    ...extra,
    postMessage(m) {
      w.posted.push(m);
    },
    async focus() {
      w.focuses++;
      if (w.refuseFocus) throw new DOMException("not allowed", "InvalidAccessError");
      return w;
    },
  };
  return w;
}

/** The built worker, run in a scope that records what it registers and does. */
function run(windows: FakeWindow[] = [], opts: { refuseOpen?: boolean } = {}) {
  const listeners = new Map<string, Listener[]>();
  const shown: Shown[] = [];
  const opened: string[] = [];
  const scope = {
    addEventListener(type: string, fn: Listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    registration: {
      async showNotification(title: string, options: Record<string, any>) {
        shown.push({ title, options });
      },
    },
    clients: {
      async matchAll(o: unknown) {
        expect(o).toEqual({ type: "window", includeUncontrolled: true });
        return windows;
      },
      async openWindow(url: string) {
        opened.push(url);
        if (opts.refuseOpen) throw new DOMException("not allowed", "InvalidAccessError");
        return null;
      },
    },
    location: { origin: ORIGIN },
  };
  new Function("self", code)(scope);
  const held: Promise<unknown>[] = [];
  const event = (extra: Record<string, unknown>, refuseWait = false) => ({
    ...extra,
    waitUntil(p: Promise<unknown>) {
      if (refuseWait) throw new DOMException("not trusted", "InvalidStateError");
      held.push(p);
    },
  });
  const push = async (data: unknown, refuseWait = false) => {
    const e = event({ data: data === undefined ? null : { json: () => (typeof data === "string" ? JSON.parse(data) : data) } }, refuseWait);
    for (const fn of listeners.get("push") ?? []) fn(e);
    await Promise.all(held);
    await Bun.sleep(1);
  };
  const click = async (url: unknown, refuseWait = false) => {
    let closed = 0;
    const e = event({ notification: { data: { url }, close: () => closed++ } }, refuseWait);
    for (const fn of listeners.get("notificationclick") ?? []) fn(e);
    await Promise.all(held);
    await Bun.sleep(1);
    return closed;
  };
  return { listeners, shown, opened, push, click };
}

describe("the built worker", () => {
  test("one classic script that listens for push and notificationclick only: no fetch, install or activate, no cache, no claim", () => {
    expect(code.length).toBeGreaterThan(100);
    expect(code.length).toBeLessThan(20_000);
    expect(code).not.toMatch(/^\s*(import|export)\b/m);
    const { listeners } = run();
    expect([...listeners.keys()]).toEqual(["push", "notificationclick"]);
    expect(code).not.toMatch(/["'`](fetch|install|activate|message|sync|periodicsync)["'`]/);
    expect(code).not.toMatch(/\bcaches\b|\.claim\(|skipWaiting|importScripts|\bfetch\(/);
  });

  test("a push shows the payload's title, body, tag and path, with renotify and the app's icon", async () => {
    const w = run();
    const payload = { v: 1, title: "Claude needs your permission", body: "", tag: `c:${CHAT}`, url: `/c/${CHAT}/permission/toolu_01AbCdEf` };
    await w.push(JSON.stringify(payload));
    expect(w.shown).toEqual([{ title: payload.title, options: { body: "", tag: payload.tag, renotify: true, icon: PUSH_ICON, data: { url: payload.url } } }]);
  });

  test("a push it cannot read shows kitespan, opening Home: bad JSON, no data, another version, a path that is not the app's, a bad tag", async () => {
    const good = { v: 1, title: "Claude finished", body: "", tag: `c:${CHAT}`, url: `/c/${CHAT}` };
    for (const data of ["{nope", undefined, { ...good, v: 2 }, { ...good, url: "https://evil.example/" }, { ...good, url: "//evil.example/x" }, { ...good, url: `/c/${CHAT}/delete` }, { ...good, tag: "other" }, { ...good, title: "" }, { ...good, title: "t".repeat(121) }]) {
      const w = run();
      await w.push(data);
      expect(w.shown).toEqual([{ title: "kitespan", options: { icon: PUSH_ICON, data: { url: "/" } } }]);
    }
  });

  test("a refused waitUntil (a synthetic event) still shows the notification", async () => {
    const w = run();
    await w.push({ v: 1, title: "Claude finished", body: "", tag: `c:${CHAT}`, url: `/c/${CHAT}` }, true);
    expect(w.shown.length).toBe(1);
  });

  test("a click closes it and posts its path to the focused window of the app, which it focuses; a window of another origin is never used", async () => {
    const other = win("https://evil.example/", { focused: true });
    const visible = win(`${ORIGIN}/chats`, { visibilityState: "visible" });
    const focused = win(`${ORIGIN}/c/${CHAT}`, { focused: true });
    const w = run([other, visible, focused]);
    expect(await w.click(`/c/${CHAT}/background/8a56ad66`)).toBe(1);
    expect(focused.posted).toEqual([{ open: `/c/${CHAT}/background/8a56ad66` }]);
    expect(focused.focuses).toBe(1);
    expect(other.posted).toEqual([]);
    expect(visible.posted).toEqual([]);
    expect(w.opened).toEqual([]);
  });

  test("no focused window: a visible one, else the first; a path that is not one of a push's opens Home", async () => {
    const hidden = win(`${ORIGIN}/`, { visibilityState: "hidden" });
    const visible = win(`${ORIGIN}/settings`, { visibilityState: "visible" });
    await run([hidden, visible]).click(`/c/${CHAT}`);
    expect(visible.posted).toEqual([{ open: `/c/${CHAT}` }]);
    const only = win(`${ORIGIN}/`, { visibilityState: "hidden", refuseFocus: true });
    await run([only]).click("javascript:alert(1)");
    expect(only.posted).toEqual([{ open: "/" }]);
    expect(only.focuses).toBe(1);
  });

  test("no window of the app: a new one at the path; a refused openWindow or waitUntil changes nothing", async () => {
    const w = run([win("https://evil.example/")]);
    await w.click(`/c/${CHAT}/question/toolu_01AbCdEf`);
    expect(w.opened).toEqual([`/c/${CHAT}/question/toolu_01AbCdEf`]);
    const refused = run([], { refuseOpen: true });
    await refused.click(`/c/${CHAT}`, true);
    expect(refused.opened).toEqual([`/c/${CHAT}`]);
  });
});

describe("/sw.js on the server", () => {
  const dir = mkdtempSync(join(tmpdir(), "kitespan-sw-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const api: Api = { handle: async () => new Response("api") };
  const noServer: Upgrader = { upgrade: () => false };
  const HOST = { host: "127.0.0.1:7942" };

  function app(withWorker: boolean) {
    const dist = mkdtempSync(join(dir, "dist-"));
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html><html><head><title>kitespan</title></head><body></body></html>");
    if (withWorker) writeFileSync(join(dist, "sw.js"), code);
    const gate = createGate(7942, []);
    return createApp({ gate, site: loadSite(dist, gate.origins), api, sockets: {} });
  }
  const ask = async (a: ReturnType<typeof app>, path: string, init: RequestInit = {}) => (await a.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers: { ...HOST, ...(init.headers as Record<string, string>) } }), noServer))!;

  test("GET and HEAD: the build's worker, as JavaScript that revalidates, with guard 9's headers; gzipped when asked", async () => {
    const a = app(true);
    const res = await ask(a, "/sw.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("service-worker-allowed")).toBeNull();
    expect(await res.text()).toBe(code);
    expect((await ask(a, "/sw.js", { method: "HEAD" })).status).toBe(200);
    const gz = await ask(a, "/sw.js", { headers: { "accept-encoding": "gzip" } });
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await gz.arrayBuffer())))).toBe(code);
  });

  test("only at /sw.js: never under /assets/; any other method is 405; another Host is 403; no worker built is 404", async () => {
    const a = app(true);
    expect((await ask(a, "/assets/sw.js")).status).toBe(404);
    expect((await ask(a, "/sw.js", { method: "POST" })).status).toBe(405);
    expect((await a.fetch(new Request(`${ORIGIN}/sw.js`, { headers: { host: "evil.example" } }), noServer))!.status).toBe(403);
    expect((await ask(app(false), "/sw.js")).status).toBe(404);
  });

  test("dev mode's worker, given at start, is served instead of the folder's", async () => {
    const gate = createGate(7942, []);
    const a = createApp({ gate, site: loadSite(join(dir, "none"), gate.origins, { worker: new TextEncoder().encode("// dev worker") }), api, sockets: {} });
    expect(await (await ask(a, "/sw.js")).text()).toBe("// dev worker");
  });
});
