// S1 (FIX-S1): a reply's reveal on a long chat costs about the same per frame as on a short one. Each row of the column
// is its own stacking context, so a frame restacks and hit-tests the live row alone, not every positioned box of the
// transcript; and no row clips or skips its paint, because a row's parts reach past its box. While only a reply's text
// grows, the screen around the conversation keeps the chat it drew (state/steady.ts), so it does not draw again per piece;
// and the finished turns keep their objects and layouts (chat/turns.ts), so the conversation draws them once. A long reply's
// finished top blocks keep their tokens and are drawn in groups (Markdown.tsx), so a frame of its reveal draws the live end.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Token } from "marked";
import type { ChatEvent } from "../../shared/protocol";
import { cardCalls } from "../../web/chat/fold";
import { MarkdownView, TopBlock, holdPartial, lexMarkdown, type MarkdownModel, type RevealCut } from "../../web/chat/Markdown";
import { layoutCache, shareBlocks, turnLayout, turnsOf, type Block, type TurnOpts } from "../../web/chat/turns";
import { AssistantText } from "../../web/chat/items/Text";
import { applyEvent, type ChatPart } from "../../web/state/reduce";
import { steadyChat, steadyChats, textOnly } from "../../web/state/steady";
import type { Item } from "../../web/state/types";
import { CHATS } from "./fixtures";
import { longReply } from "../fake-claude/long-reply";

const STYLES = join(import.meta.dir, "..", "..", "web", "styles");
const css = readFileSync(join(STYLES, "chat.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** A selector list's selectors (split at the commas outside parentheses). */
function selectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(list.slice(from, i).trim());
      from = i + 1;
    }
  }
  out.push(list.slice(from).trim());
  return out;
}

/** The declarations of every rule whose selector list holds `selector` exactly. */
function rulesOf(selector: string): string[] {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) if (selectors(m[1]!).includes(selector)) out.push(m[2]!);
  return out;
}

describe("the column's rows (S1)", () => {
  test("each row of the column is its own stacking context", () => {
    expect(rulesOf(".chat-col > *").some((d) => /(?:^|;)\s*isolation:\s*isolate\s*(?:;|$)/.test(d))).toBe(true);
  });

  test("no rule clips or skips a row's paint: a row line's hover and ring, a turn's thread and the linked row's wash reach past it", () => {
    // What reaches past a row's box today (if one of these goes, the rule below may be looked at again).
    expect(rulesOf(".chat-row").join(";")).toMatch(/margin-left:\s*-6px/);
    expect(rulesOf(".chat-turn-work::before").join(";")).toMatch(/left:\s*-13px/);
    expect(rulesOf(".chat-item.is-highlight").join(";")).toMatch(/box-shadow:\s*0 0 0 6px/);
    expect(css).not.toMatch(/content-visibility/);
    expect(css).not.toMatch(/(?:^|[;{\s])contain:\s*(?:strict|content|[^;}]*paint)/);
  });
});

describe("the screen around the conversation keeps its chat while only a reply's text grows (S1)", () => {
  const base = CHATS[0]!;
  const ctx = (seq: number) => ({ seq, replay: false, cwd: "/work/app", now: 10_000 + seq });
  const key = "msg_s1:0";
  const started = applyEvent(base, { k: "block_start", key, kind: "text", parent: null }, ctx(1));
  const grown = applyEvent(started, { k: "block_delta", key, text: "The fix " }, ctx(2));
  const more = applyEvent(grown, { k: "block_delta", key, text: "holds." }, ctx(3));

  test("a streamed piece keeps the chat the screen drew; the store's chat has the text", () => {
    expect(steadyChat(started)).toBe(started);
    expect(steadyChat(grown)).toBe(started);
    expect(steadyChat(more)).toBe(started);
    expect(more.items.at(-1)).toMatchObject({ kind: "assistant", markdown: "The fix holds.", streaming: true });
    expect(textOnly(started.items, more.items)).toBe(true);
  });

  test("anything else is a new chat: the block's end, a new row, a field of the chat", () => {
    const ended = applyEvent(more, { k: "block_end", key }, ctx(4));
    expect(steadyChat(ended)).toBe(ended);
    const tool = applyEvent(ended, { k: "tool_call", id: "toolu_s1", name: "Read", input: { file_path: "/work/app/a.ts" }, parent: null }, ctx(5));
    expect(tool.items.length).toBe(ended.items.length + 1);
    expect(steadyChat(tool)).toBe(tool);
    const renamed = { ...tool, title: "Another title" };
    expect(steadyChat(renamed)).toBe(renamed);
    const thinking: Item = { kind: "thinking", id: "t_s1", seconds: 0, text: "Let me", live: true };
    const a = { ...renamed, items: [...renamed.items, thinking] };
    expect(steadyChat(a)).toBe(a);
    const b = { ...a, items: [...renamed.items, { ...thinking, text: "Let me look" }] };
    expect(steadyChat(b)).toBe(a);
    const c = { ...a, items: [...renamed.items, { ...thinking, text: "Let me look", live: false }] };
    expect(steadyChat(c)).toBe(c);
    // The same text in another row's place is not a grown text.
    expect(textOnly(a.items, [...a.items.slice(0, -2), a.items.at(-1)!, a.items.at(-2)!])).toBe(false);
  });

  test("the chat list: the same array while only a reply's text grows in it", () => {
    const other = CHATS[1]!;
    const list1 = steadyChats([other, started]);
    expect(steadyChats([other, grown])).toBe(list1);
    expect(steadyChats([other, more])).toBe(list1);
    const renamed = { ...more, title: "Renamed" };
    const list2 = steadyChats([other, renamed]);
    expect(list2).not.toBe(list1);
    expect(list2[1]).toBe(renamed);
  });
});

describe("the finished turns are worked out and drawn once (S1)", () => {
  const blank = (): ChatPart => ({ ...CHATS[0]!, items: [], pending: [], marks: [], turn: null });
  const live = (events: ChatEvent[], start: ChatPart, from: number): ChatPart => {
    let c = start;
    events.forEach((e, i) => (c = applyEvent(c, e, { seq: from + i + 1, replay: false, cwd: null, now: 1_000_000 + from + i })));
    return c;
  };
  const turn = (n: number): ChatEvent[] => [
    { k: "turn_start", by: "user" },
    { k: "user", uuid: `u-${n}`, text: `Question ${n}.`, queued: false },
    { k: "tool_call", id: `toolu_${n}a`, name: "Read", input: { file_path: `/src/${n}.ts` }, parent: null },
    { k: "tool_result", id: `toolu_${n}a`, text: "ok", isError: false, parent: null, report: null },
    { k: "block", key: `msg_${n}:0`, kind: "text", text: `Answer ${n}.`, parent: null },
    { k: "turn_end", ok: true, subtype: "success", durationMs: 2000, error: null, uuids: [] },
  ];
  let c = blank();
  for (let n = 0; n < 6; n++) c = live(turn(n), c, n * 10);
  c = live([{ k: "turn_start", by: "user" }, { k: "user", uuid: "u-live", text: "Go on.", queued: false }, { k: "block_start", key: "msg_live:0", kind: "text", parent: null }, { k: "block_delta", key: "msg_live:0", text: "Part one" }], c, 100);
  const grown = live([{ k: "block_delta", key: "msg_live:0", text: ", part two" }], c, 110);
  const RUN: TurnOpts = { running: true, waiting: false, partial: false };
  const IDLE: TurnOpts = { running: false, waiting: false, partial: false };

  test("a streamed piece keeps every finished turn's object; the live turn is new, with the text", () => {
    const first = shareBlocks(null, turnsOf(c.items, c.marks ?? [], RUN));
    const next = turnsOf(grown.items, grown.marks ?? [], RUN);
    const shared = shareBlocks(first, next);
    expect(shared).toEqual(next);
    expect(shared.length).toBe(7);
    for (let i = 0; i < 6; i++) expect(shared[i]).toBe(first[i]!);
    expect(shared[6]).not.toBe(first[6]);
    const last = shared[6]!;
    expect(last.k === "turn" && last.turn.rows.at(-1)).toMatchObject({ kind: "assistant", markdown: "Part one, part two" });
  });

  test("a turn whose rows or end changed is new; the same turn again is kept", () => {
    const first = shareBlocks(null, turnsOf(c.items, c.marks ?? [], RUN));
    expect(shareBlocks(first, turnsOf(c.items, c.marks ?? [], RUN)).every((b, i) => b === first[i])).toBe(true);
    // The live turn ends: it is a new object; the turns before it are kept.
    const ended = live([{ k: "block_end", key: "msg_live:0" }, { k: "turn_end", ok: true, subtype: "success", durationMs: 1000, error: null, uuids: [] }], c, 120);
    const after = shareBlocks(first, turnsOf(ended.items, ended.marks ?? [], IDLE));
    expect(after[6]).not.toBe(first[6]);
    for (let i = 0; i < 6; i++) expect(after[i]).toBe(first[i]!);
  });

  test("a kept turn keeps its layout in a view; another view lays it out again", () => {
    const layoutFor = layoutCache();
    const calls = cardCalls(c.items, c.pending);
    const blocks = shareBlocks(null, turnsOf(c.items, c.marks ?? [], RUN));
    const t0 = (blocks[0] as Extract<Block, { k: "turn" }>).turn;
    const l = layoutFor(t0, "normal", undefined, calls);
    expect(l).toEqual(turnLayout(t0, "normal", undefined, calls));
    expect(layoutFor(t0, "normal", undefined, calls)).toBe(l);
    expect(layoutFor(t0, "normal", undefined, cardCalls(c.items, c.pending))).toBe(l);
    const v = layoutFor(t0, "verbose", undefined, calls);
    expect(v).not.toBe(l);
    expect(v).toEqual(turnLayout(t0, "verbose", undefined, calls));
  });
});

describe("a long reply's reveal draws its finished blocks once (S1)", () => {
  const src = longReply(20000);
  const model = lexMarkdown(src, null);

  /** The reveal as each top block draws it on its own (TopBlock): wholly shown and done fading as it is, else with the cut. */
  const reference = (m: MarkdownModel, reveal: RevealCut | null): string => {
    const kids = [];
    const tokens = m.tokens!;
    for (let i = 0; i < tokens.length; i++) {
      const start = m.starts[i]!;
      const end = start + m.units[i]!;
      if (reveal) {
        if (start >= reveal.end && end > start) break;
        if (end > reveal.end || end > reveal.fade) {
          kids.push(createElement(TopBlock, { key: i, token: tokens[i]!, index: i, cut: { pos: start, end: reveal.end, fade: reveal.fade, marks: reveal.marks ?? [] } }));
          continue;
        }
      }
      kids.push(createElement(TopBlock, { key: i, token: tokens[i]!, index: i }));
    }
    return renderToStaticMarkup(createElement("div", { className: "chat-md" }, ...kids));
  };
  const view = (m: MarkdownModel, reveal: RevealCut | null) => renderToStaticMarkup(createElement(MarkdownView, { model: m, reveal }));

  test("the reply's text and its fading words are the same at every cut, and so is the whole reply", () => {
    expect(model.tokens!.length).toBeGreaterThan(100);
    expect(view(model, null)).toBe(reference(model, null));
    for (let end = 0; end <= model.total; end += 397) {
      const fade = Math.max(0, end - 120);
      const marks = [fade, Math.floor((fade + end) / 2), end];
      expect(view(model, { end, fade, marks })).toBe(reference(model, { end, fade, marks }));
      expect(view(model, { end, fade: end })).toBe(reference(model, { end, fade: end }));
    }
    // A cut on each block's own edges, where a block starts and ends.
    for (let i = 0; i < model.starts.length; i += 7) {
      const at = model.starts[i]!;
      for (const end of [at, at + 1, at + model.units[i]!]) expect(view(model, { end, fade: Math.max(0, end - 30) })).toBe(reference(model, { end, fade: Math.max(0, end - 30) }));
    }
  });

  test("a finished block never lexes again: piece by piece it keeps its token, and the end is the whole reply's", () => {
    let m: MarkdownModel | null = null;
    const seen = new Map<number, Token>();
    for (let got = 0; got < src.length; got += 125) {
      const next = lexMarkdown(holdPartial(src.slice(0, got + 125)), m);
      if (m?.tokens && next.tokens) {
        // All but the last two blocks with content (and the spaces between them) are the earlier piece's own tokens.
        let same = 0;
        while (same < m.tokens.length && next.tokens[same] === m.tokens[same]) same++;
        expect(same).toBeGreaterThanOrEqual(m.tokens.length - 4);
        for (let i = 0; i < same; i++) {
          const had = seen.get(i);
          if (had) expect(next.tokens[i]).toBe(had);
          seen.set(i, next.tokens[i]!);
        }
      }
      m = next;
    }
    const end = lexMarkdown(src, m);
    expect(view(end, null)).toBe(view(lexMarkdown(src, null), null));
  });
});

describe("a live reply's top blocks are their own stacking contexts (S1)", () => {
  test("while the reply streams, each of its top blocks is isolated; a finished reply's are not (no layer per block in a long chat)", () => {
    expect(rulesOf(".chat-assistant.is-live .chat-md > *").some((d) => /(?:^|;)\s*isolation:\s*isolate\s*(?:;|$)/.test(d))).toBe(true);
    expect(rulesOf(".chat-md > *")).toEqual([]);
    const live = renderToStaticMarkup(createElement(AssistantText, { item: { kind: "assistant", id: "m_live", markdown: "One.\n\nTwo.", streaming: true } }));
    const done = renderToStaticMarkup(createElement(AssistantText, { item: { kind: "assistant", id: "m_done", markdown: "One.\n\nTwo." } }));
    expect(live).toContain('<div class="chat-assistant is-live">');
    expect(done).toContain('<div class="chat-assistant">');
  });
});

describe("a message's and a reply's hidden buttons have no layer each (S1)", () => {
  const HIDDEN = ["body:not(.touch) .chat-user:not(:hover, :focus-within, .show-actions) .chat-reveal:not(.is-failed)", "body:not(.touch) .chat-assistant:not(:hover, :focus-within) .chat-reveal:not(.is-failed)"];

  test("on a laptop, Copy and Take back hide by their colour until the row is hovered, focused or linked; a failed Copy shows", () => {
    // No opacity on them: a box with opacity below 1 is a layer of its own, two for each turn of a long chat.
    expect(css).not.toMatch(/\.chat-reveal[^{}]*\{[^}]*opacity/);
    // Hidden, their colour is mixed with transparent all the way: one registered number, 0 hidden and 1 shown.
    expect(rulesOf("@property --chat-reveal").join(";")).toMatch(/syntax:\s*"<number>";\s*inherits:\s*true;\s*initial-value:\s*1;/);
    for (const s of HIDDEN) expect([s, /--chat-reveal:\s*0\s*(?:;|$)/.test(rulesOf(s).join(";"))]).toEqual([s, true]);
    const mix = (token: string) => `color: color-mix(in srgb, var(${token}) calc(var(--chat-reveal) * 100%), transparent)`;
    for (const s of ["body:not(.touch) .chat-foot-btn.chat-reveal", "body:not(.touch) .chat-reveal .copy-btn"]) expect([s, rulesOf(s).join(";")]).toEqual([s, expect.stringContaining(mix("--dim"))]);
    for (const s of ["body:not(.touch) .chat-foot-btn.chat-reveal:hover", "body:not(.touch) .chat-reveal .copy-btn:hover"]) expect([s, rulesOf(s).join(";")]).toEqual([s, expect.stringContaining(mix("--text"))]);
    // A failed Copy is never hidden, and keeps its --danger over the mixed colour (base.css's .copy.is-failed rule is weaker).
    expect(rulesOf("body:not(.touch) .chat-reveal.is-failed .copy-btn").join(";")).toContain("color: var(--danger)");
  });

  test("only showing and hiding fade (160 ms, as the opacity did); a hover's colour changes at once, as before S1", () => {
    // The fade is the number's, so a hover on Copy, Take back or Bring back, and a failed Copy's --danger, are not faded.
    expect(rulesOf("body:not(.touch) .chat-reveal").join(";")).toMatch(/transition:\s*--chat-reveal var\(--t-reveal\) var\(--ease\)\s*(?:;|$)/);
    const re = /([^{}]+)\{([^{}]*)\}/g;
    for (let m = re.exec(css); m; m = re.exec(css)) {
      if (!/chat-reveal|copy-btn|chat-foot-btn/.test(m[1]!)) continue;
      expect([m[1]!.trim(), /transition[^;]*\bcolor\b/.test(m[2]!)]).toEqual([m[1]!.trim(), false]);
    }
  });

  test("in forced colours (a Windows Contrast theme) hidden buttons keep their own colour, which the system's would replace and show", () => {
    for (const s of HIDDEN) expect([s, /forced-color-adjust:\s*none\s*(?:;|$)/.test(rulesOf(s).join(";"))]).toEqual([s, true]);
    // Shown, nothing keeps them out of the system's colours.
    for (const s of ["body:not(.touch) .chat-foot-btn.chat-reveal", "body:not(.touch) .chat-reveal .copy-btn", "body:not(.touch) .chat-reveal"]) expect([s, rulesOf(s).join(";").includes("forced-color-adjust")]).toEqual([s, false]);
  });
});
