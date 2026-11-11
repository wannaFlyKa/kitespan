// U3 (DESIGN-U3 3 to 10): the turn rail's model, read from U2's turns (turns.ts turnList and turnLayout), with no
// grouping of its own. One mark per turn, in the turns' order: the row its jump names (`target`, a /m/ route's row),
// the element that the jump lands at the top (`top`), its state and its accessible name. A mark's target is the first
// row the turn shows while it is folded: its first opening input; for a turn with no input, the first row of its
// answer when it folds (its line lands at the top), else its first row that is drawn. So no turn opens: a turn with no
// input whose every drawn row folds names its first row, which is work, and that jump opens nothing (turnsOpenedBy;
// review U3). The current turn: the last one while the view follows the end, else the last whose top is at or above a
// reading line a fifth of the way down (at most 96 px), found by halves. The rail shows on a laptop (no touch) for 5
// loaded turns or more, where 32 px are free between the text's right edge and the scroller's. The preview card's
// words are worked out only when it opens, each block of the reply a sentence (markdownText). The CLI's `{` and `}` go
// to the turn before or after. Pure: no DOM.
import { Lexer, type Token, type Tokens } from "marked";
import { AGENT_REF } from "../../shared/ids";
import { refsIn } from "../../shared/protocol";
import type { Item } from "../state/types";
import type { AnchorRow } from "./anchor";
import type { Entry } from "./fold";
import { decodeEntities } from "./Markdown";
import { TURN_TAG, isInterruptedMark, type Turn, type TurnLayout, type TurnState } from "./turns";

/** The rail shows from this many loaded turns: five turns are two screens at least (DESIGN-U3 3). */
export const RAIL_MIN_TURNS = 5;
/** px: the rail needs this much between the text's right edge and the scroller's client edge (12 + 20). */
export const RAIL_STRIP = 32;
/** px: the rail's left edge is this far right of the text's right edge. */
export const RAIL_GAP = 12;
/** px: a jump (and `{` and `}`) lands its turn's top this far below the scroller's top: the column's own top padding. */
export const LAND_TOP = 24;
/** px: `{` goes to the top of the turn the reader is inside when its top is more than this above the landing line. */
export const INSIDE = 4;
/** Characters of a mark's name taken from its input (or its answer). */
export const NAME_MAX = 80;
/** Characters of the turn's last reply that the card takes (it shows three lines of them at most). */
export const ANSWER_MAX = 200;

/** The element that stands for a turn's top on the page: a row by its id, a folded turn's line, a summary row. */
export interface RailTop {
  attr: "data-item-id" | "data-turn-id" | "data-testid";
  id: string;
}

/** A turn, as the rail reads it: its layout in this view, its target row and its top. */
export interface RailSpot {
  turn: Turn;
  layout: TurnLayout;
  target: string;
  top: RailTop;
}

export interface RailMark {
  /** The turn's id (Turn.id). */
  turn: string;
  /** The row a jump names: /c/<chat>/m/<target>. */
  target: string;
  /** What the jump puts at LAND_TOP. */
  top: RailTop;
  state: TurnState;
  /** The accessible name: the input, else the answer's first words; then the state's word. */
  name: string;
}

/** A turn's state in words, after a mark's name: U2's tags, then the chat states' words (DESIGN 6.12). */
export const STATE_WORD: Partial<Record<TurnState, string>> = { ...TURN_TAG, running: "Working", waiting: "Needs input" };

const itemOf = (e: Entry | undefined): Item | null => (e && e.type === "item" ? e.item : null);
const topOfEntry = (e: Entry): RailTop => (e.type === "item" ? { attr: "data-item-id", id: e.item.id } : { attr: "data-testid", id: `summary-${e.items[0]?.id ?? e.id}` });

/** The target and the top of a turn as the view draws it; null when the view draws none of it. */
function spotOf(turn: Turn, l: TurnLayout): { target: string; top: RailTop } | null {
  const drawn = l.parts.filter((p) => p.entries.length && !(l.folds && p.role === "mark"));
  if (!drawn.length) return null;
  const firstEntry = drawn[0]!.entries[0]!;
  if (drawn[0]!.role === "input") {
    const it = itemOf(firstEntry);
    if (it) return { target: it.id, top: { attr: "data-item-id", id: it.id } };
  }
  if (l.folds) {
    // The line stands at the turn's top; the target is the first row that shows under it.
    for (const p of drawn) {
      if (p.role === "work") continue;
      const it = itemOf(p.entries[0]);
      if (it) return { target: it.id, top: { attr: "data-turn-id", id: turn.id } };
    }
    const it = itemOf(drawn[0]!.entries.find((e) => e.type === "item")) ?? turn.rows[0] ?? null;
    return it ? { target: it.id, top: { attr: "data-turn-id", id: turn.id } } : null;
  }
  // Unfolded: the first row drawn is the top; the target is the first that is no summary of calls.
  for (const p of drawn)
    for (const e of p.entries) {
      const it = itemOf(e);
      if (it) return { target: it.id, top: topOfEntry(firstEntry) };
    }
  const first = firstEntry.type === "summary" ? firstEntry.items[0] : null;
  return first ? { target: first.id, top: topOfEntry(firstEntry) } : null;
}

/** The turns the rail marks, in order: each with its layout, target and top. A turn the view draws nothing of has none. */
export function railSpots(turns: readonly Turn[], layoutOf: (t: Turn) => TurnLayout | undefined): RailSpot[] {
  const out: RailSpot[] = [];
  for (const turn of turns) {
    const layout = layoutOf(turn);
    const s = layout ? spotOf(turn, layout) : null;
    if (layout && s && AGENT_REF.test(s.target)) out.push({ turn, layout, ...s });
  }
  return out;
}

/** The mark whose jump a /m/ route to `row` is, if any. */
export function railJump(spots: readonly RailSpot[], row: string, onMessage: boolean): RailSpot | undefined {
  return onMessage ? spots.find((s) => s.target === row) : undefined;
}

/**
 * The folded turns a route to a row opens (`top`: the row, or its outermost subagent block): the one whose work holds
 * it, as a link into folded work opens its turn (DESIGN-U2 9). Not for a mark's jump that lands on its turn's line
 * (FIX-U3 1: the jump lands on the line and does not open the turn): a turn with no input whose every drawn row folds
 * (one that Claude Code started and that only ran tools or a subagent, also when it was interrupted, since a folded
 * turn draws no Interrupted mark) names its first row, which is work (spotOf).
 */
export function turnsOpenedBy(layouts: Iterable<TurnLayout>, top: string, jump: RailSpot | undefined): string[] {
  if (jump && jump.top.attr === "data-turn-id") return [];
  const out: string[] = [];
  for (const l of layouts) if (l.folds && l.workIds.includes(top)) out.push(l.turn.id);
  return out;
}

/** What the rail draws depends on: the marks' turns, states, targets and tops, and whether older turns are not loaded. */
export function railKey(spots: readonly RailSpot[], partial: boolean): string {
  let k = partial ? "p" : "a";
  for (const s of spots) k += `|${s.turn.id} ${s.turn.state} ${s.target} ${s.top.attr === "data-turn-id" ? "l" : s.top.id}`;
  return k;
}

/** The marks, with their names (worked out when the key changes). */
export function railMarks(spots: readonly RailSpot[]): RailMark[] {
  return spots.map((s) => ({ turn: s.turn.id, target: s.target, top: s.top, state: s.turn.state, name: markName(s) }));
}

const ended = (state: TurnState) => state !== "running" && state !== "waiting";

/** A text cut to `max` characters at a word's end where it can, with an ellipsis when it was cut. */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max - 30 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * An input's first line as typed: a message's first line that has text, without the file references at its end
 * (the server adds them after the text); a message of files only, the files' names joined by ", "; a `!` command as
 * `!` and its first line. Null for a row that is no input.
 */
export function inputLine(it: Item): string | null {
  if (it.kind === "bash") return `!${firstLine(it.command)}`;
  if (it.kind !== "user") return null;
  let text = it.text;
  const names: string[] = [];
  const refs = refsIn(text);
  for (let i = refs.length - 1; i >= 0; i--) {
    const r = refs[i]!;
    if (text.slice(r.end).trim() !== "") break;
    names.unshift(baseName(r.path));
    text = text.slice(0, r.at);
  }
  const line = firstLine(text);
  return line || names.join(", ");
}

/** The last part of a path (Files.tsx baseName's rule). */
const baseName = (path: string): string => path.replace(/\/+$/, "").split("/").pop() || path;

const firstLine = (s: string): string => (s.split("\n").find((l) => l.trim() !== "") ?? "").replace(/\s+/g, " ").trim();

/** Characters of a reply that markdownText reads: the card shows about ANSWER_MAX of them, from its start. */
const READ_MAX = 8000;
/** A sentence's closing punctuation, with any closing quote or bracket after it. */
const CLOSED = /[.!?:;…。！？][)\]"'”’»]*$/u;

/** A run of inline tokens as plain words (Markdown.tsx's inline walk, with no element): the text, never markup. */
function inlineWords(tokens: readonly Token[] | undefined): string {
  let s = "";
  for (const t of tokens ?? [])
    switch (t.type) {
      case "text": {
        const tt = t as Tokens.Text;
        s += tt.tokens ? inlineWords(tt.tokens) : decodeEntities(tt.text);
        break;
      }
      case "escape":
      case "codespan":
      case "html":
        s += (t as Tokens.Escape | Tokens.Codespan | Tokens.HTML).text;
        break;
      case "strong":
      case "em":
      case "del":
      case "link":
        s += inlineWords((t as Tokens.Strong).tokens);
        break;
      case "image":
        s += decodeEntities((t as Tokens.Image).text ?? "");
        break;
      case "br":
        s += " ";
        break;
      case "checkbox":
        break;
      default:
        s += t.raw;
    }
  return s;
}

/** The blocks' words, one sentence per paragraph and list item, into `out`; headings, code, tables and rules have none. */
function blockWords(tokens: readonly Token[], out: string[]) {
  for (const t of tokens)
    switch (t.type) {
      case "paragraph":
      case "text":
        out.push(inlineWords((t as Tokens.Paragraph).tokens ?? [t]));
        break;
      case "blockquote":
        blockWords((t as Tokens.Blockquote).tokens, out);
        break;
      case "list":
        for (const item of (t as Tokens.List).items) blockWords(item.tokens, out);
        break;
      default:
      // heading, code, table, hr, html, space, def: no words of their own
    }
}

/**
 * Markdown as plain words for the card (review U3): each paragraph and list item is a sentence (a period added where
 * it has no closing punctuation), so the blocks do not run together; headings, code fences, tables and rules are
 * dropped, and inline marks (emphasis, code, links) keep their words. White space collapsed. Only the first
 * READ_MAX characters are read.
 */
export function markdownText(md: string): string {
  const src = md.length > READ_MAX ? md.slice(0, md.lastIndexOf("\n", READ_MAX) > 0 ? md.lastIndexOf("\n", READ_MAX) : READ_MAX) : md;
  let tokens: Token[];
  try {
    tokens = Lexer.lex(src, { gfm: true });
  } catch {
    return src.replace(/\s+/g, " ").trim();
  }
  const out: string[] = [];
  blockWords(tokens, out);
  return out
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((s) => (CLOSED.test(s) ? s : `${s}.`))
    .join(" ");
}

/** The turn's last reply as plain words, about ANSWER_MAX characters of it; null when it has none (the Interrupted mark is none). */
export function answerText(rows: readonly Item[]): string | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const it = rows[i]!;
    if (it.kind !== "assistant" || isInterruptedMark(it)) continue;
    const words = markdownText(it.markdown);
    if (words) return clip(words, ANSWER_MAX);
  }
  return null;
}

function markName(s: RailSpot): string {
  const { turn } = s;
  const input = turn.opening > 0 ? inputLine(turn.rows[0]!) : null;
  const word = STATE_WORD[turn.state] ?? null;
  const base = input ? input : ended(turn.state) ? (answerText(turn.rows) ?? s.layout.label) : null;
  const named = base ? clip(base, NAME_MAX) : null;
  return named ? (word ? `${named}, ${word}` : named) : (word ?? s.layout.label);
}

/** The preview card's words (DESIGN-U3 5): the prompt line and its tag, then the answer lines (`first`: no prompt above them). */
export interface RailCard {
  prompt: string | null;
  tag: string | null;
  answer: string;
  first: boolean;
}

export function railCard(s: RailSpot): RailCard {
  const { turn } = s;
  const prompt = turn.opening > 0 ? inputLine(turn.rows[0]!) || null : null;
  const answer = turn.state === "running" ? "Working" : turn.state === "waiting" ? "Needs input" : (answerText(turn.rows) ?? s.layout.label);
  return { prompt, tag: TURN_TAG[turn.state] ?? null, answer, first: prompt === null };
}

// ---------------------------------------------------------------------------------------------------------------
// Where the rail shows, and the current turn

/** The rail shows: no touch surface, enough loaded turns, and room beside the text. */
export function railShows(turns: number, room: boolean, touch: boolean): boolean {
  return !touch && room && turns >= RAIL_MIN_TURNS;
}

/**
 * The strip beside the text and the rail's place, from the scroller's box (its left and offset width, its client width
 * and whether its scrollbar gutter is on both sides), the column's right edge and right padding, and the wrap's left
 * (the rail is placed in the wrap). `x` is the rail's left inside the wrap.
 */
export function railFit(m: { scrollerLeft: number; scrollerWidth: number; clientWidth: number; bothGutters: boolean; colRight: number; padRight: number; wrapLeft: number }): { strip: number; x: number; room: boolean } {
  const bars = Math.max(0, m.scrollerWidth - m.clientWidth);
  const clientRight = m.scrollerLeft + m.scrollerWidth - (m.bothGutters ? bars / 2 : bars);
  const textRight = m.colRight - m.padRight;
  const strip = Math.round(clientRight - textRight);
  return { strip, x: Math.round(textRight - m.wrapLeft + RAIL_GAP), room: strip >= RAIL_STRIP };
}

/** The reading line: a fifth of the way down the scroller, at most 96 px (the harness's line). */
export function readingLine(height: number): number {
  return Math.min(96, 0.2 * height);
}

/** The last of `n` turns whose top (`topOf`, in px from the scroller's top, in order) is at or above `line`; -1 before the first. */
function lastAtOrAbove(n: number, topOf: (i: number) => number, line: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (topOf(mid) <= line) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** The current turn's index: the last while the view follows the end (no top read), else by the reading line; the first before the first. */
export function currentTurn(n: number, topOf: (i: number) => number, line: number, following: boolean): number {
  if (n === 0) return -1;
  if (following) return n - 1;
  return Math.max(0, lastAtOrAbove(n, topOf, line));
}

/** The CLI's transcript keys (2.1.139): `{` is -1, `}` is 1, typed with no Cmd or Ctrl unless the layout's AltGr makes it. */
export function turnStep(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey?: boolean; getModifierState?: (key: string) => boolean }): -1 | 1 | null {
  if (e.key !== "{" && e.key !== "}") return null;
  if (e.metaKey) return null;
  if (e.ctrlKey && !e.getModifierState?.("AltGraph")) return null;
  return e.key === "{" ? -1 : 1;
}

/**
 * Where `{` (-1) or `}` (1) goes, by the landing line (`land` px below the scroller's top) so that a press never skips
 * a turn: `}` to the turn after the one at that line; `{` to the top of the turn the reader is inside (its top more
 * than INSIDE px above the line), else to the turn before. -1 when there is none.
 */
export function stepTo(n: number, topOf: (i: number) => number, land: number, dir: -1 | 1): number {
  const at = lastAtOrAbove(n, topOf, land + INSIDE);
  if (dir === 1) return at + 1 < n ? at + 1 : -1;
  if (at < 0) return -1;
  return topOf(at) < land - INSIDE ? at : at - 1;
}

/**
 * The reader's place that an entry of the tab's history keeps for Back (EntryState.place): an anchor of anchor.ts, or
 * "end" when the view followed the end. Null for anything else (a state written by another version of the page).
 */
export function keptPlace(v: unknown): AnchorRow[] | "end" | null {
  if (v === "end") return "end";
  if (!Array.isArray(v) || v.length === 0 || v.length > 8) return null;
  const ok = v.every((r) => !!r && typeof r === "object" && ["data-item-id", "data-turn-id", "data-testid"].includes((r as AnchorRow).attr) && typeof (r as AnchorRow).id === "string" && (r as AnchorRow).id.length <= 200 && Number.isFinite((r as AnchorRow).top));
  return ok ? (v as AnchorRow[]) : null;
}
