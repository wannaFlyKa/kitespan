// U1 (DESIGN-U1 5): how a turn's card names its turn. The notes keep a turn's first rows by their history ids
// (server/chats/ring.ts eventId); the card's `at` names them as the page names its rows, so a page finds the turn by
// its own row ids, and history finds a turn's card by its note.

import { itemIdOf } from "../../shared/ids";

/**
 * A history id as the page's row id: a message's or a `!` row's uuid as it is, a reply block's key by itemIdOf, a
 * tool call's or result's id without its kind.
 */
export function pageRowId(historyId: string): string {
  if (historyId.startsWith("call:")) return historyId.slice(5);
  if (historyId.startsWith("result:")) return historyId.slice(7);
  return itemIdOf(historyId);
}

/** The key of a turn's card: its first rows' page ids. */
export const cardKey = (at: readonly string[]): string => at.join(" ");

/** The key of a noted turn's card, from the note's history ids. */
export const noteCardKey = (ids: readonly string[]): string => cardKey(ids.slice(0, 2).map(pageRowId));
