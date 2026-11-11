// Row 116 (R116): the seen flag's rules (FIX-R116 section 2; DESIGN-R116 sections 5 and 6). The registry keeps the
// flag in the chat's ledger (`unseen`) and, per chat, the pages that say the chat is on screen; these are the rules it
// asks: which pages count now, and what a turn's end and a stop of the server set.

import { TURN_CUT, TURN_INTERRUPTED, WIRE, type ChatEventOf, type Unseen } from "../../shared/protocol";
import type { LedgerStop } from "../store/types";
import type { Viewer } from "./types";

/**
 * Whether a page has the chat on screen now: one of `on` (the pages that said `on_screen` with `on` and are still
 * attached) whose socket was heard from in the last 20 s. A page that gives no time (a test's viewer) counts.
 */
export function onScreenNow(on: Iterable<Viewer>, freshMs: number = WIRE.onScreenFreshMs): boolean {
  for (const v of on) if ((v.quietMs?.() ?? 0) <= freshMs) return true;
  return false;
}

/**
 * What a turn's end sets when no page has the chat on screen: `done` for a turn that ended well, `failed` for one
 * that ended in an error, and nothing for a turn that a Stop ended (the user's own act, from any page) or that
 * kitespan's own stop cut (Restart now, a refused start: the user asked for it, or the line says it).
 */
export function endUnseen(end: Pick<ChatEventOf<"turn_end">, "ok" | "subtype">): Unseen | null {
  if (end.subtype === TURN_INTERRUPTED || end.subtype === TURN_CUT) return null;
  return end.ok ? "done" : "failed";
}

/**
 * What a stop of the server (D32) sets once boot, or the end of kitespan's own orphan (R16), has read the transcript:
 * `lined`, the stop line shows (the turn did not finish, or a card waited). A crash's or a shutdown's line is a turn
 * that failed; after a crash, a turn that finished while no server ran (its orphan wrote the end) is a turn that
 * ended unseen. Restart now's line, also one whose restart did not happen, sets nothing: the user asked for it. A
 * shutdown whose turn finished sets nothing either: the server before this one was there at its end.
 */
export function bootUnseen(stop: Pick<LedgerStop, "by"> | null, lined: boolean): Unseen | null {
  if (!stop || stop.by === "restart" || stop.by === "restart_failed") return null;
  if (lined) return "failed";
  return stop.by === "crash" ? "done" : null;
}
