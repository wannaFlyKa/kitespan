// U5 (DESIGN-U5 5 and 6; FIX-U5 2): the message search's match rules in shared/words.ts, which the server's scan and
// the page's marks share: the fold and case, prefixes and whole words, camelCase, accents in both forms, scripts with
// no spaces, a query of punctuation or emoji, the minimum, the phrase and whole flags, and the snippet's window, cuts
// and ranges.
import { describe, expect, test } from "bun:test";
import { fold, foldFlat } from "../../shared/match";
import { CUT, WORD_LIMITS, asksMessages, markRanges, matchRanges, matchScore, matchText, queryText, snippetOf, wordQuery, wordText, wordTextUnits } from "../../shared/words";
import { CONTROL_CHARS as CONTROL } from "../../shared/protocol";

const m = (text: string, q: string) => matchText(wordText(text), wordQuery(q));
const finds = (text: string, q: string) => m(text, q) !== null;
const marked = (text: string, q: string) => markRanges(text, q).map(([s, e]) => text.slice(s, e));
const snip = (text: string, q: string) => {
  const t = wordText(text);
  const query = wordQuery(q);
  const hit = matchText(t, query);
  if (!hit) throw new Error(`no match for ${q}`);
  return snippetOf(t, query, hit.anchor);
};
/** The snippet with each range in brackets. */
const show = (s: { snippet: string; ranges: [number, number][] }) => {
  let out = "";
  let at = 0;
  for (const [a, b] of s.ranges) {
    out += `${s.snippet.slice(at, a)}[${s.snippet.slice(a, b)}]`;
    at = b;
  }
  return out + s.snippet.slice(at);
};

describe("the flat fold", () => {
  test("foldFlat gives fold's units exactly, for ASCII, accents, the dotted I, CJK, emoji and lone surrogates", () => {
    for (const s of ["Hello World", "CAFÉ Ünïcødé", "İstanbul ıi", "会議メモ 上传", "🚀 launch 👩‍💻", "a\ud800b\udc00c", "Ωμέγα", "x".repeat(20_000) + "É"]) {
      expect(foldFlat(s)).toBe(fold(s));
      expect(foldFlat(s).length).toBe(s.length);
    }
  });
});

describe("the query (rules 2 and 6)", () => {
  test("words are runs of letters and digits, folded, with no marks; the rest only separates them; 8 at most", () => {
    expect(wordQuery("  Memory-CAP, v2!  ").words).toEqual(["memory", "cap", "v2"]);
    expect(wordQuery("Café naïve").words).toEqual(["cafe", "naive"]);
    expect(wordQuery("a b c d e f g h i j").words).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
    expect(wordQuery("搜索引擎 search").words).toEqual(["搜索引擎", "search"]);
  });
  test("the minimum: one word of 2 units or more, or a Han, Hiragana or Katakana character", () => {
    expect([asksMessages("ca"), asksMessages("c"), asksMessages("  c  "), asksMessages("c a"), asksMessages("c ab")]).toEqual([true, false, false, false, true]);
    expect([asksMessages("搜"), asksMessages("あ"), asksMessages("カ"), asksMessages("é"), asksMessages("ก")]).toEqual([true, true, true, false, false]);
  });
  test("all punctuation, only emoji, or nothing asks nothing and matches nothing", () => {
    for (const q of ["!!!", "--", "...?!", "😀😀", "🚀 👩‍💻", "", "   ", "`**`"]) {
      expect(asksMessages(q)).toBe(false);
      expect(wordQuery(q).words).toEqual([]);
      expect(m("!!! -- 😀😀 🚀 text", q)).toBeNull();
    }
  });
  test("the sent form (queryText): the words as typed, one space apart, the first 8, at most the cap, same words", () => {
    expect(queryText("  Memory-CAP, v2!  ", 200)).toBe("Memory CAP v2");
    expect(queryText("a b c d e f g h i j", 200)).toBe("a b c d e f g h");
    // A decomposed accent stays with its letter; a mark alone is no word; control characters only separate.
    expect(queryText("cafe\u0301\tna\u0308ive \u0301 \u200eok", 200)).toBe("cafe\u0301 na\u0308ive ok");
    expect(queryText("搜索引擎、search", 200)).toBe("搜索引擎 search");
    expect(queryText("!!! 😀 --", 200)).toBe("");
    for (const q of ["Error: upload retry failed (503) after 30 s; see logs/upload.log line 42 and 43", "  CAFÉ\tnaïve  ", "x".repeat(300)]) {
      const sent = queryText(q, 200);
      expect(sent.length).toBeLessThanOrEqual(200);
      expect(CONTROL.test(sent)).toBe(false);
      if (q.length < 200) expect(wordQuery(sent).words).toEqual(wordQuery(q).words);
    }
  });
  test("the sent form's cut at the cap keeps a surrogate pair whole and the cut word's start", () => {
    const long = `${"word ".repeat(7)}${"𝐀".repeat(200)}`;
    const sent = queryText(long, 200);
    expect(sent.length).toBeLessThanOrEqual(200);
    expect(/[\ud800-\udbff]$/.test(sent)).toBe(false);
    expect(wordQuery(sent).words.slice(0, 7)).toEqual(Array(7).fill("word"));
    expect(wordQuery(long).words[7]!.startsWith(wordQuery(sent).words[7]!)).toBe(true);
    expect(queryText("x".repeat(300), 200)).toBe("x".repeat(200));
  });
});

describe("matching (rules 1, 3, 4, 5)", () => {
  test("case-insensitive both ways", () => {
    expect(finds("The Memory Cap", "memory")).toBe(true);
    expect(finds("the memory cap", "MEMORY")).toBe(true);
  });
  test("Greek: a word in capitals and the same word in small letters find each other, final sigma (U+03C2) included", () => {
    expect(finds("ΟΔΟΣ", "οδός")).toBe(true);
    expect(finds("η οδός μας", "ΟΔΟΣ")).toBe(true);
    expect(finds("οδοσ", "οδός")).toBe(true);
    expect(marked("ΟΔΟΣ ΚΑΙ ΟΔΟΣ", "οδός")).toEqual(["ΟΔΟΣ", "ΟΔΟΣ"]);
  });
  test("a word or its start, at a word start only: cach finds cache and caching, never recache", () => {
    expect(finds("we cache it", "cach")).toBe(true);
    expect(finds("caching helps", "cach")).toBe(true);
    expect(finds("recache it", "cach")).toBe(false);
    expect(marked("recache, then cache and caching", "cach")).toEqual(["cach", "cach"]);
  });
  test("camelCase: a capital after a lower-case letter starts a word; digits and underscores do not", () => {
    expect(finds("open SearchPane now", "pane")).toBe(true);
    expect(finds("the iPhone", "phone")).toBe(true);
    expect(finds("ALLCAPS", "caps")).toBe(false);
    expect(finds("abc123", "123")).toBe(false);
    expect(finds("snake_case_name", "case")).toBe(true);
  });
  test("accents: CAFÉ, café and cafe find Café, cafe and a decomposed cafe plus U+0301, and the mark is in the match", () => {
    const texts = ["Café au lait", "cafe au lait", "Café au lait"];
    for (const q of ["CAFÉ", "café", "cafe", "Café"]) for (const t of texts) expect(finds(t, q)).toBe(true);
    expect(marked("un café noir", "cafe")).toEqual(["café"]);
    expect(marked("résumé here", "resume")).toEqual(["résumé"]);
    expect(finds("naïve", "naive")).toBe(true);
  });
  test("scripts with combining marks (Devanagari, Thai, Arabic) match although the query loses its marks", () => {
    expect(finds("कहो नमस्ते दुनिया", "नमस्ते")).toBe(true);
    expect(marked("कहो नमस्ते दुनिया", "नमस्ते")).toEqual(["नमस्ते"]);
    expect(finds("ขอบคุณครับ", "ครับ")).toBe(true);
    expect(finds("مَرْحَبًا بالعالم", "مرحبا")).toBe(true);
  });
  test("Han, Hiragana and Katakana: every character starts a word, and a Latin word after one starts too", () => {
    expect(finds("我们的搜索引擎很快", "搜索")).toBe(true);
    expect(finds("会議メモについて", "メモ")).toBe(true);
    expect(finds("使用React开发", "react")).toBe(true);
    expect(finds("使用React开发", "开发")).toBe(true);
    expect(marked("搜索引擎和搜索", "搜索")).toEqual(["搜索", "搜索"]);
  });
  test("every query word must be in the message, in any order", () => {
    expect(finds("the cap on memory", "memory cap")).toBe(true);
    expect(finds("the memory is fine", "memory cap")).toBe(false);
  });
  test("astral letters and emoji around words", () => {
    expect(finds("ship 🚀launch now", "launch")).toBe(true);
    expect(finds("𠀀𠀁 text", "𠀁")).toBe(true);
    expect(marked("a 𝐁old word", "𝐁old")).toEqual(["𝐁old"]);
  });
  test("markup in the text is only text: <b>x</b> and tags are separators", () => {
    expect(marked("<b>cache</b> and <i>memory</i>", "cache memory")).toEqual(["cache", "memory"]);
  });
});

describe("phrase, whole and the score (rule 7)", () => {
  test("whole: every word matched a whole word somewhere; a prefix only is not whole", () => {
    expect(m("the memory cap", "memory cap")).toMatchObject({ whole: true, phrase: true });
    expect(m("the memory capital", "memory cap")).toMatchObject({ whole: false, phrase: true });
    expect(m("caps on memory and a cap", "memory cap")).toMatchObject({ whole: true, phrase: false });
    expect(m("cache", "cache")).toMatchObject({ whole: true, phrase: false });
    expect(m("caches", "cache")).toMatchObject({ whole: false, phrase: false });
  });
  test("a phrase: the words in order as consecutive words, only non-word characters between them", () => {
    expect(m("about the memory, cap and more", "memory cap")!.phrase).toBe(true);
    expect(m("about the cap memory", "memory cap")!.phrase).toBe(false);
    expect(m("memory of the cap", "memory cap")!.phrase).toBe(false);
    expect(m("memorycap", "memory cap")).toBeNull();
    expect(m("搜索引擎", "搜索 引擎")!.phrase).toBe(true);
  });
  test("the phrase is the anchor; else the first match in the text", () => {
    const text = "cap first, then memory, and later the memory cap itself";
    expect(m(text, "memory cap")!.anchor).toBe(text.indexOf("memory cap"));
    expect(m("cap first, then memory", "memory cap")!.anchor).toBe(0);
    expect(m("before cap first, then memory", "memory cap")!.anchor).toBe(7);
  });
  test("the score is 2 for a phrase and 1 for whole words", () => {
    expect(matchScore(m("the memory cap", "memory cap")!)).toBe(3);
    expect(matchScore(m("the memory capital", "memory cap")!)).toBe(2);
    expect(matchScore(m("cap and memory", "memory cap")!)).toBe(1);
    expect(matchScore(m("caps and memorys", "memory cap")!)).toBe(0);
  });
});

describe("the snippet (DESIGN-U5 6)", () => {
  const words = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `word${from + i}`).join(" ");

  test("a match at the start: no leading cut, the match marked", () => {
    const s = snip("Memory cap is 64 MiB.", "memory");
    expect(s.snippet).toBe("Memory cap is 64 MiB.");
    expect(show(s)).toBe("[Memory] cap is 64 MiB.");
  });
  test("a match at the end: the text ends there", () => {
    const text = `${words(10)} the memory`;
    const s = snip(text, "memory");
    expect(s.snippet.endsWith("the memory")).toBe(true);
    expect(s.snippet.endsWith(CUT)).toBe(false);
    expect(s.snippet.startsWith(CUT)).toBe(true);
  });
  test("the window: at most 24 units before the anchor, from a word start; at most 160 after it, at a word end", () => {
    const text = `${words(30)} memory ${words(60, 100)}`;
    const s = snip(text, "memory");
    expect(s.snippet.startsWith(CUT)).toBe(true);
    expect(s.snippet.endsWith(CUT)).toBe(true);
    const body = s.snippet.slice(1, -1);
    const at = body.indexOf("memory");
    expect(at).toBeLessThanOrEqual(WORD_LIMITS.lead);
    expect(body.length - at).toBeLessThanOrEqual(WORD_LIMITS.span);
    expect(body).toMatch(/^word\d+ /);
    expect(body).toMatch(/ word\d+$/);
    expect(text.includes(body)).toBe(true);
    expect(show(s)).toContain("[memory]");
  });
  test("a line of 5,000 characters with no space: a hard cut at 160", () => {
    const text = `memory${"x".repeat(5000)}`;
    const s = snip(text, "memory");
    expect(s.snippet).toBe(`memory${"x".repeat(154)}${CUT}`);
    expect(s.ranges).toEqual([[0, 6]]);
    const late = `${"y".repeat(3000)} memory${"x".repeat(2000)}`;
    const t = snip(late, "memory");
    expect(t.snippet.startsWith(`${CUT}memory`)).toBe(true);
    expect(t.snippet.length).toBe(1 + 160 + 1);
  });
  test("a surrogate pair at the cut is never split, nor a letter from its mark", () => {
    const pair = `memory ${"a".repeat(152)}😀😀😀`;
    const s = snip(pair, "memory");
    for (let i = 0; i < s.snippet.length; i++) {
      const c = s.snippet.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) expect(s.snippet.charCodeAt(i + 1)).toBeGreaterThanOrEqual(0xdc00);
      if (c >= 0xdc00 && c <= 0xdfff) expect(s.snippet.charCodeAt(i - 1)).toBeLessThanOrEqual(0xdbff);
    }
    const marks = `memory${"b".repeat(153)}é́́zz`;
    const t = snip(marks, "memory");
    expect(t.snippet).toBe(`memory${"b".repeat(153)}${CUT}`);
  });
  test("a leading cut never starts in the middle of a word", () => {
    const text = `averyveryverylongwordthatgoeson memory`;
    const s = snip(text, "memory");
    expect(s.snippet).toBe(`${CUT}memory`);
    expect(s.ranges).toEqual([[1, 7]]);
  });
  test("ranges: every query word in the window, merged where they touch, ascending, after the leading cut", () => {
    const s = snip("the cap, then memory and memory cap and caps", "memory cap");
    // The phrase is the anchor (25); 24 back lands inside "the", so the window starts at "cap".
    expect(show(s)).toBe("…[cap], then [memory] and [memory] [cap] and [cap]s");
    for (let i = 1; i < s.ranges.length; i++) expect(s.ranges[i]![0]).toBeGreaterThan(s.ranges[i - 1]![1]);
    expect(matchRanges(wordText("cache cache"), wordQuery("cache cach"))).toEqual([[0, 5], [6, 11]]);
    expect(matchRanges(wordText("cacheCache"), wordQuery("cache"))).toEqual([[0, 10]]);
  });
  test("right-to-left text and a direction override stay text; the snippet is the original's case and accents", () => {
    const rtl = snip("שלום עולם memory טוב", "memory");
    expect(rtl.snippet).toBe("שלום עולם memory טוב");
    expect(show(rtl)).toBe("שלום עולם [memory] טוב");
    const s = snip("Ünïcødé CAFÉ", "cafe");
    expect(show(s)).toBe("Ünïcødé [CAFÉ]");
  });
  test("a window that starts in a CJK run starts 24 units back (every character is a word start)", () => {
    const text = "这是一个很长的句子".repeat(5) + "搜索引擎";
    const s = snip(text, "搜索");
    expect(s.snippet).toBe(`${CUT}${text.slice(text.length - 4 - 24)}`);
  });
});

describe("the kept units (the server's estimate)", () => {
  test("text and fold, and the map of a text with marks at 2 units a value", () => {
    expect(wordTextUnits(wordText("abc"))).toBe(6);
    const t = wordText("é");
    expect(t.fold).toBe("e");
    expect(Array.from(t.at!)).toEqual([0, 2]);
    expect(wordTextUnits(t)).toBe(2 + 1 + 4);
  });
});
