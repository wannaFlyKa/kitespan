// The search field's focus (DESIGN.md 9.3, 6.7, 6.11, 7.2): on a laptop the pane opens with its field focused; on touch
// it gives no first focus, so the keyboard comes up when the user taps the field (L12), except when the key opened it
// (a hardware keyboard: the user is typing already). Search's key, with the pane open, focuses the field and selects
// its text. Esc or Close closes the pane "back to where the user was" (6.7): the focus goes back to the element that
// had it when the pane opened (focusBackTo).

/** The field's test id: the key finds the open pane's field by it. */
export const SEARCH_FIELD_ID = "search-input";

/** How long after the key a pane that mounts counts as opened by it. */
const KEY_OPEN_MS = 1000;
let keyOpenedAt = 0;

/** The key is opening the pane: its field takes the focus when it mounts, on touch too. */
export function openSearchFocused(now: number = Date.now()) {
  keyOpenedAt = now;
}

/** Whether the pane that mounts now was opened by the key just before (read once). */
export function takeKeyOpened(now: number = Date.now()): boolean {
  const was = keyOpenedAt > 0 && now - keyOpenedAt < KEY_OPEN_MS;
  keyOpenedAt = 0;
  return was;
}

/** Focus the open pane's field, when it has no focus, and select its text; false when no pane is open. */
export function focusSearchField(select: boolean): boolean {
  if (typeof document === "undefined") return false;
  const el = [...document.querySelectorAll<HTMLInputElement>(`[data-testid="${SEARCH_FIELD_ID}"]`)].find((f) => f.getClientRects().length > 0);
  if (!el) return false;
  if (document.activeElement === el) return true;
  el.focus({ preventScroll: true });
  if (select) el.select();
  return true;
}

/** What focusBackTo reads of an element (a stand-in in a test). */
export interface FocusTarget {
  isConnected: boolean;
  getClientRects(): ArrayLike<unknown>;
}

/**
 * Where the focus goes when Esc or Close closes the pane while the focus is in it: the element that had the focus as
 * the pane opened (`opener`), when it is still on the page, shown and outside the pane; else the composer's field
 * (`fallback`) on a laptop; on touch nothing, since a field's focus would raise the on-screen keyboard.
 */
export function focusBackTo<T extends FocusTarget>(opener: T | null, fallback: T | null, inPane: (el: T) => boolean, touch: boolean): T | null {
  const usable = (el: T | null): el is T => !!el && el.isConnected && el.getClientRects().length > 0 && !inPane(el);
  if (usable(opener)) return opener;
  return !touch && usable(fallback) ? fallback : null;
}
