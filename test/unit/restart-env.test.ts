// The restart's children get the environment the server started with (DESIGN.md 4.10; build checklist S8, S12), and the
// restart works on a machine with an HTTP proxy (S13). The real server (server/main.ts) starts with a known environment
// that holds HTTP_PROXY and http_proxy at a port where nothing listens (NO_PROXY unset), on a free port of its own with
// scratch HOME and XDG folders and the fake claude first on PATH (the real claude never runs). A chat runs once, so the
// SDK has loaded and started a query (it writes NoDefaultCurrentDirectoryInExePath into process.env at load, and
// CLAUDE_AGENT_SDK_VERSION at each query). Then Restart: the health gate must see the successor's epoch through no
// proxy, and the preflight's `--check` child and the successor (bin/kitespan's) must carry exactly the start's names.
// A `bun` wrapper first on PATH records each one's names (never a value) from /proc and runs the real Bun.
//
// Every process this test signals is one it started (the first server) or the one the first server names as its
// successor in its last line, after kill -0 and a check of its command line.

import type { Subprocess } from "bun";
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { installFakeClaude, SHELL_OWN_ENV_NAMES } from "../fake-claude/install";
import { BUILD_STAMP, stampText } from "../../server/update/stamp";
import { LINUX_ONLY, PROCFS } from "../linux";
import { freePort } from "./free-port";

const ROOT = resolve(import.meta.dir, "..", "..");
const MAIN = join(ROOT, "server", "main.ts");
const PORT = freePort();
const OWN = `http://127.0.0.1:${PORT}`;
const HEAD = Bun.spawnSync(["git", "-C", ROOT, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim();
const OK = { steps: [{ say: { id: "$USER_UUID", text: "ok" } }, { emit: { type: "result", subtype: "success", result: "ok" } }] };
/** What the SDK writes into process.env (sdk.mjs): never in a child that the restart starts. */
const SDK_OWN = ["NoDefaultCurrentDirectoryInExePath", "CLAUDE_AGENT_SDK_VERSION"];

const fake = installFakeClaude({ transcript: true, defaultTurn: OK });
const home = join(fake.root, "home");
const dist = join(fake.root, "dist");
const wrap = join(fake.root, "wrap");
for (const d of [home, dist, wrap, join(fake.root, "state"), join(fake.root, "config"), join(fake.root, "tmp")]) mkdirSync(d, { recursive: true });
writeFileSync(join(dist, "index.html"), "<!doctype html><html><body>kitespan page</body></html>");
writeFileSync(join(dist, BUILD_STAMP), stampText(HEAD));
// The wrapper: the names of the environment it was given (its own /proc entry, before its shell adds any), one file
// for the preflight's `--check` child and one for the successor's start, then the real Bun.
const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
writeFileSync(
  join(wrap, "bun"),
  `#!/bin/sh
case " $* " in
  *" --check "*) kind=check ;;
  *) kind=start ;;
esac
tr '\\000' '\\n' < /proc/$$/environ | cut -d= -f1 | sort > ${q(wrap)}/"$kind".names
exec ${q(process.execPath)} "$@"
`,
  { mode: 0o755 },
);
const proxy = `http://127.0.0.1:${freePort()}`;
const ENV: Record<string, string> = {
  PATH: `${wrap}:${fake.binDir}:${dirname(process.execPath)}:/usr/bin:/bin`,
  HOME: home,
  CLAUDE_CONFIG_DIR: join(home, ".claude"),
  XDG_STATE_HOME: join(fake.root, "state"),
  XDG_CONFIG_HOME: join(fake.root, "config"),
  TMPDIR: join(fake.root, "tmp"),
  SHELL: "/bin/sh",
  HTTP_PROXY: proxy,
  http_proxy: proxy,
};
const START = Object.keys(ENV).sort();

function cmdline(pid: number): string[] {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
  } catch {
    return [];
  }
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
/** A kitespan server of this test: main.ts, this port and this test's own build folder on its command line. */
const ours = (pid: number) => {
  const c = cmdline(pid);
  return c.includes(MAIN) && c.some((a, i) => a === "--port" && c[i + 1] === String(PORT)) && c.some((a, i) => a === "--dist" && c[i + 1] === dist);
};
async function until(pred: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}
async function health(): Promise<string | null> {
  try {
    const r = await fetch(`${OWN}/api/health`, { signal: AbortSignal.timeout(1_000) });
    return r.ok ? ((await r.json()) as { epoch: string }).epoch : null;
  } catch {
    return null;
  }
}
const gate = { "x-kitespan": "1", "content-type": "application/json", origin: OWN };

let first: Subprocess<"ignore", "pipe", "pipe"> | null = null;
let successor: number | null = null;
afterAll(async () => {
  for (const pid of [first?.pid, successor]) {
    if (pid && alive(pid) && ours(pid)) process.kill(pid, "SIGTERM");
  }
  for (const pid of [first?.pid, successor]) if (pid) await until(() => !alive(pid) || !ours(pid), 20_000, "the server to stop").catch(() => {});
  fake.cleanup();
});

test.skipIf(!PROCFS)(
  `with HTTP_PROXY and http_proxy at a dead port the restart happens, and its --check child and its successor get the start's names ${LINUX_ONLY}`,
  async () => {
    const proc = Bun.spawn([process.execPath, "--no-env-file", MAIN, "--port", String(PORT), "--dist", dist], { env: ENV, cwd: fake.root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    first = proc;
    let out = "";
    let err = "";
    const read = Promise.all([
      (async () => {
        for await (const c of proc.stdout) out += new TextDecoder().decode(c);
      })(),
      (async () => {
        for await (const c of proc.stderr) err += new TextDecoder().decode(c);
      })(),
    ]);
    await until(() => out.includes(`kitespan listens on ${OWN}`) || proc.exitCode !== null, 15_000, "the server");
    expect(proc.exitCode).toBeNull();
    const epoch0 = await health();
    expect(epoch0).not.toBeNull();

    // One chat, one turn: the SDK is loaded and has run a query.
    const added = await fetch(`${OWN}/api/projects`, { method: "POST", headers: gate, body: JSON.stringify({ cwd: fake.project }) });
    const project = ((await added.json()) as { project: { id: string } }).project.id;
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { origin: OWN } });
    const frames: Record<string, any>[] = [];
    ws.onmessage = (m) => frames.push(JSON.parse(String(m.data)));
    await new Promise<void>((ok, no) => {
      ws.onopen = () => ok();
      ws.onerror = () => no(new Error("the socket did not open"));
    });
    ws.send(JSON.stringify({ t: "hello", v: 1, tab: "tab-env" }));
    const rid = crypto.randomUUID();
    ws.send(JSON.stringify({ t: "new_chat", rid, project, uuid: rid, text: "hello", picks: { model: null, effort: null, mode: null }, uploads: [] }));
    await until(() => frames.some((f) => f.t === "ack" && f.rid === rid), 15_000, "the new chat's ack");
    const chat = frames.find((f) => f.t === "ack" && f.rid === rid)!.result.chat as string;
    await until(() => frames.some((f) => f.t === "chats" && f.delta?.chat === chat && f.delta.state === "idle"), 15_000, "the turn's end");
    expect(fake.trace().some((l) => l.t === "user")).toBe(true);

    const r = await fetch(`${OWN}/api/restart`, { method: "POST", headers: gate, body: JSON.stringify({ when: "finish" }) });
    expect(r.status).toBe(202);
    expect(await proc.exited).toBe(0);
    await read;
    const m = /kitespan restarted as process (\d+);/.exec(out);
    expect(m).not.toBeNull();
    successor = Number(m![1]);
    expect(ours(successor)).toBe(true);
    let epoch1: string | null = null;
    for (const end = Date.now() + 15_000; Date.now() < end && (epoch1 === null || epoch1 === epoch0); await Bun.sleep(100)) epoch1 = await health();
    expect(epoch1).not.toBeNull();
    expect(epoch1).not.toBe(epoch0);
    expect(err).not.toContain("the restart did not happen");

    const names = (kind: string) => readFileSync(join(wrap, `${kind}.names`), "utf8").split("\n").filter(Boolean);
    expect(existsSync(join(wrap, "check.names"))).toBe(true);
    // The preflight runs Bun itself with the start's copy: exactly the start's names.
    expect(names("check")).toEqual(START);
    // The successor goes through bin/kitespan, whose /bin/sh adds only its own names.
    const shellOwn = new Set(SHELL_OWN_ENV_NAMES);
    expect(names("start").filter((k) => !shellOwn.has(k))).toEqual(START);
    for (const k of SDK_OWN) {
      expect(names("check")).not.toContain(k);
      expect(names("start")).not.toContain(k);
    }
    ws.close();
  },
  60_000,
);
