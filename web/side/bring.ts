// Bring back (owner rows 128 and 130; DESIGN-R130 section 5): one side answer goes into the main message box's draft,
// the server-held draft of D49, as a Markdown quote, the form that Claude Code draws as a quote: each line with "> "
// before it, an empty line ">". It goes after the text already in the box, with one blank line between them, and a
// blank line after it, so the caret waits on a line of its own for the user's words. No heading and no question: the
// user reads, adds their own words and sends; nothing is ever sent by itself. The refusal fallback's notice above an
// answer is not part of the answer, so it is never quoted.
//
// It refuses, and changes nothing, while the box holds a command (a `/` chip, or `!` mode with text), as Take back
// does, and when the result would pass the draft's cap. An empty `!` or `/` box becomes a message first.
import { LIMITS } from "../../shared/protocol";
import type { ChatDraft } from "../state/store";

export const BRING_BACK = "Bring back";
/** Its accessible name: where the answer goes. */
export const BRING_BACK_NAME = "Bring back to the message box";
/** The line above the composer, in Take back's place, while the box holds a command. */
export const BRING_COMMAND_LINE = "To bring that answer back, first run or clear the command in the message box.";
export const BRING_TOO_LONG = "That answer is too long to bring back (the limit is 20,000 characters).";
/** /c/<chat>/btw/<exchange> for an exchange that the thread no longer has (5.4). */
export const SIDE_EXCHANGE_GONE = "That side question is not in the side chat any more.";

/** The answer as a Markdown quote: its own line ends, with the blank lines at either end left out. */
export function quoteAnswer(answer: string): string {
  const lines = answer.replace(/\r\n?/g, "\n").split("\n");
  const blank = (l: string) => l.trim() === "";
  let start = 0;
  let end = lines.length;
  while (start < end && blank(lines[start]!)) start++;
  while (end > start && blank(lines[end - 1]!)) end--;
  return lines
    .slice(start, end)
    .map((l) => (blank(l) ? ">" : `> ${l}`))
    .join("\n");
}

/** The box's text with the quote after it (a box of white space only is an empty box). */
export function bringText(box: string, answer: string): string {
  const quote = `${quoteAnswer(answer)}\n\n`;
  if (box.trim() === "") return quote;
  // A box that ends with a blank line gets no second one; one that ends with a line break gets one more.
  if (/\n[ \t]*\n[ \t]*$/.test(box)) return box + quote;
  if (/\n[ \t]*$/.test(box)) return `${box}\n${quote}`;
  return `${box}\n\n${quote}`;
}

/**
 * Where the message box's field scrolls after the press on touch, where nothing takes the focus (6.7): the quote's last
 * line is the last whole line in view, so the two lines after it (the blank line that ends the quote, and the line
 * where the caret will wait) are under the view, and the view's top is a whole line. A field that shows the quote from
 * its first line does not scroll. The phone's field shows 4 lines, so a scroll to the end showed only 2 of the quote.
 */
export function broughtScrollTop(f: { scrollHeight: number; clientHeight: number; lineHeight: number; padTop: number }): number {
  const end = Math.max(0, f.scrollHeight - f.clientHeight);
  return Math.max(0, Math.min(end, Math.round(end - 2 * f.lineHeight + f.padTop)));
}

export type BringResult = { ok: true; draft: ChatDraft } | { ok: false; why: "command" | "long" | "empty" };

/**
 * The box's draft after the press, or why nothing changes. `command`: the box holds a command now (store.ts
 * isCommandDraft, by its mode, never its text's first character). The chips and mentions stay; a link's mark stays
 * while the link's text stays in the box (5.1 rule 7), and the quote alone is the user's own.
 */
export function bringInto(box: ChatDraft, answer: string, command: boolean): BringResult {
  if (quoteAnswer(answer) === "") return { ok: false, why: "empty" };
  if (command) return { ok: false, why: "command" };
  // An empty `!` or `/` box becomes a message first, as Take back does.
  const kept = box.mode === "chat" ? box.text : "";
  const text = bringText(kept, answer);
  if (text.length > LIMITS.draftText) return { ok: false, why: "long" };
  return { ok: true, draft: { ...box, mode: "chat", command: null, text, link: box.link && kept.trim() !== "" } };
}
