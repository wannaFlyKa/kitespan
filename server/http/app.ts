// The route table of the one Bun.serve (DESIGN.md 4.1, 5.1 rule 1). In order, for every request:
//
// 1. The Host allowlist (D52): a Host that is not the loopback host and port or an allowed origin's host gets 403.
// 2. /ws (the chat socket, 4.3), /ws/shell (the Terminal pane, D52) and /ws/browser (the browser pane, iteration 7):
//    an exact allowed Origin before the upgrade (guard 2); anything else gets 403 with no detail, and the log line holds
//    the route, never the Origin. /ws/browser also refuses Sec-Fetch-Site cross-site and same-site (DESIGN-B1 2.16
//    point 21).
// 3. /api/: the JSON API (api.ts), behind the sender gate on mutating routes and the Origin check on reads.
// 4. GET and HEAD only from here: /assets/<name> from the build folder, the service worker at /sw.js (R130), the page
//    for the app route families of shared/route.ts, and the 404 page for every other path. There is no catch-all route
//    that answers with the page. Iteration 7's document rule (S1): an app path for a load that another site started
//    (Sec-Fetch-Site cross-site or same-site) gets the fixed 403 page instead (server/browser/guard.ts).
// The peer check (DESIGN-B1 2.16 point 10): an upgrade, a mutating /api request or an app path whose TCP peer is a
// process of the shared browser gets 403, so kitespan's own page never runs inside the browser that Claude drives.

import type { ServerWebSocket, WebSocketHandler } from "bun";
import { WIRE } from "../../shared/protocol";
import { SERVICE_WORKER_PATH } from "../../shared/push";
import { isAppPath, routePattern } from "../../shared/route";
import { otherSite, selfRefused } from "../browser/guard";
import { hostPasses, MUTATING_METHODS, upgradeOriginPasses, type Gate } from "../gate/guards";
import type { Logger } from "../log";
import { API_ROUTE_PATTERNS, type Api } from "./api";
import { forbidden, textResponse } from "./headers";
import { ASSET_PREFIX, type Site } from "./static";

export const SOCKET_PATHS = [WIRE.path, WIRE.shellPath, WIRE.browserPath] as const;
export type SocketPath = (typeof SOCKET_PATHS)[number];

/** A socket as the route table hands it on: Bun's ServerWebSocket, whose data its route owns. */
export type AnySocket = ServerWebSocket<unknown>;

/** The part of Bun's Server that an upgrade uses. */
export interface Upgrader {
  upgrade(req: Request, options: { data: unknown }): boolean;
  /** Bun's server: the request's TCP peer (the peer check). */
  requestIP?(req: Request): { address: string; port: number } | null;
}

/**
 * A socket path's owner (the chat socket's and the Terminal pane's). The route table runs the Host and Origin guards
 * first; `upgrade` then upgrades the request (undefined) or answers it. One Bun.serve has one set of WebSocket
 * handlers, so each of these answers true only for a socket of its own route.
 */
export interface SocketRoute {
  upgrade(req: Request, server: Upgrader): Response | undefined;
  websocket: {
    open(ws: AnySocket): boolean;
    message(ws: AnySocket, message: string | Buffer): boolean;
    drain(ws: AnySocket): boolean;
    close(ws: AnySocket, code: number, reason: string): boolean;
  };
}

/** The data that plainSocketRoute gives a socket: its path, and a slot that the handlers own. */
export interface SocketData {
  route: SocketPath;
  state: unknown;
}
export type KitespanSocket = ServerWebSocket<SocketData>;

/** Plain Bun-style handlers for one path. */
export interface SocketHandlers {
  open(ws: KitespanSocket): void | Promise<void>;
  message(ws: KitespanSocket, message: string | Buffer): void | Promise<void>;
  close(ws: KitespanSocket, code: number, reason: string): void | Promise<void>;
  drain?(ws: KitespanSocket): void | Promise<void>;
}

/** A SocketRoute from plain handlers: the socket's data is `{route, state: null}`. A handler that throws is logged. */
export function plainSocketRoute(route: SocketPath, h: SocketHandlers, log?: Pick<Logger, "log"> | null): SocketRoute {
  const mine = (ws: AnySocket): ws is KitespanSocket => (ws.data as SocketData | null)?.route === route;
  const run = (fn: () => void | Promise<void>) => {
    try {
      const r = fn();
      if (r instanceof Promise) r.catch(() => log?.log("error", { route, err: "unknown" }));
    } catch {
      log?.log("error", { route, err: "unknown" });
    }
  };
  return {
    upgrade(req, server) {
      if (server.upgrade(req, { data: { route, state: null } satisfies SocketData })) return undefined;
      return new Response("Expected a WebSocket\n", { status: 426, headers: { "content-type": "text/plain; charset=utf-8" } });
    },
    websocket: {
      open: (ws) => mine(ws) && (run(() => h.open(ws)), true),
      message: (ws, m) => mine(ws) && (run(() => h.message(ws, m)), true),
      drain: (ws) => mine(ws) && (run(() => h.drain?.(ws)), true),
      close: (ws, code, reason) => mine(ws) && (run(() => h.close(ws, code, reason)), true),
    },
  };
}

export interface AppDeps {
  gate: Gate;
  site: Site;
  api: Api;
  sockets: Partial<Record<SocketPath, SocketRoute>>;
  logger?: Pick<Logger, "log"> | null;
  /** Iteration 7: whether a request's TCP peer is a process of the shared browser (server/browser/guard.ts PeerCheck). */
  peer?: { shared(peer: { address: string; port: number } | null): boolean } | null;
}

export interface App {
  fetch(req: Request, server: Upgrader): Promise<Response | undefined>;
  websocket: WebSocketHandler<unknown>;
}

/** Every pattern a log line of the HTTP layer may name (beyond the route table's and the sockets', which log.ts has). */
export const HTTP_LOG_ROUTES: readonly string[] = [...API_ROUTE_PATTERNS, `${ASSET_PREFIX}*`, SERVICE_WORKER_PATH];

const API_PATTERN_RES = API_ROUTE_PATTERNS.map(
  (p) => [p, new RegExp(`^${p.replace(/:[a-z]+/g, "[^/]+").replace("*", ".+")}$`)] as const,
);

/** The pattern of a path for a log line, never the path itself. */
export function logRouteOf(pathname: string): string | null {
  if ((SOCKET_PATHS as readonly string[]).includes(pathname)) return pathname;
  if (pathname.startsWith("/api/")) return API_PATTERN_RES.find(([, re]) => re.test(pathname))?.[0] ?? null;
  if (pathname.startsWith(ASSET_PREFIX)) return `${ASSET_PREFIX}*`;
  if (pathname === SERVICE_WORKER_PATH) return SERVICE_WORKER_PATH;
  return routePattern(pathname);
}

export function createApp(deps: AppDeps): App {
  const { gate, site, api, sockets } = deps;
  const log = deps.logger ?? null;
  const safe = site.safe;

  const refuse = (pathname: string): Response => {
    log?.log("origin_refused", { route: logRouteOf(pathname) });
    return forbidden(safe);
  };

  const routes = Object.values(sockets);
  /** Hand a socket event to the route that owns the socket; a route that throws is logged and never stops the server. */
  const each = (fn: (r: SocketRoute) => boolean): void => {
    for (const r of routes) {
      try {
        if (fn(r)) return;
      } catch {
        log?.log("error", { err: "unknown" });
        return;
      }
    }
  };

  return {
    async fetch(req, server) {
      let url: URL;
      try {
        url = new URL(req.url);
      } catch {
        return textResponse(safe, "Bad request\n", 400);
      }
      const path = url.pathname;
      if (!hostPasses(req, gate)) return refuse(path);
      /** The peer check, asked only where it applies (it reads /proc). */
      const fromShared = (): boolean => {
        if (!deps.peer) return false;
        let peer: { address: string; port: number } | null = null;
        try {
          peer = server.requestIP?.(req) ?? null;
        } catch {
          peer = null;
        }
        return deps.peer.shared(peer);
      };
      const selfRefuse = (route: string | null, page: boolean): Response => {
        log?.log("browser", { answer: "self_refused", route });
        return page ? selfRefused(req.method === "HEAD") : forbidden(safe);
      };

      if ((SOCKET_PATHS as readonly string[]).includes(path)) {
        const route = path as SocketPath;
        if (!sockets[route]) return site.notFound();
        if (req.method !== "GET") return textResponse(safe, "Method not allowed\n", 405, { allow: "GET" });
        if (!upgradeOriginPasses(req, gate)) return refuse(path);
        if (route === WIRE.browserPath && otherSite(req)) return refuse(path);
        if (fromShared()) return selfRefuse(route, false);
        const answer = sockets[route]!.upgrade(req, server);
        if (answer) for (const [k, v] of Object.entries(safe.base)) answer.headers.set(k, v);
        return answer;
      }

      if (path.startsWith("/api/")) {
        if (MUTATING_METHODS.has(req.method) && fromShared()) return selfRefuse(logRouteOf(path), false);
        try {
          return await api.handle(req, url);
        } catch {
          log?.log("error", { route: logRouteOf(path), err: "unknown" });
          return textResponse(safe, "Internal error\n", 500);
        }
      }

      // No OPTIONS answer and no CORS header: a page on another site gets no preflight through (guard 3).
      if (req.method !== "GET" && req.method !== "HEAD") return textResponse(safe, "Method not allowed\n", 405, { allow: "GET, HEAD" });
      if (path.startsWith(ASSET_PREFIX)) return site.asset(req, path.slice(ASSET_PREFIX.length)) ?? site.notFound();
      if (path === SERVICE_WORKER_PATH) return site.worker(req) ?? site.notFound();
      if (isAppPath(path)) {
        if (otherSite(req) || fromShared()) return selfRefuse(routePattern(path), true);
        return site.shell(req);
      }
      return site.notFound();
    },

    websocket: {
      maxPayloadLength: WIRE.maxPayloadBytes,
      idleTimeout: WIRE.idleTimeoutS,
      sendPings: true,
      backpressureLimit: WIRE.backpressureBytes,
      closeOnBackpressureLimit: true,
      perMessageDeflate: false,
      open: (ws) => each((r) => r.websocket.open(ws)),
      message: (ws, message) => each((r) => r.websocket.message(ws, message)),
      drain: (ws) => each((r) => r.websocket.drain(ws)),
      close: (ws, code, reason) => each((r) => r.websocket.close(ws, code, reason)),
    },
  };
}
