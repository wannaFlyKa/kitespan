// U5 (FIX-U5 1, DESIGN-U5 8 and 10): the search pane's ask for the Messages group, with no React and no DOM. The pane
// sets the field's own value (the typed one, not the deferred one) on each change; 250 ms after the last change, and
// only past the minimum (shared/words.ts), it asks GET /api/search?q=&tab= (shared/message-search.ts, the contract
// with the server) with the sender gate's header (a read that may start the server's disk reads, D59) and an
// AbortController. It sends the query's words (queryText: the 8 that the search uses, at most the server's 200 units),
// so a long pasted line is searched too. Each change aborts the older ask, and an answer whose q is not what was sent
// for the field's value now is dropped. "slow" is set 1,000 ms after the ask left with no answer (the pane's
// "Searching messages…"). An answer that is not complete (the server's deadline cut its read) shows its hits and is
// asked again 1,000 ms later while the field holds q, at most 3 times. A failed ask (the network, a refusal, a reply
// of the wrong shape) is `failed` for q. When the pane opens it sends one warm-up read with an empty q, which starts
// the server's background read and answers at once.
//
// The newest answers are kept for the page's life (a few, by query), so a pane that opens again on the same query
// (Back to the search, a reload of the pane's place) shows its Messages rows at once and asks again.
//
// The typing never waits for this: the pane's own groups answer at once, and this only adds the last group.

import { asksMessages as minimumMet, queryText } from "../../shared/words";
import { MESSAGE_SEARCH, messageSearchPath, messageSearchReplyOf, type MessageHit } from "../../shared/message-search";
import { apiGet } from "../net/api";
import { tabId } from "../net/socket";

export type { MessageHit };

/** The pause after the field's last change (the harness's 250 ms). */
export const ASK_MS = 250;
/** No answer this long after the ask left: the pane says "Searching messages…". */
export const SLOW_MS = 1000;
/** An answer that is not complete is asked again this much later... */
export const AGAIN_MS = 1000;
/** ...at most this many times. */
export const AGAIN_MAX = 3;
/** The answers kept for a pane that opens again on the same query. */
const KEEP = 8;

/** The query passes the minimum of the message search (one word of 2 characters or more, or a Han, Hiragana or Katakana one). */
export const asksMessages = (q: string): boolean => minimumMet(q);

// ---- the kept answers ----

const kept = new Map<string, readonly MessageHit[]>();

function keep(q: string, hits: readonly MessageHit[]) {
  kept.delete(q);
  kept.set(q, hits);
  while (kept.size > KEEP) kept.delete(kept.keys().next().value!);
}

/** The kept answer for `q`, if any (what a pane that opens again shows before its own answer). */
export function keptAnswer(q: string): readonly MessageHit[] | null {
  return kept.get(q) ?? null;
}

/** Drop every kept answer (tests). */
export function forgetKept(): void {
  kept.clear();
}

// ---- the ask ----

export interface AskSnapshot {
  /** The field's value that this state is about ("" when nothing is asked). */
  q: string;
  /** An ask is due for q: it passes the minimum and the scope keeps Messages. */
  on: boolean;
  /** The newest answer's hits for q (or the kept ones before it); null before any. */
  hits: readonly MessageHit[] | null;
  /** An answer for q came to this pane. */
  answered: boolean;
  /** No more rows come for q: the answer was complete, or the asks again ran out. */
  settled: boolean;
  /** No answer SLOW_MS after the ask left. */
  slow: boolean;
  /** The ask for q failed. */
  failed: boolean;
}

export interface MessageAsk {
  /** The field's value now, and whether the scope keeps Messages. */
  set(q: string, on: boolean): void;
  /** The pane opened: one read with an empty q starts the server's background read. */
  warm(): void;
  snapshot(): AskSnapshot;
  subscribe(fn: () => void): () => void;
  /** The pane closed: the ask in flight and every timer go (a later set() starts again). */
  close(): void;
}

export interface AskDeps {
  fetcher?: typeof fetch;
  /** Run `fn` after `ms`; returns the cancel. */
  later?: (fn: () => void, ms: number) => () => void;
  /** This tab's id (the `hello` frame's), so the server's newer query of the tab drops the older. */
  tab?: () => string;
}

const OFF: AskSnapshot = { q: "", on: false, hits: null, answered: false, settled: false, slow: false, failed: false };

const timeout = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

export function createMessageAsk(deps: AskDeps = {}): MessageAsk {
  const later = deps.later ?? timeout;
  const tab = deps.tab ?? tabId;
  let snap: AskSnapshot = OFF;
  const subs = new Set<() => void>();
  let ctrl: AbortController | null = null;
  let warmCtrl: AbortController | null = null;
  let cancels: (() => void)[] = [];
  let again = 0;

  const emit = (next: AskSnapshot) => {
    snap = next;
    for (const fn of [...subs]) fn();
  };
  const stop = () => {
    ctrl?.abort();
    ctrl = null;
    for (const c of cancels) c();
    cancels = [];
  };
  const url = (q: string) => messageSearchPath(q, tab());

  const ask = (q: string) => {
    if (snap.q !== q) return;
    const sent = queryText(q, MESSAGE_SEARCH.queryMax);
    const mine = new AbortController();
    ctrl = mine;
    const slowOff = later(() => {
      if (ctrl === mine && snap.q === q) emit({ ...snap, slow: true });
    }, SLOW_MS);
    cancels.push(slowOff);
    const retry = () => {
      if (again >= AGAIN_MAX) return false;
      again++;
      cancels.push(later(() => ask(q), AGAIN_MS));
      return true;
    };
    apiGet<unknown>(url(sent), deps.fetcher ?? fetch, true, mine.signal).then(
      (body) => {
        if (mine.signal.aborted || ctrl !== mine || snap.q !== q) return;
        ctrl = null;
        slowOff();
        // A 204: the server dropped this read for a newer one of this tab; ask once more a little later.
        if (body === null) {
          if (!retry()) emit({ ...snap, slow: false, failed: true });
          else if (snap.slow) emit({ ...snap, slow: false });
          return;
        }
        const reply = messageSearchReplyOf(body);
        if (!reply) return emit({ ...snap, slow: false, failed: true });
        // A stale answer: its query is not what was sent for the field's value now.
        if (reply.q !== sent) return;
        keep(q, reply.hits);
        const more = !reply.complete && retry();
        emit({ ...snap, hits: reply.hits, answered: true, settled: !more, slow: false, failed: false });
      },
      () => {
        if (mine.signal.aborted || ctrl !== mine || snap.q !== q) return;
        ctrl = null;
        slowOff();
        emit({ ...snap, slow: false, failed: true });
      },
    );
  };

  return {
    set(q, on) {
      const due = on && asksMessages(q);
      if (due && snap.on && snap.q === q) return;
      if (!due && !snap.on && snap.q === "") return;
      stop();
      again = 0;
      if (!due) return emit(OFF);
      emit({ q, on: true, hits: keptAnswer(q), answered: false, settled: false, slow: false, failed: false });
      cancels.push(later(() => ask(q), ASK_MS));
    },
    warm() {
      warmCtrl?.abort();
      const mine = new AbortController();
      warmCtrl = mine;
      apiGet<unknown>(url(""), deps.fetcher ?? fetch, true, mine.signal).then(
        () => {},
        () => {},
      );
    },
    snapshot: () => snap,
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    close() {
      stop();
      warmCtrl?.abort();
      warmCtrl = null;
      // A pane that mounts again sets its value again: the state starts from nothing.
      snap = OFF;
    },
  };
}

/** How the pane makes its ask (the tests put a fixed state here). */
export const askMaker: { make: (deps?: AskDeps) => MessageAsk } = { make: createMessageAsk };

/** What the pane draws for the field's value `q` from the ask's state: the rows, the slow line, and whether the group is done. */
export interface MessagesView {
  /** An ask is due for q. */
  due: boolean;
  hits: readonly MessageHit[] | null;
  slow: boolean;
  /** No more rows come for q (or none were asked): the pane may say that nothing matches. */
  done: boolean;
  failed: boolean;
}

/**
 * The view for `q`: before the ask's state catches up with the field (the render before its effect), the kept answer
 * for q and not done; with no ask due, done.
 */
export function messagesView(snap: AskSnapshot, q: string, on: boolean): MessagesView {
  const due = on && asksMessages(q);
  if (!due) return { due, hits: null, slow: false, done: true, failed: false };
  if (snap.q !== q || !snap.on) return { due, hits: keptAnswer(q), slow: false, done: false, failed: false };
  return { due, hits: snap.hits, slow: snap.slow, done: snap.answered && snap.settled, failed: snap.failed };
}
