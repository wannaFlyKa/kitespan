// The message search (U5, FIX-U5 1, DESIGN-U5 10): the words of every kitespan chat's messages, kept in memory, and
// the scan that answers GET /api/search. Memory only: nothing is written to disk, and no index file is made.
//
// - The read. Each chat's transcript is read through the agent seam (transcriptEvents), and only its messages' text is
//   kept (server/search/text.ts), with its fold (shared/words.ts), per chat. A chat is read again only when its
//   transcript changed: the lite read's size and time (sessionInfo), which runs at most once per 10 s per chat; a turn's
//   end, a compaction and a reset that the registry relays mark the chat at once (touch). A chat with no session or no
//   transcript is skipped; every chat kitespan holds counts, archived ones too.
// - One reader. A pass walks the chats newest first (their last activity), yields between chats, and goes on until
//   every chat is fresh; a query joins the pass that runs. At most 64 MiB is kept (2 bytes a unit of the text, its fold
//   and its map, and 64 bytes a message): the chats that are kept are always the newest ones, so when one does not fit,
//   it and every older chat are left out (`capped`). The cap holds during a pass too: before a chat is read, the
//   oldest held chats go until its text fits. One chat keeps at most 8 MiB: its newest messages.
// - A query. It has 1,500 ms from its arrival: at the deadline it answers what is held, `complete: false`, and the pass
//   goes on in the background. Queries run one at a time, in arrival order. A newer query of the same tab aborts the
//   older one (in the queue, while it waits, or at the scan's next yield), as its page going away does; an aborted query
//   answers null (the route's 204) and logs nothing. Only a query with the sender gate's header starts disk reads;
//   without it, it answers from what is held. A query under the minimum starts the pass (the warm-up) and answers at
//   once with no hits.
// - The ranking. A message scores 2 x phrase + 1 x whole (shared/words.ts). A chat ranks by its best message, then by
//   its last activity (newest first), then by its id; inside a chat, at most 3 messages, by score, then the later one
//   first. At most 20 hits, cut between chats.
// - The whole cache goes after 10 minutes with no query (an unref'd timer).
// - The log: one `search` line per query that answered (the query's length, the chats read for it, the time, ok,
//   timeout, capped), and one with `len` null when a pass ends with no query waiting for it. Never the query's text.

import { MESSAGE_SEARCH, type MessageHit, type MessageSearchReply } from "../../shared/message-search";
import type { ChatEvent } from "../../shared/protocol";
import { matchScore, matchText, snippetOf, wordQuery, wordText, wordTextUnits, type WordQuery, type WordText } from "../../shared/words";
import type { Logger } from "../log";
import { searchableMessages, type SearchableMessage } from "./text";

export const MESSAGE_INDEX = {
  /** How long a query works, from its arrival, before it answers what is held. */
  deadlineMs: MESSAGE_SEARCH.deadlineMs,
  /** A chat's lite read runs at most once in this time (unless a turn's end marked it). */
  checkMs: 10_000,
  /** The whole cache goes after this long with no query. */
  idleMs: 10 * 60_000,
  /** What all chats keep together, and one chat, in estimated bytes. */
  capBytes: 64 * 1024 * 1024,
  chatBytes: 8 * 1024 * 1024,
  /** The estimate's cost of one message beside its units. */
  messageBytes: 64,
  /** The units a scan reads between two yields to the event loop. */
  scanYieldUnits: 1_000_000,
  /** The walks of one pass at most (a chat marked during a walk is read by the next). */
  rounds: 3,
} as const;
export type MessageIndexLimits = { -readonly [K in keyof typeof MESSAGE_INDEX]: number };

/** One chat as the index needs it: its session, the folder its session functions read, and its last activity (ms). */
export interface SearchChat {
  chat: string;
  sessionId: string | null;
  dir: string;
  activity: number;
}

/** The lite read: whether a transcript changed (its size, -1 when the agent does not say, and its time). */
export interface TranscriptStamp {
  size: number;
  mtime: number;
}

export interface MessageIndexOptions {
  /** Every chat kitespan holds, archived ones too. */
  chats(): readonly SearchChat[];
  /** The lite read; null when the transcript does not exist. */
  stamp(sessionId: string, dir: string): Promise<TranscriptStamp | null>;
  /** Every event of the transcript (the seam's transcriptEvents). */
  events(sessionId: string, dir: string): Promise<readonly ChatEvent[]>;
  log?: Pick<Logger, "log"> | null;
  now?: () => number;
  limits?: Partial<MessageIndexLimits>;
  /** The idle drop on a timer (default true; tests call dropIdle()). */
  timer?: boolean;
}

/** One ask of the search route. */
export interface SearchAsk {
  q: string;
  /** The page's tab: a newer ask of the same tab aborts this one. */
  tab: string | null;
  /** The sender gate's header was there: the ask may start disk reads. */
  read: boolean;
  /** The request's own signal (its page went away). */
  signal?: AbortSignal | null;
}

/** What the API route uses. */
export interface MessageSearch {
  /** The answer, or null when the ask was aborted (a newer one of its tab, or its page went away). */
  search(ask: SearchAsk): Promise<MessageSearchReply | null>;
}

interface Kept {
  id: string;
  by: SearchableMessage["by"];
  t: WordText;
}

interface Held {
  chat: string;
  sessionId: string;
  dir: string;
  activity: number;
  /** The lite read's stamp of the read that the messages came from (or that the cap left out). */
  stamp: TranscriptStamp | null;
  /** When the lite read last ran (the index's clock); 0: never. */
  checkedAt: number;
  /** A turn's end, a compaction or a reset since: the next pass checks it at once. */
  stale: boolean;
  /** The kept messages, oldest first; null when none are held. */
  msgs: Kept[] | null;
  /** The estimate of what the messages take, also when the cap left them out (0: not known). */
  bytes: number;
  /** The chat's own cap left its older messages out. */
  cut: boolean;
  /** No transcript (the lite read said so). */
  gone: boolean;
  /** The read of this stamp failed: it is tried again once the stamp changes. */
  failed: boolean;
}

interface Pass {
  done: Promise<void>;
  started: number;
  reads: number;
  capped: boolean;
  /** The queries that wait for this pass's end now. */
  waiters: number;
}

const yieldNow = () => new Promise<void>((r) => setImmediate(r));
const sameStamp = (a: TranscriptStamp | null, b: TranscriptStamp | null) => !!a && !!b && a.size === b.size && a.mtime === b.mtime;

/** Newest first, then by chat id. */
function byActivity(a: { activity: number; chat: string }, b: { activity: number; chat: string }): number {
  return b.activity - a.activity || (a.chat < b.chat ? -1 : a.chat > b.chat ? 1 : 0);
}

export class MessageIndex implements MessageSearch {
  private readonly held = new Map<string, Held>();
  private readonly opts: MessageIndexOptions;
  private readonly limits: MessageIndexLimits;
  private readonly now: () => number;
  private readonly useTimer: boolean;
  private pass: Pass | null = null;
  /** The chats read from disk since the start (a query's count is the difference). */
  private reads = 0;
  /** Whether the cap left chats or messages out at the end of the last walk. */
  private capped = false;
  /** The last query in the queue: the next one waits for it. */
  private tail: Promise<void> = Promise.resolve();
  private readonly byTab = new Map<string, AbortController>();
  private lastAsk = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(opts: MessageIndexOptions) {
    this.opts = opts;
    this.limits = { ...MESSAGE_INDEX, ...opts.limits };
    this.now = opts.now ?? Date.now;
    this.useTimer = opts.timer ?? true;
  }

  // -------------------------------------------------------------------------------------------------------------
  // What the registry tells

  /** A turn ended, a compaction or a reset happened: the chat's transcript is read again by the next pass. */
  touch(chat: string): void {
    const h = this.held.get(chat);
    if (h) h.stale = true;
  }

  /** The chat was deleted: what it held goes now. */
  forget(chat: string): void {
    this.held.delete(chat);
  }

  /** The background read (the surface's warm-up), as a query under the minimum starts it. */
  warm(): void {
    if (!this.closed) this.refresh();
  }

  close(): void {
    this.closed = true;
    this.held.clear();
    for (const c of this.byTab.values()) c.abort();
    this.byTab.clear();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Tests

  /** The chats whose messages are held now, newest first. */
  heldChats(): string[] {
    return [...this.held.values()].filter((h) => h.msgs).sort(byActivity).map((h) => h.chat);
  }

  /** The estimate of what is held now. */
  heldBytes(): number {
    let n = 0;
    for (const h of this.held.values()) if (h.msgs) n += h.bytes;
    return n;
  }

  /** Whether a pass runs now. */
  get reading(): boolean {
    return this.pass !== null;
  }

  /** The pass that runs, or none (tests wait for its end). */
  passDone(): Promise<void> {
    return this.pass?.done ?? Promise.resolve();
  }

  /** The idle drop (the timer's work): after 10 minutes with no query, everything held goes. */
  dropIdle(): void {
    if (this.pass) return this.armIdle();
    if (this.now() - this.lastAsk >= this.limits.idleMs) this.held.clear();
  }

  // -------------------------------------------------------------------------------------------------------------
  // A query

  async search(ask: SearchAsk): Promise<MessageSearchReply | null> {
    const arrival = this.now();
    this.lastAsk = arrival;
    this.armIdle();
    const ctl = new AbortController();
    const outer = ask.signal ?? null;
    const onAbort = () => ctl.abort();
    if (outer?.aborted) ctl.abort();
    else outer?.addEventListener("abort", onAbort, { once: true });
    if (ask.tab !== null) {
      this.byTab.get(ask.tab)?.abort();
      this.byTab.set(ask.tab, ctl);
    }
    try {
      if (ctl.signal.aborted || this.closed) return null;
      const query = wordQuery(ask.q);
      if (!query.asks) {
        if (ask.read) this.warm();
        return { q: ask.q, hits: [], complete: true };
      }
      const release = await this.turn(ctl.signal);
      try {
        if (ctl.signal.aborted || this.closed) return null;
        const reads0 = this.reads;
        let complete: boolean;
        let timeout = false;
        let capped = this.capped;
        if (ask.read) {
          const pass = this.refresh();
          pass.waiters++;
          const end = await this.until(pass.done, arrival + this.limits.deadlineMs, ctl.signal);
          if (end !== "done") pass.waiters--;
          if (end === "abort") return null;
          complete = end === "done";
          timeout = end === "late";
          capped = this.capped || pass.capped;
        } else complete = this.pass === null && !this.anyDue();
        const hits = await this.scan(query, ctl.signal);
        if (hits === null) return null;
        this.logLine({ len: [...ask.q].length, count: this.reads - reads0, ms: this.now() - arrival, ok: complete, timeout, capped });
        return { q: ask.q, hits, complete };
      } finally {
        release();
      }
    } finally {
      outer?.removeEventListener("abort", onAbort);
      if (ask.tab !== null && this.byTab.get(ask.tab) === ctl) this.byTab.delete(ask.tab);
    }
  }

  /** One query at a time, in arrival order: resolves when every earlier one is done, with the release of this one. */
  private async turn(signal: AbortSignal): Promise<() => void> {
    const prev = this.tail;
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    this.tail = prev.then(() => mine);
    if (signal.aborted) {
      void prev.then(release);
      return () => {};
    }
    let aborted = false;
    const stop = new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
    await Promise.race([prev, stop.then(() => (aborted = true))]);
    if (aborted) {
      // Its place in the queue is kept until the one before it is done, so no two queries ever run at once.
      void prev.then(release);
      return () => {};
    }
    return release;
  }

  /** The pass's end, the deadline, or the abort, whichever comes first. */
  private until(done: Promise<void>, deadline: number, signal: AbortSignal): Promise<"done" | "late" | "abort"> {
    if (signal.aborted) return Promise.resolve("abort");
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v: "done" | "late" | "abort") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      };
      const onAbort = () => finish("abort");
      const timer = setTimeout(() => finish("late"), Math.max(0, deadline - this.now()));
      signal.addEventListener("abort", onAbort, { once: true });
      void done.then(() => finish("done"));
    });
  }

  /** The hits of what is held, in rank order; null when the query was aborted at a yield. */
  private async scan(q: WordQuery, signal: AbortSignal): Promise<MessageHit[] | null> {
    const chats = [...this.held.values()].filter((h) => h.msgs).sort(byActivity);
    const ranked: { h: Held; best: number; rows: { m: Kept; score: number; anchor: number; i: number }[] }[] = [];
    let units = 0;
    for (const h of chats) {
      const msgs = h.msgs;
      if (!msgs) continue;
      const rows: { m: Kept; score: number; anchor: number; i: number }[] = [];
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i]!;
        units += m.t.fold.length;
        const hit = matchText(m.t, q);
        if (hit) rows.push({ m, score: matchScore(hit), anchor: hit.anchor, i });
      }
      if (rows.length) {
        rows.sort((a, b) => b.score - a.score || b.i - a.i);
        rows.length = Math.min(rows.length, MESSAGE_SEARCH.perChat);
        ranked.push({ h, best: rows[0]!.score, rows });
      }
      if (units >= this.limits.scanYieldUnits) {
        units = 0;
        await yieldNow();
        if (signal.aborted || this.closed) return null;
      }
    }
    ranked.sort((a, b) => b.best - a.best || byActivity(a.h, b.h));
    const hits: MessageHit[] = [];
    for (const r of ranked) {
      // A chat's rows are never split by the cut: it falls between chats.
      if (hits.length + r.rows.length > MESSAGE_SEARCH.hits) break;
      for (const row of r.rows) {
        const s = snippetOf(row.m.t, q, row.anchor);
        hits.push({ chat: r.h.chat, message: row.m.id, by: row.m.by, snippet: s.snippet, ranges: s.ranges.slice(0, MESSAGE_SEARCH.rangesMax) });
      }
    }
    return hits;
  }

  // -------------------------------------------------------------------------------------------------------------
  // The reader

  /** The pass that runs, or a new one. */
  private refresh(): Pass {
    if (this.pass) return this.pass;
    const pass: Pass = { done: Promise.resolve(), started: this.now(), reads: 0, capped: false, waiters: 0 };
    this.pass = pass;
    pass.done = (async () => {
      try {
        for (let round = 0; round < this.limits.rounds && !this.closed; round++) if (!(await this.walk(pass))) break;
      } catch {
        // a read that throws is passed over in walk(); nothing else should
      } finally {
        if (this.pass === pass) this.pass = null;
        if (pass.waiters === 0 && !this.closed) this.logLine({ len: null, count: pass.reads, ms: this.now() - pass.started, ok: true, timeout: false, capped: pass.capped });
      }
    })();
    return pass;
  }

  /** The held entries in step with the chats kitespan holds now, newest first. */
  private order(): Held[] {
    const seen = new Set<string>();
    const out: Held[] = [];
    for (const c of this.opts.chats()) {
      if (!c.sessionId) continue;
      seen.add(c.chat);
      let h = this.held.get(c.chat);
      if (!h || h.sessionId !== c.sessionId || h.dir !== c.dir) {
        h = { chat: c.chat, sessionId: c.sessionId, dir: c.dir, activity: c.activity, stamp: null, checkedAt: 0, stale: false, msgs: null, bytes: 0, cut: false, gone: false, failed: false };
        this.held.set(c.chat, h);
      }
      h.activity = c.activity;
      out.push(h);
    }
    for (const chat of [...this.held.keys()]) if (!seen.has(chat)) this.held.delete(chat);
    return out.sort(byActivity);
  }

  /** Whether the chat's lite read is due. */
  private due(h: Held): boolean {
    return h.stale || h.checkedAt === 0 || this.now() - h.checkedAt >= this.limits.checkMs;
  }

  private anyDue(): boolean {
    for (const c of this.opts.chats()) {
      if (!c.sessionId) continue;
      const h = this.held.get(c.chat);
      if (!h || h.sessionId !== c.sessionId || this.due(h)) return true;
    }
    return false;
  }

  /**
   * One walk over the chats, newest first. The chats that are kept are a prefix of that order within the cap: once one
   * does not fit, it and every older one are left out (their stamp and size stay known, so a later walk reads one
   * again only when there is room or its transcript changed). What is held stays within the cap during the walk too:
   * before a chat is read, the oldest held chats go until its last known size fits beside the newer ones and the older
   * ones left, and after the read until its new size does (room). True when it checked or read anything.
   */
  private async walk(pass: Pass): Promise<boolean> {
    const cap = this.limits.capBytes;
    let did = false;
    let used = 0;
    let full = false;
    let cut = false;
    const list = this.order();
    for (let i = 0; i < list.length; i++) {
      const h = list[i]!;
      if (this.closed) return false;
      if (full) {
        h.msgs = null;
        continue;
      }
      // Due, or not held while there may be room for it (a chat never read, or one the cap left out before).
      if (this.due(h) || (!h.msgs && !h.gone && !h.failed && used + h.bytes <= cap)) {
        did = true;
        const before = used;
        await this.check(h, pass, used, () => this.room(list, i, before + h.bytes));
        if (this.held.get(h.chat) === h) this.room(list, i, before + (h.msgs ? h.bytes : 0));
        await yieldNow();
        if (this.held.get(h.chat) !== h) continue;
      }
      if (h.gone) continue;
      if (h.msgs && used + h.bytes <= cap) {
        used += h.bytes;
        if (h.cut) cut = true;
        continue;
      }
      if (h.msgs) {
        // It grew past what is left: it goes, and every older chat with it.
        h.msgs = null;
        full = true;
      } else if (h.bytes > 0) full = true;
    }
    this.capped = full || cut;
    if (this.capped) pass.capped = true;
    return did;
  }

  /**
   * The cap during a walk: the chats older than `list[i]` that are held go, oldest first, while they and `bytes` (the
   * newer chats kept and `list[i]`'s own) pass the cap. The walk leaves them out anyway once one does not fit.
   */
  private room(list: readonly Held[], i: number, bytes: number): void {
    let older = 0;
    for (let j = i + 1; j < list.length; j++) if (list[j]!.msgs) older += list[j]!.bytes;
    for (let j = list.length - 1; j > i && bytes + older > this.limits.capBytes; j--) {
      const o = list[j]!;
      if (!o.msgs) continue;
      older -= o.bytes;
      o.msgs = null;
    }
  }

  /**
   * The lite read of one chat, and its read when the transcript changed, or when it is not held and fits; `room` runs
   * just before the read.
   */
  private async check(h: Held, pass: Pass, used: number, room: () => void): Promise<void> {
    let stamp: TranscriptStamp | null;
    try {
      stamp = await this.opts.stamp(h.sessionId, h.dir);
    } catch {
      h.checkedAt = this.now();
      h.stale = false;
      return; // a lite read that failed keeps what is held
    }
    h.checkedAt = this.now();
    h.stale = false;
    if (this.held.get(h.chat) !== h) return;
    if (stamp === null) {
      h.gone = true;
      h.msgs = null;
      h.bytes = 0;
      h.stamp = null;
      return;
    }
    h.gone = false;
    const same = sameStamp(stamp, h.stamp);
    if (same && (h.msgs || h.failed || used + h.bytes > this.limits.capBytes)) return;
    h.failed = false;
    room();
    let events: readonly ChatEvent[];
    try {
      events = await this.opts.events(h.sessionId, h.dir);
    } catch {
      h.failed = true;
      h.stamp = stamp;
      return;
    }
    if (this.held.get(h.chat) !== h || this.closed) return;
    pass.reads++;
    this.reads++;
    const kept = this.keep(searchableMessages(events));
    h.msgs = kept.msgs;
    h.bytes = kept.bytes;
    h.cut = kept.cut;
    h.stamp = stamp;
  }

  /** The newest messages within the chat's own cap, with their estimate. */
  private keep(found: readonly SearchableMessage[]): { msgs: Kept[]; bytes: number; cut: boolean } {
    const out: Kept[] = [];
    let bytes = 0;
    let cut = false;
    for (let i = found.length - 1; i >= 0; i--) {
      const m = found[i]!;
      const t = wordText(m.text);
      const b = 2 * wordTextUnits(t) + this.limits.messageBytes;
      if (bytes + b > this.limits.chatBytes) {
        cut = true;
        break;
      }
      bytes += b;
      out.push({ id: m.id, by: m.by, t });
    }
    out.reverse();
    return { msgs: out, bytes, cut };
  }

  // -------------------------------------------------------------------------------------------------------------

  private armIdle(): void {
    if (!this.useTimer || this.closed) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.dropIdle();
    }, this.limits.idleMs);
    (this.idleTimer as { unref?: () => void }).unref?.();
  }

  private logLine(f: { len: number | null; count: number; ms: number; ok: boolean; timeout: boolean; capped: boolean }): void {
    try {
      this.opts.log?.log("search", f);
    } catch {
      // the log never stops a search
    }
  }
}
