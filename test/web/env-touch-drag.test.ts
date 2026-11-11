// Row 102: on touch a long press on an environment heading lifts it, a move aims at a gap with the drop line, and the
// release sends one move (web/screens/EnvironmentMenu.tsx HeadingLift, wired by useHeadingDrag). A move before the lift
// is a scroll, a quick tap keeps the heading's link, a lift released with no move or a second finger puts it back, and
// a drag never opens the link. The look: no callout or text selection on the heading, the lifted heading on the raised
// surface, no lift animation with Reduce motion.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HeadingLift, LIFT_MS, type LiftHost, type TouchLike } from "../../web/screens/EnvironmentMenu";
import { dropBefore, gapAt } from "../../web/state/environments";
import { LONG_PRESS_SLOP } from "../../web/ui/primitives";

const A = "aaaaaaaaaa";
const B = "bbbbbbbbbb";
const C = "cccccccccc";
const ALL = [A, B, C];

/** A fake page: three headings (their middles at 150, 300 and 450 in a list from 100 to 700), a clock and frames. */
function rig() {
  let now = 0;
  const timers: { at: number; run: () => void; live: boolean }[] = [];
  let frames: (() => void)[] = [];
  const shown: ({ id: string; gap: number | null } | null)[] = [];
  const moves: [string, string | null][] = [];
  const swallowed: number[] = [];
  const box = { scrollTop: 0, getBoundingClientRect: () => ({ top: 100, bottom: 700 }) };
  const host: LiftHost = {
    gapAt: (y) => gapAt(y, [150, 300, 450].map((m) => m - box.scrollTop)),
    dropAt: (id, gap) => dropBefore(ALL, ALL, id, gap),
    show: (s) => shown.push(s),
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
  return { lift: new HeadingLift(host), tick, frame, frames: () => frames.length, shown, last: () => shown[shown.length - 1], moves, swallowed, box };
}

type Ev = TouchLike & { prevented: boolean };
/** A touch event: the fingers down after it (`touches`) and the ones it is about (`changed`, default: all of them). */
function ev(touches: [number, number][], changed: [number, number][] = touches, cancelable = true, at = 0): Ev {
  const pts = (l: [number, number][]) => l.map(([x, y], i) => ({ identifier: i, clientX: x, clientY: y }));
  const e = {
    touches: pts(touches),
    changedTouches: pts(changed),
    cancelable,
    timeStamp: at,
    prevented: false,
    preventDefault() {
      e.prevented = true;
    },
  };
  return e;
}
const fingerAt = (x: number, y: number) => ev([[x, y]]);
const lifted = (x: number, y: number) => ev([], [[x, y]]);

describe("a long press on a heading (row 102)", () => {
  test("the numbers: about 450 ms, and the finger's 8 px of jitter", () => {
    expect(LIFT_MS).toBe(450);
    expect(LONG_PRESS_SLOP).toBe(8);
  });

  test("a hold under 8 px lifts it; a move aims with the line; the release sends one move and opens nothing", () => {
    const r = rig();
    r.lift.down(A, fingerAt(50, 150));
    expect(r.lift.pressing).toBe(A);
    r.tick(LIFT_MS - 1);
    const jitter = fingerAt(54, 155);
    r.lift.move(jitter);
    expect(jitter.prevented).toBe(false);
    expect(r.shown).toEqual([]);
    r.tick(1);
    expect(r.shown).toEqual([{ id: A, gap: null }]);
    const m = fingerAt(54, 500);
    r.lift.move(m);
    expect(m.prevented).toBe(true); // the list does not scroll by the finger
    expect(r.last()).toEqual({ id: A, gap: 3 });
    const up = lifted(54, 500);
    up.timeStamp = 1234;
    r.lift.up(up);
    expect(up.prevented).toBe(true); // no click after it
    expect(r.swallowed).toEqual([1234]);
    expect(r.moves).toEqual([[A, null]]);
    expect(r.last()).toBeNull();
    expect(r.lift.pressing).toBeNull();
  });

  test("a drop between two others sends the one it goes before", () => {
    const r = rig();
    r.lift.down(C, fingerAt(50, 450));
    r.tick(LIFT_MS);
    r.lift.move(fingerAt(50, 200));
    expect(r.last()).toEqual({ id: C, gap: 1 });
    r.lift.up(lifted(50, 200));
    expect(r.moves).toEqual([[C, B]]);
  });

  test("a move of 8 px before the lift is a scroll: nothing lifts, nothing is held back or sent, the click stays", () => {
    const r = rig();
    r.lift.down(A, fingerAt(50, 150));
    r.tick(100);
    const m = fingerAt(50, 150 + LONG_PRESS_SLOP);
    r.lift.move(m);
    expect(m.prevented).toBe(false);
    expect(r.lift.pressing).toBeNull();
    r.tick(1000);
    const later = fingerAt(50, 400);
    r.lift.move(later);
    expect(later.prevented).toBe(false);
    const up = lifted(50, 400);
    r.lift.up(up);
    expect(up.prevented).toBe(false);
    expect(r.shown).toEqual([]);
    expect(r.moves).toEqual([]);
    expect(r.swallowed).toEqual([]);
  });

  test("a quick tap keeps the heading's link: no lift, the touchend not held back, nothing sent", () => {
    const r = rig();
    r.lift.down(A, fingerAt(50, 150));
    r.tick(120);
    const up = lifted(50, 150);
    r.lift.up(up);
    expect(up.prevented).toBe(false);
    r.tick(1000);
    expect(r.shown).toEqual([]);
    expect(r.moves).toEqual([]);
    expect(r.swallowed).toEqual([]);
  });

  test("lifted and released with no move, or where it already is: it goes back, nothing is sent, no click", () => {
    const r = rig();
    r.lift.down(B, fingerAt(50, 300));
    r.tick(LIFT_MS);
    const up = lifted(50, 300);
    r.lift.up(up);
    expect(up.prevented).toBe(true);
    expect(r.swallowed.length).toBe(1);
    expect(r.moves).toEqual([]);
    expect(r.last()).toBeNull();
    // A move that stays in its own two gaps (above and below it) shows no line and sends nothing.
    r.lift.down(B, fingerAt(50, 300));
    r.tick(LIFT_MS);
    r.lift.move(fingerAt(50, 200));
    expect(r.last()).toEqual({ id: B, gap: null });
    r.lift.move(fingerAt(50, 400));
    expect(r.last()).toEqual({ id: B, gap: null });
    r.lift.up(lifted(50, 400));
    expect(r.moves).toEqual([]);
  });

  test("a second finger ends the press, before or after the lift", () => {
    const r = rig();
    r.lift.down(A, fingerAt(50, 150));
    r.lift.finger(ev([[50, 150], [200, 600]], [[200, 600]]));
    r.tick(LIFT_MS * 2);
    expect(r.shown).toEqual([]);
    expect(r.lift.pressing).toBeNull();

    r.lift.down(A, fingerAt(50, 150));
    r.tick(LIFT_MS);
    r.lift.move(fingerAt(50, 500));
    r.lift.finger(ev([[50, 500], [200, 600]], [[200, 600]]));
    expect(r.last()).toBeNull();
    const after = ev([[50, 520], [200, 600]], [[50, 520]]);
    r.lift.move(after);
    expect(after.prevented).toBe(false);
    r.lift.up(lifted(50, 520));
    expect(r.moves).toEqual([]);
    // A press that starts with two fingers down is no press.
    r.lift.down(A, ev([[50, 150], [200, 600]]));
    expect(r.lift.pressing).toBeNull();
  });

  test("a second finger on the heading itself ends the press too; a new single press starts over", () => {
    const r = rig();
    r.lift.down(A, fingerAt(50, 150));
    r.tick(LIFT_MS);
    r.lift.down(A, ev([[50, 150], [80, 150]], [[80, 150]]));
    expect(r.last()).toBeNull();
    expect(r.lift.pressing).toBeNull();
    r.lift.down(A, fingerAt(50, 150));
    r.tick(200);
    r.lift.down(B, fingerAt(50, 300)); // the first finger's end was missed
    expect(r.lift.pressing).toBe(B);
    r.tick(LIFT_MS - 200);
    expect(r.shown).toEqual([{ id: A, gap: null }, null]);
    r.tick(200);
    expect(r.last()).toEqual({ id: B, gap: null });
  });

  test("when the browser scrolls after all (a touchmove it will not let go), the press ends", () => {
    const r = rig();
    r.lift.down(A, fingerAt(50, 150));
    r.lift.move(ev([[50, 152]], [[50, 152]], false));
    r.tick(LIFT_MS * 2);
    expect(r.shown).toEqual([]);

    r.lift.down(A, fingerAt(50, 150));
    r.tick(LIFT_MS);
    r.lift.move(ev([[50, 500]], [[50, 500]], false));
    expect(r.last()).toBeNull();
    r.lift.up(lifted(50, 500));
    expect(r.moves).toEqual([]);
  });

  test("a touchcancel puts it back and sends nothing", () => {
    const r = rig();
    r.lift.down(A, fingerAt(50, 150));
    r.tick(LIFT_MS);
    r.lift.move(fingerAt(50, 500));
    r.lift.cancel();
    expect(r.last()).toBeNull();
    r.lift.up(lifted(50, 500));
    expect(r.moves).toEqual([]);
    expect(r.swallowed).toEqual([]);
  });

  test("near the list's bottom or top edge it scrolls the list by itself, and the gap follows; a lift alone does not", () => {
    const r = rig();
    // Scrolled down: A and B are above the list's top (100), C's middle is at 150.
    r.box.scrollTop = 300;
    r.lift.down(C, fingerAt(50, 140));
    r.tick(LIFT_MS);
    r.frame();
    expect(r.frames()).toBe(0); // the finger rests near the edge, but nothing moved yet
    expect(r.box.scrollTop).toBe(300);
    r.lift.move(fingerAt(50, 110));
    expect(r.last()).toEqual({ id: C, gap: null });
    expect(r.frames()).toBe(1);
    // The list scrolls up under the still finger, and the gap is read again on each frame: B comes under it.
    for (let i = 0; i < 200 && r.last()?.gap === null; i++) r.frame();
    expect(r.box.scrollTop).toBeLessThan(300);
    expect(r.last()).toEqual({ id: C, gap: 1 });
    // Out of the edge: it stops.
    r.lift.move(fingerAt(50, 400));
    r.frame();
    expect(r.frames()).toBe(0);
    const still = r.box.scrollTop;
    r.frame();
    expect(r.box.scrollTop).toBe(still);
    // The bottom edge scrolls the other way.
    r.lift.move(fingerAt(50, 690));
    r.frame();
    expect(r.box.scrollTop).toBeGreaterThan(still);
    r.lift.up(lifted(50, 690));
    expect(r.frames()).toBe(0);
  });
});

describe("the heading on touch: its wiring and its look", () => {
  const WEB = join(import.meta.dir, "..", "..", "web");
  const menu = readFileSync(join(WEB, "screens", "EnvironmentMenu.tsx"), "utf8");
  const list = readFileSync(join(WEB, "screens", "ChatListBody.tsx"), "utf8");
  const css = readFileSync(join(WEB, "styles", "screens.css"), "utf8");
  const tokens = readFileSync(join(WEB, "styles", "tokens.css"), "utf8");
  const rule = (sel: string) => {
    const at = css.indexOf(`\n${sel} {`);
    expect(at).toBeGreaterThanOrEqual(0);
    return css.slice(at, css.indexOf("}", at));
  };

  test("the touchmove listener is not passive, so a drag can hold the list still; the touchend can stop the click", () => {
    expect(menu).toContain('el.addEventListener("touchmove", move, { passive: false })');
    expect(menu).toContain('el.addEventListener("touchend", up, { passive: false })');
    expect(menu).toContain('el.addEventListener("touchstart", down, { passive: true })');
    // Its buttons and its New chat keep their own press.
    expect(menu).toContain('closest("button, .scr-group-act")');
  });

  test("a long press is the drag's on touch: the heading's right-click menu stays shut during it", () => {
    expect(list).toMatch(/onContextMenu=\{\(e\) => \{\s*e\.preventDefault\(\);\s*if \(drag\.touching\(\)\) return;\s*setMenu\(true\);/);
    expect(list).toContain("ref={head}");
    expect(list).toContain("return el ? touchHead(p.id, el) : undefined;");
  });

  test("no callout and no text selection on the heading; the mouse dims it, a finger lifts it on the raised surface", () => {
    const head = rule(".scr-group-head");
    expect(head).toContain("-webkit-touch-callout: none;");
    expect(head).toContain("-webkit-user-select: none;");
    expect(head).toContain("user-select: none;");
    expect(list).toContain("data-dragging={drag.dragging === p.id ? drag.how : undefined}");
    expect(rule('.scr-group-head[data-dragging="mouse"]')).toContain("opacity: 0.5;");
    // The raised surface is under the heading, a little wider than it, and shows only while a finger lifts it.
    const surface = rule(".scr-group-head::before");
    expect(surface).toContain("background: var(--elevated);");
    expect(surface).toContain("box-shadow: var(--shadow-2);");
    expect(surface).toContain("inset: 0 calc(var(--s1) * -1);");
    expect(surface).toContain("opacity: 0;");
    expect(rule('.scr-group-head[data-dragging="touch"]::before')).toContain("opacity: 1;");
    expect(rule('.scr-group-head[data-dragging="touch"]')).toContain("z-index: 1;");
  });

  test("Reduce motion: the lift has no animation (its transition runs on --t-toggle, which is 0 ms then)", () => {
    const head = rule(".scr-group-head::before");
    expect(head).toMatch(/transition: [^;]*var\(--t-toggle\)/);
    expect(head).not.toMatch(/transition: [^;]*\d+ms/);
    for (const block of [tokens.slice(tokens.indexOf("@media (prefers-reduced-motion: reduce)")), tokens.slice(tokens.indexOf(':root[data-motion="reduce"] {'))]) {
      expect(block.slice(0, block.indexOf("}"))).toContain("--t-toggle: 0ms;");
    }
  });
});
