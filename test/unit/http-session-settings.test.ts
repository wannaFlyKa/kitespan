// Row 77 on the server: Settings > Chats > "Show sessions from other apps" (chats.sessionsFromOtherApps, on by
// default) and "Show sessions open in another app" (chats.sessionsOpenElsewhere, off by default), kept by the store
// with kitespan's other settings and applied where the session lists are made, so every page agrees. Off, the first
// empties the project's list of Claude Code sessions (the reply says the setting hides them) and the preview reads no
// transcript; off, the second leaves out a session that another process has open now, busy or idle, and its preview
// says so. Written through POST /api/settings with the real store in a scratch folder; no server is started.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PUBLIC_ADAPTERS } from "../../server/adapters/adapters";
import type { AgentDriver, SessionOpen } from "../../server/agents/types";
import { createGate } from "../../server/gate/guards";
import { createApi } from "../../server/http/api";
import { safeHeaders } from "../../server/http/headers";
import { createStore } from "../../server/store/store";
import { SETTINGS_DEFAULTS, type ProjectRecord } from "../../server/store/types";

const PORT = 7941;
const OWN = `http://127.0.0.1:${PORT}`;
const SENDER: Record<string, string> = { host: `127.0.0.1:${PORT}`, "x-kitespan": "1", "content-type": "application/json", origin: OWN };
const PROJECT = "k3m7q2x4ab";
const OPEN_IDLE = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const OPEN_BUSY = "1d2c3b4a-5e6f-4a0b-8c1d-2e3f4a5b6c7d";
const CLOSED = "0b1e2a3c-4d5e-4f60-8172-93a4b5c6d7e8";
const root = realpathSync(mkdtempSync(join(tmpdir(), "kitespan-session-settings-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function setup() {
  const dir = mkdtempSync(join(root, "s-"));
  const work = join(dir, "work");
  mkdirSync(work);
  const store = createStore({ root: join(dir, "store"), user: "tester" });
  await store.open();
  const project: ProjectRecord = { id: PROJECT, cwd: work, name: "work", createdAt: "2026-11-02T08:00:00Z", lastUsedAt: "2026-11-02T09:00:00Z", picks: { model: null, effort: null, permissionMode: null } };
  await store.putProject(project);
  const reads = { list: 0, history: 0 };
  const open = new Map<string, SessionOpen>([
    [OPEN_IDLE, { app: "terminal", busy: false }],
    [OPEN_BUSY, { app: "desktop", busy: true }],
  ]);
  const driver: Pick<AgentDriver, "probe" | "settings" | "listSessions" | "history" | "sessionInfo" | "openSessions"> = {
    probe: async () => ({ ok: true, path: "/opt/bin/claude", realpath: "/opt/bin/claude", version: "2.1.311", source: "path", refused: [], platformPackages: [], drift: null, belowMinimum: null }),
    settings: async () => ({ respondToBash: true, cleanupPeriodDays: null, promptSuggestions: false, defaultMode: null }),
    listSessions: async (cwd) => {
      reads.list++;
      return [
        { sessionId: OPEN_IDLE, title: "Open and idle in a terminal", customTitle: null, lastModified: 3, cwd },
        { sessionId: OPEN_BUSY, title: "Busy in the desktop app", customTitle: null, lastModified: 2, cwd },
        { sessionId: CLOSED, title: "Closed", customTitle: null, lastModified: 1, cwd },
      ];
    },
    sessionInfo: async (id, cwd) => ({ sessionId: id, title: "t", customTitle: null, lastModified: 1, cwd }),
    history: async () => {
      reads.history++;
      return { events: [], more: null };
    },
    openSessions: async () => open,
  };
  const api = createApi({
    gate: createGate(PORT),
    safe: safeHeaders("default-src 'self'"),
    store,
    driver,
    uploadFolder: async () => ({ ok: true, path: "/tmp/kitespan-uploads-tester", choice: "temp" }),
    chatForSession: () => null,
    heldSessions: () => new Set(),
    info: { port: PORT, version: "0.1.0", adapters: PUBLIC_ADAPTERS },
    settingsWriter: { write: (change) => store.writeSettings(change), reload: async () => {} },
  });
  const call = async (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const res = await api.handle(new Request(`${OWN}${path}`, { method: init.method ?? "GET", headers: init.headers ?? { host: `127.0.0.1:${PORT}` }, body: init.body }), new URL(`${OWN}${path}`));
    return { status: res.status, body: (await res.json()) as any };
  };
  const save = (change: Record<string, unknown>) => call("/api/settings", { method: "POST", headers: SENDER, body: JSON.stringify(change) });
  const list = () => call(`/api/projects/${PROJECT}/sessions`);
  const preview = (id: string) => call(`/api/projects/${PROJECT}/sessions/${id}`);
  return { store, reads, call, save, list, preview };
}

describe("the two settings in the store (row 77)", () => {
  test("their keys and defaults: sessions from other apps shown, sessions open in another app left out", async () => {
    expect(SETTINGS_DEFAULTS["chats.sessionsFromOtherApps"]).toBe(true);
    expect(SETTINGS_DEFAULTS["chats.sessionsOpenElsewhere"]).toBe(false);
    const { store } = await setup();
    expect(await store.readSettings()).toMatchObject({ "chats.sessionsFromOtherApps": true, "chats.sessionsOpenElsewhere": false });
  });

  test("each takes a boolean only, through the settings route, and is kept with the other settings", async () => {
    const { save, store } = await setup();
    for (const bad of [{ "chats.sessionsFromOtherApps": "off" }, { "chats.sessionsOpenElsewhere": 1 }, { "chats.sessionsOpenElsewhere": null }]) expect((await save(bad)).status).toBe(400);
    expect(await store.readSettings()).toMatchObject({ "chats.sessionsFromOtherApps": true, "chats.sessionsOpenElsewhere": false });
    const r = await save({ "chats.sessionsFromOtherApps": false, "chats.sessionsOpenElsewhere": true });
    expect(r.status).toBe(200);
    expect(r.body.settings).toMatchObject({ "chats.sessionsFromOtherApps": false, "chats.sessionsOpenElsewhere": true });
    expect(await store.readSettings()).toMatchObject({ "chats.sessionsFromOtherApps": false, "chats.sessionsOpenElsewhere": true });
  });
});

describe("the session list follows the settings (row 77)", () => {
  test("by default a session that another app has open now, busy or idle, is left out, and the reply names it as hidden", async () => {
    const { list } = await setup();
    const r = await list();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ sessions: [{ sessionId: CLOSED, title: "Closed", lastModified: 1 }], hiddenOpen: [OPEN_IDLE, OPEN_BUSY] });
  });

  test("Show sessions open in another app on: they show, each with its mark (D58, as W19d built it)", async () => {
    const { list, save } = await setup();
    await save({ "chats.sessionsOpenElsewhere": true });
    expect((await list()).body).toEqual({
      sessions: [
        { sessionId: OPEN_IDLE, title: "Open and idle in a terminal", lastModified: 3, open: { app: "terminal", busy: false } },
        { sessionId: OPEN_BUSY, title: "Busy in the desktop app", lastModified: 2, open: { app: "desktop", busy: true } },
        { sessionId: CLOSED, title: "Closed", lastModified: 1 },
      ],
    });
  });

  test("Show sessions from other apps off: no list at all, whatever the other setting, and Claude Code's sessions are not read", async () => {
    const { list, save, reads } = await setup();
    for (const openToo of [false, true]) {
      await save({ "chats.sessionsFromOtherApps": false, "chats.sessionsOpenElsewhere": openToo });
      expect((await list()).body).toEqual({ sessions: [], hidden: "all" });
    }
    expect(reads.list).toBe(0);
    // On again: the list is back, at once (the next read).
    await save({ "chats.sessionsFromOtherApps": true });
    expect((await list()).body.sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual([OPEN_IDLE, OPEN_BUSY, CLOSED]);
  });

  test("an unknown project is still a 404 before any setting applies", async () => {
    const { call, save } = await setup();
    await save({ "chats.sessionsFromOtherApps": false });
    expect((await call(`/api/projects/${"a".repeat(10)}/sessions`)).status).toBe(404);
  });
});

describe("the session preview follows the settings (row 77)", () => {
  const HIDDEN = { history: [], more: null, chat: null, copy: null };

  test("Show sessions from other apps off: every preview says the setting hides it, and no transcript is read", async () => {
    const { preview, save, reads } = await setup();
    await save({ "chats.sessionsFromOtherApps": false });
    for (const id of [OPEN_IDLE, CLOSED]) expect(await preview(id)).toEqual({ status: 200, body: { ...HIDDEN, hidden: "all" } });
    expect(reads.history).toBe(0);
  });

  test("by default the preview of a session open in another app says the setting hides it; a closed one shows", async () => {
    const { preview, reads } = await setup();
    for (const id of [OPEN_IDLE, OPEN_BUSY]) expect(await preview(id)).toEqual({ status: 200, body: { ...HIDDEN, hidden: "open" } });
    expect(reads.history).toBe(0);
    const closed = await preview(CLOSED);
    expect(closed.body).toEqual({ history: [], more: null, chat: null, copy: null });
    expect(reads.history).toBe(1);
  });

  test("Show sessions open in another app on: the open session's preview shows, marked", async () => {
    const { preview, save } = await setup();
    await save({ "chats.sessionsOpenElsewhere": true });
    expect((await preview(OPEN_BUSY)).body).toEqual({ history: [], more: null, chat: null, copy: null, open: { app: "desktop", busy: true } });
  });
});
