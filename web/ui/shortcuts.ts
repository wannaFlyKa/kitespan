// The page's own keyboard shortcuts (DESIGN.md 6.11), bound once on the window: Cmd or Ctrl and the slash key opens
// Settings > General > Keyboard shortcuts ("Show keyboard shortcuts"), and Cmd or Ctrl+Shift and a square bracket
// moves to the next or the previous chat in the sidebar's order ("Next or previous session", for chats): the chats
// the list shows, after its filter and without its folded projects (listedChats). Search (v0.3 search, 9.3) is Cmd+K
// on macOS and Ctrl+K elsewhere: Ctrl+K on macOS stays the field's own text key ("Control-K: Cut ... to the end of the
// paragraph"). In a chat it opens that chat's search pane, elsewhere /search; while the pane is open and its field has
// no focus, it focuses the field and selects its text. It does nothing inside the Terminal pane (the shell's key) or
// while an input method composes. The keys of the composer and its menus live there (Composer.tsx). A dialog or a
// sheet that is open keeps its keys. R124: Desktop's Open side chat, Cmd+; on macOS and Ctrl+; elsewhere: in a chat it
// opens the chat's side chat, or with the side chat open puts the focus in its box; it does nothing outside a chat, in
// the Terminal pane, over a dialog or a sheet, while an input method composes, on an archived chat, or where the agent
// answers no side question. U4 (DESIGN-U4 4.2, 11): where the side panel splits, Cmd+K and Cmd+; open their view by the
// opener rules (layout/split.ts openHref) and focus its field while a half shows it; and Desktop's Close focused pane,
// Cmd+backslash on macOS and Ctrl+backslash elsewhere, closes the half that holds the focus (the other view takes the
// whole pane), or with one view that view. It does nothing off macOS inside the Terminal (the shell's quit key), on the
// divider between two halves, over a dialog, a sheet or a drawer, or while an input method composes. Iteration 7
// (DESIGN-B1 4.1, PAGE 17): Desktop's "Toggle Browser pane", Cmd+Shift+B on macOS and Ctrl+Shift+B elsewhere: in a chat
// it opens the chat's Browser by the opener rules and from the pane closes it; outside a chat /browser, and back. The
// browser pane's frame passes it on; nothing while a dialog, a sheet or a drawer is open or an input method composes.
import { useEffect, useRef } from "react";
import { closeTo, docReach, href, navigate, parse, type EntryState, type Route } from "../router";
import { paneKindOf } from "../../shared/route";
import { halfClose, halvesOf, kindShown, openHref, pairOf, splitLive } from "../layout/split";
import { isCloseFocusedPane } from "../terminal/keys";
import { closeHref } from "../search/nav";
import { getState } from "../state/store";
import type { Chat, Project } from "../state/types";
import { composingKey } from "./primitives";
import { searchOpenHref } from "../search/nav";
import { focusSearchField, openSearchFocused } from "../search/focus";
import { focusSideField, openSideFocused, sideHref, sideShown } from "../side/nav";
import { browserKeyTarget, isBrowserKey } from "../browser/nav";

/** The page runs on macOS (or iOS, whose hardware keyboards have Cmd): Cmd is the shortcut key there, Ctrl elsewhere. */
export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** A key as the platform writes it in a tooltip or Settings: "Cmd+K" on macOS, "Ctrl+K" elsewhere. */
export function keyLabel(letter: string, mac: boolean = IS_MAC): string {
  return `${mac ? "Cmd" : "Ctrl"}+${letter.toUpperCase()}`;
}

/** The chats in the sidebar's order with nothing filtered or folded: the projects in their order, each one's chats newest first. */
export function chatOrder(projects: readonly Project[], chats: readonly Chat[]): string[] {
  const newest = (a: Chat, b: Chat) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  return projects.flatMap((p) => chats.filter((c) => c.projectId === p.id).sort(newest).map((c) => c.id));
}

/** What listedChats reads of the page: a stand-in in a test. */
export interface ListRoot {
  querySelectorAll(selector: string): ArrayLike<{ getAttribute(name: string): string | null; getClientRects(): ArrayLike<unknown> }>;
}

/**
 * The chats the chat list on the page shows, in its order: the sidebar's rows (or the phone's list screen), so a step
 * follows the list's filter and skips its folded projects, and the current chat always has its row. Null when no list
 * is on screen (the phone's chat, or a laptop under 1,000 px with its drawer closed): the step then follows chatOrder.
 */
export function listedChats(root: ListRoot = document): string[] | null {
  const shown = Array.from(root.querySelectorAll(".scr-list")).some((el) => el.getClientRects().length > 0);
  if (!shown) return null;
  const ids: string[] = [];
  for (const row of Array.from(root.querySelectorAll(".scr-list a.scr-row"))) {
    if (!row.getClientRects().length) continue;
    const to = row.getAttribute("href");
    const r = to?.startsWith("/c/") ? parse(new URL(to, "http://localhost")) : null;
    const id = r?.name === "chat" ? r.params.chat : undefined;
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * The chat `dir` steps away from `current` in `order`, round the ends. With no current chat (or one not in the
 * order), next is the first chat and previous the last. Null when there are no chats.
 */
export function stepChat(order: readonly string[], current: string | undefined, dir: 1 | -1): string | null {
  if (!order.length) return null;
  const at = current ? order.indexOf(current) : -1;
  if (at < 0) return dir === 1 ? order[0]! : order[order.length - 1]!;
  return order[(at + dir + order.length) % order.length]!;
}

export type Shortcut = "shortcuts" | "next" | "previous" | "search" | "side" | "pane" | "browser";

/**
 * Row 111, the CLI's Ctrl+Enter in the message box (DESIGN.md 6.4, 6.11): Ctrl+Enter on every platform, and Cmd+Enter
 * on macOS too. While a turn runs, the draft goes, queued behind the messages that wait, and then Send now acts
 * ("send-now"); with an empty box it is Send now alone ("now"). With no turn running, and in `!` mode, it does only
 * what Enter does ("send"). Null for any other Enter (the Meta key off macOS stays the box's own send).
 */
export function sendNowKey(e: Pick<KeyboardEvent, "ctrlKey" | "metaKey">, at: { turn: boolean; bash: boolean; empty: boolean }, mac: boolean = IS_MAC): "send" | "now" | "send-now" | null {
  if (!(e.ctrlKey || (mac && e.metaKey))) return null;
  if (!at.turn || at.bash) return "send";
  return at.empty ? "now" : "send-now";
}

/** Search's key: Cmd+K on macOS, Ctrl+K elsewhere, with no other modifier (so Ctrl+K on macOS is not it). */
function isSearchKey(e: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">, mac: boolean): boolean {
  if (e.altKey || e.shiftKey) return false;
  if (!(e.key.toLowerCase() === "k" || e.code === "KeyK")) return false;
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/**
 * Desktop's Open side chat (R124, row 124): Cmd+; on macOS, Ctrl+; elsewhere, with no Shift or Alt. The key's code, so a
 * layout that puts ";" on another key still has it where Desktop's is.
 */
function isSideKey(e: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">, mac: boolean): boolean {
  if (e.altKey || e.shiftKey || !(e.code === "Semicolon" || e.key === ";")) return false;
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/** What a key press asks for: the shortcuts page, a chat step, search, the side chat, or nothing. `mac`: the platform's key rule. */
export function shortcutFor(e: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">, mac: boolean = IS_MAC): Shortcut | null {
  if (isCloseFocusedPane(e, mac)) return "pane";
  if (isBrowserKey(e, mac)) return "browser";
  if (isSearchKey(e, mac)) return "search";
  if (isSideKey(e, mac)) return "side";
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;
  // The slash key, wherever the layout puts it: some layouts need Shift to type "/".
  if (e.key === "/" || (e.code === "Slash" && !e.shiftKey)) return "shortcuts";
  if (!e.shiftKey) return null;
  if (e.code === "BracketRight" || e.key === "}" || e.key === "]") return "next";
  if (e.code === "BracketLeft" || e.key === "{" || e.key === "[") return "previous";
  return null;
}

/** Bind the shortcuts on the window while the app runs. Each one acts only inside its key press. */
export function useGlobalShortcuts(route: Route) {
  const live = useRef(route);
  live.current = route;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat) return;
      const want = shortcutFor(e);
      if (!want) return;
      // An open dialog, sheet or drawer (aria-modal) keeps its keys.
      if (document.querySelector('[aria-modal="true"]')) return;
      if (want === "search" && !searchKeyHere(e)) return;
      if (want === "pane" && !paneKeyHere(e)) return;
      const r = live.current;
      if (want === "browser") {
        if (composingKey(e, false)) return;
        const st = history.state as EntryState | null;
        const back = typeof st?.from === "string" && docReach(st) > 0 && !/^\/browser(\/|\?|$)/.test(st.from) ? st.from : null;
        const to = browserKeyTarget(r, splitLive(), back);
        if (!to) return;
        e.preventDefault();
        if (to.close) closeTo(to.to);
        else navigate(to.to);
        return;
      }
      if (want === "pane") {
        if (closeFocusedPane(r)) e.preventDefault();
        return;
      }
      if (want === "side") {
        if (!searchKeyHere(e) || !sideKeyHere(r)) return;
        e.preventDefault();
        openSide(r);
        return;
      }
      e.preventDefault();
      if (want === "search") {
        openSearch(r);
        return;
      }
      if (want === "shortcuts") {
        navigate(href("setting", { section: "general", key: "shortcuts" }));
        return;
      }
      const { projects, chats } = getState();
      const to = stepChat(listedChats() ?? chatOrder(projects, chats), r.params.chat, want === "next" ? 1 : -1);
      if (to && to !== r.params.chat) navigate(href("chat", { chat: to }, { view: typeof r.query.view === "string" ? r.query.view : undefined }));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/**
 * Search's key acts here: not inside the Terminal pane, where Ctrl+K is the shell's key (the window listener skips it
 * whether or not xterm used it), and not while an input method composes.
 */
export function searchKeyHere(e: Pick<KeyboardEvent, "target" | "isComposing" | "keyCode">): boolean {
  if (composingKey(e, false)) return false;
  const t = e.target;
  return !(typeof Element !== "undefined" && t instanceof Element && t.closest(".term-pane, .xterm"));
}

/** Desktop's side chat key acts here: in a chat that is in the list, not archived, where the agent answers side questions. */
export function sideKeyHere(r: Route): boolean {
  const s = getState();
  const chat = r.params.chat ? s.chats.find((c) => c.id === r.params.chat) : undefined;
  return !!chat && !chat.archived && s.sideQuestions;
}

/**
 * Open the side chat from the key: the chat's side chat, or with it open, the focus in its box. U4: in a half of the
 * split too; else it opens by the opener rules.
 */
export function openSide(r: Route) {
  const chat = r.params.chat;
  if (!chat) return;
  if (sideShown(r) || kindShown(r, "side", splitLive())) {
    focusSideField();
    return;
  }
  openSideFocused();
  navigate(openHref(r, sideHref(chat, typeof r.query.view === "string" ? r.query.view : undefined)));
}

/**
 * Open search from the key: the open chat's search pane, else /search; with the pane open already, focus its field
 * and select its text (the field keeps the focus it has).
 */
export function openSearch(r: Route) {
  const chat = r.params.chat;
  const open = chat ? r.name === "chatSearch" || !!kindShown(r, "search", splitLive()) : r.name === "search";
  if (open) {
    focusSearchField(true);
    return;
  }
  openSearchFocused();
  const to = searchOpenHref(chat, typeof r.query.view === "string" ? r.query.view : undefined);
  navigate(chat ? openHref(r, to) : to);
}

// ---- U4: Desktop's Close focused pane

/**
 * Close focused pane acts here: not while an input method composes, and off macOS not inside the Terminal pane, where
 * Ctrl+backslash is the shell's quit key (on macOS the terminal passes Cmd+backslash on, terminal/xterm.ts).
 */
export function paneKeyHere(e: Pick<KeyboardEvent, "target" | "isComposing" | "keyCode">, mac: boolean = IS_MAC): boolean {
  if (composingKey(e, false)) return false;
  const t = e.target;
  return mac || !(typeof Element !== "undefined" && t instanceof Element && t.closest(".term-pane, .xterm"));
}

/** The element the pointer pressed last: a click on a part of a pane that takes no focus leaves the focus on the body. */
let pressed: { el: Element; at: number } | null = null;
const PRESS_MS = 60_000;
/** A pointer went down on `el` (null: on nothing the page knows): the page's listener, and the tests' stand-in. */
export function notePanePress(el: Element | null) {
  pressed = el ? { el, at: Date.now() } : null;
}
if (typeof document !== "undefined")
  document.addEventListener(
    "pointerdown",
    (e) => {
      notePanePress(e.target instanceof Element ? e.target : null);
    },
    true,
  );

/** Where the user is in the page: the focused element, else the one the pointer pressed last (while on the page). */
function focusedElement(): Element | null {
  const a = document.activeElement;
  if (a && a !== document.body) return a;
  return pressed && pressed.el.isConnected && Date.now() - pressed.at < PRESS_MS ? pressed.el : null;
}

/**
 * Close the side panel's view that holds the focus (DESIGN-U4 11): in a pair, that half (the other view takes the whole
 * pane); with one view, that view (the column goes to rest, the search pane back to where it opened from). False when
 * the focus is not in the side panel, and on the divider between two halves (its focus, or a drag of it, which leaves
 * the focus on the body and the divider the last press): the divider is no pane. The message box takes the focus
 * after it on a laptop when the closed view had it.
 */
export function closeFocusedPane(r: Route): boolean {
  const chat = r.params.chat;
  const at = typeof document === "undefined" ? null : focusedElement();
  if (!chat || !at?.closest("#fd-side, .side-over")) return false;
  const slot = at.closest("[data-half]")?.getAttribute("data-half");
  if (!slot && splitLive() && pairOf(r)) return false;
  const view = typeof r.query.view === "string" ? r.query.view : undefined;
  const pair = slot ? pairOf(r) : null;
  const half = pair ? halvesOf(pair).find((h) => h.slot === slot) : undefined;
  let to = half ? halfClose(half.route) : null;
  if (!to) {
    if (!paneKindOf(r.name)) return false;
    const st = history.state as EntryState | null;
    to = r.name === "chatSearch" ? closeHref(chat, view, typeof st?.from === "string" ? st.from : undefined, docReach(st) > 0) : href("chat", { chat }, { view });
  }
  closeTo(to);
  requestAnimationFrame(() => {
    const now = document.activeElement;
    if (now && now !== document.body && now.isConnected) return;
    if (!document.body.classList.contains("touch")) document.querySelector<HTMLElement>('[data-testid="composer"] [data-testid="composer-input"]')?.focus({ preventScroll: true });
  });
  return true;
}
