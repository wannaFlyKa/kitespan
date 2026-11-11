// The page's side of the service worker (DESIGN-R130 4.2 and 4.5): the worker itself (sw.js: push and
// notificationclick only, no fetch handler, no cache) is registered only when this device turns notifications on
// (device.ts). Here:
//   - a notification's click: the worker posts `{open: path}` to a window of the app; the page opens that path with
//     its router once it passes the push's own path rule (shared/push.ts isPushUrl) and the route decoder: a chat, a
//     waiting card's own path, a background session's view, or Home for a push the worker could not read. It only
//     opens: the card's route focuses the card and acts on nothing (5.2);
//   - once seen, on this device: when the page reports a chat on screen (net/onScreen.ts), its own notifications of
//     that chat (tag `c:<chat>`; a background session's `c:<chat>:bg:<id>`) are closed. Other devices keep theirs: a
//     push that shows nothing is not allowed, so the server cannot take one back.
// Neither registers anything: with no registration there is nothing to read or close.
import { isPushUrl, pushTag } from "../../shared/push";
import { parsePath } from "../../shared/route";

/** The routes a notification may open: Home, the chat, its waiting cards, a background session's view. */
export const OPEN_ROUTES: ReadonlySet<string> = new Set(["home", "chat", "permission", "question", "plan", "elicitation", "dialog", "background"]);

/** The path a worker's message asks to open, or null when it is not one a notification may open. */
export function openPathOf(data: unknown): string | null {
  const path = data && typeof data === "object" ? (data as { open?: unknown }).open : undefined;
  if (!isPushUrl(path)) return null;
  const r = parsePath(path);
  if (r.fallbackFrom || !OPEN_ROUTES.has(r.name)) return null;
  return path;
}

/** The tag of a chat's notifications, or of a background session's (the server's own, shared/push.ts). */
export function notificationTag(chat: string, background?: string): string {
  return pushTag(chat, background);
}

interface WorkerContainer {
  addEventListener(type: "message", fn: (e: { data: unknown; origin?: string }) => void): void;
  startMessages?(): void;
  getRegistration(scope?: string): Promise<{ getNotifications?(o?: { tag?: string }): Promise<{ close(): void }[]> } | undefined>;
}

function container(): WorkerContainer | null {
  if (typeof navigator === "undefined") return null;
  return ((navigator as unknown as { serviceWorker?: WorkerContainer }).serviceWorker ?? null) as WorkerContainer | null;
}

/** Listen for the worker's `{open: path}`, for the page's life. `go` is the router's navigate. */
export function listenForOpen(go: (path: string) => void, sw: WorkerContainer | null = container()): void {
  if (!sw) return;
  sw.addEventListener("message", (e) => {
    if (typeof location !== "undefined" && e.origin && e.origin !== location.origin) return;
    const path = openPathOf(e.data);
    if (path) go(path);
  });
  // Messages wait until the page says it listens (a page that loaded from the click gets its path then).
  sw.startMessages?.();
}

/** Close this device's shown notifications with this tag. Nothing when no worker is registered. */
export async function closeShown(tag: string, sw: WorkerContainer | null = container()): Promise<number> {
  if (!sw) return 0;
  try {
    const reg = await sw.getRegistration("/");
    if (!reg?.getNotifications) return 0;
    const shown = await reg.getNotifications({ tag });
    for (const n of shown) n.close();
    return shown.length;
  } catch {
    return 0;
  }
}
