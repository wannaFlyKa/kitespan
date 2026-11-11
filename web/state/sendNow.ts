// Row 111 (CO-4, DESIGN.md 6.3): which queued message carries Send now. One press sends every message that waits in
// Claude Code's queue, so Send now shows under the last one only, and only while a turn runs (with none, nothing waits
// for a turn to let it in). A message marked Not sent is not in Claude Code's queue, and this page's own message that
// the server has not shown yet may not be there yet: neither carries it. Nor does any while the server holds the queue
// back (a held chat, row 78, or a restart that waits, 4.10): those wait for no turn. After a press, Send now stays away
// from the messages it sent for the rest of that turn and until the next one starts, so a press acts once and the
// button does not come back while the turn ends; a message that still waits in a later turn has it again.
import type { Chat, Item } from "./types";

/** One press of Send now on a chat: the turn it was made in, and the messages that waited then. */
export interface SendNowPress {
  turn: number | null;
  ids: readonly string[];
}

type UserItem = Extract<Item, { kind: "user" }>;
const waits = (it: Item): it is UserItem => it.kind === "user" && !!it.queued;

/** The queued messages of a chat, in order: the ones a press sends. */
export function queuedIds(chat: Pick<Chat, "items">): string[] {
  return chat.items.filter((it) => waits(it) && !it.notSent && !it.local).map((it) => it.id);
}

/** The press still stands: made in this turn, or in the one that ended and before the next one began. */
export function pressStands(chat: Pick<Chat, "turn">, press: SendNowPress | null | undefined): press is SendNowPress {
  return !!press && (chat.turn === null || chat.turn === press.turn);
}

/**
 * Where Send now goes: under the last queued message, or nowhere. `pressed`: this page's press of it stands, so the
 * button is gone and its place stays, empty, so nothing moves under the pointer (the second click of a double click
 * would land on the Take back beside it). `restartWaits`: the restart's drain holds every chat's queue back.
 */
export function sendNowPlace(chat: Pick<Chat, "items" | "turn" | "held">, press?: SendNowPress | null, restartWaits = false): { id: string; pressed: boolean } | null {
  if (chat.held || restartWaits) return null;
  let last: UserItem | null = null;
  for (let i = chat.items.length - 1; i >= 0 && !last; i--) {
    const it = chat.items[i]!;
    if (waits(it)) last = it;
  }
  if (!last || last.notSent || last.local) return null;
  const pressed = pressStands(chat, press) && press.ids.includes(last.id);
  // With no turn running nothing is pressed, but a press's place stays until the next turn begins.
  return chat.turn === null && !pressed ? null : { id: last.id, pressed };
}

/** The message under which Send now shows, or null. */
export function sendNowTarget(chat: Pick<Chat, "items" | "turn" | "held">, press?: SendNowPress | null, restartWaits = false): string | null {
  const at = sendNowPlace(chat, press, restartWaits);
  return at && !at.pressed ? at.id : null;
}
