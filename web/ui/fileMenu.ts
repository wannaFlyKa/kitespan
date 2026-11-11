// The one file menu (DESIGN-T1 2.1, T-2; Desktop's file-path menu, PARITY PA-9): the items for a path that a row names,
// by where the row is. Pure: the rows draw it with RowMenu (ui/RowMenu.tsx). Every file path gets the menu's own subset
// of Open, Download, Attach as context, Copy path and Copy relative path, in that order; a path outside the chat's
// folder (Plan mode's plan file, an upload) only what needs no URL, since no URL may hold its path (5.1 rule 2), and
// Attach as context only inside the folder, since a mention is relative to it. On a laptop a row that is a link to a
// kitespan URL also gets Open in new tab and Copy link, the browser menu's two link items that the custom menu takes.
import { isSafeRelativePath } from "../../shared/protocol";
import { filesUrl, uploadUrl, type DownloadKind } from "../panels/download";
import type { Upload } from "../state/types";

/** What a menu row does: RowMenu acts on it. */
export type RowAct =
  /** Write the text to the clipboard, inside the tap. */
  | { do: "copy"; text: string }
  /** Go to a page URL (a navigation in the page). */
  | { do: "go"; to: string }
  /** Open a URL in a new tab (a kitespan URL, or a fetched page's own). */
  | { do: "tab"; to: string }
  /**
   * A download (a file, an upload, a tool's whole output): the existence probe, then the browser's own download
   * (panels/download.ts); a refused probe says its 5.4 line.
   */
  | { do: "save"; url: string; what: DownloadKind }
  /** Add the file's mention chip to the chat's draft; nothing is sent (D50). */
  | { do: "attach"; chat: string; rel: string }
  /** The row's own act (an upload's Remove), which the row's owner runs. */
  | { do: "run" };

export interface RowItem {
  /** The row's id: its test id is `row-<id>`. */
  id: string;
  label: string;
  act: RowAct;
  danger?: boolean;
}

/** A row's menu: `kind` names it (its test id is `row-menu-<kind>`); the sheet's title, the first line, the groups. */
export interface RowMenuSpec {
  kind: string;
  /** The sheet's title: a file's or a row's name. */
  title: string;
  /** The menu's first line, whole: the full path, a command, a pattern. */
  head: string;
  /** A line under it (a cut output). */
  note?: string;
  groups: RowItem[][];
}

/** The last part of a path. */
export function baseName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

/** A path as the host knows it: a relative path is inside the chat's project folder. */
export function hostPath(path: string, folder?: string): string {
  if (!folder || path.startsWith("/") || path.startsWith("~")) return path;
  return `${folder.replace(/\/+$/, "")}/${path.replace(/^\.\//, "")}`;
}

/** A path relative to the chat's folder, as the download route takes it; null when it is outside that folder. */
export function relInFolder(path: string, folder?: string): string | null {
  if (!path.startsWith("/") && !path.startsWith("~")) return path.replace(/^\.\//, "");
  if (!folder) return null;
  const root = folder.replace(/\/+$/, "");
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
}

/**
 * Where a file row is: a tool row whose target is a file, an Outputs file (the card and the view), a sent message's
 * file tile, a changes row (the card and the view), a file hit in search.
 */
export type FilePlace = "tool" | "outputs" | "tile" | "changes" | "hit";

export interface FileRow {
  place: FilePlace;
  chatId: string;
  /** The path as the row has it: relative to the chat's folder, or absolute. */
  path: string;
  /** The chat's folder on the host, when known. */
  folder?: string;
  /** Open's URL for a path in the folder (the file's page, or its pane), in the row's own view; none: no Open. */
  open?: (rel: string) => string;
  /** False: only the copy rows (a tool call that did not work, whose file may not be there). */
  acts?: boolean;
  /** False: no Attach as context (a read-only transcript, which has no draft). */
  attach?: boolean;
  /** A fine pointer: a row that is a link (Outputs, changes, file hits) gets Open in new tab and Copy link. */
  laptop?: boolean;
  /** The row's own link, for those two (a changes row's diff); Open's URL when not given. */
  link?: string;
  /** The page's origin, for Copy link. */
  origin?: string;
}

const OPENS: ReadonlySet<FilePlace> = new Set(["tool", "outputs", "changes"]);
const DOWNLOADS: ReadonlySet<FilePlace> = new Set(["tool", "outputs", "tile"]);
const ATTACHES: ReadonlySet<FilePlace> = new Set(["tool", "outputs", "changes", "hit"]);
const RELATIVE: ReadonlySet<FilePlace> = new Set(["tool", "outputs"]);
const LINKS: ReadonlySet<FilePlace> = new Set(["outputs", "changes", "hit"]);

const groups = (list: (RowItem | null)[][]): RowItem[][] => list.map((g) => g.filter((i): i is RowItem => i !== null)).filter((g) => g.length > 0);

/** The file menu of one path. */
export function fileMenu(f: FileRow): RowMenuSpec {
  const abs = hostPath(f.path, f.folder);
  const found = relInFolder(abs, f.folder);
  const rel = found !== null && isSafeRelativePath(found) ? found : null;
  const own = f.acts !== false ? rel : null; // the path in the folder, when the row's acts apply
  const to = own !== null && f.open ? f.open(own) : null;
  const opens = to !== null && OPENS.has(f.place);
  const rowLink = to !== null ? (f.link ?? to) : null;
  const linked = rowLink !== null && !!f.laptop && LINKS.has(f.place);
  return {
    kind: "file",
    title: baseName(abs),
    head: abs,
    groups: groups([
      [
        opens && to !== null ? { id: "open", label: f.place === "outputs" ? "Open" : "Open file", act: { do: "go", to } } : null,
        own !== null && DOWNLOADS.has(f.place) ? { id: "download", label: "Download", act: { do: "save", url: filesUrl(f.chatId, own), what: "file" } } : null,
      ],
      [own !== null && f.attach !== false && ATTACHES.has(f.place) ? { id: "attach", label: "Attach as context", act: { do: "attach", chat: f.chatId, rel: own } } : null],
      [
        { id: "copy-path", label: "Copy path", act: { do: "copy", text: abs } },
        own !== null && RELATIVE.has(f.place) ? { id: "copy-rel", label: "Copy relative path", act: { do: "copy", text: own } } : null,
      ],
      linked && rowLink !== null ? [{ id: "tab", label: "Open in new tab", act: { do: "tab", to: rowLink } }, { id: "copy-link", label: "Copy link", act: { do: "copy", text: `${f.origin ?? ""}${rowLink}` } }] : [],
    ]),
  };
}

/**
 * An upload's menu (the Files list, a sent message's tile): Download once it is on the server, Copy path (its host
 * path), and in the Files list Remove, which acts at once (`remove`).
 */
export function uploadMenu(u: Upload, remove: boolean): RowMenuSpec {
  const path = u.path || u.name;
  return {
    kind: "upload",
    title: u.name,
    head: path,
    groups: groups([
      [u.state === "done" ? { id: "download", label: "Download", act: { do: "save", url: uploadUrl(u.chatId, u.id), what: "upload" } } : null, u.path ? { id: "copy-path", label: "Copy path", act: { do: "copy", text: u.path } } : null],
      [remove ? { id: "remove", label: "Remove", act: { do: "run" }, danger: true } : null],
    ]),
  };
}
