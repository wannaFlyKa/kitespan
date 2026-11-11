// End to end, across a server restart (DESIGN.md 5.4, 6.3): the real server (server/main.ts) as its own process on a
// free port of 127.0.0.1, with scratch HOME, CLAUDE_CONFIG_DIR and XDG folders and the fake claude first on PATH (the
// real claude never runs). The fake writes the transcript as the CLI does, a `!` record under an id of its own
// (fixtures/restart-records.json). A page that attaches late, and one that attaches after the restart, draw what the
// live page drew: the answered card's record with how it was answered, the `!` row once under its own uuid, the
// call that a Stop cut off as stopped, and the message's mention tile (its path, which has a space, from the notes).
// Then done check 2 and what survives a kill -9 (R18, R11 to R17), in a world of their own: SIGKILL of the server, a
// start on the same state folder, the stop line, a message that was Queued, kitespan's own orphan, and a short read
// that a shutdown ends.
//
// The tests of each world run in order and share the server's lives.

import type { Subprocess } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { messageRef, type ChatEvent } from "../../shared/protocol";
import { installFakeClaude, type FakeClaude, type Fixture, type Turn } from "../fake-claude/install";
import { LINUX_ONLY, PROCFS } from "../linux";
import { freePort } from "./free-port";

const ROOT = resolve(import.meta.dir, "..", "..");
const MAIN = join(ROOT, "server", "main.ts");
const PORT = freePort();
const OWN = `http://127.0.0.1:${PORT}`;
const T = 30_000;

const fake = installFakeClaude("restart-records");
const PROJECT = fake.project;
const HOME = join(fake.root, "home");
const CONFIG = join(HOME, ".claude");
const STATE = join(fake.root, "state");
const DIST = join(fake.root, "dist");
for (const d of [HOME, STATE, join(fake.root, "config"), join(fake.root, "tmp"), DIST]) mkdirSync(d, { recursive: true });
writeFileSync(join(DIST, "index.html"), "<!doctype html><html><body>kitespan page</body></html>");
// Claude does not reply to `!` output here (the user's own respondToBashCommands), so the row's turn is the command.
mkdirSync(join(PROJECT, ".claude"), { recursive: true });
writeFileSync(join(PROJECT, ".claude", "settings.json"), JSON.stringify({ respondToBashCommands: false }));
// A file of the chat's folder that a message names by a mention chip: a path with a space in it.
const MENTION = "notes/会議メモ 2026.md";
mkdirSync(join(PROJECT, "notes"), { recursive: true });
writeFileSync(join(PROJECT, MENTION), "# 会議メモ\n");

const ENV: Record<string, string> = {
  PATH: `${fake.binDir}:/usr/bin:/bin`,
  HOME,
  CLAUDE_CONFIG_DIR: CONFIG,
  XDG_STATE_HOME: STATE,
  XDG_CONFIG_HOME: join(fake.root, "config"),
  TMPDIR: join(fake.root, "tmp"),
  SHELL: "/bin/sh",
};
const transcriptOf = (sid: string) => join(CONFIG, "projects", PROJECT.replace(/[^a-zA-Z0-9]/g, "-"), `${sid}.jsonl`);

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

function boot(): Promise<Running> {
  return launch(PORT, DIST, ENV, fake.root);
}

async function launch(port: number, dist: string, env: Record<string, string>, cwd: string): Promise<Running> {
  const own = `http://127.0.0.1:${port}`;
  const proc = Bun.spawn([process.execPath, "--no-env-file", MAIN, "--port", String(port), "--dist", dist], { env, cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const r: Running = { proc, out: "", err: "" };
  const read = async (s: ReadableStream<Uint8Array>, key: "out" | "err") => {
    const dec = new TextDecoder();
    for await (const c of s) r[key] += dec.decode(c, { stream: true });
  };
  void read(proc.stdout, "out");
  void read(proc.stderr, "err");
  const end = Date.now() + 15_000;
  while (!r.out.includes(`kitespan listens on ${own}`)) {
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
  closed = false;
  private constructor(readonly ws: WebSocket) {
    ws.onmessage = (m) => {
      if (typeof m.data === "string") this.frames.push(JSON.parse(m.data) as Frame);
    };
    ws.onclose = () => (this.closed = true);
  }
  static open(port = PORT): Promise<Client> {
    return new Promise((ok, no) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: `http://127.0.0.1:${port}` } });
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
  evs(chat: string, from = 0): Frame[] {
    return this.frames.slice(from).filter((f) => f.t === "ev" && f.chat === chat);
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
async function page(tab: string, port = PORT): Promise<Client> {
  const c = await Client.open(port);
  clients.push(c);
  c.send({ t: "hello", v: 1, tab });
  await c.waitFor((f) => f.t === "chats" && "list" in f);
  return c;
}
/** Attach, and what the page draws for the chat: the snapshot's history, then the tail that follows it. */
async function attach(c: Client, chat: string): Promise<{ history: ChatEvent[]; tail: ChatEvent[]; attached: Frame }> {
  const from = c.frames.length;
  c.send({ t: "attach", chat, since: 0, epoch: null });
  const attached = await c.waitFor((f) => f.t === "attached" && f.chat === chat, 10_000, from);
  const snapshot = await c.waitFor((f) => f.t === "snapshot" && f.chat === chat, 10_000, from);
  // The tail goes out right after the snapshot, in the same burst.
  await Bun.sleep(300);
  return { history: snapshot.history as ChatEvent[], tail: c.evs(chat, from).map((f) => f.e as ChatEvent), attached };
}
const rid = () => crypto.randomUUID();

let server: Running | null = null;
afterAll(async () => {
  for (const c of clients) c.close();
  if (server) await stop(server);
  for (const pid of PROCFS ? liveFakes() : []) if (cmdline(pid).includes(fake.fixturePath)) process.kill(pid, "SIGKILL");
  fake.cleanup();
});

/** What a page draws, as short lines: the records, the `!` rows and the tool calls. */
function reading(events: readonly ChatEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.k === "tool_call") out.push(`call ${e.id}`);
    else if (e.k === "tool_stopped") out.push(`stopped ${e.id}`);
    else if (e.k === "card_open") out.push(`card ${e.card.id}`);
    else if (e.k === "card_close") out.push(`closed ${e.id} ${e.why} ${e.answer}`);
    else if (e.k === "bash" && e.state === "done") out.push(`bash ${e.uuid} ${e.input}`);
  }
  return out;
}
/** A page draws a row once per id: the events of one id after the first replace it. */
const once = (lines: readonly string[]) => [...new Set(lines)];
/** The mention paths of each of the user's messages, as the page draws its tiles: the last event of each id wins. */
function mentionsBy(events: readonly ChatEvent[]): Record<string, string[] | null> {
  const out: Record<string, string[] | null> = {};
  for (const e of events) if (e.k === "user") out[e.uuid] = e.mentions ?? null;
  return out;
}

describe.skipIf(!PROCFS)(`what a page draws after a reload and after a restart ${LINUX_ONLY}`, () => {
  let chat = "";
  let sid = "";
  let bashRid = "";
  let stopMsg = "";
  let live: string[] = [];
  let liveMentions: Record<string, string[] | null> = {};

  test(
    "live: an answered permission card, a ! command, and a call that a Stop cut off",
    async () => {
      server = await boot();
      const added = await fetch(`${OWN}/api/projects`, { method: "POST", headers: { "x-kitespan": "1", "content-type": "application/json", origin: OWN }, body: JSON.stringify({ cwd: PROJECT }) });
      const projectId = ((await added.json()) as { project: { id: string } }).project.id;
      const A = await page("tab-a");
      const ack = await A.request({ t: "new_chat", rid: rid(), project: projectId, uuid: rid(), text: "please list the files", picks: { model: null, effort: null, mode: null }, uploads: [] });
      chat = ack.result.chat;
      await attach(A, chat);
      const card = await A.waitFor((f) => f.t === "ev" && f.chat === chat && f.e.k === "card_open", 15_000);
      expect((await A.request({ t: "answer", rid: rid(), chat, card: card.e.card.id, answer: { kind: "permission", allow: true, scope: "once" } })).ok).toBe(true);
      await A.waitFor((f) => f.t === "ev" && f.chat === chat && f.e.k === "turn_end", 15_000);
      sid = (A.evs(chat).find((f) => f.e.k === "session")!.e as { sessionId: string }).sessionId;

      bashRid = rid();
      expect((await A.request({ t: "bash", rid: bashRid, chat, input: "echo restart-row", draftRev: null, uploads: [] })).ok).toBe(true);
      await A.waitFor((f) => f.t === "ev" && f.chat === chat && f.e.k === "bash" && f.e.state === "done", 15_000);
      await until(() => readFileSync(transcriptOf(sid), "utf8").includes("restart-row</bash-input>"), 10_000, "the record");
      // The fake, as the CLI does, wrote the record under an id of its own.
      const record = readFileSync(transcriptOf(sid), "utf8").split("\n").find((l) => l.includes("restart-row</bash-input>"))!;
      expect((JSON.parse(record) as { uuid: string }).uuid).not.toBe(bashRid);

      const from = A.frames.length;
      stopMsg = rid();
      expect((await A.request({ t: "send", rid: stopMsg, chat, uuid: stopMsg, text: "please stop me", draftRev: null, uploads: [], mentions: [MENTION] })).ok).toBe(true);
      await A.waitFor((f) => f.t === "ev" && f.chat === chat && f.e.k === "tool_call" && f.e.id === "toolu_fake_wait_1" && f.e.input !== null, 10_000, from);
      const start = A.evs(chat, from).find((f) => f.e.k === "turn_start")!;
      expect((await A.request({ t: "interrupt", rid: rid(), chat, turn: start.seq })).ok).toBe(true);
      await A.waitFor((f) => f.t === "ev" && f.chat === chat && f.e.k === "turn_end", 10_000, from);
      live = once(reading(A.evs(chat).map((f) => f.e as ChatEvent)));
      expect(live).toEqual([
        "call toolu_fake_bash_1",
        "card toolu_fake_bash_1",
        "closed toolu_fake_bash_1 answered once",
        `bash ${bashRid} echo restart-row`,
        "call toolu_fake_wait_1",
        "stopped toolu_fake_wait_1",
      ]);
      liveMentions = mentionsBy(A.evs(chat).map((f) => f.e as ChatEvent));
      expect(liveMentions[stopMsg]).toEqual([MENTION]);
      // Every message this server sent names its paths, an empty list when it had no chips (its text then has no tile).
      expect(Object.values(liveMentions).filter((m) => m?.length)).toEqual([[MENTION]]);
      expect(Object.values(liveMentions).filter((m) => m === null)).toEqual([]);
      // The fake, as the CLI does, wrote the message under the host's uuid, with the reference the server added (the
      // path has a space, so it is quoted).
      const msg = readFileSync(transcriptOf(sid), "utf8").split("\n").find((l) => l.includes(stopMsg))!;
      expect(messageRef(`${PROJECT}/${MENTION}`)).toBe(`@"${PROJECT}/${MENTION}"`);
      expect(JSON.stringify(JSON.parse(msg))).toContain(JSON.stringify(`please stop me ${messageRef(`${PROJECT}/${MENTION}`)}`).slice(1, -1));
    },
    T,
  );

  test(
    "a page that attaches now (a reload, another device) draws the same",
    async () => {
      const late = await page("tab-late");
      const { history, tail } = await attach(late, chat);
      expect(once(reading([...history, ...tail]))).toEqual(live);
      expect(mentionsBy([...history, ...tail])).toEqual(liveMentions);
      // The ended turns' events are in history, from the transcript and the server's notes: nothing is sent twice.
      expect(reading(tail)).toEqual([]);
    },
    T,
  );

  test(
    "after a restart a page draws the same, from the transcript and the server's notes",
    async () => {
      expect(await stop(server!)).toBe(0);
      server = await boot();
      expect(existsSync(join(STATE, "kitespan", "notes", `${chat}.json`))).toBe(true);
      const after = await page("tab-after");
      const { history, tail, attached } = await attach(after, chat);
      expect(attached.state).toBe("sleeping");
      expect(once(reading([...history, ...tail]))).toEqual(live);
      expect(mentionsBy(history)).toEqual(liveMentions);
      expect(tail.filter((e) => e.k === "bash" || e.k === "card_open" || e.k === "card_close" || e.k === "tool_stopped")).toEqual([]);
      // Nothing starts Claude Code to read a history.
      expect(liveFakes()).toEqual([]);
    },
    T,
  );
});

// ---------------------------------------------------------------------------------------------------------------
// Done check 2 and what survives a kill -9 (R18, R11 to R17; BUILD-BRIEF section 2 items 1 and 2)

interface World {
  port: number;
  own: string;
  fake: FakeClaude;
  dist: string;
  env: Record<string, string>;
}

function world(fixture: Fixture): World {
  const w = installFakeClaude(fixture);
  const home = join(w.root, "home");
  const dist = join(w.root, "dist");
  for (const d of [home, join(w.root, "state"), join(w.root, "config"), join(w.root, "tmp"), dist]) mkdirSync(d, { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><html><body>kitespan page</body></html>");
  const port = freePort();
  const env = { PATH: `${w.binDir}:/usr/bin:/bin`, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), XDG_STATE_HOME: join(w.root, "state"), XDG_CONFIG_HOME: join(w.root, "config"), TMPDIR: join(w.root, "tmp"), SHELL: "/bin/sh" };
  return { port, own: `http://127.0.0.1:${port}`, fake: w, dist, env };
}
const fakesOf = (w: World) =>
  readdirSync("/proc")
    .filter((n) => /^\d+$/.test(n))
    .map(Number)
    .filter((pid) => cmdline(pid).includes(w.fake.fixturePath));
/** SIGKILL of the server (a kill -9), by its pid, after kill -0 and a check that the pid is still this server. */
async function kill9(r: Running): Promise<void> {
  const pid = r.proc.pid;
  if (r.proc.exitCode === null && alive(pid) && cmdline(pid).includes(MAIN)) process.kill(pid, "SIGKILL");
  await r.proc.exited;
}
/** SIGKILL of a fake claude this world started, by its pid, after a look at its command line. */
function killFakes(w: World): void {
  for (const pid of fakesOf(w)) if (alive(pid) && cmdline(pid).includes(w.fake.fixturePath)) process.kill(pid, "SIGKILL");
}
async function addProject(w: World, cwd: string): Promise<string> {
  const added = await fetch(`${w.own}/api/projects`, { method: "POST", headers: { "x-kitespan": "1", "content-type": "application/json", origin: w.own }, body: JSON.stringify({ cwd }) });
  return ((await added.json()) as { project: { id: string } }).project.id;
}
/** A send frame: its uuid is its rid. */
function sendOf(chat: string, text: string) {
  const r = rid();
  return { t: "send", rid: r, chat, uuid: r, text, draftRev: null, uploads: [] };
}
const RUNNING_LINE = "kitespan stopped while this chat was running. Send a message to continue.";
const notices = (events: readonly ChatEvent[]) => events.filter((e) => e.k === "notice" && e.id !== undefined).map((e) => (e as { text: string }).text);
const replies = (events: readonly ChatEvent[]) => events.filter((e) => e.k === "block" && e.kind === "text").map((e) => (e as { text: string }).text);
const resumes = (w: World) => w.fake.trace().filter((l) => l.t === "start").map((l) => (l.args as string[]).find((a) => a.startsWith("--resume=")) ?? null);

/** A turn that runs a slow tool: the kill -9 comes while it sleeps; it then writes its result and its reply. */
const SLOW: Turn = {
  steps: [
    { say: { id: "$USER_UUID", text: "Starting the slow part.", tools: [{ id: "toolu_slow_1", name: "Bash", input: { command: "sleep 6" } }] } },
    { sleep: 6_000 },
    { emit: { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_slow_1", content: "done", is_error: false }] }, parent_tool_use_id: null } },
    { say: { id: "msg_slow_done", text: "SLOWDONE" } },
    { emit: { type: "result", subtype: "success", result: "SLOWDONE" } },
  ],
};

describe.skipIf(!PROCFS)(`done check 2: a kill -9 of the server, and a start on the same state folder ${LINUX_ONLY}`, () => {
  const K = world({ transcript: true, finishTurnOnStdinEnd: true, turnsByText: { "a slow one": SLOW }, defaultTurn: { steps: [{ say: { id: "$USER_UUID", text: "ok" } }, { emit: { type: "result", subtype: "success", result: "ok" } }] } });
  let ks: Running | null = null;
  let chat = "";
  let sid = "";
  afterAll(async () => {
    if (ks) await stop(ks);
    killFakes(K);
    K.fake.cleanup();
  });
  const pageK = (tab: string) => page(tab, K.port);
  const rowOf = (c: Client) => (c.frames.find((f) => f.t === "chats" && "list" in f)!.list as Frame[]).find((r) => r.chat === chat)!;
  /** The fake's claude that runs the chat's slow turn now, once the turn's call is out. */
  async function slowTurn(c: Client): Promise<void> {
    const from = c.frames.length;
    expect((await c.request(sendOf(chat, "a slow one"), 15_000)).ok).toBe(true);
    await c.waitFor((f) => f.t === "ev" && f.chat === chat && f.e.k === "tool_call" && f.e.id === "toolu_slow_1", 15_000, from);
  }

  test(
    "an idle chat: the same chat attaches with its history, the next message resumes the same session id, and nothing holds it",
    async () => {
      ks = await launch(K.port, K.dist, K.env, K.fake.root);
      const projectId = await addProject(K, K.fake.project);
      const A = await pageK("tab-a");
      chat = (await A.request({ t: "new_chat", rid: rid(), project: projectId, uuid: rid(), text: "hello there", picks: { model: null, effort: null, mode: null }, uploads: [] })).result.chat;
      await attach(A, chat);
      await A.waitFor((f) => f.t === "ev" && f.chat === chat && f.e.k === "turn_end", 15_000);
      sid = (A.evs(chat).find((f) => f.e.k === "session")!.e as { sessionId: string }).sessionId;
      await kill9(ks);
      // An idle claude whose host is gone exits at once (the lead's live check LV-R1).
      await until(() => fakesOf(K).length === 0, 10_000, "the idle claude to exit");
      ks = await launch(K.port, K.dist, K.env, K.fake.root);
      const B = await pageK("tab-b");
      expect(rowOf(B).held).toBeUndefined();
      const { history } = await attach(B, chat);
      expect(replies(history)).toEqual(["ok"]);
      expect(notices(history)).toEqual([]);
      const from = B.frames.length;
      expect(await B.request(sendOf(chat, "again"), 15_000)).toMatchObject({ ok: true });
      await B.waitFor((f) => f.t === "ev" && f.chat === chat && f.e.k === "turn_end", 15_000, from);
      expect(resumes(K).at(-1)).toBe(`--resume=${sid}`);
      expect(B.frames.slice(from).filter((f) => f.t === "chats" && f.delta?.chat === chat && f.delta.held)).toEqual([]);
    },
    T,
  );

  test(
    "a kill -9 during a turn (its claude killed too): the running line, under the cut turn; the next message resumes",
    async () => {
      const A = await pageK("tab-c");
      await attach(A, chat);
      await slowTurn(A);
      await kill9(ks!);
      killFakes(K);
      ks = await launch(K.port, K.dist, K.env, K.fake.root);
      const B = await pageK("tab-d");
      expect(rowOf(B).held).toBeUndefined();
      const { history, tail } = await attach(B, chat);
      expect(notices(history)).toEqual([RUNNING_LINE]);
      expect(history.at(-1)).toMatchObject({ k: "notice", text: RUNNING_LINE });
      expect(notices(tail)).toEqual([]);
      const from = B.frames.length;
      expect((await B.request(sendOf(chat, "go on"), 15_000)).ok).toBe(true);
      await B.waitFor((f) => f.t === "ev" && f.chat === chat && f.e.k === "turn_end", 15_000, from);
      expect(resumes(K).at(-1)).toBe(`--resume=${sid}`);
    },
    T,
  );

  test(
    "a message Queued behind a turn shows Not sent after a kill -9, and Send again runs one turn for it",
    async () => {
      const A = await pageK("tab-e");
      await attach(A, chat);
      await slowTurn(A);
      const queuedOne = sendOf(chat, "behind the slow one");
      const behind = queuedOne.uuid;
      expect(await A.request(queuedOne)).toMatchObject({ ok: true });
      await kill9(ks!);
      killFakes(K);
      ks = await launch(K.port, K.dist, K.env, K.fake.root);
      const B = await pageK("tab-f");
      const { tail } = await attach(B, chat);
      expect(tail.filter((e) => e.k === "user" && e.uuid === behind)).toEqual([{ k: "user", uuid: behind, text: "behind the slow one", queued: true, mentions: [], notSent: true }]);
      const turns = () => K.fake.trace().filter((l) => l.t === "turn_start" && l.uuid === behind).length;
      expect(turns()).toBe(0);
      const from = B.frames.length;
      expect(await B.request({ t: "send_queued", rid: rid(), chat }, 15_000)).toMatchObject({ ok: true, result: { started: true } });
      await B.waitFor((f) => f.t === "ev" && f.chat === chat && f.e.k === "turn_end", 15_000, from);
      expect(turns()).toBe(1);
      expect(B.evs(chat, from).filter((f) => f.e.k === "user" && f.e.uuid === behind).at(-1)!.e).toMatchObject({ queued: false });
      expect(resumes(K).at(-1)).toBe(`--resume=${sid}`);
    },
    T,
  );

  test(
    "kitespan's own orphan finishes its turn: the chat is held as finishing, then the hold ends, the history holds the turn's end, and no line shows",
    async () => {
      const A = await pageK("tab-g");
      // The two turns that the kills above cut have their lines.
      expect(notices((await attach(A, chat)).history)).toEqual([RUNNING_LINE, RUNNING_LINE]);
      await slowTurn(A);
      const orphan = fakesOf(K);
      expect(orphan).toHaveLength(1);
      await kill9(ks!);
      ks = await launch(K.port, K.dist, K.env, K.fake.root);
      const B = await pageK("tab-h");
      expect(rowOf(B).held).toEqual({ app: "other", session: sid, kind: "finishing" });
      expect(await B.request(sendOf(chat, "too soon"))).toMatchObject({ ok: false, error: { code: "session_held" } });
      await B.waitFor((f) => f.t === "chats" && f.delta?.chat === chat && f.delta.held === null, 20_000);
      expect(alive(orphan[0]!) && cmdline(orphan[0]!).includes(K.fake.fixturePath)).toBe(false);
      const { history } = await attach(B, chat);
      expect(replies(history).at(-1)).toBe("SLOWDONE");
      expect(notices(history)).toEqual([RUNNING_LINE, RUNNING_LINE]);
    },
    T,
  );

  test(
    "a message Queued behind the turn that the orphan finishes: Queued during the hold, a resend is answered queued, then Not sent once; Claude Code never got it",
    async () => {
      const A = await pageK("tab-i");
      await attach(A, chat);
      await slowTurn(A);
      const queuedOne = sendOf(chat, "after the orphan");
      const behind = queuedOne.uuid;
      expect(await A.request(queuedOne)).toMatchObject({ ok: true });
      await kill9(ks!);
      ks = await launch(K.port, K.dist, K.env, K.fake.root);
      const B = await pageK("tab-j");
      expect(rowOf(B)).toMatchObject({ state: "running", held: { kind: "finishing" } });
      const during = await attach(B, chat);
      expect(during.tail.filter((e) => e.k === "user" && e.uuid === behind)).toEqual([{ k: "user", uuid: behind, text: "after the orphan", queued: true, mentions: [] }]);
      // The page whose ack the kill -9 lost resends the same frame: answered, so nothing goes back to its box.
      expect(await B.request(queuedOne)).toMatchObject({ ok: true, result: { queued: true } });
      await B.waitFor((f) => f.t === "chats" && f.delta?.chat === chat && f.delta.held === null, 20_000);
      const C = await pageK("tab-k");
      const after = await attach(C, chat);
      const shown = [...after.history, ...after.tail].filter((e) => e.k === "user" && e.uuid === behind);
      expect(shown).toEqual([{ k: "user", uuid: behind, text: "after the orphan", queued: true, mentions: [], notSent: true }]);
      expect(K.fake.trace().filter((l) => l.t === "turn_start" && l.uuid === behind)).toEqual([]);
    },
    T,
  );
});

describe.skipIf(!PROCFS)(`R17: a short read in flight at a shutdown ${LINUX_ONLY}`, () => {
  // A Claude Code whose initialize answer comes late, so the model list's short read (row 81) still waits when the
  // server stops, and which outlives the end of its stdin: only a signal ends it.
  const S = world({ initializeDelayMs: 30_000, ignoreStdinEnd: true });
  afterAll(() => {
    killFakes(S);
    S.fake.cleanup();
  });

  test(
    "leaves no claude behind",
    async () => {
      const r = await launch(S.port, S.dist, S.env, S.fake.root);
      const projectId = await addProject(S, S.fake.project);
      void fetch(`${S.own}/api/projects/${projectId}/models`, { headers: { "x-kitespan": "1", origin: S.own } }).catch(() => {});
      await until(() => fakesOf(S).length === 1, 10_000, "the short read's claude");
      // It waits to answer the SDK's initialize request.
      await S.fake.waitFor((l) => l.t === "control" && l.subtype === "initialize", 10_000);
      expect(await stop(r)).toBe(0);
      await until(() => fakesOf(S).length === 0, 5_000, "no claude after the shutdown");
      // The server's exit sent it SIGTERM (the SDK ends every claude it started when its process exits).
      expect(S.fake.trace().some((l) => l.t === "sigterm")).toBe(true);
    },
    T,
  );
});
