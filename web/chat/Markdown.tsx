// The safe markdown renderer (DESIGN.md 6.3). marked's Lexer tokens are walked into React elements, so React escapes
// every piece of model text; marked's own HTML output is never used and nothing here sets innerHTML. Raw HTML shows as
// text. Only http, https and mailto links become links, and they open in a new tab with noopener noreferrer; any other
// link shows its text plus "(href)". Images never load: they show as "[image: alt]". A code fence gets its language,
// a Copy icon button and highlight.js colours; the colours are kept only when highlight.js returned nothing but its
// own spans, which are rebuilt as React elements (never inserted as HTML).
//
// Row 79, smooth text: a live reply reveals inside its rendered blocks. The walk counts the visible characters of the
// rendered reply (its units: the text as it shows, one for each checkbox, rule and line break) and draws only what is
// before the reveal's cut, in whole words (in Chinese or Japanese, the words Intl.Segmenter finds: wordBreaks below);
// the words that came into view a moment ago are wrapped in a span that fades
// in (chat.css .chat-word-in). The cut never shows a block in a form the whole reply would not have: a code block grows
// inside its box, a table shows whole rows, and an empty element is never drawn ahead of its text: an element with
// parts of its own (a bullet, a task's box, an inline code pill, a quote's rule, a code box) comes with its first word
// and fades in whole while that word is new (enterWhole). A span keeps its key until its fade is over, so no word fades
// in twice. While the reply streams, its live end waits for what would change its form (holdPartial). A reply is lexed
// once per piece that came, from its last two blocks (the blocks before them keep their tokens, so they do not draw
// again), and each frame draws only the blocks around the cut.
import { Fragment, memo, useMemo, useRef, type ClipboardEvent, type ReactNode } from "react";
import { Lexer, type Token, type Tokens, type TokensList } from "marked";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { CopyButton } from "../ui/Copy";

const GRAMMARS = { bash, c, cpp, csharp, css, diff, dockerfile, go, ini, java, javascript, json, kotlin, makefile, markdown, plaintext, python, ruby, rust, shell, sql, swift, typescript, xml, yaml };
for (const [name, grammar] of Object.entries(GRAMMARS)) if (!hljs.getLanguage(name)) hljs.registerLanguage(name, grammar);

// ---------- text helpers ----------

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", copy: "©", reg: "®", trade: "™",
  hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  laquo: "«", raquo: "»", bull: "•", middot: "·", times: "×", divide: "÷", deg: "°",
  plusmn: "±", micro: "µ", para: "¶", sect: "§", euro: "€", pound: "£", yen: "¥",
  cent: "¢", larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔", rArr: "⇒",
  lArr: "⇐", le: "≤", ge: "≥", ne: "≠", asymp: "≈", infin: "∞", minus: "−",
  check: "✓", shy: "\u00ad",
};

/** Decode the character references that CommonMark decodes in text. The result is rendered as text, never as HTML. */
export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g, (whole, body: string) => {
    if (body[0] === "#") {
      const cp = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(cp) || cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "\ufffd";
      return String.fromCodePoint(cp);
    }
    return NAMED[body] ?? whole;
  });
}

/** The one link rule: http, https and mailto only. Returns the href to use, or null for "show it as text". */
export function safeHref(href: string | null | undefined): string | null {
  const h = (href ?? "").trim();
  if (!/^(https?:|mailto:)/i.test(h)) return null;
  try {
    const u = new URL(h);
    return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:" ? h : null;
  } catch {
    return null;
  }
}

// ---------- words: the reveal's unit ----------
//
// FIX-Q1: a reveal shows whole words. A space or a line break ends a word, as before. Chinese and Japanese (and the
// other scripts written without spaces) have none between their words, so there a word also ends where
// Intl.Segmenter finds one (one or two characters, mostly): a word end inside a run of text without spaces, next to a
// character of such a script. A word keeps the punctuation after it and the opening bracket before it, and no word
// ends right after an ASCII mark, so the live end never stops just after a mark whose meaning waits for what follows
// it (holdPartial). English and Korean, whose words are space-separated, keep today's words, and where Segmenter is
// missing every text does.
//
// Q1 review: Segmenter's word ends are not stable while a text grows: an end near the live end goes when the next
// character joins two segments into one word (とき, then ときどき; 書き, then 書き込み). What has shown never goes (row 79):
// the live end never stops before where it stopped (holdWord's `shown`), and in a live block a text that grew keeps the
// word ends it had, its old end among them, and only its new part is segmented (WordMemo), so the work per piece is
// the piece's. The memo is the block's own (its pacer's), since the same text in another reply grew another way.

/**
 * A character of those scripts (by its Script, not Script_Extensions, which give Han a middle dot and combining marks
 * that Latin text has too), the kana marks (ー, ・, the voiced marks), CJK punctuation and the fullwidth forms (，：（）).
 */
const SPACELESS = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Thai}\p{sc=Lao}\p{sc=Khmer}\p{sc=Myanmar}\u3000-\u30ff\uff00-\uffef]/u;
const OPENER = /[\p{Open_Punctuation}\p{Initial_Punctuation}]/u;
const ASCII_MARK = /[!-/:-@[-`{-~]/;
const NO_BREAKS: readonly number[] = [];

let segmenterOf: unknown = null;
let segmenter: Intl.Segmenter | null = null;
/** Each text's word ends inside its runs, by its content, for the texts drawn lately (a frame looks them up). */
const BREAKS = new Map<string, readonly number[]>();
/** The texts in BREAKS, at most this many characters together. */
const MAX_BREAK_CHARS = 1 << 18;
let breakChars = 0;

/**
 * A live block's word ends, by where each of its texts starts (its place in the block's units; a highlighted code
 * box's pieces apart), kept with the block's pacer (reveal.ts) while the block reveals. A text that grew (its live end,
 * a piece later) keeps the ends it had, and its old end, since all of it may have shown: what showed only grows.
 */
export type WordMemo = Map<string, { text: string; breaks: readonly number[] }>;
/** The texts a memo keeps, the ones used last: the live end is used at every frame. */
const MAX_MEMO = 64;
/** How many characters before a grown text's old end are segmented again with its new part: the first new word's context. */
const CONTEXT = 32;

/** Where a text's word ends come from: a live block's memo under the text's place, or (none) the cache by content. */
interface Place {
  memo: WordMemo;
  key: string;
}

/** The word segmenter, or null where the browser has none (a test may take it away, and the cache goes with it). */
function wordSegmenter(): Intl.Segmenter | null {
  const S = typeof Intl === "undefined" ? undefined : (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (S !== segmenterOf) {
    segmenterOf = S;
    segmenter = typeof S === "function" ? new S(undefined, { granularity: "word" }) : null;
    BREAKS.clear();
    breakChars = 0;
  }
  return segmenter;
}

const isWs = (ch: string | undefined) => ch === " " || ch === "\n" || ch === "\t" || ch === "\r" || ch === "\f";
const isSpace = (ch: string | undefined) => isWs(ch) || ch === "\u00a0";
const isLow = (s: string, i: number) => {
  const c = s.charCodeAt(i);
  return c >= 0xdc00 && c <= 0xdfff;
};

/** The code point that ends just before `i`, as a string (a surrogate pair whole). */
function before(s: string, i: number): string {
  return isLow(s, i - 1) && i >= 2 ? s.slice(i - 2, i) : s.charAt(i - 1);
}

/** Whether a word may end at `b` in `s`: inside a run, next to a character of a script without spaces. */
function runBreak(s: string, b: number): boolean {
  return b > 0 && b < s.length && !isSpace(s[b - 1]) && !isSpace(s[b]) && (SPACELESS.test(before(s, b)) || SPACELESS.test(String.fromCodePoint(s.codePointAt(b)!)));
}

/**
 * The word ends that Segmenter finds inside the runs of `s` that hold a character of a script without spaces, from
 * `from` on (the text before it is not segmented; `from` itself is no end).
 */
function segmentBreaks(seg: Intl.Segmenter, s: string, from = 0): number[] {
  const out: number[] = [];
  for (const g of seg.segment(from ? s.slice(from) : s)) {
    const b = from + g.index;
    if (b === from || !runBreak(s, b)) continue;
    const p = before(s, b);
    if (OPENER.test(p) || ASCII_MARK.test(p)) continue;
    if (g.isWordLike || OPENER.test(String.fromCodePoint(s.codePointAt(b)!))) out.push(b);
  }
  return out;
}

/** The word ends of `s`, from the cache by content (segmented whole the first time). */
function wordBreaks(seg: Intl.Segmenter, s: string): readonly number[] {
  let b = BREAKS.get(s);
  if (b) {
    BREAKS.delete(s);
  } else {
    b = SPACELESS.test(s) ? segmentBreaks(seg, s) : NO_BREAKS;
    breakChars += s.length;
  }
  BREAKS.set(s, b);
  while (breakChars > MAX_BREAK_CHARS && BREAKS.size > 1) {
    const old = BREAKS.keys().next().value!;
    BREAKS.delete(old);
    breakChars -= old.length;
  }
  return b;
}

/**
 * The word ends of `s`, which grew from `was` (whose ends are `ends`): those ends as they were and `was`'s end, then
 * Segmenter's ends in the new part, segmented from a little before it (the work is the new part's, not the text's).
 */
function grownBreaks(seg: Intl.Segmenter, s: string, was: string, ends: readonly number[]): readonly number[] {
  const end = was.length;
  const out = ends.slice();
  if (runBreak(s, end)) out.push(end);
  let from = Math.max(0, end - CONTEXT);
  if (from > 0 && isLow(s, from)) from--;
  if (SPACELESS.test(s.slice(from))) for (const b of segmentBreaks(seg, s, from)) if (b > end) out.push(b);
  return out;
}

/** Where words end inside the runs of `s` besides its spaces (ascending): from its block's memo, or by content. */
function endsOf(s: string, at?: Place): readonly number[] {
  const seg = wordSegmenter();
  if (!seg) return NO_BREAKS;
  if (!at) return wordBreaks(seg, s);
  const e = at.memo.get(at.key);
  const breaks = e && e.text === s ? e.breaks : e && s.length > e.text.length && s.startsWith(e.text) ? grownBreaks(seg, s, e.text, e.breaks) : wordBreaks(seg, s);
  at.memo.delete(at.key);
  at.memo.set(at.key, { text: s, breaks });
  if (at.memo.size > MAX_MEMO) at.memo.delete(at.memo.keys().next().value!);
  return breaks;
}

/** Whether a word may end inside s[from, to] (a character of a script without spaces is there, and Segmenter is). */
function mayBreak(s: string, from: number, to: number): boolean {
  return to > from && SPACELESS.test(s.slice(from, to + 2)) && wordSegmenter() !== null;
}

/** How many of the ascending `bs` are at or before `at`. */
function countTo(bs: readonly number[], at: number): number {
  let lo = 0;
  let hi = bs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bs[mid]! <= at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The last word end inside a run, after `from` and at or before `to`, or -1. */
function lastBreak(s: string, from: number, to: number, at?: Place): number {
  if (!mayBreak(s, from, to)) return -1;
  const bs = endsOf(s, at);
  const n = countTo(bs, to);
  return n > 0 && bs[n - 1]! > from ? bs[n - 1]! : -1;
}

/** How far back from a point a space is looked for before a word end in its run is (a run's words are short). */
const SCAN = 64;

/**
 * Where the word that holds `to` starts: at `to` when a space is there, else after the last space before it, or at
 * the last word end in its run at or before `to`. A long run without spaces (Chinese, Japanese) is not walked to its
 * start when a word end near `to` is there: the cost per frame stays the word's, not the paragraph's.
 */
function wordStartAt(s: string, to: number, at?: Place): number {
  if (isSpace(s[to])) return to;
  let q = to;
  const near = Math.max(0, to - SCAN);
  while (q > near && !isSpace(s[q - 1])) q--;
  if (q === near && near > 0 && !isSpace(s[near - 1])) {
    const b = lastBreak(s, near - 1, to, at);
    if (b >= 0) return b;
    while (q > 0 && !isSpace(s[q - 1])) q--;
  }
  return q < to ? Math.max(q, lastBreak(s, q, to, at)) : q;
}

/** The first word end inside s(from, to), or -1. */
function firstBreak(s: string, from: number, to: number, at?: Place): number {
  if (!mayBreak(s, from, to)) return -1;
  const bs = endsOf(s, at);
  const k = countTo(bs, from);
  return k < bs.length && bs[k]! < to ? bs[k]! : -1;
}

/** The word ends inside s(from, to), ascending. */
function breaksIn(s: string, from: number, to: number, at?: Place): readonly number[] {
  if (!mayBreak(s, from, to)) return NO_BREAKS;
  const bs = endsOf(s, at);
  const a = countTo(bs, from);
  const b = countTo(bs, to - 1);
  return a < b ? bs.slice(a, b) : NO_BREAKS;
}

// ---------- the live end of a streaming reply ----------
//
// While a reply streams, its end waits for what would change its form, so that what shows only grows and never
// shows a half-parsed form (row 79; also under Reduce motion, which shows the rest at once): a table until its
// separator row (and a row until its line ends), the last word until a space or a line break comes after it (in
// Chinese or Japanese, until the next word starts), an inline code span, emphasis or a link until its closing mark,
// and a line that holds only its block's markers (a bullet, a task's box, a heading's #, a quote's >) until its first
// word. The whole text shows when the block ends.

/** How far back an unclosed inline mark is waited for; one that stays open longer is text, and shows. */
const INLINE_WAIT = 200;

/** A trailing table waits for its separator row, and a table's last row for the end of its line, so pipes never show. */
function holdTable(src: string): string {
  const lines = src.split("\n");
  const ended = lines.length > 1 && lines[lines.length - 1] === "";
  const last = ended ? lines.length - 1 : lines.length;
  let k = last;
  while (k > 0 && /^\s*\|/.test(lines[k - 1]!)) k--;
  const tail = lines.slice(k, last);
  if (!tail.length) return src;
  const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").length;
  const sep = tail[1];
  const done = sep !== undefined && /^\s*\|?[\s:|-]+\|?\s*$/.test(sep) && /-/.test(sep) && cells(sep) >= cells(tail[0]!);
  if (!done) return lines.slice(0, k).join("\n");
  // A row whose line has not ended yet may still grow a cell.
  return !ended && tail.length > 2 ? lines.slice(0, last - 1).join("\n") + "\n" : src;
}

/** How much of the end of the last run holdWord segments: enough for its last words, so the work is the same per piece. */
const HOLD_WINDOW = 48;

/**
 * The text up to its last word: a word at the end waits until it is whole (a space, a line break or the next word came).
 * `shown`: what this returned for the text before this piece. The end never goes back before it while the text goes on
 * from it, though Segmenter's word end there went (とき, then ときどき): what showed stays.
 */
export function holdWord(src: string, shown?: string): string {
  if (!src || isWs(src[src.length - 1])) return src;
  // Once per piece that came: only the end of the last run is segmented, and only when it holds a script without
  // spaces; the run is walked to its start only when that end holds no word end (a long token).
  let from = Math.max(0, src.length - HOLD_WINDOW);
  if (from > 0 && isLow(src, from)) from--;
  let i = src.length - 1;
  while (i >= from && !isWs(src[i])) i--;
  let end = i + 1;
  const seg = SPACELESS.test(src.slice(end)) ? wordSegmenter() : null;
  const last = seg ? segmentBreaks(seg, src, end).at(-1) : undefined;
  if (last !== undefined) end = last;
  else if (i < from) {
    while (i >= 0 && !isWs(src[i])) i--;
    end = i + 1;
  }
  if (shown && shown.length > end && src.startsWith(shown)) end = shown.length;
  return src.slice(0, end);
}

/** Where the last paragraph starts (after a blank line or at a line that starts a block), or -1 inside an open code fence. */
function liveParagraph(src: string): number {
  let fence: string | null = null;
  let start = 0;
  let at = 0;
  for (const line of src.split("\n")) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length && !line.slice(f[0].length).trim()) {
        fence = null;
        start = at + line.length + 1;
      }
    } else if (f) {
      fence = f[1]!;
    } else if (!line.trim()) start = at + line.length + 1;
    else if (/^\s*(?:[-*+]\s|\d{1,9}[.)]\s|>|#{1,6}(?:\s|$))/.test(line)) start = at;
    at += line.length + 1;
  }
  return fence !== null ? -1 : Math.min(start, src.length);
}

const isAlnum = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

/**
 * Where an inline mark that is still open at the end of `s` starts (code, emphasis, a link), or -1. `s` ends at a space
 * (holdWord), so a mark's next character has always come.
 */
function openInline(s: string): number {
  const open: Record<string, number> = {};
  const brackets: number[] = [];
  let hold = -1;
  const at = (i: number) => {
    if (hold < 0 || i < hold) hold = i;
  };
  for (let i = 0; i < s.length; ) {
    const ch = s[i]!;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") {
      let n = 1;
      while (s[i + n] === "`") n++;
      // A code span closes with a run of the same length; inside it nothing else is a mark.
      let j = i + n;
      let close = -1;
      while (j < s.length) {
        const k = s.indexOf("`", j);
        if (k < 0) break;
        let m = 1;
        while (s[k + m] === "`") m++;
        if (m === n) {
          close = k + m;
          break;
        }
        j = k + m;
      }
      if (close < 0) {
        at(i);
        break;
      }
      i = close;
      continue;
    }
    if (ch === "*" || ch === "_" || ch === "~") {
      let n = 1;
      while (s[i + n] === ch) n++;
      const prev = s[i - 1];
      const next = s[i + n];
      // A run opens before a word and closes after one; "_" never opens or closes inside a word.
      const canOpen = next !== undefined && !isWs(next) && (ch !== "_" || !isAlnum(prev));
      const canClose = prev !== undefined && !isWs(prev) && (ch !== "_" || !isAlnum(next));
      if (open[ch] !== undefined && canClose) delete open[ch];
      else if (canOpen && open[ch] === undefined) open[ch] = i;
      i += n;
      continue;
    }
    if (ch === "[") {
      brackets.push(s[i - 1] === "!" ? i - 1 : i);
      i++;
      continue;
    }
    if (ch === "]" && brackets.length) {
      const o = brackets.pop()!;
      if (s[i + 1] === "(") {
        let depth = 0;
        let j = i + 1;
        for (; j < s.length; j++) {
          if (s[j] === "(") depth++;
          else if (s[j] === ")" && --depth === 0) break;
        }
        if (j >= s.length) {
          at(o);
          break;
        }
        i = j + 1;
        continue;
      }
    }
    i++;
  }
  for (const v of Object.values(open)) at(v);
  for (const b of brackets) at(b);
  return hold >= 0 && s.length - hold <= INLINE_WAIT ? hold : -1;
}

/** A last line of only its block's markers (a bullet, a number, a task's box, a quote's >, a heading's #) waits. */
function holdMarkers(src: string): string {
  const nl = src.lastIndexOf("\n") + 1;
  const line = src.slice(nl);
  return line && /^[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]*)?|>[ \t]*|#{1,6}[ \t]*)+$/.test(line) ? src.slice(0, nl) : src;
}

/**
 * The part of a streaming reply that shows now: everything but a live end that would change its form. `shown`: what
 * this returned for the reply before this piece (useMarkdownModel), so the live end never goes back (holdWord).
 */
export function holdPartial(src: string, shown?: string): string {
  let s = holdTable(holdWord(src, shown));
  const para = liveParagraph(s);
  if (para >= 0) {
    const o = openInline(s.slice(para));
    if (o >= 0) s = s.slice(0, para + o);
  }
  return holdMarkers(s);
}

// ---------- the reveal's cut ----------

/**
 * Where a live block's reveal stands, in its units: what shows (`end`), from where words still fade in (`fade`), and
 * what showed at each frame since then (`marks`, ascending): the words that came into view in one frame fade together.
 */
export interface RevealCut {
  end: number;
  fade: number;
  marks?: readonly number[];
  /** The block's word ends, kept with its pacer, so that a text that grows keeps them (WordMemo). */
  words?: WordMemo;
}

const NO_MARKS: readonly number[] = [];

/** The walk's cursor: the units passed so far, the cut, the fade's edge and marks, and whether the cut was reached. */
interface Cut {
  pos: number;
  end: number;
  fade: number;
  marks: readonly number[];
  done: boolean;
  words?: WordMemo;
}

/** A block's own share of the cut: where it starts in the reply's units, and whether it fades in whole (a code box). */
interface CutAt {
  pos: number;
  end: number;
  fade: number;
  marks: readonly number[];
  whole?: boolean;
  words?: WordMemo;
}

const cutOf = (at: CutAt | undefined): Cut | null => (at ? { pos: at.pos, end: at.end, fade: at.fade, marks: at.marks, done: false, words: at.words } : null);

/** The place of a text that starts at `pos` in a live block whose memo is `words` (`kind`: a highlighted code box's pieces). */
const placeOf = (words: WordMemo | undefined, pos: number, kind = ""): Place | undefined => (words ? { memo: words, key: kind + pos } : undefined);

/** The frame a word that ends at `end` came into view in: the first mark at or past it (the marks' count: this one). */
function frameOf(marks: readonly number[], end: number): number {
  for (let i = 0; i < marks.length; i++) if (marks[i]! >= end) return i;
  return marks.length;
}
/** How much of `s` shows when `room` of its characters are revealed: whole words only (a word shows once it all came). */
export function wholeWords(s: string, room: number, at?: Place): number {
  if (room >= s.length) return s.length;
  if (room <= 0) return 0;
  return wordStartAt(s, room, at);
}

/**
 * A piece of text in the walk: all of it without a cut; with one, the whole words before the cut, and the words that
 * end after the fade's edge in spans that fade in, one span for the words of each frame. Null: nothing of it shows.
 */
function leaf(s: string, c: Cut | null, k: string, kind = ""): ReactNode {
  if (!c) return s;
  if (c.done) return null;
  const p = c.pos;
  c.pos += s.length;
  let n = s.length;
  if (c.pos > c.end) {
    n = wholeWords(s, c.end - p, placeOf(c.words, p, kind));
    c.done = true;
  }
  if (n <= 0) return null;
  const shown = n === s.length ? s : s.slice(0, n);
  const f = c.fade - p;
  if (f >= n) return shown;
  const place = placeOf(c.words, p, kind);
  // The word that holds the fade's edge fades whole. An edge on a space moves on to the next word: the first fading
  // span then always starts where that word's span started, so it keeps its key and React keeps it (and its fade).
  let q = wordStartAt(s, Math.max(0, f), place);
  while (q < n && isSpace(shown[q])) q++;
  const parts: ReactNode[] = q > 0 ? [shown.slice(0, q)] : [];
  const fading = (from: number, to: number) =>
    parts.push(
      <span key={p + from} className="chat-word-in">
        {shown.slice(from, to)}
      </span>,
    );
  let at = q;
  let from = q;
  let frame = -1;
  /** The word that ends at `end` (the spaces after it run to `next`): a new span when it came in another frame. */
  const word = (end: number, next: number) => {
    const its = frameOf(c.marks, p + end);
    if (its !== frame && at > from) {
      fading(from, at);
      from = at;
    }
    frame = its;
    at = next;
  };
  const cuts = breaksIn(s, q, n, place);
  let ci = 0;
  for (const w of shown.slice(q).match(/\s*\S+\s*/g) ?? []) {
    const start = at;
    const end = start + w.trimEnd().length;
    // The words inside a run without spaces (Chinese, Japanese), then the last of the run with its spaces.
    for (; ci < cuts.length && cuts[ci]! < end; ci++) if (cuts[ci]! > at) word(cuts[ci]!, cuts[ci]!);
    word(end, start + w.length);
  }
  if (at > from) fading(from, at);
  if (at < n) parts.push(shown.slice(at));
  return <Fragment key={k}>{parts}</Fragment>;
}

/** A thing of one unit (a checkbox, a rule, a line break): "skip" past the cut, "new" while it fades in. */
function unit(c: Cut | null): "skip" | "show" | "new" {
  if (!c) return "show";
  if (c.done) return "skip";
  const p = c.pos++;
  if (p >= c.end) {
    c.done = true;
    return "skip";
  }
  return p + 1 > c.fade ? "new" : "show";
}

/** A thing that shows whole or not at all (a table row): null past the cut, else whether it fades in. */
function atomic(c: Cut | null, n: number): boolean | null {
  if (!c) return false;
  if (c.done) return null;
  c.pos += n;
  if (c.pos > c.end) {
    c.done = true;
    return null;
  }
  return c.pos > c.fade;
}

/** Where the first word of `s` ends (after any spaces before it), or null when `s` has no word. */
function wordEnd(s: string, at?: Place): number | null {
  let i = 0;
  while (i < s.length && isSpace(s[i])) i++;
  if (i >= s.length) return null;
  const from = i;
  // A run's first word ends near its start: a long run without spaces is walked to its end only when none does.
  for (let stop = from + SCAN; ; stop = s.length) {
    while (i < stop && i < s.length && !isSpace(s[i])) i++;
    const b = firstBreak(s, from, i, at);
    if (b >= 0) return b;
    if (i >= s.length || isSpace(s[i])) return i;
  }
}

/**
 * An element with parts of its own (a list item's bullet and box, an inline code pill, a quote's rule, a code box)
 * at the walk's cursor, whose first word ends `lead` units on: while that word is new, the element fades in whole (its
 * opacity, chat.css .chat-block-in), and the words that came into view with it draw plain inside it, so its parts and
 * its first words come in together. Returns the fade's edge to put back after the element, or null when it is not new.
 * The edge it sets is the frame's mark of that first word, which is the edge the cut reaches once the element is no
 * longer new: its words keep their form (and their spans' keys) across that frame.
 */
function enterWhole(c: Cut | null, lead: number | null): number | null {
  if (!c || c.done || lead === null) return null;
  const first = c.pos + lead;
  if (first <= c.fade) return null;
  const was = c.fade;
  c.fade = Math.max(c.fade, c.marks[frameOf(c.marks, first)] ?? c.end);
  return was;
}

/** Plain text (thinking) under a reveal's cut, or all of it. */
export function revealText(text: string, cut: RevealCut | null): ReactNode {
  return cut ? leaf(text, { pos: 0, end: cut.end, fade: cut.fade, marks: cut.marks ?? NO_MARKS, done: false, words: cut.words }, "r") : text;
}

// ---------- highlight.js, rebuilt as React elements ----------

const HLJS_CLASS = /^(?:hljs-[a-z0-9_-]+|language-[a-z0-9_-]+)(?: [a-z0-9_-]+)*$/;
const HLJS_TEXT: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'" };

/** highlight.js's spans as a tree: a class (none for a sub-language wrapper) and the children, or a piece of text. */
type HlNode = string | { cls: string | undefined; kids: HlNode[] };

function parseHighlightTree(html: string): HlNode[] | null {
  type Frame = { cls: string; kids: HlNode[] };
  const stack: Frame[] = [{ cls: "", kids: [] }];
  const re = /<span class="([^"<>]*)">|<\/span>|<|[^<]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tok = m[0];
    if (m[1] !== undefined) {
      if (!HLJS_CLASS.test(m[1])) return null;
      stack.push({ cls: m[1], kids: [] });
    } else if (tok === "</span>") {
      if (stack.length < 2) return null;
      const f = stack.pop()!;
      // A sub-language wrapper (language-css inside html) keeps its children and drops its class.
      stack[stack.length - 1]!.kids.push({ cls: f.cls.startsWith("hljs-") ? f.cls : undefined, kids: f.kids });
    } else if (tok === "<") {
      return null;
    } else {
      if (/&(?!amp;|lt;|gt;|quot;|#x27;|#39;)/.test(tok)) return null;
      stack[stack.length - 1]!.kids.push(tok.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (e) => HLJS_TEXT[e]!));
    }
  }
  return stack.length === 1 ? stack[0]!.kids : null;
}

function hlNodes(nodes: readonly HlNode[], c: Cut | null, key: { n: number }): ReactNode[] {
  const out: ReactNode[] = [];
  for (const n of nodes) {
    if (c?.done) break;
    if (typeof n === "string") {
      const s = leaf(n, c, `t${key.n++}`, "h");
      if (s !== null) out.push(s);
      continue;
    }
    const k = key.n++;
    const kids = hlNodes(n.kids, c, key);
    if (!c || kids.length)
      out.push(
        <span key={k} className={n.cls}>
          {kids}
        </span>,
      );
  }
  return out;
}

/** Parse highlight.js output that holds only its own spans and escaped text. Anything else gives null (no colours). */
export function parseHighlight(html: string): ReactNode[] | null {
  const tree = parseHighlightTree(html);
  return tree ? hlNodes(tree, null, { n: 0 }) : null;
}

function highlightTree(code: string, lang: string | undefined): HlNode[] | null {
  const name = (lang ?? "").trim().toLowerCase();
  if (!name || code.length > 60000 || !hljs.getLanguage(name)) return null;
  try {
    return parseHighlightTree(hljs.highlight(code, { language: name, ignoreIllegals: true }).value);
  } catch {
    return null;
  }
}

export function highlight(code: string, lang: string | undefined): ReactNode[] | null {
  const tree = highlightTree(code, lang);
  return tree ? hlNodes(tree, null, { n: 0 }) : null;
}

// ---------- the token walk ----------

function CodeBlock({ code, lang, cut }: { code: string; lang: string; cut?: CutAt }) {
  const ref = useRef<HTMLElement>(null);
  const tree = useMemo(() => highlightTree(code, lang), [code, lang]);
  const full = useMemo(() => (tree ? hlNodes(tree, null, { n: 0 }) : null), [tree]);
  const c = cutOf(cut);
  const body = c ? (tree ? hlNodes(tree, c, { n: 0 }) : leaf(code, c, "c")) : (full ?? code);
  return (
    <div className={`chat-md-code${cut?.whole ? " chat-block-in" : ""}`}>
      <div className="chat-md-code-head">
        <span className="chat-md-lang">{lang}</span>
        {/* The icon and the word "Copy" (G-19: touch has no tooltip); its name is still Copy code. */}
        <CopyButton text={code} target={() => ref.current} testId="copy-code" label="Copy code" word="Copy" withLabel />
      </div>
      <pre>
        <code ref={ref} className={tree ? "hljs" : undefined}>
          {body}
        </code>
      </pre>
    </div>
  );
}

function Checkbox({ checked }: { checked: boolean }) {
  return <input type="checkbox" className="chat-md-check" checked={checked} disabled readOnly aria-label={checked ? "Done" : "Not done"} />;
}

const imageLabel = (t: Token) => {
  const alt = decodeEntities((t as Tokens.Image).text ?? "").trim();
  return alt ? `[image: ${alt}]` : "[image]";
};

function inline(tokens: Token[] | undefined, key: string, c: Cut | null = null): ReactNode[] {
  const out: ReactNode[] = [];
  const push = (n: ReactNode) => {
    if (n !== null) out.push(n);
  };
  const some = (kids: ReactNode[]) => !c || kids.length > 0;
  (tokens ?? []).forEach((t, i) => {
    if (c?.done) return;
    const k = `${key}.${i}`;
    switch (t.type) {
      case "text": {
        const tt = t as Tokens.Text;
        if (!tt.tokens) push(leaf(decodeEntities(tt.text), c, k));
        else {
          const kids = inline(tt.tokens, k, c);
          if (some(kids)) out.push(<Fragment key={k}>{kids}</Fragment>);
        }
        break;
      }
      case "escape":
        push(leaf((t as Tokens.Escape).text, c, k));
        break;
      case "strong":
      case "em":
      case "del": {
        const kids = inline(t.tokens, k, c);
        const Tag = t.type;
        if (some(kids)) out.push(<Tag key={k}>{kids}</Tag>);
        break;
      }
      case "codespan": {
        const text = (t as Tokens.Codespan).text;
        const was = enterWhole(c, c && !c.done ? wordEnd(text, placeOf(c.words, c.pos)) : null);
        const s = leaf(text, c, k);
        if (was !== null) c!.fade = was;
        if (s !== null)
          out.push(
            <code key={k} className={was !== null ? "chat-block-in" : undefined}>
              {s}
            </code>,
          );
        break;
      }
      case "br":
        if (unit(c) !== "skip") out.push(<br key={k} />);
        break;
      case "link": {
        const l = t as Tokens.Link;
        const href = safeHref(l.href);
        const kids = inline(l.tokens, k, c);
        if (href) {
          if (some(kids))
            out.push(
              <a key={k} href={href} target="_blank" rel="noopener noreferrer">
                {kids}
              </a>,
            );
          break;
        }
        const tail = l.href && l.href !== l.text ? leaf(` (${l.href})`, c, `${k}.h`) : null;
        if (some(kids) || tail !== null)
          out.push(
            <Fragment key={k}>
              {kids}
              {tail !== null ? <span className="chat-md-href">{tail}</span> : null}
            </Fragment>,
          );
        break;
      }
      case "image": {
        const s = leaf(imageLabel(t), c, k);
        if (s !== null)
          out.push(
            <span key={k} className="chat-md-img">
              {s}
            </span>,
          );
        break;
      }
      case "checkbox":
        if (unit(c) !== "skip") out.push(<Checkbox key={k} checked={(t as Tokens.Checkbox).checked} />);
        break;
      case "html":
        push(leaf((t as Tokens.HTML).text, c, k));
        break;
      default:
        push(leaf(t.raw, c, k));
    }
  });
  return out;
}

const HEADINGS = ["h2", "h3", "h4", "h5", "h6", "h6"] as const;

function listItem(it: Tokens.ListItem, k: string, c: Cut | null): ReactNode {
  const parts: ReactNode[] = [];
  const toks = it.tokens ?? [];
  // The item (its bullet or number, and its box) comes with its first word: never a bullet or a box alone.
  const lead = c && !c.done ? itemLead(it, leadAt(c)) : null;
  if (c && lead !== null && c.pos + lead > c.end) {
    c.done = true;
    return null;
  }
  const was = enterWhole(c, lead);
  toks.forEach((x, j) => {
    if (c?.done) return;
    const kk = `${k}.${j}`;
    if (x.type === "text") {
      const tt = x as Tokens.Text;
      const kids = tt.tokens ? inline(tt.tokens, kk, c) : [leaf(decodeEntities(tt.text), c, kk)].filter((n) => n !== null);
      if (!c || kids.length) parts.push(<Fragment key={kk}>{kids}</Fragment>);
    } else if (x.type === "checkbox") {
      // In a loose list the box sits inside the item's first paragraph, as in a tight one.
      const next = toks[j + 1];
      if (next?.type !== "paragraph" && unit(c) !== "skip") parts.push(<Checkbox key={kk} checked={(x as Tokens.Checkbox).checked} />);
    } else if (x.type === "paragraph" && toks[j - 1]?.type === "checkbox") {
      if (unit(c) === "skip") return;
      parts.push(
        <p key={kk}>
          <Checkbox checked={(toks[j - 1] as Tokens.Checkbox).checked} />
          {inline(x.tokens, kk, c)}
        </p>,
      );
    } else parts.push(...blocks([x], kk, false, c));
  });
  if (was !== null) c!.fade = was;
  if (c && !parts.length) return null;
  const cls = [it.task ? "chat-md-task" : "", was !== null ? "chat-block-in" : ""].filter(Boolean).join(" ");
  return (
    <li key={k} className={cls || undefined}>
      {parts}
    </li>
  );
}

function blocks(tokens: Token[], key: string, top: boolean, c: Cut | null = null): ReactNode[] {
  const out: ReactNode[] = [];
  tokens.forEach((t, i) => {
    if (c?.done) return;
    const n = block(t, `${key}.${i}`, top ? i : null, c);
    if (n !== null) out.push(n);
  });
  return out;
}

/** One block: `index` is its place among the reply's top blocks (data-b, which Copy reads), null inside a block. */
function block(t: Token, k: string, index: number | null, c: Cut | null): ReactNode {
  const b = index !== null ? { "data-b": index } : {};
  const some = (kids: ReactNode[]) => !c || kids.length > 0;
  switch (t.type) {
    case "space":
    case "def":
      return null;
    case "paragraph": {
      const kids = inline(t.tokens, k, c);
      return some(kids) ? (
        <p key={k} {...b}>
          {kids}
        </p>
      ) : null;
    }
    case "text": {
      const tt = t as Tokens.Text;
      const kids = tt.tokens ? inline(tt.tokens, k, c) : [leaf(decodeEntities(tt.text), c, k)].filter((n) => n !== null);
      return some(kids) ? (
        <p key={k} {...b}>
          {kids}
        </p>
      ) : null;
    }
    case "heading": {
      const h = t as Tokens.Heading;
      const Tag = HEADINGS[Math.min(h.depth, 6) - 1] ?? "h6";
      const kids = inline(h.tokens, k, c);
      return some(kids) ? (
        <Tag key={k} className={`chat-md-h chat-md-h${Math.min(h.depth, 4)}`} {...b}>
          {kids}
        </Tag>
      ) : null;
    }
    case "hr": {
      const u = unit(c);
      return u === "skip" ? null : <hr key={k} className={u === "new" ? "chat-block-in" : undefined} {...b} />;
    }
    case "blockquote": {
      const quote = (t as Tokens.Blockquote).tokens;
      const was = enterWhole(c, c && !c.done ? blocksLead(quote, leadAt(c)) : null);
      const kids = blocks(quote, k, false, c);
      if (was !== null) c!.fade = was;
      return some(kids) ? (
        <blockquote key={k} className={was !== null ? "chat-block-in" : undefined} {...b}>
          {kids}
        </blockquote>
      ) : null;
    }
    case "code": {
      const cd = t as Tokens.Code;
      let at: CutAt | undefined;
      if (c) {
        if (c.done) return null;
        const p = c.pos;
        const place = placeOf(c.words, p);
        const was = enterWhole(c, wordEnd(cd.text, place));
        const fade = c.fade;
        if (was !== null) c.fade = was;
        c.pos += cd.text.length;
        if (c.pos > c.end) {
          c.done = true;
          // The box comes with its first whole word.
          if (wholeWords(cd.text, c.end - p, place) <= 0) return null;
        }
        if (c.done || c.pos > fade) at = { pos: p, end: c.end, fade, marks: c.marks, whole: was !== null, words: c.words };
      }
      return (
        <div key={k} className="chat-md-block" {...b}>
          <CodeBlock code={cd.text} lang={(cd.lang ?? "").trim().split(/\s+/)[0] ?? ""} cut={at} />
        </div>
      );
    }
    case "list": {
      const l = t as Tokens.List;
      const items: ReactNode[] = [];
      l.items.forEach((it, j) => {
        if (c?.done) return;
        const n = listItem(it, `${k}.${j}`, c);
        if (n !== null) items.push(n);
      });
      if (!some(items)) return null;
      const cls = l.items.some((it) => it.task) ? "chat-md-tasks" : undefined;
      const start = l.ordered && typeof l.start === "number" && l.start !== 1 ? l.start : undefined;
      return l.ordered ? (
        <ol key={k} start={start} className={cls} {...b}>
          {items}
        </ol>
      ) : (
        <ul key={k} className={cls} {...b}>
          {items}
        </ul>
      );
    }
    case "table": {
      const tb = t as Tokens.Table;
      const al = (a: "center" | "left" | "right" | null | undefined) => (a ? { textAlign: a } : undefined);
      // A row shows whole (its cells laid out at once), so the columns never take a half row's widths.
      const head = atomic(c, rowUnits(tb.header));
      if (head === null) return null;
      const rows: ReactNode[] = [];
      for (let r = 0; r < tb.rows.length; r++) {
        const row = tb.rows[r]!;
        const fresh = atomic(c, rowUnits(row));
        if (fresh === null) break;
        rows.push(
          <tr key={r} className={fresh ? "chat-block-in" : undefined}>
            {row.map((cell, j) => (
              <td key={j} style={al(tb.align[j])}>
                {inline(cell.tokens, `${k}.${r}.${j}`)}
              </td>
            ))}
          </tr>,
        );
      }
      return (
        <div key={k} className="chat-md-table" {...b}>
          <table>
            <thead>
              <tr className={head ? "chat-block-in" : undefined}>
                {tb.header.map((cell, j) => (
                  <th key={j} style={al(tb.align[j])}>
                    {inline(cell.tokens, `${k}.h${j}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>{rows}</tbody>
          </table>
        </div>
      );
    }
    case "html": {
      const s = leaf((t as Tokens.HTML).text, c, k);
      return s === null ? null : (
        <p key={k} className="chat-md-raw" {...b}>
          {s}
        </p>
      );
    }
    default: {
      const s = leaf(t.raw, c, k);
      return s === null ? null : (
        <p key={k} {...b}>
          {s}
        </p>
      );
    }
  }
}

// ---------- units: what the walk counts, per token ----------

function inlineUnits(tokens: Token[] | undefined): number {
  let n = 0;
  for (const t of tokens ?? [])
    switch (t.type) {
      case "text": {
        const tt = t as Tokens.Text;
        n += tt.tokens ? inlineUnits(tt.tokens) : decodeEntities(tt.text).length;
        break;
      }
      case "escape":
        n += (t as Tokens.Escape).text.length;
        break;
      case "strong":
      case "em":
      case "del":
        n += inlineUnits(t.tokens);
        break;
      case "codespan":
        n += (t as Tokens.Codespan).text.length;
        break;
      case "br":
      case "checkbox":
        n += 1;
        break;
      case "link": {
        const l = t as Tokens.Link;
        n += inlineUnits(l.tokens);
        if (!safeHref(l.href) && l.href && l.href !== l.text) n += l.href.length + 3;
        break;
      }
      case "image":
        n += imageLabel(t).length;
        break;
      case "html":
        n += (t as Tokens.HTML).text.length;
        break;
      default:
        n += t.raw.length;
    }
  return n;
}

function rowUnits(cells: readonly Tokens.TableCell[]): number {
  let n = 0;
  for (const cell of cells) n += inlineUnits(cell.tokens);
  return n;
}

function itemUnits(it: Tokens.ListItem): number {
  let n = 0;
  const toks = it.tokens ?? [];
  toks.forEach((x, j) => {
    if (x.type === "text") {
      const tt = x as Tokens.Text;
      n += tt.tokens ? inlineUnits(tt.tokens) : decodeEntities(tt.text).length;
    } else if (x.type === "checkbox") n += 1;
    else if (x.type === "paragraph" && toks[j - 1]?.type === "checkbox") n += inlineUnits(x.tokens);
    else n += blockUnits(x);
  });
  return n;
}

// ---------- leads: the units from an element's start to the end of its first word ----------

/** Where a lead is worked out: a live block's memo and the units before the element (its texts' places), or none. */
interface LeadAt {
  words: WordMemo;
  pos: number;
}
const leadAt = (c: Cut): LeadAt | undefined => (c.words ? { words: c.words, pos: c.pos } : undefined);
const leadOn = (at: LeadAt | undefined, n: number): LeadAt | undefined => (at ? { words: at.words, pos: at.pos + n } : undefined);
const leadPlace = (at: LeadAt | undefined, n: number): Place | undefined => (at ? placeOf(at.words, at.pos + n) : undefined);

function inlineLead(tokens: Token[] | undefined, at?: LeadAt): number | null {
  let n = 0;
  const text = (s: string) => {
    const w = wordEnd(s, leadPlace(at, n));
    if (w !== null) return n + w;
    n += s.length;
    return null;
  };
  for (const t of tokens ?? []) {
    let l: number | null = null;
    switch (t.type) {
      case "text": {
        const tt = t as Tokens.Text;
        if (tt.tokens) {
          l = inlineLead(tt.tokens, leadOn(at, n));
          if (l !== null) return n + l;
          n += inlineUnits(tt.tokens);
        } else l = text(decodeEntities(tt.text));
        break;
      }
      case "escape":
        l = text((t as Tokens.Escape).text);
        break;
      case "codespan":
        l = text((t as Tokens.Codespan).text);
        break;
      case "html":
        l = text((t as Tokens.HTML).text);
        break;
      case "image":
        l = text(imageLabel(t));
        break;
      case "br":
      case "checkbox":
        n += 1;
        break;
      case "strong":
      case "em":
      case "del":
      case "link": {
        const inner = inlineLead(t.tokens, leadOn(at, n));
        if (inner !== null) return n + inner;
        n += inlineUnits([t]);
        break;
      }
      default:
        l = text(t.raw);
    }
    if (l !== null) return l;
  }
  return null;
}

function itemLead(it: Tokens.ListItem, at?: LeadAt): number | null {
  let n = 0;
  const toks = it.tokens ?? [];
  for (let j = 0; j < toks.length; j++) {
    const x = toks[j]!;
    if (x.type === "checkbox") {
      n += 1;
      continue;
    }
    const boxed = x.type === "paragraph" && toks[j - 1]?.type === "checkbox";
    const l = boxed ? inlineLead(x.tokens, leadOn(at, n)) : blockLead(x, leadOn(at, n));
    if (l !== null) return n + l;
    n += boxed ? inlineUnits(x.tokens) : blockUnits(x);
  }
  return null;
}

function blockLead(t: Token, at?: LeadAt): number | null {
  switch (t.type) {
    case "space":
    case "def":
      return null;
    case "paragraph":
    case "heading":
      return inlineLead(t.tokens, at);
    case "text": {
      const tt = t as Tokens.Text;
      return tt.tokens ? inlineLead(tt.tokens, at) : wordEnd(decodeEntities(tt.text), leadPlace(at, 0));
    }
    case "hr":
      return 1;
    case "blockquote":
      return blocksLead((t as Tokens.Blockquote).tokens, at);
    case "list": {
      let n = 0;
      for (const it of (t as Tokens.List).items) {
        const l = itemLead(it, leadOn(at, n));
        if (l !== null) return n + l;
        n += itemUnits(it);
      }
      return null;
    }
    case "code":
      return wordEnd((t as Tokens.Code).text, leadPlace(at, 0));
    case "table":
      return rowUnits((t as Tokens.Table).header) || null;
    case "html":
      return wordEnd((t as Tokens.HTML).text, leadPlace(at, 0));
    default:
      return wordEnd(t.raw, leadPlace(at, 0));
  }
}

function blocksLead(tokens: Token[], at?: LeadAt): number | null {
  let n = 0;
  for (const t of tokens) {
    const l = blockLead(t, leadOn(at, n));
    if (l !== null) return n + l;
    n += blockUnits(t);
  }
  return null;
}

const UNITS = new WeakMap<Token, number>();

function blockUnits(t: Token): number {
  const had = UNITS.get(t);
  if (had !== undefined) return had;
  let n = 0;
  switch (t.type) {
    case "space":
    case "def":
      break;
    case "paragraph":
    case "heading":
      n = inlineUnits(t.tokens);
      break;
    case "text": {
      const tt = t as Tokens.Text;
      n = tt.tokens ? inlineUnits(tt.tokens) : decodeEntities(tt.text).length;
      break;
    }
    case "hr":
      n = 1;
      break;
    case "blockquote":
      for (const x of (t as Tokens.Blockquote).tokens) n += blockUnits(x);
      break;
    case "code":
      n = (t as Tokens.Code).text.length;
      break;
    case "list":
      for (const it of (t as Tokens.List).items) n += itemUnits(it);
      break;
    case "table": {
      const tb = t as Tokens.Table;
      n = rowUnits(tb.header);
      for (const row of tb.rows) n += rowUnits(row);
      break;
    }
    case "html":
      n = (t as Tokens.HTML).text.length;
      break;
    default:
      n = t.raw.length;
  }
  UNITS.set(t, n);
  return n;
}

// ---------- the reply's tokens, lexed once per piece ----------

/** A reply as the renderer reads it: its tokens, and per top block its units, where they start and where its source starts. */
export interface MarkdownModel {
  text: string;
  /** Null when marked could not lex it (the text then shows as it is). */
  tokens: Token[] | null;
  units: number[];
  starts: number[];
  /** Where each top block's source starts in `text`, and the end (one more entry than the tokens). */
  offsets: number[];
  /** Every unit of the reply. */
  total: number;
  /** The blocks' sources make up the whole text, and no link definition is in it: a later piece can lex from its end. */
  reusable: boolean;
}

function lex(text: string): TokensList | null {
  try {
    return Lexer.lex(text, { gfm: true });
  } catch {
    return null;
  }
}

function modelOf(text: string, tokens: TokensList | null): MarkdownModel {
  if (!tokens) return { text, tokens: null, units: [], starts: [], offsets: [], total: text.length, reusable: false };
  const units: number[] = [];
  const starts: number[] = [];
  const offsets: number[] = [];
  let u = 0;
  let o = 0;
  for (const t of tokens) {
    offsets.push(o);
    o += t.raw.length;
    starts.push(u);
    const n = blockUnits(t);
    units.push(n);
    u += n;
  }
  offsets.push(o);
  const defs = Object.keys(tokens.links ?? {}).length > 0;
  return { text, tokens, units, starts, offsets, total: u, reusable: o === text.length && !defs && !text.includes("\r") };
}

/**
 * How many of the last lex's top blocks the next one keeps: all but the last two blocks with content, and none when the
 * text is not the last one with more after it. A block after the cut is lexed again with everything after it, so it
 * must lex the same with nothing before it: an indented code block or a definition can join the paragraph before
 * it, so the cut moves back over those.
 */
function keptBlocks(prev: MarkdownModel, text: string): number {
  const toks = prev.tokens;
  if (!toks || !prev.reusable || text.length <= prev.text.length || !text.startsWith(prev.text)) return 0;
  let j = toks.length - 1;
  for (let content = 0; j > 0; j--) if (toks[j]!.type !== "space" && ++content === 2) break;
  const joins = (t: Token) => t.type === "space" || t.type === "def" || (t.type === "code" && (t as Tokens.Code).codeBlockStyle === "indented");
  while (j > 0 && joins(toks[j]!)) j--;
  return j;
}

/** The model of `text`, lexed from the last two blocks of `prev` when `text` is `prev`'s text with more after it. */
export function lexMarkdown(text: string, prev: MarkdownModel | null): MarkdownModel {
  if (prev && prev.text === text) return prev;
  const kept = prev ? keptBlocks(prev, text) : 0;
  if (kept > 0) {
    const tail = lex(text.slice(prev!.offsets[kept]!));
    if (tail && Object.keys(tail.links ?? {}).length === 0) {
      const tokens = prev!.tokens!.slice(0, kept).concat(tail) as TokensList;
      tokens.links = tail.links;
      return modelOf(text, tokens);
    }
  }
  return modelOf(text, lex(text));
}

/**
 * What each live block showed last (holdPartial, holdWord), by the block's key: a row drawn anew while its block streams
 * (a snapshot took the block out and put it back) goes on from it, so what showed stays (Q1 review).
 */
const HELD = new Map<string, string>();
const MAX_HELD = 64;
function keepHeld(key: string | undefined, held: string, live: boolean) {
  if (!key) return;
  HELD.delete(key);
  if (!live) return;
  HELD.set(key, held);
  if (HELD.size > MAX_HELD) HELD.delete(HELD.keys().next().value!);
}

/**
 * The model of a block's markdown, lexed piece by piece while it streams (its live end waits: holdPartial). `key`: the
 * block's own (chat and block), so that a row drawn anew goes on from what it showed.
 */
export function useMarkdownModel(source: string, streaming?: boolean, key?: string): MarkdownModel {
  const last = useRef<MarkdownModel | null>(null);
  // Once per piece that came, not per frame of the reveal; never less than the last piece showed.
  const text = useMemo(() => {
    const held = streaming ? holdPartial(source, last.current?.text ?? (key ? HELD.get(key) : undefined)) : source;
    keepHeld(key, held, !!streaming);
    return held;
  }, [source, streaming]);
  const model = useMemo(() => lexMarkdown(text, last.current), [text]);
  last.current = model;
  return model;
}

/** Thinking text while it streams: its last word waits (holdWord), and what showed stays (`key` as useMarkdownModel's). */
export function useHeldWord(text: string, live: boolean, key?: string): string {
  const last = useRef<string | null>(null);
  const held = useMemo(() => {
    const h = live ? holdWord(text, last.current ?? (key ? HELD.get(key) : undefined)) : text;
    keepHeld(key, h, live);
    return h;
  }, [text, live]);
  last.current = held;
  return held;
}

// ---------- the reply ----------

/** A top block. Without a cut it draws once per token (the blocks before the last ones keep their tokens). */
export const TopBlock = memo(function TopBlock({ token, index, cut }: { token: Token; index: number; cut?: CutAt }) {
  return <>{block(token, `b.${index}`, index, cutOf(cut))}</>;
});

/**
 * S1: a reply's top blocks in groups of this many (a 20,000-character reply has about 250): a frame of the reveal
 * draws the group that holds its live end, and every other group is passed over at its memo, whole.
 */
const GROUP = 16;

interface GroupProps {
  tokens: readonly Token[];
  starts: readonly number[];
  units: readonly number[];
  from: number;
  to: number;
  /** The reveal's cut, for a group with a block that is not wholly shown or still fades; null for the others. */
  reveal: RevealCut | null;
}

/** The same group: its blocks' tokens (a block lexed again is a new token) and the same cut. */
function sameGroup(a: GroupProps, b: GroupProps): boolean {
  if (a.from !== b.from || a.to !== b.to || a.reveal !== b.reveal) return false;
  for (let i = a.from; i < a.to; i++) if (a.tokens[i] !== b.tokens[i]) return false;
  return true;
}

const BlockGroup = memo(function BlockGroup({ tokens, starts, units, from, to, reveal }: GroupProps) {
  const kids: ReactNode[] = [];
  for (let i = from; i < to; i++) {
    const t = tokens[i]!;
    if (reveal) {
      const start = starts[i]!;
      const end = start + units[i]!;
      // Blocks wholly in view and done fading draw as they are (and, by their token, not again).
      if (end > reveal.end || end > reveal.fade) {
        kids.push(<TopBlock key={i} token={t} index={i} cut={{ pos: start, end: reveal.end, fade: reveal.fade, marks: reveal.marks ?? NO_MARKS, words: reveal.words }} />);
        continue;
      }
    }
    kids.push(<TopBlock key={i} token={t} index={i} />);
  }
  return <>{kids}</>;
}, sameGroup);

function firstText(el: Element, last: boolean): Text | null {
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => ((n.textContent ?? "").trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP) });
  if (!last) return walk.nextNode() as Text | null;
  let n: Node | null = null;
  for (let x = walk.nextNode(); x; x = walk.nextNode()) n = x;
  return n as Text | null;
}

/**
 * A reply's markdown. A selection that covers whole blocks copies their markdown source as text/plain (a whole table
 * copies as its GFM source) and the rendered HTML as text/html (DESIGN.md 7.10); any other selection is the browser's.
 */
export function Markdown(props: { source: string; streaming?: boolean; className?: string }) {
  const model = useMarkdownModel(props.source, props.streaming);
  return <MarkdownView model={model} className={props.className} />;
}

/** A reply's markdown from its model, all of it or up to a reveal's cut (row 79). */
export function MarkdownView({ model, reveal, className }: { model: MarkdownModel; reveal?: RevealCut | null; className?: string }) {
  const { tokens } = model;

  const onCopy = (e: ClipboardEvent<HTMLDivElement>) => {
    if (!tokens) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount !== 1) return;
    const range = sel.getRangeAt(0);
    const root = e.currentTarget;
    if (!root.contains(range.commonAncestorContainer)) return;
    const els = Array.from(root.children).filter((el): el is HTMLElement => el instanceof HTMLElement && el.dataset.b !== undefined);
    const hit = els.filter((el) => range.intersectsNode(el));
    if (!hit.length) return;
    const start = firstText(hit[0]!, false);
    const end = firstText(hit[hit.length - 1]!, true);
    if (!start || !end) return;
    if (range.comparePoint(start, 0) !== 0 || range.comparePoint(end, end.length) !== 0) return;
    const md = hit.map((el) => (tokens[Number(el.dataset.b)]?.raw ?? "").replace(/\s+$/, "")).join("\n\n");
    const holder = document.createElement("div");
    holder.appendChild(range.cloneContents());
    e.clipboardData.setData("text/plain", md);
    e.clipboardData.setData("text/html", holder.innerHTML);
    e.preventDefault();
  };

  let body: ReactNode;
  if (!tokens) body = <p className="chat-md-plain">{revealText(model.text, reveal ?? null)}</p>;
  else {
    const { starts, units } = model;
    // The blocks drawn: up to the first one with content that starts at or after the cut (by halves: the starts grow).
    let stop = tokens.length;
    if (reveal) {
      let lo = 0;
      let hi = tokens.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid]! >= reveal.end) hi = mid;
        else lo = mid + 1;
      }
      while (lo < tokens.length && units[lo] === 0) lo++;
      stop = lo;
    }
    const kids: ReactNode[] = [];
    for (let from = 0; from < stop; from += GROUP) {
      const to = Math.min(stop, from + GROUP);
      const last = starts[to - 1]! + units[to - 1]!;
      const live = !!reveal && (last > reveal.end || last > reveal.fade);
      kids.push(<BlockGroup key={from} tokens={tokens} starts={starts} units={units} from={from} to={to} reveal={live ? reveal! : null} />);
    }
    body = kids;
  }

  return (
    <div className={`chat-md${className ? " " + className : ""}`} onCopy={onCopy}>
      {body}
    </div>
  );
}

/** One line of inline markdown (a question's text): emphasis, code and safe links, no blocks. */
export function InlineMarkdown({ source }: { source: string }) {
  const nodes = useMemo(() => {
    try {
      return inline(Lexer.lexInline(source, { gfm: true }), "i");
    } catch {
      return [source];
    }
  }, [source]);
  return <>{nodes}</>;
}
