// Claude's tab and kitespan's spare (DESIGN-B1 D-6, 2.8; round Q3), with a fake debugging connection under the real
// client. The lead's second live run found Claude's work in kitespan's hidden spare tab: Playwright's MCP takes as its
// current tab the first page of its default context, which is the page with the lowest target id (Chrome answers a
// browser-level Target.setAutoAttach with the existing pages in the order of their ids: Q3's probe, 12 of 12 connects
// and Playwright 0.0.84's own pages() in that order), not the oldest one. So:
// 1. The order: the tab that the pane shows gets the lowest target id, and the spare comes after it. At a start, the
//    start tab (a new tab whose id sorts before it takes its place, the start tab closes, so the lowest listed id only
//    goes down); at a reopen (a reboot's reconcile, Stop and Start), the saved tab that a pane socket viewed last
//    (tabs.json `shown`), else the newest saved tab, takes the lowest of the blank tabs made for the saved tabs, and the
//    blank start tab's id is kept above it. The spare is made only after them, and made again while its id sorts first
//    (also at an adoption). While Start makes its tabs, no tab list goes to the pane.
// 2. The safety net: a spare that another client uses (a navigation that kitespan did not make, or a kitespan chat's
//    browser result that names it alone) joins the tab list at once (also one used while no server was attached, or
//    while frozen), a new spare is made (never while frozen), the viewer of the start tab that no pane navigated, and of
//    no other blank tab, follows it with Back to the start tab, and every other viewer sees it in the strip with
//    Claude's mark.

import { describe, expect, test } from "bun:test";
import { CdpClient, type CdpTransport } from "../../server/browser/cdp";
import type { Downloads } from "../../server/browser/downloads";
import { Relay, SPARE_TRIES } from "../../server/browser/relay";
import type { TabsFile, TabsFileStore } from "../../server/browser/tabs";
import type { BrowserServerFrame, BrowserTabView } from "../../shared/browser";

interface Sent {
  id: number;
  method: string;
  params: Record<string, any>;
  sessionId?: string;
}

interface Page {
  url: string;
  title: string;
  session: string;
  window: number;
  history: { url: string }[];
}

/** A target id that sorts by its first character: `id("8")` is "8" and 31 zeros. */
const id = (first: string, n = 0) => `${first}${String(n).padStart(31, "0")}`;

/**
 * The browser as the relay sees it. Its pages, their windows and their histories; createTarget takes its ids from
 * `ids` (else a counter); the attach events of a new target come before its reply, as Chrome sends them; closeTarget
 * ends the target. `mcpFirstPage` is the page that a Playwright MCP connecting now takes as its current tab.
 */
class Chrome {
  readonly sent: Sent[] = [];
  readonly pages = new Map<string, Page>();
  ids: string[] = [];
  /** Existing pages are attached when the relay turns auto-attach on (false: only Target.getTargets tells them). */
  attachAtAutoAttach = true;
  /** Targets whose close takes this long (ms) after its reply to end (a loaded machine's slow window close). */
  readonly slowClose = new Map<string, number>();
  private nextWindow = 100;
  private counter = 1;
  private message: (text: string) => void = () => {};
  readonly client: CdpClient;

  constructor() {
    const t: CdpTransport = { send: (text) => this.got(JSON.parse(text)), close() {}, onMessage: (cb) => (this.message = cb), onClose() {} };
    this.client = new CdpClient(t);
  }

  /** A page that exists before the relay connects (the start tab), or another client's tab. */
  addPage(target: string, url = "about:blank", window = this.nextWindow++): Page {
    const page = { url, title: "", session: `S-${target}`, window, history: [{ url }] };
    this.pages.set(target, page);
    return page;
  }

  /** The tab's events, as Chrome sends them once kitespan's auto-attach is on. */
  announce(target: string): void {
    const p = this.pages.get(target)!;
    const info = { targetId: target, type: "page", url: p.url, title: p.title };
    this.event("Target.targetCreated", { targetInfo: info });
    this.event("Target.attachedToTarget", { sessionId: p.session, targetInfo: info, waitingForDebugger: true });
  }

  /** The page that a Playwright MCP that connects now takes first: Chrome lists the pages in the order of their ids. */
  mcpFirstPage(): string | null {
    return [...this.pages.keys()].sort()[0] ?? null;
  }

  /** Runs after a call's events and before its reply (another event of the server's in that gap). */
  beforeReply: ((m: Sent) => void) | null = null;

  private got(m: Sent): void {
    this.sent.push(m);
    queueMicrotask(() => {
      const r = this.result(m);
      this.beforeReply?.(m);
      this.message(JSON.stringify({ id: m.id, result: r }));
    });
  }

  private result(m: Sent): unknown {
    const pageOf = (s?: string) => [...this.pages.entries()].find(([, p]) => p.session === s);
    switch (m.method) {
      case "Target.setAutoAttach":
        if (this.attachAtAutoAttach) for (const t of this.pages.keys()) this.announce(t);
        return {};
      case "Target.getTargets":
        return { targetInfos: [...this.pages.entries()].map(([targetId, p]) => ({ targetId, type: "page", url: p.url, title: p.title })) };
      case "Target.createTarget": {
        const target = this.ids.shift() ?? id("F", this.counter++);
        const newest = Math.max(99, ...[...this.pages.values()].map((p) => p.window));
        this.addPage(target, "about:blank", m.params.newWindow ? this.nextWindow++ : newest);
        this.announce(target);
        return { targetId: target };
      }
      case "Target.closeTarget": {
        const target = m.params.targetId as string;
        const p = this.pages.get(target);
        if (!p) return { success: false };
        const end = () => {
          this.pages.delete(target);
          this.event("Target.detachedFromTarget", { sessionId: p.session, targetId: target });
          this.event("Target.targetDestroyed", { targetId: target });
        };
        const ms = this.slowClose.get(target);
        if (ms) setTimeout(end, ms);
        else end();
        return { success: true };
      }
      case "Target.attachToTarget":
        return { sessionId: `V-${m.params.targetId}-${m.id}` };
      case "Browser.getWindowForTarget":
        return { windowId: this.pages.get(m.params.targetId)?.window ?? 1, bounds: { width: 1280, height: 943 } };
      case "Page.getLayoutMetrics":
        return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 800 } };
      case "Page.getFrameTree":
        return { frameTree: { frame: { id: `F-${m.sessionId}`, url: pageOf(m.sessionId)?.[1].url ?? "about:blank" } } };
      case "Page.getNavigationHistory": {
        const p = pageOf(m.sessionId)?.[1];
        const entries = (p?.history ?? [{ url: "about:blank" }]).map((e, i) => ({ id: i + 1, url: e.url, title: "" }));
        return { currentIndex: entries.length - 1, entries };
      }
      case "Page.createIsolatedWorld":
        return { executionContextId: 77 };
      case "Runtime.callFunctionOn":
        return { result: { value: null } };
      default:
        return {};
    }
  }

  /** Another client (Claude's MCP) navigates a page: Chrome's events, in its order, on kitespan's session. */
  navigateByOther(target: string, url: string, title = ""): void {
    const p = this.pages.get(target)!;
    this.event("Page.frameStartedNavigating", { frameId: `F-${p.session}`, url, loaderId: "L", navigationType: "differentDocument" }, p.session);
    p.url = url;
    p.title = title;
    p.history.push({ url });
    this.event("Page.frameNavigated", { frame: { id: `F-${p.session}`, url, loaderId: "L" }, type: "Navigation" }, p.session);
    this.event("Target.targetInfoChanged", { targetInfo: { targetId: target, type: "page", url, title } });
  }

  event(method: string, params: Record<string, unknown>, sessionId?: string): void {
    this.message(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }));
  }

  of(method: string): Sent[] {
    return this.sent.filter((s) => s.method === method);
  }

  /** Each Target.createTarget that the relay sent: "window" for a newWindow one, else "plain". */
  created(): string[] {
    return this.of("Target.createTarget").map((s) => (s.params.newWindow ? "window" : "plain"));
  }
}

class Conn {
  frames: BrowserServerFrame[] = [];
  send(f: BrowserServerFrame) {
    this.frames.push(f);
  }
  sendBinary(b: Uint8Array) {
    return b.length;
  }
  buffered() {
    return 0;
  }
  close() {}
  of<T extends BrowserServerFrame["t"]>(t: T) {
    return this.frames.filter((f): f is Extract<BrowserServerFrame, { t: T }> => f.t === t);
  }
  /** The newest tab list that this socket got. */
  list(): BrowserTabView[] {
    return this.of("tabs").at(-1)?.list ?? [];
  }
}

const OWN = { origins: ["http://127.0.0.1:7945"], loopbackPorts: [7945] };
const RID = () => crypto.randomUUID();
const tick = (ms = 5) => Bun.sleep(ms);
const CHAT = "k3m7q2x4abk3m7q2x4ab";
const OTHER = "q2x4abk3m7q2x4abk3m7";

async function quiet(chrome: Chrome) {
  let n = -1;
  while (n !== chrome.sent.length) {
    n = chrome.sent.length;
    await tick(15);
  }
}

/** The relay on the fake browser; `box.file` is its tabs.json as the store holds it (each save at once). */
function makeRelay(chrome: Chrome, saved: TabsFile | null = null, box: { file: TabsFile | null } = { file: saved }) {
  box.file = saved;
  const tabsFile = { read: async () => box.file, save: (f: TabsFile) => void (box.file = f), flush: async () => {}, count: async () => 0, clear: async () => {} } as unknown as TabsFileStore;
  const downloads = { folder: "/state/browser/downloads", list: () => [], begin() {}, progress: async () => {}, guidOf: () => null } as unknown as Downloads;
  return new Relay({
    refused: () => OWN,
    tabsFile,
    downloads,
    uploadPaths: async () => null,
    host: () => ({ state: "running", port: 9345 }),
    timing: { probeMs: 1, selectionMs: 1, focusMinMs: 1, publishMs: 1, infoSoonMs: 1, readyMs: 500, followMs: 1_000, spareGoneMs: 200 },
  });
}

/** Kitespan's Start: Chrome with its start tab, then the relay's attach of a fresh start. */
async function start(o: { startTab?: string; ids?: string[]; attachAtAutoAttach?: boolean; saved?: TabsFile | null } = {}) {
  const chrome = new Chrome();
  const startTab = o.startTab ?? id("8");
  chrome.addPage(startTab);
  chrome.ids = [...(o.ids ?? [])];
  chrome.attachAtAutoAttach = o.attachAtAutoAttach ?? true;
  const box: { file: TabsFile | null } = { file: null };
  const relay = makeRelay(chrome, o.saved ?? null, box);
  await relay.attach(chrome.client, { fresh: true, start: "1@x", port: 9345 });
  // Tabs that only Target.getTargets told: Chrome's attach events come now.
  if (!chrome.attachAtAutoAttach && chrome.pages.has(startTab)) chrome.announce(startTab);
  await quiet(chrome);
  return { chrome, relay, startTab, box };
}

/** Three saved tabs (a reopen's tabs.json), with the tab that a pane socket viewed last when `shown` is given. */
function savedThree(shown?: string): TabsFile {
  const t = (n: number, tab: string, path: string) => ({ id: tab, target: id("0", n), url: `https://example.com/${path}`, title: path.toUpperCase(), by: "user" as const, at: `2026-11-09T00:00:0${n}.000Z`, size: { kind: "desktop" as const } });
  return { v: 1, browserStart: "0@old", spare: null, tabs: [t(0, "abcdefghij", "a"), t(1, "bcdefghijk", "b"), t(2, "cdefghijkm", "c")], ...(shown ? { shown } : {}) };
}

/** The calls that make, close and navigate targets, in order: "create", "close <first char>", "navigate <url> on <first char>". */
function targetCalls(chrome: Chrome): string[] {
  const at = (s?: string) => (s ?? "").replace(/^S-/, "").slice(0, 1);
  return chrome.sent
    .filter((s) => ["Target.createTarget", "Target.closeTarget", "Page.navigate"].includes(s.method))
    .map((s) => (s.method === "Page.navigate" ? `navigate ${s.params.url} on ${at(s.sessionId)}` : s.method === "Target.closeTarget" ? `close ${String(s.params.targetId).slice(0, 1)}` : "create"));
}

/** The target of a listed tab (read from the relay's own model: the page never sees a target). */
function targetOfView(relay: Relay, v: BrowserTabView): string | undefined {
  const r = relay as unknown as { tabs: Map<string, { id: string | null; target: string }> };
  return [...r.tabs.values()].find((t) => t.id === v.id)?.target;
}

async function viewer(relay: Relay, tab: string) {
  const conn = new Conn();
  relay.addConn(conn);
  await relay.handle(conn, { t: "view", tab, w: 640, h: 400, dpr: 1, q: 40, credit: 2 });
  return conn;
}

async function call(relay: Relay, chat: string, tool: string, text: string, input: unknown = {}) {
  const idc = `toolu_${crypto.randomUUID().slice(0, 8)}`;
  relay.acting.event(chat, { k: "tool_call", id: idc, name: `mcp__playwright__${tool}`, input, parent: null });
  relay.acting.event(chat, { k: "tool_result", id: idc, text, isError: false, parent: null, report: null });
  await tick();
}

describe("the order: the tab the pane shows first, the spare after it, and never a spare whose id sorts first (D-6, Q3)", () => {
  test("Start: the spare is made after the start tab is known; a new tab whose id sorts before the start tab's takes the start tab's place (the start tab closes, and is gone, before the next one is made), so the lowest listed id only goes down; a connecting MCP's first page is the one tab that the pane shows", async () => {
    const { chrome, relay, startTab } = await start({ ids: [id("3"), id("1"), id("2")] });
    const targetCalls = chrome.sent.filter((s) => s.method === "Target.createTarget" || s.method === "Target.closeTarget").map((s) => (s.method === "Target.closeTarget" ? `close ${String(s.params.targetId).slice(0, 1)}` : "create"));
    // 3... sorts before the start tab 8...: it stands in for it. 1... sorts before 3...: it stands in. 2... sorts after 1...: the spare.
    expect(startTab).toBe(id("8"));
    expect(targetCalls).toEqual(["create", "close 8", "create", "close 3", "create"]);
    expect(chrome.created()).toEqual(["window", "window", "window"]);
    expect([...chrome.pages.keys()].sort()).toEqual([id("1"), id("2")]);
    expect(relay.tabList()).toHaveLength(1);
    expect(relay.tabList()[0]).toMatchObject({ url: "about:blank", by: "user", hidden: false });
    expect(targetOfView(relay, relay.tabList()[0]!)).toBe(id("1"));
    expect(chrome.mcpFirstPage()).toBe(id("1"));
    // The spare (2...) is the newest window.
    expect(chrome.pages.get(id("2"))!.window).toBe(Math.max(...[...chrome.pages.values()].map((p) => p.window)));
  });

  test("Start whose start tab takes longer to close than kitespan waits: the next stand-in replaces the stand-in, never the closing start tab, which leaves the list at once", async () => {
    const chrome = new Chrome();
    chrome.addPage(id("8"));
    chrome.slowClose.set(id("8"), 400);
    chrome.ids = [id("3"), id("1"), id("2")];
    const relay = makeRelay(chrome, null);
    const conn = new Conn();
    relay.addConn(conn);
    await relay.attach(chrome.client, { fresh: true, start: "1@x", port: 9345 });
    expect(targetCalls(chrome)).toEqual(["create", "close 8", "create", "close 3", "create"]);
    expect(conn.list().map((t) => targetOfView(relay, t))).toEqual([id("1")]);
    await Bun.sleep(500);
    await quiet(chrome);
    expect([...chrome.pages.keys()].sort()).toEqual([id("1"), id("2")]);
    expect(conn.list().map((t) => targetOfView(relay, t))).toEqual([id("1")]);
    expect(chrome.mcpFirstPage()).toBe(id("1"));
  });

  test("Start, a spare whose id sorts after the start tab's at once: one spare, nothing closed", async () => {
    const { chrome, relay, startTab } = await start({ ids: [id("A")] });
    expect(chrome.created()).toEqual(["window"]);
    expect(chrome.of("Target.closeTarget")).toEqual([]);
    expect(chrome.mcpFirstPage()).toBe(startTab);
    expect(relay.tabList()).toHaveLength(1);
  });

  test(`at most ${SPARE_TRIES} new tabs in a row; then the last one stays as the spare (the safety net covers it)`, async () => {
    const { chrome, relay } = await start({ ids: Array.from({ length: SPARE_TRIES + 2 }, (_, i) => id(String(7 - i), 1)).map((x, i) => (i < 8 ? x : id("0", i))) });
    expect(chrome.created()).toHaveLength(SPARE_TRIES);
    expect(chrome.of("Target.closeTarget")).toHaveLength(SPARE_TRIES - 1);
    expect(chrome.pages.size).toBe(2);
    expect(relay.tabList()).toHaveLength(1);
  });

  test("later (not a fresh start): a new spare whose id sorts first is closed and made again, and the blank start tab stays (an MCP may hold it by now)", async () => {
    const { chrome, relay, startTab } = await start({ ids: [id("C"), id("E"), id("1"), id("3"), id("F")] });
    const conn = new Conn();
    relay.addConn(conn);
    // New tab at an address (E...), then its spare: 1... and 3... sort before 8... and E...; F... does not.
    await relay.handle(conn, { t: "tab_new", rid: RID(), url: "https://example.com/" });
    await quiet(chrome);
    const closes = chrome.of("Target.closeTarget").map((s) => String(s.params.targetId).slice(0, 1));
    expect(closes).toEqual(["1", "3", "C"]);
    expect(chrome.pages.has(startTab)).toBe(true);
    expect([...chrome.pages.keys()].sort()).toEqual([startTab, id("E"), id("F")]);
    expect(chrome.mcpFirstPage()).toBe(startTab);
  });

  test("Start, the start tab's attach not come yet: its target is read (Target.getTargets) before the spare is made, and the spare's id is weighed against it", async () => {
    const { chrome, relay } = await start({ ids: [id("2"), id("D")], attachAtAutoAttach: false });
    const order = chrome.sent.map((s) => s.method).filter((m) => m === "Target.getTargets" || m === "Target.createTarget");
    expect(order.slice(0, 2)).toEqual(["Target.getTargets", "Target.createTarget"]);
    // Unknown, the start tab would leave 2... as the spare, the MCP's first page; known, 2... stands in for it.
    expect(chrome.created()).toEqual(["window", "window"]);
    expect(relay.tabList()).toHaveLength(1);
    expect(targetOfView(relay, relay.tabList()[0]!)).toBe(chrome.mcpFirstPage()!);
  });

  /** A reopen's checks: each blank tab ready (its resume sent) before the next is made, and no navigation before the last one is. */
  function inTurn(chrome: Chrome, blanks: string[]) {
    const resumeOf = (target: string) => chrome.sent.findIndex((s) => s.method === "Runtime.runIfWaitingForDebugger" && s.sessionId === `S-${target}`);
    const creates = chrome.sent.map((s, i) => (s.method === "Target.createTarget" ? i : -1)).filter((i) => i >= 0);
    for (let i = 0; i + 1 < blanks.length; i++) expect([blanks[i], resumeOf(blanks[i]!) < creates[i + 1]!]).toEqual([blanks[i], true]);
    const firstNav = chrome.sent.findIndex((s) => s.method === "Page.navigate");
    expect(resumeOf(blanks.at(-1)!)).toBeLessThan(firstNav);
  }

  test("a reopen (Stop and Start, a reboot's reconcile): a blank tab for each saved tab, each ready in turn; then the tab that a pane socket viewed last (tabs.json `shown`) takes the one whose target id is lowest, so a connecting MCP's first page is the tab that the pane shows; the strip keeps the saved order after the blank start tab; the spare only after them", async () => {
    // The start tab 4...; the blank tabs 6..., 2... and 9...; the spare E...
    const { chrome, relay, startTab } = await start({ startTab: id("4"), ids: [id("6"), id("2"), id("9"), id("E")], saved: savedThree("bcdefghijk") });
    expect(targetCalls(chrome)).toEqual(["create", "create", "create", "navigate https://example.com/a on 6", "navigate https://example.com/b on 2", "navigate https://example.com/c on 9", "create"]);
    inTurn(chrome, [id("6"), id("2"), id("9")]);
    const list = relay.tabList();
    expect(list.map((t) => t.id).slice(1)).toEqual(["abcdefghij", "bcdefghijk", "cdefghijkm"]);
    expect(targetOfView(relay, list[0]!)).toBe(startTab);
    expect(list.map((t) => t.by)).toEqual(["user", "user", "user", "user"]);
    // The tab that the pane shows (the one it viewed last) is Playwright's first page; never the spare, never the blank start tab.
    expect(chrome.mcpFirstPage()).toBe(id("2"));
    expect(targetOfView(relay, list.find((t) => t.id === "bcdefghijk")!)).toBe(id("2"));
    expect([...chrome.pages.keys()].sort()).toEqual([id("2"), startTab, id("6"), id("9"), id("E")]);
  });

  test("a reopen with no `shown` in tabs.json: the newest saved tab (the pane's own default, the strip's last) takes the lowest target id", async () => {
    const { chrome, relay } = await start({ startTab: id("4"), ids: [id("6"), id("2"), id("9"), id("E")], saved: savedThree() });
    expect(targetCalls(chrome)).toEqual(["create", "create", "create", "navigate https://example.com/a on 6", "navigate https://example.com/b on 9", "navigate https://example.com/c on 2", "create"]);
    const list = relay.tabList();
    expect(targetOfView(relay, list.at(-1)!)).toBe(chrome.mcpFirstPage()!);
    expect(list.at(-1)!.id).toBe("cdefghijkm");
  });

  test("a reopen whose `shown` is no saved tab (a blank tab's id, say): the newest saved tab", async () => {
    const { chrome, relay } = await start({ startTab: id("4"), ids: [id("6"), id("2"), id("9"), id("E")], saved: savedThree("zzzzzzzzzz") });
    expect(targetOfView(relay, relay.tabList().at(-1)!)).toBe(chrome.mcpFirstPage()!);
  });

  test("a reopen where the blank start tab's id sorts first: a new blank tab whose id sorts after the lowest reopened one stands in for it (the start tab closes, and is gone, before the tabs navigate)", async () => {
    // The start tab 1...; the blank tabs 6... and 9...; 8... sorts after 6...: it stands in for the start tab; the spare E...
    const saved = savedThree();
    saved.tabs.pop();
    const { chrome, relay, startTab } = await start({ startTab: id("1"), ids: [id("6"), id("9"), id("8"), id("E")], saved });
    expect(targetCalls(chrome)).toEqual(["create", "create", "create", "close 1", "navigate https://example.com/a on 9", "navigate https://example.com/b on 6", "create"]);
    expect(chrome.pages.has(startTab)).toBe(false);
    const list = relay.tabList();
    expect(list.map((t) => [targetOfView(relay, t)?.slice(0, 1), t.id === "abcdefghij" || t.id === "bcdefghijk" ? t.id : "blank"])).toEqual([
      ["8", "blank"],
      ["9", "abcdefghij"],
      ["6", "bcdefghijk"],
    ]);
    expect(chrome.mcpFirstPage()).toBe(id("6"));
  });

  test("a reopen whose start tab takes longer to close than kitespan waits (a loaded machine): the spare is weighed against the tabs that stay, never against the closing start tab, so it never sorts first once that tab is gone", async () => {
    // The start tab 1... (its close lands 400 ms late); the blank tabs 6... and 9...; 8... stands in for the start tab;
    // the spare candidates 3... (before 6...: it would sort first once 1... is gone) and E...
    const chrome = new Chrome();
    chrome.addPage(id("1"));
    chrome.slowClose.set(id("1"), 400);
    chrome.ids = [id("6"), id("9"), id("8"), id("3"), id("E")];
    const saved = savedThree();
    saved.tabs.pop();
    const relay = makeRelay(chrome, saved);
    await relay.attach(chrome.client, { fresh: true, start: "1@x", port: 9345 });
    // At the attach's end (the start tab may still be closing): the spare sorts after the shown tab.
    const spare = [...chrome.pages.keys()].find((t) => !relay.tabList().some((v) => targetOfView(relay, v) === t) && t !== id("1"))!;
    expect(spare).toBe(id("E"));
    await Bun.sleep(500);
    await quiet(chrome);
    expect([...chrome.pages.keys()].sort()).toEqual([id("6"), id("8"), id("9"), id("E")]);
    expect(chrome.mcpFirstPage()).toBe(id("6"));
    expect(targetOfView(relay, relay.tabList().at(-1)!)).toBe(id("6"));
  });

  test("a reopen where a new blank tab sorts between the start tab and the reopened ones: it joins them (the one too many closes), and the next one stands in for the start tab", async () => {
    // The start tab 1...; the blank tab 6...; 3... sorts after 1... and before 6...: it joins; 5... sorts after 3...: it
    // stands in for the start tab; 6... is one too many; the spare E...
    const saved = savedThree();
    saved.tabs = saved.tabs.slice(0, 1);
    const { chrome, relay } = await start({ startTab: id("1"), ids: [id("6"), id("3"), id("5"), id("E")], saved });
    expect(targetCalls(chrome)).toEqual(["create", "create", "create", "close 1", "close 6", "navigate https://example.com/a on 3", "create"]);
    expect([...chrome.pages.keys()].sort()).toEqual([id("3"), id("5"), id("E")]);
    expect(relay.tabList().map((t) => targetOfView(relay, t)?.slice(0, 1))).toEqual(["5", "3"]);
    expect(chrome.mcpFirstPage()).toBe(id("3"));
  });

  test("a reopen after a Stop: a socket's view of a saved tab, kept across the stop, starts again on the target that the tab gets", async () => {
    const chrome = new Chrome();
    chrome.addPage(id("8"));
    chrome.ids = [id("C"), id("9"), id("D")];
    const box: { file: TabsFile | null } = { file: null };
    const relay = makeRelay(chrome, null, box);
    await relay.attach(chrome.client, { fresh: true, start: "1@x", port: 9345 });
    await quiet(chrome);
    const conn = new Conn();
    relay.addConn(conn);
    const rid = RID();
    await relay.handle(conn, { t: "tab_new", rid, url: "https://example.com/kept" });
    await quiet(chrome);
    const tab = conn.of("ack").find((a) => a.rid === rid)!.tab!;
    chrome.navigateByOther(id("9"), "https://example.com/kept", "Kept");
    await relay.handle(conn, { t: "view", tab, w: 640, h: 400, dpr: 1, q: 40, credit: 2 });
    await quiet(chrome);
    expect(chrome.of("Page.startScreencast")).toHaveLength(1);
    // Stop: the file as it is, then the connection goes; the socket's view stays.
    await relay.freeze();
    relay.detach();
    expect(box.file).toMatchObject({ tabs: [{ id: tab, url: "https://example.com/kept" }], shown: tab });
    // Start: a new Chrome, its start tab 5..., the blank tab 2..., the spare E...
    const next = new Chrome();
    next.addPage(id("5"));
    next.ids = [id("2"), id("E")];
    await relay.attach(next.client, { fresh: true, start: "2@y", port: 9345 });
    await quiet(next);
    expect(targetOfView(relay, relay.tabList().find((t) => t.id === tab)!)).toBe(id("2"));
    expect(next.of("Target.attachToTarget").map((s) => s.params.targetId)).toEqual([id("2")]);
    expect(next.of("Page.startScreencast")).toHaveLength(1);
    expect(next.mcpFirstPage()).toBe(id("2"));
  });

  test("tabs.json's `shown`: the saved tab that a pane socket viewed last; a view of a blank tab leaves it; an adoption keeps the file's", async () => {
    const { chrome, relay, startTab, box } = await start({ ids: [id("C"), id("9"), id("D"), id("A"), id("E")] });
    const conn = new Conn();
    relay.addConn(conn);
    const opened: string[] = [];
    for (const url of ["https://example.com/one", "https://example.com/two"]) {
      const rid = RID();
      await relay.handle(conn, { t: "tab_new", rid, url });
      await quiet(chrome);
      const tab = conn.of("ack").find((a) => a.rid === rid)!.tab!;
      opened.push(tab);
      const target = targetOfView(relay, relay.tabList().find((t) => t.id === tab)!)!;
      chrome.navigateByOther(target, url, url.slice(-3));
      await quiet(chrome);
    }
    expect(box.file?.tabs.map((t) => t.id)).toEqual(opened);
    expect(box.file?.shown ?? null).toBeNull();
    const view = (tab: string) => relay.handle(conn, { t: "view", tab, w: 640, h: 400, dpr: 1, q: 40, credit: 2 });
    await view(opened[1]!);
    await view(opened[0]!);
    await quiet(chrome);
    expect(box.file?.shown).toBe(opened[0]);
    // The blank start tab is never saved: its view leaves `shown` as it was.
    await view(relay.tabList().find((t) => targetOfView(relay, t) === startTab)!.id);
    await quiet(chrome);
    expect(box.file?.shown).toBe(opened[0]);
    // A kitespan restart: the successor adopts the browser and keeps the file's `shown` while no socket views a tab.
    await relay.freeze();
    const frozen = box.file!;
    relay.detach();
    const box2: { file: TabsFile | null } = { file: null };
    const successor = makeRelay(chrome, frozen, box2);
    await successor.attach(chrome.client, { fresh: false, start: "1@x", port: 9345 });
    await quiet(chrome);
    expect(box2.file?.shown).toBe(opened[0]);
  });

  test("while Start makes its tabs, no tab list goes to a pane socket (its opened frame lists none); its first list holds the blank start tab and every reopened tab under its saved id, so a page never takes a half-made list's tab as the one it shows", async () => {
    const chrome = new Chrome();
    chrome.addPage(id("4"));
    chrome.ids = [id("6"), id("2"), id("9"), id("E")];
    const relay = makeRelay(chrome, savedThree("bcdefghijk"));
    const conn = new Conn();
    relay.addConn(conn);
    const during: number[] = [];
    chrome.beforeReply = (m) => {
      if (m.method !== "Target.createTarget") return;
      const f = relay.opened();
      during.push(f.t === "opened" ? f.tabs.length : -1);
    };
    await relay.attach(chrome.client, { fresh: true, start: "1@x", port: 9345 });
    expect(during).toEqual([0, 0, 0, 0]);
    const lists = conn.of("tabs").filter((f) => f.list.length > 0);
    expect(lists.length).toBeGreaterThan(0);
    expect(lists[0]!.list.map((t) => t.id).slice(1)).toEqual(["abcdefghij", "bcdefghijk", "cdefghijkm"]);
    expect(lists[0]!.list).toHaveLength(4);
  });

  test("an adoption (kitespan's restart) whose saved spare sorts first: a new spare, the old one closed", async () => {
    const chrome = new Chrome();
    chrome.addPage(id("8"));
    chrome.addPage(id("2"));
    chrome.ids = [id("B")];
    const relay = makeRelay(chrome, { v: 1, browserStart: "1@x", spare: id("2"), tabs: [] });
    await relay.attach(chrome.client, { fresh: false, start: "1@x", port: 9345 });
    await quiet(chrome);
    expect(chrome.created()).toEqual(["window"]);
    expect(chrome.of("Target.closeTarget").map((s) => s.params.targetId)).toEqual([id("2")]);
    expect(chrome.mcpFirstPage()).toBe(id("8"));
    expect(relay.tabList()).toHaveLength(1);
  });

  test("an adoption whose saved spare another client navigated while no kitespan server was attached (a restart's gap): it is listed at once, by other, and a new spare is made; it is never closed, also when its id sorts first", async () => {
    const chrome = new Chrome();
    chrome.addPage(id("8"));
    // The saved spare, Claude's page now; its id sorts before the start tab's.
    chrome.addPage(id("1"), "https://claude.example/");
    chrome.ids = [id("B")];
    const relay = makeRelay(chrome, { v: 1, browserStart: "1@x", spare: id("1"), tabs: [] });
    const conn = new Conn();
    relay.addConn(conn);
    await relay.attach(chrome.client, { fresh: false, start: "1@x", port: 9345 });
    await quiet(chrome);
    expect(relay.tabList().map((t) => [targetOfView(relay, t)?.slice(0, 1), t.url, t.by])).toEqual([
      ["8", "about:blank", "other"],
      ["1", "https://claude.example/", "other"],
    ]);
    expect(conn.list().map((t) => t.url)).toContain("https://claude.example/");
    expect(chrome.of("Target.closeTarget")).toEqual([]);
    expect(chrome.created()).toEqual(["window"]);
    expect([...chrome.pages.keys()].sort()).toEqual([id("1"), id("8"), id("B")]);
  });

  test("a spare that another client navigates while the relay is frozen (a restart's gap): it joins the list, but no tab is made while frozen; the successor's adoption lists it from the frozen file and makes the spare", async () => {
    const chrome = new Chrome();
    chrome.addPage(id("8"));
    chrome.ids = [id("C"), id("D"), id("E")];
    const box: { file: TabsFile | null } = { file: null };
    const relay = makeRelay(chrome, null, box);
    await relay.attach(chrome.client, { fresh: true, start: "1@x", port: 9345 });
    await quiet(chrome);
    await relay.freeze();
    const made = chrome.created().length;
    chrome.navigateByOther(id("C"), "https://claude.example/");
    await quiet(chrome);
    expect(chrome.created().length).toBe(made);
    expect(relay.tabList().map((t) => t.url)).toContain("https://claude.example/");
    // The frozen file still names it as the spare (nothing is written while frozen): the successor sees it used.
    expect(box.file?.spare).toBe(id("C"));
    relay.detach();
    const successor = makeRelay(chrome, box.file);
    await successor.attach(chrome.client, { fresh: false, start: "1@x", port: 9345 });
    await quiet(chrome);
    expect(successor.tabList().map((t) => t.url)).toContain("https://claude.example/");
    expect(chrome.created().length).toBe(made + 1);
    expect(chrome.pages.has(id("C"))).toBe(true);
    expect(chrome.of("Target.closeTarget").map((s) => s.params.targetId)).not.toContain(id("C"));
  });

  test("a restart that did not happen (thaw) after a spare was used while frozen: the spare is made then", async () => {
    const chrome = new Chrome();
    chrome.addPage(id("8"));
    chrome.ids = [id("C"), id("D")];
    const relay = makeRelay(chrome, null);
    await relay.attach(chrome.client, { fresh: true, start: "1@x", port: 9345 });
    await quiet(chrome);
    await relay.freeze();
    chrome.navigateByOther(id("C"), "https://claude.example/");
    await quiet(chrome);
    expect(chrome.created()).toEqual(["window"]);
    relay.thaw();
    await quiet(chrome);
    expect(chrome.created()).toEqual(["window", "window"]);
    expect([...chrome.pages.keys()].sort()).toEqual([id("8"), id("C"), id("D")]);
    expect(relay.tabList()).toHaveLength(2);
  });

  test("a listed tab that closes, after which the spare's id would sort first: a new spare, the old one closed", async () => {
    const { chrome, relay, startTab } = await start({ ids: [id("9"), id("B")] });
    // Another client's tab in a window of its own (id A..., after the spare's 9...).
    chrome.addPage(id("A"), "about:blank");
    chrome.announce(id("A"));
    await quiet(chrome);
    expect(chrome.created()).toEqual(["window"]);
    const startView = relay.tabList().find((t) => targetOfView(relay, t) === startTab)!;
    const conn = new Conn();
    relay.addConn(conn);
    await relay.handle(conn, { t: "tab_close", rid: RID(), tab: startView.id });
    await quiet(chrome);
    // The spare 9... now sorted before A..., the only listed tab: B... is made and 9... goes.
    expect(chrome.created()).toEqual(["window", "window"]);
    expect([...chrome.pages.keys()].sort()).toEqual([id("A"), id("B")]);
    expect(chrome.mcpFirstPage()).toBe(id("A"));
  });

  test("Claude's plain new tab still lands in the spare's window: a new spare, the old one closed, the new tab listed and the shown tab kept in view", async () => {
    const { chrome, relay, startTab } = await start({ ids: [id("C"), id("D")] });
    const shown = relay.tabList()[0]!.id;
    const conn = await viewer(relay, shown);
    // browser_tabs new: a plain Target.createTarget, in the newest window (the spare's).
    const spareWindow = chrome.pages.get(id("C"))!.window;
    chrome.addPage(id("E"), "about:blank", spareWindow);
    chrome.announce(id("E"));
    await quiet(chrome);
    expect(chrome.created()).toEqual(["window", "window"]);
    expect(chrome.of("Target.closeTarget").map((s) => s.params.targetId)).toEqual([id("C")]);
    expect(conn.list().map((t) => t.hidden)).toEqual([false, false]);
    expect(conn.of("follow")).toEqual([]);
    expect(targetOfView(relay, conn.list()[0]!)).toBe(startTab);
  });
});

describe("the safety net: a spare that another client uses joins the list, and the blank start tab's viewer follows it (D-6, D-12, Q3)", () => {
  /** Start, a spare C..., one viewer on the blank start tab and one on a tab that the pane opened at an address. */
  async function twoViewers() {
    const env = await start({ ids: [id("C"), id("9"), id("D"), id("E")] });
    const startId = env.relay.tabList()[0]!.id;
    const onStart = await viewer(env.relay, startId);
    const other = new Conn();
    env.relay.addConn(other);
    const rid = RID();
    await env.relay.handle(other, { t: "tab_new", rid, url: "https://example.com/mine" });
    const mine = other.of("ack").find((a) => a.rid === rid)!.tab!;
    env.chrome.pages.get(id("9"))!.url = "https://example.com/mine";
    env.chrome.event("Target.targetInfoChanged", { targetInfo: { targetId: id("9"), type: "page", url: "https://example.com/mine", title: "Mine" } });
    await env.relay.handle(other, { t: "view", tab: mine, w: 640, h: 400, dpr: 1, q: 40, credit: 2 });
    await quiet(env.chrome);
    // New tab made the spare D... and closed C...
    const spare = id("D");
    expect([...env.chrome.pages.keys()].sort()).toEqual([env.startTab, id("9"), spare]);
    return { ...env, startId, onStart, other, mine, spare };
  }

  test("Claude's MCP navigates the spare: at the navigation's start it joins the list, a new spare is made (the used one is not closed), the start tab's viewer follows it with Back to the start tab; the other viewer sees it in the strip with Claude's mark", async () => {
    const env = await twoViewers();
    const before = env.chrome.created().length;
    const url = "http://127.0.0.1:7001/claude";
    const p = env.chrome.pages.get(env.spare)!;
    // The navigation's start alone: the list has it at once.
    env.chrome.event("Page.frameStartedNavigating", { frameId: `F-${p.session}`, url, loaderId: "L", navigationType: "differentDocument" }, p.session);
    await tick(1);
    const used = env.onStart.list().find((t) => t.id !== env.startId && t.id !== env.mine);
    expect(used).toBeDefined();
    expect(used).toMatchObject({ by: "other", opener: env.startId, hidden: false });
    expect(env.onStart.of("follow")).toEqual([{ t: "follow", tab: used!.id, from: env.startId }]);
    expect(env.other.of("follow")).toEqual([]);
    expect(env.other.list().map((t) => t.id)).toContain(used!.id);
    // Then its commit, as Chrome tells it; a new spare, and the used one stays open.
    p.url = url;
    p.history.push({ url });
    env.chrome.event("Page.frameNavigated", { frame: { id: `F-${p.session}`, url, loaderId: "L" }, type: "Navigation" }, p.session);
    env.chrome.event("Target.targetInfoChanged", { targetInfo: { targetId: env.spare, type: "page", url, title: "Claude's page" } });
    await quiet(env.chrome);
    expect(env.chrome.created().length).toBe(before + 1);
    expect(env.chrome.of("Target.closeTarget").map((s) => s.params.targetId)).not.toContain(env.spare);
    expect(env.chrome.pages.has(env.spare)).toBe(true);
    expect(env.chrome.pages.has(id("E"))).toBe(true);
    // The bar's Back is Back to the start tab (the blank page it started as is not a Back of its own).
    const view = env.onStart.list().find((t) => t.id === used!.id)!;
    expect(view).toMatchObject({ url, canBack: false, opener: env.startId });
    const back = RID();
    await env.relay.handle(env.onStart, { t: "back", rid: back, tab: used!.id });
    expect(env.onStart.of("ack").find((a) => a.rid === back)).toMatchObject({ ok: false, code: "stale" });
    expect(env.chrome.of("Page.navigateToHistoryEntry")).toEqual([]);
    const opener = RID();
    await env.relay.handle(env.onStart, { t: "opener", rid: opener, tab: used!.id });
    expect(env.onStart.of("ack").find((a) => a.rid === opener)).toMatchObject({ ok: true });
    expect(env.chrome.of("Target.activateTarget").at(-1)!.params).toEqual({ targetId: env.startTab });
    // Claude's result names it: the strip marks it as the chat's, on every viewer.
    await call(env.relay, CHAT, "browser_navigate", `### Ran Playwright code\n### Page\n- Page URL: ${url}\n- Page Title: Claude's page\n`, { url });
    await quiet(env.chrome);
    expect(env.other.list().find((t) => t.id === used!.id)!.claudeLast).toBe(CHAT);
    expect(env.onStart.list().find((t) => t.id === used!.id)!.claudeLast).toBe(CHAT);
    // The next MCP's first page is a listed tab, never the new spare.
    expect(env.relay.tabList().map((t) => targetOfView(env.relay, t))).toContain(env.chrome.mcpFirstPage()!);
  });

  test("a URL change that only Target.targetInfoChanged tells (no event on kitespan's session) does the same", async () => {
    const env = await twoViewers();
    env.chrome.pages.get(env.spare)!.url = "https://elsewhere.example/";
    env.chrome.event("Target.targetInfoChanged", { targetInfo: { targetId: env.spare, type: "page", url: "https://elsewhere.example/", title: "" } });
    await tick(1);
    const used = env.onStart.list().find((t) => t.url === "https://elsewhere.example/");
    expect(used).toBeDefined();
    expect(env.onStart.of("follow")).toEqual([{ t: "follow", tab: used!.id, from: env.startId }]);
    await quiet(env.chrome);
    expect(env.chrome.pages.has(id("E"))).toBe(true);
  });

  test("a kitespan chat's browser result that names the spare alone (the start tab elsewhere): it joins the list with Claude's mark, a new spare; the viewer of a start tab that the user navigated does not follow", async () => {
    const { chrome, relay, startTab } = await start({ ids: [id("C"), id("D")] });
    const startId = relay.tabList()[0]!.id;
    const conn = await viewer(relay, startId);
    await relay.handle(conn, { t: "navigate", rid: RID(), tab: startId, url: "https://example.com/" });
    chrome.pages.get(startTab)!.url = "https://example.com/";
    chrome.event("Target.targetInfoChanged", { targetInfo: { targetId: startTab, type: "page", url: "https://example.com/", title: "Example" } });
    await quiet(chrome);
    // Claude's MCP holds the spare and looks before it navigates: its result names about:blank, which only the spare is.
    await call(relay, CHAT, "browser_snapshot", "### Page\n- Page URL: about:blank\n- Page Title: \n### Snapshot\n```yaml\n```\n");
    const used = conn.list().find((t) => t.id !== startId);
    expect(used).toMatchObject({ url: "about:blank", by: "other", claudeLast: CHAT, opener: null });
    expect(conn.of("follow")).toEqual([]);
    await quiet(chrome);
    expect(chrome.created()).toEqual(["window", "window"]);
    expect(chrome.of("Target.closeTarget")).toEqual([]);
    expect(relay.acting.lastOf(used!.id)).toBe(CHAT);
  });

  test("the start tab and the spare both blank: a result that names about:blank names neither, and nothing joins", async () => {
    const { chrome, relay } = await start({ ids: [id("C")] });
    const startId = relay.tabList()[0]!.id;
    const conn = await viewer(relay, startId);
    await call(relay, OTHER, "browser_snapshot", "### Page\n- Page URL: about:blank\n- Page Title: \n");
    await quiet(chrome);
    expect(relay.tabList().map((t) => [t.id, t.claudeLast])).toEqual([[startId, null]]);
    expect(relay.acting.lastOf(startId)).toBeNull();
    expect(conn.of("follow")).toEqual([]);
    expect(chrome.created()).toEqual(["window"]);
  });

  test("kitespan's own navigations never count: the pane's address in the start tab and New tab's address leave the spare a spare", async () => {
    const { chrome, relay, startTab } = await start({ ids: [id("C"), id("9"), id("D")] });
    const startId = relay.tabList()[0]!.id;
    const conn = await viewer(relay, startId);
    await relay.handle(conn, { t: "navigate", rid: RID(), tab: startId, url: "https://example.com/" });
    chrome.navigateByOther(startTab, "https://example.com/", "Example");
    await relay.handle(conn, { t: "tab_new", rid: RID(), url: "https://example.com/two" });
    await quiet(chrome);
    expect(conn.list()).toHaveLength(2);
    expect(conn.of("follow")).toEqual([]);
    // The New tab's spare D... is the only page that no list shows.
    expect([...chrome.pages.keys()].filter((t) => !relay.tabList().some((v) => targetOfView(relay, v) === t))).toEqual([id("D")]);
  });

  test("a viewer of a start tab that the user navigated, and then a spare that Claude navigates: no follow, the strip lists it", async () => {
    const { chrome, relay, startTab } = await start({ ids: [id("C"), id("D")] });
    const startId = relay.tabList()[0]!.id;
    const conn = await viewer(relay, startId);
    await relay.handle(conn, { t: "navigate", rid: RID(), tab: startId, url: "https://example.com/" });
    chrome.navigateByOther(startTab, "https://example.com/", "Example");
    await quiet(chrome);
    chrome.navigateByOther(id("C"), "https://claude.example/");
    await quiet(chrome);
    expect(conn.list().map((t) => t.url)).toEqual(["https://example.com/", "https://claude.example/"]);
    expect(conn.list()[1]).toMatchObject({ opener: null, by: "other" });
    expect(conn.of("follow")).toEqual([]);
    expect(chrome.pages.has(id("D"))).toBe(true);
  });

  test("only the start tab that no pane navigated is followed from: the viewer of another client's blank tab (Claude's plain new tab) does not follow a spare that Claude uses", async () => {
    const { chrome, relay, startTab } = await start({ ids: [id("C"), id("D"), id("E")] });
    const startId = relay.tabList()[0]!.id;
    const c0 = await viewer(relay, startId);
    await relay.handle(c0, { t: "navigate", rid: RID(), tab: startId, url: "https://example.com/" });
    chrome.navigateByOther(startTab, "https://example.com/", "Example");
    await relay.handle(c0, { t: "unview", tab: startId });
    // Claude's plain new tab lands in the spare's window: a new spare D..., the old one closes.
    chrome.addPage(id("9"), "about:blank", chrome.pages.get(id("C"))!.window);
    chrome.announce(id("9"));
    await quiet(chrome);
    const blank = relay.tabList().find((t) => targetOfView(relay, t) === id("9"))!;
    expect(blank).toMatchObject({ by: "other", url: "about:blank" });
    const conn = await viewer(relay, blank.id);
    await quiet(chrome);
    chrome.navigateByOther(id("D"), "https://claude.example/");
    await quiet(chrome);
    expect(conn.of("follow")).toEqual([]);
    expect(c0.of("follow")).toEqual([]);
    expect(conn.list().map((t) => t.url)).toContain("https://claude.example/");
  });

  test("Start with a socket that views the start tab while the first spare is made, and a new tab that stands in for it: one follow to the stand-in, after a tab list that holds it, no error; the stand-in is the start tab, so a spare that Claude uses later is followed from it", async () => {
    const chrome = new Chrome();
    chrome.addPage(id("8"));
    // 3... sorts before 8...: it stands in for the start tab; A... is the spare, B... the next one.
    chrome.ids = [id("3"), id("A"), id("B")];
    const relay = makeRelay(chrome, null);
    const conn = new Conn();
    relay.addConn(conn);
    let startId = "";
    chrome.beforeReply = (m) => {
      if (m.method !== "Target.createTarget" || startId) return;
      startId = relay.tabList()[0]!.id;
      void relay.handle(conn, { t: "view", tab: startId, w: 640, h: 400, dpr: 1, q: 40, credit: 2 });
    };
    await relay.attach(chrome.client, { fresh: true, start: "1@x", port: 9345 });
    await quiet(chrome);
    chrome.beforeReply = null;
    const standIn = relay.tabList()[0]!;
    expect(relay.tabList()).toHaveLength(1);
    expect(targetOfView(relay, standIn)).toBe(id("3"));
    const follows = conn.of("follow");
    expect(follows).toEqual([{ t: "follow", tab: standIn.id, from: startId }]);
    const listed = conn.frames.findIndex((f) => f.t === "tabs" && f.list.some((t) => t.id === standIn.id));
    expect(listed).toBeGreaterThanOrEqual(0);
    expect(listed).toBeLessThan(conn.frames.indexOf(follows[0]!));
    expect(conn.of("error")).toEqual([]);
    // The page follows (its view of the stand-in); then Claude's MCP navigates the spare: the viewer follows it from the stand-in.
    await relay.handle(conn, { t: "view", tab: standIn.id, w: 640, h: 400, dpr: 1, q: 40, credit: 2 });
    chrome.navigateByOther(id("A"), "https://claude.example/");
    await quiet(chrome);
    const used = relay.tabList().find((t) => t.url === "https://claude.example/")!;
    expect(conn.of("follow").at(-1)).toEqual({ t: "follow", tab: used.id, from: standIn.id });
  });
});
