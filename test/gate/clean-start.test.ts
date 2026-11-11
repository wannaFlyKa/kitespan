// DESIGN.md 4.7 negative case 11, a dirty start, end to end: bin/kitespan runs with a planted environment (each name
// of the removal list, one made-up name per prefix rule, a Claude Desktop host's names with its marker, and the trace
// context after a Claude Code session), and starts the real server on a free port of 127.0.0.1 with the fake claude
// first on PATH. A chat's first message starts the fake, whose start trace holds the names of its variables, never the
// values. No planted name reaches it, the user's own names do, and the SDK adds only its three unconditional names.
// The real claude never runs. It runs on macOS too: where /proc cannot be read, the server is stopped through the
// test's own handle, and only the sweep for a leaked fake is Linux-only.

import type { Subprocess } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SDK_CHILD_ENV } from "../../server/agents/claude/options";
import { CLEAN_ENV } from "../../server/agents/types";
import { installFakeClaude, SHELL_OWN_ENV_NAMES, type TraceLine } from "../fake-claude/install";
import { PROCFS } from "../linux";
import { freePort } from "../unit/free-port";

const ROOT = resolve(import.meta.dir, "..", "..");
const SCRIPT = join(ROOT, "bin", "kitespan");
const MAIN = join(ROOT, "server", "main.ts");
const PORT = freePort();
const OWN = `http://127.0.0.1:${PORT}`;
const T = 30_000;
/** Every planted variable has this value, so the test can show that no value is ever printed. */
const VALUE = "planted-value-case-11";

const fake = installFakeClaude("text-thinking");
const HOME = join(fake.root, "home");
const DIST = join(fake.root, "dist");
for (const d of [HOME, join(fake.root, "state"), join(fake.root, "config"), join(fake.root, "tmp"), DIST]) mkdirSync(d, { recursive: true });
writeFileSync(join(DIST, "index.html"), "<!doctype html><html><body>kitespan page</body></html>");

/** The user's own environment: it must reach Claude Code as it is. */
const KEEP: Record<string, string> = {
  PATH: `${fake.binDir}:${dirname(process.execPath)}:/usr/bin:/bin`,
  HOME,
  CLAUDE_CONFIG_DIR: join(HOME, ".claude"),
  XDG_STATE_HOME: join(fake.root, "state"),
  XDG_CONFIG_HOME: join(fake.root, "config"),
  TMPDIR: join(fake.root, "tmp"),
  SHELL: "/bin/sh",
  KITESPAN_CASE_11_KEPT: "1",
};
/** What a Claude Code session and a Claude Desktop host leave behind. */
const PLANTED: Record<string, string> = Object.fromEntries(
  [
    ...CLEAN_ENV.always,
    ...CLEAN_ENV.alwaysPrefixes.map((p) => `${p}PLANTED`),
    ...CLEAN_ENV.desktop,
    ...CLEAN_ENV.traceAfterSession,
  ].map((n) => [n, VALUE]),
);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function cmdline(pid: number): string[] {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
  } catch {
    return [];
  }
}

let server: Subprocess<"ignore", "pipe", "pipe"> | null = null;
let out = "";
let ws: WebSocket | null = null;

afterAll(async () => {
  try {
    ws?.close();
  } catch {}
  // Stop the server by its pid (the script execs env, which execs Bun), after kill -0 and a check that it is ours: its
  // command line where /proc can be read, else the test's own handle of the process it spawned, while it has not exited.
  if (server && server.exitCode === null && server.signalCode === null && alive(server.pid)) {
    if (!PROCFS) server.kill("SIGTERM");
    else if (cmdline(server.pid).includes(MAIN)) process.kill(server.pid, "SIGTERM");
  }
  if (server) await Promise.race([server.exited, Bun.sleep(15_000)]);
  for (const name of PROCFS ? readdirSync("/proc") : []) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (cmdline(pid).includes(fake.fixturePath) && alive(pid)) process.kill(pid, "SIGKILL");
  }
  fake.cleanup();
});

async function boot(): Promise<void> {
  server = Bun.spawn(["/bin/sh", SCRIPT, "--port", String(PORT), "--dist", DIST], {
    env: { ...KEEP, ...PLANTED },
    cwd: fake.root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const read = async (s: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    for await (const c of s) out += dec.decode(c, { stream: true });
  };
  void read(server.stdout);
  void read(server.stderr);
  const end = Date.now() + 15_000;
  while (!out.includes(`kitespan listens on ${OWN}`)) {
    if (server.exitCode !== null || Date.now() > end) throw new Error(`the server did not start (exit ${server.exitCode}): ${out}`);
    await Bun.sleep(50);
  }
}

type Frame = Record<string, any>;

function socket(): Promise<{ frames: Frame[]; send: (f: Frame) => void; waitFor: (p: (f: Frame) => boolean) => Promise<Frame> }> {
  return new Promise((resolveOpen, reject) => {
    const frames: Frame[] = [];
    const s = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { origin: OWN } });
    ws = s;
    s.onmessage = (m) => {
      if (typeof m.data === "string") frames.push(JSON.parse(m.data) as Frame);
    };
    s.onerror = () => reject(new Error("the socket did not open"));
    s.onopen = () =>
      resolveOpen({
        frames,
        send: (f) => s.send(JSON.stringify(f)),
        async waitFor(p) {
          const end = Date.now() + 10_000;
          for (;;) {
            const hit = frames.find(p);
            if (hit) return hit;
            if (Date.now() > end) throw new Error(`timed out; frames: ${frames.map((f) => f.t).join(", ")}`);
            await Bun.sleep(20);
          }
        },
      });
  });
}

describe("4.7 case 11: a planted environment never reaches Claude Code", () => {
  test(
    "bin/kitespan removes every planted name; the claude child gets the user's names and the SDK's three",
    async () => {
      await boot();
      const added = await fetch(`${OWN}/api/projects`, {
        method: "POST",
        headers: { "x-kitespan": "1", "content-type": "application/json", origin: OWN },
        body: JSON.stringify({ cwd: fake.project }),
      });
      expect(added.status).toBe(201);
      const project = ((await added.json()) as { project: { id: string } }).project.id;

      const page = await socket();
      page.send({ t: "hello", v: 1, tab: "tab-case-11" });
      const welcome = await page.waitFor((f) => f.t === "welcome");
      expect(welcome.claude.ok).toBe(true);
      const rid = crypto.randomUUID();
      page.send({ t: "new_chat", rid, project, uuid: crypto.randomUUID(), text: "hello there", picks: { model: null, effort: null, mode: null }, uploads: [] });
      expect((await page.waitFor((f) => f.t === "ack" && f.rid === rid)).ok).toBe(true);

      const start = (await fake.waitFor((l: TraceLine) => l.t === "start", 15_000)).envNames as string[];
      // No planted name, except the SDK's own entrypoint mark, which it sets once the script removed the inherited one.
      const leaked = start.filter((n) => n in PLANTED || CLEAN_ENV.alwaysPrefixes.some((p) => n.startsWith(p)));
      expect(leaked).toEqual(["CLAUDE_CODE_ENTRYPOINT"]);
      for (const n of Object.keys(KEEP)) expect(start).toContain(n);
      // The SDK's own names: those it sets on the server's process.env and those it adds to the child's copy.
      const sdkAdded = start.filter((n) => !(n in KEEP) && !SHELL_OWN_ENV_NAMES.includes(n)).sort();
      expect(sdkAdded).toEqual([...new Set([...SDK_CHILD_ENV.host, ...SDK_CHILD_ENV.added])].sort());
      // The script and the server name variables, never their values.
      expect(out).not.toContain(VALUE);
    },
    T,
  );
});
