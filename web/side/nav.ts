// Where the side chat lives in the URL (R124; DESIGN-R124 section 8; DESIGN.md 5.1 and 5.2): `/c/<chat>/btw` opens it,
// a side panel route (the laptop's column, the tablet's pane, the phone's sheet), so closing goes back to the chat and
// leaves no history entry (5.1 rule 4). `?text=` only fills the side chat's box: nothing is asked until Send. The box's
// unsent text is the server's side draft (FIX-U2, D49: the same on every page and across a restart; state/store.ts);
// a link's text is never saved by itself. Desktop's key opens the side chat, or puts the focus in its box when it is
// open.
import { href, type Route } from "../router";
import { act } from "../state/store";

export const SIDE_ROUTE = "sideChat";
/**
 * R130: /c/<chat>/btw/<exchange>, the side chat at one exchange (its page-made id): open and marked, its Bring back
 * focused on a laptop. Bring back acts only on its own press.
 */
export const SIDE_EXCHANGE_ROUTE = "sideExchange";
/** The box's field: the key finds the open side chat's field by it. */
export const SIDE_FIELD_ID = "side-input";

const viewOf = (route: Route) => (typeof route.query.view === "string" ? route.query.view : undefined);

export function sideShown(route: Route): boolean {
  return route.name === SIDE_ROUTE || route.name === SIDE_EXCHANGE_ROUTE;
}

/** The exchange a side chat link names (R130), if any. */
export function sideExchangeOf(route: Route): string | undefined {
  return route.name === SIDE_EXCHANGE_ROUTE ? route.params.exchange : undefined;
}

/** The side chat of `chat`, in the route's transcript view. */
export function sideHref(chat: string, view?: string): string {
  return href(SIDE_ROUTE, { chat }, { view });
}

/** Where the side chat's buttons point from this route: the side chat, or back to the chat while it is open. */
export function sideToggle(route: Route, chat: string): { to: string; close: boolean } {
  const open = sideShown(route);
  return { to: open ? href("chat", { chat }, { view: viewOf(route) }) : sideHref(chat, viewOf(route)), close: open };
}

// ---- a question that was not asked goes back into the box

/**
 * A question that left the thread unasked (a Stop, or `busy`: another side question ran) goes back into the chat's side
 * box when that box is empty: into the server's side draft (FIX-U2), saved at once, so every page shows it, and the
 * box shows it whether or not the side chat is open now.
 */
export function sideBoxBack(chat: string, text: string) {
  act.sideBack(chat, text);
}

// ---- the link's fill (5.2: a link only fills)

/** The last link fill each chat's box took, so a render does not fill again, while Back and Forward to another do. */
const APPLIED = new Map<string, string>();

export interface SideFill {
  /** Changes when the link's fill changes. */
  key: string;
  /** The link's text for the box; absent: the link fills nothing. */
  text?: string;
  /** The link's text was over its cap (5.4's line), so nothing filled. */
  overCap: boolean;
}

/** What a side chat link fills: its `text`, or nothing (over the cap, the router dropped it). */
export function sideFillOf(route: Route, search: string = typeof location === "undefined" ? "" : location.search): SideFill | null {
  if (!sideShown(route)) return null;
  const text = typeof route.query.text === "string" && route.query.text !== "" ? route.query.text : undefined;
  if (text !== undefined) return { key: `text|${text}`, text, overCap: false };
  const raw = new URLSearchParams(search).get("text");
  if (raw !== null && raw.length > 5000) return { key: "over", overCap: true };
  return null;
}

/** True once per new fill of the chat's box (the key it last took is kept). */
export function takeFill(chat: string, fill: SideFill | null): boolean {
  const key = fill?.key ?? "";
  if (APPLIED.get(chat) === key) return false;
  APPLIED.set(chat, key);
  return !!fill;
}

/** Tests only. */
export function resetSideNav() {
  APPLIED.clear();
  keyOpenedAt = 0;
}

// ---- the key's focus

/** How long after the key a side chat that mounts counts as opened by it. */
const KEY_OPEN_MS = 1000;
let keyOpenedAt = 0;

/** The key is opening the side chat: its box takes the focus when it mounts, on touch too (a hardware keyboard). */
export function openSideFocused(now: number = Date.now()) {
  keyOpenedAt = now;
}

/** Whether the side chat that mounts now was opened by the key just before (read once). */
export function takeSideKeyOpened(now: number = Date.now()): boolean {
  const was = keyOpenedAt > 0 && now - keyOpenedAt < KEY_OPEN_MS;
  keyOpenedAt = 0;
  return was;
}

/** Focus the open side chat's box; false when none is open. */
export function focusSideField(): boolean {
  if (typeof document === "undefined") return false;
  const el = [...document.querySelectorAll<HTMLTextAreaElement>(`[data-testid="${SIDE_FIELD_ID}"]`)].find((f) => f.getClientRects().length > 0);
  if (!el) return false;
  if (document.activeElement !== el) {
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }
  return true;
}
