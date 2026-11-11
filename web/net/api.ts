// The page's side of the JSON API under /api/ (DESIGN.md 4.3, 4.9; the shapes are server/http/api-types.ts). A read
// is a plain GET. A mutating request carries the sender gate's header and its body type (guard 3): `x-kitespan: 1`
// and JSON, or for an upload the file's own bytes as application/octet-stream; the browser adds the Origin. Each
// mutating request is recorded (net/frames.ts) when it leaves the page.

import { CHAT_ID, PROJECT_ID, UPLOAD_ID } from "../../shared/ids";
import type { ApiErrorCode } from "../../server/http/api-types";
import { recordFrame } from "./frames";

export type { ApiErrorCode };

/**
 * A refused or failed API call: its status, its error code and the server's fixed sentence. `lines`: a refusal that
 * names the lines of a request (D60's variables, E5: each line's index and a fixed code, never a value); else empty.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | "network",
    message: string,
    readonly lines: readonly { i: number; why: string }[] = [],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** The `lines` of an error answer: each with a whole index and a short code; anything else is left out. */
export function errorLines(err: unknown): { i: number; why: string }[] {
  const lines = (err as { lines?: unknown } | null)?.lines;
  if (!Array.isArray(lines)) return [];
  return lines.flatMap((l) => {
    const x = (l && typeof l === "object" ? l : {}) as { i?: unknown; why?: unknown };
    return Number.isInteger(x.i) && typeof x.why === "string" && /^[a-z_]{1,40}$/.test(x.why) ? [{ i: x.i as number, why: x.why }] : [];
  });
}

const NETWORK_LINE = "kitespan could not be reached.";

/**
 * The route pattern of an /api/ path for the record: ids become their parameter names; no value is kept. R130: a push
 * device's id (16 symbols, an upload id's shape) after /api/push/devices/ is `:device`.
 */
export function apiPattern(path: string): string {
  const bare = path.split("?")[0]!;
  const segs = bare.split("/");
  return segs
    .map((s, i) => (i === 4 && segs[1] === "api" && segs[2] === "push" && segs[3] === "devices" && UPLOAD_ID.test(s) ? ":device" : CHAT_ID.test(s) ? ":chat" : UPLOAD_ID.test(s) ? ":upload" : PROJECT_ID.test(s) ? ":project" : s))
    .join("/");
}

async function answer<T>(res: Response): Promise<T> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // not JSON (a 403 from a guard is plain text)
  }
  if (!res.ok) {
    const err = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    const code = typeof err?.code === "string" ? (err.code as ApiErrorCode) : res.status === 403 ? "bad_request" : "failed";
    const message = typeof err?.message === "string" ? err.message : "That did not work.";
    throw new ApiError(res.status, code, message, errorLines(err));
  }
  return body as T;
}

/**
 * A read: GET with no body. `sender`: the read also carries the sender gate's header, for a read that may start work on
 * the server (the new-chat form's command list, W19d; U5's message search), which a page on another site cannot send.
 * `signal`: the caller's AbortController, for a read that a newer one replaces (U5); an aborted read rejects with the
 * network's ApiError, so the caller checks its own signal first. A 204 (the server dropped the read for a newer one of
 * this tab) resolves null.
 */
export async function apiGet<T>(path: string, fetcher: typeof fetch = fetch, sender = false, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetcher(path, { method: "GET", headers: { accept: "application/json", ...(sender ? { "x-kitespan": "1" } : {}) }, cache: "no-store", ...(signal ? { signal } : {}) });
  } catch {
    throw new ApiError(0, "network", NETWORK_LINE);
  }
  return answer<T>(res);
}

/** A mutating call with a JSON body, behind the sender gate. Call it only inside a click, tap, key or submit handler. */
export async function apiSend<T>(method: "POST" | "PUT" | "DELETE", path: string, body: unknown = {}, fetcher: typeof fetch = fetch): Promise<T> {
  recordFrame(`${method} ${apiPattern(path)}`);
  let res: Response;
  try {
    res = await fetcher(path, {
      method,
      headers: { "x-kitespan": "1", "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, "network", NETWORK_LINE);
  }
  return answer<T>(res);
}

export interface UploadTarget {
  /** A chat's upload (`?chat=`), or the new-chat form's (`?project=`). */
  chat?: string;
  project?: string;
  /** Iteration 7: a file for the browser pane's chooser with no chat in reach (`?browser=1`, an upload owned by the browser). */
  browser?: boolean;
}

/**
 * Upload one file's bytes (POST /api/uploads, 4.3 and D37) with its progress, 0 to 1. XMLHttpRequest, because a
 * fetch reports no upload progress. Resolves with the server's reply; rejects with an ApiError.
 */
export function uploadBytes<T>(target: UploadTarget, file: Blob, name: string, type: string, onProgress: (p: number) => void): { done: Promise<T>; abort(): void } {
  const q = new URLSearchParams();
  if (target.chat) q.set("chat", target.chat);
  else if (target.project) q.set("project", target.project);
  else if (target.browser) q.set("browser", "1");
  if (name) q.set("name", name);
  if (type) q.set("type", type);
  recordFrame("POST /api/uploads");
  const xhr = new XMLHttpRequest();
  const done = new Promise<T>((resolve, reject) => {
    xhr.open("POST", `/api/uploads?${q.toString()}`);
    xhr.setRequestHeader("x-kitespan", "1");
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.responseType = "text";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(Math.min(1, e.loaded / e.total));
    };
    xhr.onerror = () => reject(new ApiError(0, "network", NETWORK_LINE));
    xhr.onabort = () => reject(new ApiError(0, "network", "The upload was stopped."));
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // not JSON
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1);
        resolve(body as T);
        return;
      }
      const err = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      reject(new ApiError(xhr.status, typeof err?.code === "string" ? (err.code as ApiErrorCode) : "failed", typeof err?.message === "string" ? err.message : "That file could not be uploaded."));
    };
    xhr.send(file);
  });
  return { done, abort: () => xhr.abort() };
}
