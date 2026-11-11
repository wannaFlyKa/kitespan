// The `@` picker's rules as pure functions (DESIGN.md 6.4 "The `@` picker", 9.3; owner row 54). The picker opens when
// the user types one `@` at the start of the field or after white space, in Chat mode only. The page finds it from the
// field's `input` event and the caret, never from a key event, because text that an input method or an Android
// keyboard commits can come with no key event at all. A paste, a drop or a link's text never opens it (5.1 rule 7):
// only a change that inserted one `@` before the caret, by typing or by an input method, does. Its filter is the text
// from after the `@` to the caret, with no white space in it; the picker closes when that stops being so (white space,
// the `@` gone, the caret out of it). A pick takes the `@<filter>` text out of the field and puts the caret where the
// `@` was; the file becomes a mention chip of the draft (store.ts act.addMention).
//
// The keys while it shows: Up and Down move, Enter and Tab pick, and Enter never sends, also with no row. These keys
// belong to an input method while it composes (composition.ts imeKey: with a fine pointer `isComposing` or key code
// 229; on touch while the field shows marked text, or ended it under 100 ms ago): the picker then does nothing and
// leaves the key alone, and the layer's Esc leaves it open (ui/primitives). Otherwise on touch Enter picks at once,
// also after dictation (7.5). A pick is of rows that answer the filter in the field: an Enter or Tab that comes before
// them (the server's answer is on its way, or the deferred list has not caught up) waits for them and picks their
// first row.
//
// A /c/<chat>/mention?q= link (5.2) puts `@<q>` after the box's text as the picker's token, and only as its filter:
// a pick, or a close with no pick, takes it out again with the space the link put before it, so the box is as it was.
import { CORPUS_LIMITS } from "../../shared/corpus";
import type { FileRows } from "../search/engine";
import type { Draft } from "./draft";

/** An open picker's `@` token: where its `@` is, and the filter (the text after it, up to the caret). */
export interface MentionToken {
  at: number;
  filter: string;
}

/** A link's token: the space the link put before its `@`, and whether the box's text was a link's before it. */
export interface LinkMark {
  lead: string;
  fromLink: boolean;
}

/** The open picker: its token, and for a /c/<chat>/mention?q= link's token, the link's mark. */
export type OpenMention = MentionToken & { link?: LinkMark };

const SPACE = /\s/;
const isWordStart = (text: string, at: number) => at === 0 || SPACE.test(text[at - 1]!);

/** The input types of the user's own typing: a key, or an input method's text. A paste, a drop or a replacement is not. */
const TYPED = new Set(["insertText", "insertCompositionText"]);

/**
 * Where a change typed an `@` that opens the picker, or -1. `prev` and `next` are the field's value before and after
 * the change, `caret` the caret after it, and `inputType` the change's InputEvent.inputType (null when it is not
 * known). It opens only when the change put one `@` just before the caret, at a word start, and left the text before
 * it and after the caret as they were: a typed `@`, also one typed over a selection (with an unknown input type, only
 * one typed with no selection). `trigger` is the character: `@`, or `/` for the mid-line `/` menu (slashToken.ts).
 */
export function typedAt(prev: string, next: string, caret: number, inputType: string | null, trigger = "@"): number {
  if (inputType !== null && !TYPED.has(inputType)) return -1;
  const at = caret - 1;
  if (at < 0 || next[at] !== trigger || !isWordStart(next, at)) return -1;
  const tail = next.length - caret;
  const replaced = prev.length - at - tail; // what the `@` took the place of
  if (replaced < 0 || (inputType === null && replaced !== 0)) return -1;
  if (next.slice(0, at) !== prev.slice(0, at) || next.slice(caret) !== prev.slice(at + replaced)) return -1;
  return at;
}

/** A filter the picker can hold: no white space, and not longer than the search route takes (1,024 characters). */
export function filterFits(filter: string): boolean {
  return !SPACE.test(filter) && filter.length <= CORPUS_LIMITS.queryMax;
}

/**
 * The open picker's token after the field changed, or null when the picker closes: the `@` (`trigger`) is still at
 * `at` and at a word start, the caret is after it, and the filter fits (filterFits).
 */
export function tokenAt(text: string, at: number, caret: number, trigger = "@"): MentionToken | null {
  if (at < 0 || caret <= at || text[at] !== trigger || !isWordStart(text, at)) return null;
  const filter = text.slice(at + 1, caret);
  return filterFits(filter) ? { at, filter } : null;
}

/**
 * The picker's token after the field changed from `prev` to `next` (the composer's drafts) with the caret at `caret`:
 * the open token as it follows the text, or a new one when this change typed an `@`; null when it closes or stays
 * closed. Chat mode only: in Bash mode `@` is shell text, and in `/` mode the field is a command.
 */
export function nextToken(open: MentionToken | null, prev: { mode: string; text: string }, next: { mode: string; text: string }, caret: number, inputType: string | null): MentionToken | null {
  if (next.mode !== "chat") return null;
  if (open) return tokenAt(next.text, open.at, caret);
  const at = typedAt(prev.mode === "chat" ? prev.text : "", next.text, caret, inputType);
  return at >= 0 ? { at, filter: "" } : null;
}

/**
 * The field's text after a pick: the `@<filter>` taken out, and the caret where the `@` was. A link's token goes with
 * the space the link put before it, so the box's text is as it was before the link.
 */
export function withoutToken(text: string, token: OpenMention): { text: string; caret: number } {
  const lead = token.link?.lead ?? "";
  const from = lead && text.slice(token.at - lead.length, token.at) === lead ? token.at - lead.length : token.at;
  return { text: text.slice(0, from) + text.slice(token.at + 1 + token.filter.length), caret: from };
}

/**
 * The `@` button (7.5): the field's text with an `@` put at the caret (or over the selection), with a space before it
 * when the caret is inside a word, so that the picker opens; the caret goes after the `@`.
 */
export function insertAt(text: string, start: number, end: number): { text: string; at: number } {
  const before = text.slice(0, start);
  const lead = isWordStart(text, start) ? "" : " ";
  return { text: `${before}${lead}@${text.slice(end)}`, at: start + lead.length };
}

/**
 * The draft's text that a `/c/<chat>/mention?q=` link shows: the box's chat text, then `@<q>` as the picker's token,
 * with a space before it (`lead`) when the text does not end in white space.
 */
export function linkToken(text: string, q: string): { text: string; at: number; lead: string } {
  const lead = text === "" || SPACE.test(text[text.length - 1]!) ? "" : " ";
  return { text: `${text}${lead}@${q}`, at: text.length + lead.length, lead };
}

/**
 * A /c/<chat>/mention?q= link (5.2): the box's chat text `kept` (the server's draft, or the field's own unsent text)
 * with `@<q>` after it as the picker's token, shown and not saved until the user changes it. A `!` or `/` draft cannot
 * hold the picker: the link's token takes its place in the field, as a /send link's text does. `@<q>` from a link is a
 * link's text (5.1 rule 7: the warning line shows). The composer runs it again when the server's draft comes after
 * the field was built (a page load or a reload of the link), so the box's own text shows and a pick keeps it.
 */
export function mentionFill(kept: Draft, q: string): { draft: Draft; mention: OpenMention | null } {
  const base: Draft = kept.mode === "chat" ? kept : { mode: "chat", command: null, text: "", fromLink: false };
  const t = linkToken(base.text, q);
  const token = tokenAt(t.text, t.at, t.text.length);
  return {
    draft: { mode: "chat", command: null, text: t.text, fromLink: base.fromLink || q !== "" },
    mention: token && { ...token, link: { lead: t.lead, fromLink: base.fromLink } },
  };
}

/**
 * What a key does while the picker shows: `down` and `up` move the highlight; `pick` picks the active row; `wait` takes
 * the key and picks once the rows for the filter come (`current` is false: the rows shown answer an older filter);
 * `stop` takes the key and does nothing (Enter with no row: it never sends); `ime` leaves the key to the input method
 * (nothing happens, nothing is prevented); `pass` is not the picker's key (Shift+Enter makes a new line, which closes
 * it). `ime`: an input method composes (composition.ts imeKey, the one IME guard); on touch only while the field
 * shows marked text, so after dictation Enter picks at once.
 */
export type MentionKey = "down" | "up" | "pick" | "wait" | "stop" | "ime" | "pass";

export function mentionKey(k: { key: string; shiftKey: boolean; ime: boolean }, rows: number, current = true): MentionKey {
  const own = k.key === "ArrowDown" || k.key === "ArrowUp" || k.key === "Enter" || k.key === "Tab" || k.key === "Escape";
  if (!own) return "pass";
  if (k.ime) return "ime";
  switch (k.key) {
    case "ArrowDown":
      return rows ? "down" : "pass";
    case "ArrowUp":
      return rows ? "up" : "pass";
    case "Tab":
      if (k.shiftKey) return "pass";
      return !current ? "wait" : rows ? "pick" : "pass";
    case "Enter":
      if (k.shiftKey) return "pass";
      return !current ? "wait" : rows ? "pick" : "stop";
  }
  return "pass"; // Escape: the picker is a layer, which closes it before Stop
}

/**
 * A waiting Enter or Tab (`wait`, for the token it came in) as the rows change: the row to pick (the first, the best
 * for what was typed) once rows answer its filter; `wait` while they do not yet; `drop` when no key waits, the token
 * changed (more typing, the picker closed) or nothing matches. A dropped key does nothing, and never sends.
 */
export function waitedPick(waiting: MentionToken | null, open: MentionToken | null, rows: FileRows | null): number | "wait" | "drop" {
  if (!waiting || !open || open.at !== waiting.at || open.filter !== waiting.filter) return "drop";
  if (!rows || rows.q !== waiting.filter) return "wait";
  return rows.rows.length ? 0 : "drop";
}
