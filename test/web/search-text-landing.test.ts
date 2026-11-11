// U5 (FIX-U5 1 and 2, DESIGN-U5 9): the landing of a Messages pick. The message route takes `mark` (the query, at most
// 120 characters; it only marks). In the linked row the query's words are marked as Find marks them: every match in
// each of the row's text nodes (shared/words.ts, so the page finds what the server found), never across two nodes,
// never in its buttons or its hidden text, and no other row; the marks go through the CSS Custom Highlight API with
// the wash and the underline, and a page without it keeps the row's own wash. A row that is not in the loaded pages:
// the older pages are read one after another (at most 40), "Loading earlier messages…" meanwhile, 5.4's line only
// after. The store's read of an older page says whether a page came.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "../../web/router";
import { MARK_HIGHLIGHT, MARK_SKIP, canMark, centreDelta, markSpans } from "../../web/chat/marks";
import { LOADING_EARLIER, OLDER_PAGES_MAX, olderStep, type OlderState } from "../../web/chat/older";
import { LINE_GONE } from "../../web/chat/cards/labels";

const WEB = join(import.meta.dir, "..", "..", "web");
const src = (...p: string[]) => readFileSync(join(WEB, ...p), "utf8");
const at = (u: string) => parse(new URL(u, "http://127.0.0.1"));
const C = "demoolxxxxxxxxxxxxxx";

describe("the link (DESIGN-U5 9)", () => {
  test("the message route takes mark, at most 120 characters; it marks only and opens the same row", () => {
    const r = at(`/c/${C}/m/msg_01AbC-0?mark=memory%20cap`);
    expect(r.name).toBe("message");
    expect(r.params.message).toBe("msg_01AbC-0");
    expect(r.query.mark).toBe("memory cap");
    const long = at(`/c/${C}/m/msg_01AbC-0?mark=${"x".repeat(121)}`);
    expect(long.name).toBe("message");
    expect(long.query.mark).toBeUndefined();
    expect(long.dropped).toBe(true);
  });
});

describe("the marks in the row (DESIGN-U5 9)", () => {
  test("every match of each query word in each text node, as Find marks them: case, accents, prefixes at a word start", () => {
    const texts = ["Done. The server keeps only the searchable text in memory, with a ", "cap", " of 32 MB. Memory caps: the CAP."];
    const spans = markSpans(texts, "memory cap");
    const words = spans.map((s) => texts[s.node]!.slice(s.start, s.end));
    expect(words).toEqual(["memory", "cap", "Memory", "cap", "CAP"]);
    expect(spans.map((s) => s.node)).toEqual([0, 1, 2, 2, 2]);
    // "cap" is a prefix of "caps"; "recap" does not start a word with it.
    expect(markSpans(["recap and capital"], "cap").map((s) => [s.start, s.end])).toEqual([[10, 13]]);
    expect(markSpans(["Café au lait", "cafe"], "CAFÉ").map((s) => [s.node, s.start, s.end])).toEqual([
      [0, 0, 4],
      [1, 0, 4],
    ]);
  });

  test("a word split by markup inside it is not marked (never across two text nodes); a query of no word marks nothing", () => {
    expect(markSpans(["mem", "ory cap"], "memory")).toEqual([]);
    expect(markSpans(["memory"], "!!!")).toEqual([]);
    expect(markSpans(["memory"], "")).toEqual([]);
    expect(markSpans([], "memory")).toEqual([]);
  });

  test("the row's buttons, its foot and its hidden text are not walked", () => {
    for (const s of ["button", '[aria-hidden="true"]', ".visually-hidden", ".chat-foot", ".chat-user-foot"]) expect(MARK_SKIP).toContain(s);
  });

  test("with no highlight API (an older Safari or Firefox) nothing is marked and nothing throws", () => {
    expect(canMark()).toBe(false);
    expect(MARK_HIGHLIGHT).toBe("kitespan-match");
  });

  test("a row taller than the view: the first mark is centred instead of the row", () => {
    expect(centreDelta({ top: 100, height: 600 }, { top: 1000, height: 20 })).toBe(1000 - 100 - 290);
    expect(centreDelta({ top: 0, height: 600 }, { top: 300, height: 700 })).toBe(300);
  });

  test("the look: the ring's wash finds the word, the ring's underline says it without colour; tokens only", () => {
    // The ring, not the accent: in glass dark the accent's underline was 3.05:1 on the row's wash, the ring's is 3.86:1
    // (and 2.6:1 against the mark's own ground, against 2.05); the other looks keep 4.1:1 or more.
    const css = src("styles", "chat.css");
    expect(css).toMatch(/::highlight\(kitespan-match\) \{\n  background-color: var\(--ring-wash\);\n  text-decoration: underline 2px var\(--ring\);\n  text-underline-offset: 3px;\n\}/);
  });

  test("ChatView marks the linked row only while the route names it and finds the marks again when the row draws again", () => {
    const view = src("chat", "ChatView.tsx");
    expect(view).toContain("const mark = onMessage && typeof route.query.mark === \"string\" ? route.query.mark : \"\";");
    expect(view).toContain("new MutationObserver(");
    expect(view).toContain("clearMarks()");
    // The marks are found before the row's scroll, which centres the first one in a tall row.
    expect(view.indexOf("markRow(row, mark)")).toBeLessThan(view.indexOf("placeRow(el, row, center)"));
  });
});

describe("a row in an older page (DESIGN-U5 9)", () => {
  const base: OlderState = { onMessage: true, target: true, found: false, loaded: true, more: "cursor-1", pages: 0, busy: false, failed: false };
  test("load the next older page until the row is there or no page is left, at most 40", () => {
    expect(olderStep(base)).toBe("load");
    expect(olderStep({ ...base, busy: true })).toBe("loading");
    expect(olderStep({ ...base, found: true })).toBe(null);
    expect(olderStep({ ...base, more: null })).toBe("gone");
    expect(olderStep({ ...base, pages: OLDER_PAGES_MAX - 1 })).toBe("load");
    expect(olderStep({ ...base, pages: OLDER_PAGES_MAX })).toBe("gone");
    expect(olderStep({ ...base, failed: true })).toBe("gone");
    expect(OLDER_PAGES_MAX).toBe(40);
  });
  test("before the history is drawn, no line yet; another route or no target is not this rule's", () => {
    expect(olderStep({ ...base, loaded: false })).toBe("wait");
    expect(olderStep({ ...base, onMessage: false })).toBe(null);
    expect(olderStep({ ...base, target: false })).toBe(null);
  });
  test("the words: Desktop's \"Loading earlier messages…\" meanwhile, 5.4's line after", () => {
    expect(LOADING_EARLIER).toBe("Loading earlier messages…");
    expect(LINE_GONE).toBe("That message is not in this chat.");
    const view = src("chat", "ChatView.tsx");
    expect(view).toContain("act.loadOlder(chat.id)");
    expect(view).toMatch(/earlier \? LOADING_EARLIER : older === "wait" \? null : \(targetId && !found && !rowLeft\) \|\| trustGone \? LINE_GONE/);
  });
});
