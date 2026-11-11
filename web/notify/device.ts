// Turning notifications on and off for this device (DESIGN-R130 4.5), with the browser's parts injected, so a test
// gives fakes and can see the order. On, only from the user's own tap (the switch, or the Save that a link's value=on
// shows):
//   1. Notification.requestPermission(), first, with nothing awaited before it (iOS asks only from a tap);
//   2. granted goes on; denied gives the denied line; default (the prompt was dismissed) leaves the switch off, with
//      no line;
//   3. the service worker: register("/sw.js", {scope: "/", updateViaCache: "none"}), then ready. The page registers
//      it only here, so nothing of kitespan stays in a browser that never turned notifications on;
//   4. the server's public key: from the section's read, else POST /api/push/key, which makes it the first time;
//   5. pushManager.subscribe({userVisibleOnly: true, applicationServerKey}): the permission is granted now, so WebKit
//      and Chrome need no gesture here. An older subscription of this browser goes first: it is not one of the
//      server's devices (that is why the switch was off), so its endpoint may be gone at its push service;
//   6. POST /api/push/devices with subscription.toJSON() and the default name.
// A failure at 5 gives the push service's line, at 6 the server's (a push service off the server's list has its
// own); either way the subscription and the registration go again, so a failed turn-on leaves nothing behind.
// Off for this device: unsubscribe(), POST .../remove, then unregister(), so nothing of kitespan stays in the browser.
// The browser's permission stays as the user set it.
import { ApiError } from "../net/api";
import { PUSH_SERVICE_CODE, type PushApi, type PushDevice, type SubscriptionJson } from "./api";
import { deviceIdOf } from "./names";
import { NOTIFY_WORDS } from "./words";

export type Permission = "default" | "granted" | "denied";

export interface SubscriptionLike {
  endpoint: string;
  toJSON(): { endpoint?: string; keys?: Record<string, string> };
  unsubscribe(): Promise<boolean>;
}

export interface RegistrationLike {
  pushManager: {
    getSubscription(): Promise<SubscriptionLike | null>;
    subscribe(options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }): Promise<SubscriptionLike>;
  };
  unregister(): Promise<boolean>;
}

export interface PushBrowser {
  /** Notification.requestPermission(): the call happens before this returns (inside the tap). */
  requestPermission(): Promise<Permission>;
  /** The registration whose scope is "/", or null: it reads and registers nothing. */
  registration(): Promise<RegistrationLike | null>;
  /** Register /sw.js for "/" and wait until it is ready. */
  register(): Promise<RegistrationLike>;
}

export type TurnOn =
  | { ok: true; device: PushDevice; key: string }
  | { ok: false; why: "denied" | "dismissed" | "unreached" | "off_list" | "server"; line: string | null };

/** base64url (no padding) to bytes; null when it is not. */
export function fromB64u(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const t = s.replace(/-/g, "+").replace(/_/g, "/");
    return Uint8Array.from(atob(t + "=".repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** The subscription as the server takes it, or null when the browser gave no keys. */
export function subscriptionJson(sub: SubscriptionLike): SubscriptionJson | null {
  const j = sub.toJSON();
  const p256dh = j.keys?.p256dh;
  const auth = j.keys?.auth;
  const endpoint = typeof j.endpoint === "string" ? j.endpoint : sub.endpoint;
  if (typeof endpoint !== "string" || typeof p256dh !== "string" || typeof auth !== "string") return null;
  return { endpoint, keys: { p256dh, auth } };
}

const lineOf = (e: unknown) => (e instanceof ApiError ? e.message : NOTIFY_WORDS.unreached);

export interface TurnOnDeps {
  browser: PushBrowser;
  api: PushApi;
  /** The key from the section's read, if the server has one. */
  key: string | null;
  /** The default name for the subscription's endpoint (names.ts defaultName). */
  name(endpoint: string): string;
}

/** Turn this device on. Call it inside the user's tap: its first act is the permission prompt. */
export function turnOn(d: TurnOnDeps): Promise<TurnOn> {
  // Nothing is awaited before the prompt.
  const asked = d.browser.requestPermission();
  return (async (): Promise<TurnOn> => {
    const permission = await asked.catch((): Permission => "default");
    if (permission === "denied") return { ok: false, why: "denied", line: NOTIFY_WORDS.denied };
    if (permission !== "granted") return { ok: false, why: "dismissed", line: null };
    let reg: RegistrationLike;
    try {
      reg = await d.browser.register();
    } catch {
      return { ok: false, why: "unreached", line: NOTIFY_WORDS.unreached };
    }
    const undo = async (sub: SubscriptionLike | null) => {
      if (sub) await sub.unsubscribe().catch(() => false);
      await reg.unregister().catch(() => false);
    };
    let key = d.key;
    if (!key) {
      try {
        key = await d.api.makeKey();
      } catch (e) {
        await undo(null);
        return { ok: false, why: "server", line: lineOf(e) };
      }
    }
    const keyBytes = fromB64u(key);
    if (!keyBytes) {
      await undo(null);
      return { ok: false, why: "server", line: NOTIFY_WORDS.unreached };
    }
    let sub: SubscriptionLike;
    try {
      const old = await reg.pushManager.getSubscription();
      if (old) await old.unsubscribe().catch(() => false);
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes });
    } catch {
      await undo(null);
      return { ok: false, why: "unreached", line: NOTIFY_WORDS.unreached };
    }
    const json = subscriptionJson(sub);
    if (!json) {
      await undo(sub);
      return { ok: false, why: "unreached", line: NOTIFY_WORDS.unreached };
    }
    try {
      const device = await d.api.add(json, d.name(json.endpoint));
      return { ok: true, device, key };
    } catch (e) {
      await undo(sub);
      if (e instanceof ApiError && e.code === PUSH_SERVICE_CODE) return { ok: false, why: "off_list", line: NOTIFY_WORDS.offList };
      return { ok: false, why: "server", line: lineOf(e) };
    }
  })();
}

/** This browser's subscription now, and the server's id for it (null with none). */
export async function readThisDevice(browser: PushBrowser): Promise<{ id: string | null; endpoint: string | null }> {
  const reg = await browser.registration().catch(() => null);
  const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
  return sub ? { id: await deviceIdOf(sub.endpoint), endpoint: sub.endpoint } : { id: null, endpoint: null };
}

/**
 * Turn this device off: its subscription goes, then its device on the server (`id`, when the server has it), then
 * the registration. Resolves to the server's line when the remove failed, else null. A remove that answers 404 found
 * the device gone already (a push service's 404 or 410 removed it since the read), so this device is off: no line.
 */
export async function turnOffThis(d: { browser: PushBrowser; api: PushApi; id: string | null }): Promise<string | null> {
  const reg = await d.browser.registration().catch(() => null);
  const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
  if (sub) await sub.unsubscribe().catch(() => false);
  let line: string | null = null;
  if (d.id) {
    try {
      await d.api.remove(d.id);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) line = lineOf(e);
    }
  }
  if (reg) await reg.unregister().catch(() => false);
  return line;
}

/** The browser's own parts. */
export function realBrowser(): PushBrowser {
  return {
    requestPermission: () =>
      new Promise<Permission>((resolve) => {
        const N = globalThis.Notification;
        // The older form takes a callback and returns nothing; the newer returns a promise.
        const p = N.requestPermission((v) => resolve(v));
        if (p && typeof p.then === "function") p.then(resolve, () => resolve("default"));
      }),
    registration: async () => ((await navigator.serviceWorker.getRegistration("/")) as unknown as RegistrationLike | undefined) ?? null,
    register: async () => {
      await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
      return (await navigator.serviceWorker.ready) as unknown as RegistrationLike;
    },
  };
}
