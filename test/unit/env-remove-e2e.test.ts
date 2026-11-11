// Row 99 end to end: the real server (server/main.ts) as its own process on a free port of 127.0.0.1, with a scratch
// HOME, CLAUDE_CONFIG_DIR and XDG folders and the fake claude of test/fake-claude/ first on PATH (it writes each
// session's transcript as the CLI does). An environment with a chat whose Claude Code stays open: Remove is refused
// while that chat works; then it is removed. What goes: the project, the chat's ledger, draft, notes and queue file, its
// upload records, the new-chat form's upload and its folder, and the chat's Claude Code process. What never goes: the
// transcripts under CLAUDE_CONFIG_DIR/projects, the folder and its files, a chat upload's file. Every page hears
// `projects` with `removed` before the chat's `gone`. Remove releases the chat's session for the folder (released.json,
// 0600): adding the folder again makes a new environment whose From the terminal lists the terminal's session and the
// removed chat's, but no other session of the SDK's own in that folder (L5); a Continue here of it takes it out again.

import type { Subprocess } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { installFakeClaude, loadFixture, type Fixture, type Turn } from "../fake-claude/install";
import { LINUX_ONLY, PROCFS } from "../linux";
import { freePort } from "./free-port";

const ROOT = resolve(import.meta.dir, "..", "..");
const MAIN = join(ROOT, "server", "main.ts");
const PORT = freePort();
const OWN = `http://127.0.0.1:${PORT}`;
const T = 40_000;

const text = loadFixture("text-thinking");
const done = (id: string, reply: string): Turn => ({ steps: [{ say: { id, text: reply } }, { emit: { type: "result", subtype: "success", result: reply } }] });
const fixture: Fixture = {
  transcript: true,
  onStart: text.onStart,
  turnsByText: {
    hello: done("msg_env_hello", "Hello from the fake."),
    "take your time": { steps: [{ sleep: 2_500 }, ...done("msg_env_slow", "Done at last.").steps] },
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
// The folder's own files: Remove never touches them.
writeFileSync(join(PROJECT, "README.md"), "# demo\n");
mkdirSync(join(PROJECT, "src"));
writeFileSync(join(PROJECT, "src", "main.ts"), "export {};\n");
const folderList = () => readdirSync(PROJECT, { recursive: true }).map(String).sort();
const FOLDER_BEFORE = folderList();

const ENV: Record<string, string> = {
  PATH: `${fake.binDir}:/usr/bin:/bin`,
  HOME,
  ZDOTDIR: HOME,
  CLAUDE_CONFIG_DIR: CONFIG,
  XDG_STATE_HOME: STATE,
  XDG_CONFIG_HOME: join(fake.root, "config"),
  TMPDIR: join(fake.root, "tmp"),
};
const KITESPAN = join(STATE, "kitespan");
const TRANSCRIPTS = join(CONFIG, "projects", PROJECT.replace(/[^a-zA-Z0-9]/g, "-"));
/** A session from the terminal in the same folder, written as the CLI writes one: Remove leaves it too. */
const TERMINAL_SESSION = "1b0f5c1e-1d2a-4c3b-8d4e-5f6a7b8c9d0e";
/** Another app's SDK session in the same folder (entrypoint sdk-ts), never a kitespan chat's: it never lists (L5). */
const OTHER_SDK_SESSION = "2c1e6d2f-2e3b-4d4c-9e5f-6a7b8c9d0e1f";

function plantSession(id: string, entrypoint: "cli" | "sdk-ts", prompt: string): void {
  mkdirSync(TRANSCRIPTS, { recursive: true });
  const at = (i: number) => new Date(Date.UTC(2026, 10, 1, 12, 0, i)).toISOString();
  const row = (type: "user" | "assistant", uuid: string, parentUuid: string | null, content: unknown, i: number) =>
    JSON.stringify({
      type,
      message: type === "user" ? { role: "user", content } : { id: `msg_${uuid}`, type: "message", role: "assistant", model: "claude-fake-1", content },
      uuid,
      parentUuid,
      sessionId: id,
      timestamp: at(i),
      cwd: PROJECT,
      isSidechain: false,
      userType: "external",
      entrypoint,
      version: "2.1.312",
    });
  const a = "aaaaaaaa-0000-4000-8000-000000000001";
  const b = "aaaaaaaa-0000-4000-8000-000000000002";
  writeFileSync(join(TRANSCRIPTS, `${id}.jsonl`), `${row("user", a, null, prompt, 0)}\n${row("assistant", b, a, [{ type: "text", text: "A README." }], 1)}\n`);
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
let server: Running | null = null;

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

/** Stop the server by its pid with SIGTERM, after kill -0 and a check that the pid is still this server. */
async function stop(r: Running): Promise<void> {
  const pid = r.proc.pid;
  if (r.proc.exitCode === null && alive(pid) && cmdline(pid).includes(MAIN)) process.kill(pid, "SIGTERM");
  await r.proc.exited;
}

type Frame = Record<string, any>;
const clients: WebSocket[] = [];

async function page(tab: string): Promise<{ frames: Frame[]; send(o: unknown): void; waitFor(pred: (f: Frame) => boolean, ms?: number, from?: number): Promise<Frame> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { origin: OWN } });
  clients.push(ws);
  const frames: Frame[] = [];
  ws.onmessage = (m) => {
    if (typeof m.data === "string") frames.push(JSON.parse(m.data) as Frame);
  };
  await new Promise<void>((ok, bad) => {
    ws.onopen = () => ok();
    ws.onerror = () => bad(new Error("the socket did not open"));
  });
  const waitFor = async (pred: (f: Frame) => boolean, ms = 10_000, from = 0) => {
    const end = Date.now() + ms;
    for (;;) {
      const hit = frames.slice(from).find(pred);
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`timed out; frames: ${frames.slice(from).map((f) => (f.t === "ev" ? `ev:${f.e.k}` : f.t)).join(", ")}`);
      await Bun.sleep(20);
    }
  };
  const send = (o: unknown) => ws.send(JSON.stringify(o));
  send({ t: "hello", v: 1, tab });
  await waitFor((f) => f.t === "chats" && "list" in f);
  return { frames, send, waitFor };
}

const rid = () => crypto.randomUUID();
const post = (path: string, body: unknown = {}) => fetch(`${OWN}${path}`, { method: "POST", headers: { "x-kitespan": "1", "content-type": "application/json", origin: OWN }, body: JSON.stringify(body) });
const upload = (query: string) =>
  fetch(`${OWN}/api/uploads?${query}&name=notes.txt&type=text%2Fplain`, { method: "POST", headers: { "x-kitespan": "1", "content-type": "application/octet-stream", origin: OWN }, body: "a note\n" });

afterAll(async () => {
  for (const ws of clients) ws.close();
  if (server) await stop(server);
  for (const pid of PROCFS ? liveFakes() : []) if (cmdline(pid).includes(fake.fixturePath)) process.kill(pid, "SIGKILL");
  fake.cleanup();
});

describe.skipIf(!PROCFS)(`an environment's Remove on the real server (row 99) ${LINUX_ONLY}`, () => {
  test(
    "refused while its chat works; then the chat and the project leave kitespan, and the transcripts and the folder stay",
    async () => {
      plantSession(TERMINAL_SESSION, "cli", "What is in this folder?");
      plantSession(OTHER_SDK_SESSION, "sdk-ts", "From another app's SDK");
      server = await boot();
      const A = await page("tab-a");
      const added = await post("/api/projects", { cwd: PROJECT });
      expect(added.status).toBe(201);
      const projectId = ((await added.json()) as { project: { id: string } }).project.id;
      // Every page hears of the new environment.
      await A.waitFor((f) => f.t === "projects" && !("removed" in f));

      const ack = await (async () => {
        const id = rid();
        A.send({ t: "new_chat", rid: id, project: projectId, uuid: rid(), text: "hello", picks: { model: null, effort: null, mode: null }, uploads: [] });
        return A.waitFor((f) => f.t === "ack" && f.rid === id);
      })();
      expect(ack.ok).toBe(true);
      const chat = ack.result.chat as string;
      A.send({ t: "attach", chat, since: 0, epoch: null });
      await A.waitFor((f) => f.t === "ev" && f.chat === chat && f.e.k === "turn_end", 15_000);
      const sid = JSON.parse(readFileSync(join(KITESPAN, "chats", `${chat}.json`), "utf8")).sessionId as string;
      const transcript = join(TRANSCRIPTS, `${sid}.jsonl`);
      expect(existsSync(transcript)).toBe(true);
      const fakePid = liveFakes()[0]!;
      expect(fakePid).toBeGreaterThan(0);

      // The chat's draft, a chat upload and a new-chat form upload.
      A.send({ t: "draft", chat, text: "words not sent", mode: "chat", command: null, link: false, uploads: [] });
      await until(() => existsSync(join(KITESPAN, "drafts", `${chat}.json`)), 5_000, "the draft file");
      const chatUpload = (await (await upload(`chat=${chat}`)).json()) as { upload: { id: string; path: string } };
      const formUpload = (await (await upload(`project=${projectId}`)).json()) as { upload: { id: string; path: string } };
      expect(existsSync(chatUpload.upload.path)).toBe(true);
      expect(existsSync(formUpload.upload.path)).toBe(true);

      // A turn that runs: Remove is refused with its one line, and nothing goes.
      const slow = rid();
      A.send({ t: "send", rid: slow, chat, uuid: slow, text: "take your time", draftRev: null, uploads: [] });
      await A.waitFor((f) => f.t === "chats" && f.delta?.chat === chat && f.delta.state === "running");
      const refused = await post(`/api/projects/${projectId}/remove`);
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({ error: { code: "busy", message: "A chat here is working or needs input. Remove this environment when it is done." } });
      expect(existsSync(join(KITESPAN, "chats", `${chat}.json`))).toBe(true);
      expect(A.frames.some((f) => f.t === "projects" && f.removed)).toBe(false);
      const ended = A.frames.length;
      await A.waitFor((f) => f.t === "ev" && f.chat === chat && f.e.k === "turn_end", 15_000, ended);
      // The chat is idle and its Claude Code stays open.
      expect(alive(fakePid)).toBe(true);

      const B = await page("tab-b");
      const from = A.frames.length;
      const removed = await post(`/api/projects/${projectId}/remove`);
      expect(removed.status).toBe(200);
      expect(await removed.json()).toEqual({ removed: projectId });

      // Every page: `projects` with `removed`, then the chat's `gone`, then the list to read again.
      for (const p of [A, B]) {
        const at = (pred: (f: Frame) => boolean) => p.frames.findIndex((f, i) => i >= (p === A ? from : 0) && pred(f));
        await p.waitFor((f) => f.t === "projects" && !("removed" in f), 5_000, p === A ? from : 0);
        const told = at((f) => f.t === "projects" && f.removed === projectId);
        const gone = at((f) => f.t === "chats" && f.delta?.chat === chat && f.delta.gone === true);
        const reread = p.frames.findIndex((f, i) => i > gone && f.t === "projects" && !("removed" in f));
        expect(told).toBeGreaterThanOrEqual(0);
        expect(gone).toBeGreaterThan(told);
        expect(reread).toBeGreaterThan(gone);
      }

      // What goes.
      for (const d of ["chats", "drafts", "notes", "queue"]) expect(existsSync(join(KITESPAN, d, `${chat}.json`))).toBe(false);
      const projects = JSON.parse(readFileSync(join(KITESPAN, "projects.json"), "utf8")) as { projects: { id: string }[] };
      expect(projects.projects.map((p) => p.id)).not.toContain(projectId);
      const uploads = JSON.parse(readFileSync(join(KITESPAN, "uploads.json"), "utf8")) as { uploads: { id: string }[] };
      expect(uploads.uploads).toEqual([]);
      expect(existsSync(formUpload.upload.path)).toBe(false);
      await until(() => !alive(fakePid), 10_000, "the chat's Claude Code to end");
      expect((await fetch(`${OWN}/api/projects`).then((r) => r.json())) as unknown).toEqual({ projects: [] });

      // What never goes: the transcripts, the folder and its files, a chat upload's file.
      expect(existsSync(transcript)).toBe(true);
      expect(existsSync(join(TRANSCRIPTS, `${TERMINAL_SESSION}.jsonl`))).toBe(true);
      expect(folderList()).toEqual(FOLDER_BEFORE);
      expect(existsSync(chatUpload.upload.path)).toBe(true);

      expect(existsSync(join(TRANSCRIPTS, `${OTHER_SDK_SESSION}.jsonl`))).toBe(true);
      // Remove released the chat's session for the folder, 0600, through the atomic writer.
      const releasedFile = join(KITESPAN, "released.json");
      expect(statSync(releasedFile).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(releasedFile, "utf8"))).toEqual({ v: 1, folders: [{ cwd: PROJECT, ids: [sid] }] });

      // The same folder again: a new environment. From the terminal lists the terminal's session and the removed chat's
      // (an sdk-ts transcript), and not the other sdk-ts session of the folder.
      expect(readFileSync(transcript, "utf8")).toContain('"entrypoint":"sdk-ts"');
      const again = await post("/api/projects", { cwd: PROJECT });
      expect(again.status).toBe(201);
      const next = ((await again.json()) as { project: { id: string } }).project.id;
      expect(next).not.toBe(projectId);
      const listed = async () => ((await (await fetch(`${OWN}/api/projects/${next}/sessions`)).json()) as { sessions: { sessionId: string }[] }).sessions.map((s) => s.sessionId).sort();
      expect(await listed()).toEqual([sid, TERMINAL_SESSION].sort());
      // Its preview reads, as any session's from the terminal does.
      expect((await fetch(`${OWN}/api/projects/${next}/sessions/${sid}`)).status).toBe(200);

      // Continue here makes it a chat again: it leaves the list and the record.
      const cont = await (async () => {
        const id = rid();
        A.send({ t: "continue_session", rid: id, project: next, session: sid });
        return A.waitFor((f) => f.t === "ack" && f.rid === id);
      })();
      expect(cont.ok).toBe(true);
      expect(cont.result.chat).not.toBe(chat);
      await until(() => !JSON.stringify(JSON.parse(readFileSync(releasedFile, "utf8"))).includes(sid), 5_000, "the record to drop the continued session");
      expect(await listed()).toEqual([TERMINAL_SESSION]);
    },
    T,
  );
});
