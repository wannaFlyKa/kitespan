// U2 (DESIGN-U2 3 to 7): the turns of a chat, written once, so the turn fold and U3's turn rail read the same turns;
// and how a finished turn folds in a view. Pure: no DOM, no store.
//
// A turn starts at its `turn_start` and ends at its `turn_end` (their marks, Chat.marks, say where they came among
// the rows). Where no mark says (history, which has none today), a turn starts at each input (a message, a `!` or `/`
// command) that a row of Claude's follows, and runs to the next one. The inputs before a turn's first row of work open
// it; an input that Claude read inside a turn (a queued message taken in at a tool boundary, or after Send now moved
// the work to the background, row 111) stays in its place in that turn. Messages that still wait, and rows before the
// first turn, belong to no turn.
//
// What folds: the work (thinking, the tool summaries, the replies before the last one, subagent, workflow and to-do
// rows, records and lines among them). What stays: every input in its place, and the answer: the turn's last reply and
// the rows after it that end the turn (a card's record, an error row, a refusal, a stop line). Work that came after the
// last reply (a to-do update, a launch, the user's Stop hook) folds after it, in a container of its own, so nothing
// moves out of its order and the reply always shows; a row the view leaves out (a hook row outside Verbose) is no
// work. The Interrupted mark is the line's tag. A turn folds only when it ended, no card of it waits, none of its work
// still runs in the background, the view is not Verbose, and folding saves a row: two rows of work or more in this
// view, or one reply, subagent block or workflow block.

import { TURN_CUT, TURN_INTERRUPTED } from "../../shared/protocol";
import type { Item, TurnMark } from "../state/types";
import { INTERRUPTED, cardCallsKey, cardStandsFor, didParts, foldItems, hiddenIn, isToolCall, transcriptRows, type CardCalls, type Entry, type View } from "./fold";

export type TurnState = "running" | "waiting" | "ok" | "interrupted" | "failed" | "cut";

export interface Turn {
  /** The id of its first row (its first opening input, else its first row of work): the same live, in history, after
   * a reload and on every device, because row ids are. A turn with no row yet: `turn@<its place>`. */
  id: string;
  /** Who started it: the user (a message, a `!` or `/` command), or Claude Code itself (a task's notification, a
   * Monitor event, a wake-up). A turn that history alone shows says "user" when an input opens it. */
  by: "user" | "agent";
  state: TurnState;
  /** How long it worked (turn_end's durationMs) when that is known and above 0, else null. */
  durationMs: number | null;
  /** Its rows, in order: the opening inputs first. */
  rows: Item[];
  /** How many of `rows` are its opening inputs. */
  opening: number;
  /** Its end's mark, when the page got one (the timing rule reads whether it came live). */
  end: Extract<TurnMark, { k: "end" }> | null;
}

/** The conversation as turns, in order: a turn, or a row that belongs to none (outside). */
export type Block = { k: "turn"; turn: Turn } | { k: "row"; item: Item };

export interface TurnOpts {
  /** The chat runs a turn now (or kitespan's own Claude Code finishes one, row 80): the last turn runs. */
  running: boolean;
  /** A card waits: the last turn waits for the user. */
  waiting: boolean;
  /** Older history is not loaded (the chat's `more`): rows before the first input are the end of an older turn. */
  partial: boolean;
}

/** A message or `!` command that waits (Queued, Not sent, this page's own not shown yet), or a `!` that never ran. */
export function waitingRow(it: Item): boolean {
  if (it.kind === "user") return !!it.queued || !!it.local || !!it.notSent;
  if (it.kind === "bash") return !!it.queued || !!it.notRun;
  return false;
}

/** An input: a message (a `/` command is one), or a `!` command that runs or ran. */
export function isInput(it: Item): boolean {
  return (it.kind === "user" || it.kind === "bash") && !waitingRow(it);
}

/** The Interrupted mark that a Stop's end adds (reduce.ts). */
export function isInterruptedMark(it: Item): boolean {
  return it.kind === "assistant" && it.markdown === INTERRUPTED && !it.streaming;
}

/** A row's part in a turn (after its opening inputs). */
export type Role = "pinned" | "text" | "end" | "mark" | "work";

/**
 * - pinned: stays in its place and splits the work: an input read inside the turn, a row that waits, a reconnect or
 *   a /clear divider;
 * - text: a reply; mark: the Interrupted mark;
 * - end: a row that can end a turn and say why: a card's record, an error row, a refusal, a line, a local command's
 *   output;
 * - work: the rest (thinking, calls, subagents, workflows, to-do rows, compaction, memory, hooks, plugin rows).
 */
export function roleOf(it: Item): Role {
  if (isInput(it) || waitingRow(it) || it.kind === "reconnect" || it.kind === "reset") return "pinned";
  if (isInterruptedMark(it)) return "mark";
  if (it.kind === "assistant") return "text";
  if (it.kind === "card" || it.kind === "error" || it.kind === "refusal" || it.kind === "info" || it.kind === "slash") return "end";
  return "work";
}

interface Region {
  s: number;
  /** End (exclusive); null while it is open. */
  e: number | null;
  by: "user" | "agent";
  end: Extract<TurnMark, { k: "end" }> | null;
  /** Ended by a later start, with no end of its own. */
  cut?: boolean;
  /** Its start came in a snapshot's tail (TurnMark `loose`). */
  loose?: boolean;
}

/** The start of the last run of inputs in rows[lo, hi), or -1 when there is none. */
function lastInputGroup(rows: readonly Item[], lo: number, hi: number): number {
  let i = hi - 1;
  while (i >= lo && !isInput(rows[i]!)) i--;
  if (i < lo) return -1;
  while (i - 1 >= lo && isInput(rows[i - 1]!)) i--;
  return i;
}

/**
 * The conversation's turns and the rows outside them (DESIGN-U2 3), from the rows the views draw (fold.ts
 * transcriptRows) and the turns' marks.
 */
export function turnsOf(items: readonly Item[], marks: readonly TurnMark[], opts: TurnOpts): Block[] {
  const rows = transcriptRows(items);
  const raw = new Map<string, number>();
  items.forEach((it, i) => raw.set(it.id, i));
  const rawOf = rows.map((it) => raw.get(it.id) ?? -1);
  // The rows that wait at the end (the queue) are no turn's.
  let tail = rows.length;
  while (tail > 0 && waitingRow(rows[tail - 1]!)) tail--;

  /** Where a mark comes: the count of rows up to the row it names (its first one still there); -1 when none is. */
  const place = (at: readonly string[]): number => {
    if (at.length === 0) return 0;
    for (const id of at) {
      const r = raw.get(id);
      if (r === undefined) continue;
      // The rows keep the items' order: the first row after that item, by halves.
      let lo = 0;
      let hi = rows.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (rawOf[mid]! <= r) lo = mid + 1;
        else hi = mid;
      }
      return Math.min(lo, tail);
    }
    return -1;
  };

  // ---- the turns that marks say
  const regions: Region[] = [];
  let open: Region | null = null;
  let lower = 0;
  for (const m of marks) {
    const b = place(m.at);
    if (b < 0) continue;
    if (m.k === "start") {
      // The snapshot's history marks where the turn in flight began (the server's own mark, server/chats/turns.ts), and
      // the tail sends that turn's start again: the same turn, so it starts nothing new.
      if (open && m.loose && !open.loose) continue;
      if (open) {
        open.e = Math.max(open.s, b);
        open.cut = true;
        regions.push(open);
        lower = open.e;
        open = null;
      }
      let s = Math.max(b, lower);
      // A start in a snapshot's tail: the history drawn before it may hold the turn's first rows already, its message
      // too. Unless an input comes right after it, the turn starts at the last input before it (a user's turn only:
      // nothing marks where Claude Code's own turn began).
      if (m.loose && m.by === "user" && !(s < tail && isInput(rows[s]!))) {
        const g = lastInputGroup(rows, lower, s);
        if (g >= 0) s = g;
      }
      open = { s, e: null, by: m.by, end: null, ...(m.loose ? { loose: true } : {}) };
    } else if (open) {
      open.e = Math.max(open.s, b);
      open.end = m;
      regions.push(open);
      lower = open.e;
      open = null;
    } else {
      // An end with no start (history's Interrupted end, or a start that came before the rows were drawn): the turn
      // runs from the last input before it.
      const e = Math.max(b, lower);
      const g = lastInputGroup(rows, lower, e);
      regions.push({ s: g >= 0 ? g : lower, e, by: g >= 0 ? "user" : "agent", end: m });
      lower = e;
    }
  }
  if (open) regions.push(open);

  // ---- the blocks, in order: the gaps between those turns by the inputs, then each turn
  const out: Block[] = [];
  let carry: Item[] = [];
  const turn = (list: Item[], by: Turn["by"], state: TurnState, end: Turn["end"], at: number): Turn => {
    let opening = 0;
    while (opening < list.length && isInput(list[opening]!)) opening++;
    const ms = end && end.durationMs > 0 ? end.durationMs : null;
    return { id: list[0]?.id ?? `turn@${at}`, by, state, durationMs: ms, rows: list, opening, end };
  };
  const ended = (end: Turn["end"]): TurnState => {
    if (!end || end.ok) return "ok";
    if (end.subtype === TURN_INTERRUPTED) return "interrupted";
    if (end.subtype === TURN_CUT) return "cut";
    return "failed";
  };
  const live = (): TurnState => (opts.waiting ? "waiting" : opts.running ? "running" : "ok");

  /** A gap's rows by the inputs. `last`: nothing marked follows it. `next`: the marked turn after it. */
  const gap = (lo: number, hi: number, first: boolean, last: boolean, next: Region | undefined) => {
    let i = lo;
    // Rows before the first input: the end of an older turn when older history is not loaded, else no turn's.
    const firstInput = (() => {
      let j = lo;
      while (j < hi && !isInput(rows[j]!)) j++;
      return j;
    })();
    if (firstInput > lo) {
      const lead = rows.slice(lo, firstInput);
      if (first && opts.partial && lead.some((r) => !waitingRow(r))) out.push({ k: "turn", turn: turn(lead, "user", firstInput === hi && last ? live() : "ok", null, lo) });
      else for (const item of lead) out.push({ k: "row", item });
      i = firstInput;
    }
    while (i < hi) {
      // A run of inputs, then the rows up to the next input.
      let j = i;
      while (j < hi && isInput(rows[j]!)) j++;
      let k = j;
      while (k < hi && !isInput(rows[k]!)) k++;
      const list = rows.slice(i, k);
      // Inputs that end the gap, right before a turn of the user's that a mark started: they open that turn.
      if (k === hi && j === hi && next && next.by === "user") {
        carry = list;
        return;
      }
      out.push({ k: "turn", turn: turn(list, "user", k === hi && last ? live() : "ok", null, i) });
      i = k;
    }
  };

  let at = 0;
  regions.forEach((r, n) => {
    gap(at, r.s, at === 0, false, r);
    const e = r.e ?? tail;
    const list = [...carry, ...rows.slice(r.s, e)];
    carry = [];
    const state = r.e === null ? live() : ended(r.end);
    out.push({ k: "turn", turn: turn(list, r.by, state, r.end, r.s) });
    at = e;
    if (n === regions.length - 1 && r.e === null) at = tail;
  });
  if (at < tail) gap(at, tail, at === 0, true, undefined);
  for (const item of rows.slice(tail)) out.push({ k: "row", item });
  return out;
}

/** The two turns are the same: their fields, their end's mark and each of their rows. */
function sameTurn(a: Turn, b: Turn): boolean {
  if (a.id !== b.id || a.by !== b.by || a.state !== b.state || a.durationMs !== b.durationMs || a.opening !== b.opening || a.end !== b.end || a.rows.length !== b.rows.length) return false;
  for (let i = 0; i < a.rows.length; i++) if (a.rows[i] !== b.rows[i]) return false;
  return true;
}

/**
 * S1: `next` (turnsOf's blocks now), with each turn and row that is the same as one of `prev` kept as `prev`'s own
 * block, so what is worked out and drawn from a finished turn is done once, not again for each piece of a reply.
 */
export function shareBlocks(prev: readonly Block[] | null, next: Block[]): Block[] {
  if (!prev?.length) return next;
  const had = new Map<string, Block>();
  for (const b of prev) had.set(b.k === "turn" ? `t ${b.turn.id}` : `r ${b.item.id}`, b);
  return next.map((b) => {
    const was = had.get(b.k === "turn" ? `t ${b.turn.id}` : `r ${b.item.id}`);
    if (!was) return b;
    if (b.k === "row") return was.k === "row" && was.item === b.item ? was : b;
    return was.k === "turn" && sameTurn(was.turn, b.turn) ? was : b;
  });
}

/** The turns alone (U3's rail reads these). */
export function turnList(blocks: readonly Block[]): Turn[] {
  return blocks.flatMap((b) => (b.k === "turn" ? [b.turn] : []));
}

// ---------------------------------------------------------------------------------------------------------------
// One turn in one view

/** A part of a turn as the view draws it, in order. `work` folds; the rest shows. */
export type Part = { role: "input" | "pinned" | "answer" | "mark"; entries: Entry[] } | { role: "work"; entries: Entry[] };

export interface TurnLayout {
  turn: Turn;
  parts: Part[];
  /** The turn folds in this view: it has a line. */
  folds: boolean;
  /** The line's words ("Worked for 2m 14s, read 3 files, ran 2 commands"). */
  label: string;
  /** The end state's tag after the words: Interrupted, Failed, Stopped (a cut turn); null when it ended well. */
  tag: string | null;
  /** The ids of every top-level row of the turn's work (a route to one opens the turn). */
  workIds: string[];
  /** Some of its work still runs in the background (a subagent, a workflow, a call): it does not fold until that ends. */
  runsOn: boolean;
}

/** The row's work still runs: a call, a subagent or a workflow that went on in the background. */
function stillRuns(it: Item): boolean {
  return (it.kind === "tool" && it.status === "running") || ((it.kind === "agent" || it.kind === "workflow") && it.status === "running");
}

/** "40s", "2m 14s", "2m" (a part that is 0 is left out), "1h 5m": whole seconds, at least 1s. */
export function turnDuration(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

export const TURN_TAG: Partial<Record<TurnState, string>> = { interrupted: "Interrupted", failed: "Failed", cut: "Stopped" };

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/**
 * The line's words: "Worked for <time>" (the CLI's words) when the time is known, then what the work did in the
 * summary rows' words, then the subagents and workflows; one sentence, capitalized. Nothing but replies and thinking,
 * with no time: "Worked" ("Thought" in the Thinking view when there was thinking).
 */
export function turnLabel(turn: Pick<Turn, "durationMs">, work: readonly Item[], view: View): string {
  const parts: string[] = [];
  if (turn.durationMs !== null) parts.push(`worked for ${turnDuration(turn.durationMs)}`);
  parts.push(...didParts(work.filter(isToolCall)));
  const agents = work.filter((it) => it.kind === "agent").length;
  const workflows = work.filter((it) => it.kind === "workflow").length;
  if (agents) parts.push(`ran ${plural(agents, "subagent")}`);
  if (workflows) parts.push(`ran ${plural(workflows, "workflow")}`);
  if (!parts.length) parts.push(view === "thinking" && work.some((it) => it.kind === "thinking") ? "thought" : "worked");
  const text = parts.join(", ");
  return text[0]!.toUpperCase() + text.slice(1);
}

/**
 * Where a turn's answer starts among its rows after the opening inputs: at its last reply, which always shows (work
 * that came after it, a to-do update, a launch, the user's Stop hook, folds after it, in a container of its own); with
 * no reply, after its last row of work that the view draws (`shows`), so only its end rows stay. A row that the view
 * leaves out (a hook row, an info-level line outside Verbose) moves nothing.
 */
function answerStart(body: readonly Item[], shows: (it: Item) => boolean): number {
  let lastText = -1;
  let lastWork = -1;
  body.forEach((it, i) => {
    const r = roleOf(it);
    if (r === "text") lastText = i;
    if (r === "work" && shows(it)) lastWork = i;
  });
  return lastText >= 0 ? lastText : lastWork + 1;
}

/** The turn as the view draws it. `reveal` and `calls` are the view's (fold.ts foldItems). */
export function turnLayout(turn: Turn, view: View, reveal: ReadonlySet<string> | undefined, calls: CardCalls): TurnLayout {
  const inputs = turn.rows.slice(0, turn.opening);
  const body = turn.rows.slice(turn.opening);
  const shows = (it: Item) => !!reveal?.has(it.id) || !(hiddenIn(it, view) || cardStandsFor(it, calls));
  const a = answerStart(body, shows);
  const parts: Part[] = [];
  const fold = (list: readonly Item[]) => foldItems(list, view, reveal, calls);
  if (inputs.length) parts.push({ role: "input", entries: fold(inputs) });
  let run: Item[] = [];
  const work: Item[] = [];
  const flush = () => {
    if (run.length) {
      const entries = fold(run);
      if (entries.length) parts.push({ role: "work", entries });
    }
    run = [];
  };
  body.forEach((it, i) => {
    const r = roleOf(it);
    // Before the answer everything but a pinned row is work; after it, the work rows (and their own containers).
    if ((i < a && r !== "pinned") || (i > a && r === "work")) {
      run.push(it);
      work.push(it);
      return;
    }
    flush();
    const role = r === "pinned" ? "pinned" : r === "mark" ? "mark" : "answer";
    const entries = fold([it]);
    if (entries.length) parts.push({ role, entries });
  });
  flush();
  const shown = parts.flatMap((p) => (p.role === "work" ? p.entries : []));
  const saves = shown.length >= 2 || (shown.length === 1 && shown[0]!.type === "item" && ["assistant", "agent", "workflow"].includes(shown[0]!.item.kind));
  const ended = turn.state !== "running" && turn.state !== "waiting";
  const runsOn = turn.rows.some(stillRuns);
  const folds = ended && view !== "verbose" && saves && !runsOn;
  return { turn, parts, folds, label: turnLabel(turn, work, view), tag: TURN_TAG[turn.state] ?? null, workIds: work.map((it) => it.id), runsOn };
}

/**
 * S1: turnLayout, kept per turn object (shareBlocks keeps a turn's object while it does not change) for one view, its
 * `reveal` and its card calls; another view, reveal or set of calls lays every turn out again.
 */
export function layoutCache(): (turn: Turn, view: View, reveal: ReadonlySet<string> | undefined, calls: CardCalls) => TurnLayout {
  let kept = new WeakMap<Turn, TurnLayout>();
  let key: { view: View; reveal: ReadonlySet<string> | undefined; calls: string } | null = null;
  return (turn, view, reveal, calls) => {
    const c = cardCallsKey(calls);
    if (!key || key.view !== view || key.reveal !== reveal || key.calls !== c) {
      kept = new WeakMap();
      key = { view, reveal, calls: c };
    }
    let l = kept.get(turn);
    if (!l) kept.set(turn, (l = turnLayout(turn, view, reveal, calls)));
    return l;
  };
}

/**
 * The parts drawn. A turn with a line says Interrupted in the line's tag, so its Interrupted mark is not drawn, folded
 * or open (said once); a turn with no line keeps the mark in its place.
 */
export function drawnParts(l: TurnLayout, _open: boolean): Part[] {
  return l.folds ? l.parts.filter((p) => p.role !== "mark") : l.parts;
}
