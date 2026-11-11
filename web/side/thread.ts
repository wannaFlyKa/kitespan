// The side chat's thread on the page (owner rows 124 and 125, DESIGN-R124 sections 7 and 9): the server keeps one side
// thread per chat (side/<chat id>.json), the same on every device and across a restart; the page holds a copy of it,
// read with `get side` when the side chat opens and after each `attached` while it is open, and kept current by the
// ring's events `side`, `side_gone` and `side_clear`, each with the thread's `rev`. An event whose rev is not above
// the copy's changes nothing (a replay, or an event the read already holds). While a read is out, the events that come
// wait, and the ones above the read's rev go on top of it when it lands.
//
// The page's own ask shows at once (`local`): a question this page sent that the server has not stored yet. The
// server's event for the same id takes its place; a refused ask (an ack error before the server stored anything) turns
// it into a failure that only this page shows. The thread's shape is the server's rule: at most 20 answered exchanges
// (the oldest goes when a 21st lands, the CLI's and VS Code's number) and at most one last exchange that is asking or
// failed; a new question replaces a failed one. One side question runs per chat at a time: this page's own ask never
// takes the place of the server's running one (another page's, or this page's from before a reload), and a `busy` ack
// takes the ask out with no failure line, because the box that sent it gets its question back (act.sideAsk).
import { SIDE_LIMITS, sideQuestionText, type ChatEventOf, type ErrorCode, type SideExchange, type SideRead } from "../../shared/protocol";

export type { SideExchange, SideRead };

/** The ring's side events (shared/protocol.ts ChatEvent). */
export type SideEvent = ChatEventOf<"side"> | ChatEventOf<"side_gone"> | ChatEventOf<"side_clear">;

export const SIDE_EVENT_KINDS: ReadonlySet<string> = new Set(["side", "side_gone", "side_clear"]);

export function isSideEvent<E extends { k: string }>(e: E): e is Extract<E, SideEvent> {
  return SIDE_EVENT_KINDS.has(e.k);
}

/** An exchange on the page: the server's, or this page's own ask before the server stored it (`local`). */
export type PageExchange = SideExchange & { local?: true };

export interface SideThread {
  /** The rev of the newest read or event applied; -1 before anything came. */
  rev: number;
  exchanges: readonly PageExchange[];
  /** A `get side` answered at least once. */
  read: boolean;
  /** The events that came while a read is out (null: no read is out). */
  waiting: readonly SideEvent[] | null;
}

export const EMPTY_THREAD: SideThread = Object.freeze({ rev: -1, exchanges: Object.freeze([]) as readonly PageExchange[], read: false, waiting: null });

/** The answered exchanges a thread keeps (DESIGN-R124 section 10; the CLI's and VS Code's 20). */
export const SIDE_KEEP = SIDE_LIMITS.kept;
/** A side question's cap (UTF-16 units after trimming), the composer's text cap (5.1 rule 7). */
export const SIDE_TEXT_MAX = SIDE_LIMITS.question;

/**
 * The thread's shape: the answered exchanges, at most SIDE_KEEP (the oldest go), and after them at most one exchange
 * that is asking or failed, the newest one (a new question replaced an older failed one).
 */
export function shaped(list: readonly PageExchange[]): PageExchange[] {
  const last = list[list.length - 1];
  let open = last && last.state !== "answered" ? last : null;
  // This page's ask or refusal never hides the question that the server runs (one per chat at a time).
  if (open?.local) open = serverAsking(list) ?? open;
  const answered = list.filter((x) => x.state === "answered");
  const kept = answered.slice(Math.max(0, answered.length - SIDE_KEEP));
  return open ? [...kept, open] : kept;
}

/** The newest exchange that the server holds as asking, or null. */
function serverAsking(list: readonly PageExchange[]): PageExchange | null {
  for (let i = list.length - 1; i >= 0; i--) if (!list[i]!.local && list[i]!.state === "asking") return list[i]!;
  return null;
}

/** The exchange with `x`'s id in its place, or `x` at the end. */
function upsert(list: readonly PageExchange[], x: PageExchange): PageExchange[] {
  const at = list.findIndex((y) => y.id === x.id);
  if (at < 0) return shaped([...list, x]);
  const next = [...list];
  next[at] = x;
  // An exchange that asks again (Try again) is the newest: it moves to the end.
  if (x.state !== "answered" && at !== next.length - 1) {
    next.splice(at, 1);
    next.push(x);
  }
  return shaped(next);
}

function applyOne(list: readonly PageExchange[], e: SideEvent): PageExchange[] {
  if (e.k === "side") return upsert(list, { ...e.x });
  if (e.k === "side_gone") return list.filter((x) => x.id !== e.id);
  return list.filter((x) => x.local && x.state === "asking");
}

/** The thread after a ring event. While a read is out, the event waits for it. */
export function applySideEvent(t: SideThread, e: SideEvent): SideThread {
  if (t.waiting) return { ...t, waiting: [...t.waiting, e] };
  if (e.rev <= t.rev) return t;
  return { ...t, rev: e.rev, exchanges: applyOne(t.exchanges, e) };
}

/** A `get side` went out: the events that come meanwhile wait for its answer. */
export function beginRead(t: SideThread): SideThread {
  return t.waiting ? t : { ...t, waiting: [] };
}

/**
 * The read's answer: the server's thread as it was when it answered, then the events that waited whose rev is above
 * it. This page's own asks that the server has not stored yet stay at the end.
 */
export function takeRead(t: SideThread, r: SideRead): SideThread {
  const mine = t.exchanges.filter((x) => x.local && !r.exchanges.some((y) => y.id === x.id));
  let list: PageExchange[] = shaped([...r.exchanges.map((x) => ({ ...x })), ...mine]);
  let rev = r.rev;
  for (const e of t.waiting ?? []) {
    if (e.rev <= rev) continue;
    list = applyOne(list, e);
    rev = e.rev;
  }
  return { rev, exchanges: list, read: true, waiting: null };
}

/** A read that got no answer (the socket closed, a refusal): the events that waited apply as they came. */
export function readFailed(t: SideThread): SideThread {
  let next: SideThread = { ...t, waiting: null };
  for (const e of t.waiting ?? []) next = applySideEvent(next, e);
  return next;
}

/**
 * This page's ask, shown at once until the server's event for its id comes. While another question asks, nothing
 * changes: the server answers that ask `busy` (act.sideAsk sends none then).
 */
export function localAsk(t: SideThread, id: string, question: string, at: string): SideThread {
  const running = askingOf(t);
  if (running && running.id !== id) return t;
  const was = t.exchanges.find((x) => x.id === id);
  const x: PageExchange = { id, question, at: was?.at ?? at, state: "asking", local: true };
  return { ...t, exchanges: upsert(t.exchanges, x) };
}

/** The ask's ack. `answered`: the exchange as the server stored it. `stopped`: it left the thread. `error`: refused. */
export function settleAsk(t: SideThread, id: string, ack: { answered: SideExchange } | { stopped: true } | { error: ErrorCode }): SideThread {
  if ("answered" in ack) {
    const x = t.exchanges.find((y) => y.id === id);
    // The ring's event came first and may be newer (a Try again from another page): only a local copy takes the ack.
    if (x && !x.local && x.state !== "asking") return t;
    return { ...t, exchanges: upsert(t.exchanges, { ...ack.answered }) };
  }
  if ("stopped" in ack) return { ...t, exchanges: t.exchanges.filter((x) => !(x.id === id && (x.local || x.state === "asking"))) };
  const x = t.exchanges.find((y) => y.id === id);
  // A refusal after the server stored the ask arrives as its own `side` event (failed); one before it never does.
  if (!x || !x.local) return t;
  // Another question runs (another page's, whose event may not be here yet): the ask leaves, and its box gets it back.
  if (ack.error === "busy") return { ...t, exchanges: t.exchanges.filter((y) => y !== x) };
  return { ...t, exchanges: upsert(t.exchanges, { ...x, state: "failed", error: ack.error }) };
}

/** The exchange that runs now (one per chat at a time), or null. */
export function askingOf(t: Pick<SideThread, "exchanges">): PageExchange | null {
  const last = t.exchanges[t.exchanges.length - 1];
  return last && last.state === "asking" ? last : null;
}

/**
 * The history a follow-up sends (the server builds it; this is the page's view of the same rule, for tests and for the
 * thread's own order): the answered, non-synthetic exchanges, oldest first, the newest SIDE_KEEP.
 */
export function historyOf(list: readonly SideExchange[]): { question: string; response: string }[] {
  const ok = list.filter((x) => x.state === "answered" && !x.synthetic && typeof x.answer === "string");
  return ok.slice(Math.max(0, ok.length - SIDE_KEEP)).map((x) => ({ question: x.question, response: x.answer! }));
}

/** A terminal's colour and cursor codes (ESC [ ... final byte), which a pasted line may hold. */
const ESCAPES = /\u001b\[[0-?]*[ -\/]*[@-~]/g;
/** The control characters a side question never holds (the server's rule): all but a line feed and a tab. */
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** The box's text with its line ends as line feeds and the control characters (and terminal codes) taken out. */
function cleaned(raw: string): string {
  return raw.replace(/\r\n?/g, "\n").replace(ESCAPES, "").replace(CONTROLS, "");
}

/**
 * The text a side question sends (the server's own rule, shared/protocol.ts sideQuestionText): trimmed, 1 to 5,000
 * units, no control character but a line feed or a tab, which the page takes out first (pasted terminal colours);
 * null when there is nothing it can send.
 */
export function questionText(raw: string): string | null {
  return sideQuestionText(cleaned(raw));
}

/** True for a question that is over its 5,000 units (the message box takes 20,000): nothing asks it. */
export function questionTooLong(raw: string): boolean {
  return cleaned(raw).trim().length > SIDE_TEXT_MAX;
}

