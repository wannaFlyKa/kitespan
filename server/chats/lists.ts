// The list rules of the chat list, Recent, a project page and "From the terminal" (DESIGN.md 6.2, 6.9; D48 E3), as
// pure functions of the registry's rows. An archived chat is left out of every list except the Archived view.

import type { ChatRow } from "../../shared/protocol";
import type { CHAT_FILTERS } from "../../shared/route";
import type { SessionInfo } from "../agents/types";

export type ChatFilter = (typeof CHAT_FILTERS)[number];

/** Newest first by last activity; the chat id breaks a tie, so the order is stable. */
export function byActivity(a: ChatRow, b: ChatRow): number {
  if (a.lastActivity !== b.lastActivity) return a.lastActivity < b.lastActivity ? 1 : -1;
  return a.chat < b.chat ? -1 : a.chat > b.chat ? 1 : 0;
}

/** `/chats?filter=`: All, Working (a turn runs), Needs input (a card waits) and Archived. */
export function filterChats(rows: readonly ChatRow[], filter: ChatFilter): ChatRow[] {
  const keep = (r: ChatRow): boolean => {
    if (filter === "archived") return r.archived;
    if (r.archived) return false;
    if (filter === "working") return r.state === "running" || r.state === "starting";
    if (filter === "needs-input") return r.needsYou;
    return true;
  };
  return rows.filter(keep).sort(byActivity);
}

/** Recent: the chats of every project, newest first, archived chats left out (10 on Home, all at `/chats`). */
export function recentChats(rows: readonly ChatRow[], limit: number = Number.POSITIVE_INFINITY): ChatRow[] {
  return filterChats(rows, "all").slice(0, limit);
}

/** A project page's chats, newest first, archived chats left out. */
export function projectChats(rows: readonly ChatRow[], project: string): ChatRow[] {
  return filterChats(rows, "all").filter((r) => r.project === project);
}

/**
 * "From the terminal": the sessions of a project folder that no kitespan chat holds. The driver's `listSessions`
 * already leaves out the SDK's own sessions (`includeProgrammatic: false`), and a deleted chat's transcript is gone
 * with its Delete (D48), so no deleted list is needed.
 */
export function fromTerminal(sessions: readonly SessionInfo[], heldSessionIds: ReadonlySet<string>): SessionInfo[] {
  return sessions.filter((s) => !heldSessionIds.has(s.sessionId)).sort((a, b) => b.lastModified - a.lastModified);
}
