// The page's router (DESIGN.md section 5): the URL is the state. The route table, the strict decoder and the encoder
// are shared/route.ts (the server answers the same paths with the page); this file adds the DOM and history parts:
// pushState for deliberate navigation, replaceState for live sync, the close rule and the route hook.
import { useSyncExternalStore } from "react";
import { PANE_ROUTES, parse, type Route } from "../shared/route";
import { newUuid } from "./net/frames";
import type { Anchor } from "./chat/anchor";

export { decodeQuery, decodeQueryFull, href, isSafeRelativePath, parse, parsePath, type QueryValue, type Route } from "../shared/route";

// History integration: pushState for deliberate navigation, replaceState for live sync (DESIGN.md section 5 rule 4).
const listeners = new Set<() => void>();
let cached: { href: string; route: Route } | null = null;

function emit() {
  for (const l of listeners) l();
}

/**
 * Review U3: whether the entry on screen was reached by Back or Forward: a popstate, or a document that a Back or
 * Forward loaded (its navigation's type). A link, a replace, a typed URL and a reload are not. Only then does a chat
 * put back the place its entry keeps (EntryState.place, DESIGN-U3 6): a reload opens the route as usual.
 */
export function loadedByHistory(navType: string | undefined): boolean {
  return navType === "back_forward";
}
let traversed = loadedByHistory(
  typeof performance !== "undefined" && typeof performance.getEntriesByType === "function" ? (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type : undefined,
);
/** Whether the entry on screen was reached by Back or Forward (see loadedByHistory). */
export function cameByHistory(): boolean {
  return traversed;
}
if (typeof window !== "undefined") {
  // A document that opens its entry by a reload or a new load shows the route, not the place: the entry forgets it.
  const st = history.state as EntryState | null;
  if (!traversed && st && typeof st === "object" && st.place !== undefined) {
    const { place: _gone, ...rest } = st;
    history.replaceState(rest, "");
  }
  window.addEventListener("popstate", () => {
    traversed = true;
    emit();
  });
}

export function currentUrl(): string {
  return location.pathname + location.search;
}

/**
 * The id of the document that opens on an entry whose history state is `state`. The router marks each entry it pushes
 * with it (EntryState.doc). A reload, or a Back or Forward that loads the page again, opens an entry that keeps its
 * state, and the entries that document pushed share the entry's document state, so going back to them stays in the
 * page: the id stays. A new page load (a link, a typed URL) opens an entry with no state, or one that seedHistory gave
 * a trail with no document: a new id.
 */
export function documentId(state: unknown, fresh: () => string = newUuid): string {
  const doc = state && typeof state === "object" ? (state as EntryState).doc : undefined;
  return typeof doc === "string" && doc !== "" ? doc : fresh();
}

/** This document's own id (documentId). */
const DOC = documentId(typeof history !== "undefined" ? history.state : null);

/**
 * What an entry the router pushed keeps in its history state: `from`, the URL of the entry before it, and `back`, the
 * URLs of the entries behind it, newest first (back[0] is `from`; at most TRAIL_MAX). A replace keeps the state, since
 * the entries behind do not change. A reload keeps it too. Settings adds its own fields beside these.
 */
export interface EntryState {
  from?: string;
  back?: string[];
  /**
   * The document whose router pushed the entry, and how many entries of `back`, from back[0], belong to that document
   * too. Only those are a step back that stays in the page (closeSteps). A trail from the tab's earlier documents
   * (seedHistory) names where the user came from, and closing never goes back to it. A reload keeps the id
   * (documentId).
   */
  doc?: string;
  inDoc?: number;
  /**
   * The terminal-only command (D47) whose pick in the / menu opened the Terminal pane: the pane prints "Then type
   * /<name>." above the resume command it types. It rides in the entry's state, never in its URL, because a URL never
   * carries text to the prompt.
   */
  thenType?: string;
  /**
   * U3: the reader's place in the chat when a turn rail's link left this entry (an anchor of chat/anchor.ts, or "end"
   * while the view followed the end): Back into the entry puts it back once (DESIGN-U3 6). View state, never a URL.
   */
  place?: Anchor | "end";
}
export const TRAIL_MAX = 16;

/** The fields of a state that say where its entry is in the tab's history (kept by a replace with a fresh state). */
function trailOf(st: EntryState | null | undefined): EntryState {
  const kept: EntryState = {};
  if (typeof st?.from === "string") kept.from = st.from;
  if (Array.isArray(st?.back)) kept.back = st.back;
  if (typeof st?.doc === "string" && typeof st.inDoc === "number") {
    kept.doc = st.doc;
    kept.inDoc = st.inDoc;
  }
  return kept;
}

/**
 * The state of an entry pushed in this document (`doc`) from the entry `here`, whose own state is `prev`. `here` is
 * the entry on screen, so it belongs to this document; the entries behind it do when this document pushed it too.
 */
export function pushedState(prev: EntryState | null | undefined, here: string, doc = DOC): EntryState {
  const behind = Array.isArray(prev?.back) ? prev.back : typeof prev?.from === "string" ? [prev.from] : [];
  const back = [here, ...behind].slice(0, TRAIL_MAX);
  const mine = prev?.doc === doc && typeof prev.inDoc === "number" ? prev.inDoc : 0;
  return { from: here, back, doc, inDoc: Math.min(back.length, 1 + mine) };
}

/**
 * The layout's rule for two URLs that show the same thing now, or null: the laptop's column shows the side panel's
 * cards at both /c/<chat> and /c/<chat>/details (Shell.tsx sets it), so going from one to the other replaces the
 * entry, and closing to one of them can go back to the other: no entry whose Back changes nothing.
 */
let sameView: ((a: string, b: string) => boolean) | null = null;
export function setSameView(rule: ((a: string, b: string) => boolean) | null) {
  sameView = rule;
}

/**
 * Go to `to`: a new entry (pushState), or with `replace` the current entry (replaceState). A URL that shows the same
 * thing as the current one in this layout (setSameView: Details while the laptop's column shows the cards already)
 * replaces too, so Back never lands on an entry that looks the same.
 *
 * `state` gives the entry fields of its own (EntryState's thenType). A new entry gets them beside from and back. A
 * replace, and a go to the URL that is open already, give the current entry a fresh state: its from and back and
 * these fields, and nothing it held for what it showed before (so the Terminal pane types again for a new pick).
 */
export function navigate(to: string, opts: { replace?: boolean; state?: Omit<EntryState, "from" | "back"> } = {}) {
  const here = currentUrl();
  if (opts.state) {
    traversed = false;
    const st = history.state as EntryState | null;
    if (to === here || opts.replace || sameView?.(here, to)) {
      history.replaceState({ ...trailOf(st), ...opts.state }, "", to);
      cached = null; // the same URL with a new state is a new route, so the views that read the state read it again
    } else history.pushState({ ...pushedState(st, here), ...opts.state }, "", to);
    emit();
    return;
  }
  if (to === here) return;
  traversed = false;
  // Each entry remembers the entries behind it, so closing a sheet can go back instead of piling up entries.
  if (opts.replace || sameView?.(here, to)) history.replaceState(history.state, "", to);
  else history.pushState(pushedState(history.state as EntryState | null, here), "", to);
  emit();
}

/**
 * The open layer a URL is a view of, when that layer's views push each other: the side pane of one chat (the side
 * panel's views and the Terminal pane, which the pane bar switches between).
 */
function layerOf(url: string): string | null {
  const r = parse(new URL(url, "http://kitespan.invalid"));
  return !r.fallbackFrom && PANE_ROUTES.has(r.name) ? `panel ${r.params.chat}` : null;
}

/**
 * How many entries closing the current state goes back to reach `parent` (DESIGN.md 5.1 rule 4, 5.5 step 3): 1 when
 * the entry before is the parent (or shows the same thing, setSameView); more when the entries between are views of
 * the same open layer as the current one, which pushed each other (the side panel's cards and detail views and the
 * Terminal pane, so Details, then Context, then Close goes back over both); 0 when the parent is not behind them,
 * and then closeTo replaces the current entry with the parent.
 *
 * It goes back only over entries of this document (`doc`) that its router pushed (EntryState.doc and inDoc), never to
 * an earlier document of the tab: that would unload the page, and a frame that a Send or a Save just gave the socket
 * could go with it. A link opened as a new document after the chat's page closes by replacing.
 */
export function closeSteps(st: EntryState | null | undefined, current: string, parent: string, same = sameView, doc = DOC): number {
  const behind = Array.isArray(st?.back) ? st.back : typeof st?.from === "string" ? [st.from] : [];
  const layer = layerOf(current);
  const reach = docReach(st, doc);
  for (let i = 0; i < reach; i++) {
    const u = behind[i]!;
    if (u === parent || same?.(u, parent)) return i + 1;
    if (!layer || layerOf(u) !== layer) return 0;
  }
  return 0;
}

/**
 * How many entries behind the current one (from back[0]) this document pushed: a go back over at most that many stays
 * in the page. 0 for an entry this document did not push (a new document's seeded trail, an earlier document's entry).
 */
export function docReach(st: EntryState | null | undefined, doc = DOC): number {
  const behind = Array.isArray(st?.back) ? st.back.length : typeof st?.from === "string" ? 1 : 0;
  return st?.doc === doc && typeof st.inDoc === "number" ? Math.max(0, Math.min(st.inDoc, behind)) : 0;
}

/**
 * Close a sheet, a pane or a dialog: go back to the parent when it is the entry before, or behind the views of the
 * same open layer, in this document (closeSteps), so a closed state leaves no dead history entry; else replace with
 * the parent.
 */
export function closeTo(parent: string) {
  const n = closeSteps(history.state as EntryState | null, currentUrl(), parent);
  if (n === 1) history.back();
  else if (n > 1) history.go(-n);
  else navigate(parent, { replace: true });
}

/** The parts of the Navigation API that the router reads (a browser without it gives null). */
export interface NavigationLike {
  currentEntry: { index: number; key?: string } | null;
  entries(): readonly { url: string | null; index: number; key?: string }[];
  addEventListener?(type: "currententrychange", listener: () => void): void;
}

/**
 * The URL of each entry of this tab, by its Navigation API key, kept in session storage (per tab, across the tab's
 * documents). The server sends Referrer-Policy: no-referrer, which hides document.referrer and also the URL of the
 * tab's other entries in navigation.entries() (null), so the page keeps its own record of where each entry was.
 */
export const ENTRY_URLS_KEY = "kitespan.entryUrls";
const ENTRY_URLS_MAX = 64;
type KeyStore = Pick<Storage, "getItem" | "setItem">;

export function readEntryUrls(store: KeyStore | null | undefined): Record<string, string> {
  try {
    const v = JSON.parse(store?.getItem(ENTRY_URLS_KEY) ?? "null") as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
}

/** Note the current entry's URL under its key (the newest ENTRY_URLS_MAX are kept). */
export function rememberEntry(nav: NavigationLike | null | undefined, store: KeyStore | null | undefined, url: string) {
  const key = nav?.currentEntry?.key;
  if (!key || !store) return;
  const all = readEntryUrls(store);
  delete all[key];
  all[key] = url;
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - ENTRY_URLS_MAX))) delete all[k];
  try {
    store.setItem(ENTRY_URLS_KEY, JSON.stringify(all));
  } catch {} // full or blocked storage: no trail is seeded from it
}

/**
 * The path and query of the tab's kitespan entries just before the current one, newest first. The Navigation API
 * lists only the tab's same-origin entries next to the current one, so an entry of another site (or about:blank) ends
 * the list; an entry whose URL it hides is read from this tab's own record (`known`, by key). Without the API, a
 * same-origin referrer names the entry before, when the tab has one (`length` over 1).
 */
export function entriesBefore(nav: NavigationLike | null | undefined, referrer: string, origin: string, length: number, known: Readonly<Record<string, string>> = {}): string[] {
  const local = (u: string | null): string | null => {
    if (!u) return null;
    try {
      const url = new URL(u, origin || undefined);
      return url.origin === origin ? url.pathname + url.search : null;
    } catch {
      return null;
    }
  };
  if (nav?.currentEntry && typeof nav.entries === "function") {
    const at = nav.currentEntry.index;
    const out: string[] = [];
    const byIndex = new Map(nav.entries().map((e) => [e.index, e] as const));
    for (let i = at - 1; i >= 0 && byIndex.has(i) && out.length < TRAIL_MAX; i--) {
      const e = byIndex.get(i)!;
      const u = local(e.url ?? (e.key ? known[e.key] ?? null : null));
      if (u === null) break;
      out.push(u);
    }
    return out;
  }
  const from = local(referrer);
  return from !== null && length > 1 ? [from] : [];
}

/**
 * The state for an entry that has no trail of its own (`from` and `back`): one that opened a new document, by a link
 * to an action route or a URL typed while a kitespan page was open in the tab. The entries before it become its trail,
 * so the page knows where the user came from (a dialog's parent, the chat whose facts Settings reads). It names no
 * document (EntryState.doc), so closeTo never goes back to them. Null when the entry has a trail, or nothing is known
 * behind it. Other fields of the entry stay.
 */
export function seededState(st: unknown, before: readonly string[]): EntryState | null {
  const s = st && typeof st === "object" ? (st as EntryState) : null;
  if (s && (typeof s.from === "string" || Array.isArray(s.back))) return null;
  if (!before.length) return null;
  const back = before.slice(0, TRAIL_MAX);
  return { ...(s ?? {}), from: back[0]!, back };
}

let recording = false;

/**
 * At boot (main.tsx): give the entry this document opened in its trail, when it has none (seededState), and from
 * then on note each entry's URL by its key, so a later document of this tab can find the entries before it.
 */
export function seedHistory(env?: { nav?: NavigationLike | null; referrer?: string; origin?: string; store?: KeyStore | null }) {
  if (typeof history === "undefined") return;
  const g = globalThis as { navigation?: NavigationLike; document?: { referrer?: string }; location?: { origin?: string }; sessionStorage?: KeyStore };
  const nav = env && "nav" in env ? env.nav : g.navigation;
  const referrer = env?.referrer ?? g.document?.referrer ?? "";
  const origin = env?.origin ?? g.location?.origin ?? "";
  let store: KeyStore | null = null;
  try {
    store = env && "store" in env ? env.store ?? null : g.sessionStorage ?? null;
  } catch {} // blocked storage
  if (!origin) return;
  const next = seededState(history.state, entriesBefore(nav, referrer, origin, history.length, readEntryUrls(store)));
  if (next) history.replaceState(next, "", currentUrl());
  rememberEntry(nav, store, currentUrl());
  if (!env && !recording && nav?.addEventListener) {
    recording = true;
    nav.addEventListener("currententrychange", () => rememberEntry(nav, store, currentUrl()));
  }
}

function snapshot(): Route {
  const h = location.href;
  if (!cached || cached.href !== h) cached = { href: h, route: parse(new URL(h)) };
  return cached.route;
}

/** S1: one subscribe function for every hook, so React does not subscribe again after each render. */
function subscribeRoute(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribeRoute, snapshot, snapshot);
}
