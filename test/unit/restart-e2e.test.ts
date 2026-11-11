// The restart end to end (DESIGN.md 4.10; build checklist S9, S10, S11, S13, S18; done check 3): the real server
// (server/main.ts) on a free port of its own with scratch HOME, CLAUDE_CONFIG_DIR and XDG folders and the fake claude first on PATH
// (the real claude never runs), a build stamp of this checkout's HEAD so the preflight passes, and its successor
// started through bin/kitespan as a real restart starts it. The tests of a world run in order and share its servers.
// The server's environment holds HTTP_PROXY and http_proxy at a port where nothing listens (and no NO_PROXY), as on a
// machine with a proxy: the health gate reads 127.0.0.1 through no proxy.
// - Restart when they finish, during a paced turn: 202, the notice on every page (and on one that says hello later),
//   a send to another chat held Queued and never given to Claude Code, a `!` command and a new chat refused, the turn's
//   result, then the close's "Restarting kitespan..." in the drain notice's place, `bye {reason: "restart"}`, the close
//   that follows it, and the successor's new epoch, where the held message is Not sent. An upload in flight during the
//   stop is cut and leaves nothing behind. The first server runs with `--origin`: the successor keeps it, and its lines
//   in logs/server-out.log count it without its value, which is in no file of the world's folders.
// - Cancel restart: the held send goes, on the same epoch.
// - Restart now: the fake saw an interrupt; the turn line and the card line after the reattach; an old card is stale.
// - A successor that fails (a bad line in the start-env file, which bin/kitespan refuses): the old server listens
//   again, with the same epoch, and a page that says hello then gets the notice that the restart did not happen. No
// test-only
//   hook.
// - A fake claude that ignores SIGTERM is gone before the successor starts (S11), and so is the claude of a short read
//   of the model list that was in flight at the close (R17).

import type { Subprocess } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ChatEvent } from "../../shared/protocol";
import { pacedPrompt } from "../fake-claude/long-reply";
import { installFakeClaude, type Fixture, type FakeClaude } from "../fake-claude/install";
import { BUILD_STAMP, stampText } from "../../server/update/stamp";
import { LINUX_ONLY, PROCFS } from "../linux";
import { freePort } from "./free-port";

const ROOT = resolve(import.meta.dir, "..", "..");
const MAIN = join(ROOT, "server", "main.ts");
/**
 * A free port of the system's (never a lane's test port, which another agent's server may hold): the successor gets the
 * same --port from the server's own options.
 */
const PORT = freePort();
const OWN = `http://127.0.0.1:${PORT}`;
const T = 60_000;
/** The first server's `--origin`: allowed for as long as kitespan runs, its restarts too, and never written. */
const FLAG_ORIGIN = "https://box.example.com";
const HEAD = Bun.spawnSync(["git", "-C", ROOT, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim();

const DRAIN_LINE = "kitespan restarts when the running turns end.";
/** The close's notice: the drain notice's id, its own line, no buttons (Cancel restart is the only `gone`). */
const CLOSING = { t: "notice", text: "Restarting kitespan...", id: "restart" };
const TURN_LINE = "kitespan restarted during this turn. Send a message to continue.";
const CARD_LINE = "This chat was waiting for your answer when kitespan restarted. Send a message to continue.";

interface World {
  fake: FakeClaude;
  dist: string;
  state: string;
  config: string;
  tmp: string;
  env: Record<string, string>;
}

function world(fixture: Fixture): World {
  const fake = installFakeClaude(fixture);
  const home = join(fake.root, "home");
  const dist = join(fake.root, "dist");
  const state = join(fake.root, "state");
  const config = join(fake.root, "config");
  const tmp = join(fake.root, "tmp");
  for (const d of [home, state, config, tmp, dist]) mkdirSync(d, { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><html><body>kitespan page</body></html>");
  // The build of this checkout: the preflight's first check passes.
  writeFileSync(join(dist, BUILD_STAMP), stampText(HEAD));
  // Bun on PATH for bin/kitespan and the preflight; the fake claude first.
  // A proxy where nothing listens: a request that went through it would fail.
  const proxy = `http://127.0.0.1:${freePort()}`;
  const env = { PATH: `${fake.binDir}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), XDG_STATE_HOME: state, XDG_CONFIG_HOME: config, TMPDIR: tmp, SHELL: "/bin/sh", HTTP_PROXY: proxy, http_proxy: proxy };
  return { fake, dist, state, config, tmp, env };
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
function zombie(pid: number): boolean {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    return s.slice(s.lastIndexOf(")") + 2).startsWith("Z");
  } catch {
    return true;
  }
}
const pids = () =>
  readdirSync("/proc")
    .filter((n) => /^\d+$/.test(n))
    .map(Number);
/** `flag` followed by `value` on a command line. */
const after = (c: readonly string[], flag: string, value: string) => c.some((a, i) => a === flag && c[i + 1] === value);
/**
 * The kitespan servers that these tests started for world `w`: their command line names main.ts, this port and the
 * world's own build folder (a unique scratch folder), so no other server on the host ever counts.
 */
const servers = (w: World) => pids().filter((p) => {
  const c = cmdline(p);
  return c.includes(MAIN) && after(c, "--port", String(PORT)) && after(c, "--dist", w.dist) && !zombie(p);
});
const fakesOf = (w: World) => pids().filter((p) => cmdline(p).includes(w.fake.fixturePath) && !zombie(p));
async function until(pred: () => boolean, ms = 15_000, what = "a condition"): Promise<void> {
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
  /** Both streams were read to their end. */
  read: Promise<unknown>;
}

async function launch(w: World, more: readonly string[] = []): Promise<Running> {
  const proc = Bun.spawn([process.execPath, "--no-env-file", MAIN, "--port", String(PORT), "--dist", w.dist, ...more], { env: w.env, cwd: w.fake.root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const r: Running = { proc, out: "", err: "", read: Promise.resolve() };
  const read = async (s: ReadableStream<Uint8Array>, key: "out" | "err") => {
    const dec = new TextDecoder();
    for await (const c of s) r[key] += dec.decode(c, { stream: true });
  };
  r.read = Promise.all([read(proc.stdout, "out"), read(proc.stderr, "err")]);
  const end = Date.now() + 15_000;
  while (!r.out.includes(`kitespan listens on ${OWN}`)) {
    if (proc.exitCode !== null || Date.now() > end) throw new Error(`the server did not start (exit ${proc.exitCode}): ${r.err}`);
    await Bun.sleep(50);
  }
  return r;
}

/** SIGTERM to each server of world `w` that these tests started, by its pid, after kill -0 and the same check again. */
async function stopServers(w: World): Promise<void> {
  for (const pid of servers(w)) if (alive(pid) && servers(w).includes(pid)) process.kill(pid, "SIGTERM");
  await until(() => servers(w).length === 0, 20_000, "the servers to stop");
}
function killFakes(w: World): void {
  for (const pid of fakesOf(w)) if (alive(pid) && cmdline(pid).includes(w.fake.fixturePath)) process.kill(pid, "SIGKILL");
}

async function health(): Promise<string | null> {
  try {
    const r = await fetch(`${OWN}/api/health`, { signal: AbortSignal.timeout(1_000) });
    return r.ok ? ((await r.json()) as { epoch: string }).epoch : null;
  } catch {
    return null;
  }
}
/** The epoch that the health route answers once `ok` takes it. */
async function healthUntil(ok: (epoch: string) => boolean, ms: number, what: string): Promise<string> {
  const end = Date.now() + ms;
  for (;;) {
    const e = await health();
    if (e !== null && ok(e)) return e;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}
const gate = { "x-kitespan": "1", "content-type": "application/json", origin: OWN };
async function restart(when: "finish" | "now"): Promise<{ status: number; body: unknown }> {
  const r = await fetch(`${OWN}/api/restart`, { method: "POST", headers: gate, body: JSON.stringify({ when }) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

type Frame = Record<string, any>;

class Client {
  readonly frames: Frame[] = [];
  closeCode: number | null = null;
  closeReason = "";
  private constructor(readonly ws: WebSocket) {
    ws.onmessage = (m) => {
      if (typeof m.data === "string") this.frames.push(JSON.parse(m.data) as Frame);
    };
    ws.onclose = (e) => {
      this.closeCode = e.code;
      this.closeReason = e.reason;
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
  async waitFor(pred: (f: Frame) => boolean, ms = 15_000, from = 0): Promise<Frame> {
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
  get epoch(): string {
    return this.frames.find((f) => f.t === "welcome")!.epoch as string;
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
/** Attach, and what the page draws for the chat: the snapshot's history, then the tail that follows it. */
async function attach(c: Client, chat: string): Promise<ChatEvent[]> {
  const from = c.frames.length;
  c.send({ t: "attach", chat, since: 0, epoch: null });
  await c.waitFor((f) => f.t === "attached" && f.chat === chat, 15_000, from);
  const snapshot = await c.waitFor((f) => f.t === "snapshot" && f.chat === chat, 15_000, from);
  await Bun.sleep(300);
  return [...(snapshot.history as ChatEvent[]), ...c.evs(chat, from).map((f) => f.e as ChatEvent)];
}
const rid = () => crypto.randomUUID();
const sendOf = (chat: string, text: string) => {
  const r = rid();
  return { t: "send", rid: r, chat, uuid: r, text, draftRev: null, uploads: [] };
};
const newChatOf = (project: string, text: string) => ({ t: "new_chat", rid: rid(), project, uuid: rid(), text, picks: { model: null, effort: null, mode: null }, uploads: [] });
const lines = (events: readonly ChatEvent[]) => events.flatMap((e) => (e.k === "notice" ? [e.text] : []));
const outLog = (w: World) => join(w.state, "kitespan", "logs", "server-out.log");

/** A turn that asks for a permission and waits for the answer. */
const ASK: Fixture["defaultTurn"] = {
  steps: [
    { say: { id: "$USER_UUID", text: "I will list the files.", tools: [{ id: "toolu_ask_1", name: "Bash", input: { command: "ls" } }] } },
    {
      ask: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" }, tool_use_id: "toolu_ask_1", title: "Claude wants to run ls" },
      then: {
        allow: [{ say: { id: "msg_ask_done", text: "Listed." } }, { emit: { type: "result", subtype: "success", result: "Listed." } }],
        deny: [{ say: { id: "msg_ask_no", text: "Not listed." } }, { emit: { type: "result", subtype: "success", result: "Not listed." } }],
      },
    },
  ],
};
const OK: Fixture["defaultTurn"] = { steps: [{ say: { id: "$USER_UUID", text: "ok" } }, { emit: { type: "result", subtype: "success", result: "ok" } }] };
/** About 8 s of streamed reply: long enough for the preflight and the checks while it runs. */
const SLOW = pacedPrompt(4000, 80, 100);

describe.skipIf(!PROCFS)(`a restart, end to end ${LINUX_ONLY}`, () => {
  const W = world({ transcript: true, defaultTurn: OK, turnsByText: { "ask me": ASK! } });
  let first: Running | null = null;
  let project = "";
  let x = "";
  let y = "";
  let held = "";
  let epoch0 = "";
  afterAll(async () => {
    for (const c of clients) c.close();
    await stopServers(W);
    killFakes(W);
    W.fake.cleanup();
  });

  test(
    "Restart when they finish: the notice, a held send, refusals, the turn's end, bye, and the successor's epoch, where the held send is Not sent",
    async () => {
      expect(servers(W)).toEqual([]);
      first = await launch(W, ["--origin", FLAG_ORIGIN]);
      const added = await fetch(`${OWN}/api/projects`, { method: "POST", headers: gate, body: JSON.stringify({ cwd: W.fake.project }) });
      project = ((await added.json()) as { project: { id: string } }).project.id;
      const A = await page("tab-a");
      const B = await page("tab-b");
      epoch0 = A.epoch;
      y = (await A.request(newChatOf(project, "hello"))).result.chat;
      await A.waitFor((f) => f.t === "chats" && f.delta?.chat === y && f.delta.state === "idle", 15_000);
      x = (await A.request(newChatOf(project, SLOW))).result.chat;
      A.send({ t: "attach", chat: x, since: 0, epoch: null });
      await A.waitFor((f) => f.t === "ev" && f.chat === x && f.e.k === "block_delta", 15_000);

      // An upload whose bytes are still coming when the server stops.
      let pump: ReadableStreamDefaultController<Uint8Array> | null = null;
      const body = new ReadableStream<Uint8Array>({ start: (c) => void (pump = c) });
      const upload = fetch(`${OWN}/api/uploads?chat=${y}&name=cut.txt&type=text%2Fplain`, { method: "POST", headers: { "x-kitespan": "1", "content-type": "application/octet-stream", origin: OWN }, body, duplex: "half" } as RequestInit).then(
        (r) => r.status,
        () => "cut",
      );
      pump!.enqueue(new TextEncoder().encode("the first part of the file\n"));

      expect(await restart("finish")).toEqual({ status: 202, body: { when: "finish" } });
      const notice = { t: "notice", text: DRAIN_LINE, id: "restart", actions: ["cancel_restart", "restart_now"] };
      expect(await A.waitFor((f) => f.t === "notice")).toEqual(notice);
      expect(await B.waitFor((f) => f.t === "notice")).toEqual(notice);
      const C = await page("tab-c");
      expect(await C.waitFor((f) => f.t === "notice")).toEqual(notice);

      const h = sendOf(y, "held by the drain");
      held = h.uuid;
      expect(await A.request(h)).toMatchObject({ ok: true, result: { queued: true } });
      expect(await A.request({ t: "bash", rid: rid(), chat: y, input: "ls", draftRev: null, uploads: [] })).toMatchObject({ ok: false, error: { code: "restarting" } });
      expect(await A.request(newChatOf(project, "not now"))).toMatchObject({ ok: false, error: { code: "restarting" } });
      // The turn is still running: no bye yet.
      expect(A.frames.some((f) => f.t === "bye")).toBe(false);

      await A.waitFor((f) => f.t === "ev" && f.chat === x && f.e.k === "turn_end", 30_000);
      // The close: every page's drain notice becomes "Restarting kitespan...", with no buttons, before the bye.
      for (const P of [A, B, C]) expect(await P.waitFor((f) => f.t === "notice" && f.id === "restart" && f.text !== DRAIN_LINE, 20_000)).toEqual(CLOSING);
      expect(await A.waitFor((f) => f.t === "bye", 20_000)).toEqual({ t: "bye", reason: "restart" });
      expect(A.frames.filter((f) => f.t === "notice" && f.gone)).toEqual([]);
      // The server's close frame carries 1001 (ws-backpressure.test.ts); Bun's own WebSocket client reports it as 1000,
      // with the frame's reason. A cut connection would be 1006 with no reason.
      await until(() => A.closeCode !== null, 5_000, "the close");
      expect([1000, 1001]).toContain(A.closeCode!);
      expect(A.closeReason).toBe("restart");
      expect(await first.proc.exited).toBe(0);
      await first.read;
      expect(first.out).toMatch(/kitespan restarted as process \d+; its lines go to .*server-out\.log\./);
      expect(await upload).toBe("cut");
      // The cut upload left no file.
      const uploadsDir = join(W.tmp, readdirSync(W.tmp).find((n) => n.startsWith("kitespan-uploads-")) ?? "none");
      const files = existsSync(uploadsDir) ? readdirSync(uploadsDir, { recursive: true }).map(String) : [];
      expect(files).toEqual([]);

      // The successor answers on the same port, with a new epoch; its lines are in the state folder's file (0600).
      await until(() => servers(W).length === 1, 15_000, "the successor");
      const e1 = await health();
      expect(e1).not.toBeNull();
      expect(e1).not.toBe(epoch0);
      expect(lstatSync(outLog(W)).mode & 0o777).toBe(0o600);
      const successorLines = readFileSync(outLog(W), "utf8");
      expect(successorLines).toContain(`kitespan listens on ${OWN}\nAlso allowed: 1 origin from --origin\n`);
      // The terminal named the flag's origin; no file holds it, the successor's lines included.
      expect(first.out).toContain(`Also allowed: ${FLAG_ORIGIN} (--origin)\n`);
      const holding = readdirSync(W.fake.root, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => join(e.parentPath, e.name))
        .filter((f) => readFileSync(f, "latin1").includes(new URL(FLAG_ORIGIN).host));
      expect(holding).toEqual([]);
      // The successor still allows it.
      expect((await fetch(`${OWN}/api/settings`, { headers: { host: new URL(FLAG_ORIGIN).host } })).status).toBe(200);
      const D = await page("tab-d");
      expect(D.epoch).toBe(e1!);
      // The held message was never given to Claude Code; it is Not sent now, with Send again.
      expect(W.fake.trace().some((l) => l.t === "user" && l.uuid === held)).toBe(false);
      const ys = await attach(D, y);
      const last = ys.filter((e): e is Extract<ChatEvent, { k: "user" }> => e.k === "user" && e.uuid === held).at(-1);
      expect(last).toMatchObject({ queued: true, notSent: true });
      // The turn that ran during the drain is in the history.
      const xs = await attach(D, x);
      expect(xs.some((e) => e.k === "block" && e.kind === "text" && e.text.length > 1000)).toBe(true);
      expect(lines(xs)).toEqual([]);
    },
    T,
  );

  test(
    "Cancel restart: the notice goes and the held send goes, on the same epoch",
    async () => {
      const A = await page("tab-e");
      const epoch = A.epoch;
      A.send({ t: "attach", chat: x, since: 0, epoch: null });
      const from = A.frames.length;
      expect((await A.request(sendOf(x, SLOW))).ok).toBe(true);
      await A.waitFor((f) => f.t === "ev" && f.chat === x && f.e.k === "block_delta", 15_000, from);
      expect((await restart("finish")).status).toBe(202);
      await A.waitFor((f) => f.t === "notice" && f.text === DRAIN_LINE);
      const h = sendOf(y, "held, then sent");
      expect(await A.request(h)).toMatchObject({ ok: true, result: { queued: true } });
      await Bun.sleep(200);
      expect(W.fake.trace().some((l) => l.t === "user" && l.uuid === h.uuid)).toBe(false);
      const r = await fetch(`${OWN}/api/restart/cancel`, { method: "POST", headers: gate, body: "{}" });
      expect(await r.json()).toEqual({ cancelled: true });
      expect(await A.waitFor((f) => f.t === "notice" && f.gone === true)).toEqual({ t: "notice", text: "", id: "restart", gone: true });
      // The held messages go as at a hold's end: the one from before the restart first, then this one.
      await W.fake.waitFor((l) => l.t === "user" && l.uuid === h.uuid, 15_000);
      const users = W.fake.trace().filter((l) => l.t === "user").map((l) => l.uuid);
      expect(users.indexOf(held)).toBeGreaterThan(-1);
      expect(users.indexOf(held)).toBeLessThan(users.indexOf(h.uuid));
      expect(await health()).toBe(epoch);
      expect(A.frames.some((f) => f.t === "bye")).toBe(false);
      await A.waitFor((f) => f.t === "ev" && f.chat === x && f.e.k === "turn_end", 30_000, from);
    },
    T,
  );

  test(
    "Restart now: the running turn is interrupted, the card is dropped; their lines after the reattach; an old card is stale",
    async () => {
      const A = await page("tab-f");
      const epoch = A.epoch;
      const z = (await A.request(newChatOf(project, "ask me"))).result.chat;
      A.send({ t: "attach", chat: z, since: 0, epoch: null });
      const asked = await A.waitFor((f) => f.t === "ev" && f.chat === z && f.e.k === "card_open", 15_000);
      A.send({ t: "attach", chat: x, since: 0, epoch: null });
      const from = A.frames.length;
      expect((await A.request(sendOf(x, SLOW))).ok).toBe(true);
      await A.waitFor((f) => f.t === "ev" && f.chat === x && f.e.k === "block_delta", 15_000, from);
      const interrupts = W.fake.trace().filter((l) => l.t === "control" && l.subtype === "interrupt").length;
      expect((await restart("now")).status).toBe(202);
      // Restart now with no drain before it: the close's notice all the same, then the bye.
      expect(await A.waitFor((f) => f.t === "notice" && f.id === "restart", 20_000)).toEqual(CLOSING);
      expect(await A.waitFor((f) => f.t === "bye", 30_000)).toEqual({ t: "bye", reason: "restart" });
      expect(W.fake.trace().filter((l) => l.t === "control" && l.subtype === "interrupt").length).toBeGreaterThan(interrupts);
      await until(() => servers(W).length === 1, 15_000, "the old server to go");
      await healthUntil((e) => e !== epoch, 20_000, "the successor's epoch");
      const B = await page("tab-g");
      expect(lines(await attach(B, x))).toContain(TURN_LINE);
      expect(lines(await attach(B, z))).toContain(CARD_LINE);
      const card = asked.e.card.id as string;
      expect(await B.request({ t: "answer", rid: rid(), chat: z, card, answer: { kind: "permission", allow: true, scope: "once" } })).toMatchObject({ ok: false, error: { code: "stale" } });
    },
    T,
  );

  test(
    "a successor that fails: a bad line in the start-env file makes bin/kitespan refuse, and the old server listens again with the same epoch",
    async () => {
      const A = await page("tab-h");
      const epoch = A.epoch;
      const startEnv = join(W.config, "kitespan", "start-env");
      mkdirSync(dirname(startEnv), { recursive: true });
      writeFileSync(startEnv, "this is not a start-env line\n", { mode: 0o600 });
      try {
        expect((await restart("finish")).status).toBe(202);
        expect(await A.waitFor((f) => f.t === "bye", 30_000)).toEqual({ t: "bye", reason: "restart" });
        expect(await healthUntil(() => true, 30_000, "the old server to listen again")).toBe(epoch);
        expect(servers(W)).toHaveLength(1);
        expect(readFileSync(outLog(W), "utf8")).toContain("start-env line 1");
        const B = await page("tab-i");
        expect(B.epoch).toBe(epoch);
        // The close's "Restarting kitespan..." does not stand for a page of the server that listens again; the
        // failure's line does (a phone that slept through it learns it from its hello).
        expect(await B.waitFor((f) => f.t === "notice" && f.id === "restart_failed", 5_000)).toEqual({ t: "notice", text: "kitespan did not restart. Its lines are in server-out.log.", id: "restart_failed" });
        await Bun.sleep(100);
        expect(B.frames.filter((f) => f.t === "notice" && f.id === "restart")).toEqual([]);
        // It takes work again.
        expect((await B.request(sendOf(y, "after the failed restart"))).ok).toBe(true);
      } finally {
        rmSync(startEnv, { force: true });
      }
    },
    T,
  );
});

describe.skipIf(!PROCFS)(`the close's check of the claude children (S11) ${LINUX_ONLY}`, () => {
  const W = world({ transcript: true, ignoreStdinEnd: true, ignoreSigterm: true, defaultTurn: OK });
  afterAll(async () => {
    for (const c of clients) c.close();
    await stopServers(W);
    killFakes(W);
    W.fake.cleanup();
  });

  test(
    "a fake claude that ignores SIGTERM is gone before the successor starts",
    async () => {
      expect(servers(W)).toEqual([]);
      const first = await launch(W);
      const added = await fetch(`${OWN}/api/projects`, { method: "POST", headers: gate, body: JSON.stringify({ cwd: W.fake.project }) });
      const project = ((await added.json()) as { project: { id: string } }).project.id;
      const A = await page("tab-s");
      const chat = (await A.request(newChatOf(project, "hello"))).result.chat;
      await A.waitFor((f) => f.t === "chats" && f.delta?.chat === chat && f.delta.state === "idle", 15_000);
      const fakes = fakesOf(W);
      expect(fakes).toHaveLength(1);
      const own = first.proc.pid;
      expect((await restart("finish")).status).toBe(202);
      // Watch: the first moment a successor exists, the old claude must be gone.
      let seen: { successor: number; fakeAlive: boolean } | null = null;
      await until(() => {
        const next = servers(W).find((p) => p !== own);
        if (next !== undefined && !seen) seen = { successor: next, fakeAlive: fakes.some((p) => alive(p) && !zombie(p)) };
        return seen !== null;
      }, 30_000, "the successor");
      expect(seen!.fakeAlive).toBe(false);
      expect(W.fake.trace().some((l) => l.t === "sigterm")).toBe(true);
      expect(await first.proc.exited).toBe(0);
    },
    T,
  );
});

// R17 with S11: the close ends a short read of the model list (row 81) that is in flight, so its claude is gone
// before the successor starts, and none starts during the close.
describe.skipIf(!PROCFS)(`a short read in flight at the restart's close (R17, S11) ${LINUX_ONLY}`, () => {
  // A Claude Code whose initialize answer comes late, so the read still waits when the close starts, and which
  // outlives the end of its stdin: only a signal ends it.
  const W = world({ transcript: true, initializeDelayMs: 30_000, ignoreStdinEnd: true, defaultTurn: OK });
  afterAll(async () => {
    for (const c of clients) c.close();
    await stopServers(W);
    killFakes(W);
    W.fake.cleanup();
  });

  test(
    "its claude is gone before the successor starts",
    async () => {
      expect(servers(W)).toEqual([]);
      const first = await launch(W);
      const added = await fetch(`${OWN}/api/projects`, { method: "POST", headers: gate, body: JSON.stringify({ cwd: W.fake.project }) });
      const project = ((await added.json()) as { project: { id: string } }).project.id;
      void fetch(`${OWN}/api/projects/${project}/models`, { headers: { "x-kitespan": "1", origin: OWN } }).catch(() => {});
      await until(() => fakesOf(W).length === 1, 10_000, "the short read's claude");
      await W.fake.waitFor((l) => l.t === "control" && l.subtype === "initialize", 10_000);
      const fakes = fakesOf(W);
      const own = first.proc.pid;
      expect((await restart("now")).status).toBe(202);
      let seen: { successor: number; fakeAlive: boolean } | null = null;
      await until(() => {
        const next = servers(W).find((p) => p !== own);
        if (next !== undefined && !seen) seen = { successor: next, fakeAlive: fakes.some((p) => alive(p) && !zombie(p)) };
        return seen !== null;
      }, 30_000, "the successor");
      expect(seen!.fakeAlive).toBe(false);
      expect(await first.proc.exited).toBe(0);
      // One claude only: the short read's.
      expect(W.fake.trace().filter((l) => l.t === "start")).toHaveLength(1);
    },
    T,
  );
});
