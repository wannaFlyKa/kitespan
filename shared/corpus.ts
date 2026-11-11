// The corpus routes' contract (DESIGN.md 9.3 "The routes" and "Where the filter runs"): the chat folder's file list
// as two GET reads under /api/ that take a chat id and never a path. The server and the page both import this file:
// its limits, its answers' shapes, the paths the page asks for, and the strict readers of their query strings.
//
//   GET /api/chats/:chat/corpus?max=&chars=&v=        -> CorpusReply
//   GET /api/chats/:chat/corpus/search?q=&v=          -> CorpusSearchReply
//
// The new-chat form's `@` picker (D59) reads its project's folder through the same two reads, with the same keys,
// replies, limits and errors, under a project id:
//
//   GET /api/projects/:project/corpus?max=&chars=&v=
//   GET /api/projects/:project/corpus/search?q=&v=
//
// The page holds its own copy when the list fits the limit it sends (`max` paths and, on touch, `chars` characters),
// and filters it with shared/match.ts. Over the limit, the answer has `paths: null`, and the page asks the search route
// on each keystroke instead, which ranks with the same matcher and sends the best 120 rows.

import type { NameRange } from "./match";
import { CONTROL_CHARS } from "./protocol";

export const CORPUS_LIMITS = {
  /** The most paths one corpus holds: git and the walk stop there (`complete: false`). */
  maxPaths: 100_000,
  /** The page's own copy at the laptop size. */
  laptopPaths: 100_000,
  /** On touch (medium touch and the phone, 7.1): the paths, and their characters, since the cost follows them. */
  touchPaths: 20_000,
  touchChars: 1_400_000,
  /** The JSON of an answer with its paths is at most this many bytes, whatever the page asked; else `paths: null`. */
  jsonBytes: 16 * 1024 * 1024,
  /** The search route's `q`, in UTF-16 units. */
  queryMax: 1_024,
  /** The server's scan yields to the event loop after this many paths. */
  yieldEvery: 20_000,
} as const;

/** A build's id (`v`), which the server mints per build and the page sends back as it got it. */
export const CORPUS_V = /^[A-Za-z0-9_-]{1,64}$/;

/** `git` (ls-files), `walk` (outside git, or when git lists nothing) or `none` (no listing could run). */
export type CorpusSource = "git" | "walk" | "none";

/** The page's `v` is the current build: its copy stands. */
export interface CorpusSameReply {
  v: string;
  same: true;
}

/** A build: its paths when it fits the page's limit, else `paths: null` (too large: the page asks the search route). */
export interface CorpusListReply {
  v: string;
  source: CorpusSource;
  /** False when the path cap or a deadline cut the list. */
  complete: boolean;
  /** The number of paths in the build. */
  total: number;
  /** Their characters (UTF-16 units), summed. */
  chars: number;
  /** Paths relative to the chat's folder, in the build's order; null over the page's limit or the JSON cap. */
  paths: string[] | null;
}

/** GET /api/chats/:chat/corpus. */
export type CorpusReply = CorpusSameReply | CorpusListReply;

/** One row of the search route: the path and the matched letters of its name (its basename). */
export interface CorpusSearchRow {
  path: string;
  nameRanges: NameRange[];
}

/** GET /api/chats/:chat/corpus/search. */
export interface CorpusSearchReply {
  /** The build that answered (it may be newer than the page's `v`). */
  v: string;
  /** The number of paths in that build. */
  total: number;
  /** The true number of matching paths. */
  count: number;
  /** At most 120 rows, best first. */
  rows: CorpusSearchRow[];
}

/** The limit the page sends for its size class: `chars` only on touch. */
export interface CorpusLimit {
  max: number;
  chars: number | null;
}

export function pageLimit(touch: boolean): CorpusLimit {
  return touch ? { max: CORPUS_LIMITS.touchPaths, chars: CORPUS_LIMITS.touchChars } : { max: CORPUS_LIMITS.laptopPaths, chars: null };
}

/** True when a build of `total` paths, `chars` characters and `jsonBytes` of JSON goes to the page with its paths. */
export function fitsPage(build: { total: number; chars: number; jsonBytes: number }, limit: CorpusLimit): boolean {
  return build.total <= limit.max && (limit.chars === null || build.chars <= limit.chars) && build.jsonBytes <= CORPUS_LIMITS.jsonBytes;
}

const chatPart = (chat: string) => `/api/chats/${encodeURIComponent(chat)}/corpus`;
const projectPart = (project: string) => `/api/projects/${encodeURIComponent(project)}/corpus`;

function listPath(base: string, limit: CorpusLimit, v: string | null): string {
  const qs = new URLSearchParams({ max: String(limit.max) });
  if (limit.chars !== null) qs.set("chars", String(limit.chars));
  if (v) qs.set("v", v);
  return `${base}?${qs}`;
}

function searchPath(base: string, q: string, v: string | null): string {
  const qs = new URLSearchParams({ q });
  if (v) qs.set("v", v);
  return `${base}/search?${qs.toString().replace(/\+/g, "%20")}`;
}

/** The page's corpus read. */
export function corpusPath(chat: string, limit: CorpusLimit, v: string | null = null): string {
  return listPath(chatPart(chat), limit, v);
}

/** The page's search read, for a corpus over its limit. */
export function corpusSearchPath(chat: string, q: string, v: string | null = null): string {
  return searchPath(chatPart(chat), q, v);
}

/** The new-chat form's corpus read: the project's folder (D59). */
export function projectCorpusPath(project: string, limit: CorpusLimit, v: string | null = null): string {
  return listPath(projectPart(project), limit, v);
}

/** The new-chat form's search read, for a project's corpus over its limit. */
export function projectCorpusSearchPath(project: string, q: string, v: string | null = null): string {
  return searchPath(projectPart(project), q, v);
}

/** One value of a key, or undefined when absent; null when it repeats with different values. */
function one(search: URLSearchParams, key: string): string | undefined | null {
  const all = search.getAll(key);
  if (all.length === 0) return undefined;
  return all.every((x) => x === all[0]) ? all[0]! : null;
}

function wholeNumber(raw: string | undefined | null, max: number): number | undefined | null {
  if (raw === undefined) return undefined;
  if (raw === null || !/^[0-9]{1,9}$/.test(raw)) return null;
  const n = Number(raw);
  return n <= max ? n : null;
}

function version(raw: string | undefined | null): string | null | false {
  if (raw === undefined) return null;
  return raw !== null && CORPUS_V.test(raw) ? raw : false;
}

/**
 * The corpus read's query: `max` (0 to 100,000; required), `chars` (optional, at most 16 Mi) and `v` (optional).
 * null: a bad query, which the route answers with 400. Unknown keys are ignored.
 */
export function readCorpusQuery(search: URLSearchParams): { limit: CorpusLimit; v: string | null } | null {
  const max = wholeNumber(one(search, "max"), CORPUS_LIMITS.maxPaths);
  if (max === undefined || max === null) return null;
  const chars = wholeNumber(one(search, "chars"), CORPUS_LIMITS.jsonBytes);
  if (chars === null) return null;
  const v = version(one(search, "v"));
  if (v === false) return null;
  return { limit: { max, chars: chars ?? null }, v };
}

/**
 * The search read's query: `q` (at most 1,024 characters, no control character; absent is empty) and `v` (optional).
 * null: a bad query, which the route answers with 400.
 */
export function readSearchQuery(search: URLSearchParams): { q: string; v: string | null } | null {
  const q = one(search, "q");
  if (q === null) return null;
  if (q !== undefined && (q.length > CORPUS_LIMITS.queryMax || CONTROL_CHARS.test(q))) return null;
  const v = version(one(search, "v"));
  if (v === false) return null;
  return { q: q ?? "", v };
}
