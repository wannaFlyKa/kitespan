// The Terminal pane's shell with a real login shell (D38, D52; BUILD-CHECKLIST D2 to D5; R-pty, V-pty). No claude
// runs: HOME is a temporary folder (so no startup file of the user's is read), a fake `claude` that only leaves a
// mark comes first on PATH, and the tests that press Enter on the typed command define `claude` as a shell function
// first. Each server binds port 0 of 127.0.0.1, so the system picks a free port.
import type { Server, ServerWebSocket } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newChatId } from "../../shared/ids";
import { readEnv } from "../../shared/legacy";
import { SHELL_LIMITS, WIRE, shellQuote } from "../../shared/protocol";
import type { ShellChat } from "../../server/shell/command";
import { shellEnv } from "../../server/shell/env";
import { ShellPty, type ShellExit } from "../../server/shell/pty";
import { createShellService, type ShellOutFrame, type ShellService, type ShellSocket, type ShellWsData } from "../../server/shell/service";
import { LINUX_ONLY, PROCFS } from "../linux";

const T = 20_000;
/** The main server's port and origin, set once it listens. */
let PORT = 0;
let ORIGIN = "";
const originOf = (port: number) => `http://127.0.0.1:${port}`;
/** zsh where it exists, else bash; KITESPAN_TEST_SHELL (or its old name, one release) picks another: /bin/bash. */
const SHELL = readEnv(process.env, "KITESPAN_TEST_SHELL", (l) => void process.stderr.write(`${l}\n`)) ?? (existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/bash");

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "kitespan-shell-test-")));
const HOME = join(ROOT, "home");
const BIN = join(ROOT, "bin");
const RAN = join(ROOT, "claude-ran");
mkdirSync(HOME);
mkdirSync(BIN);
writeFileSync(join(HOME, ".zshrc"), "PS1='kitespan-test%# '\n");
writeFileSync(join(HOME, ".bash_profile"), "PS1='kitespan-test$ '\n");
writeFileSync(join(BIN, "claude"), `#!/bin/sh\necho ran >> '${RAN}'\n`);
chmodSync(join(BIN, "claude"), 0o755);

const ENV: Record<string, string | undefined> = {
  ...process.env,
  HOME,
  ZDOTDIR: HOME,
  SHELL,
  PATH: `${BIN}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  // Planted: the shell must not see these.
  CLAUDECODE: "1",
  CLAUDE_CODE_SESSION_ID: crypto.randomUUID(),
  KITESPANTEST_OTHERAPP_ID: "7",
};

const chats = new Map<string, ShellChat>();
function chat(over: Partial<ShellChat> = {}): string {
  const id = newChatId();
  const cwd = join(ROOT, `chat folder ${chats.size}`);
  mkdirSync(cwd);
  chats.set(id, { cwd, sessionId: null, processOpen: false, archived: false, ...over });
  return id;
}
const cwdOf = (id: string) => chats.get(id)!.cwd;

/** R127: the refused rows that the server matched, by chat and tool use: the folder each one names. */
const trustRows = new Map<string, string>();
/** R131: the background sessions that each chat's launch rows printed (the book), as `<chat> <id>`. */
const bgBook = new Set<string>();
const services: ShellService[] = [];
function service(over: Partial<Parameters<typeof createShellService>[0]> = {}): ShellService {
  const s = createShellService({
    host: { chat: (id) => chats.get(id) ?? null, trustPath: (id, toolUse) => trustRows.get(`${id} ${toolUse}`) ?? null, backgroundId: (id, bg) => bgBook.has(`${id} ${bg}`) },
    allowOrigin: (o) => o === ORIGIN,
    shell: SHELL,
    env: ENV,
    dropPrefixes: ["KITESPANTEST_OTHERAPP_"],
    closeStepMs: 300,
    ...over,
  });
  services.push(s);
  return s;
}

const shells = service();

// The service's own form: `upgrade()` in fetch (it runs the Origin check), the four handlers in websocket.
const mount = (svc: ShellService): Server<unknown> =>
  Bun.serve<ShellWsData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      if (new URL(req.url).pathname === WIRE.shellPath) return svc.upgrade(req, server);
      return new Response(null, { status: 404 });
    },
    websocket: {
      maxPayloadLength: WIRE.maxPayloadBytes,
      open: (ws) => void svc.websocket.open(ws),
      message: (ws, m) => void svc.websocket.message(ws, m),
      drain: (ws) => void svc.websocket.drain(ws),
      close: (ws, code, reason) => void svc.websocket.close(ws, code, reason),
    },
  });
const server = (() => {
  try {
    return mount(shells);
  } catch (e) {
    rmSync(ROOT, { recursive: true, force: true });
    throw e;
  }
})();
PORT = server.port!;
ORIGIN = originOf(PORT);

const clients: Client[] = [];
afterAll(async () => {
  for (const c of clients) c.close();
  await Promise.all(services.map((s) => s.closeAll()));
  // Bun 1.3.14's stop(true) may not resolve once the server has closed a socket itself, so it is not awaited.
  void server.stop(true);
  rmSync(ROOT, { recursive: true, force: true });
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

type Ev = { text: ShellOutFrame } | { bin: number };

class Client {
  readonly events: Ev[] = [];
  raw = "";
  bin = 0;
  closed = false;
  private readonly dec = new TextDecoder();

  private constructor(readonly ws: WebSocket) {
    ws.binaryType = "arraybuffer";
    ws.onmessage = (e) => {
      if (typeof e.data === "string") this.events.push({ text: JSON.parse(e.data) as ShellOutFrame });
      else {
        const b = new Uint8Array(e.data as ArrayBuffer);
        this.bin += b.length;
        this.raw += this.dec.decode(b, { stream: true });
        this.events.push({ bin: b.length });
      }
    };
    ws.onclose = () => (this.closed = true);
  }

  static connect(port = PORT, origin = ORIGIN): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${WIRE.shellPath}`, { headers: { Origin: origin } } as unknown as string[]);
      const c = new Client(ws);
      ws.onopen = () => (clients.push(c), resolve(c));
      ws.onerror = () => reject(new Error("no socket"));
    });
  }

  get out(): string {
    return strip(this.raw);
  }

  frames<K extends ShellOutFrame["t"]>(t: K): Extract<ShellOutFrame, { t: K }>[] {
    return this.events.flatMap((e) => ("text" in e && e.text.t === t ? [e.text as Extract<ShellOutFrame, { t: K }>] : []));
  }

  frame<K extends ShellOutFrame["t"]>(t: K, n = 1, ms = 8000): Promise<Extract<ShellOutFrame, { t: K }>> {
    return until(() => this.frames(t)[n - 1], ms, `frame ${t}`);
  }

  control(f: unknown): void {
    this.ws.send(typeof f === "string" ? f : JSON.stringify(f));
  }

  keys(s: string | Uint8Array): void {
    this.ws.send(typeof s === "string" ? new TextEncoder().encode(s) : s);
  }

  async open(chatId: string, cols = 200, rows = 40) {
    const n = this.frames("opened").length;
    this.control({ t: "open", chat: chatId, cols, rows });
    return this.frame("opened", n + 1);
  }

  /** Wait until the ANSI-stripped output matches. */
  see(re: RegExp | string, ms = 8000): Promise<string> {
    return until(() => {
      const out = this.out;
      return (typeof re === "string" ? out.includes(re) : re.test(out)) && out;
    }, ms, `output ${String(re)}`);
  }

  prompt(n = 1, ms = 8000): Promise<string> {
    return until(() => count(this.out, "kitespan-test") >= n && this.out, ms, "the prompt");
  }

  close(): void {
    if (!this.closed) this.ws.close();
  }
}

function ptmxCount(): number {
  let n = 0;
  for (const fd of readdirSync("/proc/self/fd")) {
    try {
      if (readlinkSync(`/proc/self/fd/${fd}`) === "/dev/ptmx") n++;
    } catch {
      // closed while listing
    }
  }
  return n;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("a chat's shell over /ws/shell", () => {
  test("the first page starts a login shell in the chat's folder, with TERM set and the environment clean (D2)", async () => {
    const id = chat();
    const c = await Client.connect();
    const opened = await c.open(id);
    expect(opened).toEqual({ t: "opened", chat: id, cols: 200, rows: 40, fresh: true });
    await c.prompt();
    c.keys(`${say("PWDIS")}; pwd; printf 'T%sM=' ER; printenv TERM; printf 'EN%s:%s:%s:%s\\n' V "\${CLAUDECODE+set}" "\${CLAUDE_CODE_SESSION_ID+set}" "\${KITESPANTEST_OTHERAPP_ID+set}"; tty\r`);
    // tty names the pane's terminal: /dev/pts/<n> on Linux, /dev/ttys<nnn> on macOS.
    const out = await c.see(/\r\n\/dev\/(?:pts\/\d+|ttys\d+)\r\n/);
    expect(out).toContain(`PWDIS\r\n${cwdOf(id)}\r\n`);
    expect(out).toContain("TERM=xterm-256color\r\n");
    expect(out).toContain("ENV:::\r\n");
    expect(shells.has(id)).toBe(true);
  }, T);

  test("the environment is taken once, when the service is made: what the server's process.env gets later never reaches a pane (D2)", async () => {
    // The SDK's query() sets CLAUDE_AGENT_SDK_VERSION on the server's own process.env at each chat start.
    const names = ["HOME", "ZDOTDIR", "CLAUDE_AGENT_SDK_VERSION", "KITESPANTEST_LATE"];
    const saved = new Map(names.map((n) => [n, process.env[n]]));
    const put = (n: string, v: string | undefined) => {
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    };
    try {
      put("HOME", HOME);
      put("ZDOTDIR", HOME);
      put("CLAUDE_AGENT_SDK_VERSION", undefined);
      put("KITESPANTEST_LATE", undefined);
      // The server's own process.env itself (the default is the start environment, D60's E4): the copy is taken now.
      const svc = createShellService({ host: { chat: (id) => chats.get(id) ?? null }, allowOrigin: (o) => o === ORIGIN, shell: SHELL, env: process.env, closeStepMs: 300 });
      services.push(svc);
      put("CLAUDE_AGENT_SDK_VERSION", "0.3.322");
      put("KITESPANTEST_LATE", "1");
      const id = chat();
      const ws = fakeSocket(svc);
      svc.websocket.message(ws, JSON.stringify({ t: "open", chat: id, cols: 200, rows: 40 }));
      await until(() => ws.out.includes("kitespan-test"), 8000, "the prompt");
      svc.websocket.message(ws, new TextEncoder().encode(`printf 'LA%s:%s:%s\\n' TE "\${CLAUDE_AGENT_SDK_VERSION+set}" "\${KITESPANTEST_LATE+set}"\r`));
      const out = await until(() => /LATE:\w*:\w*\r\n/.test(ws.out) && ws.out, 4000, "LATE");
      expect(out).toContain("LATE::\r\n");
      await svc.closeAll();
    } finally {
      for (const [n, v] of saved) put(n, v);
    }
  }, T);

  test("keys echo and run; a resize changes stty size, and the other page gets the size (D4)", async () => {
    const id = chat();
    const a = await Client.connect();
    const b = await Client.connect();
    await a.open(id, 80, 24);
    await a.prompt();
    expect((await b.open(id, 80, 24)).fresh).toBe(false);
    a.keys(`${say("SIZEA")}; stty size\r`);
    await a.see(/SIZEA\r\n24 80\r\n/);
    a.control({ t: "resize", cols: 100, rows: 30 });
    expect(await b.frame("size")).toEqual({ t: "size", cols: 100, rows: 30 });
    expect(a.frames("size")).toEqual([]);
    a.keys(`${say("SIZEB")}; stty size\r`);
    await a.see(/SIZEB\r\n30 100\r\n/);
    await b.see(/SIZEB\r\n30 100\r\n/);
  }, T);

  test("Ctrl+C is byte 3: it stops the foreground job (D4)", async () => {
    const id = chat();
    const c = await Client.connect();
    await c.open(id);
    await c.prompt();
    const t0 = performance.now();
    c.keys("sleep 5\r");
    await Bun.sleep(400);
    c.keys(new Uint8Array([3]));
    c.keys(`printf 'R%sC=%s\\n' C "$?"\r`);
    await c.see("RCC=130", 4000);
    expect(performance.now() - t0).toBeLessThan(5000);
  }, T);

  test("the exit status comes from the shell, and the next open starts a new shell (D3)", async () => {
    const id = chat();
    const c = await Client.connect();
    await c.open(id);
    await c.prompt();
    c.keys("exit 7\r");
    expect(await c.frame("exit")).toEqual({ t: "exit", code: 7, signal: null });
    expect(shells.has(id)).toBe(false);
    expect((await c.open(id)).fresh).toBe(true);
    await c.prompt(2);
    c.keys("exit\r");
    expect(await c.frame("exit", 2)).toEqual({ t: "exit", code: 0, signal: null });
  }, T);

  test("two pages share one shell: each sees the output of the other's keys (D52)", async () => {
    const id = chat();
    const a = await Client.connect();
    const b = await Client.connect();
    expect((await a.open(id)).fresh).toBe(true);
    expect((await b.open(id)).fresh).toBe(false);
    await a.prompt();
    b.keys(`${say("FROMB")}\r`);
    await a.see("FROMB\r\n");
    await b.see("FROMB\r\n");
    a.keys(`${say("FROMA")}\r`);
    await a.see("FROMA\r\n");
    await b.see("FROMA\r\n");
  }, T);

  test("a closed pane leaves the shell running; a page that attaches gets opened, then the ring of at most 256 KiB (D52)", async () => {
    const id = chat();
    const a = await Client.connect();
    await a.open(id);
    await a.prompt();
    a.keys(`${say("RINGA")}\r`);
    await a.see("RINGA\r\n");
    a.close();
    await until(() => a.closed, 4000, "the close");
    await Bun.sleep(100);
    expect(shells.has(id)).toBe(true);

    const b = await Client.connect();
    expect((await b.open(id)).fresh).toBe(false);
    await b.see("RINGA\r\n", 2000);
    const firstBin = b.events.findIndex((e) => "bin" in e);
    const opened = b.events.findIndex((e) => "text" in e && e.text.t === "opened");
    expect(opened).toBeGreaterThanOrEqual(0);
    expect(firstBin).toBeGreaterThan(opened);

    b.keys(`head -c 400000 /dev/zero | tr '\\0' Z; printf '\\n'; ${say("RINGEND")}\r`);
    await b.see("RINGEND\r\n", 10_000);
    await Bun.sleep(200);
    const c = await Client.connect();
    await c.open(id);
    await c.see("RINGEND\r\n", 2000);
    await Bun.sleep(300);
    expect(c.bin).toBeLessThanOrEqual(SHELL_LIMITS.ringBytes);
    expect(c.bin).toBeGreaterThan(200 * 1024);
    expect(c.out).not.toContain("RINGA");
  }, T);

  test("a 1 MB burst arrives complete and in order (D4)", async () => {
    const id = chat();
    const c = await Client.connect();
    await c.open(id);
    await c.prompt();
    c.keys(`${say("BURSTBEGIN")}; head -c 1000000 /dev/zero | tr '\\0' Z; printf '\\n%s%s\\n' BU RSTEND\r`);
    await c.see("BURSTEND\r\n", 15_000);
    const raw = c.raw;
    const from = raw.indexOf("BURSTBEGIN\r\n") + "BURSTBEGIN\r\n".length;
    const to = raw.indexOf("\r\nBURSTEND");
    const body = raw.slice(from, to);
    expect(body.length).toBe(1_000_000);
    expect(/^Z+$/.test(body)).toBe(true);
  }, T);

  test("refused frames get an error and leave the socket usable", async () => {
    const id = chat();
    const archived = chat({ archived: true });
    const c = await Client.connect();
    c.keys("x");
    c.control("not json");
    c.control({ t: "type_resume" });
    c.control({ t: "open", chat: newChatId(), cols: 80, rows: 24 });
    c.control({ t: "open", chat: archived, cols: 80, rows: 24 });
    c.control({ t: "open", chat: id, cols: 0, rows: 24 });
    await c.frame("error", 6);
    expect(c.frames("error").map((e) => e.code)).toEqual(["bad_request", "bad_request", "bad_request", "not_found", "archived", "bad_request"]);
    expect(c.frames("error").every((e) => typeof e.message === "string" && e.message.length > 0)).toBe(true);
    expect(shells.has(archived)).toBe(false);
    await c.open(id);
    c.control({ t: "open", chat: id, cols: 80, rows: 24 });
    c.keys(new Uint8Array(SHELL_LIMITS.inputFrameBytes + 1).fill(0x41));
    await c.frame("error", 8);
    expect(c.frames("error").slice(6).map((e) => e.code)).toEqual(["bad_request", "bad_request"]);
    await c.prompt();
    c.keys(`${say("STILLOK")}\r`);
    await c.see("STILLOK\r\n");
    expect(c.out).not.toContain("AAAA");
  }, T);

  test("a foreign Origin gets 403 on a real upgrade; the own origin opens (4.9 guard 2)", async () => {
    let originB = "";
    const other = service({ allowOrigin: (o) => o === originB });
    const srv = mount(other);
    const PORT_B = srv.port!;
    originB = originOf(PORT_B);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT_B}${WIRE.shellPath}`, {
        headers: { Origin: "http://evil.example", Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" },
      });
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("");
      await expect(Client.connect(PORT_B, ORIGIN)).rejects.toThrow("no socket");
      const ok = await Client.connect(PORT_B, originB);
      const id = chat();
      expect((await ok.open(id)).fresh).toBe(true);
      ok.close();
    } finally {
      await other.closeAll();
      void srv.stop(true);
    }
  }, T);
});

/** The HTTP layer's per-path socket data and handlers, as its route table declares them (copied, not imported). */
type RouteData = { route: "/ws" | "/ws/shell"; state: unknown };
interface RouteHandlers {
  open(ws: ServerWebSocket<RouteData>): void | Promise<void>;
  message(ws: ServerWebSocket<RouteData>, message: string | Buffer): void | Promise<void>;
  close(ws: ServerWebSocket<RouteData>, code: number, reason: string): void | Promise<void>;
  drain?(ws: ServerWebSocket<RouteData>): void | Promise<void>;
}

describe("mounted by a router with a state slot (the HTTP layer's form)", () => {
  test("the router upgrades after its own Origin check; the slot handlers run the shell", async () => {
    const routed: RouteHandlers = shells.handlers;
    let originB = "";
    const srv = Bun.serve<RouteData>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, server) {
        if (new URL(req.url).pathname !== WIRE.shellPath) return new Response(null, { status: 404 });
        if (req.headers.get("origin") !== originB) return new Response(null, { status: 403 });
        if (server.upgrade(req, { data: { route: "/ws/shell", state: null } })) return undefined;
        return new Response(null, { status: 426 });
      },
      websocket: {
        open: (ws) => void routed.open(ws),
        message: (ws, m) => void routed.message(ws, m),
        close: (ws, code, reason) => void routed.close(ws, code, reason),
        drain: (ws) => void routed.drain?.(ws),
      },
    });
    const PORT_B = srv.port!;
    originB = originOf(PORT_B);
    try {
      const id = chat();
      const a = await Client.connect(PORT_B, originB);
      const b = await Client.connect(PORT_B, originB);
      expect((await a.open(id)).fresh).toBe(true);
      expect((await b.open(id)).fresh).toBe(false);
      await a.prompt();
      a.keys(`${say("ROUTED")}\r`);
      await b.see("ROUTED\r\n");
      a.close();
      await until(() => a.closed, 4000, "the close");
      b.keys("exit 3\r");
      expect(await b.frame("exit")).toEqual({ t: "exit", code: 3, signal: null });
    } finally {
      void srv.stop(true);
    }
  }, T);
});

describe("R127: Open in terminal on a refused folder, type_trust", () => {
  test("it types cd <the folder that the server matched> && claude at the free prompt, never Enter; Enter runs it there", async () => {
    const id = chat();
    const folder = join(ROOT, `it's the task ${chats.size}`);
    mkdirSync(folder);
    trustRows.set(`${id} toolu_bg1`, folder);
    const c = await Client.connect();
    await c.open(id);
    await c.prompt();
    c.keys(`claude() { printf 'CL%sDE-ARGS:%s|%s\\n' AU "$*" "$PWD"; }; ${say("DEFOK")}\r`);
    await c.see("DEFOK\r\n");
    c.control({ t: "type_trust", toolUse: "toolu_bg1" });
    expect(await c.frame("typed")).toEqual({ t: "typed", case: "trust" });
    await c.see("&& claude");
    await Bun.sleep(400);
    expect(c.out).not.toContain("CLAUDE-ARGS");
    expect(c.out).toContain(`cd ${shellQuote(folder)} && claude`);
    c.keys("\r");
    await c.see(`CLAUDE-ARGS:|${folder}\r\n`);
    expect(existsSync(RAN)).toBe(false);
  }, T);

  test("a tool use with no refused row, or a chat archived meanwhile, types nothing: none", async () => {
    const id = chat();
    const c = await Client.connect();
    await c.open(id);
    await c.prompt();
    c.control({ t: "type_trust", toolUse: "toolu_none" });
    expect(await c.frame("typed")).toEqual({ t: "typed", case: "none" });
    trustRows.set(`${id} toolu_bg2`, ROOT);
    chats.get(id)!.archived = true;
    c.control({ t: "type_trust", toolUse: "toolu_bg2" });
    expect(await c.frame("typed", 2)).toEqual({ t: "typed", case: "none" });
    await Bun.sleep(300);
    expect(c.out).not.toContain("&& claude");
  }, T);

  test("a tool use that is not an agent id is a bad request, and types nothing", async () => {
    const id = chat();
    const c = await Client.connect();
    await c.open(id);
    c.control({ t: "type_trust", toolUse: "toolu bad; rm" });
    expect(await c.frame("error")).toMatchObject({ t: "error", code: "bad_request" });
    c.control({ t: "type_trust" });
    expect(await c.frame("error", 2)).toMatchObject({ t: "error", code: "bad_request" });
    expect(c.frames("typed")).toEqual([]);
  }, T);
});

describe("R131: Open in terminal for a background session, type_attach", () => {
  test("it types claude attach <id> for an id in the chat's book at the free prompt, never Enter; Enter runs it", async () => {
    const id = chat();
    bgBook.add(`${id} 3f9a1c2e`);
    const c = await Client.connect();
    await c.open(id);
    await c.prompt();
    c.keys(`claude() { printf 'CL%sDE-ARGS:%s\\n' AU "$*"; }; ${say("DEFOK")}\r`);
    await c.see("DEFOK\r\n");
    c.control({ t: "type_attach", id: "3f9a1c2e" });
    expect(await c.frame("typed")).toEqual({ t: "typed", case: "attach" });
    await c.see("claude attach 3f9a1c2e");
    await Bun.sleep(400);
    expect(c.out).not.toContain("CLAUDE-ARGS");
    c.keys("\r");
    await c.see("CLAUDE-ARGS:attach 3f9a1c2e\r\n");
    expect(existsSync(RAN)).toBe(false);
  }, T);

  test("an id that no launch row of the chat printed, another chat's id, or an archived chat: none, nothing typed", async () => {
    const id = chat();
    const other = chat();
    bgBook.add(`${other} 0a1b2c3d`);
    const c = await Client.connect();
    await c.open(id);
    await c.prompt();
    c.control({ t: "type_attach", id: "0a1b2c3d" });
    expect(await c.frame("typed")).toEqual({ t: "typed", case: "none" });
    bgBook.add(`${id} 4e5f6a7b`);
    chats.get(id)!.archived = true;
    c.control({ t: "type_attach", id: "4e5f6a7b" });
    expect(await c.frame("typed", 2)).toEqual({ t: "typed", case: "none" });
    await Bun.sleep(300);
    expect(c.out).not.toContain("claude attach");
  }, T);

  test("an id that is not a short id is a bad request, and types nothing", async () => {
    const id = chat();
    const c = await Client.connect();
    await c.open(id);
    for (const bad of ["3f9a1c2e; rm -rf ~", "3F9A1C2E", "--all"]) c.control({ t: "type_attach", id: bad });
    expect(await c.frame("error", 3)).toMatchObject({ t: "error", code: "bad_request" });
    expect(c.frames("typed")).toEqual([]);
  }, T);
});

describe("Open in terminal: type_resume (D5)", () => {
  test("sent at once after open, it waits for the line editor: the command shows once, after the prompt, and does not run", async () => {
    const session = crypto.randomUUID();
    const id = chat({ sessionId: session, processOpen: false });
    const c = await Client.connect();
    c.control({ t: "open", chat: id, cols: 200, rows: 40 });
    c.control({ t: "type_resume" });
    expect(await c.frame("typed")).toEqual({ t: "typed", case: "plain" });
    await c.see(session);
    await Bun.sleep(700);
    const out = c.out;
    expect(count(out, session)).toBe(1);
    expect(out.indexOf(`claude --resume ${session}`)).toBeGreaterThan(out.indexOf("kitespan-test"));
    expect(out).toContain(`cd '${cwdOf(id)}' && claude --resume ${session}`);
    expect(out).not.toContain("not found");
    expect(existsSync(RAN)).toBe(false);
    c.keys(new Uint8Array([3]));
  }, T);

  test("the fork command while the chat's Claude Code is open; it runs only on Enter, in the chat's folder; a second request types nothing more", async () => {
    const session = crypto.randomUUID();
    const id = chat({ sessionId: session, processOpen: true });
    const c = await Client.connect();
    await c.open(id);
    await c.prompt();
    c.keys(`claude() { printf 'CL%sDE-ARGS:%s|%s\\n' AU "$*" "$PWD"; }; cd /; ${say("DEFOK")}\r`);
    await c.see("DEFOK\r\n");
    c.control({ t: "type_resume" });
    expect(await c.frame("typed")).toEqual({ t: "typed", case: "fork" });
    await c.see(`--resume ${session} --fork-session`);
    await Bun.sleep(500);
    c.control({ t: "type_resume" });
    expect(await c.frame("typed", 2)).toEqual({ t: "typed", case: "fork" });
    await Bun.sleep(300);
    expect(count(c.out, session)).toBe(1);
    expect(c.out).not.toContain("CLAUDE-ARGS");
    c.keys("\r");
    await c.see(`CLAUDE-ARGS:--resume ${session} --fork-session|${cwdOf(id)}\r\n`);
    expect(existsSync(RAN)).toBe(false);
  }, T);

  test("a command left at the prompt is replaced when the chat's state changed, never doubled", async () => {
    const session = crypto.randomUUID();
    const id = chat({ sessionId: session, processOpen: false });
    const c = await Client.connect();
    await c.open(id);
    await c.prompt();
    c.keys(`claude() { printf 'CL%sDE-ARGS:%s\\n' AU "$*"; }; ${say("DEFOK")}\r`);
    await c.see("DEFOK\r\n");
    c.control({ t: "type_resume" });
    expect(await c.frame("typed")).toEqual({ t: "typed", case: "plain" });
    await c.see(session);
    chats.get(id)!.processOpen = true;
    c.control({ t: "type_resume" });
    expect(await c.frame("typed", 2)).toEqual({ t: "typed", case: "fork" });
    await c.see("--fork-session");
    c.keys("\r");
    const out = await c.see("CLAUDE-ARGS:");
    await Bun.sleep(200);
    expect(c.out).toContain(`CLAUDE-ARGS:--resume ${session} --fork-session\r\n`);
    expect(count(out.slice(out.indexOf("CLAUDE-ARGS:")), "claude")).toBe(0);
    expect(existsSync(RAN)).toBe(false);
  }, T);

  test("two pages that ask at once, before the prompt: each gets its answer, and the command is typed once", async () => {
    const session = crypto.randomUUID();
    const id = chat({ sessionId: session, processOpen: false });
    const a = await Client.connect();
    const b = await Client.connect();
    a.control({ t: "open", chat: id, cols: 200, rows: 40 });
    b.control({ t: "open", chat: id, cols: 200, rows: 40 });
    a.control({ t: "type_resume" });
    b.control({ t: "type_resume" });
    expect(await a.frame("typed")).toEqual({ t: "typed", case: "plain" });
    expect(await b.frame("typed")).toEqual({ t: "typed", case: "plain" });
    await a.see(session);
    await Bun.sleep(500);
    expect(count(a.out, session)).toBe(1);
    expect(existsSync(RAN)).toBe(false);
    a.keys(new Uint8Array([3]));
  }, T);

  test("a second device that opens the pane later, at another size, while the line holds the command: nothing more is typed", async () => {
    const session = crypto.randomUUID();
    const id = chat({ sessionId: session, processOpen: false });
    const a = await Client.connect();
    await a.open(id);
    await a.prompt();
    a.keys(`claude() { printf 'CL%sDE-ARGS:%s\\n' AU "$*"; }; ${say("DEFOK")}\r`);
    await a.see("DEFOK\r\n");
    a.control({ t: "type_resume" });
    expect(await a.frame("typed")).toEqual({ t: "typed", case: "plain" });
    await a.see(session);
    await Bun.sleep(300);
    // The phone: another size (the shell redraws its line, which shows the command again), the ring, then its request.
    const b = await Client.connect();
    await b.open(id, 60, 20);
    await b.see(session);
    b.control({ t: "type_resume" });
    expect(await b.frame("typed")).toEqual({ t: "typed", case: "plain" });
    await Bun.sleep(600);
    // What the line holds is what runs on Enter: the command once, with nothing typed after it.
    a.keys("\r");
    await a.see("CLAUDE-ARGS:");
    await Bun.sleep(200);
    expect(a.out).toContain(`CLAUDE-ARGS:--resume ${session}\r\n`);
    expect(existsSync(RAN)).toBe(false);
  }, T);

  test("a reload (the socket closes, a new one opens and asks again) types nothing more, once per request", async () => {
    const session = crypto.randomUUID();
    const id = chat({ sessionId: session, processOpen: true });
    const watch = await Client.connect();
    await watch.open(id);
    for (let i = 0; i < 3; i++) {
      const page = await Client.connect();
      await page.open(id);
      page.control({ t: "type_resume" });
      expect(await page.frame("typed")).toEqual({ t: "typed", case: "fork" });
      await watch.see(`--resume ${session} --fork-session`);
      await Bun.sleep(300);
      page.close();
      await until(() => page.closed, 4000, "the page to close");
    }
    expect(count(watch.out, `--resume ${session} --fork-session`)).toBe(1);
    watch.keys(new Uint8Array([3]));
  }, T);

  test("once the typed command runs, another device's request is busy, and the prompt after it gets nothing", async () => {
    const session = crypto.randomUUID();
    const id = chat({ sessionId: session, processOpen: false });
    const a = await Client.connect();
    await a.open(id);
    await a.prompt();
    a.keys(`claude() { sleep 1; printf '%s%s\\n' CLAUDE DONE; }; ${say("DEFOK")}\r`);
    await a.see("DEFOK\r\n");
    a.control({ t: "type_resume" });
    expect(await a.frame("typed")).toEqual({ t: "typed", case: "plain" });
    await a.see(`claude --resume ${session}`);
    a.keys("\r");
    await Bun.sleep(200);
    const b = await Client.connect();
    await b.open(id);
    b.control({ t: "type_resume" });
    expect(await b.frame("typed")).toEqual({ t: "typed", case: "busy" });
    await a.see("CLAUDEDONE\r\n", 6000);
    await a.prompt(3);
    await Bun.sleep(500);
    const after = a.out.slice(a.out.indexOf("CLAUDEDONE"));
    expect(after).not.toContain(session);
  }, T);

  test("while a program holds the terminal, even one that turns bracketed paste on, nothing is typed: the answer is busy", async () => {
    const session = crypto.randomUUID();
    const id = chat({ sessionId: session, processOpen: true });
    const a = await Client.connect();
    await a.open(id);
    await a.prompt();
    // A program of its own, not the shell: it turns bracketed paste on, as an editor or a REPL does, and prints each
    // key it reads in brackets.
    a.keys(`sh -c 'printf "RE%sDY\\033[?2004h" A; stty -icanon -echo; while :; do k=$(dd bs=1 count=1 2>/dev/null); printf "[%s]" "$k"; done'\r`);
    await a.see("READY");
    const b = await Client.connect();
    await b.open(id);
    b.control({ t: "type_resume" });
    expect(await b.frame("typed")).toEqual({ t: "typed", case: "busy" });
    await Bun.sleep(500);
    expect(a.out.slice(a.out.indexOf("READY"))).not.toContain("[");
    expect(a.out).not.toContain(session);
    a.keys(new Uint8Array([3]));
    await a.prompt(2);
    await Bun.sleep(300);
    expect(a.out).not.toContain(session);
  }, T);

  test("a line that a page has started typing gets nothing: busy, the line stays; at a clean prompt the command is typed", async () => {
    const session = crypto.randomUUID();
    const id = chat({ sessionId: session, processOpen: false });
    const a = await Client.connect();
    await a.open(id);
    await a.prompt();
    a.keys("echo half");
    await a.see("echo half");
    const b = await Client.connect();
    await b.open(id);
    b.control({ t: "type_resume" });
    expect(await b.frame("typed")).toEqual({ t: "typed", case: "busy" });
    await Bun.sleep(300);
    expect(a.out).not.toContain(session);
    // Ctrl+C drops the half-typed line and draws a new prompt, which is free.
    a.keys(new Uint8Array([3]));
    await a.prompt(2);
    b.control({ t: "type_resume" });
    expect(await b.frame("typed", 2)).toEqual({ t: "typed", case: "plain" });
    await a.see(session);
    expect(a.out).not.toContain("echo halfcd");
    a.keys(new Uint8Array([3]));
  }, T);

  test("while a command runs the answer is busy at once, and nothing is typed at the prompt that comes after it", async () => {
    const session = crypto.randomUUID();
    const id = chat({ sessionId: session, processOpen: false });
    const a = await Client.connect();
    await a.open(id);
    await a.prompt();
    a.keys("sleep 5\r");
    await Bun.sleep(300);
    const b = await Client.connect();
    await b.open(id);
    b.control({ t: "type_resume" });
    expect(await b.frame("typed")).toEqual({ t: "typed", case: "busy" });
    a.keys(new Uint8Array([3]));
    await a.prompt(2);
    await Bun.sleep(500);
    expect(a.out).not.toContain(session);
  }, T);

  test("keys typed while a command runs wait for the next prompt's line: nothing is typed after them", async () => {
    const session = crypto.randomUUID();
    const id = chat({ sessionId: session, processOpen: false });
    const a = await Client.connect();
    await a.open(id);
    await a.prompt();
    a.keys(`sleep 1; ${say("SLEPT")}\r`);
    await Bun.sleep(300);
    a.keys("echo ahead");
    await a.see("SLEPT\r\n", 4000);
    await a.prompt(2);
    await a.see(/kitespan-test[^\n]*echo ahead/);
    a.control({ t: "type_resume" });
    expect(await a.frame("typed")).toEqual({ t: "typed", case: "busy" });
    await Bun.sleep(300);
    expect(a.out).not.toContain(session);
    a.keys(new Uint8Array([3]));
  }, T);

  test("a request that waits for the shell's first prompt is dropped by a key: busy, and nothing is typed", async () => {
    const session = crypto.randomUUID();
    const id = chat({ sessionId: session, processOpen: false });
    const b = await Client.connect();
    b.control({ t: "open", chat: id, cols: 200, rows: 40 });
    b.control({ t: "type_resume" });
    b.keys("x");
    expect(await b.frame("typed")).toEqual({ t: "typed", case: "busy" });
    await b.prompt();
    await Bun.sleep(500);
    expect(b.out).not.toContain(session);
    b.keys(new Uint8Array([3]));
  }, T);

  test("before the chat's first message nothing is typed", async () => {
    const id = chat({ sessionId: null });
    const c = await Client.connect();
    await c.open(id);
    await c.prompt();
    // A field from the page is never typed: the command is the server's own.
    c.control({ t: "type_resume", command: "printf PAGETEXT" });
    expect(await c.frame("typed")).toEqual({ t: "typed", case: "none" });
    await Bun.sleep(300);
    expect(c.out).not.toContain("claude");
    expect(c.out).not.toContain("PAGETEXT");
  }, T);
});

describe("lifetime and close path (D3)", () => {
  const ptyOpts = (onData: (b: Uint8Array) => void, onExit: (e: ShellExit) => void = () => {}) => ({
    shell: SHELL,
    cwd: ROOT,
    env: shellEnv(ENV),
    cols: 80,
    rows: 24,
    onData,
    onExit,
    closeStepMs: 300,
  });

  test.skipIf(!PROCFS)(`exit codes 0 and 7 come from the process, and a shell that exits frees its terminal ${LINUX_ONLY}`, async () => {
    const before = ptmxCount();
    for (const [line, code] of [["exit\r", 0], ["exit 7\r", 7]] as const) {
      let out = "";
      const exits: ShellExit[] = [];
      const pty = new ShellPty(ptyOpts((b) => (out += new TextDecoder().decode(b)), (e) => exits.push(e)));
      await until(() => out.includes("kitespan-test"), 8000, "the prompt");
      pty.write(line);
      expect(await pty.done).toEqual({ code, signal: null });
      expect(exits).toEqual([{ code, signal: null }]);
      expect(pty.closed).toBe(true);
      expect(alive(pty.pid)).toBe(false);
      pty.write("ignored after the end\r");
    }
    expect(ptmxCount()).toBe(before);
  }, T);

  test.skipIf(!PROCFS)(`SIGTERM does not end an interactive shell; terminal.close() does, and frees its three descriptors ${LINUX_ONLY}`, async () => {
    const before = ptmxCount();
    let out = "";
    const pty = new ShellPty(ptyOpts((b) => (out += new TextDecoder().decode(b))));
    expect(ptmxCount()).toBe(before + 3);
    await until(() => out.includes("kitespan-test"), 8000, "the prompt");
    process.kill(pty.pid, "SIGTERM");
    await Bun.sleep(500);
    expect(pty.alive()).toBe(true);
    const t0 = performance.now();
    const exit = await pty.close();
    expect(performance.now() - t0).toBeLessThan(300);
    expect(exit.code === null ? exit.signal : exit.code).not.toBe(0);
    expect(alive(pty.pid)).toBe(false);
    expect(ptmxCount()).toBe(before);
    expect(() => pty.resize(100, 30)).not.toThrow();
  }, T);

  test.skipIf(!PROCFS)(`a shell that ignores SIGHUP and SIGTERM ends by SIGKILL, the last step ${LINUX_ONLY}`, async () => {
    let out = "";
    const pty = new ShellPty(ptyOpts((b) => (out += new TextDecoder().decode(b))));
    await until(() => out.includes("kitespan-test"), 8000, "the prompt");
    pty.write("trap '' HUP TERM; exec sleep 60\r");
    await until(() => {
      try {
        return readFileSync(`/proc/${pty.pid}/comm`, "utf8").trim() === "sleep";
      } catch {
        return false;
      }
    }, 8000, "the exec");
    const t0 = performance.now();
    expect(await pty.close()).toEqual({ code: null, signal: "SIGKILL" });
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(alive(pty.pid)).toBe(false);
  }, T);

  test("end() closes the chat's shell and every page gets exit; closeAll() ends the rest", async () => {
    const one = chat();
    const two = chat();
    const a = await Client.connect();
    const b = await Client.connect();
    await a.open(one);
    await b.open(two);
    await a.prompt();
    await b.prompt();
    await shells.end(one);
    expect((await a.frame("exit")).t).toBe("exit");
    expect(shells.has(one)).toBe(false);
    expect(shells.has(two)).toBe(true);
    await shells.closeAll();
    expect((await b.frame("exit")).t).toBe("exit");
    expect(shells.count).toBe(0);
  }, T);
});

/** A socket for the handlers with no network: its buffered amount and its send status are the test's to set. */
class FakeSocket implements ShellSocket {
  buffered = 0;
  status: number | null = null;
  readonly texts: ShellOutFrame[] = [];
  readonly order: string[] = [];
  readonly bins: Uint8Array[] = [];
  constructor(readonly data: ShellWsData) {}
  sendText(s: string) {
    const f = JSON.parse(s) as ShellOutFrame;
    this.texts.push(f);
    this.order.push(f.t);
    return s.length;
  }
  sendBinary(b: Uint8Array) {
    const st = this.status;
    this.status = null;
    if (st === 0) return 0;
    this.bins.push(new Uint8Array(b));
    this.order.push("bin");
    return st ?? b.length;
  }
  getBufferedAmount() {
    return this.buffered;
  }
  close() {}
  get out() {
    return strip(new TextDecoder().decode(Buffer.concat(this.bins)));
  }
}

function fakeSocket(svc: ShellService): FakeSocket {
  let data: ShellWsData | null = null;
  const req = new Request(`${ORIGIN}${WIRE.shellPath}`, { headers: { origin: ORIGIN } });
  svc.upgrade(req, { upgrade: (_r, o) => ((data = o.data), true) });
  const ws = new FakeSocket(data!);
  expect(svc.websocket.open(ws)).toBe(true);
  return ws;
}

describe("flow control and the detached shell (D52)", () => {
  test("a page more than 1 MiB behind gets no live output, then reset and the ring once it drains", async () => {
    const id = chat();
    const fast = fakeSocket(shells);
    const slow = fakeSocket(shells);
    shells.websocket.message(fast, JSON.stringify({ t: "open", chat: id, cols: 200, rows: 40 }));
    shells.websocket.message(slow, JSON.stringify({ t: "open", chat: id, cols: 200, rows: 40 }));
    await until(() => fast.out.includes("kitespan-test"), 8000, "the prompt");
    shells.websocket.message(fast, new TextEncoder().encode(`${say("LAGONE")}\r`));
    await until(() => slow.out.includes("LAGONE\r\n"), 4000, "LAGONE");

    slow.buffered = SHELL_LIMITS.lagBytes + 1;
    const before = slow.bins.length;
    shells.websocket.message(fast, new TextEncoder().encode(`${say("LAGTWO")}\r`));
    await until(() => fast.out.includes("LAGTWO\r\n"), 4000, "LAGTWO");
    await Bun.sleep(100);
    expect(slow.bins.length).toBe(before);

    slow.buffered = 0;
    expect(shells.websocket.drain(slow)).toBe(true);
    expect(slow.texts.at(-1)).toEqual({ t: "reset" });
    const reset = slow.order.lastIndexOf("reset");
    expect(slow.order.slice(reset + 1).every((t) => t === "bin")).toBe(true);
    const ring = strip(new TextDecoder().decode(Buffer.concat(slow.bins.slice(before))));
    expect(ring).toContain("LAGONE\r\n");
    expect(ring).toContain("LAGTWO\r\n");

    // A dropped send leaves a hole, so it resets too; live output then flows again.
    slow.status = 0;
    shells.websocket.message(fast, new TextEncoder().encode(`${say("LAGTHREE")}\r`));
    await until(() => fast.out.includes("LAGTHREE\r\n"), 4000, "LAGTHREE");
    await until(() => slow.texts.filter((f) => f.t === "reset").length === 2, 4000, "the second reset");
    shells.websocket.message(fast, new TextEncoder().encode(`${say("LAGFOUR")}\r`));
    await until(() => slow.out.includes("LAGFOUR\r\n"), 4000, "LAGFOUR live");
    shells.websocket.close(fast);
    shells.websocket.close(slow);
    await shells.end(id);
  }, T);

  test("a shell with no page left ends after the keep time", async () => {
    const svc = service({ detachedKeepMs: 300 });
    const id = chat();
    const ws = fakeSocket(svc);
    svc.websocket.message(ws, JSON.stringify({ t: "open", chat: id, cols: 80, rows: 24 }));
    await until(() => ws.out.includes("kitespan-test"), 8000, "the prompt");
    svc.websocket.close(ws);
    expect(svc.has(id)).toBe(true);
    await until(() => !svc.has(id), 4000, "the end");
    expect(svc.count).toBe(0);
  }, T);

  test("a shell that cannot start gets no_shell, and the log line holds the code only", async () => {
    const lines: unknown[] = [];
    const svc = service({ log: { log: (ev, f) => void lines.push([ev, f]) } });
    const gone = chat();
    rmSync(cwdOf(gone), { recursive: true });
    const ws = fakeSocket(svc);
    svc.websocket.message(ws, JSON.stringify({ t: "open", chat: gone, cols: 80, rows: 24 }));
    expect(ws.texts).toEqual([{ t: "error", code: "no_shell", message: "The terminal could not start." }]);
    expect(lines).toEqual([["error", { chat: gone, err: "shell" }]]);
    expect(svc.has(gone)).toBe(false);
    const bad = service({ shell: join(ROOT, "no-such-shell") });
    const id = chat();
    const ws2 = fakeSocket(bad);
    bad.websocket.message(ws2, JSON.stringify({ t: "open", chat: id, cols: 80, rows: 24 }));
    expect(ws2.texts.map((f) => f.t === "error" && f.code)).toEqual(["no_shell"]);
  }, T);

  test("a socket that never sends open is closed", async () => {
    const svc = service({ openWaitMs: 100 });
    const ws = fakeSocket(svc);
    let closed: number | undefined;
    ws.close = (code?: number) => void (closed = code);
    await until(() => closed !== undefined, 2000, "the close");
    expect(closed).toBe(1008);
  }, T);
});
