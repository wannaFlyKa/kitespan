// End it here and copy (DESIGN.md 6.10, 9.4; build checklist S16, L16): the copy dialog's second running case. The
// click copies the plain command inside the click (7.10), then sends `end_here`; the server ends the chat's Claude Code
// at its first quiet moment and holds the chat as handed to the terminal (the row's `held.kind`), so every page's dialog
// learns from the chat list when it ended.
import { processLives, resumeCommand, type ResumeInput } from "../terminal/command";
import type { Chat } from "../state/types";

export const END_HERE_WORDS = {
  button: "End it here and copy",
  wait: "Wait: this chat's Claude Code is still running.",
  ended: "Ended. Paste the command in your terminal now.",
} as const;

/** The dialog's line while the chat is handed to the terminal: Wait until its Claude Code ends, then Ended; else none. */
export function endHereLine(chat: ResumeInput & Pick<Chat, "held">): string | null {
  if (chat.held?.kind !== "handed") return null;
  return processLives(chat) ? END_HERE_WORDS.wait : END_HERE_WORDS.ended;
}

/** The plain command (never the fork one), which End it here copies while the process still runs. */
export function plainResume(chat: ResumeInput, folder: string): string | null {
  return resumeCommand({ ...chat, state: "sleeping", serverState: "sleeping", held: null }, folder).command;
}

/** The click: the copy first, inside the click, then the request. */
export function endHereClick(plain: string, copy: (text: string) => void, send: () => void): void {
  copy(plain);
  send();
}
