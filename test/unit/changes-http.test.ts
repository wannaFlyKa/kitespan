// U1 (DESIGN-U1 9): GET /api/chats/:chat/changes/:turn and GET /api/chats/:chat/changes/:turn/files/<path>, with a
// real changes book over a scratch repository: the summary, one file's diff, the 5.4 cases (no such summary, a path
// not in it, marks whose objects are gone) as API errors that name their case, an archived chat's read, no-store on
// every answer, and only the route's pattern in a log line. No server is started: the handler is called.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PUBLIC_ADAPTERS } from "../../server/adapters/adapters";
import type { AgentDriver, BinaryProbe } from "../../server/agents/types";
import { ChangesBook } from "../../server/changes/book";
import { ChangesStore } from "../../server/changes/store";
import { createGate } from "../../server/gate/guards";
import { API_ROUTE_PATTERNS, createApi } from "../../server/http/api";
import { createApp, logRouteOf, type Upgrader } from "../../server/http/app";
import { loadSite } from "../../server/http/static";
import { ownUid } from "../../server/store/files";
import { SETTINGS_DEFAULTS, type ChatLedger } from "../../server/store/types";
import { changeFileApiPath, changesApiPath } from "../../shared/changes";
import { commitAll, scratch } from "./worktree-repo";

const PORT = 7941;
const OWN = `http://127.0.0.1:${PORT}`;
const CHAT = "k3m7q2x4abk3m7q2x4ab";
const PROBE: BinaryProbe = { ok: true, path: "/opt/bin/claude", realpath: "/opt/bin/claude", version: "2.1.318", source: "path", refused: [], platformPackages: [], drift: null, belowMinimum: null };
const s = scratch();
afterAll(() => s.cleanup());

writeFileSync(join(s.repo, "a.ts"), "a\nb\nc\n");
commitAll(s.repo, "a");
const root = join(s.root, "state", "changes");
mkdirSync(root, { recursive: true, mode: 0o700 });
const book = new ChangesBook({ store: new ChangesStore(root, ownUid()), git: s.wg });
const ledger = { id: CHAT, cwd: s.repo, archivedAt: "2026-11-01T00:00:00.000Z", project: "k3m7q2x4ab" } as unknown as ChatLedger;

function makeApp(withChanges = true) {
  const driver: Pick<AgentDriver, "probe" | "settings" | "listSessions" | "history" | "sessionInfo"> = {
    probe: async () => PROBE,
    settings: async () => ({ respondToBash: true, cleanupPeriodDays: 30, promptSuggestions: false, defaultMode: null }),
    listSessions: async () => [],
    sessionInfo: async () => null,
    history: async () => ({ events: [], more: null }),
  };
  const gate = createGate(PORT, []);
  const site = loadSite(join(s.root, "no-dist"), gate.origins);
  const api = createApi({
    gate,
    safe: site.safe,
    store: { listProjects: async () => [], putProject: async () => {}, readSettings: async () => ({ ...SETTINGS_DEFAULTS }), readChat: async (id) => (id === CHAT ? ledger : null), listUploads: async () => [], putUpload: async () => {}, removeUpload: async () => null },
    driver,
    uploadFolder: async () => ({ ok: true, path: "/tmp/kitespan-uploads-x", choice: "temp" }),
    chatForSession: () => null,
    heldSessions: () => new Set(),
    ...(withChanges ? { changes: book } : {}),
    info: { port: PORT, version: "0.1.0", adapters: { ...PUBLIC_ADAPTERS, origins: [] } },
  });
  return createApp({ gate, site, api, sockets: {} });
}

const noServer: Upgrader = { upgrade: () => false };
async function get(path: string, app = makeApp()): Promise<{ status: number; body: any; cache: string | null }> {
  const res = (await app.fetch(new Request(`${OWN}${path}`, { headers: { host: `127.0.0.1:${PORT}` } }), noServer))!;
  return { status: res.status, body: await res.json().catch(() => null), cache: res.headers.get("cache-control") };
}

/** One turn that edits a.ts inside an Edit's window (B, then BB, ...). */
let turns = 0;
async function turn(): Promise<string> {
  const t = book.begin(CHAT, s.repo, "user");
  await t.ready;
  book.note(t, { k: "tool_call", id: "w1", name: "Edit", input: { file_path: join(s.repo, "a.ts") }, parent: null });
  writeFileSync(join(s.repo, "a.ts"), `a\n${"B".repeat(++turns)}\nc\n`);
  book.note(t, { k: "tool_result", id: "w1", text: "ok", isError: false, parent: null, report: null });
  return (await book.end(CHAT, s.repo, t, ["7c9e6679-7425-40de-944b-e07fc1f90ae7"]))!.id;
}

describe("the two reads", () => {
  test("they are API patterns, and a log line names the pattern, never the path", () => {
    expect(API_ROUTE_PATTERNS).toContain("/api/chats/:chat/changes/:turn");
    expect(API_ROUTE_PATTERNS).toContain("/api/chats/:chat/changes/:turn/files/*");
    expect(logRouteOf(`/api/chats/${CHAT}/changes/q7m2x4k3ab/files/src/secret-name.ts`)).toBe("/api/chats/:chat/changes/:turn/files/*");
  });
  test("the summary, and one file's diff; an archived chat's too; no-store", async () => {
    const id = await turn();
    const summary = await get(changesApiPath(CHAT, id));
    expect(summary.status).toBe(200);
    expect(summary.cache).toBe("no-store");
    expect(summary.body).toEqual({ id, at: ["7c9e6679-7425-40de-944b-e07fc1f90ae7"], how: "git", total: 1, added: 1, removed: 1, files: [{ path: "a.ts", status: "M", added: 1, removed: 1 }], others: 0 });
    const diff = await get(changeFileApiPath(CHAT, id, "a.ts"));
    expect(diff.status).toBe(200);
    expect(diff.cache).toBe("no-store");
    expect(diff.body).toEqual({ path: "a.ts", status: "M", added: 1, removed: 1, hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, context: "", lines: [" a", "-b", "+B", " c"] }] });
  });
  test("not there: no such summary (or chat), a path not in it, marks whose objects are gone; each names its case", async () => {
    const id = await turn();
    expect(await get(changesApiPath(CHAT, "aaaaaaaaaa"))).toEqual({ status: 404, cache: "no-store", body: { error: { code: "not_found", message: "These changes are no longer kept." }, state: "no_turn" } });
    expect((await get(changesApiPath("aaaaaaaaaaaaaaaaaaaa", id))).body.state).toBe("no_turn");
    expect((await get(changesApiPath(CHAT, id), makeApp(false))).body.state).toBe("no_turn");
    expect(await get(changeFileApiPath(CHAT, id, "b.ts"))).toEqual({ status: 404, cache: "no-store", body: { error: { code: "not_found", message: "That file is not in this turn's changes." }, state: "no_file" } });
    expect((await get(changeFileApiPath(CHAT, "aaaaaaaaaa", "a.ts"))).body.state).toBe("no_turn");
    rmSync(join(root, CHAT, "objects"), { recursive: true, force: true });
    mkdirSync(join(root, CHAT, "objects"), { mode: 0o700 });
    expect(await get(changeFileApiPath(CHAT, id, "a.ts"))).toEqual({ status: 410, cache: "no-store", body: { error: { code: "gone", message: "This diff is no longer available." }, state: "gone" } });
  });
  test("a bad summary id or an unsafe path is no route at all", async () => {
    expect((await get(`/api/chats/${CHAT}/changes/all`)).status).toBe(404);
    expect((await get(`/api/chats/${CHAT}/changes/q7m2x4k3ab/files/..%2Fsecret`)).body.error.message).toBe("There is no such kitespan API route.");
  });
});
