// The request guards (DESIGN.md 4.9 guards 2 and 3, BUILD-BRIEF D52). Every check compares exact strings from one
// allowlist: kitespan's own loopback origins on its port (`http://127.0.0.1:<port>`, `http://localhost:<port>` and
// `http://[::1]:<port>`: only kitespan itself serves pages there) and the exact origins of the access adapter (4.8),
// for example a Cloudflare Tunnel hostname, a Tailscale Serve name or another local port of an ssh -L forward. There
// is no suffix rule and no pattern. A refusal is a plain 403 with no detail, and nothing here logs or returns the value
// of an Origin or a Host header.
//
// - The Host allowlist (D52, DNS rebinding) runs on every HTTP request and upgrade: the Host header must be a
//   loopback name with kitespan's own port (127.0.0.1, localhost or [::1]: a forwarder that targets localhost sends
//   that), or the host of an allowed origin. A page on another site whose name resolves to 127.0.0.1 sends its own
//   name as the Host, so it reads nothing.
// - The Origin allowlist runs on every WebSocket upgrade (a missing Origin is refused) and on every mutating request
//   (a missing Origin is refused). A GET or HEAD read that carries an Origin must carry an allowed one (D52).
// - The sender gate (guard 3) on every POST, PUT and DELETE under /api/: the header `x-kitespan: 1`, the body type the
//   route takes, and an allowed Origin. kitespan answers no OPTIONS request and sends no Access-Control-Allow-Origin
//   header, so a page on another site cannot send that header or a non-safelisted body type. For one release the old
//   name's header passes too (senderHeader).

import { LEGACY_HEADER } from "../../shared/legacy";

export interface Gate {
  /** The allowed origins: kitespan's own loopback origins first (127.0.0.1, localhost, [::1]), then the adapter's. */
  readonly origins: readonly string[];
  /** The allowed Host header values, lowercase: the loopback names with the port, then each allowed origin's host. */
  readonly hosts: readonly string[];
  originAllowed(origin: string | null): boolean;
  hostAllowed(host: string | null): boolean;
}

/** kitespan's own origin: the loopback address with the port, compared in full (4.8, the public default). */
export function ownOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** The Host header value a browser sends for an origin: the host, with the port when it is not the default. */
function hostOf(origin: string): string | null {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return null;
  }
}

/** `extra` holds origins that the access adapter already checked (server/adapters/adapters.ts, isExactOrigin). */
export function createGate(port: number, extra: readonly string[] = []): Gate {
  const loopback = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  const origins = [...new Set([ownOrigin(port), ...loopback.slice(1).map((h) => `http://${h}`), ...extra])];
  const hosts = [...new Set([...loopback, ...origins.map(hostOf).filter((h): h is string => h !== null)])];
  const originSet = new Set(origins);
  const hostSet = new Set(hosts);
  return {
    origins,
    hosts,
    originAllowed: (origin) => origin !== null && originSet.has(origin),
    hostAllowed: (host) => host !== null && hostSet.has(host.toLowerCase()),
  };
}

/** What a mutating route takes as its body: JSON, or the raw bytes of one uploaded file. */
export type BodyKind = "json" | "bytes";

const BODY_TYPES: Record<BodyKind, string> = {
  json: "application/json",
  // Not a CORS-safelisted type either, so a cross-site page cannot send it without a preflight that kitespan never
  // answers. An upload carries the file's bytes as they are; its JSON would be a third larger as base64.
  bytes: "application/octet-stream",
};

/** The media type of a Content-Type header, lowercase, without its parameters. */
export function mediaType(header: string | null): string | null {
  if (header === null) return null;
  const t = header.split(";")[0]!.trim().toLowerCase();
  return t || null;
}

export const MUTATING_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "DELETE", "PATCH"]);

/** D52: the Host allowlist for every request. */
export function hostPasses(req: Request, gate: Gate): boolean {
  return gate.hostAllowed(req.headers.get("host"));
}

/** D52: a GET or HEAD read passes when it has no Origin or an allowed one. */
export function readOriginPasses(req: Request, gate: Gate): boolean {
  const origin = req.headers.get("origin");
  return origin === null || gate.originAllowed(origin);
}

/** Guard 2: an upgrade needs an allowed Origin; a missing Origin and `null` are refused. */
export function upgradeOriginPasses(req: Request, gate: Gate): boolean {
  return gate.originAllowed(req.headers.get("origin"));
}

/**
 * The sender header, `x-kitespan: 1`, which a page on another site cannot send. For one release the old name's header
 * (shared/legacy.ts) passes too: a page loaded before the restart sends it until it reloads.
 */
export function senderHeader(headers: Headers): boolean {
  return headers.get("x-kitespan") === "1" || headers.get(LEGACY_HEADER) === "1";
}

/** Guard 3: the sender gate of a mutating /api/ route. */
export function senderPasses(req: Request, gate: Gate, body: BodyKind): boolean {
  return (
    MUTATING_METHODS.has(req.method) &&
    senderHeader(req.headers) &&
    mediaType(req.headers.get("content-type")) === BODY_TYPES[body] &&
    gate.originAllowed(req.headers.get("origin"))
  );
}
