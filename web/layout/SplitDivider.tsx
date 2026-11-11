// U4 (DESIGN-U4 5): the divider between the split side panel's two halves, the window splitter pattern turned on its
// side, as the width handles (ui/PaneHandle.tsx) are on their edges. A focusable separator between the halves in the
// DOM, named "<upper half> height", whose value is the upper half's height in px within its limits (layout/split.ts);
// Up and Down move it 16 px, Home and End to the limits; a double-click, or a double tap on touch, gives equal halves
// again. A drag captures the pointer (touch-action none, its touchstart cancelled so its release is no fling) and
// writes, at most once a frame, only the column's --split-top (registered, not inherited: layout.css), its own place
// and its aria-valuenow, so React renders nothing and only the two halves lay out; the chat keeps its width. The
// place is kept when the pointer goes up (the device's own share, never a URL); a cancelled drag puts it back. The
// look: the seam is the lower half's 1 px hairline; it darkens on hover, and takes the 2 px focus line while it drags
// and with the keyboard's focus; on touch a 32 x 4 px grip sits on the seam.
import { useEffect, useRef, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { splitDrag, splitKey, type SplitRange } from "./split";

/** Two taps this close make a double tap (touch has no dblclick it can count on under touch-action none). */
const DOUBLE_TAP_MS = 400;
/** A press that moves less than this is a tap, not a drag. */
const TAP_SLOP = 4;
/** The grab room above the seam: 4 px on a laptop (and 4 below), 16 px on touch (and 4 below, clear of the lower head). */
export const GRAB_ABOVE = 4;
export const GRAB_ABOVE_TOUCH = 16;

export interface SplitDividerProps {
  range: SplitRange;
  /** "<upper half> height". */
  label: string;
  /** The upper half's element id. */
  controls: string;
  /** The column whose --split-top holds the upper half's height. */
  host: RefObject<HTMLElement | null>;
  touch: boolean;
  /** Keep the upper half's height (null: equal halves again). */
  onTop: (top: number | null) => void;
  testId?: string;
}

interface Drag {
  id: number;
  y0: number;
  t0: number;
  t: number;
  moved: boolean;
  range: SplitRange;
}

export function SplitDivider(props: SplitDividerProps) {
  const { range, label, controls, host, touch, onTop, testId } = props;
  const above = touch ? GRAB_ABOVE_TOUCH : GRAB_ABOVE;
  const self = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const frame = useRef(0);
  const lastTap = useRef(0);
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      if (drag.current) host.current?.removeAttribute("data-resizing");
    },
    [host],
  );
  // A touch on the divider is the divider's alone (see PaneHandle.tsx: else Chrome takes a quick release for a fling).
  useEffect(() => {
    const el = self.current;
    if (!el) return;
    const own = (e: TouchEvent) => {
      if (e.cancelable) e.preventDefault();
    };
    el.addEventListener("touchstart", own, { passive: false });
    return () => el.removeEventListener("touchstart", own);
  }, []);

  const show = (t: number) => {
    host.current?.style.setProperty("--split-top", `${t}px`);
    if (!self.current) return;
    self.current.style.top = `${t - above}px`;
    self.current.setAttribute("aria-valuenow", String(t));
  };
  const end = () => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    host.current?.removeAttribute("data-resizing");
    self.current?.removeAttribute("data-dragging");
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // No text selection, no scroll and no focus move: the keyboard reaches the divider with Tab.
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, y0: e.clientY, t0: range.now, t: range.now, moved: false, range };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    const dy = e.clientY - d.y0;
    if (!d.moved) {
      if (Math.abs(dy) < TAP_SLOP) return;
      d.moved = true;
      host.current?.setAttribute("data-resizing", "");
      self.current?.setAttribute("data-dragging", "");
    }
    const t = splitDrag(d.t0, dy, d.range);
    if (t === d.t) return;
    d.t = t;
    if (!frame.current)
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        if (drag.current) show(drag.current.t);
      });
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    drag.current = null;
    end();
    if (d.moved) {
      show(d.t);
      if (d.t !== d.range.now) onTop(d.t);
      return;
    }
    if (e.pointerType === "mouse") return;
    const now = e.timeStamp;
    if (now - lastTap.current < DOUBLE_TAP_MS) {
      lastTap.current = 0;
      onTop(null);
    } else lastTap.current = now;
  };
  const onCancel = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    drag.current = null;
    end();
    show(d.range.now);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.nativeEvent.isComposing) return;
    const t = splitKey(e.key, range);
    if (t === null) return;
    e.preventDefault();
    if (t !== range.now) onTop(t);
  };

  return (
    <div
      ref={self}
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      aria-controls={controls}
      aria-valuenow={range.now}
      aria-valuemin={range.min}
      aria-valuemax={range.max}
      tabIndex={0}
      className="split-divider"
      style={{ top: `${range.now - above}px` }}
      data-testid={testId}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onCancel}
      onLostPointerCapture={onCancel}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onTop(null)}
    >
      {touch ? <span className="split-grip" aria-hidden="true" /> : null}
    </div>
  );
}
