// U1 (FIX-U1, DESIGN-U1 5 to 7 and 11): what the page knows of a turn's changes, as plain functions. The server works
// out each turn's summary from two git marks of the chat's folder (or, outside a repository, from Claude's own edits)
// and sends its card at the turn's end, the `changes` event (shared/changes.ts ChangesCard): its id, the turn's first
// rows (`at`), how it was made, the counts and at most 5 files, never a line of a diff. The turn's whole list and one
// file's diff are reads of their own, only when the side panel opens them (api.ts). Here: the notes the store keeps,
// which turn a note belongs to, the card's rows and words, reading the two answers defensively, and the diff's rows
// with both line numbers. No DOM, no store.
import { CHANGES_LIMITS, CHANGES_WHY, CHANGES_WHY_LINES, CHANGE_STATUSES, changedFileOf, changesCardOf, type ChangeStatus, type ChangedFile, type ChangesCard, type ChangesSummary, type ChangesWhy, type DiffHunk, type FileDiff } from "../../shared/changes";
import { isChangesId } from "../../shared/ids";
import { isSafeRelativePath } from "../../shared/route";
import type { Turn } from "../chat/turns";

export type { ChangeStatus, ChangedFile, ChangesSummary, ChangesWhy, DiffHunk, FileDiff };

/** A card as the store keeps it: the event's card, and (page side) where the event came among the rows. */
export interface ChangesNote extends ChangesCard {
  /** reduce.ts markAt when the event came: the rows it came after, for a turn whose first rows are not drawn. */
  near?: string[];
}

/** The changes view's two routes: a turn's list and one file's diff (shared/route.ts). */
export const CHANGES_ROUTES: ReadonlySet<string> = new Set(["changesTurn", "changesFile"]);

/** A note keeps at most this many files (the event's cap); the card shows at most five rows. */
export const CHANGES_EVENT_FILES = CHANGES_LIMITS.eventFiles;

// ---------------------------------------------------------------------------------------------------------------
// The words (DESIGN-U1 11)

export const CHANGES_WORDS = {
  /** The view's title: Desktop's name for its diff view and card. */
  title: "Changes",
  close: "Close changes",
  back: "Back to Changes",
  binary: "Binary",
  large: "Too large",
  added: "New",
  deleted: "Deleted",
  renamed: "Renamed",
  newFile: "New file",
  binaryLine: "A binary file: it has no lines to show.",
  gone: "This diff is no longer available.",
  failed: "This diff could not be read.",
  listFailed: "These changes could not be read.",
  tryAgain: "Try again",
  reading: "Reading the diff…",
  notInTurn: "That file is not in this turn's changes.",
  notKept: "These changes are no longer kept.",
  notebook: "This notebook's diff is not shown.",
  edits: "Claude's own edits only.",
  /** A file with no lines to show: a pure rename, an empty file. */
  sameContent: "The content did not change.",
  emptyFile: "An empty file.",
} as const;

const n = (x: number) => x.toLocaleString("en-US");
const plural = (k: number, one: string, many = `${one}s`) => `${n(k)} ${k === 1 ? one : many}`;

/** The fallback's one line: which edits the summary holds, and why (the server's own reasons, shared/changes.ts). */
export function fallbackLine(why: ChangesWhy | undefined): string {
  return why ? `${CHANGES_WORDS.edits} ${CHANGES_WHY_LINES[why]}` : CHANGES_WORDS.edits;
}

/**
 * A size as the page says sizes (ui/files.tsx formatSize: 1 MB is 1,000,000 bytes, as Finder counts), kept here so the
 * store's reducer, which reads this file, imports no screen code.
 */
function sizeText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1000) return bytes === 1 ? "1 byte" : `${Math.round(bytes)} bytes`;
  const kb = Math.round(bytes / 1e3);
  if (kb < 1000) return `${kb} KB`;
  const one = (x: number) => String(Math.round(x * 10) / 10);
  return Math.round(bytes / 1e5) < 10_000 ? `${one(bytes / 1e6)} MB` : `${one(bytes / 1e9)} GB`;
}

/** "This file is too large to compare here (4.2 MB)." */
export function tooLarge(bytes: number): string {
  const size = sizeText(bytes);
  return size ? `This file is too large to compare here (${size}).` : "This file is too large to compare here.";
}

/** "1,412 more lines", the Edit row's form. */
export function moreLines(k: number): string {
  return plural(k, "more line", "more lines");
}

/** "3 more files": the card's fifth row, and the list's foot past the summary's 1,000. */
export function moreFiles(k: number): string {
  return plural(k, "more file", "more files");
}

/** The list's foot: the changes that 4.2 left out of the turn's. */
export function listFoot(others: number): string | null {
  if (!(others > 0)) return null;
  return `${plural(others, "other file")} changed while Claude was not running a tool.`;
}

/** The list's other foot (review): the changes another chat made in the same folder while the turn ran. */
export function elsewhereFoot(k: number | undefined): string | null {
  if (!k || !(k > 0)) return null;
  return k === 1 ? "1 other file changed by another chat in this folder." : `${n(k)} other files changed by other chats in this folder.`;
}

/** What a file with no lines to show says in its view (none for one that has lines, or its own line). */
export function noLines(f: Pick<FileDiff, "status" | "binary" | "large" | "notebook" | "hunks">): string | null {
  if (f.binary || f.large || f.notebook || f.hunks.length) return null;
  if (f.status === "R") return CHANGES_WORDS.sameContent;
  if (f.status === "A" || f.status === "D") return CHANGES_WORDS.emptyFile;
  return null;
}

/** A file's one line under its name: New file, Deleted, or "Renamed from <old path>"; none for an edit. */
export function fileNote(f: Pick<ChangedFile, "status" | "from">): string | null {
  if (f.status === "A") return CHANGES_WORDS.newFile;
  if (f.status === "D") return CHANGES_WORDS.deleted;
  if (f.status === "R") return f.from ? `Renamed from ${f.from}` : CHANGES_WORDS.renamed;
  return null;
}

/** A row's quiet word in the list: New, Deleted or Renamed; none for an edit. */
export function statusWord(status: ChangeStatus): string | null {
  return status === "A" ? CHANGES_WORDS.added : status === "D" ? CHANGES_WORDS.deleted : status === "R" ? CHANGES_WORDS.renamed : null;
}

/** The counts' two slots: "+12" and "-3", a part that is 0 left blank (its slot stays, so the columns line up). */
export function countParts(added: number, removed: number): { add: string; del: string } {
  return { add: added > 0 ? `+${n(added)}` : "", del: removed > 0 ? `-${n(removed)}` : "" };
}

/** What a screen reader hears for the counts: "12 added, 3 removed"; a part that is 0 is left out. */
function countWords(added: number, removed: number, lines: boolean): string {
  const parts: string[] = [];
  if (added > 0) parts.push(lines ? `${plural(added, "line")} added` : `${n(added)} added`);
  if (removed > 0) parts.push(`${n(removed)} removed`);
  return parts.join(", ");
}

/**
 * The word in a row's counts' place: Binary or Too large; and (`status`, the card, whose rows have no status column)
 * Renamed, New or Deleted for a file with no lines added or removed (a pure rename, an empty file). None for a row
 * with counts.
 */
export function countWord(f: Pick<ChangedFile, "binary" | "large" | "notebook" | "status" | "added" | "removed">, status = false): string | null {
  if (f.binary) return CHANGES_WORDS.binary;
  if (f.large) return CHANGES_WORDS.large;
  if (status && !f.notebook && f.added === 0 && f.removed === 0) return statusWord(f.status);
  return null;
}

/**
 * A row's name: "test/unit/upload.test.ts, 12 added, 3 removed" (Binary or Too large in the counts' place). `word`: the
 * list's status word; with none, a file with no counts says its status (the card's form).
 */
export function rowLabel(f: ChangedFile, word: string | null = null): string {
  const end = countWord(f, word === null) ?? countWords(f.added, f.removed, false);
  return [f.path, word, end].filter(Boolean).join(", ");
}

// ---------------------------------------------------------------------------------------------------------------
// The card (DESIGN-U1 6)

export interface CardModel {
  /** The head row, or null for a one-file card (its one row carries the counts). */
  head: { words: string; added: number; removed: number; label: string } | null;
  /** The head's words alone ("3 files changed"): the phone's line. */
  line: string;
  /** The card's name for a screen reader: "3 files changed, 42 lines added, 18 removed". */
  label: string;
  /** At most five rows: four and "N more files" when the turn changed more than five. */
  rows: ChangedFile[];
  more: number;
  moreWords: string;
}

/**
 * The card for a note: git's own phrase ("3 files changed"), also for Claude's own edits (review, 6.12: the turn line
 * above the card says "edited 1 file, wrote 1 file", so a head "2 files edited" read as a second count of the same
 * verb; the panel's line says the summary is Claude's own edits only).
 */
export function cardModel(note: Pick<ChangesCard, "how" | "total" | "added" | "removed" | "files">): CardModel {
  const line = `${plural(note.total, "file")} changed`;
  const counts = countWords(note.added, note.removed, true);
  const label = counts ? `${line}, ${counts}` : line;
  const over = note.total > CHANGES_EVENT_FILES;
  const rows = note.files.slice(0, over ? CHANGES_EVENT_FILES - 1 : CHANGES_EVENT_FILES);
  const more = over ? note.total - rows.length : 0;
  return {
    head: note.total > 1 ? { words: line, added: note.added, removed: note.removed, label } : null,
    line,
    label,
    rows,
    more,
    moreWords: more ? moreFiles(more) : "",
  };
}

/** The card's own row id (data-item-id): a phone's changes route lands on it, scrolled to the middle and marked. */
export const cardItemId = (summary: string) => `changes-${summary}`;

/**
 * Which turn each note's card goes under: the turn that holds the note's first rows (`at`, the server's TurnNote ids);
 * else, for a turn whose first rows are on an older page, the turn that holds the rows the event came after (`near`).
 * One card a turn: a later note for the same turn takes the earlier one's place.
 */
export function changesByTurn(turns: readonly Turn[], notes: readonly ChangesNote[] | undefined): Map<string, ChangesNote> {
  const out = new Map<string, ChangesNote>();
  if (!notes?.length || !turns.length) return out;
  const turnOf = new Map<string, string>();
  for (const t of turns) for (const r of t.rows) turnOf.set(r.id, t.id);
  const find = (ids: readonly string[] | undefined) => (ids ?? []).map((a) => turnOf.get(a)).find((x) => x !== undefined);
  for (const note of notes) {
    const id = find(note.at) ?? find(note.near);
    if (id !== undefined) out.set(id, note);
  }
  return out;
}

/** An older page's notes before the chat's own; a note that both hold is kept once, the chat's (the newer). */
export function mergeChanges(older: readonly ChangesNote[] | undefined, mine: readonly ChangesNote[] | undefined): ChangesNote[] {
  const have = new Set((mine ?? []).map((x) => x.id));
  return [...(older ?? []).filter((x) => !have.has(x.id)), ...(mine ?? [])];
}

/** The chat's notes with `note` in: in place of the one with its id, else at the end. */
export function withChanges(list: readonly ChangesNote[] | undefined, note: ChangesNote): ChangesNote[] {
  const all = list ?? [];
  const i = all.findIndex((x) => x.id === note.id);
  if (i < 0) return [...all, note];
  const out = all.slice();
  out[i] = note;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Reading the answers, defensively: the event (the protocol's own check), the summary and a file's diff

/** The `changes` event's card, or null when it does not read (shared/changes.ts changesCardOf: one rule). */
export function readChangesEvent(v: unknown): ChangesCard | null {
  return changesCardOf(v);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
const ROW_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The summary the side panel reads, or null when it does not read; a file that does not read is left out. */
export function readSummary(v: unknown): ChangesSummary | null {
  if (!isObj(v)) return null;
  const { id, at, how, why, total, added, removed, files, others, elsewhere } = v;
  if (!isChangesId(id) || (how !== "git" && how !== "edits")) return null;
  if (!count(total) || !count(added) || !count(removed) || !Array.isArray(files)) return null;
  const rows = files.slice(0, CHANGES_LIMITS.files).map(changedFileOf).filter((f): f is ChangedFile => f !== null);
  const s: ChangesSummary = { id, at: Array.isArray(at) ? (at.filter((a) => typeof a === "string" && ROW_ID.test(a)) as string[]).slice(0, 2) : [], how, total, added, removed, files: rows, others: count(others) ? others : 0 };
  if (how === "edits" && typeof why === "string" && (CHANGES_WHY as readonly string[]).includes(why)) s.why = why as ChangesWhy;
  if (count(elsewhere) && elsewhere > 0) s.elsewhere = elsewhere;
  return s;
}

function readHunk(v: unknown): DiffHunk | null {
  if (!isObj(v)) return null;
  const { oldStart, oldLines, newStart, newLines, context, lines } = v;
  if (!count(oldStart) || !count(oldLines) || !count(newStart) || !count(newLines) || !Array.isArray(lines) || !lines.every((l) => typeof l === "string")) return null;
  return { oldStart, oldLines, newStart, newLines, context: typeof context === "string" ? context : "", lines: lines as string[] };
}

/** One file's diff, or null when it does not read. A hunk that does not read is left out. */
export function readDiff(v: unknown): FileDiff | null {
  if (!isObj(v)) return null;
  const { path, status, from, hunks, cut, large, added, removed } = v;
  if (typeof path !== "string" || !isSafeRelativePath(path) || typeof status !== "string" || !(CHANGE_STATUSES as readonly string[]).includes(status)) return null;
  const d: FileDiff = { path, status: status as ChangeStatus, added: count(added) ? added : 0, removed: count(removed) ? removed : 0, hunks: Array.isArray(hunks) ? hunks.map(readHunk).filter((h): h is DiffHunk => h !== null) : [] };
  if (typeof from === "string" && isSafeRelativePath(from)) d.from = from;
  if (v.binary === true) d.binary = true;
  if (v.notebook === true) d.notebook = true;
  if (isObj(large) && count(large.bytes)) d.large = { bytes: large.bytes };
  if (isObj(cut) && count(cut.shown) && count(cut.more) && cut.more > 0) d.cut = { shown: cut.shown, more: cut.more };
  if (v.edits === true) d.edits = true;
  return d;
}

// ---------------------------------------------------------------------------------------------------------------
// The diff's rows (DESIGN-U1 7.3)

export type DiffRow =
  /** A hunk's start: git's context line; `seam` between two hunks (the dashed hairline). */
  | { k: "hunk"; context: string; seam: boolean }
  /** A line of the file: its sign, its old and new numbers (null where the side has none), its text. */
  | { k: "line"; sign: " " | "+" | "-"; old: number | null; new: number | null; text: string }
  /** git's own note between lines ("No newline at end of file"): no number, no sign. */
  | { k: "note"; text: string };

/** The rows of a file's hunks, numbered as git counts them. */
export function diffRows(hunks: readonly DiffHunk[]): DiffRow[] {
  const out: DiffRow[] = [];
  hunks.forEach((h, i) => {
    if (i > 0 || h.context) out.push({ k: "hunk", context: h.context, seam: i > 0 });
    let o = h.oldStart;
    let w = h.newStart;
    for (const line of h.lines) {
      const sign = line[0];
      if (sign === "+") out.push({ k: "line", sign: "+", old: null, new: w++, text: line.slice(1) });
      else if (sign === "-") out.push({ k: "line", sign: "-", old: o++, new: null, text: line.slice(1) });
      else if (sign === "\\") out.push({ k: "note", text: line.slice(1).trim() });
      else out.push({ k: "line", sign: " ", old: o++, new: w++, text: sign === " " ? line.slice(1) : line });
    }
  });
  return out;
}

/** The number columns' width in characters: the file's widest number, at least 1. */
export function numberWidth(hunks: readonly DiffHunk[]): number {
  let max = 0;
  for (const h of hunks) max = Math.max(max, h.oldStart + h.oldLines, h.newStart + h.newLines);
  return Math.max(1, String(Math.max(0, max - 1)).length);
}
