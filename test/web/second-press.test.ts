// A double press is one press (web/ui/secondPress): the guard's place. A double tap's or a double click's second press
// lands on the control that the first one pressed; a press elsewhere is the user's next act, even a quick one (the
// restart dialog's Restart now, beside Restart when they finish), and a key's press has no second press. Each confirm
// family's own press: the background, trust, dialogs, restart and update tests. No browser.
import { describe, expect, test } from "bun:test";
import { SECOND_PRESS_MS, pressedBox, swallowSecondPress } from "../../web/ui/secondPress";
import { lastPressed, notePressed } from "../../web/ui/primitives";
import { BUTTON, acted, pressDown, tap } from "./presses";

describe("the second press's place (ui/secondPress)", () => {
  test("on the pressed control, anywhere on it or a finger's slip outside it: swallowed; then the next press acts", () => {
    for (const [x, y] of [
      [195, 798],
      [20, 780],
      [370, 818],
      [6, 826],
    ]) {
      const win = new EventTarget();
      swallowSecondPress(win, 1000, BUTTON);
      expect([x, y, acted(tap(win, 1080, x, y))]).toEqual([x, y, false]);
      expect(acted(tap(win, 1200, x, y))).toBe(true);
    }
  });

  test("a press elsewhere acts, even within the double press's time, and ends the wait", () => {
    const win = new EventTarget();
    swallowSecondPress(win, 1000, BUTTON);
    expect(acted(tap(win, 1080, 195, 860))).toBe(true); // the control under it
    expect(acted(tap(win, 1200, 195, 798))).toBe(true); // a press after that one is a press of its own
  });

  test("a key's press (no pointer went down on the control) has no second press: a quick press anywhere acts", () => {
    const win = new EventTarget();
    swallowSecondPress(win, 1000, null);
    expect(acted(tap(win, 1080, 195, 798))).toBe(true);
    expect(acted(tap(win, 1000 + SECOND_PRESS_MS + 50, 195, 798))).toBe(true);
  });

  test("the box is the control that the pointer pressed last, while that press is recent and the control is still there", () => {
    expect(pressedBox()).toBeNull();
    pressDown(BUTTON);
    expect(pressedBox()).toEqual(BUTTON);
    // A control that went (a menu's row that closed the menu): no box, so nothing waits after its press.
    notePressed({ isConnected: false, getBoundingClientRect: () => BUTTON } as unknown as HTMLElement);
    expect(lastPressed()).toBeNull();
    expect(pressedBox()).toBeNull();
    pressDown(null);
    expect(pressedBox()).toBeNull();
  });
});
