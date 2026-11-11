// Row 79, smooth text: a live text block (a reply, or thinking that shows while it streams) keeps what came and shows
// it over the next frames at an even pace, word by word with a short fade, faster when more is waiting, so it is never
// more than about half a second behind; the rest shows at once at the block's end (or the turn's). What a page loads
// (a reload, a page that comes later, a chat opened, a history read) shows at once, and so does everything under
// Reduce motion. The pacer is pure (a unit test drives it frame by frame); useReveal runs one per live block on the
// shared frame loop (ui/motion.ts) while it has something left to show, and the cut it gives is in the units that the
// renderer counts (Markdown.tsx: the visible characters of the rendered blocks).
import { useEffect, useReducer } from "react";
import { flushSync } from "react-dom";
import { motionNow, onFrames, useReducedMotion } from "../ui/motion";
import { quietNow } from "./arrivals";
import type { RevealCut, WordMemo } from "./Markdown";

export const REVEAL = {
  /** A piece that came shows within this, at an even pace: each arrival's deadline. */
  catchMs: 300,
  /** Never further behind than this: what came this long ago shows, whatever the pace (a tab that slept, a long frame). */
  maxLagMs: 500,
  /** How long a word that came into view keeps its fade-in (chat.css: the fade itself is --t-reveal, 160 ms). */
  fadeMs: 200,
  /** The pace never drops under the stream's own: its rate, in units per millisecond, is followed up to this. */
  maxRate: 4,
};

export interface Pacer {
  /** Units shown (fractional: the pace moves a little each frame). */
  shown: number;
  /** Units that came. */
  target: number;
  /** The stream's rate (units per ms, a moving average of its arrivals). */
  rate: number;
  /** When the last piece came; -1 before the first. */
  lastAt: number;
  /** The last frame's time. */
  at: number;
  /** The pieces not shown in full yet: when each came and the target after it. */
  queue: { at: number; n: number }[];
  /** What showed when, for the fade's edge (the oldest entry is what showed before any of it). */
  trail: { at: number; shown: number }[];
  /** The block's word ends (Markdown.tsx WordMemo): a text that grows keeps them, so what showed stays (Q1 review). */
  words: WordMemo;
}

export function newPacer(shown: number, now: number): Pacer {
  return { shown, target: shown, rate: 0, lastAt: -1, at: now, queue: [], trail: [{ at: -Infinity, shown }], words: new Map() };
}

/** More came: the target is `total` units now. Less (a held table line) keeps what showed for when it comes back. */
export function arrive(p: Pacer, total: number, now: number): void {
  if (total === p.target) return;
  if (total < p.target) {
    p.target = total;
    p.queue = p.queue.filter((q) => q.n <= total);
    return;
  }
  const more = total - p.target;
  // A pacer that waited for more starts its pace now, not at its last frame (no jump on the first frame).
  if (p.shown >= p.target) p.at = Math.max(p.at, now);
  if (p.lastAt >= 0) {
    const gap = Math.min(1000, Math.max(16, now - p.lastAt));
    const inst = Math.min(REVEAL.maxRate, more / gap);
    p.rate = p.rate > 0 ? p.rate * 0.7 + inst * 0.3 : inst;
  }
  p.lastAt = now;
  p.target = total;
  if (p.shown < total) p.queue.push({ at: now, n: total });
}

function mark(p: Pacer, now: number) {
  const last = p.trail[p.trail.length - 1]!;
  if (last.shown !== p.shown) p.trail.push({ at: now, shown: p.shown });
  // Keep the newest entry at or before the fade's edge, and everything after it.
  let keep = 0;
  for (let i = 0; i < p.trail.length; i++) if (p.trail[i]!.at <= now - REVEAL.fadeMs) keep = i;
  if (keep > 0) p.trail = p.trail.slice(keep);
}

/** One frame: move the cut on at the pace that meets every piece's deadline, and never slower than the stream. */
export function advance(p: Pacer, now: number): void {
  const dt = Math.min(100, Math.max(0, now - p.at));
  p.at = now;
  if (p.shown < p.target) {
    let need = 0;
    for (const q of p.queue) if (q.n > p.shown) need = Math.max(need, (q.n - p.shown) / Math.max(16, q.at + REVEAL.catchMs - now));
    p.shown = Math.min(p.target, p.shown + Math.max(p.rate, need) * dt);
    for (const q of p.queue) if (q.at + REVEAL.maxLagMs <= now && q.n > p.shown) p.shown = Math.min(p.target, q.n);
    p.queue = p.queue.filter((q) => q.n > p.shown);
  }
  mark(p, now);
}

/** The block ended (or the turn did): the rest shows at once, and fades in with the words before it. */
export function finish(p: Pacer, total: number, now: number): void {
  p.target = total;
  p.shown = total;
  p.queue = [];
  p.at = now;
  mark(p, now);
}

/** A load: what came shows at once, with no fade. */
export function snap(p: Pacer, total: number, now: number): void {
  p.target = total;
  p.shown = total;
  p.queue = [];
  p.at = now;
  p.trail = [{ at: -Infinity, shown: total }];
}

/** Where words still fade in from: what showed REVEAL.fadeMs ago. */
export function fadeEdge(p: Pacer, now: number): number {
  let edge = p.trail[0]!.shown;
  for (const e of p.trail) if (e.at <= now - REVEAL.fadeMs) edge = e.shown;
  return Math.min(edge, p.shown);
}

/** Nothing left to show or to fade. */
export function settled(p: Pacer, now: number): boolean {
  return p.shown >= p.target && fadeEdge(p, now) >= p.shown;
}

/** The cut a pacer gives now: what shows, the fade's edge, and what showed at each frame since (each frame's words fade in together). */
export function cutNow(p: Pacer, total: number, now: number): RevealCut {
  const marks = p.trail.filter((e) => e.at > now - REVEAL.fadeMs).map((e) => Math.floor(e.shown));
  return { end: Math.floor(Math.min(p.shown, total)), fade: Math.floor(fadeEdge(p, now)), marks, words: p.words };
}

// ---------------------------------------------------------------------------------------------------------------
// One pacer per live block, kept by chat and block, so a row that draws again (a view change, a snapshot that takes
// the in-flight block out and its tail puts it back) goes on where it was.

const pacers = new Map<string, Pacer>();
const MAX_PACERS = 64;

function keep(key: string, p: Pacer) {
  pacers.delete(key);
  pacers.set(key, p);
  while (pacers.size > MAX_PACERS) pacers.delete(pacers.keys().next().value!);
}

/** Tests only: forget every pacer. */
export function resetPacers() {
  pacers.clear();
}

/**
 * The cut of a block's reveal, in its renderer's units, or null to show all of it as it is. `total` is what came
 * (units), `live` that the block still streams. Outside a chat (`chatId` undefined: the session preview) and under
 * Reduce motion nothing reveals. A block seen for the first time shows what it holds at once; so does what comes while
 * the chat loads (arrivals.ts quietNow).
 */
export function useReveal(chatId: string | undefined, id: string, total: number, live: boolean): RevealCut | null {
  const reduce = useReducedMotion();
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const key = `${chatId ?? ""}\n${id}`;
  const now = motionNow();
  let p = pacers.get(key);
  if (reduce || !chatId) {
    if (p) pacers.delete(key);
    p = undefined;
  } else if (!p) {
    if (live) keep(key, (p = newPacer(total, now)));
  } else if (quietNow(chatId, now)) snap(p, total, now);
  else if (live) arrive(p, total, now);
  else if (p.target !== total || p.shown < total) finish(p, total, now);
  const active = !!p && !settled(p, now);
  useEffect(() => {
    if (!active) {
      if (!live) pacers.delete(key);
      return;
    }
    const pacer = pacers.get(key);
    if (!pacer) return;
    let stop: (() => void) | null = onFrames((t) => {
      advance(pacer, t);
      // Drawn in this frame, before its layout: the chat's observer then follows the end in the same frame.
      flushSync(tick);
      if (settled(pacer, t) && stop) {
        stop();
        stop = null;
      }
    });
    return () => stop?.();
  }, [active, key, live]);
  return p && active ? cutNow(p, total, now) : null;
}
