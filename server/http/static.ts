// The page and its built files (DESIGN.md 4.6 "Serving", 5.1 rule 1). `bun run build` writes the page and its hashed
// files into one folder (dist/web by default) and points the page at /assets/<name>. Only the app route families get
// the page; a missing file under /assets/ gets a 404, never the page. Hashed names are cached for a year as immutable,
// everything else revalidates, and a text file goes out gzipped when the browser accepts it (Bun.serve compresses
// nothing by itself). The page and every built file are read once, at start (4.10): a build under the running server
// (bin/update.sh) empties the folder and writes new names, and this server's page still gets the files it names.
// R130: the service worker (sw.js in the build folder) is served at /sw.js only, never under /assets/: a worker's scope
// is its script's folder, and kitespan's is `/`. It revalidates on every look (no-cache), as the browser's own update
// check of a worker expects.

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SERVICE_WORKER_FILE } from "../../shared/push";
import { acceptsGzip, contentSecurityPolicy, safeHeaders, textResponse, type SafeHeaders } from "./headers";

export const ASSET_PREFIX = "/assets/";

const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  // The web app manifest (FIX-U6): a browser processes it only under a JSON MIME type.
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};
const COMPRESSIBLE = new Set([".js", ".mjs", ".css", ".html", ".json", ".map", ".webmanifest", ".txt", ".svg"]);

/** A plain file name directly in the build folder: no folder, no dot file, no `..`. */
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;
/** Bun's content hash in a built name, for example `index-0ba8jk69.js`. */
export const HASHED_NAME = /-[a-z0-9]{8}\.[A-Za-z0-9]+$/;

export const IMMUTABLE = "public, max-age=31536000, immutable";

/** The built files kept in memory, in all (a build is about 1.4 MB); past it, the rest of the folder is not served. */
export const SITE_LIMITS = { bytes: 64 * 1024 * 1024 } as const;

export interface Site {
  /** False when the build folder has no page yet. */
  readonly built: boolean;
  readonly safe: SafeHeaders;
  /** The page, for a path of an app route family. */
  shell(req: Request): Response;
  /** A built file by its name under /assets/, or null when there is none. */
  asset(req: Request, name: string): Response | null;
  /** R130: the service worker for /sw.js, or null when the build has none. */
  worker(req: Request): Response | null;
  /** The server's 404 page (5.4, the last row): outside the app shell, with one link to Home. */
  notFound(): Response;
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i).toLowerCase() : "";
}

/** A name that /assets/ may serve: a plain built file, never the page itself, the service worker or a gzipped copy. */
function servable(name: string): boolean {
  return ASSET_NAME.test(name) && !name.includes("..") && name !== "index.html" && name !== SERVICE_WORKER_FILE && !name.endsWith(".gz");
}

/** A built file as it was at start; `gz` is made at its first gzipped answer. */
interface BuiltFile {
  body: Uint8Array<ArrayBuffer>;
  gz?: Uint8Array<ArrayBuffer>;
}

/** Every servable regular file of the build folder, in name order, up to SITE_LIMITS.bytes; none without a folder. */
function readBuilt(root: string): Map<string, BuiltFile> {
  const files = new Map<string, BuiltFile>();
  let names: string[];
  try {
    names = readdirSync(root).sort();
  } catch {
    return files;
  }
  let bytes = 0;
  for (const name of names) {
    if (!servable(name)) continue;
    try {
      const st = lstatSync(join(root, name));
      if (!st.isFile() || bytes + st.size > SITE_LIMITS.bytes) continue;
      const body = readFileSync(join(root, name));
      bytes += body.length;
      files.set(name, { body });
    } catch {
      // gone meanwhile, or unreadable: not served
    }
  }
  return files;
}

/** The build folder's service worker (a regular file), as it is at start; null when there is none. */
function readWorker(root: string): BuiltFile | null {
  try {
    const path = join(root, SERVICE_WORKER_FILE);
    const st = lstatSync(path);
    if (!st.isFile() || st.size > SITE_LIMITS.bytes) return null;
    return { body: readFileSync(path) };
  } catch {
    return null;
  }
}

/**
 * `dist` is the build folder; `origins` are the allowed origins (their sockets join connect-src). `worker`: the service
 * worker's script to serve instead of the build folder's sw.js (dev mode builds it at start).
 */
export function loadSite(dist: string, origins: readonly string[], opts: { worker?: Uint8Array } = {}): Site {
  const root = resolve(dist);
  const shellFile = join(root, "index.html");
  const built = existsSync(shellFile) && lstatSync(shellFile).isFile();
  const shellBody = built ? readFileSync(shellFile) : null;
  const shellText = shellBody?.toString("utf8") ?? "";
  const shellGz = shellBody ? Bun.gzipSync(shellBody, { level: 9 }) : null;
  // The page's inline script (it applies the stored look before the first paint) is allowed by its hash; the 404
  // page reuses it and the built style sheets, so it wears the user's look too.
  const inline = [...shellText.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  const styles = [...shellText.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/g)].map((m) => m[0]).join("");
  const safe = safeHeaders(contentSecurityPolicy(inline, origins));

  const notFoundHtml =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="color-scheme" content="light dark"><title>kitespan</title>${inline.map((code) => `<script>${code}</script>`).join("")}${styles}` +
    `<style>.nf{display:grid;place-items:center;min-height:100vh;padding:0 var(--s4,16px);font-size:var(--fs-prose);text-align:center}.nf a{color:var(--accent-text)}</style>` +
    `</head><body><main class="nf"><div><p>There is no kitespan page at this address.</p><p><a href="/">Go to Home</a></p></div></main></body></html>`;

  const files = readBuilt(root);
  const workerFile: BuiltFile | null = opts.worker ? { body: new Uint8Array(opts.worker) } : readWorker(root);

  return {
    built,
    safe,
    shell(req) {
      if (!shellBody) return textResponse(safe, "kitespan's page is not built. Run bun run build, then start kitespan again.\n", 503);
      // Iteration 7 (S1): the document rule answers some loads by their Sec-Fetch-Site (server/browser/guard.ts), so a
      // cache in front of a forward never gives one answer for the other.
      const headers = { ...safe.base, "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", vary: "accept-encoding, sec-fetch-site" };
      if (shellGz && acceptsGzip(req)) return new Response(shellGz, { headers: { ...headers, "content-encoding": "gzip" } });
      return new Response(shellBody, { headers });
    },
    asset(req, name) {
      const f = servable(name) ? files.get(name) : undefined;
      if (!f) return null;
      const ext = extOf(name);
      const headers: Record<string, string> = {
        ...safe.base,
        "content-type": TYPES[ext] ?? "application/octet-stream",
        "cache-control": HASHED_NAME.test(name) ? IMMUTABLE : "no-cache",
      };
      if (!COMPRESSIBLE.has(ext)) return new Response(f.body, { headers });
      headers.vary = "accept-encoding";
      if (!acceptsGzip(req)) return new Response(f.body, { headers });
      f.gz ??= Bun.gzipSync(f.body, { level: 9 });
      return new Response(f.gz, { headers: { ...headers, "content-encoding": "gzip" } });
    },
    worker(req) {
      if (!workerFile) return null;
      const headers: Record<string, string> = { ...safe.base, "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", vary: "accept-encoding" };
      if (!acceptsGzip(req)) return new Response(workerFile.body, { headers });
      workerFile.gz ??= Bun.gzipSync(workerFile.body, { level: 9 });
      return new Response(workerFile.gz, { headers: { ...headers, "content-encoding": "gzip" } });
    },
    notFound() {
      return new Response(notFoundHtml, { status: 404, headers: { ...safe.base, "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
    },
  };
}
