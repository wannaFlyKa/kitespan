// Row 73 in the JSON API (build checklist W2, W7, W9, L29, L31, L33): the project view's Worktree option and why it
// is off; the switch, which turns on only where a worktree can be made; New environment's read for a folder before it
// is a project; Archive's and Delete's facts about a chat's worktree, as counts only; and the branch of a session row
// from another worktree. No server is started: the handler is called, with kitespan's git on scratch repositories.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PUBLIC_ADAPTERS } from "../../server/adapters/adapters";
import type { AgentDriver, AgentSettings, BinaryProbe, SessionInfo } from "../../server/agents/types";
import { createGate } from "../../server/gate/guards";
import { createApi } from "../../server/http/api";
import { createApp, type Upgrader } from "../../server/http/app";
import { loadSite } from "../../server/http/static";
import { SETTINGS_DEFAULTS, type ChatLedger, type ProjectRecord } from "../../server/store/types";
import { WorktreeHost } from "../../server/worktree/host";
import { makeWorktree } from "../../server/worktree/ops";
import { commitAll, git, scratch } from "./worktree-repo";

const PORT = 7941;
const OWN = `http://127.0.0.1:${PORT}`;
const REPO_P = "k3m7q2x4ab";
const PLAIN_P = "ab2cd3ef4g";
const CHAT = "abcdefghijklmnopqrst";
const PLAIN_CHAT = "qrstuvwxyzabcdefghij";
const s = scratch();
afterAll(() => s.cleanup());
const plain = join(s.root, "plain");
mkdirSync(plain);

const PROBE: BinaryProbe = { ok: true, path: "/opt/bin/claude", realpath: "/opt/bin/claude", version: "2.1.317", source: "path", refused: [], platformPackages: [], drift: null, belowMinimum: null };
const at = "2026-11-03T08:00:00.000Z";
const project = (id: string, cwd: string): ProjectRecord => ({ id, cwd, name: "p", createdAt: at, lastUsedAt: at, picks: { model: null, effort: null, permissionMode: null } });
const chat = (id: string, cwd: string, worktree?: ChatLedger["worktree"]): ChatLedger => ({
  v: 1,
  id,
  project: REPO_P,
  cwd,
  agent: "claude-code",
  sessionId: null,
  title: null,
  picks: { model: null, effort: null, permissionMode: null },
  createdAt: at,
  seenAt: at,
  lastActivityAt: at,
  lastSeq: 0,
  state: "sleeping",
  lastExit: null,
  archivedAt: null,
  ...(worktree ? { worktree } : {}),
});

function makeApp(opts: { hook?: boolean; sessions?: SessionInfo[]; chats?: ChatLedger[] } = {}) {
  let projects = [project(REPO_P, s.repo), project(PLAIN_P, plain)];
  const settings = async (): Promise<AgentSettings> => ({ respondToBash: true, cleanupPeriodDays: null, promptSuggestions: false, defaultMode: null, ...(opts.hook ? { worktreeHook: true } : {}) });
  const driver: Pick<AgentDriver, "probe" | "settings" | "listSessions" | "history" | "sessionInfo"> = {
    probe: async () => PROBE,
    settings,
    listSessions: async () => opts.sessions ?? [],
    sessionInfo: async () => null,
    history: async () => ({ events: [], more: null }),
  };
  const gate = createGate(PORT, []);
  const site = loadSite(join(s.root, "no-dist"), gate.origins);
  const api = createApi({
    gate,
    safe: site.safe,
    store: {
      listProjects: async () => structuredClone(projects),
      putProject: async (rec) => {
        projects = [...projects.filter((p) => p.id !== rec.id), structuredClone(rec)];
      },
      readSettings: async () => ({ ...SETTINGS_DEFAULTS }),
      readChat: async (id) => structuredClone((opts.chats ?? []).find((c) => c.id === id) ?? null),
      listUploads: async () => [],
      putUpload: async () => {},
      removeUpload: async () => null,
    },
    driver,
    uploadFolder: async () => ({ ok: true, path: "/tmp/kitespan-uploads-x", choice: "temp" }),
    chatForSession: () => null,
    heldSessions: () => new Set(),
    info: { port: PORT, version: "0.4.0", adapters: { ...PUBLIC_ADAPTERS, origins: [] } },
    worktrees: new WorktreeHost({ worktreeGit: s.wg, worktreeData: s.data }),
  });
  const app = createApp({ gate, site, api, sockets: {} });
  return { app, projects: () => projects };
}

const noServer: Upgrader = { upgrade: () => false };
async function call(app: ReturnType<typeof makeApp>["app"], path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { host: `127.0.0.1:${PORT}` };
  if (body !== undefined) Object.assign(headers, { "x-kitespan": "1", "content-type": "application/json", origin: OWN });
  const req = new Request(`${OWN}${path}`, body === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(body) });
  const res = (await app.fetch(req, noServer))!;
  return { status: res.status, body: await res.json() };
}

describe("the project's Worktree option (W2, L29, L33)", () => {
  test("the project views say whether it is on and why it cannot be", async () => {
    const { app } = makeApp();
    const r = await call(app, "/api/projects");
    const byId = Object.fromEntries((r.body.projects as { id: string; worktree: boolean; worktreeOff: string | null }[]).map((p) => [p.id, p]));
    expect(byId[REPO_P]).toMatchObject({ worktree: false, worktreeOff: null });
    expect(byId[PLAIN_P]).toMatchObject({ worktree: false, worktreeOff: "not_git" });
  });

  test("the switch turns on where a worktree can be made, and stays off elsewhere with its reason", async () => {
    const { app, projects } = makeApp();
    expect((await call(app, `/api/projects/${REPO_P}/worktree`, { on: true })).body.project).toMatchObject({ worktree: true, worktreeOff: null });
    expect(projects().find((p) => p.id === REPO_P)!.worktree).toBe(true);
    expect((await call(app, `/api/projects/${PLAIN_P}/worktree`, { on: true })).body.project).toMatchObject({ worktree: false, worktreeOff: "not_git" });
    expect(projects().find((p) => p.id === PLAIN_P)!.worktree).toBeUndefined();
    expect((await call(app, `/api/projects/${REPO_P}/worktree`, { on: false })).body.project).toMatchObject({ worktree: false });
    expect(projects().find((p) => p.id === REPO_P)!.worktree).toBeUndefined();
    expect((await call(app, `/api/projects/${REPO_P}/worktree`, { on: "yes" })).status).toBe(400);
  });

  test("a WorktreeCreate hook in the project's settings keeps it off (L29)", async () => {
    const { app } = makeApp({ hook: true });
    expect((await call(app, `/api/projects/${REPO_P}/worktree`, { on: true })).body.project).toMatchObject({ worktree: false, worktreeOff: "hook" });
  });

  test("New environment's add takes the checkbox for a new project only; a known one keeps its own", async () => {
    const { app, projects } = makeApp();
    const other = join(s.root, "other");
    mkdirSync(other);
    git(other, "init", "-q");
    writeFileSync(join(other, "a.txt"), "a\n");
    commitAll(other, "first");
    const added = await call(app, "/api/projects", { cwd: other, worktree: true });
    expect(added.status).toBe(201);
    expect(added.body.project).toMatchObject({ worktree: true, worktreeOff: null });
    const known = await call(app, "/api/projects", { cwd: s.repo, worktree: true });
    expect(known.status).toBe(200);
    expect(known.body.project.worktree).toBe(false);
    expect(projects().find((p) => p.id === REPO_P)!.worktree).toBeUndefined();
  });

  test("New environment's read for a folder that is no project yet", async () => {
    const { app } = makeApp();
    expect((await call(app, `/api/folders/worktree?path=${encodeURIComponent(s.repo)}`)).body).toEqual({ ok: true });
    expect((await call(app, `/api/folders/worktree?path=${encodeURIComponent(plain)}`)).body).toEqual({ ok: false, why: "not_git", line: "This folder is not a git repository." });
    expect((await call(app, `/api/folders/worktree?path=${encodeURIComponent(join(s.root, "gone"))}`)).status).toBe(404);
    expect((await call(app, "/api/folders/worktree?path=relative")).status).toBe(400);
  });
});

describe("Archive's and Delete's facts (W7, W9, L26)", () => {
  test("how many files have changes and whether the branch stays; counts only, never a file's name", async () => {
    const made = await makeWorktree(s.wg, { root: s.repo, data: s.data, projectId: REPO_P, chatId: CHAT });
    if (!made.ok) throw new Error("no worktree");
    const w = made.worktree;
    const { app } = makeApp({ chats: [chat(CHAT, w.path, w), chat(PLAIN_CHAT, s.repo)] });
    expect((await call(app, `/api/chats/${CHAT}/worktree`)).body).toEqual({ path: w.path, branch: w.branch, changes: 0, ignored: false, branchStays: false });
    writeFileSync(join(w.path, "secret-name.txt"), "x");
    writeFileSync(join(w.path, "README.md"), "changed\n");
    const r = await call(app, `/api/chats/${CHAT}/worktree`);
    expect(r.body).toEqual({ path: w.path, branch: w.branch, changes: 2, ignored: false, branchStays: false });
    expect(JSON.stringify(r.body)).not.toContain("secret-name");
    writeFileSync(join(w.path, ".gitignore"), "*.db\n");
    commitAll(w.path, "its own");
    expect((await call(app, `/api/chats/${CHAT}/worktree`)).body).toMatchObject({ changes: 0, ignored: false, branchStays: true });
    // L25: a file that git ignores is named as a fact (Archive keeps it), never by its name.
    writeFileSync(join(w.path, "secret-local.db"), "rows");
    const ig = await call(app, `/api/chats/${CHAT}/worktree`);
    expect(ig.body).toMatchObject({ changes: 0, ignored: true });
    expect(JSON.stringify(ig.body)).not.toContain("secret-local");
    expect((await call(app, `/api/chats/${PLAIN_CHAT}/worktree`)).status).toBe(404);
  });

  test("after Archive's removal (row 100), a worktree at the path is not the chat's: no facts are read of it", async () => {
    const made = await makeWorktree(s.wg, { root: s.repo, data: s.data, projectId: REPO_P, chatId: "bcdefghijklmnopqrstu" });
    if (!made.ok) throw new Error("no worktree");
    const w = { ...made.worktree, removed: true as const };
    writeFileSync(join(w.path, "theirs.txt"), "x");
    const { app } = makeApp({ chats: [chat("bcdefghijklmnopqrstu", w.path, w)] });
    expect((await call(app, `/api/chats/bcdefghijklmnopqrstu/worktree`)).body).toEqual({ path: w.path, branch: w.branch, changes: null, ignored: null, branchStays: false });
  });
});

describe("the session rows of another worktree show its branch (L31)", () => {
  test("a row from another worktree has its branch; one in the project's folder has none", async () => {
    const sessions: SessionInfo[] = [
      { sessionId: "7c9e6679-7425-40de-944b-e07fc1f90ae7", title: "here", customTitle: null, lastModified: 2, cwd: s.repo, gitBranch: "main" },
      { sessionId: "0b1e2a3c-4d5e-4f60-8172-93a4b5c6d7e8", title: "there", customTitle: null, lastModified: 1, cwd: join(s.root, "wt"), gitBranch: "feature" },
    ];
    const { app } = makeApp({ sessions });
    const rows = (await call(app, `/api/projects/${REPO_P}/sessions`)).body.sessions as { title: string; branch?: string }[];
    expect(rows.find((r) => r.title === "here")!.branch).toBeUndefined();
    expect(rows.find((r) => r.title === "there")!.branch).toBe("feature");
  });
});
