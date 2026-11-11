// R131 (DESIGN-R131 9.6): GET /api/chats/:chat/background/:id, the read-only view's read of a background session that
// a launch row of the chat printed. The route names the chat and the short id only (a path or a session id is not even
// a route), passes `since` and `before` on when they are short and plain, and answers the registry's reply, or the
// one line for a session that is not in the chat. No server is started: the handler is called.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PUBLIC_ADAPTERS } from "../../server/adapters/adapters";
import type { AgentDriver, BinaryProbe } from "../../server/agents/types";
import { createGate } from "../../server/gate/guards";
import { API_ROUTE_PATTERNS, createApi } from "../../server/http/api";
import { createApp, type Upgrader } from "../../server/http/app";
import { loadSite } from "../../server/http/static";
import { SETTINGS_DEFAULTS } from "../../server/store/types";
import type { BackgroundViewReply } from "../../shared/protocol";

const PORT = 7941;
const OWN = `http://127.0.0.1:${PORT}`;
const CHAT = "k3m7q2x4abk3m7q2x4ab";
const ID = "3f9a1c2e";
const dir = mkdtempSync(join(tmpdir(), "kitespan-http-background-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const PROBE: BinaryProbe = { ok: true, path: "/opt/bin/claude", realpath: "/opt/bin/claude", version: "2.1.318", source: "path", refused: [], platformPackages: [], drift: null, belowMinimum: null };

function makeApp(view?: (chat: string, id: string, q: { since: string | null; before: string | null }) => Promise<BackgroundViewReply | null>) {
  const driver: Pick<AgentDriver, "probe" | "settings" | "listSessions" | "history" | "sessionInfo"> = {
    probe: async () => PROBE,
    settings: async () => ({ respondToBash: true, cleanupPeriodDays: 30, promptSuggestions: false, defaultMode: null }),
    listSessions: async () => [],
    sessionInfo: async () => null,
    history: async () => ({ events: [], more: null }),
  };
  const gate = createGate(PORT, []);
  const site = loadSite(join(dir, "no-dist"), gate.origins);
  const api = createApi({
    gate,
    safe: site.safe,
    store: { listProjects: async () => [], putProject: async () => {}, readSettings: async () => ({ ...SETTINGS_DEFAULTS }), readChat: async () => null, listUploads: async () => [], putUpload: async () => {}, removeUpload: async () => null },
    driver,
    uploadFolder: async () => ({ ok: true, path: "/tmp/kitespan-uploads-x", choice: "temp" }),
    chatForSession: () => null,
    heldSessions: () => new Set(),
    ...(view ? { backgroundView: view } : {}),
    info: { port: PORT, version: "0.1.0", adapters: { ...PUBLIC_ADAPTERS, origins: [] } },
  });
  return createApp({ gate, site, api, sockets: {} });
}

const noServer: Upgrader = { upgrade: () => false };
async function get(app: ReturnType<typeof makeApp>, path: string): Promise<{ status: number; body: any }> {
  const res = (await app.fetch(new Request(`${OWN}${path}`, { headers: { host: `127.0.0.1:${PORT}` } }), noServer))!;
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("the background view's read", () => {
  test("it is one of the API's patterns, and it names the chat and the short id only", () => {
    expect((API_ROUTE_PATTERNS as readonly string[]).includes("/api/chats/:chat/background/:id")).toBe(true);
  });

  test("the registry's reply, with since and before passed on", async () => {
    const asks: unknown[] = [];
    const app = makeApp(async (chat, id, q) => {
      asks.push([chat, id, q]);
      return q.since === "1762300000005:1234" ? { same: true } : { history: [], more: null, stamp: "1762300000005:1234", mode: "bypassPermissions" };
    });
    expect(await get(app, `/api/chats/${CHAT}/background/${ID}`)).toEqual({ status: 200, body: { history: [], more: null, stamp: "1762300000005:1234", mode: "bypassPermissions" } });
    expect(await get(app, `/api/chats/${CHAT}/background/${ID}?since=1762300000005%3A1234`)).toEqual({ status: 200, body: { same: true } });
    await get(app, `/api/chats/${CHAT}/background/${ID}?before=h1%3A40`);
    expect(asks).toEqual([
      [CHAT, ID, { since: null, before: null }],
      [CHAT, ID, { since: "1762300000005:1234", before: null }],
      [CHAT, ID, { since: null, before: "h1:40" }],
    ]);
  });

  test("a session that is not in the chat: its one line; a session outside the project: outside", async () => {
    const app = makeApp(async (_c, id) => (id === ID ? { outside: true } : null));
    expect(await get(app, `/api/chats/${CHAT}/background/${ID}`)).toEqual({ status: 200, body: { outside: true } });
    expect(await get(app, `/api/chats/${CHAT}/background/0a1b2c3d`)).toMatchObject({ status: 404, body: { error: { code: "not_found", message: "That background session is not in this chat." } } });
    expect((await get(makeApp(), `/api/chats/${CHAT}/background/${ID}`)).status).toBe(404);
  });

  test("an id that is not a short id, a session id, or a path is no route; a long or odd cursor is a bad request", async () => {
    let asked = 0;
    const app = makeApp(async () => {
      asked++;
      return { same: true };
    });
    for (const bad of ["3F9A1C2E", "7c9e6679-7425-40de-944b-e07fc1f90ae7", "..", "3f9a1c2e/extra"]) expect((await get(app, `/api/chats/${CHAT}/background/${bad}`)).status).toBe(404);
    expect((await get(app, `/api/chats/${CHAT}/background/${ID}?since=${"9".repeat(600)}`)).status).toBe(400);
    expect((await get(app, `/api/chats/${CHAT}/background/${ID}?before=a%0Ab`)).status).toBe(400);
    expect(asked).toBe(0);
  });
});
