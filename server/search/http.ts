// The corpus routes' answers (DESIGN.md 9.3; build checklist B4). The list answer is the one large JSON body of the
// API, so it is gzipped by hand (Bun.serve does not compress a Response), with the body made once per build and off
// the event loop (cache.ts listBody); it carries the same safe headers as every other answer (headers.ts guard 9),
// never cached, and varies by Accept-Encoding. The search answer is small and goes through jsonResponse.

import { fitsPage, type CorpusLimit, type CorpusListReply, type CorpusSameReply } from "../../shared/corpus";
import { acceptsGzip, jsonResponse, type SafeHeaders } from "../http/headers";
import type { CorpusBuild } from "./cache";

/**
 * GET /api/chats/:chat/corpus: `{v, same: true}` when the page's `v` is the build's; else the build, with its paths
 * when they fit the page's limit (its paths, its characters on touch, and 16 MiB of JSON), and `paths: null` when not.
 */
export async function corpusListResponse(safe: SafeHeaders, req: Request, build: CorpusBuild, query: { limit: CorpusLimit; v: string | null }, head = false): Promise<Response> {
  const vary = { vary: "accept-encoding" };
  if (query.v !== null && query.v === build.v) return jsonResponse(safe, { v: build.v, same: true } satisfies CorpusSameReply, 200, vary);
  const cheap = fitsPage({ total: build.total, chars: build.chars, jsonBytes: 0 }, query.limit);
  const body = cheap ? await build.listBody() : null;
  if (!body || body.gzip === null || !fitsPage({ total: build.total, chars: build.chars, jsonBytes: body.jsonBytes }, query.limit)) {
    return jsonResponse(safe, { ...build.listReply(), paths: null } satisfies CorpusListReply, 200, vary);
  }
  const headers: Record<string, string> = { ...safe.base, "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...vary };
  // No gzip asked (the page always asks): the JSON is made again, in steps, and not kept.
  if (!acceptsGzip(req)) return new Response(head ? null : await build.listJson(), { headers });
  headers["content-encoding"] = "gzip";
  headers["content-length"] = String(body.gzip.byteLength);
  return new Response(head ? null : body.gzip, { headers });
}

/** A search whose page went away (the request was aborted): nothing to read, and nothing to log. */
export function abortedResponse(safe: SafeHeaders): Response {
  return new Response(null, { status: 204, headers: { ...safe.base, "cache-control": "no-store" } });
}
