// The chat folder's file list on the page (DESIGN.md 9.3 "Where the filter runs"; BUILD-CHECKLIST C3, L5): kept per
// chat outside the store, read with the limit of the page's size class and the `v` it holds, one read at a time, a
// list prepared in steps and published once ready, the page's copy kept on `same`, the server's route over the
// limit, a stale answer dropped, a failed read with nothing held marked failed (no rows and no line).
import { afterEach, describe, expect, test } from "bun:test";
import { CORPUS_LIMITS, type CorpusReply, type CorpusSearchReply } from "../../shared/corpus";
import { CORPUS_KEPT, PREPARE_STEP, corpusOf, openCorpus, resetCorpora, subscribeCorpus } from "../../web/search/corpus";
import { createFileEngine } from "../../web/search/engine";

const CHAT = "demoolxxxxxxxxxxxxxx";

interface Asked {
  url: URL;
  init?: RequestInit;
}

/** A fetcher that answers each read with the next reply (or throws, or waits for `hold`). */
function server(replies: (CorpusReply | CorpusSearchReply | number | "throw")[]) {
  const asked: Asked[] = [];
  let release: (() => void) | null = null;
  let held = false;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    asked.push({ url: new URL(String(input), "http://127.0.0.1"), init });
    if (held) await new Promise<void>((r) => (release = r));
    const next = replies.shift();
    if (next === "throw" || next === undefined) throw new TypeError("network");
    if (typeof next === "number") return new Response("{}", { status: next });
    return new Response(JSON.stringify(next), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return {
    fetcher,
    asked,
    hold() {
      held = true;
    },
    go() {
      held = false;
      release?.();
    },
  };
}

const list = (v: string, paths: string[]): CorpusReply => ({ v, source: "git", complete: true, total: paths.length, chars: paths.join("").length, paths });

afterEach(() => resetCorpora());

describe("the read (L5)", () => {
  test("a laptop asks for 100,000 paths, touch for 20,000 and 1,400,000 characters; a GET with no body", async () => {
    const s = server([list("v1", ["a.ts"]), list("v1", ["a.ts"])]);
    await openCorpus(CHAT, false, { fetcher: s.fetcher });
    resetCorpora();
    await openCorpus(CHAT, true, { fetcher: s.fetcher });
    const [laptop, touch] = s.asked;
    expect(laptop!.url.pathname).toBe(`/api/chats/${CHAT}/corpus`);
    expect(Object.fromEntries(laptop!.url.searchParams)).toEqual({ max: String(CORPUS_LIMITS.laptopPaths) });
    expect(Object.fromEntries(touch!.url.searchParams)).toEqual({ max: String(CORPUS_LIMITS.touchPaths), chars: String(CORPUS_LIMITS.touchChars) });
    expect(laptop!.init).toMatchObject({ method: "GET" });
    expect(laptop!.init?.body).toBeUndefined();
  });

  test("a list is prepared in steps and published once ready; the next open sends its v, and same keeps the copy", async () => {
    const paths = Array.from({ length: PREPARE_STEP * 2 + 5 }, (_, i) => `src/f${i}.ts`);
    const s = server([list("v7", paths), { v: "v7", same: true }]);
    const steps: (() => void)[] = [];
    const seen: string[] = [];
    const off = subscribeCorpus(() => seen.push(corpusOf(CHAT).state));
    const opened = openCorpus(CHAT, false, { fetcher: s.fetcher, later: (run) => steps.push(run) });
    // Not ready before every step ran: no source yet.
    while (steps.length === 0) await Bun.sleep(1);
    expect(corpusOf(CHAT)).toMatchObject({ state: "loading", source: null });
    while (steps.length) steps.shift()!();
    await opened;
    const snap = corpusOf(CHAT);
    expect(snap.state).toBe("ready");
    expect(snap.source?.at).toBe("page");
    const corpus = snap.source?.at === "page" ? snap.source.corpus : null;
    expect([corpus?.ready, corpus?.size, corpus?.v]).toEqual([true, paths.length, "v7"]);
    expect(createFileEngine(snap.source!).rows("f1.ts")?.rows[0]?.path).toBe("src/f1.ts");
    await openCorpus(CHAT, false, { fetcher: s.fetcher });
    expect(s.asked[1]!.url.searchParams.get("v")).toBe("v7");
    expect(corpusOf(CHAT)).toBe(snap); // the same object: the page's copy stands
    expect(seen).toEqual(["loading", "ready"]);
    off();
  });

  test("over the limit the server's route ranks each query, with the build's v", async () => {
    const s = server([{ v: "big1", source: "git", complete: false, total: 100_000, chars: 9_000_000, paths: null }, { v: "big1", total: 100_000, count: 1, rows: [{ path: "a/b.ts", nameRanges: [[0, 1]] }] }]);
    await openCorpus(CHAT, true, { fetcher: s.fetcher });
    const snap = corpusOf(CHAT);
    expect(snap.source?.at).toBe("server");
    const engine = createFileEngine(snap.source!);
    let landed = 0;
    engine.subscribe(() => landed++);
    engine.ask("b");
    while (!landed) await Bun.sleep(1);
    expect(engine.rows("b")).toEqual({ q: "b", count: 1, rows: [{ path: "a/b.ts", nameStart: 2, nameRanges: [[0, 1]] }] });
    const search = s.asked[1]!.url;
    expect(search.pathname).toBe(`/api/chats/${CHAT}/corpus/search`);
    expect(Object.fromEntries(search.searchParams)).toEqual({ q: "b", v: "big1" });
    engine.close();
  });

  test("one read at a time; an answer that a fresh start overtook is dropped", async () => {
    const s = server([list("v1", ["old.ts"]), list("v2", ["new.ts"])]);
    s.hold();
    const first = openCorpus(CHAT, false, { fetcher: s.fetcher });
    const again = openCorpus(CHAT, false, { fetcher: s.fetcher });
    await again;
    expect(s.asked).toHaveLength(1); // the second open sent nothing
    resetCorpora(); // a fresh start while the read is in flight
    s.go();
    await first;
    expect(corpusOf(CHAT)).toMatchObject({ state: "none", source: null });
  });

  test("a failed read with nothing held: failed (no rows, no line); with a copy held: the copy stays", async () => {
    const s = server([404, list("v1", ["a.ts"]), "throw"]);
    await openCorpus(CHAT, false, { fetcher: s.fetcher });
    expect(corpusOf(CHAT)).toMatchObject({ state: "failed", source: null });
    await openCorpus(CHAT, false, { fetcher: s.fetcher });
    const held = corpusOf(CHAT).source;
    expect(held?.at).toBe("page");
    await openCorpus(CHAT, false, { fetcher: s.fetcher });
    expect(corpusOf(CHAT)).toMatchObject({ state: "ready", source: held });
  });

  test(`at most ${CORPUS_KEPT} chats' lists are kept; the least recently opened goes first`, async () => {
    const ids = Array.from({ length: CORPUS_KEPT + 1 }, (_, i) => `chat${i}${"x".repeat(15)}`);
    let t = 0;
    for (const id of ids) await openCorpus(id, false, { fetcher: server([list("v", [`${id}.ts`])]).fetcher, now: () => ++t });
    expect(corpusOf(ids[0]!).state).toBe("none");
    for (const id of ids.slice(1)) expect(corpusOf(id).state).toBe("ready");
  });
});
