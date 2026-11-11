// The panes' widths (row 82, W19f): on a laptop and on the tablet sizes the docked sidebar and the docked side pane
// on the right (the cards, the search pane, the uploads and files, the Terminal pane) each have a drag handle on their
// inner edge. A pane is as wide as the user dragged it (this device's own, ViewPrefs.widths), else its default (the
// design's: 248 px, 320 px, the Terminal's clamp, the tablet's 320 px or 40%), within a minimum and a maximum that
// keeps the chat column CHAT_KEEP wide. Plain numbers, so a unit test checks them; Shell.tsx puts the result in one CSS
// variable per pane (--sidebar-w, --side-w, registered as not inherited in layout.css) and in each handle's own place,
// and the handle (ui/PaneHandle.tsx) moves both while it drags.
import type { PaneWidths } from "../state/types";

/** The laptop sidebar's default width (DESIGN.md 6.2); size.ts lays the shell out with it. */
export const SIDEBAR_W = 248;
/**
 * The narrowest sidebar whose content fits in all four looks at the default text size: the filter keeps "Needs input"
 * on one line (236 px on a laptop, 240 px on a large touch tablet) and, on touch, "kitespan" keeps clear of Search
 * beside the 44 px Hide sidebar (220 px). Measured in Chrome (FIX-W19f).
 */
export const SIDEBAR_MIN = 240;
export const SIDEBAR_MAX = 480;
/** The side pane's narrowest and widest (the Terminal pane's widest default, TERM_MAX in size.ts, is the same). */
export const SIDE_MIN = 280;
export const SIDE_MAX = 720;
/** A drag or a key never leaves the chat column narrower than this. */
export const CHAT_KEEP = 420;
/** The arrow keys move a handle by this much. */
export const PANE_STEP = 16;
/** The pane bar's width (tokens.css --pane-bar-w): 48 px, and 56 px on touch. */
export const PANE_BAR_W = 48;
export const PANE_BAR_W_TOUCH = 56;

/** The side pane's two widths: the cards' (and the search pane's, the files') and the Terminal pane's. */
export type RightPane = "side" | "term" | "browser";
/** Iteration 7 (DESIGN-B1 4.1, D-13): the Browser's narrowest drag is its dock minimum, and its widest its rule's cap. */
export const BROWSER_PANE_MIN = 420;
export const BROWSER_PANE_MAX = 960;

/**
 * A handle's range and value, in px: `now` is what the pane shows, `def` what a double-click puts back, and `reach` the
 * widest it could be if the other pane were at its narrowest (where the other pane holds it, min and max can meet).
 */
export interface PaneRange {
  min: number;
  max: number;
  def: number;
  now: number;
  reach: number;
}

export interface PaneInput {
  /** The window's width. */
  width: number;
  touch: boolean;
  /** The sidebar is docked beside the chat (not a drawer, not hidden). */
  sidebar: boolean;
  /** The docked pane on the right, with its default width; null when none docks (none open, or one over the chat). */
  right: { pane: RightPane; def: number } | null;
  /** The pane bar is a column of the grid. */
  bar: boolean;
  widths: PaneWidths;
}

const clamp = (w: number, r: Pick<PaneRange, "min" | "max">) => Math.min(r.max, Math.max(r.min, w));

/** The room the two panes share: the window less the pane bar and the chat column's CHAT_KEEP. */
const roomOf = (i: PaneInput) => i.width - (i.bar ? (i.touch ? PANE_BAR_W_TOUCH : PANE_BAR_W) : 0) - CHAT_KEEP;
/** The side pane's narrowest: SIDE_MIN, or its default where that is narrower (a narrow tablet's 40%). */
const rightMin = (i: PaneInput) => (i.right?.pane === "browser" ? Math.min(BROWSER_PANE_MIN, i.right.def) : Math.min(SIDE_MIN, i.right?.def ?? 0));
/** The side pane's widest: the Browser's own cap, else SIDE_MAX. */
const rightMax = (i: PaneInput) => (i.right?.pane === "browser" ? BROWSER_PANE_MAX : SIDE_MAX);

/**
 * Each docked pane's range and width. With no width chosen, each pane shows at its default (the design's layouts are
 * unchanged). A chosen width gives way where the window has no room for it, the side pane's first, so the chat column
 * keeps CHAT_KEEP; a handle's maximum stops where the chat would get less beside the other pane as it is now.
 */
export function paneRanges(i: PaneInput): { sidebar: PaneRange | null; right: PaneRange | null } {
  const avail = roomOf(i);
  const rDef = i.right?.def ?? 0;
  const rMin = rightMin(i);
  const sbChosen = i.sidebar ? i.widths.sidebar : undefined;
  const rChosen = i.right ? i.widths[i.right.pane] : undefined;
  let sb = i.sidebar ? (sbChosen ?? SIDEBAR_W) : 0;
  let r = i.right ? (rChosen ?? rDef) : 0;
  let over = sb + r - avail;
  if (over > 0 && (sbChosen !== undefined || rChosen !== undefined)) {
    const to = Math.max(rMin, r - over);
    over -= r - to;
    r = to;
    if (over > 0 && sbChosen !== undefined) sb = Math.max(SIDEBAR_MIN, sb - over);
  }
  return {
    sidebar: i.sidebar ? { min: SIDEBAR_MIN, max: Math.max(sb, Math.min(SIDEBAR_MAX, avail - r)), def: SIDEBAR_W, now: sb, reach: Math.max(sb, Math.min(SIDEBAR_MAX, avail - (i.right ? rMin : 0))) } : null,
    right: i.right ? { min: Math.min(rMin, r), max: Math.max(r, Math.min(rightMax(i), avail - sb)), def: rDef, now: r, reach: Math.max(r, Math.min(rightMax(i), avail - (i.sidebar ? SIDEBAR_MIN : 0))) } : null,
  };
}

/**
 * A handle shows wherever its pane could change width in this window: also while the other pane holds it at one width
 * (min and max meet), so the edge keeps its cursor, its keyboard stop and its double-click. A narrow tablet whose pane
 * has no room at all has none.
 */
export const resizable = (r: PaneRange | null): r is PaneRange => !!r && r.reach > r.min;

/**
 * The widths after a double-click on a handle: that pane's chosen width goes, so it shows at its default. Where the
 * side pane's default does not fit beside the sidebar's chosen width, the sidebar gives that room (never under its
 * minimum): a chosen width otherwise gives way the side pane's first (paneRanges), which would leave the side pane as
 * it was. The sidebar's default takes its room from the side pane by that rule already.
 */
export function restoreDefault(i: PaneInput, which: "sidebar" | "right"): PaneWidths {
  const out: PaneWidths = { ...i.widths };
  if (which === "sidebar") {
    delete out.sidebar;
    return out;
  }
  if (!i.right) return out;
  delete out[i.right.pane];
  const fit = Math.max(SIDEBAR_MIN, roomOf(i) - i.right.def);
  if (i.sidebar && out.sidebar !== undefined && out.sidebar > fit) out.sidebar = fit;
  return out;
}

/** The side a pane grows toward: the sidebar to the right, the side pane to the left. */
export type Grow = "right" | "left";

/**
 * A key on a handle (the window splitter pattern): Left and Right move the edge by PANE_STEP, so the arrow toward the
 * pane's growing side widens it; Home gives the pane its smallest width and End its largest. Null for any other key.
 */
export function keyWidth(key: string, r: PaneRange, grow: Grow): number | null {
  const wider = grow === "right" ? "ArrowRight" : "ArrowLeft";
  const narrower = grow === "right" ? "ArrowLeft" : "ArrowRight";
  if (key === wider) return clamp(r.now + PANE_STEP, r);
  if (key === narrower) return clamp(r.now - PANE_STEP, r);
  if (key === "Home") return r.min;
  if (key === "End") return r.max;
  return null;
}

/** The width while a drag is `dx` px from where it started on a pane `start` px wide: whole pixels, within the range. */
export function dragWidth(start: number, dx: number, r: Pick<PaneRange, "min" | "max">, grow: Grow): number {
  return clamp(Math.round(start + (grow === "right" ? dx : -dx)), r);
}

/** The stored widths, read defensively: a number within its pane's bounds, in whole pixels; anything else is left out. */
export function cleanWidths(raw: unknown): PaneWidths {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  const ok = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v) : undefined);
  const out: PaneWidths = {};
  const sidebar = ok(o.sidebar, SIDEBAR_MIN, SIDEBAR_MAX);
  const side = ok(o.side, SIDE_MIN, SIDE_MAX);
  const term = ok(o.term, SIDE_MIN, SIDE_MAX);
  const browser = ok(o.browser, BROWSER_PANE_MIN, BROWSER_PANE_MAX);
  if (sidebar !== undefined) out.sidebar = sidebar;
  if (side !== undefined) out.side = side;
  if (term !== undefined) out.term = term;
  if (browser !== undefined) out.browser = browser;
  return out;
}

/**
 * U4: the split side panel's stored divider place (ViewPrefs.split, layout/split.ts), read defensively: the upper half's
 * share of the column's height, a finite number from 0 to 1; anything else is none (equal halves).
 */
export function cleanSplit(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : undefined;
}
