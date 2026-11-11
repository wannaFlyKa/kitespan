// Row 79, smooth text: a reply that streams in shows at an even pace, word by word with a short fade, never more than
// about half a second behind what came, and the rest at once at the block's end; a load shows at once; Reduce motion
// shows everything at once. The pacer and the change detector are pure; the markdown reveal is rendered to static HTML
// with React's server renderer, so the cut, the fades and the blocks can be read as markup.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Token } from "marked";
import { Lexer } from "marked";
import { Markdown, MarkdownView, holdPartial, holdWord, lexMarkdown, revealText, useHeldWord, useMarkdownModel, wholeWords, type MarkdownModel, type RevealCut } from "../../web/chat/Markdown";
import { REVEAL, advance, arrive, cutNow, fadeEdge, finish, newPacer, settled, snap } from "../../web/chat/reveal";
import { changeOf } from "../../web/chat/arrivals";
import { reducedMotion } from "../../web/ui/motion";
import { longReply, pacedOf, pacedPrompt } from "../fake-claude/long-reply";
import type { Item } from "../../web/state/types";

const FRAME = 1000 / 60;

/** Drive a pacer through frames while pieces arrive: `pieces[i]` units at `every * i` ms. Returns each frame's state. */
function run(pieces: number[], every: number, until: number) {
  const p = newPacer(0, 0);
  const frames: { t: number; shown: number; target: number }[] = [];
  let total = 0;
  let next = 0;
  for (let t = FRAME; t <= until; t += FRAME) {
    while (next < pieces.length && next * every <= t) {
      total += pieces[next]!;
      arrive(p, total, next * every);
      next++;
    }
    advance(p, t);
    frames.push({ t, shown: p.shown, target: p.target });
  }
  /** What had arrived by time t. */
  const came = (t: number) => {
    let n = 0;
    for (let i = 0; i < pieces.length && i * every <= t; i++) n += pieces[i]!;
    return n;
  };
  return { p, frames, came };
}

describe("the pacer", () => {
  test("a steady stream shows at an even pace, word by word, a little behind", () => {
    // 40 characters every 100 ms: about 400 a second, Claude's usual pace.
    const { frames, came } = run(Array(40).fill(40), 100, 4500);
    const steps = frames.filter((f) => f.t > 600 && f.t < 3800).map((f, i, a) => (i ? f.shown - a[i - 1]!.shown : 0)).slice(1);
    const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
    const sd = Math.sqrt(steps.reduce((a, b) => a + (b - mean) ** 2, 0) / steps.length);
    expect(mean).toBeGreaterThan(5);
    expect(mean).toBeLessThan(8);
    // Even: no frame jumps by much more than the mean, and few frames stand still.
    expect(Math.max(...steps)).toBeLessThan(mean * 2.5);
    expect(sd / mean).toBeLessThan(0.6);
    expect(steps.filter((s) => s === 0).length).toBeLessThan(steps.length * 0.25);
    // Behind by no more than half a second, at every frame.
    for (const f of frames) expect(f.shown).toBeGreaterThanOrEqual(Math.min(f.target, came(f.t - REVEAL.maxLagMs)));
  });

  test("a big piece goes faster, and is all there within half a second", () => {
    const { frames } = run([30, 30, 3000, 30], 200, 1500);
    const after = frames.filter((f) => f.t >= 400 + REVEAL.maxLagMs);
    expect(after[0]!.shown).toBeGreaterThanOrEqual(3060);
    // It still took several frames, not one: the big piece is revealed, not dropped in.
    const during = frames.filter((f) => f.t > 400 && f.t < 400 + REVEAL.maxLagMs && f.shown > 60 && f.shown < 3060);
    expect(during.length).toBeGreaterThan(5);
  });

  test("a stream with pauses and bursts is never more than half a second behind", () => {
    const pieces: number[] = [];
    let seed = 7;
    for (let i = 0; i < 120; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      pieces.push(seed % 9 === 0 ? 600 : seed % 4 === 0 ? 0 : 5 + (seed % 60));
    }
    const { frames, came } = run(pieces, 45, 7000);
    for (const f of frames) expect(f.shown).toBeGreaterThanOrEqual(Math.min(f.target, came(f.t - REVEAL.maxLagMs)));
    for (const f of frames) expect(f.shown).toBeLessThanOrEqual(f.target);
    expect(frames.at(-1)!.shown).toBe(frames.at(-1)!.target);
  });

  test("words fade for a short time after they show, and the end shows the rest at once", () => {
    const p = newPacer(0, 0);
    arrive(p, 100, 0);
    for (let t = FRAME; t < 120; t += FRAME) advance(p, t);
    const mid = p.shown;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(100);
    // What showed in the last REVEAL.fadeMs still fades: the edge is behind the cut.
    expect(fadeEdge(p, 120)).toBeLessThan(mid);
    finish(p, 140, 130);
    expect(p.shown).toBe(140);
    expect(settled(p, 130)).toBe(false); // the rest fades in
    expect(settled(p, 130 + REVEAL.fadeMs + 1)).toBe(true);
    expect(fadeEdge(p, 130 + REVEAL.fadeMs + 1)).toBe(140);
  });

  test("a load shows what came at once, with no fade", () => {
    const p = newPacer(10, 0);
    arrive(p, 50, 10);
    snap(p, 900, 20);
    expect(p.shown).toBe(900);
    expect(fadeEdge(p, 21)).toBe(900);
    expect(settled(p, 21)).toBe(true);
  });

  test("a pacer that starts with text shows that text at once", () => {
    const p = newPacer(500, 0);
    expect(p.shown).toBe(500);
    expect(settled(p, 1)).toBe(true);
  });

  test("text that shrinks (a held table line) keeps what showed for when it comes back", () => {
    const p = newPacer(0, 0);
    arrive(p, 80, 0);
    for (let t = FRAME; t < 600; t += FRAME) advance(p, t);
    expect(p.shown).toBe(80);
    arrive(p, 60, 600);
    expect(p.target).toBe(60);
    arrive(p, 90, 620);
    advance(p, 640);
    expect(p.shown).toBeGreaterThanOrEqual(80);
  });
});

describe("Reduce motion", () => {
  test("Settings On or the system's setting reduce motion", () => {
    expect(reducedMotion("on", false)).toBe(true);
    expect(reducedMotion("system", true)).toBe(true);
    expect(reducedMotion("system", false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The markdown reveal

const SAMPLE = [
  "# Plan",
  "",
  "Some **bold words** and *quiet* ones, `code`, a [link](https://example.com/a) and a [bad one](javascript:x).",
  "",
  "- first item",
  "- [x] a done task",
  "- second item with `code`",
  "",
  "1. one",
  "2. two",
  "",
  "> a quote that runs on",
  "",
  "```ts",
  "const a = 1;",
  "export function f(x: number) {",
  "  return x + a;",
  "}",
  "```",
  "",
  "| Name | Size |",
  "| --- | ---: |",
  "| alpha | 1 |",
  "| beta | 22 |",
  "",
  "---",
  "",
  "Last line.",
].join("\n");

const render = (model: MarkdownModel, reveal: { end: number; fade: number } | null) => renderToStaticMarkup(createElement(MarkdownView, { model, reveal }));
const plain = (source: string) => renderToStaticMarkup(createElement(Markdown, { source }));
const textOf = (html: string) =>
  html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");

describe("the markdown reveal", () => {
  const model = lexMarkdown(SAMPLE, null);

  test("the whole cut renders exactly as the reply renders without a reveal", () => {
    expect(render(model, { end: model.total, fade: model.total })).toBe(plain(SAMPLE));
    expect(render(model, null)).toBe(plain(SAMPLE));
  });

  test("the units count what shows: the text, plus one for each box, rule and line break", () => {
    for (const src of [SAMPLE, longReply(6000)]) {
      const m = lexMarkdown(src, null);
      // A code box's language label is its chrome, not the reply's text.
      const html = plain(src).replace(/<span class="chat-md-lang">[^<]*<\/span>/g, "").replace(/<button[^>]*data-testid="copy-code"[^>]*>[\s\S]*?<\/button>/g, "");
      const marks = (html.match(/<input|<hr|<br/g) ?? []).length;
      expect(m.total).toBe(textOf(html).length + marks);
    }
  });

  test("every cut shows whole words of the final text, and more as the cut moves on", () => {
    const full = textOf(plain(SAMPLE));
    // Where an element of the final text starts or ends, in its text.
    const edges = new Set<number>();
    let len = 0;
    for (const m of plain(SAMPLE).matchAll(/<[^>]*>|[^<]+/g)) {
      if (m[0].startsWith("<")) edges.add(len);
      else len += textOf(m[0]).length;
    }
    let before = "";
    for (let end = 0; end <= model.total; end++) {
      const html = render(model, { end, fade: end });
      const shown = textOf(html);
      // A prefix of what the whole reply shows: nothing half-parsed, nothing in a different form.
      expect(full.startsWith(shown)).toBe(true);
      expect(shown.length).toBeGreaterThanOrEqual(before.length);
      expect(shown.startsWith(before)).toBe(true);
      // Whole words: what shows ends at a space or where an element of the final text starts or ends.
      const at = shown.length;
      if (at > 0 && at < full.length) expect(/\s/.test(full[at - 1]!) || /\s/.test(full[at]!) || edges.has(at)).toBe(true);
      // No empty element is drawn ahead of its text.
      expect(html).not.toMatch(/<(p|li|strong|em|code|h\d|blockquote|ul|ol|a)\b[^>]*><\/\1>/);
      before = shown;
    }
    expect(before).toBe(full);
  });

  test("a code block grows inside its box and a table shows whole rows, never a fence or pipes", () => {
    for (let end = 0; end <= model.total; end++) {
      const html = render(model, { end, fade: end });
      expect(textOf(html)).not.toContain("```");
      expect(textOf(html)).not.toMatch(/\|\s*---/);
      const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? [];
      for (const r of rows) expect((r.match(/<t[hd]\b/g) ?? []).length).toBe(2);
    }
    // Part of the code shows in the code box while the rest has not come into view.
    const at = textOf(plain(SAMPLE)).indexOf("export function");
    const mid = render(model, { end: at + 10, fade: at + 10 });
    expect(mid).toContain('class="chat-md-code"');
    expect(textOf(mid)).toContain("export ");
    expect(textOf(mid)).not.toContain("return x");
  });

  test("words that came in the last moment fade in; earlier ones are plain text", () => {
    const html = render(model, { end: 60, fade: 40 });
    const fading = [...html.matchAll(/<span class="chat-word-in">([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(fading.length).toBeGreaterThan(0);
    const shown = textOf(html);
    // The fading words are the last ones that show (a space between two of them may be plain text).
    const words = (x: string) => x.replace(/\s+/g, "");
    expect(words(shown).endsWith(words(fading.join("")))).toBe(true);
    expect(fading.join("").length).toBeLessThan(shown.length);
    // Nothing fades once the fade's edge reached the cut.
    expect(render(model, { end: 60, fade: 60 })).not.toContain("chat-word-in");
  });

  test("links and Copy code keep working while the reply reveals", () => {
    const html = render(model, { end: 140, fade: 120 });
    expect(html).toContain('href="https://example.com/a"');
    expect(html).toContain('rel="noopener noreferrer"');
    const code = render(model, { end: textOf(plain(SAMPLE)).indexOf("return") + 3, fade: 0 });
    expect(code).toContain('data-testid="copy-code"');
  });

  test("the words that came into view in one frame fade in together, in one span", () => {
    const text = "aa bb cc dd ee ff gg hh";
    // Frames showed up to 8 and up to 14 since the fade's edge (3); the cut is at 20.
    const out = renderToStaticMarkup(createElement("div", null, revealText(text, { end: 20, fade: 3, marks: [8, 14] })));
    const spans = [...out.matchAll(/<span class="chat-word-in">([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(spans).toEqual(["bb cc ", "dd ee ", "ff gg"]);
    expect(textOf(out)).toBe("aa bb cc dd ee ff gg");
  });

  test("plain text (thinking) reveals the same way", () => {
    const text = "One two three four five six seven";
    expect(renderToStaticMarkup(createElement("div", null, revealText(text, null)))).toBe(`<div>${text}</div>`);
    const out = renderToStaticMarkup(createElement("div", null, revealText(text, { end: 16, fade: 8 })));
    expect(textOf(out)).toBe("One two three ");
    expect(out).toContain('<span class="chat-word-in">three </span>');
  });

  test("whole words: a cut inside a word shows up to the word before it", () => {
    expect(wholeWords("alpha beta gamma", 8)).toBe(6);
    expect(wholeWords("alpha beta gamma", 10)).toBe(10);
    expect(wholeWords("alpha beta gamma", 3)).toBe(0);
    expect(wholeWords("alpha beta gamma", 99)).toBe(16);
  });
});

describe("the reply is lexed once per piece, from its last blocks", () => {
  const strip = (tokens: Token[]) => JSON.parse(JSON.stringify(tokens)) as unknown;
  const samples = [
    SAMPLE,
    longReply(5000),
    "Para one\nstill one\n\nPara two\n\n    indented code\n\nafter",
    "- a\n\n- b\n\n  more of b\n\nafter the list\n\n1. x\n2. y",
    "Title\n===\n\ntext\n---\n\n> q\nlazy\n\n<div>\n\nhtml\n</div>\n\nend",
    "[ref]: https://example.com\n\nSee [ref] here.\n\nMore.",
    "Text\n| a | b |\n| - | - |\n| 1 | 2 |\n\nAfter\n\n```\nunclosed fence\n\nstill code",
  ];
  for (const [n, src] of samples.entries())
    test(`sample ${n}: piece by piece is the same as a whole lex`, () => {
      let seed = n + 3;
      let m: MarkdownModel | null = null;
      for (let at = 0; at < src.length; ) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        at = Math.min(src.length, at + 1 + (seed % 37));
        const text = src.slice(0, at);
        m = lexMarkdown(text, m);
        expect(strip(m.tokens!)).toEqual(strip(Lexer.lex(text, { gfm: true })));
      }
    });

  test("a long reply's pieces keep the blocks before the last ones (the same objects)", () => {
    const src = longReply(20000);
    const a = lexMarkdown(src.slice(0, 15000), null);
    const b = lexMarkdown(src.slice(0, 15040), a);
    expect(b.tokens![0]).toBe(a.tokens![0]!);
    expect(b.tokens![a.tokens!.length - 4]).toBe(a.tokens![a.tokens!.length - 4]!);
  });

  test("text that is not the last text with more after it is lexed whole", () => {
    const a = lexMarkdown("Alpha beta\n\ngamma", null);
    const b = lexMarkdown("Alpha\n\ngamma", a);
    expect(strip(b.tokens!)).toEqual(strip(Lexer.lex("Alpha\n\ngamma", { gfm: true })));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// What came live and what a load drew

const user = (id: string, text = "hi", queued?: boolean): Item => ({ kind: "user", id, text, queued });
const reply = (id: string, markdown: string, streaming?: boolean): Item => ({ kind: "assistant", id, markdown, streaming });

describe("a load or live events", () => {
  test("the first rows a chat draws, and a snapshot that marks it loaded, are a load", () => {
    expect(changeOf(null, [user("u1")], false, true).load).toBe(true);
    expect(changeOf([], [user("u1"), reply("a1", "x")], false, true).load).toBe(true);
  });

  test("a message that comes live is new; its echo and a reply's pieces are not a load", () => {
    const a = [user("u1"), reply("a1", "done")];
    const sent = [...a, user("u2")];
    expect(changeOf(a, sent, true, true)).toEqual({ load: false, added: ["u2"] });
    const echo = [...a, user("u2", "hi")];
    expect(changeOf(sent, echo, true, true)).toEqual({ load: false, added: [] });
    const r = [...echo, reply("a2", "Hel", true)];
    expect(changeOf(echo, r, true, true).load).toBe(false);
    const r2 = [...echo, reply("a2", "Hello the", true)];
    expect(changeOf(r, r2, true, true).load).toBe(false);
  });

  test("a snapshot that draws every row again is a load, also with an in-flight reply taken out", () => {
    const a = [user("u1"), reply("a1", "done"), user("u2"), reply("a2", "Hel", true)];
    const again = a.map((it) => ({ ...it }));
    expect(changeOf(a, again, true, true).load).toBe(true);
    const one = [user("u1"), reply("a1", "Hel", true)];
    expect(changeOf(one, [user("u1")], true, true).load).toBe(true);
  });

  test("a history read that adds another app's turn below the one row there was is a load", () => {
    const one = [user("u1")];
    expect(changeOf(one, [user("u1"), user("t1", "from the terminal"), reply("t2", "its reply")], true, true).load).toBe(true);
  });

  test("an older page above the rows is a load; a row before a queued message, or a taken-back one, is not", () => {
    const a = [user("u3"), reply("a3", "x")];
    expect(changeOf(a, [user("u1"), reply("a1", "old"), ...a], true, true).load).toBe(true);
    // The store keeps the rows that did not change as they were (the same objects).
    const [u1, a1, q1] = [user("u1"), reply("a1", "x", true), user("q1", "later", true)];
    const q = [u1!, a1!, q1!];
    expect(changeOf(q, [u1!, a1!, reply("a2", "", true), q1!], true, true)).toEqual({ load: false, added: ["a2"] });
    expect(changeOf(q, [u1!, a1!], true, true).load).toBe(false);
  });
});

describe("the fake claude's paced stream", () => {
  test("its message names the length, the pieces and the wait", () => {
    expect(pacedOf(pacedPrompt(20000, 400, 30))).toEqual({ chars: 20000, pieces: 400, ms: 30, thinking: false });
    expect(pacedOf(pacedPrompt(500, 10, 5, true))).toEqual({ chars: 500, pieces: 10, ms: 5, thinking: true });
    expect(pacedOf("hello")).toBeNull();
    expect(longReply(20000).length).toBeGreaterThanOrEqual(20000);
    expect(longReply(20000)).toBe(longReply(20000));
  });
});

describe("the styles", () => {
  const css = readFileSync(join(import.meta.dir, "..", "..", "web", "styles", "chat.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  test("a word fades in over the reveal time, and the user's message fades and rises in", () => {
    // The words' fade is their colour's (no layer per word to composite); a box, a row or a rule fades its opacity.
    expect(css).toMatch(/\.chat-word-in\s*\{[^}]*animation:\s*chat-ink var\(--t-reveal\)/);
    expect(css).toMatch(/@keyframes chat-ink\s*\{\s*from\s*\{\s*color:\s*transparent;?\s*\}/);
    expect(css).toMatch(/\.chat-block-in\s*\{[^}]*animation:\s*chat-fade var\(--t-reveal\)/);
    expect(css).toMatch(/\.chat-user\.is-entering\s*\{[^}]*animation:\s*chat-rise var\(--t-reveal\)/);
  });
  test("Reduce motion, from the system or from Settings, turns both off", () => {
    const media = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*\.chat-word-in[^@]*animation: none/);
    expect(css).toMatch(/:root\[data-motion="reduce"\] \.chat-word-in/);
    expect(media.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// No flicker: a word that came into view fades in once. Its span keeps its key (React keeps the element, and its fade
// goes on) until the fade is over and it becomes plain text; it never moves to a new span, and plain text never goes
// back into one.

/** A reply streamed as the fake claude streams it (`pieces` even pieces, `every` ms apart), drawn frame by frame. */
function streamFrames(src: string, pieces: number, every: number, draw: (model: MarkdownModel, cut: RevealCut | null, t: number) => string) {
  const size = Math.ceil(src.length / pieces);
  return streamAt(src, Array.from({ length: pieces }, (_, i) => Math.min(src.length, (i + 1) * size)), every, draw);
}

/**
 * A reply streamed in pieces that end at `ends` (characters), `every` ms apart, drawn frame by frame as AssistantText
 * draws it: each piece held as useMarkdownModel holds it (holdPartial, with what the last piece showed), and lexed.
 */
function streamAt(src: string, ends: readonly number[], every: number, draw: (model: MarkdownModel, cut: RevealCut | null, t: number) => string) {
  const p = newPacer(0, 0);
  const pieces = ends.length;
  const out: { t: number; html: string; text: string; cut: RevealCut | null }[] = [];
  let model: MarkdownModel | null = null;
  let came = 0;
  const endAt = (pieces - 1) * every;
  for (let t = FRAME; t <= endAt + 600; t += FRAME) {
    let next = came;
    while (next < pieces && next * every <= t) next++;
    const live = next < pieces || t < endAt;
    if (next !== came || !model) {
      came = next;
      const text = src.slice(0, came ? ends[came - 1]! : 0);
      model = lexMarkdown(came < pieces ? holdPartial(text, model?.text) : text, model);
      if (came < pieces) arrive(p, model.total, (came - 1) * every);
      else finish(p, model.total, t);
    }
    if (live) advance(p, t);
    const cut = settled(p, t) ? null : cutNow(p, model.total, t);
    const html = draw(model, cut, t);
    out.push({ t, html, text: textOf(html), cut });
  }
  return out;
}

/** For each character the frame shows: the start (in the shown text) of the fading span that holds it, or -1 when it is plain. */
function spanStarts(html: string): number[] {
  const out: number[] = [];
  const stack: boolean[] = [];
  let fadingAt = -1;
  for (const m of html.matchAll(/<\/?span\b[^>]*>|<[^>]*>|[^<]+/g)) {
    const tok = m[0];
    if (tok.startsWith("</span")) {
      if (stack.pop()) fadingAt = -1;
    } else if (tok.startsWith("<span")) {
      const fading = /class="chat-word-in"/.test(tok);
      stack.push(fading);
      if (fading) fadingAt = out.length;
    } else if (!tok.startsWith("<")) for (const _ of textOf(tok)) out.push(fadingAt);
  }
  return out;
}

/** The faults of a run: a character that changes from one fading span to another, or from plain back into a span. */
function restarts(frames: { t: number; html: string }[]): string[] {
  const faults: string[] = [];
  let before: number[] = [];
  for (const f of frames) {
    const now = spanStarts(f.html);
    for (let i = 0; i < Math.min(before.length, now.length); i++) {
      if (before[i] === -1 && now[i] !== -1) faults.push(`t=${Math.round(f.t)}: character ${i} went from plain text back into a fading span`);
      else if (before[i] !== -1 && now[i] !== -1 && now[i] !== before[i]) faults.push(`t=${Math.round(f.t)}: character ${i} moved from the span at ${before[i]} to a new one at ${now[i]}`);
    }
    before = now;
  }
  return faults;
}

/** The keys of revealText's fading spans: what React matches the spans of one frame to the next by. */
function fadingKeys(node: ReactNode): { key: string; text: string }[] {
  if (!isValidElement(node)) return [];
  const kids = (node as ReactElement<{ children?: ReactNode }>).props.children;
  return (Array.isArray(kids) ? kids : [kids]).filter(isValidElement).map((k) => ({ key: String(k.key), text: String((k as ReactElement<{ children?: ReactNode }>).props.children) }));
}

describe("no flicker while text reveals", () => {
  test("plain text (thinking): a fading span keeps its key while its fade runs, also when the fade's edge is at a space", () => {
    const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon";
    // The cut showed "alpha" at one frame and "beta" at the next; the fade's edge then reaches the space between them.
    const a = fadingKeys(revealText(text, { end: 10, fade: 3, marks: [5, 10] }));
    const b = fadingKeys(revealText(text, { end: 16, fade: 5, marks: [10, 16] }));
    const beta = (ks: { key: string; text: string }[]) => ks.find((k) => k.text.includes("beta"))!;
    expect(beta(b).key).toBe(beta(a).key);
    expect(beta(b).text.startsWith("beta")).toBe(true);
    // And frame by frame over a stream.
    const frames = streamFrames(text.repeat(20), 40, 80, (_m, cut, t) => renderToStaticMarkup(createElement("div", null, revealText(text.repeat(20).slice(0, Math.max(0, _m.text.length)), cut))) + `<!--${t}-->`);
    expect(restarts(frames)).toEqual([]);
  });

  for (const [name, src, pieces, every] of [
    ["a long markdown reply, steady", longReply(6000), 75, 80],
    ["a long markdown reply, in bursts", longReply(4000), 10, 900],
  ] as const)
    test(`${name}: no word fades in twice`, () => {
      const frames = streamFrames(src, pieces, every, (m, cut) => render(m, cut));
      expect(frames.at(-1)!.text).toBe(textOf(plain(src)));
      expect(restarts(frames).slice(0, 5)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------------------------------------------
// No empty element ahead of its text: an element with parts of its own (a list item's bullet, a task's box, an
// inline code pill, a quote's rule) comes with its first word, and while that word is new the element fades in as a
// whole (its opacity), so its parts never show at full strength beside text that is still transparent.

const CHROME = new Set(["li", "code", "blockquote"]);
const VOID = new Set(["input", "br", "hr", "img"]);

/** The elements with parts of their own that a frame draws: their tag, classes, and their plain and fading text. */
function chromed(html: string) {
  type El = { tag: string; cls: string; plain: string; fading: string; box: boolean; inPre: boolean };
  const out: El[] = [];
  const stack: (El | { tag: string; fading: boolean })[] = [];
  let fading = 0;
  let pre = 0;
  for (const m of html.matchAll(/<(\/?)([a-z0-9]+)([^>]*)>|[^<]+/g)) {
    if (m[2] === undefined) {
      const t = textOf(m[0]);
      for (const e of stack) if ("plain" in e) fading ? (e.fading += t) : (e.plain += t);
      continue;
    }
    const [, close, tag, attrs] = m as unknown as [string, string, string, string];
    const cls = /class="([^"]*)"/.exec(attrs)?.[1] ?? "";
    if (VOID.has(tag)) {
      if (tag === "input") for (const e of stack) if ("plain" in e) e.box = true;
      continue;
    }
    if (close) {
      const e = stack.pop()!;
      if (tag === "pre") pre--;
      if ("fading" in e && typeof e.fading === "boolean" && e.fading) fading--;
      continue;
    }
    if (tag === "pre") pre++;
    if (CHROME.has(tag)) {
      const e: El = { tag, cls, plain: "", fading: "", box: false, inPre: pre > 0 };
      out.push(e);
      stack.push(e);
    } else {
      const f = tag === "span" && cls.split(" ").includes("chat-word-in");
      if (f) fading++;
      stack.push({ tag, fading: f });
    }
  }
  return out.filter((e) => !e.inPre);
}

/** What is wrong with a frame: an element drawn with no text, or with all its text still fading while it does not fade itself. */
function emptyAhead(html: string): string[] {
  const faults: string[] = [];
  for (const e of chromed(html)) {
    const whole = e.cls.split(" ").includes("chat-block-in");
    if (!(e.plain + e.fading).trim()) faults.push(`a <${e.tag}${e.box ? "> with a box" : ">"} and no text`);
    else if (!e.plain.trim() && !whole) faults.push(`a <${e.tag}> whose text all fades in while its own parts show at once ("${e.fading.slice(0, 30)}")`);
  }
  return faults;
}

describe("no empty element ahead of its text", () => {
  const TASKS = "Plan:\n\n- [ ] first task here\n- [x] second task here\n\nA `code pill` and\n\n> a quote here\n\n1. one item\n2. two items";
  const m = lexMarkdown(TASKS, null);

  test("a task's box comes with the item's first word, never alone", () => {
    for (let end = 0; end <= m.total; end++) {
      for (const fade of [0, Math.max(0, end - 4), end]) {
        const html = render(m, { end, fade });
        for (const li of html.match(/<li class="chat-md-task">[\s\S]*?<\/li>/g) ?? []) expect(textOf(li).trim().length).toBeGreaterThan(0);
        // The cut never ends just after a box: the box and the word after it show together.
        if (/<input[^>]*\/?>(<\/li>|<\/p>)/.test(html)) throw new Error(`a box with no text at end ${end}, fade ${fade}: ${html}`);
      }
    }
  });

  test("an element whose words are all new fades in as a whole; one that came earlier keeps its words' fades", () => {
    for (let end = 0; end <= m.total; end++)
      for (const fade of [0, Math.max(0, end - 4), Math.max(0, end - 9), end]) expect(emptyAhead(render(m, { end, fade })).map((f) => `end ${end}, fade ${fade}: ${f}`)).toEqual([]);
    // A list item that came a while ago draws as it is, with no fade of its own.
    const item = textOf(plain(TASKS)).indexOf("second");
    const late = render(m, { end: m.total, fade: item + 20 });
    expect(late).not.toMatch(/<li class="chat-md-task chat-block-in"/);
  });

  for (const [name, src, pieces, every] of [
    ["a long reply, steady", longReply(6000), 75, 80],
    ["a long reply, in bursts", longReply(4000), 10, 900],
  ] as const)
    test(`${name}: no frame draws a bullet, a box, a pill or a quote's rule ahead of its text`, () => {
      const frames = streamFrames(src, pieces, every, (mm, cut) => render(mm, cut));
      const faults = frames.flatMap((f) => emptyAhead(f.html).map((x) => `t=${Math.round(f.t)}: ${x}`));
      expect(faults.slice(0, 5)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------------------------------------------
// A stream that pauses: the reveal catches up with what came, and what came ends in the middle of a word or of an
// inline construct. That end waits: the text that shows never gets shorter, and no half-parsed form shows.

/** The text a frame shows outside code boxes. */
const prose = (html: string) => textOf(html.replace(/<pre>[\s\S]*?<\/pre>/g, "").replace(/<code>[\s\S]*?<\/code>/g, " "));

describe("a stream that pauses", () => {
  for (const [name, src, pieces, every] of [
    ["in bursts 900 ms apart", longReply(4000), 10, 900],
    ["in small pieces 300 ms apart", longReply(2500), 60, 300],
  ] as const) {
    test(`${name}: the text that shows only grows, with no half-parsed code, emphasis or link`, () => {
      const frames = streamFrames(src, pieces, every, (mm, cut) => render(mm, cut));
      let before = "";
      const faults: string[] = [];
      for (const f of frames) {
        if (!f.text.startsWith(before)) faults.push(`t=${Math.round(f.t)}: the text went from ${before.length} to ${f.text.length} characters ("...${before.slice(-24)}" then "...${f.text.slice(-24)}")`);
        const p = prose(f.html);
        for (const bad of ["`", "](", "**"]) if (p.includes(bad)) faults.push(`t=${Math.round(f.t)}: "${bad}" shows in the text ("...${p.slice(Math.max(0, p.indexOf(bad) - 20), p.indexOf(bad) + 20)}...")`);
        before = f.text;
      }
      expect(faults.slice(0, 5)).toEqual([]);
      expect(frames.at(-1)!.text).toBe(textOf(plain(src)));
    });

    test(`${name}, under Reduce motion (no reveal): no half-parsed code, emphasis or link either`, () => {
      const size = Math.ceil(src.length / pieces);
      let model: MarkdownModel | null = null;
      const faults: string[] = [];
      for (let k = 1; k < pieces; k++) {
        model = lexMarkdown(holdPartial(src.slice(0, k * size)), model);
        const p = prose(render(model, null));
        for (const bad of ["`", "](", "**"]) if (p.includes(bad)) faults.push(`piece ${k}: "${bad}" shows ("...${p.slice(Math.max(0, p.indexOf(bad) - 20), p.indexOf(bad) + 20)}...")`);
      }
      expect(faults).toEqual([]);
    });
  }

  test("the live end waits for its word and its closing mark", () => {
    expect(holdPartial("It keeps going")).toBe("It keeps ");
    expect(holdPartial("It keeps ")).toBe("It keeps ");
    expect(holdPartial("A `code sp")).toBe("A ");
    expect(holdPartial("A `code span` here and")).toBe("A `code span` here ");
    expect(holdPartial("Some **bold wor")).toBe("Some ");
    expect(holdPartial("Some *quiet emph")).toBe("Some ");
    expect(holdPartial("See [a link](https://example.com/do")).toBe("See ");
    expect(holdPartial("See [a link] ")).toBe("See [a link] ");
    expect(holdPartial("See [a link](https://example.com/docs) now ")).toBe("See [a link](https://example.com/docs) now ");
    // A word with a mark inside it, or a mark with spaces around it, is text: nothing waits for it.
    expect(holdPartial("snake_case and 2 * 3 ")).toBe("snake_case and 2 * 3 ");
    // A line with only its markers waits for its first word.
    expect(holdPartial("Intro\n\n- [ ] fir")).toBe("Intro\n\n");
    expect(holdPartial("Intro\n\n## Par")).toBe("Intro\n\n");
    expect(holdPartial("Intro\n\n> a quo")).toBe("Intro\n\n> a ");
    // Inside an open code fence only the word waits.
    expect(holdPartial("```ts\nconst a = `x\nexport fun")).toBe("```ts\nconst a = `x\nexport ");
    // A table still waits for its separator row.
    expect(holdPartial("Text\n\n| a | b |\n")).toBe("Text\n");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// FIX-Q1 1: Chinese, Japanese and Korean text reveal smoothly. The reveal's unit is the word as Intl.Segmenter finds
// it (one or two characters in Chinese and Japanese, which have no spaces; today's space-separated words in English
// and Korean), with today's rule where Segmenter is missing. The pace, the fade and the held partial marks stay.

const ZH = [
  "## 修复上传测试",
  "",
  "这个测试有时会失败，因为上传在超时之前没有完成。我把等待时间从五秒改成了十秒，并且在每次重试之前**清理临时文件**，所以同一个文件不会被上传两次。",
  "",
  "- 运行`bun test`三次，全部通过",
  "- [x] 检查日志中没有新的错误",
  "- 更新了[文档](https://example.com/docs)里的说明",
  "",
  "> 注意：这个修复只影响测试，不影响正式代码。",
  "",
  "| 文件 | 改动 |",
  "| --- | --- |",
  "| upload.test.ts | 等待十秒 |",
  "| retry.ts | 清理临时文件 |",
  "",
  "最后一行，到这里就结束了。",
].join("\n");
const JA = "今日はアップロードのテストを直しました。タイムアウトを五秒から十秒に変更し、再試行の前に一時ファイルを**削除**するようにしました。テストは三回とも成功しました。次は説明を更新します。";
const MIXED = "我用Bun写了一个HTTP服务器，端口是7945。运行 `bun test` 之后，所有的test都通过了（共42个）。下一步是把README.md翻译成English，然后在Claude Code里再检查一遍。";
const KO = "오늘은 업로드 테스트를 고쳤습니다. 시간 제한을 오 초에서 십 초로 바꾸고, 다시 시도하기 전에 임시 파일을 지우도록 했습니다.";
const EN_PROSE =
  "Today I fixed the upload test. The timeout went from five seconds to ten, and the temporary file is now **removed** before each retry, so the same file is never sent twice. The test passed three times in a row.";

/** The text a frame shows, frame by frame, for a plain reply streamed as the demo streams it (30 pieces, 60 ms apart). */
function revealSteps(src: string, pieces = 30, every = 60) {
  const frames = streamFrames(src, pieces, every, (m, cut) => render(m, cut));
  const full = textOf(plain(src)).length;
  const shown = frames.map((f) => f.text.length);
  const first = shown.findIndex((n) => n > 0);
  const whole = shown.findIndex((n) => n >= full);
  const during = shown.slice(first, whole + 1);
  const deltas = during.slice(1).map((n, i) => n - during[i]!);
  // How far what shows is behind the reveal's cut (the pacer's units, which count the text as it shows).
  const behind = frames.map((f) => (f.cut ? Math.max(0, f.cut.end - f.text.length) : 0));
  return { frames, full, grew: deltas.filter((d) => d > 0).length, frames_: during.length, maxStep: Math.max(...deltas), perFrame: full / during.length, behind: Math.max(...behind) };
}

/** Run `f` as a browser without Intl.Segmenter would. */
function withoutSegmenter<T>(f: () => T): T {
  const intl = Intl as unknown as { Segmenter?: unknown };
  const had = intl.Segmenter;
  delete intl.Segmenter;
  try {
    return f();
  } finally {
    intl.Segmenter = had;
  }
}

/** Where a cut may fall in `s` without splitting a character a reader sees as one (a grapheme). */
function graphemeEdges(s: string): Set<number> {
  const out = new Set<number>([s.length]);
  for (const g of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)) out.add(g.index);
  return out;
}

describe("Chinese, Japanese and Korean text reveal smoothly (FIX-Q1)", () => {
  test("a Chinese, a Japanese and a mixed reply reveal in many small steps, at the same pace as English", () => {
    // Plain text of the same length, so the same pieces at the same times bring the same characters.
    const fit = (x: string) => x.replace(/\*\*|`/g, "").repeat(8).slice(0, 600);
    const en = revealSteps(fit(EN_PROSE));
    expect(en.grew).toBeGreaterThan(60);
    for (const [name, src] of [
      ["Chinese", fit(ZH.split("\n")[2]!)],
      ["Japanese", fit(JA)],
      ["mixed", fit(MIXED)],
    ] as const) {
      const r = revealSteps(src);
      const at = `${name}: ${r.grew} growing frames of ${r.frames_}, steps up to ${r.maxStep}, ${r.behind} behind the cut (English: ${en.grew} of ${en.frames_}, up to ${en.maxStep})`;
      // Many small steps: as many growing frames as English, none bigger than English's biggest.
      expect(r.grew, at).toBeGreaterThanOrEqual(Math.floor(en.grew * 0.9));
      expect(r.maxStep, at).toBeLessThanOrEqual(en.maxStep);
      // Never more than a word behind the cut (a Chinese word is one or two characters; "Claude" in the mixed one).
      expect(r.behind, at).toBeLessThanOrEqual(name === "mixed" ? 10 : 4);
      // The same pace: characters a frame within 15% of English's.
      expect(Math.abs(r.perFrame - en.perFrame) / en.perFrame, at).toBeLessThan(0.15);
    }
  });

  test("the units: one or two characters of Chinese and Japanese, today's words in English and Korean", () => {
    const zh = "这是一个演示，对话都是虚构的";
    // Every cut inside the Chinese shows all but at most the word it falls in (never more than 3 characters).
    for (let room = 1; room < zh.length; room++) expect(room - wholeWords(zh, room)).toBeLessThanOrEqual(2);
    expect(wholeWords(zh, 3)).toBeGreaterThan(0);
    expect(wholeWords("今日はいい天気です", 4)).toBeGreaterThan(0);
    // A word and its punctuation come together; an opening bracket comes with the word after it.
    expect(wholeWords("你好，世界", 3)).not.toBe(2);
    expect(wholeWords("请看（注意）这里", 3)).toBe(2);
    // A Latin word after fullwidth punctuation is a word of its own: "上，" shows before "kitespan" is whole.
    expect(wholeWords("机器上，kitespan 会", 8)).toBe(4);
    // Latin text inside Chinese keeps its words whole: "Bun" never shows as "Bu".
    const mixed = "我用Bun写了";
    for (let room = 0; room <= mixed.length; room++) expect([0, 1, 2, 5, 6, 7]).toContain(wholeWords(mixed, room));
    // English and Korean are as before: a space ends a word, and nothing else does. Also next to the few marks that
    // Han's Script_Extensions share with Latin (a middle dot, a modifier apostrophe, combining marks: Q1 review).
    for (const s of ["foo-bar, e.g. U.S.A. (see) don't snake_case", "오늘은 업로드 테스트를 고쳤습니다.", "Total\u00b742, page\u00b72 of 3, v2\u00b7beta, Settings\u00b7About, don\u02bct, man\u0303ana, x\u0331y and a\u02d7b"])
      for (let room = 0; room <= s.length; room++) expect(wholeWords(s, room)).toBe(withoutSegmenter(() => wholeWords(s, room)));
  });

  test("a cut never splits a character a reader sees as one: an emoji, a flag, a family, an accent", () => {
    const s = "请看👍🏽这里👨‍👩‍👧好的🇨🇳中国é了x̃好";
    const edges = graphemeEdges(s);
    for (let room = 0; room <= s.length; room++) expect(edges.has(wholeWords(s, room)), `room ${room}`).toBe(true);
    const m = lexMarkdown(s, null);
    for (let end = 0; end <= m.total; end++) {
      const shown = textOf(render(m, { end, fade: end }));
      expect(s.startsWith(shown)).toBe(true);
      expect(edges.has(shown.length), `end ${end}: "${shown}"`).toBe(true);
    }
  });

  test("every cut of a Chinese reply shows whole words of the final text, and more as the cut moves on", () => {
    const model = lexMarkdown(ZH, null);
    const full = textOf(plain(ZH));
    let before = "";
    let steps = 0;
    for (let end = 0; end <= model.total; end++) {
      const html = render(model, { end, fade: end });
      const shown = textOf(html);
      expect(full.startsWith(shown), `end ${end}`).toBe(true);
      expect(shown.startsWith(before), `end ${end}`).toBe(true);
      expect(html).not.toMatch(/<(p|li|strong|em|code|h\d|blockquote|ul|ol|a)\b[^>]*><\/\1>/);
      if (shown.length > before.length) steps++;
      before = shown;
    }
    expect(before).toBe(full);
    // About one step for every two characters, not a few big jumps.
    expect(steps).toBeGreaterThan(full.length / 3);
  });

  for (const [name, src, pieces, every] of [
    ["a Chinese reply, steady", ZH, 40, 80],
    ["a Chinese reply, in bursts", ZH.repeat(3), 6, 900],
    ["a Japanese reply, in small pieces", JA.repeat(4), 60, 300],
    ["a mixed reply, steady", MIXED.repeat(3), 30, 60],
  ] as const)
    test(`${name}: no word fades in twice, nothing empty ahead of its text, only growing, no half-parsed mark`, () => {
      const frames = streamFrames(src, pieces, every, (m, cut) => render(m, cut));
      expect(frames.at(-1)!.text).toBe(textOf(plain(src)));
      expect(restarts(frames).slice(0, 5)).toEqual([]);
      expect(frames.flatMap((f) => emptyAhead(f.html).map((x) => `t=${Math.round(f.t)}: ${x}`)).slice(0, 5)).toEqual([]);
      const faults: string[] = [];
      let before = "";
      for (const f of frames) {
        if (!f.text.startsWith(before)) faults.push(`t=${Math.round(f.t)}: the text went from "...${before.slice(-12)}" to "...${f.text.slice(-12)}"`);
        const p = prose(f.html);
        for (const bad of ["`", "](", "**"]) if (p.includes(bad)) faults.push(`t=${Math.round(f.t)}: "${bad}" shows ("...${p.slice(Math.max(0, p.indexOf(bad) - 12), p.indexOf(bad) + 12)}...")`);
        before = f.text;
      }
      expect(faults.slice(0, 5)).toEqual([]);
    });

  test("the live end of a Chinese reply waits for its last word only, and still for a closing mark", () => {
    const zh = ZH.split("\n")[2]!;
    // Piece by piece: never more than the last word held back, outside a mark (which waits for what follows it).
    for (let i = 1; i <= zh.length; i++) {
      const held = holdPartial(zh.slice(0, i));
      expect(zh.startsWith(held)).toBe(true);
      const tail = zh.slice(held.length, i);
      if (!tail.includes("*")) expect(tail.length, `after ${i} characters: "${held}"`).toBeLessThanOrEqual(3);
    }
    expect(holdPartial("这是一个演示")).toBe("这是一个");
    expect(holdPartial("在你自己的机器上，kitespan")).toBe("在你自己的机器上，");
    expect(holdPartial("在每次重试之前**清理临时")).toBe("在每次重试之前");
    expect(holdPartial("运行`bun te")).toBe("运行");
    expect(holdPartial("更新了[文档](https://exa")).toBe("更新了");
    // A line of only its block's markers still waits for its first word.
    expect(holdPartial("说明\n\n- [ ] 第")).toBe("说明\n\n");
    // Korean has spaces: its words wait as English ones do.
    expect(holdPartial("오늘은 업로드 테스")).toBe("오늘은 업로드 ");
  });

  test("an English reply's steps are unchanged: the same frames with Segmenter as without it (today's rule)", () => {
    const EN = "Some **bold words** and *quiet* ones, `code`, a [link](https://example.com/a), foo-bar, e.g. U.S.A. (see) don't; snake_case x=1 — “quoted,” she said. 3.14 café 👍🏽 ok. Open Settings\u00b7About, then page\u00b72 of 3, Total\u00b742; man\u0303ana.";
    for (const [src, pieces, every] of [
      [EN.repeat(3), 40, 80],
      [SAMPLE, 30, 60],
      [longReply(6000), 75, 80],
      [longReply(4000), 10, 900],
    ] as const) {
      const drawn = streamFrames(src, pieces, every, (m, cut) => render(m, cut)).map((f) => f.html);
      const today = withoutSegmenter(() => streamFrames(src, pieces, every, (m, cut) => render(m, cut)).map((f) => f.html));
      expect(drawn).toEqual(today);
    }
    for (let i = 0; i <= EN.length; i++) expect(holdPartial(EN.slice(0, i))).toBe(withoutSegmenter(() => holdPartial(EN.slice(0, i))));
  });

  test("without Intl.Segmenter a Chinese reply reveals by today's rule, whole space-separated words, and renders right", () => {
    withoutSegmenter(() => {
      expect(wholeWords("这是一个演示 abc", 4)).toBe(0);
      expect(holdPartial("这是一个演示")).toBe("");
      const m = lexMarkdown(ZH, null);
      expect(render(m, { end: m.total, fade: m.total })).toBe(plain(ZH));
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Q1 review: what shows only grows, also where Segmenter's words change as more comes. Segmenter's word ends are not
// stable while a reply streams: an end near the live end goes when the next character joins two segments into one
// word (とき then ときどき, 書き then 書き込み, ス then スペース, 下 then 下一步, and Thai likewise). Text that has shown never
// goes: the live end never stops before where it stopped (holdPartial and holdWord with what showed), and a text that
// grew keeps the word ends it had, its old end among them (wordBreaks). And Segmenter's work per piece is the piece's
// own size, not the live block's (the cost per frame, 4 ms, DESIGN 6.3).

const UNSTABLE: Record<string, string> = {
  Japanese:
    "このテストはファイルの書き込みを待たずに次のリクエストを送っていたため、ときどき失敗していました。スペースが足りないときも、書き込みが終わるまで待ってからリクエストを送ります。",
  Chinese: "下一步：运行测试。下一步是提交，然后下一步再检查一遍。",
  Thai: "การทดสอบนี้ล้มเหลวเป็นบางครั้งเพราะไม่ได้รอให้เขียนไฟล์เสร็จ ตอนนี้รอจนเขียนเสร็จแล้วจึงส่งคำขอต่อไป",
};

/** Piece ends of 1 to 4 characters, the same for the same seed (a small linear congruential generator). */
function smallPieces(n: number, seed: number): number[] {
  const out: number[] = [];
  let x = seed;
  for (let at = 0; at < n; ) {
    x = (x * 1103515245 + 12345) % 2147483648;
    at = Math.min(n, at + 1 + (x % 4));
    out.push(at);
  }
  return out;
}

/** The faults of frames whose text does not start with the frame before's. */
function shrinks(frames: { t: number; text: string }[]): string[] {
  const faults: string[] = [];
  let before = "";
  for (const f of frames) {
    if (!f.text.startsWith(before)) faults.push(`t=${Math.round(f.t)}: "...${before.slice(-10)}" became "...${f.text.slice(-10)}"`);
    before = f.text;
  }
  return faults;
}

/** Thinking text streamed in pieces that end at `ends`, `every` ms apart, as ThinkingRow draws it (useHeldWord, revealText). */
function thinkingFrames(src: string, ends: readonly number[], every: number) {
  const p = newPacer(0, 0);
  const out: { t: number; text: string; html: string }[] = [];
  let held = "";
  let came = 0;
  const endAt = (ends.length - 1) * every;
  for (let t = FRAME; t <= endAt + 600; t += FRAME) {
    let next = came;
    while (next < ends.length && next * every <= t) next++;
    if (next !== came) {
      came = next;
      const text = src.slice(0, ends[came - 1]!);
      held = came < ends.length ? holdWord(text, held) : text;
      if (came < ends.length) arrive(p, held.length, (came - 1) * every);
      else finish(p, held.length, t);
    }
    if (came < ends.length || t < endAt) advance(p, t);
    const cut = settled(p, t) ? null : cutNow(p, held.length, t);
    const html = renderToStaticMarkup(createElement("div", null, revealText(held, cut)));
    out.push({ t, text: textOf(html), html });
  }
  return out;
}

describe("what shows only grows, also where Segmenter's words change as more comes (Q1 review)", () => {
  test("the live end never stops before where it stopped, one character at a time", () => {
    for (const [name, src] of Object.entries(UNSTABLE)) {
      let held = "";
      let word = "";
      for (let i = 1; i <= src.length; i++) {
        const next = holdPartial(src.slice(0, i), held);
        expect(next.startsWith(held), `${name}, ${i} characters: "...${held.slice(-8)}" then "...${next.slice(-8)}"`).toBe(true);
        held = next;
        const w = holdWord(src.slice(0, i), word);
        expect(w.startsWith(word), `${name}, ${i} characters (holdWord): "...${word.slice(-8)}" then "...${w.slice(-8)}"`).toBe(true);
        word = w;
      }
    }
  });

  for (const [name, src] of Object.entries(UNSTABLE)) {
    test(`${name}, one character at a time 300 ms apart, and 1 to 4 at a time: each frame's text starts with the last one's`, () => {
      for (const ends of [Array.from({ length: src.length }, (_, i) => i + 1), smallPieces(src.length, 7), smallPieces(src.length, 11)]) {
        const frames = streamAt(src, ends, 300, (m, cut) => render(m, cut));
        expect(shrinks(frames).slice(0, 5)).toEqual([]);
        expect(restarts(frames).slice(0, 5)).toEqual([]);
        expect(frames.at(-1)!.text).toBe(textOf(plain(src)));
      }
    });
  }

  test("thinking text likewise: each frame's text starts with the last one's, and no word fades in twice", () => {
    for (const src of Object.values(UNSTABLE)) {
      for (const ends of [Array.from({ length: src.length }, (_, i) => i + 1), smallPieces(src.length, 5)]) {
        const frames = thinkingFrames(src, ends, 300);
        expect(shrinks(frames).slice(0, 5)).toEqual([]);
        expect(restarts(frames).slice(0, 5)).toEqual([]);
        expect(frames.at(-1)!.text).toBe(src);
      }
    }
  });

  test("a row drawn anew while its block streams goes on from what it showed (a snapshot took the block out)", () => {
    const src = UNSTABLE.Japanese!;
    const held = (Hook: (s: string) => string, s: string) => textOf(renderToStaticMarkup(createElement(() => createElement("pre", null, Hook(s)))));
    const reply = (s: string) => useMarkdownModel(s, true, "chat-q1\nmsg-q1").text;
    const thinking = (s: string) => useHeldWord(s, true, "chat-q1\nthink-q1");
    for (const Hook of [reply, thinking]) {
      // Each render is a new mount: the row's own memory is gone, and only the block's key carries what showed.
      let before = "";
      for (let i = 1; i <= src.length; i++) {
        const now = held(Hook, src.slice(0, i));
        expect(now.startsWith(before), `${i} characters: "...${before.slice(-8)}" then "...${now.slice(-8)}"`).toBe(true);
        before = now;
      }
    }
  });

  test("Segmenter's work per piece is the piece's own size: a long Chinese paragraph, a long code block, long thinking", () => {
    const proto = Intl.Segmenter.prototype;
    const segment = proto.segment;
    let chars = 0;
    proto.segment = function (this: Intl.Segmenter, s: string) {
      chars += s.length;
      return segment.call(this, s);
    };
    try {
      const para = ZH.split("\n")[2]!.repeat(40).slice(0, 3000);
      const code = "```\n" + Array.from({ length: 60 }, (_, i) => `[${i}] 上传完成，等待下一次重试：文件已经清理`).join("\n") + "\n```";
      const think = (ZH.split("\n")[2]! + JA).repeat(60).slice(0, 12000);
      const runs: [string, () => unknown, number][] = [
        ["a 3,000-character Chinese paragraph in 120 pieces", () => streamFrames(para, 120, 25, (m, cut) => render(m, cut)), para.length],
        ["a plain code block of Chinese log lines in 100 pieces", () => streamFrames(code, 100, 25, (m, cut) => render(m, cut)), code.length],
        ["12,000 characters of thinking in 480 pieces", () => thinkingFrames(think, Array.from({ length: 480 }, (_, i) => Math.min(think.length, (i + 1) * 25)), 25), think.length],
      ];
      for (const [what, go, n] of runs) {
        chars = 0;
        go();
        // Each piece segments its own characters and a few before them, not the whole block again.
        expect(chars / n, `${what}: ${chars} characters segmented for ${n}`).toBeLessThan(8);
      }
    } finally {
      proto.segment = segment;
    }
  });
});
