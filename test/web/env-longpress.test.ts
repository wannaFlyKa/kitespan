// Row 107: on a laptop a mouse press held on an environment heading for 450 ms with less than 8 px of movement lifts it
// as on the phone; a move aims with the drop line, the release sends one move, Esc puts it back. A move of 8 px before
// that is row 99's plain drag, and a click still opens the environment (web/screens/EnvironmentMenu.tsx MousePress,
// wired by useHeadingDrag). The browser's own link drag and text selection never take the press.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LIFT_MS, MousePress, type PointerLike, type PressHost } from "../../web/screens/EnvironmentMenu";
import { dropBefore, gapAt } from "../../web/state/environments";
import { LONG_PRESS_SLOP } from "../../web/ui/primitives";

const A = "aaaaaaaaaa";
const B = "bbbbbbbbbb";
const C = "cccccccccc";
const ALL = [A, B, C];
type Look = { id: string; gap: number | null; how: "lift" | "mouse" } | null;

/** A fake page: three headings (their middles at 150, 300 and 450 in a list from 100 to 700), a clock and frames. */
function rig() {
  let now = 0;
  const timers: { at: number; run: () => void; live: boolean }[] = [];
  let frames: (() => void)[] = [];
  const shown: Look[] = [];
  const moves: [string, string | null][] = [];
  const swallowed: number[] = [];
  const box = { scrollTop: 0, getBoundingClientRect: () => ({ top: 100, bottom: 700 }) };
  const host: PressHost = {
    gapAt: (y) => gapAt(y, [150, 300, 450].map((m) => m - box.scrollTop)),
    dropAt: (id, gap) => dropBefore(ALL, ALL, id, gap),
    show: (s) => shown.push(s && { ...s, how: "lift" }),
    dim: (s) => shown.push(s && { ...s, how: "mouse" }),
    move: (id, before) => moves.push([id, before]),
    scroller: () => box,
    swallowClick: (at) => swallowed.push(at),
    later: (run, ms) => {
      const t = { at: now + ms, run, live: true };
      timers.push(t);
      return () => (t.live = false);
    },
    frame: (run) => {
      frames.push(run);
      return () => (frames = frames.filter((f) => f !== run));
    },
  };
  const tick = (ms: number) => {
    now += ms;
    for (const t of timers)
      if (t.live && t.at <= now) {
        t.live = false;
        t.run();
      }
  };
  const frame = () => {
    const run = frames;
    frames = [];
    for (const f of run) f();
  };
  return { press: new MousePress(host), tick, frame, shown, last: () => shown[shown.length - 1], moves, swallowed, box };
}

const at = (x: number, y: number, timeStamp = 0, pointerId = 1): PointerLike => ({ pointerId, clientX: x, clientY: y, timeStamp });

describe("a mouse press held on a heading (row 107)", () => {
  test("the phone's numbers: 450 ms, and less than 8 px of movement", () => {
    expect(LIFT_MS).toBe(450);
    expect(LONG_PRESS_SLOP).toBe(8);
  });

  test("held 450 ms with a few px of jitter it lifts as on the phone; a move aims with the line; the release sends one move and opens nothing", () => {
    const r = rig();
    r.press.down(A, at(50, 150));
    expect(r.press.pressing).toBe(A);
    r.tick(200);
    r.press.move(at(53, 155)); // under 8 px: still the press
    r.tick(LIFT_MS - 201);
    expect(r.shown).toEqual([]);
    r.tick(1);
    expect(r.shown).toEqual([{ id: A, gap: null, how: "lift" }]);
    r.press.move(at(53, 500));
    expect(r.last()).toEqual({ id: A, gap: 3, how: "lift" });
    r.press.up(at(53, 500, 1234));
    expect(r.swallowed).toEqual([1234]);
    expect(r.moves).toEqual([[A, null]]);
    expect(r.last()).toBeNull();
    expect(r.press.pressing).toBeNull();
  });

  test("a drop between two others sends the one it goes before", () => {
    const r = rig();
    r.press.down(C, at(50, 450));
    r.tick(LIFT_MS);
    r.press.move(at(50, 200));
    expect(r.last()).toEqual({ id: C, gap: 1, how: "lift" });
    r.press.up(at(50, 200));
    expect(r.moves).toEqual([[C, B]]);
  });

  test("a move of 8 px before the lift is row 99's plain drag: the heading dims, no lift comes, its release sends one move", () => {
    const r = rig();
    r.press.down(A, at(50, 150));
    r.tick(100);
    r.press.move(at(50, 150 + LONG_PRESS_SLOP - 1));
    expect(r.shown).toEqual([]);
    r.press.move(at(50, 150 + LONG_PRESS_SLOP));
    expect(r.last()).toEqual({ id: A, gap: null, how: "mouse" }); // its own place: no line
    r.tick(LIFT_MS * 2);
    expect(r.shown.every((s) => s?.how === "mouse")).toBe(true);
    r.press.move(at(50, 500));
    expect(r.last()).toEqual({ id: A, gap: 3, how: "mouse" });
    r.press.up(at(50, 500, 777));
    expect(r.last()).toBeNull();
    expect(r.swallowed).toEqual([777]);
    expect(r.moves).toEqual([[A, null]]);
  });

  test("the plain drag scrolls the list near its edges, as row 99's did", () => {
    const r = rig();
    r.press.down(B, at(50, 300));
    r.press.move(at(50, 690));
    expect(r.box.scrollTop).toBeGreaterThan(0);
    const was = r.box.scrollTop;
    r.press.move(at(50, 110));
    expect(r.box.scrollTop).toBeLessThan(was);
    r.press.up(at(50, 110));
  });

  test("a click (shorter than 450 ms, no move) is the link's: nothing lifts, nothing is swallowed or sent", () => {
    const r = rig();
    r.press.down(A, at(50, 150));
    r.tick(LIFT_MS - 1);
    r.press.up(at(50, 150));
    r.tick(1000);
    expect(r.shown).toEqual([]);
    expect(r.swallowed).toEqual([]);
    expect(r.moves).toEqual([]);
    expect(r.press.pressing).toBeNull();
  });

  test("lifted and released in its own place: it goes back, nothing is sent, and the click opens nothing", () => {
    const r = rig();
    r.press.down(B, at(50, 300));
    r.tick(LIFT_MS);
    r.press.move(at(50, 200)); // its own two gaps: no line
    expect(r.last()).toEqual({ id: B, gap: null, how: "lift" });
    r.press.up(at(50, 200, 55));
    expect(r.swallowed).toEqual([55]);
    expect(r.moves).toEqual([]);
    expect(r.last()).toBeNull();
  });

  test("Esc puts a lift or a plain drag back, and the release after it sends nothing and opens nothing", () => {
    const r = rig();
    r.press.down(A, at(50, 150));
    expect(r.press.escape()).toBe(false); // before a lift or a drag, Esc is not the press's
    r.tick(LIFT_MS);
    r.press.move(at(50, 500));
    expect(r.press.escape()).toBe(true);
    expect(r.last()).toBeNull();
    r.press.move(at(50, 520)); // the button is still down: no lift and no line come back
    r.tick(LIFT_MS * 2);
    expect(r.last()).toBeNull();
    expect(r.press.escape()).toBe(false);
    r.press.up(at(50, 150, 99)); // back over its name: no click
    expect(r.swallowed).toEqual([99]);
    expect(r.moves).toEqual([]);

    r.press.down(A, at(50, 150));
    r.press.move(at(50, 500));
    expect(r.last()).toEqual({ id: A, gap: 3, how: "mouse" });
    expect(r.press.escape()).toBe(true);
    expect(r.last()).toBeNull();
    r.press.up(at(50, 500, 120));
    expect(r.swallowed).toEqual([99, 120]);
    expect(r.moves).toEqual([]);
  });

  test("another pointer's events are not the press's; a pointercancel ends it with nothing sent", () => {
    const r = rig();
    r.press.down(A, at(50, 150));
    r.press.move(at(50, 500, 0, 2));
    r.press.up(at(50, 500, 0, 2));
    expect(r.press.pressing).toBe(A);
    r.tick(LIFT_MS);
    r.press.move(at(50, 500));
    r.press.cancel();
    expect(r.last()).toBeNull();
    expect(r.press.pressing).toBeNull();
    r.press.up(at(50, 500));
    expect(r.moves).toEqual([]);
    expect(r.swallowed).toEqual([]);
    // A plain drag that is cancelled leaves no dimmed heading either.
    r.press.down(B, at(50, 300));
    r.press.move(at(50, 600));
    r.press.cancel();
    expect(r.last()).toBeNull();
  });

  test("a lifted heading held near the list's edge scrolls it by itself, as on the phone", () => {
    const r = rig();
    r.box.scrollTop = 300;
    r.press.down(C, at(50, 150));
    r.tick(LIFT_MS);
    r.press.move(at(50, 110));
    for (let i = 0; i < 200 && r.last()?.gap === null; i++) r.frame();
    expect(r.box.scrollTop).toBeLessThan(300);
    expect(r.last()).toEqual({ id: C, gap: 1, how: "lift" });
    r.press.up(at(50, 110));
    expect(r.moves).toEqual([[C, B]]);
  });
});

describe("the heading on a laptop: the browser's own drag and selection never take the press", () => {
  const WEB = join(import.meta.dir, "..", "..", "web");
  const menu = readFileSync(join(WEB, "screens", "EnvironmentMenu.tsx"), "utf8");
  const list = readFileSync(join(WEB, "screens", "ChatListBody.tsx"), "utf8");
  const primitives = readFileSync(join(WEB, "ui", "primitives.tsx"), "utf8");
  const css = readFileSync(join(WEB, "styles", "screens.css"), "utf8");

  test("the name's link is not draggable, and a dragstart on any heading is prevented, mouse or finger", () => {
    expect(list).toMatch(/className="scr-group-name"[^>]*draggable=\{false\}/);
    expect(primitives).toContain("draggable?: boolean");
    expect(menu).toContain('el.addEventListener("dragstart", noDrag);');
  });

  test("the press prevents its pointerdown's default and any selection while it is down", () => {
    expect(menu).toMatch(/onPointerDown\(id, e\) \{[\s\S]*?e\.preventDefault\(\);[\s\S]*?window\.addEventListener\("selectstart", noSelect, true\);/);
    expect(menu).toContain('window.removeEventListener("selectstart", noSelect, true);');
  });

  test("the mouse's lift has the finger's raised look", () => {
    const rule = (sel: string) => {
      const i = css.indexOf(`\n${sel},`);
      expect(i).toBeGreaterThanOrEqual(0);
      return css.slice(i, css.indexOf("}", i));
    };
    expect(rule('.scr-group-head[data-dragging="lift"]')).toContain('.scr-group-head[data-dragging="touch"] {');
    expect(rule('.scr-group-head[data-dragging="lift"]::before')).toContain('.scr-group-head[data-dragging="touch"]::before {');
    expect(rule('.scr-group-head[data-dragging="lift"]::before')).toContain("opacity: 1;");
  });
});
