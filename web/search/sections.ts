// The search pane's model (DESIGN.md 9.3 and 6.7 "The search pane"), with no React and no DOM: which rows show for a
// query, in which groups, the keys of the pane's field, what Enter picks, where a pick goes and where Esc closes to.
//
// Three groups, in this order: Chats (by title; the archived chats are left out, as the lists leave them out), Files
// (the chat folder's files, from the corpus, then the chat's uploads) and Commands (the chat's `/` commands). A query
// that starts with `/` asks for a command, so Commands go first then. Every kind is ranked by the one matcher
// (shared/match.ts); an upload by its name only, because its path is the host's upload folder, whose folder names
// would match many queries. The groups share one budget of 120 rows: each group first gets up to a floor of its own,
// so many files cannot push the chats and the commands out of view, and then the rows that are left go to the groups
// in their order; inside Files the uploads keep their rows when the folder's files would fill the group. Each group's
// count is its true total. A group with no rows is not there at all.
//
// `scope` (the URL's `scope`, 5.2) keeps one group: `chats`, `files` or `commands`. The scope control shows the groups
// that this chat has rows of at all, and only when there are two; none on is every group.
//
// U5 (DESIGN-U5 7 and 8): a fourth group, Messages, the server's matches in the text of the chats' messages
// (web/search/messages.ts asks for them after a pause). It is drawn last, after Commands, so its rows, which come
// later, never move a row that shows; it has its own 20 rows outside the 120; while it is asked (the query passes the
// minimum and the scope keeps it), Files keeps at most its floor, a rule of the query alone, so nothing above moves when
// its rows land. The Chats scope keeps it (both find a chat; no fourth segment). A chat's rows stay together: the first
// carries the chat's title and time (from the page's list, archived chats included), the others their line only; a
// hit of a chat that the page does not hold is dropped. The list's true count stays the other groups' (data-count).

import { TOP_ROWS, parseQuery, rankList, type NameRange, type Query } from "../../shared/match";
import type { MessageHit } from "./messages";
import type { SEARCH_SCOPES } from "../../shared/route";
import type { Chat, Upload } from "../state/types";
import type { MenuRow } from "../composer/draft";
import type { FileRow, FileRows } from "./engine";
import { imeKey } from "../composer/composition";

export type SearchScope = (typeof SEARCH_SCOPES)[number];
/** A group of rows (6.7's three, and U5's Messages): the uploads are rows of Files. */
export type SectionKind = "chats" | "files" | "commands" | "messages";

/** The groups in the order they show: Messages last (U5), since its rows come after the pause. */
export const SECTION_ORDER: readonly SectionKind[] = ["chats", "files", "commands", "messages"];
/** The order for a query that starts with `/`: it asks for a command. Messages stays last. */
const COMMANDS_FIRST: readonly SectionKind[] = ["commands", "chats", "files", "messages"];
export const SECTION_TITLE: Record<SectionKind, string> = { chats: "Chats", files: "Files", commands: "Commands", messages: "Messages" };
/** The rows each group keeps inside the 120 before the rest are shared out (3 groups: 60 of the 120). */
export const SECTION_FLOOR = 20;
/** U5: the Messages group's own rows, outside the 120 (the server sends at most 20). */
export const MESSAGE_ROWS = 20;
/** The groups each scope keeps: the Chats scope keeps Messages too (U5). */
export const SCOPE_KINDS: Record<SearchScope, readonly SectionKind[]> = { chats: ["chats", "messages"], files: ["files"], commands: ["commands"] };
export const SCOPE_LABEL: Record<SearchScope, string> = { chats: "Chats", files: "Files", commands: "Commands" };

export interface ChatHit {
  kind: "chats";
  key: string;
  chat: Chat;
  ranges: NameRange[];
}
export interface FileHit {
  kind: "files";
  key: string;
  path: string;
  /** Where the name starts in `path`; the ranges index the name. */
  nameStart: number;
  ranges: NameRange[];
}
export interface UploadHit {
  kind: "uploads";
  key: string;
  upload: Upload;
  /** The upload's path as it shows (its folder dimmed before the name), and where the name starts in it. */
  path: string;
  nameStart: number;
  ranges: NameRange[];
}
export interface CommandHit {
  kind: "commands";
  key: string;
  command: MenuRow;
  ranges: NameRange[];
}
/** U5: a message of a chat that matches, with its line around the match (the server's snippet and marked runs). */
export interface MessageRowHit {
  kind: "messages";
  key: string;
  chat: Chat;
  /** The page's row id of the message, for /c/<chat>/m/<message>. */
  message: string;
  /** The user's own message or Claude's reply (the row puts "You: " before the user's line). */
  by: MessageHit["by"];
  snippet: string;
  ranges: NameRange[];
  /** The chat's first row: it carries the chat's title and time; a later row of the same chat is its line alone. */
  first: boolean;
}
export type SearchHit = ChatHit | FileHit | UploadHit | CommandHit | MessageRowHit;

export interface Section {
  kind: SectionKind;
  /** The true number of matches of this kind. */
  count: number;
  /** The rows drawn, best first. */
  rows: SearchHit[];
}

export interface SearchInput {
  q: string;
  scope: SearchScope | null;
  /**
   * The chats the lists show (no archived chat), in any order: they are taken newest first, sorted once per list (a
   * list that is the same array as before is not sorted again).
   */
  chats: readonly Chat[];
  /**
   * The folder's files for `q` (the engine's answer), or null: before the corpus came, with no chat, or in a scope
   * with no files.
   */
  files: FileRows | null;
  /**
   * The files answer the field's newer query than `q` (the server answered the field's value before the deferred
   * render caught up): the other rows still answer `q`, so the list's query is `q`.
   */
  filesAhead?: boolean;
  uploads: readonly Upload[];
  /** The chat's `/` commands, or null when there are none to offer here. */
  commands: readonly MenuRow[] | null;
  /**
   * U5: the Messages answer that the page has (its query and its hits in the server's rank order), or null. Drawn only
   * when its query is `q` and the scope keeps Messages.
   */
  messages?: { q: string; hits: readonly MessageHit[] } | null;
  /** U5: every chat the page holds, archived included: the Messages rows take the chat from here. */
  allChats?: readonly Chat[];
  /** U5: Messages is asked for `q` (it passes the minimum, and the scope keeps it): Files keeps at most its floor. */
  messagesAsked?: boolean;
}

export interface SearchResult {
  /** The query every row answers (the list's `data-q`): the field's deferred value, or the server's older one. */
  q: string;
  /**
   * The true number of matches over the groups the scope keeps (the list's `data-count`), the Messages group left out:
   * its rows come later, and it has its own count.
   */
  count: number;
  sections: Section[];
  /** The number of rows drawn (at most 120, and the Messages group's own 20). */
  rows: number;
}

/**
 * How many rows each group draws inside one budget: first up to `floor` each, then what is left in the groups' order.
 * `avail` is what each group could draw; the sum never passes `total`.
 */
export function allot(avail: readonly number[], total: number = TOP_ROWS, floor: number = SECTION_FLOOR): number[] {
  const give = avail.map((a) => Math.max(0, Math.min(a, floor)));
  let left = total - give.reduce((s, n) => s + n, 0);
  if (left < 0) {
    // More groups than the floors fit: the first groups keep theirs.
    let room = total;
    return give.map((g) => {
      const n = Math.min(g, room);
      room -= n;
      return n;
    });
  }
  for (let i = 0; i < give.length && left > 0; i++) {
    const more = Math.min(Math.max(0, avail[i]! - give[i]!), left);
    give[i]! += more;
    left -= more;
  }
  return give;
}

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

// Kept between keys: the chats sorted newest first, per list, and the file hits, per engine answer, so a row whose
// file answer did not change gets the same hit object and is not drawn again (SearchPane's Row is memoized).
const sortedChats = new WeakMap<readonly Chat[], readonly Chat[]>();
const fileHits = new WeakMap<FileRows, FileHit[]>();

function newestFirst(chats: readonly Chat[]): readonly Chat[] {
  let sorted = sortedChats.get(chats);
  if (!sorted) {
    const at = new Map(chats.map((c) => [c, Date.parse(c.updatedAt)]));
    sorted = [...chats].sort((a, b) => at.get(b)! - at.get(a)!);
    sortedChats.set(chats, sorted);
  }
  return sorted;
}

function hitsOfFiles(files: FileRows): FileHit[] {
  let hits = fileHits.get(files);
  if (!hits) {
    hits = files.rows.map((r: FileRow) => ({ kind: "files", key: `f:${r.path}`, path: r.path, nameStart: r.nameStart, ranges: r.nameRanges }));
    fileHits.set(files, hits);
  }
  return hits;
}

/** A query for the commands: a `/` typed before a command name is not part of the name. */
function commandQuery(q: Query): Query {
  if (!q.terms.some((t) => t.startsWith("/"))) return q;
  return parseQuery(q.terms.map((t) => t.replace(/^\/+/, "")).join(" "));
}

/** The groups a scope keeps (every group with no scope). */
export function kindsOf(scope: SearchScope | null): readonly SectionKind[] {
  return scope ? SCOPE_KINDS[scope] : SECTION_ORDER;
}

/**
 * The rows a group of `n` draws from the folder's files and then the chat's uploads: the uploads (a chat has few)
 * keep up to half of the group when the files would fill it, so they never drop out under many matching files.
 */
export function filesThenUploads<F, U>(files: readonly F[], uploads: readonly U[], n: number): (F | U)[] {
  const k = Math.min(uploads.length, Math.max(n - files.length, Math.ceil(n / 2)));
  return [...files.slice(0, Math.max(0, n - k)), ...uploads.slice(0, k)];
}

/**
 * U5: the Messages rows for an answer, in the server's rank order with each chat's rows together (a chat's first row
 * where its best one was), at most MESSAGE_ROWS; a hit of a chat the page does not hold is dropped.
 */
export function messageRows(hits: readonly MessageHit[], chats: readonly Chat[]): MessageRowHit[] {
  const byId = new Map(chats.map((c) => [c.id, c]));
  const order: string[] = [];
  const per = new Map<string, MessageHit[]>();
  for (const h of hits) {
    if (!byId.has(h.chat)) continue;
    let list = per.get(h.chat);
    if (!list) {
      list = [];
      per.set(h.chat, list);
      order.push(h.chat);
    }
    list.push(h);
  }
  const out: MessageRowHit[] = [];
  for (const id of order)
    per.get(id)!.forEach((h, i) => out.push({ kind: "messages", key: `m:${id}:${h.message}`, chat: byId.get(id)!, message: h.message, by: h.by, snippet: h.snippet, ranges: h.ranges, first: i === 0 }));
  return out.slice(0, MESSAGE_ROWS);
}

/** The rows for one query: the groups the scope keeps, each ranked, inside the budget of 120 (and Messages' own 20). */
export function searchSections(input: SearchInput): SearchResult {
  const query = parseQuery(input.q);
  const kinds = new Set(kindsOf(input.scope));
  const chats = kinds.has("chats") ? rankList(newestFirst(input.chats), query, (c) => ({ name: c.title })) : null;
  // An upload by its name only: its path is the host's upload folder (state folder, kitespan, uploads, a random id).
  const uploads = kinds.has("files") ? rankList(input.uploads.filter((u) => u.state === "done"), query, (u) => ({ name: u.path ? nameOf(u.path) : u.name })) : null;
  const commands = kinds.has("commands") && input.commands ? rankList(input.commands, commandQuery(query), (c) => ({ name: c.name, alts: c.aliases ?? [] })) : null;
  const files = kinds.has("files") ? input.files : null;

  const lists: { kind: SectionKind; count: number; hits: SearchHit[]; uploads?: SearchHit[] }[] = [];
  if (chats?.count) lists.push({ kind: "chats", count: chats.count, hits: chats.rows.map((r) => ({ kind: "chats", key: `c:${r.item.id}`, chat: r.item, ranges: r.nameRanges })) });
  const fileRows = files?.count && files.rows.length ? hitsOfFiles(files) : [];
  const uploadRows: SearchHit[] = (uploads?.rows ?? []).map((r) => {
    const path = r.item.path || r.item.name;
    return { kind: "uploads", key: `u:${r.item.id}`, upload: r.item, path, nameStart: path.length - nameOf(path).length, ranges: r.nameRanges };
  });
  if (fileRows.length || uploadRows.length) lists.push({ kind: "files", count: (fileRows.length ? files!.count : 0) + (uploads?.count ?? 0), hits: fileRows, uploads: uploadRows });
  if (commands?.count) lists.push({ kind: "commands", count: commands.count, hits: commands.rows.map((r) => ({ kind: "commands", key: `k:${r.item.name}`, command: r.item, ranges: r.nameRanges })) });
  const order = input.q.trimStart().startsWith("/") ? COMMANDS_FIRST : SECTION_ORDER;
  lists.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));

  // U5: while Messages is asked, Files keeps at most its floor, so the last group stays in reach (a rule of the query
  // alone: nothing above moves when its rows land).
  const filesCap = input.messagesAsked && kinds.has("messages") ? SECTION_FLOOR : Number.POSITIVE_INFINITY;
  const give = allot(lists.map((l) => Math.min(l.hits.length + (l.uploads?.length ?? 0), l.kind === "files" ? filesCap : Number.POSITIVE_INFINITY)));
  const sections = lists
    .map((l, i) => ({ kind: l.kind, count: l.count, rows: l.uploads ? filesThenUploads(l.hits, l.uploads, give[i]!) : l.hits.slice(0, give[i]) }))
    .filter((s) => s.rows.length > 0);
  const count = sections.reduce((n, s) => n + s.count, 0);
  const m = input.messages;
  const mine = kinds.has("messages") && m && m.q === input.q ? messageRows(m.hits, input.allChats ?? input.chats) : [];
  if (mine.length) sections.push({ kind: "messages", count: mine.length, rows: mine });
  // The query the whole list answers: the files' when the server's answer lags the field, else `q`.
  const shown = files && files.q !== input.q && !input.filesAhead ? files.q : input.q;
  return { q: shown, count, sections, rows: sections.reduce((n, s) => n + s.rows.length, 0) };
}

/** Every drawn row in order, across the groups (the active row's index runs over this). */
export function flatRows(result: SearchResult): SearchHit[] {
  return result.sections.flatMap((s) => s.rows);
}

/** The groups that this chat has rows of at all (not only for this query): the scope control's segments. */
export function scopesHere(has: { chats: boolean; files: boolean; commands: boolean }): SearchScope[] {
  const out: SearchScope[] = [];
  if (has.chats) out.push("chats");
  if (has.files) out.push("files");
  if (has.commands) out.push("commands");
  return out.length > 1 ? out : [];
}

// ---------------------------------------------------------------------------------------------------------------
// The highlight

export interface Piece {
  text: string;
  /** A matched run, drawn in bold (in the row's own colour, as the `@` picker draws it). */
  hit: boolean;
}

/** `text` cut into plain and matched pieces by ascending ranges into it (a bad range is clamped, never thrown). */
export function pieces(text: string, ranges: readonly NameRange[]): Piece[] {
  const out: Piece[] = [];
  let at = 0;
  for (const [s0, e0] of ranges) {
    const s = Math.max(at, Math.min(text.length, s0));
    const e = Math.max(s, Math.min(text.length, e0));
    if (e === s) continue;
    if (s > at) out.push({ text: text.slice(at, s), hit: false });
    out.push({ text: text.slice(s, e), hit: true });
    at = e;
  }
  if (at < text.length || out.length === 0) out.push({ text: text.slice(at), hit: false });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The keys of the pane's field

export type PaneKey = "down" | "up" | "pick" | "close";

/**
 * What a key in the pane's field asks for. While an input method composes, the arrows, Enter and Esc are the input
 * method's (composer/composition.ts imeKey: with a fine pointer the key's own marks, the IME guard of the `@` picker,
 * DESIGN.md 6.4; on touch while the field shows marked text, or ended it under 100 ms ago). Otherwise on touch Enter
 * picks at once (iOS dictation sends no composition events). Enter with a modifier and Shift+Enter do nothing here.
 */
export function paneKey(e: { key: string; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; isComposing?: boolean; keyCode?: number }, coarse: boolean): PaneKey | null {
  if (imeKey(e, coarse)) return null;
  const mods = !!(e.altKey || e.ctrlKey || e.metaKey);
  if (e.key === "ArrowDown" && !mods && !e.shiftKey) return "down";
  if (e.key === "ArrowUp" && !mods && !e.shiftKey) return "up";
  if (e.key === "Enter" && !mods && !e.shiftKey) return "pick";
  if (e.key === "Escape") return "close";
  return null;
}

/** The active row after a move: round the ends; with no rows, none. */
export function moveActive(active: number, rows: number, dir: 1 | -1): number {
  if (rows <= 0) return 0;
  const at = Math.min(Math.max(0, active), rows - 1);
  return (at + dir + rows) % rows;
}

/** The active row kept inside a list that may have shrunk. */
export function clampActive(active: number, rows: number): number {
  return rows <= 0 ? 0 : Math.min(Math.max(0, active), rows - 1);
}

/** Where the arrows left the active row, and under which query. */
export interface Selection {
  q: string;
  i: number;
}

/** The active row for the list of query `q`: where the arrows left it under that query, else the first (a new query). */
export function activeFor(sel: Selection, q: string, rows: number): number {
  return sel.q === q ? clampActive(sel.i, rows) : 0;
}

/**
 * What Enter picks: the active row, once the list answers the field's query (`listQ` equals `fieldQ`) and the file
 * list has come (`settled`); before that, "wait": the pane picks when that list lands, so a fast Enter never opens a
 * row of an older query (on the server's path the files can answer an older query for a moment). Null with no row.
 */
export function enterPick(rows: readonly SearchHit[], active: number, listQ: string, fieldQ: string, settled: boolean): SearchHit | "wait" | null {
  if (!settled || listQ !== fieldQ) return "wait";
  return rows[active] ?? null;
}
