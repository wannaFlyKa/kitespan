// The on-screen keyboard's reads and the one release at the app's root (DESIGN.md 7.8; DESIGN-T1 2.2, G-5 to G-8):
// readKeyboard's 100 px threshold and its bad reads, the dismiss watcher's settle timer with an injected clock (a
// release at 450 ms, none on a width change, none after the field's own intent, a release after a press elsewhere),
// the owners' mark that decides whose press is the field's own, and the one layout-height mark that every reader
// shares, so a part that mounts while the keyboard is up reads it as up. No browser: the pure parts run here, and the
// root hook's wiring is read from its source (the click-through drives the real keyboard: ui-check's
// keyboard-release flow).
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KEYBOARD_MIN, SETTLE_MS, createDismissWatcher, currentKeyboard, isEditable, ownsIntent, readKeyboard } from "../../web/composer/keyboard";
import { heightMark, nextHeightMark, sampleHeightMark } from "../../web/layout/heightMark";

const WEB = join(import.meta.dir, "..", "..", "web");
const src = (...p: string[]) => readFileSync(join(WEB, ...p), "utf8");

describe("one read of the keyboard (readKeyboard)", () => {
  test("up from 100 px of layout height over the visual height; 99 px is the address bar's jitter", () => {
    expect(KEYBOARD_MIN).toBe(100);
    expect(readKeyboard(844, 745, 0, 844).up).toBe(false);
    expect(readKeyboard(844, 744, 0, 844).up).toBe(true);
    expect(readKeyboard(844, 744, 12, 844)).toEqual({ up: true, visualHeight: 744, offsetTop: 12 });
  });
  test("a missing, 0, negative or NaN visual height is a bad read: down, at the layout's height", () => {
    for (const bad of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) expect([bad, readKeyboard(844, bad, 0, 844)]).toEqual([bad, { up: false, visualHeight: 844, offsetTop: 0 }]);
    // A bad offset counts as 0, never as a move under the top.
    expect(readKeyboard(844, 500, Number.NaN, 844).offsetTop).toBe(0);
    expect(readKeyboard(844, 500, -30, 844).offsetTop).toBe(0);
  });
});

/** A clock and one timer that the test moves by hand. */
function fakeClock() {
  let t = 0;
  let due: { at: number; fn: () => void } | null = null;
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => {
      due = { at: t + ms, fn };
      return due;
    },
    clearTimer: (h: unknown) => {
      if (due === h) due = null;
    },
    to(at: number) {
      t = at;
      const d = due;
      if (d && d.at <= t) {
        due = null;
        d.fn();
      }
    },
  };
}

function watcherOn() {
  const clock = fakeClock();
  let released = 0;
  const w = createDismissWatcher({ settleMs: SETTLE_MS, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, release: () => released++ });
  return { w, clock, released: () => released };
}

describe("the dismiss watcher (createDismissWatcher), with an injected clock", () => {
  test("a keyboard that stays down 450 ms after it was up releases the field, once", () => {
    expect(SETTLE_MS).toBe(450);
    const { w, clock, released } = watcherOn();
    w.sample({ up: false, width: 390 });
    clock.to(1000);
    expect(released()).toBe(0); // never up: nothing to release
    w.sample({ up: true, width: 390 });
    clock.to(2000);
    w.sample({ up: false, width: 390 });
    clock.to(2449);
    expect(released()).toBe(0);
    clock.to(2450);
    expect(released()).toBe(1);
    // More down reads (the address bar, a scroll) release nothing more until the keyboard is up again.
    w.sample({ up: false, width: 390 });
    clock.to(4000);
    expect(released()).toBe(1);
  });
  test("a keyboard that comes back up inside the 450 ms releases nothing", () => {
    const { w, clock, released } = watcherOn();
    w.sample({ up: true, width: 390 });
    w.sample({ up: false, width: 390 });
    clock.to(200);
    w.sample({ up: true, width: 390 });
    clock.to(1000);
    expect(released()).toBe(0);
  });
  test("a width change (a rotation, a new window) resets it: no release", () => {
    const { w, clock, released } = watcherOn();
    w.sample({ up: true, width: 390 });
    w.sample({ up: false, width: 844 });
    clock.to(1000);
    expect(released()).toBe(0);
    // Up and down at the new width is the watcher's again.
    w.sample({ up: true, width: 844 });
    clock.to(1100);
    w.sample({ up: false, width: 844 });
    clock.to(1550);
    expect(released()).toBe(1);
  });
  test("the field's own intent after the keyboard went down cancels the release; an intent before it does not", () => {
    const a = watcherOn();
    a.w.sample({ up: true, width: 390 });
    a.w.sample({ up: false, width: 390 });
    a.clock.to(300);
    a.w.intent();
    a.clock.to(1000);
    expect(a.released()).toBe(0);
    // Typing while the keyboard was up is an intent before it went down: the release still comes.
    const b = watcherOn();
    b.w.sample({ up: true, width: 390 });
    b.clock.to(100);
    b.w.intent();
    b.clock.to(200);
    b.w.sample({ up: false, width: 390 });
    b.clock.to(650);
    expect(b.released()).toBe(1);
  });
  test("dispose stops a pending release", () => {
    const { w, clock, released } = watcherOn();
    w.sample({ up: true, width: 390 });
    w.sample({ up: false, width: 390 });
    w.dispose();
    clock.to(1000);
    expect(released()).toBe(0);
  });
});

/** A stand-in element: its owner by `closest`, and what it holds by `contains`. */
interface Fake {
  name: string;
  parent: Fake | null;
  owner: boolean;
  closest(sel: string): Fake | null;
  contains(other: unknown): boolean;
}
function el(name: string, parent: Fake | null = null, owner = false): Fake {
  const me: Fake = {
    name,
    parent,
    owner,
    closest(sel: string) {
      expect(sel).toBe("[data-kb-owner]");
      for (let at: Fake | null = me; at; at = at.parent) if (at.owner) return at;
      return null;
    },
    contains(other: unknown) {
      for (let at = other as Fake | null; at; at = at.parent) if (at === me) return true;
      return false;
    },
  };
  return me;
}

describe("whose press is the field's own (ownsIntent and the owners' mark)", () => {
  const page = el("page");
  const composer = el("composer", page, true);
  const field = el("textarea", el("slab", composer));
  const plus = el("plus", el("bar", composer));
  const chat = el("chat", page);
  const rename = el("rename-input", el("sheet", page));
  test("a press inside the field's owner ([data-kb-owner]: the composer's root) is the field's own", () => {
    expect([ownsIntent(field, field), ownsIntent(plus, field)]).toEqual([true, true]);
  });
  test("a press elsewhere in the page is not, so the release still comes (G-7)", () => {
    expect([ownsIntent(chat, field), ownsIntent(page, field), ownsIntent(null, field)]).toEqual([false, false, false]);
    // As the watcher sees it: only the field's own intents reach intent(), so a tap on the chat leaves the release.
    const { w, clock, released } = watcherOn();
    w.sample({ up: true, width: 390 });
    w.sample({ up: false, width: 390 });
    clock.to(200);
    if (ownsIntent(chat, field)) w.intent();
    clock.to(450);
    expect(released()).toBe(1);
  });
  test("a field with no owner (a sheet's field, rename, search) is its own owner", () => {
    expect([ownsIntent(rename, rename), ownsIntent(el("sheet-done", rename.parent), rename)]).toEqual([true, false]);
  });
  test("the fields it follows: text fields, text areas and editable boxes; not buttons, checks or a read-only field", () => {
    const input = (type: string, readOnly = false) => ({ tagName: "INPUT", type, readOnly, isContentEditable: false });
    expect(["text", "search", "url", "email", "password", "number", "tel", ""].map((t) => isEditable(input(t)))).toEqual([true, true, true, true, true, true, true, true]);
    expect(["button", "checkbox", "radio", "range", "submit", "file", "color"].map((t) => isEditable(input(t)))).toEqual([false, false, false, false, false, false, false]);
    expect(isEditable(input("text", true))).toBe(false);
    expect(isEditable({ tagName: "TEXTAREA", readOnly: false, isContentEditable: false })).toBe(true);
    expect(isEditable({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect([isEditable({ tagName: "BUTTON", isContentEditable: false }), isEditable(null), isEditable(undefined)]).toEqual([false, false, false]);
  });
});

describe("one layout-height mark for every reader (heightMark.ts, G-6)", () => {
  const g = globalThis as unknown as { window?: unknown };
  const had = "window" in g;
  const was = g.window;
  afterEach(() => {
    if (had) g.window = was;
    else delete g.window;
  });
  test("the mark is the largest innerHeight since innerWidth last changed", () => {
    let m = nextHeightMark(null, 851, 1100);
    m = nextHeightMark(m, 851, 780);
    expect(m).toEqual({ width: 851, height: 1100 });
    expect(nextHeightMark(m, 851, 1200)).toEqual({ width: 851, height: 1200 });
    expect(nextHeightMark(m, 1100, 851)).toEqual({ width: 1100, height: 851 });
  });
  test("a reader that starts while the keyboard is up reads the mark seeded before it, so it reads the keyboard as up", () => {
    // Seeded at boot (main.tsx) at the full height; then Chrome on Android shrinks the layout with the keyboard
    // (interactive-widget=resizes-content), and a part mounts now (a sheet, the side chat, a card).
    sampleHeightMark(390, 844);
    g.window = { innerWidth: 390, innerHeight: 500, visualViewport: { height: 500, offsetTop: 0 }, addEventListener() {}, removeEventListener() {} };
    expect(heightMark()).toBe(844);
    expect(currentKeyboard()).toEqual({ up: true, visualHeight: 500, offsetTop: 0 });
    // Each hook's own mark, seeded at its mount (the code before), would have read 500 and the keyboard as down.
    expect(readKeyboard(500, 500, 0, 500).up).toBe(false);
    // The keyboard down again: the layout and the visual viewport are back to 844.
    g.window = { innerWidth: 390, innerHeight: 844, visualViewport: { height: 844, offsetTop: 0 }, addEventListener() {}, removeEventListener() {} };
    expect(currentKeyboard().up).toBe(false);
  });
  test("the size class and every keyboard read take the one mark: size.ts keeps no mark of its own", () => {
    const size = src("layout", "size.ts");
    expect(size).toContain('import { sampleHeightMark } from "./heightMark";');
    expect(size).not.toMatch(/let mark\b/);
    expect(size).not.toContain("export function nextHeightMark");
    const kb = src("composer", "keyboard.ts");
    expect(kb).toContain('import { heightMark } from "../layout/heightMark";');
    expect(kb).not.toMatch(/let mark = window\.innerHeight/);
    // Seeded before the first render, and on every resize.
    const main = src("main.tsx");
    expect(main).toContain("seedHeightMark();");
    expect(main.indexOf("seedHeightMark();")).toBeLessThan(main.indexOf("const vp = readViewport();"));
  });
});

describe("the one release at the app's root (useKeyboardRelease)", () => {
  const kb = src("composer", "keyboard.ts");
  const app = src("App.tsx");
  test("App mounts it once, on touch only", () => {
    expect(app).toContain("useKeyboardRelease(vp.touch);");
    expect(app.split("useKeyboardRelease(").length).toBe(2);
  });
  test("it blurs the field it follows only while that field still has the focus, then runs the parts' clean-up", () => {
    const hook = kb.slice(kb.indexOf("export function useKeyboardRelease("));
    expect(hook).toContain("if (el && document.activeElement === el) el.blur();");
    expect(hook).toContain("for (const done of [...SETTLED]) done();");
    // The field's own press, focus or key cancels a pending release; a press elsewhere does not (G-7).
    for (const type of ["pointerdown", "focusin", "keydown"]) expect(hook).toContain(`document.addEventListener("${type}", own, true);`);
    expect(hook).toContain("if (field && ownsIntent(e.target, field)) watcher.intent();");
  });
  test("the message box no longer blurs itself: the root blurs, and the composer closes its menus", () => {
    const composer = src("composer", "Composer.tsx");
    const cb = composer.slice(composer.indexOf("const kb = useSoftKeyboard("), composer.indexOf("const [focusIn, setFocusIn]"));
    expect(cb).not.toContain(".blur()");
    expect(cb).toContain("closeMention();");
    expect(cb).toContain("closeSlash();");
    expect(composer).toContain('data-kb-owner=""');
  });
  test("the owners' mark: the side chat's box, every waiting card's frame and the browser's dialog card", () => {
    expect(src("side", "SideChat.tsx")).toContain('<div className="sc-box" data-testid="side-box" data-kb-owner="">');
    expect(src("chat", "cards", "Frame.tsx")).toContain('data-kb-owner=""');
    expect(src("browser", "DialogCard.tsx")).toContain('data-kb-owner=""');
  });
});
