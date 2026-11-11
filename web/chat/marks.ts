// U5 (DESIGN-U5 9): the query's words marked in the row that a Messages pick lands on, as Find marks them. The words
// are found in each of the row's own text nodes with shared/words.ts (the server's rules, so the page marks what the
// server found), never across two nodes (a word split by markup inside it is not marked; the row's wash still shows),
// and never in the row's buttons, its foot or its hidden text. The marks are ranges of the CSS Custom Highlight API
// under one name, drawn by chat.css's ::highlight(kitespan-match); a page without the API marks nothing and keeps the
// row's own wash and focus.

import { markRanges, wordQuery } from "../../shared/words";

/** The highlight's name (chat.css draws it). */
export const MARK_HIGHLIGHT = "kitespan-match";

/** What in a row is not its content: its buttons, its foot, its hidden text, a code block's head and a link's target. */
export const MARK_SKIP = 'button, [aria-hidden="true"], .visually-hidden, .chat-foot, .chat-user-foot, .chat-md-code-head, .chat-md-href';

export interface MarkSpan {
  /** The index of the text (the text node) in the list. */
  node: number;
  start: number;
  end: number;
}

/** The marks of the query `q` in each text, in order: every match of each of its words, inside one text each. */
export function markSpans(texts: readonly string[], q: string): MarkSpan[] {
  const query = wordQuery(q);
  if (!query.words.length) return [];
  const out: MarkSpan[] = [];
  texts.forEach((t, node) => {
    for (const [start, end] of markRanges(t, query)) out.push({ node, start, end });
  });
  return out;
}

/** The browser has the CSS Custom Highlight API. */
export function canMark(): boolean {
  return typeof CSS !== "undefined" && typeof (CSS as { highlights?: unknown }).highlights === "object" && typeof (globalThis as { Highlight?: unknown }).Highlight === "function";
}

/** The row's content text nodes, in order (not its buttons, foot or hidden text). */
function rowTexts(row: Element): Text[] {
  const out: Text[] = [];
  const walk = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const skip = n.parentElement?.closest(MARK_SKIP);
    if (skip && row.contains(skip)) continue;
    if ((n as Text).data.trim()) out.push(n as Text);
  }
  return out;
}

/** The DOM ranges of the query's words in the row. */
export function markRow(row: Element, q: string): Range[] {
  const nodes = rowTexts(row);
  return markSpans(
    nodes.map((n) => n.data),
    q,
  ).map((s) => {
    const r = document.createRange();
    r.setStart(nodes[s.node]!, s.start);
    r.setEnd(nodes[s.node]!, s.end);
    return r;
  });
}

/** Draw the marks (the one highlight holds them all); false without the API. */
export function showMarks(ranges: readonly Range[]): boolean {
  if (!canMark()) return false;
  if (ranges.length) CSS.highlights.set(MARK_HIGHLIGHT, new Highlight(...ranges));
  else CSS.highlights.delete(MARK_HIGHLIGHT);
  return true;
}

/** Take the marks away (the route left the row). */
export function clearMarks(): void {
  if (canMark()) CSS.highlights.delete(MARK_HIGHLIGHT);
}

/** The scroll that puts a mark's box in the middle of the scroller's box (both in viewport px). */
export function centreDelta(scroller: { top: number; height: number }, mark: { top: number; height: number }): number {
  return mark.top - scroller.top - Math.max(0, (scroller.height - mark.height) / 2);
}
