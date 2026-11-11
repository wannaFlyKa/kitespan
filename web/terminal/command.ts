// The command that resumes a chat's Claude Code session in a terminal (DESIGN.md 6.10, D38): the copy dialog
// (/c/<chat>/terminal) copies it. The Terminal pane never types it from here: for /c/<chat>/shell?type=resume the
// server computes the same command from the chat's own folder, session id and state (server/shell/command.ts) and
// types it. Two processes must not write one session, so while the chat's Claude Code process lives only the fork
// command is offered; a chat with no message yet has no session id, so there is no command at all.
import { shellQuote, type ChatState as WireChatState } from "../../shared/protocol";
import type { Chat } from "../state/types";

/** The dialog's line for a chat with no message yet (DESIGN.md 6.10). */
export const NO_SESSION_LINE = "This chat gets a session id with its first message.";
/**
 * The line above the prompt when the pane types the fork command, and the dialog's first words then. True in every
 * state that has a process: running, waiting, idle, starting, and failed while the process lives.
 */
export const FORK_LINE = "This chat's Claude Code is still open, so this is a fork command: it opens a copy and leaves this chat as it is.";
/**
 * The line above the prompt when the server typed nothing because the prompt was not free (another page typed at it, a
 * key left text there, or a program runs): Copy the command, in the pane's header, is the way on.
 */
export const BUSY_LINE = "Nothing was typed: the prompt is in use. Use Copy the command.";
/**
 * The same for Open in terminal's commands of a line under a row (R127's trust fallback, R131's `claude attach <id>`):
 * Copy the command copies this chat's own resume command, the wrong one there, so the way on is to free the prompt
 * (a typed line, or a program such as an earlier `claude attach`, which Ctrl+Z leaves) and press the button again.
 */
export const OPEN_AGAIN_BUSY_LINE = "Nothing was typed: the prompt is in use. Clear it or leave its program (Ctrl+Z leaves Claude Code), then press Open in terminal again.";
/** The line above the typed command when a terminal-only command's pick in the / menu opened the pane (D47). */
export const thenTypeLine = (command: string) => `Then type /${command}.`;

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A word that every POSIX shell, zsh and fish read as itself (the server's rule, server/shell/command.ts). */
const PLAIN_WORD = /^[A-Za-z0-9_./+-]+$/;

/**
 * A folder for a shell line: plain when it is safe, else single-quoted, as the server quotes it; a leading ~/ stays
 * outside the quotes, so the shell still reads it as the home folder.
 */
export function shellArg(path: string): string {
  if (path.startsWith("~/")) {
    const rest = path.slice(2);
    return `~/${rest === "" || PLAIN_WORD.test(rest) ? rest : shellQuote(rest)}`;
  }
  return PLAIN_WORD.test(path) ? path : shellQuote(path);
}

export type ResumeCase = "fork" | "plain" | "none";

export interface ResumeCommand {
  case: ResumeCase;
  /** The line to type or copy; null when the chat has no session id yet. */
  command: string | null;
  /** The line the pane shows above its prompt: the fork note, or the no-session line. */
  note: string | null;
}

/**
 * What the command needs of a chat. `serverState` is the server's word (4.1): every state but sleeping may still have
 * the process (an ending chat too, which the list shows as sleeping), as the server's own rule says
 * (server/main.ts: the shell's `processOpen`). Without it, the list's state decides: a sleeping chat has no process
 * and every other state has one. A failed chat is the one state where the process may have died (types.ts): with
 * `processAlive: false` it gets the plain command; while that is unknown, the fork command, which is safe either way.
 * A chat held as `finishing` (R16) sleeps in this server, but the Claude Code of the server before still writes its
 * session until it exits, so it counts as a live process. `loaded` false: the history is not drawn yet, so no items
 * do not mean no message.
 */
export type ResumeInput = Pick<Chat, "state" | "sessionId" | "items"> & { processAlive?: boolean; serverState?: WireChatState; loaded?: boolean; held?: Chat["held"] };

/** True while the chat's Claude Code process lives, so a second process must not resume its session. */
export function processLives(chat: ResumeInput): boolean {
  if (chat.held?.kind === "finishing") return true;
  if (chat.serverState) return chat.serverState !== "sleeping";
  if (chat.state === "sleeping") return false;
  if (chat.state === "failed") return chat.processAlive !== false;
  return true;
}

/**
 * The resume command of a chat whose folder is `folder`: the fork command while its Claude Code process lives, the
 * plain one once it has ended, none before its first message. Nothing in it comes from a URL: the folder is the
 * project's and the session id must be a UUID.
 */
export function resumeCommand(chat: ResumeInput, folder: string): ResumeCommand {
  if ((chat.items.length === 0 && chat.loaded !== false) || !SESSION_ID.test(chat.sessionId)) return { case: "none", command: null, note: NO_SESSION_LINE };
  const plain = `cd ${shellArg(folder)} && claude --resume ${chat.sessionId}`;
  if (processLives(chat)) return { case: "fork", command: `${plain} --fork-session`, note: FORK_LINE };
  return { case: "plain", command: plain, note: null };
}
