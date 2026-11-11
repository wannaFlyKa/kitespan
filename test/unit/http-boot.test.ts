// The boot of server/main.ts (DESIGN.md 4.1, 4.7 "Checked at boot", 4.9 guard 1, 4.10; build checklist A1's boot
// side, A9, A14). The server runs as its own process on the test port, with a scratch HOME and XDG folders and a fake
// `claude` first on PATH that only answers `--version` (it records any other start, so the test sees that booting
// and reading start no Claude Code). Nothing here runs the real claude.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { claudeLines } from "../../server/update/drift";
import { freePort } from "./free-port";

const ROOT = resolve(import.meta.dir, "..", "..");
const MAIN = join(ROOT, "server", "main.ts");
const PORT = freePort();
const OWN = `http://127.0.0.1:${PORT}`;

const dir = mkdtempSync(join(tmpdir(), "kitespan-boot-"));
const bin = join(dir, "bin");
const marker = join(dir, "claude-started");

beforeAll(() => {
  mkdirSync(bin);
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.311 (Claude Code)"; exit 0; fi\necho started >> "${marker}"\nexit 1\n`,
  );
  chmodSync(join(bin, "claude"), 0o755);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A clean environment of the scratch folder's own, as bin/kitespan would leave it. */
function cleanEnv(name: string, extra: Record<string, string> = {}): Record<string, string> {
  const base = join(dir, name);
  for (const d of ["home", "state", "config", "tmp"]) mkdirSync(join(base, d), { recursive: true });
  return {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: join(base, "home"),
    XDG_STATE_HOME: join(base, "state"),
    XDG_CONFIG_HOME: join(base, "config"),
    TMPDIR: join(base, "tmp"),
    SHELL: "/bin/sh",
    ...extra,
  };
}

function run(args: string[], env: Record<string, string>, bunArgs = ["--no-env-file"]) {
  return Bun.spawnSync([process.execPath, ...bunArgs, MAIN, ...args], { env, cwd: dir, stdout: "pipe", stderr: "pipe", timeout: 20_000 });
}

describe("the boot refuses", () => {
  test("a start environment that bin/kitespan did not clean, naming the variables and never their values", () => {
    const r = run(["--port", String(PORT)], cleanEnv("dirty", { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "value-that-must-not-show" }));
    expect(r.exitCode).toBe(1);
    const err = r.stderr.toString();
    expect(err).toContain("CLAUDECODE");
    expect(err).toContain("CLAUDE_CODE_SESSION_ID");
    expect(err).toContain("bin/kitespan");
    expect(err + r.stdout.toString()).not.toContain("value-that-must-not-show");
  });

  test("Bun started without --no-env-file", () => {
    const r = run(["--port", String(PORT)], cleanEnv("envfile"), []);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("--no-env-file");
  });

  test("a bad option, with the usage line", () => {
    for (const args of [["--port", "0"], ["--port", "http"], ["--port"], ["--verbose"], ["--origin", "http://box.example.com"]]) {
      const r = run(args, cleanEnv("args"));
      expect(r.exitCode).toBe(2);
      expect(r.stderr.toString()).toEndWith("kitespan: Usage: bin/kitespan [dev] [--port <port>] [--origin <origin>]... [--dist <build folder>] (bin/kitespan --help)\n");
    }
  });

  test("a state folder that others can open", () => {
    const env = cleanEnv("wide");
    mkdirSync(join(env.XDG_STATE_HOME!, "kitespan"), { mode: 0o755 });
    chmodSync(join(env.XDG_STATE_HOME!, "kitespan"), 0o755);
    const r = run(["--port", String(PORT)], env);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("failed its checks");
  });
});

describe("a clean boot", () => {
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let out = "";
  let env: Record<string, string>;
  const dist = join(dir, "dist");

  beforeAll(async () => {
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html><html><body>kitespan page</body></html>");
    env = cleanEnv("clean");
    proc = Bun.spawn([process.execPath, "--no-env-file", MAIN, "--port", String(PORT), "--dist", dist], { env, cwd: dir, stdout: "pipe", stderr: "pipe" });
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const deadline = Date.now() + 15_000;
    // The fake claude's version differs from the SDK's, so the drift line is the last boot line.
    while (!out.includes("this SDK was built for") && Date.now() < deadline) {
      const r = await Promise.race([reader.read(), Bun.sleep(500).then(() => null)]);
      if (r && !r.done) out += new TextDecoder().decode(r.value);
      if (r?.done) break;
    }
    // Keep reading in the background so the pipe never fills.
    void (async () => {
      for (;;) {
        const r = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (r.done) break;
        out += new TextDecoder().decode(r.value);
      }
    })();
  });

  afterAll(async () => {
    if (proc && proc.exitCode === null) {
      proc.kill("SIGKILL");
      await proc.exited;
    }
  });

  test("it prints its address, the access hint and the drift line", () => {
    expect(out).toContain(`kitespan listens on ${OWN}`);
    expect(out).toContain(`ssh -L ${PORT}:127.0.0.1:${PORT}`);
    expect(out).toContain("Claude Code 2.1.311 (Claude Code)");
    expect(out).toContain("Claude Code 2.1.311 runs here; this SDK was built for 2.1.312.");
  });

  test("it listens on 127.0.0.1 only", async () => {
    expect((await fetch(`${OWN}/`)).status).toBe(200);
    await expect(fetch(`http://127.0.0.2:${PORT}/`)).rejects.toThrow();
    await expect(fetch(`http://[::1]:${PORT}/`)).rejects.toThrow();
  });

  test("the page, the 404 page and a settings read", async () => {
    expect(await (await fetch(`${OWN}/c/k3m7q2x4abk3m7q2x4ab`)).text()).toContain("kitespan page");
    expect((await fetch(`${OWN}/nope`)).status).toBe(404);
    const s = (await (await fetch(`${OWN}/api/settings`)).json()) as { server: { port: number }; claude: { ok: boolean; version: string; drift: string } };
    expect(s.server.port).toBe(PORT);
    expect(s.claude.ok).toBe(true);
    expect(s.claude.version).toContain("2.1.311");
    expect((await fetch(`${OWN}/api/settings`, { headers: { origin: "https://evil.example" } })).status).toBe(403);
  });

  test("the chat socket and the Terminal pane's socket take kitespan's own origin and refuse another", async () => {
    const hello = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { origin: OWN } } as unknown as string[]);
      const timer = setTimeout(() => reject(new Error("no welcome")), 5_000);
      ws.onopen = () => ws.send(JSON.stringify({ t: "hello", v: 1, tab: "boot-test" }));
      ws.onmessage = (m) => {
        clearTimeout(timer);
        ws.close();
        resolve(String(m.data));
      };
      ws.onerror = () => reject(new Error("refused"));
    });
    expect(JSON.parse(hello).t).toBe("welcome");
    for (const [path, origin, status] of [
      ["/ws", "https://evil.example", 403],
      ["/ws/shell", "https://evil.example", 403],
      ["/ws/shell", OWN, 101],
    ] as const) {
      const got = await new Promise<number>((resolve) => {
        let text = "";
        Bun.connect({
          hostname: "127.0.0.1",
          port: PORT,
          socket: {
            open(s) {
              s.write(
                `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: ${origin}\r\n\r\n`,
              );
            },
            data(s, d) {
              text += Buffer.from(d).toString("latin1");
              if (text.includes("\r\n\r\n")) s.end();
            },
            close: () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0)),
            error: () => resolve(0),
          },
        });
      });
      expect(got).toBe(status);
    }
  });

  test("booting and reading started no Claude Code", () => {
    expect(existsSync(marker)).toBe(false);
  });

  test("SIGTERM stops it cleanly, and the log holds counts, never an Origin", async () => {
    proc!.kill("SIGTERM");
    const code = await Promise.race([proc!.exited, Bun.sleep(15_000).then(() => -1)]);
    expect(code).toBe(0);
    expect(out).toContain("kitespan is stopping");
    await expect(fetch(`${OWN}/`)).rejects.toThrow();
    const logs = join(env.XDG_STATE_HOME!, "kitespan", "logs");
    const files = readdirSync(logs);
    // The day's file, and the next day's too when the run went past midnight UTC.
    expect([1, 2]).toContain(files.length);
    for (const f of files) {
      expect(f).toMatch(/^kitespan-\d{4}-\d{2}-\d{2}\.log$/);
      expect(statSync(join(logs, f)).mode & 0o777).toBe(0o600);
    }
    const text = files.map((f) => readFileSync(join(logs, f), "utf8")).join("");
    expect(text).toContain('"ev":"origin_refused"');
    expect(text).not.toContain("evil");
  });
});

test("the drift line at start", () => {
  expect(claudeLines({ ok: true, version: "2.1.312", drift: null })).toEqual(["Claude Code 2.1.312"]);
  expect(claudeLines({ ok: true, version: "2.1.311", drift: "Claude Code 2.1.311 runs here; this SDK was built for 2.1.312." })).toEqual([
    "Claude Code 2.1.311",
    "Claude Code 2.1.311 runs here; this SDK was built for 2.1.312.",
  ]);
  // Below kitespan's minimum, its line takes the drift line's place (claude-minimum.test.ts has the cases).
  expect(
    claudeLines({ ok: true, version: "2.1.250", drift: "Claude Code 2.1.250 runs here; this SDK was built for 2.1.312.", belowMinimum: { version: "2.1.250", minimum: "2.1.296", stock: true } }),
  ).toEqual(["Claude Code 2.1.250", "Claude Code 2.1.250 runs here; kitespan supports 2.1.296 and later. Run claude update."]);
  expect(claudeLines({ ok: false, version: null, drift: null })[0]).toContain("not available");
});
