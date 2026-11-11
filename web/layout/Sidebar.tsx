// The laptop sidebar (DESIGN.md 6.2; plan v3): on the look's material (layout.css), "kitespan" with the compose button
// (named New, Desktop's word, D46), the filter, the chats grouped by project with their state dots and times, and at
// the foot Settings. ChatListBody draws all of it. On /chats it takes the focus (5.3). Under
// 1,000 px Shell draws it in a drawer that /chats opens (6.1), so a pick there replaces the drawer's entry.
// Row 82: where it docks, Hide sidebar at its top hides it (this device's own, ViewPrefs.sidebarHidden, never a URL),
// and Show sidebar at the start of the title bar brings it back; Shell puts its width handle on its inner edge.
// Iteration 8 (DESIGN-T1 2.4, 2.6; G-32): on touch Hide sidebar leaves the brand's line and ends the head's row of named
// tools (ChatListBody), so "kitespan" has its line, and its focus ring its room, to itself.
import type { MouseEvent } from "react";
import type { Route } from "../router";
import { act } from "../state/store";
import { ChatListBody } from "../screens/ChatListBody";
import { IconSidebar } from "../ui/icons";
import { useShellLayout, useViewport } from "./size";

export const SIDEBAR_HIDE = "Hide sidebar";
export const SIDEBAR_SHOW = "Show sidebar";
/** The docked sidebar's element id (its width handle's aria-controls). */
export const SIDEBAR_ID = "fd-sidebar";

export function Sidebar({ route, drawer }: { route: Route; drawer?: boolean }) {
  const form = useShellLayout().sidebar;
  const touch = useViewport().touch;
  const inDrawer = drawer ?? form === "drawer";
  const hide = inDrawer ? null : <SidebarToggle hide />;
  return (
    <nav className="sidebar scr-nav" aria-label="Chats" data-testid="sidebar" id={inDrawer ? undefined : SIDEBAR_ID}>
      {touch ? null : hide}
      <ChatListBody route={route} variant={inDrawer ? "drawer" : "sidebar"} focusOnOpen={route.name === "chats"} headTool={touch ? hide : undefined} />
    </nav>
  );
}

/**
 * Hide sidebar (at the sidebar's top) or Show sidebar (in the title bar while it is hidden): an icon button with its
 * name as its tooltip on a laptop. Touch has no tooltip: Show sidebar shows its name beside the icon there (DESIGN.md
 * 7.4), as the title bar's other buttons do on a large tablet; Hide sidebar shows it under the icon in the head's row,
 * as Search, Browser and New beside it do. The focus moves to the other one, which takes this one's place.
 */
export function SidebarToggle({ hide }: { hide: boolean }) {
  const touch = useViewport().touch;
  const label = hide ? SIDEBAR_HIDE : SIDEBAR_SHOW;
  const named = touch;
  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    const focused = document.activeElement === e.currentTarget;
    act.setView({ sidebarHidden: hide });
    if (focused) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-testid="${hide ? "sidebar-show" : "sidebar-hide"}"]`)?.focus({ preventScroll: true }));
  };
  return (
    <button
      type="button"
      className={named ? (hide ? "scr-head-tool sidebar-hide" : "btn ghost scr-bar-tool scr-bar-sidebar") : `icon-btn ${hide ? "sidebar-hide" : "scr-bar-sidebar"}`}
      aria-label={named ? undefined : label}
      title={touch ? undefined : label}
      data-testid={hide ? "sidebar-hide" : "sidebar-show"}
      onClick={onClick}
    >
      <IconSidebar size={18} />
      {named ? <span className={hide ? "scr-head-name" : undefined}>{label}</span> : null}
    </button>
  );
}
