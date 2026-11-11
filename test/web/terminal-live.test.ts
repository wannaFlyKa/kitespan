// The page's Terminal pane code (web/terminal/link.ts and session.ts) against the server's real shell service
// (server/shell/service.ts) and a real login shell (D38, D52; BUILD-CHECKLIST D5; DESIGN.md 8.3 check 10). No claude
// runs: HOME is a temporary folder (no startup file of the user's is read), and a fake `claude` that only leaves a
// mark comes first on PATH. The socket uses 127.0.0.1 on port 7947 when it is free, else another free test port.
// - Two pages that open the pane on one chat show the same shell, and a key typed on one shows on both.
// - ?type=resume: the server types the plain command at the prompt once; nothing runs and nothing is recorded until
//   the user's Enter, which records one "shell" action and runs it.
// - A page that comes back gets the screen from the shell's replay ring; an archived chat opens no shell.
import type { Server } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newChatId } from "../../shared/ids";
import { WIRE } from "../../shared/protocol";
import type { ShellChat } from "../../server/shell/command";
import { createShellService, type ShellWsData } from "../../server/shell/service";
import { ShellLink, type ShellLinkDeps, type ShellSocketLike } from "../../web/terminal/link";
import { configureLinks, noteLines, requestType, resetSessions, sessionFor, userInput, viewHidden, viewShown, type TermSession, type TermView } from "../../web/terminal/session";
import { pickTestPort } from "../click/ports";

const T = 20_000;
const PORT = pickTestPort(7947);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SHELL = existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "kitespan-pane-test-")));
const HOME = join(ROOT, "home");
const BIN = join(ROOT, "bin");
const RAN = join(ROOT, "claude-ran");
mkdirSync(HOME);
mkdirSync(BIN);
writeFileSync(join(HOME, ".bash_profile"), "PS1='kitespan-pane$ '\n");
writeFileSync(join(HOME, ".zshrc"), "PS1='kitespan-pane%# '\n");
writeFileSync(join(BIN, "claude"), `#!/bin/sh\necho "$@" >> '${RAN}'\n`);
chmodSync(join(BIN, "claude"), 0o755);

const ENV: Record<string, string> = { HOME, ZDOTDIR: HOME, SHELL, PATH: `${BIN}:/usr/bin:/bin`, LANG: "C.UTF-8" };

const chats = new Map<string, ShellChat>();
function chat(over: Partial<ShellChat> = {}): string {
  const id = newChatId();
  const cwd = join(ROOT, `chat ${chats.size}`);
  mkdirSync(cwd);
  chats.set(id, { cwd, sessionId: null, processOpen: false, archived: false, ...over });
  return id;
}

const shells = createShellService({
  host: { chat: (id) => chats.get(id) ?? null },
  allowOrigin: (o) => o === ORIGIN,
  shell: SHELL,
  env: ENV,
  closeStepMs: 300,
});

function mount(): Server<unknown> {
  return Bun.serve<ShellWsData>({
    hostname: "127.0.0.1",
    port: PORT,
    fetch(req, server) {
      if (new URL(req.url).pathname === WIRE.shellPath) return shells.upgrade(req, server);
      return new Response(null, { status: 404 });
    },
    websocket: {
      maxPayloadLength: WIRE.maxPayloadBytes,
      open: (ws) => void shells.websocket.open(ws),
      message: (ws, m) => void shells.websocket.message(ws, m),
      drain: (ws) => void shells.websocket.drain(ws),
      close: (ws, code, reason) => void shells.websocket.close(ws, code, reason),
    },
  });
}
/** Another run of the suite may hold the port for a moment: wait for it, up to 20 s. */
async function mountWhenFree(): Promise<Server<unknown>> {
  for (let i = 0; ; i++) {
    try {
      return mount();
    } catch (e) {
      if (i >= 100) throw e;
      await Bun.sleep(200);
    }
  }
}
const server = await mountWhenFree().catch((e: unknown) => {
  rmSync(ROOT, { recursive: true, force: true });
  throw e;
});

/** The page's link dependencies, with Bun's WebSocket and the page's Origin. */
const deps = (): ShellLinkDeps => ({
  url: `ws://127.0.0.1:${PORT}${WIRE.shellPath}`,
  open: (url) => new WebSocket(url, { headers: { Origin: ORIGIN } } as unknown as string[]) as unknown as ShellSocketLike,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  random: Math.random,
});
configureLinks(deps);

/** The page's record of mutating frames (web/net/frames.ts). */
type Log = { t: string; at: number }[];
const g = globalThis as unknown as { window?: { __kitespanFrames?: Log } };
const hadWindow = "window" in g;
if (!hadWindow) g.window = {};
const log = (): Log => (g.window!.__kitespanFrames ??= []);

const others: ShellLink[] = [];
afterAll(async () => {
  resetSessions();
  configureLinks(null);
  for (const l of others) l.stop();
  await shells.closeAll();
  // Bun 1.3.14's stop(true) may not resolve once the server has closed a socket itself, so it is not awaited.
  void server.stop(true);
  rmSync(ROOT, { recursive: true, force: true });
  if (!hadWindow) delete g.window;
});

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const strip = (s: string) => s.replace(ANSI, "");
const count = (s: string, part: string) => s.split(part).length - 1;
/** A command that prints `word` while its own echo does not hold it. */
const say = (word: string) => `printf '%s%s\\n' ${word.slice(0, 2)} ${word.slice(2)}`;

async function until<T>(get: () => T | undefined | null | false, ms = 8000, what = "condition"): Promise<T> {
  const end = performance.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

/** The xterm view of one page, as plain text. */
class TextView implements TermView {
  cols = 80;
  rows = 24;
  raw = "";
  private readonly dec = new TextDecoder();
  write(data: Uint8Array | string, done?: () => void) {
    this.raw += typeof data === "string" ? data : this.dec.decode(data, { stream: true });
    done?.();
  }
  clear() {
    this.raw = "";
  }
  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
  }
  get out() {
    return strip(this.raw);
  }
}

/** Page A: the pane's session with its view, attached to the chat's shell at the prompt. */
async function pageA(id: string): Promise<{ s: TermSession; view: TextView }> {
  const s = sessionFor(id);
  const view = new TextView();
  viewShown(s, view, { cols: 100, rows: 30 });
  await until(() => s.status === "open", 8000, "page A attached");
  await until(() => count(view.out, "kitespan-pane") >= 1, 8000, "the prompt on page A");
  return { s, view };
}

/** Page B: another page's link on the same chat, with what it got. */
function pageB(id: string, cols = 80, rows = 24) {
  const got = { out: "", opened: [] as { fresh: boolean }[], sizes: [] as [number, number][] };
  const dec = new TextDecoder();
  const link = new ShellLink(id, deps(), {
    output: (b) => (got.out += dec.decode(b, { stream: true })),
    opened: (f) => got.opened.push(f),
    size: (c, r) => got.sizes.push([c, r]),
    reset: () => {},
    exit: () => {},
    typed: () => {},
    status: () => {},
  });
  others.push(link);
  link.start(cols, rows);
  return { link, got, out: () => strip(got.out) };
}

describe("the page's pane on the chat's real shell (/ws/shell)", () => {
  test("two pages on one chat show one shell: the second gets the ring, and a key typed on one shows on both", async () => {
    log().length = 0;
    const id = chat();
    const a = await pageA(id);
    const b = pageB(id);
    await until(() => b.got.opened.length === 1, 8000, "page B attached");
    expect(b.got.opened[0]!.fresh).toBe(false);
    await until(() => b.out().includes("kitespan-pane"), 8000, "the ring on page B");
    // Page B opened at 80 x 24, so it set the shell's size; page A draws at that size until its user types.
    await until(() => a.view.cols === 80 && a.view.rows === 24, 8000, "page A at page B's size");
    expect(a.s.owner).toBe(false);
    userInput(a.s, `${say("SHARED")}\r`);
    await until(() => a.view.out.includes("SHARED\r\n"), 8000, "the output on page A");
    await until(() => b.out().includes("SHARED\r\n"), 8000, "the output on page B");
    // Page A's key took the size back first: page B was told.
    expect(b.got.sizes).toContainEqual([100, 30]);
    expect([a.view.cols, a.view.rows]).toEqual([100, 30]);
    expect(log().map((f) => f.t)).toEqual(["shell"]);
    expect(shells.count).toBeGreaterThanOrEqual(1);
  }, T);

  test("?type=resume on a sleeping chat: the plain command once at the prompt, nothing runs and nothing is recorded until Enter", async () => {
    log().length = 0;
    const session = crypto.randomUUID();
    const id = chat({ sessionId: session });
    const a = await pageA(id);
    requestType(a.s, null);
    await until(() => a.s.note?.case === "plain", 8000, "the typed answer");
    const command = `claude --resume ${session}`;
    await until(() => a.view.out.includes(command), 8000, "the command at the prompt");
    await Bun.sleep(400);
    expect(count(a.view.out, command)).toBe(1);
    expect(existsSync(RAN)).toBe(false);
    expect(log()).toEqual([]);
    expect(noteLines(a.s)).toEqual([]);
    expect(a.s.said).toBe("The resume command is at the prompt. Press Enter to run it.");
    userInput(a.s, "\r");
    expect(log().map((f) => f.t)).toEqual(["shell"]);
    await until(() => existsSync(RAN), 8000, "the command to run");
  }, T);

  test("a page that comes back gets the screen from the shell's ring", async () => {
    const id = chat();
    const a = await pageA(id);
    userInput(a.s, `${say("BEFORE")}\r`);
    await until(() => a.view.out.includes("BEFORE\r\n"), 8000, "the output");
    viewHidden(a.s);
    a.s.link!.stop();
    a.view.clear();
    viewShown(a.s, a.view, { cols: 100, rows: 30 });
    await until(() => a.s.status === "open", 8000, "attached again");
    await until(() => a.view.out.includes("BEFORE\r\n"), 8000, "the ring");
    expect(count(a.view.out, "BEFORE\r\n")).toBe(1);
  }, T);

  test("an archived chat opens no shell: the pane says the server's line", async () => {
    const id = chat({ archived: true });
    const s = sessionFor(id);
    viewShown(s, new TextView(), { cols: 100, rows: 30 });
    await until(() => s.status === "refused", 8000, "the refusal");
    expect(noteLines(s)).toEqual(["This chat is archived."]);
    expect(shells.has(id)).toBe(false);
  }, T);
});
