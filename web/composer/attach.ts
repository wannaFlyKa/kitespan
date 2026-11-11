// The composer's side of the files flow (D37, D50). The message box shows a file as a chip only: no `@` path goes into
// the field, and the server adds each chip's reference at send (messageRef's form in a message, the single-quoted
// path in a `!` command). The chips are the draft's upload ids (s.draftUploads, which the server's draft carries to
// every page) drawn from the chat's uploads, then the files on their way from this page, then the ones that failed
// and were not put aside by a Send. Uploads themselves go through act.upload and act.removeUpload (state/store.ts).
// After them come the mention chips (9.3): files of the chat's folder picked with `@`, the draft's `mentions`
// (act.addMention, act.removeMention: the draft only, never an upload).
import type { UploadView } from "../../server/http/api-types";
import type { Upload } from "../state/types";
import type { FileFacts } from "../ui/files";

/** The generic name a browser gives an image that has no name of its own (Chrome, Safari and Firefox: image.png). */
const GENERIC_IMAGE = /^image\.[a-z0-9]+$/i;

/**
 * The files of a paste, as act.upload takes them. A pasted image with no name of its own (a screenshot, an image
 * copied from a page) goes with an empty name, so act.upload names it pasted.<subtype>; a named file keeps its name.
 */
export function pastedFacts(files: readonly FileFacts[]): FileFacts[] {
  return files.map((f) => (f.type.startsWith("image/") && (f.name === "" || GENERIC_IMAGE.test(f.name)) ? { ...f, name: "" } : f));
}

/** The files a clipboard carries, or none. Text wins: a paste with text/plain in it goes into the field as typed. */
export function clipboardFiles(dt: DataTransfer | null): File[] {
  if (!dt || Array.from(dt.types ?? []).includes("text/plain")) return [];
  if (dt.files && dt.files.length > 0) return Array.from(dt.files);
  return Array.from(dt.items ?? [])
    .filter((i) => i.kind === "file")
    .map((i) => i.getAsFile())
    .filter((f): f is File => !!f);
}

/** A chip's upload. `unknown`: the draft names an upload this page has not read yet (another page added it). */
export type ChipUpload = Upload & { unknown?: boolean };

/** An upload as GET /api/chats/:chat/uploads lists it, in the page's form. */
export function uploadFromView(v: UploadView, chatId: string): Upload {
  const dir = v.path.slice(0, Math.max(0, v.path.lastIndexOf("/")));
  return { id: v.id, chatId: v.chat ?? chatId, name: v.name, size: v.size, type: v.type, path: v.path, ...(v.was ? { was: v.was } : {}), folder: "temp", dir, at: "", state: "done", progress: 1 };
}

function unknownUpload(id: string, chatId: string): ChipUpload {
  return { id, chatId, name: "", size: 0, type: "", path: "", folder: "temp", dir: "", at: "", state: "done", progress: 1, unknown: true };
}

/**
 * The chips over the field: the draft's uploads in its order (from the chat's list, else from `extra`, the ones read
 * for this purpose, else a chip with no name yet), then this page's uploads on their way, then the failed ones that a
 * Send has not put aside. An earlier upload that the draft does not name stays in the chat's Uploads list only.
 */
export function chipsOf(input: { chatId: string; ids: readonly string[]; uploads: readonly Upload[]; extra?: ReadonlyMap<string, Upload>; putAside: ReadonlySet<string> }): ChipUpload[] {
  const { chatId, ids, uploads, extra, putAside } = input;
  const named = ids.map((id) => uploads.find((u) => u.id === id) ?? extra?.get(id) ?? unknownUpload(id, chatId));
  const onTheWay = uploads.filter((u) => u.state === "uploading" && !ids.includes(u.id));
  const failed = uploads.filter((u) => u.state === "failed" && !putAside.has(u.id) && !ids.includes(u.id));
  return [...named, ...onTheWay, ...failed];
}

/** The draft's upload ids that neither the chat's list nor `extra` holds: the page reads the list again for them. */
export function unknownIds(ids: readonly string[], uploads: readonly Upload[], extra?: ReadonlyMap<string, Upload>): string[] {
  return ids.filter((id) => !uploads.some((u) => u.id === id) && !extra?.has(id));
}

/** True while a file of the draft is still on its way: Send waits for it. */
export function waitsForUpload(chips: readonly Upload[]): boolean {
  return chips.some((u) => u.state === "uploading");
}

/** A mention chip (9.3): a file of the chat's folder that the draft names, as its chip shows it. */
export interface MentionChipFacts {
  /** Relative to the chat's folder, as the draft holds it. */
  path: string;
  name: string;
  /** The folder part before the name, with no slash at its end; "" for a file at the folder's top. */
  dir: string;
  /** The path on the host (the chat's folder, then the path), as the server adds it at send; null with no folder known. */
  abs: string | null;
  /** Its name ends as an image's does, so the chip shows the image icon (the upload chip goes by its type). */
  image: boolean;
}

/** A file name that ends as an image's does: a file of the chat's folder has no type, so its icon goes by its name. */
export function isImageName(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic|ico)$/i.test(name);
}

/** A path inside a folder as the host writes it: the folder with no slash at its end, then the relative path. */
function inFolder(folder: string, path: string): string {
  return `${folder.replace(/\/+$/, "")}/${path}`;
}

/**
 * The mention chips over the field, after the upload chips (the server adds the uploads' references first, then the
 * mentions', so the chips keep that order), in the order they were picked.
 */
export function mentionChipsOf(mentions: readonly string[], folder: string | null | undefined): MentionChipFacts[] {
  return mentions.map((path) => {
    const cut = path.lastIndexOf("/");
    const name = path.slice(cut + 1);
    return { path, name, dir: cut > 0 ? path.slice(0, cut) : "", abs: folder ? inFolder(folder, path) : null, image: isImageName(name) };
  });
}
