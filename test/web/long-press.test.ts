// DESIGN-T1 2.1: the long press's timing (PressTimer, the core of useLongPress) with a clock of the test's own, and
// T-27's guards: a popup that a long press opened ignores the click that ends the press, and a scrim closes only on a
// click whose press began on it.
import { describe, expect, test } from "bun:test";
import { LONG_PRESS_MS, LONG_PRESS_SLOP, PRESS_WASH_MS, PressTimer, SCROLL_QUIET_MS, lastScrollAt, notePointerDown, noteScroll, ownScroll, popupTakesClick, pressBeganOn, type PressClock } from "../../web/ui/primitives";

function rig(ms = LONG_PRESS_MS) {
  let now = 1000;
  const timers: { at: number; run: () => void; live: boolean }[] = [];
  const clock: PressClock = {
    now: () => now,
    later: (run, wait) => {
      const t = { at: now + wait, run, live: true };
      timers.push(t);
      return () => (t.live = false);
    },
  };
  const said: string[] = [];
  const timer = new PressTimer(clock, { fire: () => said.push("fire"), wash: (on) => said.push(on ? "wash" : "unwash") }, ms);
  const tick = (wait: number) => {
    now += wait;
    for (const t of timers)
      if (t.live && t.at <= now) {
        t.live = false;
        t.run();
      }
  };
  return { timer, tick, said, now: () => now };
}

describe("the long press", () => {
  test("a still press fires at 500 ms, with the wash from 150 ms; its end takes the wash away", () => {
    const r = rig();
    expect(r.timer.down(10, 10, null)).toBe(true);
    r.tick(PRESS_WASH_MS - 1);
    expect(r.said).toEqual([]);
    r.tick(1);
    expect(r.said).toEqual(["wash"]);
    r.tick(LONG_PRESS_MS - PRESS_WASH_MS - 1);
    expect(r.said).toEqual(["wash"]);
    expect(r.timer.waiting).toBe(true);
    r.tick(1);
    expect(r.said).toEqual(["wash", "fire"]);
    expect(r.timer.fired).toBe(true);
    r.timer.end();
    expect(r.said).toEqual(["wash", "fire", "unwash"]);
    // fired stays until the next press, so the click that ends this one is swallowed
    expect(r.timer.fired).toBe(true);
    r.timer.down(0, 0, null);
    expect(r.timer.fired).toBe(false);
  });

  test("a scroll after the press cancels it; a scroll in the first 150 ms shows nothing", () => {
    const r = rig();
    r.timer.down(10, 10, null);
    r.tick(100);
    r.timer.scroll();
    r.tick(1000);
    expect(r.said).toEqual([]);
    r.timer.down(10, 10, null);
    r.tick(300);
    r.timer.scroll();
    r.tick(1000);
    expect(r.said).toEqual(["wash", "unwash"]);
  });

  test("a press 100 ms after its scroller scrolled never arms; one 400 ms after arms", () => {
    const r = rig();
    const scrolled = r.now();
    r.tick(100);
    expect(r.timer.down(10, 10, scrolled)).toBe(false);
    r.tick(2000);
    expect(r.said).toEqual([]);
    const again = r.now();
    r.tick(SCROLL_QUIET_MS + 100);
    expect(r.timer.down(10, 10, again)).toBe(true);
    r.tick(LONG_PRESS_MS);
    expect(r.said).toEqual(["wash", "fire"]);
  });

  test("a move under the slop is jitter; a move of the slop cancels", () => {
    const r = rig();
    r.timer.down(10, 10, null);
    r.timer.move(10 + LONG_PRESS_SLOP - 1, 10);
    r.tick(LONG_PRESS_MS);
    expect(r.said).toEqual(["wash", "fire"]);
    const s = rig();
    s.timer.down(10, 10, null);
    s.timer.move(10, 10 + LONG_PRESS_SLOP);
    s.tick(LONG_PRESS_MS);
    expect(s.said).toEqual([]);
  });
});

describe("the page's own scrolls (the transcript following the end)", () => {
  test("a scroll the page made itself is no person's: it ends no press and keeps a new one from nothing", () => {
    const scroller = { scrollTop: 0 } as unknown as EventTarget & { scrollTop: number };
    expect(noteScroll(scroller, 5000)).toBe(true);
    expect(lastScrollAt()).toBe(5000);
    // The view follows the end: it sets the place, and its scroll event comes a frame later at that place.
    scroller.scrollTop = 1800;
    ownScroll(scroller);
    expect(noteScroll(scroller, 6000)).toBe(false);
    expect(lastScrollAt()).toBe(5000);
    // While the reply streams it follows again and again; none of those counts either.
    scroller.scrollTop = 1840;
    ownScroll(scroller);
    expect(noteScroll(scroller, 6100)).toBe(false);
    // A finger's scroll from there counts, and so does the next one.
    scroller.scrollTop = 1600;
    expect(noteScroll(scroller, 6200)).toBe(true);
    expect(lastScrollAt()).toBe(6200);
    scroller.scrollTop = 1600;
    expect(noteScroll(scroller, 6300)).toBe(true);
  });
});

describe("the click after the hold (T-27)", () => {
  test("a popup that a long press opened takes a pointer's click only after a pointer went down inside it", () => {
    const armed = { armed: true, openedAt: 500 };
    expect(popupTakesClick(armed, true, null)).toBe(false); // the lifting finger's click
    expect(popupTakesClick(armed, true, 400)).toBe(false); // a press inside from before it opened
    expect(popupTakesClick(armed, true, 600)).toBe(true); // a new tap on a row
    expect(popupTakesClick(armed, false, null)).toBe(true); // a key's click (Enter on a row)
    expect(popupTakesClick({ armed: false, openedAt: 500 }, true, null)).toBe(true); // opened by a tap: as before
  });

  test("a scrim closes only on a click whose press began on it", () => {
    const scrim = new EventTarget();
    const row = new EventTarget();
    notePointerDown(row);
    expect(pressBeganOn(scrim)).toBe(false);
    notePointerDown(scrim);
    expect(pressBeganOn(scrim)).toBe(true);
    // one press, one click
    expect(pressBeganOn(scrim)).toBe(false);
  });
});
