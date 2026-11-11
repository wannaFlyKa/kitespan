// U1 (DESIGN-U1 9): the changes view's two reads, both GET by the chat's id and the summary's id, never a host path:
// a turn's summary (its list) and one file's diff. They run only when the side panel opens them, never on a timer;
// the diff's text reaches the page only then. Both answers never change (the marks are kept trees), so a read is kept
// for the page's life (the newest few diffs), and a reload reads again. What each answer gives, as plain functions
// (summaryState, diffState); the hooks put them on screen, with "Reading the diff…" after 300 ms.
import { useEffect, useState } from "react";
import { changeFileApiPath, changesApiPath } from "../../shared/changes";
import { readDiff, readSummary, type ChangesSummary, type FileDiff } from "./model";

/** An answer as the page got it: its HTTP status (0: the request did not reach the server) and its JSON body. */
export interface Answer {
  status: number;
  body: unknown;
}

export type SummaryState = { phase: "loading" } | { phase: "ok"; summary: ChangesSummary } | { phase: "gone" } | { phase: "failed" };
export type DiffState = { phase: "loading" } | { phase: "ok"; diff: FileDiff } | { phase: "gone" } | { phase: "missing" } | { phase: "notKept" } | { phase: "failed" };

/** The server's word for what is not there (shared/changes.ts ChangesMissing): no_turn, no_file or gone. */
function missingState(body: unknown): string | null {
  const s = body && typeof body === "object" ? (body as { state?: unknown }).state : null;
  return typeof s === "string" ? s : null;
}

/**
 * A summary's answer: the summary; 404 (or 410) no longer kept, also as the server's word in a 200 answer; anything
 * else could not be read.
 */
export function summaryState(a: Answer): SummaryState {
  const word = missingState(a.body);
  if (word === "no_turn" || word === "gone") return { phase: "gone" };
  if (a.status === 200) {
    const summary = readSummary(a.body);
    return summary ? { phase: "ok", summary } : { phase: "failed" };
  }
  return a.status === 404 || a.status === 410 ? { phase: "gone" } : { phase: "failed" };
}

/**
 * A diff's answer: the diff; 410 (`gone`) its marks' objects are gone; 404 is the summary that is no longer kept
 * (`no_turn`), or a path that is not in the turn's changes (`no_file`; with no word, a path that `summary` does not list);
 * anything else could not be read (a failure, the server's deadline, the network).
 */
export function diffState(a: Answer, summary: ChangesSummary | null, path: string): DiffState {
  const word = missingState(a.body);
  // The server's word comes with its status (404, 410) or in a 200 answer: the same line either way.
  if (word === "gone") return { phase: "gone" };
  if (word === "no_turn") return { phase: "notKept" };
  if (word === "no_file") return { phase: "missing" };
  if (a.status === 200) {
    const diff = readDiff(a.body);
    return diff ? { phase: "ok", diff } : { phase: "failed" };
  }
  if (a.status === 410) return { phase: "gone" };
  if (a.status === 404) {
    return summary && !summary.files.some((f) => f.path === path) ? { phase: "missing" } : { phase: "gone" };
  }
  return { phase: "failed" };
}

/** A GET of a changes read: its status and its JSON body; a request that did not reach the server is status 0. */
async function read(path: string): Promise<Answer> {
  try {
    const res = await fetch(path, { method: "GET", headers: { accept: "application/json", "x-kitespan": "1" }, cache: "no-store" });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {}
    return { status: res.status, body };
  } catch {
    return { status: 0, body: null };
  }
}

// The answers that never change, kept for the page's life: every summary, and the newest diffs.
const summaries = new Map<string, ChangesSummary>();
const diffs = new Map<string, FileDiff>();
const DIFFS_KEPT = 24;
const keepDiff = (key: string, d: FileDiff) => {
  diffs.delete(key);
  diffs.set(key, d);
  for (const k of [...diffs.keys()].slice(0, Math.max(0, diffs.size - DIFFS_KEPT))) diffs.delete(k);
};

/** How long a read runs before its line says so (DESIGN-U1 7.3). */
export const SLOW_MS = 300;

/** A turn's summary, read when the view opens it (again after Try again, `attempt`). */
export function useSummary(chat: string, turn: string, attempt: number): SummaryState {
  const key = `${chat}/${turn}`;
  const kept = summaries.get(key);
  const [state, setState] = useState<{ key: string; s: SummaryState }>({ key, s: kept ? { phase: "ok", summary: kept } : { phase: "loading" } });
  useEffect(() => {
    const had = summaries.get(key);
    if (had) {
      setState({ key, s: { phase: "ok", summary: had } });
      return;
    }
    let live = true;
    setState({ key, s: { phase: "loading" } });
    void read(changesApiPath(chat, turn)).then((a) => {
      const s = summaryState(a);
      if (s.phase === "ok") summaries.set(key, s.summary);
      if (live) setState({ key, s });
    });
    return () => {
      live = false;
    };
  }, [key, attempt]);
  return state.key === key ? state.s : kept ? { phase: "ok", summary: kept } : { phase: "loading" };
}

/** One file's diff, read when the view opens it (again after Try again, `attempt`). */
export function useDiff(chat: string, turn: string, path: string, attempt: number): DiffState {
  const key = `${chat}/${turn}/${path}`;
  const kept = diffs.get(key);
  const [state, setState] = useState<{ key: string; s: DiffState }>({ key, s: kept ? { phase: "ok", diff: kept } : { phase: "loading" } });
  useEffect(() => {
    const had = diffs.get(key);
    if (had) {
      setState({ key, s: { phase: "ok", diff: had } });
      return;
    }
    let live = true;
    setState({ key, s: { phase: "loading" } });
    void read(changeFileApiPath(chat, turn, path)).then((a) => {
      const s = diffState(a, summaries.get(`${chat}/${turn}`) ?? null, path);
      if (s.phase === "ok") keepDiff(key, s.diff);
      if (live) setState({ key, s });
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);
  return state.key === key ? state.s : kept ? { phase: "ok", diff: kept } : { phase: "loading" };
}

/** True once a read has run for SLOW_MS: its line shows then, never for a quick one. */
export function useSlow(loading: boolean): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!loading) return;
    const t = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(t);
  }, [loading]);
  return slow && loading;
}
