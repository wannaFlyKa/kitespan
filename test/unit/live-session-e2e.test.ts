// D58 end to end: the real server (server/main.ts) as its own process on a free port of 127.0.0.1, with a scratch
// HOME and CLAUDE_CONFIG_DIR, the fake claude first on PATH (the real claude never runs), a transcript that "the
// terminal" has open (a `sleep` process stands in for it, with a record in the scratch registry of running sessions),
// and Bun clients as the page. By default the list leaves the session out (row 77); with Settings > Chats > Show
// sessions open in another app on, the session list and the preview mark the session; Continue in a copy makes a chat on a
// fork (a new session id that the fake claude then resumes) and the terminal's transcript stays as it was; the record
// of kitespan's own claude process never counts. A record that opens the copy's session elsewhere makes kitespan give
// it up (row 78): its turn finishes, its claude process ends, a queued message waits, a send is refused and a page that
// opens the chat starts nothing; when that process ends, the chat's history holds the other app's turn and the queued
// message goes on a new process that resumes the session.
//
// The tests run in order and share one server; each depends on the ones before it.
import type { Subprocess } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Fixture, TraceLine } from "../fake-claude/install";
import { installFakeClaude } from "../fake-claude/install";
import { LINUX_ONLY, PROCFS } from "../linux";
import { freePort } from "./free-port";

const ROOT = resolve(import.meta.dir, "..", "..");
const MAIN = join(ROOT, "server", "main.ts");
const PORT = freePort();
const OWN = `http://127.0.0.1:${PORT}`;
const T = 40_000;

const fixture: Fixture = {
  transcript: true,
  turnsByText: {
    hello: { steps: [{ say: { id: "msg_copy_1", text: "Hello from the copy." } }, { emit: { type: "result", subtype: "success", result: "Hello from the copy." } }] },
    // Row 78: a turn long enough for the registry's 2 s check to see the other app while it runs.
    slow: { steps: [{ sleep: 6_000 }, { say: { id: "msg_slow_1", text: "The slow answer." } }, { emit: { type: "result", subtype: "success", result: "The slow answer." } }] },
    after: { steps: [{ say: { id: "msg_after_1", text: "Back in kitespan." } }, { emit: { type: "result", subtype: "success", result: "Back in kitespan." } }] },
  },
};
const fake = installFakeClaude(fixture);
const PROJECT = fake.project;
const HOME = join(fake.root, "home");
const CONFIG = join(HOME, ".claude");
const SESSIONS = join(CONFIG, "sessions");
const STATE = join(fake.root, "state");
const DIST = join(fake.root, "dist");
for (const d of [HOME, STATE, join(fake.root, "config"), join(fake.root, "tmp"), DIST, SESSIONS]) mkdirSync(d, { recursive: true });
writeFileSync(join(DIST, "index.html"), "<!doctype html><html><body>kitespan page</body></html>");

const ENV: Record<string, string> = {
  PATH: `${fake.binDir}:/usr/bin:/bin`,
  HOME,
  ZDOTDIR: HOME,
  CLAUDE_CONFIG_DIR: CONFIG,
  XDG_STATE_HOME: STATE,
  XDG_CONFIG_HOME: join(fake.root, "config"),
  TMPDIR: join(fake.root, "tmp"),
  SHELL: "/bin/sh",
};

// The terminal's session: a transcript in the project's folder, written by "the CLI" (entrypoint cli).
const TERMINAL = "5e1c2d3a-4b5c-4d6e-8f70-8192a3b4c5d6";
const transcriptOf = (sid: string) => join(CONFIG, "projects", PROJECT.replace(/[^a-zA-Z0-9]/g, "-"), `${sid}.jsonl`);
{
  const rows = [
    { type: "user", uuid: "dddddddd-0000-4000-8000-000000000001", message: { role: "user", content: "Ledger loop in the terminal" } },
    { type: "assistant", uuid: "dddddddd-0000-4000-8000-000000000002", message: { id: "msg_t1", type: "message", role: "assistant", model: "claude-fake-1", content: [{ type: "text", text: "The loop runs." }] } },
  ];
  let parent: string | null = null;
  let out = "";
  rows.forEach((r, i) => {
    out += JSON.stringify({ ...r, parentUuid: parent, sessionId: TERMINAL, timestamp: new Date(Date.UTC(2026, 10, 1, 12, 0, i)).toISOString(), cwd: PROJECT, isSidechain: false, userType: "external", entrypoint: "cli", version: "2.1.311" }) + "\n";
    parent = r.uuid;
  });
  mkdirSync(join(CONFIG, "projects", PROJECT.replace(/[^a-zA-Z0-9]/g, "-")), { recursive: true });
  writeFileSync(transcriptOf(TERMINAL), out);
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
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
function startOf(pid: number): string {
  const s = readFileSync(`/proc/${pid}/stat`, "utf8");
  return s.slice(s.lastIndexOf(")") + 2).split(" ")[19]!;
}
const sleepers: Subprocess[] = [];
function sleeper(): number {
  const p = Bun.spawn(["sleep", "300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  sleepers.push(p);
  return p.pid;
}
function stopSleeper(pid: number): void {
  if (alive(pid) && (cmdline(pid)[0] ?? "").endsWith("sleep")) process.kill(pid, "SIGTERM");
}
/** A record as Claude Code writes one in its registry of running sessions. */
function register(pid: number, sessionId: string, entrypoint: string, status = "idle"): void {
  writeFileSync(
    join(SESSIONS, `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd: PROJECT, startedAt: Date.now(), procStart: startOf(pid), version: "2.1.311", kind: "interactive", entrypoint, status, updatedAt: Date.now() }),
  );
}

interface Running {
  proc: Subprocess<"ignore", "pipe", "pipe">;
  out: string;
  err: string;
}
async function boot(): Promise<Running> {
  const proc = Bun.spawn([process.execPath, "--no-env-file", MAIN, "--port", String(PORT), "--dist", DIST], { env: ENV, cwd: fake.root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const r: Running = { proc, out: "", err: "" };
  const read = async (s: ReadableStream<Uint8Array>, key: "out" | "err") => {
    const dec = new TextDecoder();
    for await (const c of s) r[key] += dec.decode(c, { stream: true });
  };
  void read(proc.stdout, "out");
  void read(proc.stderr, "err");
  const end = Date.now() + 15_000;
  while (!r.out.includes(`kitespan listens on ${OWN}`)) {
    if (proc.exitCode !== null || Date.now() > end) throw new Error(`the server did not start (exit ${proc.exitCode}): ${r.err}`);
    await Bun.sleep(50);
  }
  return r;
}
async function stop(r: Running): Promise<void> {
  const pid = r.proc.pid;
  if (r.proc.exitCode === null && alive(pid) && cmdline(pid).includes(MAIN)) process.kill(pid, "SIGTERM");
  await r.proc.exited;
}
/** The fake claude processes alive now (their command line names this test's fixture file). */
function liveFakes(): number[] {
  return readdirSync("/proc")
    .filter((n) => /^\d+$/.test(n))
    .map(Number)
    .filter((pid) => cmdline(pid).includes(fake.fixturePath));
}

type Frame = Record<string, any>;
class Client {
  readonly frames: Frame[] = [];
  private constructor(readonly ws: WebSocket) {
    ws.onmessage = (m) => {
      if (typeof m.data === "string") this.frames.push(JSON.parse(m.data) as Frame);
    };
  }
  static open(): Promise<Client> {
    return new Promise((res, rej) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { origin: OWN } });
      const c = new Client(ws);
      ws.onopen = () => res(c);
      ws.onerror = () => rej(new Error("the socket did not open"));
    });
  }
  send(o: unknown): void {
    this.ws.send(JSON.stringify(o));
  }
  async waitFor(pred: (f: Frame) => boolean, ms = 10_000, from = 0): Promise<Frame> {
    const end = Date.now() + ms;
    for (;;) {
      const hit = this.frames.slice(from).find(pred);
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`timed out; frames: ${this.frames.slice(from).map((f) => (f.t === "ev" ? `ev:${f.e.k}` : f.t)).join(", ")}`);
      await Bun.sleep(20);
    }
  }
  async request(f: Frame, ms?: number): Promise<Frame> {
    const from = this.frames.length;
    this.send(f);
    return this.waitFor((x) => x.t === "ack" && x.rid === f.rid, ms, from);
  }
  close(): void {
    try {
      this.ws.close();
    } catch {}
  }
}

const rid = () => crypto.randomUUID();
const getJson = async (path: string): Promise<any> => (await fetch(`${OWN}${path}`)).json();
const starts = (): TraceLine[] => fake.trace().filter((l) => l.t === "start");
function argOf(line: TraceLine, name: string): string | null {
  const args = line.args as string[];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1] ?? null;
    if (args[i]!.startsWith(`${name}=`)) return args[i]!.slice(name.length + 1);
  }
  return null;
}

let server: Running | null = null;
let page: Client | null = null;

afterAll(async () => {
  page?.close();
  if (server) await stop(server);
  for (const pid of PROCFS ? liveFakes() : []) if (cmdline(pid).includes(fake.fixturePath)) process.kill(pid, "SIGKILL");
  for (const p of sleepers) stopSleeper(p.pid);
  fake.cleanup();
});

describe.skipIf(!PROCFS)(`a session that is open in the terminal (D58), on the real server ${LINUX_ONLY}`, () => {
  let projectId = "";
  let terminalPid = 0;
  let chat = "";
  let copy = "";
  const original = readFileSync(transcriptOf(TERMINAL));

  test(
    "the session list and the preview mark the session that the terminal has open, busy while it is",
    async () => {
      terminalPid = sleeper();
      register(terminalPid, TERMINAL, "cli", "busy");
      server = await boot();
      const added = await fetch(`${OWN}/api/projects`, { method: "POST", headers: { "x-kitespan": "1", "content-type": "application/json", origin: OWN }, body: JSON.stringify({ cwd: PROJECT }) });
      expect(added.status).toBe(201);
      projectId = ((await added.json()) as { project: { id: string } }).project.id;
      // Row 77: by default a session open in another app is left out of the list, and its preview says so.
      expect(await getJson(`/api/projects/${projectId}/sessions`)).toEqual({ sessions: [], hiddenOpen: [TERMINAL] });
      expect(await getJson(`/api/projects/${projectId}/sessions/${TERMINAL}`)).toMatchObject({ history: [], hidden: "open" });
      // Settings > Chats > Show sessions open in another app, on: it shows, marked (D58).
      const saved = await fetch(`${OWN}/api/settings`, { method: "POST", headers: { "x-kitespan": "1", "content-type": "application/json", origin: OWN }, body: JSON.stringify({ "chats.sessionsOpenElsewhere": true }) });
      expect(saved.status).toBe(200);
      const list = await getJson(`/api/projects/${projectId}/sessions`);
      expect(list.sessions).toEqual([{ sessionId: TERMINAL, title: "Ledger loop in the terminal", lastModified: expect.any(Number), open: { app: "terminal", busy: true } }]);
      const preview = await getJson(`/api/projects/${projectId}/sessions/${TERMINAL}`);
      expect(preview).toMatchObject({ chat: null, open: { app: "terminal", busy: true } });
    },
    T,
  );

  test(
    "Continue in a copy: a chat on a fork with the copy's title, which the fake claude resumes; the terminal's transcript is untouched",
    async () => {
      page = await Client.open();
      page.send({ t: "hello", v: 1, tab: "tab-live" });
      await page.waitFor((f) => f.t === "chats" && "list" in f);
      // A plain Continue here (a preview read before the terminal opened it) is refused, and nothing resumes it (W19d).
      const here = await page.request({ t: "continue_session", rid: rid(), project: projectId, session: TERMINAL });
      expect(here).toMatchObject({ ok: false, error: { code: "session_open" } });
      expect(starts()).toHaveLength(0);
      const ack = await page.request({ t: "continue_session", rid: rid(), project: projectId, session: TERMINAL, fork: true });
      expect(ack.ok).toBe(true);
      chat = ack.result.chat;
      const row = await page.waitFor((f) => f.t === "chats" && f.delta?.chat === chat && "title" in f.delta);
      expect(row.delta.title).toBe("Copy of Ledger loop in the terminal");
      // The preview of the original now offers the copy (W19d).
      expect(await getJson(`/api/projects/${projectId}/sessions/${TERMINAL}`)).toMatchObject({ chat: null, copy: chat, open: { app: "terminal", busy: true } });

      page.send({ t: "attach", chat, since: 0, epoch: null });
      const snap = await page.waitFor((f) => f.t === "snapshot" && f.chat === chat);
      expect(snap.history.filter((e: Frame) => e.k === "user").map((e: Frame) => e.text)).toEqual(["Ledger loop in the terminal"]);

      const id = rid();
      expect((await page.request({ t: "send", rid: id, chat, uuid: id, text: "hello", draftRev: null, uploads: [] })).ok).toBe(true);
      await page.waitFor((f) => f.t === "ev" && f.chat === chat && f.e.k === "turn_end", 15_000);
      expect(starts()).toHaveLength(1);
      copy = argOf(starts()[0]!, "--resume") ?? "";
      expect(copy).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(copy).not.toBe(TERMINAL);
      expect(argOf(starts()[0]!, "--session-id")).toBeNull();
      // The fake wrote the copy's turn under the copy's id; the terminal's file is as it was, byte for byte.
      expect(readFileSync(transcriptOf(copy), "utf8")).toContain("Hello from the copy.");
      expect(readFileSync(transcriptOf(TERMINAL)).equals(original)).toBe(true);
      // The original stays the terminal's: still listed, still marked; the copy is the chat's, so it is not listed.
      await Bun.sleep(2_100);
      const list = await getJson(`/api/projects/${projectId}/sessions`);
      expect(list.sessions.map((s: Frame) => [s.sessionId, s.open?.app ?? null])).toEqual([[TERMINAL, "terminal"]]);
    },
    T,
  );

  test(
    "the record of kitespan's own claude process never counts; another process on the copy's session: kitespan's turn finishes, its process ends, a queued message waits and a send is refused; when that process ends the chat reads the other app's turn and sends the queued message (row 78)",
    async () => {
      const own = starts()[0]!.pid as number;
      expect(alive(own)).toBe(true);
      register(own, copy, "sdk-ts", "busy");
      await Bun.sleep(2_100);
      expect(await getJson(`/api/projects/${projectId}/sessions/${copy}`)).not.toHaveProperty("open");
      expect(page!.frames.some((f) => f.t === "chats" && f.delta?.chat === chat && "held" in f.delta)).toBe(false);

      // kitespan's own turn runs, with a message queued behind it; then the terminal opens the copy's session.
      const from = page!.frames.length;
      const slow = rid();
      expect((await page!.request({ t: "send", rid: slow, chat, uuid: slow, text: "slow", draftRev: null, uploads: [] })).ok).toBe(true);
      await page!.waitFor((f) => f.t === "ev" && f.chat === chat && f.e.k === "turn_start", 10_000, from);
      const after = rid();
      expect((await page!.request({ t: "send", rid: after, chat, uuid: after, text: "after", draftRev: null, uploads: [] })).ok).toBe(true);
      const other = sleeper();
      register(other, copy, "cli");
      const on = await page!.waitFor((f) => f.t === "chats" && f.delta?.chat === chat && "held" in f.delta, 15_000, from);
      expect(on.delta.held).toEqual({ app: "terminal", session: copy });
      // The turn is never cut: it ends as the fixture ends it, after the hold came.
      const end = await page!.waitFor((f) => f.t === "ev" && f.chat === chat && f.e.k === "turn_end", 15_000, from);
      expect(end.e.ok).toBe(true);
      expect(page!.frames.indexOf(on)).toBeLessThan(page!.frames.indexOf(end));
      expect(fake.trace().filter((l) => l.t === "turn_end").every((l) => l.interrupted === false)).toBe(true);
      // Then kitespan's claude process ends, as the idle timer would end it: no exit line, and the queued message
      // stays, Queued, never sent to that process.
      const gone = Date.now() + 15_000;
      while (alive(own) && Date.now() < gone) await Bun.sleep(50);
      expect(alive(own)).toBe(false);
      const shown = page!.frames.slice(from).filter((f) => f.t === "ev" && f.chat === chat);
      expect(shown.some((f) => f.e.k === "exit")).toBe(false);
      expect(shown.some((f) => f.e.k === "taken_back" && f.e.uuid === after)).toBe(false);
      expect(shown.filter((f) => f.e.k === "user" && f.e.uuid === after).at(-1)?.e.queued).toBe(true);
      expect(fake.trace().some((l) => l.t === "turn_start" && l.uuid === after)).toBe(false);

      // A send now is refused with its own code; a page that opens the chat meanwhile starts no process.
      const refused = rid();
      expect(await page!.request({ t: "send", rid: refused, chat, uuid: refused, text: "hello", draftRev: null, uploads: [] })).toMatchObject({ ok: false, error: { code: "session_held" } });
      const second = await Client.open();
      second.send({ t: "hello", v: 1, tab: "tab-second" });
      const list = await second.waitFor((f) => f.t === "chats" && "list" in f);
      expect(list.list.find((r: Frame) => r.chat === chat)?.held).toEqual({ app: "terminal", session: copy });
      second.send({ t: "attach", chat, since: 0, epoch: null });
      await second.waitFor((f) => f.t === "snapshot" && f.chat === chat);
      await Bun.sleep(500);
      expect(starts()).toHaveLength(1);
      second.close();

      // The terminal writes a turn into the session, then closes it.
      const file = transcriptOf(copy);
      const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
      let parent = (JSON.parse(lines[lines.length - 1]!) as { uuid: string }).uuid;
      const rows = [
        { type: "user", uuid: rid(), message: { role: "user", content: "A note from the terminal" } },
        { type: "assistant", uuid: rid(), message: { id: "msg_t2", type: "message", role: "assistant", model: "claude-fake-1", content: [{ type: "text", text: "The terminal answered." }] } },
      ];
      for (const r of rows) {
        appendFileSync(file, JSON.stringify({ ...r, parentUuid: parent, sessionId: copy, timestamp: new Date().toISOString(), cwd: PROJECT, isSidechain: false, userType: "external", entrypoint: "cli", version: "2.1.311" }) + "\n");
        parent = r.uuid;
      }
      const next = page!.frames.length;
      stopSleeper(other);
      const off = await page!.waitFor((f) => f.t === "chats" && f.delta?.chat === chat && "held" in f.delta, 15_000, next);
      expect(off.delta.held).toBeNull();
      // The page reads the history again (the store attaches again): the terminal's turn shows.
      page!.send({ t: "attach", chat, since: 0, epoch: null });
      const snap = await page!.waitFor((f) => f.t === "snapshot" && f.chat === chat, 10_000, next);
      expect(snap.history.filter((e: Frame) => e.k === "user").map((e: Frame) => e.text)).toContain("A note from the terminal");
      // The queued message goes on a new process that resumes the session, after the terminal's turn.
      await page!.waitFor((f) => f.t === "ev" && f.chat === chat && f.e.k === "turn_end", 15_000, next);
      expect(starts()).toHaveLength(2);
      expect(argOf(starts()[1]!, "--resume")).toBe(copy);
      expect(fake.trace().some((l) => l.t === "turn_start" && l.uuid === after)).toBe(true);
      const text = readFileSync(file, "utf8");
      expect(text.indexOf("Back in kitespan.")).toBeGreaterThan(text.indexOf("The terminal answered."));
    },
    60_000,
  );
});
