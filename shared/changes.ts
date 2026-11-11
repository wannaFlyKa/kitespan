// U1 (DESIGN-U1 5, 8 and 9): what a turn changed in the chat's folder, as the server sends it. The server works it out
// from two git marks of the folder (the turn's start and its end) or, when it has no marks, from Claude's own file
// edits; the page draws the card under the turn's answer from the `changes` event (live and from history), and the
// side panel's changes view from the two reads below. Paths and counts reach every page; a diff's text reaches a page
// only when it opens that diff.

import { isChangesId } from "./ids";
import { CONTROL_CHARS, isSafeRelativePath } from "./protocol";

export const CHANGES_LIMITS = {
  /** The files one summary lists, in path order; the totals count the rest too. */
  files: 1_000,
  /** The files the `changes` event (the card) carries. */
  eventFiles: 5,
  /** A file's path relative to the chat's folder (isSafeRelativePath's own cap). */
  path: 1_024,
  /** An untracked file over this many bytes is left out of the marks and shows Too large. */
  largeFileBytes: 8 * 1024 * 1024,
  /** A side over this many bytes is too large to compare. */
  sideBytes: 1024 * 1024,
  /** A patch whose text is over this many bytes is too large to compare. */
  patchBytes: 2 * 1024 * 1024,
  /** The lines of one file's diff that are kept; the rest are counted (`cut`). */
  lines: 3_000,
  /** The characters of one diff line that are kept (a longer one ends with an ellipsis). */
  lineChars: 2_000,
  /** The summaries a chat keeps, and their JSON in bytes; the oldest go first. */
  turns: 1_000,
  turnsBytes: 4 * 1024 * 1024,
  /** The file tools' own hunks that a turn without marks keeps, in bytes of JSON. */
  editsBytes: 256 * 1024,
  /** A chat's changes folder over this many bytes takes no more marks. */
  chatBytes: 256 * 1024 * 1024,
  /**
   * A folder with more untracked files than this (not ignored, the large ones too), or more bytes of them, takes
   * no mark: a mark would hash them all, each turn, into the chat's folder.
   */
  markFiles: 20_000,
  markBytes: 64 * 1024 * 1024,
  /** The start mark's deadline (the message waits at most this long), the end mark's with its summary, a diff's read. */
  startMs: 3_000,
  endMs: 10_000,
  diffMs: 5_000,
  /** The slack on each side of a tool's run window (the kernel's file times run a few ms behind the server's clock). */
  slackMs: 50,
} as const;

/** A file's change: modified, added, deleted or renamed (a rename may change lines too). */
export const CHANGE_STATUSES = ["M", "A", "D", "R"] as const;
export type ChangeStatus = (typeof CHANGE_STATUSES)[number];

/** `git`: from the two marks; `edits`: from Claude's own file edits only (no marks). */
export const CHANGES_HOW = ["git", "edits"] as const;
export type ChangesHow = (typeof CHANGES_HOW)[number];

/**
 * Why a summary is `edits`: the folder is not a git repository, git is not installed, the repository's config could
 * run a program, the start mark is missing (late, or the turn started without one), a mark failed, or the folder has
 * too many untracked files to mark (CHANGES_LIMITS.markFiles, markBytes).
 */
export const CHANGES_WHY = ["not_git", "no_git", "refused", "no_start", "failed", "big", "full"] as const;
export type ChangesWhy = (typeof CHANGES_WHY)[number];

/** The fallback's reason, under the changes view's head (DESIGN-U1 4.4 and 11), after "Claude's own edits only.". */
export const CHANGES_WHY_LINES: Readonly<Record<ChangesWhy, string>> = {
  not_git: "This folder is not a git repository.",
  no_git: "git is not installed.",
  refused: "This repository's git config could run a program, so kitespan does not read it.",
  no_start: "git could not read this folder when the turn started.",
  failed: "git could not read this turn's changes.",
  big: "This folder has too many untracked files for kitespan to mark.",
  full: "This chat's saved changes reached kitespan's 256 MiB limit.",
};

/** One changed file of a turn. A binary or large file, and a notebook that Claude edited, have no counts (0 and 0). */
export interface ChangedFile {
  /** Relative to the chat's folder (isSafeRelativePath). */
  path: string;
  status: ChangeStatus;
  added: number;
  removed: number;
  /** A rename's old path. */
  from?: string;
  binary?: true;
  /** An untracked file over 8 MiB: left out of the marks, no counts. */
  large?: true;
  /** `edits` only: a NotebookEdit, whose diff is not shown. */
  notebook?: true;
}

/**
 * The card: what the `changes` event carries, live and from history. `at`: the page's row ids of the turn's first rows
 * (a user message's uuid, a reply block's itemIdOf, a tool call's id), as the notes keep them, so a page puts the card in
 * that turn wherever the event arrives. `total`, `added` and `removed` count every changed file, also those past the
 * event's five and the summary's 1,000.
 */
export interface ChangesCard {
  id: string;
  at: string[];
  how: ChangesHow;
  total: number;
  added: number;
  removed: number;
  /** At most CHANGES_LIMITS.eventFiles, in path order. */
  files: ChangedFile[];
}

/** The whole summary (GET /api/chats/:chat/changes/:turn): every file up to 1,000, the reason, and the left-out count. */
export interface ChangesSummary extends ChangesCard {
  /** `edits` only. */
  why?: ChangesWhy;
  /** Changes that the marks saw and that are not the turn's (the user's own, between Claude's tools). */
  others: number;
  /** Changes that the marks saw and that are another chat's in the same folder (its file tools', its commands'). */
  elsewhere?: number;
}

/** One hunk of a unified diff, three lines of context. Each line has its sign first: " ", "+", "-" or "\" (no newline). */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The function line git prints after `@@` ("" when none). */
  context: string;
  lines: string[];
}

/** A file tool's own hunk, as the SDK's `structuredPatch` has it (no function line). */
export type EditHunk = Omit<DiffHunk, "context">;

/** One file's diff (DESIGN-U1 9). */
export interface FileDiff {
  path: string;
  status: ChangeStatus;
  from?: string;
  added: number;
  removed: number;
  binary?: true;
  /** A side over 1 MiB, a patch over 2 MiB, or an untracked file over 8 MiB: its larger size in bytes. */
  large?: { bytes: number };
  notebook?: true;
  hunks: DiffHunk[];
  /** Past 3,000 lines: how many are shown and how many more there are. */
  cut?: { shown: number; more: number };
  /** Claude's own edits' hunks (no marks), in the order of the edits. */
  edits?: true;
}

/**
 * The two reads (both GET, both by the chat's id and the summary's id, never a host path; an archived chat's too):
 *
 * - `GET /api/chats/:chat/changes/:turn` (changesApiPath): 200 with the ChangesSummary.
 * - `GET /api/chats/:chat/changes/:turn/files/<path>` (changeFileApiPath): 200 with the FileDiff.
 *
 * When there is nothing to show, the answer is an API error whose body also names the case (`state`, ChangesMissing):
 * `no_turn` (404), no summary of that id is kept for the chat, or no such chat ("These changes are no longer kept.");
 * `no_file` (404), that path is not in the turn's changes ("That file is not in this turn's changes."); `gone` (410),
 * the marks' objects are no longer there, the repository moved or its objects were pruned ("This diff is no longer
 * available."). A failure or a deadline is a 500 (`failed`): "This diff could not be read.", with Try again. Every
 * answer has `Cache-Control: no-store`.
 */
export const CHANGES_MISSING = { no_turn: 404, no_file: 404, gone: 410 } as const;
export type ChangesMissingState = keyof typeof CHANGES_MISSING;
export interface ChangesMissing {
  error: { code: "not_found" | "gone"; message: string };
  state: ChangesMissingState;
}

/** The summary read's path. */
export function changesApiPath(chat: string, turn: string): string {
  return `/api/chats/${encodeURIComponent(chat)}/changes/${encodeURIComponent(turn)}`;
}

/** The file read's path: the file's path segment by segment. */
export function changeFileApiPath(chat: string, turn: string, path: string): string {
  return `${changesApiPath(chat, turn)}/files/${path.split("/").map(encodeURIComponent).join("/")}`;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
const ROW_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** One file as the server sends it, or null when it is not one (a bad path, a bad status, a bad count). */
export function changedFileOf(v: unknown): ChangedFile | null {
  if (!isObj(v)) return null;
  const { path, status, added, removed, from } = v;
  if (typeof path !== "string" || !isSafeRelativePath(path) || path.includes("\uFFFD")) return null;
  if (typeof status !== "string" || !(CHANGE_STATUSES as readonly string[]).includes(status)) return null;
  if (!count(added) || !count(removed)) return null;
  if (from !== undefined && (typeof from !== "string" || !isSafeRelativePath(from) || status !== "R")) return null;
  return {
    path,
    status: status as ChangeStatus,
    added,
    removed,
    ...(from !== undefined ? { from } : {}),
    ...(v.binary === true ? { binary: true as const } : {}),
    ...(v.large === true ? { large: true as const } : {}),
    ...(v.notebook === true ? { notebook: true as const } : {}),
  };
}

/**
 * The card of a `changes` event, checked (the page's read of it): its id, at least one row id of the right shape, the
 * counts, and at most five files (a bad file drops the card). Null for anything else.
 */
export function changesCardOf(v: unknown): ChangesCard | null {
  if (!isObj(v)) return null;
  const { id, at, how, total, added, removed, files } = v;
  if (!isChangesId(id) || typeof how !== "string" || !(CHANGES_HOW as readonly string[]).includes(how)) return null;
  if (!Array.isArray(at) || at.length === 0 || at.length > 2 || !at.every((x) => typeof x === "string" && ROW_ID.test(x) && !CONTROL_CHARS.test(x))) return null;
  if (!count(total) || !count(added) || !count(removed) || !Array.isArray(files) || files.length > CHANGES_LIMITS.eventFiles) return null;
  const rows = files.map(changedFileOf);
  if (rows.some((r) => r === null) || rows.length > total) return null;
  return { id, at: [...(at as string[])], how: how as ChangesHow, total, added, removed, files: rows as ChangedFile[] };
}
