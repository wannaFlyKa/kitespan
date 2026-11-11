// The segmented control and the switch (ui/Segmented.tsx, ui/Switch.tsx; prototype design plan v2): their keyboard
// rules and their ARIA roles, without a browser. The arrow keys move the segment that is on (wrapping, skipping a
// disabled one), Home and End go to the ends; the switch is a real checkbox with role="switch", so Space is the
// checkbox's own key and Enter turns it too. Neither component uses a hook, so the test calls them as functions and
// drives their handlers with stand-in events; react-dom/server renders their markup.
import { describe, expect, test } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Segmented, segmentFor, type SegmentOption } from "../../web/ui/Segmented";
import { Switch, switchKey } from "../../web/ui/Switch";

const OPTIONS: SegmentOption<"system" | "light" | "dark">[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

describe("segmentFor: where a key moves the segmented control", () => {
  const none = [false, false, false];
  test("the arrow keys move one segment and wrap", () => {
    expect(segmentFor("ArrowRight", 0, none)).toBe(1);
    expect(segmentFor("ArrowDown", 1, none)).toBe(2);
    expect(segmentFor("ArrowRight", 2, none)).toBe(0);
    expect(segmentFor("ArrowLeft", 0, none)).toBe(2);
    expect(segmentFor("ArrowUp", 2, none)).toBe(1);
  });
  test("Home and End go to the first and the last segment that is not disabled", () => {
    expect(segmentFor("Home", 2, none)).toBe(0);
    expect(segmentFor("End", 0, none)).toBe(2);
    expect(segmentFor("Home", 2, [true, false, false])).toBe(1);
    expect(segmentFor("End", 0, [false, false, true])).toBe(1);
  });
  test("a disabled segment is skipped", () => {
    expect(segmentFor("ArrowRight", 0, [false, true, false])).toBe(2);
    expect(segmentFor("ArrowLeft", 2, [false, true, false])).toBe(0);
  });
  test("with no segment on, the arrows start from an end", () => {
    expect(segmentFor("ArrowRight", -1, none)).toBe(0);
    expect(segmentFor("ArrowLeft", -1, none)).toBe(2);
  });
  test("other keys, no segments, or nowhere else to go: no move", () => {
    expect(segmentFor("a", 0, none)).toBeNull();
    expect(segmentFor("Enter", 0, none)).toBeNull();
    expect(segmentFor("ArrowRight", 0, [])).toBeNull();
    expect(segmentFor("ArrowRight", 1, [true, false, true])).toBeNull();
    expect(segmentFor("Home", 0, [true, true, true])).toBeNull();
  });
});

/** A stand-in keydown on the segment at `from`: it records preventDefault and which segment got the focus. */
function segKey(key: string, from: number, mods: Partial<Record<"altKey" | "ctrlKey" | "metaKey" | "shiftKey", boolean>> = {}) {
  const focused: number[] = [];
  const radios = OPTIONS.map((_, i) => ({ focus: () => focused.push(i) }));
  const e = {
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...mods,
    target: { dataset: { index: String(from) } },
    currentTarget: { querySelectorAll: () => radios },
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
  return { e, focused };
}

describe("Segmented", () => {
  test("a radio group: one radio per option, the one that is on checked and the only tab stop", () => {
    const html = renderToStaticMarkup(createElement(Segmented, { value: "light", options: OPTIONS, onChange: () => {}, label: "Theme", testId: "seg-theme" }));
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Theme"');
    expect(html.match(/role="radio"/g)?.length).toBe(3);
    expect(html.match(/aria-checked="true"/g)?.length).toBe(1);
    expect(html.match(/tabindex="0"/g)?.length).toBe(1);
    expect(html).toMatch(/aria-checked="true" tabindex="0"[^>]*data-value="light"/);
    expect(html).toContain('style="--seg-count:3;--seg-index:1"');
    expect(html).toContain('class="seg"');
  });
  test("with no option on, the first enabled segment is the tab stop and the thumb hides", () => {
    const html = renderToStaticMarkup(createElement(Segmented, { value: null, options: OPTIONS, onChange: () => {}, label: "Show", block: true, small: true }));
    expect(html).toContain('data-none="true"');
    expect(html).toContain('class="seg seg-block seg-small"');
    expect(html).not.toContain('aria-checked="true"');
    expect(html).toMatch(/tabindex="0"[^>]*data-value="system"/);
  });
  test("ArrowRight turns the next segment on and moves the focus there; ArrowLeft wraps", () => {
    const picked: string[] = [];
    const el = Segmented({ value: "system", options: OPTIONS, onChange: (v) => picked.push(v), label: "Theme" }) as ReactElement<{ onKeyDown: (e: unknown) => void }>;
    const right = segKey("ArrowRight", 0);
    el.props.onKeyDown(right.e);
    expect(picked).toEqual(["light"]);
    expect(right.focused).toEqual([1]);
    expect(right.e.prevented).toBe(true);
    const left = segKey("ArrowLeft", 0);
    el.props.onKeyDown(left.e);
    expect(picked).toEqual(["light", "dark"]);
    expect(left.focused).toEqual([2]);
  });
  test("a key with a modifier, or one that does not move, does nothing", () => {
    const picked: string[] = [];
    const el = Segmented({ value: "system", options: OPTIONS, onChange: (v) => picked.push(v), label: "Theme" }) as ReactElement<{ onKeyDown: (e: unknown) => void }>;
    for (const k of [segKey("ArrowRight", 0, { metaKey: true }), segKey("Tab", 0), segKey("x", 0)]) {
      el.props.onKeyDown(k.e);
      expect(k.e.prevented).toBe(false);
    }
    expect(picked).toEqual([]);
  });
  test("a click on the segment that is on calls nothing; a click on a disabled one neither", () => {
    const picked: string[] = [];
    const opts = [OPTIONS[0]!, { ...OPTIONS[1]!, disabled: true }, OPTIONS[2]!];
    const el = Segmented({ value: "system", options: opts, onChange: (v) => picked.push(v), label: "Theme" }) as ReactElement<{ children: ReactElement<{ onClick: () => void }>[] }>;
    const [on, off, dark] = el.props.children;
    on!.props.onClick();
    off!.props.onClick();
    dark!.props.onClick();
    expect(picked).toEqual(["dark"]);
  });
});

describe("Switch", () => {
  test("a real checkbox with role switch, named by its label", () => {
    const html = renderToStaticMarkup(createElement(Switch, { checked: true, onChange: () => {}, label: "Allow bypass permissions mode", testId: "switch-bypass" }));
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('role="switch"');
    expect(html).toContain('checked=""');
    expect(html).toContain('aria-label="Allow bypass permissions mode"');
    expect(html).toContain('data-on="true"');
    expect(html).toContain('class="switch-track" aria-hidden="true"');
  });
  test("a visible label names it instead (aria-labelledby), and disabled shows", () => {
    const html = renderToStaticMarkup(createElement(Switch, { checked: false, onChange: () => {}, label: "unused", labelledBy: "row-7", disabled: true }));
    expect(html).toContain('aria-labelledby="row-7"');
    expect(html).not.toContain("aria-label=");
    expect(html).toContain("disabled");
    expect(html).toContain('data-on="false"');
  });
  test("switchKey: Enter turns it; Space is the checkbox's own key, so it is not handled twice", () => {
    expect(switchKey("Enter", false)).toBe(true);
    expect(switchKey("Enter", true)).toBe(false);
    expect(switchKey(" ", false)).toBeNull();
    expect(switchKey("a", false)).toBeNull();
  });

  type InputProps = { onKeyDown: (e: unknown) => void; onChange: (e: unknown) => void };
  const input = (on: boolean, seen: boolean[], disabled = false) =>
    (Switch({ checked: on, onChange: (v) => seen.push(v), label: "Name chats", disabled }) as ReactElement<{ children: ReactElement<InputProps>[] }>).props.children[0]!.props;
  const key = (k: string, repeat = false) => ({ key: k, repeat, prevented: false, preventDefault() {
    this.prevented = true;
  } });

  test("Space: the checkbox's change event turns it, and the key handler leaves Space alone", () => {
    const seen: boolean[] = [];
    const props = input(false, seen);
    const space = key(" ");
    props.onKeyDown(space);
    expect(space.prevented).toBe(false);
    expect(seen).toEqual([]);
    props.onChange({ currentTarget: { checked: true } }); // what the browser fires after Space or a click
    expect(seen).toEqual([true]);
  });
  test("Enter turns it once; a held Enter (repeat) and a disabled switch do nothing", () => {
    const seen: boolean[] = [];
    const enter = key("Enter");
    input(true, seen).onKeyDown(enter);
    expect(seen).toEqual([false]);
    expect(enter.prevented).toBe(true);
    input(true, seen).onKeyDown(key("Enter", true));
    input(true, seen, true).onKeyDown(key("Enter"));
    expect(seen).toEqual([false]);
  });
});
