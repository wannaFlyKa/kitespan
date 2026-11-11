// The Terminal's key bar on touch (DESIGN.md 7.7: a control for every key; DESIGN-T1 2.8, T-12): one row of 44 px keys.
// Esc, Tab, Ctrl, Select, the four signs and the arrows scroll sideways, and the part that scrolls fades at its end
// while more keys lie past it; Copy and Paste are pinned at the row's end, so a terminal's copy and paste is always in
// view. Select is a toggle, as Ctrl is: while it is on, a finger's drag on the terminal selects its text (xterm's own
// selection) instead of scrolling it. Copy writes that selection exactly; Paste reads the clipboard inside the tap and
// goes in as a paste. This file holds the bar's plain parts: TerminalPane.tsx draws the bar, xterm.ts does the drag.

const ESC = "\x1b";

export interface BarKey {
  /** The key's word, or the name a screen reader says for a sign or an arrow. */
  name: string;
  /** What the key sends to the shell; none for Ctrl, Select, Copy and Paste, which act in the pane. */
  data?: string;
  /** A sign, drawn in mono in place of the name. */
  sign?: string;
  /** An arrow's path, drawn in place of the name. */
  path?: string;
  /** Ctrl and Select: on or off (aria-pressed). */
  toggle?: true;
}

export const SCROLL_KEYS: readonly BarKey[] = [
  { name: "Esc", data: ESC },
  { name: "Tab", data: "\t" },
  { name: "Ctrl", toggle: true },
  { name: "Select", toggle: true },
  { name: "Vertical bar", data: "|", sign: "|" },
  { name: "Tilde", data: "~", sign: "~" },
  { name: "Slash", data: "/", sign: "/" },
  { name: "Hyphen", data: "-", sign: "-" },
];
/** The four arrows, one group at the scrolling part's end. */
export const ARROW_KEYS: readonly BarKey[] = [
  { name: "Left", data: `${ESC}[D`, path: "M12.5 8h-9M7 4.5 3.5 8 7 11.5" },
  { name: "Up", data: `${ESC}[A`, path: "M8 12.5v-9M4.5 7 8 3.5 11.5 7" },
  { name: "Down", data: `${ESC}[B`, path: "M8 3.5v9M4.5 9 8 12.5 11.5 9" },
  { name: "Right", data: `${ESC}[C`, path: "M3.5 8h9M9 4.5 12.5 8 9 11.5" },
];
/** Pinned at the row's end, after a hairline, outside the part that scrolls. */
export const PINNED_KEYS: readonly BarKey[] = [{ name: "Copy" }, { name: "Paste" }];

/** The pane's line when the clipboard refused Paste (or the browser has no clipboard read). */
export const PASTE_FAILED = "Paste failed. Use the system's Paste on the terminal.";

/** Select after a tap on it (on, off) or when the pane closes (off). */
export function selectAfter(on: boolean, event: "tap" | "close"): boolean {
  return event === "tap" ? !on : false;
}

export interface Cell {
  col: number;
  row: number;
}

/** The cell under a point in the terminal's screen of `cols` x `rows` cells, clamped to the screen. */
export function cellAt(box: { left: number; top: number; width: number; height: number }, cols: number, rows: number, x: number, y: number): Cell {
  if (box.width <= 0 || box.height <= 0 || cols < 1 || rows < 1) return { col: 0, row: 0 };
  const clamp = (v: number, n: number) => Math.max(0, Math.min(n - 1, Math.floor(v)));
  return { col: clamp(((x - box.left) / box.width) * cols, cols), row: clamp(((y - box.top) / box.height) * rows, rows) };
}

/**
 * xterm's select(column, row, length) for a drag from the cell `a` to the cell `b`, either way, both included. `line`
 * is the buffer's line (the screen's first line plus the row), so a drag keeps its start while the screen scrolls.
 */
export function dragSpan(a: { col: number; line: number }, b: { col: number; line: number }, cols: number): { column: number; row: number; length: number } {
  const [from, to] = b.line < a.line || (b.line === a.line && b.col < a.col) ? [b, a] : [a, b];
  return { column: from.col, row: from.line, length: (to.line - from.line) * cols + (to.col - from.col) + 1 };
}

/** More keys lie past the scrolling part's end (its fade, data-more). */
export function moreKeys(scrollLeft: number, clientWidth: number, scrollWidth: number): boolean {
  return scrollLeft + clientWidth < scrollWidth - 1;
}
