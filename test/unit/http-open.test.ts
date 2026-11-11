// D58 in the JSON API: the project's session list and the session preview mark a session that another process has
// open now (`open: {app, busy}`, section 4), from the driver's read of Claude Code's registry of running sessions. A
// session that is not open has no `open`; a registry that cannot be read counts as none open, and the reply still
// comes. Settings > Chats > Show sessions open in another app is on here (row 77). No server is started: the
// handler is called.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PUBLIC_ADAPTERS } from "../../server/adapters/adapters";
import type { AgentDriver, BinaryProbe, SessionOpen } from "../../server/agents/types";
import { createGate } from "../../server/gate/guards";
import { createApi } from "../../server/http/api";
import { createApp, type Upgrader } from "../../server/http/app";
import { loadSite } from "../../server/http/static";
import { SETTINGS_DEFAULTS, type ProjectRecord } from "../../server/store/types";

const PORT = 7941;
const OWN = `http://127.0.0.1:${PORT}`;
const PROJECT = "k3m7q2x4ab";
const A = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const B = "0b1e2a3c-4d5e-4f60-8172-93a4b5c6d7e8";
const dir = mkdtempSync(join(tmpdir(), "kitespan-http-open-"));
const work = join(dir, "work");
mkdirSync(work, { recursive: true });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PROBE: BinaryProbe = { ok: true, path: "/opt/bin/claude", realpath: "/opt/bin/claude", version: "2.1.311", source: "path", refused: [], platformPackages: [], drift: null, belowMinimum: null };

function makeApp(openSessions?: () => Promise<ReadonlyMap<string, SessionOpen>>, copyForSession?: (id: string) => string | null) {
  const cwd = realpathSync(work);
  const project: ProjectRecord = { id: PROJECT, cwd, name: "work", createdAt: "2026-10-30T08:00:00Z", lastUsedAt: "2026-10-30T09:00:00Z", picks: { model: null, effort: null, permissionMode: null } };
  const driver: Pick<AgentDriver, "probe" | "settings" | "listSessions" | "history" | "sessionInfo"> & Partial<Pick<AgentDriver, "openSessions">> = {
    probe: async () => PROBE,
    settings: async () => ({ respondToBash: true, cleanupPeriodDays: 30, promptSuggestions: false, defaultMode: null }),
    listSessions: async (c) => [
      { sessionId: A, title: "Open in a terminal", customTitle: null, lastModified: 2, cwd: c },
      { sessionId: B, title: "Closed", customTitle: null, lastModified: 1, cwd: c },
    ],
    sessionInfo: async (id, c) => ({ sessionId: id, title: "t", customTitle: null, lastModified: 1, cwd: c }),
    history: async () => ({ events: [], more: null }),
    ...(openSessions ? { openSessions } : {}),
  };
  const gate = createGate(PORT, []);
  const site = loadSite(join(dir, "no-dist"), gate.origins);
  const api = createApi({
    gate,
    safe: site.safe,
    store: {
      listProjects: async () => [structuredClone(project)],
      putProject: async () => {},
      // Row 77: these marks show while Show sessions open in another app is on (off by default: http-session-settings).
      readSettings: async () => ({ ...SETTINGS_DEFAULTS, "chats.sessionsOpenElsewhere": true }),
      readChat: async () => null,
      listUploads: async () => [],
      putUpload: async () => {},
      removeUpload: async () => null,
    },
    driver,
    uploadFolder: async () => ({ ok: true, path: "/tmp/kitespan-uploads-x", choice: "temp" }),
    chatForSession: () => null,
    ...(copyForSession ? { copyForSession } : {}),
    heldSessions: () => new Set(),
    info: { port: PORT, version: "0.1.0", adapters: { ...PUBLIC_ADAPTERS, origins: [] } },
  });
  return createApp({ gate, site, api, sockets: {} });
}

const noServer: Upgrader = { upgrade: () => false };
async function get(app: ReturnType<typeof makeApp>, path: string): Promise<{ status: number; body: any }> {
  const res = (await app.fetch(new Request(`${OWN}${path}`, { headers: { host: `127.0.0.1:${PORT}` } }), noServer))!;
  return { status: res.status, body: await res.json() };
}

describe("open sessions in the API (D58)", () => {
  const open = async () => new Map<string, SessionOpen>([[A, { app: "terminal", busy: true }]]);

  test("the session list marks the session that is open elsewhere, and only it", async () => {
    const r = await get(makeApp(open), `/api/projects/${PROJECT}/sessions`);
    expect(r.status).toBe(200);
    expect(r.body.sessions).toEqual([
      { sessionId: A, title: "Open in a terminal", lastModified: 2, open: { app: "terminal", busy: true } },
      { sessionId: B, title: "Closed", lastModified: 1 },
    ]);
  });

  test("the preview says it too", async () => {
    expect((await get(makeApp(open), `/api/projects/${PROJECT}/sessions/${A}`)).body).toMatchObject({ open: { app: "terminal", busy: true } });
    expect((await get(makeApp(open), `/api/projects/${PROJECT}/sessions/${B}`)).body).not.toHaveProperty("open");
  });

  test("the preview names the newest copy of the session that a chat holds (W19d), else null", async () => {
    const COPY = "abcdefghijabcdefghij";
    const app = makeApp(open, (id) => (id === A ? COPY : null));
    expect((await get(app, `/api/projects/${PROJECT}/sessions/${A}`)).body).toMatchObject({ chat: null, copy: COPY, open: { app: "terminal", busy: true } });
    expect((await get(app, `/api/projects/${PROJECT}/sessions/${B}`)).body).toMatchObject({ chat: null, copy: null });
    expect((await get(makeApp(open), `/api/projects/${PROJECT}/sessions/${A}`)).body).toMatchObject({ copy: null });
  });

  test("a session that waits for an answer (R22) is marked waiting, in the list and the preview", async () => {
    const waits = async () => new Map<string, SessionOpen>([[A, { app: "desktop", busy: true, waiting: true }]]);
    expect((await get(makeApp(waits), `/api/projects/${PROJECT}/sessions`)).body.sessions[0]).toEqual({ sessionId: A, title: "Open in a terminal", lastModified: 2, open: { app: "desktop", busy: true, waiting: true } });
    expect((await get(makeApp(waits), `/api/projects/${PROJECT}/sessions/${A}`)).body.open).toEqual({ app: "desktop", busy: true, waiting: true });
  });

  test("a registry that cannot be read, or a driver without one, marks nothing and still answers", async () => {
    const broken = makeApp(async () => {
      throw new Error("unreadable");
    });
    const list = await get(broken, `/api/projects/${PROJECT}/sessions`);
    expect(list.status).toBe(200);
    expect(list.body.sessions.map((s: object) => "open" in s)).toEqual([false, false]);
    const preview = await get(broken, `/api/projects/${PROJECT}/sessions/${A}`);
    expect(preview.status).toBe(200);
    expect(preview.body).not.toHaveProperty("open");
    expect((await get(makeApp(), `/api/projects/${PROJECT}/sessions`)).body.sessions[0]).not.toHaveProperty("open");
  });
});
