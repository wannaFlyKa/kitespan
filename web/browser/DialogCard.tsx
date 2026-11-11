// A page's dialog (DESIGN-B1 4.6, D-8; PAGE 7): the card over a --scrim veil local to the stage, on every viewer of the
// tab; the first answer wins (this page's, another window's, or Claude's). The title is Chrome's: "<host> says", with
// the host from the server, never from the message; an embedded page's is "An embedded page at <host> says";
// beforeunload is "Leave site?" with "Changes you made may not be saved.". The message is plain text, line breaks kept.
// prompt adds a field with the page's default answer.
// Focus (F10): when the frame had the keys, or a key went to the page in the last second, the card itself takes the
// focus (an alertdialog, announced) and no button does, so a Space or an Enter typed for the page answers nothing;
// otherwise OK takes it on a laptop, and nothing on touch. For 500 ms after it shows, its buttons ignore presses; Esc is
// Cancel (on alert, OK) at any time while the card holds the focus, over the chat too (escape.ts). Enter and Space
// answer only from a focused button (or Enter in the prompt's field). When the card goes while it holds the focus (an
// answer here, or from another window or Claude), the focus goes back to the frame.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { imeKey } from "../composer/composition";
import { IconGlobe } from "../ui/icons";
import { readingOrder } from "../ui/primitives";
import { onEscape, useFocusBack } from "./escape";
import type { DialogFrame } from "./store";

/** The card's buttons ignore presses this long after it shows. */
export const DIALOG_GUARD_MS = 500;
/** A key sent to the page this recently counts as typing for the page. */
export const RECENT_KEY_MS = 1_000;

export function dialogTitle(d: Pick<DialogFrame, "type" | "host" | "embedded">): string {
  if (d.type === "beforeunload") return "Leave site?";
  return d.embedded ? `An embedded page at ${d.host} says` : `${d.host} says`;
}

export function dialogText(d: Pick<DialogFrame, "type" | "message">): string {
  return d.type === "beforeunload" ? "Changes you made may not be saved." : d.message;
}

/** The buttons, in the row's order (the main one last): alert OK; confirm and prompt Cancel, OK; beforeunload Cancel, Leave. */
export function dialogButtons(type: DialogFrame["type"]): ("cancel" | "ok" | "leave")[] {
  if (type === "alert") return ["ok"];
  return ["cancel", type === "beforeunload" ? "leave" : "ok"];
}

/** Where the focus goes as the card shows (F10): the card itself, OK, or nowhere. */
export function dialogFocus(i: { frameHadKeys: boolean; lastKeyAt: number; now: number; touch: boolean; onScreen: boolean }): "card" | "ok" | "none" {
  if (!i.onScreen) return "none";
  if (i.frameHadKeys || i.now - i.lastKeyAt < RECENT_KEY_MS) return "card";
  return i.touch ? "none" : "ok";
}

/** A press counts only after the guard. */
export const guardOver = (shownAt: number, now: number) => now - shownAt >= DIALOG_GUARD_MS;

export function DialogCard(props: { d: DialogFrame; phone: boolean; touch: boolean; frameHadKeys: boolean; lastKeyAt: number; onAnswer: (accept: boolean, text?: string) => void }) {
  const { d, phone, touch, frameHadKeys, lastKeyAt, onAnswer } = props;
  const card = useRef<HTMLElement>(null);
  const ok = useRef<HTMLButtonElement>(null);
  const shownAt = useRef(Date.now());
  const [text, setText] = useState(d.defaultPrompt);
  const [focusCard] = useState(() => dialogFocus({ frameHadKeys, lastKeyAt, now: Date.now(), touch, onScreen: true }));
  useEffect(() => {
    shownAt.current = Date.now();
    setText(d.defaultPrompt);
  }, [d.tab, d.id, d.defaultPrompt]);
  useLayoutEffect(() => {
    if (focusCard === "card") card.current?.focus({ preventScroll: true });
    else if (focusCard === "ok") ok.current?.focus({ preventScroll: true });
  }, [focusCard, d.id]);
  const answer = (accept: boolean) => {
    if (!guardOver(shownAt.current, Date.now())) return;
    onAnswer(accept, d.type === "prompt" ? text : undefined);
  };
  const live = useRef({ d, onAnswer });
  live.current = { d, onAnswer };
  const escape = () => live.current.onAnswer(live.current.d.type === "alert", undefined);
  useEffect(
    () =>
      onEscape(() => {
        if (!card.current?.contains(document.activeElement)) return false;
        escape();
        return true;
      }),
    [],
  );
  useFocusBack(card);
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      escape();
      return;
    }
    // Enter and Space answer only from a focused button: the card itself, holding the focus, takes neither.
    if ((e.key === "Enter" || e.key === " ") && e.target === card.current) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  const titleId = `bp-dlg-t-${d.tab}-${d.id}`;
  const msgId = `bp-dlg-m-${d.tab}-${d.id}`;
  const buttons = dialogButtons(d.type).map((b) =>
    b === "cancel" ? (
      <button key="cancel" type="button" className="btn" onClick={() => answer(false)} data-testid="browser-dialog-cancel">
        Cancel
      </button>
    ) : (
      <button key={b} ref={ok} type="button" className="btn primary" onClick={() => answer(true)} data-testid="browser-dialog-ok">
        {b === "leave" ? "Leave" : "OK"}
      </button>
    ),
  );
  return (
    <>
      <div className="bp-veil" />
      <div className="bp-card-wrap">
        <section ref={card} className="chat-card is-dialog" role="alertdialog" aria-labelledby={titleId} aria-describedby={msgId} tabIndex={-1} onKeyDown={onKey} data-testid="browser-dialog" data-kb-owner="">
          <header className="chat-card-head">
            <span className="chat-card-icon">
              <IconGlobe />
            </span>
            <h2 className="chat-card-title" id={titleId}>
              {dialogTitle(d)}
            </h2>
          </header>
          <div className="chat-card-body">
            <p className="chat-card-text bp-card-text" id={msgId}>
              {dialogText(d)}
            </p>
            {d.type === "prompt" ? (
              <input
                className="field"
                type="text"
                aria-label="Your answer"
                value={text}
                maxLength={2000}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !imeKey(e.nativeEvent)) {
                    e.preventDefault();
                    answer(true);
                  }
                }}
                data-testid="browser-dialog-field"
              />
            ) : null}
          </div>
          <div className="chat-card-actions">{readingOrder(buttons, phone)}</div>
        </section>
      </div>
    </>
  );
}
