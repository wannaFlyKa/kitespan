// Settings in the tab's history (DESIGN.md 5.1 rule 4): Done closes Settings instead of pushing the place it came
// from. Each Settings entry keeps, in its history state beside the router's `from`, the place Settings was opened from
// and its number among the Settings entries since then: 1 for the entry that opened Settings, one more for each entry a
// section link pushes (a replace keeps the entry and its number). A reload keeps them. Settings.tsx numbers the
// entries; Done there and in the phone's title bar calls closeSettings. As closeTo, Done goes back only inside this
// document: a step back into an earlier document would unload the page, and a Save on its way could go with it.
import { useEffect, useRef } from "react";
import { docReach, navigate, type EntryState, type Route } from "../router";

interface SettingsEntry extends EntryState {
  settingsFrom?: string;
  settingsDepth?: number;
}

const entryState = (): SettingsEntry => (typeof history !== "undefined" ? (history.state as SettingsEntry | null) : null) ?? {};

export const isSettingsUrl = (url: string) => url === "/settings" || /^\/settings[/?]/.test(url);

/** The place before Settings, and whether it is a real entry (a fresh tab has none: then Home). */
export function settingsCameFrom(): { to: string; real: boolean } {
  const st = entryState();
  const was = st.settingsFrom ?? st.from ?? "";
  const real = !!was && !isSettingsUrl(was);
  return { to: real ? was : "/", real };
}

/** Number the current Settings entry, once per route; `came` is where Settings was opened from. */
export function useSettingsDepth(route: Route, came: { to: string; real: boolean }) {
  const last = useRef(0);
  useEffect(() => {
    const st = entryState();
    if (st.settingsDepth) {
      last.current = st.settingsDepth;
      return;
    }
    // The entry that opened Settings is 1; one pushed from a numbered Settings entry is one more; else unknown.
    const depth = !st.from || !isSettingsUrl(st.from) ? 1 : last.current ? last.current + 1 : 0;
    last.current = depth;
    if (depth && came.real) history.replaceState({ ...st, settingsDepth: depth, settingsFrom: came.to }, "");
  }, [route]);
}

/**
 * How many entries Done goes back: the Settings entries, when this document pushed them and the entry before them,
 * which is the place Settings came from (router.ts docReach); else 0. `doc`: the router's document id (tests only).
 */
export function settingsSteps(st: SettingsEntry, doc?: string): number {
  const n = st.settingsDepth ?? 0;
  if (n < 1 || !st.settingsFrom || st.back?.[n - 1] !== st.settingsFrom) return 0;
  return n <= (doc === undefined ? docReach(st) : docReach(st, doc)) ? n : 0;
}

/**
 * Done: back over the Settings entries to the place before them (settingsSteps); else that place replaces Settings (a
 * Settings opened as a new document, by a link or a typed URL), or Home when there is none (a fresh tab).
 */
export function closeSettings() {
  const st = entryState();
  const n = settingsSteps(st);
  if (n) history.go(-n);
  else navigate(st.settingsDepth && st.settingsFrom ? st.settingsFrom : "/", { replace: true });
}
