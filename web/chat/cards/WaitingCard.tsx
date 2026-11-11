// The waiting card that takes the composer's place (DESIGN.md 6.3). One card shows at a time, with "1 of N" when
// several wait. A card route focuses the card; its ?answer= focuses that button and its ?pick= ticks options. A link
// never acts: only a click, a tap, a submit or a key press in the card answers it.
import { useEffect, useRef, type RefObject } from "react";
import type { Route } from "../../router";
import { useViewport } from "../../layout/size";
import type { Card, Chat, PermissionCard, PlanAnswer } from "../../state/types";
import { DialogCardView } from "./DialogCard";
import { CardChat, CardOnPhone } from "./Frame";
import { ElicitationCardView } from "./ElicitationCard";
import { PermissionCardView } from "./PermissionCard";
import { PlanCardView } from "./PlanCard";
import { QuestionCardView } from "./QuestionCard";

export const CARD_ROUTES = new Set(["permission", "question", "plan", "elicitation", "dialog"]);
/**
 * The composer's routes (DESIGN.md 5.2). While a card waits the composer is hidden, so such a link shows one line
 * above the card (labels.ts answerFirstLine) and keeps its URL; the composer, the / menu, the + menu or the picker
 * opens from it once the card is answered.
 */
export const COMPOSER_ROUTES = new Set(["send", "bash", "slashMenu", "slash", "add", "model", "effort", "mode", "mention"]);

/**
 * The paths whose place on an archived chat says "This chat is archived." (5.4, D48): a composer, picker, Stop or card
 * path, and (R127) Trust this folder's confirm, which an archived chat never opens.
 */
export function archivedLinePath(route: Route): boolean {
  return COMPOSER_ROUTES.has(route.name) || route.name === "stop" || route.name === "trust" || CARD_ROUTES.has(route.name);
}

/** The waiting card that a card route names: its request id, on the path of the card's own kind. */
export function routedCardOf(chat: Chat, route: Route): Card | undefined {
  if (!CARD_ROUTES.has(route.name)) return undefined;
  const id = route.params.request;
  return chat.pending.find((k) => k.id === id && k.kind === route.name);
}

export function WaitingCard({ chat, card, index, route }: { chat: Chat; card: Card; index: number; route: Route }) {
  const ref = useRef<HTMLElement>(null);
  const vp = useViewport();
  const total = chat.pending.length;
  const count = total > 1 ? `${index + 1} of ${total}` : undefined;
  // A card link focuses its card, and its pre-fill counts, only on the path of the card's own kind (a /question/ path
  // naming a permission request is a bad link: ChatView shows its line). A composer link focuses the card too: its
  // composer waits behind it.
  const own = routedCardOf(chat, route) === card;
  const routed = own || COMPOSER_ROUTES.has(route.name);
  const answer = own && typeof route.query.answer === "string" ? route.query.answer : undefined;
  const picks = own && Array.isArray(route.query.pick) ? route.query.pick : undefined;
  const pickKey = picks?.join("\u0000") ?? "";

  useEffect(() => {
    if (!routed) return;
    const el = ref.current;
    if (!el) return;
    // After the deny field opens (on ?answer=deny) the button is in place; one frame is enough. A request that Claude
    // Code marks defaultToNo opens on Deny whatever the link pre-fills (D52: no stray key approves it).
    const denyFirst = card.kind === "permission" && card.wire?.kind === "permission" && card.wire.defaultToNo;
    const id = requestAnimationFrame(() => {
      const want = denyFirst ? "deny" : answer;
      const button = want ? el.querySelector<HTMLElement>(`[data-testid="confirm-${want}"]`) : null;
      // On a laptop an elicitation form starts at its first field; a touch device keeps the keyboard down.
      const field = !answer && card.kind === "elicitation" && !vp.touch ? el.querySelector<HTMLElement>("input") : null;
      (button ?? field ?? el).focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
    // Focus follows the link itself (its path and pre-fill), not every render.
  }, [routed, route.name, card.id, answer, pickKey, card.kind, vp.touch]);

  // FIX-Q1: on the phone the card's buttons stack with the primary first, in the DOM too (Frame.tsx). T-4: the card's
  // foot holds Stop for this chat, keeping the transcript view.
  const view = typeof route.query.view === "string" ? route.query.view : undefined;
  return (
    <CardOnPhone.Provider value={vp.size === "phone"}>
      <CardChat.Provider value={{ chat: chat.id, view }}>{cardView(chat, card, count, answer, picks, ref)}</CardChat.Provider>
    </CardOnPhone.Provider>
  );
}

function cardView(chat: Chat, card: Card, count: string | undefined, answer: string | undefined, picks: string[] | undefined, ref: RefObject<HTMLElement | null>) {
  switch (card.kind) {
    case "permission":
      return <PermissionCardView key={card.id} chat={chat} card={card} count={count} prefill={answer as NonNullable<PermissionCard["answered"]> | undefined} cardRef={ref} />;
    case "question":
      return <QuestionCardView key={card.id} chat={chat} card={card} count={count} picks={picks} cardRef={ref} />;
    case "plan":
      return <PlanCardView key={card.id} chat={chat} card={card} count={count} prefill={answer as PlanAnswer | undefined} cardRef={ref} />;
    case "elicitation":
      return <ElicitationCardView key={card.id} chat={chat} card={card} count={count} cardRef={ref} />;
    case "dialog":
      return <DialogCardView key={card.id} chat={chat} card={card} count={count} cardRef={ref} />;
  }
}
