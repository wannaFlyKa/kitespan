// Following the end of the chat (DESIGN.md 6.2; row 79). The view keeps the end in view while the reader is at it,
// and stops at once when the reader moves toward the start: a wheel or trackpad step up, a finger that drags the
// column down, a key that scrolls up, or a drag on the scrollbar that moves up. A reveal grows the column on every
// frame, so waiting until the reader is NEAR_BOTTOM px from the end would pull a small step (a finger's drag moves
// less than that in a frame) back to the end each time. Only a move back near the end starts following again. A move
// that the view made itself (its own scroll to the end, which the browser reports a frame later) or that the layout
// made (the column got shorter at its end) never counts as the reader's.

/** px: the view starts to follow the end again when the reader scrolls back this close to it (6.2). */
export const NEAR_BOTTOM = 90;

export interface Follow {
  /** The view follows the end. */
  stick: boolean;
  /** Where the view last scrolled itself to the end (null once the reader scrolled). */
  autoTop: number | null;
  /** The scroll position at the last scroll event (or the view's own last scroll). */
  lastTop: number;
  /** A pointer is down on the scroller itself (its scrollbar). */
  dragging: boolean;
  /** The finger's last height on the screen in a touch drag. */
  touchY: number | null;
}

export function newFollow(): Follow {
  return { stick: true, autoTop: null, lastTop: 0, dragging: false, touchY: null };
}

/** The view scrolled itself to the end, to `top`. */
export function followedTo(f: Follow, top: number): void {
  f.autoTop = top;
  f.lastTop = top;
}

/** The reader moved toward the start: the view stops following now. */
export function leave(f: Follow): void {
  f.stick = false;
  f.autoTop = null;
}

// Each move below names the scroll position: at the top (or with nothing to scroll) a move up moves nothing, and the
// view keeps following.

/** A wheel or trackpad step (deltaY below 0: toward the start). */
export function onWheel(f: Follow, deltaY: number, top: number): void {
  if (deltaY < 0 && top > 0) leave(f);
}

export function onTouchStart(f: Follow, y: number): void {
  f.touchY = y;
}

/** A finger that moves down the screen drags the column toward its start. */
export function onTouchMove(f: Follow, y: number, top: number): void {
  if (f.touchY !== null && y > f.touchY + 0.5 && top > 0) leave(f);
  f.touchY = y;
}

export function onTouchEnd(f: Follow): void {
  f.touchY = null;
}

const UP_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);

/** A key in the column: one that scrolls toward the start. */
export function onKey(f: Follow, key: string, shift: boolean, top: number): void {
  if ((UP_KEYS.has(key) || (key === " " && shift)) && top > 0) leave(f);
}

/** A scroll event at `top`, `gap` px from the end. Returns whether the view follows the end now. */
export function onScrolled(f: Follow, top: number, gap: number): boolean {
  const own = f.autoTop !== null && Math.abs(top - f.autoTop) < 2;
  const up = top < f.lastTop - 1;
  f.lastTop = top;
  if (own) {
    f.stick = true;
    return true;
  }
  f.autoTop = null;
  if (up && f.dragging) f.stick = false;
  else if (gap >= NEAR_BOTTOM) f.stick = false;
  else if (!up) f.stick = true;
  return f.stick;
}
