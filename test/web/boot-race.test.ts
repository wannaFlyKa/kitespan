// The boot race (DESIGN.md 4.3, 6.3): the page asks GET /api/projects at boot while the socket attaches the open
// chat. When the chat's snapshot comes first, its rows are drawn with no folder known, so their paths are absolute;
// once the projects come, the rows are drawn again with the chat's folder (a path relative to it), with no reload.
// The store runs on the real Connection over a fake socket, and on a fetch whose /api/projects answer waits.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, type Card as WireCard, type ChatEvent, type ChatRow, type ClientFrame, type DraftState, type ServerFrame } from "../../shared/protocol";
import type { ProjectsReply } from "../../server/http/api-types";
import { Connection, type SocketLike } from "../../web/net/socket";
import { act, connectWith, getState, resetState, start } from "../../web/state/store";
import type { AgentItem, Chat, PermissionCard, ToolItem } from "../../web/state/types";

class MemoryStorage {
  map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

class FakeSocket implements SocketLike {
  readyState = 1;
  sent: ClientFrame[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data) as ClientFrame);
  }
  close() {}
  receive(f: ServerFrame) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
}

const g = globalThis as unknown as { window?: object; localStorage?: MemoryStorage; fetch: typeof fetch };
const own = { window: !g.window, storage: !g.localStorage };
g.window ??= {};
g.localStorage ??= new MemoryStorage();
const realFetch = g.fetch;
afterEach(() => {
  g.fetch = realFetch;
  connectWith(null);
  resetState();
});
afterAll(() => {
  if (own.window) delete g.window;
  if (own.storage) delete g.localStorage;
});

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

const EPOCH = "lz2k3m-abcdefghijkl";
const CHAT = "k3m7q2x4abk3m7q2x4ab";
const PROJECT = "k3m7q2x4ab";
const FOLDER = "/work/kitespan";
const row: ChatRow = { chat: CHAT, title: "Fix the upload", project: PROJECT, state: "idle", needsYou: false, lastActivity: "2026-10-31T10:00:00.000Z", archived: false };
const draft: DraftState = { rev: 1, text: "", mode: "chat", command: null, link: false, uploads: [], by: null, at: "2026-10-31T10:00:00.000Z" };
const PROJECTS: ProjectsReply = {
  projects: [{ id: PROJECT, name: "kitespan", cwd: FOLDER, createdAt: "2026-10-01T10:00:00.000Z", lastUsedAt: "2026-10-31T10:00:00.000Z", picks: { model: null, effort: null, permissionMode: null }, worktree: false, worktreeOff: null, env: 0 }],
};
const permission = (id: string, path: string): WireCard => ({
  kind: "permission",
  id,
  toolUseId: id,
  toolName: "Edit",
  title: null,
  displayName: null,
  description: null,
  reason: null,
  blockedPath: null,
  input: { file_path: path, old_string: "a", new_string: "b" },
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  sessionRule: true,
  parent: null,
});

/**
 * A fresh page on its boot path (store.start): the projects read waits until `release` is called, while the socket
 * opens, lists the chat, attaches it and sends its snapshot.
 */
function bootWithSlowProjects(chatRow: ChatRow = row, history?: ChatEvent[], projects: ProjectsReply = PROJECTS) {
  resetState();
  connectWith(null);
  g.localStorage = new MemoryStorage();
  let release = () => {};
  const projectsCame = new Promise<void>((r) => (release = r));
  const asked: string[] = [];
  g.fetch = (async (url: string) => {
    asked.push(url);
    if (url === "/api/projects") {
      await projectsCame;
      return new Response(JSON.stringify(projects), { status: 200 });
    }
    if (url.startsWith("/api/settings")) return new Response(JSON.stringify({ settings: {}, agent: null }), { status: 200 });
    return new Response(JSON.stringify({ uploads: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  const sock = new FakeSocket();
  const conn = new Connection({ url: "ws://127.0.0.1:7942/ws", tab: "tab_me", open: () => sock, now: () => 0, setTimer: () => 0, clearTimer: () => {}, random: () => 0.5, reload: () => {} });
  start(conn);
  sock.onopen?.({});
  sock.receive({ t: "welcome", epoch: EPOCH, version: "0.1.0", v: PROTOCOL_VERSION, claude: { ok: true, version: "2.1.322", drift: null }, update: { available: false }, auth: "none" });
  sock.receive({ t: "chats", list: [chatRow] });
  act.open(CHAT);
  sock.receive({ t: "attached", chat: CHAT, epoch: EPOCH, state: "waiting", seq: 9, cards: [permission("toolu_wait", `${FOLDER}/web/App.tsx`)], picks: { model: null, effort: null, mode: null }, title: null, draft, archived: false, replay: "snapshot" });
  sock.receive({
    t: "snapshot",
    chat: CHAT,
    seq: 8,
    more: null,
    history: history ?? [
      { k: "user", uuid: "11111111-2222-4333-8444-555555555555", text: "Fix the upload test", queued: false },
      { k: "tool_call", id: "toolu_read", name: "Read", input: { file_path: `${FOLDER}/server/upload.ts` }, parent: null },
      { k: "tool_result", id: "toolu_read", text: "ok", isError: false, parent: null, report: null },
      { k: "tool_call", id: "toolu_edit", name: "Edit", input: { file_path: `${FOLDER}/server/upload.ts`, old_string: "a", new_string: "b" }, parent: null },
      { k: "tool_result", id: "toolu_edit", text: "ok", isError: false, parent: null, report: null },
      { k: "tool_call", id: "toolu_note", name: "Write", input: { file_path: `${FOLDER}/docs/notes.md`, content: "x" }, parent: null },
      { k: "tool_result", id: "toolu_note", text: "ok", isError: false, parent: null, report: null },
      // A path outside the folder stays as it is.
      { k: "tool_call", id: "toolu_tmp", name: "Read", input: { file_path: "/tmp/log.txt" }, parent: null },
      { k: "tool_result", id: "toolu_tmp", text: "ok", isError: false, parent: null, report: null },
      { k: "tool_call", id: "toolu_agent", name: "Agent", input: { description: "Find the callers", prompt: "Find them", subagent_type: "Explore" }, parent: null },
      { k: "tool_call", id: "toolu_inner", name: "Read", input: { file_path: `${FOLDER}/server/api.ts` }, parent: "toolu_agent" },
      { k: "tool_result", id: "toolu_inner", text: "ok", isError: false, parent: "toolu_agent", report: null },
      { k: "tool_result", id: "toolu_agent", text: "done", isError: false, parent: null, report: null },
      // An answered card's record.
      { k: "tool_call", id: "toolu_asked", name: "Edit", input: { file_path: `${FOLDER}/web/main.tsx`, old_string: "a", new_string: "b" }, parent: null },
      { k: "card_open", card: permission("toolu_asked", `${FOLDER}/web/main.tsx`) },
      { k: "card_close", id: "toolu_asked", why: "answered", answer: "once" },
      { k: "tool_result", id: "toolu_asked", text: "ok", isError: false, parent: null, report: null },
      // A card whose close is in the snapshot's tail (seq 9), which comes after the projects in the second test.
      { k: "tool_call", id: "toolu_tail", name: "Edit", input: { file_path: `${FOLDER}/web/tail.ts`, old_string: "a", new_string: "b" }, parent: null },
      { k: "card_open", card: permission("toolu_tail", `${FOLDER}/web/tail.ts`) },
    ],
  });
  return { release, asked, sock };
}

const chat = (): Chat => getState().chats.find((c) => c.id === CHAT)!;
const tool = (id: string) => chat().items.find((i) => i.id === id) as ToolItem;

describe("the boot race: the snapshot before the projects", () => {
  test("the rows drawn before the projects came are drawn again with the chat's folder when they come", async () => {
    const { release, asked } = bootWithSlowProjects();
    expect(asked).toContain("/api/projects");
    // The snapshot came first: no folder is known yet, so the paths are absolute.
    expect(getState().projects).toEqual([]);
    expect(tool("toolu_read").summary).toBe(`${FOLDER}/server/upload.ts`);

    release();
    await flush();
    expect(getState().projects.map((p) => p.folder)).toEqual([FOLDER]);
    const c = chat();
    expect(tool("toolu_read").summary).toBe("server/upload.ts");
    expect(tool("toolu_edit").summary).toBe("server/upload.ts");
    expect(tool("toolu_edit").diff?.path).toBe("server/upload.ts");
    expect(tool("toolu_note").diff?.path).toBe("docs/notes.md");
    expect(tool("toolu_tmp").summary).toBe("/tmp/log.txt");
    // A subagent's rows too.
    const agent = c.items.find((i) => i.id === "toolu_agent") as AgentItem;
    expect((agent.rows.find((r) => r.id === "toolu_inner") as ToolItem).summary).toBe("server/api.ts");
    // The Outputs card: each file once, relative to the folder.
    expect(c.outputs).toEqual([
      { path: "server/upload.ts", kind: "file" },
      { path: "docs/notes.md", kind: "doc" },
      { path: "web/main.tsx", kind: "file" },
      { path: "web/tail.ts", kind: "file" },
    ]);
    // The open card and an answered card's record keep everything but their paths.
    const open = c.pending[0] as PermissionCard;
    expect([open.detail, open.diff?.path, open.wire?.id]).toEqual(["web/App.tsx", "web/App.tsx", "toolu_wait"]);
    const record = c.items.find((i) => i.id === "card-toolu_asked");
    expect(record).toMatchObject({ kind: "card", card: { kind: "permission", detail: "web/main.tsx", answered: "once", diff: { path: "web/main.tsx" } } });
    // The rest of the chat is as it was.
    expect(c.items.map((i) => i.id)).toEqual(["11111111-2222-4333-8444-555555555555", "toolu_read", "toolu_edit", "toolu_note", "toolu_tmp", "toolu_agent", "toolu_asked", "card-toolu_asked", "toolu_tail"]);
    expect(c.loaded).toBe(true);
  });

  test("a later event, and a projects read that changes no folder, keep the rows as they are", async () => {
    const { release, sock } = bootWithSlowProjects();
    release();
    await flush();
    // The tail's close of a card the snapshot opened: its record says the path relative to the folder.
    sock.receive({ t: "ev", chat: CHAT, seq: 9, e: { k: "card_close", id: "toolu_tail", why: "answered", answer: "once" } });
    expect(chat().items.find((i) => i.id === "card-toolu_tail")).toMatchObject({ kind: "card", card: { kind: "permission", detail: "web/tail.ts", answered: "once" } });
    // An event after the projects came is drawn with the folder at once.
    sock.receive({ t: "ev", chat: CHAT, seq: 10, e: { k: "tool_call", id: "toolu_late", name: "Read", input: { file_path: `${FOLDER}/README.md` }, parent: null } });
    expect(tool("toolu_late").summary).toBe("README.md");
    const items = chat().items;
    // The same folder again (New environment's Use this folder on a known one answers it): nothing is drawn again.
    g.fetch = (async () => new Response(JSON.stringify({ project: PROJECTS.projects[0] }), { status: 200 })) as unknown as typeof fetch;
    expect(await act.addFolder(FOLDER)).toEqual({ id: PROJECT });
    expect(chat().items).toBe(items);
  });

  test("a worktree chat (row 73): its rows stay relative to its worktree, and a path in the main checkout stays absolute", async () => {
    // A deep link to a worktree chat, or a reload of it: the chat's folder is its worktree (the row's `worktree`), which
    // the page knows from the chat list before the projects come, so the projects' read must not draw its rows again
    // with the project's folder.
    const WT = "/srv/u/.local/share/kitespan/worktrees/k3m7q2x4ab/k3m7q2x4";
    const wtRow = { ...row, worktree: { path: WT, branch: "kitespan/k3m7q2x4", kept: false } } as ChatRow;
    const history: ChatEvent[] = [
      { k: "tool_call", id: "toolu_read", name: "Read", input: { file_path: `${WT}/server/upload.ts` }, parent: null },
      { k: "tool_result", id: "toolu_read", text: "ok", isError: false, parent: null, report: null },
      { k: "tool_call", id: "toolu_main", name: "Read", input: { file_path: `${FOLDER}/.env.example` }, parent: null },
      { k: "tool_result", id: "toolu_main", text: "ok", isError: false, parent: null, report: null },
    ];
    const projects: ProjectsReply = { projects: [{ ...PROJECTS.projects[0]!, worktree: true }] };
    const { release } = bootWithSlowProjects(wtRow, history, projects);
    expect(tool("toolu_read").summary).toBe("server/upload.ts");
    expect(tool("toolu_main").summary).toBe(`${FOLDER}/.env.example`);
    const before = chat().items;
    release();
    await flush();
    expect(getState().projects.map((p) => p.folder)).toEqual([FOLDER]);
    expect(tool("toolu_read").summary).toBe("server/upload.ts");
    expect(tool("toolu_main").summary).toBe(`${FOLDER}/.env.example`);
    // The folder did not change, so nothing was drawn again.
    expect(chat().items).toBe(before);
  });
});
