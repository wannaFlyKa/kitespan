// R130 (FIX-R130 1; DESIGN-R130 4.5, "The service worker"): kitespan's service worker. It handles two events and no
// other: `push`, which shows the notification that the server's payload names (shared/push.ts), and
// `notificationclick`, which opens the notification's path in a window of the app. It has no fetch, install or activate
// handler, keeps no cache and claims no page, so it changes nothing about how the page loads (still no offline page).
// Its scope is `/`: the server serves it at /sw.js (server/http/static.ts), built from web/sw.ts.
//
// The click only opens: it posts the path to a window of kitespan's own origin (the focused one, else a visible one,
// else the first), whose router opens it after the route decoder checks it again, and focuses that window; with none
// it opens a new one. A path that is not one of a push's (shared/push.ts isPushUrl) opens Home. The work starts before
// `waitUntil`, so a refused `waitUntil` (a synthetic event) or a refused `focus()` changes nothing.
//
// The types are the few this file uses, so it type-checks with the page's DOM library and runs in a worker.

import { PUSH_FALLBACK_TITLE, PUSH_ICON, isPushUrl, pushPayloadOf } from "../shared/push";

export interface WorkerNotification {
  readonly data?: unknown;
  close(): void;
}

export interface WorkerPushEvent {
  readonly data: { json(): unknown } | null;
  waitUntil(work: Promise<unknown>): void;
}

export interface WorkerClickEvent {
  readonly notification: WorkerNotification;
  waitUntil(work: Promise<unknown>): void;
}

export interface WorkerWindow {
  readonly url: string;
  readonly focused?: boolean;
  readonly visibilityState?: string;
  postMessage(message: unknown): void;
  focus(): Promise<unknown>;
}

export interface WorkerScope {
  addEventListener(type: "push", listener: (e: WorkerPushEvent) => void): void;
  addEventListener(type: "notificationclick", listener: (e: WorkerClickEvent) => void): void;
  readonly registration: { showNotification(title: string, options: Record<string, unknown>): Promise<void> };
  readonly clients: {
    matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<readonly WorkerWindow[]>;
    openWindow(url: string): Promise<unknown>;
  };
  readonly location: { readonly origin: string };
}

/** What a window of the app gets from a click: the path to open with its router. */
export interface WorkerOpenMessage {
  open: string;
}

/** Keep the worker alive for `work`, which has started already; a refusal (a synthetic event's) changes nothing. */
function hold(e: { waitUntil(work: Promise<unknown>): void }, work: Promise<unknown>): void {
  const settled = work.catch(() => {});
  try {
    e.waitUntil(settled);
  } catch {
    // not a trusted event: the work runs anyway
  }
}

/** Show the push's notification, or "kitespan" opening Home for a push that this worker cannot read. */
export function showPush(scope: WorkerScope, e: WorkerPushEvent): Promise<void> {
  let data: unknown = null;
  try {
    data = e.data ? e.data.json() : null;
  } catch {
    data = null;
  }
  const p = pushPayloadOf(data);
  if (!p) return scope.registration.showNotification(PUSH_FALLBACK_TITLE, { icon: PUSH_ICON, data: { url: "/" } });
  return scope.registration.showNotification(p.title, { body: p.body, tag: p.tag, renotify: true, icon: PUSH_ICON, data: { url: p.url } });
}

/** Open `path` in a window of the app: post it to one (and focus it), else open a new window. */
export async function openPath(scope: WorkerScope, path: string): Promise<"posted" | "opened" | "none"> {
  const all = await scope.clients.matchAll({ type: "window", includeUncontrolled: true });
  const own = all.filter((c) => {
    try {
      return new URL(c.url).origin === scope.location.origin;
    } catch {
      return false;
    }
  });
  const pick = own.find((c) => c.focused) ?? own.find((c) => c.visibilityState === "visible") ?? own[0];
  if (pick) {
    pick.postMessage({ open: path } satisfies WorkerOpenMessage);
    try {
      await pick.focus();
    } catch {
      // a focus that the browser refused: the window opens the path all the same
    }
    return "posted";
  }
  try {
    await scope.clients.openWindow(path);
    return "opened";
  } catch {
    return "none";
  }
}

/** The worker's two handlers, on its own scope. */
export function installWorker(scope: WorkerScope): void {
  scope.addEventListener("push", (e) => hold(e, showPush(scope, e)));
  scope.addEventListener("notificationclick", (e) => {
    e.notification.close();
    const url = (e.notification.data as { url?: unknown } | null | undefined)?.url;
    hold(e, openPath(scope, isPushUrl(url) ? url : "/"));
  });
}
