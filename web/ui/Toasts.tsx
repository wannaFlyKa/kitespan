// The toast host (DESIGN.md 6.3, the Toast row): Claude Code's notifications in a small panel at the top right of the
// page, under the header. One toast at a time, the highest priority first (the oldest first within a priority); it
// closes after its time (8 s when the message gives none) or on its close button, and waits while the pointer or the
// focus is on it. Screen readers hear it as a polite live region. A toast is live state: no URL, no transcript row,
// and closing one is not a recorded action. App renders this once.
// T-21 (iteration 8): a finger's enter and leave last only its press, so on touch a tap holds the toast instead, until
// its Close or a second tap.
import { useEffect, useState, type PointerEvent } from "react";
import type { Route } from "../router";
import { act, useStore } from "../state/store";
import type { Toast } from "../state/types";
import { IconClose } from "./icons";

export const TOAST_MS = 8000;
const RANK: Record<Toast["priority"], number> = { immediate: 3, high: 2, medium: 1, low: 0 };

/** What holds a toast open: a mouse or a pen over it, the focus inside it, or a tap on touch. */
export interface ToastHold {
  pointer: boolean;
  focus: boolean;
  tap: boolean;
}
export const NO_HOLD: ToastHold = { pointer: false, focus: false, tap: false };
export const toastHeld = (h: ToastHold) => h.pointer || h.focus || h.tap;

/**
 * The hold after a pointer event on the toast: a mouse's or a pen's enter and leave hold it while it is over the toast;
 * a finger's do nothing, and its press turns the tap's hold on, or off again.
 */
export function pointerHold(h: ToastHold, kind: "enter" | "leave" | "down", pointerType: string): ToastHold {
  if (pointerType === "touch") return kind === "down" ? { ...h, tap: !h.tap } : h;
  if (kind === "down") return h;
  return { ...h, pointer: kind === "enter" };
}

/** The toast to show on a screen: the open chat's own toasts and those of no chat, the highest priority first. */
export function pickToast(toasts: readonly Toast[], chatId: string | undefined): Toast | null {
  let best: Toast | null = null;
  for (const t of toasts) {
    if (t.chatId !== undefined && t.chatId !== chatId) continue;
    if (!best || RANK[t.priority] > RANK[best.priority]) best = t;
  }
  return best;
}

export function Toasts({ route }: { route: Route }) {
  const toasts = useStore((s) => s.toasts);
  const toast = pickToast(toasts, route.params.chat);
  const [hold, setHold] = useState<ToastHold>(NO_HOLD);
  const held = toastHeld(hold);
  const id = toast?.id;
  const ms = toast ? toast.timeoutMs ?? TOAST_MS : 0;
  const on = (kind: "enter" | "leave" | "down") => (e: PointerEvent) => setHold((h) => pointerHold(h, kind, e.pointerType));

  useEffect(() => setHold(NO_HOLD), [id]);
  useEffect(() => {
    if (!id || held) return;
    const t = setTimeout(() => act.closeToast(id), ms);
    return () => clearTimeout(t);
  }, [id, ms, held]);

  return (
    <div className="toasts" role="status" aria-live="polite" data-testid="toasts">
      {toast ? (
        <div
          key={toast.id}
          className="toast"
          data-testid="toast"
          data-priority={toast.priority}
          data-held={held ? "" : undefined}
          onPointerEnter={on("enter")}
          onPointerLeave={on("leave")}
          onPointerDown={on("down")}
          onFocus={() => setHold((h) => ({ ...h, focus: true }))}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHold((h) => ({ ...h, focus: false }));
          }}
        >
          <p className="toast-text">{toast.text}</p>
          <button type="button" className="icon-btn toast-close" aria-label="Close" title="Close" onClick={() => act.closeToast(toast.id)}>
            <IconClose size={14} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
