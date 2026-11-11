// The command that Open in terminal types at the pane's prompt (DESIGN.md 6.10, D14, D38). The server computes it from
// the chat's own folder, session id and state; nothing in it comes from the page. Two processes must not write one
// session, so while the chat's Claude Code process may still be alive only the fork command is typed. The command
// never holds a line end or any other control character, so typing it never runs it.

import { isAbsolute } from "node:path";
import { isBgId, isUuid } from "../../shared/ids";
import { shellQuote } from "../../shared/protocol";

/** What the shell needs of a chat. The registry fills it in (server/shell/service.ts, ShellHost). */
export interface ShellChat {
  /** The chat's folder (absolute): the shell starts there, and the command changes to it. */
  cwd: string;
  /** Claude Code's session id once the chat has a transcript to resume (its first message went out); null before. */
  sessionId: string | null;
  /**
   * True while the chat's Claude Code process may be alive: every state but sleeping, and a failed chat until the
   * server knows that its process ended. Then the fork command is typed, never the plain one.
   */
  processOpen: boolean;
  /** D48: an archived chat gets no shell. */
  archived: boolean;
  /**
   * Row 73 (L28): the project's folder when `cwd` is the chat's own worktree, so the terminal can read the project's
   * config as the chat does (`--project-config-root`, while PROJECT_CONFIG_ROOT_IN_TERMINAL is on). Absent: none.
   */
  configRoot?: string | null;
}

/**
 * L28: Open in terminal adds `--project-config-root <project folder>` for a worktree chat, so the terminal reads the
 * project's config as the chat does (not only the worktree branch's own `.claude`). The lead's live check LV-W4 on
 * Claude Code 2.1.317: an interactive resume takes the hidden flag, as it takes the plain command; both then ask
 * Claude Code's trust question for a worktree folder it never saw (live/LIVE-NOTES.md item 10).
 */
export const PROJECT_CONFIG_ROOT_IN_TERMINAL = true;

export type ResumeCase = "plain" | "fork" | "none";

export interface ResumeCommand {
  case: ResumeCase;
  /** The line to type, with no line end; null when there is nothing to resume yet. */
  command: string | null;
}

/** C0 controls, DEL and C1 controls: a typed line with one of them could act as a key (a line feed is Enter). */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** A word that every POSIX shell, zsh and fish read as itself. */
const PLAIN_WORD = /^[A-Za-z0-9_./+-]+$/;

/** The folder as one shell word: as it is when that is safe, else single-quoted. */
export function shellWord(s: string): string {
  return PLAIN_WORD.test(s) ? s : shellQuote(s);
}

/**
 * `cd <folder> && claude --resume <session id>`, plus `--fork-session` while the chat's Claude Code is open; no
 * command before the chat's first message (the pane then says that the chat gets a session id with it). A worktree
 * chat's folder is its worktree (W11); with `on` (L28) its project's folder follows as `--project-config-root`.
 */
export function resumeCommand(chat: Pick<ShellChat, "cwd" | "sessionId" | "processOpen" | "configRoot">, on: boolean = PROJECT_CONFIG_ROOT_IN_TERMINAL): ResumeCommand {
  const id = chat.sessionId;
  if (!isUuid(id) || !isAbsolute(chat.cwd) || CONTROL.test(chat.cwd)) return { case: "none", command: null };
  const root = chat.configRoot;
  const config = on && typeof root === "string" && root !== chat.cwd && isAbsolute(root) && !CONTROL.test(root) ? ` --project-config-root ${shellWord(root)}` : "";
  const plain = `cd ${shellWord(chat.cwd)} && claude --resume ${id}${config}`;
  return chat.processOpen ? { case: "fork", command: `${plain} --fork-session` } : { case: "plain", command: plain };
}

/**
 * R127, Open in terminal on a refused folder's line: `cd <folder> && claude`, so Claude Code asks its own trust question
 * there (FIX-R127 section 2, the fallback). The folder is the one that the server matched in the tool row's refusal,
 * never one from the page; null when it is not an absolute path or holds a control character.
 */
export function trustCommand(folder: string | null): string | null {
  if (typeof folder !== "string" || !isAbsolute(folder) || CONTROL.test(folder)) return null;
  return `cd ${shellWord(folder)} && claude`;
}

/**
 * R131, Open in terminal for a background session: `claude attach <id>`, so the user answers its prompts in Claude
 * Code's own UI (Ctrl+Z drops back to the shell and the session keeps running). No `cd`: attach finds the session by
 * its id from any folder. Null for anything that is not Claude Code's short id.
 */
export function attachCommand(id: string): string | null {
  return isBgId(id) ? `claude attach ${id}` : null;
}

/** True when `text` is safe to type: no control character at all, so it cannot press Enter or any other key. */
export function isTypeable(text: string): boolean {
  return text.length > 0 && !CONTROL.test(text);
}
