// U2 (DESIGN-U2 10): the reader's place in the conversation, kept by the page itself. While the view does not follow
// the end, the first row whose bottom is below the scroller's top stays at its distance from that top when the
// column changes above it: a turn's line that comes, a turn that folds, a view switch. When that row folds away, its
// turn's line takes its place; when a view does not draw it (a summary in Verbose, a call inside a summary in Normal,
// thinking in Normal), its stand-in does (the summary's first call, the summary that holds the call), else the next
// row that the view draws. The browser's own scroll anchoring is off on the scroller (chat.css): Safari before 27 has
// none, and two anchorings would move the view twice. A row is found again by its id, so a row drawn again (moved
// into a turn's work) is still the same row.

/** One row of the anchor: how to find it again (an attribute and its value) and its top's distance from the
 * scroller's top (px). */
export interface AnchorRow {
  attr: "data-item-id" | "data-turn-id" | "data-testid";
  id: string;
  top: number;
}

/** The reader's row, then the next rows after it: the first one that the column still draws is kept in place. */
export type Anchor = AnchorRow[];

/** The parts of an element that the anchor reads (a DOM element has them; a test passes a stand-in). */
export interface AnchorEl {
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { top: number; bottom: number };
  readonly children: ArrayLike<AnchorEl>;
  readonly nextElementSibling: AnchorEl | null;
  matches(selector: string): boolean;
  closest(selector: string): AnchorEl | null;
}

export interface AnchorRoot extends AnchorEl {
  querySelector(selector: string): AnchorEl | null;
}

const ATTRS = ["data-item-id", "data-turn-id", "data-testid"] as const;
/** How many rows the anchor keeps: the reader's and the next ones. */
const KEEP = 4;

function rowOf(el: AnchorEl, top: number): AnchorRow | null {
  for (const attr of ATTRS) {
    const id = el.getAttribute(attr);
    if (id) return { attr, id, top: el.getBoundingClientRect().top - top };
  }
  return null;
}

/** The first of `list` whose bottom is below `top` (they are in the column's order, top to bottom), by halves. */
function firstBelow(list: ArrayLike<AnchorEl>, top: number): AnchorEl | null {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.getBoundingClientRect().bottom > top) hi = mid;
    else lo = mid + 1;
  }
  return lo < list.length ? list[lo]! : null;
}

/** The open work container of a turn's line element, if it has one that shows. */
function openWork(el: AnchorEl): AnchorEl | null {
  for (const c of Array.from(el.children)) if (c.matches(".chat-turn-work:not([hidden])")) return c;
  return null;
}

/**
 * The reader's anchor in `col` under a scroller whose top is at `top`: the first row of the column whose bottom is
 * below it, then the rows after it. Inside an open turn the anchor is the row of its work there, not the turn's line.
 */
export function readAnchor(col: AnchorEl, top: number): Anchor | null {
  let el = firstBelow(col.children, top);
  for (let depth = 0; el && depth < 3; depth++) {
    const inner = el.matches(".chat-turn") ? openWork(el) : el.matches(".chat-turn-work") ? el : null;
    if (!inner) break;
    // The line itself, while it is still on screen above its work.
    if (el.matches(".chat-turn") && el.getBoundingClientRect().top + 1 >= top) break;
    const row = firstBelow(inner.children, top);
    if (!row) break;
    el = row;
  }
  const out: Anchor = [];
  for (let at = el; at && out.length < KEEP; at = at.nextElementSibling) {
    const row = rowOf(at, top);
    if (row) out.push(row);
  }
  return out.length ? out : null;
}

/** The element that stands for an anchor's row now: the row, its stand-in in this view, or its folded turn's line. */
export function anchorElement(col: Pick<AnchorRoot, "querySelector">, a: AnchorRow): AnchorEl | null {
  const q = (attr: string, v: string, op = "=") => col.querySelector(`[${attr}${op}"${cssString(v)}"]`);
  let el = q(a.attr, a.id);
  // A summary (Normal, Thinking) is its calls in Verbose; a call is its summary where calls fold.
  if (!el && a.attr === "data-testid" && a.id.startsWith("summary-")) el = q("data-item-id", a.id.slice("summary-".length));
  if (!el && a.attr === "data-item-id") el = q("data-rows", a.id, "~=");
  if (!el) return null;
  const folded = el.closest(".chat-turn-work[hidden]");
  if (!folded) return el;
  const turn = folded.getAttribute("data-turn-work");
  return turn ? q("data-turn-id", turn) : null;
}

/** The first of the anchor's rows that the column draws now, and how far the scroller must move to put it back. */
export function anchorShift(col: Pick<AnchorRoot, "querySelector">, a: Anchor, top: number): number {
  for (const row of a) {
    const el = anchorElement(col, row);
    if (!el) continue;
    const d = el.getBoundingClientRect().top - top - row.top;
    return Math.abs(d) < 0.5 ? 0 : d;
  }
  return 0;
}

/** A value for a CSS attribute selector in double quotes. */
function cssString(s: string): string {
  return s.replace(/["\\]/g, (c) => `\\${c}`);
}
