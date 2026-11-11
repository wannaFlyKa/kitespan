// What the registry merges into a chat's history from its own notes (store/types.ts NotesRecord), so a page that
// attaches late, reloads, or comes after a restart draws what a live page drew (DESIGN.md 5.4, 6.3):
// - each closed card of the transcript's turns, as its `card_open` and its `card_close` (with how it closed), right
//   after the card's tool call;
// - each `!` record under the row's own uuid: Claude Code writes the record under an id of its own, so the record is
//   found by its content and given the id that the live row had, and a page that drew the row live draws it once;
// - each `!` row that never ran (Not run), where the transcript ended when it was noted;
// - each message's mention paths (9.3), on its `user` event by the message's uuid: the transcript holds only the text,
//   where nothing marks where a path with white space in it ends, so the page makes tiles of exactly these paths;
// - the calls of the last turn that got no result, as `tool_stopped`, once no turn runs.

import { createHash } from "node:crypto";
import { LIMITS, capText, type Card, type CardAnswer, type ChatEvent, type ChatEventOf } from "../../shared/protocol";
import type { BashNote, NotRunNote, NotesRecord } from "../store/types";
import { eventId } from "./ring";

/** A digest of a `!` record's content, as the transcript holds it (the caps of capEvent applied). */
export function bashDigest(input: string, stdout: string, stderr: string): string {
  const key = JSON.stringify([capText(input, LIMITS.bashInput), capText(stdout, LIMITS.bashOutput), capText(stderr, LIMITS.bashOutput)]);
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

const note = (s: string): { note?: string } => {
  const t = s.trim();
  return t ? { note: capText(t, LIMITS.answerText) } : {};
};

/**
 * The `card_close` of a card, with how it closed (5.4): Allow once or for this session, Deny (with its note), the
 * question's answers (only those of the card's own questions, as the driver passes them on), the plan's mode, or
 * `cancelled` when it closed with no answer.
 */
export function cardClose(card: Card, a: CardAnswer | null, why: "answered" | "cancelled" | "lost"): ChatEventOf<"card_close"> {
  const base: ChatEventOf<"card_close"> = { k: "card_close", id: card.id, why };
  if (!a || why !== "answered") return { ...base, answer: "cancelled" };
  switch (a.kind) {
    case "permission":
      return a.allow ? { ...base, answer: a.scope } : { ...base, answer: "denied", ...note(a.message) };
    case "question": {
      const known = new Set(card.kind === "question" ? card.questions.map((q) => q.question) : []);
      const answers = Object.fromEntries(Object.entries(a.answers).filter(([q]) => known.has(q)));
      return Object.keys(answers).length ? { ...base, answer: "answered", answers } : { ...base, answer: "cancelled" };
    }
    case "plan":
      return a.approve ? { ...base, answer: "answered", mode: a.mode } : { ...base, answer: "denied", ...note(a.feedback) };
    case "elicitation":
      return { ...base, answer: a.action === "accept" ? "answered" : a.action === "decline" ? "denied" : "cancelled" };
    case "dialog":
      return { ...base, answer: a.behavior === "completed" ? "answered" : "cancelled" };
  }
}

/**
 * Give each `!` record of `events` that one of the chat's rows sent the row's own uuid. The records are matched to
 * the rows by content, newest first, each row once and in order: the newest row may still wait for its record, and a
 * record that no row of kitespan's sent (a `!` typed in the terminal) keeps the id it has. A record that is already
 * under a row's uuid is that row's. Each matched record also gets what the transcript does not hold and the row
 * showed live: the exit code, the duration, the timeout and the cap.
 */
function relabelBash(events: ChatEvent[], rows: NotesRecord["bash"]): ChatEvent[] {
  if (rows.length === 0) return events;
  const byUuid = new Map(rows.map((r) => [r.uuid, r]));
  const present = new Set<string>();
  for (const e of events) if (e.k === "bash" && e.state !== "not_run") present.add(e.uuid);
  const left = rows.filter((r) => !present.has(r.uuid));
  const out = events.slice();
  const withNote = (e: ChatEventOf<"bash">, r: BashNote): ChatEvent => ({ ...e, uuid: r.uuid, code: r.code, ms: r.ms, timedOut: r.timedOut || e.timedOut, capped: r.capped || e.capped });
  let at = left.length - 1;
  for (let i = out.length - 1; i >= 0; i--) {
    const e = out[i]!;
    if (e.k !== "bash" || e.state === "not_run") continue;
    const own = byUuid.get(e.uuid);
    if (own) {
      out[i] = withNote(e, own);
      continue;
    }
    if (at < 0) continue;
    const digest = bashDigest(e.input, e.stdout, e.stderr);
    for (let j = at; j >= 0; j--) {
      if (left[j]!.digest !== digest) continue;
      out[i] = withNote(e, left[j]!);
      at = j - 1;
      break;
    }
  }
  return out;
}

/**
 * Where the transcript ends now, for a Not run row noted now (NotRunNote): the id of its last event that has one
 * (eventId), and the count of the events after it.
 */
export function notRunAnchor(events: readonly ChatEvent[]): { after: string | null; skip: number } {
  for (let i = events.length - 1; i >= 0; i--) {
    const id = eventId(events[i]!);
    if (id !== null) return { after: id, skip: events.length - 1 - i };
  }
  return { after: null, skip: events.length };
}

/** A Not run row as history draws it: the `bash` event that the live row ended with. */
function notRunRow(n: NotRunNote): ChatEvent {
  return { k: "bash", uuid: n.uuid, input: n.input, state: "not_run", stdout: "", stderr: "", code: null, ms: null, timedOut: false, capped: false };
}

/**
 * Each noted Not run row, in the transcript's own events (before any other note is merged in, so the places read as
 * they were noted): after its anchor and the events it skips, rows at one place in the order they were noted. A row
 * whose anchor is gone (a rewind took that part of the conversation away) is left out.
 */
function insertNotRun(events: ChatEvent[], rows: NotesRecord["notRun"]): ChatEvent[] {
  if (rows.length === 0) return events;
  const index = new Map<string, number>();
  const have = new Set<string>();
  events.forEach((e, i) => {
    const id = eventId(e);
    if (id !== null) index.set(id, i);
    if (e.k === "bash") have.add(e.uuid);
  });
  const placed: { at: number; e: ChatEvent }[] = [];
  for (const n of rows) {
    if (have.has(n.uuid)) continue;
    const anchor = n.after === null ? -1 : index.get(n.after);
    if (anchor === undefined) continue;
    have.add(n.uuid);
    placed.push({ at: Math.min(events.length, anchor + 1 + n.skip), e: notRunRow(n) });
  }
  if (placed.length === 0) return events;
  placed.sort((a, b) => a.at - b.at);
  const out: ChatEvent[] = [];
  let p = 0;
  for (let i = 0; i <= events.length; i++) {
    while (p < placed.length && placed[p]!.at === i) out.push(placed[p++]!.e);
    if (i < events.length) out.push(events[i]!);
  }
  return out;
}

/** Each noted card's open and close, right after its tool call's first event, in the order the cards closed. */
function insertCards(events: ChatEvent[], cards: NotesRecord["cards"]): ChatEvent[] {
  if (cards.length === 0) return events;
  const have = new Set<string>();
  for (const e of events) if (e.k === "card_open") have.add(e.card.id);
  const after = new Map<string, ChatEvent[]>();
  for (const n of cards) {
    if (n.after === null || have.has(n.card.id)) continue;
    have.add(n.card.id);
    const list = after.get(n.after) ?? [];
    list.push({ k: "card_open", card: n.card }, n.close);
    after.set(n.after, list);
  }
  if (after.size === 0) return events;
  const out: ChatEvent[] = [];
  for (const e of events) {
    out.push(e);
    if (e.k !== "tool_call") continue;
    const list = after.get(e.id);
    if (!list) continue;
    out.push(...list);
    after.delete(e.id);
  }
  return out;
}

/** Each `user` event of a message noted with mention paths, with those paths; every other event as it is. */
function withMentions(events: ChatEvent[], notes: NotesRecord["mentions"]): ChatEvent[] {
  if (!notes?.length) return events;
  const byUuid = new Map(notes.map((n) => [n.uuid, n.paths]));
  return events.map((e) => {
    const paths = e.k === "user" ? byUuid.get(e.uuid) : undefined;
    return paths ? { ...e, mentions: [...paths] } : e;
  });
}

/** The calls after the last turn's boundary that have no result and no stop yet: stopped, at the end. */
function stopTrailing(events: ChatEvent[]): ChatEvent[] {
  const settled = new Set<string>();
  for (const e of events) if (e.k === "tool_result" || e.k === "tool_stopped") settled.add(e.id);
  let open: { id: string; parent: string | null }[] = [];
  for (const e of events) {
    // A `!` record starts a turn; a row that never ran does not.
    if (e.k === "turn_end" || e.k === "user" || (e.k === "bash" && e.state !== "not_run")) open = [];
    else if (e.k === "tool_call" && !settled.has(e.id) && !open.some((c) => c.id === e.id)) open.push({ id: e.id, parent: e.parent });
  }
  return open.length ? [...events, ...open.map((c): ChatEvent => ({ k: "tool_stopped", id: c.id, parent: c.parent }))] : events;
}

/**
 * The whole transcript's events with the chat's notes merged in. `ended`: no turn runs now, so a call of the last
 * turn with no result will get none.
 */
export function decorateHistory(events: ChatEvent[], notes: NotesRecord, opts: { ended: boolean }): ChatEvent[] {
  let out = insertNotRun(events, notes.notRun);
  out = relabelBash(out, notes.bash);
  out = insertCards(out, notes.cards);
  out = withMentions(out, notes.mentions);
  return opts.ended ? stopTrailing(out) : out;
}
