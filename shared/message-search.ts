// The message search's contract (U5, DESIGN-U5 10): one GET read under /api/ that the search surface asks after a
// pause in typing, for the Messages group. The server and the page both import this file: its limits, its answer's
// shape and checker, the path the page asks for, and the strict reader of its query string.
//
//   GET /api/search?q=&tab=     -> MessageSearchReply (no-store); an ask that a newer one of the same tab replaced,
//                                  or whose page went away, answers 204 with no body
//
// The read starts disk reads (Claude Code's transcripts, through the agent seam) only with the sender gate's header
// `x-kitespan: 1`, the page's own; without it the server answers from what it holds and reads nothing. A `q` under the
// minimum (shared/words.ts) starts the background read, the surface's warm-up when it opens, and answers at once with
// no hits. The answer holds only the chat ids, the message ids (the page's row ids: a user message's uuid, a reply
// block's itemIdOf), who said each (the user or the agent), the snippets and their marks: never a transcript, a title,
// a project, a path or a model string.

import { AGENT_REF, CHAT_ID, TAB_ID } from "./ids";
import { CONTROL_CHARS } from "./protocol";

export const MESSAGE_SEARCH = {
  /** The route. */
  path: "/api/search",
  /** `q`, in UTF-16 units. */
  queryMax: 200,
  /** The hits of one answer, and of one chat. */
  hits: 20,
  perChat: 3,
  /** A snippet's longest form: 24 units before the anchor, 160 after it, and two ellipses. */
  snippetMax: 24 + 160 + 2,
  /** The ranges of one snippet (a range and the gap after it take 2 units at least). */
  rangesMax: 128,
  /** How long the server works on one query, from its arrival, before it answers what it holds (`complete: false`). */
  deadlineMs: 1_500,
} as const;

/** One message that matched: its chat, its row id, who said it, and one line of its text with the matched words' ranges. */
export interface MessageHit {
  chat: string;
  message: string;
  /** The user's own message, or the agent's (Claude's) reply: the page puts "You: " before the user's line. */
  by: "user" | "agent";
  snippet: string;
  /** Half-open `[start, end)` UTF-16 ranges into `snippet`, ascending and apart. */
  ranges: [number, number][];
}

/** GET /api/search. */
export interface MessageSearchReply {
  /** The query as it was asked (the page sends its words, words.ts queryText): the page drops an answer whose `q` is not
   * what it sent for its field's value now. */
  q: string;
  /** At most 20, at most 3 per chat, in rank order. */
  hits: MessageHit[];
  /** False when the deadline came before every chat's text was read: the hits so far, and the page may ask again. */
  complete: boolean;
}

/** The page's ask: `q` first, then the tab; spaces as %20, so one value never splits. */
export function messageSearchPath(q: string, tab: string | null): string {
  const qs = new URLSearchParams({ q });
  if (tab !== null) qs.set("tab", tab);
  return `${MESSAGE_SEARCH.path}?${qs.toString().replace(/\+/g, "%20")}`;
}

/** One value of a key, or undefined when absent; null when it repeats with different values. */
function one(search: URLSearchParams, key: string): string | undefined | null {
  const all = search.getAll(key);
  if (all.length === 0) return undefined;
  return all.every((x) => x === all[0]) ? all[0]! : null;
}

/**
 * The read's query: `q` (0 to 200 UTF-16 units, no control character; absent is empty) and `tab` (optional, the
 * page's tab id). null: a bad query, which the route answers with 400. Unknown keys are ignored.
 */
export function readMessageSearchQuery(search: URLSearchParams): { q: string; tab: string | null } | null {
  const q = one(search, "q");
  if (q === null) return null;
  if (q !== undefined && (q.length > MESSAGE_SEARCH.queryMax || CONTROL_CHARS.test(q))) return null;
  const tab = one(search, "tab");
  if (tab === null || (tab !== undefined && !TAB_ID.test(tab))) return null;
  return { q: q ?? "", tab: tab ?? null };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function rangesOf(v: unknown, length: number): [number, number][] | null {
  if (!Array.isArray(v) || v.length > MESSAGE_SEARCH.rangesMax) return null;
  const out: [number, number][] = [];
  let last = -1;
  for (const r of v) {
    if (!Array.isArray(r) || r.length !== 2) return null;
    const [s, e] = r as unknown[];
    if (!Number.isSafeInteger(s) || !Number.isSafeInteger(e)) return null;
    const a = s as number;
    const b = e as number;
    if (a < 0 || b <= a || b > length || a <= last) return null;
    out.push([a, b]);
    last = b;
  }
  return out;
}

/**
 * A reply as the page may use it, or null when it is not one: every hit with a chat id, a message id of 1 to 64 safe
 * characters, who said it (user or agent), a snippet of at most 186 units, and ranges inside it; at most 20 hits.
 */
export function messageSearchReplyOf(v: unknown): MessageSearchReply | null {
  if (!isObj(v) || typeof v.q !== "string" || v.q.length > MESSAGE_SEARCH.queryMax || typeof v.complete !== "boolean" || !Array.isArray(v.hits)) return null;
  if (v.hits.length > MESSAGE_SEARCH.hits) return null;
  const hits: MessageHit[] = [];
  for (const h of v.hits) {
    if (!isObj(h) || typeof h.chat !== "string" || !CHAT_ID.test(h.chat) || typeof h.message !== "string" || !AGENT_REF.test(h.message)) return null;
    if (h.by !== "user" && h.by !== "agent") return null;
    if (typeof h.snippet !== "string" || h.snippet.length > MESSAGE_SEARCH.snippetMax) return null;
    const ranges = rangesOf(h.ranges, h.snippet.length);
    if (!ranges) return null;
    hits.push({ chat: h.chat, message: h.message, by: h.by, snippet: h.snippet, ranges });
  }
  return { q: v.q, hits, complete: v.complete };
}
