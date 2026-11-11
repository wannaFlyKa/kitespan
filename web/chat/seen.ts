// Rule 2 of the seen report (owner row 116, DESIGN-R116 section 5; net/onScreen.ts has the other rules): the route
// is one of the chat's own paths where its conversation shows.
import { PANEL_ROUTES } from "../routes";
import type { Route } from "../router";
import { terminalShown } from "../terminal/route";
import { CHANGES_ROUTES } from "../changes/model";

/** R131: the routes of a background session's view. */
export const BG_VIEW_ROUTES: ReadonlySet<string> = new Set(["background", "backgroundStop"]);

/**
 * Every path of a chat shows its conversation, beside its panes and under its dialogs and pickers, except on the
 * phone, where the Details sheet and its detail views, the search page and the Terminal page cover it. A route with no
 * chat (Home, /chats and its drawer, Settings) shows none. U1: on the phone a changes route is the chat at its card.
 */
export function conversationShows(route: Route, phone: boolean): boolean {
  if (!route.params.chat) return false;
  // R131: a background session's view (and its Stop confirm) is a page over the chat at every size: it sees the
  // session's end, never the chat's (DESIGN-R131 9.5).
  if (BG_VIEW_ROUTES.has(route.name)) return false;
  if (!phone) return true;
  return (!PANEL_ROUTES.has(route.name) || CHANGES_ROUTES.has(route.name)) && !terminalShown(route);
}
