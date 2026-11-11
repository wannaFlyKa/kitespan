// A chat's side thread (owner rows 124 and 125; DESIGN-R124 section 10): `side/<chat id>.json` under kitespan's state
// folder, beside `drafts/` and `queue/`. kitespan's own record, never in Claude Code's transcript. It holds the
// thread's `rev` and its exchanges, oldest first: at most 20 answered ones, then at most one that asks or failed. The
// file is at most 1 MiB; one that fails its check is set aside (`.bad`) and the chat starts with an empty thread.
// Written at once at each change, through the store's one atomic writer; Delete removes it, Archive keeps it.

import { CHAT_ID } from "../../shared/ids";
import { SIDE_LIMITS, sideExchangeOf, type SideExchange } from "../../shared/protocol";

export interface SideRecord {
  v: 1;
  /** The chat's id; it must match the file name. */
  id: string;
  /** One higher at each change of the thread; never lower while the chat exists. */
  rev: number;
  exchanges: SideExchange[];
}

/** The side file's JSON at most (the oldest answered exchanges go first to fit it, server/chats/side.ts). */
export const SIDE_FILE_BYTES = 1024 * 1024;

/** The thread's shape: at most SIDE_LIMITS.kept answered exchanges, and only the last one may ask or have failed. */
export function sideShaped(list: readonly SideExchange[]): boolean {
  let answered = 0;
  for (const [i, x] of list.entries()) {
    if (x.state === "answered") answered++;
    else if (i !== list.length - 1) return false;
  }
  return answered <= SIDE_LIMITS.kept;
}

/** A side file's record; null when it fails its check (the store then sets the file aside). */
export function sideRecordOf(raw: unknown, fileId?: string): SideRecord | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const own = (k: string) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
  const id = own("id");
  const rev = own("rev");
  const list = own("exchanges");
  if (own("v") !== 1 || typeof id !== "string" || !CHAT_ID.test(id) || (fileId !== undefined && id !== fileId)) return null;
  if (typeof rev !== "number" || !Number.isSafeInteger(rev) || rev < 0) return null;
  if (!Array.isArray(list) || list.length > SIDE_LIMITS.kept + 1) return null;
  const exchanges: SideExchange[] = [];
  for (const v of list) {
    const x = sideExchangeOf(v);
    if (!x || exchanges.some((y) => y.id === x.id)) return null;
    exchanges.push(x);
  }
  return sideShaped(exchanges) ? { v: 1, id, rev, exchanges } : null;
}
