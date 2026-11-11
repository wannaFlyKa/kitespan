// The shared browser's host (DESIGN-B1 2.1 to 2.5; SERVER-B1 2.3 to 2.9): one headless Chrome on 127.0.0.1:<port>
// with kitespan's own profile in the state folder, started outside kitespan's process group or adopted after six
// checks, and its states as codes that the page words (shared/browser.ts BROWSER_HOST_STATES).
//
// At boot (when browser.enabled) and at Start, in order: adopt the Chrome that host.json names, when all six checks
// pass; else test the port (`port_own`, `port_other`: nothing is adopted, signalled or started); else remove the
// profile's two session folders (D-5), spawn Chrome detached with about:blank, write host.json, wait for /json/version
// (20 s at most), run checks 3 to 6 on what answers, connect, and let the relay reopen the saved tabs.
//
// The checks (SERVER-B1 2.6, S2): 1, the pid's start ticks with the boot's id equal the record's (the anchor: a reused
// pid fails it); 2, its command line names kitespan's profile and the port, and no --remote-allow-origins, in both of
// the file's forms (a sanity check only); 3, its uid is the server's; 4, every LISTEN row of the port is this uid's;
// 5, the pid holds that row's socket; 6, /json/version names ws://127.0.0.1:<port>/devtools/browser/, and once
// connected SystemInfo.getProcessInfo's browser id is the pid. Adoption needs all six; a signal needs 1, 2 and 3, run
// again just before it. kitespan never adopts a Chrome on another profile and never signals a program it did not start.
//
// Stop (the user's, and kitespan's quit, S4): Browser.close, which writes the cookie store; after 3 s SIGTERM; after
// 5 s more SIGKILL; host.json goes once it is gone, tabs.json stays. The user's Stop and a quit turn browser.enabled
// off, so the browser stays off until the user's next Start; a restart never stops it, and a crash cannot.
// Chrome's crash: `starting` again after 1 s, then 2, 4, 8 and 16 s; the sixth end in ten minutes gives `crashed`.

import { closeSync, constants, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { browserMcpCommand, type BrowserHostView, type BrowserMissingReason, type BrowserReply } from "../../shared/browser";
import type { Logger } from "../log";
import { readJson, writeAtomic } from "../store/files";
import { loopback } from "../update/loopback";
import { CdpClient, type CdpLike } from "./cdp";
import { BROWSER_FILE, chooseBinary, readBrowserConfig, type BinaryChoice, type BrowserConfig } from "./config";
import { cmdlineCheck, holderOf, listenRows, startOf, systemProc, uidOf, type ProcReader } from "./procfs";

export const HOST_FILE = "host.json";
export const HOST_LIMITS = {
  hostFileBytes: 4 * 1024,
  startWaitMs: 20_000,
  closeWaitMs: 3_000,
  termWaitMs: 5_000,
  /** The window in which six ends give `crashed`. */
  crashWindowMs: 10 * 60_000,
  crashEnds: 6,
  backoffFirstMs: 1_000,
  backoffMaxMs: 60_000,
} as const;

/** host.json: the Chrome that kitespan started, as the next kitespan adopts it. */
export interface HostRecord {
  v: 1;
  pid: number;
  /** The start ticks of /proc/<pid>/stat, `@`, the boot's id (check 1). */
  start: string;
  port: number;
  binary: string;
  startedAt: string;
}

export function hostRecordOf(raw: unknown): HostRecord | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || typeof r.pid !== "number" || !Number.isInteger(r.pid) || r.pid <= 1) return null;
  if (typeof r.start !== "string" || !/^[0-9]{1,20}@[0-9a-f-]{36}$/.test(r.start)) return null;
  if (typeof r.port !== "number" || !Number.isInteger(r.port) || r.port < 1024 || r.port > 65535) return null;
  if (typeof r.binary !== "string" || r.binary.length > 4096 || typeof r.startedAt !== "string" || r.startedAt.length > 40) return null;
  return { v: 1, pid: r.pid, start: r.start, port: r.port, binary: r.binary, startedAt: r.startedAt };
}

/** What /json/version gave. */
export interface VersionInfo {
  browser: string;
  wsUrl: string;
}

export type Signal = "SIGTERM" | "SIGKILL";

/** The spawn of Chrome, detached into its own session; tests give a double. */
export type SpawnChrome = (argv: string[], opts: { env: Record<string, string>; out: number }) => { pid: number };

export interface HostOptions {
  /** kitespan's state folder; the browser's files are in its browser/ folder. */
  state: string;
  /** kitespan's config folder, where browser.json is. */
  configDir: string;
  uid: number;
  /** The start environment (server/start-env-copy.ts): Chrome's environment comes from its allow-list. */
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  /** kitespan's own port, and the ports of its allowed origins (the browser's port may take neither). */
  refusedPorts: () => number[];
  /** browser.enabled in settings.json. */
  settings: { enabled(): Promise<boolean>; setEnabled(on: boolean): Promise<void> };
  /** How many tabs tabs.json holds (the `off` state's `saved`). */
  savedTabs(): Promise<number>;
  /** The relay takes the connection: `fresh` after a start of kitespan's own (reopen the saved tabs), false after an adoption. */
  attach(cdp: CdpLike, info: { fresh: boolean; start: string; pid: number; port: number }): Promise<void>;
  /** The connection went (a stop, a crash, a lost socket). */
  detached(): void;
  /** Clear browsing data's tabs.json: emptied. */
  clearTabs(): Promise<void>;
  /** Just before the stop order: the relay writes tabs.json as it is and writes no more until the next attach. */
  beforeStop?(): Promise<void>;
  log?: Pick<Logger, "log">;
  proc?: ProcReader;
  spawn?: SpawnChrome;
  kill?: (pid: number, signal: Signal) => boolean;
  version?: (port: number, timeoutMs: number) => Promise<VersionInfo | null>;
  connect?: (wsUrl: string) => Promise<CdpLike>;
  /** True when something listens on 127.0.0.1:<port>. */
  portBusy?: (port: number) => boolean;
  /** Tests: shorter waits. */
  limits?: Partial<Record<keyof typeof HOST_LIMITS, number>>;
  now?: () => number;
}

type Timer = ReturnType<typeof setTimeout>;

/** The proxy variables, either case (SERVER-B1 2.2): the owner's browsing needs the owner's proxy. */
const PROXY = new Set(["http_proxy", "https_proxy", "no_proxy", "all_proxy"]);
const ENV_KEEP = new Set(["HOME", "PATH", "USER", "LOGNAME", "SHELL", "LANG", "TZ", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"]);

/** Chrome's environment (DESIGN-B1 2.2): an allow-list of the start environment; no credential of any tool reaches it. */
export function chromeEnv(env: Readonly<Record<string, string | undefined>>, tmp: string | null, loopbackOnly: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    const keep = ENV_KEEP.has(k) || k.startsWith("LC_") || k.startsWith("FONTCONFIG_") || (!loopbackOnly && PROXY.has(k.toLowerCase()));
    if (keep) out[k] = v;
  }
  // kitespan's own folder when the singleton socket's path fits under it, else the inherited one when it fits, else
  // none, so Chrome takes the system's (under a TMPDIR that is too long, Chrome ends at its start).
  const t = tmp ?? (env.TMPDIR && tmpFits(env.TMPDIR) ? env.TMPDIR : undefined);
  if (t) out.TMPDIR = t;
  return out;
}

/**
 * The singleton socket's path under TMPDIR must stay under 108 bytes (SERVER-B1 2.2): Chrome makes
 * <tmp>/org.chromium.Chromium.XXXXXX/SingletonSocket, 45 bytes more, under the folder's real path, so both the path
 * as given and its real path must fit.
 */
export const tmpFits = (tmp: string): boolean => {
  let real = tmp;
  try {
    real = realpathSync(tmp);
  } catch {}
  return Math.max(Buffer.byteLength(tmp), Buffer.byteLength(real)) + 45 <= 107;
};

/** Chrome's command line (DESIGN-B1 2.2), then about:blank. Never --remote-allow-origins or any flag from a file. */
export function chromeArgs(binary: string, port: number, profile: string, loopbackOnly: boolean): string[] {
  return [
    binary,
    "--headless=new",
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--password-store=basic",
    "--window-size=1280,943",
    "--enable-unsafe-swiftshader",
    ...(loopbackOnly
      ? ["--host-resolver-rules=MAP * ~NOTFOUND,EXCLUDE 127.0.0.1,EXCLUDE localhost", "--no-proxy-server", "--disable-background-networking", "--disable-component-update"]
      : []),
    "about:blank",
  ];
}

/** /json/version over a plain loopback socket, never through the user's proxy (server/update/loopback.ts). */
export async function readVersion(port: number, timeoutMs: number): Promise<VersionInfo | null> {
  try {
    const a = await loopback({ port, method: "GET", path: "/json/version", timeoutMs, maxBytes: 16 * 1024 });
    const j = a.json as { Browser?: unknown; webSocketDebuggerUrl?: unknown } | undefined;
    if (a.status !== 200 || !j || typeof j.webSocketDebuggerUrl !== "string" || typeof j.Browser !== "string") return null;
    return { browser: j.Browser, wsUrl: j.webSocketDebuggerUrl };
  } catch {
    return null;
  }
}

function busyPort(port: number): boolean {
  try {
    const s = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    s.stop(true);
    return false;
  } catch {
    return true;
  }
}

const systemSpawn: SpawnChrome = (argv, o) => {
  const p = Bun.spawn(argv, { detached: true, stdin: "ignore", stdout: o.out, stderr: o.out, env: o.env });
  p.unref();
  return { pid: p.pid };
};

const systemKill = (pid: number, signal: Signal): boolean => {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
};

/** The browser's version from /json/version's `Browser` (for example `HeadlessChrome/154.0.8037.57`): the number. */
export function versionNumber(browser: string): string | undefined {
  const m = /\/(\d+(?:\.\d+){0,3})$/.exec(browser);
  return m ? m[1] : undefined;
}

export class BrowserHost {
  private view: BrowserHostView;
  private readonly listeners = new Set<(v: BrowserHostView) => void>();
  private readonly proc: ProcReader;
  private readonly lim: Record<keyof typeof HOST_LIMITS, number>;
  private readonly now: () => number;
  private chain: Promise<unknown> = Promise.resolve();
  private cdp: CdpLike | null = null;
  private record: HostRecord | null = null;
  private config: BrowserConfig;
  private binary: BinaryChoice = { path: null, from: null, reason: "none", tried: null };
  private ends: number[] = [];
  private retry: Timer | null = null;
  private stopping = false;
  private quitting = false;

  readonly dir: string;
  readonly profile: string;
  readonly downloads: string;
  readonly tmp: string;

  constructor(private readonly o: HostOptions) {
    this.proc = o.proc ?? systemProc;
    this.lim = { ...HOST_LIMITS, ...o.limits };
    this.now = o.now ?? Date.now;
    this.dir = join(o.state, "browser");
    this.profile = join(this.dir, "profile");
    this.downloads = join(this.dir, "downloads");
    this.tmp = join(this.dir, "tmp");
    this.config = this.readConfig();
    this.view = { state: "off", port: this.config.port };
  }

  /** The state as the page draws it. */
  get state(): BrowserHostView {
    return this.view;
  }

  /** The record of the Chrome in use (the peer check reads its pid). */
  get running(): HostRecord | null {
    return this.view.state === "running" ? this.record : null;
  }

  onState(listener: (v: BrowserHostView) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Settings > Browser's facts (GET /api/browser). */
  reply(): BrowserReply {
    const program = this.binary.path !== null ? { path: this.binary.path, from: this.binary.from } : { path: this.binary.tried, from: this.binary.tried ? ("config" as const) : null };
    return {
      host: this.view,
      program,
      port: { value: this.config.port, from: this.config.portFrom },
      problem: this.config.problem,
      profile: this.profile,
      mcp: browserMcpCommand(this.config.port),
    };
  }

  private readConfig(): BrowserConfig {
    return readBrowserConfig(join(this.o.configDir, BROWSER_FILE), this.o.refusedPorts(), this.o.uid < 0 ? null : this.o.uid);
  }

  private set(v: BrowserHostView): void {
    this.view = v;
    for (const l of [...this.listeners]) {
      try {
        l(v);
      } catch {}
    }
  }

  private async setOff(): Promise<void> {
    const saved = await this.o.savedTabs().catch(() => 0);
    this.set({ state: "off", port: this.config.port, saved });
  }

  /** One host operation at a time. */
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const next = this.chain.then(job, job);
    this.chain = next.catch(() => {});
    return next;
  }

  /** At kitespan's boot: the browser starts (or is adopted) only when browser.enabled. */
  boot(): Promise<void> {
    return this.serial(async () => {
      this.config = this.readConfig();
      if (await this.o.settings.enabled().catch(() => false)) await this.begin();
      else await this.setOff();
    });
  }

  /** The user's Start (also Try again): browser.enabled on, then the three steps. Nothing new while it runs. */
  start(): Promise<void> {
    return this.serial(async () => {
      if (this.view.state === "running" && this.cdp && !this.cdp.closed) return;
      this.quitting = false;
      this.ends = [];
      this.clearRetry();
      await this.o.settings.setEnabled(true);
      this.config = this.readConfig();
      await this.begin();
    });
  }

  /** The user's Stop: browser.enabled off, then the stop order. */
  stop(): Promise<boolean> {
    return this.serial(async () => {
      this.clearRetry();
      await this.o.settings.setEnabled(false).catch(() => {});
      const gone = await this.stopChrome();
      if (gone) await this.setOff();
      return gone;
    });
  }

  /**
   * S4: kitespan's quit (SIGTERM or SIGINT, server/main.ts stop()), never the restart path: browser.enabled off, so the
   * browser stays off until the user's Start, then the stop order.
   */
  quit(): Promise<void> {
    this.quitting = true;
    this.clearRetry();
    return this.serial(async () => {
      if (!this.record && !this.cdp && !(await this.readRecord())) return;
      await this.o.settings.setEnabled(false).catch(() => {});
      await this.stopChrome();
    });
  }

  /**
   * kitespan's restart (its successor adopts the browser): the connection goes, no restart is scheduled, and Chrome
   * runs on as it is.
   */
  release(): void {
    this.quitting = true;
    this.clearRetry();
    const cdp = this.cdp;
    this.cdp = null;
    if (cdp) {
      try {
        cdp.close();
      } catch {}
      this.o.detached();
    }
  }

  /**
   * Clear browsing data (S3): the stop order; when Chrome still runs after it, nothing is removed and the answer is
   * false. Else the profile folder is emptied (never through a link), tabs.json emptied, chrome-out.log removed, and a
   * browser that was running starts again with no tabs. Downloads stay.
   */
  clear(): Promise<boolean> {
    return this.serial(async () => {
      const was = this.view;
      const wasOn = was.state === "running" || was.state === "starting";
      this.clearRetry();
      const gone = await this.stopChrome();
      if (!gone) {
        this.set(was);
        return false;
      }
      emptyFolder(this.profile);
      await this.o.clearTabs().catch(() => {});
      try {
        unlinkSync(join(this.dir, "chrome-out.log"));
      } catch {}
      this.o.log?.log("browser", { answer: "cleared" });
      if (wasOn) await this.begin();
      else await this.setOff();
      return true;
    });
  }

  private clearRetry(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
  }

  private async readRecord(): Promise<HostRecord | null> {
    try {
      const r = await readJson(join(this.dir, HOST_FILE), this.lim.hostFileBytes, this.o.uid);
      return r.kind === "ok" ? hostRecordOf(r.value) : null;
    } catch {
      return null;
    }
  }

  private wantFlags(port: number): string[] {
    return [`--user-data-dir=${this.profile}`, `--remote-debugging-port=${port}`];
  }

  /** Checks 1, 2 and 3: the recorded process lives, is a Chrome on kitespan's profile and port, and is this user's. */
  ownProcess(rec: HostRecord): boolean {
    const start = startOf(this.proc, rec.pid);
    if (start === null || start !== rec.start) return false;
    if (!cmdlineCheck(this.proc.read(`/proc/${rec.pid}/cmdline`), this.wantFlags(rec.port), ["--remote-allow-origins"]).ok) return false;
    return this.o.uid < 0 || uidOf(this.proc, rec.pid) === this.o.uid;
  }

  /** Checks 4 and 5: every LISTEN row of the port is this user's, and the pid holds one of them. */
  ownListener(rec: HostRecord): boolean {
    const rows = listenRows(this.proc, rec.port);
    if (rows.length === 0 || rows.some((r) => r.uid !== this.o.uid)) return false;
    return rows.some((r) => holderOf(this.proc, r.inode, [rec.pid]) === rec.pid);
  }

  /** Check 6's first half: /json/version names a browser endpoint on 127.0.0.1 and the port. */
  private versionOk(v: VersionInfo | null, port: number): v is VersionInfo {
    return v !== null && v.wsUrl.startsWith(`ws://127.0.0.1:${port}/devtools/browser/`) && /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[A-Za-z0-9-]{1,64}$/.test(v.wsUrl);
  }

  /** Check 6's second half, on the open connection: SystemInfo.getProcessInfo's browser process is the pid. */
  private async browserPidOk(cdp: CdpLike, pid: number): Promise<boolean> {
    try {
      const info = await cdp.send<{ processInfo: { type: string; id: number }[] }>("SystemInfo.getProcessInfo", {}, undefined, 5_000);
      return info.processInfo.find((p) => p.type === "browser")?.id === pid;
    } catch {
      return false;
    }
  }

  private connectTo(wsUrl: string): Promise<CdpLike> {
    return this.o.connect ? this.o.connect(wsUrl) : CdpClient.connect(wsUrl);
  }

  private version(port: number, timeoutMs: number): Promise<VersionInfo | null> {
    return (this.o.version ?? readVersion)(port, timeoutMs);
  }

  /** The three steps of DESIGN-B1 2.3. Runs inside serial(). */
  private async begin(): Promise<void> {
    if (this.quitting) return;
    const port = this.config.port;
    this.binary = chooseBinary(this.config, this.o.env.PATH ?? "", this.o.home, this.o.uid < 0 ? null : this.o.uid);

    // 1. Adopt the Chrome that host.json names, when all six checks pass.
    const rec = await this.readRecord();
    if (rec && this.ownProcess(rec)) {
      if (rec.port === port && this.ownListener(rec)) {
        const v = await this.version(port, 5_000);
        if (this.versionOk(v, port) && (await this.connectAndAttach(rec, v, false))) return;
      }
      // kitespan's own Chrome, but on another port or not answering: stopped (checks 1 to 3 hold), then a fresh start.
      this.record = rec;
      await this.stopChrome();
    }

    // 2. The port: held by another program of this user, or of another user. Nothing is adopted, signalled or started.
    if ((this.o.portBusy ?? busyPort)(port)) {
      const rows = listenRows(this.proc, port);
      const other = rows.length > 0 && rows.some((r) => r.uid !== this.o.uid);
      this.o.log?.log("browser", { answer: other ? "port_other" : "port_own" });
      this.set({ state: other ? "port_other" : "port_own", port });
      return;
    }

    // 3. A fresh start.
    if (this.binary.path === null) {
      const reason: BrowserMissingReason = this.binary.reason;
      this.o.log?.log("browser", { answer: "missing" });
      this.set({ state: "missing", port, reason });
      return;
    }
    await this.freshStart(this.binary.path, port);
  }

  private prepareFolders(): boolean {
    for (const d of [this.dir, this.profile, this.downloads, this.tmp]) {
      try {
        mkdirSync(d, { mode: 0o700 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") return false;
      }
      const st = lstatSync(d, { throwIfNoEntry: false });
      if (!st || !st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077) !== 0 || (this.o.uid >= 0 && st.uid !== this.o.uid)) return false;
    }
    return true;
  }

  private async freshStart(binary: string, port: number): Promise<void> {
    const attempt = this.ends.length;
    this.set({ state: "starting", port, ...(attempt > 0 ? { attempt } : {}) });
    if (!this.prepareFolders()) return this.ended("start");
    // D-5: Chrome's own session restore doubles tabs; kitespan reopens its own list.
    for (const name of ["Sessions", "Sessions_Encrypted"]) {
      const p = join(this.profile, "Default", name);
      try {
        if (lstatSync(p, { throwIfNoEntry: false })) rmSync(p, { recursive: true, force: true });
      } catch {}
    }
    let out: number;
    try {
      const file = join(this.dir, "chrome-out.log");
      try {
        unlinkSync(file);
      } catch {}
      out = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch {
      return this.ended("start");
    }
    const t0 = this.now();
    let pid: number;
    try {
      pid = (this.o.spawn ?? systemSpawn)(chromeArgs(binary, port, this.profile, this.config.loopbackOnly), { env: chromeEnv(this.o.env, tmpFits(this.tmp) ? this.tmp : null, this.config.loopbackOnly), out }).pid;
    } catch {
      closeSync(out);
      this.o.log?.log("error", { err: "browser" });
      return this.ended("start");
    } finally {
      try {
        closeSync(out);
      } catch {}
    }
    const start = startOf(this.proc, pid);
    if (start === null) return this.ended("start");
    const rec: HostRecord = { v: 1, pid, start, port, binary, startedAt: new Date(this.now()).toISOString() };
    this.record = rec;
    try {
      await writeAtomic(this.dir, HOST_FILE, `${JSON.stringify(rec)}\n`, this.lim.hostFileBytes, this.o.uid);
    } catch {
      this.o.log?.log("error", { err: "browser" });
    }
    // Wait for /json/version; then checks 3 to 6 on what answers.
    let v: VersionInfo | null = null;
    const end = t0 + this.lim.startWaitMs;
    while (this.now() < end && !this.quitting) {
      if (startOf(this.proc, pid) !== start) break;
      v = await this.version(port, 1_000);
      if (v) break;
      await Bun.sleep(100);
    }
    if (!v || !this.versionOk(v, port) || !this.ownProcess(rec) || !this.ownListener(rec)) {
      // Not ours answering, or nothing: the record's process is stopped by its own checks.
      if (this.ownProcess(rec)) await this.stopChrome();
      return this.ended("start");
    }
    if (!(await this.connectAndAttach(rec, v, true, this.now() - t0))) {
      if (this.ownProcess(rec)) await this.stopChrome();
      return this.ended("start");
    }
  }

  /** Connect, check 6's second half, then the relay's attach; `running`. False when any step failed. */
  private async connectAndAttach(rec: HostRecord, v: VersionInfo, fresh: boolean, ms?: number): Promise<boolean> {
    let cdp: CdpLike;
    try {
      cdp = await this.connectTo(v.wsUrl);
    } catch {
      return false;
    }
    if (!(await this.browserPidOk(cdp, rec.pid))) {
      cdp.close();
      return false;
    }
    this.cdp = cdp;
    this.record = rec;
    cdp.onClose(() => {
      if (this.cdp !== cdp) return;
      this.cdp = null;
      this.o.detached();
      if (!this.stopping && !this.quitting) void this.serial(() => this.lost(rec));
    });
    try {
      await this.o.attach(cdp, { fresh, start: rec.start, pid: rec.pid, port: rec.port });
    } catch {
      this.cdp = null;
      cdp.close();
      this.o.detached();
      return false;
    }
    if (this.cdp !== cdp) return false;
    const version = versionNumber(v.browser);
    this.o.log?.log("browser", { answer: fresh ? "started" : "adopted", ...(ms !== undefined ? { ms } : {}) });
    this.set({ state: "running", how: fresh ? "started" : "adopted", ...(version ? { version } : {}), port: rec.port });
    return true;
  }

  /** The connection closed while running: adopt again if the process lives, else a crash. */
  private async lost(rec: HostRecord): Promise<void> {
    if (this.stopping || this.quitting || this.view.state !== "running") return;
    if (this.ownProcess(rec) && this.ownListener(rec)) {
      const v = await this.version(rec.port, 3_000);
      if (this.versionOk(v, rec.port) && (await this.connectAndAttach(rec, v, false))) return;
    }
    this.o.log?.log("browser", { answer: "exited" });
    await this.ended("crash");
  }

  /** Chrome ended or did not start: a restart after a back-off, or `crashed` at the sixth end in ten minutes. */
  private async ended(_why: "start" | "crash"): Promise<void> {
    if (this.quitting) return;
    const t = this.now();
    this.ends = [...this.ends.filter((x) => t - x < this.lim.crashWindowMs), t];
    if (this.ends.length >= this.lim.crashEnds) {
      this.o.log?.log("browser", { answer: "crashed" });
      this.set({ state: "crashed", port: this.config.port });
      return;
    }
    const attempt = this.ends.length;
    const wait = Math.min(this.lim.backoffMaxMs, this.lim.backoffFirstMs * 2 ** (attempt - 1));
    this.set({ state: "starting", port: this.config.port, attempt });
    this.clearRetry();
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.serial(async () => {
        if (this.view.state !== "starting" || this.quitting) return;
        this.config = this.readConfig();
        await this.begin();
      });
    }, wait);
    this.retry.unref?.();
  }

  /**
   * The stop order on the recorded Chrome: Browser.close; after closeWaitMs SIGTERM; after termWaitMs more SIGKILL;
   * each signal only after checks 1, 2 and 3 again. True when nothing of it runs any more (host.json then goes).
   */
  private async stopChrome(): Promise<boolean> {
    const rec = this.record ?? (await this.readRecord());
    const cdp = this.cdp;
    if (!rec && !cdp) return true;
    this.stopping = true;
    await this.o.beforeStop?.().catch(() => {});
    const before = this.view;
    if (before.state === "running" || before.state === "starting") this.set({ state: "stopping", port: before.port });
    try {
      const kill = this.o.kill ?? systemKill;
      const gone = () => !rec || startOf(this.proc, rec.pid) !== rec.start;
      if (cdp && !cdp.closed) {
        cdp.send("Browser.close", {}, undefined, this.lim.closeWaitMs).catch(() => {});
      }
      if (await this.waitGone(gone, this.lim.closeWaitMs)) return this.forget(rec);
      for (const sig of ["SIGTERM", "SIGKILL"] as const) {
        if (!rec || gone()) return this.forget(rec);
        if (!this.ownProcess(rec)) return false;
        kill(rec.pid, sig);
        if (await this.waitGone(gone, sig === "SIGTERM" ? this.lim.termWaitMs : 2_000)) return this.forget(rec);
      }
      return gone() ? this.forget(rec) : false;
    } finally {
      this.stopping = false;
      if (this.cdp === cdp && cdp) {
        this.cdp = null;
        try {
          cdp.close();
        } catch {}
        this.o.detached();
      }
    }
  }

  private async waitGone(gone: () => boolean, ms: number): Promise<boolean> {
    const end = this.now() + ms;
    while (!gone()) {
      if (this.now() >= end) return false;
      await Bun.sleep(50);
    }
    return true;
  }

  private forget(rec: HostRecord | null): true {
    if (rec) this.o.log?.log("browser", { answer: "stopped" });
    this.record = null;
    try {
      unlinkSync(join(this.dir, HOST_FILE));
    } catch {}
    return true;
  }
}

/** Empty a folder and keep it (Clear browsing data): every entry removed, links removed as links, never followed. */
export function emptyFolder(dir: string): void {
  let names: string[];
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) return;
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    try {
      rmSync(join(dir, name), { recursive: true, force: true });
    } catch {}
  }
}
