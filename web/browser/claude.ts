// "Claude is acting" (DESIGN-B1 4.4, F13) and each tab's one mark (4.2), from the server's `acting` list (the running
// browser calls of kitespan's chats, SERVER 11; `ToolSearch` never counts, and the owner's terminal sessions light
// nothing) and the tabs. The chip's forms: in the tab on screen (a status; beside a chat that is not the acting one, a
// link to that chat), in another tab (a button that shows it), and the tab unknown (a status, no mark), while
// browser_navigate, browser_tabs or browser_close run. It is off, and so are Claude's marks, in the two port states
// (F1): Claude's tools then reach another program. The store holds the chip 1.5 s after the last call ends.
import type { BrowserActing, BrowserHostState, BrowserTabView } from "../../shared/browser";

/** The chip holds this long after the last call ends, so a run of calls does not flicker. */
export const CHIP_HOLD_MS = 1_500;

export type ChipForm = { form: "here"; chat: string; link: boolean } | { form: "other"; tab: string; chat: string } | { form: "unknown" };

/** Claude's marks and the chip light only while kitespan's own browser runs on the port. */
export function claudeLit(hostState: BrowserHostState | null | undefined): boolean {
  return hostState !== "port_own" && hostState !== "port_other";
}

/**
 * The chip for the tab on screen (`shown`), beside chat `besideChat` (null on /browser): null when no call runs (or is
 * held), and in the port states.
 */
export function chipOf(i: { acting: readonly BrowserActing[]; shown: string | null; besideChat: string | null; hostState: BrowserHostState | null | undefined }): ChipForm | null {
  if (!i.acting.length || !claudeLit(i.hostState)) return null;
  const here = i.shown ? i.acting.find((a) => a.tab === i.shown) : undefined;
  if (here) return { form: "here", chat: here.chat, link: i.besideChat !== null && here.chat !== i.besideChat };
  const other = i.acting.find((a) => a.tab !== null && a.tab !== i.shown);
  if (other) return { form: "other", tab: other.tab!, chat: other.chat };
  return { form: "unknown" };
}

export type TabMark = "dot" | "working" | "pointer" | null;

/**
 * A tab's one mark, the first of: the needs-you dot (a dialog or a file chooser waits there), the working mark (a
 * running call of Claude's uses it), the pointer (the last result of a chat's browser call named it alone).
 */
export function tabMark(t: Pick<BrowserTabView, "id" | "dialog" | "chooser" | "claudeLast">, running: readonly BrowserActing[], lit = true): TabMark {
  if (t.dialog !== null || t.chooser !== null) return "dot";
  if (!lit) return null;
  if (running.some((a) => a.tab === t.id)) return "working";
  return t.claudeLast ? "pointer" : null;
}

/** The words a tab's name adds for its state (DESIGN-B1 4.18, PAGE 18). */
export function tabNameOf(t: Pick<BrowserTabView, "loading">, title: string, mark: TabMark): string {
  const parts = [title];
  if (mark === "working") parts.push("Claude is acting");
  else if (mark === "pointer") parts.push("Claude's tab");
  if (mark === "dot") parts.push("needs an answer");
  if (t.loading) parts.push("loading");
  return parts.join(", ");
}

/** The chip's words and name (DESIGN-B1 4.4, 4.16). */
export const CHIP_WORDS = {
  acting: "Claude is acting",
  other: "Claude is acting in another tab",
  otherName: "Claude is acting in another tab. Show it",
  narrowOther: "Claude's tab",
  narrowOtherName: "Claude's tab: Claude is acting there. Show it",
  said: "Claude is acting in the browser",
  link: (title: string) => `Claude is acting, in ${title}. Open the chat`,
} as const;

/**
 * Claude uses this tab during a turn (DESIGN-B1 2.13, D-6, F25): a running call of Claude's acts in it, or the chat
 * whose last result named it has a turn running. Close and Page size ask first then.
 */
export function claudeUsing(t: Pick<BrowserTabView, "id" | "claudeLast">, running: readonly BrowserActing[], turnRuns: (chat: string) => boolean): string | null {
  const now = running.find((a) => a.tab === t.id);
  if (now) return now.chat;
  return t.claudeLast && turnRuns(t.claudeLast) ? t.claudeLast : null;
}
