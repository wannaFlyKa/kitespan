// Where the search pane goes (DESIGN.md 9.3, 5.1 rule 4, 5.5): its own URL while the user types (q and scope, written
// with replaceState), a pick (a navigation, pushed, so Back returns to the results), and Esc or Close (back to where
// the user was). Pure: the page passes the history state in. U5: a message's pick opens the chat at that message with
// the query as `mark`, which only marks its words there (DESIGN-U5 9; the route's own cap is 120 characters).

import { PANE_ROUTES, href, parsePath } from "../../shared/route";
import type { SearchHit, SearchScope } from "./sections";

/** The pane's URL for this query: `/c/<chat>/search` in a chat, `/search` (q only) with no chat. */
export function searchHref(chat: string | null, q: string, scope: SearchScope | null, view?: string): string {
  return chat ? href("chatSearch", { chat }, { q, scope: scope ?? undefined, view }) : href("search", {}, { q });
}

/** Where the open pane's key and buttons point: the chat's pane, or `/search` with no chat. */
export function searchOpenHref(chat: string | null | undefined, view?: string): string {
  return chat ? href("chatSearch", { chat }, { view }) : href("search");
}

/** The message route's `mark` holds at most this many characters (its SHORT cap). */
const MARK_CAP = 120;

/**
 * The query as a message link's `mark`: its white space collapsed, and never over the route's cap (whole words up to
 * it; a first word longer than the cap gives none, so the link marks nothing and shows no line).
 */
export function markOf(q: string): string {
  const words = q.trim().split(/\s+/).filter(Boolean);
  let out = "";
  for (const w of words) {
    const next = out ? `${out} ${w}` : w;
    if (next.length > MARK_CAP) break;
    out = next;
  }
  return out;
}

/**
 * Where a pick goes: a chat, a file of the chat's folder, the chat's uploads, a command in the composer (5.5), or (U5)
 * a message of a chat, with `q` to mark; the view goes with it only inside the pane's own chat.
 */
export function pickHref(hit: SearchHit, chat: string | null, view?: string, q = ""): string {
  switch (hit.kind) {
    case "chats":
      return href("chat", { chat: hit.chat.id });
    case "messages":
      return href("message", { chat: hit.chat.id, message: hit.message }, { mark: markOf(q) || undefined, view: hit.chat.id === chat ? view : undefined });
    case "files":
      return chat ? href("files", { chat, path: hit.path }, { view }) : "/";
    case "uploads":
      return chat ? href("uploads", { chat }, { view }) : "/";
    case "commands":
      return chat ? href("slash", { chat, command: hit.command.name }, { view }) : "/";
  }
}

/**
 * Where Esc and Close take the pane: back to where the user was when that entry is this document's and shows the same
 * chat (the chat, or a view of its side pane such as Details), so closing goes back one entry; else the chat itself
 * (or, with no chat, the page before or Home). `from` and `inDoc` come from the entry's history state.
 */
export function closeHref(chat: string | null, view: string | undefined, from: string | undefined, inDoc: boolean): string {
  const home = chat ? href("chat", { chat }, { view }) : "/";
  if (!from || !inDoc || !from.startsWith("/") || from.startsWith("//")) return home;
  const r = parsePath(from);
  if (r.fallbackFrom || r.name === "chatSearch" || r.name === "search") return home;
  if (!chat) return from;
  return r.params.chat === chat && (r.name === "chat" || PANE_ROUTES.has(r.name)) ? from : home;
}
