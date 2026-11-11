// The click-through harness (DESIGN.md 8.2 to 8.4 on the real server). It writes the seed of one scene into a scratch
// folder (seed/), puts the fake claude of test/fake-claude/ first on PATH, boots bin/kitespan on a test port from 7941
// to 7949, and sends the scene's warm-up messages over its own socket, so the example chat is where the scene needs
// it (an open card, a running turn, a queued message) before any page opens. The page under test never sees those
// frames: they come from the harness's socket, not from the page's net layer. stop() ends the server by its pid,
// after a kill -0 and a /proc/<pid>/cmdline check, then a restart's successor of this boot (4.10: bin/kitespan again
// with this boot's port and page and --bind-wait), then every process that the seed's server left behind. `origins`
// allows more origins than the server's own, as the access adapter's adapters.json does (4.8): the slow-network
// proxy's, for one. `fixture` changes the fake claude's fixture for this boot (finishTurnOnStdinEnd, for one), and
// crash() is a kill -9 of the server (4.10, Signals and crashes): SIGKILL by its pid after the same checks, then
// bin/kitespan again on the same seed and port with no warm-up; what the old server left running stays. restart() is
// the same with a SIGTERM, so the server ends its chats' Claude Code itself and every chat sleeps before its next start
// (part 2's worktree-gone flow). XDG_DATA_HOME is the seed's own data folder, where kitespan keeps its records of
// worktrees in the making (row 100: the worktrees themselves go in the project's .claude/worktrees). R131: in the
// background scene the harness also starts the example chat's background session's stand-in process and writes its
// record (seed/background.ts), which `background` lets a flow change; stop() ends it by its pid.
//
// The real claude never runs: the binary pin takes the first claude on PATH, and boot() refuses to start when any
// other PATH entry holds one.
//
// As a script, it boots one scene and waits:
//   bun test/click/harness.ts [--scene main] [--port 7942] [--dist <built page> | --page <index.html>] [--keep]

import type { Subprocess } from "bun";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { tmpFits } from "../../server/browser/host";
import { FAKE_CLAUDE, type Fixture, type TraceLine } from "../fake-claude/install";
import { clickFixture } from "./seed/fixture";
import { EX } from "./seed/ids";
import { DOT_SCENES, PART2_SCENES, SCENES, SEARCH_SCENES, SEARCH_TEXT_SCENES, SIDE_SCENES, sceneOf, type SeedSceneName, type Until } from "./seed/scenes";
import { writeSeed, type SeedPaths } from "./seed/write";
import { bgFixture, startBgSeed, type BgSeed } from "./seed/background";
import { checkPort, portFree } from "./ports";

export const ROOT = resolve(import.meta.dir, "..", "..");
const BIN_KITESPAN = join(ROOT, "bin", "kitespan");
const MAIN = join(ROOT, "server", "main.ts");

export { CLICK_PORTS, FORBIDDEN_PORTS, checkPort, pickTestPort, portFree } from "./ports";
export const DEFAULT_PORT = 7942;

export interface BootOptions {
  /**
   * A scene of SCENES, or one booted by name only: SEARCH_SCENES (the v0.3 search gate's), PART2_SCENES, DOT_SCENES,
   * SIDE_SCENES (R124), SEARCH_TEXT_SCENES (U5).
   */
  scene: SeedSceneName;
  /** A port from 7941 to 7949 (default 7942). */
  port?: number;
  /** The built page (index.html and its assets). */
  dist: string;
  /** Leave the scratch folder in place after stop() (for a look at the seed or the logs). */
  keep?: boolean;
  /** How long the server and each warm-up step may take. */
  timeoutMs?: number;
  /** Origins to allow beside the server's own (exact, loopback http or https), written to the seed's adapters.json. */
  origins?: string[];
  /** v0.6 touch: the access adapter's phone link form (`access.phoneLink`, one `{url}`), written with `origins`. */
  phoneLink?: string;
  /** Fields merged over the click-through fixture for this boot (the fake claude reads them at each start). */
  fixture?: Partial<Fixture>;
  /**
   * Names added to the server's environment, for example HTTP_PROXY at a port where nothing listens (the restart's
   * loopback reads must not use it). A name that the seed sets (PATH among them, which keeps the real claude out) is
   * refused.
   */
  env?: Record<string, string>;
  /**
   * The checkout whose bin/kitespan runs (default this one): the update flows boot a scratch clone of their own
   * (test/click/scratch.ts), so that an Update runs only there, never in this checkout.
   */
  root?: string;
  /**
   * Iteration 7: the shared browser of the browser pane (DESIGN-B1 7.4): the seed's browser.json names this Chrome for
   * Testing and this debugging port (a test port from 9341 to 9349, never 9340), loopback only. The browser stays off
   * until a flow presses Start (or `enabled` writes browser.enabled into the seed's settings first).
   */
  browser?: { chrome: string; port: number; enabled?: boolean };
}

/** The names that boot() sets in the server's environment: `env` may not change them. */
const SEED_ENV_NAMES = ["PATH", "HOME", "ZDOTDIR", "CLAUDE_CONFIG_DIR", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "TMPDIR", "SHELL", "LANG"];

function checkEnv(env: Record<string, string>): void {
  for (const name of Object.keys(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`"${name}" is not an environment variable's name`);
    if (SEED_ENV_NAMES.includes(name)) throw new Error(`${name} is the seed's own; env may not set it`);
  }
}

export interface StopReport {
  /** The server's exit code (null when a signal ended it). */
  code: number | null;
  /** Processes that the server left behind and stop() ended (the fake claude, a shell): by pid. */
  leftovers: number[];
  /** A restart's successors of this boot that stop() ended, by pid. */
  successors: number[];
  ms: number;
}

export interface Booted {
  scene: SeedSceneName;
  port: number;
  base: string;
  /** The server's pid now (crash() starts a new one). */
  readonly pid: number;
  seed: SeedPaths;
  fake: ClickClaude;
  /** Milliseconds from spawn to listening, and for the warm-up. */
  timing: { bootMs: number; warmMs: number };
  /** The server's own output so far (counts and routes only, never content: server/log.ts). */
  output(): { out: string; err: string };
  /** What the fake claude saw (its trace). */
  trace(): TraceLine[];
  /** The pids of a restart's successors of this boot that run now (the server that a restart left on the port). */
  successors(): number[];
  /** A kill -9 of the server, then a new start on the same seed and port (no warm-up); its time to listen. */
  crash(): Promise<{ bootMs: number }>;
  /** A SIGTERM of the server (its exit code), then a new start on the same seed and port (no warm-up). */
  restart(): Promise<{ code: number | null; bootMs: number }>;
  stop(): Promise<StopReport>;
  /**
   * R131 (the background scene): the example chat's background session (seed/background.ts): its record, the fake's
   * list and its transcript, which a flow changes; stop() ends its stand-in process. Null in every other scene, and
   * where /proc cannot give the stand-in's start time.
   */
  background: BgSeed | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Ports and processes

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cmdline(pid: number): string[] {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

function cwdOf(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

/** Processes of this seed: their command line names the seed folder, or they run inside it. */
function seedProcesses(root: string, except: number[]): number[] {
  const out: number[] = [];
  let names: string[] = [];
  try {
    names = readdirSync("/proc");
  } catch {
    return out;
  }
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    const pid = Number(n);
    if (pid === process.pid || except.includes(pid)) continue;
    const cl = cmdline(pid);
    const cwd = cwdOf(pid);
    if (cl.some((a) => a.includes(root)) || (cwd !== null && (cwd === root || cwd.startsWith(`${root}/`)))) out.push(pid);
  }
  return out;
}

/**
 * A restart's successors of one boot (4.10): bin/kitespan's server again with that boot's port and page plus the port
 * wait. They run in the repository root with the seed's environment, so only their command line names them. `main`
 * is the booted checkout's server/main.ts.
 */
function successorsOf(port: number, dist: string, except: number[], main = MAIN): number[] {
  const out: number[] = [];
  let names: string[] = [];
  try {
    names = readdirSync("/proc");
  } catch {
    return out;
  }
  const after = (cl: string[], flag: string, value: string) => cl.some((a, i) => a === flag && cl[i + 1] === value);
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    const pid = Number(n);
    if (pid === process.pid || except.includes(pid)) continue;
    const cl = cmdline(pid);
    if (cl.includes(main) && after(cl, "--port", String(port)) && after(cl, "--dist", dist) && cl.includes("--bind-wait")) out.push(pid);
  }
  return out;
}

async function waitGone(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (alive(pid)) {
    if (Date.now() > end) return false;
    await Bun.sleep(50);
  }
  return true;
}

/** End one process of this seed: SIGTERM, then SIGHUP and SIGKILL, each after kill -0 and a fresh ownership check. */
async function endSeedProcess(pid: number, mine: (pid: number) => boolean): Promise<void> {
  for (const sig of ["SIGTERM", "SIGHUP", "SIGKILL"] as const) {
    if (!alive(pid) || !mine(pid)) return;
    try {
      process.kill(pid, sig);
    } catch {
      return;
    }
    if (await waitGone(pid, sig === "SIGKILL" ? 2_000 : 3_000)) return;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The page build

const WEB_ENTRY = join(ROOT, "web", "index.html");
const BUILD_SCRIPT = join(ROOT, "scripts", "build-web.ts");

/**
 * Build the page as `bun run build` does (production, assets under /assets/) into `out`: web/index.html through the
 * repository's own build script, or another entry (`entry`) with `bun build`.
 */
export async function buildPage(opts: { out: string; entry?: string }): Promise<{ dist: string; ms: number }> {
  const entry = resolve(opts.entry ?? WEB_ENTRY);
  if (!existsSync(entry)) throw new Error(`${entry} does not exist, so there is no page to build (pass a built folder with --dist)`);
  const t0 = Date.now();
  const cmd =
    entry === WEB_ENTRY && existsSync(BUILD_SCRIPT)
      ? [process.execPath, "--no-env-file", BUILD_SCRIPT, "--out", opts.out]
      : [process.execPath, "build", entry, "--production", "--public-path=/assets/", `--outdir=${opts.out}`];
  const proc = Bun.spawn(cmd, {
    cwd: ROOT,
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: process.env.HOME ?? tmpdir(), TMPDIR: tmpdir() },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0 || !existsSync(join(opts.out, "index.html"))) {
    const tail = `${out}\n${err}`.trim().split("\n").slice(-12).join("\n");
    throw new Error(`the page build failed (exit ${code}):\n${tail}`);
  }
  return { dist: opts.out, ms: Date.now() - t0 };
}

// ---------------------------------------------------------------------------------------------------------------
// The warm-up socket

type Frame = Record<string, any>;

class Socket {
  readonly frames: Frame[] = [];
  private constructor(private readonly ws: WebSocket) {
    ws.onmessage = (m) => {
      if (typeof m.data !== "string") return;
      try {
        this.frames.push(JSON.parse(m.data) as Frame);
      } catch {}
    };
  }

  static open(port: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const origin = `http://127.0.0.1:${port}`;
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin } });
      const s = new Socket(ws);
      const t = setTimeout(() => reject(new Error("the warm-up socket did not open")), 5_000);
      ws.onopen = () => {
        clearTimeout(t);
        resolve(s);
      };
      ws.onerror = () => {
        clearTimeout(t);
        reject(new Error("the warm-up socket did not open"));
      };
    });
  }

  send(f: Frame): void {
    this.ws.send(JSON.stringify(f));
  }

  async waitFor(pred: (f: Frame) => boolean, ms: number, what: string, from = 0): Promise<Frame> {
    const end = Date.now() + ms;
    for (;;) {
      const hit = this.frames.slice(from).find(pred);
      if (hit) return hit;
      if (Date.now() > end) {
        const seen = this.frames.slice(from).map((f) => (f.t === "ev" ? `ev:${f.e?.k}` : f.t === "ack" ? `ack:${f.ok ? "ok" : f.error?.code}` : f.t));
        throw new Error(`timed out waiting for ${what}; frames: ${seen.slice(-30).join(", ") || "none"}`);
      }
      await Bun.sleep(20);
    }
  }

  close(): void {
    try {
      this.ws.close();
    } catch {}
  }
}

const untilMatches = (u: Until, e: Frame): boolean => {
  switch (u.k) {
    case "turn_end":
      return e.k === "turn_end";
    case "card":
      return e.k === "card_open" && e.card?.id === u.id;
    case "task":
      return e.k === "task" && e.ev === "started" && e.toolUseId === u.toolUse;
    case "tool":
      return e.k === "tool_call" && e.id === u.id && e.input !== null;
    case "queued":
      return e.k === "user" && e.uuid === u.uuid && e.queued === true;
  }
};
const untilText = (u: Until): string => (u.k === "card" ? `the card ${u.id}` : u.k === "task" ? `a task for ${u.toolUse}` : u.k === "tool" ? `the tool call ${u.id}` : u.k === "queued" ? `the queued message ${u.uuid}` : "the end of the turn");

/**
 * Put the example chat (and any other chat a step names) in the scene's state: attach, send each warm-up message, wait
 * for what it must bring. The harness stands for the user who sends them with the chat open, so it says each chat is
 * on screen (row 116): a warm-up turn that ends leaves no unread dot that the scene did not ask for.
 */
async function warmUp(port: number, scene: SeedSceneName, timeoutMs: number): Promise<void> {
  const steps = sceneOf(scene).warm;
  if (!steps.length) return;
  const chats = [...new Set(steps.map((step) => step.chat ?? EX.chat))];
  const s = await Socket.open(port);
  try {
    s.send({ t: "hello", v: 1, tab: "click-harness" });
    await s.waitFor((f) => f.t === "welcome", timeoutMs, "welcome");
    for (const chat of chats) {
      const from = s.frames.length;
      s.send({ t: "attach", chat, since: 0, epoch: null });
      await s.waitFor((f) => f.t === "attached" && f.chat === chat, timeoutMs, "attached", from);
      s.send({ t: "on_screen", chat, on: true });
    }
    for (const step of steps) {
      const chat = step.chat ?? EX.chat;
      const from = s.frames.length;
      const uuid = step.uuid ?? crypto.randomUUID();
      s.send({ t: "send", rid: uuid, chat, uuid, text: step.text, draftRev: null, uploads: [] });
      const ack = await s.waitFor((f) => f.t === "ack" && f.rid === uuid, timeoutMs, `the ack of "${step.text}"`, from);
      if (!ack.ok) throw new Error(`the warm-up message "${step.text}" was refused: ${ack.error?.code}`);
      for (const u of step.until) await s.waitFor((f) => f.t === "ev" && f.chat === chat && untilMatches(u, f.e ?? {}), timeoutMs, untilText(u), from);
    }
    for (const chat of chats) s.send({ t: "detach", chat });
    await Bun.sleep(100);
  } finally {
    s.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The fake claude, installed in the seed's own scratch folder

export interface ClickClaude {
  /** The scratch folder: the seed goes in here too. */
  root: string;
  /** The folder with the `claude` script: first on the server's PATH. */
  binDir: string;
  fixturePath: string;
  tracePath: string;
  trace(): TraceLine[];
}

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/**
 * A scratch folder with `bin/claude`: a two-line sh script that runs test/fake-claude/fake-claude.ts with Bun and the
 * click-through fixture, as test/fake-claude/install.ts does, under a name that reads well in the page (the chat's
 * folder shows in the title bar and the Environment card).
 */
function installClickClaude(fixture: Fixture): ClickClaude {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kitespan-demo-")));
  const binDir = join(root, "bin");
  mkdirSync(binDir, { mode: 0o700 });
  const fixturePath = join(root, "fixture.json");
  const tracePath = join(root, "trace.jsonl");
  writeFileSync(fixturePath, JSON.stringify(fixture));
  const bin = join(binDir, "claude");
  writeFileSync(bin, `#!/bin/sh\nexec ${quote(process.execPath)} --no-env-file ${quote(FAKE_CLAUDE)} --fixture ${quote(fixturePath)} --trace ${quote(tracePath)} "$@"\n`);
  chmodSync(bin, 0o755);
  const trace = (): TraceLine[] => {
    if (!existsSync(tracePath)) return [];
    return readFileSync(tracePath, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as TraceLine);
  };
  return { root, binDir, fixturePath, tracePath, trace };
}

// ---------------------------------------------------------------------------------------------------------------
// Boot and stop

const SHELL = existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";

/** Boot bin/kitespan on the seed of one scene. */
export async function boot(opts: BootOptions): Promise<Booted> {
  const port = opts.port ?? DEFAULT_PORT;
  checkPort(port);
  checkEnv(opts.env ?? {});
  const timeoutMs = opts.timeoutMs ?? 20_000;
  if (!existsSync(join(opts.dist, "index.html"))) throw new Error(`${opts.dist} holds no built page (index.html)`);
  for (let i = 0; !portFree(port); i++) {
    // A server this harness stopped a moment ago may still hold the port for a few milliseconds.
    if (i >= 40) throw new Error(`port ${port} is in use; the harness never stops a process it did not start`);
    await Bun.sleep(50);
  }

  const fake = installClickClaude({ ...clickFixture(), ...opts.fixture });
  let seed: SeedPaths;
  try {
    seed = writeSeed(fake.root, opts.scene);
  } catch (e) {
    rmSync(fake.root, { recursive: true, force: true });
    throw e;
  }
  // R131: the background scene's worker: the fake's agents list (it needs the seed's folders), then the stand-in
  // process and its busy record, before the server's first look at the registry.
  let background: BgSeed | null = null;
  if (sceneOf(opts.scene).bg) {
    writeFileSync(fake.fixturePath, JSON.stringify({ ...clickFixture(), ...bgFixture(seed), ...opts.fixture }));
    background = startBgSeed(seed, fake.fixturePath);
  }
  /** The shared browser's short TMPDIR, when this boot made one (below). */
  let ownTmp: string | null = null;
  const cleanup = () => {
    background?.stop();
    if (opts.keep) return;
    rmSync(seed.root, { recursive: true, force: true });
    if (ownTmp) rmSync(ownTmp, { recursive: true, force: true });
  };
  // The server's TMPDIR: the seed's own, but see the shared browser's below.
  let serverTmp = seed.tmp;
  if (opts.browser) {
    const { chrome, port: cdp } = opts.browser;
    if (!Number.isInteger(cdp) || cdp < 9341 || cdp > 9349) {
      cleanup();
      throw new Error(`the shared browser's port ${cdp} is not a test port from 9341 to 9349`);
    }
    // Chrome's singleton socket goes under the first of <state>/browser/tmp and the server's TMPDIR that leaves it room
    // (server/browser/host.ts tmpFits). The seed sits deep under the caller's TMPDIR, so when neither of its folders
    // fits, the server gets a short folder of this boot's own beside the seed, k and the port's last digit (two boots
    // never share a port), removed with the seed; when even that name does not fit, the caller's own TMPDIR (a run
    // keeps that one short). Never the system's /tmp.
    if (!tmpFits(join(seed.state, "browser", "tmp")) && !tmpFits(seed.tmp)) {
      const outer = realpathSync(tmpdir());
      const short = join(outer, `k${port % 10}`);
      if (tmpFits(short)) {
        try {
          mkdirSync(short, { mode: 0o700 });
        } catch {}
        const st = lstatSync(short, { throwIfNoEntry: false });
        if (st?.isDirectory() && !st.isSymbolicLink() && st.uid === process.getuid?.() && (st.mode & 0o077) === 0) {
          ownTmp = short;
          serverTmp = short;
        }
      }
      if (!ownTmp) {
        if (!tmpFits(outer)) {
          cleanup();
          throw new Error(`TMPDIR ${outer} is too long for the shared browser's socket (62 bytes at most, as its real path)`);
        }
        serverTmp = outer;
      }
    }
    const dir = join(seed.configHome, "kitespan");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "browser.json"), JSON.stringify({ v: 1, chrome, port: cdp, loopbackOnly: true }) + "\n", { mode: 0o600 });
    if (opts.browser.enabled) {
      const file = join(seed.state, "settings.json");
      const now = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
      writeFileSync(file, JSON.stringify({ ...now, "browser.enabled": true }) + "\n", { mode: 0o600 });
    }
  }
  if (opts.origins?.length || opts.phoneLink) {
    // The access adapter's file (4.8): a regular file of this user that no one else can write.
    const dir = join(seed.configHome, "kitespan");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const access = { ...(opts.origins?.length ? { origins: opts.origins } : {}), ...(opts.phoneLink ? { phoneLink: opts.phoneLink } : {}) };
    writeFileSync(join(dir, "adapters.json"), JSON.stringify({ v: 1, access }) + "\n", { mode: 0o600 });
  }

  // The fake claude first on PATH; Bun's folder for bin/kitespan; the system folders for sh, git and the shell.
  const pathDirs = [fake.binDir, dirname(process.execPath), "/usr/bin", "/bin"];
  for (const d of pathDirs.slice(1)) {
    if (existsSync(join(d, "claude"))) {
      cleanup();
      throw new Error(`${d} holds a claude, so the seed's PATH could reach it; the harness runs only the fake claude`);
    }
  }
  const env: Record<string, string> = {
    ...opts.env,
    PATH: pathDirs.join(":"),
    HOME: seed.home,
    ZDOTDIR: seed.home,
    CLAUDE_CONFIG_DIR: seed.claudeConfig,
    XDG_STATE_HOME: seed.stateHome,
    XDG_CONFIG_HOME: seed.configHome,
    XDG_DATA_HOME: seed.data,
    TMPDIR: serverTmp,
    SHELL,
    LANG: "C.UTF-8",
  };

  const log = { out: "", err: "" };
  const read = async (s: ReadableStream<Uint8Array>, key: "out" | "err") => {
    const dec = new TextDecoder();
    for await (const c of s) log[key] = (log[key] + dec.decode(c, { stream: true })).slice(-200_000);
  };
  const binKitespan = opts.root ? join(resolve(opts.root), "bin", "kitespan") : BIN_KITESPAN;
  const main = opts.root ? join(resolve(opts.root), "server", "main.ts") : MAIN;
  const spawn = () => {
    const p = Bun.spawn([binKitespan, "--port", String(port), "--dist", opts.dist], { cwd: seed.root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    void read(p.stdout, "out").catch(() => {});
    void read(p.stderr, "err").catch(() => {});
    return p;
  };
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  let proc: Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = spawn();
  } catch (e) {
    cleanup();
    throw e;
  }
  /** The servers this boot started and that are gone (a crash), so stop() counts none of them as a leftover. */
  const past: number[] = [];
  // Our server only: bun running server/main.ts on this port, the process this harness spawned.
  const ours = (p: number) => {
    const cl = cmdline(p);
    return cl.includes(main) && cl.includes(String(port));
  };
  /** Wait until the server that runs now says it listens (its line after `from` in the output). */
  const listening = async (from: number) => {
    const end = Date.now() + timeoutMs;
    while (!log.out.slice(from).includes(`kitespan listens on ${base}`)) {
      if (proc.exitCode !== null) throw new Error(`the server exited (code ${proc.exitCode}) before it listened: ${log.err.trim().split("\n").slice(-6).join(" | ")}`);
      if (Date.now() > end) throw new Error(`the server did not listen on ${base} in ${timeoutMs} ms: ${log.err.trim().split("\n").slice(-6).join(" | ")}`);
      await Bun.sleep(25);
    }
  };

  let stopped: Promise<StopReport> | null = null;
  const stop = (): Promise<StopReport> => {
    if (stopped) return stopped;
    stopped = (async () => {
      const s0 = Date.now();
      const pid = proc.pid;
      if (proc.exitCode === null && alive(pid) && ours(pid)) {
        process.kill(pid, "SIGTERM");
        if (!(await waitGone(pid, 15_000)) && alive(pid) && ours(pid)) process.kill(pid, "SIGKILL");
      }
      const code = await proc.exited;
      // A restart left its successor on the port: the same check, SIGTERM, then SIGKILL after 15 s.
      const successors = successorsOf(port, opts.dist, [pid, ...past], main);
      for (const p of successors) {
        const still = (x: number) => successorsOf(port, opts.dist, [pid, ...past], main).includes(x);
        if (!alive(p) || !still(p)) continue;
        try {
          process.kill(p, "SIGTERM");
          if (!(await waitGone(p, 15_000)) && alive(p) && still(p)) process.kill(p, "SIGKILL");
        } catch {
          // gone already
        }
        await waitGone(p, 2_000);
      }
      const leftovers = seedProcesses(seed.root, [pid, ...past]);
      const mine = (p: number) => seedProcesses(seed.root, [pid, ...past]).includes(p);
      for (const p of leftovers) await endSeedProcess(p, mine);
      cleanup();
      return { code, leftovers, successors, ms: Date.now() - s0 };
    })();
    return stopped;
  };

  const crash = async (): Promise<{ bootMs: number }> => {
    if (stopped) throw new Error("the server was stopped");
    const old = proc;
    if (old.exitCode === null && alive(old.pid) && ours(old.pid)) process.kill(old.pid, "SIGKILL");
    await old.exited;
    past.push(old.pid);
    for (let i = 0; !portFree(port); i++) {
      if (i >= 100) throw new Error(`port ${port} is still in use after the kill -9`);
      await Bun.sleep(50);
    }
    const c0 = Date.now();
    const from = log.out.length;
    proc = spawn();
    await listening(from);
    return { bootMs: Date.now() - c0 };
  };

  const restart = async (): Promise<{ code: number | null; bootMs: number }> => {
    if (stopped) throw new Error("the server was stopped");
    const old = proc;
    if (old.exitCode === null && alive(old.pid) && ours(old.pid)) {
      process.kill(old.pid, "SIGTERM");
      if (!(await waitGone(old.pid, 15_000)) && alive(old.pid) && ours(old.pid)) process.kill(old.pid, "SIGKILL");
    }
    const code = await old.exited;
    past.push(old.pid);
    for (let i = 0; !portFree(port); i++) {
      if (i >= 100) throw new Error(`port ${port} is still in use after the server stopped`);
      await Bun.sleep(50);
    }
    const c0 = Date.now();
    const from = log.out.length;
    proc = spawn();
    await listening(from);
    return { code, bootMs: Date.now() - c0 };
  };

  try {
    await listening(0);
    const bootMs = Date.now() - t0;
    const w0 = Date.now();
    await warmUp(port, opts.scene, timeoutMs);
    return {
      scene: opts.scene,
      port,
      base,
      get pid() {
        return proc.pid;
      },
      seed,
      fake,
      timing: { bootMs, warmMs: Date.now() - w0 },
      output: () => ({ ...log }),
      trace: () => fake.trace(),
      successors: () => successorsOf(port, opts.dist, [proc.pid, ...past], main),
      crash,
      restart,
      stop,
      background,
    };
  } catch (e) {
    await stop().catch(() => {});
    const err = e as Error;
    err.message = `scene ${opts.scene}: ${err.message}`;
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// As a script: boot one scene and wait for Ctrl+C

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opt = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const scene = (opt("--scene") ?? "main") as SeedSceneName;
  const known: readonly string[] = [...SCENES, ...SEARCH_SCENES, ...PART2_SCENES, ...DOT_SCENES, ...SIDE_SCENES, ...SEARCH_TEXT_SCENES];
  if (!known.includes(scene)) {
    console.error(`harness: unknown scene ${scene}; the scenes are ${known.join(", ")}`);
    process.exit(2);
  }
  const port = Number(opt("--port") ?? DEFAULT_PORT);
  let dist = opt("--dist");
  let built: string | null = null;
  try {
    if (!dist) {
      built = mkdtempSync(join(tmpdir(), "kitespan-click-page-"));
      const b = await buildPage({ out: built, entry: opt("--page") });
      dist = b.dist;
      console.log(`harness: built the page in ${b.ms} ms`);
    } else if (!statSync(dist).isDirectory()) throw new Error(`${dist} is not a folder`);
    const h = await boot({ scene, port, dist, keep: argv.includes("--keep") });
    console.log(`harness: scene ${scene} (${sceneOf(scene).about}) on ${h.base}, pid ${h.pid}; boot ${h.timing.bootMs} ms, warm-up ${h.timing.warmMs} ms`);
    console.log(`harness: the seed is in ${h.seed.root}; Ctrl+C stops the server`);
    const end = async () => {
      const r = await h.stop();
      if (built) rmSync(built, { recursive: true, force: true });
      console.log(`harness: stopped (exit ${r.code}; ${r.leftovers.length} leftover process(es) ended)`);
      process.exit(0);
    };
    process.on("SIGINT", () => void end());
    process.on("SIGTERM", () => void end());
  } catch (e) {
    if (built) rmSync(built, { recursive: true, force: true });
    console.error(`harness: ${(e as Error).message}`);
    process.exit(1);
  }
}
