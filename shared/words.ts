// The message search's match rules (U5, DESIGN-U5 5 and 6): one pure module that the server (the scan, the ranking,
// the snippets) and the page (the minimum, the marks in a landed row) both import, so both find the same words. No
// DOM, no Bun API, no import from outside shared/.
//
// The rules.
// 1. The fold: shared/match.ts's (one unit per unit: lower case, a precomposed letter to its base, the dotted I to i,
//    the Greek final sigma to sigma).
//    The query loses its combining marks, as parseQuery does; so does the text's fold, which keeps, for each of its
//    units, where that unit is in the text (`at`), so a decomposed é (e and U+0301) and the marks of Devanagari, Thai
//    or Arabic never stop a word from matching. A text with no combining mark keeps a 1:1 fold and no `at`.
// 2. The query's words: runs of letters and digits (\p{L}, \p{N}). Everything else (spaces, punctuation, symbols,
//    emoji) only separates words and is never matched. The first 8 words are used.
// 3. A word start in the text: the text's start; a letter or digit after a character that is not a letter, a digit
//    or a combining mark (a mark continues the letter before it); a capital after a lower-case letter (camelCase);
//    any Han, Hiragana or Katakana character, and a letter after one; and, as for those scripts, any letter of the
//    scripts that write no spaces between words (Thai, Lao, Khmer, Myanmar).
// 4. A query word matches at a word start, as the whole word or as its start (a prefix): `cach` finds `cache` and
//    `caching`, never `recache`. The combining marks that follow the matched letters belong to the match.
// 5. A message matches when every query word matches in it, in any order.
// 6. The minimum: one query word of 2 units or more, or one that holds a Han, Hiragana or Katakana character. Under
//    it (or with no word at all: all punctuation, only emoji) the page asks the server nothing.
// 7. Phrase: 2 or more query words, in order, as consecutive words of the text with only non-word characters between
//    them (none between two words of a script with no spaces); every word but the last is whole there. Whole: every
//    query word matched a whole word somewhere in the message. A message scores 2 x phrase + 1 x whole.
//
// The snippet: the text around the anchor (the phrase's start, else the first match in the text), at most 24 units
// before it, moved forward to a word start, and at most 160 after it, ending at a word end found in its last 20 units,
// else cut hard (never inside a surrogate pair, never between a letter and its marks); a cut start gets a leading
// "…", a cut end a trailing one. `ranges`: every query word's match inside the window, merged where they touch, in
// UTF-16 units of the snippet string (after the leading "…").

import { foldFlat, unitsString } from "./match";

export const WORD_LIMITS = {
  /** The query words used; the rest are ignored. */
  words: 8,
  /** A query word of at least this many UTF-16 units starts the message search (or a Han, Hiragana or Katakana one). */
  minUnits: 2,
  /** The snippet: units before the anchor, units after it, and the last units of the window where a word end is looked for. */
  lead: 24,
  span: 160,
  wordEnd: 20,
} as const;

/** The ellipsis of a cut end. */
export const CUT = "…";

/** A half-open `[start, end)` slice in UTF-16 units. */
export type TextRange = [start: number, end: number];

// ---------------------------------------------------------------------------------------------------------------
// Characters

const LETTER = 1;
const DIGIT = 2;
const MARK = 4;
/** Han, Hiragana or Katakana (the minimum's exception). */
const CJK = 8;
/** A script that writes no spaces between words: each of its letters is a word start. */
const NOSPACE = 16;
const UPPER = 32;
const LOWER = 64;
const KNOWN = 128;
const WORD = LETTER | DIGIT;

const RE_LETTER = /\p{L}/u;
const RE_DIGIT = /\p{N}/u;
const RE_MARK = /\p{M}/u;
const RE_CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const RE_NOSPACE = /[\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const RE_UPPER = /[\p{Lu}\p{Lt}]/u;
const RE_LOWER = /\p{Ll}/u;

function classify(cp: number): number {
  if (cp >= 0xd800 && cp <= 0xdfff) return KNOWN; // a lone surrogate
  const ch = String.fromCodePoint(cp);
  let k = KNOWN;
  if (RE_LETTER.test(ch)) k |= LETTER;
  if (RE_DIGIT.test(ch)) k |= DIGIT;
  if (RE_MARK.test(ch)) k |= MARK;
  if (k & WORD) {
    if (RE_CJK.test(ch)) k |= CJK | NOSPACE;
    else if (RE_NOSPACE.test(ch)) k |= NOSPACE;
    if (RE_UPPER.test(ch)) k |= UPPER;
    else if (RE_LOWER.test(ch)) k |= LOWER;
  }
  return k;
}

/** The kinds of the BMP, filled on first use (0: not known yet). */
const BMP = new Uint8Array(0x10000);
for (let c = 0; c < 0x80; c++) BMP[c] = classify(c);
/** The astral characters seen, at most a few thousand kept. */
const ASTRAL = new Map<number, number>();

function kindOf(cp: number): number {
  if (cp < 0x10000) {
    let k = BMP[cp]!;
    if (k === 0) BMP[cp] = k = classify(cp);
    return k;
  }
  let k = ASTRAL.get(cp);
  if (k === undefined) {
    k = classify(cp);
    if (ASTRAL.size < 4096) ASTRAL.set(cp, k);
  }
  return k;
}

/** The code point that starts at `i` (a lone surrogate is its own). */
function cpAt(s: string, i: number): number {
  const c = s.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
    const d = s.charCodeAt(i + 1);
    if (d >= 0xdc00 && d <= 0xdfff) return ((c - 0xd800) << 10) + (d - 0xdc00) + 0x10000;
  }
  return c;
}

/** The code point that ends at `i` (i > 0). */
function cpBefore(s: string, i: number): number {
  const c = s.charCodeAt(i - 1);
  if (c >= 0xdc00 && c <= 0xdfff && i >= 2) {
    const h = s.charCodeAt(i - 2);
    if (h >= 0xd800 && h <= 0xdbff) return ((h - 0xd800) << 10) + (c - 0xdc00) + 0x10000;
  }
  return c;
}

const cpUnits = (cp: number) => (cp > 0xffff ? 2 : 1);

/** True when `i` is inside a surrogate pair (between its two units). */
function insidePair(s: string, i: number): boolean {
  if (i <= 0 || i >= s.length) return false;
  const h = s.charCodeAt(i - 1);
  const l = s.charCodeAt(i);
  return h >= 0xd800 && h <= 0xdbff && l >= 0xdc00 && l <= 0xdfff;
}

/** The kind of the character before `i`, past any combining marks (the letter they belong to); 0 at the start. */
function baseKindBefore(s: string, i: number): number {
  let j = i;
  while (j > 0) {
    const cp = cpBefore(s, j);
    const k = kindOf(cp);
    if (!(k & MARK)) return k;
    j -= cpUnits(cp);
  }
  return 0;
}

/** Rule 3: whether a word starts at text index `j` (the index of a letter or a digit). */
function startsWord(s: string, j: number): boolean {
  if (j <= 0) return true;
  const k = kindOf(cpAt(s, j));
  if (k & NOSPACE) return true;
  const p = baseKindBefore(s, j);
  if (!(p & WORD)) return true;
  if (p & NOSPACE) return true;
  return (k & UPPER) !== 0 && (p & LOWER) !== 0;
}

/** Whether a word ends at text index `e` (after its last letter, digit or mark). */
function endsWord(s: string, e: number): boolean {
  if (e <= 0 || e >= s.length) return true;
  const k = kindOf(cpAt(s, e));
  if (k & MARK) return false;
  if (!(k & WORD)) return true;
  if (k & NOSPACE) return true;
  const p = baseKindBefore(s, e);
  if (!(p & WORD) || p & NOSPACE) return true;
  return (k & UPPER) !== 0 && (p & LOWER) !== 0;
}

// ---------------------------------------------------------------------------------------------------------------
// The query

export interface WordQuery {
  /** The query's words, folded and with no combining marks: at most 8, in the query's order. */
  readonly words: readonly string[];
  /** Rule 6: whether the message search runs for this query. */
  readonly asks: boolean;
}

const MARKS_G = /\p{M}/gu;
const WORD_RUN = /[\p{L}\p{N}]+/gu;
const HAS_CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** The query's words (rule 2) and whether it reaches the minimum (rule 6). */
export function wordQuery(q: string): WordQuery {
  const f = foldFlat(q).replace(MARKS_G, "");
  const words: string[] = [];
  for (const m of f.matchAll(WORD_RUN)) {
    if (words.length === WORD_LIMITS.words) break;
    words.push(m[0]);
  }
  return { words, asks: words.some((w) => w.length >= WORD_LIMITS.minUnits || HAS_CJK.test(w)) };
}

/** Rule 6: whether `q` searches messages (the page asks the server only then). */
export function asksMessages(q: string): boolean {
  return wordQuery(q).asks;
}

/** A run of letters, digits and marks (a mark joins the letters around it, as rule 2 drops it). */
const WORD_SPAN = /[\p{L}\p{N}\p{M}]+/gu;
const HAS_WORD = /[\p{L}\p{N}]/u;

/**
 * The query as the page sends it, which the server takes up to `maxUnits` UTF-16 units: the words that rule 2 uses
 * (the first 8), each as it was typed, one space between them, cut at `maxUnits` (never inside a surrogate pair). It
 * has the query's words, so it finds what the query finds; only a cut can shorten the last word to its start (a
 * prefix). Its other characters (punctuation, control characters, runs of space) only separated words.
 */
export function queryText(q: string, maxUnits: number): string {
  const f = foldFlat(q);
  const parts: string[] = [];
  for (const m of f.matchAll(WORD_SPAN)) {
    if (parts.length === WORD_LIMITS.words) break;
    const at = m.index ?? 0;
    if (HAS_WORD.test(m[0])) parts.push(q.slice(at, at + m[0].length));
  }
  const out = parts.join(" ");
  if (out.length <= maxUnits) return out;
  return out.slice(0, insidePair(out, maxUnits) ? maxUnits - 1 : maxUnits).trimEnd();
}

// ---------------------------------------------------------------------------------------------------------------
// A text

export interface WordText {
  /** The text as the snippet shows it. */
  readonly text: string;
  /** Its fold (rule 1), with its combining marks taken out when it has any. */
  readonly fold: string;
  /** Where fold unit i is in the text, and `at[fold.length]` is the text's length; null when the fold is 1:1. */
  readonly at: Int32Array | null;
}

const HAS_MARK = /\p{M}/u;

/** A text prepared for matching: kept once per message by the server, made per text node by the page. */
export function wordText(text: string): WordText {
  const f = foldFlat(text);
  if (!HAS_MARK.test(text)) return { text, fold: f, at: null };
  const units = new Uint16Array(f.length);
  const at = new Int32Array(f.length + 1);
  let n = 0;
  for (let i = 0; i < text.length; ) {
    const cp = cpAt(text, i);
    const len = cpUnits(cp);
    if (!(kindOf(cp) & MARK)) {
      for (let u = 0; u < len; u++) {
        units[n] = f.charCodeAt(i + u);
        at[n++] = i + u;
      }
    }
    i += len;
  }
  at[n] = text.length;
  return { text, fold: unitsString(units, n), at: at.slice(0, n + 1) };
}

/** The UTF-16 units that a prepared text holds, its `at` counted as 2 units a value (the server's memory estimate). */
export function wordTextUnits(t: WordText): number {
  return t.text.length + t.fold.length + (t.at ? 2 * t.at.length : 0);
}

/** The text index of fold index `i`. */
const textAt = (t: WordText, i: number): number => (t.at ? t.at[i]! : i);

/** The first fold index whose text index is at least `j`. */
function foldAt(t: WordText, j: number): number {
  const at = t.at;
  if (!at) return Math.max(0, Math.min(j, t.fold.length));
  let lo = 0;
  let hi = t.fold.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (at[mid]! < j) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Whether `w` matches at fold index `i` (rule 4). */
function matchesAt(t: WordText, w: string, i: number): boolean {
  return t.fold.startsWith(w, i) && startsWord(t.text, textAt(t, i));
}

/** The first fold index at or after `from` where `w` matches, or -1. */
function nextMatch(t: WordText, w: string, from: number): number {
  const f = t.fold;
  for (let i = f.indexOf(w, from); i >= 0; i = f.indexOf(w, i + 1)) if (startsWord(t.text, textAt(t, i))) return i;
  return -1;
}

/** Whether the match of `w` at fold index `i` is a whole word. */
function wholeAt(t: WordText, w: string, i: number): boolean {
  return endsWord(t.text, textAt(t, i + w.length));
}

/** The fold index past the non-word characters from `p`. */
function skipSeparators(t: WordText, p: number): number {
  const f = t.fold;
  while (p < f.length) {
    const cp = cpAt(f, p);
    if (kindOf(cp) & WORD) break;
    p += cpUnits(cp);
  }
  return p;
}

/** Rule 7: the fold index where the query's words first stand as a phrase, or -1. */
function phraseAt(t: WordText, words: readonly string[]): number {
  const first = words[0]!;
  for (let i = nextMatch(t, first, 0); i >= 0; i = nextMatch(t, first, i + 1)) {
    let pos = i;
    let ok = true;
    for (let k = 0; k < words.length; k++) {
      const w = words[k]!;
      if (k > 0 && !matchesAt(t, w, pos)) {
        ok = false;
        break;
      }
      if (k === words.length - 1) break;
      if (!wholeAt(t, w, pos)) {
        ok = false;
        break;
      }
      pos = skipSeparators(t, pos + w.length);
    }
    if (ok) return i;
  }
  return -1;
}

export interface TextMatch {
  phrase: boolean;
  whole: boolean;
  /** The snippet's anchor, a text index: the phrase's start, else the first match in the text. */
  anchor: number;
}

/** Rule 5: the message's match, or null when a query word is not in it (or the query has no word). */
export function matchText(t: WordText, q: WordQuery): TextMatch | null {
  const words = q.words;
  if (words.length === 0) return null;
  const firsts: number[] = [];
  for (const w of words) {
    const i = nextMatch(t, w, 0);
    if (i < 0) return null;
    firsts.push(i);
  }
  let whole = true;
  for (let k = 0; k < words.length && whole; k++) {
    const w = words[k]!;
    let found = false;
    for (let i = firsts[k]!; i >= 0 && !found; i = nextMatch(t, w, i + 1)) found = wholeAt(t, w, i);
    whole = found;
  }
  let anchor = Math.min(...firsts);
  let phrase = false;
  if (words.length >= 2) {
    const p = phraseAt(t, words);
    if (p >= 0) {
      phrase = true;
      anchor = p;
    }
  }
  return { phrase, whole, anchor: textAt(t, anchor) };
}

/** Rule 7's score: 2 for a phrase, 1 for whole words. */
export function matchScore(m: TextMatch): number {
  return (m.phrase ? 2 : 0) + (m.whole ? 1 : 0);
}

/** Ascending, merged where they touch or overlap. */
function merged(ranges: TextRange[]): TextRange[] {
  if (ranges.length === 0) return ranges;
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: TextRange[] = [[ranges[0]![0], ranges[0]![1]]];
  for (let k = 1; k < ranges.length; k++) {
    const last = out[out.length - 1]!;
    const r = ranges[k]!;
    if (r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/**
 * Every match of every query word in the text, as text ranges (the marks that follow a match are in it), cut to
 * `[from, to)`, ascending and merged where they touch: the snippet's marks, and the page's marks in a landed row.
 */
export function matchRanges(t: WordText, q: WordQuery, from = 0, to = t.text.length): TextRange[] {
  const out: TextRange[] = [];
  if (to <= from) return out;
  const f0 = foldAt(t, from);
  const f1 = foldAt(t, to);
  for (const w of q.words) {
    for (let i = nextMatch(t, w, Math.max(0, f0 - w.length + 1)); i >= 0 && i < f1; i = nextMatch(t, w, i + 1)) {
      const s = Math.max(from, textAt(t, i));
      const e = Math.min(to, textAt(t, i + w.length));
      if (e > s) out.push([s, e]);
    }
  }
  return merged(out);
}

/** The page's marks in one text (a text node of a landed row): `matchRanges` of a fresh prepared text. */
export function markRanges(text: string, q: string | WordQuery): TextRange[] {
  const query = typeof q === "string" ? wordQuery(q) : q;
  if (query.words.length === 0 || !text) return [];
  return matchRanges(wordText(text), query);
}

// ---------------------------------------------------------------------------------------------------------------
// The snippet

export interface Snippet {
  snippet: string;
  /** Into `snippet`, after its leading "…". */
  ranges: TextRange[];
}

/** The start of the code point before `i`. */
const prevStart = (s: string, i: number) => i - cpUnits(cpBefore(s, i));

/** The window's start: at most `lead` units before the anchor, moved forward to a word start. */
function windowStart(s: string, anchor: number): number {
  let p = Math.max(0, anchor - WORD_LIMITS.lead);
  if (p === 0) return 0;
  if (insidePair(s, p)) p++;
  while (p < anchor) {
    const cp = cpAt(s, p);
    if (kindOf(cp) & WORD && startsWord(s, p)) return p;
    p += cpUnits(cp);
  }
  return anchor;
}

/** The window's end: the text's end when it is near, else a word end in the window's last units, else a hard cut. */
function windowEnd(s: string, anchor: number): number {
  const limit = anchor + WORD_LIMITS.span;
  if (limit >= s.length) return s.length;
  const floor = Math.max(anchor + 1, limit - WORD_LIMITS.wordEnd);
  for (let e = limit; e >= floor; e--) {
    if (insidePair(s, e)) continue;
    if (kindOf(cpBefore(s, e)) & (WORD | MARK) && endsWord(s, e)) return e;
  }
  let e = limit;
  if (insidePair(s, e)) e--;
  // Never between a letter and its marks: the letter and its marks go together.
  while (e > anchor && kindOf(cpAt(s, e)) & MARK) e = prevStart(s, e);
  // A window of nothing but marks after the anchor: the hard cut as it is.
  return e > anchor ? e : insidePair(s, limit) ? limit - 1 : limit;
}

/** The snippet of a prepared text for the query, around `anchor` (matchText's). */
export function snippetOf(t: WordText, q: WordQuery, anchor: number): Snippet {
  const s = t.text;
  const a = Math.max(0, Math.min(anchor, s.length));
  const start = windowStart(s, a);
  let end = windowEnd(s, a);
  const cutEnd = end < s.length;
  let body = s.slice(start, end);
  if (cutEnd) {
    const trimmed = body.replace(/\s+$/u, "");
    end -= body.length - trimmed.length;
    body = trimmed;
  }
  const lead = start > 0 ? CUT : "";
  const shift = lead.length - start;
  const ranges = matchRanges(t, q, start, end).map(([x, y]): TextRange => [x + shift, y + shift]);
  return { snippet: lead + body + (cutEnd ? CUT : ""), ranges };
}
