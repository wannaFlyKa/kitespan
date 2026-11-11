// The demo frame's first module (frame.tsx imports it before web/main.tsx; DESIGN-W1 4.1 to 4.3). ES modules run in
// import order, so all of this is done before the app's first module reads anything:
//
// - the frame's URL moves to its device's start route at the origin's root, where the app's router reads its paths;
// - the browser's WebSocket, fetch and XMLHttpRequest become the stand-ins of port.ts, over a MessageChannel to the
//   landing page that holds the frame (no request leaves the tab);
// - local and session storage are the frame's own, in memory (nothing is kept on the visitor's machine, also when the
//   frame is opened by itself and the app runs for a moment before it leaves), seeded with the landing page's theme
//   and, on the laptop, the split panel's share;
// - the phone frame acts as a phone (a coarse pointer and touch points), the laptop frame as a laptop;
// - the service worker and push are hidden, so Settings > Notifications says the demo's line and nothing registers;
// - while the device switch shows the other frame, nothing in this one takes the keyboard focus;
// - a link to the API (a download) and window.open go nowhere.
//
// This module imports nothing from web/ (test/unit/demo-bundle.test.ts reads its imports): it must run first.

import { DEMO_TAG, START_ROUTES, demoDevice } from "./lines";
import { FrameLink, demoFetch, demoWebSocketClass, demoXhrClass, type PortLike } from "./port";

const device = demoDevice(location.search);
/** The landing page, from the frame's own folder (demo/). */
const landing = new URL("../", location.href).href;

/** The frame's parent is a page of this site (same origin). */
function hosted(): boolean {
  try {
    return window.parent !== window && window.parent.location.origin === location.origin;
  } catch {
    return false;
  }
}

/** The landing page's theme now: its root's data-theme, else the device's (DESIGN-W1 4.6). */
function pageTheme(): "light" | "dark" | "system" {
  try {
    const t = window.parent.document.documentElement.getAttribute("data-theme");
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

/** A Storage in memory: the frame's own, for this page's life. */
class MemoryStorage {
  private readonly m = new Map<string, string>();
  get length(): number {
    return this.m.size;
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.m.get(String(k)) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(String(k), String(v));
  }
  removeItem(k: string): void {
    this.m.delete(String(k));
  }
  clear(): void {
    this.m.clear();
  }
}

/** A media query list whose answer is fixed (the pointer of the frame's device). */
function fixedQuery(media: string, matches: boolean) {
  return {
    matches,
    media,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  };
}

const define = (o: object, key: string, value: unknown) => Object.defineProperty(o, key, { value, configurable: true, writable: true });

/** The landing page shows the other frame now: this one's box is inert (site/page.ts). */
function notShown(): boolean {
  try {
    return !!window.frameElement?.closest("[inert]");
  } catch {
    return false;
  }
}

const isHosted = hosted();
let port: PortLike | null = null;

// Storage: each frame is its own device (its own tab id, look, theme and view), and nothing is kept, hosted or not.
const local = new MemoryStorage();
define(window, "localStorage", local);
define(window, "sessionStorage", new MemoryStorage());

if (isHosted) {
  // 1. The URL: the router reads location.pathname, and every action is a path at the root (/c/<chat>).
  history.replaceState(null, "", START_ROUTES[device]);

  // 2. The storage's seed: the landing page's theme, and the laptop's split share.
  local.setItem("kitespan.settings", JSON.stringify({ theme: pageTheme() }));
  if (device === "laptop") local.setItem("kitespan.view", JSON.stringify({ split: 0.62 }));

  // 3. The device: a phone has a coarse pointer and touch points, a laptop neither; full width, the real device.
  if (device !== "auto") {
    const coarse = device === "phone";
    const real = window.matchMedia.bind(window);
    define(window, "matchMedia", (q: string) => (/\(\s*(any-)?pointer\s*:\s*coarse\s*\)/.test(q) ? fixedQuery(q, coarse) : /\(\s*(any-)?pointer\s*:\s*fine\s*\)/.test(q) ? fixedQuery(q, !coarse) : real(q)));
    Object.defineProperty(navigator, "maxTouchPoints", { get: () => (coarse ? 5 : 0), configurable: true });
  }

  // 4. No service worker and no push: nothing registers, and Notifications says the demo's line.
  Object.defineProperty(navigator, "serviceWorker", { get: () => undefined, configurable: true });
  delete (window as unknown as { PushManager?: unknown }).PushManager;

  // 5. The network: the landing page's server, over this frame's own port.
  const ch = new MessageChannel();
  port = ch.port1 as unknown as PortLike;
  window.parent.postMessage({ [DEMO_TAG]: 1, device }, location.origin, [ch.port2]);

  // 6. The keyboard: the app focuses its own elements (a route's pane as it opens, the message box after a card's
  //    answer), and Chrome lets a script focus inside a frame whose box is inert; so while the other frame shows, an
  //    element's focus() does nothing here, and a focus that comes another way is let go of, with the landing page's
  //    own, so the keyboard stays where the visitor is.
  for (const proto of [globalThis.HTMLElement?.prototype, globalThis.SVGElement?.prototype]) {
    if (!proto) continue;
    const focus = proto.focus;
    define(proto, "focus", function (this: HTMLElement | SVGElement, options?: FocusOptions) {
      if (!notShown()) focus.call(this, options);
    });
  }
  document.addEventListener(
    "focusin",
    (e) => {
      if (!notShown()) return;
      (e.target as HTMLElement | null)?.blur?.();
      (window.frameElement as HTMLElement | null)?.blur();
    },
    true,
  );
}

/** The frame's link to the stand-in server (bridge.ts takes the landing page's theme from it). */
export const link = new FrameLink(port);
const base = () => location.href;
define(window, "WebSocket", demoWebSocketClass(link, base));
define(window, "fetch", demoFetch(link, base));
define(window, "XMLHttpRequest", demoXhrClass(link, base));
define(window, "open", () => null);

// A link to the API (a download, which the demo's build answers itself: swap/download.ts) never becomes a request.
document.addEventListener(
  "click",
  (e) => {
    const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
    if (!(a instanceof HTMLAnchorElement)) return;
    const u = new URL(a.href, location.href);
    if (u.origin === location.origin && u.pathname.startsWith("/api/")) e.preventDefault();
  },
  true,
);

// Opened by itself (no landing page around it), the frame goes to the landing page.
if (!isHosted) location.replace(landing);
