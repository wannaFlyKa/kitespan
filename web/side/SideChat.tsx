// The side chat (owner rows 124 and 125; DESIGN-R124 sections 5 to 8): ask Claude a quick question about the chat at
// any moment, also while a turn runs, and read the answer, without anything going into the conversation, the queue or
// the running turn. The server asks it on the chat's live process (askSideQuestion) and keeps the thread per chat, the
// same on every device and across a restart (side/thread.ts, store.ts).
//
// Where it shows is Shell's: the side panel's place (the laptop's column, the tablet's docked pane, over the chat as a
// layer from 1,000 to 1,087 px with the sidebar docked) and, on the phone, its own sheet over the chat, as tall as its
// content up to half the screen, riding the on-screen keyboard while its box has the focus (7.8), still at most half
// the visual viewport then, so part of the chat stays in view. The sheet closes by
// Done, its scrim, Back, Esc, or a drag down on its grip or title row (64 px, or a flick; with Reduce motion it does
// not follow the finger). Esc in the side chat closes it and gives the focus back to its opener; it never stops a side
// question or the turn.
//
// The one thing it is remembered by: the newest answer in full, every earlier question one quiet line above it (the
// CLI's overlay lists earlier side questions above the current answer). A tap on an earlier line opens its answer in
// place. The newest exchange is always open, its question a heading; its body is a polite live region, so an answer
// that lands is read out. Answers are the reply's prose and markdown with Copy under them; an empty answer shows
// nothing and no Copy; a refusal fallback's notice shows as the transcript's refusal line above it. R130: after Copy, Bring
// back puts the answer into the message box's draft as a quote (side/bring.ts) and never sends; it shows wherever the
// box can take it (not in an archived chat, a held one, an asking or failed question, an empty answer, or Claude
// Code's own placeholder for a question it could not answer). Where the
// side chat sits beside the chat (the laptop's column, the tablet's pane) it stays open, and on a laptop the focus
// goes to the box with the caret at the end; the phone's sheet and the layer over the chat close, so the box shows. On
// touch nothing takes the focus, so no keyboard comes up until a tap. Asking: the working
// mark ("Claude is answering"), and 6.3's retry line from Claude Code's progress. Failed: one line, "The side question
// did not finish.", with Try again (the same id). Clear sits at the top of the thread, away from Close, and stays whole
// there while the thread scrolls under it; it is hidden while a question runs, and on touch it leaves the focus where
// it is (no keyboard comes up). Principle 0: no helper line, no count, no empty-state text.
//
// The box: one short question (Enter sends, Shift+Enter is a new line; on touch the Return key setting applies), Stop in
// Send's place while a question runs. Its text is the chat's side draft, which the server holds (FIX-U2, D49): every
// page shows the same text, also after a restart, and a Send clears it on every page; the question goes back into it
// when it is empty after this page's Stop, and when the server answered `busy` (another page asked first; one side
// question runs at a time) or refused it. A link's ?text= only fills it, as plain text, with "Prompt from an external
// link" under it until it is sent or cleared, and is never saved by itself; an edit saves it with its mark. A held chat
// locks it as row 80 locks the message box (the server refuses every side question while the chat is held, also
// while kitespan's own process from before a restart finishes, or hands the session over); an archived chat has no box
// and shows its kept thread read-only.
// U4: in a half of the split side panel its Close (and Esc) gives the whole pane to the other half, and as the other
// half (not the URL's own view) it takes no focus as it opens, nor does an exchange's Bring back. There the box's first
// letter or a Send makes it the URL's own view (a replace, the places kept), as the search field's typing does, so the
// next opener takes the other half's place.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { closeTo, href, navigate, type Route } from "../router";
import { act, flushDrafts, sideBoxOf, useStore } from "../state/store";
import type { Chat } from "../state/types";
import { useViewport } from "../layout/size";
import { Scrim, useLayer } from "../ui/primitives";
import { imeKey } from "../composer/composition";
import { CopyButton } from "../ui/Copy";
import { IconChevron, IconClose, IconSend, IconStop } from "../ui/icons";
import { IconSpark } from "../chat/items/icons";
import { RefusalNotice } from "../chat/items/Notes";
import { delayLabel } from "../chat/items/format";
import { Markdown } from "../chat/Markdown";
import { ExternalLinkLine } from "../composer/ExternalLinkLine";
import { useFocusInside, useSoftKeyboard } from "../composer/keyboard";
import { TOO_LONG } from "../screens/common";
import { focusBackTo } from "../search/focus";
import { BRING_BACK, BRING_BACK_NAME, SIDE_EXCHANGE_GONE, broughtScrollTop } from "./bring";
import { EMPTY_THREAD, SIDE_TEXT_MAX, askingOf, questionText, type PageExchange } from "./thread";
import { SIDE_FIELD_ID, sideBoxBack, sideExchangeOf, sideFillOf, sideHref, takeFill, takeSideKeyOpened } from "./nav";
import { halfClose, halfLink, halfOwnHref } from "../layout/split";
import "../styles/side.css";

/** Where the side chat is drawn: Shell's side places, or the phone's sheet. */
export type SidePlace = "column" | "pane" | "over" | "sheet";

export const SIDE_TITLE = "Side chat";
export const SIDE_PLACEHOLDER = "Ask a side question…";
export const SIDE_FAILED = "The side question did not finish.";
export const SIDE_ANSWERING = "Claude is answering";
/** A drag down this far on the sheet's grip or title row closes it (or a flick). */
export const SHEET_CLOSE_PX = 64;
const FLICK_PX_PER_MS = 0.5;
/** The phone's title bar, which the riding sheet never covers (7.8). */
const HEADER_PX = 44;
const COMPOSER_FIELD = '[data-testid="composer"] [data-testid="composer-input"]';

const viewOf = (route: Route) => (typeof route.query.view === "string" ? route.query.view : undefined);
const reduceMotion = () =>
  typeof document !== "undefined" &&
  (document.documentElement.dataset.motion === "reduce" || (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches));

/** "Retrying (2 of 10) in 4 s" (6.3's retry line, from Claude Code's progress). */
export function retryLine(r: { attempt: number; max: number; delayMs: number }): string {
  return `Retrying (${r.attempt} of ${r.max}) in ${delayLabel(r.delayMs)}`;
}



/** How long after Bring back the message box may lay out again (its keys moving to a row of their own). */
export const BROUGHT_SETTLE_MS = 250;
/** What the user does in a field that makes their place their own. */
const OWN_PLACE = ["pointerdown", "touchstart", "wheel", "keydown", "input"] as const;

/**
 * Bring back's second placing of the message box (2.7): `place` runs once more after BROUGHT_SETTLE_MS, unless the
 * user acted in the box first or it left the page. The tests drive it with a stand-in box and timer.
 */
export function settleBrought(box: Pick<HTMLElement, "addEventListener" | "removeEventListener" | "isConnected">, place: () => void, later: (run: () => void, ms: number) => unknown = setTimeout): void {
  let own = false;
  const mine = () => {
    own = true;
  };
  for (const k of OWN_PLACE) box.addEventListener(k, mine, { passive: true, once: true });
  later(() => {
    for (const k of OWN_PLACE) box.removeEventListener(k, mine);
    if (!own && box.isConnected) place();
  }, BROUGHT_SETTLE_MS);
}
export function SideChat({ chat, route, place }: { chat: Chat; route: Route; place: SidePlace }) {
  const vp = useViewport();
  const thread = useStore((s) => s.side[chat.id] ?? EMPTY_THREAD);
  // The read while it shows (and again on each attach): store.ts act.sideView.
  useEffect(() => {
    act.sideView(chat.id, true);
    return () => act.sideView(chat.id, false);
  }, [chat.id]);
  const chatUrl = href("chat", { chat: chat.id }, { view: viewOf(route) });
  const root = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const readOnly = chat.archived;
  // Row 80: the chat is held (another app has the session, or kitespan's own process from before a restart still
  // finishes or hands it over): the server takes no side question then, so the box takes no typing.
  const locked = !readOnly && !!chat.held;

  // ---- focus: on a laptop the box, on touch none until the user taps it (unless the key opened it) ----
  // The element that had the focus as it opened gets it back when Esc or Close closes it while the focus is inside;
  // with none, the message box's field on a laptop. Over the chat and in the phone's sheet the layer gives it back.
  const opener = useRef<HTMLElement | null>(null);
  const closing = useRef(false);
  const ownFocus = place === "column" || place === "pane";
  useLayoutEffect(() => {
    const at = typeof document !== "undefined" ? document.activeElement : null;
    const box = place === "sheet" ? null : root.current;
    if (at instanceof HTMLElement && at !== document.body && !box?.contains(at)) opener.current = at;
    const byKey = takeSideKeyOpened();
    // U4: only the URL's own view takes the focus (the other half of a pair opens plain, also after a reload).
    if (!readOnly && !locked && (!vp.touch || byKey) && route.half?.path !== false) field.current?.focus({ preventScroll: true });
    return () => {
      if (!closing.current || !ownFocus) return;
      closing.current = false;
      const now = document.activeElement;
      if (now && now !== document.body && !box?.contains(now)) return;
      const inside = (el: HTMLElement) => !!box?.contains(el);
      focusBackTo(opener.current, document.querySelector<HTMLElement>(COMPOSER_FIELD), inside, vp.touch)?.focus({ preventScroll: true });
    };
    // Once, as it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const close = () => {
    closing.current = true;
    // U4: in a half of the split side panel, the other view takes the whole pane.
    closeTo(halfClose(route) ?? chatUrl);
  };
  // Esc anywhere in it closes it (the column and the docked pane; the layer forms close on Esc themselves). It never
  // reaches the message box's Esc, which stops the turn. Esc while an input method composes is the input method's (it
  // cancels the word), on touch too (composer/composition.ts imeKey).
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Escape" || e.defaultPrevented || imeKey(e.nativeEvent, vp.touch)) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };

  // R130 Bring back: the answer into the message box's draft; the sheet and the layer over the chat close so the box
  // shows. On a laptop the box takes the focus with the caret at the end, scrolled to its end; on touch nothing does
  // (6.7), and the field shows the quote down to its last line (bring.ts broughtScrollTop).
  const bring = (answer: string) => {
    const done = act.bringBack(chat.id, answer);
    if (done === "none") return;
    if (place === "sheet" || place === "over") close();
    const touch = vp.touch;
    requestAnimationFrame(() => {
      const box = document.querySelector<HTMLTextAreaElement>(COMPOSER_FIELD);
      if (!box) return;
      if (!touch) {
        box.focus({ preventScroll: true });
        box.setSelectionRange(box.value.length, box.value.length);
        box.scrollTop = box.scrollHeight;
        return;
      }
      const place = () => {
        const cs = getComputedStyle(box);
        box.scrollTop = broughtScrollTop({ scrollHeight: box.scrollHeight, clientHeight: box.clientHeight, lineHeight: parseFloat(cs.lineHeight) || 22, padTop: parseFloat(cs.paddingTop) || 0 });
      };
      place();
      // The box may lay out once more as the draft lands (a narrow slab moves its keys to a row of their own, 2.7),
      // which puts the field back at its top: place it again once that has settled, unless the user touched, scrolled
      // or typed in the box meanwhile (their place wins), or the box is gone.
      settleBrought(box, place);
    });
  };

  // R130: a link to one exchange marks it (and opens it in place when it is an earlier one); one that the thread no
  // longer has says so in one line once the thread is read.
  const marked = sideExchangeOf(route);
  const gone = !!marked && thread.read && !thread.exchanges.some((x) => x.id === marked);

  const body = (
    <>
      {gone ? (
        <p className="notice sc-gone" data-testid="link-notice" role="status">
          {SIDE_EXCHANGE_GONE}
        </p>
      ) : null}
      <div ref={list} className="sc-list" data-testid="side-list">
        <Thread chat={chat} exchanges={thread.exchanges} list={list} readOnly={readOnly || locked} field={field} touch={vp.touch} bring={readOnly || locked ? undefined : bring} marked={gone ? undefined : marked} focusMark={route.half?.path !== false} />
      </div>
      {readOnly ? null : <SideBox chat={chat} route={route} field={field} locked={locked} asking={askingOf(thread)} />}
    </>
  );

  if (place === "sheet")
    return (
      <SideSheet onClose={close} touch={vp.touch}>
        {body}
      </SideSheet>
    );
  return (
    <section ref={root} className={`sc sc-at-${place}`} role="region" aria-label={SIDE_TITLE} data-testid="side-chat" data-place={place} onKeyDown={onKeyDown}>
      <header className="sc-head">
        <h2 className="sc-title">{SIDE_TITLE}</h2>
        <button type="button" className="icon-btn sc-close" aria-label="Close side chat" title={vp.touch ? "Close side chat" : "Close side chat (Esc)"} data-testid="side-close" onClick={close}>
          <IconClose size={16} />
        </button>
      </header>
      {body}
    </section>
  );
}

/**
 * The thread: Clear at its top (it stays whole there while the thread scrolls under it), the earlier exchanges folded
 * to one line each, the newest open. The list ends at the newest exchange; when an answer lands that is taller than the
 * room under the Clear row, its question sits right under that row.
 */
function Thread(props: {
  chat: Chat;
  exchanges: readonly PageExchange[];
  list: React.RefObject<HTMLDivElement | null>;
  readOnly: boolean;
  field: React.RefObject<HTMLTextAreaElement | null>;
  touch: boolean;
  /** Bring back, where the message box can take an answer. */
  bring?: (answer: string) => void;
  /** R130: the exchange a link names: marked, opened in place, scrolled into view, its Bring back focused on a laptop. */
  marked?: string;
  /** U4: false as the other half of the split side panel, which takes no focus (the mark still shows). */
  focusMark?: boolean;
}) {
  const { chat, exchanges, list, readOnly, field, touch, bring, marked, focusMark = true } = props;
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const newest = exchanges[exchanges.length - 1];
  const earlier = useMemo(() => exchanges.slice(0, -1), [exchanges]);
  const newestLi = useRef<HTMLLIElement>(null);
  const shownKey = newest ? `${newest.id}:${newest.state}` : "";
  useLayoutEffect(() => {
    const box = list.current;
    const li = newestLi.current;
    if (!box) return;
    box.scrollTop = box.scrollHeight;
    // The Clear row stays at the list's top (sticky) once the thread scrolls: what scrolls under it is out of view. It
    // sticks below the list's padding, so the room starts at its bottom edge, measured where it sticks, plus its gap
    // (with no Clear row, at the padding).
    const head = box.querySelector<HTMLElement>(".sc-thread-head");
    const top = box.getBoundingClientRect().top;
    const cover = head ? head.getBoundingClientRect().bottom - top + (parseFloat(getComputedStyle(head).marginBottom) || 0) : parseFloat(getComputedStyle(box).paddingTop) || 0;
    if (li && box.scrollHeight > box.clientHeight && li.offsetHeight > box.clientHeight - cover) box.scrollTop += li.getBoundingClientRect().top - top - cover;
  }, [shownKey, list]);
  // The link's exchange, once the thread has it: open it in place, bring it into view, and on a laptop focus its Bring
  // back (which acts only on its own press). Once per link.
  const markedDone = useRef<string | null>(null);
  const markedHere = !!marked && exchanges.some((x) => x.id === marked);
  useLayoutEffect(() => {
    if (!marked || !markedHere || markedDone.current === marked) return;
    markedDone.current = marked;
    if (exchanges[exchanges.length - 1]?.id !== marked) setOpen((s) => new Set([...s, marked]));
    requestAnimationFrame(() => {
      const li = list.current?.querySelector<HTMLElement>(`[data-exchange="${marked}"]`);
      li?.scrollIntoView({ block: "nearest" });
      if (!touch && focusMark) li?.querySelector<HTMLElement>('[data-testid="side-bring-back"]')?.focus({ preventScroll: true });
    });
  }, [marked, markedHere, exchanges, list, touch, focusMark]);
  if (!newest) return null;
  const asking = newest.state === "asking";
  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  // On a laptop the box takes the focus for the next question; on touch nothing does (6.7), so no keyboard comes up.
  const clear = () => {
    void act.sideClear(chat.id);
    if (!touch) field.current?.focus({ preventScroll: true });
  };
  return (
    <>
      {!asking && !readOnly ? (
        <div className="sc-thread-head">
          <button type="button" className="btn plain chat-mini sc-clear" aria-label="Clear side chat" data-testid="side-clear" onClick={clear}>
            Clear
          </button>
        </div>
      ) : null}
      <ol className="sc-thread" aria-label="Side questions" data-testid="side-thread">
        {earlier.map((x) => (
          <Earlier key={x.id} x={x} open={open.has(x.id)} onToggle={() => toggle(x.id)} bring={bring} marked={x.id === marked} />
        ))}
        <li ref={newestLi} key={newest.id} className={`sc-x is-open is-newest${newest.id === marked ? " is-marked" : ""}`} data-state={newest.state} data-testid="side-newest" data-exchange={newest.id}>
          <h3 className="sc-q is-static">
            <span className="sc-q-text" dir="auto">
              {newest.question}
            </span>
          </h3>
          <div className="sc-body" aria-live="polite">
            <Answer chat={chat} x={newest} readOnly={readOnly} bring={bring} />
          </div>
        </li>
      </ol>
    </>
  );
}

function Earlier({ x, open, onToggle, bring, marked }: { x: PageExchange; open: boolean; onToggle: () => void; bring?: (answer: string) => void; marked?: boolean }) {
  const id = useId();
  return (
    <li className={`sc-x ${open ? "is-open" : "is-folded"}${marked ? " is-marked" : ""}`} data-testid="side-earlier" data-exchange={x.id}>
      <button type="button" className="sc-q" aria-expanded={open} aria-controls={open ? id : undefined} onClick={onToggle}>
        <span className="sc-q-text" dir="auto">
          {x.question}
        </span>
        <span className="sc-q-chev" aria-hidden="true">
          <IconChevron size={14} />
        </span>
      </button>
      {open ? (
        <div id={id} className="sc-body">
          <Answer x={x} readOnly bring={bring} />
        </div>
      ) : null}
    </li>
  );
}

/** An exchange's body by its state. `bring`: Bring back, on an answer that has text. */
function Answer({ chat, x, readOnly, bring }: { chat?: Chat; x: PageExchange; readOnly: boolean; bring?: (answer: string) => void }) {
  const prose = useRef<HTMLDivElement>(null);
  if (x.state === "asking")
    return (
      <div className="sc-working" data-testid="side-asking">
        <span className="chat-working" role="img" aria-label={SIDE_ANSWERING}>
          <IconSpark size={16} />
        </span>
        {x.retry ? <span className="sc-retry">{retryLine(x.retry)}</span> : null}
      </div>
    );
  if (x.state === "failed")
    return (
      <div className="sc-fail" role="status" data-testid="side-failed">
        <span className="sc-fail-text">{SIDE_FAILED}</span>
        {!readOnly && chat ? (
          <button type="button" className="btn chat-mini sc-again" data-testid="side-again" onClick={() => void act.sideAsk(chat.id, x.question, x.id).then((end) => end === "busy" && sideBoxBack(chat.id, x.question))}>
            Try again
          </button>
        ) : null}
      </div>
    );
  const answer = x.answer ?? "";
  return (
    <>
      {x.fallback ? (
        <div className="sc-note">
          <RefusalNotice item={{ kind: "refusal", id: `side-${x.id}`, text: x.fallback }} />
        </div>
      ) : null}
      {answer ? (
        <div className="chat-assistant sc-a" data-testid="side-answer">
          <div ref={prose}>
            <Markdown source={answer} />
          </div>
          <div className="chat-foot">
            <CopyButton text={answer} target={() => prose.current} className="chat-reveal" testId="side-copy" label="Copy answer" />
            {/* Claude Code's own placeholder for a side question it could not answer (synthetic) is no answer to bring. */}
            {bring && !x.synthetic ? (
              <button type="button" className="chat-foot-btn chat-reveal" aria-label={BRING_BACK_NAME} data-testid="side-bring-back" onClick={() => bring(answer)}>
                {BRING_BACK}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

/** The side chat's box: the chat's side draft (the server's, FIX-U2), Send or Stop, and its lines. */
function SideBox(props: { chat: Chat; route: Route; field: React.RefObject<HTMLTextAreaElement | null>; locked: boolean; asking: PageExchange | null }) {
  const { chat, route, field, locked, asking } = props;
  const vp = useViewport();
  const returnKey = useStore((s) => s.settings.returnKey);
  const stored = useStore((s) => sideBoxOf(s, chat.id));
  const fill = sideFillOf(route);
  // A link's fill: plain text with its line, the box's own until the user edits or sends it, never saved by itself
  // (5.1 rule 7); meanwhile the server's side draft stays under it, as the message box keeps a link's pre-fill.
  const [linkFill, setLinkFill] = useState<string | null>(() => (!locked && takeFill(chat.id, fill) && fill?.text !== undefined ? fill.text : null));
  // A link opened while the side chat shows (Back, Forward, the address bar) fills again. Row 80: not while the chat is
  // held; a link that came during the hold fills when it ends.
  const fillKey = fill?.key ?? "";
  useEffect(() => {
    if (locked || !takeFill(chat.id, fill) || fill?.text === undefined) return;
    setLinkFill(fill.text);
    // Only the fill's key and the hold decide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fillKey, locked]);
  const text = linkFill ?? stored.text;
  const link = linkFill !== null || stored.link;
  // U4: in the half that is not the URL's own view, a letter or a Send makes it that view (the places kept), so the
  // next opener (4.2 rule 4) takes the half the user did not use last. True when it did.
  const takePath = () => {
    const own = halfOwnHref(route);
    if (own) navigate(own, { replace: true });
    return own !== null;
  };
  // The user's own typing is the side draft: kept at once, saved on the server (an edited link fill keeps its mark).
  const set = (next: string) => {
    setLinkFill(null);
    act.setSideDraft(chat.id, { text: next, link: link && next !== "" });
    takePath();
  };
  const question = questionText(text);
  const canSend = !locked && !asking && question !== null;

  const send = () => {
    if (!canSend || question === null) return;
    setLinkFill(null);
    // The box empties at once, and the server clears the side draft on every page; a busy or refused question comes
    // back into it (act.sideSend).
    void act.sideSend(chat.id, question);
    // The link's text is in the thread now: its URL goes, so a reload does not fill it again.
    if (!takePath() && fill) navigate(halfLink(route, sideHref(chat.id, viewOf(route))), { replace: true });
  };
  const stop = () => {
    if (!asking) return;
    const x = asking;
    void act.sideStop(chat.id, x.id).then((stopped) => stopped && sideBoxBack(chat.id, x.question));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (locked || e.key !== "Enter" || e.shiftKey || e.altKey) return;
    // DESIGN.md 7.5: an input method that is composing a word takes its Return (composer/composition.ts imeKey); on
    // touch the Return key setting decides, and a dictated question sends.
    if (imeKey(e.nativeEvent, vp.touch)) return;
    const forced = e.metaKey || e.ctrlKey;
    if (vp.touch && returnKey !== "send" && !forced) return;
    e.preventDefault();
    send();
  };

  // It grows to 6 lines on a laptop and a tablet, 4 on the phone, then scrolls.
  const maxLines = vp.size === "phone" ? 4 : 6;
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight) || 20;
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const max = Math.round(lh * maxLines + pad);
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [text, maxLines, vp.width, field]);

  const keep = (e: PointerEvent) => e.preventDefault(); // a tap on the key keeps the keyboard up (7.5)
  const keySize = vp.touch ? 20 : 14;
  const key = asking ? (
    <button type="button" className="cmp-key cmp-stop sc-key" aria-label="Stop side question" title="Stop" data-testid="side-stop" onPointerDown={keep} onClick={stop}>
      <IconStop size={keySize} />
    </button>
  ) : (
    <button type="button" className="cmp-key cmp-send sc-key" aria-label="Send" title="Send (Enter)" data-testid="side-send" disabled={!canSend} onPointerDown={keep} onClick={send}>
      <IconSend size={keySize} />
    </button>
  );
  return (
    <div className="sc-box" data-testid="side-box" data-kb-owner="">
      <div className={`sc-field${locked ? " is-held" : ""}`}>
        <textarea
          ref={field}
          className="sc-input"
          data-testid={SIDE_FIELD_ID}
          rows={1}
          dir="auto"
          maxLength={SIDE_TEXT_MAX}
          readOnly={locked}
          value={text}
          placeholder={locked ? "" : SIDE_PLACEHOLDER}
          aria-label="Side question"
          enterKeyHint={vp.touch && returnKey === "newline" ? "enter" : "send"}
          autoComplete="off"
          onChange={(e) => set(e.target.value)}
          onKeyDown={onKeyDown}
          // The side draft's wait for the typing to stop, and its save at once on blur (the message box's rules).
          onCompositionStart={() => act.setSideComposing(chat.id, true)}
          onCompositionEnd={() => act.setSideComposing(chat.id, false)}
          onBlur={flushDrafts}
        />
        {key}
      </div>
      <div className="sc-lines">
        {fill?.overCap ? (
          <p className="cmp-line is-warn" data-testid="link-notice" role="status">
            {TOO_LONG}
          </p>
        ) : null}
        <ExternalLinkLine text={link ? text : ""} />
      </div>
    </div>
  );
}

/**
 * The riding sheet's height cap (rows 115 and 121: the sheet takes little room): half the visual viewport, so part of
 * the chat stays in view above it while the user types a question about it, never less than the sheet without its
 * thread (`rest`: the grip, the title row and the box; the thread scrolls inside), and never over the title bar.
 */
export function rideHeight(visual: number, rest: number): number {
  return Math.max(0, Math.min(visual - HEADER_PX, Math.max(rest, Math.round(visual / 2))));
}

/** The riding sheet's height without its thread's list, measured again as its box grows or shrinks. */
function useSheetRest(box: React.RefObject<HTMLDivElement | null>, on: boolean): number {
  const [rest, setRest] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!on || !el) return;
    const measure = () => {
      const list = el.querySelector<HTMLElement>(".sc-list");
      // scrollHeight counts what a cap too small would clip, so the box is never cut.
      const next = Math.ceil(el.scrollHeight - (list?.offsetHeight ?? 0));
      setRest((was) => (was === next ? was : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    for (const part of el.querySelectorAll<HTMLElement>(".sheet-head, .sc-box")) ro.observe(part);
    return () => ro.disconnect();
  }, [box, on]);
  return rest;
}

/**
 * The phone's side chat sheet (7.6): the grip, the title row with "Side chat" and Done, the thread and the box. A modal
 * layer (Esc and the scrim close it; Back leaves its route). No first focus on touch. While the on-screen keyboard is
 * up and the box has the focus, it rides the keyboard: its foot at the visual viewport's, at most half the visual
 * viewport high (rideHeight), so the chat above it stays in view.
 */
function SideSheet({ onClose, touch, children }: { onClose: () => void; touch: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayer({ active: true, box: ref, onClose, modal: true });
  const kb = useSoftKeyboard(touch);
  const focusIn = useFocusInside(ref, touch);
  const riding = kb.up && focusIn;
  const rest = useSheetRest(ref, riding);
  const style = riding ? { maxHeight: rideHeight(kb.visualHeight, rest), transform: `translateY(calc(${kb.offsetTop + kb.visualHeight}px - 100%))` } : undefined;
  const drag = useSheetDrag(ref, onClose);
  return createPortal(
    <>
      <Scrim onClick={onClose} />
      <SideSheetFrame box={ref} riding={riding} style={style} drag={drag} onClose={onClose}>
        {children}
      </SideSheetFrame>
    </>,
    document.body,
  );
}

/** The sheet itself (outside its portal, so a test can draw it): the grip and the title row are its drag handle. */
export function SideSheetFrame(props: { box?: React.RefObject<HTMLDivElement | null>; riding?: boolean; style?: CSSProperties; drag?: SheetDrag; onClose: () => void; children: ReactNode }) {
  const { box, riding, style, drag, onClose, children } = props;
  const titleId = useId();
  return (
    <div ref={box} className={`sheet sc-sheet${riding ? " is-riding" : ""}`} style={style} role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="side-chat" data-place="sheet" tabIndex={-1}>
      <div className="sheet-grip" aria-hidden="true" data-testid="side-grip" {...drag} />
      <div className="sheet-head" {...drag}>
        <h2 className="sheet-title" id={titleId}>
          {SIDE_TITLE}
        </h2>
        <button type="button" className="btn plain sheet-done" data-testid="sheet-done" onClick={onClose}>
          Done
        </button>
      </div>
      <div className="sc sc-at-sheet">{children}</div>
    </div>
  );
}

/** Whether a drag down of `dy` px over `ms` closes the sheet: past the line, or a flick. */
export function dragCloses(dy: number, ms: number): boolean {
  if (dy >= SHEET_CLOSE_PX) return true;
  return dy > 16 && ms > 0 && dy / ms >= FLICK_PX_PER_MS;
}

/**
 * The sheet's drag to close, on its grip and title row (not on Done): it follows the finger down (with Reduce motion
 * it stays), and on release closes past the line or on a flick, else settles back.
 */
type SheetDrag = ReturnType<typeof useSheetDrag>;
function useSheetDrag(box: React.RefObject<HTMLDivElement | null>, onClose: () => void) {
  const start = useRef<{ y: number; t: number; id: number; dy: number } | null>(null);
  const end = (e: PointerEvent<HTMLDivElement>, cancel: boolean) => {
    const s = start.current;
    const el = box.current;
    if (!s || s.id !== e.pointerId) return;
    start.current = null;
    if (!el) return;
    el.classList.remove("is-dragging");
    if (!cancel && dragCloses(s.dy, e.timeStamp - s.t)) {
      onClose();
      return;
    }
    if (!el.style.translate) return;
    el.classList.add("is-settling");
    el.style.translate = "";
    setTimeout(() => el.classList.remove("is-settling"), 260);
  };
  return {
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 || (e.target as Element).closest("button")) return;
      start.current = { y: e.clientY, t: e.timeStamp, id: e.pointerId, dy: 0 };
      e.currentTarget.setPointerCapture?.(e.pointerId);
      box.current?.classList.add("is-dragging");
    },
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
      const s = start.current;
      if (!s || s.id !== e.pointerId) return;
      s.dy = Math.max(0, e.clientY - s.y);
      if (!reduceMotion() && box.current) box.current.style.translate = `0 ${s.dy}px`;
    },
    onPointerUp: (e: PointerEvent<HTMLDivElement>) => end(e, false),
    onPointerCancel: (e: PointerEvent<HTMLDivElement>) => end(e, true),
  };
}

