// The shared browser's host against fake /proc tables (DESIGN-B1 2.3, 2.4, 7.1; S2): check 2's parser in both of the
// cmdline file's forms (Chrome's own argv, and the space-joined title that Chrome writes under a large environment),
// with a profile path with and without a space and the three prefix traps; the adoption checks; the stop order, which
// signals only after checks 1, 2 and 3; the states (off, missing, port_own, port_other, starting, running, crashed);
// S4's quit; browser.json's checks; the command line and the environment allow-list.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CdpEvent, CdpLike } from "../../server/browser/cdp";
import { BROWSER_DEFAULT_PORT, browserConfigProblemKey, readBrowserConfig } from "../../server/browser/config";
import { BrowserHost, chromeArgs, chromeEnv, hostRecordOf, tmpFits, versionNumber, type HostOptions, type HostRecord, type Signal } from "../../server/browser/host";
import { cmdlineCheck, connectionInode, holderOf, listenRows, startOf, treeOf, type ProcReader } from "../../server/browser/procfs";
import { checkTree } from "../../server/store/files";
import { leftOpaque } from "../../server/store/store";

const BOOT = "0f0e2c8c-1f4a-4c41-a3c6-6b2c1a7f0d12";
const UID = 1000;
const PROFILE = "/srv/you/.local/state/kitespan/browser/profile";
const SPACED = "/srv/you/my state/kitespan/browser/profile";
const BIN = "/opt/chrome/chrome";
const HEADLESS_ADDS = ["--noerrdialogs", "--ozone-platform=headless", "--ozone-override-screen-size=800,600", "--use-angle=swiftshader-webgl"];

const argvOf = (profile: string, port = BROWSER_DEFAULT_PORT) => chromeArgs(BIN, port, profile, true);
/** The file as Chrome's own argv: its fields with a NUL after each. */
const argvFile = (fields: string[]) => Buffer.from(fields.map((f) => `${f}\0`).join(""));
/** The file as a rewritten title: one space-joined string, the real binary path first, the headless flags added, one NUL. */
const titleFile = (fields: string[]) => Buffer.from(`${["/srv/real/you/opt/chrome/chrome", ...fields.slice(1), ...HEADLESS_ADDS].join(" ")}\0`);

describe("check 2: the cmdline in both forms (S2)", () => {
  const want = (profile: string, port = BROWSER_DEFAULT_PORT) => [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`];
  const refused = ["--remote-allow-origins"];
  test("Chrome's argv: 15 fields; each flag one whole field", () => {
    expect(argvOf(PROFILE).length).toBe(15);
    expect(cmdlineCheck(argvFile(argvOf(PROFILE)), want(PROFILE), refused)).toEqual({ form: "argv", ok: true });
    expect(cmdlineCheck(argvFile(argvOf(SPACED)), want(SPACED), refused)).toEqual({ form: "argv", ok: true });
  });
  test("the rewritten title: one string with one NUL, the resolver rule in five words, each flag between spaces", () => {
    const t = titleFile(argvOf(PROFILE));
    expect([...t].filter((b) => b === 0).length).toBe(1);
    // 15 arguments, the resolver rule's 4 more words, and the 4 flags that headless mode adds.
    expect(t.toString().replace("\0", "").split(" ").length).toBe(23);
    expect(cmdlineCheck(t, want(PROFILE), refused)).toEqual({ form: "title", ok: true });
    expect(cmdlineCheck(titleFile(argvOf(SPACED)), want(SPACED), refused)).toEqual({ form: "title", ok: true });
  });
  test("the three prefix traps fail in both forms: the profile plus 2, the port plus 0, a shorter profile path", () => {
    for (const p of [PROFILE, SPACED]) {
      for (const file of [argvFile(argvOf(p)), titleFile(argvOf(p))]) {
        expect(cmdlineCheck(file, [`--user-data-dir=${p}2`, `--remote-debugging-port=${BROWSER_DEFAULT_PORT}`], refused).ok).toBe(false);
        expect(cmdlineCheck(file, [`--user-data-dir=${p}`, `--remote-debugging-port=${BROWSER_DEFAULT_PORT}0`], refused).ok).toBe(false);
        expect(cmdlineCheck(file, [`--user-data-dir=${p.slice(0, -2)}`, `--remote-debugging-port=${BROWSER_DEFAULT_PORT}`], refused).ok).toBe(false);
      }
    }
  });
  test("--remote-allow-origins is refused in both forms; an empty or missing file is no form", () => {
    const withOrigins = [...argvOf(PROFILE).slice(0, -1), "--remote-allow-origins=*", "about:blank"];
    expect(cmdlineCheck(argvFile(withOrigins), want(PROFILE), refused)).toEqual({ form: "argv", ok: false });
    expect(cmdlineCheck(titleFile(withOrigins), want(PROFILE), refused)).toEqual({ form: "title", ok: false });
    expect(cmdlineCheck(Buffer.alloc(0), want(PROFILE), refused)).toEqual({ form: "none", ok: false });
    expect(cmdlineCheck(null, want(PROFILE), refused)).toEqual({ form: "none", ok: false });
  });
  test("another profile, the user's own Chrome, fails", () => {
    const own = chromeArgs(BIN, BROWSER_DEFAULT_PORT, "/srv/you/.config/google-chrome", false);
    expect(cmdlineCheck(argvFile(own), want(PROFILE), refused).ok).toBe(false);
    expect(cmdlineCheck(titleFile(own), want(PROFILE), refused).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// A fake /proc

interface FakeProcess {
  pid: number;
  ticks: string;
  state?: string;
  uid: number;
  cmdline: Buffer;
  fds?: Record<string, string>;
  children?: number[];
}

class FakeProc implements ProcReader {
  procs = new Map<number, FakeProcess>();
  tcp: string[] = [];
  tcp6: string[] = [];
  boot = BOOT;
  add(p: FakeProcess): void {
    this.procs.set(p.pid, p);
  }
  read(path: string): Buffer | null {
    if (path === "/proc/sys/kernel/random/boot_id") return Buffer.from(`${this.boot}\n`);
    if (path === "/proc/net/tcp") return Buffer.from(["  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode", ...this.tcp].join("\n"));
    if (path === "/proc/net/tcp6") return Buffer.from(["  sl  local_address rem_address st", ...this.tcp6].join("\n"));
    const m = /^\/proc\/(\d+)\/(stat|status|cmdline)$/.exec(path) ?? /^\/proc\/(\d+)\/task\/\d+\/(children)$/.exec(path);
    if (!m) return null;
    const p = this.procs.get(Number(m[1]));
    if (!p) return null;
    if (m[2] === "stat") return Buffer.from(`${p.pid} (chrome) ${p.state ?? "S"} 1 ${p.pid} ${p.pid} 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 ${p.ticks} 1 1\n`);
    if (m[2] === "status") return Buffer.from(`Name:\tchrome\nUid:\t${p.uid}\t${p.uid}\t${p.uid}\t${p.uid}\n`);
    if (m[2] === "children") return Buffer.from((p.children ?? []).join(" "));
    return p.cmdline;
  }
  list(path: string): string[] | null {
    const fd = /^\/proc\/(\d+)\/fd$/.exec(path);
    if (fd) return Object.keys(this.procs.get(Number(fd[1]))?.fds ?? {});
    const task = /^\/proc\/(\d+)\/task$/.exec(path);
    if (task) return this.procs.has(Number(task[1])) ? [task[1]!] : null;
    return null;
  }
  link(path: string): string | null {
    const m = /^\/proc\/(\d+)\/fd\/(\d+)$/.exec(path);
    return m ? (this.procs.get(Number(m[1]))?.fds?.[m[2]!] ?? null) : null;
  }
  /** A LISTEN row on 127.0.0.1:<port> of `uid` with this inode. */
  listen(port: number, uid: number, inode: string): void {
    this.tcp.push(`   0: 0100007F:${port.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  ${uid}        0 ${inode} 1 0000000000000000 100 0 0 10 0`);
  }
  exit(pid: number): void {
    this.procs.delete(pid);
    this.tcp = this.tcp.filter((r) => !r.includes(` ${this.inodeOf(pid)} `));
  }
  inodeOf(pid: number): string {
    return Object.values(this.procs.get(pid)?.fds ?? {})[0]?.replace(/\D/g, "") ?? "-";
  }
}

describe("the /proc readers", () => {
  const proc = new FakeProc();
  proc.add({ pid: 4242, ticks: "987654", uid: UID, cmdline: argvFile(argvOf(PROFILE)), fds: { "3": "socket:[5551]", "4": "/dev/null" }, children: [4243] });
  proc.add({ pid: 4243, ticks: "987700", uid: UID, cmdline: argvFile(["chrome", "--type=renderer"]), fds: { "9": "socket:[7777]" } });
  proc.listen(9340, UID, "5551");
  test("check 1's value: the start ticks with the boot's id; a zombie or a missing pid gives null", () => {
    expect(startOf(proc, 4242)).toBe(`987654@${BOOT}`);
    expect(startOf(proc, 1)).toBeNull();
    expect(startOf(proc, 99999)).toBeNull();
    proc.add({ pid: 4244, ticks: "1", state: "Z", uid: UID, cmdline: Buffer.alloc(0) });
    expect(startOf(proc, 4244)).toBeNull();
  });
  test("the LISTEN rows, the inode's holder, a process tree", () => {
    expect(listenRows(proc, 9340)).toEqual([{ uid: UID, inode: "5551" }]);
    expect(listenRows(proc, 9341)).toEqual([]);
    expect(holderOf(proc, "5551", [4243, 4242])).toBe(4242);
    expect(holderOf(proc, "5551", [4243])).toBeNull();
    expect(treeOf(proc, 4242)).toEqual([4242, 4243]);
  });
  test("a loopback connection's inode, by the peer's port and kitespan's", () => {
    proc.tcp.push(`   1: 0100007F:D431 0100007F:1F05 01 00000000:00000000 00:00000000 00000000  ${UID}        0 7777 1 0000000000000000 20 4 30 10 -1`);
    expect(connectionInode(proc, { address: "127.0.0.1", port: 0xd431 }, 0x1f05)).toBe("7777");
    expect(connectionInode(proc, { address: "::ffff:127.0.0.1", port: 0xd431 }, 0x1f05)).toBe("7777");
    expect(connectionInode(proc, { address: "127.0.0.1", port: 0xd432 }, 0x1f05)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The host with fakes

/** A fake debugging connection: SystemInfo names `pid`; Browser.close ends the process when `closes`. */
class FakeCdp implements CdpLike {
  closed = false;
  sent: string[] = [];
  private closeFns: (() => void)[] = [];
  constructor(
    private readonly pid: () => number,
    /** What Browser.close does: the process ends and the socket closes. */
    private readonly ends: () => void,
    private readonly closes: () => boolean,
  ) {}
  async send<T>(method: string): Promise<T> {
    this.sent.push(method);
    if (method === "SystemInfo.getProcessInfo") return { processInfo: [{ type: "browser", id: this.pid() }] } as T;
    if (method === "Browser.close" && this.closes()) setTimeout(() => this.ends(), 5);
    return {} as T;
  }
  on(_l: (e: CdpEvent) => void): () => void {
    return () => {};
  }
  onClose(l: () => void): () => void {
    this.closeFns.push(l);
    return () => {};
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const f of this.closeFns) f();
  }
}

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

interface World {
  host: BrowserHost;
  proc: FakeProc;
  signals: [number, Signal][];
  spawns: string[][];
  settings: { enabled: boolean };
  attached: { fresh: boolean }[];
  cdps: FakeCdp[];
  state: string;
  /** Browser.close ends the process (true by default). */
  closes: boolean;
  /** Something of this user (or another) listens on the port. */
  busy: boolean;
  nextPid: number;
  /** A spawned Chrome answers /json/version (true by default). */
  answers: boolean;
}

function world(over: Partial<HostOptions> = {}, config: Record<string, unknown> = { v: 1, chrome: process.execPath, port: 9399 }): World {
  const root = mkdtempSync(join(tmpdir(), "kbu-"));
  roots.push(root);
  const state = join(root, "state");
  const configDir = join(root, "config");
  mkdirSync(state, { mode: 0o700 });
  mkdirSync(configDir, { mode: 0o700 });
  writeFileSync(join(configDir, "browser.json"), JSON.stringify(config), { mode: 0o600 });
  const w: World = { proc: new FakeProc(), signals: [], spawns: [], settings: { enabled: false }, attached: [], cdps: [], state, closes: true, busy: false, nextPid: 5000, answers: true } as unknown as World;
  const profile = join(state, "browser", "profile");
  const port = (config.port as number) ?? BROWSER_DEFAULT_PORT;
  let current = 0;
  w.host = new BrowserHost({
    state,
    configDir,
    uid: process.getuid!(),
    env: { HOME: "/srv/you", PATH: "/usr/bin", ANTHROPIC_API_KEY: "secret", AWS_SECRET_ACCESS_KEY: "secret", http_proxy: "http://proxy:3128", TMPDIR: "/tmp" },
    home: "/srv/you",
    refusedPorts: () => [7945],
    settings: { enabled: async () => w.settings.enabled, setEnabled: async (on) => void (w.settings.enabled = on) },
    savedTabs: async () => 3,
    attach: async (_cdp, info) => void w.attached.push({ fresh: info.fresh }),
    detached: () => {},
    clearTabs: async () => {},
    proc: w.proc,
    spawn: (argv) => {
      w.spawns.push(argv);
      const pid = w.nextPid++;
      current = pid;
      w.proc.add({ pid, ticks: String(100 + pid), uid: process.getuid!(), cmdline: argvFile(argv), fds: { "7": `socket:[${pid}0]` } });
      w.proc.listen(port, process.getuid!(), `${pid}0`);
      return { pid };
    },
    kill: (pid, sig) => {
      w.signals.push([pid, sig]);
      if (sig === "SIGKILL") w.proc.exit(pid);
      return true;
    },
    version: async (p) => (w.answers && w.proc.procs.size > 0 ? { browser: "HeadlessChrome/154.0.8037.57", wsUrl: `ws://127.0.0.1:${p}/devtools/browser/abc-123` } : null),
    connect: async () => {
      const cdp: FakeCdp = new FakeCdp(
        () => current,
        () => {
          w.proc.exit(current);
          cdp.close();
        },
        () => w.closes,
      );
      w.cdps.push(cdp);
      return cdp;
    },
    portBusy: () => w.busy,
    limits: { startWaitMs: 500, closeWaitMs: 60, termWaitMs: 60, backoffFirstMs: 10, backoffMaxMs: 40 },
    ...over,
  });
  void profile;
  return w;
}

const waitFor = async (what: string, ok: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
};

describe("the host's states", () => {
  test("off at boot until the user's Start; off says how many tabs are saved", async () => {
    const w = world();
    await w.host.boot();
    expect(w.host.state).toEqual({ state: "off", port: 9399, saved: 3 });
    expect(w.spawns).toEqual([]);
  });
  test("Start: browser.enabled on, the session folders removed, a detached spawn with the design's flags, running", async () => {
    const w = world();
    const sessions = join(w.state, "browser", "profile", "Default", "Sessions");
    mkdirSync(sessions, { recursive: true, mode: 0o700 });
    writeFileSync(join(sessions, "Session_1"), "x");
    await w.host.start();
    expect(w.settings.enabled).toBe(true);
    expect(w.host.state).toEqual({ state: "running", how: "started", version: "154.0.8037.57", port: 9399 });
    expect(w.attached).toEqual([{ fresh: true }]);
    expect(Bun.file(sessions).size).toBe(0);
    const argv = w.spawns[0]!;
    expect(argv).toContain(`--user-data-dir=${join(w.state, "browser", "profile")}`);
    expect(argv).toContain("--remote-debugging-address=127.0.0.1");
    expect(argv.some((a) => /remote-allow-origins|no-sandbox|disable-web-security|enable-automation|remote-debugging-pipe/.test(a))).toBe(false);
    expect(argv.at(-1)).toBe("about:blank");
    const rec = hostRecordOf(await Bun.file(join(w.state, "browser", "host.json")).json())!;
    expect(rec.start).toBe(`${100 + rec.pid}@${BOOT}`);
  });
  test("missing: no binary, or a configured path that fails its checks", async () => {
    const none = world({ env: { PATH: "/nonexistent" }, home: "/nonexistent" }, { v: 1, port: 9399 });
    await none.host.start();
    expect(none.host.state).toEqual({ state: "missing", port: 9399, reason: "none" });
    const bad = world({}, { v: 1, chrome: "/nonexistent/chrome", port: 9399 });
    await bad.host.start();
    expect(bad.host.state).toEqual({ state: "missing", port: 9399, reason: "bad_path" });
    expect(bad.spawns).toEqual([]);
  });
  test("the port held: port_own for this user's program, port_other for another user's; nothing adopted or signalled", async () => {
    const own = world();
    own.busy = true;
    own.proc.listen(9399, process.getuid!(), "1234");
    await own.host.start();
    expect(own.host.state).toEqual({ state: "port_own", port: 9399 });
    const other = world();
    other.busy = true;
    other.proc.listen(9399, process.getuid!() + 1, "1235");
    await other.host.start();
    expect(other.host.state).toEqual({ state: "port_other", port: 9399 });
    expect([...own.signals, ...other.signals, ...own.spawns, ...other.spawns]).toEqual([]);
  });
  test("Chrome's crash: starting again with the attempt, then crashed at the sixth end in ten minutes", async () => {
    const w = world();
    w.answers = false;
    await w.host.start();
    await waitFor("crashed", () => w.host.state.state === "crashed", 5_000);
    expect(w.spawns.length).toBe(6);
    expect(w.host.state).toEqual({ state: "crashed", port: 9399 });
    expect(w.settings.enabled).toBe(true);
  });
});

describe("adoption (the six checks)", () => {
  const startOnce = async () => {
    const w = world();
    await w.host.start();
    return w;
  };
  const adopter = (w: World) => {
    const w2 = world();
    // The same state folder: a second host on it, with the first world's /proc.
    return new BrowserHost({ ...(w2.host as unknown as { o: HostOptions }).o, state: w.state, proc: w.proc, connect: (w.host as unknown as { o: HostOptions }).o.connect, version: (w.host as unknown as { o: HostOptions }).o.version, attach: async (_c, info) => void w.attached.push({ fresh: info.fresh }) });
  };
  test("all six pass: adopted, nothing spawned, no reopen", async () => {
    const w = await startOnce();
    w.host.release();
    w.settings.enabled = true;
    const h2 = adopter(w);
    const before = w.spawns.length;
    (h2 as unknown as { o: HostOptions }).o.settings = { enabled: async () => true, setEnabled: async () => {} };
    await h2.boot();
    expect(h2.state).toMatchObject({ state: "running", how: "adopted" });
    expect(w.spawns.length).toBe(before);
    expect(w.attached.at(-1)).toEqual({ fresh: false });
  });
  test("a reused pid (another start), another uid, or a socket held elsewhere: never adopted", async () => {
    const rec = (w: World): HostRecord => hostRecordOf(JSON.parse(require("node:fs").readFileSync(join(w.state, "browser", "host.json"), "utf8")))!;
    const w = await startOnce();
    w.host.release();
    const r = rec(w);
    expect(w.host.ownProcess(r)).toBe(true);
    expect(w.host.ownProcess({ ...r, start: `1@${BOOT}` })).toBe(false);
    w.proc.boot = "11111111-2222-4333-8444-555555555555";
    expect(w.host.ownProcess(r)).toBe(false);
    w.proc.boot = BOOT;
    w.proc.procs.get(r.pid)!.uid = process.getuid!() + 1;
    expect(w.host.ownProcess(r)).toBe(false);
    w.proc.procs.get(r.pid)!.uid = process.getuid!();
    expect(w.host.ownListener(r)).toBe(true);
    w.proc.procs.get(r.pid)!.fds = {};
    expect(w.host.ownListener(r)).toBe(false);
    w.proc.procs.get(r.pid)!.fds = { "7": `socket:[${r.pid}0]` };
    w.proc.listen(r.port, process.getuid!() + 1, "999");
    expect(w.host.ownListener(r)).toBe(false);
  });
});

describe("the stop order (DESIGN-B1 2.4)", () => {
  test("Browser.close first; a Chrome that exits gets no signal; host.json goes; browser.enabled off", async () => {
    const w = world();
    await w.host.start();
    expect(await w.host.stop()).toBe(true);
    expect(w.cdps[0]!.sent).toContain("Browser.close");
    expect(w.signals).toEqual([]);
    expect(w.settings.enabled).toBe(false);
    expect(await Bun.file(join(w.state, "browser", "host.json")).exists()).toBe(false);
    expect(w.host.state).toEqual({ state: "off", port: 9399, saved: 3 });
  });
  test("a Chrome that outlives Browser.close: SIGTERM, then SIGKILL, each after checks 1 to 3", async () => {
    const w = world();
    await w.host.start();
    w.closes = false;
    const pid = w.host.running!.pid;
    expect(await w.host.stop()).toBe(true);
    expect(w.signals).toEqual([
      [pid, "SIGTERM"],
      [pid, "SIGKILL"],
    ]);
  });
  test("a stop whose check 1 fails (the pid is another process now) sends no signal", async () => {
    const w = world();
    await w.host.start();
    w.closes = false;
    const pid = w.host.running!.pid;
    w.proc.procs.get(pid)!.ticks = "1";
    expect(await w.host.stop()).toBe(true);
    expect(w.signals).toEqual([]);
  });
  test("a stop whose check 2 fails (another command line on that process) sends no signal and says so", async () => {
    const w = world();
    await w.host.start();
    w.closes = false;
    const pid = w.host.running!.pid;
    w.proc.procs.get(pid)!.cmdline = argvFile(["/usr/bin/other", "--user-data-dir=/elsewhere"]);
    expect(await w.host.stop()).toBe(false);
    expect(w.signals).toEqual([]);
  });
  test("S4, quit: Browser.close and browser.enabled off; the next boot starts nothing", async () => {
    const w = world();
    await w.host.start();
    await w.host.quit();
    expect(w.settings.enabled).toBe(false);
    expect(w.cdps[0]!.sent).toContain("Browser.close");
    expect(w.proc.procs.size).toBe(0);
  });
  test("Clear browsing data: nothing removed while Chrome still runs (false); else the profile emptied and a new start", async () => {
    const w = world();
    await w.host.start();
    const profile = join(w.state, "browser", "profile");
    writeFileSync(join(profile, "Cookies"), "c", { mode: 0o600 });
    symlinkSync("/etc/passwd", join(profile, "SingletonLock"));
    w.closes = false;
    const pid = w.host.running!.pid;
    w.proc.procs.get(pid)!.cmdline = argvFile(["/usr/bin/other"]);
    expect(await w.host.clear()).toBe(false);
    expect(await Bun.file(join(profile, "Cookies")).exists()).toBe(true);
    expect(w.host.state.state).toBe("running");
    w.proc.procs.get(pid)!.cmdline = argvFile(argvOf(profile, 9399));
    w.closes = true;
    expect(await w.host.clear()).toBe(true);
    expect(await Bun.file(join(profile, "Cookies")).exists()).toBe(false);
    expect(require("node:fs").readdirSync(profile)).toEqual([]);
    expect(await Bun.file("/etc/passwd").exists()).toBe(true);
    expect(w.host.state.state).toBe("running");
  });
});

describe("browser.json (DESIGN-B1 2.1)", () => {
  const dir = mkdtempSync(join(tmpdir(), "kbc-"));
  roots.push(dir);
  const file = join(dir, "browser.json");
  const put = (v: unknown, mode = 0o600) => {
    rmSync(file, { force: true });
    writeFileSync(file, typeof v === "string" ? v : JSON.stringify(v), { mode });
    chmodSync(file, mode);
  };
  test("the keys and their values; unknown keys and any flag are refused", () => {
    expect(browserConfigProblemKey({ v: 1 }, [])).toBeNull();
    expect(browserConfigProblemKey({ v: 1, chrome: "/usr/bin/chromium", port: 9341, loopbackOnly: true }, [])).toBeNull();
    for (const [raw, key] of [
      [{ v: 2 }, "v"],
      [{ v: 1, flags: ["--remote-allow-origins=*"] }, "flags"],
      [{ v: 1, extraArgs: [] }, "extraArgs"],
      [{ v: 1, chrome: "chrome" }, "chrome"],
      [{ v: 1, chrome: "/usr/bin/chrome --remote-allow-origins=*\n" }, "chrome"],
      [{ v: 1, port: 80 }, "port"],
      [{ v: 1, port: 7945 }, "port"],
      [{ v: 1, port: 9340.5 }, "port"],
      [{ v: 1, loopbackOnly: "yes" }, "loopbackOnly"],
      [[], "(the top level)"],
    ] as const) {
      expect([raw, browserConfigProblemKey(raw, [7945])]).toEqual([raw, key]);
    }
  });
  test("the file's checks: a link, a mode others can write, too large, not JSON; each gives the defaults and one line", () => {
    expect(readBrowserConfig(join(dir, "none.json"), [])).toEqual({ chrome: null, port: 9340, portFrom: "default", loopbackOnly: false, problem: null });
    put({ v: 1, port: 9341 });
    expect(readBrowserConfig(file, [])).toMatchObject({ port: 9341, portFrom: "config", problem: null });
    put({ v: 1, port: 9341 }, 0o620);
    expect(readBrowserConfig(file, []).problem).toContain("other users can change the file");
    put("{not json");
    expect(readBrowserConfig(file, []).problem).toContain("not JSON");
    put("x".repeat(5000));
    expect(readBrowserConfig(file, []).problem).toContain("too large");
    put({ v: 1, port: 9341, chrome: "/x", nope: 1 });
    expect(readBrowserConfig(file, []).problem).toContain("nope is not valid");
    expect(readBrowserConfig(file, []).port).toBe(9340);
    rmSync(file);
    writeFileSync(join(dir, "real.json"), "{}", { mode: 0o600 });
    symlinkSync(join(dir, "real.json"), file);
    expect(readBrowserConfig(file, []).problem).toContain("symbolic link");
  });
});

describe("the command line and the environment (DESIGN-B1 2.2)", () => {
  test("the flags, and loopbackOnly's four", () => {
    expect(chromeArgs(BIN, 9340, PROFILE, false)).toEqual([BIN, "--headless=new", "--remote-debugging-port=9340", "--remote-debugging-address=127.0.0.1", `--user-data-dir=${PROFILE}`, "--no-first-run", "--no-default-browser-check", "--password-store=basic", "--window-size=1280,943", "--enable-unsafe-swiftshader", "about:blank"]);
    expect(chromeArgs(BIN, 9340, PROFILE, true).slice(10, 14)).toEqual(["--host-resolver-rules=MAP * ~NOTFOUND,EXCLUDE 127.0.0.1,EXCLUDE localhost", "--no-proxy-server", "--disable-background-networking", "--disable-component-update"]);
  });
  test("the allow-list: no credential reaches Chrome; the proxy only when not loopbackOnly; TMPDIR kitespan's when it fits", () => {
    const env = { HOME: "/h", PATH: "/p", LANG: "C", LC_ALL: "C", FONTCONFIG_FILE: "/f", ANTHROPIC_API_KEY: "k", AWS_ACCESS_KEY_ID: "k", CLAUDE_CODE_X: "k", KITESPAN_X: "k", GITHUB_TOKEN: "k", HTTPS_PROXY: "http://p", no_proxy: "x", TMPDIR: "/tmp" };
    expect(chromeEnv(env, "/s/browser/tmp", false)).toEqual({ HOME: "/h", PATH: "/p", LANG: "C", LC_ALL: "C", FONTCONFIG_FILE: "/f", HTTPS_PROXY: "http://p", no_proxy: "x", TMPDIR: "/s/browser/tmp" });
    expect(chromeEnv(env, null, true)).toEqual({ HOME: "/h", PATH: "/p", LANG: "C", LC_ALL: "C", FONTCONFIG_FILE: "/f", TMPDIR: "/tmp" });
    expect(tmpFits("/".padEnd(62, "a"))).toBe(true);
    expect(tmpFits("/".padEnd(63, "a"))).toBe(false);
  });
  test("an inherited TMPDIR too long for Chrome's socket is left out, and a short link to a long folder does not fit", () => {
    const long = "/".padEnd(63, "a");
    expect(chromeEnv({ HOME: "/h", TMPDIR: long }, null, true)).toEqual({ HOME: "/h" });
    expect(chromeEnv({ HOME: "/h", TMPDIR: long }, "/s/browser/tmp", true)).toEqual({ HOME: "/h", TMPDIR: "/s/browser/tmp" });
    // Chrome makes its socket under the real path: a link with a short name to a deep folder does not fit.
    const root = mkdtempSync(join(tmpdir(), "kbt-"));
    roots.push(root);
    let deep = root;
    while (Buffer.byteLength(deep) + 45 <= 107) deep = join(deep, "dddddddd");
    mkdirSync(deep, { recursive: true });
    const link = join(root, "l");
    symlinkSync(deep, link);
    expect(tmpFits(link)).toBe(false);
    expect(tmpFits(deep)).toBe(false);
  });
  test("host.json's record check, and the version number", () => {
    expect(hostRecordOf({ v: 1, pid: 12, start: `1@${BOOT}`, port: 9340, binary: BIN, startedAt: "2026-11-09T00:00:00.000Z" })).not.toBeNull();
    for (const bad of [{ v: 1, pid: 1, start: `1@${BOOT}`, port: 9340, binary: BIN, startedAt: "x" }, { v: 1, pid: 12, start: "1", port: 9340, binary: BIN, startedAt: "x" }, { v: 1, pid: 12, start: `1@${BOOT}`, port: 80, binary: BIN, startedAt: "x" }, null, []]) expect(hostRecordOf(bad)).toBeNull();
    expect(versionNumber("HeadlessChrome/154.0.8037.57")).toBe("154.0.8037.57");
    expect(versionNumber("Chrome")).toBeUndefined();
  });
});

describe("leftOpaque: the state folder's tree check and a Chrome profile (DESIGN-B1 2.5)", () => {
  test("the profile's three links and three 0644 files, the downloads' 0644 files and Chrome's socket folder pass", async () => {
    const root = mkdtempSync(join(tmpdir(), "kbo-"));
    roots.push(root);
    const state = join(root, "state");
    for (const d of ["", "browser", "browser/profile", "browser/profile/Default", "browser/downloads", "browser/tmp"]) mkdirSync(join(state, d), { mode: 0o700 });
    for (const l of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) symlinkSync("host-1234", join(state, "browser/profile", l));
    for (const f of ["Variations", "Last Version", "Default/README"]) writeFileSync(join(state, "browser/profile", f), "x", { mode: 0o644 });
    writeFileSync(join(state, "browser/downloads", "0f0e2c8c-1f4a-4c41-a3c6-6b2c1a7f0d12"), "x", { mode: 0o644 });
    symlinkSync("/x", join(state, "browser/tmp", "SingletonSocket"));
    writeFileSync(join(state, "browser", "tabs.json"), "{}", { mode: 0o600 });
    expect(await checkTree(state, process.getuid!(), leftOpaque)).toEqual([]);
    expect((await checkTree(state, process.getuid!())).length).toBeGreaterThan(0);
    // Their own mode is still checked, and so is everything beside them.
    chmodSync(join(state, "browser/profile"), 0o755);
    writeFileSync(join(state, "browser", "host.json"), "{}", { mode: 0o644 });
    expect((await checkTree(state, process.getuid!(), leftOpaque)).map((p) => p.path).sort()).toEqual(["browser/host.json", "browser/profile"]);
  });
});
