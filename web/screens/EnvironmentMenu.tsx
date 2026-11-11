// Row 99: an environment's menu, from the "..." button on its heading in the chat lists (the sidebar, the drawer and the
// phone's /chats; on hover and focus on a laptop, always on touch) or a right-click on the heading, and from the "..."
// beside New chat here on its page. Rename and Remove open their own paths (/p/<project>/rename and /remove), Move up
// and Move down (in the lists only) each send one move; the first one has no Move up and the last no Move down. The
// keys: Enter or Space opens it, the arrows, Home and End move, Esc closes it and the focus goes back to its button. A
// menu on a laptop and a tablet, a sheet of grouped rows on the phone (usePopupRows), as a chat row's menu is.
// A heading also drags (useHeadingDrag): with the mouse on a laptop, by a plain drag or a long press that lifts it
// (row 107, MousePress), and on touch after a long press (row 102, HeadingLift). A line shows where it goes, and the
// drop sends one move; Esc or a second finger puts it back.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { href, navigate } from "../router";
import { act } from "../state/store";
import { dropBefore, gapAt } from "../state/environments";
import type { Project } from "../state/types";
import { LONG_PRESS_SLOP, Popup } from "../ui/primitives";
import { usePopupRows } from "./common";

/** Move up's and Move down's `before` (undefined: no such item); null steps: no Move items (the project page). */
export interface EnvSteps {
  up: string | null | undefined;
  down: string | null | undefined;
}

/** The arrows, Home and End move between a menu's rows (its links and enabled buttons). */
export function rowKeys(e: KeyboardEvent<HTMLElement>) {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>("a[href], button:not(:disabled)")];
  if (!rows.length) return;
  const at = rows.indexOf(document.activeElement as HTMLElement);
  const next = e.key === "ArrowDown" ? rows[(at + 1) % rows.length] : e.key === "ArrowUp" ? rows[at <= 0 ? rows.length - 1 : at - 1] : e.key === "Home" ? rows[0] : e.key === "End" ? rows[rows.length - 1] : undefined;
  if (!next) return;
  e.preventDefault();
  next.focus();
}

/** A menu row that opens a path in the page (a plain click), or in a new tab with a modifier, as Link does. */
function MenuLink({ to, className, onNavigate, testId, children }: { to: string; className: string; onNavigate: () => void; testId?: string; children: ReactNode }) {
  return (
    <a
      href={to}
      role="menuitem"
      className={className}
      data-testid={testId}
      onClick={(e: MouseEvent) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        onNavigate();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

export function EnvMenu(props: { open: boolean; onClose: () => void; anchor: RefObject<HTMLElement | null>; project: Project; steps: EnvSteps | null }) {
  const { open, onClose, anchor, project, steps } = props;
  const k = usePopupRows();
  const move = (before: string | null) => {
    onClose();
    act.moveProject(project.id, before);
  };
  const up = steps?.up;
  const down = steps?.down;
  return (
    <Popup open={open} onClose={onClose} anchor={anchor} title={project.name} testId="env-menu">
      <div className={`${k.box} scr-menu`} role="menu" aria-label={project.name} onKeyDown={rowKeys}>
        <div className={k.list}>
          <MenuLink to={href("projectRename", { project: project.id })} className={k.row} onNavigate={onClose} testId="env-rename">
            Rename
          </MenuLink>
          {up !== undefined ? (
            <button type="button" role="menuitem" className={k.row} data-testid="env-move-up" onClick={() => move(up)}>
              Move up
            </button>
          ) : null}
          {down !== undefined ? (
            <button type="button" role="menuitem" className={k.row} data-testid="env-move-down" onClick={() => move(down)}>
              Move down
            </button>
          ) : null}
        </div>
        {!k.sheet ? <hr className="menu-sep" /> : null}
        <div className={k.list}>
          <MenuLink to={href("projectRemove", { project: project.id })} className={`${k.row} danger scr-menu-delete`} onNavigate={onClose} testId="env-remove">
            Remove
          </MenuLink>
        </div>
      </div>
    </Popup>
  );
}

/** Near the list's top or bottom edge the mouse's plain drag scrolls the list this much per move. */
const EDGE = 28;
const EDGE_STEP = 14;

/** How a heading moves: the mouse's plain drag dims it ("mouse"); a long press lifts it on the raised surface, a
 *  finger's ("touch", row 102) or the mouse's on a laptop ("lift", row 107). */
export type DragHow = "mouse" | "touch" | "lift";

export interface HeadingDrag {
  /** The heading being dragged, how, and the gap its drop would go to (null: where it is). */
  dragging: string | null;
  how: DragHow | null;
  gap: number | null;
  /** The mouse's press on one heading: a click, its plain drag or its long press (MousePress). */
  onPointerDown(id: string, e: ReactPointerEvent<HTMLElement>): void;
  /** One heading's finger listeners (its long press); returns their removal. */
  touchHead(id: string, el: HTMLElement): () => void;
  /** A finger presses a heading now: its long press is the drag's, so it opens no menu. */
  touching(): boolean;
}

/** On touch a press this long that moves less than LONG_PRESS_SLOP lifts a heading (row 102). */
export const LIFT_MS = 450;
/** Near the list's top or bottom edge a lifted heading scrolls the list by itself, this much per frame. */
const LIFT_EDGE = 44;
const LIFT_STEP = 6;

interface TouchPoint {
  identifier: number;
  clientX: number;
  clientY: number;
}
/** What a lift reads of a touch event (a TouchEvent; the tests give plain objects). */
export interface TouchLike {
  touches: ArrayLike<TouchPoint>;
  changedTouches: ArrayLike<TouchPoint>;
  cancelable: boolean;
  timeStamp: number;
  preventDefault(): void;
}
interface ScrollBox {
  scrollTop: number;
  getBoundingClientRect(): { top: number; bottom: number };
}
/** What a lift needs of the page (useHeadingDrag gives it; the tests give their own). */
export interface LiftHost {
  /** The gap of the shown headings that a finger at `y` points to. */
  gapAt(y: number): number;
  /** A drop of `id` at `gap`: the move's `before`, or undefined when it stays where it is. */
  dropAt(id: string, gap: number): string | null | undefined;
  /** The lifted heading and its line's gap (null: no drag). */
  show(drag: { id: string; gap: number | null } | null): void;
  move(id: string, before: string | null): void;
  /** The box the list scrolls in, read at the lift. */
  scroller(id: string): ScrollBox | null;
  /** The click that may still end the drag opens nothing. */
  swallowClick(at: number): void;
  /** A timer and an animation frame; each returns its cancel. */
  later(run: () => void, ms: number): () => void;
  frame(run: () => void): () => void;
}

interface Press {
  id: string;
  finger: number;
  x: number;
  y: number;
  /** Lifted. */
  on: boolean;
  /** The finger's last y, and the gap the line marks (null: none). */
  at: number;
  gap: number | null;
  box: ScrollBox | null;
  /** The cancels of the lift's timer and of the edge's next frame. */
  timer: (() => void) | null;
  edge: (() => void) | null;
}

function pointOf(list: ArrayLike<TouchPoint>, finger: number): TouchPoint | undefined {
  for (let i = 0; i < list.length; i++) if (list[i]!.identifier === finger) return list[i];
  return undefined;
}

/**
 * A long press's drag of a heading: a finger's (row 102), and the mouse's on a laptop through MousePress (row 107),
 * which reads it as one finger. A press that stays within LONG_PRESS_SLOP for LIFT_MS lifts the heading; a
 * move before that is the list's scroll, and a quick tap stays the heading's link or button. Lifted, each move holds
 * the list still (its touchmove's default prevented) and puts the line at the gap under the finger; near the list's
 * top or bottom edge the list scrolls by itself. The release sends one move (none when the heading would stay where it
 * is) and opens nothing; a second finger, a touchcancel, or a scroll that the browser started anyway puts it back.
 */
export class HeadingLift {
  private p: Press | null = null;
  constructor(private readonly host: LiftHost) {}

  /** The heading a finger presses now, lifted or not yet (null: none). */
  get pressing(): string | null {
    return this.p?.id ?? null;
  }

  /** The press has lifted its heading. */
  get lifted(): boolean {
    return this.p?.on === true;
  }

  /** A finger goes down on heading `id` (a second one on it ends the press). */
  down(id: string, e: TouchLike) {
    this.cancel();
    const t = e.changedTouches[0];
    if (e.touches.length !== 1 || !t) return;
    const p: Press = { id, finger: t.identifier, x: t.clientX, y: t.clientY, on: false, at: t.clientY, gap: null, box: null, timer: null, edge: null };
    this.p = p;
    p.timer = this.host.later(() => this.lift(p), LIFT_MS);
  }

  /** A finger goes down anywhere: a second one ends the press. */
  finger(e: TouchLike) {
    if (e.touches.length > 1) this.cancel();
  }

  move(e: TouchLike) {
    const p = this.p;
    if (!p) return;
    if (e.touches.length > 1) return this.cancel();
    const t = pointOf(e.touches, p.finger) ?? pointOf(e.changedTouches, p.finger);
    if (!t) return;
    // Before the lift a real move is the list's scroll; a move the browser will not let go of is a scroll already.
    if (!p.on) {
      if (!e.cancelable || Math.hypot(t.clientX - p.x, t.clientY - p.y) >= LONG_PRESS_SLOP) this.cancel();
      return;
    }
    if (!e.cancelable) return this.cancel();
    e.preventDefault();
    p.at = t.clientY;
    this.aim(p);
    if (!p.edge && this.edgeOf(p)) p.edge = this.host.frame(() => this.scroll(p));
  }

  up(e: TouchLike) {
    const p = this.p;
    if (!p || !pointOf(e.changedTouches, p.finger)) return;
    const before = p.on && p.gap !== null ? this.host.dropAt(p.id, p.gap) : undefined;
    this.cancel();
    if (!p.on) return; // a tap: the link's or the button's own
    if (e.cancelable) e.preventDefault(); // no click after it
    this.host.swallowClick(e.timeStamp);
    if (before !== undefined) this.host.move(p.id, before);
  }

  cancel() {
    const p = this.p;
    if (!p) return;
    this.p = null;
    p.timer?.();
    p.edge?.();
    if (p.on) this.host.show(null);
  }

  private lift(p: Press) {
    if (this.p !== p) return;
    p.timer = null;
    p.on = true;
    p.box = this.host.scroller(p.id);
    this.host.show({ id: p.id, gap: null });
  }

  private aim(p: Press) {
    const gap = this.host.gapAt(p.at);
    const next = this.host.dropAt(p.id, gap) !== undefined ? gap : null;
    if (next === p.gap) return;
    p.gap = next;
    this.host.show({ id: p.id, gap: next });
  }

  /** -1 near the list's top edge, 1 near its bottom, 0 elsewhere. */
  private edgeOf(p: Press): -1 | 0 | 1 {
    const r = p.box?.getBoundingClientRect();
    if (!r) return 0;
    return p.at < r.top + LIFT_EDGE ? -1 : p.at > r.bottom - LIFT_EDGE ? 1 : 0;
  }

  private scroll(p: Press) {
    p.edge = null;
    const dir = this.edgeOf(p);
    if (this.p !== p || !dir || !p.box) return;
    const was = p.box.scrollTop;
    p.box.scrollTop = was + dir * LIFT_STEP;
    if (p.box.scrollTop !== was) this.aim(p);
    p.edge = this.host.frame(() => this.scroll(p));
  }
}

/** What a mouse press reads of a pointer event (a PointerEvent; the tests give plain objects). */
export interface PointerLike {
  pointerId: number;
  clientX: number;
  clientY: number;
  timeStamp: number;
}
/** What a mouse press needs of the page: a lift's host (its `show` is the lifted look), and the plain drag's look. */
export interface PressHost extends LiftHost {
  /** The heading that the plain drag dims, and its line's gap (null: no drag). */
  dim(drag: { id: string; gap: number | null } | null): void;
}

/** The mouse as a lift reads it: one finger, gone at the release. A mouse never scrolls the list, so each of its
 *  moves is the lift's to hold. */
function touchOf(e: PointerLike, down: boolean): TouchLike {
  const t = { identifier: e.pointerId, clientX: e.clientX, clientY: e.clientY };
  return { touches: down ? [t] : [], changedTouches: [t], cancelable: true, timeStamp: e.timeStamp, preventDefault() {} };
}

/**
 * The mouse's press on a heading (rows 99 and 107). Held LIFT_MS with less than LONG_PRESS_SLOP of movement, it lifts
 * the heading as a finger does (HeadingLift: the raised surface, the line, the list's own scroll near its edges); a
 * move of LONG_PRESS_SLOP before that is row 99's plain drag, which dims the heading and scrolls the list near its
 * edges as it moves. Either one's release sends one move (none when the heading would stay where it is) and opens
 * nothing; a release before either is a click, the link's own. Esc puts a drag or a lift back, and the release after
 * it opens nothing.
 */
export class MousePress {
  private p: { id: string; pointer: number; x: number; y: number; mode: "press" | "drag" | "stopped"; gap: number | null; box: ScrollBox | null } | null = null;
  private readonly lift: HeadingLift;
  constructor(private readonly host: PressHost) {
    this.lift = new HeadingLift(host);
  }

  /** The heading the mouse presses now (null: none). */
  get pressing(): string | null {
    return this.p?.id ?? null;
  }

  down(id: string, e: PointerLike) {
    this.cancel();
    this.p = { id, pointer: e.pointerId, x: e.clientX, y: e.clientY, mode: "press", gap: null, box: null };
    this.lift.down(id, touchOf(e, true));
  }

  move(e: PointerLike) {
    const p = this.p;
    if (!p || e.pointerId !== p.pointer || p.mode === "stopped") return;
    if (this.lift.lifted) return this.lift.move(touchOf(e, true));
    if (p.mode === "press") {
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < LONG_PRESS_SLOP) return;
      this.lift.cancel();
      p.mode = "drag";
      p.box = this.host.scroller(p.id);
    }
    const r = p.box?.getBoundingClientRect();
    if (p.box && r) {
      if (e.clientY < r.top + EDGE) p.box.scrollTop -= EDGE_STEP;
      else if (e.clientY > r.bottom - EDGE) p.box.scrollTop += EDGE_STEP;
    }
    const gap = this.host.gapAt(e.clientY);
    p.gap = this.host.dropAt(p.id, gap) !== undefined ? gap : null;
    this.host.dim({ id: p.id, gap: p.gap });
  }

  up(e: PointerLike) {
    const p = this.p;
    if (!p || e.pointerId !== p.pointer) return;
    this.p = null;
    if (this.lift.lifted) return this.lift.up(touchOf(e, false));
    this.lift.cancel();
    if (p.mode === "press") return; // a click: the link's own
    const before = p.mode === "drag" && p.gap !== null ? this.host.dropAt(p.id, p.gap) : undefined;
    if (p.mode === "drag") this.host.dim(null);
    this.host.swallowClick(e.timeStamp);
    if (before !== undefined) this.host.move(p.id, before);
  }

  /** Esc: a drag or a lift goes back, and the release that ends the press opens nothing. True when it took the key. */
  escape(): boolean {
    const p = this.p;
    if (!p || p.mode === "stopped" || (p.mode === "press" && !this.lift.lifted)) return false;
    this.lift.cancel();
    if (p.mode === "drag") this.host.dim(null);
    p.mode = "stopped";
    return true;
  }

  /** A lost pointer, or the list going away: the heading goes back, and nothing is sent. */
  cancel() {
    const p = this.p;
    this.p = null;
    this.lift.cancel();
    if (p?.mode === "drag") this.host.dim(null);
  }
}

/** The gap of the headings (.scr-group-head[data-env]) in `box` that a pointer at `y` points to. */
function gapIn(box: HTMLElement | null, y: number): number {
  const heads = [...(box?.querySelectorAll<HTMLElement>(".scr-group-head[data-env]") ?? [])];
  return gapAt(
    y,
    heads.map((h) => {
      const r = h.getBoundingClientRect();
      return r.top + r.height / 2;
    }),
  );
}

/** The box that scrolls `el` up and down (the phone's whole list in landscape), else `fallback`. */
function scrollBoxOf(el: Element | null | undefined, fallback: HTMLElement | null): HTMLElement | null {
  for (let n = el?.parentElement; n; n = n.parentElement) {
    const y = getComputedStyle(n).overflowY;
    if ((y === "auto" || y === "scroll") && n.scrollHeight > n.clientHeight) return n;
  }
  return fallback;
}

/**
 * The headings' drag. With the mouse (a laptop; a pen never drags), a press on a heading (not on its buttons or its
 * New chat link) is MousePress's: held still it lifts the heading, moved it is the plain drag, released at once it is
 * the link's click. The pointer leaves the heading at once, so its moves and its release are read on the window; while
 * it is down no text is selected, and the browser's own link drag never starts (its pointerdown's default is
 * prevented, the name's link is not draggable, and a dragstart on the heading is prevented). With a finger, a long
 * press lifts the heading (HeadingLift, through each heading's own listeners, touchHead). `all` is every environment
 * in the sidebar's order, `shown` those the list shows, `box` the list whose headings (.scr-group-head[data-env]) it
 * measures, and `scroller` the list's scrolling box.
 */
export function useHeadingDrag(all: readonly string[], shown: readonly string[], box: RefObject<HTMLElement | null>, scroller: RefObject<HTMLElement | null>): HeadingDrag {
  const [state, setState] = useState<{ id: string; gap: number | null; how: DragHow } | null>(null);
  const lists = useRef({ all, shown });
  lists.current = { all, shown };
  /** The mouse press now (its window listeners' removal), or null. */
  const off = useRef<(() => void) | null>(null);
  const [{ lift, mouse }] = useState(() => {
    const look = (how: DragHow) => (s: { id: string; gap: number | null } | null) => {
      setState(s && { ...s, how });
      if (s) document.documentElement.dataset.drag = "env";
      else delete document.documentElement.dataset.drag;
    };
    const host = (how: "touch" | "lift"): LiftHost => ({
      gapAt: (y) => gapIn(box.current, y),
      dropAt: (id, gap) => dropBefore(lists.current.all, lists.current.shown, id, gap),
      show: look(how),
      move: (id, before) => act.moveProject(id, before),
      scroller: (id) => scrollBoxOf([...(box.current?.querySelectorAll<HTMLElement>(".scr-group-head[data-env]") ?? [])].find((h) => h.dataset.env === id), scroller.current),
      swallowClick,
      later: (run, ms) => {
        const t = setTimeout(run, ms);
        return () => clearTimeout(t);
      },
      frame: (run) => {
        const f = requestAnimationFrame(run);
        return () => cancelAnimationFrame(f);
      },
    });
    return { lift: new HeadingLift(host("touch")), mouse: new MousePress({ ...host("lift"), dim: look("mouse") }) };
  });

  /** The mouse press's window listeners go. */
  const stop = useCallback(() => {
    off.current?.();
    off.current = null;
  }, []);
  const end = useCallback(() => {
    stop();
    lift.cancel();
    mouse.cancel();
    setState(null);
    delete document.documentElement.dataset.drag;
  }, [stop, lift, mouse]);
  useEffect(() => end, [end]);
  // A second finger anywhere ends a finger's press.
  useEffect(() => {
    const finger = (e: TouchEvent) => lift.finger(e);
    window.addEventListener("touchstart", finger, { capture: true, passive: true });
    return () => window.removeEventListener("touchstart", finger, { capture: true });
  }, [lift]);

  const touchHead = useCallback(
    (id: string, el: HTMLElement) => {
      const down = (e: TouchEvent) => {
        if ((e.target as Element | null)?.closest?.("button, .scr-group-act")) return;
        lift.down(id, e);
      };
      const move = (e: TouchEvent) => lift.move(e);
      const up = (e: TouchEvent) => lift.up(e);
      const cancel = () => lift.cancel();
      // A link's own drag (the mouse's, or a phone browser's long press and move) is never the heading's.
      const noDrag = (e: DragEvent) => e.preventDefault();
      el.addEventListener("touchstart", down, { passive: true });
      el.addEventListener("touchmove", move, { passive: false });
      el.addEventListener("touchend", up, { passive: false });
      el.addEventListener("touchcancel", cancel);
      el.addEventListener("dragstart", noDrag);
      return () => {
        el.removeEventListener("touchstart", down);
        el.removeEventListener("touchmove", move);
        el.removeEventListener("touchend", up);
        el.removeEventListener("touchcancel", cancel);
        el.removeEventListener("dragstart", noDrag);
        if (lift.pressing === id) lift.cancel();
      };
    },
    [lift],
  );
  const touching = useCallback(() => lift.pressing !== null, [lift]);

  return {
    dragging: state?.id ?? null,
    how: state?.how ?? null,
    gap: state?.gap ?? null,
    touchHead,
    touching,
    onPointerDown(id, e) {
      if (e.pointerType !== "mouse" || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      if ((e.target as Element).closest("button, .scr-group-act")) return;
      // No text selection and no native link drag: the press is the heading's own.
      e.preventDefault();
      end();
      const pointer = e.pointerId;
      mouse.down(id, e.nativeEvent);
      const move = (ev: PointerEvent) => mouse.move(ev);
      const up = (ev: PointerEvent) => {
        if (ev.pointerId !== pointer) return;
        stop();
        mouse.up(ev);
      };
      const key = (ev: globalThis.KeyboardEvent) => {
        if (ev.key !== "Escape" || !mouse.escape()) return;
        ev.preventDefault();
        ev.stopImmediatePropagation();
      };
      // A browser that still starts a selection from a press whose pointerdown was prevented: none while it is down.
      const noSelect = (ev: Event) => ev.preventDefault();
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", up, true);
      window.addEventListener("pointercancel", end, true);
      window.addEventListener("keydown", key, true);
      window.addEventListener("selectstart", noSelect, true);
      off.current = () => {
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", up, true);
        window.removeEventListener("pointercancel", end, true);
        window.removeEventListener("keydown", key, true);
        window.removeEventListener("selectstart", noSelect, true);
      };
    },
  };
}

/** The click that ends a drag opens nothing (the heading's link would follow its href). */
function swallowClick(upAt: number) {
  const click = (ev: Event) => {
    if (ev.timeStamp < upAt) return;
    ev.preventDefault();
    ev.stopPropagation();
    done();
  };
  const timer = setTimeout(done, 400);
  function done() {
    clearTimeout(timer);
    window.removeEventListener("click", click, true);
  }
  window.addEventListener("click", click, true);
}
