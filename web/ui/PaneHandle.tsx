// A pane's drag handle (row 82, W19f; the window splitter pattern): a focusable separator on the pane's inner edge.
// Its value is the pane's width in px, with the range in aria-valuemin and aria-valuemax; Left and Right move it by
// 16 px, Home and End to the ends (layout/panes.ts keyWidth); a double-click, or a double tap on touch, puts the default
// back. A drag captures the pointer (a mouse, a pen or a finger: touch-action none, and a touch's touchstart cancelled,
// so its release is no fling that would cost the next tap), and while it moves it writes only the pane's CSS variable
// on the shell, the handle's own place and its aria-valuenow (at most once a frame), so React renders nothing. The
// variable is registered as not inherited (layout.css @property), so a move restyles the shell and the handle only,
// never the transcript under them (an inherited one restyled every element on the page each move: 13 to 22 ms a move
// on a long chat); the grid then lays out its columns. The width is kept when the pointer goes up; a cancelled drag
// puts it back. The look: a hairline on the edge that the look's focus colour lights while it drags, on hover and with
// the keyboard's focus, and on touch a grip on the edge (layout.css).
import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { dragWidth, keyWidth, type Grow, type PaneRange } from "../layout/panes";

/** Two taps this close make a double tap (touch has no dblclick it can count on under touch-action none). */
const DOUBLE_TAP_MS = 400;
/** A press that moves less than this is a tap, not a drag. */
const TAP_SLOP = 4;

export interface PaneHandleProps {
  range: PaneRange;
  /** The side the pane grows toward: "right" for the sidebar on the left, "left" for the side pane on the right. */
  grow: Grow;
  label: string;
  /** The pane's element id. */
  controls: string;
  /** The CSS variable that holds the pane's width, on `host` (not inherited, so the handle cannot read it). */
  cssVar: string;
  host: RefObject<HTMLElement | null>;
  /** The side pane's handle: what lies between the pane and the shell's right edge (the pane bar's width), if any. */
  offset?: string;
  /** Show the grip on the edge (touch, which has no hover to show the handle). */
  grip?: boolean;
  /** Keep a width (null: the default again). */
  onWidth: (width: number | null) => void;
  testId?: string;
}

interface Drag {
  id: number;
  x0: number;
  w0: number;
  w: number;
  moved: boolean;
  range: PaneRange;
}

export function PaneHandle(props: PaneHandleProps) {
  const { range, grow, label, controls, cssVar, host, offset, grip, onWidth, testId } = props;
  /** The handle's place for a width: the sidebar's right edge, or the side pane's left edge from the shell's right. */
  const place = (w: number): CSSProperties => (grow === "right" ? { left: `${w}px` } : { right: offset ? `calc(${w}px + ${offset})` : `${w}px` });
  const self = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const frame = useRef(0);
  const lastTap = useRef(0);
  // A handle that goes in the middle of a drag (its pane closed by a key, another route) leaves no resizing mark.
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      if (drag.current) host.current?.removeAttribute("data-resizing");
    },
    [host],
  );
  // A touch on the handle is the handle's alone: its touchstart is cancelled. Else Chrome takes a quick finger's release
  // for a fling, and stopping it costs the next tap anywhere on the page (Hide sidebar, the pane bar's lit button). React
  // listens for touchstart passively, so the listener is the element's own. Pointer events still come.
  useEffect(() => {
    const el = self.current;
    if (!el) return;
    const own = (e: TouchEvent) => {
      if (e.cancelable) e.preventDefault();
    };
    el.addEventListener("touchstart", own, { passive: false });
    return () => el.removeEventListener("touchstart", own);
  }, []);

  const show = (w: number) => {
    host.current?.style.setProperty(cssVar, `${w}px`);
    if (!self.current) return;
    Object.assign(self.current.style, place(w));
    self.current.setAttribute("aria-valuenow", String(w));
  };
  const end = () => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    host.current?.removeAttribute("data-resizing");
    self.current?.removeAttribute("data-dragging");
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // No text selection, no scroll, and no focus: the focus stays where it was (the message box keeps it, and on touch
    // its keyboard stays up); the keyboard reaches the handle with Tab.
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, x0: e.clientX, w0: range.now, w: range.now, moved: false, range };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x0;
    if (!d.moved) {
      if (Math.abs(dx) < TAP_SLOP) return;
      d.moved = true;
      host.current?.setAttribute("data-resizing", "");
      self.current?.setAttribute("data-dragging", "");
    }
    const w = dragWidth(d.w0, dx, d.range, grow);
    if (w === d.w) return;
    d.w = w;
    if (!frame.current)
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        if (drag.current) show(drag.current.w);
      });
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    drag.current = null;
    end();
    if (d.moved) {
      show(d.w);
      if (d.w !== d.range.now) onWidth(d.w);
      return;
    }
    // A tap: two of them on touch put the default back (a mouse has its dblclick below).
    if (e.pointerType === "mouse") return;
    const now = e.timeStamp;
    if (now - lastTap.current < DOUBLE_TAP_MS) {
      lastTap.current = 0;
      onWidth(null);
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
    if (e.altKey || e.ctrlKey || e.metaKey || e.nativeEvent.isComposing) return;
    const w = keyWidth(e.key, range, grow);
    if (w === null) return;
    e.preventDefault();
    if (w !== range.now) onWidth(w);
  };

  return (
    <div
      ref={self}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuenow={range.now}
      aria-valuemin={range.min}
      aria-valuemax={range.max}
      tabIndex={0}
      className={`pane-handle pane-handle-${grow === "right" ? "start" : "end"}`}
      style={place(range.now)}
      data-testid={testId}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onCancel}
      onLostPointerCapture={onCancel}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onWidth(null)}
    >
      {grip ? <span className="pane-grip" aria-hidden="true" /> : null}
    </div>
  );
}
