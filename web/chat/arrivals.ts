// Row 79: what a chat's rows show at once and what comes in. A chat drawn for the first time, a snapshot (a reload, a
// page that comes later, a reconnect, a history read) and an older page are loads: their text shows at once, and so
// does what comes in the moment after (a snapshot's tail replays the turn in flight). So is a reconnect's replay, by
// the store's mark (net/replay.ts), from `attached` until the missed events are in, which a live event's rows cannot
// tell apart. A message that comes live (this page's own send, or another page's that this one sees) enters with a
// short fade and rise. Else the rows tell: a live event changes at most one row and adds at the end (or before the
// queued messages); a load draws every row again, takes the in-flight reply out, adds above the rows that were there,
// or adds more than one row at once (a history read with another app's turns).
import { useRef } from "react";
import { inReplay, resetReplays } from "../net/replay";
import type { Item } from "../state/types";
import { motionNow } from "../ui/motion";

/** After a load, what comes this soon still shows at once (the snapshot's tail comes right after it). */
export const QUIET_MS = 400;
/** A new message that has not drawn this soon after it came does not enter (it was folded away, say). */
const ENTER_MS = 1000;

const queuedRow = (it: Item) => (it.kind === "user" || it.kind === "bash") && !!it.queued;

/**
 * Between two renders of a chat's rows: a load, or live events and the rows they added. `prev` null is the chat's
 * first render; `wasLoaded` and `loaded` are Chat.loaded before and now.
 */
export function changeOf(prev: readonly Item[] | null, next: readonly Item[], wasLoaded: boolean, loaded: boolean): { load: boolean; added: string[] } {
  if (prev === null || (loaded && !wasLoaded)) return { load: true, added: [] };
  if (prev === next) return { load: false, added: [] };
  const before = new Map<string, Item>();
  for (const it of prev) before.set(it.id, it);
  const ids = new Set<string>();
  const added: string[] = [];
  let changed = 0;
  let firstAdded = -1;
  let lastKept = -1;
  next.forEach((it, i) => {
    ids.add(it.id);
    const was = before.get(it.id);
    if (!was) {
      added.push(it.id);
      if (firstAdded < 0) firstAdded = i;
      return;
    }
    if (was !== it) changed++;
    if (!queuedRow(it)) lastKept = i;
  });
  // A row that went that was not a queued message (Take back): a snapshot drew the rows without it.
  const removed = prev.some((it) => !ids.has(it.id) && !queuedRow(it));
  const load = changed >= 2 || added.length >= 2 || (firstAdded >= 0 && firstAdded < lastKept) || (removed && changed >= 1);
  return { load, added: load ? [] : added };
}

const quietUntil = new Map<string, number>();
const entered = new Map<string, number>();

/** The chat loads, or loaded a moment ago: what comes now shows at once. */
export function quietNow(chatId: string, now: number): boolean {
  return (quietUntil.get(chatId) ?? -Infinity) > now || inReplay(chatId, now, QUIET_MS);
}

/** The row came live a moment ago and has not drawn yet: it enters. */
export function entering(chatId: string | undefined, id: string, now: number): boolean {
  if (!chatId) return false;
  const at = entered.get(`${chatId}\n${id}`);
  return at !== undefined && now - at < ENTER_MS;
}

/** The row drew: a later draw of it (a view change) does not enter again. */
export function enteredDone(chatId: string | undefined, id: string) {
  if (chatId) entered.delete(`${chatId}\n${id}`);
}

/** Tests only: forget every load and every entering row. */
export function resetArrivals() {
  quietUntil.clear();
  entered.clear();
  resetReplays();
}

/**
 * The conversation calls this as it draws a chat's rows, before the rows draw: it marks a load (quietNow) or the rows
 * that came live (entering).
 */
export function useArrivals(chatId: string, items: readonly Item[], loaded: boolean): void {
  const last = useRef<{ items: readonly Item[]; loaded: boolean } | null>(null);
  const was = last.current;
  if (was && was.items === items && was.loaded === loaded) return;
  const now = motionNow();
  const c = changeOf(was?.items ?? null, items, was?.loaded ?? false, loaded);
  // A row that comes in the moment after a load (the snapshot's tail) is part of the load: it shows at once.
  const quiet = quietNow(chatId, now);
  if (c.load) quietUntil.set(chatId, now + QUIET_MS);
  for (const [key, at] of entered) if (now - at >= ENTER_MS) entered.delete(key);
  if (!quiet) for (const id of c.added) entered.set(`${chatId}\n${id}`, now);
  last.current = { items, loaded };
}
