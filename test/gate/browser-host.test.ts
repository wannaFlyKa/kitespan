// The shared browser's host and relay on a real headless Chrome (DESIGN-B1 2.2 to 2.12, 7.2; SERVER-B1 15): Chrome for
// Testing on a test port from 9341 to 9349 with its own profile in a scratch state folder, loopback only, and the
// local test site on 127.0.0.1. Start, the six checks, the bind, New tab and a cast at 1280 x 800, the adoption by a
// second host (kitespan's restart), the stop order, the reopen under the same ids with no doubled tabs after three
// starts, a Chrome crash, the port and binary states, a dialog, a chooser through an upload, a picker on the tapped
// control, a tab that a page opens, two viewers, a download, the stale-frame refusal and the Fetch block. The real
// claude never runs, and no page leaves 127.0.0.1.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BROWSER_TAB_ID } from "../../shared/ids";
import { PROTOCOL_VERSION } from "../../shared/protocol";
import type { BrowserClientFrame, BrowserTabView } from "../../shared/browser";
import { Downloads } from "../../server/browser/downloads";
import { BrowserHost, HOST_FILE, type HostOptions } from "../../server/browser/host";
import { cmdlineCheck, listenRows, startOf, systemProc } from "../../server/browser/procfs";
import { Relay } from "../../server/browser/relay";
import { TabsFileStore, TABS_FILE } from "../../server/browser/tabs";
import { Cdp } from "../../scripts/lib/cdp";
import { startBrowserSite, type BrowserSite } from "../click/browser-site";
import { LINUX_ONLY, PROCFS } from "../linux";
import { FakeConn, browserFolders, cdpPort, readJsonFile, recordPid, scratch, spawned, stopSpawned, testChrome } from "./browser-lib";

const CHROME = testChrome();
const T = 60_000;
const OWN_PORT = 7945;

interface Kit {
  host: BrowserHost;
  relay: Relay;
  tabsFile: TabsFileStore;
  downloads: Downloads;
}

describe.skipIf(!PROCFS || !CHROME)(`the shared browser on a real headless Chrome ${LINUX_ONLY}`, () => {
  let root = "";
  let port = 0;
  let folders: { state: string; config: string };
  let site: BrowserSite;
  const settings = { enabled: false };
  let uploadFile = "";
  const kits: Kit[] = [];

  const rid = () => crypto.randomUUID();
  const profile = () => join(folders.state, "browser", "profile");

  function kit(over: Partial<HostOptions> = {}): Kit {
    const dir = join(folders.state, "browser");
    const refused = () => ({ origins: [`http://127.0.0.1:${OWN_PORT}`, `http://localhost:${OWN_PORT}`, `http://[::1]:${OWN_PORT}`], loopbackPorts: [OWN_PORT] });
    const tabsFile = new TabsFileStore(dir, process.getuid!(), refused);
    let relay: Relay | null = null;
    const downloads = new Downloads({ dir, uid: process.getuid!(), keepDays: async () => 7, onChange: (v) => relay?.broadcast({ t: "download", ...v }) });
    const host: BrowserHost = new BrowserHost({
      state: folders.state,
      configDir: folders.config,
      uid: process.getuid!(),
      env: { HOME: process.env.HOME, PATH: "/usr/bin:/bin", LANG: "C.UTF-8", TMPDIR: process.env.TMPDIR },
      home: homedir(),
      refusedPorts: () => [OWN_PORT],
      settings: { enabled: async () => settings.enabled, setEnabled: async (on) => void (settings.enabled = on) },
      savedTabs: () => tabsFile.count(),
      attach: (cdp, info) => relay!.attach(cdp, info),
      detached: () => relay?.detach(),
      clearTabs: () => tabsFile.clear(),
      beforeStop: () => relay?.freeze() ?? Promise.resolve(),
      spawn: (argv, o) => {
        const p = Bun.spawn(argv, { detached: true, stdin: "ignore", stdout: o.out, stderr: o.out, env: o.env });
        p.unref();
        recordPid(p.pid, profile(), join(root, "pids.txt"));
        return { pid: p.pid };
      },
      ...over,
    });
    relay = new Relay({ refused, tabsFile, downloads, uploadPaths: async (ids) => (ids.length === 1 && ids[0] === "k3m7q2x4abk3m7q2" ? [uploadFile] : null), host: () => host.state });
    const k = { host, relay, tabsFile, downloads };
    kits.push(k);
    return k;
  }

  /** The stand-in sockets of the test that runs; each test's go before the next (at most 8 casts in all). */
  const open: { k: Kit; c: FakeConn }[] = [];
  const connect = (k: Kit) => {
    const c = new FakeConn();
    k.relay.addConn(c);
    open.push({ k, c });
    return c;
  };
  beforeEach(() => {
    for (const { k, c } of open.splice(0)) k.relay.removeConn(c);
  });
  const ack = (c: FakeConn, r: string) => c.wait(`the ack of ${r}`, () => c.of("ack").find((a) => a.rid === r));
  const send = (k: Kit, c: FakeConn, f: BrowserClientFrame) => k.relay.handle(c, f);
  const pageTargets = async (): Promise<string[]> => {
    const r = await fetch(`http://127.0.0.1:${port}/json/list`);
    return ((await r.json()) as { type: string; url: string }[]).filter((t) => t.type === "page").map((t) => t.url);
  };
  /** The ids that tabs.json holds now. */
  const savedTabIds = (): string[] => (readJsonFile(join(folders.state, "browser", TABS_FILE))?.tabs ?? []).map((t: { id: string }) => t.id).sort();
  /** Draw every frame at once: the page's `drawn`. */
  const drawAll = (k: Kit, c: FakeConn) => {
    c.onCast = (h) => void k.relay.handle(c, { t: "drawn", tab: h.tab, n: h.n });
  };

  beforeAll(() => {
    root = scratch("kbh");
    port = cdpPort();
    folders = browserFolders(root, CHROME!, port);
    site = startBrowserSite();
    uploadFile = join(root, "up", "u-a1b2c3", "note.txt");
    mkdirSync(join(root, "up", "u-a1b2c3"), { recursive: true, mode: 0o700 });
    writeFileSync(uploadFile, "an uploaded note\n", { mode: 0o600 });
  });

  afterAll(async () => {
    for (const k of kits) await k.host.quit().catch(() => {});
    site?.stop();
    expect(await stopSpawned()).toEqual([]);
    // Every Chrome of this test is gone: its scratch folder (the profiles) goes too.
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test(
    "Start: Chrome on 127.0.0.1 only, its own profile 0700, no --remote-allow-origins, all six checks, host.json",
    async () => {
      const k = kit();
      await k.host.start();
      expect(settings.enabled).toBe(true);
      expect(k.host.state).toMatchObject({ state: "running", how: "started", port });
      expect(k.host.state.version).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      const rec = readJsonFile(join(folders.state, "browser", HOST_FILE));
      expect(rec).toMatchObject({ v: 1, port, binary: CHROME });
      expect(startOf(systemProc, rec.pid)).toBe(rec.start);
      expect(k.host.ownProcess(rec) && k.host.ownListener(rec)).toBe(true);
      const cl = cmdlineCheck(systemProc.read(`/proc/${rec.pid}/cmdline`), [`--user-data-dir=${profile()}`, `--remote-debugging-port=${port}`, "--headless=new", "--remote-debugging-address=127.0.0.1"], ["--remote-allow-origins", "--no-sandbox", "--disable-web-security", "--enable-automation", "--remote-debugging-pipe"]);
      expect(cl.ok).toBe(true);
      // The bind: one LISTEN row, on 127.0.0.1 (0100007F) in /proc/net/tcp, of this user.
      const tcp = systemProc.read("/proc/net/tcp")!.toString().split("\n").filter((l) => l.includes(`:${port.toString(16).toUpperCase().padStart(4, "0")} `) && l.split(/\s+/)[4] === "0A");
      expect(tcp.length).toBe(1);
      expect(tcp[0]!.trim().split(/\s+/)[1]).toBe(`0100007F:${port.toString(16).toUpperCase().padStart(4, "0")}`);
      expect(listenRows(systemProc, port).every((r) => r.uid === process.getuid!())).toBe(true);
      for (const d of ["", "profile", "downloads", "tmp"]) expect((lstatSync(join(folders.state, "browser", d)).mode & 0o777).toString(8)).toBe("700");
      // A page's Origin is refused by Chrome's own rule.
      const page = new WebSocket(`ws://127.0.0.1:${port}/devtools/browser/x`, { headers: { origin: site.base } } as unknown as string[]);
      const refused = await new Promise<string>((r) => {
        page.onopen = () => r("open");
        page.onerror = () => r("error");
        page.onclose = () => r("closed");
      });
      expect(refused).not.toBe("open");
    },
    T,
  );

  /** The page targets in the order that a second client's browser-level auto-attach lists them (Playwright's connect). */
  const attachOrder = async (): Promise<string[]> => {
    const info = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string };
    const raw = await Cdp.connect(info.webSocketDebuggerUrl);
    const order: string[] = [];
    const off = raw.on((e) => {
      if (e.method !== "Target.attachedToTarget" || e.params.targetInfo?.type !== "page") return;
      order.push(e.params.targetInfo.targetId);
      if (e.params.waitingForDebugger) raw.send("Runtime.runIfWaitingForDebugger", {}, e.params.sessionId).catch(() => {});
    });
    try {
      await raw.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
      await raw.send("Target.getTargetInfo");
      await Bun.sleep(100);
    } finally {
      off();
      raw.close();
    }
    return order;
  };
  /** The relay's own model of the tabs: their targets, ids and whether each is the spare. */
  const model = (k: Kit) => [...(k.relay as unknown as { tabs: Map<string, { target: string; id: string | null; spare: boolean }> }).tabs.values()];

  test(
    "Claude's first tab (D-6, Q3): at each of four Starts, a second client's browser-level auto-attach (Playwright's connect) lists the start tab first, never the spare; a spare that such a client navigates joins the list and the start tab's viewer follows it",
    async () => {
      const k = kits[0]!;
      const firsts: string[] = [];
      for (let i = 0; i < 4; i++) {
        if (i > 0) {
          await k.relay.freeze();
          expect(await k.host.stop()).toBe(true);
          await k.host.start();
          expect(k.host.state).toMatchObject({ state: "running", how: "started" });
        }
        const order = await attachOrder();
        const tabs = model(k);
        const spare = tabs.find((t) => t.spare)!;
        expect(spare).toBeDefined();
        // Chrome lists the pages in the order of their ids; kitespan's spare never comes first.
        expect(order).toEqual([...order].sort());
        firsts.push(order[0] === spare.target ? "spare" : tabs.some((t) => !t.spare && t.target === order[0]) ? "listed" : "unknown");
      }
      expect(firsts).toEqual(["listed", "listed", "listed", "listed"]);
      // The safety net on the real browser: a raw client (Claude's MCP stands in) navigates the spare.
      const c = connect(k);
      drawAll(k, c);
      const startTab = k.relay.tabList()[0]!;
      expect(k.relay.tabList()).toHaveLength(1);
      await send(k, c, { t: "view", tab: startTab.id, w: 640, h: 400, dpr: 1, q: 50, credit: 1 });
      await c.wait("a frame of the start tab", () => c.casts.find((x) => x.header.tab === startTab.id));
      const spare = model(k).find((t) => t.spare)!;
      const info = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string };
      const raw = await Cdp.connect(info.webSocketDebuggerUrl);
      try {
        const { sessionId } = await raw.send<{ sessionId: string }>("Target.attachToTarget", { targetId: spare.target, flatten: true });
        await raw.send("Page.navigate", { url: `${site.base}/plain?t=claude%20page` }, sessionId);
        const follow = await c.wait("the follow", () => c.of("follow")[0]);
        expect(follow.from).toBe(startTab.id);
        const used = await c.wait("the used spare in the list", () => k.relay.tabList().find((t) => t.id === follow.tab && t.url.includes("claude%20page")));
        expect(used).toMatchObject({ by: "other", opener: startTab.id, canBack: false });
        await c.wait("a new spare", () => model(k).some((t) => t.spare && t.target !== spare.target));
        expect(model(k).filter((t) => t.spare)).toHaveLength(1);
      } finally {
        raw.close();
      }
      // Back as the page sends it here (no history of its own, an opener): the start tab again.
      const back = rid();
      await send(k, c, { t: "opener", rid: back, tab: k.relay.tabList()[1]!.id });
      expect((await ack(c, back)).ok).toBe(true);
      // The later tests start from the start tab and a spare alone.
      const r = rid();
      await send(k, c, { t: "tab_close", rid: r, tab: k.relay.tabList()[1]!.id, force: true });
      expect((await ack(c, r)).ok).toBe(true);
      await c.wait("one tab again", () => k.relay.tabList().length === 1);
      await send(k, c, { t: "unview", tab: startTab.id });
    },
    T * 2,
  );

  test(
    "New tab, then a cast: the Desktop page is 1280 x 800, frames are acked end to end, the tab is saved",
    async () => {
      const k = kits[0]!;
      const c = connect(k);
      const r = rid();
      await send(k, c, { t: "tab_new", rid: r, url: `${site.base}/anim` });
      const a = await ack(c, r);
      expect(a.ok).toBe(true);
      expect(a.tab).toMatch(BROWSER_TAB_ID);
      drawAll(k, c);
      await send(k, c, { t: "view", tab: a.tab!, w: 640, h: 400, dpr: 1, q: 50, credit: 2 });
      const f = await c.wait("a 1280 x 800 frame", () => c.casts.find((x) => x.header.tab === a.tab && x.header.dw === 1280 && x.header.dh === 800));
      expect(f.header.w).toBeLessThanOrEqual(640);
      await c.wait("ten frames", () => c.casts.length >= 10);
      expect(k.relay.tabList().find((t) => t.id === a.tab)).toMatchObject({ by: "user", size: { kind: "desktop", w: 1280, h: 800 } });
      await k.tabsFile.flush();
      await Bun.sleep(1_100);
      await k.tabsFile.flush();
      const saved = readJsonFile(join(folders.state, "browser", TABS_FILE));
      expect(saved.tabs.map((t: { id: string }) => t.id)).toContain(a.tab);
      await send(k, c, { t: "unview", tab: a.tab! });
    },
    T,
  );

  test(
    "The URL rule: kitespan's own origins, the debugging port and other schemes never open; nothing reaches Chrome",
    async () => {
      const k = kits[0]!;
      const c = connect(k);
      const before = (await pageTargets()).length;
      for (const url of [`http://127.0.0.1:${OWN_PORT}/`, `http://localhost:${OWN_PORT}/c/x`, `http://127.0.0.1:${port}/json/list`, "file:///etc/passwd", "chrome://settings/", "javascript:alert(1)", "data:text/html,x"]) {
        const r = rid();
        await send(k, c, { t: "tab_new", rid: r, url });
        expect([url, (await ack(c, r)).code]).toEqual([url, "url_refused"]);
      }
      const tab = k.relay.tabList().find((t) => t.by === "user" && t.url.includes("/anim"))!;
      const r = rid();
      await send(k, c, { t: "navigate", rid: r, tab: tab.id, url: `http://[::1]:${OWN_PORT}/` });
      expect((await ack(c, r)).code).toBe("url_refused");
      expect((await pageTargets()).length).toBe(before);
    },
    T,
  );

  test(
    "The Fetch block: a page's own link to kitespan's origin never loads, and neither does a raw navigation",
    async () => {
      const k = kits[0]!;
      // A stand-in for kitespan's own page on its port: it counts every load that reached it.
      const own = startBrowserSite({ port: OWN_PORT });
      const reached = () => own.hits.filter((h) => h.path.startsWith("/app")).length;
      const c = connect(k);
      const r = rid();
      await send(k, c, { t: "tab_new", rid: r, url: `${site.base}/hostile?vec=link_self&to=${encodeURIComponent(`http://u@LOCALHOST:${OWN_PORT}/app`)}` });
      const t = (await ack(c, r)).tab!;
      drawAll(k, c);
      await send(k, c, { t: "view", tab: t, w: 640, h: 400, dpr: 1, q: 50, credit: 1 });
      const fr = await c.wait("a frame of the page", () => c.casts.find((x) => x.header.tab === t && x.header.nav >= 1));
      await send(k, c, { t: "mouse", tab: t, n: fr.header.n, type: "mousePressed", x: 300, y: 300, button: "left", clicks: 1 });
      await send(k, c, { t: "mouse", tab: t, n: fr.header.n, type: "mouseReleased", x: 300, y: 300, button: "left", clicks: 1 });
      await Bun.sleep(1_000);
      expect(reached()).toBe(0);
      // Claude's browser_navigate, as a raw client of its own on another tab: the block holds for it too.
      const r2 = rid();
      await send(k, c, { t: "tab_new", rid: r2, url: `${site.base}/plain?t=raw%20target` });
      await ack(c, r2);
      const info = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string };
      const raw = await Cdp.connect(info.webSocketDebuggerUrl);
      try {
        const { targetInfos } = await raw.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets");
        const target = targetInfos.find((x) => x.type === "page" && x.url.includes("raw%20target"))!;
        const { sessionId } = await raw.send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true });
        await raw.send("Page.navigate", { url: `http://127.0.0.1:${OWN_PORT}/app?raw` }, sessionId).catch(() => {});
        await raw.send("Page.navigate", { url: `http://u@127.0.0.1:${OWN_PORT}/app?userinfo` }, sessionId).catch(() => {});
        await Bun.sleep(800);
      } finally {
        raw.close();
      }
      expect(reached()).toBe(0);
      own.stop();
      await send(k, c, { t: "unview", tab: t });
    },
    T,
  );

  test(
    "Adoption: a second host (kitespan's restart) adopts the same Chrome after the six checks; ids map back",
    async () => {
      const k1 = kits[0]!;
      const c1 = connect(k1);
      await Bun.sleep(100);
      k1.relay.removeConn(c1);
      const before = k1.relay.tabList();
      await k1.relay.freeze();
      const pid = k1.host.running!.pid;
      k1.host.release();
      const k2 = kit();
      await k2.host.boot();
      expect(k2.host.state).toMatchObject({ state: "running", how: "adopted", port });
      expect(k2.host.running!.pid).toBe(pid);
      const c2 = connect(k2);
      await c2.wait("the tabs", () => k2.relay.tabList().length >= before.length);
      // Every saved tab (http and https, never kitespan's own address) keeps its id; the others get new ones.
      const savedIds = savedTabIds();
      expect(savedIds.length).toBeGreaterThan(0);
      const live = k2.relay.tabList().map((t: BrowserTabView) => t.id);
      for (const id of savedIds) expect(live).toContain(id);
      expect(k2.relay.tabList().length).toBe(before.length);
    },
    T,
  );

  test(
    "Stop: Browser.close first, the process gone, host.json gone, tabs.json kept; Start reopens the tabs by id, and at each Start Claude's first page (a second client's browser-level auto-attach lists it first) is the saved tab that a pane socket viewed last (D-6, Q3)",
    async () => {
      const k = kits.at(-1)!;
      // The tab that the pane shows: the oldest saved tab (not the pane's own default, the newest), viewed last.
      const pane = connect(k);
      const more = rid();
      await send(k, pane, { t: "tab_new", rid: more, url: `${site.base}/plain?t=newest%20saved` });
      const newest = (await ack(pane, more)).tab!;
      await pane.wait("the newest tab loaded", () => k.relay.tabList().some((t) => t.id === newest && t.url.includes("newest%20saved")));
      await k.tabsFile.flush();
      await Bun.sleep(1_100);
      await k.tabsFile.flush();
      const oldest = readJsonFile(join(folders.state, "browser", TABS_FILE)).tabs[0].id as string;
      expect(oldest).not.toBe(newest);
      expect(k.relay.tabList().some((t) => t.id === oldest)).toBe(true);
      await send(k, pane, { t: "view", tab: oldest, w: 320, h: 200, dpr: 1, q: 30, credit: 1 });
      await send(k, pane, { t: "unview", tab: oldest });
      k.relay.removeConn(pane);
      await k.relay.freeze();
      expect(readJsonFile(join(folders.state, "browser", TABS_FILE)).shown).toBe(oldest);
      const saved = savedTabIds();
      expect(saved.length).toBeGreaterThan(1);
      const pid = k.host.running!.pid;
      expect(await k.host.stop()).toBe(true);
      expect(settings.enabled).toBe(false);
      expect(k.host.state).toMatchObject({ state: "off", saved: saved.length });
      expect(startOf(systemProc, pid)).toBeNull();
      expect(existsSync(join(folders.state, "browser", HOST_FILE))).toBe(false);
      expect(readJsonFile(join(folders.state, "browser", TABS_FILE)).tabs.length).toBe(saved.length);
      for (let i = 0; i < 3; i++) {
        await k.host.start();
        expect(k.host.state).toMatchObject({ state: "running", how: "started" });
        const c = connect(k);
        await c.wait("the reopened tabs", () => saved.every((id) => k.relay.tabList().some((t) => t.id === id && t.url.startsWith("http"))));
        // One start tab, the reopened tabs and the spare: Chrome's own restore doubled nothing.
        expect((await pageTargets()).length).toBe(saved.length + 2);
        const order = await attachOrder();
        expect([i, model(k).find((t) => t.target === order[0])?.id]).toEqual([i, oldest]);
        k.relay.removeConn(c);
        if (i < 2) expect(await k.host.stop()).toBe(true);
      }
      expect(readdirSync(join(profile(), "Default")).includes("Sessions")).toBe(true);
    },
    T * 2,
  );

  test(
    "A Chrome crash: starting again, a fresh start, the tabs back under their ids",
    async () => {
      const k = kits.at(-1)!;
      await Bun.sleep(1_100);
      const ids = savedTabIds();
      const pid = k.host.running!.pid;
      expect(spawned.some((s) => s.pid === pid)).toBe(true);
      process.kill(pid, "SIGKILL");
      const c = connect(k);
      await c.wait("starting", () => k.host.state.state === "starting");
      await c.wait("running again", () => k.host.state.state === "running" && k.host.running?.pid !== pid, 30_000);
      await c.wait("the tabs back under their ids", () => ids.every((id) => k.relay.tabList().some((t) => t.id === id)), 20_000);
    },
    T,
  );

  test(
    "A dialog on every viewer, the first answer wins, the late one is stale",
    async () => {
      const k = kits.at(-1)!;
      const a = connect(k);
      const b = connect(k);
      const r = rid();
      await send(k, a, { t: "tab_new", rid: r, url: `${site.base}/dialogs` });
      const t = (await ack(a, r)).tab!;
      drawAll(k, a);
      drawAll(k, b);
      await send(k, a, { t: "view", tab: t, w: 1280, h: 800, dpr: 1, q: 50, credit: 1 });
      await send(k, b, { t: "view", tab: t, w: 390, h: 300, dpr: 2, q: 50, credit: 1 });
      const fr = await a.wait("a frame of the page", () => a.casts.find((x) => x.header.tab === t && x.header.nav >= 1));
      await b.wait("a frame on the second viewer", () => b.casts.find((x) => x.header.tab === t));
      for (const type of ["mousePressed", "mouseReleased"] as const) await send(k, a, { t: "mouse", tab: t, n: fr.header.n, type, x: 640, y: 400, button: "left", clicks: 1 });
      const d = await a.wait("the dialog", () => a.last("dialog"));
      expect(d).toMatchObject({ tab: t, type: "confirm", message: "proceed?", embedded: false });
      expect(d.host).toBe(new URL(site.base).host);
      await b.wait("the dialog on the other viewer", () => b.last("dialog"));
      expect(k.relay.tabList().find((x) => x.id === t)!.dialog).toBe(d.id);
      const r1 = rid();
      await send(k, b, { t: "dialog_answer", rid: r1, tab: t, id: d.id, accept: true });
      expect((await ack(b, r1)).ok).toBe(true);
      const closed = await a.wait("dialog_closed", () => a.last("dialog_closed"));
      expect(closed).toMatchObject({ tab: t, id: d.id, result: true, by: "pane" });
      const r2 = rid();
      await send(k, a, { t: "dialog_answer", rid: r2, tab: t, id: d.id, accept: false });
      expect((await ack(a, r2)).code).toBe("stale");
      await a.wait("the title", () => k.relay.tabList().find((x) => x.id === t)?.title === "confirm=true");
    },
    T,
  );

  test(
    "The file chooser through an upload: the card on every viewer, the store's file set, never a path from a page",
    async () => {
      const k = kits.at(-1)!;
      const c = connect(k);
      const r = rid();
      await send(k, c, { t: "tab_new", rid: r, url: `${site.base}/chooser` });
      const t = (await ack(c, r)).tab!;
      drawAll(k, c);
      await send(k, c, { t: "view", tab: t, w: 1280, h: 800, dpr: 1, q: 50, credit: 1 });
      const fr = await c.wait("a frame of the page", () => c.casts.find((x) => x.header.tab === t && x.header.nav >= 1));
      for (const type of ["mousePressed", "mouseReleased"] as const) await send(k, c, { t: "mouse", tab: t, n: fr.header.n, type, x: 640, y: 400, button: "left", clicks: 1 });
      const ch = await c.wait("the chooser", () => c.last("chooser"));
      expect(ch).toMatchObject({ tab: t, mode: "selectSingle", by: "pane", multiple: false, label: "Attachment" });
      expect(ch.accept).toEqual([".txt", "text/plain"]);
      const bad = rid();
      await send(k, c, { t: "chooser_answer", rid: bad, tab: t, id: ch.id, uploads: ["abcdefghijklmnop"] });
      expect((await ack(c, bad)).code).toBe("not_found");
      const good = rid();
      await send(k, c, { t: "chooser_answer", rid: good, tab: t, id: ch.id, uploads: ["k3m7q2x4abk3m7q2"] });
      expect((await ack(c, good)).ok).toBe(true);
      expect(c.last("chooser_closed")).toMatchObject({ tab: t, id: ch.id, by: "pane" });
      await c.wait("the page saw the file", () => k.relay.tabList().find((x) => x.id === t)?.title === "file=note.txt");
    },
    T,
  );

  test(
    "A picker acts on the control that was tapped: the select's items, a pick by index, the native popup closed",
    async () => {
      const k = kits.at(-1)!;
      const c = connect(k);
      const r = rid();
      await send(k, c, { t: "tab_new", rid: r, url: `${site.base}/select` });
      const t = (await ack(c, r)).tab!;
      drawAll(k, c);
      await send(k, c, { t: "view", tab: t, w: 1280, h: 800, dpr: 1, q: 50, credit: 1 });
      const fr = await c.wait("a frame of the page", () => c.casts.find((x) => x.header.tab === t && x.header.nav >= 1));
      for (const type of ["mousePressed", "mouseReleased"] as const) await send(k, c, { t: "mouse", tab: t, n: fr.header.n, type, x: 640, y: 400, button: "left", clicks: 1 });
      const p = await c.wait("the picker", () => c.last("picker"));
      expect(p).toMatchObject({ tab: t, kind: "select", open: true, selected: 0 });
      if (p.kind !== "select") throw new Error("not a select");
      expect(p.items.map((i) => [i.label, i.disabled, i.group])).toEqual([["Apple", false, null], ["Banana", false, null], ["Cherry", true, null], ["Date", false, "More"]]);
      const bad = rid();
      await send(k, c, { t: "pick", rid: bad, tab: t, id: p.id, index: 9 });
      expect((await ack(c, bad)).code).toBe("bad_request");
      const wrongKind = rid();
      await send(k, c, { t: "pick", rid: wrongKind, tab: t, id: p.id, value: "2026-11-09" });
      expect((await ack(c, wrongKind)).code).toBe("bad_request");
      const good = rid();
      await send(k, c, { t: "pick", rid: good, tab: t, id: p.id, index: 3 });
      expect((await ack(c, good)).ok).toBe(true);
      await c.wait("the page's change", () => k.relay.tabList().find((x) => x.id === t)?.title === "s=Date");
      const again = rid();
      await send(k, c, { t: "pick", rid: again, tab: t, id: p.id, index: 1 });
      expect((await ack(c, again)).code).toBe("stale");
    },
    T,
  );

  test(
    "A tab that a page opens: the socket whose tap opened it follows it; Back to the opener",
    async () => {
      const k = kits.at(-1)!;
      const a = connect(k);
      const b = connect(k);
      const r = rid();
      await send(k, a, { t: "tab_new", rid: r, url: `${site.base}/popup` });
      const t = (await ack(a, r)).tab!;
      drawAll(k, a);
      drawAll(k, b);
      await send(k, a, { t: "view", tab: t, w: 1280, h: 800, dpr: 1, q: 50, credit: 1 });
      await send(k, b, { t: "view", tab: t, w: 1280, h: 800, dpr: 1, q: 50, credit: 1 });
      const fr = await a.wait("a frame of the page", () => a.casts.find((x) => x.header.tab === t && x.header.nav >= 1));
      for (const type of ["mousePressed", "mouseReleased"] as const) await send(k, a, { t: "mouse", tab: t, n: fr.header.n, type, x: 640, y: 130, button: "left", clicks: 1 });
      const f = await a.wait("follow", () => a.last("follow"));
      expect(f.from).toBe(t);
      expect(b.of("follow").length).toBe(0);
      await a.wait("the opener hidden", () => k.relay.tabList().find((x) => x.id === t)?.hidden === true);
      const child = await a.wait("the child", () => k.relay.tabList().find((x) => x.id === f.tab && x.opener === t && x.by === "page"));
      expect(child.hidden).toBe(false);
      const r2 = rid();
      await send(k, a, { t: "opener", rid: r2, tab: f.tab });
      expect((await ack(a, r2)).ok).toBe(true);
      await a.wait("the opener shown", () => k.relay.tabList().find((x) => x.id === t)?.hidden === false);
    },
    T,
  );

  test(
    "A download lands in kitespan's folder, 0600, listed by name only",
    async () => {
      const k = kits.at(-1)!;
      const c = connect(k);
      const r = rid();
      await send(k, c, { t: "tab_new", rid: r, url: `${site.base}/download` });
      const t = (await ack(c, r)).tab!;
      drawAll(k, c);
      await send(k, c, { t: "view", tab: t, w: 1280, h: 800, dpr: 1, q: 50, credit: 1 });
      const fr = await c.wait("a frame of the page", () => c.casts.find((x) => x.header.tab === t && x.header.nav >= 1));
      for (const type of ["mousePressed", "mouseReleased"] as const) await send(k, c, { t: "mouse", tab: t, n: fr.header.n, type, x: 640, y: 400, button: "left", clicks: 1 });
      const d = await c.wait("the download", () => c.of("download").find((x) => x.state === "completed"));
      expect(d).toMatchObject({ name: "site-file.txt", received: 23, total: 23 });
      expect(Object.keys(d).sort()).toEqual(["at", "id", "name", "received", "state", "t", "total"]);
      const file = k.downloads.fileOf(d.id)!;
      expect((lstatSync(file.path).mode & 0o777).toString(8)).toBe("600");
    },
    T,
  );

  test(
    "Input against a stale frame: a press after the page navigated is refused, and its release dropped",
    async () => {
      const k = kits.at(-1)!;
      const c = connect(k);
      const r = rid();
      await send(k, c, { t: "tab_new", rid: r, url: `${site.base}/scroll` });
      const t = (await ack(c, r)).tab!;
      drawAll(k, c);
      await send(k, c, { t: "view", tab: t, w: 1280, h: 800, dpr: 1, q: 50, credit: 1 });
      const fr = await c.wait("a frame of the page", () => c.casts.find((x) => x.header.tab === t && x.header.nav >= 1));
      const r2 = rid();
      await send(k, c, { t: "navigate", rid: r2, tab: t, url: `${site.base}/plain?t=moved` });
      await ack(c, r2);
      await c.wait("a frame of the new page", () => c.casts.find((x) => x.header.tab === t && x.header.nav > fr.header.nav));
      await send(k, c, { t: "mouse", tab: t, n: fr.header.n, type: "mousePressed", x: 100, y: 50, button: "left", clicks: 1 });
      expect(c.last("error")).toMatchObject({ code: "stale_frame" });
    },
    T,
  );

  /** A new tab of the site and a cast on it at 1280 x 800; the newest frame of the loaded page. */
  async function tabAndFrame(k: Kit, c: FakeConn, path: string, extra: Partial<BrowserClientFrame> = {}) {
    const r = rid();
    await send(k, c, { t: "tab_new", rid: r, url: `${site.base}${path}`, ...extra } as BrowserClientFrame);
    const t = (await ack(c, r)).tab!;
    drawAll(k, c);
    await send(k, c, { t: "view", tab: t, w: 1280, h: 800, dpr: 1, q: 50, credit: 1 });
    const fr = await c.wait("a frame of the page", () => c.casts.find((x) => x.header.tab === t && x.header.nav >= 1));
    return { t, n: fr.header.n };
  }
  const tap = async (k: Kit, c: FakeConn, t: string, n: number, x: number, y: number) => {
    for (const type of ["mousePressed", "mouseReleased"] as const) await send(k, c, { t: "mouse", tab: t, n, type, x, y, button: "left", clicks: 1 });
  };

  test(
    "The selection sent ahead (D-15): Ctrl+A in a textarea gives its text to the socket that typed; a password field gives none",
    async () => {
      const k = kits.at(-1)!;
      const c = connect(k);
      const { t, n } = await tabAndFrame(k, c, "/text");
      await tap(k, c, t, n, 640, 200);
      const f = await c.wait("the focus", () => c.of("focus").find((x) => x.tab === t && x.editable));
      expect(f).toMatchObject({ editable: true, type: "textarea", password: false });
      for (const type of ["rawKeyDown", "keyUp"] as const) await send(k, c, { t: "key", tab: t, n, type, key: "a", code: "KeyA", vk: 65, mods: 2, sq: 4 });
      const sel = await c.wait("the selection", () => c.of("selection").find((x) => x.sq === 4));
      expect(sel).toEqual({ t: "selection", tab: t, sq: 4, text: "one two three", cut: false });
      await tap(k, c, t, n, 640, 700);
      await c.wait("the password field's focus", () => c.of("focus").find((x) => x.tab === t && x.editable && x.password));
      for (const type of ["rawKeyDown", "keyUp"] as const) await send(k, c, { t: "key", tab: t, n, type, key: "a", code: "KeyA", vk: 65, mods: 2, sq: 5 });
      expect(await c.wait("the selection", () => c.of("selection").find((x) => x.sq === 5))).toMatchObject({ text: "" });
      // The password field's value never leaves the page.
      expect(c.of("selection").map((x) => x.text)).toEqual(["one two three", ""]);
    },
    T,
  );

  test(
    "A date picker: PICKER_FACTS of the tapped field, SET_VALUE_ON with the value as an argument",
    async () => {
      const k = kits.at(-1)!;
      const c = connect(k);
      const { t, n } = await tabAndFrame(k, c, "/date");
      await tap(k, c, t, n, 640, 400);
      const p = await c.wait("the picker", () => c.last("picker"));
      expect(p).toMatchObject({ tab: t, kind: "date", value: "2026-11-09" });
      const r = rid();
      await send(k, c, { t: "pick", rid: r, tab: t, id: p.id, value: "2026-12-25" });
      expect((await ack(c, r)).ok).toBe(true);
      await c.wait("the page's change", () => k.relay.tabList().find((x) => x.id === t)?.title === "d=2026-12-25");
    },
    T,
  );

  test(
    "Page size (D-7): a Phone tab's page is 390 x 844 for every viewer; Desktop again is 1280 x 800",
    async () => {
      const k = kits.at(-1)!;
      const c = connect(k);
      const { t } = await tabAndFrame(k, c, "/anim", { size: { kind: "phone", w: 390, h: 844 } } as Partial<BrowserClientFrame>);
      await c.wait("a phone frame", () => c.casts.find((x) => x.header.tab === t && x.header.dw === 390 && x.header.dh === 844));
      expect(k.relay.tabList().find((x) => x.id === t)!.size).toEqual({ kind: "phone", w: 390, h: 844, by: "user" });
      const r = rid();
      await send(k, c, { t: "tab_size", rid: r, tab: t, kind: "desktop" });
      expect((await ack(c, r)).ok).toBe(true);
      const from = c.casts.length;
      await c.wait("a desktop frame", () => c.casts.slice(from).find((x) => x.header.tab === t && x.header.dw === 1280 && x.header.dh === 800));
    },
    T,
  );

  test(
    "Clear browsing data (S3): stopped, the whole profile emptied, started again with no tabs; downloads stay",
    async () => {
      const k = kits.at(-1)!;
      const before = k.host.running!.pid;
      const dl = k.downloads.list().length;
      writeFileSync(join(profile(), "Default", "kitespan-test-marker"), "x", { mode: 0o600 });
      expect(await k.host.clear()).toBe(true);
      expect(startOf(systemProc, before)).toBeNull();
      expect(k.host.state).toMatchObject({ state: "running", how: "started" });
      const c = connect(k);
      await Bun.sleep(300);
      expect(k.relay.tabList().filter((t) => t.url.startsWith("http"))).toEqual([]);
      expect(readJsonFile(join(folders.state, "browser", TABS_FILE)).tabs).toEqual([]);
      expect(readdirSync(join(profile(), "Default")).includes("kitespan-test-marker")).toBe(false);
      expect(k.downloads.list().length).toBe(dl);
      void c;
    },
    T,
  );

  test(
    "Quit (S4): Browser.close and browser.enabled off; the next boot starts nothing",
    async () => {
      const k = kits.at(-1)!;
      const pid = k.host.running!.pid;
      await k.host.quit();
      expect(settings.enabled).toBe(false);
      expect(startOf(systemProc, pid)).toBeNull();
      const k2 = kit();
      await k2.host.boot();
      expect(k2.host.state.state).toBe("off");
    },
    T,
  );

  test(
    "The port held by another program of this user: port_own, nothing signalled; a bad browser path: missing",
    async () => {
      const other = cdpPort([port]);
      const listener = Bun.listen({ hostname: "127.0.0.1", port: other, socket: { data() {} } });
      try {
        writeFileSync(join(folders.config, "browser.json"), JSON.stringify({ v: 1, chrome: CHROME, port: other, loopbackOnly: true }), { mode: 0o600 });
        const k = kit();
        await k.host.start();
        expect(k.host.state).toMatchObject({ state: "port_own", port: other });
      } finally {
        listener.stop(true);
      }
      writeFileSync(join(folders.config, "browser.json"), JSON.stringify({ v: 1, chrome: join(root, "no-such-chrome"), port }), { mode: 0o600 });
      const k = kit();
      await k.host.start();
      expect(k.host.state).toMatchObject({ state: "missing", reason: "bad_path" });
      expect(k.host.reply().program).toEqual({ path: join(root, "no-such-chrome"), from: "config" });
      writeFileSync(join(folders.config, "browser.json"), JSON.stringify({ v: 1, chrome: CHROME, port, loopbackOnly: true, extraArgs: ["--remote-allow-origins=*"] }), { mode: 0o600 });
      const k3 = kit();
      expect(k3.host.reply().problem).toContain("extraArgs is not valid");
      settings.enabled = false;
    },
    T,
  );

  test("the version the pane's open carries", () => {
    expect(PROTOCOL_VERSION).toBe(5);
  });
});
