// D60 end to end (build checklist E1, E3, E5, E7, G2; the local half of done check 8): bin/kitespan starts the real
// server on a free port of 127.0.0.1 with the fake claude first on PATH. A project's variables are saved through the
// API, and a chat's first message starts the fake, whose start trace holds its variables' names and a SHA-256 of one
// variable, never a value. The names are the clean start's, the SDK's added ones and the environment's. A project
// whose variables file failed its check at boot starts nothing (`env_unreadable`). The planted value is in no answer,
// no frame, no log, no line the server printed, and not in last-options.json. The real claude never runs. It runs on
// macOS too: where /proc cannot be read, the server is stopped through the test's own handle.

import type { Subprocess } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SDK_CHILD_ENV } from "../../server/agents/claude/options";
import { installFakeClaude, loadFixture, SHELL_OWN_ENV_NAMES, type TraceLine } from "../fake-claude/install";
import { PROCFS } from "../linux";
import { freePort } from "../unit/free-port";

const ROOT = resolve(import.meta.dir, "..", "..");
const SCRIPT = join(ROOT, "bin", "kitespan");
const MAIN = join(ROOT, "server", "main.ts");
const PORT = freePort();
const OWN = `http://127.0.0.1:${PORT}`;
const T = 40_000;
const NAME = "KITESPAN_DC8_LOCAL";
const SECRET = "planted-env-start-value-Dc8x";
const BROKEN = "brokenenvq";

const fake = installFakeClaude({ ...loadFixture("text-thinking"), envHash: [NAME] });
const HOME = join(fake.root, "home");
const DIST = join(fake.root, "dist");
const STATE = join(fake.root, "state");
const KITESPAN_STATE = join(STATE, "kitespan");
const BROKEN_FOLDER = join(fake.root, "broken-project");
for (const d of [HOME, STATE, join(fake.root, "config"), join(fake.root, "tmp"), DIST, BROKEN_FOLDER]) mkdirSync(d, { recursive: true });
writeFileSync(join(DIST, "index.html"), "<!doctype html><html><body>kitespan page</body></html>");

// Before the boot: a project whose variables file fails its check.
mkdirSync(join(KITESPAN_STATE, "env"), { recursive: true, mode: 0o700 });
chmodSync(KITESPAN_STATE, 0o700);
const at = "2026-11-03T08:00:00.000Z";
writeFileSync(
  join(KITESPAN_STATE, "projects.json"),
  JSON.stringify({ v: 1, projects: [{ id: BROKEN, cwd: BROKEN_FOLDER, name: "broken", createdAt: at, lastUsedAt: at, picks: { model: null, effort: null, permissionMode: null } }] }),
  { mode: 0o600 },
);
writeFileSync(join(KITESPAN_STATE, "env", `${BROKEN}.json`), `{"v":1,"id":"${BROKEN}","vars":[{"name":"PATH","value":"x","at":"${at}"}]}`, { mode: 0o600 });

const KEEP: Record<string, string> = {
  PATH: `${fake.binDir}:${dirname(process.execPath)}:/usr/bin:/bin`,
  HOME,
  CLAUDE_CONFIG_DIR: join(HOME, ".claude"),
  XDG_STATE_HOME: STATE,
  XDG_CONFIG_HOME: join(fake.root, "config"),
  TMPDIR: join(fake.root, "tmp"),
  SHELL: "/bin/sh",
};

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
/** Every API answer's text. */
const answers: string[] = [];

afterAll(async () => {
  try {
    ws?.close();
  } catch {}
  // Only the server this test started, by its pid, after kill -0 and a check of its command line (where /proc can be
  // read; else through the test's own handle, while it has not exited): its shutdown closes every chat's Claude Code
  // (the fake).
  if (server && server.exitCode === null && server.signalCode === null && alive(server.pid)) {
    if (!PROCFS) server.kill("SIGTERM");
    else if (cmdline(server.pid).includes(MAIN)) process.kill(server.pid, "SIGTERM");
  }
  if (server) await Promise.race([server.exited, Bun.sleep(15_000)]);
  fake.cleanup();
});

async function boot(): Promise<void> {
  server = Bun.spawn(["/bin/sh", SCRIPT, "--port", String(PORT), "--dist", DIST], { env: KEEP, cwd: fake.root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
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

const SENDER = { "x-kitespan": "1", "content-type": "application/json", origin: OWN };
async function api(path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${OWN}${path}`, body === undefined ? { headers: { origin: OWN } } : { method: "POST", headers: SENDER, body: JSON.stringify(body) });
  const text = await res.text();
  answers.push(text);
  return { status: res.status, json: JSON.parse(text) };
}

type Frame = Record<string, any>;
function socket(): Promise<{ frames: Frame[]; raw: string[]; send: (f: Frame) => void; waitFor: (p: (f: Frame) => boolean) => Promise<Frame> }> {
  return new Promise((resolveOpen, reject) => {
    const frames: Frame[] = [];
    const raw: string[] = [];
    const s = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { origin: OWN } });
    ws = s;
    s.onmessage = (m) => {
      if (typeof m.data !== "string") return;
      raw.push(m.data);
      frames.push(JSON.parse(m.data) as Frame);
    };
    s.onerror = () => reject(new Error("the socket did not open"));
    s.onopen = () =>
      resolveOpen({
        frames,
        raw,
        send: (f) => s.send(JSON.stringify(f)),
        async waitFor(p) {
          const end = Date.now() + 15_000;
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

/** Every file under `dir`, as text. */
function filesUnder(dir: string): { path: string; text: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .map((path) => ({ path, text: readFileSync(path, "latin1") }));
}

describe("D60 end to end", () => {
  test(
    "the chat's Claude Code gets the environment's variables; an unreadable environment starts nothing; the value shows nowhere",
    async () => {
      await boot();
      expect(out).toContain(`env/${BROKEN}.json`);
      const added = await api("/api/projects", { cwd: fake.project });
      expect(added.status).toBe(201);
      const project = added.json.project.id as string;
      expect(added.json.project.env).toBe(0);

      const saved = await api(`/api/projects/${project}/env`, { set: [{ name: NAME, value: SECRET }], remove: [] });
      expect(saved).toMatchObject({ status: 200, json: { vars: [{ name: NAME, inSettings: false }], unreadable: false } });
      expect((await api(`/api/projects/${project}/env`)).json.vars.map((v: { name: string }) => v.name)).toEqual([NAME]);
      expect((await api("/api/projects")).json.projects.find((p: { id: string }) => p.id === project).env).toBe(1);
      expect((await api(`/api/projects/${BROKEN}/env`)).json).toEqual({ vars: [], unreadable: true });

      const page = await socket();
      page.send({ t: "hello", v: 1, tab: "tab-env-start" });
      expect((await page.waitFor((f) => f.t === "welcome")).claude.ok).toBe(true);
      const rid = crypto.randomUUID();
      page.send({ t: "new_chat", rid, project, uuid: crypto.randomUUID(), text: "hello there", picks: { model: null, effort: null, mode: null }, uploads: [] });
      const made = await page.waitFor((f) => f.t === "ack" && f.rid === rid);
      expect(made.ok).toBe(true);
      page.send({ t: "attach", chat: made.result.chat, since: 0, epoch: null });

      const start = await fake.waitFor((l: TraceLine) => l.t === "start", 15_000);
      expect((start.envHashes as Record<string, string>)[NAME]).toBe(new Bun.CryptoHasher("sha256").update(SECRET).digest("hex"));
      const names = start.envNames as string[];
      // The clean start's names, then the SDK's three added names and the environment's: none of the SDK's host names
      // (the start environment was copied before the SDK loaded).
      for (const n of Object.keys(KEEP)) expect(names).toContain(n);
      const extra = names.filter((n) => !(n in KEEP) && !SHELL_OWN_ENV_NAMES.includes(n)).sort();
      expect(extra).toEqual([...SDK_CHILD_ENV.added, NAME].sort());

      // The unreadable environment: New chat refuses, and makes no chat.
      const rid2 = crypto.randomUUID();
      page.send({ t: "new_chat", rid: rid2, project: BROKEN, uuid: crypto.randomUUID(), text: "hi", picks: { model: null, effort: null, mode: null }, uploads: [] });
      const refused = await page.waitFor((f) => f.t === "ack" && f.rid === rid2);
      expect(refused).toMatchObject({ ok: false, error: { code: "env_unreadable" } });

      // last-options.json keeps names only (G2).
      const last = readFileSync(join(KITESPAN_STATE, "last-options.json"), "utf8");
      expect(JSON.parse(last).options.env).toEqual({ "[inherited]": true, [NAME]: "[set]" });

      // Nowhere: the API's answers, the frames, the server's own lines, its logs and every file of the state folder
      // except the environment's own, and the fake's trace.
      await page.waitFor((f) => (f.t === "ev" && f.e?.k === "turn_end") || (f.t === "snapshot" && JSON.stringify(f).includes('"turn_end"')));
      for (const a of answers) expect(a).not.toContain(SECRET);
      for (const f of page.raw) expect(f).not.toContain(SECRET);
      expect(out).not.toContain(SECRET);
      const files = filesUnder(KITESPAN_STATE).filter((f) => !f.path.startsWith(join(KITESPAN_STATE, "env")));
      expect(files.some((f) => f.path.endsWith("last-options.json"))).toBe(true);
      expect(files.some((f) => f.path.includes(`${join(KITESPAN_STATE, "logs")}`))).toBe(true);
      for (const f of files) expect(f.text).not.toContain(SECRET);
      expect(readFileSync(fake.tracePath, "utf8")).not.toContain(SECRET);
      // The environment's own file holds it, 0600 in a 0700 folder.
      expect(readFileSync(join(KITESPAN_STATE, "env", `${project}.json`), "utf8")).toContain(SECRET);
    },
    T,
  );
});
