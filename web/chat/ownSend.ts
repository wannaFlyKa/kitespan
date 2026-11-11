// FIX-Q1: your own send goes to the end. A send from this page's message box (Send, or Run for a `!` command) is the
// reader going on with the chat: the conversation (ChatView) drops a linked row's pin and a kept place and follows the
// end at the press, as a send at the end always did. A route that only names a row becomes the chat's own URL once the
// send went out (a refused one leaves the link as it was), so the row's mark goes: a /m/ link (a search hit, a turn
// rail's jump), on the phone a changes route, which there is the chat at the turn's card line (changes/nav.ts), and a
// card route whose card no longer waits (its record, or 5.4's line). Back when the entry before is the chat's own URL
// in this page (a rail's jump pushed the link from it), so no entry repeats it (5.1 rule 4, 5.5 step 3); else by
// replace, so Back still returns to where the link came from. Page state only: another page's send is the server's
// echo, and that one leaves this reader where they are.
import { closeSteps, type EntryState, type Route } from "../router";
import { CHANGES_ROUTES } from "../changes/model";

const listeners = new Map<string, Set<(done: Promise<boolean>) => void>>();

/** The message box sends (or runs) this, now: the conversation of `chatId` follows the end. `done`: the send's result. */
export function ownSend(chatId: string, done: Promise<boolean>): void {
  for (const f of [...(listeners.get(chatId) ?? [])]) f(done);
}

/** The conversation of `chatId` hears this page's own sends; the result stops it. */
export function onOwnSend(chatId: string, f: (done: Promise<boolean>) => void): () => void {
  let set = listeners.get(chatId);
  if (!set) listeners.set(chatId, (set = new Set()));
  set.add(f);
  return () => {
    set.delete(f);
    if (!set.size && listeners.get(chatId) === set) listeners.delete(chatId);
  };
}

/**
 * Whether a send on this route goes to the chat's own URL: the route names a row and nothing else. `cardGone`: the
 * route is a card's and its card does not wait (the view shows its record, or 5.4's line).
 */
export function sendLeaves(route: Route, phone: boolean, cardGone = false): boolean {
  return route.name === "message" || (phone && CHANGES_ROUTES.has(route.name)) || cardGone;
}

/** How the chat's own URL takes the route's place: "back" when the entry before is it in this page (closeSteps), else "replace". */
export function leaveBy(st: EntryState | null | undefined, current: string, chatUrl: string): "back" | "replace" {
  return closeSteps(st, current, chatUrl) === 1 ? "back" : "replace";
}

/**
 * After a send that left (sendLeaves): once it went out, and while the page still shows the URL it was sent from,
 * `leave`; a refused send (the queue's cap, no Claude Code, a restart) leaves the link as it was.
 */
export function leaveAfter(done: Promise<boolean>, from: string, now: () => string, leave: () => void): Promise<void> {
  return done.then((ok) => {
    if (ok && now() === from) leave();
  });
}
