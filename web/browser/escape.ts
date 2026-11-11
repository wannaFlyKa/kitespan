// Esc inside the Browser (DESIGN-B1 4.1, 4.3, 4.5, 4.6): over the chat the pane is a layer, and the layer's Esc runs
// before any element's own key handler (ui/primitives.tsx). So the parts that own Esc while they hold the focus (the
// frame, which passes it to the page; a dialog card, whose Esc is Cancel; a file card; a picker; More; the address
// field, which puts the tab's address back) register here, and the layer's close asks them first: the newest part that
// takes it wins, and only when none does does the layer close.
// When a part over the frame (a card, a picker) closes while it holds the focus, the focus goes back to the frame, which
// held the keys when the part took over (useFocusBack), never to the page's body.
import { useLayoutEffect, type RefObject } from "react";

type Taker = () => boolean;
const takers: Taker[] = [];

/** Register a part that may take Esc; `take` returns true when it used it. Returns the unregister. */
export function onEscape(take: Taker): () => void {
  takers.push(take);
  return () => {
    const at = takers.lastIndexOf(take);
    if (at >= 0) takers.splice(at, 1);
  };
}

/** The layer's Esc: true when a part of the pane took it (the layer stays). */
export function escapeTaken(): boolean {
  for (let i = takers.length - 1; i >= 0; i--) if (takers[i]!()) return true;
  return false;
}

/** The part in `box` closes while it holds the focus: the focus goes to the frame, else to the address field. */
export function useFocusBack(box: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    return () => {
      // The cleanup runs before the part leaves the page, so the focus is still where it was.
      if (!el.contains(document.activeElement)) return;
      const frame = el.closest(".bp-stage")?.querySelector<HTMLElement>('[data-testid="browser-frame"]');
      const field = el.closest(".bp")?.querySelector<HTMLElement>('[data-testid="browser-address"]');
      queueMicrotask(() => {
        const now = document.activeElement;
        if (now && now !== document.body && now.isConnected) return;
        [frame, field].find((x) => x?.isConnected)?.focus({ preventScroll: true });
      });
    };
  }, [box]);
}
