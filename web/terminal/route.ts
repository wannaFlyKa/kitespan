// Where the Terminal pane shows (D38): at /c/<chat>/shell, and behind the copy dialog (/c/<chat>/terminal) when the
// pane's own Copy the command opened it, so the pane stays in place under the dialog and comes back when it closes.
// What its header names, and the 5.4 line that its phone page shows for a link that could not be read in full.
import { folderParts } from "../panels/format";
import { href, type EntryState, type Route } from "../router";
import { halfClose, kindShown, openHref, shellUnder } from "../layout/split";
import { PANEL_ROUTES } from "../routes";
import { COMMANDS } from "../state/catalog";
import type { CommandRow } from "../state/types";
import { linkNoticeLine } from "../ui/LinkNotice";

/**
 * The folder that the pane's header names (DESIGN.md 6.10): its own name, as the sidebar and the Environment card name
 * it, never a path cut at its start. The full path is the header's title, and Copy the command shows it.
 */
export function paneFolderName(folder: string): string {
  return folder ? folderParts(folder).name : "";
}

/**
 * The 5.4 line ("That link could not be read.", "Part of that link could not be read.") on the phone's Terminal page
 * only (`page`): there the chat, which draws the line at every other size (ChatScreen.tsx), is hidden under the page,
 * so the page shows it once, under its title bar. Elsewhere the chat beside the pane shows it, and the pane does not.
 */
export function pageLinkLine(route: Route, page: boolean): string | null {
  return page ? linkNoticeLine(route) : null;
}

/**
 * The /c/<chat>/shell URL the current entry was opened from, if any (the router keeps `from` in the entry's state). U4:
 * also a pair with the Terminal in it (its lower half), so the copy dialog keeps the pair under it.
 */
export function shellBehind(chatId: string): string | null {
  return shellUnder(chatId);
}

/** True when the route shows the chat's Terminal pane. */
export function terminalShown(route: Route): boolean {
  if (route.name === "shell") return true;
  return route.name === "terminal" && !!route.params.chat && shellBehind(route.params.chat) !== null;
}

/** The pane's URL with the resume command typed: what Open in terminal opens (the title bar, the session menu). */
export function openInTerminalHref(chatId: string, view?: string): string {
  return href("shell", { chat: chatId }, { type: "resume", view });
}

/**
 * The terminal-only command whose / menu pick opened this history entry (D47): the composer puts its name in the
 * entry's state (EntryState thenType), never in the URL. Only a name of a known terminal-only command counts: one of
 * the chat's own `/` menu rows (store.ts commandRowsOf), or of the list the page has before Claude Code sent one.
 */
export function thenTypeOf(state: unknown, commands: readonly CommandRow[] = []): string | null {
  const name = (state as EntryState | null)?.thenType;
  if (typeof name !== "string") return null;
  return [...commands, ...COMMANDS].some((c) => c.terminalOnly && c.name === name) ? name : null;
}

/**
 * Where Ctrl+backtick (keys.ts) goes from a route of chat `chatId` (DESIGN.md 6.11): from the Terminal pane to the
 * chat, which closes the pane (`close`: Shell.tsx uses closeTo); from the chat or one of its side panel views to the
 * pane with nothing typed; from anything else (a dialog, an action route that waits for its click) nowhere. U4, where
 * the split shows (`live`): with the Terminal in a half it closes that half (the other view alone), and it opens the
 * Terminal by the opener rules (below the one view, or in a pair's lower half).
 */
export function terminalToggleTarget(route: Route, chatId: string, live = false): { to: string; close: boolean } | null {
  if (route.fallbackFrom || route.params.chat !== chatId) return null;
  const view = typeof route.query.view === "string" ? route.query.view : undefined;
  const half = live ? kindShown(route, "terminal", true) : null;
  if (half?.half && route.name !== "terminal") return { to: halfClose(half) ?? href("chat", { chat: chatId }, { view }), close: true };
  if (route.name === "shell") return { to: href("chat", { chat: chatId }, { view }), close: true };
  if (route.name === "chat" || PANEL_ROUTES.has(route.name)) return { to: openHref(route, href("shell", { chat: chatId }, { view }), live), close: false };
  return null;
}
