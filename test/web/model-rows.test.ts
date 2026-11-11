// Row 81 on the page (FIX-W19f): the new-chat form's and the project page's model rows are Claude Code's own list as
// the server keeps it (GET /api/projects/:project/models, which waits for the server's one short read when none is
// kept), so a remembered model shows by its name and the form's picker lists every model before any chat has run.
// Any chat's `get models` answer is the same list, so it fills the page's list too. No browser: the store runs on a
// fake socket and a fake fetch; the form's reads are checked in its source.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PROTOCOL_VERSION, type ChatRow, type ClientFrame, type ModelInfo, type ServerFrame } from "../../shared/protocol";
import { Connection, type SocketLike } from "../../web/net/socket";
import { askModelRows, knownModels, modelLabel } from "../../web/screens/common";
import { act, connectWith, getState, resetState } from "../../web/state/store";
import { SectionBody, START_A_CHAT } from "../../web/screens/Settings";

const WEB = join(import.meta.dir, "..", "..", "web");
const src = (...p: string[]) => readFileSync(join(WEB, ...p), "utf8");
const has = (text: string, part: string) => expect([part, text.includes(part)]).toEqual([part, true]);

const PROJECT = "k3m7q2x4ab";
const CHAT = "k3m7q2x4abk3m7q2x4ab";
const LIST: ModelInfo[] = [
  { value: "default", displayName: "Default (recommended)", description: "Use the default model", efforts: ["low", "medium", "high"], supportsAutoMode: true },
  { value: "claude-opus-5-5", displayName: "Opus 5.5", description: "Most capable", efforts: ["low", "medium", "high", "xhigh", "max"], supportsAutoMode: true },
  { value: "claude-haiku-5-5", displayName: "Haiku 5.5", description: "Fast", efforts: ["low", "medium", "high"], supportsAutoMode: false },
];

const g = globalThis as unknown as { window?: { __kitespanFrames?: { t: string }[]; innerWidth?: number; innerHeight?: number }; fetch: typeof fetch; matchMedia?: unknown };
const own = { window: !g.window };
g.window ??= {};
const realFetch = g.fetch;
let replies: (unknown | number)[] = [];
const asked: string[] = [];
const askedHeaders: Record<string, string>[] = [];
let hold: Promise<void> | null = null;
g.fetch = (async (url: string, init?: RequestInit) => {
  asked.push(`${init?.method ?? "GET"} ${url}`);
  askedHeaders.push({ ...((init?.headers ?? {}) as Record<string, string>) });
  if (hold) await hold;
  const next = replies.shift();
  if (typeof next === "number") return new Response(JSON.stringify({ error: { code: "internal", message: "no" } }), { status: next });
  return new Response(JSON.stringify(next ?? {}), { status: 200, headers: { "content-type": "application/json" } });
}) as unknown as typeof fetch;
afterAll(() => {
  if (own.window) delete g.window;
  g.fetch = realFetch;
  connectWith(null);
  resetState();
});

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

const chatRow = (chat: string): ChatRow => ({ chat, title: "A past chat", project: PROJECT, state: "sleeping", needsYou: false, lastActivity: "2026-11-02T09:00:00.000Z", archived: false });

function boot(rows: ChatRow[] = []): FakeSocket {
  resetState({ projects: [{ id: PROJECT, name: "demo", folder: "/work/demo", picks: { model: "claude-haiku-5-5" } } as never] });
  const sock = new FakeSocket();
  const conn = new Connection({ url: "ws://127.0.0.1:7942/ws", tab: "tab_me", open: () => sock, now: () => 0, setTimer: () => 0, clearTimer: () => {}, random: () => 0.5, reload: () => {} });
  connectWith(conn);
  conn.start();
  sock.onopen?.({});
  sock.receive({ t: "welcome", epoch: "lz2k3m-abcdefghijkl", version: "0.3.0", v: PROTOCOL_VERSION, claude: { ok: true, version: "2.1.312", drift: null }, update: { available: false }, auth: "none" });
  sock.receive({ t: "chats", list: rows });
  asked.length = 0;
  askedHeaders.length = 0;
  hold = null;
  return sock;
}
const gets = (sock: FakeSocket) => sock.sent.filter((f) => f.t === "get");

describe("the page's model list (act.loadModels)", () => {
  test("one GET of /api/projects/:project/models with the sender header; two asks at once share it; the list kept", async () => {
    boot();
    replies = [{ models: LIST, at: "2026-11-02T10:00:00.000Z" }];
    const [a, b] = await Promise.all([act.loadModels(PROJECT), act.loadModels(PROJECT)]);
    expect(asked).toEqual([`GET /api/projects/${PROJECT}/models`]);
    // The page's own read: only it may let the server start its short read (as the / menu's read, W19d).
    expect(askedHeaders.at(-1)).toMatchObject({ "x-kitespan": "1" });
    expect(a).toEqual(LIST);
    expect(b).toBe(a);
    expect(getState().modelList).toEqual(LIST);
  });

  test("an empty answer, a failed read and a reply of another shape leave the list as it was", async () => {
    boot();
    replies = [{ models: [], at: null }, 500, { models: "nope" }];
    expect(await act.loadModels(PROJECT)).toEqual([]);
    expect(await act.loadModels(PROJECT)).toBeNull();
    expect(await act.loadModels(PROJECT)).toEqual([]);
    expect(getState().modelList).toBeNull();
    replies = [{ models: LIST, at: "2026-11-02T10:00:00.000Z" }, { models: [], at: null }];
    await act.loadModels(PROJECT);
    await act.loadModels(PROJECT);
    expect(getState().modelList).toEqual(LIST);
  });

  test("a chat's `get models` is the same list in every chat: its rows fill the page's list too, and no rows leave it", async () => {
    const sock = boot([chatRow(CHAT)]);
    const p = act.load(CHAT, "models");
    const f = gets(sock).at(-1) as Extract<ClientFrame, { t: "get" }>;
    sock.receive({ t: "ack", rid: f.rid, ok: true, result: LIST });
    await p;
    expect(getState().modelList).toEqual(LIST);
    const q = act.load(CHAT, "models");
    sock.receive({ t: "ack", rid: (gets(sock).at(-1) as Extract<ClientFrame, { t: "get" }>).rid, ok: true, result: [] });
    await q;
    expect(getState().modelList).toEqual(LIST);
  });
});

describe("the form's and the project page's rows (screens/common.tsx)", () => {
  test("the owner's case: a remembered model shows by its name from the kept list, with no chat running", async () => {
    boot([chatRow(CHAT)]);
    // Before: the page knows no rows, and the remembered value would show as its raw id.
    expect(knownModels(getState().chats)).toBeNull();
    expect(modelLabel("claude-haiku-5-5", [])).toBe("claude-haiku-5-5");
    replies = [{ models: LIST, at: "2026-11-02T10:00:00.000Z" }];
    await act.loadModels(PROJECT);
    const rows = knownModels(getState().chats)!;
    expect(rows.map((m) => m.label)).toEqual(["Default (recommended)", "Opus 5.5", "Haiku 5.5"]);
    expect(modelLabel("claude-haiku-5-5", rows)).toBe("Haiku 5.5");
    expect(rows[1]).toEqual({ id: "claude-opus-5-5", label: "Opus 5.5", hint: "Most capable", efforts: ["low", "medium", "high", "xhigh", "max"], supportsAutoMode: true });
  });

  test("askModelRows reads the project's route, never through a chat; once the rows are known it reads nothing", async () => {
    const sock = boot([chatRow(CHAT)]);
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    replies = [{ models: LIST, at: "2026-11-02T10:00:00.000Z" }];
    askModelRows(PROJECT);
    askModelRows(PROJECT);
    expect(asked).toEqual([`GET /api/projects/${PROJECT}/models`]);
    release();
    await act.loadModels(PROJECT);
    expect(getState().modelList).toEqual(LIST);
    askModelRows(PROJECT);
    expect(asked).toHaveLength(1);
    expect(gets(sock)).toEqual([]);
    // No project: nothing to read through.
    boot();
    askModelRows(undefined);
    expect(asked).toEqual([]);
  });

  test("the form reads the rows when it shows a project, beside its / menu's read, so both share the server's one read", () => {
    const form = src("screens", "NewChatForm.tsx");
    has(form, "if (projectKey) askModelRows(projectKey);");
    has(form, "if (projectKey) void act.loadProjectCommands(projectKey);");
    const common = src("screens", "common.tsx");
    has(common, "act.loadModels(projectId)");
    has(common, "useStore((s) => s.modelList)");
    // The project page names its remembered model through the same rows.
    has(src("screens", "ProjectScreen.tsx"), "useModelRowsFor(project.picks.model, project.id)");
  });
});

describe("Settings > Models (screens/Settings.tsx): the same kept list, with or without a chat", () => {
  const ownMm = !g.matchMedia;
  // A menu row reads the viewport (layout/size.ts): a laptop window with a mouse for these renders.
  const laptop = () => {
    g.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    Object.assign(g.window!, { innerWidth: 1100, innerHeight: 800, addEventListener() {}, removeEventListener() {} });
  };
  afterAll(() => {
    if (ownMm) delete g.matchMedia;
  });
  const models = () => renderToStaticMarkup(createElement(SectionBody, { id: "models", ctx: { touch: false, laptop: true, phone: false, narrow: false } }));

  test("no chat at all, and the server keeps a list: the rows show by name, not Start a chat to read it", async () => {
    laptop();
    boot();
    replies = [{ models: LIST, at: "2026-11-02T10:00:00.000Z" }];
    await act.loadModels(PROJECT);
    const html = models();
    expect(html).toContain('data-testid="setting-model-claude-haiku-5-5"');
    expect(html).toContain('<span class="set-model-label">Haiku 5.5</span>');
    expect(html).not.toContain('data-testid="setting-model-none"');
    expect(html.slice(html.indexOf('data-testid="setting-models"'), html.indexOf("</ul>", html.indexOf('data-testid="setting-models"')))).not.toContain(START_A_CHAT);
  });

  test("a chat whose own rows were not read yet shows the kept list too", async () => {
    laptop();
    boot([chatRow(CHAT)]);
    replies = [{ models: LIST, at: "2026-11-02T10:00:00.000Z" }];
    await act.loadModels(PROJECT);
    const html = models();
    expect(html).toContain('data-testid="setting-model-claude-opus-5-5"');
    expect(html).not.toContain('data-testid="setting-model-none"');
  });

  test("no chat and no list yet: Start a chat to read it, and the section asks the project's route for the list", () => {
    laptop();
    boot();
    expect(models()).toContain('data-testid="setting-model-none"');
    const settings = src("screens", "Settings.tsx");
    const section = settings.slice(settings.indexOf("function ModelsSection("), settings.indexOf("// ---- Appearance ----"));
    has(section, "const kept = useStore((s) => s.modelList);");
    has(section, "else askModelRows(project);");
    has(section, "const rows: ModelInfo[] | null = chat?.models?.length ? chat.models : kept?.length ? kept : null;");
  });
});
