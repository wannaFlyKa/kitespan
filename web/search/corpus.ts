// The chat folder's file list on the page (DESIGN.md 9.3 "Where the filter runs"; BUILD-CHECKLIST C3). Each folder's
// list lives in a module map here, outside the store's State, so 100,000 paths never pass through a selector. It is
// kept per folder, not per chat (C3, R-corpus 4: one transfer per root and build), because every chat of a project
// has the project's folder: the key is the folder (corpusKey), so a second chat of the project sends the `v` that the
// page holds, the server answers `same`, and the one prepared copy serves both. The server keeps the last word: it
// answers `same` only when this chat's folder has that very build, so a chat whose folder differs gets its own list.
// A surface that opens (the search pane, the `@` picker) asks for the list with the `v` it holds: the server answers
// that the page's copy stands (`same`), sends the list when it fits the limit of the page's size class (100,000 paths
// on a laptop; 20,000 paths and 1,400,000 characters on touch), or says it is over the limit (`paths: null`), and then
// the server's search route ranks each query instead, asked through the chat that opened it last. One read runs at a
// time per folder, and an answer that a newer read overtook is dropped by its sequence number. A list that arrives is
// prepared in steps (shared/match.ts Corpus), so a large one never holds the page for one long task, and it is
// published only once it is ready, after one more step that runs the scorer once (warmScorer), so the first key typed
// is not the scorer's first run. The reads are GETs under /api/: they change nothing, so they are never recorded
// (net/frames.ts).
//
// What a surface gets is a FileSource (web/search/engine.ts); each surface makes its own engine from it, because the
// narrowing stack and the server route's one request in flight belong to one field's typing.
//
// The new-chat form's `@` picker (D59) reads a project's list before any chat exists: the project corpus routes
// (shared/corpus.ts projectCorpusPath), with the same limits and answers. Its list is kept under the same key, the
// project's folder, so the form and the project's chats share one copy; a server source asks through whoever read the
// list last (a chat or the project: `Owner`).

import { corpusPath, pageLimit, projectCorpusPath, type CorpusLimit, type CorpusReply } from "../../shared/corpus";
import { Corpus, warmScorer } from "../../shared/match";
import { projectRouteSearch, routeSearch, type FileSource, type SearchRoute } from "./engine";

/** Where one folder's list stands. */
export type CorpusState = "none" | "loading" | "ready" | "failed";

export interface CorpusSnapshot {
  state: CorpusState;
  /** The page's copy or the server's route; null before the first answer (or after a failed first read). */
  source: FileSource | null;
}

/** Whose routes a list is read through: a chat's, or (the new-chat form, D59) a project's. */
export type Owner = { chat: string } | { project: string };

const ownerKey = (o: Owner) => ("chat" in o ? `chat:${o.chat}` : `project:${o.project}`);
const listPathOf = (o: Owner, limit: CorpusLimit, v: string | null) => ("chat" in o ? corpusPath(o.chat, limit, v) : projectCorpusPath(o.project, limit, v));
const searchOf = (o: Owner, v: string | null, fetcher: typeof fetch): SearchRoute => ("chat" in o ? routeSearch(o.chat, v, fetcher) : projectRouteSearch(o.project, v, fetcher));

interface Entry {
  snap: CorpusSnapshot;
  v: string | null;
  /** Whose search route a server source asks through (ownerKey). */
  via: string | null;
  seq: number;
  /** The read in flight: its sequence number. */
  reading: number | null;
  limit: CorpusLimit | null;
  usedAt: number;
}

/** The folders whose lists are kept; the least recently opened one goes first. */
export const CORPUS_KEPT = 4;
/** Paths prepared per step before the page yields. */
export const PREPARE_STEP = 25_000;

const NONE: CorpusSnapshot = Object.freeze({ state: "none", source: null }) as CorpusSnapshot;
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();

function emit() {
  for (const l of [...listeners]) l();
}

/** Called when any folder's list changes; returns the unsubscribe. */
export function subscribeCorpus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The key of a chat's list: its folder (the project's), so the chats of one folder share one list; a chat whose
 * folder the page does not know yet keeps its own (its id, which never looks like a folder key).
 */
export function corpusKey(chat: string, folder?: string | null): string {
  return folder ? `folder:${folder}` : chat;
}

/**
 * The key of a project's list (the new-chat form, D59): its folder, as for its chats, so they share one list; a
 * project whose folder the page does not know yet keeps its own (`project:<id>`, never a chat's id or a folder key).
 */
export function projectCorpusKey(project: string, folder?: string | null): string {
  return folder ? `folder:${folder}` : `project:${project}`;
}

/** The list under one key (corpusKey) as it stands (the same object until it changes, for useSyncExternalStore). */
export function corpusOf(key: string | null): CorpusSnapshot {
  return (key && entries.get(key)?.snap) || NONE;
}

function set(e: Entry, snap: CorpusSnapshot) {
  e.snap = snap;
  emit();
}

function forgetOld() {
  if (entries.size <= CORPUS_KEPT) return;
  const old = [...entries.entries()].filter(([, e]) => e.reading === null).sort((a, b) => a[1].usedAt - b[1].usedAt);
  for (const [key] of old.slice(0, entries.size - CORPUS_KEPT)) entries.delete(key);
}

/** The pieces a read needs, so a unit test runs it without a network or timers. */
export interface CorpusDeps {
  fetcher?: typeof fetch;
  /** Run the next preparation step later (a macrotask on the page). */
  later?: (run: () => void) => void;
  now?: () => number;
  /** Run the scorer once over a prepared list before it is published (warmScorer). */
  warm?: (corpus: Corpus) => unknown;
}

const defaultLater = (run: () => void) => setTimeout(run, 0);

/**
 * Ask for a chat's list (a surface opened), kept under `key` (corpusKey: the chat's folder). One read at a time per
 * key: while one is in flight, this does nothing. The answer replaces the source only when it is newer: `same` keeps
 * the page's copy (a server source is asked through this chat from then on), a list becomes a new prepared Corpus
 * (and so a new source), and a list over the limit becomes the server's search route. A read that fails keeps what
 * the page had, or marks the list failed when it had nothing: no rows and no line (5.4 has none for it).
 */
export function openCorpus(chat: string, touch: boolean, deps: CorpusDeps = {}, key: string = corpusKey(chat)): Promise<void> {
  return openList({ chat }, touch, deps, key);
}

/** A project's list (the new-chat form's `@` picker, D59), through the project corpus routes; as openCorpus. */
export function openProjectCorpus(project: string, touch: boolean, deps: CorpusDeps = {}, key: string = projectCorpusKey(project)): Promise<void> {
  return openList({ project }, touch, deps, key);
}

function openList(owner: Owner, touch: boolean, deps: CorpusDeps, key: string): Promise<void> {
  const via = ownerKey(owner);
  const fetcher = deps.fetcher ?? fetch;
  const later = deps.later ?? defaultLater;
  const now = deps.now ?? Date.now;
  const warm = deps.warm ?? warmScorer;
  let e = entries.get(key);
  if (!e) {
    e = { snap: NONE, v: null, via: null, seq: 0, reading: null, limit: null, usedAt: now() };
    entries.set(key, e);
  }
  e.usedAt = now();
  if (e.reading !== null) return Promise.resolve();
  const entry = e;
  const limit = pageLimit(touch);
  // A new size class (a tablet's pointer, a window moved) asks for the list again from scratch.
  const held = entry.limit && entry.limit.max === limit.max && entry.limit.chars === limit.chars ? entry.v : null;
  const seq = ++entry.seq;
  entry.reading = seq;
  if (entry.snap.state === "none" || entry.snap.state === "failed") set(entry, { state: "loading", source: entry.snap.source });
  const current = () => entries.get(key) === entry && entry.seq === seq;
  const done = () => {
    if (entry.reading === seq) entry.reading = null;
    forgetOld();
  };
  return fetcher(listPathOf(owner, limit, held), { method: "GET", headers: { accept: "application/json" }, cache: "no-store" })
    .then(async (res) => {
      if (!res.ok) throw new Error(`corpus: ${res.status}`);
      return (await res.json()) as CorpusReply;
    })
    .then(
      (reply) =>
        new Promise<void>((resolve) => {
          if (!current()) return resolve();
          if ("same" in reply) {
            // The page's copy stands: the same snapshot, so nothing that reads it draws again; a server source that
            // another chat of the folder (or the project's form) read is asked through this one from now on.
            const source = entry.snap.source;
            if (!source) set(entry, { state: "failed", source: null });
            else if (source.at === "server" && entry.via !== via) {
              entry.via = via;
              set(entry, { state: "ready", source: { at: "server", search: searchOf(owner, reply.v, fetcher) } });
            } else if (entry.snap.state !== "ready") set(entry, { state: "ready", source });
            return resolve();
          }
          if (reply.paths === null) {
            entry.v = reply.v;
            entry.via = via;
            entry.limit = limit;
            set(entry, { state: "ready", source: { at: "server", search: searchOf(owner, reply.v, fetcher) } });
            return resolve();
          }
          const corpus = new Corpus(reply.paths, reply.v);
          const step = () => {
            if (!current()) return resolve();
            if (!corpus.prepare(PREPARE_STEP)) return later(step);
            later(publish);
          };
          // A step of its own, so the warm-up never lengthens the last preparation step's task.
          const publish = () => {
            if (!current()) return resolve();
            warm(corpus);
            entry.v = reply.v;
            entry.via = via;
            entry.limit = limit;
            set(entry, { state: "ready", source: { at: "page", corpus } });
            resolve();
          };
          step();
        }),
    )
    .catch(() => {
      if (!current()) return;
      if (!entry.snap.source) set(entry, { state: "failed", source: null });
      else if (entry.snap.state !== "ready") set(entry, { state: "ready", source: entry.snap.source });
    })
    .finally(done);
}

/** Forget every list (a test's fresh start). */
export function resetCorpora() {
  entries.clear();
  emit();
}
