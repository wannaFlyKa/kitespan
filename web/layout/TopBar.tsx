// The top bar (DESIGN.md 6.2, 7.2 and 7.3; plan v3): on the look's material (layout.css), --header-h high.
//   laptop, in a chat: the title bar (the look's height; 44 px on touch). R124: Side chat before Open in terminal
//     (Desktop's name; its tooltip names the key, Cmd+; on macOS and Ctrl+; elsewhere), lit and named Close side chat
//     while the side chat is open; none on an archived chat, or where the agent answers no side question. The title (a click turns it into a field:
//     /c/<chat>/rename), the caret that opens the session menu, a state dot for Needs input and Failed only (M2: no
//     state word; the bar's text for a screen reader says the state), and the chat's folder, as the link to its
//     project, only while the side panel is hidden (M3: the Environment card names it otherwise); on the right Open in
//     terminal (the Terminal pane with the resume command typed, D38; while the pane is open it closes it; with a
//     pane bar, the bar's Terminal button has its place) and Hide session rail or Show session rail (while the side
//     panel is a column). Under 1,000 px the sidebar is a drawer, so the bar starts with the chats button; where the
//     user hid the docked sidebar (row 82), with Show sidebar (on every laptop screen, not only a chat's).
//   medium touch and phone, in a chat: a 44 px header with the chats button, the title (a tap renames; the dot only
//     for Needs input and Failed) and the menu button; the phone adds the context ring, which opens Details at
//     Context.
//   U4: where the side panel splits (the laptop's column), Side chat and Open in terminal are lit while a half shows
//     their view, and close that half; unlit, they open it by the opener rules (beside the view that shows).
//   phone, a chat's uploads and file screens, its Terminal page and its search pane (v0.3 search): their own screen
//     over the chat (5.3), so the header holds Back to the chat ("Chat", its name visible as 7.7 asks) and the
//     screen's name.
//   phone and medium touch, /search: its own screen, so the header holds Back to the screen before it and the name
//     "Search" (a laptop has Esc and the sidebar).
//   phone, Settings: one header, as iOS has one nav bar: the list's has Done at the right (back to where the user came
//     from), a section's has Back to the list.
//   /p/<project>/environment and a session's preview (/p/<project>/session/<id>): Back to the project, named by it, in
//     the chats button's and the title's place at every size, since a home-screen app has no browser Back (FIX-U6);
//     opened from a chat in this page (its Details, a refused start's Environment button), Back to that chat ("Chat").
//   any other screen: the screen's title, after the chats button wherever the chat list is not docked; none where the
//     page names itself (M31: Home, /new, a project page, the later routes' pages, /search, whose field says what it
//     finds, and a laptop's /chats, whose main column is Home). The phone's /chats screen is the list itself: its bar says "Chats"
//     and has the Search button (v0.3 search) and the compose button (Desktop's "New", D46) at the right, as the
//     sidebar has them beside "kitespan".
//   Iteration 7 (DESIGN-B1 4.1, 4.4): the laptop's Browser tool after Open in terminal (lit and named Close browser while
//     the Browser shows; its tooltip names Cmd+Shift+B), with the needs-you dot while a page waits for an answer in a tab
//     that no view shows; the phone's Browser page has Back "Chat" and "Browser" (its chip at the right); the phone's
//     chat list bar has a Browser button beside Search and New.
//   Iteration 8 (touch, DESIGN-T1 2.1, 2.3, 2.4, 2.6): a long press on the chat title opens the session menu (the
//     phone's sheet; under the title on a tablet and the large tablet), and so does a right-click on a laptop; a tap
//     still renames, and the title is no link a finger can drag or call out. On touch the bars' tools that open a place
//     show their names: the phone's /chats bar (Search, Browser, New), the chats button ("Chats", while its band is at
//     least 400 px: screens.css), the title bar's tools. Wherever the sidebar is hidden the title bar has Search. A bar
//     whose named tools would cut its heading, or leave the title less than its width or 40% of the band (the large
//     tablet's column form), drops their words (ui/barRoom.ts).
// Bar buttons wear --bar-tint where a look sets it (iOS tints them), else --text: no accent on resting chrome (6.13).
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { closeTo, currentUrl, docReach, href, navigate, parsePath, type EntryState, type Route } from "../router";
import { useStore } from "../state/store";
import type { Chat } from "../state/types";
import { useShellLayout, useViewport, type SidebarForm } from "./size";
import { useRail } from "./Shell";
import { PANE_ROUTES, PANEL_ROUTES } from "../routes";
import { Link, useLongPress } from "../ui/primitives";
import { useBarRoom } from "../ui/barRoom";
import { IconBack, IconChats, IconChevron, IconCompose, IconMore, IconPanel, IconSideChat, IconTerminal } from "../ui/icons";
import { IS_MAC, keyLabel } from "../ui/shortcuts";
import { sideHref } from "../side/nav";
import { kindToggle, splitShows } from "./split";
import { SessionMenu } from "../dialogs/SessionMenu";
import { RenameForm } from "../dialogs/RenameForm";
import { chatsHref } from "../screens/ChatListBody";
import { barState, chatHref, MARKED, STATE_WORD, StateDot, usePopupFocus, viewOf } from "../screens/common";
import { closeSettings } from "../screens/settingsHistory";
import { openInTerminalHref, terminalShown } from "../terminal/route";
import { contextMeter, useContextRead } from "../composer/ContextRing";
import { closeHref } from "../search/nav";
import { SearchButton } from "./SearchButton";
import { SidebarToggle } from "./Sidebar";
import { BG_VIEW_ROUTES } from "../chat/seen";
import { BG_HEADING, bgBarMark, type BgBarMark } from "../chat/background";
import { CHAT_BROWSER_ROUTES, browserToggle } from "../browser/nav";
import { NEEDS_WORDS, useBrowserDot } from "../browser/dot";
import { BrowserButton } from "../browser/BrowserButton";
import { IconGlobe } from "../ui/icons";

/** The chat's paths that the phone shows as their own screen over the chat (DESIGN.md 5.3). */
const OVER_CHAT: Record<string, string> = { uploads: "Uploads", files: "Files", chatSearch: "Search" };
const SETTINGS_ROUTES = new Set(["settings", "settingsSection", "setting", "settingsDevice", "restart"]);

export function TopBar({ route, chat }: { route: Route; chat?: Chat }) {
  const vp = useViewport();
  const phone = vp.size === "phone";
  if (!chat) {
    if (phone && SETTINGS_ROUTES.has(route.name)) return <SettingsBar route={route} />;
    if (vp.size !== "laptop" && route.name === "search") return <SearchScreenBar />;
    return <ScreenBar route={route} />;
  }
  if (phone && (OVER_CHAT[route.name] || terminalShown(route) || CHAT_BROWSER_ROUTES.has(route.name))) return <OverChatBar route={route} chat={chat} />;
  return vp.size === "laptop" ? <LaptopChatBar route={route} chat={chat} /> : <TouchChatBar route={route} chat={chat} />;
}

/**
 * The chat title's press (DESIGN-T1 2.1): the long press's handlers for the element around the title, which wears the
 * pressed wash while the finger rests (screens.css, from the hook's data-pressing).
 */
function useTitlePress(open: () => void) {
  const { onPointerDown, onPointerUp, onPointerCancel, onPointerMove, onContextMenu, onClickCapture } = useLongPress(open);
  return { onPointerDown, onPointerUp, onPointerCancel, onPointerMove, onContextMenu, onClickCapture };
}

/** A plain click that the page handles itself (not a new tab or window). */
const plainClick = (e: MouseEvent) => !(e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey);

/** Back with its name (7.7: on touch an icon button shows its name): closes this screen to its parent with closeTo. */
function BackButton({ to, label, aria }: { to: string; label: string; aria?: string }) {
  return (
    <a
      href={to}
      className="scr-bar-back"
      aria-label={aria}
      onClick={(e) => {
        if (!plainClick(e)) return;
        e.preventDefault();
        closeTo(to);
      }}
    >
      <IconBack size={20} />
      <span>{label}</span>
    </a>
  );
}

/** The phone's uploads and file screens: Back returns to the chat, and the header names the screen. */
function OverChatBar({ route, chat }: { route: Route; chat: Chat }) {
  return (
    <header className="topbar scr-bar scr-bar-touch" data-testid="topbar">
      <BackButton to={chatHref("chat", chat.id, route)} label="Chat" aria={`Back to ${chat.title}`} />
      <span className="scr-bar-heading">{terminalShown(route) ? "Terminal" : CHAT_BROWSER_ROUTES.has(route.name) ? "Browser" : OVER_CHAT[route.name]}</span>
    </header>
  );
}

/** The /search screen on touch: Back to the screen before it (the chat list when none of this page is behind it). */
function SearchScreenBar() {
  const st = (typeof history !== "undefined" ? history.state : null) as EntryState | null;
  const before = closeHref(null, undefined, typeof st?.from === "string" ? st.from : undefined, docReach(st) > 0);
  return (
    <header className="topbar scr-bar scr-bar-touch" data-testid="topbar">
      <BackButton to={before === "/" ? href("chats") : before} label="Back" />
      <span className="scr-bar-heading">Search</span>
    </header>
  );
}

/** The phone's Settings: the list's header has its title and Done (back over the Settings entries, settingsHistory); a
 * section's has Back to the list. */
function SettingsBar({ route }: { route: Route }) {
  if (route.name !== "settings")
    return (
      <header className="topbar scr-bar scr-bar-touch" data-testid="topbar">
        <BackButton to={href("settings")} label="Settings" />
      </header>
    );
  return (
    <header className="topbar scr-bar scr-bar-touch" data-testid="topbar">
      <span className="scr-bar-heading">Settings</span>
      <button type="button" className="scr-bar-done" data-testid="settings-done" onClick={closeSettings}>
        Done
      </button>
    </header>
  );
}

function LaptopChatBar({ route, chat }: { route: Route; chat: Chat }) {
  const vp = useViewport();
  const layout = useShellLayout();
  const rail = useRail(route, chat);
  const [menu, setMenu] = useState<false | "caret" | "title">(false);
  const titleWrap = useRef<HTMLSpanElement>(null);
  const caret = useRef<HTMLButtonElement>(null);
  const band = useRef<HTMLElement>(null);
  usePopupFocus(!!menu, "session-menu", menu === "title" ? titleWrap : caret);
  // The title's long press (touch) and right-click open the session menu under it; the click that ends a press is
  // swallowed, so it does not rename.
  const press = useTitlePress(() => setMenu("title"));
  const project = useStore((s) => s.projects.find((p) => p.id === chat.projectId));
  const renaming = route.name === "rename";
  const sideOn = useStore((s) => s.sideQuestions) && !chat.archived;
  // U4: where the side panel splits, each tool is lit while a half shows its view, and closes that half; unlit, it
  // opens its view by the opener rules (layout/split.ts kindToggle).
  const live = splitShows(layout);
  const own = chatHref("chat", chat.id, route);
  const side = kindToggle(route, "side", sideHref(chat.id, viewOf(route)), live, own);
  const termTool = kindToggle(route, "terminal", openInTerminalHref(chat.id, viewOf(route)), live, own);
  const term = termTool.on;
  const browser = browserToggle(route, chat.id, live);
  const dot = useBrowserDot() && !browser.on;
  // M3: the folder only while no side panel or pane shows beside the chat (the Environment card or the Terminal
  // pane's header names it then).
  const sideShown = rail ? rail.beside : PANEL_ROUTES.has(route.name) || terminalShown(route);
  useEffect(() => setMenu(false), [route.name, chat.id]); // a menu never outlives the state it was opened over
  // R131: a background session that needs you, or whose end no one saw, in the chat's own bar: where the list's dot points.
  const mark = MARKED.has(barState(chat)) ? null : bgBarMark(chat, viewOf(route));
  const tools = !renaming && !layout.paneBar;
  // T-28: on touch the title keeps its width or 40% of the band, else the tools drop their words.
  useBarRoom(band, "title", vp.touch && tools, `${chat.title}|${layout.sidebar}`);
  return (
    <header ref={band} className="topbar scr-bar" data-testid="topbar">
      {layout.sidebar === "drawer" ? <ChatsButton back={false} /> : layout.sidebar === "hidden" ? <SidebarToggle hide={false} /> : null}
      {renaming ? (
        <RenameForm key={`${chat.id}:${String(route.query.title ?? "")}`} chat={chat} route={route} inline testId="dialog-rename" />
      ) : (
        <div className="scr-bar-chat">
          <span className="scr-bar-titlewrap" ref={titleWrap} {...press}>
            <Link to={chatHref("rename", chat.id, route)} className="scr-bar-title" title={vp.touch ? undefined : "Rename"} dir="auto" draggable={false}>
              {chat.title}
            </Link>
            <button ref={caret} type="button" className="icon-btn scr-bar-caret" aria-label="Session menu" title="Session menu" aria-haspopup="dialog" aria-expanded={menu === "caret"} onClick={() => setMenu((v) => (v ? false : "caret"))}>
              <IconChevron />
            </button>
          </span>
          <span className={`scr-bar-state scr-state-${barState(chat)}`}>
            {MARKED.has(barState(chat)) ? <StateDot state={barState(chat)} /> : null}
            <span className="visually-hidden">{STATE_WORD[barState(chat)]}</span>
          </span>
          {mark ? <BgBarMarkLink mark={mark} /> : null}
          {project && !sideShown ? (
            <Link to={href("project", { project: project.id })} className="scr-bar-folder mono" title={`Project ${project.name}`}>
              {project.folder}
            </Link>
          ) : null}
        </div>
      )}
      {/* With a pane bar, its Terminal button holds Open in terminal, and the side panel opens from the bar too. */}
      {tools ? (
        <div className="scr-bar-tools">
          {/* T-10: Search wherever the sidebar, which holds it, is hidden. */}
          {layout.sidebar === "hidden" ? <SearchButton route={route} named={vp.touch ? "beside" : undefined} className={vp.touch ? undefined : "scr-bar-icon"} testId="topbar-search" /> : null}
          {sideOn ? (
            <BarTool
              to={side.to}
              close={side.close}
              on={side.close}
              label={side.close ? "Close side chat" : "Side chat"}
              tip={side.close ? "Close side chat" : `Side chat (${keyLabel(";")})`}
              keys={IS_MAC ? "Meta+;" : "Control+;"}
              named={vp.touch}
              icon={<IconSideChat size={18} />}
            />
          ) : null}
          <BarTool
            to={termTool.to}
            close={term}
            on={term}
            label={term ? "Close terminal" : "Open in terminal"}
            named={vp.touch}
            icon={<IconTerminal size={18} />}
            terminalHome
          />
          <BarTool
            to={browser.to}
            close={browser.close}
            on={browser.on}
            label={browser.on ? "Close browser" : dot ? `Browser${NEEDS_WORDS}` : "Browser"}
            tip={browser.on ? "Close browser" : dot ? "Browser: the browser needs an answer" : `Browser (${IS_MAC ? "Cmd" : "Ctrl"}+Shift+B)`}
            keys={IS_MAC ? "Meta+Shift+B" : "Control+Shift+B"}
            named={vp.touch}
            icon={<IconGlobe size={18} />}
            dot={dot}
            testId="topbar-browser"
          />
          {rail ? <BarTool onClick={rail.toggle} label={rail.label} named={vp.touch} icon={<IconPanel size={18} />} testId="topbar-rail" /> : null}
        </div>
      ) : null}
      <SessionMenu open={!!menu} onClose={() => setMenu(false)} anchor={titleWrap} chat={chat} route={route} />
    </header>
  );
}

/**
 * R131: the chat's background sessions in its own bar (chat/background.ts bgBarMark): the dot that the chat's row shows
 * in the list (the warm pulse while a session needs input; Reduce motion stops it), as a link to that session, its view
 * or else its launch row opened in place. A screen reader hears which session; on a laptop the pointer reads it as the
 * title. With nothing to open yet (its row is not drawn), the dot alone, named.
 */
function BgBarMarkLink({ mark }: { mark: BgBarMark }) {
  const dot = <span className={`dot ${mark.dot}`} aria-hidden="true" />;
  return mark.to ? (
    <Link to={mark.to} className="icon-btn scr-bar-bg" aria-label={mark.said} title={mark.said} data-testid="bar-bg">
      {dot}
    </Link>
  ) : (
    <span className="scr-bar-bg" role="img" aria-label={mark.said} data-testid="bar-bg">
      {dot}
    </span>
  );
}

/** A title bar button: the icon, its name on hover, and the name as text on touch, where there is no hover (6.2). */
function BarTool(props: { to?: string; close?: boolean; on?: boolean; onClick?: () => void; label: string; tip?: string; keys?: string; named: boolean; icon: ReactNode; testId?: string; terminalHome?: boolean; dot?: boolean }) {
  const { to, close, on, onClick, label, tip, keys, named, icon, testId, terminalHome, dot } = props;
  const className = `${named ? "btn ghost scr-bar-tool" : "icon-btn scr-bar-icon"}${on ? " on" : ""}${dot ? " bp-has-dot" : ""}`;
  const inner = (
    <>
      {icon}
      {dot ? <span className="dot waiting bp-tool-dot" aria-hidden="true" /> : null}
      {named ? <span>{label.replace(NEEDS_WORDS, "")}</span> : null}
    </>
  );
  if (to)
    return (
      <Link to={to} close={close} className={className} aria-label={named && !dot ? undefined : label} aria-current={on ? "page" : undefined} aria-keyshortcuts={keys} title={named ? undefined : (tip ?? label)} data-terminal-home={terminalHome ? "" : undefined} data-testid={testId}>
        {inner}
      </Link>
    );
  return (
    <button type="button" className={className} aria-label={named ? undefined : label} title={named ? undefined : label} data-testid={testId} onClick={onClick}>
      {inner}
    </button>
  );
}

function TouchChatBar({ route, chat }: { route: Route; chat: Chat }) {
  const vp = useViewport();
  const phone = vp.size === "phone";
  const [menu, setMenu] = useState<false | "more" | "title">(false);
  const more = useRef<HTMLButtonElement>(null);
  const title = useRef<HTMLSpanElement>(null);
  usePopupFocus(!!menu, "session-menu", menu === "title" ? title : more);
  // A long press on the title opens the session menu (the phone's sheet; under the title on a tablet); a tap renames.
  const press = useTitlePress(() => setMenu("title"));
  const renaming = route.name === "rename" && !phone; // the phone renames in a sheet (ChatDialogs)
  // Iteration 7 (F20): on the phone the session menu holds the Browser, so its button wears the needs-you dot too.
  const dot = useBrowserDot() && phone;
  useEffect(() => setMenu(false), [route.name, chat.id]);
  // R131: as on the laptop, after the title (the title is a link of its own, so the mark is a 44 px link beside it).
  const mark = MARKED.has(barState(chat)) ? null : bgBarMark(chat, viewOf(route));
  return (
    <header className="topbar scr-bar scr-bar-touch" data-testid="topbar">
      <ChatsButton back={phone} />
      {renaming ? (
        <RenameForm key={`${chat.id}:${String(route.query.title ?? "")}`} chat={chat} route={route} inline testId="dialog-rename" />
      ) : (
        <span className="scr-bar-press" ref={title} {...press}>
          <Link to={chatHref("rename", chat.id, route)} className="scr-bar-title scr-bar-title-touch" aria-label={`${chat.title}, ${STATE_WORD[barState(chat)]}. Rename`} draggable={false}>
            {MARKED.has(barState(chat)) ? <StateDot state={barState(chat)} /> : null}
            <span className="scr-bar-title-text" dir="auto">{chat.title}</span>
          </Link>
        </span>
      )}
      {!renaming && mark ? <BgBarMarkLink mark={mark} /> : null}
      {phone && !renaming ? <HeaderContextRing chat={chat} route={route} /> : null}
      {!renaming ? (
        <button ref={more} type="button" className={`icon-btn${dot ? " bp-has-dot" : ""}`} aria-label={dot ? `Session menu${NEEDS_WORDS}` : "Session menu"} aria-haspopup="dialog" aria-expanded={menu === "more"} data-terminal-home={phone ? "" : undefined} onClick={() => setMenu((v) => (v ? false : "more"))}>
          <IconMore size={18} />
          {dot ? <span className="dot waiting bp-tool-dot" aria-hidden="true" /> : null}
        </button>
      ) : null}
      <SessionMenu open={!!menu} onClose={() => setMenu(false)} anchor={menu === "title" ? title : more} chat={chat} route={route} />
    </header>
  );
}

// The page a chats button opened the drawer over. The button goes away with that page, so when the drawer closes back
// to it, the new page's chats button takes the focus that the drawer gives back (a pick elsewhere leaves it alone).
let drawerOver: string | null = null;
const onChats = (url: string) => /^\/chats(\?|$)/.test(url);

/**
 * The chats button. Phone: Back to the chat list (7.2), through history when the list is the entry before. Medium
 * touch and a laptop under 1,000 px: the list drawer. On a tablet the drawer's button shows its name, "Chats", while
 * its band has room for it and the title (screens.css: 400 px); the phone's Back stays an arrow.
 */
function ChatsButton({ back }: { back: boolean }) {
  const vp = useViewport();
  const named = vp.touch && !back && vp.size !== "phone";
  const to = chatsHref();
  const self = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    const here = currentUrl();
    if (drawerOver === null || onChats(here)) return; // the chat behind the open medium drawer has a button too
    const a = document.activeElement;
    if (drawerOver === here && (!a || a === document.body)) self.current?.focus({ preventScroll: true });
    drawerOver = null;
  }, []);
  return (
    <a
      ref={self}
      href={to}
      className={named ? "btn ghost scr-bar-tool scr-bar-chats" : "icon-btn scr-bar-chats"}
      aria-label={named ? undefined : "Chats"}
      title={named ? undefined : "Chats"}
      onClick={(e) => {
        if (!plainClick(e)) return;
        e.preventDefault();
        const from = (history.state as { from?: string } | null)?.from;
        if (back && from && onChats(from)) history.back();
        else {
          drawerOver = back ? null : currentUrl();
          navigate(to);
        }
      }}
    >
      {back ? <IconBack size={18} /> : <IconChats size={18} />}
      {named ? <span>Chats</span> : null}
    </a>
  );
}

/**
 * The phone header's context ring (7.2): how full the context window is; it opens Details at Context. Until Claude
 * Code reports the window, only the track and "..." (6.7: never a made-up value).
 */
export function HeaderContextRing({ chat, route }: { chat: Chat; route: Route }) {
  useContextRead(chat);
  const { known, pct, text, label } = contextMeter(chat);
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <Link to={chatHref("context", chat.id, route)} className="scr-ring" aria-label={label} title="Context">
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle cx="9" cy="9" r={r} className="scr-ring-track" />
        {known ? <circle cx="9" cy="9" r={r} className="scr-ring-fill" strokeDasharray={`${(c * pct) / 100} ${c}`} transform="rotate(-90 9 9)" /> : null}
      </svg>
      <span className="scr-ring-pct">{text}</span>
    </Link>
  );
}

function ScreenBar({ route }: { route: Route }) {
  const vp = useViewport();
  const layout = useShellLayout();
  const title = useScreenTitle(route);
  const parent = useParentProject(route);
  const back = useBackFromChat(Boolean(parent));
  const over = useOverChat(route);
  const touchBar = vp.size !== "laptop";
  const bar = useRef<HTMLElement>(null);
  // The phone's /chats bar: Search, Browser and New named on touch, unless "Chats" would be cut (T-5).
  const listBar = route.name === "chats" && layout.sidebar === "screen";
  const named = vp.touch ? "beside" : undefined;
  useBarRoom(bar, "bar", listBar && vp.touch && !over);
  // R131: a background session's view is a page over its chat: Back "Chat" at every size, and on touch the heading
  // "Background session" (on a laptop the view's own head names the session).
  if (over)
    return (
      <header className={`topbar scr-bar${touchBar ? " scr-bar-touch" : ""}`} data-testid="topbar">
        <BackButton to={over.to} label="Chat" aria={`Back to ${over.title}`} />
        {touchBar ? <span className="scr-bar-heading">{BG_HEADING}</span> : null}
      </header>
    );
  // The chat list is a drawer on medium touch and on a laptop under 1,000 px, and a screen on the phone.
  // A sidebar the user hid (row 82): Show sidebar takes the chats button's place.
  const hidden = layout.sidebar === "hidden";
  const chats = layout.sidebar !== "docked" && !hidden && route.name !== "chats" && !parent;
  return (
    <header ref={bar} className={`topbar scr-bar${touchBar ? " scr-bar-touch" : ""}`} data-testid="topbar">
      {hidden ? <SidebarToggle hide={false} /> : chats ? <ChatsButton back={false} /> : null}
      {parent ? (
        back ? (
          <BackButton to={back.to} label="Chat" aria={`Back to ${back.title}`} />
        ) : (
          <BackButton to={href("project", { project: parent.id })} label={parent.name} aria={`Back to ${parent.name}`} />
        )
      ) : (
        <span className="scr-bar-heading">{title}</span>
      )}
      {listBar ? (
        <>
          <SearchButton route={route} className="scr-bar-search" named={named} />
          <BrowserButton route={route} className="scr-bar-search" size={named ? 18 : 20} named={named} />
          <Link to={href("new")} className={named ? "btn ghost scr-bar-tool scr-bar-compose" : "icon-btn scr-bar-compose"} aria-label="New" title={named ? undefined : "New"}>
            <IconCompose size={named ? 18 : 20} />
            {named ? <span>New</span> : null}
          </Link>
        </>
      ) : null}
    </header>
  );
}

// The bar's title for a screen with no large title of its own. Every other screen has one (M31: Home, /new, a project
// page, and the later routes' pages, /search among them), so the bar names nothing there.
const TITLES: Record<string, string> = {
  // Iteration 7: /browser where a title bar shows (the phone, medium, a laptop under 1,000 px).
  browser: "Browser",
  browserTab: "Browser",
  settings: "Settings",
  settingsSection: "Settings",
  setting: "Settings",
  // G-42: a device's own view of Settings (medium touch shows a title bar there too).
  settingsDevice: "Settings",
  restart: "Settings",
};

/** The bar's title on a screen with no chat (exported for the tests). */
export function screenTitle(name: string, sidebar: SidebarForm): string {
  // /chats: the phone's list screen has no title of its own; elsewhere the main column under the bar is Home.
  if (name === "chats") return sidebar === "screen" ? "Chats" : "";
  return TITLES[name] ?? "";
}

/** R131: the chat that a background session's view (or its Stop confirm) is a page over: Back goes to it, with its view key. */
function useOverChat(route: Route): { to: string; title: string } | null {
  const id = BG_VIEW_ROUTES.has(route.name) ? route.params.chat : undefined;
  const title = useStore((s) => (id ? s.chats.find((c) => c.id === id)?.title : undefined));
  return id && title !== undefined ? { to: chatHref("chat", id, route), title } : null;
}

/** The project a screen of the project's own closes to (its environment, a session's preview); none when unknown. */
function useParentProject(route: Route) {
  const below = route.name === "session" || route.name === "projectEnvironment";
  return useStore((s) => (below ? s.projects.find((p) => p.id === route.params.project) : undefined));
}

/**
 * The chat a screen of a project's own was opened from in this page (a chat's Details, the Environment button under a
 * refused start): the entry behind it, when this document pushed it and it is the chat or a view of its side pane, and
 * the chat is in the list. Back then goes back to it (closeTo goes back one entry), as the browser's Back did; a
 * direct link, or any other entry behind, keeps Back to the project.
 */
function useBackFromChat(below: boolean): { to: string; title: string } | null {
  const st = below && typeof history !== "undefined" ? (history.state as EntryState | null) : null;
  const from = st && docReach(st) > 0 && typeof st.from === "string" && st.from.startsWith("/") && !st.from.startsWith("//") ? st.from : null;
  const r = from ? parsePath(from) : null;
  const id = r && !r.fallbackFrom && (r.name === "chat" || PANE_ROUTES.has(r.name)) ? r.params.chat : undefined;
  const title = useStore((s) => (id ? s.chats.find((c) => c.id === id)?.title : undefined));
  return from && title !== undefined ? { to: from, title } : null;
}

function useScreenTitle(route: Route): string {
  const layout = useShellLayout();
  const project = useStore((s) => s.projects.find((p) => p.id === route.params.project));
  // The page's own heading names the project or the session, so the bar gives the context instead of repeating it.
  if (route.name === "project") return ""; // the page's large title names it; an unknown project shows Home
  if (route.name === "session" || route.name === "projectEnvironment") return project?.name ?? "";
  // A chat path without its chat shows Home (DESIGN.md 5.4), the file and uploads paths too.
  return screenTitle(route.name, layout.sidebar);
}
