// The side box's draft end to end (FIX-U2 section 2; D49): the real server (server/main.ts) as its own process on a free
// port of 127.0.0.1, with a scratch HOME, CLAUDE_CONFIG_DIR and XDG folders and the fake claude first on PATH (the real
// claude never runs). Two pages' sockets on one chat: the side box's draft typed on page A reaches page B (and A) as
// the side draft, never as the message box's; it is in `side/<chat id>.draft.json` (0600) and survives a server
// restart, where both new pages get it in `attached`; a side question sent from page B's side box clears it on both
// pages and in the file, and the question reaches Claude Code as a side question, never as a message.
//
// The tests run in order and share one server life per restart; each depends on the ones before it.

import type { Subprocess } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { installFakeClaude, type Fixture, type TraceLine } from "../fake-claude/install";
import { LINUX_ONLY, PROCFS } from "../linux";
import { freePort } from "./free-port";

const ROOT = resolve(import.meta.dir, "..", "..");
const MAIN = join(ROOT, "server", "main.ts");
const PORT = freePort();
const OWN = `http://127.0.0.1:${PORT}`;
const T = 30_000;

const fixture: Fixture = {
  transcript: true,
  turnsByText: {
    "plan the upload": { steps: [{ say: { id: "msg_sd_1", text: "Planned." } }, { emit: { type: "result", subtype: "success", result: "Planned." } }] },
  },
};
const fake = installFakeClaude(fixture);
const HOME = join(fake.root, "home");
const STATE = join(fake.root, "state");
const DIST = join(fake.root, "dist");
for (const d of [HOME, STATE, join(fake.root, "config"), join(fake.root, "tmp"), DIST]) mkdirSync(d, { recursive: true });
writeFileSync(join(DIST, "index.html"), "<!doctype html><html><body>kitespan page</body></html>");
const ENV: Record<string, string> = {
  PATH: `${fake.binDir}:/usr/bin:/bin`,
  HOME,
  CLAUDE_CONFIG_DIR: join(HOME, ".claude"),
  XDG_STATE_HOME: STATE,
  XDG_CONFIG_HOME: join(fake.root, "config"),
  TMPDIR: join(fake.root, "tmp"),
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
/** The fake claude processes alive now (their command line names this test's fixture file). */
function liveFakes(): number[] {
  const out: number[] = [];
  for (const name of readdirSync("/proc")) if (/^\d+$/.test(name) && cmdline(Number(name)).includes(fake.fixturePath)) out.push(Number(name));
  return out;
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
    if (proc.exitCode !== null || Date.now() > end) throw new Error(`the server did not start (exit ${proc.exitCode}): ${r.err}`);
    await Bun.sleep(50);
  }
  return r;
}
/** SIGTERM to this test's own server, by its pid, after kill -0 and a check of its command line. */
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
    ws.onclose = () => {
      this.closed = true;
    };
  }
  static open(): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { origin: OWN } });
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
  drafts(chat: string, from = 0): Frame[] {
    return this.frames.slice(from).filter((f) => f.t === "draft" && f.chat === chat);
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
let server: Running | null = null;
async function hello(tab: string): Promise<{ c: Client; welcome: Frame }> {
  const c = await Client.open();
  clients.push(c);
  c.send({ t: "hello", v: 1, tab });
  const welcome = await c.waitFor((f) => f.t === "welcome");
  await c.waitFor((f) => f.t === "chats" && "list" in f);
  return { c, welcome };
}
async function attach(c: Client, chat: string): Promise<Frame> {
  const from = c.frames.length;
  c.send({ t: "attach", chat, since: 0, epoch: null });
  const attached = await c.waitFor((f) => f.t === "attached" && f.chat === chat, 10_000, from);
  await c.waitFor((f) => f.t === "snapshot" && f.chat === chat, 10_000, from);
  return attached;
}
const rid = () => crypto.randomUUID();
const sideFile = () => join(STATE, "kitespan", "side", `${chat}.draft.json`);
const mainFile = () => join(STATE, "kitespan", "drafts", `${chat}.json`);
const users = (): TraceLine[] => fake.trace().filter((l) => l.t === "user");

let chat = "";
let rev = 0;
const QUESTION = "Which file holds the upload cap?";

afterAll(async () => {
  for (const c of clients) c.close();
  if (server) await stop(server);
  for (const pid of PROCFS ? liveFakes() : []) if (cmdline(pid).includes(fake.fixturePath)) process.kill(pid, "SIGKILL");
  fake.cleanup();
});

describe.skipIf(!PROCFS)(`the side box's draft with the real server and two pages ${LINUX_ONLY}`, () => {
  let A: Client;
  let B: Client;

  test(
    "two pages on one chat: each attach carries the side box's draft beside the message box's",
    async () => {
      server = await boot();
      const added = await fetch(`${OWN}/api/projects`, { method: "POST", headers: { "x-kitespan": "1", "content-type": "application/json", origin: OWN }, body: JSON.stringify({ cwd: fake.project }) });
      expect(added.status).toBe(201);
      const projectId = ((await added.json()) as { project: { id: string } }).project.id;
      A = (await hello("tab-a")).c;
      const ack = await A.request({ t: "new_chat", rid: rid(), project: projectId, uuid: rid(), text: "plan the upload", picks: { model: null, effort: null, mode: null }, uploads: [] });
      expect(ack.ok).toBe(true);
      chat = ack.result.chat;
      const a = await attach(A, chat);
      await A.waitFor((f) => f.t === "ev" && f.chat === chat && f.e.k === "turn_end", 15_000);
      const h = await hello("tab-b");
      expect(h.welcome.capabilities?.sideQuestions).toBe(true);
      B = h.c;
      const b = await attach(B, chat);
      for (const at of [a, b]) {
        expect(at.sideDraft).toMatchObject({ rev: 0, text: "", mode: "chat", command: null, link: false, uploads: [], by: null });
        expect(at.draft).toMatchObject({ rev: 0, text: "" });
      }
    },
    T,
  );

  test(
    "the side box's text typed on page A reaches page B (and A) as the side draft, never as the message box's",
    async () => {
      const fromA = A.frames.length;
      const fromB = B.frames.length;
      A.send({ t: "draft", chat, box: "side", text: QUESTION, mode: "chat", command: null, link: false, uploads: [] });
      const onB = await B.waitFor((f) => f.t === "draft" && f.chat === chat, 5_000, fromB);
      const onA = await A.waitFor((f) => f.t === "draft" && f.chat === chat, 5_000, fromA);
      expect(onB).toMatchObject({ box: "side", text: QUESTION, mode: "chat", by: "tab-a", link: false, uploads: [] });
      expect(onB.rev).toBe(1);
      expect(onA).toEqual(onB);
      rev = onB.rev;
      await Bun.sleep(200);
      expect(B.drafts(chat, fromB).filter((f) => f.box !== "side")).toEqual([]);
      // Written next to the side thread within the main draft's window (at most once a second), 0600.
      await until(() => existsSync(sideFile()), 3_000, "the side draft's file");
      expect(lstatSync(sideFile()).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(sideFile(), "utf8"))).toMatchObject({ v: 1, id: chat, box: "side", rev, text: QUESTION, by: "tab-a" });
      expect(existsSync(mainFile()) ? JSON.parse(readFileSync(mainFile(), "utf8")).text : "").toBe("");
    },
    T,
  );

  test(
    "it survives a server restart: both new pages get it at attach, with its rev",
    async () => {
      const fromA = A.frames.length;
      expect(await stop(server!)).toBe(0);
      server = null;
      await A.waitFor((f) => f.t === "bye", 5_000, fromA);
      await until(() => A.closed && B.closed, 5_000, "both sockets to close");
      server = await boot();
      A = (await hello("tab-a2")).c;
      B = (await hello("tab-b2")).c;
      for (const c of [A, B]) {
        const at = await attach(c, chat);
        expect(at.sideDraft).toMatchObject({ rev, text: QUESTION, by: "tab-a" });
        expect(at.state).toBe("sleeping");
      }
    },
    T,
  );

  test(
    "a side question sent from page B's side box clears it on both pages and in the file; Claude Code gets no message",
    async () => {
      const before = users().length;
      const fromA = A.frames.length;
      const fromB = B.frames.length;
      const ack = await B.request({ t: "side_question", rid: rid(), chat, id: rid(), text: QUESTION, draftRev: rev }, 20_000);
      expect(ack.ok).toBe(true);
      expect(ack.result.answered).toMatchObject({ question: QUESTION, state: "answered" });
      for (const [c, from] of [[A, fromA], [B, fromB]] as const) {
        const d = await c.waitFor((f) => f.t === "draft" && f.chat === chat && f.box === "side", 5_000, from);
        expect(d).toMatchObject({ rev: rev + 1, text: "", by: "tab-b2" });
      }
      await until(() => JSON.parse(readFileSync(sideFile(), "utf8")).rev === rev + 1, 3_000, "the cleared file");
      expect(JSON.parse(readFileSync(sideFile(), "utf8"))).toMatchObject({ box: "side", text: "", by: "tab-b2" });
      // The question went to Claude Code as a side question, never as a message.
      expect(fake.trace().some((l) => l.t === "side_question" && l.question === QUESTION)).toBe(true);
      expect(users().length).toBe(before);
    },
    T,
  );

  test(
    "SIGTERM stops the server with exit 0 and nothing on stderr",
    async () => {
      const last = server!;
      expect(await stop(last)).toBe(0);
      server = null;
      expect(last.err).toBe("");
    },
    T,
  );
});
