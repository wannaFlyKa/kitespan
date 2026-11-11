// U4 (FIX-U4, DESIGN-U4): two views in the side panel, one above the other, in the laptop's column and the tablet's
// docked pane. The URL holds the pair (shared/route.ts): its own view is the one used last, and `above=` or `below=`
// names the other, so a link, Back and a reload give the same two halves. The Terminal always takes the lower half.
// These are the page's rules as plain functions: the pair and its halves, where a link inside a half goes, where an
// opener outside the panel goes (4.2 rules 1 to 4), what closing a half gives, the two spellings of one pair, the
// toggles' lit state, the column's width, and the divider's limits, keys, drag and the share the device keeps. Over
// the chat and on the phone the split does not show: there the URL's own view shows alone, and an opener replaces it.
import { href, parse, parsePath, type EntryState, type QueryValue, type Route } from "../router";
import { PANE_ROUTES, paneKindOf, paneRouteOf, paneValueOf, type PaneKind } from "../../shared/route";
import { PANE_BAR_W_TOUCH, cleanSplit } from "./panes";
import { CHAT_MIN, PANEL_W, TERM_SHARE, mediumPaneWidth, readViewport, terminalLayout, useShellLayout, type LayoutPrefs, type ShellLayout, type Viewport } from "./size";
import { getState } from "../state/store";

export type { PaneKind };
export type Slot = "upper" | "lower";

/** One half of a pair: its route (with `half` set), its value, its kind and its place. */
export interface Half {
  route: Route;
  value: string;
  kind: PaneKind;
  slot: Slot;
  /** The URL's own view: the one used last, which alone takes the focus and a pre-fill. */
  path: boolean;
}

export interface Pair {
  chat: string;
  view?: string;
  /** The pair's URL as the builder writes it. */
  url: string;
  path: Half;
  other: Half;
}

const viewOf = (route: Route) => (typeof route.query.view === "string" ? route.query.view : undefined);

/**
 * The /c/<chat>/shell URL (or a pair with the Terminal in it) that the entry on screen was opened from: the copy dialog
 * (/c/<chat>/terminal) shows over the Terminal only when its own Copy the command opened it.
 */
export function shellUnder(chatId: string): string | null {
  if (typeof history === "undefined") return null;
  const from = (history.state as EntryState | null)?.from;
  if (typeof from !== "string") return null;
  const r = parse(new URL(from, "http://kitespan.invalid"));
  if (r.fallbackFrom || r.params.chat !== chatId) return null;
  return r.name === "shell" || (PANE_ROUTES.has(r.name) && r.query.below === "shell") ? from : null;
}

/** The pair a route's URL names (a half's route: its whole pair's), or null: one view, a refused pair, a route outside the panel. */
export function pairOf(route: Route): Pair | null {
  if (route.half) return pairOf(parsePath(route.half.url));
  if (route.fallbackFrom) return null;
  const chat = route.params.chat;
  const kind = paneKindOf(route.name);
  if (!chat || !kind) return null;
  const key = typeof route.query.above === "string" ? "above" : typeof route.query.below === "string" ? "below" : null;
  if (!key) return null;
  if (route.name === "terminal" && !shellUnder(chat)) return null;
  const value = route.query[key] as string;
  const r = paneRouteOf(chat, value);
  const otherKind = r ? paneKindOf(r.name) : null;
  const own = paneValueOf(route);
  if (!r || !otherKind || own === null) return null;
  const view = viewOf(route);
  const url = href(route.name, route.params, route.query);
  const pathSlot: Slot = key === "above" ? "lower" : "upper";
  const otherSlot: Slot = key === "above" ? "upper" : "lower";
  return {
    chat,
    view,
    url,
    path: { route: { ...route, half: { url, slot: pathSlot, path: true } }, value: own, kind, slot: pathSlot, path: true },
    other: { route: { ...r, query: view ? { view } : {}, half: { url, slot: otherSlot, path: false } }, value, kind: otherKind, slot: otherSlot, path: false },
  };
}

/** The halves top to bottom. */
export function halvesOf(p: Pair): readonly [Half, Half] {
  return p.path.slot === "upper" ? [p.path, p.other] : [p.other, p.path];
}

/**
 * The URL of a pair: `to` (a view of the side panel with its own keys) as the URL's own view, and `other` in its place.
 * The builder drops a pair the decoder would refuse (shared/route.ts href), so `to` alone comes back then.
 */
export function pairHref(to: string, other: { value: string; slot: Slot } | null): string {
  const r = parsePath(to);
  if (r.fallbackFrom) return to;
  const query: Record<string, QueryValue | undefined> = { ...r.query, above: undefined, below: undefined };
  if (other) query[other.slot === "upper" ? "above" : "below"] = other.value;
  return href(r.name, r.params, query);
}

/**
 * Where a link inside a half goes (DESIGN-U4 4.2, the link rule): a view of the side panel goes into this half, the
 * other half staying, except that a view whose kind the other half shows goes to that half (this one staying). The
 * Terminal keeps the lower half. A link out of the panel (the chat, a message, a menu, another chat) is as it is, and
 * so is any link of a route that is no half.
 */
export function halfLink(route: Route, to: string): string {
  const h = route.half;
  if (!h) return to;
  const p = pairOf(parsePath(h.url));
  const t = parsePath(to);
  const kind = paneKindOf(t.name);
  if (!p || !kind || t.name === "terminal" || t.fallbackFrom || t.params.chat !== p.chat) return to;
  const self = p.path.slot === h.slot ? p.path : p.other;
  const keep = self === p.path ? p.other : p.path;
  if (kind === keep.kind) return pairHref(to, { value: self.value, slot: self.slot });
  return pairHref(to, { value: keep.value, slot: kind === "terminal" ? "upper" : keep.slot });
}

/**
 * The URL that makes a half the URL's own view, the places kept (DESIGN-U4 6.2: typing in the half that is not the
 * path, the search field's or the side box's), for a replace; null when it is the URL's own view already, or no half.
 * The next opener then takes the other half's place (4.2 rule 4: the half not used last).
 */
export function halfOwnHref(route: Route): string | null {
  if (route.half?.path !== false) return null;
  return halfLink(route, href(route.name, route.params, { view: viewOf(route) }));
}

/**
 * Where a back row inside a half goes ("< Context", "< Uploads", "< Outputs": a step back in its own place). As a link
 * of the half goes (halfLink), except that a target of the kind the other half shows takes the whole pane alone: this
 * half closes into it. So a back row never names the URL on screen, nor changes the other half instead of its own.
 */
export function halfBack(route: Route, to: string): string {
  const h = route.half;
  const p = h ? pairOf(parsePath(h.url)) : null;
  const t = parsePath(to);
  const kind = paneKindOf(t.name);
  if (!h || !p || !kind || t.fallbackFrom || t.params.chat !== p.chat) return halfLink(route, to);
  const keep = p.path.slot === h.slot ? p.other : p.path;
  return kind === keep.kind ? href(t.name, t.params, { ...t.query, above: undefined, below: undefined }) : halfLink(route, to);
}

/**
 * Where closing a half goes (4.3): the other view alone, the whole panel its own. The URL's own view keeps its keys;
 * the other view has the transcript view only. Null for a route that is no half (it closes as before).
 */
export function halfClose(route: Route): string | null {
  const h = route.half;
  if (!h) return null;
  const p = pairOf(parsePath(h.url));
  if (!p) return null;
  if (h.slot === p.path.slot) return href(p.other.route.name, p.other.route.params, { view: p.view });
  return href(p.path.route.name, p.path.route.params, { ...p.path.route.query, above: undefined, below: undefined });
}

/**
 * Whether the laptop's column shows the session rail's cards at rest where the split shows (`live`): there
 * /c/<chat>/details draws what /c/<chat> draws (Shell.tsx cardsHome), so it is the chat's own view for the openers too.
 * The tablet's Details pane, and the cards that a hidden session rail shows on /c/<chat>/details, are a view.
 */
export function cardsRest(live: boolean): boolean {
  if (!live || typeof window === "undefined") return false;
  return readViewport().size === "laptop" && !getState().view.railHidden;
}

/**
 * Where an opener outside the panel goes from `route` to open `to`, a view of the side panel (DESIGN-U4 4.2): (1) its
 * kind shows in a half: that half shows it; (2) nothing shows (the chat, the laptop's cards at rest, also at
 * /c/<chat>/details: `rest`): it opens alone; (3) one view shows: the new one opens below it, but the Terminal always
 * takes the lower half; (4) two views show: the new one takes the place of the half that is not the Terminal, with no
 * Terminal of the half not used last (the other), in place; a Terminal opened into a pair without it takes the lower
 * half. Where the split does not show (`live` false: over the chat, the phone) the opener replaces the view as before
 * and makes no pair.
 */
export function openHref(route: Route, to: string, live: boolean = splitLive(), rest: boolean = cardsRest(live)): string {
  const t = parsePath(to);
  const kind = paneKindOf(t.name);
  if (!live || !kind || t.name === "terminal" || t.fallbackFrom || route.fallbackFrom || t.params.chat !== route.params.chat) return to;
  const p = pairOf(route);
  if (p) {
    const same = p.path.kind === kind ? p.path : p.other.kind === kind ? p.other : null;
    if (same) {
      const keep = same === p.path ? p.other : p.path;
      return pairHref(to, { value: keep.value, slot: keep.slot });
    }
    if (kind === "terminal") {
      const upper = halvesOf(p)[0];
      return pairHref(to, { value: upper.value, slot: "upper" });
    }
    const keep = p.other.kind === "terminal" ? p.other : p.path;
    return pairHref(to, { value: keep.value, slot: keep.slot });
  }
  const own = paneKindOf(route.name);
  if (!own || (route.name === "terminal" && !shellUnder(route.params.chat ?? ""))) return to;
  if (own === kind || (route.name === "details" && rest)) return to;
  const value = paneValueOf(route)!;
  return pairHref(to, { value, slot: own === "terminal" ? "lower" : "upper" });
}

/**
 * The route that shows `kind` now: the URL's own view, or where the split shows (`live`) the other half too (with
 * `half` set); null when none does. The copy dialog shows the Terminal only over it (shellUnder).
 */
export function kindShown(route: Route, kind: PaneKind, live: boolean): Route | null {
  const p = live ? pairOf(route) : null;
  if (p) return p.path.kind === kind ? p.path.route : p.other.kind === kind ? p.other.route : null;
  if (route.fallbackFrom || paneKindOf(route.name) !== kind) return null;
  return route.name !== "terminal" || shellUnder(route.params.chat ?? "") ? route : null;
}

/**
 * A toggle for a kind (the pane bar's buttons, the title bar's tools): lit while its kind shows; a press then closes
 * that half (the other view alone), or the one view (to `chatUrl`); unlit, it opens `to` by the opener rules.
 */
export function kindToggle(route: Route, kind: PaneKind, to: string, live: boolean, chatUrl: string): { on: boolean; to: string; close: boolean } {
  const shown = kindShown(route, kind, live);
  if (shown) return { on: true, to: halfClose(shown) ?? chatUrl, close: true };
  return { on: false, to: openHref(route, to, live), close: false };
}

/**
 * Show session rail on a laptop (DESIGN-U4 4.3): `cards` (/c/<chat>/details) always take the upper half, as the
 * Terminal always takes the lower one, so the rail keeps its place at the top of the column and a side chat's box the
 * panel's foot. The view that shows alone goes below the cards; in a pair the lower half stays, in place, and the
 * cards take the upper half's place.
 */
export function railShowHref(route: Route, cards: string): string {
  const p = pairOf(route);
  const value = p ? halvesOf(p)[1].value : paneValueOf(route);
  return value === null ? cards : pairHref(cards, { value, slot: "lower" });
}

/** The pair a URL shows, written place by place: the URL's own view with its keys, the other's path, the transcript view. */
function pairKey(url: string): string | null {
  const p = pairOf(parsePath(url));
  if (!p) return null;
  const spell = (h: Half) => (h.path ? href(h.route.name, h.route.params, { ...h.route.query, above: undefined, below: undefined, view: undefined }) : href(h.route.name, h.route.params));
  return [p.view ?? "", ...halvesOf(p).map(spell)].join(" ");
}

/**
 * One pair, two spellings (6.4): `/c/<chat>/btw?above=context` and `/c/<chat>/context?below=btw` show the same two
 * views in the same places, so the router takes them for one view (setSameView): a move between them replaces the
 * entry, and Close goes back to the other spelling as to its parent.
 */
export function samePair(a: string, b: string): boolean {
  const k = pairKey(a);
  return k !== null && k === pairKey(b);
}

/** The halves' names: the divider's is "<upper half> height". */
const TITLES: Record<string, string> = {
  details: "Details",
  environment: "Environment",
  context: "Context",
  connectors: "Connectors",
  outputs: "Outputs",
  uploads: "Uploads",
  files: "Files",
  chatSearch: "Search",
  sideChat: "Side chat",
  sideExchange: "Side chat",
  shell: "Terminal",
  terminal: "Terminal",
  // U1: a turn's changes and one file's diff (the divider's name "Changes height").
  changesTurn: "Changes",
  changesFile: "Changes",
  // Iteration 7 (DESIGN-B1 4.1): the Browser, every tab one kind ("Browser height").
  chatBrowser: "Browser",
  chatBrowserTab: "Browser",
};
export function halfTitle(route: Route): string {
  return TITLES[route.name] ?? "Details";
}
/** A half's own name for its folded head: halfTitle's words, and for a file (U1: a file's diff too) the file's own name. */
export function halfName(route: Route): string {
  const path = route.name === "files" || route.name === "changesFile" ? (route.params.path ?? "") : "";
  return path.slice(path.lastIndexOf("/") + 1) || halfTitle(route);
}

// ---- where the split shows, and the column's width (DESIGN-U4 7)

/**
 * The split shows where the side panel docks beside the chat: the laptop's column and the tablet's docked pane. Over
 * the chat (a laptop whose chat would keep less than 520 px) and on the phone, one view shows.
 */
export function splitShows(layout: Pick<ShellLayout, "size" | "side" | "paneOver">): boolean {
  if (layout.size === "phone") return false;
  return layout.side === "column" || (layout.side === "pane" && !layout.paneOver);
}

/** Whether the split shows in this layout now, for a link that a render writes (an opener's `to`). */
export function useSplitLive(): boolean {
  return splitShows(useShellLayout());
}

/**
 * The column's default width for its views: the Terminal's (its clamp, narrowed so the chat keeps CHAT_MIN) while the
 * Terminal is a half or the one view, else the side pane's (320 px; the tablet's 320 px or 40%). The split needs no
 * width of its own, so no breakpoint moves. A width the user dragged is the device's own (panes.ts). U1 (DESIGN-U1
 * 7.1): a diff is code, so a changes view takes the Terminal's rule on a laptop; on medium touch it takes 40% of the
 * window, narrowed so the chat keeps CHAT_MIN beside the pane bar, never under the side pane's own width.
 */
export function sideWidth(vp: Pick<Viewport, "size" | "width">, prefs: LayoutPrefs, terminal: boolean, changes = false): number {
  if (changes && vp.size === "medium") return Math.max(mediumPaneWidth(vp.width), Math.min(Math.round(vp.width * TERM_SHARE), vp.width - PANE_BAR_W_TOUCH - CHAT_MIN));
  if (terminal || changes) return terminalLayout(vp, prefs).width;
  return vp.size === "medium" ? mediumPaneWidth(vp.width) : PANEL_W;
}
/** The chat's minimum where the panel docks (size.ts), as the split keeps it. */
export { CHAT_MIN };

// ---- the divider (DESIGN-U4 5)

/** Each half keeps at least this much height, on a laptop and on touch (the Terminal's head and its key bar). */
export const SPLIT_MIN = 200;
export const SPLIT_MIN_TOUCH = 240;
/** Up and Down move the divider by this much. */
export const SPLIT_STEP = 16;

/** The divider's place: the upper half's height in px, within its limits; `def` is equal halves. */
export interface SplitRange {
  min: number;
  max: number;
  def: number;
  now: number;
}

const clamp = (v: number, r: Pick<SplitRange, "min" | "max">) => Math.min(r.max, Math.max(r.min, v));

/** The divider's range in a column `height` px tall, at the device's `share` (none: equal halves). */
export function splitRange(height: number, touch: boolean, share?: number): SplitRange {
  const least = touch ? SPLIT_MIN_TOUCH : SPLIT_MIN;
  const min = least;
  const max = Math.max(least, Math.round(height) - least);
  const def = clamp(Math.round(height / 2), { min, max });
  const now = share === undefined ? def : clamp(Math.round(share * height), { min, max });
  return { min, max, def, now };
}

/** A column too short for two halves of their least height: the half not used last folds to its head. */
export function splitFolds(height: number, touch: boolean): boolean {
  return height < 2 * (touch ? SPLIT_MIN_TOUCH : SPLIT_MIN) + 1;
}

/** A key on the focused divider (the window splitter pattern): Up and Down by SPLIT_STEP, Home and End to the limits. */
export function splitKey(key: string, r: SplitRange): number | null {
  if (key === "ArrowUp") return clamp(r.now - SPLIT_STEP, r);
  if (key === "ArrowDown") return clamp(r.now + SPLIT_STEP, r);
  if (key === "Home") return r.min;
  if (key === "End") return r.max;
  return null;
}

/** The upper half's height while a drag is `dy` px from where it started at `start`: whole pixels, within the range. */
export function splitDrag(start: number, dy: number, r: Pick<SplitRange, "min" | "max">): number {
  return clamp(Math.round(start + dy), r);
}

/** The share the device keeps for a divider at `top` in a column `height` px tall (4 decimals). */
export function shareOf(top: number, height: number): number {
  return height > 0 ? Math.round((top / height) * 10000) / 10000 : 0.5;
}

/** The stored share, read defensively (panes.ts, beside the stored widths, which the store reads with it). */
export { cleanSplit };

// ---- the split's state for the key handlers, which run outside React (Shell.tsx sets it)

let live = false;
/** Whether the split shows in this layout now (Shell.tsx keeps it while a chat screen with a side panel shows). */
export function splitLive(): boolean {
  return live;
}
export function setSplitLive(on: boolean) {
  live = on;
}
