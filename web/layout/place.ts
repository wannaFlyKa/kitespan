// Two places of iteration 8 (touch; DESIGN-T1 2.6 and 2.7), as plain numbers so a unit test checks them; Shell.tsx
// applies them.
//   The large tablet (the laptop class with touch, 1024x1366): a pane over the chat (Details, search, the side chat,
//     changes, the Browser, the Terminal) ends 8 px above the composer's dock at rest (T-15, owner question Q8), so the
//     composer and Send are never under it, also with a hardware keyboard, which never raises the on-screen keyboard
//     that D44's rule waits for. The inset is the dock's rest height, never its live height: a taller composer (more
//     lines, a chip row, a held line, a row of keys, a card in its place) draws over the pane's foot, so the pane, and
//     the Terminal's rows in it, never change height while the user types. While the pane rides the on-screen keyboard
//     the inset is 0.
//   Medium touch (626 and 768 px): where the docked pane would be under 320 px, a changes view opens over the chat at
//     the whole width beside the pane bar (T-17, owner question Q1's default); at 834 px it docks at 320 px.
import { PANEL_W, type SizeClass, type Viewport } from "./size";
import { sideWidth } from "./split";

/** The gap between a pane over the chat and the composer's dock under it. */
export const OVER_GAP = 8;

/** The dock's rest height at a window width: from the dock's top to the shell's foot, in px. */
export interface RestMark {
  width: number;
  height: number;
}

/**
 * The next rest mark: the least height seen at this width, so a taller dock never raises it (the pane keeps its height
 * while the box grows) and a new width starts again (a turned tablet). A height that is not a positive number (a dock
 * that is not laid out) changes nothing.
 */
export function nextRestMark(mark: RestMark | null, width: number, height: number): RestMark | null {
  const same = mark && mark.width === width ? mark : null;
  if (!(height > 0)) return same;
  return same && same.height <= height ? same : { width, height: Math.round(height) };
}

/**
 * Where a pane over the chat ends, in px above the shell's foot: on touch in the laptop class, the dock's rest height
 * and the gap; 0 elsewhere, before the dock is measured, and while the pane rides the on-screen keyboard.
 */
export function overPaneBottom(o: { size: SizeClass; touch: boolean; rest: number | null; riding: boolean }): number {
  if (o.size !== "laptop" || !o.touch || o.riding || o.rest === null || !(o.rest > 0)) return 0;
  return Math.round(o.rest) + OVER_GAP;
}

/**
 * Where a changes view opens: over the chat on medium touch where its docked pane would be under 320 px (DESIGN 7.3's
 * floor), else in the side panel's place.
 */
export function changesPlace(vp: Pick<Viewport, "size" | "width">): "over" | "docked" {
  return vp.size === "medium" && sideWidth(vp, {}, false, true) < PANEL_W ? "over" : "docked";
}
