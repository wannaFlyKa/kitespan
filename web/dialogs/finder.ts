// New environment's folder finder (D54), the parts without React: what the filter field's text means, which rows show,
// the breadcrumb, the keys, and the folder that Use this folder takes. The two reads are GETs (GET /api/folders and
// /api/folders/suggested, server/http/api-types.ts): they change nothing on the host, so they are never recorded.
//
// The field: plain text narrows the rows by name (the names that start with it first). A path, `/...`, `~` or `~/...`,
// browses there as it is typed, as a shell completes one: the folder up to the last `/` is listed and the rest narrows
// it, so `~/code/we` lists ~/code with website first. A last part that starts with "." brings the dot folders.
// Suggested shows only at the start (the home folder, nothing typed but a filter): inside a folder the rows are that
// folder's. It leaves out the folders that kitespan's projects have (the form's folder picker lists those). Without a
// filter it shows its first SUGGESTED_SHOWN rows; the filter reaches the rest. A folder with more folders than one
// listing holds (`truncated`) is read again with the filter (`q`), so a folder past the cap is found by its name.
// The rows: a tap goes in. A folder that Use this folder could never take (see usable) shows no row. The keys (in the
// field): the arrows move the highlight, Enter opens the highlighted folder (or the typed path), Cmd or Ctrl+Enter
// uses it. While a filter is typed, its first row is highlighted.
// Use this folder takes the highlighted row, else the typed path, else, with nothing typed, the folder that Browse
// shows; a filter that matches no row leaves it off, as the top of the disk does.

import type { FolderEntry, FoldersReply, SuggestedFolder, SuggestedFoldersReply } from "../../server/http/api-types";
import { CONTROL_CHARS } from "../../shared/protocol";
import { ApiError, apiGet } from "../net/api";
import { cleanFolder } from "../state/store";

/** Suggested rows shown while no filter is typed (the session folders come first, newest first). */
export const SUGGESTED_SHOWN = 8;

/** The line for a listing that failed on the page's side (no answer from the server). */
export const FOLDERS_FAILED = "That folder could not be read.";

/** A path typed in the filter field: the folder to list (`dir`, up to its last `/`), the rest (`leaf`), the whole. */
export interface TypedPath {
  dir: string;
  leaf: string;
  full: string;
}

/** The field's text as a path, or null when it is a plain filter. */
export function typedPath(text: string): TypedPath | null {
  const t = text.trim();
  if (t === "~") return { dir: "~", leaf: "", full: "~" };
  if (!t.startsWith("/") && !t.startsWith("~/")) return null;
  const cut = t.lastIndexOf("/") + 1;
  return { dir: t.slice(0, cut), leaf: t.slice(cut), full: t };
}

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** The rows whose name holds the filter (case and accents ignored): those that start with it first, else in order. */
export function narrow<T extends { name: string }>(rows: readonly T[], filter: string): T[] {
  const f = fold(filter);
  if (!f) return [...rows];
  const first: T[] = [];
  const then: T[] = [];
  for (const r of rows) {
    const n = fold(r.name);
    if (n.startsWith(f)) first.push(r);
    else if (n.includes(f)) then.push(r);
  }
  return [...first, ...then];
}

/** The folder that holds a path ("/" for a folder at the top). */
export function parentOf(path: string): string {
  const cut = path.replace(/\/+$/, "").lastIndexOf("/");
  return cut > 0 ? path.slice(0, cut) : "/";
}

/** A path under the home folder from it (`~`, `~/...`); any other path as it is. */
export function tilde(path: string, home: string | null): string {
  if (!home || home === "/") return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** A folder the finder asks for (`~`, `~/...` or absolute) as an absolute path without a trailing `/`; null while
 *  the home folder is not known yet. */
export function expand(path: string, home: string | null): string | null {
  if (path === "~" || path === "~/") return home;
  if (path.startsWith("~/")) return home ? `${home}/${path.slice(2)}`.replace(/\/+$/, "") : null;
  return path.replace(/\/+$/, "") || "/";
}

/**
 * The breadcrumb of a folder, from `/`; a folder under the home folder goes through `~` in place of the home folder's
 * own parts (`/ > ~ > code`), so the way up to `/` is one tap from anywhere.
 */
export function crumbs(path: string, home: string | null): { label: string; path: string }[] {
  const fromHome = Boolean(home && home !== "/" && (path === home || path.startsWith(`${home}/`)));
  const out = [{ label: "/", path: "/" }];
  if (fromHome) out.push({ label: "~", path: home! });
  let at = fromHome ? home! : "/";
  for (const seg of path.slice(fromHome ? home!.length : 0).split("/").filter(Boolean)) {
    at = at === "/" ? `/${seg}` : `${at}/${seg}`;
    out.push({ label: seg, path: at });
  }
  return out;
}

/**
 * A folder that Use this folder can take as it is: act.addFolder's cleanFolder keeps it unchanged (not `/`, no empty,
 * "." or ".." part, no space at its end, not too long) and it has no character that the server refuses. A folder
 * that is not one can never be added (and the server will not list inside it), so it shows no row.
 */
export function usable(path: string): boolean {
  return cleanFolder(path) === path && !CONTROL_CHARS.test(path);
}

/** One row of the finder: a Suggested folder or a folder in the one Browse shows. */
export interface FinderRow {
  key: string;
  from: "suggested" | "browse";
  name: string;
  path: string;
  git: boolean;
  /** Browse: it holds a subfolder. */
  more: boolean;
}

const suggestedRow = (f: SuggestedFolder): FinderRow => ({ key: `s:${f.path}`, from: "suggested", name: f.name, path: f.path, git: f.git, more: false });
const browseRow = (f: FolderEntry): FinderRow => ({ key: `b:${f.path}`, from: "browse", name: f.name, path: f.path, git: f.git, more: f.subfolders });

export interface FinderView {
  typed: TypedPath | null;
  /** The text that narrows the rows: the typed path's last part, or the plain filter. */
  filter: string;
  /** The folder to list (GET /api/folders?path=), and whether with the dot folders. */
  list: { path: string; hidden: boolean };
  /** Suggested shows: at the home folder, with no path typed. */
  start: boolean;
  suggested: FinderRow[];
  browse: FinderRow[];
}

/**
 * What the finder shows. `dir` is the folder browsed to ("~" at the start); `home` the home folder once a listing
 * named it; `listing` the listing of the folder asked for (`list`), or null while it loads; `projects` the folders
 * of kitespan's projects, which Suggested leaves out as it does those the server marked (one may be added since).
 */
export function finderView(o: { text: string; dir: string; home: string | null; listing: FoldersReply | null; suggested: readonly SuggestedFolder[]; projects?: ReadonlySet<string> }): FinderView {
  const typed = typedPath(o.text);
  const filter = typed ? typed.leaf : o.text.trim();
  const list = { path: typed ? typed.dir : o.dir, hidden: filter.startsWith(".") };
  const start = !typed && (o.dir === "~" || o.dir === o.home);
  const fresh = start ? o.suggested.filter((f) => f.project === null && !o.projects?.has(f.path) && usable(f.path)) : [];
  const all = narrow(fresh.map(suggestedRow), filter);
  const suggested = filter ? all : all.slice(0, SUGGESTED_SHOWN);
  const browse = o.listing?.ok ? narrow(o.listing.folders.filter((f) => usable(f.path)).map(browseRow), filter) : [];
  return { typed, filter, list, start, suggested, browse };
}

/** What GET /api/folders is asked for: the folder, with the dot folders or not, and the filter (`q`) or none. */
export interface FolderAsk {
  path: string;
  hidden: boolean;
  q?: string;
}

/**
 * The read for a filter: once the folder's own listing came back `truncated` (more folders than one listing holds),
 * the filter goes with it (`q`), so the server narrows before it caps and a folder past the cap is found by its
 * name. Else the page narrows the listing it has, with no read per key.
 */
export function listingAsk(list: { path: string; hidden: boolean }, filter: string, whole: FoldersReply | null): FolderAsk {
  return whole?.ok && whole.truncated && filter ? { ...list, q: filter } : list;
}

/** A read's key in the finder's listings. */
export const askKey = (a: FolderAsk): string => JSON.stringify([a.path, a.hidden, a.q ?? ""]);

/** The highlighted row: the one the arrows moved to, else the first while a filter is typed, else none. */
export function activeRow(picked: number | null, count: number, filter: string): number | null {
  if (!count) return null;
  if (picked !== null) return Math.min(Math.max(picked, 0), count - 1);
  return filter ? 0 : null;
}

/** What a key in the field does: move the highlight to a row, open (Enter), or use the folder (Cmd or Ctrl+Enter). */
export type FinderKey = { kind: "move"; to: number } | { kind: "open" } | { kind: "use" } | null;

export function finderKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; isComposing?: boolean }, active: number | null, count: number): FinderKey {
  if (e.isComposing || e.altKey) return null;
  if (e.key === "Enter") return e.metaKey || e.ctrlKey ? { kind: "use" } : e.shiftKey ? null : { kind: "open" };
  if (e.metaKey || e.ctrlKey || !count) return null;
  if (e.key === "ArrowDown") return { kind: "move", to: active === null ? 0 : Math.min(active + 1, count - 1) };
  if (e.key === "ArrowUp") return { kind: "move", to: active === null ? count - 1 : Math.max(active - 1, 0) };
  return null;
}

/**
 * The folder Use this folder takes: the highlighted row; else the typed path with a last part (the server checks
 * it); else, with no filter typed, the folder Browse shows once its listing has come and could be read. null when
 * there is none: a filter that matches no row (the folder behind it is not the one meant), `/`, or a folder that
 * is not usable.
 */
export function folderToUse(o: { active: FinderRow | null; typed: TypedPath | null; filter: string; listing: FoldersReply | null }): string | null {
  if (o.active) return o.active.path;
  if (o.typed?.leaf) return o.typed.full;
  if (o.filter) return null;
  return o.listing?.ok && usable(o.listing.path) ? o.listing.path : null;
}

/**
 * The folder whose Worktree option New environment reads (row 73, W2): the one Use this folder takes, once it is a
 * listed folder (a row, or the folder Browse is in). A typed path that no row is may not be there (its folder's listing
 * is still on its way, or no row matches), so it is not read: no failed request. The add's own answer says the rest.
 */
export function folderToRead(o: Parameters<typeof folderToUse>[0]): string | null {
  return !o.active && o.typed?.leaf ? null : folderToUse(o);
}

/** GET /api/folders: a failed request reads as a folder that could not be read, with its line. */
export async function readFolders(ask: FolderAsk, fetcher?: typeof fetch): Promise<FoldersReply> {
  const { path } = ask;
  const q = new URLSearchParams({ path });
  if (ask.hidden) q.set("hidden", "1");
  if (ask.q) q.set("q", ask.q);
  try {
    return await apiGet<FoldersReply>(`/api/folders?${q.toString()}`, fetcher);
  } catch (e) {
    // No answer says kitespan could not be reached; a refused path (400) reads as a folder that could not be read.
    const line = e instanceof ApiError && e.status !== 400 ? e.message : FOLDERS_FAILED;
    return { ok: false, path, parent: null, home: "", reason: "failed", line };
  }
}

/** GET /api/folders/suggested: none when it fails (Suggested then does not show). */
export async function readSuggested(fetcher?: typeof fetch): Promise<SuggestedFolder[]> {
  try {
    const r = await apiGet<SuggestedFoldersReply>("/api/folders/suggested", fetcher);
    return Array.isArray(r?.folders) ? r.folders : [];
  } catch {
    return [];
  }
}
