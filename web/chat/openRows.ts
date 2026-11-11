// The rows a reader opened or closed in a conversation beyond what its URL opens (DESIGN.md 6.2 and 6.3): view state
// only, kept per key in ChatView, never in the store and never in the URL.
import { href, parse, type EntryState, type Route } from "../router";

/** The routes that name a row of the conversation, and the param that names it. */
export const ROW_PARAM: Readonly<Record<string, "toolUse" | "message">> = { tool: "toolUse", agent: "toolUse", workflow: "toolUse", thinking: "message", message: "message" };

export function isRowRoute(route: Route): boolean {
  return Object.hasOwn(ROW_PARAM, route.name);
}

/**
 * The key a route's open rows are kept under. A route that names a row (a tool, subagent, workflow or thinking block,
 * or a message) has its own key, so Back and Forward bring each entry's open rows back with it. Every other route of
 * the chat (a picker, a menu, a dialog, a composer link, a card, a side detail, the chat itself) shares the chat's
 * key, so the conversation under a picker, a menu or a sheet stays as the reader left it.
 *
 * `trail` is the entry's history trail (entryTrail). When the entries behind lead, through the chat's other routes
 * only, back to a row route (a picker opened over a block, then closed to the chat), the key names that row route
 * too: the rows carried from it then stay with those entries, and an earlier entry of the chat's path keeps its own.
 */
export function openRowsKey(route: Route, chatId: string, trail: readonly string[] = []): string {
  return isRowRoute(route) ? href(route.name, route.params) : chatRowsKey(chatId, trail);
}

/** The key of the chat's other routes for an entry with this trail (openRowsKey). */
export function chatRowsKey(chatId: string, trail: readonly string[] = []): string {
  const chat = href("chat", { chat: chatId });
  for (const u of trail) {
    const r = parse(new URL(u, "http://kitespan.invalid"));
    if (r.fallbackFrom || r.params.chat !== chatId) break;
    if (isRowRoute(r)) return `${chat} over ${href(r.name, r.params)}`;
  }
  return chat;
}

/** The URLs of the entries behind an entry, newest first, from its history state (router.ts EntryState). */
export function entryTrail(state: unknown): string[] {
  const st = state as EntryState | null | undefined;
  if (Array.isArray(st?.back)) return st.back.filter((u): u is string => typeof u === "string");
  return typeof st?.from === "string" ? [st.from] : [];
}

/**
 * The open rows that go on from a row route: what the reader opened or closed there, and the rows its URL opened
 * (its block, the containers around its row), unless the reader closed them.
 */
export function carryRows(from: ReadonlyMap<string, boolean> | undefined, urlOpen: Iterable<string>): Map<string, boolean> {
  const next = new Map(from);
  for (const id of urlOpen) if (next.get(id) !== false) next.set(id, true);
  return next;
}
