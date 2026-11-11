// The frame's keys (DESIGN-B1 4.3 and 4.17, F12; w3 lines 24-33): what a key press in the frame sends to the shared
// Chrome (a Linux Chrome, whose editing keys are Ctrl's), the macOS table, kitespan's own keys that never reach the
// page, copy and paste, and the modifier bits (shared/browser.ts BROWSER_MODS). On touch (DESIGN-T1 2.8, T-13): More >
// Select text, a finger's drag that selects the page's text, the foot's Copy, the foot as its field's owner for the
// keyboard release, and an address edit that stays when the field loses the focus.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BROWSER_MODS, type BrowserTabView } from "../../shared/browser";
import { keyAction, strokeFrames, vkOf, type KeyInput } from "../../web/browser/keys";
import { asksSelection } from "../../web/browser/copy";
import { More } from "../../web/browser/More";
import { TouchFoot } from "../../web/browser/Keyboard";
import { selectingText, setSelectingText, textDragFrames } from "../../web/browser/selectText";

const ev = (key: string, code: string, mods: Partial<KeyInput> = {}, keyCode = 0): KeyInput => ({ key, code, keyCode, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, ...mods });
const { alt, ctrl, meta, shift } = BROWSER_MODS;

describe("the macOS table (F12)", () => {
  const mac = true;
  test("Cmd plus a letter is Ctrl plus that letter (select all, undo, redo, cut, bold)", () => {
    expect(keyAction(ev("a", "KeyA", { metaKey: true }), mac)).toEqual({ kind: "strokes", strokes: [{ key: "a", code: "KeyA", vk: 65, mods: ctrl }] });
    expect(keyAction(ev("z", "KeyZ", { metaKey: true }), mac)).toEqual({ kind: "strokes", strokes: [{ key: "z", code: "KeyZ", vk: 90, mods: ctrl }] });
    expect(keyAction(ev("z", "KeyZ", { metaKey: true, shiftKey: true }), mac)).toEqual({ kind: "strokes", strokes: [{ key: "z", code: "KeyZ", vk: 90, mods: ctrl | shift }] });
    for (const [k, c, vk] of [["x", "KeyX", 88], ["y", "KeyY", 89], ["b", "KeyB", 66], ["i", "KeyI", 73], ["k", "KeyK", 75]] as const)
      expect(keyAction(ev(k, c, { metaKey: true }), mac)).toEqual({ kind: "strokes", strokes: [{ key: k, code: c, vk, mods: ctrl }] });
  });
  test("Cmd+Left and Cmd+Right are Home and End, with Shift kept", () => {
    expect(keyAction(ev("ArrowLeft", "ArrowLeft", { metaKey: true }), mac)).toEqual({ kind: "strokes", strokes: [{ key: "Home", code: "Home", vk: 36, mods: 0 }] });
    expect(keyAction(ev("ArrowRight", "ArrowRight", { metaKey: true, shiftKey: true }), mac)).toEqual({ kind: "strokes", strokes: [{ key: "End", code: "End", vk: 35, mods: shift }] });
  });
  test("Cmd+Up and Cmd+Down are Ctrl+Home and Ctrl+End", () => {
    expect(keyAction(ev("ArrowUp", "ArrowUp", { metaKey: true }), mac)).toEqual({ kind: "strokes", strokes: [{ key: "Home", code: "Home", vk: 36, mods: ctrl }] });
    expect(keyAction(ev("ArrowDown", "ArrowDown", { metaKey: true, shiftKey: true }), mac)).toEqual({ kind: "strokes", strokes: [{ key: "End", code: "End", vk: 35, mods: ctrl | shift }] });
  });
  test("Option+Left and Option+Right are Ctrl+Left and Ctrl+Right (a word)", () => {
    expect(keyAction(ev("ArrowLeft", "ArrowLeft", { altKey: true }), mac)).toEqual({ kind: "strokes", strokes: [{ key: "ArrowLeft", code: "ArrowLeft", vk: 37, mods: ctrl }] });
    expect(keyAction(ev("ArrowRight", "ArrowRight", { altKey: true, shiftKey: true }), mac)).toEqual({ kind: "strokes", strokes: [{ key: "ArrowRight", code: "ArrowRight", vk: 39, mods: ctrl | shift }] });
  });
  test("Option+Backspace and Option+Delete delete a word", () => {
    expect(keyAction(ev("Backspace", "Backspace", { altKey: true }), mac)).toEqual({ kind: "strokes", strokes: [{ key: "Backspace", code: "Backspace", vk: 8, mods: ctrl }] });
    expect(keyAction(ev("Delete", "Delete", { altKey: true }), mac)).toEqual({ kind: "strokes", strokes: [{ key: "Delete", code: "Delete", vk: 46, mods: ctrl }] });
  });
  test("Cmd+Backspace deletes to the line's start: Shift+Home, then Backspace", () => {
    expect(keyAction(ev("Backspace", "Backspace", { metaKey: true }), mac)).toEqual({
      kind: "strokes",
      strokes: [
        { key: "Home", code: "Home", vk: 36, mods: shift },
        { key: "Backspace", code: "Backspace", vk: 8, mods: 0 },
      ],
    });
  });
  test("Cmd+C copies and Cmd+V pastes through the page's own paths, never as keys", () => {
    expect(keyAction(ev("c", "KeyC", { metaKey: true }), mac)).toEqual({ kind: "copy" });
    expect(keyAction(ev("v", "KeyV", { metaKey: true }), mac)).toEqual({ kind: "paste" });
  });
  test("kitespan's own keys are not sent: Cmd+L, Cmd+Shift+B, Cmd+backslash, Ctrl+backtick", () => {
    expect(keyAction(ev("l", "KeyL", { metaKey: true }), mac)).toEqual({ kind: "own" });
    expect(keyAction(ev("b", "KeyB", { metaKey: true, shiftKey: true }), mac)).toEqual({ kind: "own" });
    expect(keyAction(ev("\\", "Backslash", { metaKey: true }), mac)).toEqual({ kind: "own" });
    expect(keyAction(ev("`", "Backquote", { ctrlKey: true }), mac)).toEqual({ kind: "own" });
  });
  test("a plain key on macOS is as it is (typed text keeps its text)", () => {
    expect(keyAction(ev("a", "KeyA", {}, 65), mac)).toEqual({ kind: "press", stroke: { key: "a", code: "KeyA", vk: 65, mods: 0, text: "a" } });
    expect(keyAction(ev("A", "KeyA", { shiftKey: true }, 65), mac)).toEqual({ kind: "press", stroke: { key: "A", code: "KeyA", vk: 65, mods: shift, text: "A" } });
  });
});

describe("off macOS", () => {
  const mac = false;
  test("Ctrl+C copies, Ctrl+V pastes; Ctrl+A and Ctrl+Z go to the page", () => {
    expect(keyAction(ev("c", "KeyC", { ctrlKey: true }), mac)).toEqual({ kind: "copy" });
    expect(keyAction(ev("v", "KeyV", { ctrlKey: true }), mac)).toEqual({ kind: "paste" });
    expect(keyAction(ev("a", "KeyA", { ctrlKey: true }, 65), mac)).toEqual({ kind: "press", stroke: { key: "a", code: "KeyA", vk: 65, mods: ctrl } });
    expect(keyAction(ev("z", "KeyZ", { ctrlKey: true, shiftKey: true }, 90), mac)).toEqual({ kind: "press", stroke: { key: "z", code: "KeyZ", vk: 90, mods: ctrl | shift } });
  });
  test("Ctrl+L, Ctrl+Shift+B, Ctrl+backslash and Ctrl+backtick are kitespan's", () => {
    for (const e of [ev("l", "KeyL", { ctrlKey: true }), ev("B", "KeyB", { ctrlKey: true, shiftKey: true }), ev("\\", "Backslash", { ctrlKey: true }), ev("`", "Backquote", { ctrlKey: true })]) expect(keyAction(e, mac)).toEqual({ kind: "own" });
  });
  test("Meta is not translated off macOS", () => {
    expect(keyAction(ev("a", "KeyA", { metaKey: true }, 65), mac)).toEqual({ kind: "press", stroke: { key: "a", code: "KeyA", vk: 65, mods: meta } });
  });
});

describe("every key", () => {
  test("Enter carries a carriage return; Tab and the arrows carry no text; Space is a space", () => {
    expect(keyAction(ev("Enter", "Enter", {}, 13), false)).toEqual({ kind: "press", stroke: { key: "Enter", code: "Enter", vk: 13, mods: 0, text: "\r" } });
    expect(keyAction(ev("Tab", "Tab", { shiftKey: true }, 9), false)).toEqual({ kind: "press", stroke: { key: "Tab", code: "Tab", vk: 9, mods: shift } });
    expect(keyAction(ev("ArrowDown", "ArrowDown", { altKey: true }, 40), false)).toEqual({ kind: "press", stroke: { key: "ArrowDown", code: "ArrowDown", vk: 40, mods: alt } });
    expect(keyAction(ev(" ", "Space", {}, 32), false)).toEqual({ kind: "press", stroke: { key: " ", code: "Space", vk: 32, mods: 0, text: " " } });
  });
  test("a bare modifier and a dead key send nothing; a key while an input method composes sends nothing", () => {
    expect(keyAction(ev("Shift", "ShiftLeft", { shiftKey: true }), false)).toEqual({ kind: "none" });
    expect(keyAction(ev("Meta", "MetaLeft", { metaKey: true }), true)).toEqual({ kind: "none" });
    expect(keyAction(ev("Dead", "Quote"), false)).toEqual({ kind: "none" });
    expect(keyAction(ev("a", "KeyA", { isComposing: true }), false)).toEqual({ kind: "none" });
  });
  test("a character outside ASCII goes as text (insertText), since key and code are ASCII", () => {
    expect(keyAction(ev("é", "KeyE"), false)).toEqual({ kind: "text", text: "é" });
    expect(keyAction(ev("å", "KeyA", { altKey: true }), true)).toEqual({ kind: "text", text: "å" });
  });
  test("the virtual key code: the event's own, else from the code", () => {
    expect(vkOf("KeyQ", 0)).toBe(81);
    expect(vkOf("Digit7", 0)).toBe(55);
    expect(vkOf("F4", 0)).toBe(115);
    expect(vkOf("Escape", 0)).toBe(27);
    expect(vkOf("Whatever", 300)).toBe(0);
    expect(vkOf("KeyQ", 81)).toBe(81);
  });
  test("a stroke's frames: keyDown with text, else rawKeyDown, then keyUp", () => {
    expect(strokeFrames({ key: "a", code: "KeyA", vk: 65, mods: 0, text: "a" }, "down")).toEqual([{ type: "keyDown", key: "a", code: "KeyA", vk: 65, text: "a" }]);
    expect(strokeFrames({ key: "Home", code: "Home", vk: 36, mods: shift }, "both")).toEqual([
      { type: "rawKeyDown", key: "Home", code: "Home", vk: 36, mods: shift },
      { type: "keyUp", key: "Home", code: "Home", vk: 36, mods: shift },
    ]);
  });
});

// ---- touch (DESIGN-T1 2.8, T-13)

const SRC = join(import.meta.dir, "..", "..", "web");
// The hidden field holds one zero-width space (Keyboard.tsx SENTINEL): not text.
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\u200b/g, "").replace(/\s+/g, " ").trim();
const gm = globalThis as unknown as { matchMedia?: unknown; window?: unknown };
const own = { mm: !gm.matchMedia, win: !gm.window };
let coarse = false;
function viewport(width: number, height: number, touch: boolean) {
  coarse = touch;
  gm.window = { innerWidth: width, innerHeight: height, addEventListener() {}, removeEventListener() {} };
}
beforeAll(() => {
  gm.matchMedia = (q: string) => ({ matches: coarse && q === "(pointer: coarse)", addEventListener() {}, removeEventListener() {} });
});
afterAll(() => {
  if (own.mm) delete gm.matchMedia;
  if (own.win) delete gm.window;
  setSelectingText(false);
});

const TAB: BrowserTabView = {
  id: "q2x4abk3m7",
  url: "http://localhost:3000/book",
  title: "Ridgeway Trails: book a walk",
  loading: false,
  canBack: true,
  canForward: false,
  by: "user",
  opener: null,
  crashed: false,
  hidden: false,
  dialog: null,
  chooser: null,
  size: { kind: "desktop", w: 1280, h: 800, by: "user" },
} as BrowserTabView;
const more = (moving = false, zoom: number | null = null) =>
  renderToStaticMarkup(
    createElement(More, {
      open: true,
      onClose() {},
      anchor: { current: null },
      tab: TAB,
      onSize() {},
      zoom,
      canZoomIn: true,
      onZoomIn() {},
      onZoomOut() {},
      moving,
      onMove() {},
      fullHref: null,
      downloads: [],
      links: false,
      onLinks() {},
    }),
  );
const foot = (phone: boolean) =>
  renderToStaticMarkup(
    createElement(TouchFoot, {
      tab: TAB.id,
      phone,
      nav: false,
      canBack: true,
      canForward: false,
      backName: "Back",
      onBack() {},
      onForward() {},
      tabs: 1,
      onTabs() {},
      focus: null,
      up: false,
      onUp() {},
      onTyped() {},
    }),
  );

describe("More > Select text", () => {
  test("one switch for the page, off at first", () => {
    expect(selectingText()).toBe(false);
    setSelectingText(true);
    expect(selectingText()).toBe(true);
    setSelectingText(false);
    expect(selectingText()).toBe(false);
  });
  test("on touch, More has the switch after the zoom's rows; a laptop's mouse selects, so it has none", () => {
    setSelectingText(false);
    viewport(834, 1194, true);
    const h = more();
    expect(h).toMatch(/<label class="menu-row bp-more-switch"><span>Select text<\/span><span class="switch" data-on="false"><input type="checkbox" role="switch" class="switch-input" aria-label="Select text" data-testid="browser-select-text"/);
    expect(text(h)).toContain("Zoom, on this device");
    expect(text(h).indexOf("Select text")).toBeLessThan(text(h).indexOf("Copy address"));
    expect(text(more(true, 1.5))).toMatch(/Move Select text/);
    setSelectingText(true);
    expect(more()).toMatch(/<span class="switch" data-on="true"><input type="checkbox" role="switch" class="switch-input" aria-label="Select text" data-testid="browser-select-text" checked=""\/>/);
    setSelectingText(false);
    viewport(1280, 800, false);
    expect(more()).not.toContain("Select text");
  });
  test("a finger's drag while it is on: the left button's press where the drag began, its moves, its release with sq, which asks for the page's selection", () => {
    let n = 0;
    const sq = () => ++n;
    const from = { x: 10, y: 20 };
    expect(textDragFrames("move", false, from, { x: 30, y: 25 }, TAB.id, 7, sq)).toEqual([
      { t: "mouse", tab: TAB.id, n: 7, type: "mousePressed", x: 10, y: 20, button: "left", clicks: 1 },
      { t: "mouse", tab: TAB.id, n: 7, type: "mouseMoved", x: 30, y: 25, button: "left" },
    ]);
    expect(textDragFrames("move", true, from, { x: 50, y: 25 }, TAB.id, 8, sq)).toEqual([{ t: "mouse", tab: TAB.id, n: 8, type: "mouseMoved", x: 50, y: 25, button: "left" }]);
    const end = textDragFrames("end", true, from, { x: 60, y: 26 }, TAB.id, 9, sq);
    expect(end).toEqual([{ t: "mouse", tab: TAB.id, n: 9, type: "mouseReleased", x: 60, y: 26, button: "left", clicks: 1, sq: 1 }]);
    expect(asksSelection(end[0]!)).toBe(true);
    // A drag that never pressed sends nothing at its end, and takes no sq.
    expect(textDragFrames("end", false, from, from, TAB.id, 9, sq)).toEqual([]);
    expect(n).toBe(1);
  });
  test("the frame sends the drag's frames instead of a wheel while it is on, and no flick follows", () => {
    const stage = readFileSync(join(SRC, "browser", "Stage.tsx"), "utf8");
    expect(stage).toMatch(/if \(selectingText\(\)\) \{\s*for \(const f of textDragFrames\("move", one\.pressed, one\.from, page\(t\.clientX, t\.clientY\), s\(\)\.tab\.id, drawnN\(s\(\)\.tab\.id\), hold\)\) sendInput\(f\);\s*one\.pressed = true;\s*return;\s*\}\s*wheel\(/);
    expect(stage).toMatch(/if \(o\.pressed\) \{\s*for \(const f of textDragFrames\("end", true, o\.from, page\(o\.lx, o\.ly\), s\(\)\.tab\.id, drawnN\(s\(\)\.tab\.id\), hold\)\) sendInput\(f\);\s*return;\s*\}/);
  });
  test("Select text and Move take turns: one on turns the other off", () => {
    const m = readFileSync(join(SRC, "browser", "More.tsx"), "utf8");
    expect(m).toMatch(/onChange=\{\(on\) => \{\s*setSelectingText\(on\);\s*if \(on\) \{\s*p\.onMove\(false\);\s*p\.onClose\(\);/);
    const stage = readFileSync(join(SRC, "browser", "Stage.tsx"), "utf8");
    expect(stage).toMatch(/onClick=\{\(\) => \{\s*if \(!p\.moving\) setSelectingText\(false\);\s*p\.onMoving\(!p\.moving\);/);
  });
});

describe("the touch foot", () => {
  test("Copy shows while Select text is on, before Keyboard; not otherwise", () => {
    setSelectingText(false);
    expect(foot(true)).not.toContain("browser-copy");
    setSelectingText(true);
    const h = foot(true);
    expect(text(h)).toBe("Back Forward Copy Keyboard 1 Tabs");
    expect(h).toMatch(/<button type="button" class="bp-foot-btn" data-testid="browser-copy">/);
    expect(text(foot(false))).toBe("Copy Keyboard");
    setSelectingText(false);
  });
  test("the foot and its key row are one owner of the hidden field for the keyboard release (data-kb-owner)", () => {
    expect(foot(true)).toMatch(/^<div class="bp-touch" data-kb-owner="">/);
    const css = readFileSync(join(SRC, "styles", "browser.css"), "utf8");
    expect(css).toMatch(/\.bp-touch \{\s*display: contents;\s*\}/);
  });
  test("Copy writes the selection the page sent, as Cmd+C or Ctrl+C in the frame does; the pane closing turns Select text off", () => {
    const kb = readFileSync(join(SRC, "browser", "Keyboard.tsx"), "utf8");
    expect(kb).toMatch(/onClick=\{\(\) =>\s*tab &&\s*void copyPageSelection\(tab\)\.then/);
    expect(kb).toMatch(/useEffect\(\(\) => \(\) => setSelectingText\(false\), \[\]\);/);
    const stage = readFileSync(join(SRC, "browser", "Stage.tsx"), "utf8");
    expect(stage).toMatch(/const copyNow = \(\) => void copyPageSelection\(tab\);/);
  });
});

describe("the address field on touch", () => {
  test("an edit stays when the field loses the focus (the keyboard release blurs it): nothing puts the address back on blur; Esc does", () => {
    const bar = readFileSync(join(SRC, "browser", "Bar.tsx"), "utf8");
    expect(bar).toMatch(/onBlur=\{\(\) => setFocused\(false\)\}/);
    expect(bar.match(/onBlur/g)).toHaveLength(1);
    expect(bar).toMatch(/else if \(e\.key === "Escape"\) \{\s*const back = escapeAddress\(p\.value, p\.url\);/);
    // The pane shows the tab's address again only while the user is not editing it, and only Go or another tab ends an edit.
    const pane = readFileSync(join(SRC, "browser", "BrowserPane.tsx"), "utf8");
    expect(pane).toMatch(/if \(draft \|\| editing\.current\) return;\s*setValue\(fieldUrl\(tab\?\.url\)\);/);
    expect(pane.match(/editing\.current = false/g)).toHaveLength(2);
  });
});
