// The browser pane's routes (DESIGN-B1 4.1; shared/route.ts): /c/<chat>/browser and /c/<chat>/browser/<tab>, the side
// panel's seventh view kind, and /browser and /browser/<tab>, a page of its own. A `url` only fills a new tab's
// address field, which opens only on Go or Enter. Showing a tab names it in the URL (a replace, so the tab strip leaves
// no history behind). This device's own choices, never a URL: the tab it showed last, and where chat links open
// (DESIGN-B1 4.15, PA-14).
import { href, type Route } from "../router";
import { browserUrlProblem } from "../../shared/browser";
import { isBrowserTabId } from "../../shared/ids";
import { halfClose, kindShown, openHref } from "../layout/split";

export const BROWSER_ROUTES: ReadonlySet<string> = new Set(["browser", "browserTab", "chatBrowser", "chatBrowserTab"]);
export const CHAT_BROWSER_ROUTES: ReadonlySet<string> = new Set(["chatBrowser", "chatBrowserTab"]);

const viewOf = (route: Route) => (typeof route.query.view === "string" ? route.query.view : undefined);

/** True when the route shows the Browser as its own view (not as the other half of a pair). */
export function browserShown(route: Route): boolean {
  return BROWSER_ROUTES.has(route.name) && !route.fallbackFrom;
}

/** The pane's URL for a tab (null: no tab named), beside chat `chat` or on its own. */
export function browserHref(chat: string | undefined, tab: string | null, view?: string, url?: string): string {
  if (chat) return tab ? href("chatBrowserTab", { chat, tab }, { view }) : href("chatBrowser", { chat }, { view, url });
  return tab ? href("browserTab", { tab }) : href("browser", {}, { url });
}

/** The URL that shows `tab` in the route's place: the same route kind with the tab named, the pair kept. */
export function tabHrefIn(route: Route, tab: string | null): string {
  const chat = route.params.chat;
  if (!chat) return browserHref(undefined, tab);
  const above = typeof route.query.above === "string" ? route.query.above : undefined;
  const below = typeof route.query.below === "string" ? route.query.below : undefined;
  return tab ? href("chatBrowserTab", { chat, tab }, { view: viewOf(route), above, below }) : href("chatBrowser", { chat }, { view: viewOf(route), above, below });
}

/** The tab a route names, or null. */
export function routeTab(route: Route): string | null {
  const t = route.params.tab;
  return (route.name === "browserTab" || route.name === "chatBrowserTab") && isBrowserTabId(t) ? t! : null;
}

/** The address a route pre-fills (`url`): only a new tab's field holds it, never opened by itself. */
export function routeUrl(route: Route): string | null {
  return (route.name === "browser" || route.name === "chatBrowser") && typeof route.query.url === "string" && route.query.url ? route.query.url : null;
}

/** 5.4's line for a pre-fill that may not fill the field. */
export const PREFILL_REFUSED = "That address cannot open here.";

/**
 * A `url` pre-fill (PAGE-B1 2.1, DESIGN-B1 4.1): only an http or https address with a host fills a new tab's field;
 * anything else fills nothing and gets 5.4's line. (Go runs the whole URL rule, kitespan's own origins included.)
 */
export function prefillOf(raw: string | null): { url: string } | { refused: true } | null {
  if (raw === null) return null;
  return raw !== "about:blank" && browserUrlProblem(raw, { origins: [], loopbackPorts: [] }) === null ? { url: raw } : { refused: true };
}

/**
 * A chat link whose address waits in a new tab's field (the browser off or missing, or its socket not open in time):
 * it came from Claude's text here, not from an external link, so the field says nothing of where it came from. Only
 * this page's own click marks it, for a short while; a link can never mark itself.
 */
let chatLink: { url: string; at: number } | null = null;
export function markChatLink(url: string) {
  chatLink = { url, at: Date.now() };
}
export function isChatLink(url: string | null): boolean {
  return !!url && !!chatLink && chatLink.url === url && Date.now() - chatLink.at < 10_000;
}

/**
 * The Browser tool's toggle (the title bar's, the pane bar's, the phone's menu item): lit while a view or half shows
 * the Browser; a press then closes it; unlit it opens /c/<chat>/browser by the opener rules (layout/split.ts).
 */
export function browserToggle(route: Route, chat: string, live: boolean): { on: boolean; to: string; close: boolean } {
  const chatUrl = href("chat", { chat }, { view: viewOf(route) });
  const shown = kindShown(route, "browser", live);
  if (shown) return { on: true, to: halfClose(shown) ?? chatUrl, close: true };
  return { on: false, to: openHref(route, href("chatBrowser", { chat }, { view: viewOf(route) }), live), close: false };
}

/**
 * Cmd+Shift+B (Ctrl+Shift+B off macOS), Desktop's "Toggle Browser pane" (DESIGN-B1 4.1, PAGE 17): in a chat it opens
 * the chat's Browser by the opener rules and from the pane closes its half; outside a chat it opens /browser, and from
 * there goes back where it came from (`back`). Null where it does nothing (an action route that waits for its press).
 */
export function browserKeyTarget(route: Route, live: boolean, back: string | null): { to: string; close: boolean } | null {
  if (route.fallbackFrom) return null;
  const chat = route.params.chat;
  if (route.name === "browser" || route.name === "browserTab") return { to: back ?? "/", close: true };
  if (!chat) return { to: href("browser"), close: false };
  if (route.def.kind === "action") return null;
  const t = browserToggle(route, chat, live);
  return { to: t.to, close: t.close };
}

/** The Browser key: Cmd+Shift+B on macOS, Ctrl+Shift+B elsewhere, with no Alt. */
export function isBrowserKey(e: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">, mac: boolean): boolean {
  if (!e.shiftKey || e.altKey) return false;
  if (!(e.code === "KeyB" || e.key.toLowerCase() === "b")) return false;
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

// ---- this device's choices (local storage, never a URL)

const LAST_KEY = "kitespan.browser.tab";
const LINKS_KEY = "kitespan.browser.links";

function kv(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The tab this device showed last. */
export function lastTab(): string | null {
  const v = kv()?.getItem(LAST_KEY) ?? null;
  return isBrowserTabId(v) ? v : null;
}
export function keepLastTab(tab: string) {
  try {
    kv()?.setItem(LAST_KEY, tab);
  } catch {}
}

/** Where a chat's links open on this device (DESIGN-B1 4.15): ask the first time, the browser pane, or a new tab. */
export type ChatLinks = "ask" | "pane" | "tab";
export function chatLinks(): ChatLinks {
  const v = kv()?.getItem(LINKS_KEY);
  return v === "pane" || v === "tab" ? v : "ask";
}
const linkListeners = new Set<() => void>();
export function setChatLinks(v: ChatLinks) {
  try {
    if (v === "ask") kv()?.removeItem(LINKS_KEY);
    else kv()?.setItem(LINKS_KEY, v);
  } catch {}
  for (const l of linkListeners) l();
}
export function onChatLinks(fn: () => void): () => void {
  linkListeners.add(fn);
  return () => linkListeners.delete(fn);
}
export const CHAT_LINK_WORDS: Record<ChatLinks, string> = { ask: "Ask the first time", pane: "In the browser pane", tab: "In a new tab" };
