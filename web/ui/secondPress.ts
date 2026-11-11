// A double press is one press, on every confirm whose press sends one request and closes it (or changes what it
// shows) on the answer: a background session's Stop (R131) first, then Trust this folder, the dialogs that close on
// the ok ack (useAckClose), Archive and Delete, which leave the chat at once, Restart's three buttons and Update. A
// quick answer can come between a double tap's two taps (Claude Code stops a background session in about 200 ms), and
// the second tap would then act on what came under the finger: Open in terminal under the closed Stop sheet, Cancel
// restart where Restart when they finish was.
import { lastPressed } from "./primitives";

/** How soon after the press a double press's second one starts (a double tap's or a double click's; Windows' default). */
export const SECOND_PRESS_MS = 500;

/** How far outside the pressed control a second press still lands on it (a finger's slip). */
const SLOP_PX = 8;

export type PressBox = Pick<DOMRect, "left" | "top" | "right" | "bottom">;

/** The box of the control that the press being handled went down on; null for a key's press. */
export function pressedBox(): PressBox | null {
  return lastPressed()?.getBoundingClientRect() ?? null;
}

/**
 * Swallow the click of a press that starts within SECOND_PRESS_MS of the one that sent, on the control that one
 * pressed (`box`), before any handler: a capture listener on window runs first, and preventDefault keeps a link from
 * following its href. On the waiting button it would do nothing, but once a quick answer closed the confirm or changed
 * it, it would act on what is under the pointer now. A press elsewhere or later, a press that became a scroll, or a
 * second press whose click does not come ends the wait. A key's press has no second press: with no box nothing waits,
 * and a key's click has no press, so it acts.
 */
export function swallowSecondPress(target: Pick<Window, "addEventListener" | "removeEventListener"> = window, pressedAt = performance.now(), box: PressBox | null = pressedBox()) {
  if (!box) return;
  let armed = false;
  const on = (e: Event) => {
    const { clientX: x, clientY: y } = e as PointerEvent;
    return x >= box.left - SLOP_PX && x <= box.right + SLOP_PX && y >= box.top - SLOP_PX && y <= box.bottom + SLOP_PX;
  };
  const down = (e: Event) => {
    if (armed || e.timeStamp - pressedAt >= SECOND_PRESS_MS || !on(e)) done();
    else armed = true;
  };
  const click = (e: Event) => {
    if (!armed) return;
    e.preventDefault();
    e.stopPropagation();
    done();
  };
  const timer = setTimeout(done, 2 * SECOND_PRESS_MS);
  function done() {
    clearTimeout(timer);
    target.removeEventListener("pointerdown", down, true);
    target.removeEventListener("pointercancel", done, true);
    target.removeEventListener("click", click, true);
  }
  target.addEventListener("pointerdown", down, true);
  target.addEventListener("pointercancel", done, true);
  target.addEventListener("click", click, true);
}
