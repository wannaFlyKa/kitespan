// The session menu (DESIGN.md 6.2): Rename, Open in terminal (the Terminal pane with the resume command typed, D38),
// then Details on the phone only (where the side panel is a column, the title bar's Hide session rail or Show session
// rail toggles it, and where the pane bar shows, its Details button opens it, so the menu repeats neither), Transcript
// view, Keyboard shortcuts (6.8), and last Archive (Stop and archive while the chat's Claude Code is busy)
// and Delete, a --danger label (D48, 6.10). An archived chat's menu offers Unarchive and Delete in their place, and no
// Rename or Open in terminal: its page is read-only. No line sits under the items: where the title came from shows in
// the Rename form (M30). A menu that only lists items has no URL of its own (5.1 rule 1): each item opens a state that
// has one or acts as its own named button (Archive is the named button, as in Desktop: one click, no dialog), and the
// transcript view changes with replaceState. A menu on a laptop and a tablet (hairline separators between its parts);
// on the phone a sheet of grouped lists (plan v3). R124: Side chat after Search, on the phone only (elsewhere the title
// bar's Side chat or the pane bar's opens it), where the agent answers side questions; an archived chat has none.
// v0.6 touch (DESIGN-T1 2.3 and 2.5): Stop first, in a group of its own, while a turn runs or a card waits (the Stop
// confirm, /c/<chat>/stop, the one control every size has then); Open on phone after Open in terminal, on every size
// but the phone; and Keyboard shortcuts wherever a hardware keyboard is likely (medium touch, the large tablet and the
// laptop: every size but the phone, whose list is in Settings > General).
import type { RefObject } from "react";
import { href, navigate, type Route } from "../router";
import { VIEW_IDS } from "../routes";
import type { Chat } from "../state/types";
import { useShellLayout, useViewport } from "../layout/size";
import { useRail } from "../layout/Shell";
import { Link, Popup } from "../ui/primitives";
import { IconCheck } from "../ui/icons";
import { archiveItem, chatHref, pressArchive, usePopupRows, viewOf } from "../screens/common";
import { openInTerminalHref } from "../terminal/route";
import { useStore } from "../state/store";
import { sideHref } from "../side/nav";
import { browserToggle } from "../browser/nav";
import { NEEDS_WORDS, useBrowserDot } from "../browser/dot";
import { kindToggle, useSplitLive } from "../layout/split";

const VIEW_LABEL: Record<string, string> = { normal: "Normal", thinking: "Thinking", verbose: "Verbose" };

export function SessionMenu(props: { open: boolean; onClose: () => void; anchor: RefObject<HTMLElement | null>; chat: Chat; route: Route }) {
  const { open, onClose, anchor, chat, route } = props;
  const vp = useViewport();
  const k = usePopupRows();
  const rail = useRail(route, chat); // the title bar's toggle; null where the side panel is not a column
  const layout = useShellLayout(); // the pane bar's Details button, on a tablet and a narrow laptop
  const view = viewOf(route) ?? "normal";
  const sideOn = useStore((s) => s.sideQuestions) && !chat.archived && layout.size === "phone";
  // U4: as the title bar's tools, Open in terminal and Side chat open their view by the opener rules (layout/split.ts
  // kindToggle); while a half, or the one view, shows that kind, the item closes it and says so.
  const live = useSplitLive();
  const own = chatHref("chat", chat.id, route);
  const term = kindToggle(route, "terminal", openInTerminalHref(chat.id, viewOf(route)), live, own);
  const side = kindToggle(route, "side", sideHref(chat.id, viewOf(route)), live, own);
  const browser = browserToggle(route, chat.id, live);
  const dot = useBrowserDot();
  // Desktop: "The Thinking mode appears in the menu only after Claude has produced thinking" (DESIGN.md 6.3).
  const views = VIEW_IDS.filter((v) => v !== "thinking" || view === "thinking" || chat.items.some((i) => i.kind === "thinking"));
  const setView = (v: string) => {
    onClose();
    navigate(href(route.name, route.params, { ...route.query, view: v === "normal" ? undefined : v }), { replace: true });
  };
  const sep = k.sheet ? null : <hr className="menu-sep" />;
  const archive = archiveItem(chat);
  const stop = !chat.archived && (chat.turn !== null || chat.pending.length > 0);
  return (
    <Popup open={open} onClose={onClose} anchor={anchor} title={chat.title} testId="session-menu">
      <div className={`${k.box} scr-menu`}>
        {stop ? (
          <>
            <div className={k.list}>
              <Link to={chatHref("stop", chat.id, route)} className={k.row} onNavigate={onClose} data-testid="menu-stop">
                Stop
              </Link>
            </div>
            {sep}
          </>
        ) : null}
        <div className={k.list}>
          {!chat.archived ? (
            <>
              <Link to={chatHref("rename", chat.id, route)} className={k.row} onNavigate={onClose}>
                Rename
              </Link>
              <Link to={term.to} close={term.close} className={k.row} onNavigate={onClose}>
                {term.close ? "Close terminal" : "Open in terminal"}
              </Link>
            </>
          ) : null}
          {vp.size === "phone" ? null : (
            <Link to={chatHref("phone", chat.id, route)} className={k.row} onNavigate={onClose} data-testid="menu-phone">
              Open on phone
            </Link>
          )}
          {rail || layout.paneBar ? null : (
            <Link to={chatHref("details", chat.id, route)} className={k.row} onNavigate={onClose}>
              Details
            </Link>
          )}
          {/* The phone's way to the chat's search pane (7.2, v0.3 search), beside Details: elsewhere the side column's
              or the pane bar's Search opens it. */}
          {rail || layout.paneBar ? null : (
            <Link to={chatHref("chatSearch", chat.id, route)} className={k.row} onNavigate={onClose}>
              Search
            </Link>
          )}
          {sideOn ? (
            <Link to={side.to} close={side.close} className={k.row} onNavigate={onClose}>
              {side.close ? "Close side chat" : "Side chat"}
            </Link>
          ) : null}
          {/* Iteration 7 (DESIGN-B1 4.1): the phone's way to the chat's Browser, after Side chat, with the needs-you dot. */}
          {layout.size === "phone" ? (
            <Link to={browser.to} close={browser.close} className={k.row} onNavigate={onClose} aria-label={!browser.close && dot ? `Browser${NEEDS_WORDS}` : undefined} data-testid="menu-browser">
              {browser.close ? "Close browser" : "Browser"}
              {!browser.close && dot ? <span className="dot waiting" aria-hidden="true" /> : null}
            </Link>
          ) : null}
        </div>
        {sep}
        <p className={`${k.label} scr-menu-label`} id="scr-view-label">
          Transcript view
        </p>
        <div className={`${k.list} scr-menu-group`} role="group" aria-labelledby="scr-view-label">
          {views.map((v) => (
            <button key={v} type="button" role="menuitemradio" aria-checked={view === v} className={k.row} onClick={() => setView(v)}>
              <span className="scr-pick-text">{VIEW_LABEL[v]}</span>
              <IconCheck className={k.check} />
            </button>
          ))}
        </div>
        {vp.size === "phone" ? null : (
          <>
            {sep}
            <div className={k.list}>
              <Link to={href("setting", { section: "general", key: "shortcuts" })} className={k.row} onNavigate={onClose} data-testid="menu-shortcuts">
                Keyboard shortcuts
              </Link>
            </div>
          </>
        )}
        {sep}
        <div className={k.list}>
          <button
            type="button"
            className={k.row}
            data-testid="menu-archive"
            onClick={() => {
              onClose();
              pressArchive(chat, true); // the menu is on the chat's own page
            }}
          >
            {archive.label}
          </button>
          <Link to={chatHref("delete", chat.id, route)} className={`${k.row} danger scr-menu-delete`} onNavigate={onClose}>
            Delete
          </Link>
        </div>
      </div>
    </Popup>
  );
}
