// The engine of search on the page (DESIGN.md 9.3, D55): the one place that the `@` picker and the search pane get
// file rows from. Either the page holds the chat folder's list (a prepared Corpus, filtered here and narrowed while
// the query grows), or the list is over the page's limit and the server's search route ranks each query with the same
// matcher. Both give the same shape, so the picker and the pane never know which one answered.
//
// The contract for a hook. `createFileEngine(source)` makes one engine per source: per prepared corpus (a new build,
// a new `v`, is a new corpus and so a new engine) or per server route. Then:
// - `rows(q)` is the snapshot (for `useSyncExternalStore`), called with the deferred query the rows follow: pure, and
//   it never starts a request. The page's copy answers it at once for `q`; the server route answers with its answer
//   for `q` when it holds one (it keeps its last two), else its newest, whose `q` may be an older or a newer query.
// - `ask(q)` is the effect (`useEffect` on `[engine, q]`), called with the field's current value, not the deferred
//   one, so the request leaves as the field echoes the key, before the deferred render: it asks the server for `q`.
//   The page's copy needs nothing.
// - `subscribe(listener)` tells when a server answer lands.
// - `close()` aborts the request in flight; call it when the engine is replaced or the surface closes.
// The server route keeps one request in flight. An answer for a query that is no longer the newest is dropped, and
// the newest is asked next. The rows' `q` and `count` are what the list's root shows as `data-q` and `data-count`.
// No React, no DOM: the unit tests run it as it is.

import { corpusSearchPath, projectCorpusSearchPath, type CorpusSearchReply } from "../../shared/corpus";
import { Searcher, TOP_ROWS, nameStart, type Corpus, type NameRange } from "../../shared/match";

/** One file row: the folder part is `path.slice(0, nameStart)`; the ranges index the name after it. */
export interface FileRow {
  /** Relative to the chat's folder. */
  path: string;
  nameStart: number;
  nameRanges: NameRange[];
}

/** The rows for one query. */
export interface FileRows {
  /** The query these rows answer (the list's `data-q`); a server answer may be for an older query than the field's. */
  q: string;
  /** The true number of matching files (the list's `data-count`). */
  count: number;
  /** At most 120, best first. */
  rows: FileRow[];
  /** The server's search failed: no rows, and no "No file matches" line either. */
  failed?: true;
}

/** The server's search route as a function: one query in, the best rows out; aborted by its signal. */
export type SearchRoute = (q: string, signal: AbortSignal) => Promise<CorpusSearchReply>;

/** Where the file rows come from. */
export type FileSource =
  /** The page's own copy, prepared when it arrived (`prepareCorpus`). */
  | { at: "page"; corpus: Corpus }
  /** The server's search route (the list is over the page's limit). */
  | { at: "server"; search: SearchRoute };

export interface FileEngine {
  readonly at: FileSource["at"];
  /**
   * The rows for `q`: the page's copy's (null until it is prepared), or the server's answer for `q` or its newest (null
   * before one).
   */
  rows(q: string): FileRows | null;
  /** Ask the server for `q`; the page's copy needs nothing. */
  ask(q: string): void;
  /** Called when a server answer lands; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Abort the request in flight and drop the listeners. */
  close(): void;
}

/** The engine over one source: the picker and the pane each make one when they open, and close it when they close. */
export function createFileEngine(source: FileSource): FileEngine {
  return source.at === "page" ? pageEngine(source.corpus) : serverEngine(source.search);
}

const noUnsubscribe = () => {};

function pageEngine(corpus: Corpus): FileEngine {
  const searcher = new Searcher(corpus, TOP_ROWS);
  // The last two answers: a render with the deferred query and one with the newest may alternate, and each must get
  // the same object back without a scan (the snapshot rule of useSyncExternalStore).
  let last: FileRows | null = null;
  let before: FileRows | null = null;
  return {
    at: "page",
    rows(q) {
      if (!corpus.ready) return null;
      if (last && last.q === q) return last;
      if (before && before.q === q) {
        [last, before] = [before, last];
        return last;
      }
      before = last;
      last = searcher.search(q);
      return last;
    },
    ask() {},
    subscribe: () => noUnsubscribe,
    close() {},
  };
}

function serverEngine(search: SearchRoute): FileEngine {
  const listeners = new Set<() => void>();
  // The last two answers, the newest first: the deferred render still asks for the query before the field's newest,
  // and gets its own answer (the same object) while the newest lands.
  let latest: FileRows | null = null;
  let before: FileRows | null = null;
  let wanted: string | null = null;
  let inflight: AbortController | null = null;
  let closed = false;

  const held = (q: string) => (latest?.q === q ? latest : before?.q === q ? before : null);
  const publish = (rows: FileRows) => {
    if (latest?.q !== rows.q) before = latest;
    latest = rows;
    for (const l of [...listeners]) l();
  };
  const send = (q: string) => {
    const ctrl = new AbortController();
    inflight = ctrl;
    const landed = (rows: FileRows) => {
      if (closed || inflight !== ctrl) return;
      inflight = null;
      if (q === wanted) publish(rows);
      else if (wanted !== null && !held(wanted)) send(wanted);
    };
    let pending: Promise<CorpusSearchReply>;
    try {
      pending = search(q, ctrl.signal);
    } catch (e) {
      pending = Promise.reject(e);
    }
    pending.then(
      (reply) => landed({ q, count: reply.count, rows: reply.rows.map((r) => ({ path: r.path, nameStart: nameStart(r.path), nameRanges: r.nameRanges })) }),
      () => landed({ q, count: 0, rows: [], failed: true }),
    );
  };

  return {
    at: "server",
    rows: (q) => held(q) ?? latest,
    ask(q) {
      if (closed) return;
      wanted = q;
      if (held(q) || inflight) return;
      send(q);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      closed = true;
      inflight?.abort();
      inflight = null;
      listeners.clear();
    },
  };
}

/** The server's search route for one chat: a GET with no body, aborted with its signal; a refused answer throws. */
export function routeSearch(chat: string, v: string | null = null, fetcher: typeof fetch = fetch): SearchRoute {
  return searchAt((q) => corpusSearchPath(chat, q, v), fetcher);
}

/** The same for a project's folder (the new-chat form's `@` picker, D59): the project corpus search route. */
export function projectRouteSearch(project: string, v: string | null = null, fetcher: typeof fetch = fetch): SearchRoute {
  return searchAt((q) => projectCorpusSearchPath(project, q, v), fetcher);
}

function searchAt(path: (q: string) => string, fetcher: typeof fetch): SearchRoute {
  return async (q, signal) => {
    const res = await fetcher(path(q), { method: "GET", headers: { accept: "application/json" }, cache: "no-store", signal });
    if (!res.ok) throw new Error(`search: ${res.status}`);
    return (await res.json()) as CorpusSearchReply;
  };
}
