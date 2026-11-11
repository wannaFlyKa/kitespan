// The project corpus routes (D59): the new-chat form's `@` picker reads the project's folder with the chat routes'
// query keys, replies, limits, gates and errors (shared/corpus.ts), a project id and never a path, from the same cache
// as the chats of that folder (one build, one `v`), and no path or query in any log line.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORPUS_LIMITS, corpusPath, pageLimit, projectCorpusPath, projectCorpusSearchPath, type CorpusListReply, type CorpusSearchReply } from "../../shared/corpus";
import { PUBLIC_ADAPTERS } from "../../server/adapters/adapters";
import { createGate } from "../../server/gate/guards";
import { API_ROUTE_PATTERNS, createApi } from "../../server/http/api";
import { createApp, HTTP_LOG_ROUTES, logRouteOf } from "../../server/http/app";
import { loadSite } from "../../server/http/static";
import { createLogger } from "../../server/log";
import { CorpusBuild, CorpusCache, type CorpusService } from "../../server/search/cache";
import { projectRecord } from "../../server/chats/testing";
import { SETTINGS_DEFAULTS, type ChatLedger } from "../../server/store/types";

const PORT = 7942;
const OWN = `http://127.0.0.1:${PORT}`;
const PROJECT = "k3m7q2x4ab";
const CHAT = "k3m7q2x4abk3m7q2x4ab";
const GIT = ["/usr/bin/git", "/bin/git"].find((g) => existsSync(g)) ?? null;

const dir = realpathSync(mkdtempSync(join(tmpdir(), "kitespan-project-corpus-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
/** A folder name that must never reach a log line. */
const folder = join(dir, "zebra-secret-folder");
const FILES = ["README.md", "src/upload.ts", "web/composer/Composer.tsx"];
for (const f of FILES) {
  mkdirSync(join(folder, f, ".."), { recursive: true });
  writeFileSync(join(folder, f), "x\n");
}
if (GIT) {
  const env = { PATH: "/usr/bin:/bin", HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init"]]) spawnSync(GIT, ["-C", folder, ...args], { env });
}

function ledger(id: string, cwd: string): ChatLedger {
  const at = "2026-11-01T08:00:00.000Z";
  return { v: 1, id, project: PROJECT, cwd, agent: "claude-code", sessionId: null, title: null, picks: { model: null, effort: null, permissionMode: null }, createdAt: at, seenAt: at, lastActivityAt: at, lastSeq: 0, state: "sleeping", lastExit: null, archivedAt: null };
}

function makeApp(opts: { corpus?: CorpusService; logDir?: string } = {}) {
  const gate = createGate(PORT);
  const site = loadSite(join(dir, "no-build"), gate.origins);
  const logger = opts.logDir ? createLogger({ dir: opts.logDir, routes: HTTP_LOG_ROUTES }) : null;
  const api = createApi({
    gate,
    safe: site.safe,
    store: {
      listProjects: async () => [projectRecord(PROJECT, folder)],
      putProject: async () => {},
      readSettings: async () => ({ ...SETTINGS_DEFAULTS }),
      readChat: async (id) => (id === CHAT ? ledger(CHAT, folder) : null),
      listUploads: async () => [],
      putUpload: async () => {},
      removeUpload: async () => null,
    },
    driver: { probe: async () => { throw new Error("unused"); }, settings: async () => { throw new Error("unused"); }, listSessions: async () => [], history: async () => ({ events: [], more: null }), sessionInfo: async () => null },
    uploadFolder: async () => ({ ok: true, choice: "temp", path: dir }),
    chatForSession: () => null,
    heldSessions: () => new Set<string>(),
    info: { port: PORT, version: "0.3.0", adapters: PUBLIC_ADAPTERS },
    corpus: opts.corpus,
    logger,
  });
  const app = createApp({ gate, site, api, sockets: {}, logger });
  const get = async (path: string, headers: Record<string, string> = {}, method = "GET") =>
    (await app.fetch(new Request(`${OWN}${path}`, { method, headers: { host: `127.0.0.1:${PORT}`, ...headers } }), { upgrade: () => false }))!;
  return { get, logger };
}

const LAPTOP = pageLimit(false);
const TOUCH = pageLimit(true);

async function listOf(res: Response): Promise<CorpusListReply> {
  if (res.headers.get("content-encoding") === "gzip") return JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await res.arrayBuffer())))) as CorpusListReply;
  return (await res.json()) as CorpusListReply;
}

describe("the routes", () => {
  test("in the API's route list and their log pattern; the page's paths beside the chat routes'", () => {
    expect(API_ROUTE_PATTERNS).toContain("/api/projects/:project/corpus");
    expect(API_ROUTE_PATTERNS).toContain("/api/projects/:project/corpus/search");
    expect(logRouteOf(`/api/projects/${PROJECT}/corpus`)).toBe("/api/projects/:project/corpus");
    expect(logRouteOf(`/api/projects/${PROJECT}/corpus/search`)).toBe("/api/projects/:project/corpus/search");
    expect(projectCorpusPath(PROJECT, LAPTOP)).toBe(`/api/projects/${PROJECT}/corpus?max=100000`);
    expect(projectCorpusPath(PROJECT, TOUCH, "abc123")).toBe(`/api/projects/${PROJECT}/corpus?max=20000&chars=1400000&v=abc123`);
    expect(projectCorpusSearchPath(PROJECT, "my notes")).toBe(`/api/projects/${PROJECT}/corpus/search?q=my%20notes`);
    expect(projectCorpusSearchPath(PROJECT, "a+b", "v1")).toBe(`/api/projects/${PROJECT}/corpus/search?q=a%2Bb&v=v1`);
  });

  test("the Host allowlist and the Origin check guard both; a read only", async () => {
    const { get } = makeApp();
    for (const path of [projectCorpusPath(PROJECT, LAPTOP), projectCorpusSearchPath(PROJECT, "upl")]) {
      expect((await get(path, { host: "evil.invalid" })).status).toBe(403);
      expect((await get(path, { origin: "https://evil.invalid" })).status).toBe(403);
      expect((await get(path, { origin: OWN })).status).toBe(200);
      expect((await get(path, { origin: OWN, "content-type": "application/json", "x-kitespan": "1" }, "POST")).status).toBe(405);
    }
  });

  test("a project that is not here is 404; a bad id no route; a bad query 400", async () => {
    const { get } = makeApp();
    expect((await get(projectCorpusPath("zzzzzzzzzz", LAPTOP))).status).toBe(404);
    expect((await get(projectCorpusSearchPath("zzzzzzzzzz", "a"))).status).toBe(404);
    expect((await get("/api/projects/..%2F..%2Fetc/corpus?max=10")).status).toBe(404);
    const base = `/api/projects/${PROJECT}/corpus`;
    for (const qs of ["", "?max=", "?max=100001", "?max=10&max=11", "?max=10&chars=x", "?max=10&v=has%20space"]) expect((await get(base + qs)).status).toBe(400);
    expect((await get(projectCorpusSearchPath(PROJECT, "a".repeat(CORPUS_LIMITS.queryMax + 1)))).status).toBe(400);
    expect((await get(projectCorpusSearchPath(PROJECT, "a\u0000b"))).status).toBe(400);
  });

  test("`paths: null` over the page's limit, as for a chat", async () => {
    const paths = Array.from({ length: 20_001 }, (_, i) => `f/${i}.ts`);
    const build = new CorpusBuild({ source: "git", paths, complete: true }, Date.now());
    const cache = new CorpusCache({ list: async () => ({ source: "git", paths, complete: true, capped: false, timeout: false, code: 0, ms: 1, spawnFailed: false }), realRoot: async (c) => c, timer: false });
    const { get } = makeApp({ corpus: { read: async () => build, search: (cwd, chat, q, signal) => cache.search(cwd, chat, q, signal) } });
    expect((await listOf(await get(projectCorpusPath(PROJECT, TOUCH)))).paths).toBeNull();
    expect((await listOf(await get(projectCorpusPath(PROJECT, LAPTOP), { "accept-encoding": "gzip" }))).paths?.length).toBe(20_001);
    const r = (await (await get(projectCorpusSearchPath(PROJECT, "1999"))).json()) as CorpusSearchReply;
    expect(r.total).toBe(20_001);
    expect(r.rows.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!GIT)("the project's folder", () => {
  test("its files, gzipped, with the safe headers; one build shared with a chat of the folder; the search ranks them", async () => {
    const { get } = makeApp();
    const res = await get(projectCorpusPath(PROJECT, LAPTOP), { "accept-encoding": "gzip" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const body = await listOf(res);
    expect(body).toMatchObject({ source: "git", complete: true, total: 3, paths: ["README.md", "src/upload.ts", "web/composer/Composer.tsx"] });
    // The chat of the same folder reads the same build: the page's copy stands.
    expect(await (await get(corpusPath(CHAT, LAPTOP, body.v))).json()).toEqual({ v: body.v, same: true });
    expect(await (await get(projectCorpusPath(PROJECT, LAPTOP, body.v))).json()).toEqual({ v: body.v, same: true });
    const r = (await (await get(projectCorpusSearchPath(PROJECT, "comp"))).json()) as CorpusSearchReply;
    expect(r).toEqual({ v: body.v, total: 3, count: 1, rows: [{ path: "web/composer/Composer.tsx", nameRanges: [[0, 4]] }] });
  });

  test("the log: one corpus line with no chat, no path, no folder name and no query", async () => {
    const logDir = join(dir, "logs");
    const { get, logger } = makeApp({ logDir });
    await get(projectCorpusPath(PROJECT, LAPTOP));
    await get(projectCorpusSearchPath(PROJECT, "zebra upl"));
    await get(projectCorpusPath(PROJECT, LAPTOP), { origin: "https://evil.invalid" });
    logger!.close();
    const text = readdirSync(logDir).map((f) => readFileSync(join(logDir, f), "utf8")).join("");
    const lines = text.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => l.ev)).toEqual(["corpus", "origin_refused"]);
    expect(lines[0]).toMatchObject({ ev: "corpus", chat: null, code: 0, ok: true });
    expect(lines[1]).toMatchObject({ ev: "origin_refused", route: "/api/projects/:project/corpus" });
    expect(text).not.toMatch(/zebra|secret|upl|README|composer|kitespan-project-corpus/i);
  });
});
