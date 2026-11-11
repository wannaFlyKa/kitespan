// The layouts (DESIGN.md 6.1, 6.2, 7.2, 7.3 and 5.3; the rules are shellLayout in size.ts):
//   laptop: the sidebar (docked from 1,000 px, else a drawer that /chats opens) | main | the side panel's column,
//     while the chat column keeps 520 px beside it; else a pane bar whose pane opens over the chat. "Hide session
//     rail" hides the column (a view preference); a side panel path still shows it.
//   medium touch: main | one docked pane (320 px from an 800 px window, else 40%) | the pane bar; the chat list in a
//     drawer
//   phone: top bar | main; the side cards open as a sheet
// The Terminal pane (D38, /c/<chat>/shell) takes the side panel's place: the laptop's column wherever the side panel
// docks, wider than the cards when there is room (terminalLayout in size.ts), else over the chat as the panel is; the
// medium docked pane; the phone's own page under the title bar. On every touch device the shell rides the on-screen
// keyboard while the pane has the focus (the phone's page whenever the keyboard is up), so the key bar stays above
// it (7.7, 7.8). Ctrl+backtick opens it with nothing typed and closes it (DESIGN.md 6.11).
// The chrome (prototype design plans v2 and v3): the title bar (--header-h, the look's height) and the sidebar, the
// drawers and the pane bar on a laptop and a tablet wear the look's material (layout.css: --material-bg and
// --material-filter, translucent in the glass look and solid in the others), with hairlines between the parts.
// Which pane is open is part of the URL: /c/<chat>/details and the card routes open it; closing goes back to /c/<chat>.
// The chat's search pane (/c/<chat>/search, v0.3 search, 9.3) takes the side panel's place too: the laptop's column, or
// over the chat as a layer where the panel opens over it; the medium docked pane, from the bar's Search button (lit
// while it is open); and on the phone its own page over the chat (Back "Chat" and "Search" in the title bar), with the
// chat mounted under it, hidden, as the Terminal page has it. On touch the search surfaces (that pane and the /search
// page) ride the on-screen keyboard as the Terminal pane does, so the end of a long list scrolls up above it (7.8).
// Row 82: on a laptop and a tablet the docked sidebar and the docked pane on the right (the cards' column, the search
// pane, the uploads and files, the Terminal pane, the tablet's docked pane) each have a width handle on their inner
// edge (ui/PaneHandle.tsx; the widths and their ranges from layout/panes.ts). One CSS variable per pane on the shell
// holds its width (--sidebar-w, --side-w, not inherited: layout.css) and the grid reads it; each handle holds its own
// place in px, so a drag moves the variable and the handle only, and restyles nothing under the shell. A pane over the
// chat has no handle; a pane that the other one holds at one width keeps it (its double-click takes its default's room
// back). On touch the handle starts under the title bar and shows a grip. The sidebar's Hide sidebar hides it (its room
// goes to the chat; Show sidebar in the title bar brings it back). The widths and the hidden sidebar are this device's
// own (ViewPrefs), never a URL. The phone has none.
// Row 93: the docked sidebar and the docked pane on the right slide as they open and close (layout/slide.ts).
// R124 (row 124): the side chat (/c/<chat>/btw) takes the side panel's place as the search pane does: the laptop's
// column (where, from U4, the session rail toggle reads Show session rail and brings the cards in above it), over the
// chat as a layer where the panel opens over it, the tablet's docked pane from the bar's fifth button, Side chat (lit
// while it is open), and on the phone its own sheet over the chat. On touch beside the chat it rides the on-screen
// keyboard while its box has the focus, as the search pane does.
// U4 (DESIGN-U4): where the side panel docks beside the chat (the laptop's column, the tablet's docked pane) it holds two
// views, one above the other, when the URL names a pair (layout/split.ts): each view in a half of its own, the Terminal
// always the lower one, the divider between them (SplitDivider.tsx). The column keeps its width rule (the Terminal's
// while it is a half), so the chat loses no width. Each view keeps its place in the tree by its kind, so the Terminal
// stays mounted while the view above it changes. Over the chat and on the phone the URL's own view shows alone.
// Iteration 7 (DESIGN-B1 4.1, D-13): the Browser, the side panel's seventh view kind (/c/<chat>/browser[/<tab>]), docks
// beside the chat only where its column is at least 420 px (browser/layout.ts); anywhere narrower it opens over the chat
// as a layer (a laptop: min of its rule and the chat column; medium touch: the whole width beside the pane bar), and on
// the phone it is a page of its own with the chat mounted under it. In a pair its column takes its own, wider, rule. Esc
// over the chat closes it unless a part of the pane takes the key (browser/escape.ts: the frame passes it to the page).
// Iteration 8 (touch, DESIGN-T1 2.6 and 2.7; layout/place.ts): on the large tablet (the laptop class with touch) a pane
// over the chat ends 8 px above the composer's dock at rest, with a foot of its own, and the dock (a taller box, a card
// in its place) draws over that foot; on medium touch where the docked pane would be under 320 px (626 and 768 px) a
// changes view opens over the chat at the whole width beside the pane bar, and the other half of its pair stays in the
// URL and in the docked pane under it, so closing the layer shows that half.
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { closeTo, href, navigate, setSameView, type Route } from "../router";
import { PANEL_ROUTES } from "../routes";
import { paneKindOf } from "../../shared/route";
import { act, getState, useStore } from "../state/store";
import { mediumPaneWidth, PANEL_W, terminalLayout, useLayoutPrefs, useShellLayout, useViewport, type SideMode } from "./size";
import { halfClose, halfName, halfTitle, halvesOf, kindToggle, pairOf, railShowHref, samePair, setSplitLive, shareOf, sideWidth, splitFolds, splitLive, splitRange, splitShows, type PaneKind, type Slot } from "./split";
import { SplitDivider } from "./SplitDivider";
import { PANE_BAR_W, PANE_BAR_W_TOUCH, paneRanges, resizable, restoreDefault, type PaneInput, type RightPane } from "./panes";
import { usePaneSlides } from "./slide";
import { changesPlace, nextRestMark, overPaneBottom, type RestMark } from "./place";
import { Sidebar, SIDEBAR_ID } from "./Sidebar";
import { TopBar } from "./TopBar";
import { Link, Scrim, useLayer } from "../ui/primitives";
import { PaneHandle } from "../ui/PaneHandle";
import { IconCards, IconFile, IconGlobe, IconSearch, IconSideChat, IconTerminal } from "../ui/icons";
import type { Chat } from "../state/types";
import { useFocusInside, useSoftKeyboard } from "../composer/keyboard";
import { TerminalPane } from "../terminal/TerminalPane";
import { terminalShown, terminalToggleTarget } from "../terminal/route";
import { existingSession, userInput } from "../terminal/session";
import { isTerminalToggle } from "../terminal/keys";
import { SearchPane, searchCloseTarget } from "../search/SearchPane";
import { SideChat } from "../side/SideChat";
import { sideHref, sideShown } from "../side/nav";
import { ChangesView } from "../changes/ChangesView";
import { CHANGES_ROUTES } from "../changes/nav";
import { BrowserPane } from "../browser/BrowserPane";
import { browserLayout } from "../browser/layout";
import { CHAT_BROWSER_ROUTES, browserToggle } from "../browser/nav";
import { escapeTaken } from "../browser/escape";
import { useBrowserDot } from "../browser/dot";

export type { SideMode, SidebarForm, ShellLayout } from "./size";
export { shellLayout, useShellLayout } from "./size";
// The paths that show the side panel: the details cards, their detail views, the chat's uploads and its files (D37).
export const SIDE_ROUTES = PANEL_ROUTES;

/** /c/<chat>/details as the chat's own URL (with the same query): the laptop's column shows the cards at both. */
const cardsHome = (url: string) => url.replace(/^(\/c\/[^/?#]+)\/details(?=$|\?)/, "$1");

const viewOf = (route: Route) => (typeof route.query.view === "string" ? route.query.view : undefined);

export const RAIL_HIDE = "Hide session rail";
export const RAIL_SHOW = "Show session rail";
/** The docked pane on the right's element id (its width handle's aria-controls). */
export const SIDE_ID = "fd-side";

/**
 * Keep a pane's width on this device; null puts its default back (a double-click), the other pane giving the room it
 * needs (panes.ts restoreDefault). A view preference: local storage, never a URL.
 */
function keepWidth(layout: PaneInput, pane: "sidebar" | RightPane, width: number | null) {
  const now = getState().view.widths;
  const widths = width === null ? restoreDefault({ ...layout, widths: now }, pane === "sidebar" ? "sidebar" : "right") : { ...now, [pane]: width };
  act.setView({ widths });
}

/** True inside a Shell that was given a side panel (a chat screen); a page such as the file download page has none. */
const ShellHasSide = createContext(false);

/**
 * The title bar's session rail toggle (DESIGN.md 6.2, Desktop's words "Hide session rail" and "Show session rail").
 * Null where the side panel is not a column (no chat, a narrow laptop, medium, phone) and on a page whose Shell has
 * no side panel. Call `toggle` in a click: it sets a view preference (local storage, not recorded) and, on a side
 * panel path, also goes back to the chat. U4 (DESIGN-U4 4.3): while the column holds a view and none of them is a
 * Details or Files view (the Terminal, the search pane, the side chat, or a pair of them), it reads Show session rail
 * and brings the cards into the upper half (split.ts railShowHref: the view alone, or a pair's lower half, below them);
 * while a Details or Files view is a half of a pair, Hide session rail closes that half and the device's rail choice
 * stays. `beside`: a view shows in the column.
 */
export function useRail(route: Route, chat?: Chat): { shown: boolean; label: string; toggle: () => void; beside: boolean } | null {
  const layout = useShellLayout();
  const hidden = useStore((s) => s.view.railHidden);
  const hasSide = useContext(ShellHasSide);
  if (!chat || !hasSide || layout.side !== "column") return null;
  const cards = href("details", { chat: chat.id }, { view: viewOf(route) });
  const showCards = { shown: false, label: RAIL_SHOW, beside: true, toggle: () => navigate(railShowHref(route, cards)) };
  const pair = pairOf(route);
  if (pair) {
    const panelHalves = halvesOf(pair).filter((h) => h.kind === "details" || h.kind === "files");
    const half = panelHalves.length > 1 ? pair.other : panelHalves[0];
    if (!half) return showCards;
    return { shown: true, label: RAIL_HIDE, beside: true, toggle: () => closeTo(halfClose(half.route) ?? cards) };
  }
  const own = terminalShown(route) ? "terminal" : route.name === "terminal" ? null : paneKindOf(route.name);
  if (own === "terminal" || own === "search" || own === "side" || own === "changes" || own === "browser") return showCards;
  const sideRoute = SIDE_ROUTES.has(route.name);
  const shown = !hidden || sideRoute;
  return {
    shown,
    label: shown ? RAIL_HIDE : RAIL_SHOW,
    beside: shown,
    toggle: () => {
      if (!shown) return act.setView({ railHidden: false });
      act.setView({ railHidden: true });
      if (sideRoute) closeTo(href("chat", { chat: chat.id }, { view: viewOf(route) }));
    },
  };
}

/**
 * The slim bar on the right edge (DESIGN.md 7.3). In v0.1 core it holds Details (the side panel's cards), Files
 * (the chat's uploads) and Terminal (the Terminal pane at a prompt, D38; Open in terminal in the session menu opens
 * it with the resume command typed); Search (the chat's search pane) joins with v0.3 search, and Browser with its
 * milestone. A tap opens that pane; a second tap closes it, going back when the entry before is the chat (5.1 rule 4),
 * so a closed pane leaves no history entry. On touch each button shows its name under the icon. The Terminal button
 * takes the focus when the Terminal pane closes and its opener is gone (data-terminal-home, TerminalPane.tsx).
 * U4: where the docked pane holds a pair (`live`), both its kinds are lit; a second tap on a lit one closes its half,
 * and an unlit one opens by the opener rules (layout/split.ts kindToggle).
 */
function PaneBar({ route, chat, names, live }: { route: Route; chat: Chat; names: boolean; live: boolean }) {
  const sideOn = useStore((s) => s.sideQuestions) && !chat.archived;
  const dot = useBrowserDot();
  const view = viewOf(route);
  const base = href("chat", { chat: chat.id }, { view });
  const toggle = (kind: PaneKind, to: string) => kindToggle(route, kind, to, live, base);
  const buttons = [
    { ...toggle("details", href("details", { chat: chat.id }, { view })), name: "Details", icon: <IconCards size={18} /> },
    { ...toggle("files", href("uploads", { chat: chat.id }, { view })), name: "Files", icon: <IconFile size={18} /> },
    { ...toggle("terminal", href("shell", { chat: chat.id }, { view })), name: "Terminal", icon: <IconTerminal size={18} />, home: true },
    { ...toggle("search", href("chatSearch", { chat: chat.id }, { view })), name: "Search", icon: <IconSearch size={18} /> },
    // R124: the side chat, after Search (only where the agent answers side questions; an archived chat has none).
    ...(sideOn ? [{ ...toggle("side", sideHref(chat.id, view)), name: "Side chat", closeName: "Close side chat", icon: <IconSideChat size={18} /> }] : []),
    // Iteration 7 (DESIGN-B1 4.1): the Browser, the sixth button, with the needs-you dot while a page waits (4.4).
    { ...browserToggle(route, chat.id, live), name: "Browser", closeName: "Close browser", icon: <IconGlobe size={18} />, dot: dot && !browserToggle(route, chat.id, live).on },
  ];
  return (
    <nav className={`pane-bar${names ? " with-names" : ""}`} aria-label="Side panes">
      {buttons.map((b) => (
        <Link
          key={b.name}
          to={b.to}
          close={b.close}
          className={`pane-bar-btn${b.on ? " on" : ""}${"dot" in b && b.dot ? " bp-has-dot" : ""}`}
          aria-label={names ? ("dot" in b && b.dot ? `${b.name}, the browser needs an answer` : undefined) : "dot" in b && b.dot ? `${b.name}, the browser needs an answer` : b.name}
          aria-current={b.on ? "page" : undefined}
          title={b.on ? ("closeName" in b ? b.closeName : `Close ${b.name}`) : b.name}
          data-terminal-home={"home" in b && b.home ? "" : undefined}
        >
          {b.icon}
          {"dot" in b && b.dot ? <span className="dot waiting bp-tool-dot" aria-hidden="true" /> : null}
          {names ? <span className="pane-bar-name">{b.name}</span> : null}
        </Link>
      ))}
    </nav>
  );
}

/**
 * Ctrl+backtick, Desktop's "Toggle terminal pane" (DESIGN.md 6.11, D38), on a chat screen: from the chat or one of its
 * side panel views it opens the Terminal pane with nothing typed, from the pane it closes it (terminal/route.ts
 * terminalToggleTarget). It acts inside the key press only; an open dialog, sheet or drawer keeps its keys, and the
 * terminal passes the key on to the page (terminal/xterm.ts).
 */
function useTerminalToggle(route: Route, chatId: string | null) {
  const live = useRef(route);
  live.current = route;
  useEffect(() => {
    if (!chatId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.isComposing || !isTerminalToggle(e)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const to = terminalToggleTarget(live.current, chatId, splitLive());
      if (!to) return;
      e.preventDefault();
      if (to.close) closeTo(to.to);
      else navigate(to.to);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chatId]);
}

/** A laptop narrower than 1,000 px: /chats opens the sidebar as a drawer over the page (DESIGN.md 6.1, 5.3). */
function SidebarDrawer({ route }: { route: Route }) {
  const box = useRef<HTMLElement>(null);
  const from = (history.state as { from?: string } | null)?.from;
  const parent = from && !/^\/chats(\?|$)/.test(from) ? from : "/";
  const close = () => closeTo(parent);
  useLayer({ active: true, box, onClose: close, modal: true });
  return createPortal(
    <>
      <Scrim onClick={close} />
      <aside ref={box} className="shell-drawer" role="dialog" aria-modal="true" aria-label="Chats" tabIndex={-1} data-testid="sidebar-drawer">
        <Sidebar route={route} drawer />
      </aside>
    </>,
    document.body,
  );
}

/** A view in the docked side: its kind (its place in the tree), its route, and its half in a pair. */
interface DockView {
  kind: PaneKind;
  route: Route;
  slot: Slot | null;
}

/** The upper half's element id (the divider's aria-controls). */
const HALF_ID: Record<Slot, string> = { upper: "fd-split-upper", lower: "fd-split-lower" };

export function Shell(props: { route: Route; chat?: Chat; side?: (mode: SideMode, route?: Route, reads?: boolean) => ReactNode; children: ReactNode; bare?: boolean }) {
  const { route, chat, side, children } = props;
  const vp = useViewport();
  const layout = useShellLayout();
  const prefs = useLayoutPrefs();
  const railHidden = useStore((s) => s.view.railHidden);
  const widths = useStore((s) => s.view.widths);
  const share = useStore((s) => s.view.split);
  const shellBox = useRef<HTMLDivElement>(null);
  const sideRoute = SIDE_ROUTES.has(route.name);
  const paneBox = useRef<HTMLElement>(null);
  const termBox = useRef<HTMLElement>(null);
  const mainBox = useRef<HTMLDivElement>(null);
  const sideBox = useRef<HTMLElement>(null);
  const browserBox = useRef<HTMLElement>(null);
  const changesBox = useRef<HTMLElement>(null);

  const phone = layout.size === "phone";
  const laptop = layout.size === "laptop";
  const docked = layout.sidebar === "docked";
  const panel = side && chat ? side : null;
  // U4: the pair the URL names, where the split shows (the laptop's column, the tablet's docked pane).
  const live = !!panel && splitShows(layout);
  // Iteration 7 (D-13): the Browser docks only where its column is at least 420 px; a pair with it shows only there.
  const browserPlace = panel ? browserLayout(vp, prefs, layout.paneBar) : null;
  const browserDocks = !!browserPlace && (browserPlace.form === "column" || browserPlace.form === "pane");
  const fullPair = useMemo(() => {
    const p = live ? pairOf(route) : null;
    return p && !browserDocks && (p.path.kind === "browser" || p.other.kind === "browser") ? null : p;
  }, [live, route, browserDocks]);
  // U1: a changes view, the URL's own (over the chat and on the phone, where one view shows).
  const changesRoute = CHANGES_ROUTES.has(route.name);
  // The tablet's docked pane (D26), a place of its own (not over the chat).
  const tabletPane = !phone && !!panel && layout.side === "pane" && !layout.paneOver;
  // T-17: the changes view over the chat on medium touch under 320 px of pane; its pair's other half docks under it.
  const changesOver = tabletPane && changesRoute && !route.fallbackFrom && changesPlace(vp) === "over";
  const pair = changesOver ? null : fullPair;
  const under = changesOver && fullPair ? fullPair.other : null;
  const pairHas = (kind: PaneKind) => (!!pair && (pair.path.kind === kind || pair.other.kind === kind)) || under?.kind === kind;
  const search = route.name === "chatSearch" || pairHas("search");
  const sideChat = sideShown(route) || pairHas("side");
  // The Browser as the URL's own view: docked by the views below, else over the chat, or the phone's page.
  const browserRoute = !!panel && CHAT_BROWSER_ROUTES.has(route.name) && !route.fallbackFrom;
  const browserPage = phone && browserRoute;
  const browserOver = !phone && browserRoute && !browserDocks;
  // The Terminal pane's place (size.ts terminalLayout); it is part of the chat screen, so the chat stays mounted.
  const term = panel && (terminalShown(route) || pairHas("terminal")) ? terminalLayout(vp, prefs) : null;
  const termCol = !phone && term?.form === "column";
  const termOver = !phone && term?.form === "over";
  const termPane = !phone && term?.form === "pane";
  const termPage = phone && !!term;
  // The on-screen keyboard (DESIGN.md 7.7, 7.8): the Terminal pane's key bar stays above it on every touch device.
  // While it is up the shell is as tall as the visual viewport and moved down by its offsetTop, as the composer's
  // wrapper is: the phone's page whenever the keyboard is up (the page covers the chat), the medium pane and the large
  // tablet's column or layer while the focus is in the pane (the composer beside it rides on its own). Styles only.
  const termTouch = !!term && vp.touch;
  const kb = useSoftKeyboard(termTouch);
  const termFocus = useFocusInside(".term-pane", termTouch && !phone);
  const riding = termTouch && kb.up && (phone || termFocus);
  // The search surfaces ride the same way (7.8: a bottom offset would land behind the keyboard), with their own watch
  // (never on with the Terminal's: a route shows one or the other): the phone's search page whenever the keyboard is
  // up (it covers the chat, as the Terminal page does), and elsewhere on touch (the medium pane, the large tablet's
  // column or layer, /search) while the focus is in the search.
  const searchTouch = vp.touch && ((search && !!panel) || route.name === "search");
  const searchKb = useSoftKeyboard(searchTouch);
  const searchFocus = useFocusInside(".srch", searchTouch && !phone);
  const searchRiding = !riding && searchTouch && searchKb.up && (phone || searchFocus);
  // The side chat beside the chat on touch (the tablet's pane, the large tablet's column or layer) rides the same way
  // while its box has the focus; the phone's sheet rides on its own (SideChat.tsx).
  const sideTouch = vp.touch && !phone && sideChat && !!panel;
  const sideKb = useSoftKeyboard(sideTouch);
  const sideFocus = useFocusInside(".sc", sideTouch);
  const sideRiding = !riding && !searchRiding && sideTouch && sideKb.up && sideFocus;
  // The Browser on touch rides the same way while its hidden field has the focus (DESIGN-B1 4.10): the key row on the keyboard.
  const browserTouch = vp.touch && !!panel && (browserRoute || pairHas("browser"));
  const browserKb = useSoftKeyboard(browserTouch);
  const browserFocus = useFocusInside(".bp", browserTouch);
  const browserRiding = !riding && !searchRiding && !sideRiding && browserTouch && browserKb.up && browserFocus;
  const ride = riding ? kb : searchRiding ? searchKb : sideRiding ? sideKb : browserRiding ? browserKb : null;
  const rideStyle = ride ? { height: ride.visualHeight, transform: `translateY(${ride.offsetTop}px)` } : undefined;
  const rideClass = `${riding ? " term-riding" : ""}${searchRiding ? " srch-riding" : ""}${sideRiding ? " sc-riding" : ""}${browserRiding ? " bp-riding" : ""}`;
  useTerminalToggle(route, panel && chat ? chat.id : null);
  // The laptop's column, as a place of its own (not over the chat).
  const columnLayout = !phone && !!panel && layout.side === "column";
  const pane = !phone && !!panel && layout.side === "pane" && sideRoute && !browserRoute;
  const bar = !phone && !!panel && layout.paneBar;
  const over = pane && layout.paneOver;
  const chatUrl = chat ? href("chat", { chat: chat.id }, { view: viewOf(route) }) : "/";
  // A pane over the chat is a layer: it covers the chat and its Stop, so Esc closes it first, wherever the focus is
  // (the pane bar's button that opened it, say), before Esc can reach the composer. A docked pane stays until its
  // button or Close.
  useLayer({ active: over, box: paneBox, onClose: () => closeTo(search && chat ? searchCloseTarget(chat.id, route) : chatUrl) });
  // The medium changes layer, as the changes view's own Close: to its pair's other half alone, else to the chat.
  const changesOwn = changesOver && fullPair ? fullPair.path.route : route;
  useLayer({ active: changesOver, box: changesBox, onClose: () => closeTo(halfClose(changesOwn) ?? chatUrl) });
  // The terminal over the chat is such a layer too, but Esc inside the terminal is the shell's key: the layer passes
  // it on to the shell then, and closes only when the focus is elsewhere (its Close button closes it too).
  useLayer({
    active: termOver,
    box: termBox,
    onClose: () => {
      const s = chat ? existingSession(chat.id) : undefined;
      const at = document.activeElement;
      if (s && at && termBox.current?.contains(at) && at.closest(".term-host")) userInput(s, "\x1b");
      else closeTo(chatUrl);
    },
  });
  // The Browser over the chat is a layer too; Esc goes to the part of the pane that holds it first (the frame passes it
  // to the page, a card is Cancel, a picker and More close), and only then closes the layer.
  useLayer({
    active: browserOver,
    box: browserBox,
    onClose: () => {
      if (!escapeTaken()) closeTo(chatUrl);
    },
  });
  // While the laptop's column shows the session rail, /c/<chat> and /c/<chat>/details look the same, so closing a
  // detail view to Details goes back to the chat's entry when that is the one before (no entry whose Back changes
  // nothing). The rule reads the rail's state when it runs: "Hide session rail" hides it first, then closes. U4: where
  // the split shows, the two spellings of one pair are one view too (split.ts samePair).
  useEffect(() => {
    if (!columnLayout && !live) return;
    setSameView((a, b) => (live && samePair(a, b)) || (columnLayout && !getState().view.railHidden && cardsHome(a) === cardsHome(b)));
    return () => setSameView(null);
  }, [columnLayout, live]);
  // The key handlers (Cmd K, Cmd ;, Ctrl+backtick, Close focused pane) read where the split shows.
  useLayoutEffect(() => {
    if (!panel) return;
    setSplitLive(live);
    return () => setSplitLive(false);
  }, [panel, live]);

  // The views of the docked side, top to bottom: a pair's two halves; else the one view (the Terminal, a side panel
  // view, or on a laptop the cards at rest while the session rail shows).
  const views: DockView[] = pair
    ? halvesOf(pair).map((h) => ({ kind: h.kind, route: h.route, slot: h.slot }))
    : under
      ? [{ kind: under.kind, route: under.route, slot: null }]
      : changesOver
        ? []
        : (columnLayout && termCol) || (tabletPane && termPane)
      ? [{ kind: "terminal", route, slot: null }]
      : (columnLayout || tabletPane) && sideRoute && !browserOver
        ? [{ kind: paneKindOf(route.name) ?? "details", route, slot: null }]
        : columnLayout && !railHidden && !browserOver
          ? [{ kind: "details", route, slot: null }]
          : [];
  const termDocked = views.some((v) => v.kind === "terminal");
  // U1: a diff is code, so a changes view (alone, or a half) gives the column the Terminal's width rule; the width the
  // user drags it to is the Terminal's own (one code width per device).
  const changesDocked = views.some((v) => v.kind === "changes");
  // The Browser's column takes its own rule (the widest of a pair's), and the width the user drags it to is its own.
  const browserDocked = views.some((v) => v.kind === "browser");
  // The docked pane on the right, if one shows beside the chat, and its default width (the Terminal's is its own).
  const docks = views.length > 0;
  const right: { pane: RightPane; def: number } | null = !docks
    ? null
    : browserDocked && browserPlace
      ? { pane: "browser", def: browserPlace.width }
      : changesDocked
      ? { pane: "term", def: sideWidth(vp, prefs, termDocked, true) }
      : termDocked
        ? { pane: "term", def: term!.width }
        : { pane: "side", def: laptop ? PANEL_W : mediumPaneWidth(vp.width) };
  const paneIn: PaneInput = { width: vp.width, touch: vp.touch, sidebar: docked, right, bar, widths };
  const widthOf = paneRanges(paneIn);
  // Row 93: the docked sidebar and the docked pane on the right slide as they open and close (slide.ts), the chat
  // column as wide as the window less the docked panes and the pane bar.
  const mainWidth = vp.width - (widthOf.sidebar?.now ?? 0) - (widthOf.right?.now ?? 0) - (bar ? (vp.touch ? PANE_BAR_W_TOUCH : PANE_BAR_W) : 0);
  usePaneSlides(
    shellBox,
    mainBox,
    {
      left: { open: docked, width: widthOf.sidebar?.now ?? 0, id: SIDEBAR_ID },
      right: { open: docks, width: widthOf.right?.now ?? 0, id: SIDE_ID, edge: bar ? "var(--pane-bar-w)" : undefined, bar: bar ? (vp.touch ? PANE_BAR_W_TOUCH : PANE_BAR_W) : 0 },
    },
    mainWidth,
    !phone,
    vp.width,
  );
  // The split's height: the column's own, measured (a short window, the on-screen keyboard), else the window's.
  const colHeight = useColumnHeight(sideBox, !!pair, ride ? ride.visualHeight : vp.height);
  // The half that folds to its head (DESIGN-U4 7, 8): on touch while the on-screen keyboard is up, the one without the
  // focus; in a column too short for two halves, the one not used last.
  const splitKb = useSoftKeyboard(!!pair && vp.touch);
  const upperFocus = useFocusInside(`#${HALF_ID.upper}`, !!pair && vp.touch);
  const lowerFocus = useFocusInside(`#${HALF_ID.lower}`, !!pair && vp.touch);
  const fold: Slot | null = !pair ? null : splitKb.up && (upperFocus || lowerFocus) ? (upperFocus ? "lower" : "upper") : splitFolds(colHeight, vp.touch) ? pair.other.slot : null;
  const range = splitRange(colHeight, vp.touch, share);
  // T-15: where a pane over the chat ends on the large tablet (place.ts), from the dock's rest height.
  const overShown = over || browserOver || termOver;
  const rest = useDockRest(mainBox, shellBox, laptop && vp.touch && overShown, vp.width, chat ? `${chat.id}:${chat.archived ? "archived" : chat.pending.length ? "card" : "box"}` : "");
  const overBottom = overPaneBottom({ size: layout.size, touch: vp.touch, rest, riding: !!ride });
  const overFoot = overBottom > 0 ? " side-over-above" : "";
  const keepTop = (top: number | null) => act.setView({ split: top === null ? undefined : shareOf(top, colHeight) });

  if (phone) {
    // The terminal's page: the chat stays mounted under it (hidden), so Back finds it as it was; while the keyboard
    // is up the page is as tall as the visual viewport, so the key bar sits above the keyboard (DESIGN.md 7.8).
    return (
      <ShellHasSide.Provider value={!!panel}>
        <div
          className={`shell shell-phone${rideClass}`}
          style={rideStyle}
          data-sidebar="screen"
          data-side="sheet"
          data-terminal={termPage ? "page" : undefined}
          data-search={search && panel ? "page" : undefined}
          data-browser={browserPage ? "page" : undefined}
        >
          <TopBar route={route} chat={chat} />
          <main className="main">
            {termPage ? <TerminalPane chat={chat!} route={route} mode="page" /> : null}
            {search && panel ? <SearchPane route={route} chat={chat!} place="page" /> : null}
            {browserPage ? <BrowserPane route={route} chat={chat!} mode="page" /> : null}
            {children}
          </main>
          {side && sideRoute && !search && !changesRoute && !browserRoute ? sideChat && chat ? <SideChat chat={chat} route={route} place="sheet" /> : side("sheet") : null}
        </div>
      </ShellHasSide.Provider>
    );
  }

  const paneVars = {
    "--sidebar-w": widthOf.sidebar ? `${widthOf.sidebar.now}px` : undefined,
    "--side-w": widthOf.right ? `${widthOf.right.now}px` : undefined,
  } as CSSProperties;
  const cols = [docked ? "var(--sidebar-w)" : "", "minmax(0, 1fr)", docks ? "var(--side-w)" : "", bar ? "var(--pane-bar-w)" : ""].filter(Boolean).join(" ");
  const sideId = docks ? SIDE_ID : undefined;
  // The docked side's class: its place (the laptop's column, the tablet's pane) and, with one view, that view's own
  // (the search pane, the side chat and the Terminal scroll inside themselves); a pair is a split of two halves.
  const place = laptop ? "side-col" : "side-pane";
  const one = views.length === 1 ? views[0]!.kind : null;
  const sideClass = pair ? `${place} split` : `${place}${one === "search" ? " srch-col" : one === "side" ? " sc-col" : one === "changes" ? " chg-col" : one === "browser" ? " bp-col" : one === "terminal" ? (laptop ? " term-col" : " term-docked") : ""}`;
  const mode = laptop ? "column" : "pane";
  // A pair's rows: the upper half's height (--split-top, registered as not inherited: layout.css), or a folded half's
  // head, and the lower half takes the rest.
  const rows = !pair ? undefined : fold === "upper" ? "calc(var(--header-h) + 1px) minmax(0, 1fr)" : fold === "lower" ? "minmax(0, 1fr) calc(var(--header-h) + 1px)" : "var(--split-top) minmax(0, 1fr)";
  const splitStyle = pair ? ({ "--split-top": `${range.now}px`, gridTemplateRows: rows } as CSSProperties) : undefined;
  // The side panel's cards read Context and Connectors once, also where both halves are side panel views.
  const reader = views.find((v) => v.kind === "details" || v.kind === "files");
  const viewNode = (v: DockView) =>
    v.kind === "terminal" ? (
      <TerminalPane chat={chat!} route={v.route} mode={mode} />
    ) : v.kind === "search" ? (
      <SearchPane route={v.route} chat={chat!} place={mode} />
    ) : v.kind === "side" ? (
      <SideChat chat={chat!} route={v.route} place={mode} />
    ) : v.kind === "changes" ? (
      <ChangesView chat={chat!} route={v.route} place={mode} />
    ) : v.kind === "browser" ? (
      <BrowserPane chat={chat!} route={v.route} mode={mode} />
    ) : (
      panel!(mode, v.route, v === reader)
    );
  const upper = pair ? halvesOf(pair)[0] : null;
  // A folded half shows its head alone (DESIGN-U4 7, 8). A Details or Files view has no head of its own on a laptop,
  // nor in the tablet's half the cards, Uploads and a file (SidePanel.tsx): there the fold is a one-row head with the
  // view's name, a file's own name, and no link.
  const foldHead = (v: DockView) =>
    fold && fold === v.slot && (v.kind === "details" || v.kind === "files") && (laptop || v.route.name === "details" || v.route.name === "uploads" || v.route.name === "files") ? (
      <div className="split-fold-head" aria-hidden="true">
        {halfName(v.route)}
      </div>
    ) : null;
  const dockChildren: ReactNode[] = [];
  views.forEach((v, i) => {
    if (i === 1 && upper && !fold)
      dockChildren.push(<SplitDivider key="divider" range={range} label={`${halfTitle(upper.route)} height`} controls={HALF_ID.upper} host={sideBox} touch={vp.touch} onTop={keepTop} testId="split-divider" />);
    dockChildren.push(
      <div key={v.kind} id={v.slot ? HALF_ID[v.slot] : undefined} className={`split-half${v.slot ? ` split-${v.slot}` : ""}${fold && fold === v.slot ? " is-folded" : ""}`} data-half={v.slot ?? undefined} data-kind={v.kind}>
        {foldHead(v)}
        {viewNode(v)}
      </div>,
    );
  });
  return (
    <ShellHasSide.Provider value={!!panel}>
      <div
        ref={shellBox}
        className={`shell ${laptop ? "shell-laptop" : "shell-medium"}${laptop && layout.side === "column" ? " shell-wide" : ""}${rideClass}`}
        style={{ gridTemplateColumns: cols, ...paneVars, ...rideStyle }}
        data-sidebar={layout.sidebar}
        data-side={changesOver ? "over" : docks && laptop ? "column" : pane ? (over ? "over" : "pane") : docks ? "pane" : "none"}
        data-terminal={term && !phone ? term.form : undefined}
        data-split={pair ? (fold ? `folded-${fold}` : "two") : undefined}
        data-browser={browserOver ? "over" : browserDocked ? "docked" : undefined}
        data-over={overBottom > 0 ? "above" : undefined}
      >
        {docked ? <Sidebar route={route} /> : null}
        {resizable(widthOf.sidebar) ? (
          <PaneHandle range={widthOf.sidebar} grow="right" label="Sidebar width" controls={SIDEBAR_ID} cssVar="--sidebar-w" host={shellBox} grip={vp.touch} onWidth={(w) => keepWidth(paneIn, "sidebar", w)} testId="pane-handle-sidebar" />
        ) : null}
        <div ref={mainBox} className={`main-col${props.bare ? " main-col-bare" : ""}`}>
          {props.bare ? null : <TopBar route={route} chat={chat} />}
          <main className="main">{children}</main>
        </div>
        {right && resizable(widthOf.right) ? (
          <PaneHandle
            range={widthOf.right}
            grow="left"
            label="Side pane width"
            controls={SIDE_ID}
            cssVar="--side-w"
            host={shellBox}
            offset={bar ? "var(--pane-bar-w)" : undefined}
            grip={vp.touch}
            onWidth={(w) => keepWidth(paneIn, right.pane, w)}
            testId="pane-handle-side"
          />
        ) : null}
        {docks ? (
          <aside ref={sideBox} id={sideId} className={sideClass} style={splitStyle}>
            {dockChildren}
          </aside>
        ) : null}
        {over ? (
          <aside
            ref={paneBox}
            className={`side-pane side-over${search ? " srch-col" : sideChat ? " sc-col" : changesRoute ? " chg-col" : ""}${overFoot}`}
            style={{ width: changesRoute ? `min(${sideWidth(vp, prefs, false, true)}px, calc(100% - ${bar ? "var(--pane-bar-w)" : "0px"}))` : undefined, bottom: overBottom || undefined }}
          >
            {search ? <SearchPane route={route} chat={chat!} place="over" /> : sideChat ? <SideChat chat={chat!} route={route} place="over" /> : changesRoute ? <ChangesView chat={chat!} route={route} place="over" /> : panel!("pane")}
          </aside>
        ) : null}
        {browserOver && browserPlace ? (
          <aside ref={browserBox} className={`side-pane side-over bp-over-chat${overFoot}`} style={{ width: `min(${browserPlace.width}px, calc(100% - ${bar ? "var(--pane-bar-w)" : "0px"}))`, right: bar ? undefined : 0, bottom: overBottom || undefined }} data-testid="browser-over">
            <BrowserPane route={route} chat={chat!} mode="over" />
          </aside>
        ) : null}
        {termOver ? (
          <aside ref={termBox} className={`side-pane side-over term-over${overFoot}`} style={{ width: `min(${term!.width}px, calc(100% - ${bar ? "var(--pane-bar-w)" : "0px"}))`, right: bar ? undefined : 0, bottom: overBottom || undefined }}>
            <TerminalPane chat={chat!} route={route} mode="over" />
          </aside>
        ) : null}
        {changesOver ? (
          <aside ref={changesBox} className="side-pane side-over chg-col chg-over-chat" data-testid="changes-over">
            <ChangesView chat={chat!} route={changesOwn} place="over" />
          </aside>
        ) : null}
        {bar ? <PaneBar route={route} chat={chat!} names={vp.touch} live={live} /> : null}
        {laptop && !docked && route.name === "chats" ? <SidebarDrawer route={route} /> : null}
      </div>
    </ShellHasSide.Provider>
  );
}

// The dock's rest mark (place.ts), kept for the page: a chat opened again at the same width finds it.
let restMark: RestMark | null = null;

/**
 * T-15: the composer's dock at rest, from its top to the shell's foot (place.ts nextRestMark), while `on` (a pane over
 * the chat on the large tablet). Measured as it is laid out, and again when it resizes; `dock` names the dock that
 * shows (the chat, and its composer, card or Unarchive bar), so a new one is measured too. A dock that rides the
 * on-screen keyboard is not at rest. Null until a dock is measured at this width.
 */
function useDockRest(main: RefObject<HTMLElement | null>, shell: RefObject<HTMLElement | null>, on: boolean, width: number, dock: string): number | null {
  const [rest, setRest] = useState<number | null>(null);
  useLayoutEffect(() => {
    const col = main.current;
    const host = shell.current;
    if (!on || !col || !host) return;
    const el = col.querySelector<HTMLElement>(".cmp-dock") ?? col.querySelector<HTMLElement>(".chat-dock");
    const measure = () => {
      if (el && el.isConnected && !el.matches(".is-riding") && !el.querySelector(".is-riding")) restMark = nextRestMark(restMark, width, host.getBoundingClientRect().bottom - el.getBoundingClientRect().top);
      const now = restMark && restMark.width === width ? restMark.height : null;
      setRest((p) => (p === now ? p : now));
    };
    measure();
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [main, shell, on, width, dock]);
  return on ? rest : null;
}

/**
 * The docked side's height while it holds a pair: measured from the column (a ResizeObserver), else `fallback` (the
 * window's, or the visual viewport's while the shell rides the on-screen keyboard) before the first measure.
 */
function useColumnHeight(box: RefObject<HTMLElement | null>, on: boolean, fallback: number): number {
  const [h, setH] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!on || !el) {
      setH(null);
      return;
    }
    setH(el.clientHeight || null);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setH(el.clientHeight || null));
    ro.observe(el);
    return () => ro.disconnect();
  }, [box, on]);
  return h ?? fallback;
}
