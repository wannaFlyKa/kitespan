// Shared primitives. Popup renders an anchored menu on a laptop and on a tablet (medium touch, and the large tablet,
// which is the laptop layout with touch: DESIGN.md 5.3 and 7.4; 44 px rows on touch), and an opaque bottom sheet on
// the phone or when it has no anchor (popupIsSheet; areas that draw a popup's rows read usePopupSheet). Dialog is modal everywhere. Sheets and
// dialogs trap the focus while they are open and give it back to the element that opened them (DESIGN.md 6.13).
// The look is plan v2's (base.css): a sheet has the grabber and a title row with the title centred and Done at the
// top right; Segmented (ui/Segmented.tsx), Switch (ui/Switch.tsx) and the files parts (ui/files.tsx) sit beside these.
import { Children, Fragment, cloneElement, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import { createPortal } from "react-dom";
import { closeTo, navigate } from "../router";
import { useViewport, type SizeClass } from "../layout/size";
import { dimThemeColor } from "./look";
import { imeHolds } from "../composer/composition";

export { useCopy, type CopyState, type CopyTarget } from "./Copy";
export { Segmented, segmentFor, type SegmentOption } from "./Segmented";
export { Switch, switchKey } from "./Switch";

/**
 * A link that navigates in the page. With `close`, it closes the open state it points away from: it goes back when the
 * entry before is `to` (closeTo, DESIGN.md 5.1 rule 4), so closing leaves no history entry behind.
 */
export function Link(props: {
  to: string;
  replace?: boolean;
  close?: boolean;
  className?: string;
  children: ReactNode;
  title?: string;
  dir?: "auto";
  draggable?: boolean;
  "aria-label"?: string;
  "aria-current"?: "page" | "location" | undefined;
  "aria-keyshortcuts"?: string;
  /** U3: the turn rail's marks (one Tab stop, their card). */
  tabIndex?: number;
  "aria-describedby"?: string;
  "data-i"?: number;
  "data-testid"?: string;
  onNavigate?: () => void;
  /** A row menu's target (ui/RowMenu.tsx): its ref and its press, key and context menu handlers. */
  ref?: Ref<HTMLAnchorElement>;
  onPointerDown?: (e: React.PointerEvent) => void;
  onPointerUp?: (e: React.PointerEvent) => void;
  onPointerCancel?: (e: React.PointerEvent) => void;
  onPointerMove?: (e: React.PointerEvent) => void;
  onClickCapture?: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
}) {
  const { to, replace, close, className, children, onNavigate, ...rest } = props;
  return (
    <a
      href={to}
      className={className}
      {...rest}
      onClick={(e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        onNavigate?.();
        if (close) closeTo(to);
        else navigate(to, { replace });
      }}
    >
      {children}
    </a>
  );
}

/**
 * The layer under a sheet, a dialog or a drawer (base.css .scrim): it dims the whole page, the title bar too, so while
 * it shows the theme-color metas hold the colour it makes over the look's --bg (look.ts dimThemeColor), and the status
 * bar stays the colour of the page under it (DESIGN.md 6.13). It closes only on a click whose press began on it
 * (T-27): the click that a browser may send when a long press's finger lifts lands on the scrim of the sheet that the
 * press opened, and must not close it.
 */
export function Scrim({ onClick }: { onClick: () => void }) {
  useLayoutEffect(() => {
    dimThemeColor(true);
    return () => dimThemeColor(false);
  }, []);
  return (
    <div
      className="scrim"
      onClick={(e) => {
        if (e.detail > 0 && !pressBeganOn(e.currentTarget)) return;
        onClick();
      }}
    />
  );
}

// ---- layers: every open menu, sheet, dialog and drawer, the newest last. Esc closes the newest one only; Tab stays
// inside the newest modal one. Focus goes back to the element that opened a layer when it closes.

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

interface Layer {
  box: RefObject<HTMLElement | null>;
  modal: boolean;
  close: RefObject<() => void>;
  opener: HTMLElement | null;
  /**
   * The opener's place, for when the opener itself is gone: its nearest `[data-focus-return]` (tabIndex -1), for
   * example a trust line whose button an answer took away while its confirm was open (R127).
   */
  place: HTMLElement | null;
  /** The opener of the layer that was on top when this one opened, for when this layer's opener is gone. */
  fallback: HTMLElement | null;
  /** The last element inside the layer that had the focus. */
  inside: HTMLElement | null;
}
const layers: Layer[] = [];
const topLayer = () => layers[layers.length - 1];

/**
 * The IME guard (DESIGN.md 6.4, BUILD-CHECKLIST L13): true while an input method composes a word with a fine pointer
 * (`isComposing`, or the key code 229 that some browsers give its keys), so its arrows, Enter and Esc stay the input
 * method's. On touch it is false: iOS dictation and some keyboards mark every key so, and a tap's key must still act.
 */
export function composingKey(e: { isComposing?: boolean; keyCode?: number }, coarse: boolean): boolean {
  return !coarse && (!!e.isComposing || e.keyCode === 229);
}

const coarseNow = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

/** The elements in a box that Tab can reach, in order. */
export function focusables(box: HTMLElement): HTMLElement[] {
  return [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest("[inert]") && el.getClientRects().length > 0);
}

// What had the focus, and what the pointer pressed last: Safari does not focus a button on a click, so the pressed
// control is the opener when it is recent.
const recent: HTMLElement[] = [];
let pressed: { el: HTMLElement; at: number } | null = null;
// Where the last pointer went down, whatever it was (T-27's guards), and the last scroll (useLongPress).
let lastDown: { target: EventTarget | null; at: number } | null = null;
let lastScroll: { target: EventTarget | null; at: number } | null = null;
// The long presses under way, which a scroll of their scroller ends; and when the last one opened its menu.
const pressing = new Set<{ el: HTMLElement; timer: PressTimer }>();
let pressFiredAt = Number.NEGATIVE_INFINITY;

if (typeof window !== "undefined" && typeof document !== "undefined") {
  document.addEventListener(
    "focusin",
    (e) => {
      const el = e.target;
      if (!(el instanceof HTMLElement)) return;
      const at = recent.indexOf(el);
      if (at >= 0) recent.splice(at, 1);
      recent.push(el);
      if (recent.length > 8) recent.shift();
      // A modal layer keeps the focus: focus that lands outside it comes back in, once the current task is done, so a
      // helper field that a click focuses and removes at once (the old copy command) still works.
      const t = topLayer();
      const box = t?.modal ? t.box.current : null;
      if (!t || !box) return;
      if (box.contains(el)) {
        t.inside = el;
        return;
      }
      setTimeout(() => {
        const now = document.activeElement;
        if (topLayer() !== t || !box.isConnected || (now && box.contains(now))) return;
        (t.inside?.isConnected && box.contains(t.inside) ? t.inside : (focusables(box)[0] ?? box)).focus({ preventScroll: true });
      }, 0);
    },
    true,
  );
  document.addEventListener(
    "pointerdown",
    (e) => {
      notePointerDown(e.target);
      const el = e.target instanceof Element ? e.target.closest(FOCUSABLE) : null;
      notePressed(el instanceof HTMLElement ? el : null);
    },
    true,
  );
  // A scroll anywhere (scroll does not bubble; the capture phase sees every scroller's): a long press in that scroller
  // ends, and one that starts soon after does not arm (useLongPress).
  document.addEventListener("scroll", (e) => void noteScroll(e.target), { capture: true, passive: true });
  // Registered before any component's own key listener, so Esc in a layer reaches nothing else.
  window.addEventListener(
    "keydown",
    (e) => {
      const t = topLayer();
      if (!t) return;
      if (e.key === "Escape") {
        // Esc while an input method composes is the input method's (it cancels the word): the layer stays, and no
        // older surface's Esc (Stop, say) gets it either. Its default is left alone. On touch the key says nothing,
        // so the document's composition does (imeHolds, T-18).
        if (composingKey(e, coarseNow()) || imeHolds()) {
          e.stopImmediatePropagation();
          return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        t.close.current?.();
        return;
      }
      const box = t.box.current;
      if (e.key !== "Tab" || !t.modal || !box) return;
      const items = focusables(box);
      const first = items[0];
      const last = items[items.length - 1];
      const at = document.activeElement;
      if (!first || !last) {
        e.preventDefault();
        box.focus({ preventScroll: true });
      } else if (e.shiftKey && (at === first || at === box || !box.contains(at))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (at === last || !box.contains(at))) {
        e.preventDefault();
        first.focus();
      }
    },
    true,
  );
}

/** A pointer went down on `el` (a control; null when it was none): the page's listener, and the tests' stand-in. */
export function notePressed(el: HTMLElement | null) {
  pressed = el ? { el, at: Date.now() } : null;
}

/** A pointer went down on `target`, any element: the page's listener, and the tests' stand-in. */
export function notePointerDown(target: EventTarget | null, at = performance.now()) {
  lastDown = { target, at };
}

/** True when the last pointer went down on `el` itself (a scrim): its click began there. It is used once. */
export function pressBeganOn(el: EventTarget): boolean {
  const began = lastDown?.target === el;
  if (began) lastDown = null;
  return began;
}

/** When the last pointer went down inside `box` (performance.now()), else null. */
function downInside(box: Node | null): number | null {
  const t = lastDown?.target;
  return box && t instanceof Node && box.contains(t) ? lastDown!.at : null;
}

/**
 * T-27: whether a popup takes a click inside it. A popup that a long press opened (`armed`) opens while the finger is
 * still down, so the click that a browser may send when it lifts lands on the popup's rows: such a popup takes a
 * pointer's click only once a pointer went down inside it after it opened. A click with no pointer (a key's) is taken.
 */
export function popupTakesClick(guard: { armed: boolean; openedAt: number }, pointer: boolean, downAt: number | null): boolean {
  return !guard.armed || !pointer || (downAt !== null && downAt >= guard.openedAt);
}

// Where the page itself last scrolled each scroller to (ownScroll): the scroll event that follows is the page's, not a
// finger's, so it ends no press.
const ownTops = new WeakMap<object, number>();

/**
 * The page scrolled `el` itself (the transcript following the end): its next scroll event, while `el` is still where
 * the page put it, is not a person's scroll (useLongPress).
 */
export function ownScroll(el: { scrollTop: number }): void {
  ownTops.set(el, el.scrollTop);
}

/**
 * A scroll of `target`: unless it is one the page made itself (ownScroll), a long press over it ends and one that
 * starts soon after does not arm. False when it was the page's own. The page's listener, and the tests' stand-in.
 */
export function noteScroll(target: EventTarget | null, at = performance.now()): boolean {
  const own = target && typeof target === "object" ? ownTops.get(target) : undefined;
  if (own !== undefined) {
    if (Math.abs((target as unknown as { scrollTop: number }).scrollTop - own) < 1) return false;
    ownTops.delete(target!);
  }
  lastScroll = { target, at };
  for (const p of pressing) if (scrollsOver(target, p.el)) p.timer.scroll();
  return true;
}

/** When the last scroll that counts came (noteScroll), else null. */
export function lastScrollAt(): number | null {
  return lastScroll?.at ?? null;
}

/** Whether a scroll of `scroller` (an element, or the document for the page) moves `el`. */
function scrollsOver(scroller: EventTarget | null, el: Node): boolean {
  if (typeof document !== "undefined" && (scroller === document || scroller === window)) return true;
  return scroller instanceof Node && scroller.contains(el);
}

/** The control that the pointer pressed last, while that press is recent (a click's handler asks for its own press). */
export function lastPressed(): HTMLElement | null {
  return pressed && Date.now() - pressed.at < 1500 && pressed.el.isConnected ? pressed.el : null;
}

function openerFor(box: HTMLElement | null): HTMLElement | null {
  const usable = (el: Element | null | undefined): el is HTMLElement => el instanceof HTMLElement && el.isConnected && el !== document.body && !box?.contains(el);
  if (pressed && Date.now() - pressed.at < 1500 && usable(pressed.el)) return pressed.el;
  if (usable(document.activeElement)) return document.activeElement;
  for (let i = recent.length - 1; i >= 0; i--) if (usable(recent[i])) return recent[i]!;
  return null;
}

/**
 * Make an open surface a layer: Esc closes it while it is the newest layer, and when it closes, focus goes back to
 * the element that opened it (if the focus was in it or lost), or to that element's `[data-focus-return]` place when
 * the element is gone. A modal layer also takes the focus when it opens
 * (`initial`, else the box itself, which needs tabIndex -1) unless something inside took it already, and keeps Tab
 * inside it. Popup and Dialog use it; a drawer can too.
 */
export function useLayer(opts: { active: boolean; box: RefObject<HTMLElement | null>; onClose: () => void; modal?: boolean; initial?: () => HTMLElement | null | undefined }) {
  const { active, box, onClose, modal = false, initial } = opts;
  const close = useRef(onClose);
  close.current = onClose;
  const first = useRef(initial);
  first.current = initial;
  useLayoutEffect(() => {
    if (!active) return;
    const el = box.current;
    const opener = openerFor(el);
    const place = opener?.parentElement?.closest<HTMLElement>("[data-focus-return]") ?? null;
    const layer: Layer = { box, modal, close, opener, place, fallback: topLayer()?.opener ?? null, inside: null };
    layers.push(layer);
    if (modal && el && !el.contains(document.activeElement)) (first.current?.() ?? el).focus({ preventScroll: true });
    return () => {
      const at = layers.indexOf(layer);
      if (at >= 0) layers.splice(at, 1);
      const now = document.activeElement;
      const lost = !now || now === document.body || !!el?.contains(now);
      if (!lost) return;
      const to = [layer.opener, layer.place, layer.fallback].find((x) => x?.isConnected);
      const above = topLayer();
      if (to && !(above?.modal && above.box.current && !above.box.current.contains(to))) to.focus({ preventScroll: true });
    };
  }, [active, modal, box]);
}

/**
 * DESIGN.md 5.3: pickers and menus are a menu above their button on a laptop and on a tablet ("A menu with 44 px
 * rows" on medium touch; the large tablet is the laptop layout), and a bottom sheet on the phone. A popup with no
 * anchor (a detail view, a dialog's touch form) is a sheet.
 */
export function popupIsSheet(size: SizeClass, anchored: boolean): boolean {
  return size === "phone" || !anchored;
}
/** True when a Popup with (or without) an anchor shows as a sheet here, so its rows can take the sheet's form. */
export function usePopupSheet(anchored = true): boolean {
  return popupIsSheet(useViewport().size, anchored);
}

/** A fixed box's own width, measured away from the window's edge (near it a box shrinks to the room that is left). */
function ownWidth(box: HTMLElement | null): number {
  if (!box) return 0;
  const was = box.style.left;
  box.style.left = "-9999px";
  const w = box.offsetWidth;
  box.style.left = was;
  return w;
}

/**
 * `at`: a menu opens at this point instead of under its anchor (a right-click's pointer); the anchor still counts as
 * the menu's own for the press that closes it. A popup that a long press opened ignores the click that ends the press
 * (T-27, popupTakesClick).
 */
export function Popup(props: { open: boolean; onClose: () => void; anchor?: RefObject<HTMLElement | null>; at?: { x: number; y: number } | null; title: string; children: ReactNode; wide?: boolean; testId?: string }) {
  const { open, onClose, anchor, at, title, children, wide, testId } = props;
  const vp = useViewport();
  const asSheet = popupIsSheet(vp.size, !!anchor);
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const guard = useRef({ armed: false, openedAt: 0 });
  useLayer({ active: open, box: ref, onClose, modal: asSheet, initial: () => ref.current?.querySelector<HTMLElement>("[data-autofocus], [aria-checked='true']") });

  useLayoutEffect(() => {
    if (!open) return;
    const now = performance.now();
    guard.current = { armed: now - pressFiredAt < PRESS_OPENS_MS, openedAt: now };
  }, [open]);
  const onClickCapture = (e: React.MouseEvent) => {
    if (popupTakesClick(guard.current, e.detail > 0, downInside(ref.current))) return;
    e.preventDefault();
    e.stopPropagation();
    takeFocus();
  };
  // A popup that a long press opened takes the focus once the finger lifts (the press's end gives it back to the
  // target, or to the body behind a sheet), as one its opener opened has it: a screen reader's hold and a keyboard
  // then start inside it.
  const takeFocus = () => {
    const box = ref.current;
    if (!box || box.contains(document.activeElement)) return;
    (box.querySelector<HTMLElement>("[data-autofocus], [aria-checked='true']") ?? focusables(box)[0] ?? box).focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!open || !guard.current.armed) return;
    // The hold's own lift: its pointerup, touchend and the click a browser may send after them (which moves the focus
    // to where it lands), each followed by the move; that click, or the next press, ends the watch.
    const timers: ReturnType<typeof setTimeout>[] = [];
    const kinds = ["pointerup", "touchend", "click"] as const;
    const off = () => {
      for (const k of kinds) window.removeEventListener(k, lift, true);
      window.removeEventListener("pointerdown", next, true);
    };
    function lift(e: Event) {
      timers.push(setTimeout(takeFocus, 0));
      if (e.type === "click") off();
    }
    const next = () => off();
    for (const k of kinds) window.addEventListener(k, lift, true);
    window.addEventListener("pointerdown", next, true);
    return () => {
      off();
      window.removeEventListener("pointerdown", next, true);
      for (const t of timers) clearTimeout(t);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const atX = at?.x;
  const atY = at?.y;
  useLayoutEffect(() => {
    if (!open || asSheet || !anchor?.current) return;
    const r = atX !== undefined && atY !== undefined ? { left: atX, top: atY, bottom: atY } : anchor.current.getBoundingClientRect();
    // Its own width, drawn once off screen (a row menu's first line and padding make it wider than 300 px), so its
    // right edge keeps 8 px from the window's.
    const width = Math.min(ownWidth(ref.current) || (wide ? 420 : 300), window.innerWidth - 16);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    if (r.top > window.innerHeight / 2) setPos({ left, bottom: window.innerHeight - r.top + 6 });
    else setPos({ left, top: r.bottom + 6 });
  }, [open, asSheet, anchor, atX, atY, wide, vp.width, vp.height]);

  useEffect(() => {
    if (!open || asSheet) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor?.current?.contains(t)) return;
      onClose();
    };
    window.addEventListener("pointerdown", down, true);
    return () => window.removeEventListener("pointerdown", down, true);
  }, [open, asSheet, onClose, anchor]);

  if (!open) return null;
  if (asSheet)
    return createPortal(
      <>
        <Scrim onClick={onClose} />
        <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid={testId} ref={ref} tabIndex={-1} onClickCapture={onClickCapture}>
          <div className="sheet-grip" aria-hidden="true" />
          {/* The title row (plan v2): the title centred, Done at the top right, in the accent and semibold. */}
          <div className="sheet-head">
            <h2 className="sheet-title" id={titleId} dir="auto">
              {title}
            </h2>
            <button type="button" className="btn plain sheet-done" data-testid="sheet-done" onClick={onClose}>
              Done
            </button>
          </div>
          {children}
        </div>
      </>,
      document.body,
    );
  return createPortal(
    <div className="menu" role="dialog" aria-label={title} data-testid={testId} ref={ref} style={{ position: "fixed", left: pos?.left ?? -9999, top: pos?.top, bottom: pos?.bottom, minWidth: wide ? 360 : 240 }} onClickCapture={onClickCapture}>
      {children}
    </div>,
    document.body,
  );
}

export function Dialog(props: { open: boolean; onClose: () => void; title: string; children: ReactNode; testId?: string; initial?: (box: HTMLElement) => HTMLElement | null }) {
  const { open, onClose, title, children, testId, initial } = props;
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // The first focus: the caller's pick (null: the dialog itself), else a marked element, a field or the primary button.
  const first = (box: HTMLElement) => (initial ? initial(box) : box.querySelector<HTMLElement>("[data-autofocus], input, textarea, button.primary"));
  useLayer({ active: open, box: ref, onClose, modal: true, initial: () => (ref.current ? first(ref.current) : null) });
  if (!open) return null;
  return createPortal(
    <>
      <Scrim onClick={onClose} />
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid={testId} ref={ref} tabIndex={-1}>
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </>,
    document.body,
  );
}

/**
 * FIX-Q1: a row of buttons (a card's answers, a dialog's) in the order the eye reads them. A row keeps the order
 * written, the main action last, at the right; where the buttons stack (the phone, or a card's row that does not fit),
 * the main action is on top, so it comes first in the DOM too, and Tab and a screen reader meet the buttons in the order
 * they show. Each button keeps its key either way, so a change of size moves it and never draws it again.
 */
export function readingOrder(buttons: ReactNode, stacked: boolean): ReactNode[] {
  const list = flatButtons(buttons, "");
  return stacked ? list.reverse() : list;
}

/** The buttons of a fragment as one list, each with a key of its own. */
function flatButtons(kids: ReactNode, prefix: string): ReactNode[] {
  return Children.toArray(kids).flatMap((k) => {
    if (!isValidElement(k)) return [k];
    const key = `${prefix}${String(k.key)}`;
    if (k.type === Fragment) return flatButtons((k.props as { children?: ReactNode }).children, `${key}/`);
    return [prefix ? cloneElement(k, { key }) : k];
  });
}

/** A finger always jitters a little: a long-press ignores movement under this many pixels. */
export const LONG_PRESS_SLOP = 8;
/** How long a finger holds before a long press opens its menu (DESIGN.md 7.7). */
export const LONG_PRESS_MS = 500;
/** After this much of the hold the target wears the pressed wash (data-pressing), so the finger sees what it holds. */
export const PRESS_WASH_MS = 150;
/** A press that starts this soon after its scroller scrolled does not arm: a finger that stops a fling rests to read. */
export const SCROLL_QUIET_MS = 300;
/** A popup that opens this soon after a long press fired is the press's (T-27's guard arms). */
const PRESS_OPENS_MS = 1000;

/** The long press's clock: the time now (performance.now()) and a timer, the page's or a test's. */
export interface PressClock {
  now(): number;
  later(run: () => void, ms: number): () => void;
}
const PAGE_CLOCK: PressClock = {
  now: () => performance.now(),
  later: (run, ms) => {
    const t = setTimeout(run, ms);
    return () => clearTimeout(t);
  },
};

/**
 * One target's long press, apart from React and the DOM so its timing can be tested with a clock: `down` arms it
 * (unless its scroller scrolled in the last 300 ms), the wash shows after 150 ms, and the press fires at `ms`; a move
 * of 8 px or more, a scroll of its scroller, or the pointer's end cancels it.
 */
export class PressTimer {
  /** True from the moment the press fired until the next `down`: the click that ends it is swallowed. */
  fired = false;
  private start: { x: number; y: number } | null = null;
  private stopFire: (() => void) | null = null;
  private stopWash: (() => void) | null = null;
  private washed = false;
  constructor(
    private readonly clock: PressClock,
    private readonly on: { fire: () => void; wash: (on: boolean) => void },
    private readonly ms = LONG_PRESS_MS,
  ) {}
  /** A touch went down at (x, y); `scrolledAt`, when its scroller last scrolled (null: not lately). True if it armed. */
  down(x: number, y: number, scrolledAt: number | null): boolean {
    this.end();
    this.fired = false;
    if (scrolledAt !== null && this.clock.now() - scrolledAt < SCROLL_QUIET_MS) return false;
    this.start = { x, y };
    this.stopWash = this.clock.later(() => {
      this.stopWash = null;
      this.washed = true;
      this.on.wash(true);
    }, PRESS_WASH_MS);
    this.stopFire = this.clock.later(() => {
      this.stopFire = null;
      this.fired = true;
      this.on.fire();
    }, this.ms);
    return true;
  }
  /** The pointer moved: a move under the slop is the finger's jitter. */
  move(x: number, y: number) {
    const s = this.start;
    if (s && Math.hypot(x - s.x, y - s.y) < LONG_PRESS_SLOP) return;
    this.end();
  }
  /** The target's scroller scrolled: the finger scrolls, so the press ends. */
  scroll() {
    this.end();
  }
  /** The press ends (the pointer's up or cancel, or a move): no fire, and the wash goes. */
  end() {
    this.stopFire?.();
    this.stopWash?.();
    this.stopFire = this.stopWash = null;
    this.start = null;
    if (this.washed) {
      this.washed = false;
      this.on.wash(false);
    }
  }
  /** True while a press is armed and has not fired. */
  get waiting(): boolean {
    return this.stopFire !== null;
  }
}

/** True while the element holds a text selection that is not empty (T-3: a right-click there is the browser's). */
function selectionIn(el: Element): boolean {
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  return !!sel && !sel.isCollapsed && sel.toString().trim() !== "" && sel.containsNode(el, true);
}

/**
 * Long-press for touch (a menu instead of hover or right-click; 500 ms, DESIGN.md 7.7), on PressTimer. A move of 8 px
 * or more cancels it, and so does a scroll of the target's scroller; a press right after such a scroll does not arm.
 * After 150 ms the target wears data-pressing. A right-click opens the menu at once. onClickCapture swallows the click
 * that ends a long-press; a popup that it opened ignores that click too (Popup's guard).
 */
export function useLongPress(onLongPress: () => void, ms = LONG_PRESS_MS) {
  const latest = useRef(onLongPress);
  latest.current = onLongPress;
  const target = useRef<HTMLElement | null>(null);
  const entry = useRef<{ el: HTMLElement; timer: PressTimer } | null>(null);
  const timer = useRef<PressTimer | null>(null);
  if (!timer.current)
    timer.current = new PressTimer(
      PAGE_CLOCK,
      {
        fire: () => {
          pressFiredAt = performance.now();
          latest.current();
        },
        wash: (on) => {
          const el = target.current;
          if (!el) return;
          if (on) el.setAttribute("data-pressing", "");
          else el.removeAttribute("data-pressing");
        },
      },
      ms,
    );
  const t = timer.current;
  const clear = () => {
    t.end();
    if (entry.current) pressing.delete(entry.current);
    entry.current = null;
  };
  useEffect(() => clear, []); // eslint-disable-line react-hooks/exhaustive-deps
  return {
    onPointerDown: (e: React.PointerEvent) => {
      t.fired = false;
      if (e.pointerType !== "touch") return;
      clear();
      const el = e.currentTarget as HTMLElement;
      target.current = el;
      const scrolledAt = lastScroll && scrollsOver(lastScroll.target, el) ? lastScroll.at : null;
      if (!t.down(e.clientX, e.clientY, scrolledAt)) return;
      entry.current = { el, timer: t };
      pressing.add(entry.current);
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    /** With the event, a move under 8 px is ignored; called with no event, it cancels the press. */
    onPointerMove: (e?: React.PointerEvent) => {
      if (e) t.move(e.clientX, e.clientY);
      else t.end();
      if (!t.waiting) clear();
    },
    onContextMenu: (e: React.MouseEvent) => {
      if (t.fired) {
        e.preventDefault();
        return; // the long-press opened it already (Android also sends contextmenu)
      }
      // T-3: with Shift held, or a text selection in the target, the browser's own menu shows.
      if (e.shiftKey || selectionIn(e.currentTarget)) return;
      e.preventDefault();
      clear();
      latest.current();
    },
    onClickCapture: (e: React.MouseEvent) => {
      if (!t.fired) return;
      t.fired = false;
      e.preventDefault();
      e.stopPropagation();
    },
    /** True when the press now ending fired (its menu is open). */
    fired: () => t.fired,
  };
}

export function relTime(iso: string, now = Date.parse("2026-10-30T09:00:00Z")): string {
  const m = Math.round((now - Date.parse(iso)) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}
