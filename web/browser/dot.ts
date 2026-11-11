// The needs-you dot on the ways in (DESIGN-B1 4.4, F20): the title bar's Browser tool, the sidebar head's Browser
// button, the pane bar's, and on the phone the session menu's button and the chat list's Browser button wear it while a
// page dialog or a file chooser waits in a tab that no Browser view on this page shows. Their names add ", the browser
// needs an answer". Each Browser view says which tab it shows (showingTab).
import { useEffect, useSyncExternalStore } from "react";
import type { BrowserTabView } from "../../shared/browser";
import { useBrowser } from "./store";

export const NEEDS_WORDS = ", the browser needs an answer";

const shown = new Map<number, string>();
const listeners = new Set<() => void>();
let version = 0;
let next = 0;
const emit = () => {
  version++;
  for (const l of listeners) l();
};

/** A Browser view shows `tab` (null: none) while it is mounted. */
export function useShowingTab(tab: string | null) {
  useEffect(() => {
    if (!tab) return;
    const id = ++next;
    shown.set(id, tab);
    emit();
    return () => {
      shown.delete(id);
      emit();
    };
  }, [tab]);
}

/** Whether a tab waits for an answer that no view on this page shows (pure, for the tests). */
export function needsYou(tabs: readonly Pick<BrowserTabView, "id" | "dialog" | "chooser">[], onScreen: ReadonlySet<string>): boolean {
  return tabs.some((t) => (t.dialog !== null || t.chooser !== null) && !onScreen.has(t.id));
}

export function useBrowserDot(): boolean {
  const b = useBrowser();
  useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => version,
    () => version,
  );
  return b.opened && needsYou(b.tabs, new Set(shown.values()));
}
