// More > Select text on touch (DESIGN-T1 2.8, T-13): while it is on, a one-finger drag in the frame selects the page's
// text, as a mouse would (the left button's press where the drag began, its moves, its release), instead of scrolling
// the page; and the touch foot shows Copy, which writes the selection that the server sent after the release (copy.ts,
// D-15), as Cmd+C or Ctrl+C in the frame does. A tap and a long press stay what they are. One switch for the page:
// More sets it, the frame and the foot read it, and it goes off when the pane closes (the foot unmounts). It and Move
// take turns: one on turns the other off.
import { useSyncExternalStore } from "react";
import type { InputFrame } from "../net/browserSocket";
import { writeClipboard } from "../ui/Copy";
import { COPY_LINES } from "./copy";
import { addNote, copyHold } from "./store";

let on = false;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export function selectingText(): boolean {
  return on;
}

export function setSelectingText(next: boolean): void {
  if (on === next) return;
  on = next;
  for (const fn of listeners) fn();
}

export function useSelectingText(): boolean {
  return useSyncExternalStore(subscribe, selectingText, selectingText);
}

export interface PagePoint {
  x: number;
  y: number;
}

/**
 * The frames of a finger's drag while Select text is on, in page coordinates: on a move, the press where the drag
 * began (once, `pressed` false) and the move; at its end, the release, with `sq` so that the server sends the page's
 * selection after it (copy.ts asksSelection). A drag that never pressed sends nothing at its end.
 */
export function textDragFrames(phase: "move" | "end", pressed: boolean, from: PagePoint, at: PagePoint, tab: string, n: number, sq: () => number): InputFrame[] {
  if (phase === "end") return pressed ? [{ t: "mouse", tab, n, type: "mouseReleased", x: at.x, y: at.y, button: "left", clicks: 1, sq: sq() }] : [];
  const move: InputFrame = { t: "mouse", tab, n, type: "mouseMoved", x: at.x, y: at.y, button: "left" };
  return pressed ? [move] : [{ t: "mouse", tab, n, type: "mousePressed", x: from.x, y: from.y, button: "left", clicks: 1 }, move];
}

/**
 * Copy the page's selection that the server sent, inside the press (DESIGN 7.10 rule 2): "copied", "none" when nothing
 * is selected, or "failed", when the stage's line says "Copy failed" with the held text to copy by hand (rule 4): the
 * write was refused, or an input still waits for its answer, so the held text may be about to change.
 */
export function copyPageSelection(tab: string): Promise<"copied" | "none" | "failed"> {
  const c = copyHold(tab).copy();
  const failed = () => {
    addNote(tab, COPY_LINES.failed, 6_000, "copy", c.text);
    return "failed" as const;
  };
  if (c.pending) return Promise.resolve(failed());
  if (!c.text) return Promise.resolve("none");
  return writeClipboard(c.text).then((ok) => (ok ? "copied" : failed()));
}
