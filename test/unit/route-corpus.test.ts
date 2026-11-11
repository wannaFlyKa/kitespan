// The corpus routes' contract (DESIGN.md 9.3 "The routes" and "Where the filter runs"; the build checklist's B4 and
// L5): the page's limits, the paths it asks for, and the strict readers of their query strings.
import { describe, expect, test } from "bun:test";
import { CORPUS_LIMITS, CORPUS_V, corpusPath, corpusSearchPath, fitsPage, pageLimit, readCorpusQuery, readSearchQuery } from "../../shared/corpus";

const C = "k3m7q2x4abk3m7q2x4ab";
const qs = (s: string) => new URLSearchParams(s);
const queryOf = (path: string) => new URL(path, "http://127.0.0.1:7941").searchParams;

describe("the limits (L5)", () => {
  test("the design's numbers", () => {
    expect(CORPUS_LIMITS).toEqual({ maxPaths: 100_000, laptopPaths: 100_000, touchPaths: 20_000, touchChars: 1_400_000, jsonBytes: 16 * 1024 * 1024, queryMax: 1_024, yieldEvery: 20_000 });
  });
  test("the page sends its size class's limit: chars on touch only", () => {
    expect(pageLimit(false)).toEqual({ max: 100_000, chars: null });
    expect(pageLimit(true)).toEqual({ max: 20_000, chars: 1_400_000 });
  });
  test("a build goes to the page with its paths only within every limit", () => {
    const laptop = pageLimit(false);
    const touch = pageLimit(true);
    const build = (total: number, chars: number, jsonBytes = chars + 4 * total) => ({ total, chars, jsonBytes });
    expect(fitsPage(build(100_000, 5_000_000), laptop)).toBe(true);
    expect(fitsPage(build(100_001, 5_000_000), laptop)).toBe(false);
    expect(fitsPage(build(50_000, 20_000_000, CORPUS_LIMITS.jsonBytes + 1), laptop)).toBe(false); // the JSON cap, whatever the page asked
    expect(fitsPage(build(50_000, 0, CORPUS_LIMITS.jsonBytes), laptop)).toBe(true);
    expect(fitsPage(build(20_000, 1_400_000), touch)).toBe(true);
    expect(fitsPage(build(20_001, 100_000), touch)).toBe(false);
    expect(fitsPage(build(10_000, 1_400_001), touch)).toBe(false); // the characters, since the cost follows them
    expect(fitsPage(build(0, 0), { max: 0, chars: 0 })).toBe(true);
  });
});

describe("the paths the page asks for", () => {
  test("the corpus read: the chat id, max, chars on touch, and the v it holds", () => {
    expect(corpusPath(C, pageLimit(false))).toBe(`/api/chats/${C}/corpus?max=100000`);
    expect(corpusPath(C, pageLimit(true), "b1-abc_9")).toBe(`/api/chats/${C}/corpus?max=20000&chars=1400000&v=b1-abc_9`);
  });
  test("the search read: q with a space as %20, a plus and a percent kept", () => {
    expect(corpusSearchPath(C, "web comp")).toBe(`/api/chats/${C}/corpus/search?q=web%20comp`);
    expect(queryOf(corpusSearchPath(C, "a+b 100% c/d")).get("q")).toBe("a+b 100% c/d");
    expect(corpusSearchPath(C, "x", "v2")).toBe(`/api/chats/${C}/corpus/search?q=x&v=v2`);
    expect(queryOf(corpusSearchPath(C, "日本 é \u{1f600}")).get("q")).toBe("日本 é \u{1f600}");
  });
  test("each path reads back to what the page sent", () => {
    for (const touch of [false, true])
      for (const v of [null, "v1"]) expect(readCorpusQuery(queryOf(corpusPath(C, pageLimit(touch), v)))).toEqual({ limit: pageLimit(touch), v });
    for (const q of ["", "a", "web comp", "src/te", "x".repeat(1024)]) expect(readSearchQuery(queryOf(corpusSearchPath(C, q, "v9")))).toEqual({ q, v: "v9" });
  });
});

describe("the corpus read's query (400 when null)", () => {
  test("max is required, a whole number from 0 to 100,000", () => {
    expect(readCorpusQuery(qs("max=0"))).toEqual({ limit: { max: 0, chars: null }, v: null });
    expect(readCorpusQuery(qs("max=100000"))).toEqual({ limit: { max: 100_000, chars: null }, v: null });
    for (const bad of ["", "max=", "max=100001", "max=-1", "max=1.5", "max=1e3", "max=0x10", "max= 1", "max=1&max=2", "chars=5"]) expect([bad, readCorpusQuery(qs(bad))]).toEqual([bad, null]);
    expect(readCorpusQuery(qs("max=7&max=7"))).toEqual({ limit: { max: 7, chars: null }, v: null });
  });
  test("chars is optional, a whole number up to 16 MiB", () => {
    expect(readCorpusQuery(qs("max=1&chars=1400000"))?.limit).toEqual({ max: 1, chars: 1_400_000 });
    expect(readCorpusQuery(qs(`max=1&chars=${16 * 1024 * 1024}`))?.limit.chars).toBe(16 * 1024 * 1024);
    for (const bad of [`max=1&chars=${16 * 1024 * 1024 + 1}`, "max=1&chars=x", "max=1&chars=", "max=1&chars=1&chars=2"]) expect([bad, readCorpusQuery(qs(bad))]).toEqual([bad, null]);
  });
  test("v is optional, an id of 1 to 64 letters, digits, - and _; unknown keys are ignored", () => {
    expect(readCorpusQuery(qs("max=1&v=abc-DEF_123"))?.v).toBe("abc-DEF_123");
    expect(readCorpusQuery(qs(`max=1&v=${"v".repeat(64)}`))?.v).toBe("v".repeat(64));
    for (const bad of ["max=1&v=", `max=1&v=${"v".repeat(65)}`, "max=1&v=a.b", "max=1&v=a%2Fb", "max=1&v=a&v=b"]) expect([bad, readCorpusQuery(qs(bad))]).toEqual([bad, null]);
    expect(readCorpusQuery(qs("max=1&path=/etc&evil=1"))).toEqual({ limit: { max: 1, chars: null }, v: null });
    expect(CORPUS_V.test("x")).toBe(true);
  });
});

describe("the search read's query (400 when null)", () => {
  test("q holds at most 1,024 characters and no control character; absent is empty", () => {
    expect(readSearchQuery(qs(""))).toEqual({ q: "", v: null });
    expect(readSearchQuery(qs(`q=${"a".repeat(1024)}`))?.q.length).toBe(1024);
    expect(readSearchQuery(qs(`q=${"a".repeat(1025)}`))).toBeNull();
    for (const c of ["\u0000", "\n", "\t", "\u007f", "\u0085", "\u202e", "\u2066", "\u2028"]) expect(readSearchQuery(new URLSearchParams({ q: `a${c}b` }))).toBeNull();
    expect(readSearchQuery(qs("q=a&q=b"))).toBeNull();
    expect(readSearchQuery(qs("q=a&q=a"))).toEqual({ q: "a", v: null });
    expect(readSearchQuery(new URLSearchParams({ q: "café 日本 \u{1f600}" }))?.q).toBe("café 日本 \u{1f600}");
  });
  test("v as on the corpus read", () => {
    expect(readSearchQuery(qs("q=a&v=v1"))).toEqual({ q: "a", v: "v1" });
    expect(readSearchQuery(qs("q=a&v=../x"))).toBeNull();
  });
});
