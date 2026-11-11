// U1 (DESIGN-U1 8): the changes view's URLs. /c/<chat>/changes/<turn> is a turn's list and
// /c/<chat>/changes/<turn>/<relative path> one file's diff, both views of the side panel (U4's sixth kind, changes);
// they pre-fill nothing. A card's row is an opener outside the panel (layout/split.ts openHref), so with the Terminal
// open the diff lands above it. On the phone (row 115) both open the chat with the turn's card line in the middle,
// marked as a linked message is, and the URL is not rewritten, so the same link opens the diff on a laptop. On the
// laptop and the tablet (review) a route entered from outside the page brings the turn's card into view, unmarked.
import { href, type Route } from "../router";
import { kindShown } from "../layout/split";
import { CHANGES_ROUTES } from "./model";

export { CHANGES_ROUTES };

/** The URL of a turn's list, or with `path` of that file's diff, keeping the transcript view. */
export function changesHref(chat: string, turn: string, path?: string, view?: string): string {
  return path ? href("changesFile", { chat, turn, path }, { view }) : href("changesTurn", { chat, turn }, { view });
}

/**
 * The turn and the file (null: the list) that the side panel shows now: the URL's own view, or where the split shows
 * (`live`) the other half too. Null when no changes view shows. The card marks that row (DESIGN-U1 6.1).
 */
export function changesShown(route: Route, live: boolean): { turn: string; path: string | null } | null {
  const r = kindShown(route, "changes", live);
  const turn = r?.params.turn;
  if (!r || !turn) return null;
  return { turn, path: r.name === "changesFile" ? (r.params.path ?? null) : null };
}

/**
 * The landing (DESIGN-U1 8.4): the summary a changes route names, whose card the chat scrolls to. Always on the phone
 * (its card line, marked); on the laptop and the tablet when the route was entered from outside the page (`outside`:
 * the page opened on it, a reload, Back or Forward), not when the card's own row or the panel's list opened it.
 */
export function changesLanding(route: Route, phone: boolean, outside = false): string | null {
  if (!(phone || outside) || route.fallbackFrom || !CHANGES_ROUTES.has(route.name)) return null;
  return route.params.turn ?? null;
}
