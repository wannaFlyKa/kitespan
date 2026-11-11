// End to end: the real server (server/main.ts) as its own process on a free port of 127.0.0.1, with a scratch HOME,
// CLAUDE_CONFIG_DIR and XDG folders, and the fake claude of test/fake-claude/ first on PATH, so the binary pin, the
// gate and the SDK run as in production and the real claude never runs. Bun WebSocket clients drive it as two pages
// would: hello, a chat in a project, a text turn with thinking, a second viewer on one process, the shared draft
// across a restart, a message sent again to the next server (applied once), a permission card answered once, archive
// and unarchive, the Terminal pane's shell and its environment, `!` commands with Claude's reply on and off (the fake
// writes their records under ids of its own, as the CLI does), a `!` command behind a queued message drawn in one
// order live and after a reload, Stop seen alike on both pages and after a reload (the fake writes the CLI's interrupt
// line), the Origin gate, and delete (the fake writes a transcript, so deleteSession has a file to remove).
//
// The tests run in order and share one server life per restart; each depends on the ones before it.

import type { Subprocess } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EPOCH } from "../../shared/ids";
import { PROTOCOL_VERSION, type ChatEvent } from "../../shared/protocol";
import { installFakeClaude, loadFixture, type Fixture, type TraceLine, type Turn } from "../fake-claude/install";
import { LINUX_ONLY, PROCFS } from "../linux";
import { machineName } from "../../server/machine";
import { freePort } from "./free-port";

const ROOT = resolve(import.meta.dir, "..", "..");
const MAIN = join(ROOT, "server", "main.ts");
const PORT = freePort();
const OWN = `http://127.0.0.1:${PORT}`;
const T = 30_000;
/** zsh where it exists, else bash. */
const SHELL = existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/bash";

// ---------------------------------------------------------------------------------------------------------------
// The fake claude: turns picked by the message's text, with the transcript written as the CLI writes it.

const text = loadFixture("text-thinking");
const tool = loadFixture("tool-permission");
const HELLO_REPLY = "Hello! How can I help you today?";
const done = (id: string, reply: string): Turn => ({
  steps: [{ say: { id, text: reply } }, { emit: { type: "result", subtype: "success", result: reply } }],
});
const fixture: Fixture = {
  transcript: true,
  onStart: text.onStart,
  turnsByText: {
    "list the files": tool.turns![0]!,
    // A short wait first, so the page attaches while the turn runs and draws its events live.
    hello: { steps: [{ sleep: 1_500 }, ...text.turns![0]!.steps] },
    again: text.turns![1]!,
    "after the restart": done("msg_e2e_restart", "Back after the restart."),
    // A long turn that a page stops.
    "stop me": { steps: [{ sleep: 8_000 }, ...done("msg_e2e_stop", "Too late.").steps] },
    // A long turn whose tool call runs when a page stops it (Claude Code's own line then says "for tool use").
    "stop the tool": {
      steps: [
        { say: { id: "msg_e2e_stop_tool", text: "Running the tests.", tools: [{ id: "toolu_e2e_stop", name: "Bash", input: { command: "bun test" } }] } },
        { sleep: 8_000 },
        ...done("msg_e2e_stop_tool_2", "Too late.").steps,
      ],
    },
    // A turn that a second message and a `!` command wait behind, and the second message's own turn.
    "e2e-hold-first": { steps: [{ sleep: 1_500 }, ...done("msg_e2e_hold_1", "First done.").steps] },
    "e2e-hold-second": { steps: [{ sleep: 1_000 }, ...done("msg_e2e_hold_2", "Second done.").steps] },
    // Claude's reply to a `!` record (its text holds the command): a short wait first, so a page attaches mid-reply.
    "e2e-bash-one": { steps: [{ sleep: 2_500 }, ...done("msg_e2e_bash", "It printed e2e-bash-one.").steps] },
    // The reply is in the transcript while the turn still runs, so a page that attaches now finds its blocks in the
    // snapshot's history and in the tail of the turn in flight; the keys must match for the page to draw them once.
    "mid-turn": {
      steps: [
        { say: { id: "msg_e2e_mid", thinking: "Thinking mid-turn.", text: "A reply mid-turn.", chunks: 2 } },
        { sleep: 3_000 },
        { emit: { type: "result", subtype: "success", result: "A reply mid-turn." } },
      ],
    },
  },
};
const fake = installFakeClaude(fixture);
const PROJECT = fake.project;
const HOME = join(fake.root, "home");
const CONFIG = join(HOME, ".claude");
const STATE = join(fake.root, "state");
const DIST = join(fake.root, "dist");
/** Written only if a typed command ran: the shell's `claude` is a function that leaves this mark. */
const RAN = join(fake.root, "claude-ran");
for (const d of [HOME, STATE, join(fake.root, "config"), join(fake.root, "tmp"), DIST]) mkdirSync(d, { recursive: true });
const shellRc = (prompt: string) => `PS1='${prompt}'\nclaude() { echo ran >> '${RAN}'; }\n`;
writeFileSync(join(HOME, ".zshrc"), shellRc("e2e%# "));
writeFileSync(join(HOME, ".bash_profile"), shellRc("e2e$ "));
// New environment's Suggested: one git repository under the home folder, for the walk that starts at boot.
mkdirSync(join(HOME, "code", "demo", ".git"), { recursive: true });
writeFileSync(join(DIST, "index.html"), "<!doctype html><html><body>kitespan page</body></html>");
// A torn ledger from an earlier life (a crash mid-write): the first boot sets it aside as .bad and goes on.
const TORN = join(STATE, "kitespan", "chats", "aaaaaaaaaaaaaaaaaaaa.json");
mkdirSync(join(STATE, "kitespan", "chats"), { recursive: true, mode: 0o700 });
chmodSync(join(STATE, "kitespan"), 0o700);
chmodSync(join(STATE, "kitespan", "chats"), 0o700);
writeFileSync(TORN, '{"id":"aaaaaaaaaaaaaaaaaaaa","cwd":', { mode: 0o600 });

/** As bin/kitespan would leave it: no Claude Code session's variables, and nothing of the user's own folders. */
const ENV: Record<string, string> = {
  PATH: `${fake.binDir}:/usr/bin:/bin`,
  HOME,
  ZDOTDIR: HOME,
  CLAUDE_CONFIG_DIR: CONFIG,
  XDG_STATE_HOME: STATE,
  XDG_CONFIG_HOME: join(fake.root, "config"),
  TMPDIR: join(fake.root, "tmp"),
  SHELL,
};

const transcriptOf = (sid: string) => join(CONFIG, "projects", PROJECT.replace(/[^a-zA-Z0-9]/g, "-"), `${sid}.jsonl`);
const starts = (): TraceLine[] => fake.trace().filter((l) => l.t === "start");
/** A CLI argument's value, in either form the SDK uses (`--name value` or `--name=value`), or null. */
function argOf(line: TraceLine, name: string): string | null {
  const args = line.args as string[];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1] ?? null;
    if (args[i]!.startsWith(`${name}=`)) return args[i]!.slice(name.length + 1);
  }
  return null;
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
/** The fake claude processes alive now (their command line names this test's fixture file). */
function liveFakes(): number[] {
  const out: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    if (cmdline(Number(name)).includes(fake.fixturePath)) out.push(Number(name));
  }
  return out;
}
async function until(pred: () => boolean, ms = 10_000, what = "a condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The server process

interface Running {
  proc: Subprocess<"ignore", "pipe", "pipe">;
  out: string;
  err: string;
}

async function boot(): Promise<Running> {
  const proc = Bun.spawn([process.execPath, "--no-env-file", MAIN, "--port", String(PORT), "--dist", DIST], {
    env: ENV,
    cwd: fake.root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
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

/** Stop the server by its pid with SIGTERM, after kill -0 and a check that the pid is still this server. */
async function stop(r: Running): Promise<number> {
  const pid = r.proc.pid;
  if (r.proc.exitCode === null && alive(pid) && cmdline(pid).includes(MAIN)) process.kill(pid, "SIGTERM");
  return await r.proc.exited;
}

// ---------------------------------------------------------------------------------------------------------------
// A page's socket

type Frame = Record<string, any>;

class Client {
  readonly frames: Frame[] = [];
  readonly bytes: Uint8Array[] = [];
  closed = false;

  private constructor(readonly ws: WebSocket) {
    ws.binaryType = "arraybuffer";
    ws.onmessage = (m) => {
      if (typeof m.data === "string") this.frames.push(JSON.parse(m.data) as Frame);
      else this.bytes.push(new Uint8Array(m.data as ArrayBuffer));
    };
    ws.onclose = () => {
      this.closed = true;
    };
  }

  static open(path: string, origin: string = OWN): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`, { headers: { origin } });
      const c = new Client(ws);
      ws.onopen = () => resolve(c);
      ws.onerror = () => reject(new Error("the socket did not open"));
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

  evs(chat: string, from = 0): Frame[] {
    return this.frames.slice(from).filter((f) => f.t === "ev" && f.chat === chat);
  }

  /** What the page draws for `chat` since its last attach: the snapshot's history, then the ev frames after it. */
  drawn(chat: string): ChatEvent[] {
    let at = -1;
    this.frames.forEach((f, i) => {
      if (f.t === "snapshot" && f.chat === chat) at = i;
    });
    if (at < 0) return [];
    return [...(this.frames[at]!.history as ChatEvent[]), ...this.evs(chat, at + 1).map((f) => f.e as ChatEvent)];
  }

  output(): string {
    const all = Buffer.concat(this.bytes.map((b) => Buffer.from(b))).toString("utf8");
    return all.replace(ANSI, "");
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

async function hello(tab: string): Promise<{ c: Client; welcome: Frame; list: Frame }> {
  const c = await Client.open("/ws");
  clients.push(c);
  c.send({ t: "hello", v: 1, tab });
  const welcome = await c.waitFor((f) => f.t === "welcome");
  const list = await c.waitFor((f) => f.t === "chats" && "list" in f);
  return { c, welcome, list };
}

async function attach(c: Client, chat: string): Promise<{ attached: Frame; snapshot: Frame }> {
  const from = c.frames.length;
  c.send({ t: "attach", chat, since: 0, epoch: null });
  const attached = await c.waitFor((f) => f.t === "attached" && f.chat === chat, 10_000, from);
  const snapshot = await c.waitFor((f) => f.t === "snapshot" && f.chat === chat, 10_000, from);
  return { attached, snapshot };
}

const rid = () => crypto.randomUUID();
const send = (chat: string, words: string, id = rid()) => ({ t: "send", rid: id, chat, uuid: id, text: words, draftRev: null, uploads: [] });

/** The text and thinking blocks an event list draws, by key, with their whole text. */
function blocks(events: readonly ChatEvent[]): { key: string; kind: string; text: string }[] {
  const out = new Map<string, { key: string; kind: string; text: string }>();
  for (const e of events) {
    if (e.k === "block_start") out.set(e.key, { key: e.key, kind: e.kind, text: "" });
    else if (e.k === "block_delta") out.get(e.key)!.text += e.text;
    else if (e.k === "block") out.set(e.key, { key: e.key, kind: e.kind, text: e.text });
  }
  return [...out.values()];
}
const users = (events: readonly ChatEvent[]) => events.filter((e): e is Extract<ChatEvent, { k: "user" }> => e.k === "user");
/** A page's reading of a conversation: who said what, in order, with no keys or seq. */
const reading = (events: readonly ChatEvent[]) => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    if (e.k === "user" && !seen.has(e.uuid)) {
      seen.add(e.uuid);
      out.push(`user: ${e.text}`);
    }
  }
  for (const b of blocks(events)) out.push(`${b.kind}: ${b.text}`);
  return out;
};

/** A raw upgrade request; resolves with the status of the answer. */
function rawUpgrade(path: string, origin: string | null): Promise<number> {
  const request =
    `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n` +
    (origin === null ? "" : `Origin: ${origin}\r\n`) +
    "\r\n";
  return new Promise((resolve) => {
    let out = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (timer) clearTimeout(timer);
      resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(out)?.[1] ?? 0));
    };
    void Bun.connect({
      hostname: "127.0.0.1",
      port: PORT,
      socket: {
        open(s) {
          s.write(request);
          timer = setTimeout(() => s.end(), 1_500);
        },
        data(s, d) {
          out += Buffer.from(d).toString("latin1");
          if (out.includes("\r\n\r\n")) s.end();
        },
        close: finish,
        error: finish,
      },
    });
  });
}

// ---------------------------------------------------------------------------------------------------------------

const clients: Client[] = [];
let server: Running | null = null;

afterAll(async () => {
  for (const c of clients) c.close();
  if (server) await stop(server);
  // Any fake claude still alive is this test's own (its command line names this fixture file).
  for (const pid of PROCFS ? liveFakes() : []) if (cmdline(pid).includes(fake.fixturePath)) process.kill(pid, "SIGKILL");
  fake.cleanup();
});

describe.skipIf(!PROCFS)(`the real server with the fake claude ${LINUX_ONLY}`, () => {
  let A: Client;
  let B: Client;
  let chat = "";
  let sid = "";
  let epoch1 = "";
  let projectId = "";
  let draftRev = 0;
  let firstPid = 0;
  let shellPane: Client;
  /** A message sent before the restart, which a tab may send again when it did not see the ack. */
  let sentBefore: Frame | null = null;

  test(
    "it boots on 127.0.0.1 with the fake claude pinned, and hello gets welcome and the chat list",
    async () => {
      server = await boot();
      expect(server.out).toContain(`kitespan listens on ${OWN}`);
      // The torn ledger is set aside, named on stderr, and no chat comes of it.
      expect(server.err).toContain("set aside 1 file(s) that failed their checks");
      expect(existsSync(TORN)).toBe(false);
      expect(existsSync(`${TORN}.bad`)).toBe(true);
      const h = await hello("tab-a");
      A = h.c;
      expect(h.welcome).toMatchObject({ t: "welcome", v: PROTOCOL_VERSION, auth: "none", update: { available: false } });
      // The machine's own name, as the server reads it at run time (D54).
      expect(h.welcome.host).toBe(machineName());
      expect(h.welcome.epoch).toMatch(EPOCH);
      expect(h.welcome.claude.ok).toBe(true);
      expect(h.list.list).toEqual([]);
      epoch1 = h.welcome.epoch;
      // Booting starts no Claude Code: the pin only runs `claude --version`, which the trace does not record.
      expect(starts()).toHaveLength(0);
    },
    T,
  );

  test(
    "New environment's reads: Browse starts at the home folder, and Suggested holds the repository under it",
    async () => {
      const home = await fetch(`${OWN}/api/folders`);
      expect(home.status).toBe(200);
      expect(await home.json()).toMatchObject({ ok: true, path: HOME, home: HOME, folders: [{ name: "code", git: false, subfolders: true }] });
      const code = (await (await fetch(`${OWN}/api/folders?path=${encodeURIComponent("~/code")}`)).json()) as { folders: unknown[] };
      expect(code.folders).toEqual([{ name: "demo", path: join(HOME, "code", "demo"), git: true, subfolders: false, link: false }]);
      const suggested = await fetch(`${OWN}/api/folders/suggested`);
      expect(suggested.status).toBe(200);
      expect(await suggested.json()).toEqual({ folders: [{ name: "demo", path: join(HOME, "code", "demo"), git: true, project: null, from: "repo" }] });
    },
    T,
  );

  test(
    "a chat in a project: its first message runs a text turn with thinking, and the events arrive with seq",
    async () => {
      const added = await fetch(`${OWN}/api/projects`, {
        method: "POST",
        headers: { "x-kitespan": "1", "content-type": "application/json", origin: OWN },
        body: JSON.stringify({ cwd: PROJECT }),
      });
      expect(added.status).toBe(201);
      projectId = ((await added.json()) as { project: { id: string } }).project.id;

      const first = rid();
      const ack = await A.request({ t: "new_chat", rid: rid(), project: projectId, uuid: first, text: "hello there", picks: { model: null, effort: null, mode: null }, uploads: [] });
      expect(ack.ok).toBe(true);
      chat = ack.result.chat;
      await A.waitFor((f) => f.t === "chats" && f.delta?.chat === chat);

      const { attached, snapshot } = await attach(A, chat);
      expect(attached).toMatchObject({ chat, epoch: epoch1, archived: false, replay: "snapshot" });
      expect(["starting", "running"]).toContain(attached.state);
      await A.waitFor((f) => f.t === "ev" && f.chat === chat && f.e.k === "turn_end", 15_000);

      const evs = A.evs(chat);
      expect(evs.length).toBeGreaterThan(3);
      for (let i = 0; i < evs.length; i++) {
        expect(Number.isInteger(evs[i]!.seq)).toBe(true);
        expect(evs[i]!.seq).toBeGreaterThan(i === 0 ? snapshot.seq : evs[i - 1]!.seq);
      }
      const drawn = A.drawn(chat);
      // The user's own message, made by the server (the CLI does not echo it), once, with the text as sent.
      expect(users(drawn).filter((u) => u.uuid === first).map((u) => u.text)).toEqual(["hello there"]);
      // One text block and one thinking block: the per-block records do not draw the reply a second time.
      const b = blocks(drawn);
      expect(b.filter((x) => x.kind === "text").map((x) => x.text)).toEqual([HELLO_REPLY]);
      expect(b.filter((x) => x.kind === "thinking")).toHaveLength(1);
      const session = drawn.find((e) => e.k === "session") as Extract<ChatEvent, { k: "session" }> | undefined;
      expect(session).toBeDefined();
      sid = session!.sessionId;
      // The first start passed kitespan's own session id, and the fake wrote its transcript under that id.
      expect(starts()).toHaveLength(1);
      expect(argOf(starts()[0]!, "--session-id")).toBe(sid);
      expect(argOf(starts()[0]!, "--resume")).toBeNull();
      expect(existsSync(transcriptOf(sid))).toBe(true);
      firstPid = starts()[0]!.pid as number;
    },
    T,
  );

  test(
    "a second socket attaches to the same chat, draws the same conversation, and shares one process",
    async () => {
      const h = await hello("tab-b");
      B = h.c;
      expect(h.list.list.map((r: Frame) => r.chat)).toEqual([chat]);
      await attach(B, chat);
      // B came after the turn: it draws the turn from the snapshot's history, as A drew it live.
      expect(reading(B.drawn(chat))).toEqual(reading(A.drawn(chat)));

      // A message now: both sockets get the same ev frames, with the same seq.
      const fromA = A.frames.length;
      const fromB = B.frames.length;
      const msg = send(chat, "say it again");
      sentBefore = msg;
      const ack = await A.request(msg);
      expect(ack).toMatchObject({ ok: true, result: { queued: false } });
      const end = (c: Client, from: number) => c.waitFor((f) => f.t === "ev" && f.chat === chat && f.e.k === "turn_end", 15_000, from);
      await Promise.all([end(A, fromA), end(B, fromB)]);
      const a = A.evs(chat, fromA);
      const b = B.evs(chat, fromB);
      expect(b).toEqual(a);
      expect(users(a.map((f) => f.e)).map((u) => [u.uuid, u.text])).toEqual([[msg.uuid, "say it again"]]);
      expect(blocks(a.map((f) => f.e)).map((x) => x.text)).toEqual(["Second reply."]);

      // One Claude Code process for the chat, however many pages view it.
      expect(starts()).toHaveLength(1);
      expect(liveFakes()).toEqual([firstPid]);
    },
    T,
  );

  test(
    "a permission card from the fake claude reaches both sockets and is answered once",
    async () => {
      const fromA = A.frames.length;
      const fromB = B.frames.length;
      expect((await A.request(send(chat, "please list the files"))).ok).toBe(true);
      const isCard = (f: Frame) => f.t === "ev" && f.chat === chat && f.e.k === "card_open";
      const [onA, onB] = await Promise.all([A.waitFor(isCard, 10_000, fromA), B.waitFor(isCard, 10_000, fromB)]);
      expect(onB).toEqual(onA);
      const card = onA.e.card;
      expect(card).toMatchObject({ kind: "permission", toolName: "Bash", defaultToNo: true });

      // Both pages answer at once: the first answer wins, the other is stale.
      const allow = { t: "answer", rid: rid(), chat, card: card.id, answer: { kind: "permission", allow: true, scope: "once" } };
      const deny = { t: "answer", rid: rid(), chat, card: card.id, answer: { kind: "permission", allow: false, message: "" } };
      const [ackA, ackB] = await Promise.all([A.request(allow), B.request(deny)]);
      expect(ackA.ok).toBe(true);
      expect(ackB).toMatchObject({ ok: false, error: { code: "stale" } });

      const end = (c: Client, from: number) => c.waitFor((f) => f.t === "ev" && f.chat === chat && f.e.k === "turn_end", 15_000, from);
      await Promise.all([end(A, fromA), end(B, fromB)]);
      for (const c of [A, B]) {
        expect(c.evs(chat, c === A ? fromA : fromB).filter((f) => f.e.k === "card_close").map((f) => f.e)).toEqual([{ k: "card_close", id: card.id, why: "answered", answer: "once" }]);
      }
      const asks = fake.trace().filter((l) => l.t === "ask" && l.subtype === "can_use_tool");
      expect(asks).toHaveLength(1);
      const answers = fake.trace().filter((l) => l.t === "answer" && l.id === asks[0]!.id);
      expect(answers).toHaveLength(1);
      expect((answers[0]!.response as { behavior: string }).behavior).toBe("allow");
      expect(blocks(A.evs(chat, fromA).map((f) => f.e)).map((x) => x.text)).toContain("There are two files: notes.txt and plan.md.");
    },
    T,
  );

  test(
    "archive ends the idle chat's process and hides it; unarchive brings it back",
    async () => {
      const fromA = A.frames.length;
      const fromB = B.frames.length;
      expect((await A.request({ t: "archive", rid: rid(), chat, on: true, stop: false })).ok).toBe(true);
      const archived = (on: boolean) => (f: Frame) => f.t === "chats" && f.delta?.chat === chat && f.delta.archived === on;
      await Promise.all([A.waitFor(archived(true), 5_000, fromA), B.waitFor(archived(true), 5_000, fromB)]);
      await until(() => !alive(firstPid), 10_000, "the fake claude to end");
      expect(liveFakes()).toEqual([]);
      // The composer refuses an archived chat.
      expect(await A.request(send(chat, "hello while archived"))).toMatchObject({ ok: false, error: { code: "archived" } });

      expect((await B.request({ t: "archive", rid: rid(), chat, on: false, stop: false })).ok).toBe(true);
      await Promise.all([A.waitFor(archived(false), 5_000, fromA), B.waitFor(archived(false), 5_000, fromB)]);
      expect(starts()).toHaveLength(1);
    },
    T,
  );

  test(
    "a draft typed on socket A reaches socket B (and A); no send follows it, so it stays",
    async () => {
      const fromA = A.frames.length;
      const fromB = B.frames.length;
      A.send({ t: "draft", chat, text: "half-typed note", mode: "chat", command: null, link: false, uploads: [] });
      const onB = await B.waitFor((f) => f.t === "draft" && f.chat === chat, 5_000, fromB);
      const onA = await A.waitFor((f) => f.t === "draft" && f.chat === chat, 5_000, fromA);
      expect(onB).toMatchObject({ text: "half-typed note", mode: "chat", by: "tab-a", link: false, uploads: [] });
      expect(onB.rev).toBeGreaterThan(0);
      expect(onA).toEqual(onB);
      draftRev = onB.rev;
    },
    T,
  );

  test(
    "the draft survives a server restart; the chat comes back asleep with its history",
    async () => {
      const fromA = A.frames.length;
      expect(await stop(server!)).toBe(0);
      server = null;
      expect((await A.waitFor((f) => f.t === "bye", 5_000, fromA)).reason).toBe("shutdown");
      await until(() => A.closed && B.closed, 5_000, "both sockets to close");

      server = await boot();
      const a = await hello("tab-a2");
      const b = await hello("tab-b2");
      A = a.c;
      B = b.c;
      expect(a.welcome.epoch).not.toBe(epoch1);
      expect(a.list.list).toEqual([expect.objectContaining({ chat, project: projectId, state: "sleeping", archived: false })]);
      for (const c of [A, B]) {
        const { attached } = await attach(c, chat);
        expect(attached.draft).toMatchObject({ rev: draftRev, text: "half-typed note", mode: "chat", by: "tab-a" });
        expect(attached.state).toBe("sleeping");
        expect(users(c.drawn(chat)).map((u) => u.text)).toEqual(["hello there", "say it again", "please list the files"]);
      }
      // Nothing starts a chat's Claude Code until a message needs it.
      expect(liveFakes()).toEqual([]);
    },
    T,
  );

  test(
    "a message applied before the restart and sent again to the new server (its ack was lost) runs no second turn",
    async () => {
      const msg = sentBefore!;
      const turns = () => fake.trace().filter((l) => l.t === "turn_start" && l.uuid === msg.uuid).length;
      expect(turns()).toBe(1);
      expect(await A.request(msg)).toMatchObject({ ok: true, result: { queued: false } });
      await Bun.sleep(500);
      expect(fake.trace().filter((l) => l.t === "user" && l.uuid === msg.uuid)).toHaveLength(1);
      expect(turns()).toBe(1);
      // The chat stays asleep: the resend starts no Claude Code.
      expect(liveFakes()).toEqual([]);
      expect(starts()).toHaveLength(1);
    },
    T,
  );

  test(
    "/ws/shell opens a shell for the chat, and type_resume types the resume command without Enter",
    async () => {
      shellPane = await Client.open("/ws/shell");
      clients.push(shellPane);
      // 300 columns, so the typed command (the project's mkdtemp path under TMPDIR twice) never wraps in the pane.
      shellPane.send({ t: "open", chat, cols: 300, rows: 30 });
      expect(await shellPane.waitFor((f) => f.t === "opened")).toMatchObject({ chat, cols: 300, rows: 30, fresh: true });
      shellPane.send({ t: "type_resume" });
      // The chat sleeps, so the command is the plain resume; it is typed after the prompt and never run.
      expect(await shellPane.waitFor((f) => f.t === "typed", 15_000)).toEqual({ t: "typed", case: "plain" });
      const command = `cd ${PROJECT} && claude --resume ${sid}`;
      await until(() => shellPane.output().includes(command), 10_000, "the typed command");
      await Bun.sleep(1_000);
      expect(existsSync(RAN)).toBe(false);
      expect(starts()).toHaveLength(1);
      expect(shellPane.output().split(command)).toHaveLength(2);

      // A second pane joins the same shell and gets the ring, with the typed command in it.
      const second = await Client.open("/ws/shell");
      clients.push(second);
      second.send({ t: "open", chat, cols: 300, rows: 30 });
      expect(await second.waitFor((f) => f.t === "opened")).toMatchObject({ fresh: false });
      await until(() => second.output().includes(command), 5_000, "the ring");
      second.close();
    },
    T,
  );

  test(
    "the pane's shell has TERM and none of the names that the SDK sets on the server's own environment",
    async () => {
      const keys = (s: string) => shellPane.ws.send(new TextEncoder().encode(s));
      // Ctrl+C drops the typed line unrun. The marker is split in the command, so the echoed line never matches it.
      keys("\x03");
      await Bun.sleep(300);
      keys(`printf '%s%s:%s:%s:%s\\n' E2E ENV "\${NoDefaultCurrentDirectoryInExePath+set}" "\${CLAUDE_AGENT_SDK_VERSION+set}" "$TERM"\r`);
      await until(() => /E2EENV:[^\r\n]*\r?\n/.test(shellPane.output()), 10_000, "the environment line");
      // The SDK sets NoDefaultCurrentDirectoryInExePath on process.env when the server imports it, before any chat.
      expect(/E2EENV:([^\r\n]*)/.exec(shellPane.output())![1]).toBe("::xterm-256color");
      expect(existsSync(RAN)).toBe(false);
    },
    T,
  );

  test(
    "a message after the restart resumes the session in a new process",
    async () => {
      const from = A.frames.length;
      expect((await A.request(send(chat, "after the restart"))).ok).toBe(true);
      await A.waitFor((f) => f.t === "ev" && f.chat === chat && f.e.k === "turn_end", 15_000, from);
      expect(blocks(A.evs(chat, from).map((f) => f.e)).map((x) => x.text)).toEqual(["Back after the restart."]);
      expect(starts()).toHaveLength(2);
      // The transcript exists, so the start is a resume, never kitespan's id again (live L1).
      expect(argOf(starts()[1]!, "--resume")).toBe(sid);
      expect(argOf(starts()[1]!, "--session-id")).toBeNull();
      expect(liveFakes()).toEqual([starts()[1]!.pid as number]);
    },
    T,
  );

  /** The `!` frame, and what a page that attaches afterwards draws for its command. */
  const bash = (input: string, id = rid()) => ({ t: "bash", rid: id, chat, input, draftRev: null, uploads: [] });
  const bashRows = (events: readonly ChatEvent[], input: string) => events.filter((e): e is Extract<ChatEvent, { k: "bash" }> => e.k === "bash" && e.input === input);

  test(
    "a ! command that Claude answers: the reply is one turn by the user, and a late page draws one row, during the reply and after it",
    async () => {
      const from = A.frames.length;
      const cmd = bash("echo e2e-bash-one");
      expect((await A.request(cmd)).ok).toBe(true);
      // The reply turn runs and the transcript holds the record (under the CLI's own id): a page that attaches now
      // gets the record in the snapshot and the row's live events after it, and draws one row.
      await until(() => existsSync(transcriptOf(sid)) && readFileSync(transcriptOf(sid), "utf8").includes("e2e-bash-one</bash-input>"), 10_000, "the record");
      const during = (await hello("tab-d1")).c;
      await attach(during, chat);
      expect(A.evs(chat, from).some((f) => f.e.k === "turn_end")).toBe(false);
      expect(new Set(bashRows(during.drawn(chat), "echo e2e-bash-one").map((e) => e.uuid)).size).toBe(1);
      during.close();
      await A.waitFor((f) => f.t === "ev" && f.chat === chat && f.e.k === "turn_end", 15_000, from);
      const evs = A.evs(chat, from).map((f) => f.e as ChatEvent);
      const rows = bashRows(evs, "echo e2e-bash-one");
      expect(rows.map((e) => [e.uuid, e.state])).toEqual([
        [cmd.rid, "running"],
        [cmd.rid, "done"],
      ]);
      expect(rows[1]).toMatchObject({ stdout: "e2e-bash-one", stderr: "", code: 0, timedOut: false });
      // The user's respondToBashCommands is unset (on): the record starts Claude's reply, one turn, by the user.
      expect(evs.filter((e) => e.k === "turn_start").map((e) => (e as Extract<ChatEvent, { k: "turn_start" }>).by)).toEqual(["user"]);
      expect(evs.filter((e) => e.k === "turn_end")).toHaveLength(1);
      // The record went on the input once, under the row's uuid, as a query.
      expect(fake.trace().filter((l) => l.t === "user" && l.uuid === cmd.rid).map((l) => l.shouldQuery)).toEqual([true]);

      // A late page gets the transcript's copy, which the CLI wrote under an id of its own, under the row's own uuid
      // (the server's notes): one row, with the id the live row had.
      const late = (await hello("tab-d")).c;
      await attach(late, chat);
      const ids = [...new Set(bashRows(late.drawn(chat), "echo e2e-bash-one").map((e) => e.uuid))];
      expect(ids).toEqual([cmd.rid]);
      const record = readFileSync(transcriptOf(sid), "utf8").split("\n").find((l) => l.includes("e2e-bash-one</bash-input>"))!;
      expect((JSON.parse(record) as { uuid: string }).uuid).not.toBe(cmd.rid);
      late.close();
    },
    T,
  );

  test(
    "a ! command with Claude's reply off (the user's respondToBashCommands): no turn, and a late page draws one row, every time",
    async () => {
      mkdirSync(join(PROJECT, ".claude"), { recursive: true });
      writeFileSync(join(PROJECT, ".claude", "settings.json"), JSON.stringify({ respondToBashCommands: false }));
      const from = A.frames.length;
      const cmd = bash("echo e2e-bash-two");
      expect((await A.request(cmd)).ok).toBe(true);
      await A.waitFor((f) => f.t === "ev" && f.chat === chat && f.e.k === "bash" && f.e.uuid === cmd.rid && f.e.state === "done", 15_000, from);
      await until(() => fake.trace().some((l) => l.t === "user" && l.uuid === cmd.rid), 5_000, "the record on the input");
      expect(fake.trace().filter((l) => l.t === "user" && l.uuid === cmd.rid).map((l) => l.shouldQuery)).toEqual([false]);
      await Bun.sleep(500);
      expect(A.evs(chat, from).filter((f) => f.e.k === "turn_start")).toEqual([]);

      // The transcript holds the record under the CLI's own id, and no turn has ended since, so the row's live events
      // would follow the snapshot too; history gives the record the row's uuid, so the page draws one row, on each reload.
      for (const tab of ["tab-e", "tab-e2"]) {
        const late = (await hello(tab)).c;
        const { snapshot } = await attach(late, chat);
        const recorded = bashRows(snapshot.history as ChatEvent[], "echo e2e-bash-two");
        expect(recorded).toHaveLength(1);
        expect(recorded[0]!.uuid).toBe(cmd.rid);
        expect([...new Set(bashRows(late.drawn(chat), "echo e2e-bash-two").map((e) => e.uuid))]).toEqual([cmd.rid]);
        late.close();
      }
    },
    T,
  );

  test(
    "a page that attaches in the middle of a turn draws each block once",
    async () => {
      const from = A.frames.length;
      expect((await A.request(send(chat, "a mid-turn attach"))).ok).toBe(true);
      await A.waitFor((f) => f.t === "ev" && f.chat === chat && f.e.k === "block_end" && f.e.key.startsWith("msg_e2e_mid:"), 10_000, from);
      await Bun.sleep(300);
      const late = (await hello("tab-c")).c;
      await attach(late, chat);
      await late.waitFor((f) => f.t === "ev" && f.chat === chat && f.e.k === "turn_end", 15_000);
      const b = blocks(late.drawn(chat)).filter((x) => x.text.includes("mid-turn"));
      expect(b.map((x) => `${x.kind}: ${x.text}`)).toEqual(["thinking: Thinking mid-turn.", "text: A reply mid-turn."]);
      late.close();
    },
    T,
  );

  test(
    "a ! command typed behind a queued message runs after that message's turn, and a late page draws the order the live page drew",
    async () => {
      const from = A.frames.length;
      const first = send(chat, "e2e-hold-first");
      expect((await A.request(first)).ok).toBe(true);
      await A.waitFor((f) => f.t === "ev" && f.chat === chat && f.e.k === "turn_start", 10_000, from);
      const second = send(chat, "e2e-hold-second");
      expect((await A.request(second)).ok).toBe(true);
      const cmd = bash("echo e2e-hold-cmd");
      expect((await A.request(cmd)).ok).toBe(true);
      await A.waitFor((f) => f.t === "ev" && f.chat === chat && f.e.k === "bash" && f.e.uuid === cmd.rid && f.e.state === "done", 15_000, from);
      const evs = A.evs(chat, from).map((f) => f.e as ChatEvent);
      // Live, the row was Queued below the second message, and the second reply drew above it (6.3): the command ran
      // after both turns ended, never during the second one.
      const running = evs.findIndex((e) => e.k === "bash" && e.uuid === cmd.rid && e.state === "running");
      expect(evs.slice(0, running).filter((e) => e.k === "turn_end")).toHaveLength(2);
      expect(evs.slice(running).filter((e) => e.k === "turn_start" || e.k === "block")).toEqual([]);
      // The transcript has the same order, so a late page (a reload, a restart) draws it too.
      await until(() => readFileSync(transcriptOf(sid), "utf8").includes("e2e-hold-cmd</bash-input>"), 5_000, "the record");
      const late = (await hello("tab-h")).c;
      const { snapshot } = await attach(late, chat);
      const order = (snapshot.history as ChatEvent[]).flatMap((e) => {
        if (e.k === "user" && (e.uuid === first.uuid || e.uuid === second.uuid)) return [e.text];
        if (e.k === "block" && e.kind === "text" && /^(First|Second) done\.$/.test(e.text)) return [e.text];
        if (e.k === "bash" && e.uuid === cmd.rid) return [`!${e.input}`];
        return [];
      });
      expect(order).toEqual(["e2e-hold-first", "First done.", "e2e-hold-second", "Second done.", "!echo e2e-hold-cmd"]);
      late.close();
    },
    T,
  );

  /** A turn's end as a page draws it: the calls tagged Stopped, then the end, in order. */
  const turnEnds = (events: readonly ChatEvent[]) =>
    events.flatMap((e) => (e.k === "tool_stopped" ? [`stopped ${e.id}`] : e.k === "turn_end" ? [`end ${e.ok ? "ok" : e.subtype}`] : []));

  test(
    "Stop on one page ends the turn the same way on both pages: interrupted, with no error line; a late page draws the same end",
    async () => {
      for (const [words, line] of [
        ["please stop me", "[Request interrupted by user]"],
        ["please stop the tool", "[Request interrupted by user for tool use]"],
      ] as const) {
        const fromA = A.frames.length;
        const fromB = B.frames.length;
        const msg = send(chat, words);
        expect((await A.request(msg)).ok).toBe(true);
        const start = await A.waitFor((f) => f.t === "ev" && f.chat === chat && f.e.k === "turn_start", 10_000, fromA);
        if (words.includes("tool")) await A.waitFor((f) => f.t === "ev" && f.chat === chat && f.e.k === "tool_call", 10_000, fromA);
        await Bun.sleep(300);
        expect(await A.request({ t: "interrupt", rid: rid(), chat, turn: start.seq })).toMatchObject({ ok: true });
        const end = (c: Client, from: number) => c.waitFor((f) => f.t === "ev" && f.chat === chat && f.e.k === "turn_end", 10_000, from);
        const [onA, onB] = await Promise.all([end(A, fromA), end(B, fromB)]);
        for (const f of [onA, onB]) expect(f.e).toMatchObject({ k: "turn_end", ok: false, subtype: "interrupted", error: null });
        // The fake claude ended the turn as the CLI does: an error result of its own, and its own line in the transcript.
        expect(fake.trace().filter((l) => l.t === "turn_end").at(-1)).toMatchObject({ interrupted: true });
        await until(() => readFileSync(transcriptOf(sid), "utf8").includes(JSON.stringify(line)), 5_000, "the interrupt line");
        const live = turnEnds(A.evs(chat, fromA).map((f) => f.e as ChatEvent));
        expect(live).toEqual(words.includes("tool") ? ["stopped toolu_e2e_stop", "end interrupted"] : ["end interrupted"]);
        // A reload or a late page draws the turn from history: the same end, and no extra row for Claude Code's line.
        const late = (await hello(`tab-s-${live.length}`)).c;
        const { snapshot } = await attach(late, chat);
        const hist = snapshot.history as ChatEvent[];
        const at = hist.findIndex((e) => e.k === "user" && e.uuid === msg.uuid);
        expect(at).toBeGreaterThanOrEqual(0);
        expect(turnEnds(hist.slice(at))).toEqual(live);
        expect(hist.some((e) => e.k === "user" && e.text.includes("Request interrupted"))).toBe(false);
        late.close();
      }
    },
    T,
  );

  test(
    "a foreign Origin gets 403 on both socket paths",
    async () => {
      for (const path of ["/ws", "/ws/shell"]) {
        expect(await rawUpgrade(path, "http://evil.example")).toBe(403);
        expect(await rawUpgrade(path, `http://localhost:${PORT + 1}`)).toBe(403);
        expect(await rawUpgrade(path, `http://localhost:${PORT}`)).toBe(101);
        expect(await rawUpgrade(path, null)).toBe(403);
        expect(await rawUpgrade(path, OWN)).toBe(101);
        await expect(Client.open(path, "http://evil.example")).rejects.toThrow();
      }
    },
    T,
  );

  test(
    "delete ends the process, removes the chat and its transcript, and both sockets get gone",
    async () => {
      const pid = starts()[1]!.pid as number;
      expect(existsSync(transcriptOf(sid))).toBe(true);
      const ledger = join(STATE, "kitespan", "chats", `${chat}.json`);
      const draftFile = join(STATE, "kitespan", "drafts", `${chat}.json`);
      expect(existsSync(ledger)).toBe(true);
      expect(existsSync(draftFile)).toBe(true);
      const fromA = A.frames.length;
      const fromB = B.frames.length;
      const fromShell = shellPane.frames.length;
      expect((await A.request({ t: "delete", rid: rid(), chat }, 20_000)).ok).toBe(true);
      const gone = (f: Frame) => f.t === "chats" && f.delta?.chat === chat && f.delta.gone === true;
      await Promise.all([A.waitFor(gone, 5_000, fromA), B.waitFor(gone, 5_000, fromB)]);
      expect(alive(pid)).toBe(false);
      expect(liveFakes()).toEqual([]);
      // deleteSession removed the transcript; the store removed the ledger and the draft.
      expect(existsSync(transcriptOf(sid))).toBe(false);
      expect(existsSync(ledger)).toBe(false);
      expect(existsSync(draftFile)).toBe(false);
      // The chat's shell ends with it.
      await shellPane.waitFor((f) => f.t === "exit", 10_000, fromShell);
      // Attaching again finds nothing.
      const again = A.frames.length;
      A.send({ t: "attach", chat, since: 0, epoch: null });
      expect((await A.waitFor((f) => f.t === "chats" && f.delta?.chat === chat, 5_000, again)).delta).toEqual({ chat, gone: true });
    },
    T,
  );

  test(
    "SIGTERM stops the server with exit 0; nothing went to stderr, and the log's only error line is the torn ledger",
    async () => {
      const last = server!;
      expect(await stop(last)).toBe(0);
      server = null;
      expect(liveFakes()).toEqual([]);
      expect(last.out).toContain("kitespan is stopping");
      expect(last.err).toBe("");
      const logs = join(STATE, "kitespan", "logs");
      const lines = readdirSync(logs).flatMap((f) => readFileSync(join(logs, f), "utf8").split("\n").filter((l) => l.trim()));
      const events = lines.map((l) => JSON.parse(l) as { ev: string; err: string | null; route: string | null });
      expect(events.filter((e) => e.ev === "claude_start")).toHaveLength(2);
      // The refused upgrades are counted by route; the Origin itself is never written.
      expect(events.filter((e) => e.ev === "origin_refused").map((e) => e.route)).toContain("/ws");
      expect(lines.join("\n")).not.toContain("evil.example");
      expect(events.filter((e) => e.ev === "error").map((e) => e.err)).toEqual(["bad_record"]);
    },
    T,
  );
});
