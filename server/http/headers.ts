// The headers every response carries (DESIGN.md 4.9 guard 9), and the small response helpers of the HTTP layer. A
// page that cannot be framed cannot trick a tap on a button that a link pre-filled, and no query string leaves in a
// Referer header. No response carries an Access-Control-Allow-Origin header (guard 3).

import { createHash } from "node:crypto";

/** The Content-Security-Policy: kitespan's own origin only, the shell's inline scripts by hash, no framing. */
export function contentSecurityPolicy(inlineScripts: readonly string[], origins: readonly string[]): string {
  const hashes = inlineScripts.map((code) => `'sha256-${createHash("sha256").update(code, "utf8").digest("base64")}'`);
  // 'self' covers the page's own ws: origin in current browsers; the explicit ws origins cover the rest, and each
  // allowed remote origin's socket. A CSP source cannot name an IPv6 literal (the browser drops it with a console
  // error), so [::1] has none: a page there reaches its own socket through 'self'.
  const sockets = origins.filter((o) => !o.includes("[")).map((o) => o.replace(/^http(s?):/, "ws$1:"));
  return [
    "default-src 'self'",
    `script-src ${["'self'", ...hashes].join(" ")}`,
    "style-src 'self' 'unsafe-inline'", // React writes style attributes
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${["'self'", ...sockets].join(" ")}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export interface SafeHeaders {
  readonly csp: string;
  /** The guard 9 set, to spread into a response's headers. */
  readonly base: Readonly<Record<string, string>>;
}

export function safeHeaders(csp: string): SafeHeaders {
  return { csp, base: { "content-security-policy": csp, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } };
}

/** A short plain-text answer that no cache keeps. */
export function textResponse(safe: SafeHeaders, body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { ...safe.base, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

/** A JSON answer of the API: never cached, never sniffed. */
export function jsonResponse(safe: SafeHeaders, body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...safe.base, "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

/** A refusal by a guard: 403 with no detail (4.9 guard 2). */
export function forbidden(safe: SafeHeaders): Response {
  return textResponse(safe, "Forbidden\n", 403);
}

/** True when the request accepts a gzip body (RFC 9110 Accept-Encoding, with q=0 as a refusal). */
export function acceptsGzip(req: Request): boolean {
  const header = req.headers.get("accept-encoding");
  if (!header) return false;
  let gzip: number | null = null;
  let star: number | null = null;
  for (const part of header.split(",")) {
    const [token, ...params] = part.trim().toLowerCase().split(";");
    const qParam = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    const q = qParam ? Number(qParam.slice(2)) : 1;
    const weight = Number.isFinite(q) ? q : 0;
    if (token === "gzip" || token === "x-gzip") gzip = weight;
    else if (token === "*") star = weight;
  }
  return (gzip ?? star ?? 0) > 0;
}
