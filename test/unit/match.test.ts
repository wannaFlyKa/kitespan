// kitespan's own matcher (D55, DESIGN.md 9.3 "The engine"; build checklist A1 to A7): the scores, the fold, one row
// matcher for every kind, the name ranges, the prepared corpus, the best 120 with a true count, and narrowing.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  Corpus,
  Scan,
  Searcher,
  TOP_ROWS,
  fold,
  letterMask,
  matchRow,
  nameStart,
  parseQuery,
  prepareCorpus,
  rankList,
  searchCorpus,
  type CorpusResult,
} from "../../shared/match";

const ROOT = join(import.meta.dir, "..", "..");

/** A file row as the corpus matches it: its name, then its path. */
const file = (q: string, path: string) => matchRow(q, path.slice(nameStart(path)), [path]);
/** One string as the whole candidate. */
const text = (q: string, s: string) => matchRow(q, s);

/** A fixed LCG, so every run builds the same paths. */
function lcg(seed: number) {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 0x1_0000_0000;
  };
}

const WORDS = ["index", "main", "App", "config", "server", "client", "utils", "helper", "model", "view", "Composer", "service", "handler", "route", "schema", "test", "spec", "mock", "fixture", "data", "Provider", "context", "hooks", "styles", "theme", "search", "fuzzy", "match", "upload", "draft"];
const EXTS = ["ts", "tsx", "js", "json", "md", "css", "html", "txt", "yml", "lock"];
const DIRS = ["src", "web", "server", "shared", "test", "lib", "docs", "scripts"];

/** Repository-relative paths, as git ls-files gives them. */
function repoPaths(n: number, seed = 0x2468ace): string[] {
  const rnd = lcg(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const name = `${pick(WORDS)}${rnd() < 0.5 ? "-" : "."}${pick(WORDS)}${(i % 97).toString(36)}.${pick(EXTS)}`;
    out.push(`${DIRS[i % DIRS.length]}/${WORDS[(i >> 3) % WORDS.length]!.toLowerCase()}/m${i % 211}/${name}`);
  }
  return out;
}

/** Every path under one shared folder whose name holds an a, so `a` matches every row (the bench's second shape). */
function prefixPaths(n: number, seed = 0x5eed): string[] {
  const rnd = lcg(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
  return Array.from({ length: n }, (_, i) => `vault/proj/${i}/${pick(WORDS)}${rnd() < 0.5 ? "-" : "."}${pick(WORDS)}${(i % 97).toString(36)}.${pick(EXTS)}`);
}

/** The reference: every row through matchRow, a stable sort by score, the first `limit`. */
function reference(paths: readonly string[], q: string, limit = TOP_ROWS) {
  const hits: { index: number; score: number }[] = [];
  paths.forEach((p, index) => {
    const m = file(q, p);
    if (m) hits.push({ index, score: m.score });
  });
  hits.sort((a, b) => b.score - a.score || a.index - b.index);
  return { count: hits.length, top: hits.slice(0, limit) };
}

const brief = (r: CorpusResult) => ({ count: r.count, rows: r.rows.map((h) => [h.index, h.score, h.nameRanges]) });

/** Each word typed letter by letter, then deleted to its first letter: 106 keystrokes a pass. */
const TYPED = ["app", "config", "server", "index", "test", "schema", "handler", "fuzzy", "web comp", "src test"];
function typingScript(): string[] {
  const out: string[] = [];
  for (const w of TYPED) {
    for (let i = 1; i <= w.length; i++) out.push(w.slice(0, i));
    for (let i = w.length - 1; i >= 1; i--) out.push(w.slice(0, i));
  }
  return out;
}

describe("the score (A1)", () => {
  test("the worked values: streaks, the head bonus, word starts and the first index", () => {
    expect(text("comp", "Composer.tsx")).toEqual({ score: 30, nameRanges: [[0, 4]] });
    expect(text("comp", "web/composer/Composer.tsx")).toEqual({ score: 20.9, nameRanges: [[4, 8]] });
    expect(text("cv", "ChatView.tsx")).toEqual({ score: 12.7, nameRanges: [[0, 1], [4, 5]] }); // a capital after a lower-case letter
    expect(text("cv", "chat-view.tsx")).toEqual({ score: 12.8, nameRanges: [[0, 1], [5, 6]] }); // after -
    expect(text("cv", "civic.tsx")).toEqual({ score: 12, nameRanges: [[0, 1], [2, 3]] }); // no gap penalty
    expect(text("idx", "index.ts")).toEqual({ score: 15, nameRanges: [[0, 1], [2, 3], [4, 5]] });
    expect(text("idx", "src/idx.ts")).toEqual({ score: 11.9, nameRanges: [[4, 7]] }); // after /, minus the first index
  });
  test("each word start: / 0.9; - _ and a space 0.8; a capital after a lower-case letter 0.7; . 0.6; on a run's first letter only", () => {
    // b at index 2 (or 1) scores 1 + 2 * 1 plus its bonus, minus that index.
    expect(text("b", "a/b")!.score).toBe(1.9);
    for (const sep of ["-", "_", " "]) expect(text("b", `a${sep}b`)!.score).toBe(1.8);
    expect(text("b", "aB")!.score).toBe(2.7);
    expect(text("b", "AB")!.score).toBe(2); // a capital after a capital is no word start
    expect(text("b", "a.b")!.score).toBe(1.6);
    expect(text("bc", "a/bc")!.score).toBe(6.9); // 3.9 + 5: the second letter of a run gets no bonus
    expect(text("é", "aÉ")!.score).toBe(2.7); // a capital outside ASCII after a lower-case letter
  });
  test("a match far from the start scores below zero and is still a match", () => {
    // z at index 10 after a j: 1 + 2 * 1, no bonus, minus 10.
    expect(text("z", "abcdefghijz")).toEqual({ score: -7, nameRanges: [[10, 11]] });
    // a is not in the name x.ts; on the path its first a is at 22, after an n: 3 - 22.
    expect(file("a", "src/very/long/folder/name/x.ts")).toEqual({ score: -19, nameRanges: [] });
    const c = prepareCorpus(["src/very/long/folder/name/x.ts", "a.ts"]);
    const r = searchCorpus(c, "a");
    expect(r.count).toBe(2);
    expect(r.rows.map((h) => [h.path, h.score])).toEqual([["a.ts", 9], ["src/very/long/folder/name/x.ts", -19]]);
    // An alias match below zero: the run summ scores 3 + 5 + 7 + 9, minus its first index 30.
    expect(matchRow("summ", "compact", [`${"x".repeat(30)}summ`])).toEqual({ score: -6, nameRanges: [] });
  });
  test("greedy from left to right: the known loss is pinned (abc on ab_x_bc: greedy 17, best 17.8)", () => {
    const greedy = text("abc", "ab_x_bc")!;
    expect(greedy.score).toBe(17);
    expect(greedy.nameRanges).toEqual([[0, 2], [6, 7]]);
    // Every alignment, scored by the same rule: the best one keeps a at 0 and takes the "bc" run at 5.
    const best = bestAlignment("abc", "ab_x_bc");
    expect(best).toBeCloseTo(17.8, 6);
    expect(greedy.score).toBeLessThan(best);
    // And ab on a-xb-ab: greedy is also the best (12), the contiguous ab at 5 would score only 3.8.
    expect(text("ab", "a-xb-ab")!.score).toBe(12);
    expect(bestAlignment("ab", "a-xb-ab")).toBeCloseTo(12, 6);
  });
});

/** The best score of every alignment of q in s under the same rule (a test's own exhaustive scorer). */
function bestAlignment(q: string, s: string): number {
  const f = fold(s);
  const fq = fold(q);
  let best = -Infinity;
  const bonus = (i: number) => {
    const p = s[i - 1]!;
    if (p === "/") return 0.9;
    if ("-_ ".includes(p)) return 0.8;
    if (p === ".") return 0.6;
    return /[A-Z]/.test(s[i]!) && /[a-z]/.test(p) ? 0.7 : 0;
  };
  const walk = (qi: number, from: number, picked: number[]) => {
    if (qi === fq.length) {
      let score = 0;
      let streak = 0;
      picked.forEach((i, k) => {
        streak = k > 0 && picked[k - 1] === i - 1 ? streak + 1 : 1;
        score += 1 + 2 * streak + (i === 0 ? 6 : streak === 1 ? bonus(i) : 0);
      });
      best = Math.max(best, score - picked[0]!);
      return;
    }
    for (let i = from; i < f.length; i++) if (f[i] === fq[qi]) walk(qi + 1, i + 1, [...picked, i]);
  };
  walk(0, 0, []);
  return best;
}

describe("the fold (A2)", () => {
  test("one output unit per input unit, for every kind of letter", () => {
    const samples = ["\u0130stanbul.txt", "\u00c9cran.md", "e\u0301cran.md", "\u65e5\u672c\u8a9e\u306e\u30d5\u30a1\u30a4\u30eb.ts", "\ud55c\uad6d\uc5b4.md", "\u5bb6\u65cf \u{1f468}\u200d\u{1f469}\u200d\u{1f467}.png", "\u{1f600}\u{1f601}.txt", "\u03a3\u038a\u03a3\u03a5\u03a6\u039f\u03a3.md", "Stra\u00dfe.txt", "\u1e9e.txt", "\u212a\u212b.txt", "\u01c4emal.txt", "\u0131.txt", "\ud800 lone.txt", "\uff21\uff22\uff23.txt", "\ufb01le.txt"];
    for (const s of samples) {
      const f = fold(s);
      expect([s, f.length]).toEqual([s, s.length]);
    }
    expect(fold("İstanbul")).toBe("istanbul");
    expect(fold("ÉCRAN")).toBe("ecran");
    expect(fold("Straße")).toBe("straße"); // ß stays one letter
    expect(fold("\u212a")).toBe("k"); // the Kelvin sign
    expect(fold("한")).toBe("한"); // a syllable is not taken apart into its jamo
    expect(fold("\u{1f600}")).toBe("\u{1f600}"); // a surrogate pair stays
    // A word's final sigma folds as the capital and the plain small sigma do (one unit still).
    expect(fold("ΟΔΟΣ")).toBe(fold("οδός"));
    expect(fold("ς")).toBe("σ");
  });
  test("a Greek name in capitals is found by its small-letter form, final sigma included, and the reverse", () => {
    expect(text("οδός", "ΟΔΟΣ.md")).not.toBeNull();
    expect(text("ΟΔΟΣ", "οδός.md")).not.toBeNull();
  });
  test("stan on İstanbul.txt highlights [1,5), and txt still matches", () => {
    expect(text("stan", "İstanbul.txt")!.nameRanges).toEqual([[1, 5]]);
    expect(text("txt", "İstanbul.txt")).not.toBeNull();
    expect(file("txt", "docs/İstanbul.txt")!.nameRanges).toEqual([[2, 3], [10, 12]]);
    expect(text("istanbul", "İSTANBUL.TXT")!.nameRanges).toEqual([[0, 8]]);
  });
  test("an accented letter matches whatever its case, both ways", () => {
    const c = prepareCorpus(["docs/Écran.md", "écran.md", "ecran.txt", "notes.md"]);
    // All three names score alike, so they keep the corpus order.
    expect(searchCorpus(c, "écran").rows.map((r) => r.path)).toEqual(["docs/Écran.md", "écran.md", "ecran.txt"]);
    expect(searchCorpus(c, "Écran").rows.map((r) => r.path)).toEqual(["docs/Écran.md", "écran.md", "ecran.txt"]);
    expect(searchCorpus(c, "ecran").count).toBe(3);
    expect(file("Écran", "docs/Écran.md")!.nameRanges).toEqual([[0, 5]]);
    // A name in decomposed form (NFD, as some file systems keep it) still matches; the mark is skipped.
    expect(text("ecran", "E\u0301cran.md")).not.toBeNull();
    // A query typed in decomposed form loses its marks, so it finds both forms.
    expect(text("e\u0301cran", "\u00c9cran.md")!.nameRanges).toEqual([[0, 5]]);
    expect(text("E\u0301CRAN", "E\u0301cran.md")).not.toBeNull();
    expect(parseQuery("e\u0301cran").terms).toEqual(["ecran"]);
  });
  test("no case rule beyond the fold: a capital in the query matches a lower-case letter", () => {
    expect(text("COMP", "composer.tsx")!.score).toBe(text("comp", "composer.tsx")!.score);
  });
  test("a highlight never splits a surrogate pair", () => {
    // Both emoji share their first unit; greedy takes it from the first one, so the range grows to whole pairs.
    const m = text("\u{1f601}", "\u{1f600}\u{1f601}.txt")!;
    expect(m.nameRanges).toEqual([[0, 4]]);
  });
  test("the letter mask: 26 letters and one bit for every digit", () => {
    expect(letterMask("abz")).toBe(1 | 2 | (1 << 25));
    expect(letterMask("09")).toBe(1 << 26);
    expect(letterMask("日本/.-")).toBe(0);
  });
});

describe("one row matcher for every kind (A3)", () => {
  test("a file: the name first with ranges, then the path with none", () => {
    expect(file("comp", "web/composer/Composer.tsx")).toEqual({ score: 30, nameRanges: [[0, 4]] });
    expect(file("web comp", "web/composer/Composer.tsx")).toEqual({ score: 51, nameRanges: [[0, 4]] });
    expect(file("web/comp", "web/composer/Composer.tsx")).toEqual({ score: 86, nameRanges: [] }); // a / makes it path-only
    expect(file("comp pos", "web/composer/Composer.tsx")!.nameRanges).toEqual([[0, 6]]); // merged into one range
    expect(file("zzz", "web/composer/Composer.tsx")).toBeNull();
  });
  test("white space is AND, in any order, with any amount of it", () => {
    for (const q of ["flaky test", "test flaky", "  flaky   test ", "flaky\ttest"]) expect(text(q, "Flaky upload test")).not.toBeNull();
    expect(text("flaky nope", "Flaky upload test")).toBeNull();
    expect(text("flaky test", "Flaky upload test")!.nameRanges).toEqual([[0, 5], [13, 17]]);
  });
  test("a chat: its title; a null title never matches, not even a blank query", () => {
    expect(matchRow("", "Release notes")).toEqual({ score: 0, nameRanges: [] });
    expect(matchRow("", null)).toBeNull();
    expect(matchRow("rel", null)).toBeNull();
  });
  test("a command: its name, then its aliases (the best alias, score only)", () => {
    expect(matchRow("comp", "compact", ["summarize"])!.nameRanges).toEqual([[0, 4]]);
    const viaAlias = matchRow("summ", "compact", ["summarize", "sum"])!;
    expect(viaAlias.nameRanges).toEqual([]);
    expect(viaAlias.score).toBe(matchRow("summ", "summarize")!.score);
    expect(matchRow("zz", "compact", ["summarize"])).toBeNull();
  });
  test("rankList: best first, ties in list order, a true count, at most the limit", () => {
    const chats = [{ t: "Upload test" }, { t: null }, { t: "upload" }, { t: "Fix the upload" }, { t: "upload" }];
    const r = rankList(chats, "upload", (c) => ({ name: c.t }), 2);
    expect(r.count).toBe(4);
    expect(r.rows.map((x) => x.index)).toEqual([0, 2]); // 0, 2 and 4 tie at the top; list order breaks the tie
    expect(rankList(chats, "upload", (c) => ({ name: c.t })).rows.map((x) => x.index)).toEqual([0, 2, 4, 3]);
  });
});

describe("the ranges index the name (A4)", () => {
  test("a file deep in a folder: comp on web/composer/Composer.tsx gives [0,4) on Composer.tsx", () => {
    const c = prepareCorpus(["web/composer/Composer.tsx"]);
    const hit = searchCorpus(c, "comp").rows[0]!;
    expect(hit.nameStart).toBe(13);
    expect(hit.path.slice(hit.nameStart)).toBe("Composer.tsx");
    expect(hit.nameRanges).toEqual([[0, 4]]);
    const name = hit.path.slice(hit.nameStart);
    expect(name.slice(hit.nameRanges[0]![0], hit.nameRanges[0]![1])).toBe("Comp");
  });
  test("ranges are ascending, coalesced and inside the name", () => {
    for (const p of repoPaths(3000)) {
      for (const q of ["comp", "se te", "idx", "a b c", "mo de"]) {
        const m = file(q, p);
        if (!m) continue;
        const len = p.length - nameStart(p);
        let end = -1;
        for (const [s, e] of m.nameRanges) {
          expect(s).toBeGreaterThan(end); // ascending, and never adjacent (coalesced)
          expect(e).toBeGreaterThan(s);
          expect(e).toBeLessThanOrEqual(len);
          end = e;
        }
      }
    }
  });
  test("no search file builds HTML from a string: no innerHTML, no dangerouslySetInnerHTML", () => {
    const files: string[] = [join(ROOT, "shared", "match.ts")];
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(n)) files.push(p);
      }
    };
    walk(join(ROOT, "web", "search"));
    for (const n of readdirSync(join(ROOT, "web", "composer"))) if (/^Mention/.test(n)) files.push(join(ROOT, "web", "composer", n));
    for (const p of files) expect([p, /innerHTML|dangerouslySetInnerHTML/.test(readFileSync(p, "utf8"))]).toEqual([p, false]);
  });
});

describe("the prepared corpus (A5)", () => {
  test("prepare fills the folded paths, the masks and the name offsets once", () => {
    const c = prepareCorpus(["web/App.tsx", "README.md", "docs/Écran.md"], "v1");
    expect(c.ready).toBe(true);
    expect(c.v).toBe("v1");
    expect(c.folded).toEqual(["web/app.tsx", "readme.md", "docs/ecran.md"]);
    expect([...c.nameAt]).toEqual([4, 0, 5]);
    expect(c.masks[1]).toBe(letterMask("readme.md"));
  });
  test("a query before prepare ends gives no rows and does not throw; after it, the rows", () => {
    const c = new Corpus(repoPaths(1000));
    expect(c.ready).toBe(false);
    expect(searchCorpus(c, "comp")).toEqual({ q: "comp", count: 0, rows: [] });
    expect(c.prepare(400)).toBe(false);
    expect(searchCorpus(c, "comp").rows).toEqual([]);
    const s = new Searcher(c);
    expect(s.search("comp").rows).toEqual([]);
    expect(c.prepare(400)).toBe(false);
    expect(c.prepare(400)).toBe(true);
    expect(searchCorpus(c, "comp").count).toBe(reference(c.paths, "comp").count);
    expect(s.search("comp").count).toBe(reference(c.paths, "comp").count); // nothing from before it was ready stuck
  });
  test("an empty corpus and a blank query", () => {
    expect(searchCorpus(prepareCorpus([]), "a")).toEqual({ q: "a", count: 0, rows: [] });
    const c = prepareCorpus(repoPaths(500));
    const blank = searchCorpus(c, "   ");
    expect(blank.count).toBe(500);
    expect(blank.rows.map((r) => r.index)).toEqual(Array.from({ length: TOP_ROWS }, (_, i) => i)); // the corpus order
    expect(blank.rows.every((r) => r.score === 0 && r.nameRanges.length === 0)).toBe(true);
  });
});

describe("the best 120 and a true count (A6)", () => {
  const paths = repoPaths(20_000);
  const corpus = prepareCorpus(paths);
  const filters = ["a", "ap", "app", "conf", "serv", "index", "mod", "te", "tes", "test", "sch", "han", "fz", "fuz", "web comp", "src/te", "zzzz"];
  for (const q of filters)
    test(`"${q}": the kept rows equal a full sort's first 120, and the count is the full count`, () => {
      const got = searchCorpus(corpus, q);
      const want = reference(paths, q);
      expect(got.count).toBe(want.count);
      expect(got.rows.map((r) => [r.index, r.score])).toEqual(want.top.map((r) => [r.index, r.score]));
    });
  test("the pathological corpus (a shared prefix, a matches every row): the same best 120 and the full count", () => {
    const pp = prefixPaths(20_000);
    const pc = prepareCorpus(pp);
    for (const q of ["a", "ap", "pro", "va app", "te", "zz"]) {
      const got = searchCorpus(pc, q);
      const want = reference(pp, q);
      expect([q, got.count]).toEqual([q, want.count]);
      expect(got.rows.map((r) => [r.index, r.score])).toEqual(want.top.map((r) => [r.index, r.score]));
    }
    expect(searchCorpus(pc, "a").count).toBe(20_000);
  });
  test("the score-only scan gives the same score and ranges as the ranged row matcher", () => {
    const cases: [string, string][] = [
      ["comp", "web/composer/Composer.tsx"],
      ["web comp", "web/composer/Composer.tsx"],
      ["web/comp", "web/composer/Composer.tsx"],
      ["comp pos", "web/composer/Composer.tsx"],
      ["cv", "src/ChatView.tsx"],
      ["cv", "src/chat-view.tsx"],
      ["cv", "civic.tsx"],
      ["idx", "index.ts"],
      ["idx", "src/idx.ts"],
      ["abc", "ab_x_bc"],
      ["stan", "docs/İstanbul.txt"],
      ["écran", "docs/Écran.md"],
      ["Écran", "écran.md"],
    ];
    const c = prepareCorpus(cases.map(([, p]) => p));
    cases.forEach(([q, p], i) => {
      const hit = searchCorpus(c, q).rows.find((r) => r.index === i)!;
      expect([q, p, hit.score, hit.nameRanges]).toEqual([q, p, file(q, p)!.score, file(q, p)!.nameRanges]);
    });
  });
  test("ties keep the corpus order, and a limit below 120 keeps the best", () => {
    const c = prepareCorpus(["b/x.ts", "a/x.ts", "c/x.ts", "x.tsx"]);
    expect(searchCorpus(c, "x.ts").rows.map((r) => r.path)).toEqual(["b/x.ts", "a/x.ts", "c/x.ts", "x.tsx"]);
    expect(searchCorpus(c, "x.ts", 2).rows.map((r) => r.path)).toEqual(["b/x.ts", "a/x.ts"]);
    expect(searchCorpus(c, "x.ts", 0)).toMatchObject({ count: 4, rows: [] });
  });
  test("a scan in steps (the server yields between them) gives the result of one step", () => {
    for (const q of ["te", "web comp", "a"]) {
      const scan = new Scan(corpus, q);
      let steps = 0;
      while (!scan.step(777)) steps++;
      expect(steps).toBeGreaterThan(10);
      expect(brief(scan.result(q))).toEqual(brief(searchCorpus(corpus, q)));
    }
  });
});

describe("narrowing (A7)", () => {
  const paths = repoPaths(8_000, 0x13579);
  const corpus = prepareCorpus(paths, "v1");
  test("the 318-keystroke typing script: the narrowed result equals a scratch run at every step", () => {
    const s = new Searcher(corpus);
    let steps = 0;
    for (let pass = 0; pass < 3; pass++)
      for (const q of typingScript()) {
        expect([q, brief(s.search(q))]).toEqual([q, brief(searchCorpus(corpus, q))]);
        steps++;
      }
    expect(steps).toBe(318);
  });
  test("random edits (typing, Backspace, cuts, spaces, case) equal a scratch run at every step", () => {
    const rnd = lcg(0xbeef);
    const letters = "abcdefghilmnoprstuvwxyz  ./-_ACEST";
    const s = new Searcher(corpus);
    let q = "";
    for (let k = 0; k < 600; k++) {
      const r = rnd();
      if (r < 0.55) q += letters[Math.floor(rnd() * letters.length)];
      else if (r < 0.8) q = q.slice(0, -1);
      else if (r < 0.9) q = q.slice(0, Math.floor(rnd() * (q.length + 1)));
      else if (r < 0.95) q = q.toUpperCase();
      else q = "";
      if (q.length > 12) q = q.slice(0, 4);
      expect([q, brief(s.search(q))]).toEqual([q, brief(searchCorpus(corpus, q))]);
    }
  });
  test("a query longer than the stack's depth, then deleted letter by letter, equals a scratch run at every step", () => {
    const s = new Searcher(corpus);
    const long = "s e r v e r t e s t s c h e m a h a n d l e r".slice(0, 45);
    for (let i = 1; i <= long.length; i++) expect([i, brief(s.search(long.slice(0, i)))]).toEqual([i, brief(searchCorpus(corpus, long.slice(0, i)))]);
    for (let i = long.length - 1; i >= 0; i--) expect([i, brief(s.search(long.slice(0, i)))]).toEqual([i, brief(searchCorpus(corpus, long.slice(0, i)))]);
  });
  test("a limit below 120 narrows to the same rows as a scratch run with that limit", () => {
    const s = new Searcher(corpus, 7);
    for (const q of ["s", "se", "ser", "serv", "ser", "s", "sc"]) expect([q, brief(s.search(q))]).toEqual([q, brief(searchCorpus(corpus, q, 7))]);
  });
  test("Backspace answers from the stack: the same result object for the same query", () => {
    const s = new Searcher(corpus);
    const ser = s.search("ser");
    s.search("serv");
    s.search("serve");
    expect(s.search("ser")).toBe(ser);
    expect(s.search("SER")).toMatchObject({ q: "SER", count: ser.count }); // the same folded query, asked as typed
  });
  test("a new corpus in the middle of the typing gives the new corpus's scratch result", () => {
    const s = new Searcher(corpus);
    s.search("te");
    s.search("tes");
    const next = prepareCorpus([...paths.slice(0, 4_000), "test/the-new-test.ts", ...paths.slice(5_000)], "v2");
    s.use(next);
    for (const q of ["test", "tes", "te", "test n"]) expect([q, brief(s.search(q))]).toEqual([q, brief(searchCorpus(next, q))]);
    expect(s.search("the new").rows[0]!.path).toBe("test/the-new-test.ts");
    s.use(null);
    expect(s.search("te")).toEqual({ q: "te", count: 0, rows: [] });
  });
  test("parseQuery: the folded key keeps white space, the terms do not", () => {
    expect(parseQuery("  Web  Comp ")).toEqual({ key: "  web  comp ", terms: ["web", "comp"], mask: letterMask("webcomp") });
    expect(parseQuery(" \t ").terms).toEqual([]);
  });
});
