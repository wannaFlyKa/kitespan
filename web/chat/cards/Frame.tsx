// The frame every waiting card shares: an icon, the title, "1 of N" when several requests wait, a body that scrolls
// inside the card when it is long, and the row of answer buttons. The card takes the composer's place (DESIGN.md 6.3).
// The buttons stay on one row while they fit; when they do not, they stack, each as wide as the card, with the
// primary first, as on the phone (where they always stack). Stacked, the primary is first in the DOM too (FIX-Q1:
// readingOrder), so Tab and a screen reader meet the buttons in the order they show. A plan card's options are a list.
// The card's foot holds Stop on every size (DESIGN-T1 T-4, G-10): a quiet 44 px link to the Stop confirm, under a
// hairline and apart from the answers, which ends the turn and answers every waiting card as dismissed; Deny still
// answers this card only. The frame is its fields' owner (data-kb-owner) for the keyboard's release at the app's root
// (composer/keyboard.ts), so a press anywhere in the card keeps its field.
import { createContext, useContext, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { href } from "../../router";
import { IconStop } from "../../ui/icons";
import { Link, readingOrder } from "../../ui/primitives";

/** The card is drawn on the phone, where its buttons always stack (WaitingCard says so). */
export const CardOnPhone = createContext(false);
/** The chat whose turn the card waits in, and the transcript view (WaitingCard says so): its foot's Stop. None: no foot. */
export const CardChat = createContext<{ chat: string; view?: string } | null>(null);

/** A button's own width: its text, padding and border, whether the row stretches it or not. */
function naturalWidth(el: HTMLElement): number {
  const range = document.createRange();
  range.selectNodeContents(el);
  const text = range.getBoundingClientRect().width;
  const cs = getComputedStyle(el);
  return Math.ceil(text + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth));
}

/** Whether the row's buttons do not fit side by side. */
function needsStack(row: HTMLElement): boolean {
  const cs = getComputedStyle(row);
  const buttons = [...row.children].filter((c): c is HTMLElement => c instanceof HTMLElement);
  const gap = parseFloat(cs.columnGap) || 0;
  const room = row.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const need = buttons.reduce((sum, b) => sum + naturalWidth(b), 0) + gap * Math.max(0, buttons.length - 1);
  return need > room + 0.5;
}

/**
 * Whether the row's buttons stack because they do not fit side by side (the row's `data-fit="stack"`), kept right as
 * the card's width changes (a window resize, a side pane that opens, the text size). The check runs before paint
 * after each render; a resize re-checks in the next frame, so the observer never sees a change it made itself.
 */
function useFit(row: RefObject<HTMLElement | null>, on: boolean): boolean {
  const [stack, setStack] = useState(false);
  useLayoutEffect(() => {
    const el = row.current;
    setStack(!!el && on && needsStack(el));
  });
  useLayoutEffect(() => {
    const el = row.current;
    if (!el || !on || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setStack(needsStack(el)));
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [row, on]);
  return stack;
}

export function CardFrame(props: {
  kind: string;
  icon: ReactNode;
  title: ReactNode;
  count?: string;
  cardRef: RefObject<HTMLElement | null>;
  onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void;
  children?: ReactNode;
  note?: ReactNode;
  actions: ReactNode;
  /** The answers are a list of options, the first one first (the plan card). */
  list?: boolean;
}) {
  const { kind, icon, title, count, cardRef, onKeyDown, children, note, actions, list } = props;
  const titleId = useId();
  const row = useRef<HTMLDivElement>(null);
  const fit = useFit(row, !list);
  const phone = useContext(CardOnPhone);
  const stopAt = useContext(CardChat);
  return (
    <section className={`chat-card is-${kind}`} data-testid={`card-${kind}`} data-kb-owner="" aria-labelledby={titleId} tabIndex={-1} ref={cardRef} onKeyDown={onKeyDown}>
      <header className="chat-card-head">
        <span className="chat-card-icon">{icon}</span>
        <h2 className="chat-card-title" id={titleId}>
          {title}
        </h2>
        {count ? <span className="chat-card-count">{count}</span> : null}
      </header>
      {children ? <div className="chat-card-body">{children}</div> : null}
      {note}
      <div className={`chat-card-actions${list ? " is-list" : ""}`} data-fit={fit ? "stack" : undefined} ref={row}>
        {readingOrder(actions, !list && (phone || fit))}
      </div>
      {stopAt ? (
        <div className="chat-card-foot">
          <Link to={href("stop", { chat: stopAt.chat }, { view: stopAt.view })} className="btn ghost chat-card-stop" data-testid="card-stop">
            <IconStop size={14} />
            <span>Stop</span>
          </Link>
        </div>
      ) : null}
    </section>
  );
}

/** The 1 to 9 keys of an open card (DESIGN.md 6.11), outside its text fields. Returns the digit, or null. */
export function digitKey(e: KeyboardEvent): number | null {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !/^[1-9]$/.test(e.key)) return null;
  const t = e.target as HTMLElement | null;
  if (t?.closest("input, textarea, select, [contenteditable]")) return null;
  return Number(e.key);
}

/** One plain line in a card, for a pre-fill the chat does not offer (DESIGN.md 5.4). */
export function CardLine({ text }: { text: string | null }) {
  return text ? (
    <p className="chat-card-line" role="status" data-testid="card-line">
      {text}
    </p>
  ) : null;
}
