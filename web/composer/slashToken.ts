// The `/` menu at a mid-line `/` (D57, DESIGN.md 6.4), on the `@` picker's token rules (mention.ts typedAt, tokenAt).
// A `/` that the user types at a word start opens the `/` menu's rows over that word: after white space, or at the
// start of a non-empty field (a `/` typed into an empty field still picks the `/` mode, draft.ts typed). It opens in
// Chat mode and in a command's arguments after its chip; not in Bash mode, not while the field is still the command
// filter, never inside a word (src/app, a/b, http://), and never from a paste, a drop or a link's text (5.1 rule 7):
// only a change that typed one `/` before the caret does. Its filter is the text from after the `/` to the caret, with
// no white space; the menu closes when that stops being so, or when the field's mode or chip changes. It is the field's
// own state, as the typed `@` picker is: no URL (/c/<chat>/slash stays the start-of-message menu).
//
// The menu shows only while a row answers the filter (Composer.tsx slashShown): a path such as /etc/hosts (no command
// name holds a `/`) or a word such as /zzz shows nothing, and Enter sends as with no menu; the token stays open, so
// Backspace back to a filter with rows shows the menu again. A pick puts `/<name> ` in place of `/<filter>` and the
// caret after the space: plain text, no chip, no mode change, nothing sent, also for a terminal-only row. The keys are
// the `@` picker's (mention.ts mentionKey): Enter never sends while the menu shows. kitespan sends the text as typed.
import type { Draft } from "./draft";
import { tokenAt, typedAt, type MentionToken } from "./mention";

/** The menu's token: where its `/` is, and the filter (the text after it, up to the caret). */
export type SlashToken = MentionToken;

type Field = Pick<Draft, "mode" | "command" | "text">;

/** Where a typed `/` opens the menu: Chat mode, and a command's arguments after its chip. */
export function slashField(d: Pick<Draft, "mode" | "command">): boolean {
  return d.mode === "chat" || (d.mode === "slash" && d.command !== null);
}

/**
 * The menu's token after the field changed from `prev` to `next` (the composer's drafts) with the caret at `caret`:
 * the open token as it follows the text, or a new one when this change typed a `/` at a word start; null when it
 * closes or stays closed. A change of the field's mode or chip closes it: the text is another field's then.
 */
export function nextSlash(open: SlashToken | null, prev: Field, next: Field, caret: number, inputType: string | null): SlashToken | null {
  if (!slashField(next) || prev.mode !== next.mode || prev.command !== next.command) return null;
  if (open) return tokenAt(next.text, open.at, caret, "/");
  const at = typedAt(prev.text, next.text, caret, inputType, "/");
  return at >= 0 ? { at, filter: "" } : null;
}

/**
 * The field's text after a pick of `name`: `/<name>` and one space in place of `/<filter>`, the rest after it as it
 * was, and the caret after the space. A space that follows the token already is that one space.
 */
export function slashPick(text: string, token: SlashToken, name: string): { text: string; caret: number } {
  const head = `${text.slice(0, token.at)}/${name} `;
  const rest = text.slice(token.at + 1 + token.filter.length);
  return { text: head + (rest.startsWith(" ") ? rest.slice(1) : rest), caret: head.length };
}
