// Composition on touch (DESIGN.md 7.5; DESIGN-T1 2.8, T-18, G-9): Return waits only while an input method shows
// marked text in the focused field, and 100 ms after it ends; a dictated message (no composition events, key code 229)
// sends; a fine pointer keeps the key's own marks (ui/primitives composingKey). One tracker at the document, in the
// capture phase, installed once at the app's root. The same test serves the message box, the `@` picker, the new-chat
// box, the side chat, the cards' fields and the search pane's field (paneKey). No browser: a stand-in document whose
// listeners the test calls, and a clock it moves.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IME_TAIL_MS, createCompositionTracker, imeHolds, imeKey, installComposition } from "../../web/composer/composition";
import { paneKey } from "../../web/search/sections";
import { composingKey } from "../../web/ui/primitives";

const WEB = join(import.meta.dir, "..", "..", "web");
const src = (...p: string[]) => readFileSync(join(WEB, ...p), "utf8");

describe("the tracker (createCompositionTracker)", () => {
  const field = { name: "field" };
  const other = { name: "other" };
  test("marked text holds Return in its field, from compositionstart to compositionend", () => {
    expect(IME_TAIL_MS).toBe(100);
    const t = createCompositionTracker();
    expect(t.holds(field, 0)).toBe(false);
    t.start(field, 0);
    expect([t.holds(field, 10), t.holds(field, 5000), t.holds(other, 10), t.holds(null, 10)]).toEqual([true, true, false, false]);
  });
  test("an input method that ends the composition before the Enter's keydown (end, then Enter within 100 ms) still holds it", () => {
    const t = createCompositionTracker();
    t.start(field, 0);
    t.end(field, 1000);
    expect([t.holds(field, 1000), t.holds(field, 1050), t.holds(field, 1099)]).toEqual([true, true, true]);
    // 100 ms and later after the end, Return is the field's again: Enter 200 ms after sends.
    expect([t.holds(field, 1100), t.holds(field, 1200)]).toEqual([false, false]);
    // Only in the field that composed.
    expect(t.holds(other, 1050)).toBe(false);
  });
  test("a field that loses the focus mid-word holds nothing more (no stuck Return)", () => {
    const t = createCompositionTracker();
    t.start(field, 0);
    t.leave(field);
    expect(t.holds(field, 10)).toBe(false);
    t.start(field, 20);
    t.end(field, 30);
    t.leave(field);
    expect(t.holds(field, 40)).toBe(false);
    // Another field's leave does not end this one's composition.
    t.start(field, 50);
    t.leave(other);
    expect(t.holds(field, 60)).toBe(true);
  });
});

/** A stand-in document: the listeners the tracker adds, its focused element, and a clock. */
function fakeDoc() {
  const on = new Map<string, (e: { target: unknown }) => void>();
  const doc = {
    activeElement: null as unknown,
    addEventListener(type: string, fn: (e: { target: unknown }) => void, capture?: boolean) {
      expect(capture).toBe(true);
      on.set(type, fn);
    },
    removeEventListener(type: string) {
      on.delete(type);
    },
  };
  let t = 0;
  const fire = (type: string, target: unknown) => on.get(type)?.({ target });
  return { doc, on, fire, now: () => t, at: (ms: number) => (t = ms) };
}

describe("the installed tracker: imeHolds, imeKey and the fields' Enter", () => {
  let off: (() => void) | null = null;
  afterEach(() => {
    off?.();
    off = null;
  });
  const setUp = () => {
    const f = fakeDoc();
    off = installComposition(f.doc as unknown as Document, f.now);
    const field = { tagName: "TEXTAREA" };
    f.doc.activeElement = field;
    return { ...f, field };
  };
  test("it listens at the document in the capture phase for the start, the end and a focus that leaves", () => {
    const f = setUp();
    expect([...f.on.keys()].sort()).toEqual(["compositionend", "compositionstart", "focusout"]);
    off!();
    off = null;
    expect(f.on.size).toBe(0);
    expect(imeHolds()).toBe(false);
  });
  test("dictation (no composition events, key code 229) sends on touch", () => {
    setUp();
    expect(imeHolds()).toBe(false);
    expect(imeKey({ keyCode: 229, isComposing: false }, true)).toBe(false);
    // iOS marks some keyboards' keys as composing too: on touch the key's marks alone never hold Return.
    expect(imeKey({ keyCode: 229, isComposing: true }, true)).toBe(false);
  });
  test("marked text waits: Enter during the composition is the input method's, and the second Enter sends", () => {
    const f = setUp();
    f.at(0);
    f.fire("compositionstart", f.field);
    f.at(400);
    expect([imeHolds(), imeKey({ keyCode: 229, isComposing: true }, true)]).toEqual([true, true]);
    f.fire("compositionend", f.field);
    f.at(450);
    expect(imeKey({ keyCode: 13 }, true)).toBe(true); // the committing Enter, just after the end
    f.at(600);
    expect(imeKey({ keyCode: 13 }, true)).toBe(false); // the next Enter sends
  });
  test("a composition in another field holds nothing in the focused one", () => {
    const f = setUp();
    f.fire("compositionstart", { tagName: "INPUT" });
    expect(imeHolds()).toBe(false);
  });
  test("a fine pointer keeps composingKey: the key's own marks, whatever the tracker says", () => {
    const f = setUp();
    for (const e of [{ isComposing: true }, { keyCode: 229 }, {}, { isComposing: false, keyCode: 13 }]) expect([e, imeKey(e, false)]).toEqual([e, composingKey(e, false)]);
    f.fire("compositionstart", f.field);
    expect(imeKey({ keyCode: 13 }, false)).toBe(false);
  });
  test("the search pane's field: no hit is picked while imeHolds(), and Enter picks once the word is taken", () => {
    const f = setUp();
    f.at(0);
    f.fire("compositionstart", f.field);
    expect(paneKey({ key: "Enter", keyCode: 229, isComposing: true }, true)).toBeNull();
    expect(paneKey({ key: "ArrowDown" }, true)).toBeNull();
    expect(paneKey({ key: "Escape" }, true)).toBeNull(); // Esc cancels the word; the pane stays
    f.fire("compositionend", f.field);
    f.at(200);
    expect(paneKey({ key: "Enter" }, true)).toBe("pick");
    // With no composition, touch picks at once on any Enter (dictation), as before.
    expect(paneKey({ key: "Enter", keyCode: 229 }, true)).toBe("pick");
    // A fine pointer: the key's marks, as before.
    expect(paneKey({ key: "Enter", isComposing: true }, false)).toBeNull();
    expect(paneKey({ key: "Enter" }, false)).toBe("pick");
  });
});

describe("every field's Enter and Esc take the one test (imeKey)", () => {
  test("App installs the tracker once", () => {
    const app = src("App.tsx");
    expect(app).toContain("useEffect(() => installComposition(), []);");
    expect(app.split("installComposition(").length).toBe(2);
  });
  test("the message box: Return waits while imeKey, before the Return key setting and Send now", () => {
    const composer = src("composer", "Composer.tsx");
    const keys = composer.slice(composer.indexOf("const onKeyDown = "), composer.indexOf("// ---- files (D37, D50)"));
    expect(keys).toContain("const ime = imeKey(e.nativeEvent, coarse);");
    const enter = keys.slice(keys.indexOf('if (e.key === "Enter" && !e.shiftKey && !e.altKey) {'));
    expect(enter.indexOf("if (ime) return;")).toBeGreaterThan(0);
    expect(enter.indexOf("if (ime) return;")).toBeLessThan(enter.indexOf('if (coarse && settings.returnKey !== "send" && !forced) return;'));
    expect(enter.indexOf("if (ime) return;")).toBeLessThan(enter.indexOf("sendNowKey("));
    expect(keys).not.toContain("never wait for composition on touch");
  });
  test("the new-chat box and the side chat's box: the same", () => {
    const form = src("composer", "useFormBox.ts");
    const keys = form.slice(form.indexOf("const onKeyDown = "), form.indexOf("// ---- the end of the keys ----"));
    expect(keys).toContain("const ime = imeKey(e.nativeEvent, coarse);");
    expect(keys.indexOf("if (ime) return;")).toBeLessThan(keys.indexOf("onStart();"));
    const side = src("side", "SideChat.tsx");
    const box = side.slice(side.indexOf("const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>)"), side.indexOf("// It grows to 6 lines"));
    expect(box).toContain("if (imeKey(e.nativeEvent, vp.touch)) return;");
    expect(box).not.toContain("never wait for composition on touch");
  });
  test("Esc during a composition is the input method's: the side chat stays open, and the message box stops no turn", () => {
    const side = src("side", "SideChat.tsx");
    expect(side).toContain('if (e.key !== "Escape" || e.defaultPrevented || imeKey(e.nativeEvent, vp.touch)) return;');
    const composer = src("composer", "Composer.tsx");
    expect(composer).toContain('if (e.key === "Escape" && k.canStop && !k.menuVisible && !k.popupOpen && !isOtherField(e.target, field.current) && !imeKey(e)) {');
  });
  test("the cards' fields (a Deny note, Other, a page's prompt) wait the same way on touch and with a mouse", () => {
    for (const p of [["chat", "cards", "PermissionCard.tsx"], ["chat", "cards", "QuestionCard.tsx"], ["browser", "DialogCard.tsx"]]) {
      const code = src(...p);
      expect([p.join("/"), code.includes('if (e.key === "Enter" && !imeKey(e.nativeEvent)) {')]).toEqual([p.join("/"), true]);
      expect([p.join("/"), code.includes('e.key === "Enter" && !e.nativeEvent.isComposing')]).toEqual([p.join("/"), false]);
    }
  });
});
