// The corpus cache (DESIGN.md 9.3; build checklist B3, B5), with a fake builder and a fake clock: one build per root
// at a time, one corpus per real path, the 10 s refresh that waits at most 250 ms, the same `v` for the same paths,
// the LRU limits, the idle drop, the one log line per build with no path in it, the scorer's warm-up once per
// prepared build, and the server-side search (the top 120 with a true count, an aborted request).

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { CORPUS_V } from "../../shared/corpus";
import * as match from "../../shared/match";
import type { Corpus } from "../../shared/match";
import type { CorpusListing } from "../../server/search/build";
import { CORPUS_CACHE, CorpusBuild, CorpusCache, newCorpusV } from "../../server/search/cache";
import type { LogEvent, LogFields } from "../../server/log";

const CHAT = "k3m7q2x4abk3m7q2x4ab";

function listing(paths: string[], over: Partial<CorpusListing> = {}): CorpusListing {
  return { source: "git", paths, complete: true, capped: false, timeout: false, code: 0, ms: 3, spawnFailed: false, ...over };
}

/** A fake builder: each root's next listing, how often it ran, and an optional hold on each build. */
function fakeBuilder() {
  const next = new Map<string, () => CorpusListing>();
  const calls: string[] = [];
  let hold: Promise<void> | null = null;
  const list = async (root: string) => {
    calls.push(root);
    if (hold) await hold;
    const f = next.get(root);
    if (!f) throw new Error(`no listing for ${root}`);
    return f();
  };
  return {
    list,
    calls,
    set: (root: string, paths: string[] | (() => CorpusListing)) => next.set(root, typeof paths === "function" ? paths : () => listing(paths)),
    hold(p: Promise<void> | null) {
      hold = p;
    },
  };
}

function setup(over: Partial<ConstructorParameters<typeof CorpusCache>[0]> = {}) {
  const b = fakeBuilder();
  let now = 1_000_000;
  const lines: { ev: LogEvent; f: LogFields }[] = [];
  const cache = new CorpusCache({
    list: b.list,
    // Two names of one folder resolve to one root; a folder that is gone resolves to nothing.
    realRoot: async (cwd) => (cwd === "/gone" ? null : cwd.replace(/^\/alias/, "/real")),
    log: { log: (ev, f = {}) => lines.push({ ev, f }) },
    now: () => now,
    timer: false,
    ...over,
  });
  return { b, cache, lines, tick: (ms: number) => (now += ms) };
}

describe("builds", () => {
  test("a build's id fits the route's pattern", () => {
    for (let i = 0; i < 50; i++) expect(newCorpusV()).toMatch(CORPUS_V);
    const b = new CorpusBuild(listing(["a.ts", "web/é.md"]), 0);
    expect([b.total, b.chars, b.source, b.complete]).toEqual([2, 12, "git", true]);
  });

  test("the first read builds once, however many ask at the same time", async () => {
    const { b, cache } = setup();
    b.set("/real/app", ["a.ts", "b.ts"]);
    const [x, y, z] = await Promise.all([cache.read("/real/app", CHAT), cache.read("/real/app", CHAT), cache.read("/alias/app", null)]);
    expect(b.calls).toEqual(["/real/app"]);
    expect(x).toBe(y);
    expect(y).toBe(z);
    expect(x.paths).toEqual(["a.ts", "b.ts"]);
    expect(cache.roots()).toEqual(["/real/app"]);
  });

  test("a read within 10 s answers the corpus it has; a later one rebuilds, and the same paths keep the same v", async () => {
    const { b, cache, tick } = setup();
    b.set("/real/app", ["a.ts"]);
    const first = await cache.read("/real/app", CHAT);
    tick(CORPUS_CACHE.staleMs);
    expect(await cache.read("/real/app", CHAT)).toBe(first);
    expect(b.calls.length).toBe(1);
    tick(1);
    const again = await cache.read("/real/app", CHAT);
    expect(b.calls.length).toBe(2);
    expect(again).toBe(first);
    // It counts as checked now: the next read within 10 s does not rebuild.
    tick(5_000);
    await cache.read("/real/app", CHAT);
    expect(b.calls.length).toBe(2);
    // A change gives a new build with a new v.
    b.set("/real/app", ["a.ts", "new.ts"]);
    tick(CORPUS_CACHE.staleMs + 1);
    const changed = await cache.read("/real/app", CHAT);
    expect(changed).not.toBe(first);
    expect(changed.v).not.toBe(first.v);
    expect(changed.paths).toEqual(["a.ts", "new.ts"]);
  });

  test("a slow rebuild: the read waits at most 250 ms, answers the old corpus, and the rebuild lands for the next read", async () => {
    const { b, cache, tick } = setup();
    b.set("/real/app", ["a.ts"]);
    const first = await cache.read("/real/app", CHAT);
    b.set("/real/app", ["a.ts", "b.ts"]);
    let release!: () => void;
    b.hold(new Promise<void>((r) => (release = r)));
    tick(CORPUS_CACHE.staleMs + 1);
    const t0 = performance.now();
    const got = await cache.read("/real/app", CHAT);
    const waited = performance.now() - t0;
    expect(got).toBe(first);
    expect(waited).toBeGreaterThanOrEqual(CORPUS_CACHE.waitMs - 20);
    expect(waited).toBeLessThan(CORPUS_CACHE.waitMs + 400);
    // A read meanwhile shares the running rebuild.
    void cache.read("/real/app", CHAT);
    expect(b.calls.length).toBe(2);
    b.hold(null);
    release();
    await Bun.sleep(5);
    const next = await cache.read("/real/app", CHAT);
    expect(next.paths).toEqual(["a.ts", "b.ts"]);
    expect(b.calls.length).toBe(2);
  });

  test("a folder that cannot be resolved: no paths, source none, and nothing kept", async () => {
    const { b, cache } = setup();
    const got = await cache.read("/gone", CHAT);
    expect([got.source, got.total, got.paths]).toEqual(["none", 0, []]);
    expect(b.calls).toEqual([]);
    expect(cache.roots()).toEqual([]);
  });
});

describe("the list body", () => {
  const ODD = ['quote".ts', "back\\slash.ts", "été/日本語.md", "rocket 🚀.md", "with space.txt"];
  /** About the gate's size: 100,000 paths, some 4 MB of JSON. */
  const LARGE = Array.from({ length: 100_000 }, (_, i) => `packages/pkg-${i % 400}/src/module-${i}/file-${i}.ts`);

  test("the JSON is the list reply's, byte for byte, in pieces of 20,000 paths; the gzip body holds it", async () => {
    for (const paths of [[], ODD, Array.from({ length: 45_001 }, (_, i) => `${ODD[i % ODD.length]}-${i}`)]) {
      const b = new CorpusBuild(listing(paths), 0);
      const json = JSON.stringify(b.listReply());
      const body = await b.listBody();
      expect(body.jsonBytes).toBe(Buffer.byteLength(json));
      expect(new TextDecoder().decode(Bun.gunzipSync(body.gzip!))).toBe(json);
      expect(new TextDecoder().decode(await b.listJson())).toBe(json);
    }
  });

  test("one body per build: every ask shares the one being made", async () => {
    const b = new CorpusBuild(listing(ODD), 0);
    const first = b.listBody();
    expect(b.listBody()).toBe(first);
    expect(await b.listBody()).toBe(await first);
  });

  test("the event loop turns while the body is made: the JSON in steps, and the gzip off the loop", async () => {
    const b = new CorpusBuild(listing(LARGE), 0);
    let turns = 0;
    let on = true;
    const spin = () => {
      turns++;
      if (on) setImmediate(spin);
    };
    setImmediate(spin);
    const body = await b.listBody();
    on = false;
    expect(body.gzip).not.toBeNull();
    // The JSON alone yields once per 20,000 paths (4 times here); a gzip on the loop would add no turn at all.
    expect(turns).toBeGreaterThan(20);
    turns = 0;
    on = true;
    setImmediate(spin);
    await b.listJson();
    on = false;
    expect(turns).toBeGreaterThanOrEqual(4);
  });
});

describe("what is kept", () => {
  test("LRU past 4 roots: the root read longest ago goes", async () => {
    const { b, cache, tick } = setup();
    for (const r of ["a", "b", "c", "d", "e"]) b.set(`/real/${r}`, [`${r}.ts`]);
    for (const r of ["a", "b", "c", "d"]) {
      await cache.read(`/real/${r}`, CHAT);
      tick(1);
    }
    // Reading a again makes b the oldest.
    await cache.read("/real/a", CHAT);
    await cache.read("/real/e", CHAT);
    expect(cache.roots()).toEqual(["/real/c", "/real/d", "/real/a", "/real/e"]);
  });

  test("LRU past 300,000 paths", async () => {
    const { b, cache } = setup();
    const many = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}/${i}.ts`);
    b.set("/real/one", many(100_000, "one"));
    b.set("/real/two", many(100_000, "two"));
    b.set("/real/three", many(90_000, "three"));
    b.set("/real/four", many(20_000, "four"));
    for (const r of ["one", "two", "three"]) await cache.read(`/real/${r}`, CHAT);
    expect(cache.roots().length).toBe(3);
    await cache.read("/real/four", CHAT);
    expect(cache.roots()).toEqual(["/real/two", "/real/three", "/real/four"]);
  });

  test("a root with no read for 10 minutes is dropped", async () => {
    const { b, cache, tick } = setup();
    b.set("/real/a", ["a.ts"]);
    b.set("/real/b", ["b.ts"]);
    await cache.read("/real/a", CHAT);
    tick(CORPUS_CACHE.idleMs - 1_000);
    await cache.read("/real/b", CHAT);
    tick(2_000);
    cache.sweep();
    expect(cache.roots()).toEqual(["/real/b"]);
    tick(CORPUS_CACHE.idleMs);
    cache.sweep();
    expect(cache.roots()).toEqual([]);
  });

  test("the sweep timer never keeps the process alive, and close stops it", async () => {
    const b = fakeBuilder();
    b.set("/real/a", ["a.ts"]);
    const cache = new CorpusCache({ list: b.list, realRoot: async (c) => c });
    await cache.read("/real/a", CHAT);
    cache.close();
    expect(cache.roots()).toEqual([]);
  });
});

describe("the log", () => {
  test("one corpus line per build: chat, code, ms, ok, timeout, capped, and never a path", async () => {
    const { b, cache, tick, lines } = setup();
    b.set("/real/secret-project", () => listing(["private/plan.md"], { code: 0, ms: 12.4, capped: true, complete: false }));
    await cache.read("/real/secret-project", CHAT);
    await cache.read("/real/secret-project", CHAT);
    await cache.search("/real/secret-project", CHAT, "plan");
    expect(lines).toEqual([{ ev: "corpus", f: { chat: CHAT, code: 0, ms: 12.4, ok: true, timeout: false, capped: true } }]);
    b.set("/real/walked", () => listing([], { source: "none", code: null, spawnFailed: true, complete: false }));
    tick(1);
    await cache.read("/real/walked", null);
    expect(lines.slice(1)).toEqual([
      { ev: "corpus", f: { chat: null, code: null, ms: 3, ok: false, timeout: false, capped: false } },
      { ev: "error", f: { chat: null, err: "corpus" } },
    ]);
    expect(JSON.stringify(lines)).not.toMatch(/secret|private|plan|walked|real/);
  });
});

describe("the scorer's warm-up (shared/match.ts warmScorer)", () => {
  /** The shared warmScorer, spied on: each call's corpus and whether it was prepared then; restored after each test. */
  const calls: { corpus: Corpus; ready: boolean }[] = [];
  const real = match.warmScorer;
  let spy: ReturnType<typeof spyOn> | null = null;
  beforeEach(() => {
    calls.length = 0;
    spy = spyOn(match, "warmScorer").mockImplementation((corpus: Corpus, rows?: number) => {
      calls.push({ corpus, ready: corpus.ready });
      return real(corpus, rows);
    });
  });
  afterEach(() => spy?.mockRestore());

  test("once per build, on the prepared corpus that the searches then share; a new build is warmed again", async () => {
    const { b, cache, tick } = setup();
    b.set("/real/app", Array.from({ length: 30_000 }, (_, i) => `src/comp${i % 300}/Composer${i}.tsx`));
    const [x, y] = await Promise.all([cache.search("/real/app", CHAT, "comp"), cache.search("/real/app", CHAT, "a")]);
    await cache.search("/real/app", CHAT, "compo");
    expect([x!.count, y!.count]).toEqual([30_000, 0]);
    const build = await cache.read("/real/app", CHAT);
    expect(calls.length).toBe(1);
    expect(calls[0]!.ready).toBe(true);
    expect(calls[0]!.corpus).toBe(await build.corpus());
    b.set("/real/app", ["a.ts", "new.ts"]);
    tick(CORPUS_CACHE.staleMs + 1);
    const changed = await cache.read("/real/app", CHAT);
    expect(changed).not.toBe(build);
    expect(calls.length).toBe(1);
    expect((await cache.search("/real/app", CHAT, "new"))!.count).toBe(1);
    expect(calls.length).toBe(2);
    expect(calls[1]!.corpus).toBe(await changed.corpus());
  });

  test("a build whose corpus is never searched is never prepared or warmed (the list route sends the paths only)", async () => {
    const { b, cache } = setup();
    b.set("/real/app", ["a.ts"]);
    await (await cache.read("/real/app", CHAT)).listBody();
    expect(calls.length).toBe(0);
  });
});

describe("the search on the server", () => {
  test("the best 120 rows from the shared matcher, with the true count and the build's v and total", async () => {
    const { b, cache } = setup();
    const paths = [...Array.from({ length: 300 }, (_, i) => `src/comp${i}/Composer${i}.tsx`), "README.md", "docs/notes.md"];
    b.set("/real/app", paths);
    const r = (await cache.search("/real/app", CHAT, "comp"))!;
    const build = await cache.read("/real/app", CHAT);
    expect([r.v, r.total, r.count, r.rows.length]).toEqual([build.v, 302, 300, 120]);
    expect(r.rows[0]).toEqual({ path: "src/comp0/Composer0.tsx", nameRanges: [[0, 4]] });
    expect(Object.keys(r.rows[0]!)).toEqual(["path", "nameRanges"]);
    const none = (await cache.search("/real/app", CHAT, "zzzz"))!;
    expect([none.count, none.rows]).toEqual([0, []]);
  });

  test("the search never rebuilds a stale corpus", async () => {
    const { b, cache, tick } = setup();
    b.set("/real/app", ["a.ts"]);
    await cache.search("/real/app", CHAT, "a");
    tick(CORPUS_CACHE.staleMs * 3);
    await cache.search("/real/app", CHAT, "a");
    expect(b.calls.length).toBe(1);
  });

  test("an aborted request gets no answer and stops the scan", async () => {
    const { b, cache } = setup();
    b.set("/real/app", Array.from({ length: 50_000 }, (_, i) => `f${i}/a.ts`));
    const before = new AbortController();
    before.abort();
    expect(await cache.search("/real/app", CHAT, "a", before.signal)).toBeNull();
    const during = new AbortController();
    const p = cache.search("/real/app", CHAT, "a", during.signal);
    setImmediate(() => during.abort());
    expect(await p).toBeNull();
    expect((await cache.search("/real/app", CHAT, "a"))!.count).toBe(50_000);
  });
});
