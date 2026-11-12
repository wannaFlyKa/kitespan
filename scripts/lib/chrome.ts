// Find, start and stop a headless Chrome for Testing for the click-through (DESIGN.md 8.2): its own browser on a free
// loopback port, with a throwaway profile, started without --remote-allow-origins.
import { accessSync, constants, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Cdp, sleep } from "./cdp";

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Newest first: compare the runs of digits in two paths as numbers. */
function byVersionDesc(a: string, b: string): number {
  const na = a.match(/\d+/g)?.map(Number) ?? [];
  const nb = b.match(/\d+/g)?.map(Number) ?? [];
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (nb[i] ?? -1) - (na[i] ?? -1);
    if (d) return d;
  }
  return b.localeCompare(a);
}

/** The places a Chrome for Testing usually lives: the environment, PATH, the installers' caches, the macOS apps. */
export function chromeCandidates(): string[] {
  const out: string[] = [];
  for (const v of [process.env.CHROME_PATH, process.env.CHROME_BIN]) if (v) out.push(v);
  for (const name of ["chrome", "google-chrome-for-testing", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const p = Bun.which(name);
    if (p) out.push(p);
  }
  const home = homedir();
  const caches: [string, string][] = [
    [join(home, ".cache", "puppeteer", "chrome"), "*/chrome-linux64/chrome"],
    [join(home, ".cache", "ms-playwright"), "chromium-*/chrome-linux64/chrome"],
    [join(home, ".cache", "ms-playwright"), "chromium-*/chrome-linux/chrome"],
    [join(home, ".cache", "puppeteer", "chrome"), "*/chrome-mac*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"],
    [join(home, "Library", "Caches", "ms-playwright"), "chromium-*/chrome-mac*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"],
  ];
  for (const [cwd, pattern] of caches) {
    if (!existsSync(cwd)) continue;
    const found = [...new Bun.Glob(pattern).scanSync({ cwd, onlyFiles: true, followSymlinks: true })].sort(byVersionDesc);
    out.push(...found.map((f) => join(cwd, f)));
  }
  out.push(
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  );
  return out;
}

export function findChrome(): string | null {
  return chromeCandidates().find((p) => existsSync(p) && executable(p)) ?? null;
}

/** True when nothing holds this port on 127.0.0.1 (a short bind proves it). */
export function portFree(port: number): boolean {
  try {
    const s = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    s.stop(true);
    return true;
  } catch {
    return false;
  }
}

export function freePort(from: number, to: number): number | null {
  // KITESPAN_TEST_CHROME_PORTS ("9348-9349") keeps a run's Chrome inside part of the range, beside other runs.
  const part = /^(\d+)-(\d+)$/.exec(process.env.KITESPAN_TEST_CHROME_PORTS ?? "");
  if (part) {
    from = Math.max(from, Number(part[1]));
    to = Math.min(to, Number(part[2]));
  }
  for (let p = from; p <= to; p++) if (portFree(p)) return p;
  return null;
}

export interface OwnChrome {
  port: number;
  wsUrl: string;
  pid: number;
  stop(): Promise<void>;
}

/** The proxy variables (curl's names, either case): Chrome would hand its own requests to that proxy. */
const PROXY_VARS = new Set(["http_proxy", "https_proxy", "all_proxy", "ftp_proxy", "no_proxy"]);

/** The environment Chrome starts with: the caller's, without the proxy variables. */
export function chromeEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !PROXY_VARS.has(k.toLowerCase())) out[k] = v;
  return out;
}

/** Chrome's command line: headless, DevTools on 127.0.0.1:<port>, the profile, the caller's flags, then about:blank. */
export function chromeArgs(port: number, profile: string, extraArgs: readonly string[] = []): string[] {
  return [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--noerrdialogs",
    "--disable-background-networking",
    // No host but the loopback one (DESIGN.md 8.3 check 35): every other name resolves to nothing, so neither a page nor
    // Chrome's own requests (autofill, updates, its push channel's check-in) reach the network. Without the 127.0.0.1
    // exclude Chrome cannot reach 127.0.0.1 itself. A proxy would resolve the names itself, so there is none: no proxy
    // server, and no proxy variable in Chrome's environment (chromeEnv).
    "--host-resolver-rules=MAP * ~NOTFOUND,EXCLUDE 127.0.0.1,EXCLUDE localhost",
    "--no-proxy-server",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-sync",
    "--disable-extensions",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--mute-audio",
    "--password-store=basic",
    "--use-mock-keychain",
    ...extraArgs,
    "about:blank",
  ];
}

/** Start a headless Chrome on 127.0.0.1:<port> with a new profile; resolves once its DevTools endpoint answers. */
export async function launchChrome(binary: string, port: number, opts: { timeoutMs?: number; extraArgs?: string[] } = {}): Promise<OwnChrome> {
  const timeoutMs = opts.timeoutMs ?? 60_000; // a first start on a fresh CI runner may take over 20 s (its caches)
  const profile = mkdtempSync(join(tmpdir(), "ui-check-chrome-"));
  const args = chromeArgs(port, profile, opts.extraArgs ?? []);
  const proc = Bun.spawn([binary, ...args], { stdin: "ignore", stdout: "ignore", stderr: "pipe", env: chromeEnv() });
  let stderr = "";
  (async () => {
    const reader = proc.stderr.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      stderr = (stderr + dec.decode(value)).slice(-4000);
    }
  })().catch(() => {});

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (proc.exitCode === null) {
      proc.kill("SIGTERM");
      const t0 = Date.now();
      while (proc.exitCode === null && proc.signalCode === null && Date.now() - t0 < 5000) await sleep(50);
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      await proc.exited.catch(() => {});
    }
    rmSync(profile, { recursive: true, force: true });
  };

  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      await stop();
      const tail = stderr.trim().split("\n").slice(-3).join(" | ");
      throw new Error(`Chrome exited before its DevTools port opened${tail ? `: ${tail}` : ""}`);
    }
    let wsUrl: string | undefined;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) wsUrl = ((await res.json()) as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl;
    } catch {}
    if (wsUrl) {
      // The port was free a moment ago; make sure the browser that answers is the process started here.
      const owner = await browserPid(wsUrl);
      if (owner === null || owner === proc.pid) return { port, wsUrl, pid: proc.pid, stop };
      await stop();
      throw new Error(`another browser (pid ${owner}) answers on port ${port}`);
    }
    await sleep(100);
  }
  await stop();
  throw new Error(`Chrome did not open its DevTools port ${port} in ${timeoutMs} ms`);
}

/** The browser process id behind a DevTools endpoint (SystemInfo.getProcessInfo), or null when it cannot be read. */
async function browserPid(wsUrl: string): Promise<number | null> {
  let cdp: Cdp | null = null;
  try {
    cdp = await Cdp.connect(wsUrl, { timeoutMs: 3000, requestTimeoutMs: 3000 });
    const info = await cdp.send<{ processInfo: { type: string; id: number }[] }>("SystemInfo.getProcessInfo");
    return info.processInfo.find((p) => p.type === "browser")?.id ?? null;
  } catch {
    return null;
  } finally {
    cdp?.close();
  }
}
