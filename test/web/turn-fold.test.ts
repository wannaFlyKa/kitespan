// U2 (FIX-U2 section 1, DESIGN-U2 8 to 10 and 15): the turn's line as it draws (a button with aria-expanded and
// aria-controls, the chevron in the icon slot, a quiet tag), its folded work (hidden until found), the styles (tokens
// only, 44 px on touch through the rows' height, Reduce motion through --t-reveal, the browser's own anchoring off)
// and the reader's anchor (web/chat/anchor.ts) on stand-in elements. Rendered with React's server renderer.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { anchorElement, anchorShift, readAnchor, type AnchorRoot } from "../../web/chat/anchor";
import { TurnLine, TurnWork, workId } from "../../web/chat/items/Turn";

const WEB = join(import.meta.dir, "..", "..", "web");
const src = (...p: string[]) => readFileSync(join(WEB, ...p), "utf8");

function line(open: boolean, tag: string | null = null, works = 1): string {
  const work = createElement(TurnWork, { turnId: "m1", n: 0, open, found: () => {}, children: createElement("div", { "data-item-id": "a1" }, "The pane takes the slash off.") });
  return renderToStaticMarkup(createElement(TurnLine, { turnId: "m1", label: "Worked for 2m 14s, read 3 files, ran 2 commands", tag, open, works, toggle: () => {}, children: work }));
}

describe("the line and its work (DESIGN-U2 8, 15)", () => {
  test("a button with aria-expanded and aria-controls naming every container of the work; the chevron in the icon slot", () => {
    const closed = line(false, null, 2);
    expect(closed).toContain('class="chat-item chat-compact chat-item-turn chat-turn"');
    expect(closed).toContain('data-turn-id="m1"');
    expect(closed).toMatch(/<button type="button" class="chat-row chat-turn-line" aria-expanded="false" aria-controls="turn-work-m1-0 turn-work-m1-1"/);
    expect(closed).toContain('<span class="chat-row-icon chat-turn-chev"><svg');
    expect(closed).toContain('<span class="chat-row-label">Worked for 2m 14s, read 3 files, ran 2 commands</span>');
    expect(line(true)).toContain('aria-expanded="true"');
    expect(line(true)).toContain("chat-turn is-open");
  });

  test("folded, the work is in the page but hidden (until found, set after the draw); open, it shows", () => {
    expect(line(false)).toContain(`<div id="${workId("m1", 0)}" class="chat-turn-work" data-turn-work="m1" hidden="">`);
    expect(line(false)).toContain("The pane takes the slash off.");
    expect(line(true)).not.toContain(` hidden=`);
    const turnSrc = src("chat", "items", "Turn.tsx");
    expect(turnSrc).toContain('setAttribute("hidden", "until-found")');
    expect(turnSrc).toContain('addEventListener("beforematch"');
  });

  test("the end state is a quiet tag after the words: never the danger colour, and a pause before it for a screen reader", () => {
    const html = line(false, "Failed");
    expect(html).toContain('<span class="chat-tag">Failed</span>');
    expect(html).not.toContain("is-bad");
    // The accessible name reads "..., ran 2 commands, Failed", not "... ran 2 commands Failed".
    expect(html).toContain('ran 2 commands</span><span class="visually-hidden">,</span> <span class="chat-tag">Failed</span>');
    expect(line(false)).not.toContain("visually-hidden");
  });
});

describe("the styles (DESIGN-U2 15.3)", () => {
  const css = src("styles", "chat.css");
  const turnRules = css.slice(css.indexOf("/* ---- U2"), css.indexOf(".chat-col > .chat-item-turn.is-open + *"));

  test("tokens only: no colour, size or radius of its own; the chevron turns with --t-reveal (0 under Reduce motion)", () => {
    expect(turnRules.length).toBeGreaterThan(200);
    expect(turnRules).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    expect(turnRules).toContain("var(--hairline)");
    expect(turnRules).toContain("var(--faint)");
    expect(turnRules).toContain("transition: transform var(--t-reveal) var(--ease)");
    expect(turnRules).toContain("font-variant-numeric: tabular-nums");
    // The line is a chat-row: its height is the rows' --row-h, which touch makes 44 px (tokens.css).
    expect(src("styles", "tokens.css")).toMatch(/body\.touch,\s*body\.touch \[data-look\] \{[^}]*--row-h: var\(--touch\)/);
  });

  test("folded work takes no room, and keeps its box for the browser's Find", () => {
    expect(css).toMatch(/\.chat-turn-work\[hidden\] \{\s*margin: 0;\s*padding: 0;\s*border: 0;/);
    expect(src("styles", "base.css")).toContain('[hidden]:not([hidden="until-found"]) {');
  });

  test("the page keeps the reader's place itself: the scroller's own anchoring is off", () => {
    expect(css).toMatch(/\.chat-scroll \{[^}]*overflow-anchor: none;/);
  });
});

// ---- stand-in elements for the anchor: a column of rows, each with a top and a height
interface Box {
  attrs: Record<string, string>;
  cls: string[];
  top: number;
  h: number;
  kids: Box[];
  parent?: Box;
  hidden?: boolean;
}
const box = (cls: string, attrs: Record<string, string>, top: number, h: number, kids: Box[] = [], hidden = false): Box => {
  const b: Box = { attrs, cls: cls.split(" ").filter(Boolean), top, h, kids, hidden };
  for (const k of kids) k.parent = b;
  return b;
};
function matches(b: Box, s: string): boolean {
  return s
    .split(",")
    .map((x) => x.trim())
    .some((one) => {
      if (one === ".chat-turn-work:not([hidden])") return b.cls.includes("chat-turn-work") && !b.hidden;
      if (one === ".chat-turn-work[hidden]") return b.cls.includes("chat-turn-work") && !!b.hidden;
      if (one.startsWith(".")) return b.cls.includes(one.slice(1));
      const m = /^\[([a-z-]+)(~?)="(.*)"\]$/.exec(one);
      if (!m) return false;
      const want = m[3]!.replace(/\\(.)/g, "$1");
      const have = b.attrs[m[1]!];
      return m[2] === "~" ? !!have && have.split(" ").includes(want) : have === want;
    });
}
function el(b: Box, shift: { y: number }): AnchorRoot {
  const all = (x: Box): Box[] => [x, ...x.kids.flatMap(all)];
  return {
    getAttribute: (n) => b.attrs[n] ?? null,
    getBoundingClientRect: () => ({ top: b.top - shift.y, bottom: b.top + b.h - shift.y }),
    get children() {
      return b.kids.map((k) => el(k, shift));
    },
    get nextElementSibling() {
      const sib = b.parent?.kids;
      const next = sib ? sib[sib.indexOf(b) + 1] : undefined;
      return next ? el(next, shift) : null;
    },
    matches: (s) => matches(b, s),
    closest: (s) => {
      for (let x: Box | undefined = b; x; x = x.parent) if (matches(x, s)) return el(x, shift);
      return null;
    },
    querySelector: (s) => {
      const hit = all(b).slice(1).find((x) => matches(x, s));
      return hit ? el(hit, shift) : null;
    },
  };
}

describe("the reader's anchor (DESIGN-U2 10)", () => {
  test("the first row whose bottom is below the scroller's top, at its distance from that top, then the rows after it", () => {
    const col = box("chat-col", {}, 0, 900, [box("chat-item", { "data-item-id": "m1" }, 0, 60), box("chat-item", { "data-item-id": "a1" }, 70, 200), box("chat-item", { "data-item-id": "m2" }, 280, 60)]);
    expect(readAnchor(el(col, { y: 100 }), 0)).toEqual([
      { attr: "data-item-id", id: "a1", top: -30 },
      { attr: "data-item-id", id: "m2", top: 180 },
    ]);
  });

  test("inside an open turn whose line is above the top, the anchor is the row of its work there", () => {
    const work = box("chat-turn-work", { "data-turn-work": "t1" }, 40, 400, [box("chat-item", { "data-item-id": "w1" }, 40, 100), box("chat-item chat-item-summary", { "data-testid": "summary-w2", "data-rows": "w2 w3" }, 150, 30)]);
    const turn = box("chat-item chat-turn", { "data-turn-id": "t1" }, 0, 440, [box("chat-row-line", {}, 0, 30), work]);
    const col = box("chat-col", {}, 0, 900, [turn, box("chat-item", { "data-item-id": "z1" }, 450, 80)]);
    expect(readAnchor(el(col, { y: 145 }), 0)?.[0]).toEqual({ attr: "data-testid", id: "summary-w2", top: 5 });
    // The line itself while it still shows.
    expect(readAnchor(el(col, { y: 0 }), 0)?.[0]).toEqual({ attr: "data-turn-id", id: "t1", top: 0 });
  });

  test("a row that folded away is stood for by its turn's line, and the shift puts the anchor back", () => {
    const work = box("chat-turn-work", { "data-turn-work": "t1" }, 30, 0, [box("chat-item", { "data-item-id": "w1" }, 30, 0)], true);
    const turn = box("chat-item chat-turn", { "data-turn-id": "t1" }, 0, 30, [box("chat-row-line", {}, 0, 30), work]);
    const col = el(box("chat-col", {}, 0, 900, [turn]), { y: 0 });
    expect(anchorElement(col, { attr: "data-item-id", id: "w1", top: -12 })?.getAttribute("data-turn-id")).toBe("t1");
    expect(anchorShift(col, [{ attr: "data-item-id", id: "w1", top: -12 }], 0)).toBe(12);
    expect(anchorShift(col, [{ attr: "data-turn-id", id: "t1", top: 0.2 }], 0)).toBe(0);
  });

  test("a view that does not draw the row: a summary stands for its call, the call for its summary, else the next row", () => {
    const normal = el(box("chat-col", {}, 0, 900, [box("chat-item chat-item-summary", { "data-testid": "summary-c1", "data-rows": "c1 c2" }, 100, 30), box("chat-item", { "data-item-id": "a1" }, 140, 60)]), { y: 0 });
    const verbose = el(box("chat-col", {}, 0, 900, [box("chat-item", { "data-item-id": "c1" }, 100, 30), box("chat-item", { "data-item-id": "c2" }, 132, 30), box("chat-item", { "data-item-id": "a1" }, 170, 60)]), { y: 0 });
    expect(anchorElement(verbose, { attr: "data-testid", id: "summary-c1", top: 0 })?.getAttribute("data-item-id")).toBe("c1");
    expect(anchorElement(normal, { attr: "data-item-id", id: "c2", top: 0 })?.getAttribute("data-testid")).toBe("summary-c1");
    // A thinking row that Normal does not draw: the next row keeps its own place.
    expect(anchorShift(normal, [{ attr: "data-item-id", id: "think-1", top: 10 }, { attr: "data-item-id", id: "a1", top: 120 }], 0)).toBe(20);
    expect(anchorShift(normal, [{ attr: "data-item-id", id: "gone", top: 10 }], 0)).toBe(0);
  });
});
