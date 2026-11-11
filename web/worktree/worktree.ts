// Row 73 on the page (DESIGN 9.4 "Worktrees"), the parts without React: the words, the shapes the page reads from
// the server about a project's Worktree option and a chat's worktree, and the reads and writes. A worktree chat runs
// in its own folder: every place that names the chat's folder (the Environment detail, Copy the command) takes the
// worktree's path from here, and the project's folder is the folder it is a worktree of.

// Pure: it imports shared/ only, since the page's types import it (the reads are web/worktree/api.ts).

import { ERROR_MESSAGES, ackReason, type AckError, type ChatWorktree as WireWorktree, type ErrorCode, type WorktreeOff } from "../../shared/protocol";

// ---- the project's option

/**
 * Why the Worktree option is off for a folder (W2): not a git repository, not the top folder of a repository's main
 * checkout (a subfolder, or a linked worktree of the user's), or a repository with no commit (L33), a WorktreeCreate
 * hook in the project's Claude Code settings (L29), a repository config that could run a program (W1: `includeIf`,
 * a filter name that cannot be read, a custom LFS transfer), or (row 100) a `.claude` or `.claude/worktrees` there that
 * is a symbolic link or not a folder, or another git repository. The server's and the page's one list
 * (shared/protocol.ts).
 */
export { WORKTREE_OFF, isWorktreeOff, type WorktreeOff } from "../../shared/protocol";

/** The one line under the option while it is off (kitespan's own words: Desktop's docs give none), as the server's. */
export const WORKTREE_OFF_LINE: Record<WorktreeOff, string> = {
  not_git: "This folder is not a git repository.",
  not_top: "kitespan makes worktrees only from the top folder of a repository's main checkout.",
  no_commit: "This repository has no commit yet.",
  hook: "Your Claude Code settings have a WorktreeCreate hook, which kitespan's worktrees would not run.",
  config: "This repository's git config could run a program, so kitespan makes no worktree here.",
  link: "This repository's .claude or .claude/worktrees is a symbolic link or not a folder, so kitespan makes no worktree here.",
  nested: "This repository's .claude or .claude/worktrees is another git repository, so kitespan makes no worktree here.",
};

/**
 * A refused request's line (F5): the off reason's line when the ack names a known one (a Start whose worktree could not
 * be made: `worktree_failed` with the reason of kitespan's check), else the code's message.
 */
export function refusalLine(error: AckError): string {
  const why = ackReason(error);
  return why ? WORKTREE_OFF_LINE[why] : error.message;
}

/** Desktop's words for the option and the dialog's rows (DESIGN 6.12, row 73). */
export const WORKTREE_WORDS = {
  option: "Worktree",
  folder: "Folder",
  branch: "Branch",
  /** W4's two buttons (L35). */
  again: "Make it again from its branch",
  project: "Continue in the project folder",
  /** W5's buttons. */
  tryAgain: "Try again",
  copy: "Continue in a copy",
  without: "Continue without the worktree",
  /** L34: the folder Claude Code reports at its start, when it is not the chat's own. */
  workingFolder: "Working folder",
  /** W3: the new-chat form's one step line while git makes the chat's worktree (Desktop's docs give no words). */
  making: "Making the worktree...",
} as const;

/** "Worktree of <project folder>" (W6). */
export const worktreeOf = (folder: string) => `Worktree of ${folder}`;

/** A folder's Worktree option as a read answers it: on may be chosen, or why it may not. */
export type WorktreeCan = { ok: true } | { ok: false; why: WorktreeOff };

// ---- a chat's worktree

/**
 * A worktree chat's own folder, as the chat list row gives it (W3, W6): its path, its branch, and Archive's `kept`.
 * `own` false: the linked worktree that a terminal session ran in (Continue here, W12), which kitespan never removes or
 * makes again; absent: kitespan's own worktree (W3).
 */
export interface ChatWorktree extends WireWorktree {
  own?: false;
}

/** A chat row's `worktree`, read with care: a row without one (or with null) is a chat in its project's folder. */
export function worktreeOfRow(row: unknown): ChatWorktree | null {
  const w = (row && typeof row === "object" ? (row as { worktree?: unknown }).worktree : null) as { path?: unknown; branch?: unknown; kept?: unknown; own?: unknown } | null | undefined;
  if (!w || typeof w !== "object" || typeof w.path !== "string" || !w.path.startsWith("/")) return null;
  return { path: w.path, branch: typeof w.branch === "string" && w.branch ? w.branch : null, kept: w.kept === true, ...(w.own === false ? { own: false as const } : {}) };
}

/** kitespan's own worktree (W3), which Archive and Delete may remove and Make it again can add back. */
export function ownWorktree(w: ChatWorktree | null | undefined): w is ChatWorktree {
  return w != null && w.own !== false;
}

/** L27: another chat of the list runs in the same worktree of kitespan's (Continue in a copy), so Delete keeps it. */
export function sharedWorktree(chats: readonly { id: string; worktree?: ChatWorktree | null }[], chat: { id: string; worktree?: ChatWorktree | null }): boolean {
  const path = ownWorktree(chat.worktree) ? chat.worktree.path : null;
  return path !== null && chats.some((c) => c.id !== chat.id && ownWorktree(c.worktree) && c.worktree.path === path);
}

/** The chat's folder: its worktree's, else its project's (null while neither is known). */
export function chatFolder(worktree: ChatWorktree | null | undefined, projectFolder: string | null | undefined): string | null {
  return worktree?.path ?? projectFolder ?? null;
}

/** What Delete's confirm and Archive's dialog read of a worktree chat (W7, W9): never a file's name. */
export interface WorktreeStatus {
  /** How many files have changes (tracked and untracked), or null when the worktree is not there. */
  changes: number | null;
  /** W7 (L25): the worktree holds files that git ignores (other than copies of the project's own), so Archive keeps it. */
  ignored?: boolean;
  /** The branch holds a commit that no other branch has, so Delete keeps it (L26). */
  branchStays: boolean;
  /**
   * The server's word on whether Delete removes the worktree: false for one that another chat shares (L27) or that is
   * not the chat's own (the read's 404). Absent: the server did not say, and the page's own rule decides.
   */
  removes?: boolean;
}

const files = (n: number) => (n === 1 ? "1 file" : `${n} files`);

/** Delete's line for a worktree chat (L26): the worktree it removes, how many files have changes. */
export function deleteWorktreeLine(path: string, status: WorktreeStatus | null): string {
  const n = status?.changes ?? 0;
  return n > 0 ? `This also removes its worktree, ${path}, with changes in ${files(n)}.` : `This also removes its worktree, ${path}.`;
}

/** Delete's line when the read of the worktree's changes failed: never the clean form. */
export const deleteUnreadLine = (path: string) => `This also removes its worktree, ${path}, whose changes could not be read.`;

/** What Delete's confirm says of the chat's worktree, and whether Delete waits for the read (W9, L26, L27, W12). */
export interface DeleteFacts {
  /** The removal line, only when Delete removes the worktree; null: it removes none. */
  line: string | null;
  /** The read of its changes is on its way: the line makes no claim about them yet, and Delete waits for it. */
  reading: boolean;
  /** The line that says the branch stays, only when it does. */
  branch: string | null;
}

/**
 * Delete's confirm for a chat: no line for a chat in its project's folder, for a terminal session's linked worktree
 * (W12) or for a worktree that another chat shares (L27), since Delete removes none of them; else the removal line
 * with how many files have changes, "..." while that is read, and a line that says so when the read failed.
 */
export function deleteFacts(wt: ChatWorktree | null | undefined, status: WorktreeStatus | null | undefined, shared: boolean): DeleteFacts {
  const none: DeleteFacts = { line: null, reading: false, branch: null };
  if (!ownWorktree(wt) || shared) return none;
  if (status === undefined) return { line: deleteWorktreeLine(wt.path, null), reading: true, branch: null };
  if (status === null) return { line: deleteUnreadLine(wt.path), reading: false, branch: null };
  if (status.removes === false) return none;
  return { line: deleteWorktreeLine(wt.path, status), reading: false, branch: status.branchStays ? branchStaysLine(wt.branch) : null };
}

/** Delete's line when the branch stays (L26): it holds commits that no other branch has. */
export function branchStaysLine(branch: string | null): string {
  return branch ? `Its branch ${branch} stays: it holds commits that no other branch has.` : "Its branch stays: it holds commits that no other branch has.";
}

/** Archive's one line for a worktree that stays on disk (L25): it has changes, or files that git ignores. */
export function archiveKeepsLine(status: WorktreeStatus | null): string | null {
  const n = status?.changes ?? 0;
  if (n > 0) return `Its worktree has changes in ${files(n)}, so it stays on disk.`;
  return status?.changes === 0 && status.ignored === true ? "Its worktree has files that git ignores, so it stays on disk." : null;
}

/** Row 100: `path` is inside the project's folder `folder` (its `.claude/worktrees`), not in kitespan's data folder. */
export function inFolder(path: string, folder: string | null | undefined): boolean {
  const top = (folder ?? "").replace(/\/+$/, "");
  return top !== "" && path.startsWith(`${top}/`);
}

/**
 * Row 99: an environment's Remove confirm, one line per worktree of kitespan's own in it. Remove follows Archive's rule
 * (L25): one with changes or with files that git ignores stays, a clean one goes (its branch stays), and one that a
 * copy shares (`shared`, L27) always stays. Each one that stays gets a line. A clean one gets Delete's line only when
 * it is `inside` the project's folder (row 100: `.claude/worktrees`), since Remove then changes that folder; one in
 * kitespan's data folder gets none. While the read of its changes runs, the line makes no claim about them ("..."
 * after it, and Remove waits); a read that failed says so. Null: no line (it goes from the data folder, it is not
 * there, or it is not the chat's own). `touchesFolder`: Remove may remove it from the project's folder (so the first
 * line does not say that the folder is not changed).
 */
export function removeTreeLine(
  path: string,
  status: WorktreeStatus | null | undefined,
  shared: boolean,
  inside: boolean,
): { line: string | null; reading: boolean; touchesFolder: boolean } {
  const at = `Its worktree at ${path}`;
  const stays = (line: string | null) => ({ line, reading: false, touchesFolder: false });
  if (status && (status.removes === false || status.changes === null)) return stays(null);
  if (status && status.changes! > 0) return stays(`${at} has changes in ${files(status.changes!)}, so it stays on disk.`);
  if (status?.ignored === true) return stays(`${at} has files that git ignores, so it stays on disk.`);
  if (shared) return stays(`${at} stays on disk.`);
  if (status === undefined) return { line: `${at} stays on disk if it has changes.`, reading: true, touchesFolder: inside };
  if (status === null) return { line: `${at} stays on disk if it has changes, which could not be read.`, reading: false, touchesFolder: inside };
  return { line: inside ? deleteWorktreeLine(path, null) : null, reading: false, touchesFolder: inside };
}

/** The archived chat's line while archive kept its worktree (L25): it may hold only ignored files, so no "changes". */
export function keptLine(path: string): string {
  return `Its worktree stays at ${path}.`;
}

// ---- the lines of a refused start (W4, W5)

/** The start codes whose line has buttons under it. */
export const START_CODES = ["worktree_gone", "cwd_unavailable", "worktree_unverified", "worktree_resume_refused"] as const satisfies readonly ErrorCode[];
export type StartCode = (typeof START_CODES)[number];

export function isStartCode(c: unknown): c is StartCode {
  return typeof c === "string" && (START_CODES as readonly string[]).includes(c);
}

/** One button under a refused start's line. */
export type StartAction = "again" | "project" | "tryAgain" | "copy" | "without";

/**
 * The buttons of a refused start's line (W4, W5): kitespan's own gone worktree (`worktree_gone`; the server sends it
 * for Claude Code's cwd_unavailable in such a chat too) can be made again from its branch, or the chat continues in the
 * project's folder; a terminal session's linked worktree that is gone (`cwd_unavailable` in a worktree chat, W12) can
 * only continue in the project's folder, since kitespan never makes another app's worktree; worktree_unverified has Try
 * again (the binding is kept); worktree_resume_refused has Continue in a copy, and Continue without the worktree only as
 * an explicit choice. Nothing retries by itself.
 */
export function startActions(code: StartCode, worktree: ChatWorktree | null | undefined): StartAction[] {
  switch (code) {
    case "worktree_gone":
      return worktree && !ownWorktree(worktree) ? ["project"] : ["again", "project"];
    case "cwd_unavailable":
      return worktree ? ["project"] : [];
    case "worktree_unverified":
      return ["tryAgain"];
    case "worktree_resume_refused":
      return ["copy", "without"];
  }
}

/** The line itself: kitespan's fixed sentence for the code (DESIGN 4.4), whatever words the refusal came with. */
export function startLine(code: StartCode): string {
  return ERROR_MESSAGES[code];
}

/**
 * The line under it: Claude Code's own first error line, for worktree_resume_refused only (DESIGN 4.4: the sentence
 * "with Claude Code's first error line"), when it has one that is not the sentence itself.
 */
export function startDetail(code: StartCode, text: string | null | undefined): string | undefined {
  const line = (text ?? "").trim();
  return code === "worktree_resume_refused" && line && line !== ERROR_MESSAGES[code] ? line : undefined;
}
