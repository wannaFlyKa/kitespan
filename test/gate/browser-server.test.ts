// The browser pane on the real server (DESIGN-B1 7.2, 7.4; S1): bin/kitespan on the test port with the fake claude, a
// browser.json that names Chrome for Testing on a test debugging port (loopback only), and the local test site.
// - /ws/browser over a real socket: refused without an Origin, with null and with a foreign one; open, opened, a tab,
//   binary frames of a 1280 x 800 page.
// - The routes behind the sender gate; Start; the peer check: kitespan's page opened in the shared Chrome by a raw
//   debugging client (Target.createTarget with the URL, which no Fetch block can stop) gets the 403 page.
// - A kitespan crash (kill -9): Chrome runs on, the next kitespan adopts it, the tab ids map back. Quit (S4) stops it
//   and leaves it off.
// - The forward cases (S1, DESIGN-B1 2.16 point 22): a TLS stand-in forward of the test's own in front of kitespan,
//   allowed with --origin, and hostile pages on another site and on the same site. With kitespan's Fetch block (a test
//   Chrome that kitespan adopts: browser.json adds no flag, so the test starts the Chrome that resolves the test names
//   and takes the test certificate, and kitespan adopts it after its six checks) no load of B1's list reaches kitespan;
//   with no block (a plain test Chrome), every load that a page starts gets the 403 page, the browser's own loads get the
//   shell (the residue that DESIGN-B1 names), and kitespan's page loads from its address, a link inside it and a reload.
// The real claude never runs; nothing leaves 127.0.0.1; every Chrome and server is stopped by the pid the test recorded.

import type { Subprocess } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { decodeCastFrame, type BrowserServerFrame } from "../../shared/browser";
import { PROTOCOL_VERSION } from "../../shared/protocol";
import { chromeArgs, chromeEnv } from "../../server/browser/host";
import { SELF_REFUSED_TEXT } from "../../server/browser/guard";
import { cmdlineCheck, startOf, systemProc } from "../../server/browser/procfs";
import { Cdp } from "../../scripts/lib/cdp";
import { HOSTILE_CLICKED, HOSTILE_LOADED, startBrowserSite, type BrowserSite } from "../click/browser-site";
import { pickTestPort } from "../click/ports";
import { installFakeClaude } from "../fake-claude/install";
import { LINUX_ONLY, PROCFS } from "../linux";
import { freePort } from "../unit/free-port";
import { browserFolders, cdpPort, readJsonFile, recordPid, scratch, spawned, stopSpawned, testChrome } from "./browser-lib";

const ROOT = resolve(import.meta.dir, "..", "..");
const SCRIPT = join(ROOT, "bin", "kitespan");
const MAIN = join(ROOT, "server", "main.ts");
const CHROME = testChrome();
const OPENSSL = Bun.which("openssl", { PATH: "/usr/bin:/bin" });
const T = 90_000;

type Frame = BrowserServerFrame;

/** One kitespan server that this test spawned, by its pid, stopped only after kill -0 and a cmdline check. */
interface Server {
  proc: Subprocess<"ignore", "pipe", "pipe">;
  out: () => string;
  stop(signal?: "SIGTERM" | "SIGKILL"): Promise<number | null>;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const cmdline = (pid: number) => (systemProc.read(`/proc/${pid}/cmdline`)?.toString() ?? "").split("\0");

describe.skipIf(!PROCFS || !CHROME)(`the browser pane on the real server ${LINUX_ONLY}`, () => {
  const fake = installFakeClaude("text-thinking");
  let root = "";
  let port = 0;
  let cdp = 0;
  let folders: { state: string; config: string };
  let home = "";
  let dist = "";
  let site: BrowserSite;
  let fwdPort = 0;
  const servers: Server[] = [];
  const own = () => `http://127.0.0.1:${port}`;
  const kitState = () => join(folders.state, "kitespan");
  const profile = () => join(kitState(), "browser", "profile");

  async function boot(extra: string[] = []): Promise<Server> {
    let out = "";
    const env: Record<string, string> = {
      PATH: `${fake.binDir}:${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      XDG_STATE_HOME: folders.state,
      XDG_CONFIG_HOME: folders.config,
      XDG_DATA_HOME: join(root, "data"),
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      SHELL: "/bin/sh",
      LANG: "C.UTF-8",
    };
    const proc = Bun.spawn(["/bin/sh", SCRIPT, "--port", String(port), "--dist", dist, ...extra], { env, cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    recordPid(proc.pid, "server", join(root, "pids.txt"));
    const read = async (s: ReadableStream<Uint8Array>) => {
      const dec = new TextDecoder();
      for await (const c of s) out += dec.decode(c, { stream: true });
    };
    void read(proc.stdout);
    void read(proc.stderr);
    const end = Date.now() + 20_000;
    while (!out.includes(`kitespan listens on ${own()}`)) {
      if (proc.exitCode !== null || Date.now() > end) throw new Error(`the server did not start (exit ${proc.exitCode}): ${out.slice(-800)}`);
      await Bun.sleep(50);
    }
    const s: Server = {
      proc,
      out: () => out,
      async stop(signal = "SIGTERM") {
        if (proc.exitCode === null && alive(proc.pid) && cmdline(proc.pid).includes(MAIN)) process.kill(proc.pid, signal);
        await Promise.race([proc.exited, Bun.sleep(20_000)]);
        return proc.exitCode;
      },
    };
    servers.push(s);
    return s;
  }

  const post = (path: string, body: unknown = {}) => fetch(`${own()}${path}`, { method: "POST", headers: { "x-kitespan": "1", "content-type": "application/json", origin: own() }, body: JSON.stringify(body) });
  const browserState = async () => ((await (await fetch(`${own()}/api/browser`)).json()) as { host: { state: string; how?: string } }).host;
  const until = async (what: string, ok: () => boolean | Promise<boolean>, ms = 20_000) => {
    const end = Date.now() + ms;
    while (!(await ok())) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await Bun.sleep(50);
    }
  };

  /** A pane socket over the wire. */
  function pane(origin: string | null = own()): Promise<{ frames: Frame[]; casts: ReturnType<typeof decodeCastFrame>[]; ws: WebSocket; opened: Promise<boolean>; send: (f: unknown) => void }> {
    return new Promise((resolveIt) => {
      const frames: Frame[] = [];
      const casts: ReturnType<typeof decodeCastFrame>[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/browser`, (origin ? { headers: { origin } } : {}) as unknown as string[]);
      ws.binaryType = "arraybuffer";
      let done: (v: boolean) => void = () => {};
      const opened = new Promise<boolean>((r) => (done = r));
      ws.onopen = () => done(true);
      ws.onerror = () => done(false);
      ws.onclose = () => done(false);
      ws.onmessage = (m) => {
        if (typeof m.data === "string") frames.push(JSON.parse(m.data) as Frame);
        else {
          const d = decodeCastFrame(new Uint8Array(m.data as ArrayBuffer));
          casts.push(d);
          if (d) ws.send(JSON.stringify({ t: "drawn", tab: d.header.tab, n: d.header.n }));
        }
      };
      resolveIt({ frames, casts, ws, opened, send: (f) => ws.send(JSON.stringify(f)) });
    });
  }

  beforeAll(() => {
    root = scratch("kbs");
    port = pickTestPort(7945);
    cdp = cdpPort();
    home = join(root, "home");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    folders = browserFolders(root, CHROME!, cdp);
    mkdirSync(join(folders.config, "kitespan"), { recursive: true, mode: 0o700 });
    writeFileSync(join(folders.config, "kitespan", "browser.json"), readFileSync(join(folders.config, "browser.json")), { mode: 0o600 });
    dist = join(root, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), `<!doctype html><html><head><title>kitespan stub</title></head><body><a id="next" href="/chats" style="position:fixed;left:0;top:0;width:100vw;height:100vh;display:block">next</a></body></html>`);
    site = startBrowserSite();
    fwdPort = freePort();
  });

  afterAll(async () => {
    for (const s of servers) await s.stop().catch(() => null);
    // A test that failed half way may leave kitespan's own Chrome: stopped only by kitespan's own record of its spawn,
    // with the same start, on this test's profile.
    const rec = readJsonFile(join(kitState(), "browser", "host.json"));
    if (rec && startOf(systemProc, rec.pid) === rec.start) recordPid(rec.pid, profile());
    site?.stop();
    fake.cleanup();
    const left = await stopSpawned();
    expect(left.filter((pid) => spawned.find((s) => s.pid === pid)?.profile !== "server")).toEqual([]);
    // Every server and Chrome of this test is gone: its scratch folder (the profiles, the certificate) goes too.
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test(
    "/ws/browser: no Origin, null and a foreign Origin are refused before the upgrade; kitespan's own opens; open gets opened",
    async () => {
      const s = await boot([`--origin`, `https://kite.test:${fwdPort}`]);
      void s;
      for (const origin of [null, "null", "https://evil.example", `http://127.0.0.1:${port + 1}`]) {
        const p = await pane(origin);
        expect([origin, await p.opened]).toEqual([origin, false]);
      }
      const p = await pane();
      expect(await p.opened).toBe(true);
      p.send({ t: "ping", n: 1 });
      await Bun.sleep(100);
      expect(p.frames.map((f) => f.t)).toEqual(["error"]);
      p.send({ t: "open", v: PROTOCOL_VERSION });
      await until("opened", () => p.frames.some((f) => f.t === "opened"));
      expect(p.frames.find((f) => f.t === "opened")).toEqual({ t: "opened", host: { state: "off", port: cdp, saved: 0 }, tabs: [], acting: [], downloads: [] });
      p.send({ t: "ping", n: 7 });
      await until("pong", () => p.frames.some((f) => f.t === "pong" && f.n === 7));
      p.ws.send(new Uint8Array([1, 2, 3]));
      await until("the close for a binary frame", async () => p.ws.readyState === WebSocket.CLOSED);
    },
    T,
  );

  test(
    "Start behind the sender gate, then a tab over the wire: binary frames of a 1280 x 800 page",
    async () => {
      expect((await fetch(`${own()}/api/browser/start`, { method: "POST", headers: { "content-type": "application/json", origin: own() }, body: "{}" })).status).toBe(403);
      expect((await fetch(`${own()}/api/browser/start`, { method: "POST", headers: { "x-kitespan": "1", "content-type": "application/json", origin: own(), "sec-fetch-site": "cross-site" }, body: "{}" })).status).toBe(403);
      expect((await post("/api/browser/start")).status).toBe(200);
      await until("running", async () => (await browserState()).state === "running");
      expect(readJsonFile(join(kitState(), "settings.json"))["browser.enabled"]).toBe(true);
      const p = await pane();
      await p.opened;
      p.send({ t: "open", v: PROTOCOL_VERSION });
      const rid = crypto.randomUUID();
      p.send({ t: "tab_new", rid, url: `${site.base}/anim` });
      await until("the ack", () => p.frames.some((f) => f.t === "ack" && f.rid === rid));
      const ack = p.frames.find((f) => f.t === "ack" && f.rid === rid) as Extract<Frame, { t: "ack" }>;
      expect(ack.ok).toBe(true);
      p.send({ t: "view", tab: ack.tab, w: 640, h: 400, dpr: 1, q: 50, credit: 2 });
      await until("frames of the page", () => p.casts.filter((c) => c !== null && c.header.tab === ack.tab && c.header.nav >= 1).length >= 5);
      const c = p.casts.at(-1)!;
      expect([c!.header.dw, c!.header.dh, c!.header.w <= 640]).toEqual([1280, 800, true]);
      p.ws.close();
    },
    T,
  );

  test(
    "the peer check: kitespan's page that a raw client opens in the shared Chrome (no Fetch block can stop it) gets the 403 page",
    async () => {
      const v = (await (await fetch(`http://127.0.0.1:${cdp}/json/version`)).json()) as { webSocketDebuggerUrl: string };
      const raw = await Cdp.connect(v.webSocketDebuggerUrl);
      try {
        const { targetId } = await raw.send<{ targetId: string }>("Target.createTarget", { url: `${own()}/chats` });
        const { sessionId } = await raw.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
        let text = "";
        await until("the page's text", async () => {
          const r = await raw.send<{ result: { value?: string } }>("Runtime.evaluate", { expression: "document.body ? document.body.innerText : ''", returnByValue: true }, sessionId).catch(() => null);
          text = r?.result.value ?? "";
          return text.length > 0;
        });
        expect(text).toContain(SELF_REFUSED_TEXT);
        expect(text).not.toContain("next");
        await raw.send("Target.closeTarget", { targetId });
      } finally {
        raw.close();
      }
      expect(servers.at(-1)!.out()).not.toContain("/chats");
    },
    T,
  );

  test(
    "a kitespan crash (kill -9): Chrome runs on; the next kitespan adopts it after its checks; the saved tab keeps its id",
    async () => {
      const rec = readJsonFile(join(kitState(), "browser", "host.json"));
      await Bun.sleep(1_200);
      const saved = readJsonFile(join(kitState(), "browser", "tabs.json")).tabs.map((t: { id: string }) => t.id);
      expect(saved.length).toBeGreaterThan(0);
      expect(await servers.at(-1)!.stop("SIGKILL")).toBeNull();
      expect(startOf(systemProc, rec.pid)).toBe(rec.start);
      await boot([`--origin`, `https://kite.test:${fwdPort}`]);
      await until("adopted", async () => (await browserState()).state === "running");
      expect(await browserState()).toMatchObject({ state: "running", how: "adopted" });
      expect(readJsonFile(join(kitState(), "browser", "host.json")).pid).toBe(rec.pid);
      const p = await pane();
      await p.opened;
      p.send({ t: "open", v: PROTOCOL_VERSION });
      await until("opened", () => p.frames.some((f) => f.t === "opened"));
      const tabs = (p.frames.find((f) => f.t === "opened") as Extract<Frame, { t: "opened" }>).tabs.map((t) => t.id);
      for (const id of saved) expect(tabs).toContain(id);
      p.ws.close();
    },
    T,
  );

  test(
    "quit (S4): SIGTERM stops the shared browser too and turns it off; tabs.json stays",
    async () => {
      const rec = readJsonFile(join(kitState(), "browser", "host.json"));
      expect(await servers.at(-1)!.stop("SIGTERM")).toBe(0);
      expect(startOf(systemProc, rec.pid)).toBeNull();
      expect(readJsonFile(join(kitState(), "settings.json"))["browser.enabled"]).toBe(false);
      expect(readJsonFile(join(kitState(), "browser", "host.json"))).toBeNull();
      expect(readJsonFile(join(kitState(), "browser", "tabs.json")).tabs.length).toBeGreaterThan(0);
    },
    T,
  );

  // -------------------------------------------------------------------------------------------------------------
  // The forward cases (S1)

  describe.skipIf(!OPENSSL)("through a TLS stand-in forward (S1)", () => {
    let tls: { key: string; cert: string };
    let hostile: BrowserSite;
    let forward: ReturnType<typeof Bun.serve>;
    /** What reached kitespan through the forward: the path, Sec-Fetch-Site and -Dest, and kitespan's status. */
    const seen: { path: string; site: string | null; dest: string | null; status: number }[] = [];
    const kite = () => `https://kite.test:${fwdPort}`;
    const NAMES = "MAP kite.test 127.0.0.1,MAP hostile.test 127.0.0.1,MAP evil.kite.test 127.0.0.1,MAP * ~NOTFOUND,EXCLUDE 127.0.0.1,EXCLUDE localhost";

    /** One request to kitespan over a plain socket, the forward's own process (no proxy, as a forward is). */
    async function relay(req: Request): Promise<Response> {
      const u = new URL(req.url);
      const body = req.method === "GET" || req.method === "HEAD" ? new Uint8Array(0) : new Uint8Array(await req.arrayBuffer());
      const lines = [`${req.method} ${u.pathname}${u.search} HTTP/1.1`];
      req.headers.forEach((v, k) => {
        if (!["connection", "accept-encoding", "content-length", "transfer-encoding"].includes(k)) lines.push(`${k}: ${v}`);
      });
      lines.push("connection: close", `content-length: ${body.length}`, "", "");
      const head = new TextEncoder().encode(lines.join("\r\n"));
      const chunks: Uint8Array[] = [];
      await new Promise<void>((done) => {
        void Bun.connect({
          hostname: "127.0.0.1",
          port,
          socket: {
            open(s) {
              s.write(head);
              if (body.length) s.write(body);
            },
            data(_s, c) {
              chunks.push(new Uint8Array(c));
            },
            close: () => done(),
            end: () => done(),
            error: () => done(),
            connectError: () => done(),
          },
        });
      });
      const all = Buffer.concat(chunks);
      const split = all.indexOf("\r\n\r\n");
      const headText = all.subarray(0, split).toString("latin1").split("\r\n");
      const status = Number(headText[0]!.split(" ")[1]);
      const headers = new Headers();
      for (const l of headText.slice(1)) {
        const i = l.indexOf(":");
        if (i > 0 && !["content-length", "connection", "transfer-encoding"].includes(l.slice(0, i).toLowerCase())) headers.append(l.slice(0, i), l.slice(i + 1).trim());
      }
      seen.push({ path: u.pathname + u.search, site: req.headers.get("sec-fetch-site"), dest: req.headers.get("sec-fetch-dest"), status });
      return new Response(status === 204 || status === 304 ? null : all.subarray(split + 4), { status, headers });
    }

    /** A Chrome of the test's own: the test names and certificate, on `port` with `prof`. Recorded; stopped by pid. */
    async function testBrowser(debugPort: number, prof: string): Promise<{ pid: number; ws: string }> {
      mkdirSync(prof, { recursive: true, mode: 0o700 });
      chmodSync(prof, 0o700);
      const args = [...chromeArgs(CHROME!, debugPort, prof, false).slice(0, -1), `--host-resolver-rules=${NAMES}`, "--no-proxy-server", "--disable-background-networking", "--disable-component-update", "--ignore-certificate-errors", "about:blank"];
      const p = Bun.spawn(args, { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore", env: chromeEnv({ HOME: home, PATH: "/usr/bin:/bin", TMPDIR: process.env.TMPDIR }, null, true) });
      p.unref();
      recordPid(p.pid, prof, join(root, "pids.txt"));
      let ws = "";
      await until("the test Chrome", async () => {
        try {
          ws = ((await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
        } catch {}
        return ws !== "";
      });
      return { pid: p.pid, ws };
    }

    /** Run one of B1's loads in a Chrome; `claude` stands for Claude's raw client on the same Chrome. */
    async function load(raw: Cdp, vec: string, to: string): Promise<void> {
      const page = async (url: string) => {
        const { targetId } = await raw.send<{ targetId: string }>("Target.createTarget", { url });
        const { sessionId } = await raw.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
        await Bun.sleep(700);
        return { targetId, sessionId };
      };
      const click = async (sessionId: string) => {
        for (const type of ["mousePressed", "mouseReleased"]) await raw.send("Input.dispatchMouseEvent", { type, x: 200, y: 200, button: "left", clickCount: 1 }, sessionId);
      };
      const hostileUrl = (h: string) => `https://${h}:${hostile.port}/hostile?vec=${vec.replace("samesite_", "")}&to=${encodeURIComponent(to)}`;
      if ((HOSTILE_CLICKED as readonly string[]).includes(vec)) await click((await page(hostileUrl("hostile.test"))).sessionId);
      else if (vec === "samesite_location") await click((await page(hostileUrl("evil.kite.test"))).sessionId);
      else if ((HOSTILE_LOADED as readonly string[]).includes(vec)) await page(hostileUrl("hostile.test"));
      else if (vec === "claude_navigate") await raw.send("Page.navigate", { url: to }, (await page(`https://hostile.test:${hostile.port}/plain`)).sessionId).catch(() => {});
      else if (vec === "claude_navigate_userinfo") await raw.send("Page.navigate", { url: to.replace("https://", "https://u@") }, (await page(`https://hostile.test:${hostile.port}/plain`)).sessionId).catch(() => {});
      else if (vec === "claude_blank_script") await raw.send("Runtime.evaluate", { expression: `location.href = ${JSON.stringify(to)}` }, (await page("about:blank")).sessionId).catch(() => {});
      await Bun.sleep(1_200);
    }

    const PAGE_STARTED = [...HOSTILE_CLICKED, "samesite_location", ...HOSTILE_LOADED];
    const BROWSER_STARTED = ["claude_navigate", "claude_navigate_userinfo"];

    beforeAll(async () => {
      const dir = join(root, "tls");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const r = Bun.spawnSync([OPENSSL!, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "1", "-subj", "/CN=kite.test", "-addext", "subjectAltName=DNS:kite.test,DNS:hostile.test,DNS:evil.kite.test"], { stdout: "ignore", stderr: "ignore", env: { PATH: "/usr/bin:/bin", HOME: home } });
      if (r.exitCode !== 0) throw new Error("openssl could not make the test certificate");
      chmodSync(join(dir, "key.pem"), 0o600);
      tls = { key: readFileSync(join(dir, "key.pem"), "utf8"), cert: readFileSync(join(dir, "cert.pem"), "utf8") };
      hostile = startBrowserSite({ tls });
      forward = Bun.serve({ hostname: "127.0.0.1", port: fwdPort, reusePort: false, tls, fetch: (req) => relay(req) });
    });
    afterAll(() => {
      hostile?.stop();
      forward?.stop(true);
    });

    test(
      "with kitespan's Fetch block (a test Chrome that kitespan adopts): no load of B1's list reaches kitespan",
      async () => {
        await boot([`--origin`, kite()]);
        // The test's Chrome on kitespan's profile and port, with host.json: kitespan adopts it after its six checks.
        const dir = join(kitState(), "browser");
        for (const d of [dir, join(dir, "downloads"), join(dir, "tmp")]) mkdirSync(d, { recursive: true, mode: 0o700 });
        const b = await testBrowser(cdp, profile());
        writeFileSync(join(dir, "host.json"), JSON.stringify({ v: 1, pid: b.pid, start: startOf(systemProc, b.pid), port: cdp, binary: CHROME, startedAt: new Date().toISOString() }), { mode: 0o600 });
        expect(cmdlineCheck(systemProc.read(`/proc/${b.pid}/cmdline`), [`--user-data-dir=${profile()}`], ["--remote-allow-origins"]).ok).toBe(true);
        expect((await post("/api/browser/start")).status).toBe(200);
        await until("adopted", async () => (await browserState()).state === "running");
        expect(await browserState()).toMatchObject({ how: "adopted" });
        const raw = await Cdp.connect(b.ws);
        try {
          for (const vec of [...PAGE_STARTED, ...BROWSER_STARTED, "claude_blank_script"]) {
            seen.splice(0);
            await load(raw, vec, `${kite()}/chats?v=${vec}`);
            const shells = seen.filter((x) => x.path.startsWith("/chats") && x.status === 200);
            expect([vec, shells]).toEqual([vec, []]);
          }
        } finally {
          raw.close();
        }
        expect(await servers.at(-1)!.stop("SIGTERM")).toBe(0);
        expect(startOf(systemProc, b.pid)).toBeNull();
      },
      T * 3,
    );

    test(
      "with no block (a plain test Chrome): every load a page starts gets 403; the browser's own loads get the shell; kitespan's page loads from its address, a link inside it and a reload",
      async () => {
        await boot([`--origin`, kite()]);
        const b = await testBrowser(cdpPort([cdp]), join(root, "plain"));
        const raw = await Cdp.connect(b.ws);
        try {
          for (const vec of PAGE_STARTED) {
            seen.splice(0);
            await load(raw, vec, `${kite()}/chats?v=${vec}`);
            const docs = seen.filter((x) => x.path.startsWith("/chats"));
            expect([vec, docs.length > 0 || vec === "worker" || vec === "page_fetch", docs.filter((d) => d.status === 200 && d.dest !== "empty")]).toEqual([vec, true, []]);
            // A form's POST to an app path gets 405 (only GET and HEAD get the page); every other load gets the 403 page.
            for (const d of docs.filter((x) => x.dest === "document" || x.dest === "iframe")) expect([vec, d.site, d.status]).toEqual([vec, d.site === "same-site" ? "same-site" : "cross-site", vec === "form_post" ? 405 : 403]);
          }
          // The residue: a load that the browser itself starts carries Sec-Fetch-Site none, as a typed address does.
          for (const vec of BROWSER_STARTED) {
            seen.splice(0);
            await load(raw, vec, `${kite()}/chats?v=${vec}`);
            expect([vec, seen.filter((x) => x.path.startsWith("/chats")).map((x) => [x.site, x.status])]).toEqual([vec, [["none", 200]]]);
          }
          // The owner's own: the address, a link inside the page, a reload.
          seen.splice(0);
          const { targetId } = await raw.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
          const { sessionId } = await raw.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
          await raw.send("Page.navigate", { url: `${kite()}/` }, sessionId);
          await Bun.sleep(800);
          for (const type of ["mousePressed", "mouseReleased"]) await raw.send("Input.dispatchMouseEvent", { type, x: 200, y: 200, button: "left", clickCount: 1 }, sessionId);
          await Bun.sleep(800);
          await raw.send("Page.reload", {}, sessionId);
          await Bun.sleep(800);
          const docs = seen.filter((x) => x.dest === "document");
          expect(docs.map((x) => [x.path, x.status])).toEqual([
            ["/", 200],
            ["/chats", 200],
            ["/chats", 200],
          ]);
          expect(docs.map((x) => x.site)).toEqual(["none", "same-origin", "same-origin"]);
          const text = await raw.send<{ result: { value?: string } }>("Runtime.evaluate", { expression: "document.title", returnByValue: true }, sessionId);
          expect(text.result.value).toBe("kitespan stub");
          await raw.send("Browser.close").catch(() => {});
          await until("the plain Chrome gone", () => startOf(systemProc, b.pid) === null);
        } finally {
          raw.close();
        }
        expect(await servers.at(-1)!.stop("SIGTERM")).toBe(0);
      },
      T * 3,
    );
  });
});
