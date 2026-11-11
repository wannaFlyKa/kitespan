// The new-chat form's prompt box as a chat's composer (D59, DECISIONS-OWNER row 75; DESIGN.md 6.4, 6.9): the rules
// that the form's box adds to the composer's own (draft.ts, mention.ts, slashToken.ts), as pure functions. The form's
// box has the composer's two modes that a first message can be: Chat, and "/" (a "/" typed into the empty field picks
// it: the command chip and the / menu over the project's commands). A "!" stays text: the form has no Bash mode, since
// a chat starts with a message. A link's text stays plain (draft.ts typed), so /new?text=/x is the text "/x".
//
// Start sends the box as a chat's Send would: the message, or the command with its arguments (`/<name> <args>`) as the
// first message, with the mention chips (paths relative to the project's folder) in the new_chat frame. As Send, it
// works with files alone (mention chips or done uploads) in Chat mode; a command needs its text (formCanStart).
//
// The start menu (a "/" in the empty field) leaves out, besides the terminal-only commands, the built-in ones that act
// on a conversation that exists (formStartRows): as a new chat's first message they have nothing to act on. The
// mid-line menu, which only types a name into the text, keeps them.
//
// The / menu's rows before a chat exists are the project's (GET /api/projects/:project/commands): `at` is when the
// server read them, null with an empty list while its first read runs or after it failed; the page asks once more
// about 3 s later (asksAgain).
//
// The menus rise from a chat's composer, at the bottom of the screen. The form's box is near the top of the page, so
// its menus open on the side with more room, under the box when it has room for a few rows (menuSide).
import { LIMITS, isSafeRelativePath } from "../../shared/protocol";
import { outgoing, typed, type Draft, type MenuRow } from "./draft";

/** The draft after the field's value changed (draft.ts typed), with no Bash mode: a "!" is text. */
export function formTyped(prev: Draft, value: string, replacedAll: boolean): Draft {
  const next = typed(prev, value, replacedAll);
  return next.mode === "bash" ? { mode: "chat", command: null, text: value, fromLink: next.fromLink } : next;
}

/** What Start sends as the first message: the message trimmed, or the command with its arguments; "" for nothing. */
export function formStartText(d: Draft): string {
  return d.mode === "slash" ? outgoing(d) : d.text.trim();
}

/**
 * Whether Start may send (the composer's canSend): not while an upload is on its way; a message, a command with its
 * arguments, or in Chat mode files alone (mention chips of this project or done uploads).
 */
export function formCanStart(d: Draft, files: { uploads: number; mentions: number }, busy: boolean): boolean {
  if (busy) return false;
  return formStartText(d) !== "" || (d.mode === "chat" && files.uploads + files.mentions > 0);
}

/** The built-in commands that act on a conversation that exists: a new chat has none yet (W19d). */
const CONVERSATION_ONLY: ReadonlySet<string> = new Set(["clear", "compact"]);

/** The start menu's rows: the project's, without the built-in commands that need a conversation (CONVERSATION_ONLY). */
export function formStartRows(rows: readonly MenuRow[]): MenuRow[] {
  return rows.filter((r) => !(r.source === "built-in" && CONVERSATION_ONLY.has(r.name)));
}

/**
 * The mention chips with `path` added after the others (each path once): null when it cannot be one (not a safe
 * relative path, or the chips are at the new_chat frame's limit of 100).
 */
export function withPath(list: readonly string[], path: string, max: number = LIMITS.sendMentions): readonly string[] | null {
  if (!isSafeRelativePath(path)) return null;
  if (list.includes(path)) return list;
  if (list.length >= max) return null;
  return [...list, path];
}

/** How long the page waits before it asks once more for a project's commands that the server had not read yet. */
export const COMMANDS_AGAIN_MS = 3000;

/** The server had no list yet (its first read runs, or it failed): an empty list with no `at`. */
export function asksAgain(reply: { commands: readonly unknown[]; at: string | null } | null | undefined): boolean {
  return !!reply && reply.at === null && reply.commands.length === 0;
}

/** The fewest pixels a menu under the box needs (three rows and a little); with less, the side with more room. */
export const MENU_MIN_BELOW = 132;
/** The tallest a menu gets (composer.css .menu.cmp-slash). */
export const MENU_MAX = 340;
const GAP = 6; // between the box and the menu (composer.css)
const MARGIN = 8; // between the menu and the edge of the room

/**
 * Where the form's menus open: under the box when the room under it (to the visual viewport's bottom: the on-screen
 * keyboard's top) holds MENU_MIN_BELOW, or holds more than the room above it (to the top bar); above it otherwise.
 * `maxHeight` is the room on that side, at most MENU_MAX and at least 88 px.
 */
export function menuSide(box: { top: number; bottom: number }, room: { top: number; bottom: number }): { below: boolean; maxHeight: number } {
  const under = room.bottom - box.bottom - GAP - MARGIN;
  const over = box.top - room.top - GAP - MARGIN;
  const below = under >= MENU_MIN_BELOW || under >= over;
  return { below, maxHeight: Math.round(Math.max(88, Math.min(MENU_MAX, below ? under : over))) };
}
