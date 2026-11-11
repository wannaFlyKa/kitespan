// A double press (web/ui/secondPress) as the dialogs' tests drive it: a stand-in window that the guard listens on, a
// tap as the browser sends it (the pointer's down and up, then the click, with their time and place), and a dialog's
// own press handler, read from the elements that its component returns inside a render (React's server renderer
// attaches no handler to a node).
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { notePressed } from "../../web/ui/primitives";
import { SECOND_PRESS_MS, type PressBox } from "../../web/ui/secondPress";

export type Pressed = Event & { stopped?: boolean };

/** A pointer's event or a click at `at` ms (the page's clock, as performance.now()), at (x, y). */
export function pressEvent(type: string, at: number, x = 0, y = 0): Pressed {
  const e = new Event(type, { cancelable: true, bubbles: true }) as Pressed;
  Object.defineProperty(e, "timeStamp", { value: at });
  Object.defineProperty(e, "clientX", { value: x });
  Object.defineProperty(e, "clientY", { value: y });
  e.stopPropagation = () => {
    e.stopped = true;
    Event.prototype.stopPropagation.call(e);
  };
  return e;
}

/** One tap at `at` ms through `win`: its pointer goes down and up, then its click comes; the click, to read. */
export function tap(win: EventTarget, at: number, x = 0, y = 0): Pressed {
  win.dispatchEvent(pressEvent("pointerdown", at, x, y));
  win.dispatchEvent(pressEvent("pointerup", at + 15, x, y));
  const click = pressEvent("click", at + 15, x, y);
  win.dispatchEvent(click);
  return click;
}

/** Whether a click reached the page: not swallowed (no handler under window would miss it, a link would follow). */
export const acted = (click: Pressed) => !click.defaultPrevented && !click.stopped;

/** `f` inside a render, so the hooks of the components it calls run (on a laptop's viewport, when none is set); its result. */
export function inRender<T>(f: () => T): T {
  const g = globalThis as Record<string, unknown>;
  const own = { matchMedia: g.matchMedia === undefined, window: g.window === undefined };
  if (own.matchMedia) g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  if (own.window) g.window = {};
  const win = g.window as { innerWidth?: number; innerHeight?: number };
  const sized = win.innerWidth === undefined;
  if (sized) Object.assign(win, { innerWidth: 1100, innerHeight: 800 });
  let out: { v: T } | null = null;
  function Probe() {
    out = { v: f() };
    return null;
  }
  try {
    renderToStaticMarkup(createElement(Probe));
  } finally {
    if (sized) {
      delete win.innerWidth;
      delete win.innerHeight;
    }
    if (own.matchMedia) delete g.matchMedia;
    if (own.window) delete g.window;
  }
  return out!.v;
}

/** A component's own elements (call it inside inRender, so its hooks run there). */
export function expand(node: ReactNode): ReactNode {
  if (!isValidElement(node) || typeof node.type !== "function") throw new Error("not a component's element");
  return (node.type as (p: unknown) => ReactNode)(node.props);
}

/** The props of the element in `node` whose own prop `key` is `value`, among the elements' children (components are not drawn). */
export function propsWhere(node: ReactNode, key: string, value: unknown): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = propsWhere(n, key, value);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const props = (node as ReactElement<Record<string, unknown>>).props;
  if (props[key] === value) return props;
  return propsWhere(props.children as ReactNode, key, value);
}

/** The handler that `prop` names on the element with `testId`. */
export function handlerOf(node: ReactNode, testId: string, prop = "onClick"): () => void {
  const f = propsWhere(node, "data-testid", testId)?.[prop];
  if (typeof f !== "function") throw new Error(`no ${prop} on ${testId}`);
  return f as () => void;
}

/** The pressed button in these presses: a 366 x 44 px box (the phone sheet's Stop), and a point on it. */
export const BUTTON: PressBox = { left: 12, top: 776, right: 378, bottom: 820 };
const ON = { x: 195, y: 798 };

/** The pointer goes down on a control with `box` (ui/primitives' record of the pressed control), or on none. */
export function pressDown(box: PressBox | null) {
  notePressed(box ? ({ isConnected: true, getBoundingClientRect: () => box } as unknown as HTMLElement) : null);
}

/**
 * A double press through a dialog's own handler: the pointer goes down on its button (BUTTON) and `press` runs once,
 * for the first press's click; then a second tap on it 80 ms later, and a later one after SECOND_PRESS_MS. The window
 * is a stand-in while they run.
 */
export function doublePress(press: () => void): { second: Pressed; later: Pressed } {
  const g = globalThis as Record<string, unknown>;
  const had = g.window;
  const win = new EventTarget();
  g.window = win;
  try {
    pressDown(BUTTON);
    press();
    const t = performance.now();
    return { second: tap(win, t + 80, ON.x, ON.y), later: tap(win, t + SECOND_PRESS_MS + 100, ON.x, ON.y) };
  } finally {
    pressDown(null);
    if (had === undefined) delete g.window;
    else g.window = had;
  }
}
