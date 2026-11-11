// U2 (DESIGN 4.4 and 6.3 The turn fold; DESIGN-U2 3 rule 7): the turns that history gives every page, so a reload,
// another device, an archived chat and every page after a restart group the rows into the same turns as the page that
// saw them live, with the same durations and end states (D49).
// - Each turn that ran on this server is in the chat's notes (store/types.ts TurnNote), written at its end: history
//   gives it its `turn_start` before its first row and its `turn_end` after its last row (and the server's own rows
//   that follow it there: a closed card, a stopped call, a stop line), with the end's own subtype, duration and line.
//   Claude Code's own Interrupted end inside it gives way to the noted one, so the end shows once.
// - The turn in flight (the registry's, noted at its end only) gets its start where its first row is, and no end, so a
//   page that attaches while it runs keeps the message read inside it in it, and an agent's own turn apart from the
//   turn before it.
// - A turn that no note knows (one run in the terminal, or before iteration 5) and that Claude Code started by itself
//   (a background task's notification, a wake-up): a reply in a new API message after a finished reply, with no input
//   between, starts it, and the next input, the next start or its own Interrupted end ends it. Every other turn the
//   notes do not know is left to the page's own rule (a turn at each input, chat/turns.ts).
// The transcript holds no durations for an SDK host's turns, and the SDK's history read gives a `system` record's
// message only, so the terminal's own `turn_duration` records cannot be read here: such a turn has no duration.
// U1: a noted turn's changes card (the `changes` event, from the chat's changes store) follows its `turn_end`.

import type { ChatEvent } from "../../shared/protocol";
import { cardKey, noteCardKey, pageRowId } from "../changes/rows";
import type { TurnNote } from "../store/types";
import { eventId } from "./ring";

/** The turn in flight, as the registry tracks it: the history ids of its first rows, and who started it. */
export interface InFlightTurn {
  ids: readonly string[];
  by: "user" | "agent";
}

/** A user's input as history has it: a message (a `/` command is one), or a `!` command that ran. */
function isInput(e: ChatEvent): boolean {
  return e.k === "user" || (e.k === "bash" && e.state !== "not_run");
}

/**
 * An event that starts a row of the conversation: an input, a start, a block or call of the main thread, or a `!` row
 * that never ran (it waited, so it is no turn's).
 */
function startsRow(e: ChatEvent): boolean {
  if (e.k === "user" || e.k === "bash" || e.k === "turn_start") return true;
  return (e.k === "block" || e.k === "block_start" || e.k === "tool_call") && e.parent === null;
}

/**
 * The history id of an event that the registry counts as one of a turn's rows (TurnNote `ids` and `last`): a message
 * that does not wait, a `!` row that ran, and a block, call or result of the main thread. Null for every other event.
 */
export function turnRowId(e: ChatEvent): string | null {
  switch (e.k) {
    case "user":
      return e.queued ? null : e.uuid;
    case "bash":
      return e.state === "done" ? e.uuid : null;
    case "block_start":
    case "block":
    case "tool_call":
    case "tool_result":
      return e.parent === null ? eventId(e) : null;
    default:
      return null;
  }
}

/** The API message of a block's key, `<message id>:<index>` (events.ts historyEvents). */
const messageOf = (key: string): string => key.slice(0, key.lastIndexOf(":"));

interface Start {
  at: number;
  by: "user" | "agent";
  note?: TurnNote;
  /** The turn in flight: no end. */
  open?: boolean;
  /** Claude Code's own turn that no note knows. */
  own?: boolean;
}

/**
 * The decorated history (history.ts decorateHistory, stops.ts insertStops) with each turn's start and end put in.
 * `ended`: no turn runs now, so a turn of Claude Code's own that reaches the transcript's end has ended. `cards` (U1):
 * the chat's changes cards by their turn's first rows (server/changes/rows.ts cardKey); each goes right after its noted
 * turn's end.
 */
export function insertTurns(
  events: readonly ChatEvent[],
  notes: readonly TurnNote[] | undefined,
  inFlight: InFlightTurn | null,
  ended: boolean,
  cards?: ReadonlyMap<string, ChatEvent>,
): ChatEvent[] {
  const index = new Map<string, number>();
  events.forEach((e, i) => {
    const id = eventId(e);
    if (id !== null && !index.has(id)) index.set(id, i);
  });
  const find = (ids: readonly string[]): number => {
    for (const id of ids) {
      const at = index.get(id);
      if (at !== undefined) return at;
    }
    return -1;
  };

  const starts: Start[] = [];
  const taken = new Set<number>();
  for (const note of notes ?? []) {
    const at = find(note.ids);
    if (at < 0 || taken.has(at)) continue;
    taken.add(at);
    starts.push({ at, by: note.by, note });
  }
  if (inFlight) {
    const at = find(inFlight.ids);
    if (at >= 0 && !taken.has(at)) {
      taken.add(at);
      starts.push({ at, by: inFlight.by, open: true });
    }
  }
  // Claude Code's own turns: a reply in a new API message right after a finished reply (or a turn's end), with no input,
  // no result and no compaction between. A call cannot tell (it may be the finished reply's own message's).
  let done = false;
  let lastText: string | null = null;
  events.forEach((e, i) => {
    if (isInput(e) || (e.k === "tool_result" && e.parent === null) || e.k === "compacted") {
      done = false;
      lastText = null;
    } else if (e.k === "turn_end") {
      done = true;
      lastText = null;
    } else if (e.k === "tool_call" && e.parent === null) done = false;
    else if (e.k === "block" && e.parent === null) {
      const msg = messageOf(e.key);
      if (done && msg !== lastText && !taken.has(i)) starts.push({ at: i, by: "agent", own: true });
      done = e.kind === "text";
      lastText = e.kind === "text" ? msg : null;
    }
  });
  starts.sort((a, b) => a.at - b.at);

  // Each noted turn's span, up to the next noted turn or the turn in flight; a start of Claude Code's own inside one (a
  // reply after a Stop hook's feedback, say) or after the turn in flight's start is that turn's, so it goes.
  const fixed = starts.filter((x) => !x.own);
  const span = new Map<Start, number>();
  fixed.forEach((x, n) => {
    if (x.note) span.set(x, endOf(x, fixed[n + 1]?.at ?? events.length));
  });
  const inside = (at: number) => fixed.some((x) => (x.open && at >= x.at) || (x.note && at >= x.at && at < span.get(x)!));
  const kept = starts.filter((x) => !x.own || !inside(x.at));

  const ends = new Map<number, ChatEvent[]>();
  const begins = new Map<number, ChatEvent[]>();
  const dropped = new Set<number>();
  /** U1: the cards that a noted turn's end took. */
  const placed = new Set<string>();
  const plainEnd = (): ChatEvent => ({ k: "turn_end", ok: true, subtype: "success", durationMs: 0, error: null, uuids: [] });
  kept.forEach((x, n) => {
    const next = kept[n + 1]?.at ?? events.length;
    push(begins, x.at, { k: "turn_start", by: x.by });
    if (x.open) return;
    if (x.note) {
      const e = Math.min(span.get(x)!, next);
      // Claude Code's own Interrupted end of this turn gives way to the noted one, so the end shows once.
      for (let i = x.at; i < e; i++) if (events[i]!.k === "turn_end") dropped.add(i);
      push(ends, e, { k: "turn_end", ok: x.note.ok, subtype: x.note.subtype, durationMs: x.note.durationMs, error: x.note.error, uuids: [...x.note.uuids] });
      const key = noteCardKey(x.note.ids);
      const card = cards?.get(key);
      if (card) {
        push(ends, e, card);
        placed.add(key);
      }
      return;
    }
    // Claude Code's own turn: to its own end (an Interrupted line), the next input or start, or the transcript's end.
    for (let i = x.at + 1; i < next; i++) {
      if (events[i]!.k === "turn_end") return;
      if (isInput(events[i]!)) return push(ends, i, plainEnd());
    }
    if (next < events.length || ended) push(ends, next, plainEnd());
  });

  /**
   * A noted turn's end, before `limit` (the next noted turn or the turn in flight): after its last row and what follows
   * that row before the next row starts (its results, a closed card, a stopped call, Claude Code's Interrupted line, a
   * stop line); with no last row in the transcript, at the next input that it did not take in.
   */
  function endOf(x: Start, limit: number): number {
    const note = x.note!;
    const last = find(note.last);
    if (last >= x.at && last < limit) {
      let i = last + 1;
      while (i < limit && !startsRow(events[i]!)) i++;
      return i;
    }
    const took = new Set(note.uuids);
    for (let i = x.at + 1; i < limit; i++) {
      const e = events[i]!;
      if (isInput(e) && !(e.k === "user" && took.has(e.uuid))) return i;
    }
    return limit;
  }

  if (!begins.size && !ends.size) return withCards([...events]);
  const out: ChatEvent[] = [];
  for (let i = 0; i <= events.length; i++) {
    for (const e of ends.get(i) ?? []) out.push(e);
    for (const e of begins.get(i) ?? []) out.push(e);
    if (i < events.length && !dropped.has(i)) out.push(events[i]!);
  }
  return withCards(out);

  /**
   * U1: a card whose turn no note holds (a note that the notes' cap dropped, a seed's turn): after the first turn end
   * that follows the turn's first row on this page, else before the next input, else (no turn runs) at the page's end.
   * A card whose turn's first row is not on this page is left to the page that holds it.
   */
  function withCards(list: ChatEvent[]): ChatEvent[] {
    if (!cards?.size) return list;
    for (const [key, card] of cards) {
      if (placed.has(key) || card.k !== "changes") continue;
      const at = new Set(card.at);
      const first = list.findIndex((e) => {
        const id = eventId(e);
        return id !== null && at.has(pageRowId(id));
      });
      if (first < 0) continue;
      let to = -1;
      for (let i = first + 1; i < list.length && to < 0; i++) {
        if (list[i]!.k === "turn_end") to = i + 1;
        else if (isInput(list[i]!) || list[i]!.k === "turn_start") to = i;
      }
      if (to < 0) {
        if (!ended) continue;
        to = list.length;
      }
      list.splice(to, 0, card);
      placed.add(cardKey(card.at));
    }
    return list;
  }
}

function push(m: Map<number, ChatEvent[]>, at: number, e: ChatEvent): void {
  const list = m.get(at);
  if (list) list.push(e);
  else m.set(at, [e]);
}
