// U3 (DESIGN-U3 4 to 9, 13): the turn rail beside the conversation's text on a laptop. A navigation list named
// "Turns", one link per turn (rail.ts marks): a 2 px tick in --faint, longer in --dim under the pointer or while its
// card shows, longest in --text for the current turn (aria-current="location"); while the turn runs in --ok-fill and
// while it waits in --attn-dot, the chat list's dots for a chat that runs and one that needs you (review U3: --accent
// is the text's colour in Mono and Editor). A link goes to /c/<chat>/m/<target> (with the view), drawn through Link: a
// plain click goes there in place, a middle click or Cmd-click opens a tab; nothing else happens. The rail is one Tab
// stop (a roving tabindex, Desktop's pattern for a row of controls): Up and Down, Home and End move between the marks,
// Enter follows the link. A mark with the keyboard focus shows its card (role="tooltip") at once, and a mark under
// the pointer once the reader means it (review U3): the pointer rests on the rail for INTENT_MS, or moves along it to
// another mark, so a pointer that only crosses the rail on its way into the column opens nothing. The card: the turn's
// first input line with U2's quiet tag, then up to three lines of its last reply, worked out when it opens, each in
// its own direction (dir="auto", as the bubble). Once it shows it follows the pointer along the rail at once (not
// marks that scroll under a still pointer), stays while the pointer is on it, goes 100 ms after the pointer leaves
// both, when the focus leaves the rail, when a mark is clicked or when the card itself is clicked (a click on the card
// only closes it), and the first Esc hides it (used up, so the composer's Esc does not stop the turn). A wheel over
// the rail (when its ladder cannot scroll that way) or over the card scrolls the conversation, as a wheel over the
// text does, and the card goes (review U3: both sit beside the scroller, not in it). More than 40 marks scroll inside
// the rail with a fade at each end that can scroll; the current mark is kept in view, never under the pointer. Older
// turns that are not loaded show as three dots, and a sentence for screen readers. No motion: everything changes at
// once.
import { memo, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { href } from "../router";
import { Link } from "../ui/primitives";
import type { RailCard, RailMark } from "./rail";

export const RAIL_NAME = "Turns";
export const OLDER_NOT_LOADED = "Older turns are not loaded.";
/** ms: the card stays this long after the pointer leaves the rail and the card (time to cross the gap between them). */
const GRACE_MS = 100;
/** ms: the pointer rests on the rail this long before a card shows (a crossing at 500 px a second takes 40 ms). */
export const INTENT_MS = 150;
/** px: the fade at a scrollable end of the rail; the current mark is kept inside it. */
const FADE = 20;
/** px: the card stays this far inside the band above the composer. */
const BAND_PAD = 8;
const MARK = "a.chat-rail-mark";

/** What ChatView tells the rail: the current turn (null: the last one, while the view follows the end), and its place. */
export interface RailApi {
  setCurrent(turn: string | null): void;
  /**
   * The rail's left inside the wrap, in px: --rail-x on the rail and its card only (a change on the wrap would restyle
   * the whole transcript while a pane's handle drags). The same value again writes nothing.
   */
  place(x: number): void;
}

/** What the rail asks ChatView. */
export interface RailHooks {
  /** The card's words for a turn, when its card opens. */
  card(turn: string): RailCard | null;
  /** Just before a mark's link goes to `to`: keep the reader's place for Back (or land again when `to` is open already). */
  leave(mark: RailMark, to: string): void;
  /** A wheel over the rail or its card that the rail does not use: the conversation scrolls by it, as by the reader's. */
  wheel(deltaY: number, deltaMode: number): void;
}

interface Preview {
  i: number;
  turn: string;
  by: "pointer" | "focus";
  card: RailCard;
}

const RailMarkItem = memo(function RailMarkItem({ mark, i, to, current, previewed, tab, described, leave }: { mark: RailMark; i: number; to: string; current: boolean; previewed: boolean; tab: number; described: string | undefined; leave: (m: RailMark, to: string) => void }) {
  const state = mark.state === "running" ? " is-running" : mark.state === "waiting" ? " is-waiting" : "";
  return (
    <li>
      <Link
        to={to}
        className={`chat-rail-mark${state}${previewed ? " is-previewed" : ""}`}
        aria-label={mark.name}
        aria-current={current ? "location" : undefined}
        aria-describedby={described}
        tabIndex={tab}
        data-i={i}
        onNavigate={() => leave(mark, to)}
      >
        {null}
      </Link>
    </li>
  );
});

/** The card's words: the prompt line with its tag, then the answer lines. */
export function RailCardBody({ card }: { card: RailCard }) {
  return (
    <>
      {card.prompt !== null ? (
        <p className="chat-rail-prompt">
          <span className="chat-rail-prompt-text" dir="auto">
            {card.prompt}
          </span>
          {card.tag ? <span className="chat-tag">{card.tag}</span> : null}
        </p>
      ) : null}
      <p className={`chat-rail-answer${card.first ? " is-first" : ""}`} dir="auto">
        {card.answer}
      </p>
    </>
  );
}

/** Scroll the rail so the mark shows inside its fades (at once). */
function keepInView(nav: HTMLElement, a: HTMLElement) {
  if (nav.scrollHeight <= nav.clientHeight) return;
  const top = a.offsetTop;
  if (top < nav.scrollTop + FADE || top + a.offsetHeight > nav.scrollTop + nav.clientHeight - FADE) nav.scrollTop = top - (nav.clientHeight - a.offsetHeight) / 2;
}

export const TurnRail = memo(function TurnRail({ marks, partial, chatId, view, api, hooks }: { marks: readonly RailMark[]; partial: boolean; chatId: string; view: string | undefined; api: RefObject<RailApi | null>; hooks: RefObject<RailHooks> }) {
  const [current, setCurrent] = useState<string | null>(null);
  const [focusAt, setFocusAt] = useState<number | null>(null);
  const [preview, setPreviewState] = useState<Preview | null>(null);
  const cardId = `chat-rail-card${useId().replace(/:/g, "")}`;
  const nav = useRef<HTMLElement>(null);
  const cardEl = useRef<HTMLDivElement>(null);
  const shown = useRef<Preview | null>(null);
  const marksNow = useRef(marks);
  marksNow.current = marks;
  const over = useRef({ rail: false, card: false });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The mark whose card Esc hid: the pointer on it does not show it again until it moves to another. */
  const dismissed = useRef<number | null>(null);
  /**
   * Review U3: where the pointer came onto the rail while no card showed (its point and mark), the mark under it now,
   * and the timer that shows that mark's card once the pointer has rested on the rail for INTENT_MS.
   */
  const intent = useRef<{ x: number; y: number; i: number } | null>(null);
  const under = useRef<number | null>(null);
  const intentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** The place ChatView gave (RailApi.place), kept for a card that opens later. */
  const railX = useRef<number | null>(null);
  const putX = (el: HTMLElement | null) => {
    if (el && railX.current !== null) el.style.setProperty("--rail-x", `${railX.current}px`);
  };
  useImperativeHandle(
    api,
    () => ({
      setCurrent: (turn) => setCurrent((c) => (c === turn ? c : turn)),
      place: (x) => {
        if (railX.current === x) return;
        railX.current = x;
        putX(nav.current);
        putX(cardEl.current);
      },
    }),
    [],
  );

  const at = current === null ? -1 : marks.findIndex((m) => m.turn === current);
  const cur = at >= 0 ? at : marks.length - 1;
  const hrefs = useMemo(() => marks.map((m) => href("message", { chat: chatId, message: m.target }, { view })), [marks, chatId, view]);
  // A click goes: the card has done its job (the turn it shows is now at the top), so it closes, as after Esc.
  const leave = useCallback(
    (m: RailMark, to: string) => {
      hooks.current.leave(m, to);
      dismissed.current = marksNow.current.findIndex((x) => x.turn === m.turn);
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      if (intentTimer.current) clearTimeout(intentTimer.current);
      intentTimer.current = null;
      intent.current = null;
      shown.current = null;
      setPreviewState(null);
    },
    [hooks],
  );

  const setPreview = (p: Preview | null) => {
    shown.current = p;
    setPreviewState(p);
  };
  const open = (i: number, by: Preview["by"]) => {
    const m = marksNow.current[i];
    if (!m) return;
    const p = shown.current;
    if (p && p.i === i && p.turn === m.turn) {
      if (p.by !== by) setPreview({ ...p, by });
      return;
    }
    const card = hooks.current.card(m.turn);
    setPreview(card ? { i, turn: m.turn, by, card } : null);
  };
  const markEls = () => (nav.current ? Array.from(nav.current.querySelectorAll<HTMLElement>(MARK)) : []);
  const indexOf = (el: EventTarget | null): number | null => {
    const a = el instanceof Element ? el.closest(MARK) : null;
    const i = a ? Number(a.getAttribute("data-i")) : NaN;
    return Number.isInteger(i) ? i : null;
  };
  const focusedMark = () => (nav.current?.contains(document.activeElement) ? indexOf(document.activeElement) : null);
  const cancelHide = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const hideSoon = () => {
    cancelHide();
    timer.current = setTimeout(() => {
      timer.current = null;
      if (over.current.rail || over.current.card) return;
      const f = focusedMark();
      if (f !== null) open(f, "focus");
      else setPreview(null);
    }, GRACE_MS);
  };
  useEffect(() => cancelHide, []);
  /** No card is wanted yet: the pointer that came onto the rail has not rested on it nor moved along it. */
  const endIntent = () => {
    if (intentTimer.current) clearTimeout(intentTimer.current);
    intentTimer.current = null;
    intent.current = null;
  };
  useEffect(() => endIntent, []);
  /**
   * The pointer is on mark `i` and no card shows: does the reader want one? Yes when the pointer moved along the rail
   * to another mark (more down or up than sideways since it came onto the rail); else the card shows once the pointer
   * has stayed on the rail for INTENT_MS (on the mark under it then). A pointer that crosses the rail sideways leaves it
   * first, and nothing shows.
   */
  const wants = (i: number, x: number, y: number): boolean => {
    under.current = i;
    const it = intent.current;
    if (!it) {
      intent.current = { x, y, i };
      intentTimer.current = setTimeout(() => {
        intentTimer.current = null;
        intent.current = null;
        const k = under.current;
        if (!over.current.rail || k === null || dismissed.current === k || shown.current) return;
        dismissed.current = null;
        open(k, "pointer");
      }, INTENT_MS);
      return false;
    }
    return i !== it.i && Math.abs(y - it.y) >= Math.abs(x - it.x);
  };
  /** A wheel the rail passes on: the card goes (as after Esc, until the pointer is on another mark), the conversation scrolls. */
  const passWheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = shown.current;
    if (p) {
      dismissed.current = p.i;
      cancelHide();
      over.current.card = false;
      setPreview(null);
    }
    endIntent();
    hooks.current.wheel(e.deltaY, e.deltaMode);
  };
  const passNow = useRef(passWheel);
  passNow.current = passWheel;
  // The wheel listeners are not passive (React's onWheel is), so a wheel the rail passes on scrolls nothing else.
  useEffect(() => {
    const el = nav.current;
    if (!el) return;
    const on = (e: WheelEvent) => {
      // A pinch (Ctrl and the wheel) zooms, and a sideways swipe is the browser's.
      if (e.ctrlKey || e.deltaY === 0) return;
      // A ladder taller than the rail scrolls first, to its end.
      const max = el.scrollHeight - el.clientHeight;
      if (max > 1 && (e.deltaY < 0 ? el.scrollTop > 0.5 : el.scrollTop < max - 0.5)) return;
      passNow.current(e);
    };
    el.addEventListener("wheel", on, { passive: false });
    return () => el.removeEventListener("wheel", on);
  }, []);
  const cardShown = preview !== null;
  useEffect(() => {
    const el = cardEl.current;
    if (!el) return;
    const on = (e: WheelEvent) => {
      if (e.ctrlKey || e.deltaY === 0) return;
      passNow.current(e);
    };
    el.addEventListener("wheel", on, { passive: false });
    return () => el.removeEventListener("wheel", on);
  }, [cardShown]);

  const focusMark = (i: number) => {
    const a = markEls()[i];
    if (!a || !nav.current) return;
    setFocusAt(i);
    a.focus({ preventScroll: true });
    keepInView(nav.current, a);
  };

  // The current mark stays in view (not while the pointer is on the rail), and the fades say which ends can scroll.
  const fades = () => {
    const el = nav.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    el.classList.toggle("fade-top", max > 1 && el.scrollTop > 1);
    el.classList.toggle("fade-bottom", max > 1 && el.scrollTop < max - 1);
  };
  const curNow = useRef(cur);
  curNow.current = cur;
  const settle = () => {
    const el = nav.current;
    const a = markEls()[curNow.current];
    if (el && a && !over.current.rail) keepInView(el, a);
    fades();
  };
  useLayoutEffect(settle, [cur, marks]);
  // The rail's height follows the band (a window or a pane that resizes): the same again then.
  useEffect(() => {
    const el = nav.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => settle());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The card sits beside its mark, centred on it and kept inside the band (set at once, before the paint).
  useLayoutEffect(() => {
    const card = cardEl.current;
    const el = nav.current;
    const wrap = el?.parentElement;
    const a = preview ? markEls()[preview.i] : undefined;
    if (!card || !wrap || !a) return;
    putX(card);
    const w = wrap.getBoundingClientRect();
    const r = a.getBoundingClientRect();
    const h = card.offsetHeight;
    // The band starts below the title bar where the conversation scrolls under it (the glass look's scroll padding).
    const sc = wrap.querySelector<HTMLElement>(":scope > .chat-scroll");
    const bar = sc ? parseFloat(getComputedStyle(sc).scrollPaddingTop) || 0 : 0;
    const mid = r.top + r.height / 2 - w.top;
    card.style.top = `${Math.round(Math.max(bar + BAND_PAD, Math.min(w.height - h - BAND_PAD, mid - h / 2)))}px`;
  }, [preview]);

  // A mark that is gone (the marks changed) takes its card with it.
  useEffect(() => {
    const p = shown.current;
    if (p && marks[p.i]?.turn !== p.turn) setPreview(null);
    if (focusAt !== null && focusAt >= marks.length) setFocusAt(null);
  }, [marks]);

  // Esc hides the card first, and is used up (DESIGN-U3 5): the composer's and the waiting card's Esc check it.
  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing || document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      dismissed.current = shown.current?.i ?? null;
      cancelHide();
      setPreview(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [preview]);

  const tabAt = focusAt ?? cur;
  return (
    <>
      <nav
        ref={nav}
        className="chat-rail"
        aria-label={RAIL_NAME}
        data-testid="turn-rail"
        onScroll={fades}
        onPointerMove={(e) => {
          if (e.pointerType === "touch") return;
          over.current.rail = true;
          cancelHide();
          const i = indexOf(e.target);
          if (i === null) return;
          under.current = i;
          if (dismissed.current === i) return;
          // A card that shows follows the pointer at once; else it waits for the reader's intent (review U3).
          if (!shown.current && !wants(i, e.clientX, e.clientY)) return;
          endIntent();
          dismissed.current = null;
          open(i, "pointer");
        }}
        onPointerLeave={() => {
          over.current.rail = false;
          under.current = null;
          endIntent();
          hideSoon();
        }}
        onFocus={(e) => {
          const i = indexOf(e.target);
          if (i === null) return;
          setFocusAt(i);
          dismissed.current = null;
          open(i, "focus");
        }}
        onBlur={(e) => {
          const to = e.relatedTarget instanceof Node ? e.relatedTarget : null;
          if (to && (nav.current?.contains(to) || cardEl.current?.contains(to))) return;
          setFocusAt(null);
          if (!over.current.rail && !over.current.card) setPreview(null);
        }}
        onKeyDown={(e) => {
          if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
          const n = marks.length;
          const from = focusAt ?? cur;
          const to = e.key === "ArrowDown" ? Math.min(n - 1, from + 1) : e.key === "ArrowUp" ? Math.max(0, from - 1) : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : null;
          if (to === null) return;
          e.preventDefault();
          focusMark(to);
        }}
      >
        {partial ? <p className="visually-hidden">{OLDER_NOT_LOADED}</p> : null}
        <ol className="chat-rail-list">
          {partial ? (
            <li className="chat-rail-more" aria-hidden="true">
              <i />
              <i />
              <i />
            </li>
          ) : null}
          {marks.map((m, i) => (
            <RailMarkItem key={m.turn} mark={m} i={i} to={hrefs[i]!} current={i === cur} previewed={preview?.i === i} tab={i === tabAt ? 0 : -1} described={preview?.i === i && focusAt === i ? cardId : undefined} leave={leave} />
          ))}
        </ol>
      </nav>
      {preview ? (
        <div
          ref={cardEl}
          id={cardId}
          className="chat-rail-card"
          role="tooltip"
          data-testid="turn-rail-card"
          onPointerEnter={() => {
            over.current.card = true;
            cancelHide();
          }}
          onPointerLeave={() => {
            over.current.card = false;
            hideSoon();
          }}
          onClick={() => {
            // Review U3: a click on the card only closes it (as Esc does): a click meant for what the card covers
            // (a code block's Copy, a link) never jumps to another turn. The mark is the link.
            dismissed.current = preview.i;
            cancelHide();
            over.current.card = false;
            setPreview(null);
          }}
        >
          <RailCardBody card={preview.card} />
        </div>
      ) : null}
    </>
  );
});
