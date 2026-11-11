// Iteration 8 (touch; DESIGN-T1 2.6, 2.7 and 2.9; T-6, T-15, T-17, T-30, G-31, G-36, G-37): the places that layout/place.ts
// works out and Shell.tsx applies. The large tablet's pane over the chat ends above the composer's dock at rest (from
// the rest height, which a taller dock never raises, and 0 while the pane rides the keyboard); on medium touch where the
// docked pane would be under 320 px a changes view opens over the chat, its pair's other half docked under it; a medium
// pane that has no room to grow has no width handle; the pane bar that comes with Show sidebar takes its room at once,
// so the chat column never gets narrower than the chat in it; and the touch rules of layout.css and base.css.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parse } from "../../web/router";
import { paneValueOf, parsePath } from "../../shared/route";
import { resetState } from "../../web/state/store";
import { DEFAULT_VIEW } from "../../web/state/catalog";
import type { Chat } from "../../web/state/types";
import { Shell } from "../../web/layout/Shell";
import { OVER_GAP, changesPlace, nextRestMark, overPaneBottom } from "../../web/layout/place";
import { PANE_BAR_W_TOUCH, SIDEBAR_W, paneRanges, resizable } from "../../web/layout/panes";
import { PANEL_W, mediumPaneWidth } from "../../web/layout/size";
import { halfClose, pairHref, pairOf } from "../../web/layout/split";
import { slideFrames, slideRoom } from "../../web/layout/slide";
import { changesHref } from "../../web/changes/nav";
import { CHATS, PROJECTS } from "./fixtures";

const STYLES = join(import.meta.dir, "..", "..", "web", "styles");
const css = (name: string) => readFileSync(join(STYLES, name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const C = "demoolxxxxxxxxxxxxxx";
const T = "k3m7q2x4ab";
const at = (u: string) => parse(new URL(u, "http://127.0.0.1"));

describe("the large tablet: a pane over the chat ends above the composer at rest (T-15)", () => {
  test("on touch in the laptop class only: the rest height and the 8 px gap", () => {
    expect(overPaneBottom({ size: "laptop", touch: true, rest: 134, riding: false })).toBe(134 + OVER_GAP);
    expect(OVER_GAP).toBe(8);
    // A laptop with a mouse, medium touch and the phone keep the pane to the foot of the window.
    expect(overPaneBottom({ size: "laptop", touch: false, rest: 134, riding: false })).toBe(0);
    expect(overPaneBottom({ size: "medium", touch: true, rest: 134, riding: false })).toBe(0);
    expect(overPaneBottom({ size: "phone", touch: true, rest: 134, riding: false })).toBe(0);
  });
  test("0 while the pane rides the on-screen keyboard, and before the dock is measured", () => {
    expect(overPaneBottom({ size: "laptop", touch: true, rest: 134, riding: true })).toBe(0);
    expect(overPaneBottom({ size: "laptop", touch: true, rest: null, riding: false })).toBe(0);
    expect(overPaneBottom({ size: "laptop", touch: true, rest: 0, riding: false })).toBe(0);
  });
  test("the rest height is the least dock seen at the width: a taller dock (more lines, a card) never raises it", () => {
    let m = nextRestMark(null, 1024, 134);
    expect(m).toEqual({ width: 1024, height: 134 });
    for (const taller of [186, 238, 412]) m = nextRestMark(m, 1024, taller);
    expect(m).toEqual({ width: 1024, height: 134 });
    expect(overPaneBottom({ size: "laptop", touch: true, rest: m!.height, riding: false })).toBe(142);
    // A shorter dock at the same width lowers it; a new width (a turned tablet) starts again.
    m = nextRestMark(m, 1024, 120.4);
    expect(m).toEqual({ width: 1024, height: 120 });
    expect(nextRestMark(m, 1366, 160)).toEqual({ width: 1366, height: 160 });
    // A dock that is not laid out changes nothing.
    expect(nextRestMark(m, 1024, 0)).toBe(m);
    expect(nextRestMark(m, 1024, Number.NaN)).toBe(m);
    expect(nextRestMark(m, 1366, 0)).toBeNull();
  });
  test("the pane's foot and the dock over it (layout.css)", () => {
    const layout = css("layout.css");
    expect(layout).toMatch(/\.side-pane\.side-over\.side-over-above \{\s*border-bottom: 1px solid var\(--hairline\);\s*border-bottom-left-radius: var\(--r-card\);/);
    expect(layout).toMatch(/\.shell\[data-over="above"\] :is\(\.cmp-dock, \.chat-dock:not\(\.is-riding\)\) \{\s*position: relative;\s*z-index: 31;/);
    // Over the pane (30), under the riding composer and card (35).
    expect(layout).toMatch(/\.side-pane\.side-over \{[^}]*z-index: 30;/);
  });
});

describe("medium touch: the changes view over the chat under 320 px of pane (T-17, Q1's default)", () => {
  test("over the chat at 626 and 768 px, docked at 834 px and on a laptop", () => {
    expect(changesPlace({ size: "medium", width: 626 })).toBe("over");
    expect(changesPlace({ size: "medium", width: 768 })).toBe("over");
    expect(changesPlace({ size: "medium", width: 834 })).toBe("docked");
    expect(changesPlace({ size: "laptop", width: 1024 })).toBe("docked");
    expect(changesPlace({ size: "phone", width: 390 })).toBe("docked");
    // The layer's width beside the pane bar: 570 and 712 px, against the 250 and 307 px it would dock at.
    expect([626 - PANE_BAR_W_TOUCH, 768 - PANE_BAR_W_TOUCH]).toEqual([570, 712]);
    expect([mediumPaneWidth(626), mediumPaneWidth(768), mediumPaneWidth(834)]).toEqual([250, 307, PANEL_W]);
  });

  const gm = globalThis as unknown as { matchMedia?: unknown; window?: unknown; history?: unknown };
  const own = { mm: !gm.matchMedia, win: !gm.window, hist: !gm.history };
  let coarse = false;
  const viewport = (width: number, height: number, touch: boolean) => {
    coarse = touch;
    gm.window = { innerWidth: width, innerHeight: height, addEventListener() {}, removeEventListener() {} };
  };
  beforeAll(() => {
    gm.matchMedia = (q: string) => ({ matches: coarse && q === "(pointer: coarse)", addEventListener() {}, removeEventListener() {} });
    gm.history ??= { state: null };
    resetState({ projects: structuredClone(PROJECTS), chats: structuredClone(CHATS), ready: true, view: { ...DEFAULT_VIEW } });
  });
  afterAll(() => {
    if (own.mm) delete gm.matchMedia;
    if (own.win) delete gm.window;
    if (own.hist) delete gm.history;
    resetState();
  });
  const chat = () => CHATS.find((c) => c.id === C) as Chat;
  const shell = (url: string) => renderToStaticMarkup(createElement(Shell, { route: at(url), chat: chat(), side: () => createElement("div", { className: "panel-stand-in" }), children: createElement("div", { className: "chat-screen" }) }));
  const file = changesHref(C, T, "src/upload.ts");

  test("at 626 px the view is a layer over the chat beside the pane bar, and nothing docks", () => {
    viewport(626, 890, true);
    const html = shell(file);
    expect(html).toContain('data-side="over"');
    expect(html).toMatch(/<aside class="side-pane side-over chg-col chg-over-chat" data-testid="changes-over">/);
    expect(html).not.toContain('id="fd-side"');
    expect(html).toContain('class="pane-bar with-names"');
  });

  test("with a pair, the layer shows the path's view alone; the other half stays in the URL and docks under it", () => {
    viewport(626, 890, true);
    const details = paneValueOf(parsePath(`/c/${C}/details`))!;
    const url = pairHref(file, { value: details, slot: "lower" });
    expect(pairOf(parsePath(url))).not.toBeNull();
    const html = shell(url);
    expect(html).toContain("chg-over-chat");
    // The docked pane holds the other half (the cards' stand-in), as one view: no divider.
    expect(html).toMatch(/<aside id="fd-side" class="side-pane"[^>]*>[\s\S]*panel-stand-in/);
    expect(html).not.toContain('data-testid="split-divider"');
    // Closing the layer (its Close, Esc) goes to that half alone, so the docked pane shows it.
    expect(halfClose(pairOf(parsePath(url))!.path.route)).toBe(`/c/${C}/details`);
  });

  test("at 834 px the view docks at 320 px as before", () => {
    viewport(834, 1194, true);
    const html = shell(file);
    expect(html).not.toContain("chg-over-chat");
    expect(html).toContain('id="fd-side"');
    expect(html).toContain("--side-w:320px");
  });

  test("the layer's place (layout.css): from the left edge to the pane bar, no edge of its own", () => {
    expect(css("layout.css")).toMatch(/\.shell-medium > \.side-pane\.side-over\.chg-over-chat \{\s*left: 0;\s*width: auto;\s*border-left: 0;\s*box-shadow: none;/);
  });
});

describe("a medium pane with no room to grow has no width handle (T-30, as the code has it)", () => {
  const right = (w: number) => paneRanges({ width: w, touch: true, sidebar: false, right: { pane: "side", def: mediumPaneWidth(w) }, bar: true, widths: {} }).right!;
  test("none at 626 px: the 250 px pane is its minimum and its reach", () => {
    expect(right(626)).toMatchObject({ min: 250, now: 250, reach: 250 });
    expect(resizable(right(626))).toBe(false);
    expect(resizable(right(701))).toBe(false);
  });
  test("from 702 px a handle that only narrows the pane to 280 px; it widens only from about 795 px", () => {
    expect(resizable(right(702))).toBe(true);
    expect(right(768)).toMatchObject({ min: 280, now: 307, reach: 307 });
    expect(right(794).reach).toBe(right(794).now);
    expect(right(834).reach).toBeGreaterThan(right(834).now);
  });
});

describe("Show sidebar on the large tablet: the chat never runs past its column (G-31)", () => {
  // 1024 px with the sidebar hidden: the chat (704 px) beside the cards' column (320 px). Show sidebar: the sidebar
  // (248 px) docks, the column goes and the pane bar (56 px) comes in its place, so the chat column is 720 px.
  const before = 1024 - PANEL_W;
  const after = 1024 - SIDEBAR_W - PANE_BAR_W_TOUCH;
  const pinned = Math.min(before, after);
  const px = (k: Keyframe, prop: string) => Number(/(-?[\d.]+)px/.exec(String(k[prop]))![1]);
  const column = (room: number, e: number) => {
    const left = slideFrames("left", SIDEBAR_W, 0, 1, true);
    const right = slideFrames("right", PANEL_W, 1, 0, false, room);
    const m = (f: Keyframe[], prop: string) => px(f[0]!, prop) + (px(f[1]!, prop) - px(f[0]!, prop)) * e;
    return after - m(left.main, "marginLeft") - m(right.main, "marginRight");
  };
  test("the bar's room comes off the column's margin: the column starts as wide as the chat was", () => {
    const room = slideRoom(PANEL_W, false, 0, PANE_BAR_W_TOUCH);
    expect(room).toBe(PANEL_W - PANE_BAR_W_TOUCH);
    expect(column(room, 0)).toBe(before);
    for (const e of [0, 0.1, 0.25, 0.5, 0.75, 1]) expect([e, column(room, e) >= pinned]).toEqual([e, true]);
    expect(column(room, 1)).toBe(after);
    // As it was: the margin held the pane's whole width, so the column began 56 px narrower than the chat in it.
    expect(column(PANEL_W, 0)).toBe(before - PANE_BAR_W_TOUCH);
  });
  test("Hide sidebar: the bar goes as the column comes, and its room is given back the same way", () => {
    expect(slideRoom(PANEL_W, true, PANE_BAR_W_TOUCH, 0)).toBe(PANEL_W - PANE_BAR_W_TOUCH);
    // No bar change: the pane's own width, as before; never under 0.
    expect(slideRoom(PANEL_W, true, 56, 56)).toBe(PANEL_W);
    expect(slideRoom(PANEL_W, false, 0, 0)).toBe(PANEL_W);
    expect(slideRoom(40, false, 0, 56)).toBe(0);
    // The pane still moves its whole width; only the chat column's margin takes the room.
    expect(slideFrames("right", PANEL_W, 1, 0, false, 264).pane).toEqual(slideFrames("right", PANEL_W, 1, 0, false).pane);
  });
});

describe("touch's bars and the page (T-6, G-36, G-37)", () => {
  test("on touch every bar is opaque, with no backdrop filter, in every look; the laptop keeps the material", () => {
    const layout = css("layout.css");
    const block = /\.touch \.shell > \.sidebar::before,\s*\.touch \.shell-drawer::before,\s*\.touch \.pane-bar::before,\s*body\.touch \.scr-drawer::before,\s*\.touch \.main-col > \.topbar::before \{([^}]*)\}/.exec(layout);
    expect(block).not.toBeNull();
    expect(block![1]).toContain("-webkit-backdrop-filter: none;");
    expect(block![1]).toContain("backdrop-filter: none;");
    expect(block![1]).toContain("background: var(--panel);");
    expect(layout).toMatch(/\.touch \.main-col > \.topbar::before \{\s*background: var\(--bg\);/);
    expect(layout).toMatch(/\.shell > \.sidebar::before,[^{]*\{[^}]*backdrop-filter: var\(--material-filter\);/);
  });
  test("a sheet's foot: the home indicator's inset replaces the base padding, never adds to it", () => {
    const base = css("base.css");
    expect(base).toContain("padding: 0 var(--sheet-pad-r) max(var(--s4), env(safe-area-inset-bottom)) var(--sheet-pad-l);");
    expect(base).not.toMatch(/\+ env\(safe-area-inset-bottom\)/);
  });
  test("the page's height: 100%, then 100svh, then 100dvh", () => {
    const chain = /height: 100%;\s*height: 100svh;\s*height: 100dvh;/;
    expect(css("base.css")).toMatch(new RegExp(`html,\\s*body,\\s*#root \\{\\s*${chain.source}`));
    expect(css("layout.css")).toMatch(new RegExp(`\\.shell \\{\\s*position: relative;\\s*${chain.source}`));
    expect(css("layout.css")).toMatch(new RegExp(`\\.boot-wait \\{\\s*${chain.source}`));
  });
});

describe("Copy's live region (R-7)", () => {
  test("every Copy button says Copied in a hidden role=status inside its own positioned box", async () => {
    const { CopyButton } = await import("../../web/ui/Copy");
    const html = renderToStaticMarkup(createElement(CopyButton, { text: "x", label: "Copy reply", testId: "copy-reply" }));
    expect(html).toMatch(/^<span class="copy"><button[^>]*aria-label="Copy reply"[^>]*>.*<\/button><span class="visually-hidden" role="status"><\/span><\/span>$/);
    // The hidden span is position: absolute; its box must be its container, or a long transcript's spans lie past the
    // scroller and the chat's column (overflow hidden) scrolls when a field takes the focus.
    const css = readFileSync(join(import.meta.dir, "..", "..", "web", "styles", "base.css"), "utf8");
    expect(/\n\.copy \{[^}]*position: relative;/.test(css)).toBe(true);
  });
});
