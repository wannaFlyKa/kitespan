// The layout height's high-water mark H (DESIGN.md 7.8): the largest innerHeight seen since innerWidth last changed.
// One mark for every reader: the size class (size.ts) and every read of the on-screen keyboard (composer/keyboard.ts).
// main.tsx seeds it before the first render and on every resize, so a part that mounts while the keyboard is up (a
// sheet, the side chat, a card) reads the full height, not the height that the keyboard left. Chrome on Android
// honours interactive-widget=resizes-content (index.html), so there the layout shrinks with the keyboard, and only
// the mark tells the keyboard from a short window; iOS keeps innerHeight, so the mark costs nothing there.

export interface HeightMark {
  width: number;
  height: number;
}

export function nextHeightMark(mark: HeightMark | null, width: number, height: number): HeightMark {
  if (!mark || mark.width !== width) return { width, height };
  return height > mark.height ? { width, height } : mark;
}

let mark: HeightMark | null = null;

/** The mark after a sample of the window at this width and height (the window's own now, by default). */
export function sampleHeightMark(width: number = window.innerWidth, height: number = window.innerHeight): HeightMark {
  mark = nextHeightMark(mark, width, height);
  return mark;
}

/** The mark's height now: H. */
export function heightMark(): number {
  return sampleHeightMark().height;
}

let seeded = false;

/** The first sample, before the first render, and one on every resize (main.tsx; once a page). */
export function seedHeightMark(): void {
  sampleHeightMark();
  if (seeded) return;
  seeded = true;
  window.addEventListener("resize", () => void sampleHeightMark());
}
