// The Search button (DESIGN.md 6.2, 7.2, 7.3; v0.3 search): an icon button whose accessible name and tooltip are
// "Search", with the key in the tooltip on a laptop (Cmd+K on macOS, Ctrl+K elsewhere), as New beside it has its name.
// It opens the open chat's search pane, or `/search` when no chat is open; while that is open it is lit and closes it.
// On touch it is a 44 px target (base.css .icon-btn) with no tooltip. Iteration 8 (DESIGN-T1 2.4, T-5): where it opens a
// place from a bar it shows its name on touch, beside the icon in a title bar (`named` "beside": the phone's /chats bar,
// the title bar while the sidebar is hidden) or under it in a list head ("under": the medium drawer, the large tablet's
// sidebar); a bar with no room for the word drops it (ui/barRoom.ts), and "Search" stays its name.
import type { ReactNode } from "react";
import type { Route } from "../router";
import { Link } from "../ui/primitives";
import { IconSearch } from "../ui/icons";
import { IS_MAC, keyLabel } from "../ui/shortcuts";
import { closeHref, searchOpenHref } from "../search/nav";
import { useViewport } from "./size";
import { kindToggle, useSplitLive } from "./split";

/** How a bar tool shows its name on touch: beside its icon in a title bar, or under it in a list head. */
export type ToolNamed = "beside" | "under";

/** A bar tool's class and its name's element for `named` (none: the icon alone, its name for a screen reader). */
export function toolForm(named: ToolNamed | undefined, own: string): { className: string; name: (words: string) => ReactNode } {
  if (named === "beside") return { className: `btn ghost scr-bar-tool ${own}`, name: (w) => <span>{w}</span> };
  if (named === "under") return { className: `scr-head-tool ${own}`, name: (w) => <span className="scr-head-name">{w}</span> };
  return { className: `icon-btn ${own}`, name: () => null };
}

/** The button's tooltip: its name, and the key where a keyboard is the way in. */
export function searchTitle(touch: boolean, mac?: boolean): string | undefined {
  return touch ? undefined : `Search (${keyLabel("K", mac)})`;
}

export function SearchButton({ route, className = "", named, testId }: { route: Route; className?: string; named?: ToolNamed; testId?: string }) {
  const touch = useViewport().touch;
  const live = useSplitLive();
  const chat = route.params.chat ?? null;
  const view = typeof route.query.view === "string" ? route.query.view : undefined;
  // U4: in a chat, lit while a half of the split side panel shows the search pane (a press closes that half), and it
  // opens the pane by the opener rules.
  const t = chat ? kindToggle(route, "search", searchOpenHref(chat, view), live, closeHref(chat, view, undefined, false)) : null;
  const open = t ? t.on : route.name === "search";
  const to = t ? t.to : open ? closeHref(chat, view, undefined, false) : searchOpenHref(chat, view);
  const form = toolForm(named, `scr-search ${className}`.trim());
  return (
    <Link to={to} close={open} className={form.className} aria-label="Search" aria-keyshortcuts={IS_MAC ? "Meta+K" : "Control+K"} title={searchTitle(touch)} aria-current={open ? "page" : undefined} data-testid={testId}>
      <IconSearch size={18} />
      {form.name("Search")}
    </Link>
  );
}
