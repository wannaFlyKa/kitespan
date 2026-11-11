// The page's search engine contract (web/search/engine.ts; DESIGN.md 9.3; the build checklist's C3): one engine for
// the `@` picker and the search pane, over the page's own copy or the server's search route, with the same rows.
import { describe, expect, test } from "bun:test";
import type { CorpusSearchReply } from "../../shared/corpus";
import { Corpus, Searcher, prepareCorpus, searchCorpus } from "../../shared/match";
import { createFileEngine, routeSearch, type FileRows, type SearchRoute } from "../../web/search/engine";

const C = "k3m7q2x4abk3m7q2x4ab";
const PATHS = ["web/composer/Composer.tsx", "web/composer/MentionMenu.tsx", "shared/match.ts", "docs/Écran.md", "README.md"];

/** A search route that answers only when the test says so. */
function gatedRoute() {
  const calls: { q: string; signal: AbortSignal; ok: (r: CorpusSearchReply) => void; fail: (e: unknown) => void }[] = [];
  const route: SearchRoute = (q, signal) => new Promise((ok, fail) => calls.push({ q, signal, ok, fail }));
  const reply = (q: string, paths: string[]): CorpusSearchReply => ({ v: "v1", total: PATHS.length, count: paths.length, rows: paths.map((path) => ({ path, nameRanges: [[0, Math.min(q.length, 1)]] })) });
  return { calls, route, reply };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the page's own copy", () => {
  test("rows for a query come at once, equal a scratch search, and need no request", () => {
    const corpus = prepareCorpus(PATHS, "v1");
    const engine = createFileEngine({ at: "page", corpus });
    expect(engine.at).toBe("page");
    for (const q of ["c", "co", "comp", "mention", "écran", "", "zz"]) {
      const rows = engine.rows(q)!;
      const want = searchCorpus(corpus, q);
      expect([q, rows.q, rows.count, rows.rows.map((r) => [r.path, r.nameStart, r.nameRanges])]).toEqual([q, q, want.count, want.rows.map((r) => [r.path, r.nameStart, r.nameRanges])]);
    }
    engine.ask("anything");
    let called = 0;
    engine.subscribe(() => called++)();
    expect(called).toBe(0);
  });
  test("the same query gives the same object, also when two queries alternate (the deferred render and the urgent one)", () => {
    const engine = createFileEngine({ at: "page", corpus: prepareCorpus(PATHS) });
    const a = engine.rows("co")!;
    const b = engine.rows("com")!;
    expect(engine.rows("co")).toBe(a);
    expect(engine.rows("com")).toBe(b);
    expect(engine.rows("co")).toBe(a);
    const c = engine.rows("comp")!;
    expect(engine.rows("comp")).toBe(c);
    expect(engine.rows("com")).toBe(b);
  });
  test("no rows before the copy is prepared", () => {
    const corpus = new Corpus(PATHS);
    const engine = createFileEngine({ at: "page", corpus });
    expect(engine.rows("comp")).toBeNull();
    corpus.prepare();
    expect(engine.rows("comp")!.count).toBe(new Searcher(corpus).search("comp").count);
  });
  test("the file rows give the folder part and the name's ranges", () => {
    const row = createFileEngine({ at: "page", corpus: prepareCorpus(PATHS) }).rows("comp")!.rows[0]!;
    expect(row.path.slice(0, row.nameStart)).toBe("web/composer/");
    expect(row.nameRanges).toEqual([[0, 4]]);
  });
});

describe("the server's search route", () => {
  test("one request in flight; an answer for an older query is dropped and the newest is asked next", async () => {
    const g = gatedRoute();
    const engine = createFileEngine({ at: "server", search: g.route });
    const seen: (FileRows | null)[] = [];
    engine.subscribe(() => seen.push(engine.rows("ignored")));
    expect(engine.at).toBe("server");
    expect(engine.rows("c")).toBeNull();
    engine.ask("c");
    engine.ask("co");
    engine.ask("com");
    expect(g.calls.map((c) => c.q)).toEqual(["c"]);
    g.calls[0]!.ok(g.reply("c", ["a/c.ts"]));
    await tick();
    expect(seen).toEqual([]); // "c" is no longer the newest query
    expect(g.calls.map((c) => c.q)).toEqual(["c", "com"]);
    g.calls[1]!.ok(g.reply("com", ["web/composer/Composer.tsx"]));
    await tick();
    expect(seen).toEqual([{ q: "com", count: 1, rows: [{ path: "web/composer/Composer.tsx", nameStart: 13, nameRanges: [[0, 1]] }] }]);
    expect(engine.rows("anything")).toBe(seen[0]!);
  });
  test("asking the query that the newest answer is for sends nothing", async () => {
    const g = gatedRoute();
    const engine = createFileEngine({ at: "server", search: g.route });
    engine.ask("x");
    g.calls[0]!.ok(g.reply("x", []));
    await tick();
    engine.ask("x");
    expect(g.calls.length).toBe(1);
    // Back to the answered query while another is in flight: the in-flight answer is dropped, and nothing more is sent.
    engine.ask("xy");
    engine.ask("x");
    g.calls[1]!.ok(g.reply("xy", ["xy.ts"]));
    await tick();
    expect(g.calls.length).toBe(2);
    expect(engine.rows("x")!.q).toBe("x");
  });
  test("a failed request gives no rows and the failed mark, so the list shows no 'No file matches' line", async () => {
    const g = gatedRoute();
    const engine = createFileEngine({ at: "server", search: g.route });
    let n = 0;
    engine.subscribe(() => n++);
    engine.ask("comp");
    g.calls[0]!.fail(new Error("503"));
    await tick();
    expect(n).toBe(1);
    expect(engine.rows("comp")).toEqual({ q: "comp", count: 0, rows: [], failed: true });
    const throwing = createFileEngine({
      at: "server",
      search: () => {
        throw new Error("no fetch");
      },
    });
    throwing.ask("a");
    await tick();
    expect(throwing.rows("a")).toEqual({ q: "a", count: 0, rows: [], failed: true });
  });
  test("close aborts the request in flight, and nothing lands after it", async () => {
    const g = gatedRoute();
    const engine = createFileEngine({ at: "server", search: g.route });
    let n = 0;
    engine.subscribe(() => n++);
    engine.ask("a");
    engine.close();
    expect(g.calls[0]!.signal.aborted).toBe(true);
    g.calls[0]!.ok(g.reply("a", ["a.ts"]));
    await tick();
    expect(n).toBe(0);
    expect(engine.rows("a")).toBeNull();
    engine.ask("b");
    expect(g.calls.length).toBe(1);
  });
  test("unsubscribe stops the calls", async () => {
    const g = gatedRoute();
    const engine = createFileEngine({ at: "server", search: g.route });
    let n = 0;
    const off = engine.subscribe(() => n++);
    off();
    engine.ask("a");
    g.calls[0]!.ok(g.reply("a", []));
    await tick();
    expect(n).toBe(0);
    expect(engine.rows("a")!.q).toBe("a");
  });
});

describe("routeSearch", () => {
  test("a GET of the chat's search path with the v, no body, no mutating header, and the signal", async () => {
    const asked: { url: string; init: RequestInit }[] = [];
    const reply: CorpusSearchReply = { v: "v2", total: 3, count: 1, rows: [{ path: "a/b.ts", nameRanges: [[0, 1]] }] };
    const fetcher = (async (url: string, init: RequestInit) => {
      asked.push({ url, init });
      return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const ctrl = new AbortController();
    expect(await routeSearch(C, "v1", fetcher)("web comp", ctrl.signal)).toEqual(reply);
    expect(asked[0]!.url).toBe(`/api/chats/${C}/corpus/search?q=web%20comp&v=v1`);
    expect(asked[0]!.init.method).toBe("GET");
    expect(asked[0]!.init.body).toBeUndefined();
    expect(asked[0]!.init.headers).toEqual({ accept: "application/json" });
    expect(asked[0]!.init.signal).toBe(ctrl.signal);
  });
  test("a refused answer throws, so the engine marks the rows failed", async () => {
    const fetcher = (async () => new Response("{}", { status: 400 })) as unknown as typeof fetch;
    await expect(routeSearch(C, null, fetcher)("a", new AbortController().signal)).rejects.toThrow("search: 400");
  });
});
