// U5 (DESIGN-U5 9): a /m/ link to a message that is older than the pages the chat has loaded (attach brings the newest
// 252 KiB of events; a Messages pick names any message). The chat reads its older pages one after another, as the
// store's loadOlder reads one, until the row is there or no page is left, at most 40 pages (about 10 MiB of events),
// and says "Loading earlier messages…" meanwhile, Desktop's own words; 5.4's "That message is not in this chat." only
// after. Pure: ChatView keeps the count and calls the store.

/** Desktop's words while a link waits for an older page (its changelog's "loading earlier messages"). */
export const LOADING_EARLIER = "Loading earlier messages…";
/** The older pages a link may read, at most (a page holds 252 KiB of events). */
export const OLDER_PAGES_MAX = 40;

export interface OlderState {
  /** The route is the message route. */
  onMessage: boolean;
  /** It names a row. */
  target: boolean;
  /** The row is in the loaded pages. */
  found: boolean;
  /** The chat's history is drawn. */
  loaded: boolean;
  /** The cursor of the next older page, or null when none is left. */
  more: string | null;
  /** The older pages read for this link so far. */
  pages: number;
  /** A page is being read. */
  busy: boolean;
  /** A read failed. */
  failed: boolean;
}

/**
 * The next step: "load" the next older page, "loading" while one is read, "gone" (5.4's line), "wait" before the
 * history is drawn (no line yet), or null (not this rule's: another route, no row, or the row is there).
 */
export function olderStep(s: OlderState): "load" | "loading" | "gone" | "wait" | null {
  if (!s.onMessage || !s.target || s.found) return null;
  if (!s.loaded) return "wait";
  if (s.more === null || s.failed || s.pages >= OLDER_PAGES_MAX) return "gone";
  return s.busy ? "loading" : "load";
}
