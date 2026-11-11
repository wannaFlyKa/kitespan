// Row 93 (the owner, after row 82): Hide sidebar and Show sidebar, and the docked pane on the right as it opens and
// closes, slide: about 200 ms on the look's ease-out. The pane keeps its own width and moves by a transform (the right
// one clipped at its column's edge), and the chat column's margin on that side holds the room the pane has not taken
// (or not given back) yet, so the two edges ride together. No slide on the first paint or a reload, while a handle
// drags, when the window's width changed, with Reduce motion, or on the phone. scripts/ui-check.ts pane-slide checks
// it in Chrome, frame by frame.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parse } from "../../web/router";
import { resetState } from "../../web/state/store";
import { DEFAULT_VIEW } from "../../web/state/catalog";
import type { Chat } from "../../web/state/types";
import { Shell } from "../../web/layout/Shell";
import { SLIDE_EASE, SLIDE_MS, slideFrames, slides, type SlideSide } from "../../web/layout/slide";
import { CHATS, PROJECTS } from "./fixtures";

const STYLES = join(import.meta.dir, "..", "..", "web", "styles");
const css = (name: string) => readFileSync(join(STYLES, name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** A keyframe's px value of `prop` (the first number in it; for a clip, its right inset). */
const px = (k: Keyframe, prop: string) => {
  const v = String(k[prop]);
  const m = prop === "clipPath" ? /inset\(\S+ (-?[\d.]+)px/.exec(v) : /(-?[\d.]+)px/.exec(v);
  return m ? Number(m[1]) : NaN;
};
const mix = (a: number, b: number, e: number) => a + (b - a) * e;

describe("the slide's frames", () => {
  test("the sidebar opening: in from the left, the chat column's margin giving its room back", () => {
    const { pane, main } = slideFrames("left", 248, 0, 1, true);
    expect(pane).toEqual([{ transform: "translateX(-248px)" }, { transform: "translateX(0px)" }]);
    expect(main).toEqual([{ marginLeft: "-248px" }, { marginLeft: "0px" }]);
  });
  test("the sidebar closing: out to the left, its column gone, the margin keeping the room it has not given back", () => {
    const { pane, main } = slideFrames("left", 300, 1, 0, false);
    expect(pane).toEqual([{ transform: "translateX(0px)" }, { transform: "translateX(-300px)" }]);
    expect(main).toEqual([{ marginLeft: "300px" }, { marginLeft: "0px" }]);
  });
  test("the pane on the right: in from the right, clipped at its column's edge (never under the pane bar)", () => {
    const open = slideFrames("right", 320, 0, 1, true);
    expect(open.pane).toEqual([
      { transform: "translateX(320px)", clipPath: "inset(0px 320px 0px 0px)" },
      { transform: "translateX(0px)", clipPath: "inset(0px 0px 0px 0px)" },
    ]);
    expect(open.main).toEqual([{ marginRight: "-320px" }, { marginRight: "0px" }]);
    expect(slideFrames("right", 320, 1, 0, false).main).toEqual([{ marginRight: "320px" }, { marginRight: "0px" }]);
  });
  test("at every point of the slide the chat column's edge is the pane's, and the right pane shows nothing past its edge", () => {
    const w = 320;
    for (const side of ["left", "right"] as SlideSide[])
      for (const [from, to, inGrid] of [[0, 1, true], [1, 0, false], [0.4, 1, true], [0.7, 0, false]] as const) {
        const { pane, main } = slideFrames(side, w, from, to, inGrid);
        const margin = side === "left" ? "marginLeft" : "marginRight";
        for (const e of [0, 0.1, 0.5, 0.9, 1]) {
          const shift = mix(px(pane[0]!, "transform"), px(pane[1]!, "transform"), e);
          const m = mix(px(main[0]!, margin), px(main[1]!, margin), e);
          // The pane's inner edge, from its column's outer edge (0 at the shell's left, or the right edge); the chat
          // column's edge from the same place: its column's edge (the pane's column's width when the pane has one).
          const paneEdge = side === "left" ? w + shift : w - shift;
          const chatEdge = (inGrid ? w : 0) + m;
          expect([side, from, to, e, Math.round(paneEdge * 1000) / 1000]).toEqual([side, from, to, e, Math.round(chatEdge * 1000) / 1000]);
          if (side === "right") expect(Math.round((shift - mix(px(pane[0]!, "clipPath"), px(pane[1]!, "clipPath"), e)) * 1000) / 1000).toBe(0);
        }
      }
  });
  test("about 200 ms on the look's ease-out: tokens.css --t-toggle and --ease", () => {
    const tokens = css("tokens.css");
    expect(SLIDE_MS).toBe(200);
    expect(tokens).toMatch(new RegExp(`--t-toggle: ${SLIDE_MS}ms;`));
    expect(tokens).toContain(`--ease: ${SLIDE_EASE};`);
  });
});

describe("when a pane slides", () => {
  const base = { on: true, first: false, resized: false, reduced: false, dragging: false };
  test("a toggle on a laptop or a tablet slides", () => {
    expect(slides(base)).toBe(true);
  });
  test("never on the first paint or a reload, after a resize, with Reduce motion, while a handle drags, or on the phone", () => {
    expect(slides({ ...base, first: true })).toBe(false);
    expect(slides({ ...base, resized: true })).toBe(false);
    expect(slides({ ...base, reduced: true })).toBe(false);
    expect(slides({ ...base, dragging: true })).toBe(false);
    expect(slides({ ...base, on: false })).toBe(false);
  });
  test("Reduce motion is the app's setting or the system's (ui/motion.ts), read where the slide starts", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "web", "layout", "slide.ts"), "utf8");
    expect(src).toContain("const reduced = useReducedMotion();");
    expect(src).toMatch(/slides\(\{ on, first: s\.first, resized: width !== s\.width, reduced, dragging: host\.hasAttribute\("data-resizing"\) \}\)/);
  });
  test("while a pane slides its handle does not show (layout.css)", () => {
    expect(css("layout.css")).toMatch(/\.shell\[data-slide~="sidebar"\] > \.pane-handle-start,\s*\.shell\[data-slide~="side"\] > \.pane-handle-end \{\s*visibility: hidden;\s*\}/);
  });
});

describe("the shell", () => {
  const gm = globalThis as unknown as { matchMedia?: unknown; window?: unknown };
  const own = { mm: !gm.matchMedia, win: !gm.window };
  beforeAll(() => {
    gm.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    gm.window = { innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {} };
    resetState({ projects: structuredClone(PROJECTS), chats: structuredClone(CHATS), ready: true, view: { ...DEFAULT_VIEW } });
  });
  afterAll(() => {
    if (own.mm) delete gm.matchMedia;
    if (own.win) delete gm.window;
    resetState();
  });
  test("the first paint is the final layout: no slide marked, no margin, no transform", () => {
    const chat = CHATS.find((c) => c.id === "demoolxxxxxxxxxxxxxx") as Chat;
    const html = renderToStaticMarkup(createElement(Shell, { route: parse(new URL(`http://127.0.0.1/c/${chat.id}`)), chat, side: () => createElement("div"), children: createElement("div") }));
    expect(html).not.toContain("data-slide");
    expect(html).toMatch(/<div class="main-col">/);
    expect(html).not.toMatch(/margin|transform|clip-path/);
  });
});
