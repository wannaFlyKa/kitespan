// The on-screen keyboard (DESIGN.md 7.8). No CSS unit counts it, so read visualViewport. The keyboard is up when the
// layout height minus the visual height is 100 px or more, which is above the address bar's jitter; a missing or bad
// read counts as down. The layout height is the high-water mark of layout/heightMark.ts, one for every reader: an
// Android in-app web view, and Chrome under interactive-widget=resizes-content, shrink the layout viewport with the
// keyboard, so the live difference would fall to about 0; iOS keeps innerHeight, so the mark costs nothing there.
//
// One read for every part (useSoftKeyboard): one set of listeners on visualViewport and the window, so a part that
// mounts while the keyboard is up reads it as up.
//
// One release at the app's root (useKeyboardRelease, App.tsx): when the keyboard stays down for 450 ms after it was
// up, the field it served lets go (a blur), because Android Back and the iPadOS minimize gesture hide the keyboard
// without one. It follows the focused field, whichever it is (the message box, the new-chat box, the side chat, a
// card's field, a sheet's field, rename, search, the Terminal, the browser pane's fields), and the field's own intent
// cancels it: a press, a focus or a key inside the field's owner ([data-kb-owner]: the composer's root, the side
// chat's box, a waiting card, the Terminal pane, the browser's touch foot) or in the field itself, which is its own
// owner when it has none. A tap elsewhere in the page does not. A width change resets it.
// The parts' own clean-up (the composer closes its `@` picker and its mid-line `/` menu) runs with the release.
import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { heightMark } from "../layout/heightMark";

function subscribeCoarse(cb: () => void) {
  const mq = matchMedia("(pointer: coarse)");
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
/**
 * A coarse pointer: a phone or a tablet with an on-screen keyboard (DESIGN.md 7.5). A touch laptop is fine. The
 * composer and the new-chat form's box take their keys' touch rules from it (the IME guard, the Return key).
 */
export function useCoarse(): boolean {
  return useSyncExternalStore(subscribeCoarse, () => matchMedia("(pointer: coarse)").matches, () => false);
}

/** The least layout height minus visual height that counts as a keyboard. */
export const KEYBOARD_MIN = 100;
/** How long the keyboard stays down before the field is released. */
export const SETTLE_MS = 450;

export interface SoftKeyboard {
  up: boolean;
  /** visualViewport.height, or innerHeight when there is no good read. */
  visualHeight: number;
  /** visualViewport.offsetTop: how far the visual viewport is scrolled down inside the layout viewport. */
  offsetTop: number;
}

/** One read: `mark` is the layout height's high-water mark. */
export function readKeyboard(mark: number, vvHeight: number | undefined, vvTop: number | undefined, innerHeight: number): SoftKeyboard {
  const ok = typeof vvHeight === "number" && Number.isFinite(vvHeight) && vvHeight > 0;
  if (!ok) return { up: false, visualHeight: innerHeight, offsetTop: 0 };
  const top = typeof vvTop === "number" && Number.isFinite(vvTop) ? Math.max(0, vvTop) : 0;
  return { up: mark - vvHeight >= KEYBOARD_MIN, visualHeight: vvHeight, offsetTop: top };
}

const same = (a: SoftKeyboard, b: SoftKeyboard) => a.up === b.up && Math.abs(a.visualHeight - b.visualHeight) < 1 && Math.abs(a.offsetTop - b.offsetTop) < 1;

// ---- the one read ----

let kbNow: SoftKeyboard | null = null;
/** The keyboard now, from the one mark: the same object while nothing moved by a pixel. */
export function currentKeyboard(): SoftKeyboard {
  const vv = window.visualViewport;
  const next = readKeyboard(heightMark(), vv?.height, vv?.offsetTop, window.innerHeight);
  if (kbNow && same(kbNow, next)) return kbNow;
  kbNow = next;
  return next;
}

const readers = new Set<() => void>();
let unwatch: (() => void) | null = null;
/** One set of listeners for every reader, there while any part reads. */
export function subscribeKeyboard(cb: () => void): () => void {
  readers.add(cb);
  if (!unwatch) {
    const vv = window.visualViewport;
    const changed = () => {
      currentKeyboard();
      for (const r of [...readers]) r();
    };
    vv?.addEventListener("resize", changed);
    vv?.addEventListener("scroll", changed);
    window.addEventListener("resize", changed);
    unwatch = () => {
      vv?.removeEventListener("resize", changed);
      vv?.removeEventListener("scroll", changed);
      window.removeEventListener("resize", changed);
    };
  }
  return () => {
    readers.delete(cb);
    if (readers.size || !unwatch) return;
    unwatch();
    unwatch = null;
  };
}

let off: SoftKeyboard | null = null;
/** Down, at the window's height: a part that does not watch (not on touch), and the server's render. */
function downNow(): SoftKeyboard {
  const h = typeof window === "undefined" ? 0 : window.innerHeight;
  if (!off || Math.abs(off.visualHeight - h) >= 1) off = { up: false, visualHeight: h, offsetTop: 0 };
  return off;
}
const noWatch = () => () => {};

/** The parts' clean-up for a keyboard that settled closed (useSoftKeyboard's onSettledClosed), run by the release. */
const SETTLED = new Set<() => void>();

/**
 * The keyboard on a touch device (`enabled`); elsewhere it is always down and nothing is watched. `onSettledClosed`
 * is the part's own clean-up when the root releases its field (useKeyboardRelease); the root blurs the field.
 */
export function useSoftKeyboard(enabled: boolean, onSettledClosed?: () => void): SoftKeyboard {
  const settled = useRef(onSettledClosed);
  settled.current = onSettledClosed;
  useEffect(() => {
    if (!enabled) return;
    const done = () => settled.current?.();
    SETTLED.add(done);
    return () => void SETTLED.delete(done);
  }, [enabled]);
  return useSyncExternalStore(enabled ? subscribeKeyboard : noWatch, enabled ? currentKeyboard : downNow, downNow);
}

// ---- the release ----

export interface DismissWatcher {
  /** A read of the keyboard at the window's width. */
  sample(s: { up: boolean; width: number }): void;
  /** The field's own press, focus or key. */
  intent(): void;
  dispose(): void;
}

/**
 * The settle timer as a pure factory, so a test can drive it with its own clock: after the keyboard was up, a read
 * that finds it down starts the timer; a read that finds it up again, or a width change, stops it. At the timer it
 * checks again that the last read is down and that no intent of the field came since the keyboard went down, then
 * releases once; the next release waits for the keyboard to be up again.
 */
export function createDismissWatcher<T>(o: { settleMs: number; now: () => number; setTimer: (fn: () => void, ms: number) => T; clearTimer: (t: T) => void; release: () => void }): DismissWatcher {
  let width: number | null = null;
  let wasUp = false;
  let last: { up: boolean; width: number } | null = null;
  let timer: { t: T } | null = null;
  let downAt = 0;
  let intentAt = Number.NEGATIVE_INFINITY;
  const cancel = () => {
    if (timer) o.clearTimer(timer.t);
    timer = null;
  };
  const fire = () => {
    timer = null;
    const go = wasUp && !!last && !last.up && intentAt < downAt;
    wasUp = false;
    if (go) o.release();
  };
  return {
    sample(s) {
      if (width !== null && s.width !== width) {
        // A rotation or a new window size: a new layout height, and no keyboard to wait for.
        wasUp = false;
        cancel();
      }
      width = s.width;
      last = s;
      if (s.up) {
        wasUp = true;
        cancel();
      } else if (wasUp && !timer) {
        downAt = o.now();
        timer = { t: o.setTimer(fire, o.settleMs) };
      }
    },
    intent() {
      intentAt = o.now();
    },
    dispose() {
      cancel();
      wasUp = false;
    },
  };
}

/** What a press, a focus or a key may be on: an element, or a stand-in with its two lookups. */
interface Ownable {
  closest?(selector: string): Ownable | null;
  contains?(other: unknown): boolean;
}

/** Whether `target` is inside the field's owner ([data-kb-owner] around it), or the field itself when it has none. */
export function ownsIntent(target: unknown, field: Ownable): boolean {
  if (!target) return false;
  const owner = field.closest?.("[data-kb-owner]") ?? field;
  return !!owner.contains?.(target);
}

/** The input types that type text (an on-screen keyboard serves them). */
const TEXT_INPUTS = new Set(["", "text", "search", "url", "email", "password", "number", "tel"]);

/** A field that the on-screen keyboard serves: a text field, a text area or an editable box, not read-only. */
export function isEditable(el: { tagName?: string; type?: string; readOnly?: boolean; isContentEditable?: boolean } | null | undefined): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.readOnly) return false;
  if (el.tagName === "TEXTAREA") return true;
  return el.tagName === "INPUT" && TEXT_INPUTS.has((el.type ?? "").toLowerCase());
}

/** The focused element when the keyboard serves it. */
function editableFocus(): HTMLElement | null {
  const at = document.activeElement;
  return at instanceof HTMLElement && isEditable(at) ? at : null;
}

/** The one release (App.tsx, on touch only): the field that the keyboard served lets go when it settles closed. */
export function useKeyboardRelease(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let field: HTMLElement | null = null;
    const watcher = createDismissWatcher({
      settleMs: SETTLE_MS,
      now: () => performance.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t),
      release: () => {
        const el = field;
        field = null;
        if (el && document.activeElement === el) el.blur();
        for (const done of [...SETTLED]) done();
      },
    });
    const sample = () => {
      const kb = currentKeyboard();
      if (kb.up) field = editableFocus() ?? field;
      watcher.sample({ up: kb.up, width: window.innerWidth });
    };
    const own = (e: Event) => {
      // A field that takes the focus while the keyboard is up is the one it serves now.
      if (e.type === "focusin" && e.target instanceof HTMLElement && isEditable(e.target) && currentKeyboard().up) field = e.target;
      if (field && ownsIntent(e.target, field)) watcher.intent();
    };
    const stop = subscribeKeyboard(sample);
    sample();
    document.addEventListener("pointerdown", own, true);
    document.addEventListener("focusin", own, true);
    document.addEventListener("keydown", own, true);
    return () => {
      stop();
      watcher.dispose();
      document.removeEventListener("pointerdown", own, true);
      document.removeEventListener("focusin", own, true);
      document.removeEventListener("keydown", own, true);
    };
  }, [enabled]);
}

/**
 * True while the focus is inside a part (`inside`: a selector, or a ref to the part's element), from the document's
 * focusin and focusout: a part rides the keyboard only while its own field has the focus, so two parts never ride at
 * once (the composer beside the Terminal pane on a tablet). Always false while not `enabled`.
 */
export function useFocusInside(inside: string | RefObject<Element | null>, enabled: boolean): boolean {
  const [on, setOn] = useState(false);
  const where = useRef(inside);
  where.current = inside;
  useEffect(() => {
    if (!enabled) {
      setOn(false);
      return;
    }
    const within = (el: EventTarget | null) => {
      if (!(el instanceof Element)) return false;
      const w = where.current;
      return typeof w === "string" ? el.closest(w) !== null : !!w.current?.contains(el);
    };
    const focusIn = (e: FocusEvent) => setOn(within(e.target));
    const focusOut = (e: FocusEvent) => setOn(within(e.relatedTarget));
    setOn(within(document.activeElement));
    document.addEventListener("focusin", focusIn);
    document.addEventListener("focusout", focusOut);
    return () => {
      document.removeEventListener("focusin", focusIn);
      document.removeEventListener("focusout", focusOut);
    };
  }, [enabled]);
  return enabled && on;
}
