// The chat list (DESIGN.md 6.2, 7.2, 7.3 and 7.7; plan v3; D48): "kitespan" (the link to Home) with the compose button
// (New), the filter (the shared Segmented control: All, Working and Needs input), the chats grouped by project with
// their state dots, the Archived row at the end of the list, and the foot (Settings, and "Reconnecting..." only while
// it is true, M4). The laptop sidebar (a drawer under 1,000 px), the phone's /chats screen and the medium drawer all
// draw this one component; in a drawer it marks the chat it was opened over. The phone's /chats screen has its title
// and compose button in the title bar (TopBar), so its list starts with the filter.
// A group heading's name is the link to the project page (M8), its chevron folds it, and only a folded heading shows
// how many of its chats need input (M6), because its rows are hidden then. "+" starts a chat in the project; on touch
// it shows its name under its icon (7.7: touch has no tooltip). In the narrow touch lists (the large tablet's sidebar,
// the medium drawer) a row's time or state word goes under its title, so the title keeps the row's width. Elsewhere a
// waiting row starts with "Needs input" (6.2, as agent view writes it), except under the Needs input filter (M7).
// Archived chats (D48) are out of the groups and their counts; the Archived row, shown only while one exists and with no
// count, opens the archived view (/chats?filter=archived; elsewhere a view of the list, as the filter is), where the
// title "Archived" takes the row's place, the groups hold only archived chats and a row's menu offers Unarchive and
// Delete. A segment of the filter goes back to the other chats.
// Row 99: a heading also has the environment's menu (its "..." button, or a right-click on a laptop: Rename, Move up,
// Move down and Remove; EnvironmentMenu.tsx), and it drags to a new place, with a line where it goes: with the mouse on
// a laptop (a plain drag, or a long press that lifts it, row 107), and on touch after a long press (row 102). Its name's
// link is not draggable, so the browser's own link drag never takes it.
// The foot also has the drain's line while a restart waits (settings/DrainLine.tsx) and the update's line (row 108,
// update/UpdateLine.tsx): the step line while an update runs, Restart to apply, or Update available with Update; not
// beside Settings > About, whose own rows say it.
// A row's menu opens from its "..." button, a right-click or a long-press on touch: Rename, Open in terminal, Archive
// (Stop and archive while the chat's Claude Code is busy) and Delete, last, as a --danger label (6.2, 6.10). On touch a
// swipe to the left shows the same two last items at the row's end; a swipe alone changes nothing (principle 3): only
// a tap on one of them acts, and a tap anywhere else only closes them (7.7). A row's Rename and Delete open their
// dialog over the chat, and it closes back to this list (common.tsx dialogParent).
// Iteration 8 (touch, DESIGN-T1 2.4, T-5 and T-11): the head never drops its Browser button. On touch "kitespan" has
// the head's line to itself and the tools take a row of their own under it, each named under its icon as the pane
// bar's buttons are (Search, Browser, New, and in the docked sidebar Hide sidebar); where one name is wider than its
// tool (the large tablet's 248 px sidebar at a large text size) the head drops them all. On a laptop the tools stay
// icons on the brand's line, and take a row under it where they have no room there (ui/barRoom.ts).
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { href, navigate, parse, type Route } from "../router";
import { useStore, visibleChats } from "../state/store";
import { steadyChats } from "../state/steady";
import type { Chat, Project } from "../state/types";
import { Link, Popup, Segmented, useLongPress } from "../ui/primitives";
import { useViewport } from "../layout/size";
import { IconChevron, IconCompose, IconGear, IconMore, IconPlus } from "../ui/icons";
import { openInTerminalHref } from "../terminal/route";
import { SearchButton } from "../layout/SearchButton";
import { BrowserButton } from "../browser/BrowserButton";
import { DrainLine } from "../settings/DrainLine";
import { UpdateLine } from "../update/UpdateLine";
import { ChatDot, ChatMeta, ChatTitle, RECONNECTING, RESTARTING, archiveItem, newestFirst, pressArchive, useConnection, usePopupFocus, usePopupRows } from "./common";
import { EnvMenu, useHeadingDrag, type EnvSteps, type HeadingDrag } from "./EnvironmentMenu";
import { stepBefore } from "../state/environments";
import { useBarRoom } from "../ui/barRoom";

export type ChatFilter = "all" | "working" | "needs-input";
/** The list's view: one of the filter's three segments, or the archived chats (the Archived row, D48). */
export type ListView = ChatFilter | "archived";

const FILTERS: { id: ChatFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "working", label: "Working" },
  { id: "needs-input", label: "Needs input" },
];
const EMPTY: Record<ListView, string> = {
  all: "No chats yet. Start one with New, the pencil button at the top.",
  working: "No chat is working right now.",
  "needs-input": "No chat needs your input.",
  archived: "No archived chats.",
};

// Kept outside React: every screen draws its own shell, so a screen change remounts the list. The view, the folded
// groups and the scroll position should survive that.
const memory = { view: "all" as ListView, folded: new Set<string>(), scroll: 0 };

const matches = (c: Chat, v: ListView) => v === "all" || v === "archived" || (v === "working" ? c.state === "running" : c.state === "waiting");

/** The filter as Segmented options. */
const FILTER_OPTIONS = FILTERS.map((f) => ({ value: f.id, label: f.label, testId: `filter-${f.id}` }));

export interface ListGroup {
  project: Project;
  /** The rows the view shows, newest first. */
  shown: Chat[];
  /** The chats of the group that need input (the folded heading's count). */
  needs: number;
}

/**
 * The groups of a view (6.2, D48): every project in its order, each with the chats the view shows. Archived chats are
 * only in the archived view, and never in a count.
 */
export function listGroups(chats: readonly Chat[], projects: readonly Project[], view: ListView): ListGroup[] {
  const pool = view === "archived" ? chats.filter((c) => c.archived) : visibleChats(chats);
  return projects.map((project) => {
    const all = pool.filter((c) => c.projectId === project.id).sort(newestFirst);
    return { project, shown: all.filter((c) => matches(c, view)), needs: view === "archived" ? 0 : all.filter((c) => c.state === "waiting").length };
  });
}

/** The groups that show: all of them in the All view, which lists every project; else only those with rows. */
export function shownGroups(groups: readonly ListGroup[], view: ListView): ListGroup[] {
  return view === "all" ? [...groups] : groups.filter((g) => g.shown.length > 0);
}

/** The number a heading shows: only while it is folded, and only when some of its chats need input (M6). */
export function headingCount(g: Pick<ListGroup, "needs">, folded: boolean): number | null {
  return folded && g.needs > 0 ? g.needs : null;
}

/** The Archived row shows only while an archived chat exists (D52), with no count. */
export function showArchivedRow(chats: readonly Chat[]): boolean {
  return chats.some((c) => c.archived);
}

/** The last items of a row's menu (6.2, 6.10): the archive item, then Delete; an archived row has no Rename. */
export function rowMenuItems(chat: Chat): string[] {
  return [...(chat.archived ? [] : ["Rename", "Open in terminal"]), archiveItem(chat).label, "Delete"];
}

/** The /chats URL of a view: the archived view and the three filters (All has no key). */
export function viewHref(view: ListView): string {
  return href("chats", {}, { filter: view === "all" ? undefined : view });
}

/** The /chats URL with the view the list last showed, so opening the list does not reset it. */
export function chatsHref(): string {
  return viewHref(memory.view);
}

/** The chat a drawer was opened over (the entry before /chats), so the list marks it as the current one. */
function chatBehind(): string | undefined {
  const from = (history.state as { from?: string } | null)?.from;
  if (!from || !from.startsWith("/c/")) return undefined;
  return parse(new URL(from, location.origin)).params.chat;
}

/** On /chats the view is in the URL (replaceState: it is live state, 5.1 rule 4); elsewhere it has no URL. */
function useView(route: Route): [ListView, (v: ListView) => void] {
  const onChats = route.name === "chats";
  const fromUrl = onChats ? ((route.query.filter as ListView | undefined) ?? "all") : undefined;
  const [kept, setKept] = useState<ListView>(fromUrl ?? memory.view);
  useEffect(() => {
    if (fromUrl) {
      memory.view = fromUrl;
      setKept(fromUrl);
    }
  }, [fromUrl]);
  const set = (v: ListView) => {
    memory.view = v;
    setKept(v);
    if (onChats) navigate(viewHref(v), { replace: true });
  };
  return [fromUrl ?? kept, set];
}

export function ChatListBody(props: { route: Route; variant: "sidebar" | "screen" | "drawer"; focusOnOpen?: boolean; headTool?: ReactNode }) {
  const { route, variant, focusOnOpen, headTool } = props;
  // Picking from the drawer replaces the drawer's entry, so Back goes to the chat before it, not to a closed drawer.
  const replace = variant === "drawer";
  // S1: the same list while only a reply's text grows (state/steady.ts), so the rows do not draw again per piece.
  const chats = useStore((s) => steadyChats(s.chats));
  const projects = useStore((s) => s.projects);
  const [behind] = useState(() => (variant === "drawer" ? chatBehind() : undefined));
  const currentChat = route.params.chat ?? behind;
  const currentProject = useStore((s) => route.params.project ?? s.chats.find((c) => c.id === currentChat)?.projectId);
  const [view, setView] = useView(route);
  const [folded, setFolded] = useState<Set<string>>(() => new Set(memory.folded));
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => listGroups(chats, projects, view), [chats, projects, view]);
  const anyShown = groups.some((g) => g.shown.length > 0);
  const visible = shownGroups(groups, view);
  const archivedRow = showArchivedRow(chats);
  const allIds = useMemo(() => projects.map((p) => p.id), [projects]);
  const shownIds = useMemo(() => visible.map((g) => g.project.id), [visible]);
  const groupsBox = useRef<HTMLUListElement>(null);
  const drag = useHeadingDrag(allIds, shownIds, groupsBox, scroller);

  // The last archived chat left (Unarchive, Delete) while the list showed them outside /chats: back to every chat.
  useEffect(() => {
    if (view === "archived" && !archivedRow && route.name !== "chats") setView("all");
  }, [view, archivedRow, route.name]);
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = memory.scroll;
  }, []);
  // /chats gives the list the focus (DESIGN.md 5.3): the current chat's row, else the first one, else the filter.
  useEffect(() => {
    if (!focusOnOpen) return;
    const box = root.current;
    const el = box?.querySelector<HTMLElement>('.scr-row[aria-current="page"]') ?? box?.querySelector<HTMLElement>(".scr-row") ?? box?.querySelector<HTMLElement>('.scr-filter [aria-checked="true"]');
    el?.focus();
  }, [focusOnOpen]);

  const toggle = (id: string) =>
    setFolded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      memory.folded = next;
      return next;
    });

  return (
    <div className={`scr-list scr-list-${variant}`} ref={root} data-testid={variant !== "sidebar" || route.name === "chats" ? "chat-list" : undefined} data-view={view}>
      {variant !== "screen" ? <ListHead route={route} project={currentProject} replace={replace} tool={headTool} /> : null}
      <div className="scr-list-top">
        <Segmented value={view === "archived" ? null : view} options={FILTER_OPTIONS} onChange={setView} label="Show chats" block small className="scr-filter" testId="chat-filter" />
      </div>
      <div className="scr-list-scroll" ref={scroller} onScroll={(e) => (memory.scroll = e.currentTarget.scrollTop)}>
        {view === "archived" ? (
          <h2 className="scr-view-title" id="scr-archived-h">
            Archived
          </h2>
        ) : null}
        <ul className="scr-groups" ref={groupsBox} aria-labelledby={view === "archived" ? "scr-archived-h" : undefined}>
          {visible.map((g, i) => (
            <Group
              key={g.project.id}
              group={g}
              view={view}
              folded={folded.has(g.project.id)}
              onToggle={() => toggle(g.project.id)}
              currentChat={currentChat}
              replace={replace}
              steps={{ up: stepBefore(allIds, shownIds, g.project.id, -1), down: stepBefore(allIds, shownIds, g.project.id, 1) }}
              drag={drag}
              drop={drag.gap === i ? "before" : drag.gap === shownIds.length && i === shownIds.length - 1 ? "after" : undefined}
            />
          ))}
        </ul>
        {!anyShown ? (
          <div className="scr-list-empty">
            <p>{EMPTY[view]}</p>
            {view !== "all" && view !== "archived" ? (
              <button type="button" className="btn" onClick={() => setView("all")}>
                Show all chats
              </button>
            ) : null}
          </div>
        ) : null}
        {/* In the archived view its title names it at the top, so the row does not repeat it at the end. */}
        {archivedRow && view !== "archived" ? (
          <a
            href={viewHref("archived")}
            className="scr-archived-row"
            data-testid="archived-row"
            onClick={(e) => {
              if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              setView("archived");
            }}
          >
            Archived
          </a>
        ) : null}
      </div>
      <div className="scr-list-foot">
        <Link to={href("settings")} className="scr-foot-row" replace={replace} aria-current={route.name.startsWith("setting") || route.name === "restart" ? "page" : undefined}>
          <IconGear className="scr-foot-icon" />
          <span className="scr-row-title">Settings</span>
        </Link>
        <DrainLine />
        {aboutRoute(route) ? null : <UpdateLine foot />}
        <ConnectionLine />
      </div>
    </div>
  );
}

/** Settings > About and its keys (the restart dialog, the update's confirm): About's rows say the update's line. */
function aboutRoute(route: Route): boolean {
  return route.name === "restart" || ((route.name === "settingsSection" || route.name === "setting") && route.params.section === "about");
}

/** The foot's last line: "Reconnecting..." only while the socket reconnects (M4), "Restarting kitespan..." while
 *  kitespan restarts (4.10); a good connection shows no word. The line stays in the page, empty, so a screen reader
 *  hears it when it changes. */
function ConnectionLine() {
  const state = useConnection();
  return (
    <p className="scr-conn" role="status" data-testid="connection" data-state={state}>
      {state !== "connected" ? (
        <>
          <span className="scr-conn-mark" aria-hidden="true">
            <span className="scr-conn-dot" />
          </span>
          {state === "restarting" ? RESTARTING : RECONNECTING}
        </>
      ) : null}
    </p>
  );
}

/** The list's head: "kitespan", the link to Home (owner row 92), then its tools: Search (v0.3 search, 6.2), the
 *  Browser (iteration 7) and the compose button (a square with a pencil) that opens /new in this project, whose name
 *  and tooltip are Desktop's word, "New" (D46, DESIGN.md 6.12), as the phone's title bar names it. `tool` ends the
 *  row: the docked sidebar's Hide sidebar on touch (layout/Sidebar.tsx). */
function ListHead({ route, project, replace, tool }: { route: Route; project?: string; replace: boolean; tool?: ReactNode }) {
  const head = useRef<HTMLDivElement>(null);
  const touch = useViewport().touch;
  const named = touch ? "under" : undefined;
  useBarRoom(head, "head", true, touch);
  return (
    <div className="scr-list-head" ref={head}>
      <Link to={href("home")} className="scr-brand" replace={replace} aria-label="kitespan, home">
        kitespan
      </Link>
      <div className="scr-head-tools" data-testid="head-tools">
        <SearchButton route={route} named={named} />
        <BrowserButton route={route} named={named} />
        <Link to={href("new", {}, { project })} className={touch ? "scr-head-tool scr-compose" : "icon-btn scr-compose"} replace={replace} aria-label="New" title={touch ? undefined : "New"} aria-current={route.name === "new" ? "page" : undefined}>
          <IconCompose size={18} />
          {touch ? <span className="scr-head-name">New</span> : null}
        </Link>
        {tool}
      </div>
    </div>
  );
}

function Group(props: { group: ListGroup; view: ListView; folded: boolean; onToggle: () => void; currentChat?: string; replace: boolean; steps: EnvSteps; drag: HeadingDrag; drop?: "before" | "after" }) {
  const { group, view, folded, onToggle, currentChat, replace, steps, drag, drop } = props;
  const { project: p, shown } = group;
  const named = useViewport().touch;
  const count = headingCount(group, folded);
  const rowsId = `scr-rows-${p.id}`;
  const [menu, setMenu] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const head = useRef<HTMLDivElement>(null);
  usePopupFocus(menu, "env-menu", more);
  const { touchHead } = drag;
  useEffect(() => {
    const el = head.current;
    return el ? touchHead(p.id, el) : undefined;
  }, [touchHead, p.id]);
  return (
    <li className="scr-group" data-drop={drop}>
      <div
        ref={head}
        className="scr-group-head"
        data-env={p.id}
        data-dragging={drag.dragging === p.id ? drag.how : undefined}
        onPointerDown={(e) => drag.onPointerDown(p.id, e)}
        onContextMenu={(e) => {
          e.preventDefault();
          if (drag.touching()) return;
          setMenu(true);
        }}
      >
        <Link to={href("project", { project: p.id })} className="scr-group-name" replace={replace} title={named ? undefined : `Project ${p.name}`} draggable={false}>
          {p.name}
        </Link>
        {count !== null ? (
          <span className="scr-group-needs">
            {count}
            <span className="visually-hidden"> {count === 1 ? "needs" : "need"} input</span>
          </span>
        ) : null}
        <button type="button" className="icon-btn scr-fold" aria-expanded={!folded} aria-controls={rowsId} aria-label={`Chats in ${p.name}`} onClick={onToggle}>
          <IconChevron className="scr-fold-icon" />
        </button>
        <button ref={more} type="button" className="icon-btn scr-group-more" data-testid="env-more" aria-label={`Menu for ${p.name}`} aria-haspopup="dialog" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>
          <IconMore />
        </button>
        {view !== "archived" ? (
          <Link to={href("new", {}, { project: p.id })} className="icon-btn scr-group-act" replace={replace} aria-label={`New chat in ${p.name}`} title={named ? undefined : `New chat in ${p.name}`}>
            <IconPlus />
            {named ? <span className="scr-group-act-name">New chat</span> : null}
          </Link>
        ) : null}
      </div>
      {!folded && shown.length ? (
        <ul className="scr-rows" id={rowsId}>
          {shown.map((c) => (
            <ChatRow key={c.id} chat={c} current={c.id === currentChat} replace={replace} lead={view !== "needs-input"} words={view !== "working"} />
          ))}
        </ul>
      ) : null}
      <EnvMenu open={menu} onClose={() => setMenu(false)} anchor={more} project={p} steps={steps} />
    </li>
  );
}

/** How far a finger must move sideways before a row slides (a scroll or a tap moves less). */
const SWIPE_START = 10;
/** The actions' width before they were measured. */
const SWIPE_FALLBACK = 176;
/** How long after its pointer ends a tap's click may still come; after that the tap had none (a scroll, a drag). */
const CLICK_AFTER_UP_MS = 500;

/**
 * Swallow the click that ends the tap now going down, wherever it lands: a capture listener on window runs before any
 * other handler, and preventDefault keeps a link from following its href. So a tap that only closes something (a
 * row's swipe actions, 7.7, as in iOS) opens nothing else. It stops waiting when the tap turns into a scroll, when its
 * pointer ends with no click, or at the next press.
 */
export function swallowNextClick(target: Pick<Window, "addEventListener" | "removeEventListener"> = window, downAt = performance.now()) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const click = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    done();
  };
  const up = () => {
    if (timer === null) timer = setTimeout(done, CLICK_AFTER_UP_MS);
  };
  const down = (e: Event) => {
    if (e.timeStamp > downAt) done(); // a later press: the tap that closed the actions gave no click
  };
  function done() {
    if (timer !== null) clearTimeout(timer);
    target.removeEventListener("click", click, true);
    target.removeEventListener("pointerup", up, true);
    target.removeEventListener("pointercancel", done, true);
    target.removeEventListener("pointerdown", down, true);
  }
  target.addEventListener("click", click, true);
  target.addEventListener("pointerup", up, true);
  target.addEventListener("pointercancel", done, true);
  target.addEventListener("pointerdown", down, true);
}

/**
 * One chat row. Its menu opens from the "..." button, a right-click, or a long-press on touch (DESIGN.md 6.2, 7.7). On
 * touch a swipe to the left slides the row and shows its archive item and Delete at its end; the swipe only shows
 * them, and each acts on its own tap. The filter that selects the row says its state already (M7): under Needs input
 * the row has no lead word (`lead` false), under Working no "Working" (`words` false); the dot stays, and the state is
 * still read out.
 */
function ChatRow({ chat, current, replace, lead, words }: { chat: Chat; current: boolean; replace: boolean; lead: boolean; words: boolean }) {
  const touch = useViewport().touch;
  const [menu, setMenu] = useState(false);
  const [swiped, setSwiped] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const more = useRef<HTMLButtonElement>(null);
  const actions = useRef<HTMLDivElement>(null);
  const width = useRef(SWIPE_FALLBACK);
  const pressed = useRef(false); // a long-press or a swipe ended here: swallow the click that ends it
  const start = useRef<{ x: number; y: number; sliding: boolean } | null>(null);
  const press = useLongPress(() => {
    pressed.current = true;
    setSwiped(false);
    setMenu(true);
  });
  const close = () => setMenu(false);
  const k = usePopupRows();
  usePopupFocus(menu, "row-menu", more);
  const item = archiveItem(chat);
  const archive = () => {
    setMenu(false);
    setSwiped(false);
    pressArchive(chat, current);
  };

  const showActions = touch && (swiped || drag !== null);
  useLayoutEffect(() => {
    if (showActions && actions.current) width.current = actions.current.offsetWidth || SWIPE_FALLBACK;
  }, [showActions, item.label]);
  // A tap anywhere but on the actions only closes them (7.7): on the row itself, a group heading or another row, its
  // click is swallowed, so it opens nothing.
  useEffect(() => {
    if (!swiped) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (actions.current?.contains(t)) return;
      swallowNextClick(window, e.timeStamp);
      setSwiped(false);
    };
    window.addEventListener("pointerdown", down, true);
    return () => window.removeEventListener("pointerdown", down, true);
  }, [swiped]);

  const onPointerDown = (e: ReactPointerEvent<HTMLLIElement>) => {
    pressed.current = false;
    start.current = e.pointerType === "touch" ? { x: e.clientX, y: e.clientY, sliding: false } : null;
    press.onPointerDown(e);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLLIElement>) => {
    const s = start.current;
    if (!s) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    // A finger always jitters a little; only a real move cancels the long-press.
    if (Math.hypot(dx, dy) > 8) press.onPointerMove();
    if (!s.sliding) {
      if (Math.abs(dy) > SWIPE_START && Math.abs(dy) >= Math.abs(dx)) {
        start.current = null; // a scroll
        return;
      }
      if (Math.abs(dx) <= SWIPE_START || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      if (dx > 0 && !swiped) {
        start.current = null; // to the right a closed row has nothing to show; the browser's edge swipe stays its own
        return;
      }
      s.sliding = true;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {} // the pointer is gone
    }
    const base = swiped ? -width.current : 0;
    setDrag(Math.max(-width.current, Math.min(0, base + dx)));
  };
  const endSlide = () => {
    const s = start.current;
    start.current = null;
    if (!s?.sliding) return;
    pressed.current = true;
    setSwiped((drag ?? 0) < -width.current / 2);
    setDrag(null);
  };

  const x = drag ?? (swiped && touch ? -width.current : 0);
  return (
    <li
      className="scr-row-li"
      data-swiped={swiped || undefined}
      onPointerDown={onPointerDown}
      onPointerUp={() => {
        press.onPointerUp();
        endSlide();
      }}
      onPointerCancel={() => {
        press.onPointerCancel();
        start.current = null;
        setDrag(null);
      }}
      onPointerMove={onPointerMove}
      onContextMenu={press.onContextMenu}
      onClickCapture={(e) => {
        if (!pressed.current) return;
        pressed.current = false;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div className={`scr-row-slide${drag !== null ? " is-dragging" : ""}`} style={x ? { transform: `translateX(${x}px)` } : undefined}>
        <Link to={href("chat", { chat: chat.id })} className="scr-row" replace={replace} aria-current={current ? "page" : undefined} title={chat.title}>
          <ChatDot chat={chat} />
          <ChatTitle chat={chat} className="scr-row-title" lead={lead} />
          <ChatMeta chat={chat} words={words} />
        </Link>
        <button ref={more} type="button" className="icon-btn scr-row-more" aria-label={`Menu for ${chat.title}`} aria-haspopup="dialog" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>
          <IconMore />
        </button>
        {showActions ? (
          <div className="scr-swipe" ref={actions} data-testid="row-swipe">
            <button type="button" className="btn scr-swipe-btn" data-testid={`swipe-${item.testId.slice("confirm-".length)}`} onClick={archive}>
              {item.label}
            </button>
            <Link to={href("delete", { chat: chat.id })} className="btn primary danger scr-swipe-btn" onNavigate={() => setSwiped(false)}>
              Delete
            </Link>
          </div>
        ) : null}
      </div>
      <Popup open={menu} onClose={close} anchor={more} title={chat.title} testId="row-menu">
        <div className={`${k.box} scr-menu`}>
          {!chat.archived ? (
            <div className={k.list}>
              <Link to={href("rename", { chat: chat.id })} className={k.row} onNavigate={close}>
                Rename
              </Link>
              <Link to={openInTerminalHref(chat.id)} className={k.row} onNavigate={close}>
                Open in terminal
              </Link>
            </div>
          ) : null}
          {!chat.archived && !k.sheet ? <hr className="menu-sep" /> : null}
          <div className={k.list}>
            <button type="button" className={k.row} data-testid="row-archive" onClick={archive}>
              {item.label}
            </button>
            <Link to={href("delete", { chat: chat.id })} className={`${k.row} danger scr-menu-delete`} onNavigate={close}>
              Delete
            </Link>
          </div>
        </div>
      </Popup>
    </li>
  );
}
