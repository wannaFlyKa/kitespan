// Downloads through the server's download routes (DESIGN.md 6.4, D37; build checklist C3): a file in a chat's folder,
// GET /api/chats/<chat>/files/<relative path> (a folder comes as one .tar.gz), and an upload, GET
// /api/chats/<chat>/uploads/<upload>/file. A download is a read: it sends no mutating request and records nothing.
// The existence probe beside each route goes first (GET .../exists/<relative path> and .../uploads/<upload>/exists,
// always a 200 read): it says whether the path is there, whether it is a file or a folder, its size and its name, so
// a gone file shows its 5.4 line on the page with no failed request (a 404 would put an error in the browser's
// console), and the browser then saves the file under the server's name (RFC 6266).
import type { ExistsReply } from "../../server/http/api-types";

/** DESIGN.md 5.4: a file path that is not in the chat's folder. */
export const FILE_GONE = "That file is not in this chat's folder.";
/** DESIGN.md 5.4 (T-26): a tool output that the chat's transcript does not hold (the output route's 404). */
export const OUTPUT_GONE = "That message is not in this chat.";
/** An upload that was removed or swept since the list was read. */
export const UPLOAD_GONE = "That upload is gone.";
/** A folder over the archive's caps (the existence probe's `over`, the download route's 413). */
export const FOLDER_TOO_LARGE = "That folder is too large to download as one archive.";
const NOT_REACHED = "kitespan could not be reached.";
const FAILED = "That did not work.";

export interface Probe {
  kind: "file" | "folder";
  /** The name the server gives the download (a folder's ends with .tar.gz); "" when it sent none. */
  name: string;
  /** Bytes: the file's size, or the total size of a folder's files. */
  size: number;
  /** A folder's entries (its files, folders and links), else null. */
  entries: number | null;
}

export type ProbeResult = { ok: true; probe: Probe } | { ok: false; status: number; line: string };
export type ProbeState = { phase: "probing" } | ({ phase: "done" } & ProbeResult);

const segments = (rel: string) => rel.split("/").map(encodeURIComponent).join("/");

/** The download route of a path relative to the chat's folder. */
export function filesUrl(chatId: string, rel: string): string {
  return `/api/chats/${encodeURIComponent(chatId)}/files/${segments(rel)}`;
}

/** The download route of one of the chat's uploads. */
export function uploadUrl(chatId: string, uploadId: string): string {
  return `/api/chats/${encodeURIComponent(chatId)}/uploads/${encodeURIComponent(uploadId)}/file`;
}

/** What a download is: a file of the chat's folder, an upload, or a tool's whole output (T-26). */
export type DownloadKind = "file" | "upload" | "output";

/** The existence probe beside a download route (filesUrl, uploadUrl or a tool's output); any other URL stays as it is. */
export function existsUrl(downloadUrl: string): string {
  const file = /^(\/api\/chats\/[^/]+)\/files\/(.*)$/.exec(downloadUrl);
  if (file) return `${file[1]}/exists/${file[2]}`;
  if (/^\/api\/chats\/[^/]+\/tools\/[^/]+\/output$/.test(downloadUrl)) return `${downloadUrl}/exists`;
  const up = /^(\/api\/chats\/[^/]+\/uploads\/[^/]+)\/file$/.exec(downloadUrl);
  return up ? `${up[1]}/exists` : downloadUrl;
}

/**
 * The file name in a content-disposition header (RFC 6266): `filename*` (RFC 8187, UTF-8) first, as the server sends
 * the exact name there, else the ASCII `filename`. Null when the header names none.
 */
export function dispositionName(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*UTF-8''([^;\s]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1]!);
    } catch {
      // fall back to the plain name
    }
  }
  const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header);
  if (quoted) return quoted[1]!.replace(/\\(.)/g, "$1");
  const bare = /filename\s*=\s*([^;\s]+)/i.exec(header);
  return bare ? bare[1]! : null;
}

/** The page's line for a refused probe, by the status that the download route would answer. */
export function probeLine(status: number, what: DownloadKind): string {
  if (status === 404) return what === "upload" ? UPLOAD_GONE : what === "output" ? OUTPUT_GONE : FILE_GONE;
  if (status === 413) return FOLDER_TOO_LARGE;
  if (status === 0) return NOT_REACHED;
  return FAILED;
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/**
 * The probe's answer for the existence probe's reply: a gone path (any reason) reads as the route's 404 would, and a
 * folder over the archive's caps as its 413, so each keeps its line. A reply of another shape did not work.
 */
export function probeOf(reply: unknown, what: DownloadKind): ProbeResult {
  const r = reply as Partial<Record<string, unknown>> | null;
  if (!r || typeof r !== "object" || typeof r.exists !== "boolean") return { ok: false, status: 200, line: FAILED };
  if (!r.exists) return { ok: false, status: 404, line: probeLine(404, what) };
  const name = typeof r.name === "string" ? r.name : "";
  if (r.kind === "folder") {
    if (r.over === true) return { ok: false, status: 413, line: FOLDER_TOO_LARGE };
    return { ok: true, probe: { kind: "folder", name: name ? `${name}.tar.gz` : "", size: isCount(r.bytes) ? r.bytes : 0, entries: isCount(r.entries) ? r.entries : null } };
  }
  return { ok: true, probe: { kind: "file", name, size: isCount(r.size) ? r.size : 0, entries: null } };
}

/** Ask the existence probe of a download route: a plain GET with no body and no sender header, always a 200 read. */
export async function probe(url: string, what: DownloadKind, fetcher: typeof fetch = fetch): Promise<ProbeResult> {
  let res: Response;
  try {
    res = await fetcher(existsUrl(url), { method: "GET", cache: "no-store" });
  } catch {
    return { ok: false, status: 0, line: NOT_REACHED };
  }
  if (!res.ok) return { ok: false, status: res.status, line: probeLine(res.status, what) };
  let reply: ExistsReply;
  try {
    reply = (await res.json()) as ExistsReply;
  } catch {
    return { ok: false, status: res.status, line: FAILED };
  }
  return probeOf(reply, what);
}

/** Hand the URL to the browser's own download (the server's content-disposition names the file). */
export function saveUrl(url: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * A Download button's press: the existence probe first, then the browser's download when it passes. Resolves with the
 * probe, whose `line` the button shows when it did not pass.
 */
export async function download(url: string, what: DownloadKind, fetcher: typeof fetch = fetch, save: (url: string) => void = saveUrl): Promise<ProbeResult> {
  const r = await probe(url, what, fetcher);
  if (r.ok) save(url);
  return r;
}
