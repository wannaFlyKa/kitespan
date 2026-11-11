// Downloads in the transcript (D37, BUILD-BRIEF section 7): every file a chat names gets a Download action. A tool
// row whose target is a file (Read, Write, Edit) offers Download beside the row, and a user message that refers to an
// uploaded file (its reference, shared/protocol.ts messageRef: `@<path>`, `@"<path>"`, or the path in backticks where
// Claude Code attaches neither) shows that file above the bubble as a tile that downloads it.
// So does a file of the chat's folder that a mention chip sent (9.3, L10): the server adds its reference after the
// uploads', at the end of the text, and names the chips' paths on the message's `user` event (the notes keep them for
// history), so exactly those paths are tiles, and the rest of the text stays text: with an empty list (sent with no
// chips), a reference typed by hand too. A message with no such list (from before v0.3, or from the terminal) is read
// as before, among the references at the end only: a bare one runs to the next white space, because its text has no
// mark where such a path ends. A known path is found in every form, the bare one that iteration 2 sent for every path
// too. A download is a read (C3): the existence probe of the server's download route, then the browser's
// own download; it records nothing. A probe that is refused shows its line as the chat's notice. A tile has the file's
// menu (DESIGN-T1 2.1: Download and Copy path, its full path first): a long press or its "..." on touch, a right-click
// on a laptop.
import { useMemo, type ReactNode } from "react";
import { isSafeRelativePath, messageRefForms, refsIn } from "../../../shared/protocol";
import { isImageName } from "../../composer/attach";
import { FILE_GONE, download, filesUrl, uploadUrl } from "../../panels/download";
import { NO_UPLOADS, act, chatFolderIn, uploadRefForms, useStore } from "../../state/store";
import type { ToolItem, Upload } from "../../state/types";
import { formatSize } from "../../ui/files";
import { IconDownload, IconFile, IconImage } from "../../ui/icons";
import { baseName, fileMenu, relInFolder, uploadMenu } from "../../ui/fileMenu";
import { useRowMenu } from "../../ui/RowMenu";

// The path helpers live with the file menu (ui/fileMenu.ts) and the tool menu (toolMenu.ts), which read them too.
export { baseName, hostPath, relInFolder } from "../../ui/fileMenu";
export { fileTarget } from "./toolMenu";

/** A Download press: probe, then save; a refused probe (or a path outside the folder) shows the 5.4 line. */
async function saveFile(url: string | null, what: "file" | "upload") {
  if (!url) return act.setNotice(FILE_GONE);
  const r = await download(url, what);
  if (!r.ok) act.setNotice(r.line);
}

/** A file of the chat's folder that a message names: a mention chip's reference (9.3), by its path in the folder. */
export interface FolderFile {
  /** `file ` and its path: a key apart from every upload's id. */
  id: string;
  chatId: string;
  /** Relative to the chat's folder, as the chip held it. */
  rel: string;
  /** The reference's path on the host, as the server added it. */
  path: string;
}

/** A file a message refers to: an upload, or a file of the chat's folder. */
export type MessageFile = Upload | FolderFile;

/**
 * A message's text in parts: plain text, and each reference (its text, in whichever form it was sent) of an upload or
 * of a folder's file it names. A file that the message's event names but whose reference its text does not hold (the
 * event's text cap cut it) is a part with no text (`ref` ""), after the others: its tile shows all the same.
 */
export type MessagePart = string | { ref: string; upload: Upload } | { ref: string; file: FolderFile };

/** The chat whose folder a message's mention references are in: its id and its folder on the host. */
export interface RefFolder {
  chatId: string;
  folder: string;
}

/** The chat's uploads, as a message's references are matched against them, with the chat's folder (useChatUploads). */
export type ChatUploads = readonly Upload[] & { readonly refFolder?: RefFolder };

const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch);

/**
 * Split a message at its references to finished uploads and to files of the chat's folder. A reference stands at the
 * start or after white space, is followed by white space or the end, and is in a form of messageRefForms: an upload's
 * path is known, and so is its path from before the folder move (uploadRefForms), so each of its forms is looked for
 * whole (a path may hold white space), and where two start at the same place, the longer one wins. A folder's file is
 * `<folder>/<path>`. `mentions`, the paths that the message's event names (9.3): exactly these are files, each at its
 * last reference before the next one's (the server puts them at the end of the text, in chip order), so the words
 * after one stay text, and so does a copy the user typed; one whose reference the text does not hold still gets its
 * tile. An empty list: no folder's file at all (sent with no chips). With no such list (an old message), a folder's
 * file is among the references at the end of the text, read as refAt reads one, its path a safe relative one:
 * anywhere else such text stays text, and so does a bare path with white space in it, because the text does not mark
 * where it ends.
 */
export function splitRefs(text: string, uploads: ChatUploads, refFolder: RefFolder | undefined = uploads.refFolder, mentions?: readonly string[]): MessagePart[] {
  type Hit = { at: number; end: number; part: Exclude<MessagePart, string> };
  const hits: Hit[] = [];
  const root = refFolder?.folder.replace(/\/+$/, "");
  const fileOf = (rel: string): FolderFile => ({ id: `file ${rel}`, chatId: refFolder!.chatId, rel, path: `${root}/${rel}` });
  // The server's list: placed first, so where an upload's reference is the same text, the list's wins.
  const missing: FolderFile[] = [];
  if (refFolder && root && mentions?.length) {
    let before = text.length;
    for (const rel of [...new Set(mentions)].reverse()) {
      const found = lastRef(text, messageRefForms(`${root}/${rel}`), before);
      if (!found) {
        missing.unshift(fileOf(rel));
        continue;
      }
      hits.push({ ...found, part: { ref: text.slice(found.at, found.end), file: fileOf(rel) } });
      before = found.at;
    }
  }
  for (const upload of uploads) {
    if (upload.state !== "done" || !upload.path) continue;
    for (const ref of uploadRefForms(upload)) {
      for (let at = text.indexOf(ref); at >= 0; at = text.indexOf(ref, at + 1)) {
        const end = at + ref.length;
        if (isSpace(text[at - 1]) && isSpace(text[end])) hits.push({ at, end, part: { ref, upload } });
      }
    }
  }
  if (refFolder && root && !mentions) {
    const head = `${root}/`;
    const files: Hit[] = [];
    for (const r of refsIn(text)) {
      if (!r.path.startsWith(head) || hits.some((h) => h.at === r.at)) continue; // an upload's own reference wins
      const rel = r.path.slice(head.length);
      if (isSafeRelativePath(rel)) files.push({ at: r.at, end: r.end, part: { ref: text.slice(r.at, r.end), file: fileOf(rel) } });
    }
    // Only the references at the end count: after each, nothing but white space and other references.
    const all = outermost([...hits, ...files]);
    let tail = text.length;
    for (let i = all.length - 1; i >= 0; i--) {
      const h = all[i]!;
      if (text.slice(h.end, tail).trim() !== "") break;
      if (files.includes(h)) hits.push(h);
      tail = h.at;
    }
  }
  const parts: MessagePart[] = [];
  let pos = 0;
  for (const h of outermost(hits)) {
    if (h.at > pos) parts.push(text.slice(pos, h.at));
    parts.push(h.part);
    pos = h.end;
  }
  if (pos < text.length) parts.push(text.slice(pos));
  for (const file of missing) parts.push({ ref: "", file });
  return parts;
}

/**
 * Where one of `refs` (a path's forms) last stands as a reference that ends by `before` (white space or an edge on
 * each side); the latest of them; else null.
 */
function lastRef(text: string, refs: readonly string[], before: number): { at: number; end: number } | null {
  let found: { at: number; end: number } | null = null;
  for (const ref of refs) {
    for (let at = text.lastIndexOf(ref, before - ref.length); at >= 0 && at + ref.length <= before; at = at > 0 ? text.lastIndexOf(ref, at - 1) : -1) {
      if (!isSpace(text[at - 1]) || !isSpace(text[at + ref.length])) continue;
      if (!found || at > found.at) found = { at, end: at + ref.length };
      break;
    }
  }
  return found;
}

/** References in text order, leaving out each one inside a longer one that starts before or with it. */
function outermost<T extends { at: number; end: number }>(hits: readonly T[]): T[] {
  const out: T[] = [];
  let pos = 0;
  for (const h of [...hits].sort((a, b) => a.at - b.at || b.end - a.end)) {
    if (h.at < pos) continue;
    out.push(h);
    pos = h.end;
  }
  return out;
}

/** The files a message refers to, in the order it names them, each once: its uploads and its folder's files. */
export function referencedUploads(parts: readonly MessagePart[]): MessageFile[] {
  const seen = new Set<string>();
  const out: MessageFile[] = [];
  for (const p of parts) {
    if (typeof p === "string") continue;
    const f = "upload" in p ? p.upload : p.file;
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    out.push(f);
  }
  return out;
}

/**
 * The chat's uploads, for a message's references (none outside a chat), with the chat's folder, which its mention
 * references are in (splitRefs reads it from the list).
 */
export function useChatUploads(chatId: string | undefined): ChatUploads {
  const uploads = useStore((s) => (chatId ? s.uploads[chatId] ?? NO_UPLOADS : NO_UPLOADS));
  const folder = useProjectFolder(chatId);
  return useMemo(() => (chatId && folder ? Object.assign([...uploads], { refFolder: { chatId, folder } }) : uploads), [uploads, chatId, folder]);
}

/** The chat's folder (its worktree's, row 73, else its project's), which a tool row's relative path is in. */
export function useProjectFolder(chatId: string | undefined): string | undefined {
  return useStore((s) => chatFolderIn(s, chatId ? s.chats.find((c) => c.id === chatId) : undefined));
}

/** Download beside a tool row: an icon button that saves the file from the chat's folder. */
export function DownloadButton({ chatId, path, folder, testId }: { chatId: string; path: string; folder?: string; testId?: string }) {
  const label = `Download ${baseName(path)}`;
  const rel = relInFolder(path, folder);
  return (
    <button type="button" className="icon-btn chat-dl" aria-label={label} title={label} data-testid={testId} onClick={() => void saveFile(rel === null ? null : filesUrl(chatId, rel), "file")}>
      <IconDownload size={15} />
    </button>
  );
}

/**
 * The files a message refers to, above its bubble: each a tile (its icon, its name, and its size or, for a file of the
 * chat's folder, its folder part) that downloads it. Each tile's `onClick` is its download.
 */
export function MessageFiles({ uploads }: { uploads: readonly MessageFile[] }) {
  if (!uploads.length) return null;
  return (
    <div className="chat-files">
      {uploads.map((u) => ("rel" in u ? <FolderTile key={u.id} f={u} onClick={() => void saveFile(filesUrl(u.chatId, u.rel), "file")} /> : <UploadTile key={u.id} u={u} onClick={() => void saveFile(uploadUrl(u.chatId, u.id), "upload")} />))}
    </div>
  );
}

/** A tile and, on touch, its "..." beside it (a button holds no button). */
function WithOpener({ tile, opener, menu }: { tile: ReactNode; opener: ReactNode; menu: ReactNode }) {
  return opener ? (
    <span className="chat-file-item">
      {tile}
      {opener}
      {menu}
    </span>
  ) : (
    <>
      {tile}
      {menu}
    </>
  );
}

function UploadTile({ u, onClick }: { u: Upload; onClick: () => void }) {
  const menu = useRowMenu(() => uploadMenu(u, false), { openerClass: "chat-file-more" });
  const tile = (
    <button
      type="button"
      className="attach-chip chat-file"
      aria-label={`Download ${u.name}, ${formatSize(u.size)}`}
      title={u.path}
      data-testid={`download-${u.id}`}
      onClick={onClick}
      {...menu.target}
    >
      <span className="attach-icon" aria-hidden="true">
        {u.type.startsWith("image/") ? <IconImage size={16} /> : <IconFile size={16} />}
      </span>
      <span className="attach-text">
        <span className="attach-name">{u.name}</span>
        <span className="attach-size">{formatSize(u.size)}</span>
      </span>
      <IconDownload size={15} className="chat-file-dl" />
    </button>
  );
  return <WithOpener tile={tile} opener={menu.opener} menu={menu.menu} />;
}

/** A file of the chat's folder that a mention sent (9.3): the folder part stands where an upload's size does. */
function FolderTile({ f, onClick }: { f: FolderFile; onClick: () => void }) {
  const name = baseName(f.rel);
  const cut = f.rel.lastIndexOf("/");
  const dir = cut > 0 ? f.rel.slice(0, cut) : "";
  const folder = f.path.slice(0, Math.max(0, f.path.length - f.rel.length - 1));
  const menu = useRowMenu(() => fileMenu({ place: "tile", chatId: f.chatId, path: f.rel, folder }), { openerClass: "chat-file-more" });
  const tile = (
    <button
      type="button"
      className="attach-chip chat-file"
      aria-label={dir ? `Download ${name}, in ${dir}` : `Download ${name}`}
      title={f.path}
      data-testid="download-mention"
      data-path={f.rel}
      onClick={onClick}
      {...menu.target}
    >
      <span className="attach-icon" aria-hidden="true">
        {isImageName(name) ? <IconImage size={16} /> : <IconFile size={16} />}
      </span>
      <span className="attach-text">
        <span className="attach-name">{name}</span>
        {dir ? (
          <span className="attach-size mention-dir" dir="auto">
            {dir}
          </span>
        ) : null}
      </span>
      <IconDownload size={15} className="chat-file-dl" />
    </button>
  );
  return <WithOpener tile={tile} opener={menu.opener} menu={menu.menu} />;
}
