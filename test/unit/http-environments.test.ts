// Row 99 on the JSON API: an environment's Rename, Move and Remove (POST /api/projects/:project/rename, /move,
// /remove), each one request behind the sender gate, run one at a time with the other project table changes, and each
// told to every page (the socket's `projects` frame). GET /api/projects keeps the last used order until a move, then
// gives the user's order, with an environment added later at the top. Remove is refused while a chat there works or
// needs input, with its one line. No server is started: the handler is called.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PUBLIC_ADAPTERS } from "../../server/adapters/adapters";
import type { AgentDriver } from "../../server/agents/types";
import { Environments, REMOVE_BUSY, cleanProjectName } from "../../server/chats/environments";
import { MemoryStore, projectRecord } from "../../server/chats/testing";
import { createGate } from "../../server/gate/guards";
import { createApi } from "../../server/http/api";
import { createApp, logRouteOf, type Upgrader } from "../../server/http/app";
import { loadSite } from "../../server/http/static";
import { ownUid } from "../../server/store/files";
import type { ProjectRecord } from "../../server/store/types";
import type { ReleasedSession } from "../../server/store/released";

const PORT = 7947;
const OWN = `http://127.0.0.1:${PORT}`;
const A = "aaaaaaaaaa";
const B = "bbbbbbbbbb";
const C = "cccccccccc";
const SENDER: Record<string, string> = { "x-kitespan": "1", "content-type": "application/json", origin: OWN };
const noServer: Upgrader = { upgrade: () => false };
const dir = mkdtempSync(join(tmpdir(), "kitespan-http-env-"));
const work = join(dir, "work");

beforeAll(() => mkdirSync(work, { recursive: true }));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The terminal's session in every folder, two sessions of the SDK's own (one a removed chat's), and an old chat's. */
const TERMINAL = "11111111-1111-4111-8111-111111111111";
const CHAT_SESSION = "22222222-2222-4222-8222-222222222222";
const OTHER_SDK = "33333333-3333-4333-8333-333333333333";
const STILL_CHAT = "44444444-4444-4444-8444-444444444444";
const info = (sessionId: string, cwd: string) => ({ sessionId, title: sessionId.slice(0, 4), customTitle: null, lastModified: 1, cwd });
const driver: Pick<AgentDriver, "probe" | "settings" | "listSessions" | "listReleased" | "history" | "sessionInfo"> = {
  probe: async () => ({ ok: true, path: "/opt/bin/claude", realpath: "/opt/bin/claude", version: "2.1.312", source: "path", refused: [], platformPackages: [], drift: null, belowMinimum: null }),
  settings: async () => ({ respondToBash: true, cleanupPeriodDays: 30, promptSuggestions: false, defaultMode: null }),
  listSessions: async (cwd) => [info(TERMINAL, cwd)],
  // As the SDK with includeProgrammatic true, kept to the ids asked for.
  listReleased: async (cwd, ids) => [TERMINAL, CHAT_SESSION, OTHER_SDK, STILL_CHAT].filter((id) => ids.includes(id)).map((id) => info(id, cwd)),
  sessionInfo: async () => null,
  history: async () => ({ events: [], more: null }),
};

const used = (id: string, cwd: string, lastUsedAt: string): ProjectRecord => ({ ...projectRecord(id, cwd), name: id.slice(0, 1), lastUsedAt });

function setup(opts: { busy?: boolean; leaves?: boolean; releaseFails?: boolean; envFails?: boolean } = {}) {
  const store = new MemoryStore();
  // Last used: B, then C, then A.
  store.projects = [used(A, "/srv/a", "2026-11-01T09:00:00.000Z"), used(B, "/srv/b", "2026-11-03T09:00:00.000Z"), used(C, "/srv/c", "2026-11-02T09:00:00.000Z")];
  const notes: (string | undefined)[] = [];
  const left: string[] = [];
  const steps: string[] = [];
  const putProjects = store.putProjects.bind(store);
  let multiWrites = 0;
  store.putProjects = async (recs) => {
    multiWrites++;
    await putProjects(recs);
  };
  const removeProject = store.removeProject.bind(store);
  store.removeProject = async (id) => {
    steps.push("removeProject");
    return removeProject(id);
  };
  const released = new Map<string, ReleasedSession[]>();
  const environments = new Environments({
    store,
    released: {
      release: async (cwd, sessions) => {
        steps.push(`release ${cwd} ${sessions.map((x) => x.id).join(",")}`);
        if (opts.releaseFails) throw new Error("disk full");
        released.set(cwd, [...(released.get(cwd) ?? []), ...sessions]);
      },
    },
    chats: {
      beginLeave: () => opts.busy !== true,
      cancelLeave: () => steps.push("cancelLeave"),
      sessionsIn: (id) => [{ id: CHAT_SESSION, dir: store.projects.find((p) => p.id === id)!.cwd }],
      leaveProject: async (id) => {
        steps.push("leaveProject");
        left.push(id);
        return opts.leaves !== false;
      },
    },
    env: {
      remove: async (id) => {
        steps.push(`removeEnv ${id}`);
        if (opts.envFails) throw new Error("disk full");
      },
    },
    notify: (removed) => {
      steps.push(removed ? `notify:${removed}` : "notify");
      notes.push(removed);
    },
    uid: ownUid(),
  });
  const gate = createGate(PORT, []);
  const site = loadSite(join(dir, "dist"), gate.origins);
  const api = createApi({
    gate,
    safe: site.safe,
    store,
    driver,
    uploadFolder: async () => ({ ok: true, path: "/tmp/kitespan-uploads-x", choice: "temp" }),
    chatForSession: () => null,
    info: { port: PORT, version: "0.1.0", adapters: { ...PUBLIC_ADAPTERS, origins: [] } },
    environments,
    releasedOf: (cwd) => released.get(cwd) ?? [],
    heldSessions: () => new Set([STILL_CHAT]),
  });
  const app = createApp({ gate, site, api, sockets: {} });
  const call = async (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    (await app.fetch(new Request(`${OWN}${path}`, { method: init.method ?? "GET", headers: { host: `127.0.0.1:${PORT}`, ...init.headers }, body: init.body }), noServer))!;
  const post = (path: string, body: unknown) => call(path, { method: "POST", headers: SENDER, body: JSON.stringify(body) });
  const listed = async () => ((await (await call("/api/projects")).json()) as { projects: { id: string; name: string }[] }).projects.map((p) => p.id);
  return { store, notes, left, steps, call, post, listed, multiWrites: () => multiWrites };
}

describe("the order (GET /api/projects)", () => {
  test("no move yet: the last used first, as before", async () => {
    const { listed } = setup();
    expect(await listed()).toEqual([B, C, A]);
  });

  test("after one move, the user's order holds whatever is used next; an environment added later goes at the top", async () => {
    const { store, post, listed, notes } = setup();
    const r = await post(`/api/projects/${A}/move`, { before: B });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { projects: { id: string }[] }).projects.map((p) => p.id)).toEqual([A, B, C]);
    expect(await listed()).toEqual([A, B, C]);
    store.projects = store.projects.map((p) => (p.id === C ? { ...p, lastUsedAt: "2026-11-09T09:00:00.000Z" } : p));
    expect(await listed()).toEqual([A, B, C]);
    const added = await post("/api/projects", { cwd: work });
    expect(added.status).toBe(201);
    const id = ((await added.json()) as { project: { id: string } }).project.id;
    expect(await listed()).toEqual([id, A, B, C]);
    expect(notes).toEqual([undefined, undefined]);
  });

  test("an environment added before any move is first too (it was used last), and every page hears of it", async () => {
    const { post, listed, notes } = setup();
    const id = ((await (await post("/api/projects", { cwd: realpathSync(work) })).json()) as { project: { id: string } }).project.id;
    expect(await listed()).toEqual([id, B, C, A]);
    expect(notes).toEqual([undefined]);
  });
});

describe("Move (POST /api/projects/:project/move)", () => {
  test("Move up, Move down and a drop at the end: one request, one write of projects.json each", async () => {
    const { post, listed, multiWrites } = setup();
    await post(`/api/projects/${A}/move`, { before: C }); // A up by one: B, A, C
    expect(await listed()).toEqual([B, A, C]);
    await post(`/api/projects/${B}/move`, { before: C }); // B down by one: A, B, C
    expect(await listed()).toEqual([A, B, C]);
    await post(`/api/projects/${A}/move`, { before: null }); // to the end
    expect(await listed()).toEqual([B, C, A]);
    expect(multiWrites()).toBe(3);
  });

  test("a bad body or an unknown project is refused and changes nothing", async () => {
    const { post, listed, notes, call } = setup();
    expect((await post(`/api/projects/${A}/move`, {})).status).toBe(400);
    expect((await post(`/api/projects/${A}/move`, { before: 3 })).status).toBe(400);
    expect((await post(`/api/projects/${A}/move`, { before: "zzzzzzzzzz" })).status).toBe(400);
    expect((await post("/api/projects/zzzzzzzzzz/move", { before: null })).status).toBe(404);
    expect((await call(`/api/projects/${A}/move`, { method: "POST", headers: { "content-type": "application/json", origin: OWN }, body: "{}" })).status).toBe(403);
    expect((await call(`/api/projects/${A}/move`)).status).toBe(405);
    expect(await listed()).toEqual([B, C, A]);
    expect(notes).toEqual([]);
    // Before itself: nothing moves, and nothing is written.
    expect((await post(`/api/projects/${A}/move`, { before: A })).status).toBe(200);
    expect(notes).toEqual([]);
  });
});

describe("Rename (POST /api/projects/:project/rename)", () => {
  test("the name only, trimmed; the folder and the rest stay; every page hears of it", async () => {
    const { store, post, notes } = setup();
    const r = await post(`/api/projects/${A}/rename`, { name: "  Web app  " });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { project: { name: string; cwd: string } }).project).toMatchObject({ name: "Web app", cwd: "/srv/a" });
    const rec = store.projects.find((p) => p.id === A)!;
    expect(rec).toEqual({ ...used(A, "/srv/a", "2026-11-01T09:00:00.000Z"), name: "Web app" });
    expect(notes).toEqual([undefined]);
    // The same name again writes nothing.
    await post(`/api/projects/${A}/rename`, { name: "Web app" });
    expect(notes).toEqual([undefined]);
  });

  test("1 to 80 characters after trimming, with no control character", async () => {
    const { store, post } = setup();
    expect((await post(`/api/projects/${A}/rename`, { name: "n".repeat(80) })).status).toBe(200);
    for (const name of ["", "   ", "n".repeat(81), "two\nlines", "a\u202eb", 42, null])
      expect((await post(`/api/projects/${A}/rename`, { name })).status).toBe(400);
    expect((await post(`/api/projects/${A}/rename`, {})).status).toBe(400);
    expect((await post("/api/projects/zzzzzzzzzz/rename", { name: "x" })).status).toBe(404);
    expect(store.projects.find((p) => p.id === A)!.name).toBe("n".repeat(80));
    expect(cleanProjectName("  a b  ")).toBe("a b");
  });
});

describe("Remove (POST /api/projects/:project/remove)", () => {
  test("refused while a chat there works or needs input, with its one line; nothing goes and no page is told", async () => {
    const { store, post, left, notes } = setup({ busy: true });
    const r = await post(`/api/projects/${A}/remove`, {});
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: { code: "busy", message: REMOVE_BUSY } });
    expect(REMOVE_BUSY).toBe("A chat here is working or needs input. Remove this environment when it is done.");
    expect(left).toEqual([]);
    expect(notes).toEqual([]);
    expect(store.projects.map((p) => p.id)).toContain(A);
  });

  test("every page hears first, then the chats leave, then the project goes, then the list is read again", async () => {
    const { store, post, steps, listed } = setup();
    const r = await post(`/api/projects/${A}/remove`, {});
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ removed: A });
    expect(steps).toEqual([`release /srv/a ${CHAT_SESSION}`, `notify:${A}`, "leaveProject", `removeEnv ${A}`, "removeProject", "notify"]);
    expect(await listed()).toEqual([B, C]);
    expect(store.projects.map((p) => p.id)).not.toContain(A);
    expect((await post(`/api/projects/${A}/remove`, {})).status).toBe(404);
  });

  test("when a chat could not leave, the project stays and the pages read the list again", async () => {
    const { store, post, steps } = setup({ leaves: false });
    expect((await post(`/api/projects/${A}/remove`, {})).status).toBe(500);
    expect(steps).toEqual([`release /srv/a ${CHAT_SESSION}`, `notify:${A}`, "leaveProject", "notify"]);
    expect(store.projects.map((p) => p.id)).toContain(A);
  });

  test("when the variables file cannot go, the project stays (Remove may run again) and chats may start there again", async () => {
    const { store, post, steps } = setup({ envFails: true });
    expect((await post(`/api/projects/${A}/remove`, {})).status).toBe(500);
    expect(steps).toEqual([`release /srv/a ${CHAT_SESSION}`, `notify:${A}`, "leaveProject", `removeEnv ${A}`, "cancelLeave", "notify"]);
    expect(store.projects.map((p) => p.id)).toContain(A);
  });

  test("when the sessions cannot be released, nothing goes and no page is told", async () => {
    const { store, post, steps, left } = setup({ releaseFails: true });
    expect((await post(`/api/projects/${A}/remove`, {})).status).toBe(500);
    expect(steps).toEqual([`release /srv/a ${CHAT_SESSION}`, "cancelLeave"]);
    expect(left).toEqual([]);
    expect(store.projects.map((p) => p.id)).toContain(A);
  });

  test("the folder added again lists the released session From the terminal, and no other session of the SDK's own", async () => {
    const { store, post, call } = setup();
    const sessions = async (id: string) => ((await (await call(`/api/projects/${id}/sessions`)).json()) as { sessions: { sessionId: string }[] }).sessions.map((x) => x.sessionId);
    expect(await sessions(A)).toEqual([TERMINAL]);
    expect((await post(`/api/projects/${A}/remove`, {})).status).toBe(200);
    // The same folder added again (its real path, the release's key) is a new project.
    const D = "dddddddddd";
    await store.putProject(used(D, "/srv/a", "2026-11-04T09:00:00.000Z"));
    expect(await sessions(D)).toEqual([TERMINAL, CHAT_SESSION]);
    // Another folder lists its terminal's sessions only; the SDK's other session never lists.
    expect(await sessions(B)).toEqual([TERMINAL]);
    expect(JSON.stringify(await sessions(D))).not.toContain(OTHER_SDK);
  });

  test("the three routes are in the log's route list", () => {
    for (const r of ["rename", "move", "remove"]) expect(logRouteOf(`/api/projects/${A}/${r}`)).toBe(`/api/projects/:project/${r}`);
  });
});
