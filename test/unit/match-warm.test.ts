// Warming the scorer (DESIGN.md 9.3 "Speed"): the blank query that a surface shows when it opens scores nothing, so
// without a warm-up the first key the user types is the scorer's first run, and the slowest key. warmScorer scores a
// few thousand rows once when a list is prepared; the page runs it as the last step before it publishes the list.
import { afterEach, describe, expect, test } from "bun:test";
import type { CorpusReply } from "../../shared/corpus";
import { Corpus, Searcher, WARM_ROWS, prepareCorpus, searchCorpus, warmScorer } from "../../shared/match";
import { corpusOf, openCorpus, resetCorpora } from "../../web/search/corpus";

const CHAT = "k3m7q2x4abk3m7q2x4ab";
const WORDS = ["index", "main", "App", "config", "server", "Composer", "handler", "schema", "test", "upload"];

function paths(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `pkg${i % 400}/src/${WORDS[i % WORDS.length]}/${WORDS[(i * 7) % WORDS.length]}${i}.ts`);
}

/** What a corpus holds and answers, to compare before and after a warm-up. */
function stateOf(c: Corpus) {
  return { folded: [...c.folded], masks: [...c.masks], nameAt: [...c.nameAt], ready: c.ready, answers: ["a", "comp", "src test", ""].map((q) => searchCorpus(c, q)) };
}

describe("warmScorer", () => {
  test("it scores the first rows of a prepared corpus, from scratch and narrowed, and no more than a bound", () => {
    const c = prepareCorpus(paths(100_000), "v1");
    const scored = warmScorer(c);
    // The commonest letter is in almost every path, so most of the first rows are scored; the narrowed query scores
    // only the rows the first one matched.
    expect(scored).toBeGreaterThan(WARM_ROWS);
    expect(scored).toBeLessThanOrEqual(2 * WARM_ROWS);
    expect(warmScorer(c, 10)).toBeLessThanOrEqual(20);
  });

  test("it changes nothing in the corpus or in a searcher's answers", () => {
    const c = prepareCorpus(paths(30_000), "v1");
    const before = stateOf(c);
    const s = new Searcher(c);
    const typed = ["c", "co", "com"].map((q) => s.search(q));
    warmScorer(c);
    expect(stateOf(c)).toEqual(before);
    expect(["comp", "com", "co"].map((q) => s.search(q))).toEqual(["comp", "com", "co"].map((q) => searchCorpus(c, q)));
    expect(typed).toEqual(["c", "co", "com"].map((q) => searchCorpus(c, q)));
  });

  test("a corpus that is not prepared, is empty, or has no letter gives nothing to score", () => {
    const part = new Corpus(paths(10));
    part.prepare(5);
    expect(warmScorer(part)).toBe(0);
    expect(warmScorer(new Corpus(paths(10)))).toBe(0);
    expect(warmScorer(prepareCorpus([]))).toBe(0);
    expect(warmScorer(prepareCorpus(["会議/メモ", "1/2", "🚀/上传"]))).toBe(0);
  });

  test("a corpus smaller than the bound is scored whole", () => {
    const c = prepareCorpus(["web/composer/Composer.tsx", "shared/match.ts", "README.md"]);
    const scored = warmScorer(c);
    expect(scored).toBeGreaterThan(0);
    expect(scored).toBeLessThanOrEqual(6);
  });
});

describe("the page warms each list it prepares (web/search/corpus.ts)", () => {
  afterEach(() => resetCorpora());

  const listReply = (v: string, p: string[]): CorpusReply => ({ v, source: "git", complete: true, total: p.length, chars: p.join("").length, paths: p });
  const fetcherOf = (replies: CorpusReply[]) =>
    (async () => new Response(JSON.stringify(replies.shift()), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

  test("once, after the last step of prepare and before the list is published; not again when the copy stands", async () => {
    const list = paths(60_000);
    const calls: { corpus: Corpus; ready: boolean; state: string }[] = [];
    const warm = (corpus: Corpus) => {
      calls.push({ corpus, ready: corpus.ready, state: corpusOf(CHAT).state });
      return 0;
    };
    const fetcher = fetcherOf([listReply("v1", list), { v: "v1", same: true }]);
    await openCorpus(CHAT, false, { fetcher, warm });
    const snap = corpusOf(CHAT);
    expect(snap.state).toBe("ready");
    expect(calls.length).toBe(1);
    expect(calls[0]!.ready).toBe(true);
    expect(calls[0]!.state).toBe("loading");
    expect(snap.source?.at === "page" && snap.source.corpus).toBe(calls[0]!.corpus);
    await openCorpus(CHAT, false, { fetcher, warm });
    expect(corpusOf(CHAT)).toBe(snap);
    expect(calls.length).toBe(1);
  });

  test("not for a list over the limit (the server's route ranks it)", async () => {
    let warmed = 0;
    const fetcher = fetcherOf([{ v: "big1", source: "git", complete: false, total: 100_000, chars: 9_000_000, paths: null }]);
    await openCorpus(CHAT, true, { fetcher, warm: () => warmed++ });
    expect(corpusOf(CHAT).source?.at).toBe("server");
    expect(warmed).toBe(0);
  });

  test("by default with warmScorer: the published list is prepared and answers at once", async () => {
    await openCorpus(CHAT, false, { fetcher: fetcherOf([listReply("v2", paths(3_000))]) });
    const snap = corpusOf(CHAT);
    expect(snap.source?.at).toBe("page");
    const corpus = snap.source?.at === "page" ? snap.source.corpus : null;
    expect(corpus?.ready).toBe(true);
    expect(searchCorpus(corpus!, "comp").count).toBeGreaterThan(0);
  });
});
