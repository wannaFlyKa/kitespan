// A chat's event ring buffer (DESIGN.md 4.3): the newest events with their sequence numbers, at most 2,000 events or
// 4 MiB of frame JSON, whichever comes first. Numbers in the ring are contiguous, so a lookup is one subtraction.

import { WIRE, capText, type ChatEvent } from "../../shared/protocol";
import type { RingItem } from "./types";

/** UTF-8 length of a string without allocating a buffer. */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

export function evFrameJson(chat: string, seq: number, e: ChatEvent): string {
  return JSON.stringify({ t: "ev", chat, seq, e });
}

/**
 * The event and its `ev` frame, made small enough that the frame stays under `maxBytes` (256 KiB: no frame over a page,
 * 4.3). The text caps already bound every field in characters; a string full of escapes or wide characters can still
 * pass the byte limit, so the longest string is halved until the frame fits. Claude's own text never comes here
 * oversized, because splitBlock sends it in 32,000-character pieces.
 */
export function fitEvent(
  chat: string,
  seq: number,
  e: ChatEvent,
  maxBytes: number = WIRE.pageBytes,
): { e: ChatEvent; json: string; bytes: number } {
  let cur: ChatEvent = e;
  let json = evFrameJson(chat, seq, cur);
  let bytes = utf8Bytes(json);
  for (let round = 0; round < 40 && bytes > maxBytes; round++) {
    let best: { path: (string | number)[]; len: number } | null = null;
    const walk = (v: unknown, path: (string | number)[]) => {
      if (typeof v === "string") {
        if (!best || v.length > best.len) best = { path, len: v.length };
      } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...path, i]));
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, [...path, k]);
    };
    walk(cur, []);
    const found = best as { path: (string | number)[]; len: number } | null;
    if (!found || found.len === 0 || found.path.length === 0) break;
    const copy = structuredClone(cur) as unknown as Record<string | number, unknown>;
    let o: Record<string | number, unknown> = copy;
    for (const key of found.path.slice(0, -1)) o = o[key] as Record<string | number, unknown>;
    const last = found.path[found.path.length - 1]!;
    o[last] = capText(o[last] as string, Math.floor(found.len / 2));
    cur = copy as unknown as ChatEvent;
    json = evFrameJson(chat, seq, cur);
    bytes = utf8Bytes(json);
  }
  return { e: cur, json, bytes };
}

/**
 * The agent id of an event (the message uuid, the block key, the tool-use id with the event's kind), or null for an
 * event that a history page never holds. The snapshot path drops ring events whose id is already in the history page
 * (4.3 step 5). A tool's call and its result carry one tool-use id, so the id names the kind too: a page that holds
 * only the call still gets the live result. History never holds a denied tag or a tool's progress, so they have none.
 * A stopped call, and a closed card's open and close (the server's own record, merged into history), have theirs.
 */
export function eventId(e: ChatEvent): string | null {
  switch (e.k) {
    case "user":
    case "taken_back":
    case "bash":
    case "refusal":
    case "info":
    case "memory":
    case "plugin_install":
    case "agent_error":
      return e.uuid;
    case "block_start":
    case "block_delta":
    case "block_end":
    case "block":
      return e.key;
    case "tool_call":
      return `call:${e.id}`;
    case "tool_result":
      return `result:${e.id}`;
    case "tool_stopped":
      return `stopped:${e.id}`;
    case "card_open":
      return `card:${e.card.id}`;
    case "card_close":
      return `close:${e.id}`;
    // U1: a turn's changes card, which history holds after its turn's end (from the store).
    case "changes":
      return `changes:${e.id}`;
    default:
      return null;
  }
}

export class Ring {
  private items: RingItem[] = [];
  private head = 0;
  private total = 0;

  constructor(
    readonly chat: string,
    private readonly maxEvents: number = WIRE.ringEvents,
    private readonly maxBytes: number = WIRE.ringBytes,
  ) {}

  /** Add the event with its number; the oldest events go when a limit is passed. */
  push(seq: number, e: ChatEvent, json: string = evFrameJson(this.chat, seq, e), bytes: number = utf8Bytes(json)): RingItem {
    const item: RingItem = { seq, e, json, bytes };
    const last = this.last;
    if (last !== null && seq !== last + 1) this.clear();
    this.items.push(item);
    this.total += item.bytes;
    while (this.size > this.maxEvents || (this.total > this.maxBytes && this.size > 1)) {
      this.total -= this.items[this.head]!.bytes;
      this.head++;
    }
    if (this.head > 1024 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return item;
  }

  get size(): number {
    return this.items.length - this.head;
  }

  get bytes(): number {
    return this.total;
  }

  /** The lowest number held, or null when empty. */
  get first(): number | null {
    return this.size === 0 ? null : this.items[this.head]!.seq;
  }

  get last(): number | null {
    return this.size === 0 ? null : this.items[this.items.length - 1]!.seq;
  }

  /** Whether the ring still holds the event numbered `seq`. */
  holds(seq: number): boolean {
    const first = this.first;
    return first !== null && seq >= first && seq <= this.last!;
  }

  /**
   * The event right after `seq`: null when there is none yet, "gap" when the ring already dropped it (the socket must
   * start again from a snapshot). An empty ring knows no numbers, so the registry tells a dropped ring apart (next).
   */
  next(seq: number): RingItem | null | "gap" {
    const first = this.first;
    if (first === null) return null;
    if (seq + 1 < first) return "gap";
    const i = seq + 1 - first;
    return i < this.size ? this.items[this.head + i]! : null;
  }

  /** Every event held, oldest first. */
  all(): RingItem[] {
    return this.items.slice(this.head);
  }

  clear(): void {
    this.items = [];
    this.head = 0;
    this.total = 0;
  }
}
