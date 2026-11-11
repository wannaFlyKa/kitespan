// Whether this browser can get kitespan's notifications (DESIGN-R130 2.1 and 4.5), read from what the browser has,
// never from the User-Agent, and in this order:
//   1. a secure context: HTTPS, or 127.0.0.1 and localhost (an `ssh -L` forward). Tested first, because on an insecure
//      origin Chrome reports the permission as denied, which would give the wrong line;
//   2. a service worker, PushManager, Notification and showNotification (iOS and iPadOS give them only to a web app on
//      the Home Screen; the phone's company browser has none);
//   3. the permission, unless the user blocked it (a page cannot ask again then).
// Reading it asks nothing and registers nothing.
import { NOTIFY_WORDS } from "./words";

export type NotifyGate = "insecure" | "unsupported" | "denied" | "ok";

export interface NotifyEnv {
  secure: boolean;
  serviceWorker: boolean;
  pushManager: boolean;
  notification: boolean;
  showNotification: boolean;
  /** Notification.permission, or null with no Notification. */
  permission: "default" | "granted" | "denied" | null;
}

/** What this browser has (a missing global reads as missing). */
export function readEnv(w: unknown = globalThis): NotifyEnv {
  const g = (w ?? {}) as {
    isSecureContext?: boolean;
    navigator?: { serviceWorker?: unknown };
    PushManager?: unknown;
    Notification?: { permission?: string };
    ServiceWorkerRegistration?: { prototype?: object };
  };
  const proto = g.ServiceWorkerRegistration?.prototype;
  const p = g.Notification?.permission;
  return {
    secure: g.isSecureContext === true,
    serviceWorker: !!g.navigator?.serviceWorker,
    pushManager: typeof g.PushManager === "function",
    notification: typeof g.Notification === "function",
    showNotification: !!proto && "showNotification" in proto,
    permission: p === "default" || p === "granted" || p === "denied" ? p : null,
  };
}

export function gateOf(env: NotifyEnv): NotifyGate {
  if (!env.secure) return "insecure";
  if (!env.serviceWorker || !env.pushManager || !env.notification || !env.showNotification) return "unsupported";
  if (env.permission === "denied") return "denied";
  return "ok";
}

/**
 * Whether the section lists the devices that have notifications on: wherever this browser could be a device (it can
 * get them, its permission is blocked, or the origin is not secure), so that another device can be seen and turned
 * off from here. A browser with no push (the phone's company browser) gets its line and nothing more.
 */
export function listsDevices(gate: NotifyGate): boolean {
  return gate !== "unsupported";
}

/** The first row's one line for a gate that leaves no switch. */
export function gateLine(gate: NotifyGate): string | null {
  if (gate === "insecure") return NOTIFY_WORDS.insecure;
  if (gate === "unsupported") return NOTIFY_WORDS.unsupported;
  if (gate === "denied") return NOTIFY_WORDS.denied;
  return null;
}
