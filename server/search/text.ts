// What the message search keeps of a transcript (U5, DESIGN-U5 4 and 6): agent-neutral, on the seam's ChatEvents.
//
// Kept: the user's messages (`user` events, the bubble's words: without the file references that its tiles stand for,
// refsIn) and Claude's replies (`block` events of kind text on the main thread, the intermediate ones of a turn's work
// too, since a link opens the folded turn), each under the page's own row id (a user message's uuid, a reply block's
// itemIdOf), with who said it (`by`: the user or the agent, so the page can tell the user's words from a reply that
// repeats them). Left out: thinking, tool calls and their output, `!` commands and their output, slash commands' local
// output, notices and system lines, compaction, subagent rows (historyEvents leaves them out) and the side chat (its
// own record). A reply is read as the chat shows it: the Markdown marks that do not show are taken out (backticks,
// double asterisks, underscores and tildes, a line's leading `#` marks, `>` and list markers, fence lines, rules, a
// table's rules and pipes; a link keeps its text, an image its alt text). Every run of white space becomes one space.
// A provider's resource name in a message (a token that starts with `arn:`, as Bedrock names a model) is kept as
// "[an ARN]", so no snippet ever carries one (row 95).

import { itemIdOf } from "../../shared/ids";
import { refsIn, type ChatEvent } from "../../shared/protocol";
import { maskArns } from "../agents/types";

/** One message the search keeps: the page's row id, who said it, and its text as the snippet shows it. */
export interface SearchableMessage {
  id: string;
  by: "user" | "agent";
  text: string;
}

/** Every run of white space as one space, the ends trimmed. */
export function collapseSpace(s: string): string {
  return s.replace(/\s+/gu, " ").trim();
}

/** The user's words as the bubble shows them: the text without its file references. */
export function userSearchText(text: string): string {
  const refs = refsIn(text);
  if (refs.length === 0) return collapseSpace(text);
  let out = "";
  let at = 0;
  for (const r of refs) {
    if (r.at < at) continue;
    out += `${text.slice(at, r.at)} `;
    at = r.end;
  }
  return collapseSpace(out + text.slice(at));
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** A thematic break or a setext underline: three or more of one of - * _ = (with spaces). */
const RULE = /^ {0,3}([-*_=])(?:[ \t]*\1){2,}[ \t]*$/;
/** A table's delimiter row: pipes, colons, dashes and spaces only, with a dash. */
const TABLE_RULE = /^[ \t]*\|?[ \t:]*-[-| \t:]*$/;
const HEADING = /^ {0,3}#{1,6}(?=\s|$)[ \t]*/;
const QUOTE = /^[ \t]*(?:>[ \t]?)+/;
const LIST = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/;
/** A table's row: its cells' text shows, its pipes do not. */
const TABLE_ROW = /^[ \t]*\|.*\|[ \t]*$/;
const IMAGE = /!\[([^\]\n]*)\]\([^)\n]*\)/g;
const LINK = /\[([^\]\n]*)\]\([^)\n]*\)/g;
const MARKS = /\*\*|__|~~|`+/g;

/** A reply's Markdown as the text the chat shows (DESIGN-U5 6): the marks that do not show taken out, spaces collapsed. */
export function replySearchText(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const kept: string[] = [];
  for (const raw of lines) {
    if (FENCE.test(raw) || RULE.test(raw) || TABLE_RULE.test(raw)) continue;
    let line = raw.replace(QUOTE, "");
    line = line.replace(HEADING, "").replace(LIST, "");
    if (TABLE_ROW.test(line)) line = line.replace(/(?<!\\)\|/g, " ");
    kept.push(line);
  }
  const text = kept.join("\n").replace(IMAGE, "$1").replace(LINK, "$1").replace(MARKS, "");
  return collapseSpace(text);
}

/** The messages of a transcript's events that the search keeps, oldest first; an empty message is left out. */
export function searchableMessages(events: readonly ChatEvent[]): SearchableMessage[] {
  const out: SearchableMessage[] = [];
  for (const e of events) {
    let id: string | null = null;
    let by: SearchableMessage["by"] = "user";
    let text = "";
    if (e.k === "user") {
      id = e.uuid;
      text = userSearchText(e.text);
    } else if (e.k === "block" && e.kind === "text" && e.parent === null) {
      id = itemIdOf(e.key);
      by = "agent";
      text = replySearchText(e.text);
    }
    if (id !== null && text !== "") out.push({ id, by, text: maskArns(text) });
  }
  return out;
}
