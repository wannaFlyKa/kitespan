// `/btw` in the message box (owner row 124; DESIGN-R124 sections 2.6, 6 and 8): kitespan's own side question, never a
// prompt. Claude Code 2.1.317's command list for an SDK session has no `btw` row, and typed as a prompt Claude Code
// answers "/btw isn't available in this environment." So the chat's `/` menu gets kitespan's own row, with the CLI's
// description and argument hint (never terminal-only: the page answers it), and at Send any of these is a side
// question that goes to the side chat and never to Claude Code: the btw chip, the `/` filter text "btw ..." with no
// chip, or a message whose text starts with "/btw" (a link's plain text) followed by white space or its end. A bare
// `/btw` opens the side chat. The new-chat form's menu has no such row (no chat exists yet to ask about), and a first
// message that is /btw sends nothing: one line says to start the chat first (the server refuses it too).
import { BTW_COMMAND, btwQuestion } from "../../shared/protocol";
import type { Draft, MenuRow } from "../composer/draft";

export const BTW = BTW_COMMAND;

/**
 * The message box takes 20,000 characters and a side question 5,000 (4.3): over that, Send asks nothing, the box keeps
 * the text, and this line says why, in the words of 5.4's link line.
 */
export const BTW_TOO_LONG = "That side question is too long (the limit is 5,000 characters).";

/** The new-chat form's line for a first message that is /btw: a side question needs a chat to ask about. */
export const BTW_NO_CHAT = "Start the chat first, then ask a side question.";

/**
 * The line the new-chat form's Start shows in place of sending (null: it sends): a first message that is a side
 * question, where the agent answers side questions. Without them the server's own refusal (unsupported) says so.
 */
export function formSideLine(text: string, offered: boolean): string | null {
  return offered && btwQuestion(text) !== null ? BTW_NO_CHAT : null;
}

/** The CLI's own words for the command (its description and argument hint, 2.1.317). */
export const BTW_ROW: MenuRow = Object.freeze({
  name: BTW,
  hint: "Ask a quick side question without interrupting the main conversation",
  args: "[question]",
  source: "built-in",
}) as MenuRow;

/**
 * The chat's `/` menu rows with `/btw` as kitespan's (`offered`: the chat's agent answers side questions). Claude
 * Code's own btw row, if a later version lists one, keeps its words and is never terminal-only here. A list that has
 * not come yet stays as it is: a slash link is judged against Claude Code's list once it came (draft.ts prefillOf).
 */
export function withSideRow(rows: MenuRow[], offered: boolean): MenuRow[] {
  if (!offered || rows.length === 0) return rows;
  const at = rows.findIndex((r) => r.name === BTW);
  if (at >= 0) {
    if (!rows[at]!.terminalOnly) return rows;
    const next = [...rows];
    next[at] = { ...rows[at]!, terminalOnly: undefined };
    return next;
  }
  // In the list's order of names, before the first row whose name sorts after it.
  const before = rows.findIndex((r) => r.name.localeCompare(BTW) > 0);
  return before < 0 ? [...rows, BTW_ROW] : [...rows.slice(0, before), BTW_ROW, ...rows.slice(before)];
}

/**
 * The side question a Send of this draft asks, or null for a draft that goes to Claude Code as it does today. The
 * question is the text after `btw`, trimmed; "" is a bare `/btw`, which only opens the side chat. The text forms are
 * the server's own rule (shared/protocol.ts btwQuestion), so the page and the server read "/btw" the same way.
 */
export function sideQuestionOf(d: Pick<Draft, "mode" | "command" | "text">): { question: string } | null {
  if (d.mode === "slash") {
    if (d.command === BTW) return { question: d.text.trim() };
    if (d.command) return null;
    const q = btwQuestion("/" + d.text.trimStart());
    return q === null ? null : { question: q };
  }
  if (d.mode !== "chat") return null;
  const q = btwQuestion(d.text);
  return q === null ? null : { question: q };
}
