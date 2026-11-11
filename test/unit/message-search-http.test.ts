// U5 (DESIGN-U5 10; FIX-U5 2): GET /api/search through the route table with no server started: the Host and Origin
// guards, the 400s (q over 200 units, a control character, a bad tab), the sender header rule (no disk read without
// it), the 204 of an ask that a newer one of its tab replaced, no-store and the safe headers, the reply's shape (no
// title, project or path), and no query in any log line.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MESSAGE_SEARCH, messageSearchPath, type MessageSearchReply } from "../../shared/message-search";
import type { ChatEvent } from "../../shared/protocol";
import { PUBLIC_ADAPTERS } from "../../server/adapters/adapters";
import { createGate } from "../../server/gate/guards";
import { API_ROUTE_PATTERNS, createApi } from "../../server/http/api";
import { createApp, HTTP_LOG_ROUTES, logRouteOf } from "../../server/http/app";
import { loadSite } from "../../server/http/static";
import { createLogger } from "../../server/log";
import { MessageIndex, type MessageSearch } from "../../server/search/messages";
import { SETTINGS_DEFAULTS } from "../../server/store/types";

const PORT = 7942;
const OWN = `http://127.0.0.1:${PORT}`;
const CHAT = "k3m7q2x4abk3m7q2x4ab";
const SESSION = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const dir = realpathSync(mkdtempSync(join(tmpdir(), "kitespan-search-http-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const EVENTS: ChatEvent[] = [
  { k: "user", uuid: "aaaaaaaa-0000-4000-8000-000000000001", text: "Where does the zebra cache live?", queued: false },
  { k: "block", key: "msg_01A:0", kind: "text", text: "The zebra cache lives in **memory**.", parent: null },
];

function makeApp(opts: { messages?: MessageSearch | null; logDir?: string; gate?: Promise<void> } = {}) {
  const reads: string[] = [];
  const logger = opts.logDir ? createLogger({ dir: opts.logDir, routes: HTTP_LOG_ROUTES }) : null;
  const index = new MessageIndex({
    log: logger,
    chats: () => [{ chat: CHAT, sessionId: SESSION, dir: "/srv/demo/zebra-secret-folder", activity: Date.now() }],
    stamp: async () => {
      reads.push("stamp");
      return { size: 10, mtime: 1 };
    },
    events: async () => {
      if (opts.gate) await opts.gate;
      reads.push("events");
      return EVENTS;
    },
    timer: false,
  });
  const gate = createGate(PORT);
  const site = loadSite(join(dir, "no-build"), gate.origins);
  const api = createApi({
    gate,
    safe: site.safe,
    store: {
      listProjects: async () => [],
      putProject: async () => {},
      readSettings: async () => ({ ...SETTINGS_DEFAULTS }),
      readChat: async () => null,
      listUploads: async () => [],
      putUpload: async () => {},
      removeUpload: async () => null,
    },
    driver: { probe: async () => { throw new Error("unused"); }, settings: async () => { throw new Error("unused"); }, listSessions: async () => [], history: async () => ({ events: [], more: null }), sessionInfo: async () => null },
    uploadFolder: async () => ({ ok: true, choice: "temp", path: dir }),
    chatForSession: () => null,
    heldSessions: () => new Set<string>(),
    info: { port: PORT, version: "0.5.0", adapters: PUBLIC_ADAPTERS },
    ...(opts.messages === null ? {} : { messages: opts.messages ?? index }),
    logger,
  });
  const app = createApp({ gate, site, api, sockets: {}, logger });
  const get = async (path: string, headers: Record<string, string> = {}, method = "GET") =>
    (await app.fetch(new Request(`${OWN}${path}`, { method, headers: { host: `127.0.0.1:${PORT}`, ...headers } }), { upgrade: () => false }))!;
  return { get, reads, logger, index };
}

const PAGE = { "x-kitespan": "1", origin: OWN };

describe("the route", () => {
  test("it is in the API's route list and its log pattern", () => {
    expect(API_ROUTE_PATTERNS).toContain("/api/search");
    expect(logRouteOf(messageSearchPath("zebra", "t1").split("?")[0]!)).toBe("/api/search");
  });

  test("the Host allowlist and the Origin check guard it; GET only", async () => {
    const { get } = makeApp();
    const path = messageSearchPath("zebra", "t1");
    expect((await get(path, { host: "evil.invalid" })).status).toBe(403);
    expect((await get(path, { origin: "https://evil.invalid" })).status).toBe(403);
    expect((await get(path, PAGE)).status).toBe(200);
    expect((await get(path, { ...PAGE, "content-type": "application/json" }, "POST")).status).toBe(405);
  });

  test("a bad query is 400: q over 200 units, a control character, two values of q, a bad tab", async () => {
    const { get } = makeApp();
    expect((await get(messageSearchPath("a".repeat(MESSAGE_SEARCH.queryMax + 1), null), PAGE)).status).toBe(400);
    expect((await get(messageSearchPath("a".repeat(MESSAGE_SEARCH.queryMax), null), PAGE)).status).toBe(200);
    for (const qs of ["?q=a%00b", "?q=a%E2%80%AEb", "?q=a&q=b", "?q=a&tab=", "?q=a&tab=has%20space", `?q=a&tab=${"t".repeat(65)}`]) expect((await get(`/api/search${qs}`, PAGE)).status).toBe(400);
  });

  test("with no message search the route is not here", async () => {
    const { get } = makeApp({ messages: null });
    expect((await get(messageSearchPath("zebra", null), PAGE)).status).toBe(404);
  });
});

describe("the answer", () => {
  test("the page's own read reads the transcripts; the reply has no-store, the safe headers, and no title, project or path", async () => {
    const { get, reads } = makeApp();
    const res = await get(messageSearchPath("zebra cache", "t1"), PAGE);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const body = (await res.json()) as MessageSearchReply;
    expect(body).toEqual({
      q: "zebra cache",
      complete: true,
      hits: [
        { chat: CHAT, message: "msg_01A-0", by: "agent", snippet: "The zebra cache lives in memory.", ranges: [[4, 9], [10, 15]] },
        { chat: CHAT, message: "aaaaaaaa-0000-4000-8000-000000000001", by: "user", snippet: "Where does the zebra cache live?", ranges: [[15, 20], [21, 26]] },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("zebra-secret-folder");
    expect(reads).toEqual(["stamp", "events"]);
  });

  test("a read without the sender header starts no disk read and answers from what is held", async () => {
    const { get, reads } = makeApp();
    const cold = (await (await get(messageSearchPath("zebra", null), { origin: OWN })).json()) as MessageSearchReply;
    expect(cold).toEqual({ q: "zebra", hits: [], complete: false });
    expect(reads).toEqual([]);
    await get(messageSearchPath("zebra", null), PAGE);
    const held = (await (await get(messageSearchPath("zebra", null))).json()) as MessageSearchReply;
    expect(held.hits).toHaveLength(2);
    expect(reads).toEqual(["stamp", "events"]);
  });

  test("a q under the minimum is the warm-up: no hits at once, and the read starts", async () => {
    const { get, reads, index } = makeApp();
    expect(await (await get(messageSearchPath("", "t1"), PAGE)).json()).toEqual({ q: "", hits: [], complete: true });
    await index.passDone();
    expect(reads).toEqual(["stamp", "events"]);
  });

  test("an ask that a newer one of its tab replaced answers 204 with no body", async () => {
    let open!: () => void;
    const { get } = makeApp({ gate: new Promise<void>((r) => (open = r)) });
    const first = get(messageSearchPath("zebr", "t1"), PAGE);
    await new Promise((r) => setTimeout(r, 5));
    const second = get(messageSearchPath("zebra", "t1"), PAGE);
    open();
    const a = await first;
    expect(a.status).toBe(204);
    expect(await a.text()).toBe("");
    expect(a.headers.get("cache-control")).toBe("no-store");
    expect((await second).status).toBe(200);
  });

  test("no log line holds the query, a word of it or a snippet", async () => {
    const logDir = join(dir, "logs");
    const { get, logger } = makeApp({ logDir });
    await get(messageSearchPath("zebra cache", "t1"), PAGE);
    await get(messageSearchPath("zebra%00", "t1"), PAGE);
    logger!.close();
    const text = readdirSync(logDir).map((f) => readFileSync(join(logDir, f), "utf8")).join("");
    expect(text).toContain('"ev":"search"');
    expect(text).toContain('"len":11');
    expect(text).not.toMatch(/zebra|cache|memory|secret/);
  });
});
