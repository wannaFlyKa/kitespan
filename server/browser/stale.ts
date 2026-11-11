// Input against a stale frame (DESIGN-B1 2.14, F9; a lead default, proposal, not probed). Each input frame names `n`,
// the newest frame that its viewer drew. The server keeps, per viewer, the navigation count, the scroll offsets and the
// time of its last 64 frames, and refuses a press (mousePressed, touchStart) when:
// 1. frame n's navigation count is lower than the tab's now (the page navigated since the frame that the user saw),
//    or n is not among the 64 and the tab navigated in the last 5 s; or
// 2. a newer frame than n was already sent to this viewer, its main-frame scroll offsets differ from n's, and n is more
//    than 1 s older than it (the page scrolled under the user).
// Moves, wheels, keys and text are never refused. The scroll test sees the main document's scroll only.

export const STALE_LIMITS = { frames: 64, navigatedMs: 5_000, scrolledMs: 1_000 } as const;

export interface FrameMark {
  n: number;
  nav: number;
  sx: number;
  sy: number;
  at: number;
}

export function stalePress(frames: ReadonlyMap<number, FrameMark>, latest: FrameMark | null, n: number, tab: { nav: number; navAt: number }, now: number): boolean {
  const seen = frames.get(n);
  if (!seen) return tab.navAt > 0 && now - tab.navAt < STALE_LIMITS.navigatedMs;
  if (seen.nav < tab.nav) return true;
  if (latest && latest.n > n && (latest.sx !== seen.sx || latest.sy !== seen.sy) && latest.at - seen.at > STALE_LIMITS.scrolledMs) return true;
  return false;
}

/** Keep a frame's mark among the last 64. */
export function keepMark(frames: Map<number, FrameMark>, mark: FrameMark): void {
  frames.set(mark.n, mark);
  while (frames.size > STALE_LIMITS.frames) frames.delete(frames.keys().next().value!);
}
