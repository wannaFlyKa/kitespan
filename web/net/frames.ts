// The page's record of what it sends that can change something (DESIGN.md 8.4, principle 3: a link never acts by
// itself). Every mutating frame on /ws and every mutating /api/ request is pushed into window.__kitespanFrames when it
// first leaves the page, so the click-through can prove that opening a URL sends nothing until a click, a tap, a key
// press or a submit. hello, ping, attach, detach and get read only and are not recorded, and neither is on_screen, the
// view's report of a chat on screen (row 116: seen is not an action, so a link that opens a chat sends it with no
// click), nor a resend of a request after a reconnect (the same request, with the same rid).

export interface FrameRecord {
  /** A /ws frame's `t`, or for the JSON API the method and the route pattern, for example `POST /api/settings`. */
  t: string;
  at: number;
}

declare global {
  interface Window {
    __kitespanFrames?: FrameRecord[];
  }
}

/** The client frames that change nothing the user made (4.3, 8.4): reads, and the view's reports (row 116). */
export const READ_ONLY_FRAMES: ReadonlySet<string> = new Set(["hello", "ping", "attach", "detach", "get", "on_screen"]);

export function isMutatingFrame(t: string): boolean {
  return !READ_ONLY_FRAMES.has(t);
}

/** Note one mutating frame or request. Outside a browser (a unit test with no window) it does nothing. */
export function recordFrame(t: string): void {
  if (typeof window === "undefined") return;
  (window.__kitespanFrames ??= []).push({ t, at: Date.now() });
}

/** A lowercase random UUID (version 4) from getRandomValues, which works on a plain-http origin too. */
export function newUuid(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const TAB_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

/** A new tab id (the `hello` frame's `tab`): 22 symbols of [A-Za-z0-9_-]. */
export function newTabId(): string {
  const b = new Uint8Array(22);
  crypto.getRandomValues(b);
  return [...b].map((x) => TAB_CHARS[x & 63]).join("");
}
