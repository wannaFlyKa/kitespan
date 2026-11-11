// Row 99 in iteration 4's part 2: an environment's Remove with worktrees and variables. The real registry, the
// environments' Remove, the released sessions and the variables store, on a scratch repository with kitespan's own git
// (worktree-repo.ts) and the scripted driver in Claude Code's place. Each chat with a worktree of kitespan's own
// follows Archive's rule (L25): a clean one goes and its branch stays; one with changes or ignored work stays on disk,
// its ledger gone and its branch kept; one that a copy shares (L27) and a terminal session's linked one (W12) are never
// removed. The variables file goes after the chats. A released session whose transcript is filed under a worktree's
// folder lists again From the terminal when the main folder is added again, read there (and its preview and Continue
// here too). Remove is refused while a worktree is in the making there or another app holds a chat; the project's
// records in the making go with it, and while one cannot go the project stays.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NewChatFrame } from "../../shared/protocol";
import { PUBLIC_ADAPTERS } from "../../server/adapters/adapters";
import { Environments, REMOVE_BUSY } from "../../server/chats/environments";
import { ChatRegistry } from "../../server/chats/registry";
import { FakeDriver, MemoryStore, apply, autoReply, projectRecord, settle } from "../../server/chats/testing";
import { createEnvStore, type EnvStore } from "../../server/env/store";
import { createGate } from "../../server/gate/guards";
import { createApi } from "../../server/http/api";
import { createApp, type Upgrader } from "../../server/http/app";
import { loadSite } from "../../server/http/static";
import { ownUid } from "../../server/store/files";
import { RELEASED, ReleasedSessions } from "../../server/store/released";
import { findGit } from "../../server/search/git";
import { WorktreeHost } from "../../server/worktree/host";
import { makeWorktree } from "../../server/worktree/ops";
import { branches, git, scratch, type Scratch } from "./worktree-repo";

const PORT = 7947;
const OWN = `http://127.0.0.1:${PORT}`;
const PROJECT = "k3m7q2x4ab";
const OTHER_CHAT = "abcdefghijklmnopqrst";
const GIT = findGit(process.env.PATH ?? "")!;
const SENDER: Record<string, string> = { "x-kitespan": "1", "content-type": "application/json", origin: OWN };
const noServer: Upgrader = { upgrade: () => false };
const rid = () => crypto.randomUUID();

let open: { s: Scratch; reg: ChatRegistry; state: string }[] = [];
afterEach(async () => {
  for (const o of open) {
    await o.reg.shutdown();
    o.s.cleanup();
    rmSync(o.state, { recursive: true, force: true });
  }
  open = [];
});

/** A stand-in for git: `body` runs in sh first for each call whose arguments hold `match`. */
function standIn(s: Scratch, match: string, body: string): string {
  const p = join(s.root, `git-${match.replace(/\W/g, "-")}`);
  writeFileSync(p, `#!/bin/sh\ncase " $* " in *" ${match} "*) ${body};; esac\nexec '${GIT}' "$@"\n`);
  chmodSync(p, 0o755);
  return p;
}

async function setup(opts: { git?: (s: Scratch) => string; openCheckMs?: number } = {}) {
  const s = scratch();
  const state = mkdtempSync(join(tmpdir(), "kitespan-env-remove-wt-"));
  mkdirSync(join(state, "env"), { mode: 0o700 });
  const wg = opts.git ? { ...s.wg, git: opts.git(s) } : s.wg;
  const driver = new FakeDriver();
  autoReply(driver);
  // The SDK leaves its own sessions (kitespan's chats') out of From the terminal (L5): only listReleased finds them.
  driver.listSessions = async () => [];
  const store = new MemoryStore();
  store.projects = [{ ...projectRecord(PROJECT, s.repo), worktree: true }];
  const env: EnvStore = createEnvStore({ dir: join(state, "env") });
  await env.open();
  const released = new ReleasedSessions({ dir: state, uid: ownUid() });
  await released.open();
  const reg = new ChatRegistry(
    {
      driver,
      store,
      env,
      worktreeGit: wg,
      worktreeData: s.data,
      continued: (id) => void released.unrelease([id]),
      releasedFolder: (cwd, id) => released.folderOf(cwd, id),
    },
    { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 5_000, ...(opts.openCheckMs ? { openCheckMs: opts.openCheckMs, openFastMs: opts.openCheckMs } : {}) },
  );
  await reg.boot();
  open.push({ s, reg, state });
  const notes: (string | undefined)[] = [];
  const environments = new Environments({ store, chats: reg, env, released, notify: (removed) => notes.push(removed), uid: ownUid() });
  const gate = createGate(PORT, []);
  const site = loadSite(join(s.root, "no-dist"), gate.origins);
  const api = createApi({
    gate,
    safe: site.safe,
    store,
    driver,
    uploadFolder: async () => ({ ok: true, path: "/tmp/kitespan-uploads-x", choice: "temp" }),
    chatForSession: (id) => reg.chatForSession(id),
    heldSessions: () => reg.heldSessions(),
    info: { port: PORT, version: "0.4.0", adapters: { ...PUBLIC_ADAPTERS, origins: [] } },
    worktrees: new WorktreeHost({ worktreeGit: wg, worktreeData: s.data }),
    env,
    environments,
    releasedOf: (cwd) => released.of(cwd),
  });
  const app = createApp({ gate, site, api, sockets: {} });
  const call = async (path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const init = body === undefined ? { method: "GET", headers: { host: `127.0.0.1:${PORT}` } } : { method: "POST", headers: { host: `127.0.0.1:${PORT}`, ...SENDER }, body: JSON.stringify(body) };
    const r = (await app.fetch(new Request(`${OWN}${path}`, init), noServer))!;
    return { status: r.status, body: await r.json() };
  };
  return { s, state, driver, store, env, released, reg, environments, call, notes };
}

const frame = (text: string): NewChatFrame => ({ t: "new_chat", rid: rid(), project: PROJECT, uuid: rid(), text, picks: { model: null, effort: null, mode: null }, uploads: [] });
async function newChat(reg: ChatRegistry, text = "Plan it"): Promise<string> {
  const o = await apply(reg, frame(text));
  if (!o.ok) throw new Error(`new_chat refused: ${o.code}`);
  await settle(10);
  return (o.result as { chat: string }).chat;
}
const dirOf = (s: Scratch) => join(s.data, "kitespan", "worktrees", PROJECT);
const listed = (s: Scratch) => git(s.repo, "worktree", "list", "--porcelain").match(/^worktree .*$/gm)!.map((l) => l.slice("worktree ".length));
async function until(pred: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

describe("Remove with worktrees (L25, L27, W12)", () => {
  test("a clean worktree goes and its branch stays; one with changes or ignored work stays on disk, its branch kept", async () => {
    const { s, store, reg, driver, call } = await setup();
    writeFileSync(join(s.repo, ".gitignore"), "build/\n");
    git(s.repo, "add", ".gitignore");
    git(s.repo, "commit", "-q", "-m", "ignore build");
    const clean = await newChat(reg, "clean");
    const changed = await newChat(reg, "changed");
    const ignored = await newChat(reg, "ignored");
    const w = async (id: string) => (await store.readChat(id))!.worktree!;
    const [wc, wd, wi] = [await w(clean), await w(changed), await w(ignored)];
    for (const n of ["a.md", "b.md", "c.md"]) writeFileSync(join(wd.path, n), "work\n");
    mkdirSync(join(wi.path, "build"));
    writeFileSync(join(wi.path, "build", "out.bin"), "built\n");
    // What the confirm reads (Delete's GET): the changes of each, as counts only.
    expect((await call(`/api/chats/${changed}/worktree`)).body).toMatchObject({ path: wd.path, changes: 3, ignored: false });
    expect((await call(`/api/chats/${ignored}/worktree`)).body).toMatchObject({ path: wi.path, changes: 0, ignored: true });

    const r = await call(`/api/projects/${PROJECT}/remove`, {});
    expect(r).toEqual({ status: 200, body: { removed: PROJECT } });
    expect(existsSync(wc.path)).toBe(false);
    expect(readFileSync(join(wd.path, "a.md"), "utf8")).toBe("work\n");
    expect(existsSync(join(wi.path, "build", "out.bin"))).toBe(true);
    expect(listed(s).sort()).toEqual([s.repo, wd.path, wi.path].sort());
    expect(branches(s.repo)).toEqual(["main", wc.branch, wd.branch, wi.branch].sort());
    // The ledgers went; the transcripts stayed; no record in the making is left.
    for (const id of [clean, changed, ignored]) expect(store.chats.has(id)).toBe(false);
    expect(driver.deletedSessions).toEqual([]);
    expect(readdirSync(dirOf(s)).filter((f) => f.endsWith(".making"))).toEqual([]);
    expect(store.projects).toEqual([]);
  });

  test("a worktree that a copy shares stays whole, and a terminal session's linked worktree is never touched", async () => {
    const { s, store, reg, driver, environments } = await setup();
    const a = await newChat(reg, "original");
    const wa = (await store.readChat(a))!.worktree!;
    const sid = store.chats.get(a)!.sessionId!;
    // Continue in a copy (L27): the copy runs in the same worktree.
    const copy = await apply(reg, { t: "continue_session", rid: rid(), project: PROJECT, session: sid, fork: true });
    expect(copy.ok).toBe(true);
    const copyId = (copy as { result: { chat: string } }).result.chat;
    expect((await store.readChat(copyId))!.worktree?.path).toBe(wa.path);
    // A terminal session that ran in a linked worktree of the user's own (W12).
    const linked = join(s.root, "linked");
    git(s.repo, "worktree", "add", "-q", "-b", "mine", linked);
    const term = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    driver.transcript(term, "From the terminal", linked);
    const cont = await apply(reg, { t: "continue_session", rid: rid(), project: PROJECT, session: term });
    expect(cont.ok).toBe(true);
    expect((await store.readChat((cont as { result: { chat: string } }).result.chat))!.linked).toBe(true);

    expect(await environments.remove(PROJECT)).toEqual({ ok: true, value: null });
    expect(existsSync(join(wa.path, "README.md"))).toBe(true);
    expect(existsSync(join(linked, "README.md"))).toBe(true);
    expect(listed(s).sort()).toEqual([s.repo, wa.path, linked].sort());
    expect(branches(s.repo)).toEqual(["main", "mine", wa.branch].sort());
    expect(store.chats.size).toBe(0);
  });
});

describe("Remove and the environment's variables (D60)", () => {
  test("the variables file goes after the chats, with an unreadable one set aside; another project's stays", async () => {
    const { state, store, env, reg, call } = await setup();
    const OTHER = "ab2cd3ef4g";
    store.projects = [...store.projects, projectRecord(OTHER, "/srv/work/other")];
    expect(await env.change(PROJECT, { set: [{ name: "SHOP_API_TOKEN", value: "planted-value-1" }], remove: [] })).toEqual({ ok: true, changed: true });
    expect(await env.change(OTHER, { set: [{ name: "OTHER_TOKEN", value: "planted-value-2" }], remove: [] })).toEqual({ ok: true, changed: true });
    writeFileSync(join(state, "env", `${PROJECT}.json.bad`), "{}", { mode: 0o600 });
    await newChat(reg, "with variables");
    // The project view names how many (the confirm's line); never a value.
    const view = (await call("/api/projects")).body.projects.find((p: { id: string }) => p.id === PROJECT);
    expect(view.env).toBe(1);
    expect(JSON.stringify(view)).not.toContain("planted-value");

    expect((await call(`/api/projects/${PROJECT}/remove`, {})).status).toBe(200);
    expect(existsSync(join(state, "env", `${PROJECT}.json`))).toBe(false);
    expect(existsSync(join(state, "env", `${PROJECT}.json.bad`))).toBe(false);
    expect(env.vars(PROJECT)).toEqual([]);
    expect(existsSync(join(state, "env", `${OTHER}.json`))).toBe(true);
    expect(env.vars(OTHER)).toEqual([{ name: "OTHER_TOKEN", value: "planted-value-2" }]);
    expect(store.projects.map((p) => p.id)).toEqual([OTHER]);
  });
});

describe("a released worktree session (row 99 with W3, W4)", () => {
  test("filed under its worktree's folder, it lists again when the main folder is added again, read there", async () => {
    const { s, state, store, reg, driver, call } = await setup();
    const chat = await newChat(reg, "in the worktree");
    const w = (await store.readChat(chat))!.worktree!;
    const sid = store.chats.get(chat)!.sessionId!;
    // Claude Code filed the transcript under the folder it ran in: the worktree's.
    driver.transcript(sid, "in the worktree", w.path);
    expect((await call(`/api/projects/${PROJECT}/remove`, {})).status).toBe(200);
    // The clean worktree went; its transcript's folder is kept with the id.
    expect(existsSync(w.path)).toBe(false);
    expect(JSON.parse(readFileSync(join(state, RELEASED), "utf8"))).toEqual({ v: 1, folders: [{ cwd: s.repo, ids: [sid], at: { [sid]: w.path } }] });

    const added = await call("/api/projects", { cwd: s.repo });
    expect(added.status).toBe(201);
    const again = added.body.project.id as string;
    expect(again).not.toBe(PROJECT);
    const list = await call(`/api/projects/${again}/sessions`);
    expect(list.body.sessions.map((x: { sessionId: string }) => x.sessionId)).toEqual([sid]);
    expect(driver.releasedReads).toEqual([{ cwd: w.path, ids: [sid] }]);
    // Its preview reads it there too.
    const mark = driver.sessionDirs.length;
    expect((await call(`/api/projects/${again}/sessions/${sid}`)).status).toBe(200);
    const reads = driver.sessionDirs.slice(mark).filter((d) => d.sessionId === sid && (d.op === "info" || d.op === "history"));
    expect(reads.map((d) => [d.op, d.cwd])).toEqual([
      ["info", w.path],
      ["history", w.path],
    ]);

    // Continue here: the chat runs in the project's folder, and its session is read where it is filed (sessionDir).
    const before = driver.sessionDirs.length;
    const o = await apply(reg, { t: "continue_session", rid: rid(), project: again, session: sid });
    expect(o.ok).toBe(true);
    const made = (await store.readChat((o as { result: { chat: string } }).result.chat))!;
    expect(made).toMatchObject({ project: again, cwd: s.repo, sessionId: sid, sessionDir: w.path });
    expect(driver.sessionDirs.slice(before).find((d) => d.op === "info")).toEqual({ op: "info", sessionId: sid, cwd: w.path });
    // A chat holds the session again, so it is released no more.
    await until(() => JSON.parse(readFileSync(join(state, RELEASED), "utf8")).folders.length === 0);
  });
});

describe("Remove's refusals and the records in the making (W3)", () => {
  test("refused with the busy line while a worktree is being made there; once its chat is idle, it goes", async () => {
    const { s, store, reg, environments, call } = await setup({ git: (x) => standIn(x, "worktree add", "sleep 1") });
    const start = apply(reg, frame("slow checkout"));
    await until(() => existsSync(dirOf(s)) && readdirSync(dirOf(s)).some((f) => f.endsWith(".making")));
    expect(reg.projectBusy(PROJECT)).toBe(true);
    expect(await call(`/api/projects/${PROJECT}/remove`, {})).toEqual({ status: 409, body: { error: { code: "busy", message: REMOVE_BUSY } } });
    expect(await environments.remove(PROJECT)).toEqual({ ok: false, code: "busy" });
    // Nothing went, and the Start goes on.
    expect(store.projects.map((p) => p.id)).toEqual([PROJECT]);
    const made = await start;
    expect(made.ok).toBe(true);
    const chat = (made as { result: { chat: string } }).result.chat;
    await until(() => reg.stateOf(chat) === "idle");
    expect(reg.projectBusy(PROJECT)).toBe(false);
    expect(await environments.remove(PROJECT)).toEqual({ ok: true, value: null });
    expect(store.chats.size).toBe(0);
  }, 20_000);

  test("refused while another app has a chat's session open (row 78)", async () => {
    const { store, reg, driver, environments } = await setup({ openCheckMs: 20 });
    const chat = await newChat(reg, "held elsewhere");
    await until(() => reg.stateOf(chat) === "idle");
    driver.openNow.set(store.chats.get(chat)!.sessionId!, { app: "terminal", busy: false });
    await until(() => !!reg.list().find((r) => r.chat === chat)?.held);
    expect(await environments.remove(PROJECT)).toEqual({ ok: false, code: "busy" });
    driver.openNow.clear();
    await until(() => !reg.list().find((r) => r.chat === chat)?.held);
    expect(await environments.remove(PROJECT)).toEqual({ ok: true, value: null });
  });

  test("a record left in the making goes with the project; one that cannot go keeps the project, and Remove may run again", async () => {
    // kitespan's git runs with a scrubbed environment, so the stand-in reads a file: while it is there, removal fails.
    const { s, store, environments } = await setup({ git: (x) => standIn(x, "worktree remove", `if [ -e '${join(x.root, "stuck")}' ]; then exit 1; fi`) });
    // A Start's add that a server which died after it left (no ledger holds it), made after this boot's sweep.
    const left = await makeWorktree(s.wg, { root: s.repo, data: s.data, projectId: PROJECT, chatId: OTHER_CHAT }, () => {});
    expect(left.ok).toBe(true);
    // Row 100: the worktree in the project's .claude/worktrees, its record in the data folder.
    expect(left.ok && left.worktree.path).toBe(join(s.repo, ".claude", "worktrees", "abcdefgh"));
    expect(readdirSync(dirOf(s))).toEqual(["abcdefgh.making"]);
    const stuck = join(s.root, "stuck");
    writeFileSync(stuck, "");
    expect(await environments.remove(PROJECT)).toEqual({ ok: false, code: "failed" });
    expect(store.projects.map((p) => p.id)).toEqual([PROJECT]);
    expect(readdirSync(dirOf(s))).toContain("abcdefgh.making");
    rmSync(stuck);
    expect(await environments.remove(PROJECT)).toEqual({ ok: true, value: null });
    expect(readdirSync(dirOf(s))).toEqual([]);
    expect(readdirSync(join(s.repo, ".claude", "worktrees"))).toEqual([]);
    expect(branches(s.repo)).toEqual(["main"]);
    expect(listed(s)).toEqual([s.repo]);
    expect(store.projects).toEqual([]);
  });
});
