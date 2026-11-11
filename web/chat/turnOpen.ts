// U2 (DESIGN-U2 6 and 8): whether a finished turn shows folded or open on this page. View state only: nothing here
// reaches the store, the server or the URL.
// - Drawn folded: every finished turn is folded when the conversation is drawn (a chat opened, a reload, a page that
//   comes later, a reconnect's snapshot).
// - The turn this page watched end stays open: its `turn_end` came live after the conversation was drawn. It folds by
//   itself when a later turn starts, but only while the view follows the end and the focus is not inside its work;
//   until then it waits (Never under the reader). Drawn again, it is folded.
// - So does a turn whose work ran on in the background (drawn open with its Stop and progress) once that work ends on
//   this page: the reader may be reading it, or have the focus in it.
// - The reader's own choice wins: a turn opened or closed on its line keeps that state, kept per chat on this device in
//   session storage (the newest TURN_CHOICES_MAX turns), except that a link to a row inside a turn opens it.
import type { TurnMark } from "../state/types";
import type { Turn } from "./turns";

/** Session storage: `kitespan.turns.<chat id>`, a JSON object of turn id to true (open) or false (closed). */
export const TURN_CHOICES_KEY = "kitespan.turns.";
/** The turns per chat whose choice is kept (a design value). */
export const TURN_CHOICES_MAX = 200;

type Store = Pick<Storage, "getItem" | "setItem">;

/** The session storage, or null where it cannot be used (a locked-down browser). */
export function sessionStore(): Store | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** The reader's choices for a chat's turns on this device, oldest first. */
export function readChoices(store: Store | null, chatId: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  try {
    const raw = store?.getItem(TURN_CHOICES_KEY + chatId);
    const o: unknown = raw ? JSON.parse(raw) : null;
    if (o && typeof o === "object" && !Array.isArray(o)) for (const [id, v] of Object.entries(o)) if (typeof v === "boolean") out.set(id, v);
  } catch {
    // A value that does not read is no choice.
  }
  return out;
}

/** The choices with this one as the newest, at most TURN_CHOICES_MAX of them, written back; the new map. */
export function writeChoice(store: Store | null, chatId: string, id: string, open: boolean): Map<string, boolean> {
  const next = readChoices(store, chatId);
  next.delete(id);
  next.set(id, open);
  for (const old of next.keys()) {
    if (next.size <= TURN_CHOICES_MAX) break;
    next.delete(old);
  }
  try {
    store?.setItem(TURN_CHOICES_KEY + chatId, JSON.stringify(Object.fromEntries(next)));
  } catch {
    // A full or locked storage keeps the choice for this view only.
  }
  return next;
}

/** The timing rule's memory for one drawn conversation. */
export interface Watch {
  /** The end marks the conversation had when it was drawn: their turns show folded. */
  drawn: Set<TurnMark>;
  /** Watched turns that already folded by themselves. */
  folded: Set<string>;
  /** Whether each ended turn's work ran on in the background at the last draw, by its end mark. */
  runsOn: Map<TurnMark, boolean>;
  /** The end marks of turns whose background work ended on this page: they wait as a watched turn does. */
  late: Set<TurnMark>;
}

export function newWatch(marks: readonly TurnMark[] | undefined): Watch {
  return { drawn: new Set(marks ?? []), folded: new Set(), runsOn: new Map(), late: new Set() };
}

/**
 * At each draw: an ended turn whose background work ran at the last draw and has ended now becomes one this page
 * watched end (its end mark joins `late`). A snapshot draws the turn again with a new end mark, which is folded.
 */
export function noteRunsOn(w: Watch, layouts: readonly { turn: Pick<Turn, "id" | "end">; runsOn: boolean }[]): void {
  for (const { turn, runsOn } of layouts) {
    const end = turn.end;
    if (!end) continue;
    if (w.runsOn.get(end) === true && !runsOn && !w.late.has(end)) {
      w.late.add(end);
      w.folded.delete(turn.id);
    }
    w.runsOn.set(end, runsOn);
  }
}

/**
 * The turn's end came live on this page after the conversation was drawn (or its background work ended here since),
 * and it has not folded by itself yet.
 */
export function watchedOpen(w: Watch, turn: Pick<Turn, "id" | "end">): boolean {
  if (!turn.end || w.folded.has(turn.id)) return false;
  return (turn.end.live && !w.drawn.has(turn.end)) || w.late.has(turn.end);
}

/**
 * The watched turns that fold now (they join `w.folded`): a later turn started, the view follows the end, and the
 * focus is not inside the turn's work. While the reader is scrolled up, or the focus is there, they wait.
 */
export function foldNow(w: Watch, turns: readonly Pick<Turn, "id" | "end">[], follows: boolean, focusIn: (id: string) => boolean): string[] {
  if (!follows) return [];
  const out: string[] = [];
  turns.forEach((t, i) => {
    if (i === turns.length - 1 || !watchedOpen(w, t) || focusIn(t.id)) return;
    w.folded.add(t.id);
    out.push(t.id);
  });
  return out;
}

/**
 * A turn's open state, strongest first: the reader's own toggle on this history entry (it beats a link, as a row's
 * does), a link to a row in its work, the reader's choice on this device, then the timing rule.
 */
export function turnOpen(s: { entry?: boolean; forced: boolean; choice?: boolean; watched: boolean }): boolean {
  if (s.entry !== undefined) return s.entry;
  if (s.forced) return true;
  if (s.choice !== undefined) return s.choice;
  return s.watched;
}
