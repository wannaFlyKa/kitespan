// A project's file list on the page (D59, DECISIONS-OWNER row 75; the contracts of FIX-W19d section 4): the new-chat
// form's `@` picker reads the project's folder before any chat exists, through GET /api/projects/:project/corpus and
// its search route, with the chat routes' limits and answers; the list is kept under the project's folder, the key its
// chats use, so the form and the chats share one copy, and a list over the page's limit is ranked by the route of
// whoever read it last (the project's form, or a chat).
import { afterEach, describe, expect, test } from "bun:test";
import { CORPUS_LIMITS, type CorpusReply, type CorpusSearchReply } from "../../shared/corpus";
import { corpusKey, corpusOf, openCorpus, openProjectCorpus, projectCorpusKey, resetCorpora } from "../../web/search/corpus";
import { createFileEngine, projectRouteSearch } from "../../web/search/engine";

const PROJECT = "k3m7q2x4ab";
const CHAT = "demoolxxxxxxxxxxxxxx";
const FOLDER = "/work/demo";

function server(replies: (CorpusReply | CorpusSearchReply | number)[]) {
  const asked: URL[] = [];
  const inits: (RequestInit | undefined)[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    asked.push(new URL(String(input), "http://127.0.0.1"));
    inits.push(init);
    const next = replies.shift();
    if (next === undefined) throw new TypeError("network");
    if (typeof next === "number") return new Response("{}", { status: next });
    return new Response(JSON.stringify(next), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetcher, asked, inits };
}

const list = (v: string, paths: string[]): CorpusReply => ({ v, source: "git", complete: true, total: paths.length, chars: paths.join("").length, paths });
const big = (v: string): CorpusReply => ({ v, source: "git", complete: false, total: 100_000, chars: 9_000_000, paths: null });
const now = (() => {
  let t = 0;
  return () => ++t;
})();
const deps = (fetcher: typeof fetch) => ({ fetcher, later: (run: () => void) => run(), now, warm: () => 0 });

afterEach(() => resetCorpora());

describe("the project corpus read (D59)", () => {
  test("GET /api/projects/:project/corpus with the page's limit, a laptop's and touch's; no body", async () => {
    const s = server([list("v1", ["README.md"]), list("v1", ["README.md"])]);
    await openProjectCorpus(PROJECT, false, deps(s.fetcher));
    resetCorpora();
    await openProjectCorpus(PROJECT, true, deps(s.fetcher));
    const [laptop, touch] = s.asked;
    expect(laptop!.pathname).toBe(`/api/projects/${PROJECT}/corpus`);
    expect(Object.fromEntries(laptop!.searchParams)).toEqual({ max: String(CORPUS_LIMITS.laptopPaths) });
    expect(Object.fromEntries(touch!.searchParams)).toEqual({ max: String(CORPUS_LIMITS.touchPaths), chars: String(CORPUS_LIMITS.touchChars) });
    expect(s.inits[0]).toMatchObject({ method: "GET" });
    expect(s.inits[0]?.body).toBeUndefined();
    const snap = corpusOf(projectCorpusKey(PROJECT));
    expect(snap.state).toBe("ready");
    expect(createFileEngine(snap.source!).rows("READ")?.rows.map((r) => r.path)).toEqual(["README.md"]);
  });

  test("the key is the project's folder, as its chats' is; with no folder known, the project's own", () => {
    expect(projectCorpusKey(PROJECT, FOLDER)).toBe(corpusKey(CHAT, FOLDER));
    expect(projectCorpusKey(PROJECT)).toBe(`project:${PROJECT}`);
    expect(projectCorpusKey(PROJECT)).not.toBe(corpusKey(CHAT));
  });

  test("over the limit, the project's search route ranks each query, with the build's v", async () => {
    const s = server([big("b1"), { v: "b1", total: 100_000, count: 1, rows: [{ path: "docs/a b.md", nameRanges: [[0, 1]] }] }]);
    await openProjectCorpus(PROJECT, false, deps(s.fetcher));
    const snap = corpusOf(projectCorpusKey(PROJECT));
    expect(snap.source?.at).toBe("server");
    const engine = createFileEngine(snap.source!);
    let landed = 0;
    engine.subscribe(() => landed++);
    engine.ask("a b");
    while (!landed) await Bun.sleep(1);
    expect(engine.rows("a b")?.rows.map((r) => r.path)).toEqual(["docs/a b.md"]);
    const search = s.asked[1]!;
    expect(search.pathname).toBe(`/api/projects/${PROJECT}/corpus/search`);
    expect(Object.fromEntries(search.searchParams)).toEqual({ q: "a b", v: "b1" });
    // A space is %20, as the chat route's is (no "+").
    expect(search.search).toContain("q=a%20b");
    engine.close();
  });

  test("the form and a chat of the project share one list: the second read sends the v, and same keeps the copy", async () => {
    const key = corpusKey(CHAT, FOLDER);
    const s = server([list("v3", ["src/upload.ts", "README.md"]), { v: "v3", same: true }]);
    await openCorpus(CHAT, false, deps(s.fetcher), key);
    const snap = corpusOf(key);
    await openProjectCorpus(PROJECT, false, deps(s.fetcher), projectCorpusKey(PROJECT, FOLDER));
    expect(s.asked[1]!.pathname).toBe(`/api/projects/${PROJECT}/corpus`);
    expect(s.asked[1]!.searchParams.get("v")).toBe("v3");
    expect(corpusOf(key)).toBe(snap);
  });

  test("a server source a chat read is asked through the project's route once the form read it (same)", async () => {
    const key = corpusKey(CHAT, FOLDER);
    const s = server([big("b2"), { v: "b2", same: true }, { v: "b2", total: 100_000, count: 0, rows: [] }]);
    await openCorpus(CHAT, false, deps(s.fetcher), key);
    await openProjectCorpus(PROJECT, false, deps(s.fetcher), key);
    const engine = createFileEngine(corpusOf(key).source!);
    let landed = 0;
    engine.subscribe(() => landed++);
    engine.ask("x");
    while (!landed) await Bun.sleep(1);
    expect(s.asked[2]!.pathname).toBe(`/api/projects/${PROJECT}/corpus/search`);
    engine.close();
  });

  test("projectRouteSearch: a GET with no body; a refused answer throws", async () => {
    const s = server([403]);
    const route = projectRouteSearch(PROJECT, "v9", s.fetcher);
    await expect(route("q", new AbortController().signal)).rejects.toThrow("search: 403");
    expect(s.asked[0]!.pathname).toBe(`/api/projects/${PROJECT}/corpus/search`);
    expect(s.inits[0]).toMatchObject({ method: "GET" });
  });
});
