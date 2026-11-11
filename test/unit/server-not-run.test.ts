// End to end, a `!` command that never runs (the `bash` event's `not_run`, D3, DESIGN.md 6.3): the real server
// (server/main.ts) as its own process on a free port of 127.0.0.1, with scratch HOME, CLAUDE_CONFIG_DIR and XDG folders
// and the fake claude first on PATH (the real claude never runs). With one live chat at most, a `!` command on a
// sleeping chat waits for a slot behind a chat whose turn runs; then the claude on PATH can no longer run, and the slot
// frees, so the start fails. The page keeps the command's row as Not run, the free-slot line goes, the command is back
// in the empty box, and a page after a reload and after a restart draws the row where it was.
//
// The tests run in order and share the server's lives.

import type { Subprocess } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ERROR_MESSAGES, type ChatEvent } from "../../shared/protocol";
import { CAP_NOTICE } from "../../server/chats/registry";
import { installFakeClaude, loadFixture, type Fixture } from "../fake-claude/install";
import { LINUX_ONLY, PROCFS } from "../linux";
import { freePort } from "./free-port";

const ROOT = resolve(import.meta.dir, "..", "..");
const MAIN = join(ROOT, "server", "main.ts");
const PORT = freePort();
const OWN = `http://127.0.0.1:${PORT}`;
const T = 30_000;
const COMMAND = "echo e2e-not-run";
const HELLO_REPLY = "Hello! How can I help you today?";

const text = loadFixture("text-thinking");
const fixture: Fixture = {
  transcript: true,
  onStart: text.onStart,
  turnsByText: {
    hello: text.turns![0]!,
    // A turn that holds the only slot until a page stops it.
    "hold the slot": { steps: [{ sleep: 30_000 }, { emit: { type: "result", subtype: "success", result: "Too late." } }] },
  },
};
const fake = installFakeClaude(fixture);
const PROJECT = fake.project;
const HOME = join(fake.root, "home");
const CONFIG = join(HOME, ".claude");
const STATE = join(fake.root, "state");
const DIST = join(fake.root, "dist");
for (const d of [HOME, STATE, join(fake.root, "config"), join(fake.root, "tmp"), DIST]) mkdirSync(d, { recursive: true });
writeFileSync(join(DIST, "index.html"), "<!doctype html><html><body>kitespan page</body></html>");

/** The PATH after the fake's folder: with the fake not runnable, nothing else may be found there. */
const SYSTEM_PATH = "/usr/bin:/bin";
const ENV: Record<string, string> = {
  PATH: `${fake.binDir}:${SYSTEM_PATH}`,
  HOME,
  CLAUDE_CONFIG_DIR: CONFIG,
  XDG_STATE_HOME: STATE,
  XDG_CONFIG_HOME: join(fake.root, "config"),
  TMPDIR: join(fake.root, "tmp"),
  SHELL: "/bin/sh",
};

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
function liveFakes(): number[] {
  return readdirSync("/proc")
    .filter((n) => /^\d+$/.test(n))
    .map(Number)
    .filter((pid) => cmdline(pid).includes(fake.fixturePath));
}
async function until(pred: () => boolean, ms = 10_000, what = "a condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
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
    if (proc.exitCode !== null || Date.now() > end) throw new Error(`the server did not start (exit ${proc.exitCode})`);
    await Bun.sleep(50);
  }
  return r;
}

/** Stop the server by its pid with SIGTERM, after kill -0 and a check that the pid is still this server. */
async function stop(r: Running): Promise<number> {
  const pid = r.proc.pid;
  if (r.proc.exitCode === null && alive(pid) && cmdline(pid).includes(MAIN)) process.kill(pid, "SIGTERM");
  return await r.proc.exited;
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
    return new Promise((ok, no) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { origin: OWN } });
      const c = new Client(ws);
      ws.onopen = () => ok(c);
      ws.onerror = () => no(new Error("the socket did not open"));
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
  evs(chat: string, from = 0): ChatEvent[] {
    return this.frames.slice(from).filter((f) => f.t === "ev" && f.chat === chat).map((f) => f.e as ChatEvent);
  }
  close(): void {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}

const clients: Client[] = [];
async function page(tab: string): Promise<Client> {
  const c = await Client.open();
  clients.push(c);
  c.send({ t: "hello", v: 1, tab });
  await c.waitFor((f) => f.t === "chats" && "list" in f);
  return c;
}
/** Attach, and what the page gets for the chat: the attached frame, the snapshot's history, then the tail after it. */
async function attach(c: Client, chat: string): Promise<{ attached: Frame; history: ChatEvent[]; tail: ChatEvent[] }> {
  const from = c.frames.length;
  c.send({ t: "attach", chat, since: 0, epoch: null });
  const attached = await c.waitFor((f) => f.t === "attached" && f.chat === chat, 10_000, from);
  const snapshot = await c.waitFor((f) => f.t === "snapshot" && f.chat === chat, 10_000, from);
  // The tail goes out right after the snapshot, in the same burst.
  await Bun.sleep(300);
  return { attached, history: snapshot.history as ChatEvent[], tail: c.evs(chat, from) };
}
const rid = () => crypto.randomUUID();

/**
 * What a page shows of a chat's events, as short lines in order: the messages, the replies, the `!` rows with their
 * last state, and the server's lines; an event with an id replaces the earlier one, and `taken_back` removes its row.
 */
function shown(events: readonly ChatEvent[]): string[] {
  const rows = new Map<string, string>();
  events.forEach((e, i) => {
    if (e.k === "user") rows.set(e.uuid, `user ${e.text}`);
    else if (e.k === "block" && e.kind === "text") rows.set(e.key, `reply ${e.text}`);
    else if (e.k === "bash") rows.set(e.uuid, `bash ${e.state} ${e.input}`);
    else if (e.k === "notice") rows.set(e.id ?? `notice-${i}`, `line ${e.text}`);
    else if (e.k === "taken_back") rows.delete(e.uuid);
  });
  return [...rows.values()];
}

let server: Running | null = null;
afterAll(async () => {
  chmodSync(fake.bin, 0o755);
  for (const c of clients) c.close();
  if (server) await stop(server);
  for (const pid of PROCFS ? liveFakes() : []) if (cmdline(pid).includes(fake.fixturePath)) process.kill(pid, "SIGKILL");
  fake.cleanup();
});

describe.skipIf(!PROCFS)(`a \`!\` command whose chat's start fails after it waited for a slot ${LINUX_ONLY}`, () => {
  let chat = "";
  let cmd = "";

  test(
    "live: the row stays as Not run, the free-slot line goes, the start's failure is the one line, and the command is back in the box",
    async () => {
      // With the fake not runnable, nothing on the rest of the PATH may answer as claude (never the real one).
      expect(Bun.which("claude", { PATH: SYSTEM_PATH })).toBeNull();
      server = await boot();
      const added = await fetch(`${OWN}/api/projects`, { method: "POST", headers: { "x-kitespan": "1", "content-type": "application/json", origin: OWN }, body: JSON.stringify({ cwd: PROJECT }) });
      const projectId = ((await added.json()) as { project: { id: string } }).project.id;
      const cap = await fetch(`${OWN}/api/settings`, { method: "POST", headers: { "x-kitespan": "1", "content-type": "application/json", origin: OWN }, body: JSON.stringify({ "chats.maxLive": 1 }) });
      expect(cap.status).toBe(200);
      const P = await page("tab-a");
      const newChat = async (words: string) => (await P.request({ t: "new_chat", rid: rid(), project: projectId, uuid: rid(), text: words, picks: { model: null, effort: null, mode: null }, uploads: [] })).result.chat as string;

      // The chat's first turn, then the page leaves it, so it may sleep.
      chat = await newChat("hello there");
      await attach(P, chat);
      await P.waitFor((f) => f.t === "ev" && f.chat === chat && f.e.k === "turn_end", 15_000);
      P.send({ t: "detach", chat });
      // Another chat takes the only slot, and its turn holds it: the first chat sleeps.
      const busy = await newChat("hold the slot");
      await until(() => liveFakes().length === 1, 10_000, "the first chat's Claude Code to end");

      // The page comes back to the sleeping chat and runs a command: it waits for the slot.
      const from = P.frames.length;
      await attach(P, chat);
      cmd = rid();
      expect(await P.request({ t: "bash", rid: cmd, chat, input: COMMAND, draftRev: null, uploads: [] })).toMatchObject({ ok: true, result: null });
      const line = (await P.waitFor((f) => f.t === "ev" && f.chat === chat && f.e.k === "notice", 5_000, from)).e;
      expect(line).toEqual({ k: "notice", text: CAP_NOTICE, id: expect.any(String) });
      expect(shown(P.evs(chat, from)).slice(-2)).toEqual([`bash queued ${COMMAND}`, `line ${CAP_NOTICE}`]);

      // The claude on PATH can no longer run, and Stop and archive frees the slot: the chat's start fails.
      chmodSync(fake.bin, 0o644);
      expect((await P.request({ t: "archive", rid: rid(), chat: busy, on: true, stop: true }, 20_000)).ok).toBe(true);
      await P.waitFor((f) => f.t === "ev" && f.chat === chat && f.e.k === "bash" && f.e.state === "not_run", 15_000, from);
      await P.waitFor((f) => f.t === "draft" && f.chat === chat && f.text === COMMAND, 5_000, from);
      const live = P.evs(chat, from);
      expect(live.filter((e) => e.k === "taken_back")).toEqual([{ k: "taken_back", uuid: line.id }]);
      expect(live.filter((e) => e.k === "bash")).toEqual([
        { k: "bash", uuid: cmd, input: COMMAND, state: "queued", stdout: "", stderr: "", code: null, ms: null, timedOut: false, capped: false },
        { k: "bash", uuid: cmd, input: COMMAND, state: "not_run", stdout: "", stderr: "", code: null, ms: null, timedOut: false, capped: false },
      ]);
      expect(shown(live).slice(-2)).toEqual([`bash not_run ${COMMAND}`, `line ${ERROR_MESSAGES.no_claude}`]);
      expect(P.frames.filter((f) => f.t === "draft" && f.chat === chat).at(-1)).toMatchObject({ text: COMMAND, mode: "bash" });
      expect(liveFakes()).toEqual([]);
    },
    T,
  );

  test(
    "a reload draws the row once as Not run, after the chat's reply, with no free-slot line",
    async () => {
      const Q = await page("tab-reload");
      const { history, tail } = await attach(Q, chat);
      const view = shown([...history, ...tail]);
      expect(view.filter((l) => l.startsWith("user") || l.startsWith("reply") || l.startsWith("bash"))).toEqual(["user hello there", `reply ${HELLO_REPLY}`, `bash not_run ${COMMAND}`]);
      expect(view).not.toContain(`line ${CAP_NOTICE}`);
      expect(history.filter((e) => e.k === "bash").map((e) => (e as { uuid: string }).uuid)).toEqual([cmd]);
    },
    T,
  );

  test(
    "after a restart the row is where it was, from the server's notes, and the command is still in the box",
    async () => {
      chmodSync(fake.bin, 0o755);
      expect(await stop(server!)).toBe(0);
      server = await boot();
      expect(existsSync(join(STATE, "kitespan", "notes", `${chat}.json`))).toBe(true);
      const R = await page("tab-after");
      const { attached, history, tail } = await attach(R, chat);
      expect(attached).toMatchObject({ state: "sleeping", draft: { text: COMMAND, mode: "bash" } });
      expect(shown(history)).toEqual(["user hello there", `reply ${HELLO_REPLY}`, `bash not_run ${COMMAND}`]);
      expect(history.at(-1)).toMatchObject({ k: "bash", uuid: cmd, state: "not_run" });
      expect(tail.filter((e) => e.k === "bash" || e.k === "notice")).toEqual([]);
      // Nothing starts Claude Code to read a history.
      expect(liveFakes()).toEqual([]);
    },
    T,
  );
});
