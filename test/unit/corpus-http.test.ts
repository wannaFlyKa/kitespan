// The corpus routes (DESIGN.md 9.3; build checklist B4, B5), through the route table with no server started: the Host
// and Origin guards on both, a chat id and never a path, 404 and 400, `same: true`, `paths: null` over each limit,
// the hand-made gzip body with the safe headers, the top 120 with a true count, an archived chat read, and no path or
// query in any log line.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORPUS_LIMITS, corpusPath, corpusSearchPath, pageLimit, type CorpusListReply, type CorpusSearchReply } from "../../shared/corpus";
import { PUBLIC_ADAPTERS } from "../../server/adapters/adapters";
import { createGate } from "../../server/gate/guards";
import { API_ROUTE_PATTERNS, createApi } from "../../server/http/api";
import { createApp, HTTP_LOG_ROUTES, logRouteOf } from "../../server/http/app";
import { loadSite } from "../../server/http/static";
import { createLogger } from "../../server/log";
import { CorpusBuild, CorpusCache, type CorpusService } from "../../server/search/cache";
import { SETTINGS_DEFAULTS, type ChatLedger } from "../../server/store/types";

const PORT = 7942;
const OWN = `http://127.0.0.1:${PORT}`;
const CHAT = "k3m7q2x4abk3m7q2x4ab";
const ARCHIVED = "abcdefghijabcdefghij";
const GIT = ["/usr/bin/git", "/bin/git"].find((g) => existsSync(g)) ?? null;

const dir = realpathSync(mkdtempSync(join(tmpdir(), "kitespan-corpus-http-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
/** A folder name that must never reach a log line. */
const project = join(dir, "zebra-secret-folder");
const FILES = ["README.md", "src/upload.ts", "src/sync.ts", "web/composer/Composer.tsx", "docs/Écran.md"];
for (const f of FILES) {
  mkdirSync(join(project, f, ".."), { recursive: true });
  writeFileSync(join(project, f), "x\n");
}
if (GIT) {
  const env = { PATH: "/usr/bin:/bin", HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init"]]) spawnSync(GIT, ["-C", project, ...args], { env });
}

function ledger(id: string, cwd: string, archivedAt: string | null = null): ChatLedger {
  const at = "2026-11-01T08:00:00.000Z";
  return { v: 1, id, project: "k3m7q2x4ab", cwd, agent: "claude-code", sessionId: null, title: null, picks: { model: null, effort: null, permissionMode: null }, createdAt: at, seenAt: at, lastActivityAt: at, lastSeq: 0, state: "sleeping", lastExit: null, archivedAt };
}

function makeApp(opts: { corpus?: CorpusService; logDir?: string } = {}) {
  const chats = new Map([
    [CHAT, ledger(CHAT, project)],
    [ARCHIVED, ledger(ARCHIVED, project, "2026-11-01T09:00:00.000Z")],
  ]);
  const gate = createGate(PORT);
  const site = loadSite(join(dir, "no-build"), gate.origins);
  const logger = opts.logDir ? createLogger({ dir: opts.logDir, routes: HTTP_LOG_ROUTES }) : null;
  const api = createApi({
    gate,
    safe: site.safe,
    store: {
      listProjects: async () => [],
      putProject: async () => {},
      readSettings: async () => ({ ...SETTINGS_DEFAULTS }),
      readChat: async (id) => chats.get(id) ?? null,
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
const SAFE = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };

async function listOf(res: Response): Promise<CorpusListReply> {
  if (res.headers.get("content-encoding") === "gzip") return JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await res.arrayBuffer())))) as CorpusListReply;
  return (await res.json()) as CorpusListReply;
}

/** A corpus service that answers one fixed build (the size limits need builds no folder here has). */
function fixed(paths: string[]): CorpusService & { build: CorpusBuild } {
  const build = new CorpusBuild({ source: "git", paths, complete: true }, Date.now());
  const cache = new CorpusCache({ list: async () => ({ source: "git", paths, complete: true, capped: false, timeout: false, code: 0, ms: 1, spawnFailed: false }), realRoot: async (c) => c, timer: false });
  return { build, read: async () => build, search: (cwd, chat, q, signal) => cache.search(cwd, chat, q, signal) };
}

describe("the routes", () => {
  test("both are in the API's route list and their log pattern; a path never is", () => {
    expect(API_ROUTE_PATTERNS).toContain("/api/chats/:chat/corpus");
    expect(API_ROUTE_PATTERNS).toContain("/api/chats/:chat/corpus/search");
    expect(logRouteOf(`/api/chats/${CHAT}/corpus`)).toBe("/api/chats/:chat/corpus");
    expect(logRouteOf(`/api/chats/${CHAT}/corpus/search`)).toBe("/api/chats/:chat/corpus/search");
    expect(corpusPath(CHAT, LAPTOP)).toBe(`/api/chats/${CHAT}/corpus?max=100000`);
  });

  test("the Host allowlist and the Origin check guard both", async () => {
    const { get } = makeApp();
    for (const path of [corpusPath(CHAT, LAPTOP), corpusSearchPath(CHAT, "upl")]) {
      expect((await get(path, { host: "evil.invalid" })).status).toBe(403);
      expect((await get(path, { origin: "https://evil.invalid" })).status).toBe(403);
      expect((await get(path, { origin: OWN })).status).toBe(200);
      expect((await get(path)).status).toBe(200);
      // A read only: no other method.
      expect((await get(path, { origin: OWN, "content-type": "application/json" }, "POST")).status).toBe(405);
    }
  });

  test("a chat that is not here is 404; a bad id is no route at all", async () => {
    const { get } = makeApp();
    const gone = "zzzzzzzzzzzzzzzzzzzz";
    expect((await get(corpusPath(gone, LAPTOP))).status).toBe(404);
    expect((await get(corpusSearchPath(gone, "a"))).status).toBe(404);
    expect((await get("/api/chats/..%2F..%2Fetc/corpus?max=10")).status).toBe(404);
  });

  test("a bad query is 400: max, chars and v; a q over 1,024 characters or with a control character", async () => {
    const { get } = makeApp();
    const base = `/api/chats/${CHAT}/corpus`;
    for (const qs of ["", "?max=", "?max=-1", "?max=100001", "?max=1e3", "?max=10&max=11", "?max=10&chars=x", "?max=10&v=has%20space", `?max=10&v=${"a".repeat(65)}`]) expect((await get(base + qs)).status).toBe(400);
    expect((await get(corpusSearchPath(CHAT, "a".repeat(CORPUS_LIMITS.queryMax + 1)))).status).toBe(400);
    expect((await get(corpusSearchPath(CHAT, "a\u0000b"))).status).toBe(400);
    expect((await get(corpusSearchPath(CHAT, "a\u202eb"))).status).toBe(400);
    expect((await get(corpusSearchPath(CHAT, "a".repeat(CORPUS_LIMITS.queryMax)))).status).toBe(200);
  });
});

describe.skipIf(!GIT)("the list", () => {
  test("the chat folder's files, gzipped by hand, with the safe headers; then `same: true` for the page's v", async () => {
    const { get } = makeApp();
    const res = await get(corpusPath(CHAT, LAPTOP), { "accept-encoding": "gzip, deflate, br" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("vary")).toBe("accept-encoding");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    for (const [k, v] of Object.entries(SAFE)) expect(res.headers.get(k)).toBe(v);
    const body = await listOf(res);
    expect(body).toEqual({ v: body.v, source: "git", complete: true, total: 5, chars: FILES.join("").length, paths: ["README.md", "docs/Écran.md", "src/sync.ts", "src/upload.ts", "web/composer/Composer.tsx"] });
    // No gzip asked: plain JSON, the same answer.
    const plain = await get(corpusPath(CHAT, LAPTOP), { "accept-encoding": "identity" });
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(await listOf(plain)).toEqual(body);
    const same = await get(corpusPath(CHAT, LAPTOP, body.v));
    expect(await same.json()).toEqual({ v: body.v, same: true });
    for (const [k, v] of Object.entries(SAFE)) expect(same.headers.get(k)).toBe(v);
    // An old v gets the build.
    expect((await listOf(await get(corpusPath(CHAT, LAPTOP, "oldbuild1")))).paths?.length).toBe(5);
  });

  test("an archived chat can be read", async () => {
    const { get } = makeApp();
    expect((await listOf(await get(corpusPath(ARCHIVED, TOUCH)))).total).toBe(5);
  });

  test("HEAD answers the headers with no body", async () => {
    const { get } = makeApp();
    const res = await get(corpusPath(CHAT, LAPTOP), { "accept-encoding": "gzip" }, "HEAD");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });
});

describe("the limits", () => {
  test("`paths: null` over the page's path limit, over the touch character limit, and over 16 MiB of JSON", async () => {
    const twenty = Array.from({ length: 20_001 }, (_, i) => `f/${i}.ts`);
    let app = makeApp({ corpus: fixed(twenty) });
    const over = await listOf(await app.get(corpusPath(CHAT, TOUCH)));
    expect([over.total, over.paths]).toEqual([20_001, null]);
    expect((await listOf(await app.get(corpusPath(CHAT, LAPTOP), { "accept-encoding": "gzip" }))).paths?.length).toBe(20_001);
    expect((await listOf(await app.get(`/api/chats/${CHAT}/corpus?max=0`))).paths).toBeNull();

    // 20,000 paths of 71 characters: under the touch path limit, over its 1,400,000 characters.
    const wide = Array.from({ length: 20_000 }, (_, i) => `deep/${"x".repeat(60)}/${String(i).padStart(5, "0")}`);
    app = makeApp({ corpus: fixed(wide) });
    const chars = await listOf(await app.get(corpusPath(CHAT, TOUCH)));
    expect(chars.chars).toBeGreaterThan(CORPUS_LIMITS.touchChars);
    expect([chars.total, chars.paths]).toEqual([20_000, null]);
    expect((await listOf(await app.get(corpusPath(CHAT, LAPTOP)))).paths?.length).toBe(20_000);

    // 17,000 paths of 1,000 characters: about 17 MB of JSON, within every path and character limit the laptop sends.
    const huge = Array.from({ length: 17_000 }, (_, i) => `${"y".repeat(994)}/${String(i).padStart(5, "0")}`);
    app = makeApp({ corpus: fixed(huge) });
    const big = await listOf(await app.get(corpusPath(CHAT, LAPTOP), { "accept-encoding": "gzip" }));
    expect([big.total, big.paths]).toEqual([17_000, null]);
  });
});

describe.skipIf(!GIT)("the search", () => {
  test("the best rows by the shared matcher, with the build's v and total and the true count", async () => {
    const { get } = makeApp();
    const v = (await listOf(await get(corpusPath(CHAT, LAPTOP)))).v;
    const res = await get(corpusSearchPath(CHAT, "comp", "an0ld0ne"));
    for (const [k, val] of Object.entries(SAFE)) expect(res.headers.get(k)).toBe(val);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const r = (await res.json()) as CorpusSearchReply;
    expect(r).toEqual({ v, total: 5, count: 1, rows: [{ path: "web/composer/Composer.tsx", nameRanges: [[0, 4]] }] });
    // Accents fold both ways (the shared fold).
    expect(((await (await get(corpusSearchPath(CHAT, "ecran"))).json()) as CorpusSearchReply).rows.map((x) => x.path)).toEqual(["docs/Écran.md"]);
    // An empty query lists the first rows in corpus order.
    expect(((await (await get(`/api/chats/${CHAT}/corpus/search`)).json()) as CorpusSearchReply).count).toBe(5);
  });

  test("at most 120 rows, best first, with the true count", async () => {
    const paths = Array.from({ length: 1_000 }, (_, i) => `pkg${i}/src/upload${i}.ts`);
    const { get } = makeApp({ corpus: fixed(paths) });
    const r = (await (await get(corpusSearchPath(CHAT, "upl"))).json()) as CorpusSearchReply;
    expect([r.total, r.count, r.rows.length]).toEqual([1_000, 1_000, 120]);
    expect(r.rows[0]!.path).toBe("pkg0/src/upload0.ts");
  });
});

describe.skipIf(!GIT)("the log", () => {
  test("no path, no folder name and no query in any line", async () => {
    const logDir = join(dir, "logs");
    const { get, logger } = makeApp({ logDir });
    await get(corpusPath(CHAT, LAPTOP));
    await get(corpusSearchPath(CHAT, "zebra upl"));
    await get(corpusSearchPath(CHAT, "a\u0000b"));
    await get(corpusPath(CHAT, LAPTOP), { origin: "https://evil.invalid" });
    await get(`${corpusSearchPath(CHAT, "zebra")}&q=other`);
    logger!.close();
    const text = readdirSync(logDir).map((f) => readFileSync(join(logDir, f), "utf8")).join("");
    const lines = text.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => l.ev)).toEqual(["corpus", "origin_refused"]);
    expect(lines[0]).toMatchObject({ ev: "corpus", chat: CHAT, code: 0, ok: true, timeout: false, capped: false });
    expect(lines[1]).toMatchObject({ ev: "origin_refused", route: "/api/chats/:chat/corpus" });
    expect(text).not.toMatch(/zebra|secret|upl|README|composer|kitespan-corpus/i);
  });
});
