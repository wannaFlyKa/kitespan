// The relay and its allow-list with a fake debugging connection (DESIGN-B1 2.6, 2.7, 2.14, 3.6, 7.1): the real
// CdpClient over a fake transport, so the guard of allow.ts and the id matching are the real ones. Every refused method
// and argument; the attach calls sent back to back (S1); the Fetch block's handler; each pane frame mapped to its own
// calls only, with the arguments that the relay computes; refusals that send nothing; the cast's credits, acks and
// backpressure; the stale-frame rule.

import { describe, expect, test } from "bun:test";
import { CDP_METHODS, CallRefused, FRAME_METHODS, NEVER_METHODS, SERVER_METHODS, guardCall } from "../../server/browser/allow";
import { CdpClient, type CdpTransport } from "../../server/browser/cdp";
import { Relay, focusFactsOf, jpegSize, pickerFactsOf } from "../../server/browser/relay";
import { CHOOSER_CANCEL, FIXED_SCRIPT_TEXTS, PICKER_FACTS, PROBE_EL, SELECTION, SET_SELECT_ON, SET_VALUE_ON } from "../../server/browser/scripts";
import { stalePress, keepMark, type FrameMark } from "../../server/browser/stale";
import { decodeCastFrame, type BrowserClientFrame, type BrowserServerFrame } from "../../shared/browser";
import type { Downloads } from "../../server/browser/downloads";
import type { TabsFileStore, TabsFile } from "../../server/browser/tabs";

describe("the allow-list's guard (DESIGN-B1 2.7.2)", () => {
  test("every method of 2.7.2's never list, and any method off the lists, is refused before it is sent", () => {
    for (const m of [...NEVER_METHODS, "Runtime.enable", "Network.enable", "Storage.clearCookies", "Page.addScriptToEvaluateOnNewDocument", "DOM.enable", "Accessibility.getFullAXTree", "Overlay.highlightNode", "Target.setRemoteLocations"]) {
      expect([m, () => guardCall(m, {})]).toEqual([m, expect.any(Function)]);
      expect(() => guardCall(m, {})).toThrow(CallRefused);
    }
    for (const m of NEVER_METHODS) expect(CDP_METHODS.has(m)).toBe(false);
    expect([...FRAME_METHODS].filter((m) => SERVER_METHODS.has(m))).toEqual([]);
  });
  test("Runtime.callFunctionOn carries only a fixed script, never an expression", () => {
    for (const text of FIXED_SCRIPT_TEXTS) expect(() => guardCall("Runtime.callFunctionOn", { functionDeclaration: text, objectId: "o" })).not.toThrow();
    for (const text of ["function () { return document.cookie }", `${PROBE_EL} `, "() => 1", "", 7]) expect(() => guardCall("Runtime.callFunctionOn", { functionDeclaration: text, objectId: "o" })).toThrow(CallRefused);
    expect(() => guardCall("Runtime.callFunctionOn", { functionDeclaration: PROBE_EL, expression: "1" })).toThrow(CallRefused);
  });
  test("the arguments that 2.7.2 forbids", () => {
    const refused: [string, Record<string, unknown>][] = [
      ["Page.reload", { scriptToEvaluateOnLoad: "alert(1)" }],
      ["Input.dispatchKeyEvent", { type: "keyDown", commands: ["selectAll"] }],
      ["Target.attachToTarget", { targetId: "T" }],
      ["Target.attachToTarget", { targetId: "T", flatten: false }],
      ["Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true }],
      ["Target.createTarget", { url: "file:///etc/passwd" }],
      ["Target.createTarget", { url: "chrome://settings/" }],
      ["Target.createTarget", { url: "javascript:alert(1)" }],
      ["Target.createTarget", { url: "about:blank", browserContextId: "C" }],
      ["Page.navigate", { url: "data:text/html,x" }],
      ["Page.navigate", { url: "view-source:https://a/" }],
      ["DOM.resolveNode", { nodeId: 1, executionContextId: 2, objectGroup: "kitespan" }],
      ["DOM.resolveNode", { backendNodeId: 1, objectGroup: "kitespan" }],
      ["DOM.resolveNode", { backendNodeId: 1, executionContextId: 2 }],
      ["DOM.setFileInputFiles", { files: ["/x"], nodeId: 3 }],
      ["DOM.setFileInputFiles", { files: ["/x"], backendNodeId: 3, objectId: "o" }],
      ["Browser.setDownloadBehavior", { behavior: "allow", downloadPath: "/x" }],
      ["Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: "/x", eventsEnabled: false }],
      ["Page.createIsolatedWorld", { frameId: "F", worldName: "kitespan", grantUniveralAccess: true }],
    ];
    for (const [m, p] of refused) expect([m, p, (() => { try { guardCall(m, p); return "sent"; } catch (e) { return e instanceof CallRefused ? "refused" : "other"; } })()]).toEqual([m, p, "refused"]);
  });
  test("the client sends nothing for a refused call", async () => {
    const sent: string[] = [];
    const t: CdpTransport = { send: (x) => void sent.push(x), close() {}, onMessage() {}, onClose() {} };
    const c = new CdpClient(t);
    await expect(c.send("Runtime.evaluate", { expression: "1" })).rejects.toThrow(CallRefused);
    await expect(c.send("Network.getAllCookies")).rejects.toThrow(CallRefused);
    expect(sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// A fake debugging connection under the real client

interface Sent {
  id: number;
  method: string;
  params: Record<string, any>;
  sessionId?: string;
}

class FakeChrome {
  readonly sent: Sent[] = [];
  private message: (text: string) => void = () => {};
  private closeCb: () => void = () => {};
  /** Hold the replies (to show that calls go out back to back); release() sends them. */
  hold = false;
  private held: (() => void)[] = [];
  results: Record<string, (p: Record<string, any>, s?: string) => unknown> = {};
  private nextTarget = 1;
  readonly client: CdpClient;

  constructor() {
    const t: CdpTransport = {
      send: (text) => this.got(JSON.parse(text)),
      close: () => {},
      onMessage: (cb) => (this.message = cb),
      onClose: (cb) => (this.closeCb = cb),
    };
    this.client = new CdpClient(t);
  }

  private got(m: Sent): void {
    this.sent.push(m);
    const reply = () => {
      const r = this.result(m);
      this.message(JSON.stringify({ id: m.id, result: r }));
    };
    if (this.hold) this.held.push(reply);
    else queueMicrotask(reply);
  }

  release(): void {
    this.hold = false;
    for (const r of this.held.splice(0)) r();
  }

  newTarget(): string {
    return `T${String(this.nextTarget++).padStart(31, "0")}`;
  }

  private result(m: Sent): unknown {
    const own = this.results[m.method];
    if (own) return own(m.params, m.sessionId);
    switch (m.method) {
      case "Target.createTarget": {
        const targetId = this.newTarget();
        const sessionId = `S-${targetId}`;
        queueMicrotask(() => {
          this.event("Target.targetCreated", { targetInfo: { targetId, type: "page", url: "about:blank", title: "" } });
          this.event("Target.attachedToTarget", { sessionId, targetInfo: { targetId, type: "page", url: "about:blank", title: "" }, waitingForDebugger: true });
        });
        return { targetId };
      }
      case "Target.attachToTarget":
        return { sessionId: `V-${m.params.targetId}-${m.id}` };
      case "Page.getFrameTree":
        return { frameTree: { frame: { id: `F-${m.sessionId}`, url: "about:blank" } } };
      case "Browser.getWindowForTarget":
        return { windowId: Number(String(m.params.targetId).replace(/\D/g, "")), bounds: { width: 1280, height: 943 } };
      case "Page.getLayoutMetrics":
        return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 800 } };
      case "Page.getNavigationHistory":
        return { currentIndex: 1, entries: [{ id: 11 }, { id: 12 }, { id: 13 }] };
      case "Page.createIsolatedWorld":
        return { executionContextId: 77 };
      case "Target.getTargets":
        return { targetInfos: [] };
      case "DOM.resolveNode":
        return { object: { objectId: "file-input" } };
      case "Runtime.callFunctionOn":
        return { result: { value: null } };
      default:
        return {};
    }
  }

  event(method: string, params: Record<string, unknown>, sessionId?: string): void {
    this.message(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }));
  }

  close(): void {
    this.closeCb();
  }

  of(method: string): Sent[] {
    return this.sent.filter((s) => s.method === method);
  }
}

class Conn {
  frames: BrowserServerFrame[] = [];
  binary: Uint8Array[] = [];
  bufferedBytes = 0;
  closed: number | null = null;
  send(f: BrowserServerFrame) {
    this.frames.push(f);
  }
  sendBinary(b: Uint8Array) {
    this.binary.push(b);
    return b.length;
  }
  buffered() {
    return this.bufferedBytes;
  }
  close(code: number) {
    this.closed = code;
  }
  of<T extends BrowserServerFrame["t"]>(t: T) {
    return this.frames.filter((f): f is Extract<BrowserServerFrame, { t: T }> => f.t === t);
  }
}

const OWN = { origins: ["http://127.0.0.1:7945", "http://localhost:7945", "http://[::1]:7945", "https://kite.example.net"], loopbackPorts: [7945] };
const RID = () => crypto.randomUUID();
const tick = (ms = 5) => Bun.sleep(ms);

async function setup(opts: { uploads?: (ids: readonly string[]) => Promise<string[] | null>; now?: () => number } = {}) {
  const chrome = new FakeChrome();
  let saved: TabsFile | null = null;
  const tabsFile = { read: async () => null, save: (f: TabsFile) => void (saved = f), flush: async () => {}, count: async () => 0, clear: async () => {} } as unknown as TabsFileStore;
  const downloads = { folder: "/state/browser/downloads", list: () => [], begin() {}, progress: async () => {}, guidOf: (id: string) => (id === "abcdefghijk23456" ? "0f0e2c8c-1f4a-4c41-a3c6-6b2c1a7f0d12" : null) } as unknown as Downloads;
  const relay = new Relay({
    refused: () => OWN,
    tabsFile,
    downloads,
    uploadPaths: opts.uploads ?? (async (ids) => (ids[0] === "k3m7q2x4abk3m7q2" ? ["/state/uploads/u-a1b2c3/note.txt"] : null)),
    host: () => ({ state: "running", port: 9345 }),
    timing: { probeMs: 1, selectionMs: 1, focusMinMs: 1, publishMs: 1, infoSoonMs: 1, readyMs: 500, followMs: 1_000 },
    ...(opts.now ? { now: opts.now } : {}),
  });
  await relay.attach(chrome.client, { fresh: false, start: "1@x", port: 9345 });
  const conn = new Conn();
  relay.addConn(conn);
  return { chrome, relay, conn, saved: () => saved };
}

/** Until no call has gone out for a while (the spare's and the tab's own background calls are done). */
async function quiet(env: Awaited<ReturnType<typeof setup>>) {
  let n = -1;
  while (n !== env.chrome.sent.length) {
    n = env.chrome.sent.length;
    await tick(15);
  }
}

/** A tab that New tab opened, with its session ready, its URL reported as Chrome reports it. */
async function openTab(env: Awaited<ReturnType<typeof setup>>, url = "https://example.com/") {
  const rid = RID();
  await env.relay.handle(env.conn, { t: "tab_new", rid, url });
  const ack = env.conn.of("ack").find((a) => a.rid === rid)!;
  expect(ack.ok).toBe(true);
  const nav = env.chrome.of("Page.navigate").find((x) => x.params.url === url);
  if (nav) env.chrome.event("Target.targetInfoChanged", { targetInfo: { targetId: nav.sessionId!.slice(2), type: "page", url, title: "Example" } });
  await quiet(env);
  return ack.tab!;
}

const sessionOf = (env: Awaited<ReturnType<typeof setup>>, tabUrl: string) => env.chrome.of("Page.navigate").find((s) => s.params.url === tabUrl)!.sessionId!;

describe("the connection and each new tab (DESIGN-B1 2.6, S1)", () => {
  test("at connect, back to back: discover, kitespan's own download folder, the paused auto-attach", async () => {
    const { chrome } = await setup();
    expect(chrome.sent.slice(0, 3).map((s) => [s.method, s.params])).toEqual([
      ["Target.setDiscoverTargets", { discover: true }],
      ["Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: "/state/browser/downloads", eventsEnabled: true }],
      ["Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }],
    ]);
  });
  test("a new tab gets its four calls before any reply comes (never awaited one by one), then the resume", async () => {
    const env = await setup();
    env.chrome.hold = true;
    env.chrome.event("Target.targetCreated", { targetInfo: { targetId: "A".repeat(32), type: "page", url: "", openerId: undefined } });
    env.chrome.event("Target.attachedToTarget", { sessionId: "SA", targetInfo: { targetId: "A".repeat(32), type: "page", url: "" }, waitingForDebugger: true });
    await tick();
    const onTab = env.chrome.sent.filter((s) => s.sessionId === "SA").map((s) => s.method);
    expect(onTab).toEqual(["Page.enable", "Page.setInterceptFileChooserDialog", "Fetch.enable", "Runtime.runIfWaitingForDebugger"]);
    const fetch = env.chrome.of("Fetch.enable")[0]!.params;
    expect(fetch.patterns).toEqual([{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }, ...OWN.origins.map((o) => ({ urlPattern: `${o}/*`, requestStage: "Request" }))]);
    env.chrome.release();
  });
  test("a target that is not a tab (a worker, the browser's own UI) is resumed and left", async () => {
    const env = await setup();
    env.chrome.event("Target.attachedToTarget", { sessionId: "SW", targetInfo: { targetId: "B".repeat(32), type: "service_worker", url: "https://a/sw.js" }, waitingForDebugger: true });
    await tick();
    expect(env.chrome.sent.filter((s) => s.sessionId === "SW" || s.params.sessionId === "SW").map((s) => s.method)).toEqual(["Runtime.runIfWaitingForDebugger", "Target.detachFromTarget"]);
  });
  test("the Fetch block: kitespan's own origins in every spelling fail; everything else continues", async () => {
    const env = await setup();
    const paused = (url: string, requestId: string) => env.chrome.event("Fetch.requestPaused", { requestId, request: { url }, resourceType: "Document" }, "SA");
    const own = ["http://127.0.0.1:7945/", "http://u@127.0.0.1:7945/app", "http://LOCALHOST:7945/c", "https://kite.example.net/", "https://u:p@KITE.example.net/x", "http://127.0.0.2:7945/", "http://127.0.0.1:9345/json/list"];
    const other = ["https://example.com/", "http://127.0.0.1:7944/", "https://kite.example.net.evil/", "http://kite.example.net/", "about:blank"];
    own.forEach((u, i) => paused(u, `own${i}`));
    other.forEach((u, i) => paused(u, `other${i}`));
    await tick();
    expect(env.chrome.of("Fetch.failRequest").map((s) => [s.params.requestId, s.params.errorReason, s.sessionId])).toEqual(own.map((_, i) => [`own${i}`, "BlockedByClient", "SA"]));
    expect(env.chrome.of("Fetch.continueRequest").map((s) => s.params.requestId)).toEqual(other.map((_, i) => `other${i}`));
  });
});

describe("tabs.json around a stop or a restart (DESIGN-B1 2.4; main.ts release and relisten)", () => {
  test("freeze writes the tabs as they are, then nothing; thaw, after a restart that did not happen, writes again", async () => {
    const env = await setup();
    const a = await openTab(env, "https://example.com/a");
    await env.relay.freeze();
    const frozen = env.saved();
    expect(frozen?.tabs.map((t) => t.id)).toEqual([a]);
    // While frozen (the successor adopts and writes its own), this server writes nothing.
    const b = await openTab(env, "https://example.com/b");
    expect(env.saved()).toBe(frozen);
    env.relay.thaw();
    expect(env.saved()?.tabs.map((t) => t.id)).toEqual([a, b]);
  });
});

describe("each frame maps to its own calls only (DESIGN-B1 2.7)", () => {
  test("tab_new: about:blank in a new window, then the address once kitespan's session is on it, then a new spare", async () => {
    const env = await setup();
    const before = env.chrome.sent.length;
    const tab = await openTab(env, "https://example.com/a?b=c");
    expect(tab).toMatch(/^[a-z2-7]{10}$/);
    const calls = env.chrome.sent.slice(before);
    expect(calls[0]).toMatchObject({ method: "Target.createTarget", params: { url: "about:blank", newWindow: true } });
    expect(calls.find((c) => c.method === "Page.navigate")!.params).toEqual({ url: "https://example.com/a?b=c" });
    const navAt = calls.findIndex((c) => c.method === "Page.navigate");
    const resumeAt = calls.findIndex((c) => c.method === "Runtime.runIfWaitingForDebugger");
    expect(resumeAt).toBeGreaterThan(-1);
    expect(navAt).toBeGreaterThan(resumeAt);
    for (const c of calls) expect([c.method, CDP_METHODS.has(c.method)]).toEqual([c.method, true]);
  });
  test("tab_new and navigate refuse kitespan's own origins and other schemes with url_refused, and send nothing", async () => {
    const env = await setup();
    const tab = await openTab(env);
    for (const url of ["http://127.0.0.1:7945/", "https://kite.example.net/c/x", "file:///etc/passwd", "http://127.0.0.1:9345/json", "javascript:alert(1)"]) {
      const before = env.chrome.sent.length;
      const a = RID();
      await env.relay.handle(env.conn, { t: "tab_new", rid: a, url });
      const b = RID();
      await env.relay.handle(env.conn, { t: "navigate", rid: b, tab, url });
      expect([url, env.conn.of("ack").find((x) => x.rid === a)!.code, env.conn.of("ack").find((x) => x.rid === b)!.code]).toEqual([url, "url_refused", "url_refused"]);
      expect(env.chrome.sent.length).toBe(before);
    }
  });
  test("navigate, back, forward, reload, stop: each one call on kitespan's own session, the history entry picked by the server", async () => {
    const env = await setup();
    const tab = await openTab(env);
    const s = sessionOf(env, "https://example.com/");
    const run = async (f: BrowserClientFrame) => {
      const before = env.chrome.sent.length;
      await env.relay.handle(env.conn, f);
      await tick();
      return env.chrome.sent.slice(before).filter((c) => c.method !== "Target.getTargets").map((c) => [c.method, c.params, c.sessionId]);
    };
    expect(await run({ t: "navigate", rid: RID(), tab, url: "HTTPS://Example.COM/x" })).toEqual([["Page.navigate", { url: "https://example.com/x" }, s]]);
    expect(await run({ t: "back", rid: RID(), tab })).toEqual([["Page.getNavigationHistory", {}, s], ["Page.navigateToHistoryEntry", { entryId: 11 }, s]]);
    expect(await run({ t: "forward", rid: RID(), tab })).toEqual([["Page.getNavigationHistory", {}, s], ["Page.navigateToHistoryEntry", { entryId: 13 }, s]]);
    expect(await run({ t: "reload", rid: RID(), tab, nocache: true })).toEqual([["Page.reload", { ignoreCache: true }, s]]);
    expect(await run({ t: "stop", rid: RID(), tab })).toEqual([["Page.stopLoading", {}, s]]);
  });
  test("input: the mouse, touch, keys and text with the arguments of 2.7, never editor commands", async () => {
    const env = await setup();
    const tab = await openTab(env);
    const s = sessionOf(env, "https://example.com/");
    const before = env.chrome.sent.length;
    await env.relay.handle(env.conn, { t: "mouse", tab, n: 0, type: "mouseWheel", x: 10, y: 20, dx: 0, dy: 120, mods: 8 });
    await env.relay.handle(env.conn, { t: "touch", tab, n: 0, type: "touchStart", points: [{ x: 5, y: 6, id: 1 }] });
    await env.relay.handle(env.conn, { t: "key", tab, n: 0, type: "keyDown", key: "a", code: "KeyA", vk: 65, text: "a", mods: 2 });
    await env.relay.handle(env.conn, { t: "key", tab, n: 0, type: "keyUp", key: "a", code: "KeyA", vk: 65, text: "a" });
    await env.relay.handle(env.conn, { t: "text", tab, n: 0, text: "héllo\nworld" });
    const input = env.chrome.sent.slice(before).filter((c) => c.method.startsWith("Input."));
    expect(input.map((c) => [c.method, c.params, c.sessionId])).toEqual([
      ["Input.dispatchMouseEvent", { type: "mouseWheel", x: 10, y: 20, button: "none", clickCount: 0, modifiers: 8, deltaX: 0, deltaY: 120 }, s],
      ["Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 5, y: 6, id: 1 }] }, s],
      ["Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2, text: "a", unmodifiedText: "a" }, s],
      ["Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 0 }, s],
      ["Input.insertText", { text: "héllo\nworld" }, s],
    ]);
  });
  test("SELECTION after every key that goes down and every text that carries sq (a typed key can replace the selection), to that socket only, read once for a burst", async () => {
    const env = await setup();
    const tab = await openTab(env);
    const sel = () => env.conn.of("selection").map((s) => s.sq);
    const selCalls = () => env.chrome.of("Runtime.callFunctionOn").filter((c) => String(c.params.functionDeclaration).includes("getSelection")).length;
    await env.relay.handle(env.conn, { t: "key", tab, n: 0, type: "keyDown", key: "x", code: "KeyX", vk: 88, text: "x", sq: 5 });
    await quiet(env);
    expect(sel()).toEqual([5]);
    await env.relay.handle(env.conn, { t: "key", tab, n: 0, type: "rawKeyDown", key: "ArrowRight", code: "ArrowRight", vk: 39, sq: 6 });
    await quiet(env);
    expect(sel()).toEqual([5, 6]);
    await env.relay.handle(env.conn, { t: "text", tab, n: 0, text: "é", sq: 7 });
    await quiet(env);
    expect(sel()).toEqual([5, 6, 7]);
    // A key's release and a key with no sq ask nothing.
    await env.relay.handle(env.conn, { t: "key", tab, n: 0, type: "keyUp", key: "x", code: "KeyX", vk: 88, sq: 8 });
    await env.relay.handle(env.conn, { t: "key", tab, n: 0, type: "keyDown", key: "y", code: "KeyY", vk: 89, text: "y" });
    await quiet(env);
    expect(sel()).toEqual([5, 6, 7]);
    // A burst of typing: one read, which answers the newest input.
    const calls = selCalls();
    for (const [i, ch] of ["a", "b", "c"].entries()) await env.relay.handle(env.conn, { t: "key", tab, n: 0, type: "keyDown", key: ch, code: `Key${ch.toUpperCase()}`, vk: 65 + i, text: ch, sq: 10 + i });
    await quiet(env);
    expect(sel()).toEqual([5, 6, 7, 12]);
    expect(selCalls()).toBe(calls + 1);
  });
  test("tab_close and tab_size: Close is one call; Page size is the fixed emulation; both ask first while Claude acts", async () => {
    const env = await setup();
    const tab = await openTab(env);
    const s = sessionOf(env, "https://example.com/");
    env.relay.acting.event("k3m7q2x4abk3m7q2x4ab", { k: "tool_call", id: "toolu_1", name: "mcp__playwright__browser_snapshot", input: {}, parent: null });
    env.relay.acting.event("k3m7q2x4abk3m7q2x4ab", { k: "tool_result", id: "toolu_1", text: "### Page\n- Page URL: https://example.com/\n", isError: false, parent: null, report: null });
    await tick();
    const before = env.chrome.sent.length;
    const a = RID();
    await env.relay.handle(env.conn, { t: "tab_close", rid: a, tab });
    expect(env.conn.of("ack").find((x) => x.rid === a)!.code).toBe("claude_acting");
    const b = RID();
    await env.relay.handle(env.conn, { t: "tab_size", rid: b, tab, kind: "phone" });
    expect(env.conn.of("ack").find((x) => x.rid === b)!.code).toBe("claude_acting");
    expect(env.chrome.sent.length).toBe(before);
    const c = RID();
    await env.relay.handle(env.conn, { t: "tab_size", rid: c, tab, kind: "phone", w: 390, h: 844, force: true });
    await tick();
    expect(env.chrome.sent.slice(before).map((x) => [x.method, x.params, x.sessionId])).toEqual([
      ["Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }, s],
      ["Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, s],
    ]);
    const d = RID();
    const mid = env.chrome.sent.length;
    await env.relay.handle(env.conn, { t: "tab_size", rid: d, tab, kind: "desktop", force: true });
    await tick();
    expect(env.chrome.sent.slice(mid).map((x) => x.method)).toEqual(["Emulation.clearDeviceMetricsOverride", "Emulation.setTouchEmulationEnabled"]);
    const e = RID();
    await env.relay.handle(env.conn, { t: "tab_close", rid: e, tab, force: true });
    expect(env.chrome.of("Target.closeTarget").at(-1)!.params).toEqual({ targetId: expect.stringMatching(/^T0+\d+$/) });
  });
  test("an unknown tab: not_found, and the browser down: host_down; nothing is sent", async () => {
    const env = await setup();
    const before = env.chrome.sent.length;
    const a = RID();
    await env.relay.handle(env.conn, { t: "reload", rid: a, tab: "q2x4abk3m7" });
    expect(env.conn.of("ack").find((x) => x.rid === a)!.code).toBe("not_found");
    env.relay.detach();
    const b = RID();
    await env.relay.handle(env.conn, { t: "tab_new", rid: b });
    expect(env.conn.of("ack").find((x) => x.rid === b)!.code).toBe("host_down");
    expect(env.chrome.sent.length).toBe(before);
  });
  test("a dialog: on its viewers, answered once with handleJavaScriptDialog; a prompt's text only for a prompt", async () => {
    const env = await setup();
    const tab = await openTab(env);
    const s = sessionOf(env, "https://example.com/");
    await env.relay.handle(env.conn, { t: "view", tab, w: 640, h: 400, dpr: 1, q: 50, credit: 1 });
    await tick();
    env.chrome.event("Page.javascriptDialogOpening", { url: "https://example.com/a?secret=1", message: "proceed?", type: "confirm", defaultPrompt: "", frameId: `F-${s}` }, s);
    await tick();
    const d = env.conn.of("dialog").at(-1)!;
    expect(d).toEqual({ t: "dialog", tab, id: 1, type: "confirm", message: "proceed?", defaultPrompt: "", host: "example.com", embedded: false });
    const a = RID();
    await env.relay.handle(env.conn, { t: "dialog_answer", rid: a, tab, id: 1, accept: true, text: "ignored for a confirm" });
    expect(env.chrome.of("Page.handleJavaScriptDialog").map((x) => [x.params, x.sessionId])).toEqual([[{ accept: true }, s]]);
    env.chrome.event("Page.javascriptDialogClosed", { result: true, userInput: "" }, s);
    await tick();
    expect(env.conn.of("dialog_closed").at(-1)).toEqual({ t: "dialog_closed", tab, id: 1, result: true, by: "pane" });
    const b = RID();
    await env.relay.handle(env.conn, { t: "dialog_answer", rid: b, tab, id: 1, accept: false });
    expect(env.conn.of("ack").find((x) => x.rid === b)!.code).toBe("stale");
  });
  test("the file chooser: the store's own paths for the upload ids, by the chooser's backendNodeId; Cancel runs CHOOSER_CANCEL", async () => {
    const env = await setup();
    const tab = await openTab(env);
    const s = sessionOf(env, "https://example.com/");
    env.chrome.results["Runtime.callFunctionOn"] = (p) => ({ result: { value: p.functionDeclaration.includes("accept") ? { accept: [".txt", "bad accept!"], multiple: false, label: "Attachment" } : null } });
    await env.relay.handle(env.conn, { t: "view", tab, w: 640, h: 400, dpr: 1, q: 50, credit: 1 });
    env.chrome.event("Page.frameNavigated", { frame: { id: `F-${s}`, url: "https://example.com/" } }, s);
    env.chrome.event("Page.fileChooserOpened", { frameId: `F-${s}`, mode: "selectSingle", backendNodeId: 42 }, s);
    await tick(20);
    const ch = env.conn.of("chooser").at(-1)!;
    expect(ch).toMatchObject({ tab, id: 1, mode: "selectSingle", accept: [".txt", "bad accept!"], label: "Attachment", host: "example.com", by: "other" });
    expect(env.chrome.of("DOM.resolveNode").at(-1)!.params).toEqual({ backendNodeId: 42, executionContextId: 77, objectGroup: "kitespan" });
    const two = RID();
    await env.relay.handle(env.conn, { t: "chooser_answer", rid: two, tab, id: 1, uploads: ["k3m7q2x4abk3m7q2", "abcdefghijklmnop"] });
    expect(env.conn.of("ack").find((x) => x.rid === two)!.code).toBe("bad_request");
    const unknown = RID();
    await env.relay.handle(env.conn, { t: "chooser_answer", rid: unknown, tab, id: 1, uploads: ["abcdefghijklmnop"] });
    expect(env.conn.of("ack").find((x) => x.rid === unknown)!.code).toBe("not_found");
    const good = RID();
    await env.relay.handle(env.conn, { t: "chooser_answer", rid: good, tab, id: 1, uploads: ["k3m7q2x4abk3m7q2"] });
    expect(env.chrome.of("DOM.setFileInputFiles").map((x) => [x.params, x.sessionId])).toEqual([[{ files: ["/state/uploads/u-a1b2c3/note.txt"], backendNodeId: 42 }, s]]);
    expect(env.conn.of("chooser_closed").at(-1)).toEqual({ t: "chooser_closed", tab, id: 1, by: "pane" });
    env.chrome.event("Page.fileChooserOpened", { frameId: `F-${s}`, mode: "selectSingle", backendNodeId: 43 }, s);
    await tick(20);
    const c = RID();
    await env.relay.handle(env.conn, { t: "chooser_cancel", rid: c, tab, id: 2 });
    expect(env.chrome.of("Runtime.callFunctionOn").at(-1)!.params).toEqual({ functionDeclaration: CHOOSER_CANCEL, objectId: "file-input", returnByValue: true });
    expect(env.conn.of("chooser_closed").at(-1)).toMatchObject({ id: 2, by: "cancelled" });
  });
  test("a picker: PROBE_EL keeps the tapped control, PICKER_FACTS by value; the pick runs on the kept object with the value as an argument", async () => {
    const env = await setup();
    const tab = await openTab(env);
    const s = sessionOf(env, "https://example.com/");
    env.chrome.event("Page.frameNavigated", { frame: { id: `F-${s}`, url: "https://example.com/" } }, s);
    env.chrome.results["Runtime.callFunctionOn"] = (p) => {
      if (p.functionDeclaration === PROBE_EL) return { result: { objectId: "the-select" } };
      if (p.functionDeclaration === PICKER_FACTS) return { result: { value: { kind: "select", open: true, box: { x: 1, y: 2, w: 3, h: 4 }, label: "Fruit", selected: 0, items: [{ group: null, label: "Apple", disabled: false, index: 0 }, { group: null, label: "Banana", disabled: false, index: 1 }] } } };
      if (p.functionDeclaration === SET_SELECT_ON) return { result: { value: true } };
      return { result: { value: null } };
    };
    await env.relay.handle(env.conn, { t: "mouse", tab, n: 0, type: "mouseReleased", x: 10, y: 10, button: "left", clicks: 1 });
    await tick(30);
    const p = env.conn.of("picker").at(-1)!;
    expect(p).toMatchObject({ tab, id: 1, kind: "select", open: true, label: "Fruit", selected: 0 });
    expect(env.chrome.of("Runtime.callFunctionOn").find((x) => x.params.functionDeclaration === PROBE_EL)!.params).toEqual({ functionDeclaration: PROBE_EL, executionContextId: 77, returnByValue: false, objectGroup: "kitespan" });
    const a = RID();
    await env.relay.handle(env.conn, { t: "pick", rid: a, tab, id: 1, index: 1 });
    const set = env.chrome.of("Runtime.callFunctionOn").find((x) => x.params.functionDeclaration === SET_SELECT_ON)!;
    expect(set.params).toEqual({ functionDeclaration: SET_SELECT_ON, objectId: "the-select", arguments: [{ value: 1 }], returnByValue: true });
    // The popup was open: an Escape key closes it, then the object goes.
    expect(env.chrome.of("Input.dispatchKeyEvent").map((x) => x.params.type + ":" + x.params.key)).toEqual(["rawKeyDown:Escape", "keyUp:Escape"]);
    expect(env.chrome.of("Runtime.releaseObject").at(-1)!.params).toEqual({ objectId: "the-select" });
    expect(env.conn.of("ack").find((x) => x.rid === a)!.ok).toBe(true);
    for (const f of [{ index: 2 }, { value: "2026-11-09" }]) {
      const r = RID();
      await env.relay.handle(env.conn, { t: "pick", rid: r, tab, id: 1, ...f } as BrowserClientFrame);
      expect(env.conn.of("ack").find((x) => x.rid === r)!.code).toBe("stale");
    }
    void SET_VALUE_ON;
    void SELECTION;
  });
  test("download_cancel: Browser.cancelDownload by Chrome's guid, which the page never names", async () => {
    const env = await setup();
    const a = RID();
    await env.relay.handle(env.conn, { t: "download_cancel", rid: a, id: "abcdefghijk23456" });
    expect(env.chrome.of("Browser.cancelDownload").map((x) => x.params)).toEqual([{ guid: "0f0e2c8c-1f4a-4c41-a3c6-6b2c1a7f0d12" }]);
    const b = RID();
    await env.relay.handle(env.conn, { t: "download_cancel", rid: b, id: "zzzzzzzzzzzzzzzz" });
    expect(env.conn.of("ack").find((x) => x.rid === b)!.code).toBe("stale");
  });
});

/** A screencast frame's data: a JPEG start with its size (the relay reads only the SOF marker). */
const jpeg = (w: number, h: number) => {
  const b = new Uint8Array(20);
  b.set([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255]);
  return Buffer.from(b).toString("base64");
};

describe("casts (DESIGN-B1 2.9, 3.5, 3.6)", () => {
  test("view: a cast session of its own, its size, quality and credit; a frame goes out as the binary frame; drawn acks it", async () => {
    const env = await setup();
    const tab = await openTab(env);
    await env.relay.handle(env.conn, { t: "view", tab, w: 390.4, h: 600, dpr: 2, q: 50, credit: 1 });
    await tick(10);
    const attach = env.chrome.of("Target.attachToTarget").at(-1)!;
    expect(attach.params).toEqual({ targetId: expect.any(String), flatten: true });
    const v = `V-${attach.params.targetId}-${attach.id}`;
    expect(env.chrome.of("Page.startScreencast").at(-1)).toMatchObject({ sessionId: v, params: { format: "jpeg", quality: 50, maxWidth: 781, maxHeight: 1200, everyNthFrame: 1, maxFramesInFlight: 1 } });
    env.chrome.event("Page.screencastFrame", { data: jpeg(780, 488), sessionId: 9, metadata: { deviceWidth: 1280, deviceHeight: 800, pageScaleFactor: 1, offsetTop: 0, scrollOffsetX: 0, scrollOffsetY: 40 } }, v);
    await tick();
    const d = decodeCastFrame(env.conn.binary.at(-1)!)!;
    expect(d.header).toEqual({ tab, n: 1, w: 780, h: 488, dw: 1280, dh: 800, psf: 1, top: 0, sx: 0, sy: 40, nav: 0 });
    expect(env.chrome.of("Page.screencastFrameAck").length).toBe(0);
    await env.relay.handle(env.conn, { t: "drawn", tab, n: 1 });
    await env.relay.handle(env.conn, { t: "drawn", tab, n: 1 });
    await env.relay.handle(env.conn, { t: "drawn", tab, n: 99 });
    expect(env.chrome.of("Page.screencastFrameAck").map((x) => [x.params, x.sessionId])).toEqual([[{ sessionId: 9 }, v]]);
  });
  test("backpressure: over 1 MiB buffered only the newest frame is kept, the dropped one acked to Chrome", async () => {
    const env = await setup();
    const tab = await openTab(env);
    await env.relay.handle(env.conn, { t: "view", tab, w: 640, h: 400, dpr: 1, q: 50, credit: 3 });
    await tick(10);
    const attach = env.chrome.of("Target.attachToTarget").at(-1)!;
    const v = `V-${attach.params.targetId}-${attach.id}`;
    env.conn.bufferedBytes = 2 * 1024 * 1024;
    for (const id of [1, 2, 3]) env.chrome.event("Page.screencastFrame", { data: jpeg(640, 400), sessionId: id, metadata: { deviceWidth: 1280, deviceHeight: 800 } }, v);
    await tick();
    expect(env.conn.binary.length).toBe(0);
    expect(env.chrome.of("Page.screencastFrameAck").map((x) => x.params.sessionId)).toEqual([1, 2]);
    env.conn.bufferedBytes = 0;
    env.relay.drained(env.conn as never);
    expect(env.conn.binary.length).toBe(1);
  });
  test("a view that comes before kitespan's session is ready on the tab starts once it is, once", async () => {
    const env = await setup();
    env.chrome.hold = true;
    const target = "C".repeat(32);
    env.chrome.event("Target.targetCreated", { targetInfo: { targetId: target, type: "page", url: "https://example.com/new", title: "New" } });
    env.chrome.event("Target.attachedToTarget", { sessionId: "SC", targetInfo: { targetId: target, type: "page", url: "https://example.com/new" }, waitingForDebugger: true });
    await tick(40);
    const tab = env.relay.tabList().find((t) => t.url === "https://example.com/new")!.id;
    await env.relay.handle(env.conn, { t: "view", tab, w: 640, h: 400, dpr: 1, q: 50, credit: 1 });
    expect(env.chrome.of("Target.attachToTarget").length).toBe(0);
    env.chrome.release();
    await tick(10);
    env.chrome.release();
    await quiet(env);
    expect(env.chrome.of("Target.attachToTarget").filter((x) => x.params.targetId === target).length).toBe(1);
    expect(env.chrome.of("Page.startScreencast").length).toBe(1);
  });
  test("at most 4 casts a tab and 8 in all: viewers_full", async () => {
    const env = await setup();
    const tab = await openTab(env);
    const conns = Array.from({ length: 5 }, () => new Conn());
    for (const c of conns) {
      env.relay.addConn(c as never);
      await env.relay.handle(c as never, { t: "view", tab, w: 100, h: 100, dpr: 1, q: 50, credit: 1 });
    }
    expect(conns.map((c) => c.of("error").map((e) => e.code))).toEqual([[], [], [], [], ["viewers_full"]]);
  });
  test("the stale-frame rule: a press against a frame from before a navigation is refused, its release dropped", async () => {
    const env = await setup();
    const tab = await openTab(env);
    const s = sessionOf(env, "https://example.com/");
    await env.relay.handle(env.conn, { t: "view", tab, w: 640, h: 400, dpr: 1, q: 50, credit: 3 });
    await tick(10);
    const attach = env.chrome.of("Target.attachToTarget").at(-1)!;
    const v = `V-${attach.params.targetId}-${attach.id}`;
    env.chrome.event("Page.screencastFrame", { data: jpeg(640, 400), sessionId: 1, metadata: { deviceWidth: 1280, deviceHeight: 800 } }, v);
    await tick();
    env.chrome.event("Page.frameNavigated", { frame: { id: `F-${s}`, url: "https://example.com/next" } }, s);
    await tick();
    const before = env.chrome.of("Input.dispatchMouseEvent").length;
    await env.relay.handle(env.conn, { t: "mouse", tab, n: 1, type: "mousePressed", x: 1, y: 1, button: "left", clicks: 1 });
    await env.relay.handle(env.conn, { t: "mouse", tab, n: 1, type: "mouseReleased", x: 1, y: 1, button: "left", clicks: 1 });
    expect(env.conn.of("error").map((e) => e.code)).toEqual(["stale_frame"]);
    expect(env.chrome.of("Input.dispatchMouseEvent").length).toBe(before);
    // Moves and wheels are never refused; coordinates past the frame's size are.
    await env.relay.handle(env.conn, { t: "mouse", tab, n: 1, type: "mouseMoved", x: 1, y: 1 });
    await env.relay.handle(env.conn, { t: "mouse", tab, n: 1, type: "mouseMoved", x: 5000, y: 1 });
    expect(env.chrome.of("Input.dispatchMouseEvent").length).toBe(before + 1);
    expect(env.conn.of("error").map((e) => e.code)).toEqual(["stale_frame", "bad_request"]);
  });
});

describe("Claude's tab mark, the size set by Claude and the chooser's owner (DESIGN-B1 2.8, 2.11, 2.13; the live run B3)", () => {
  const CHAT_A = "k3m7q2x4abk3m7q2x4ab";
  const CHAT_B = "m7q2x4abk3m7q2x4abk3";
  /** A result's Page section, as Playwright MCP 0.0.84 writes it: it names the tab with that URL and title. */
  const pageOf = (url: string) => `### Page\n- Page URL: ${url}\n- Page Title: Example`;
  const MODAL = "### Modal state\n- [File chooser]: can be handled by browser_file_upload";
  type Env = Awaited<ReturnType<typeof setup>>;
  /** A kitespan chat's browser call, then its result (none while `result` is null: the call still runs). */
  const claude = (env: Env, chat: string, id: string, tool: string, input: unknown, result: string | null) => {
    env.relay.acting.event(chat, { k: "tool_call", id, name: `mcp__playwright__${tool}`, input, parent: null });
    if (result !== null) env.relay.acting.event(chat, { k: "tool_result", id, text: result, isError: false, parent: null, report: null });
  };
  /** The tab as the newest published tab list shows it. */
  const shown = (env: Env, tab: string) => env.conn.of("tabs").at(-1)!.list.find((t) => t.id === tab)!;
  async function viewing(env: Env, tab: string, conn: Conn = env.conn): Promise<string> {
    await env.relay.handle(conn as never, { t: "view", tab, w: 640, h: 400, dpr: 1, q: 50, credit: 3 });
    await tick(10);
    const attach = env.chrome.of("Target.attachToTarget").at(-1)!;
    return `V-${attach.params.targetId}-${attach.id}`;
  }
  let ackId = 1_000;
  /** `n` screencast frames of cast session `v` whose page is `w` x `h` (CSS px). */
  const frames = (env: Env, v: string, w: number, h: number, n = 1) => {
    for (let i = 0; i < n; i++) env.chrome.event("Page.screencastFrame", { data: jpeg(640, 400), sessionId: ackId++, metadata: { deviceWidth: w, deviceHeight: h } }, v);
  };

  test("the tab list marks the tab as the chat whose result named it most recently; a chat's end takes its mark away, and the next newest keeps it", async () => {
    const env = await setup();
    const tab = await openTab(env);
    claude(env, CHAT_A, "a1", "browser_navigate", { url: "https://example.com/" }, pageOf("https://example.com/"));
    env.relay.acting.event(CHAT_A, { k: "turn_end", ok: true, subtype: "success", durationMs: 1, error: null, uuids: [] });
    await tick();
    expect(shown(env, tab).claudeLast).toBe(CHAT_A);
    claude(env, CHAT_B, "b1", "browser_snapshot", {}, pageOf("https://example.com/"));
    await tick();
    expect(shown(env, tab).claudeLast).toBe(CHAT_B);
    // B archived, deleted or its process closed: the registry's chatEnded hook.
    env.relay.acting.ended(CHAT_B);
    await tick();
    expect(shown(env, tab).claudeLast).toBe(CHAT_A);
    env.relay.acting.event(CHAT_A, { k: "exit", code: 0, signal: null, stderr: [] });
    await tick();
    expect(shown(env, tab).claudeLast).toBeNull();
  });

  test("browser_resize's result that names the tab shows its size, set by Claude, at once (a still page may send no frame at it), and it stays Claude's however long, never by a timer", async () => {
    let clock = 1_000_000;
    const env = await setup({ now: () => clock });
    const tab = await openTab(env);
    const v = await viewing(env, tab);
    frames(env, v, 1280, 800, 2);
    await tick();
    expect(shown(env, tab).size).toEqual({ kind: "desktop", w: 1280, h: 800, by: "user" });
    claude(env, CHAT_A, "s1", "browser_snapshot", {}, pageOf("https://example.com/"));
    claude(env, CHAT_A, "r1", "browser_resize", { width: 900, height: 700 }, pageOf("https://example.com/"));
    await tick();
    expect(shown(env, tab).size).toEqual({ kind: "other", w: 900, h: 700, by: "claude" });
    // The frames at that size, at once and a minute and ten minutes on: still set by Claude.
    frames(env, v, 900, 700, 3);
    await tick();
    for (const later of [60_000, 10 * 60_000]) {
      clock += later;
      frames(env, v, 900, 700, 3);
      await tick();
      expect([later, shown(env, tab).size]).toEqual([later, { kind: "other", w: 900, h: 700, by: "claude" }]);
    }
    // The next change, a size that kitespan did not make (another client's emulation): set elsewhere.
    frames(env, v, 1024, 768, 2);
    await tick();
    expect(shown(env, tab).size).toEqual({ kind: "other", w: 1024, h: 768, by: "other" });
    // Claude's size again, with no browser_resize result of a kitespan chat: set elsewhere too.
    frames(env, v, 900, 700, 2);
    await tick();
    expect(shown(env, tab).size).toEqual({ kind: "other", w: 900, h: 700, by: "other" });
    // The pane's Page size: Desktop, by the user.
    await env.relay.handle(env.conn, { t: "tab_size", rid: RID(), tab, kind: "desktop", force: true });
    await tick();
    expect(shown(env, tab).size).toEqual({ kind: "desktop", w: 1280, h: 800, by: "user" });
  });

  test("frames at Claude's size that come while its browser_resize runs never show set elsewhere; its result makes it Claude's, and it stays", async () => {
    let clock = 1_000_000;
    const env = await setup({ now: () => clock });
    const tab = await openTab(env);
    const v = await viewing(env, tab);
    claude(env, CHAT_A, "s1", "browser_snapshot", {}, pageOf("https://example.com/"));
    claude(env, CHAT_A, "r1", "browser_resize", { width: 900, height: 700 }, null);
    frames(env, v, 900, 700, 4);
    await tick();
    expect(shown(env, tab).size).toEqual({ kind: "desktop", w: 1280, h: 800, by: "user" });
    env.relay.acting.event(CHAT_A, { k: "tool_result", id: "r1", text: pageOf("https://example.com/"), isError: false, parent: null, report: null });
    await tick();
    expect(shown(env, tab).size).toEqual({ kind: "other", w: 900, h: 700, by: "claude" });
    clock += 12_000;
    frames(env, v, 900, 700, 3);
    await tick();
    expect(shown(env, tab).size).toEqual({ kind: "other", w: 900, h: 700, by: "claude" });
    // A resize that failed, or one whose result names another tab, sets nothing on this tab.
    claude(env, CHAT_A, "r2", "browser_resize", { width: 500, height: 500 }, null);
    env.relay.acting.event(CHAT_A, { k: "tool_result", id: "r2", text: "### Error\nError: no page", isError: true, parent: null, report: null });
    await tick();
    expect(shown(env, tab).size).toEqual({ kind: "other", w: 900, h: 700, by: "claude" });
  });

  test("the chooser's owner is decided when it opens and kept: Claude's while a kitespan chat's browser call runs on that tab, the pane's after its input in the second before, else other", async () => {
    let clock = 1_000_000;
    const env = await setup({ now: () => clock });
    const a = await openTab(env, "https://example.com/a");
    const b = await openTab(env, "https://example.com/b");
    const sa = sessionOf(env, "https://example.com/a");
    const sb = sessionOf(env, "https://example.com/b");
    await viewing(env, a);
    await viewing(env, b);
    const opened = async (s: string, backendNodeId: number) => {
      env.chrome.event("Page.fileChooserOpened", { frameId: `F-${s}`, mode: "selectSingle", backendNodeId }, s);
      await tick(20);
      return env.conn.of("chooser").at(-1)!;
    };
    // Claude's click runs on tab a (its chat's last result named a) when the chooser opens there.
    claude(env, CHAT_A, "s1", "browser_snapshot", {}, pageOf("https://example.com/a"));
    claude(env, CHAT_A, "c1", "browser_click", { element: "Notes file", ref: "e3" }, null);
    expect(await opened(sa, 42)).toMatchObject({ tab: a, id: 1, by: "claude" });
    // The click's result clears the acting list: the chooser stays Claude's, for a viewer that comes later too.
    env.relay.acting.event(CHAT_A, { k: "tool_result", id: "c1", text: MODAL, isError: false, parent: null, report: null });
    await tick();
    expect(env.relay.acting.list()).toEqual([]);
    const late = new Conn();
    env.relay.addConn(late as never);
    await env.relay.handle(late as never, { t: "view", tab: a, w: 640, h: 400, dpr: 1, q: 50, credit: 1 });
    expect(late.of("chooser")).toEqual([expect.objectContaining({ tab: a, id: 1, by: "claude" })]);
    // A call of a chat that runs on another tab (b) does not make tab a's chooser Claude's; on tab b it does.
    claude(env, CHAT_B, "s2", "browser_snapshot", {}, pageOf("https://example.com/b"));
    claude(env, CHAT_B, "c2", "browser_click", {}, null);
    expect(await opened(sa, 43)).toMatchObject({ tab: a, id: 2, by: "other" });
    expect(await opened(sb, 44)).toMatchObject({ tab: b, id: 1, by: "claude" });
    // The pane's input on tab a in the second before it opened: the pane's, even while Claude's call runs there.
    claude(env, CHAT_A, "c3", "browser_click", {}, null);
    await env.relay.handle(env.conn, { t: "key", tab: a, n: 0, type: "keyDown", key: "Enter", code: "Enter", vk: 13 });
    clock += 500;
    expect(await opened(sa, 45)).toMatchObject({ tab: a, id: 3, by: "pane" });
    // Over a second after the input, with Claude's click still running on tab a: Claude's.
    clock += 1_000;
    expect(await opened(sa, 46)).toMatchObject({ tab: a, id: 4, by: "claude" });
  });

  /** The size as the newest tab list shows it, in one word: kind:wxh:by. */
  const sizeOf = (env: Env, tab: string) => {
    const s = shown(env, tab).size;
    return `${s.kind}:${s.w}x${s.h}:${s.by}`;
  };
  /** Claude's tab: its first result named it, then browser_resize to 900 x 700 came back, and frames at that size. */
  async function claudeSized(env: Env, tab: string, v: string | null) {
    claude(env, CHAT_A, "s1", "browser_snapshot", {}, pageOf("https://example.com/"));
    claude(env, CHAT_A, "r1", "browser_resize", { width: 900, height: 700 }, pageOf("https://example.com/"));
    if (v) frames(env, v, 900, 700, 3);
    await tick();
    expect(sizeOf(env, tab)).toBe("other:900x700:claude");
  }

  test("one frame at another size keeps Claude's size and its source: a new size needs two frames in a row (the review's ONE_ODD_FRAME)", async () => {
    const env = await setup({ now: () => 1_000_000 });
    const tab = await openTab(env);
    const v = await viewing(env, tab);
    await claudeSized(env, tab, v);
    const seq: string[] = [];
    frames(env, v, 900, 650, 1);
    await tick();
    seq.push(sizeOf(env, tab));
    frames(env, v, 900, 700, 3);
    await tick();
    seq.push(sizeOf(env, tab));
    // Two in a row at a new size: a change that kitespan did not make.
    frames(env, v, 900, 650, 2);
    await tick();
    seq.push(sizeOf(env, tab));
    expect(seq).toEqual(["other:900x700:claude", "other:900x700:claude", "other:900x650:other"]);
  });

  test("a second browser_resize of Claude's: its frames before its result keep the size that shows, and the result makes the new one Claude's (the review's TWICE)", async () => {
    const env = await setup({ now: () => 1_000_000 });
    const tab = await openTab(env);
    const v = await viewing(env, tab);
    await claudeSized(env, tab, v);
    const seq: string[] = [];
    claude(env, CHAT_A, "r2", "browser_resize", { width: 800, height: 600 }, null);
    frames(env, v, 800, 600, 1);
    await tick();
    seq.push(sizeOf(env, tab));
    frames(env, v, 800, 600, 3);
    await tick();
    seq.push(sizeOf(env, tab));
    env.relay.acting.event(CHAT_A, { k: "tool_result", id: "r2", text: pageOf("https://example.com/"), isError: false, parent: null, report: null });
    await tick();
    seq.push(sizeOf(env, tab));
    frames(env, v, 800, 600, 3);
    await tick();
    seq.push(sizeOf(env, tab));
    expect(seq).toEqual(["other:900x700:claude", "other:900x700:claude", "other:800x600:claude", "other:800x600:claude"]);
  });

  test("the pane's Page size after Claude's: the frames already in flight at Claude's size do not show set elsewhere; a size that did not change shows once they are past (the review's PANE_AFTER_CLAUDE)", async () => {
    const env = await setup({ now: () => 1_000_000 });
    const tab = await openTab(env);
    const v = await viewing(env, tab);
    await claudeSized(env, tab, v);
    const seq: string[] = [];
    await env.relay.handle(env.conn, { t: "tab_size", rid: RID(), tab, kind: "desktop", force: true });
    await tick();
    seq.push(sizeOf(env, tab));
    // The cast's credit (3) bounds the frames in flight.
    frames(env, v, 900, 700, 1);
    await tick();
    seq.push(sizeOf(env, tab));
    frames(env, v, 900, 700, 1);
    await tick();
    seq.push(sizeOf(env, tab));
    frames(env, v, 1280, 800, 1);
    await tick();
    seq.push(sizeOf(env, tab));
    // Now the page shows the Desktop size, so the next frames at another size are a change again.
    frames(env, v, 900, 700, 2);
    await tick();
    seq.push(sizeOf(env, tab));
    expect(seq).toEqual(["desktop:1280x800:user", "desktop:1280x800:user", "desktop:1280x800:user", "desktop:1280x800:user", "other:900x700:other"]);
    // A Page size whose change never shows (another client's size holds): once the frames in flight are past, the
    // size that the frames show.
    await env.relay.handle(env.conn, { t: "tab_size", rid: RID(), tab, kind: "desktop", force: true });
    frames(env, v, 900, 700, 3);
    await tick();
    expect(sizeOf(env, tab)).toBe("desktop:1280x800:user");
    frames(env, v, 900, 700, 2);
    await tick();
    expect(sizeOf(env, tab)).toBe("other:900x700:other");
  });

  test("Claude's size goes when the chat that set it ends (its Playwright session, and its size, go with its process): the tab's own size again, with no frame (the review's ENDED_NO_VIEWER)", async () => {
    const env = await setup({ now: () => 1_000_000 });
    const tab = await openTab(env);
    await claudeSized(env, tab, null);
    // Another chat's end changes nothing.
    env.relay.acting.ended(CHAT_B);
    await tick();
    expect(sizeOf(env, tab)).toBe("other:900x700:claude");
    env.relay.acting.ended(CHAT_A);
    await tick();
    expect([sizeOf(env, tab), shown(env, tab).claudeLast]).toEqual(["desktop:1280x800:user", null]);
    // The same by the exit event, on a Phone tab: its Phone size again.
    const phone = await openTab(env, "https://example.com/p");
    await env.relay.handle(env.conn, { t: "tab_size", rid: RID(), tab: phone, kind: "phone", w: 390, h: 844, force: true });
    claude(env, CHAT_B, "s2", "browser_snapshot", {}, pageOf("https://example.com/p"));
    claude(env, CHAT_B, "r2", "browser_resize", { width: 900, height: 700 }, pageOf("https://example.com/p"));
    await tick();
    expect(sizeOf(env, phone)).toBe("other:900x700:claude");
    env.relay.acting.event(CHAT_B, { k: "exit", code: 0, signal: null, stderr: [] });
    await tick();
    expect(sizeOf(env, phone)).toBe("phone:390x844:user");
  });

  test("Claude's size, then its chat ends on a tab with a cast: the frames tell (Archive comes before its process closes), so its last frames at Claude's size never show set elsewhere, and the first at the tab's own size shows that", async () => {
    const env = await setup({ now: () => 1_000_000 });
    const tab = await openTab(env);
    const v = await viewing(env, tab);
    await claudeSized(env, tab, v);
    env.relay.acting.ended(CHAT_A);
    await tick();
    const seq = [sizeOf(env, tab)];
    frames(env, v, 900, 700, 8);
    await tick();
    seq.push(sizeOf(env, tab));
    frames(env, v, 1280, 800, 1);
    await tick();
    seq.push(sizeOf(env, tab));
    expect(seq).toEqual(["other:900x700:claude", "other:900x700:claude", "desktop:1280x800:user"]);
    // The chat's end is past: a later size of Claude's again, but with no chat's resize, is a change kitespan did not make.
    frames(env, v, 900, 700, 2);
    await tick();
    expect(sizeOf(env, tab)).toBe("other:900x700:other");
  });

  test("a chooser that a page opens while a kitespan chat navigates another tab is not Claude's: a navigate, tabs or close call gives no user activation in another tab (the review's SCRIPT_CHOOSER_WHILE_NAV_ELSEWHERE)", async () => {
    const env = await setup({ now: () => 1_000_000 });
    const a = await openTab(env, "https://example.com/a");
    const b = await openTab(env, "https://example.com/b");
    const sa = sessionOf(env, "https://example.com/a");
    await viewing(env, a);
    const opened = async (backendNodeId: number) => {
      env.chrome.event("Page.fileChooserOpened", { frameId: `F-${sa}`, mode: "selectSingle", backendNodeId }, sa);
      await tick(20);
      return env.conn.of("chooser").at(-1)!.by;
    };
    // Chat B last used tab b; its navigate, tabs and close calls run (tab unknown until their result).
    claude(env, CHAT_B, "s2", "browser_snapshot", {}, pageOf("https://example.com/b"));
    const seq: string[] = [];
    for (const [id, tool] of [["n1", "browser_navigate"], ["t1", "browser_tabs"], ["x1", "browser_close"]] as const) {
      claude(env, CHAT_B, id, tool, {}, null);
      seq.push(`${tool}:${await opened(40 + seq.length)}`);
      env.relay.acting.event(CHAT_B, { k: "tool_result", id, text: pageOf("https://example.com/b"), isError: false, parent: null, report: null });
    }
    // A chat with no known tab yet whose navigate runs: its tab may be tab a, so Claude's.
    claude(env, CHAT_A, "n2", "browser_navigate", { url: "https://example.com/a" }, null);
    seq.push(`new chat's navigate:${await opened(50)}`);
    env.relay.acting.event(CHAT_A, { k: "tool_result", id: "n2", text: pageOf("https://example.com/b"), isError: false, parent: null, report: null });
    // B's click with tab b known and A's navigate from tab b: tab a's chooser is no one's of theirs.
    claude(env, CHAT_B, "c1", "browser_click", {}, null);
    claude(env, CHAT_A, "n3", "browser_navigate", { url: "https://example.com/c" }, null);
    seq.push(`click on b and navigate from b:${await opened(51)}`);
    expect(seq).toEqual(["browser_navigate:other", "browser_tabs:other", "browser_close:other", "new chat's navigate:claude", "click on b and navigate from b:other"]);
    void b;
  });

  test("the chat that opened Claude's chooser ends while its card shows: the chooser frame again, the same id, now by other (no Claude is there to take it); another chat's end changes nothing", async () => {
    const env = await setup({ now: () => 1_000_000 });
    const a = await openTab(env, "https://example.com/a");
    const sa = sessionOf(env, "https://example.com/a");
    await viewing(env, a);
    claude(env, CHAT_A, "s1", "browser_snapshot", {}, pageOf("https://example.com/a"));
    claude(env, CHAT_A, "c1", "browser_click", {}, null);
    env.chrome.event("Page.fileChooserOpened", { frameId: `F-${sa}`, mode: "selectSingle", backendNodeId: 42 }, sa);
    await tick(20);
    expect(env.conn.of("chooser")).toEqual([expect.objectContaining({ tab: a, id: 1, by: "claude" })]);
    env.relay.acting.ended(CHAT_B);
    await tick();
    expect(env.conn.of("chooser").length).toBe(1);
    env.relay.acting.ended(CHAT_A);
    await tick();
    expect(env.conn.of("chooser")).toEqual([expect.objectContaining({ tab: a, id: 1, by: "claude" }), expect.objectContaining({ tab: a, id: 1, by: "other" })]);
    // A second word of the same end sends nothing more, and a viewer that comes later gets the page's chooser.
    env.relay.acting.ended(CHAT_A);
    await tick();
    expect(env.conn.of("chooser").length).toBe(2);
    const late = new Conn();
    env.relay.addConn(late as never);
    await env.relay.handle(late as never, { t: "view", tab: a, w: 640, h: 400, dpr: 1, q: 50, credit: 1 });
    expect(late.of("chooser")).toEqual([expect.objectContaining({ tab: a, id: 1, by: "other" })]);
    // A chooser of Claude's that opens on the exit event's chat: the same.
    claude(env, CHAT_B, "s2", "browser_snapshot", {}, pageOf("https://example.com/a"));
    claude(env, CHAT_B, "c2", "browser_click", {}, null);
    env.chrome.event("Page.fileChooserOpened", { frameId: `F-${sa}`, mode: "selectSingle", backendNodeId: 43 }, sa);
    await tick(20);
    expect(env.conn.of("chooser").at(-1)).toMatchObject({ id: 2, by: "claude" });
    env.relay.acting.event(CHAT_B, { k: "exit", code: null, signal: "SIGKILL", stderr: [] });
    await tick();
    expect(env.conn.of("chooser").at(-1)).toMatchObject({ id: 2, by: "other" });
  });
});

describe("the stale-frame rule over made-up histories (DESIGN-B1 2.14)", () => {
  const frames = new Map<number, FrameMark>();
  for (let n = 1; n <= 70; n++) keepMark(frames, { n, nav: n < 50 ? 1 : 2, sx: 0, sy: n < 60 ? 0 : 300, at: n * 100 });
  test("only the last 64 are kept", () => {
    expect(frames.size).toBe(64);
    expect(frames.has(6)).toBe(false);
    expect(frames.has(7)).toBe(true);
  });
  const latest = frames.get(70)!;
  test("a frame from before a navigation, or one no longer kept just after a navigation, is stale", () => {
    expect(stalePress(frames, latest, 40, { nav: 2, navAt: 5_000 }, 7_100)).toBe(true);
    expect(stalePress(frames, latest, 3, { nav: 2, navAt: 5_000 }, 7_100)).toBe(true);
    expect(stalePress(frames, latest, 3, { nav: 2, navAt: 5_000 }, 11_000)).toBe(false);
  });
  test("a frame that the page scrolled under, more than 1 s older than the newest, is stale; a recent one is not", () => {
    expect(stalePress(frames, latest, 55, { nav: 2, navAt: 5_000 }, 7_100)).toBe(true);
    expect(stalePress(frames, latest, 65, { nav: 2, navAt: 5_000 }, 7_100)).toBe(false);
    expect(stalePress(frames, latest, 70, { nav: 2, navAt: 5_000 }, 7_100)).toBe(false);
  });
});

describe("what the fixed scripts give back is checked again before it reaches a page", () => {
  test("picker facts: kinds, caps, a colour list of hex values only", () => {
    expect(pickerFactsOf({ kind: "evil" })).toBeNull();
    const many = Array.from({ length: 600 }, (_, i) => ({ group: null, label: "x".repeat(300), disabled: false, index: i }));
    const s = pickerFactsOf({ kind: "select", open: true, box: { x: 1e9, y: Number.NaN }, label: "y".repeat(100), selected: 2, items: many })!;
    if (s.kind !== "select") throw new Error("kind");
    expect([s.items.length, s.items[0]!.label.length, s.label.length, s.box]).toEqual([500, 200, 80, { x: 100_000, y: 0, w: 0, h: 0 }]);
    const c = pickerFactsOf({ kind: "color", value: "#336699", list: ["#ff0000", "red", "javascript:x", "#00ff00"] })!;
    if (c.kind === "select") throw new Error("kind");
    expect(c.list).toEqual(["#ff0000", "#00ff00"]);
  });
  test("focus facts: never a value", () => {
    expect(focusFactsOf({ editable: true, type: "email", value: "secret@x", inputmode: "email", enterkeyhint: "go", password: false, box: { x: 1, y: 2, w: 3, h: 4 } })).toEqual({ editable: true, type: "email", inputmode: "email", enterkeyhint: "go", password: false, box: { x: 1, y: 2, w: 3, h: 4 } });
    expect(focusFactsOf("nope")).toEqual({ editable: false });
  });
  test("a JPEG's size from its frame header", () => {
    const b = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc2, 0, 17, 8, 0x01, 0xe8, 0x03, 0x0c, 3, 0, 0]);
    expect(jpegSize(b)).toEqual({ w: 780, h: 488 });
    expect(jpegSize(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
