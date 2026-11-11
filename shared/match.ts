// kitespan's own matcher (D55, DESIGN.md 9.3 "The engine"): one pure module that the page and the server both import,
// so both rank alike. No React, no DOM, no fs and no Bun API.
//
// The rules. A query splits on white space into terms that must all match (AND), for every kind of row. A term is a
// case-insensitive subsequence, taken greedily from left to right (the first match of each letter; no search for a
// better alignment, so a few rows score a little lower than their best alignment would). Each matched character at
// index i scores 1 + 2 * streak (streak: the length of the run of consecutive matches it ends), plus 6 at index 0,
// plus a small bonus on the first character of a run at a word start: after `/` 0.9; after `-`, `_` or a space 0.8;
// a capital after a lower-case letter 0.7; after `.` 0.6. Then the term's score loses the index of its first match,
// so a match far from the start scores below zero and is still a match. There is no gap penalty. A term tries the
// row's name first (which gives highlight ranges into the name), then its other fields, such as a file's path (score
// only). A row's score is the sum of its terms' scores.
//
// The case rule: none beyond the fold. A capital in the query matches a lower-case letter, and the case of the
// candidate only gives the capital-after-lower-case bonus.
//
// One fold (`fold`) turns every UTF-16 unit into one unit: lower case, a precomposed letter to its base letter (É to
// e), the dotted capital I to i, a word's final sigma (ς) to the plain small sigma (σ, as Σ folds), surrogates kept.
// Matching and highlighting use the same fold, so a highlight never shifts and an accented name is found whatever the
// case of its accented letter. The query also loses its combining marks, so a query typed in decomposed form finds
// both forms of a name.
//
// Scores are kept in tenths (integers) inside the module, so the score-only scan and the ranged pass add exactly the
// same numbers; a result's `score` is the real value (tenths / 10).

/** A half-open `[start, end)` slice of the row's NAME (a file's basename, a chat's title, a command's name). */
export type NameRange = [start: number, end: number];

/** The rows a search keeps: the best 120, with the true count of matches. */
export const TOP_ROWS = 120;

/** "Not a subsequence": below any score a real match can have (a path or a query holds far fewer units). */
const MISS = -0x40000000;

// ---------------------------------------------------------------------------------------------------------------
// The fold

/** The fold of each non-ASCII BMP unit, filled on first use (0: not known yet; a non-ASCII unit never folds to 0). */
const FOLD = new Uint16Array(0x10000);
const NON_ASCII = /[^\u0000-\u007f]/;
const ONLY_MARKS = /^\p{M}+$/u;
const MARKS = /\p{M}/gu;

const FINAL_SIGMA = "\u03c2";
const SMALL_SIGMA = 0x03c3;

function isSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdfff;
}

function foldSlow(c: number): number {
  const ch = String.fromCharCode(c);
  let base = ch;
  const d = ch.normalize("NFD");
  // A precomposed letter (É, İ, Å) or a singleton (the Kelvin sign) gives its base. A decomposition into letters
  // (a Hangul syllable into its jamo) is not a base letter, so it stays.
  if (d !== ch && (d.length === 1 || ONLY_MARKS.test(d.slice(1))) && !isSurrogate(d.charCodeAt(0))) base = d[0]!;
  const low = base.toLowerCase();
  // Σ lower-cases to σ on its own, but a word in small letters ends in ς: both are σ here, so the cases meet.
  if (low === FINAL_SIGMA) return SMALL_SIGMA;
  if (low.length === 1 || ONLY_MARKS.test(low.slice(1))) return low.charCodeAt(0);
  return base.charCodeAt(0);
}

function foldUnit(c: number): number {
  if (c < 0x80) return c >= 65 && c <= 90 ? c + 32 : c;
  if (isSurrogate(c)) return c;
  const known = FOLD[c]!;
  if (known !== 0) return known;
  const v = foldSlow(c);
  FOLD[c] = v;
  return v;
}

/** The fold of `s`: exactly one UTF-16 unit for each unit of `s`, so an index into the fold is an index into `s`. */
export function fold(s: string): string {
  if (!NON_ASCII.test(s)) return s.toLowerCase();
  let out = "";
  for (let i = 0; i < s.length; i++) out += String.fromCharCode(foldUnit(s.charCodeAt(i)));
  return out;
}

/** The units a string is made from at once (String.fromCharCode takes at most this many arguments safely). */
const UNIT_CHUNK = 8_192;

/** The first `n` units of `units` as one flat string (made in chunks, then joined once). */
export function unitsString(units: Uint16Array, n: number = units.length): string {
  if (n <= UNIT_CHUNK) return String.fromCharCode.apply(null, units.subarray(0, n) as unknown as number[]);
  const parts: string[] = [];
  for (let i = 0; i < n; i += UNIT_CHUNK) parts.push(String.fromCharCode.apply(null, units.subarray(i, Math.min(n, i + UNIT_CHUNK)) as unknown as number[]));
  return parts.join("");
}

/**
 * The same fold as `fold`, made as one flat string (U5, the message search's kept text): `fold` adds one unit at a
 * time, and a long text kept that way holds a rope of one-unit pieces (34.6 bytes a character in the design's bench,
 * against 2 for a flat string). Use this for long texts that are kept; `fold` stays the matcher's for short names.
 */
export function foldFlat(s: string): string {
  if (!NON_ASCII.test(s)) return s.toLowerCase();
  const n = s.length;
  const out = new Uint16Array(n);
  for (let i = 0; i < n; i++) out[i] = foldUnit(s.charCodeAt(i));
  return unitsString(out, n);
}

/** 1: a capital, 2: a lower-case letter, 3: neither (0: not known yet). */
const CASE = new Uint8Array(0x10000);

function caseOf(c: number): number {
  if (c < 0x80) return c >= 65 && c <= 90 ? 1 : c >= 97 && c <= 122 ? 2 : 3;
  if (isSurrogate(c)) return 3;
  let k = CASE[c]!;
  if (k === 0) {
    const ch = String.fromCharCode(c);
    k = ch !== ch.toLowerCase() ? 1 : ch !== ch.toUpperCase() ? 2 : 3;
    CASE[c] = k;
  }
  return k;
}

/** The letter mask of a folded string: bits 0 to 25 for a to z, bit 26 for any digit. */
export function letterMask(folded: string): number {
  let m = 0;
  for (let i = 0; i < folded.length; i++) {
    const c = folded.charCodeAt(i);
    if (c >= 97 && c <= 122) m |= 1 << (c - 97);
    else if (c >= 48 && c <= 57) m |= 1 << 26;
  }
  return m;
}

// ---------------------------------------------------------------------------------------------------------------
// The query

export interface Query {
  /** The folded query as typed (white space kept): one query extends another when its key starts with the other's. */
  readonly key: string;
  /** The folded terms; none for a blank query, which every row matches with score 0. */
  readonly terms: readonly string[];
  /** The letter mask of all the terms: a row whose path lacks one of these letters cannot match. */
  readonly mask: number;
}

export function parseQuery(q: string): Query {
  const key = NON_ASCII.test(q) ? fold(q).replace(MARKS, "") : q.toLowerCase();
  const trimmed = key.trim();
  const terms = trimmed ? trimmed.split(/\s+/) : [];
  let mask = 0;
  for (const t of terms) mask |= letterMask(t);
  return { key, terms, mask };
}

// ---------------------------------------------------------------------------------------------------------------
// Scoring (tenths)

/** The word-start bonus of the character at `i` of the original `o`, in tenths; `i` is never the field's start. */
function bonusAt(o: string, i: number): number {
  const p = o.charCodeAt(i - 1);
  if (p === 47) return 9; // after /
  if (p === 45 || p === 95 || p === 32) return 8; // after -, _ or a space
  if (p === 46) return 6; // after .
  return caseOf(o.charCodeAt(i)) === 1 && caseOf(p) === 2 ? 7 : 0; // a capital after a lower-case letter
}

/**
 * The greedy score of the folded term `t` in `f[from, to)` (the folded field; `o` is the original, for the case of a
 * letter), in tenths, or MISS when `t` is not a subsequence there. Indexes count from `from`. `out`, when given, gets
 * the matched runs as flat `start, end` pairs relative to `from` (partial pairs are left behind on a miss).
 */
function scoreIn(t: string, f: string, o: string, from: number, to: number, out: number[] | null): number {
  const tl = t.length;
  if (to - from < tl) return MISS;
  let qi = 0;
  let qc = t.charCodeAt(0);
  let streak = 0;
  let score = 0;
  let first = -1;
  for (let i = from; i < to; i++) {
    if (f.charCodeAt(i) !== qc) {
      streak = 0;
      continue;
    }
    streak++;
    score += 10 + 20 * streak;
    if (i === from) score += 60;
    else if (streak === 1) score += bonusAt(o, i);
    if (first < 0) first = i - from;
    if (out) {
      const r = i - from;
      const n = out.length;
      if (streak > 1 && n > 0 && out[n - 1] === r) out[n - 1] = r + 1;
      else out.push(r, r + 1);
    }
    if (++qi === tl) return score - 10 * first;
    qc = t.charCodeAt(qi);
  }
  return MISS;
}

/** True when every term is a subsequence of the folded `f` (the prefilter's second stage: no scoring, no bonus). */
function hasAll(terms: readonly string[], f: string): boolean {
  const fl = f.length;
  for (let k = 0; k < terms.length; k++) {
    const t = terms[k]!;
    const tl = t.length;
    let qi = 0;
    let qc = t.charCodeAt(0);
    let i = 0;
    for (; i < fl; i++) {
      if (f.charCodeAt(i) === qc) {
        if (++qi === tl) break;
        qc = t.charCodeAt(qi);
      }
    }
    if (qi < tl) return false;
  }
  return true;
}

/** Flat pairs into ascending, coalesced ranges of a name of `len` units that start at `at` in `o`, never splitting a surrogate pair. */
function toRanges(flat: number[], o: string, at: number, len: number): NameRange[] {
  if (flat.length === 0) return [];
  const pairs: NameRange[] = [];
  for (let k = 0; k < flat.length; k += 2) {
    let s = flat[k]!;
    let e = flat[k + 1]!;
    const sc = o.charCodeAt(at + s);
    if (s > 0 && sc >= 0xdc00 && sc <= 0xdfff) s--;
    const ec = o.charCodeAt(at + e - 1);
    if (e < len && ec >= 0xd800 && ec <= 0xdbff) e++;
    pairs.push([s, e]);
  }
  pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: NameRange[] = [pairs[0]!];
  for (let k = 1; k < pairs.length; k++) {
    const last = out[out.length - 1]!;
    const p = pairs[k]!;
    if (p[0] <= last[1]) last[1] = Math.max(last[1], p[1]);
    else out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// One row of any kind (chats, uploads, commands, and a file outside a prepared corpus)

export interface RowMatch {
  score: number;
  /** Into the name only; a term that matched another field adds none. */
  nameRanges: NameRange[];
}

/** What one row offers the matcher: its name, and the other fields a term may match (score only). */
export interface RowFields {
  /** A null name never matches (a chat with no title). */
  name: string | null;
  alts?: readonly string[];
}

/**
 * Match one row: each term tries `name` first (with ranges into `name`), then the best of `alts` (score only). A null
 * name never matches (a chat with no title). A file: its basename and `[path]`; an upload: its name and `[path]`; a
 * chat: its title; a command: its name and its aliases. A blank query matches with score 0.
 */
export function matchRow(query: string | Query, name: string | null, alts: readonly string[] = []): RowMatch | null {
  if (name === null) return null;
  const q = typeof query === "string" ? parseQuery(query) : query;
  if (q.terms.length === 0) return { score: 0, nameRanges: [] };
  const fn = fold(name);
  const fa = alts.map(fold);
  const flat: number[] = [];
  let total = 0;
  for (const t of q.terms) {
    const before = flat.length;
    let s = scoreIn(t, fn, name, 0, fn.length, flat);
    if (s === MISS) {
      flat.length = before;
      for (let k = 0; k < fa.length; k++) s = Math.max(s, scoreIn(t, fa[k]!, alts[k]!, 0, fa[k]!.length, null));
      if (s === MISS) return null;
    }
    total += s;
  }
  return { score: total / 10, nameRanges: toRanges(flat, name, 0, name.length) };
}

/** One kept row of a list: the item, its place in the list, and its match. */
export interface RankedRow<T> extends RowMatch {
  item: T;
  index: number;
}

export interface Ranked<T> {
  /** The true number of matching rows. */
  count: number;
  /** At most `limit` rows, best first; equal scores keep the list's order. */
  rows: RankedRow<T>[];
}

/** Rank a small list (the chats, the uploads, the commands) with `matchRow`. */
export function rankList<T>(items: readonly T[], query: string | Query, fields: (item: T) => RowFields, limit: number = TOP_ROWS): Ranked<T> {
  const q = typeof query === "string" ? parseQuery(query) : query;
  const hits: RankedRow<T>[] = [];
  items.forEach((item, index) => {
    const f = fields(item);
    const m = matchRow(q, f.name, f.alts);
    if (m) hits.push({ item, index, ...m });
  });
  hits.sort((a, b) => b.score - a.score || a.index - b.index);
  return { count: hits.length, rows: hits.slice(0, Math.max(0, limit)) };
}

// ---------------------------------------------------------------------------------------------------------------
// A prepared corpus of file paths (the chat folder's files)

/** Where a path's name (its basename) starts: after its last `/`. */
export function nameStart(path: string): number {
  return path.lastIndexOf("/") + 1;
}

/**
 * A corpus of paths relative to the chat's folder, prepared once when it arrives: the folded path (the lower-case
 * copy), its letter mask and where its name starts, in parallel arrays. `prepare(rows)` prepares in steps; the
 * corpus answers queries once every row is prepared, and before that a search gives no rows.
 */
export class Corpus {
  readonly paths: readonly string[];
  /** The build's id that the server gave with the paths (empty when there is none). */
  readonly v: string;
  readonly size: number;
  readonly folded: string[];
  readonly masks: Int32Array;
  readonly nameAt: Int32Array;
  private done = 0;

  constructor(paths: readonly string[], v = "") {
    this.paths = paths;
    this.v = v;
    this.size = paths.length;
    this.folded = new Array<string>(this.size).fill("");
    this.masks = new Int32Array(this.size);
    this.nameAt = new Int32Array(this.size);
  }

  get ready(): boolean {
    return this.done === this.size;
  }

  /** Prepare up to `rows` more rows; true when every row is prepared. */
  prepare(rows: number = Infinity): boolean {
    const end = Math.min(this.size, this.done + Math.max(0, rows));
    for (let i = this.done; i < end; i++) {
      const p = this.paths[i]!;
      const f = fold(p);
      this.folded[i] = f;
      this.masks[i] = letterMask(f);
      this.nameAt[i] = nameStart(p);
    }
    this.done = end;
    return this.ready;
  }
}

/** A corpus prepared at once. */
export function prepareCorpus(paths: readonly string[], v = ""): Corpus {
  const c = new Corpus(paths, v);
  c.prepare();
  return c;
}

/** One kept file row. */
export interface FileHit {
  /** The row's place in the corpus. */
  index: number;
  path: string;
  score: number;
  /** Where the name starts in `path`: the folder part is `path.slice(0, nameStart)`. */
  nameStart: number;
  /** Into the name (`path.slice(nameStart)`), never into the path. */
  nameRanges: NameRange[];
}

export interface CorpusResult {
  /** The query as it was asked. */
  q: string;
  /** The true number of matching paths. */
  count: number;
  /** At most the limit, best first; equal scores keep the corpus order. */
  rows: FileHit[];
}

/** The score of a corpus row, in tenths, or MISS. Each term: the name first, then the whole path. */
function rowScore(terms: readonly string[], f: string, o: string, at: number): number {
  let total = 0;
  for (let k = 0; k < terms.length; k++) {
    const t = terms[k]!;
    let s = scoreIn(t, f, o, at, f.length, null);
    if (s === MISS && at > 0) s = scoreIn(t, f, o, 0, f.length, null);
    if (s === MISS) return MISS;
    total += s;
  }
  return total;
}

function rowRanges(terms: readonly string[], f: string, o: string, at: number): NameRange[] {
  const flat: number[] = [];
  for (const t of terms) {
    const before = flat.length;
    if (scoreIn(t, f, o, at, f.length, flat) === MISS) flat.length = before;
  }
  return toRanges(flat, o, at, o.length - at);
}

export interface ScanOptions {
  /** The most rows kept (TOP_ROWS). */
  limit?: number;
  /** Scan only these rows (ascending corpus indexes), the matches of a query that this one extends. */
  within?: Int32Array | null;
  /** Keep every match's index, so the next, longer query can scan only them. */
  keep?: boolean;
}

/**
 * One query over a corpus, in steps, so the server can yield to its event loop between them (every 20,000 paths).
 * The prefilter is the letter mask, then a subsequence test on the folded path; only the rows that pass are scored,
 * with no allocation; the best rows go into a bounded heap ordered by score, then corpus order; ranges are made for
 * the kept rows only.
 */
export class Scan {
  private readonly corpus: Corpus;
  private readonly query: Query;
  private readonly within: Int32Array | null;
  private readonly limit: number;
  private readonly end: number;
  private pos = 0;
  private count = 0;
  private readonly heapS: Int32Array;
  private readonly heapI: Int32Array;
  private heapN = 0;
  private readonly found: Int32Array | null;

  constructor(corpus: Corpus, query: string | Query, opts: ScanOptions = {}) {
    this.corpus = corpus;
    this.query = typeof query === "string" ? parseQuery(query) : query;
    this.within = opts.within ?? null;
    this.limit = Math.max(0, Math.floor(opts.limit ?? TOP_ROWS));
    this.end = corpus.ready ? (this.within ? this.within.length : corpus.size) : 0;
    this.heapS = new Int32Array(this.limit);
    this.heapI = new Int32Array(this.limit);
    this.found = opts.keep ? new Int32Array(this.end) : null;
  }

  get done(): boolean {
    return this.pos === this.end;
  }

  /** Scan up to `rows` more candidates; true when the scan is done. */
  step(rows: number = Infinity): boolean {
    const stop = Math.min(this.end, this.pos + Math.max(0, rows));
    const { terms, mask } = this.query;
    const { folded, masks, nameAt, paths } = this.corpus;
    const within = this.within;
    const found = this.found;
    const blank = terms.length === 0;
    for (let k = this.pos; k < stop; k++) {
      const i = within ? within[k]! : k;
      let s = 0;
      if (!blank) {
        if ((mask & ~masks[i]!) !== 0) continue;
        const f = folded[i]!;
        if (!hasAll(terms, f)) continue;
        s = rowScore(terms, f, paths[i]!, nameAt[i]!);
        if (s === MISS) continue; // never after hasAll: the name is a suffix of the path
      }
      if (found) found[this.count] = i;
      this.count++;
      this.offer(s, i);
    }
    this.pos = stop;
    return this.done;
  }

  /** Lower score, or the same score later in the corpus: the heap's root is its worst row. */
  private worse(a: number, b: number): boolean {
    const sa = this.heapS[a]!;
    const sb = this.heapS[b]!;
    return sa < sb || (sa === sb && this.heapI[a]! > this.heapI[b]!);
  }

  private swap(a: number, b: number): void {
    const s = this.heapS[a]!;
    const i = this.heapI[a]!;
    this.heapS[a] = this.heapS[b]!;
    this.heapI[a] = this.heapI[b]!;
    this.heapS[b] = s;
    this.heapI[b] = i;
  }

  private offer(s: number, i: number): void {
    const K = this.limit;
    if (K === 0) return;
    if (this.heapN < K) {
      let c = this.heapN++;
      this.heapS[c] = s;
      this.heapI[c] = i;
      while (c > 0) {
        const p = (c - 1) >> 1;
        if (!this.worse(c, p)) break;
        this.swap(c, p);
        c = p;
      }
      return;
    }
    const rs = this.heapS[0]!;
    if (s < rs || (s === rs && i > this.heapI[0]!)) return;
    this.heapS[0] = s;
    this.heapI[0] = i;
    let c = 0;
    for (;;) {
      const l = 2 * c + 1;
      const r = l + 1;
      let m = c;
      if (l < K && this.worse(l, m)) m = l;
      if (r < K && this.worse(r, m)) m = r;
      if (m === c) break;
      this.swap(c, m);
      c = m;
    }
  }

  /** The indexes of every match so far, ascending (only with `keep`). */
  matches(): Int32Array | null {
    return this.found ? this.found.slice(0, this.count) : null;
  }

  /** The result of the rows scanned so far (the whole result once `step` returned true). */
  result(q: string = this.query.key): CorpusResult {
    const order: number[] = [];
    for (let k = 0; k < this.heapN; k++) order.push(k);
    order.sort((a, b) => this.heapS[b]! - this.heapS[a]! || this.heapI[a]! - this.heapI[b]!);
    const { folded, nameAt, paths } = this.corpus;
    const terms = this.query.terms;
    const rows = order.map((k): FileHit => {
      const i = this.heapI[k]!;
      const at = nameAt[i]!;
      return { index: i, path: paths[i]!, score: this.heapS[k]! / 10, nameStart: at, nameRanges: terms.length ? rowRanges(terms, folded[i]!, paths[i]!, at) : [] };
    });
    return { q, count: this.count, rows };
  }
}

/** One query over the whole corpus, from scratch. Before the corpus is prepared it gives no rows. */
export function searchCorpus(corpus: Corpus, q: string, limit: number = TOP_ROWS): CorpusResult {
  const scan = new Scan(corpus, q, { limit });
  scan.step();
  return scan.result(q);
}

// ---------------------------------------------------------------------------------------------------------------
// Narrowing while the query grows

interface Step {
  key: string;
  matches: Int32Array;
  result: CorpusResult;
}

/** The earlier results that a Searcher keeps for Backspace. */
const STACK_MAX = 32;

/**
 * Search one corpus as the user types. A query that extends the last one (its folded text starts with the last
 * one's) scans only the last matches, because a row that matches the longer query matches the shorter one too. A
 * stack of earlier results answers Backspace. A new corpus (a new build, a new `v`) drops the stack. Every answer
 * equals a scratch search of the same query.
 */
export class Searcher {
  private current: Corpus | null;
  private readonly limit: number;
  private stack: Step[] = [];

  constructor(corpus: Corpus | null = null, limit: number = TOP_ROWS) {
    this.current = corpus;
    this.limit = limit;
  }

  get corpus(): Corpus | null {
    return this.current;
  }

  /** Search another corpus from now on; the stack is dropped when it is a different one. */
  use(corpus: Corpus | null): void {
    if (corpus === this.current) return;
    this.current = corpus;
    this.stack = [];
  }

  search(q: string): CorpusResult {
    const c = this.current;
    if (!c || !c.ready) return { q, count: 0, rows: [] };
    const query = parseQuery(q);
    if (query.terms.length === 0) {
      this.stack = [];
      return searchCorpus(c, q, this.limit);
    }
    while (this.stack.length && !query.key.startsWith(this.stack[this.stack.length - 1]!.key)) this.stack.pop();
    const top = this.stack[this.stack.length - 1];
    if (top && top.key === query.key) {
      if (top.result.q !== q) top.result = { ...top.result, q };
      return top.result;
    }
    const scan = new Scan(c, query, { limit: this.limit, within: top ? top.matches : null, keep: true });
    scan.step();
    const result = scan.result(q);
    this.stack.push({ key: query.key, matches: scan.matches()!, result });
    if (this.stack.length > STACK_MAX) this.stack.shift();
    return result;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Warming the scorer

/** The rows that `warmScorer` scans (in Chrome, 1,000 to 10,000 rows gave the first key the same gain). */
export const WARM_ROWS = 2_000;

/**
 * Score the first `rows` rows of a prepared corpus once, with throwaway queries, so that the first key typed after a
 * surface opens is not the scorer's first run: the blank query that a surface shows first scores nothing, and a
 * JavaScript engine compiles a function well only after it has run for a while. The queries take the two paths of
 * typing: the commonest letter of those rows from scratch, then that letter and the next commonest one within its
 * matches. Nothing is kept. Returns the number of rows scored (0 when the corpus is not prepared or has no letter).
 */
export function warmScorer(corpus: Corpus, rows: number = WARM_ROWS): number {
  if (!corpus.ready) return 0;
  const n = Math.min(corpus.size, Math.max(0, rows));
  const counts = new Int32Array(26);
  for (let i = 0; i < n; i++) {
    const m = corpus.masks[i]!;
    for (let b = 0; b < 26; b++) if (m & (1 << b)) counts[b]!++;
  }
  let first = -1;
  let second = -1;
  for (let b = 0; b < 26; b++) {
    if (counts[b] === 0) continue;
    if (first < 0 || counts[b]! > counts[first]!) {
      second = first;
      first = b;
    } else if (second < 0 || counts[b]! > counts[second]!) second = b;
  }
  if (first < 0) return 0;
  const a = String.fromCharCode(97 + first);
  const scratch = new Scan(corpus, a, { keep: true });
  scratch.step(n);
  const scored = scratch.result().count;
  if (second < 0) return scored;
  const narrowed = new Scan(corpus, a + String.fromCharCode(97 + second), { within: scratch.matches(), keep: true });
  narrowed.step();
  return scored + narrowed.result().count;
}
