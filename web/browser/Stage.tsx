// The stage and the frame (DESIGN-B1 4.2, 4.3; PAGE 3.3 and 4): a picture of the page, one JPEG at a time, fitted to the
// stage (contain, never past the page's own size) inside a 4 px inset, on the --panel ground. Its rest edge is a 1 px
// hairline outside it; while it holds the keys, a 2 px --ring line outside it with a 2 px gap (F11). The frame asks the
// server for frames as wide as it is drawn (the local zoom included, never wider than the page), at the size class's
// quality and credit (4.20), and acks each one it drew. A frame that is not visible (the page hidden) is not viewed.
//
// Input, in frame coordinates mapped to the page's viewport (mapping.ts): on a laptop the mouse (moves, at most one a
// frame; presses with their click count; the wheel; the right button, whose context menu is the page's), Ctrl+wheel the
// local zoom, Alt+wheel the zoomed stage's pan; every key while the frame holds the keys (keys.ts, the macOS table),
// Cmd+C or Ctrl+C the copy of the selection the page holds (copy.ts), Cmd+V or Ctrl+V the paste event's text. On touch
// a tap (under 300 ms and 8 px) is a tap on the page, a one-finger drag scrolls it 1:1 (a wheel), a flick carries on
// for up to a second, a long press (500 ms) is a right-click, and two fingers pinch and pan the frame on this device
// only (D-19, the exception to DESIGN 7.7, inside the frame's box alone). Move (while zoomed) makes one finger or the
// mouse pan the stage and send nothing. More > Select text (selectText.ts) makes a one-finger drag select the page's
// text instead (the left button's press, moves and release), with no flick after it; it and Move take turns. Each input carries `n`, the newest frame drawn; each tap and click draws a 24 px
// ring at its point for 300 ms. The frame is role application in the Tab order after the bar, named by the page's
// title, and its description names the way out (Cmd+L or Ctrl+L).
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { BrowserFocusFacts, BrowserTabView, CastHeader } from "../../shared/browser";
import { BROWSER_LIMITS, BROWSER_MODS } from "../../shared/browser";
import type { SizeClass } from "../layout/size";
import { IconMove } from "../ui/icons";
import { IS_MAC } from "../ui/shortcuts";
import { keyAction, leaveKeyWords, strokeFrames, type KeyInput, type Stroke } from "./keys";
import { askChanged, fitBox, pinchZoom, toFrame, toPage, viewAsk, type FrameFacts, type ViewAsk } from "./mapping";
import { copyHold, drawn, drawnN, onCast, sendInput, setTouchWords, unviewTab, viewTab } from "./store";
import { asksSelection } from "./copy";
import { copyPageSelection, selectingText, setSelectingText, textDragFrames, type PagePoint } from "./selectText";
import { onEscape } from "./escape";

export const TAP_MS = 300;
export const TAP_SLOP = 8;
export const LONG_PRESS_MS = 500;
const FLING_MS = 1_000;

/** The frame's description (DESIGN-B1 4.3, 4.16). */
export function frameDescription(mac: boolean): string {
  return `Clicks and keys go to the page in the shared browser. Press ${leaveKeyWords(mac)} to leave the page.`;
}

/** Text a paste gives the page: the controls but tab and line feed go, a carriage return becomes a line feed, at most the cap. */
export function pasteText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .slice(0, BROWSER_LIMITS.text);
}

const BUTTONS = ["left", "middle", "right"] as const;
const modsOf = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => (e.altKey ? BROWSER_MODS.alt : 0) | (e.ctrlKey ? BROWSER_MODS.ctrl : 0) | (e.metaKey ? BROWSER_MODS.meta : 0) | (e.shiftKey ? BROWSER_MODS.shift : 0);

export interface StageProps {
  tab: BrowserTabView;
  size: SizeClass;
  touch: boolean;
  phone: boolean;
  frameId: string;
  /** The page's title (the frame's name). */
  title: string;
  /** The local zoom (null: Fit) and its setter; Move while zoomed. */
  zoom: number | null;
  onZoom: (z: number | null) => void;
  moving: boolean;
  onMoving: (on: boolean) => void;
  /** The frame holds the keys. */
  onKeys: (on: boolean) => void;
  /** A key went to the page (the dialog card's focus rule). */
  onKeySent: () => void;
  /** Cmd+L or Ctrl+L in the frame: the address field. */
  onLeave: () => void;
  /** The fitted scale, for More's Zoom in (the share of the page's own size that Fit shows). */
  onFit: (scale: number) => void;
  /** The on-screen keyboard is up on touch, and the field the page focused (the band, 4.10). */
  keyboardUp: boolean;
  focus: BrowserFocusFacts | null;
  /** Input is off: the socket reconnects, or a state covers the stage. */
  inert: boolean;
  /**
   * Over the frame: the pickers, drawn beside it (never inside it, so a press on a picker never reaches the page), with
   * the frame's place in the stage's scrolled content (`left`, `top`); over the stage: the cards, the lines, the states.
   */
  inFrame?: (facts: FrameFacts, boxW: number, stage: { w: number; h: number; left: number; top: number }) => ReactNode;
  over?: ReactNode;
  /** The frame is dimmed (Reconnecting..., a hidden tab). */
  dim: boolean;
}

export function Stage(p: StageProps) {
  const stage = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [facts, setFacts] = useState<FrameFacts>({ dw: p.tab.size.w || 1280, dh: p.tab.size.h || 800, psf: 1, top: 0 });
  const [marks, setMarks] = useState<{ id: number; x: number; y: number }[]>([]);
  const [visible, setVisible] = useState(typeof document === "undefined" || document.visibilityState !== "hidden");
  const tab = p.tab.id;
  const live = useRef(p);
  live.current = p;
  setTouchWords(p.touch);

  // ---- measure the stage, and draw what comes
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const read = () => setBox((b) => (b.w === el.clientWidth && b.h === el.clientHeight ? b : { w: el.clientWidth, h: el.clientHeight }));
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  useEffect(() => {
    let busy = false;
    let next: { h: CastHeader; jpeg: Uint8Array } | null = null;
    const draw = (h: CastHeader, jpeg: Uint8Array) => {
      if (busy) {
        if (next) drawn(tab, next.h.n); // a frame passed over: acked, so the credit comes back
        next = { h, jpeg };
        return;
      }
      busy = true;
      const blob = new Blob([jpeg as BlobPart], { type: "image/jpeg" });
      const done = () => {
        busy = false;
        drawn(tab, h.n);
        if (next) {
          const n = next;
          next = null;
          draw(n.h, n.jpeg);
        }
      };
      createImageBitmap(blob).then(
        (bmp) => {
          const c = canvas.current;
          if (c) {
            if (c.width !== bmp.width || c.height !== bmp.height) {
              c.width = bmp.width;
              c.height = bmp.height;
            }
            c.getContext("2d")?.drawImage(bmp, 0, 0);
          }
          bmp.close();
          setFacts((f) => (f.dw === h.dw && f.dh === h.dh && f.psf === h.psf && f.top === h.top ? f : { dw: h.dw, dh: h.dh, psf: h.psf, top: h.top }));
          done();
        },
        () => done(),
      );
    };
    return onCast(tab, draw);
  }, [tab]);

  // ---- where the frame sits, and what the pane asks of the server
  const fit = fitBox(box.w, box.h, facts.dw, facts.dh);
  const drawnW = p.zoom === null ? fit.w : Math.round(facts.dw * p.zoom);
  const drawnH = p.zoom === null ? fit.h : Math.round(facts.dh * p.zoom);
  const onFit = useRef(p.onFit);
  onFit.current = p.onFit;
  useEffect(() => onFit.current(fit.scale), [fit.scale]);
  const asked = useRef<ViewAsk | null>(null);
  useEffect(() => {
    if (!box.w || !box.h || !visible) return;
    const ask = viewAsk(p.size, drawnW, drawnH, facts.dw, facts.dh, typeof devicePixelRatio === "number" ? devicePixelRatio : 1);
    if (!askChanged(asked.current, ask)) return;
    const t = setTimeout(() => {
      asked.current = ask;
      viewTab(tab, ask);
    }, asked.current ? 150 : 0);
    return () => clearTimeout(t);
  }, [tab, box.w, box.h, drawnW, drawnH, facts.dw, facts.dh, p.size, visible]);
  useEffect(() => {
    if (visible) return;
    asked.current = null;
    unviewTab(tab);
  }, [visible, tab]);
  useEffect(
    () => () => {
      asked.current = null;
      unviewTab(tab);
    },
    [tab],
  );

  // While the on-screen keyboard is up, the frame keeps its width and shows the band round the focused field (4.10).
  const band = p.keyboardUp && p.zoom === null && p.focus?.editable ? toFrame(p.focus.box, drawnW, facts) : null;
  const shiftY = band ? Math.max(0, Math.min(drawnH - Math.max(1, box.h - 8), band.y - 24)) : 0;

  // ---- the input
  const at = (clientX: number, clientY: number) => {
    const r = frame.current!.getBoundingClientRect();
    return { fx: clientX - r.left, fy: clientY - r.top, w: r.width };
  };
  // The mapping reads the newest frame's facts through a ref, so the touch handlers (bound once) map with them too.
  const factsRef = useRef(facts);
  factsRef.current = facts;
  const page = (clientX: number, clientY: number) => {
    const a = at(clientX, clientY);
    return toPage(a.fx, a.fy, a.w, factsRef.current);
  };
  const mark = (clientX: number, clientY: number) => {
    const a = at(clientX, clientY);
    const id = Date.now() + Math.random();
    setMarks((m) => [...m.slice(-3), { id, x: a.fx, y: a.fy }]);
    setTimeout(() => setMarks((m) => m.filter((x) => x.id !== id)), TAP_MS);
  };
  const n = () => drawnN(tab);
  const sq = () => copyHold(tab).next();

  // A mouse (or a pen): its moves at most once a frame, its presses, its wheel; Move pans instead.
  const moveFrame = useRef(0);
  const pan = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "touch" || p.inert) return;
    frame.current?.focus({ preventScroll: true });
    if (p.moving && p.zoom !== null) {
      pan.current = { x: e.clientX, y: e.clientY, sl: scroller.current?.scrollLeft ?? 0, st: scroller.current?.scrollTop ?? 0 };
      e.currentTarget.setPointerCapture?.(e.pointerId);
      return;
    }
    const button = BUTTONS[e.button];
    if (!button) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const pt = page(e.clientX, e.clientY);
    mark(e.clientX, e.clientY);
    sendInput({ t: "mouse", tab, n: n(), type: "mousePressed", ...pt, button, clicks: Math.min(3, Math.max(1, e.detail || 1)), mods: modsOf(e) });
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "touch") return;
    if (pan.current) {
      pan.current = null;
      return;
    }
    const button = BUTTONS[e.button];
    if (!button || p.inert) return;
    const pt = page(e.clientX, e.clientY);
    sendInput({ t: "mouse", tab, n: n(), type: "mouseReleased", ...pt, button, clicks: Math.min(3, Math.max(1, e.detail || 1)), mods: modsOf(e), ...(button === "left" ? { sq: sq() } : {}) });
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "touch" || p.inert) return;
    if (pan.current && scroller.current) {
      scroller.current.scrollLeft = pan.current.sl - (e.clientX - pan.current.x);
      scroller.current.scrollTop = pan.current.st - (e.clientY - pan.current.y);
      return;
    }
    if (moveFrame.current) return;
    const x = e.clientX;
    const y = e.clientY;
    const held = e.buttons & 1 ? "left" : e.buttons & 4 ? "middle" : e.buttons & 2 ? "right" : "none";
    const mods = modsOf(e);
    moveFrame.current = requestAnimationFrame(() => {
      moveFrame.current = 0;
      if (!frame.current) return;
      sendInput({ t: "mouse", tab, n: n(), type: "mouseMoved", ...page(x, y), button: held, mods });
    });
  };

  // The wheel: the page's; Ctrl+wheel (a trackpad pinch) the local zoom; Alt+wheel the zoomed stage's pan.
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const s = live.current;
      if (s.inert) return;
      e.preventDefault();
      if (e.ctrlKey) {
        s.onZoom(pinchZoom(s.zoom, fitRef.current, Math.exp(-e.deltaY / 200)));
        return;
      }
      if (e.altKey && s.zoom !== null && scroller.current) {
        scroller.current.scrollLeft += e.deltaX || (e.shiftKey ? e.deltaY : 0);
        scroller.current.scrollTop += e.shiftKey ? 0 : e.deltaY;
        return;
      }
      const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
      const clamp = (v: number) => Math.max(-BROWSER_LIMITS.delta, Math.min(BROWSER_LIMITS.delta, Math.round(v * k)));
      const r = el.getBoundingClientRect();
      sendInput({ t: "mouse", tab: s.tab.id, n: drawnN(s.tab.id), type: "mouseWheel", ...toPage(e.clientX - r.left, e.clientY - r.top, r.width, factsRef.current), dx: clamp(e.deltaX), dy: clamp(e.deltaY), mods: modsOf(e) });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  const fitRef = useRef(fit.scale);
  fitRef.current = fit.scale;

  // Touch: tap, drag (a wheel, 1:1), flick, long press (a right-click), and the two-finger pinch and pan (D-19).
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    // `from` and `pressed`: Select text's drag (the page's point where it began, and whether its press went).
    type One = { x: number; y: number; t: number; lx: number; ly: number; drag: boolean; long: ReturnType<typeof setTimeout> | null; fired: boolean; v: { x: number; y: number; t: number }[]; from: PagePoint; pressed: boolean };
    let one: One | null = null;
    let two: { d: number; z: number | null; cx: number; cy: number; sl: number; st: number } | null = null;
    let fling = 0;
    const s = () => live.current;
    const hold = () => copyHold(s().tab.id).next();
    const dist = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const wheel = (x: number, y: number, dx: number, dy: number) => {
      const r = el.getBoundingClientRect();
      const zoom = r.width / (factsRef.current.dw || 1);
      const psf = factsRef.current.psf || 1;
      sendInput({ t: "mouse", tab: s().tab.id, n: drawnN(s().tab.id), type: "mouseWheel", ...toPage(x - r.left, y - r.top, r.width, factsRef.current), dx: Math.round(dx / zoom / psf), dy: Math.round(dy / zoom / psf) });
    };
    const start = (e: TouchEvent) => {
      if (s().inert) return;
      cancelAnimationFrame(fling);
      if (e.touches.length >= 2) {
        e.preventDefault();
        if (one?.long) clearTimeout(one.long);
        one = null;
        const [a, b] = [e.touches[0]!, e.touches[1]!];
        two = { d: dist(a, b), z: s().zoom, cx: (a.clientX + b.clientX) / 2, cy: (a.clientY + b.clientY) / 2, sl: scroller.current?.scrollLeft ?? 0, st: scroller.current?.scrollTop ?? 0 };
        return;
      }
      const t = e.touches[0]!;
      e.preventDefault();
      el.focus({ preventScroll: true });
      one = { x: t.clientX, y: t.clientY, t: performance.now(), lx: t.clientX, ly: t.clientY, drag: false, long: null, fired: false, v: [], from: page(t.clientX, t.clientY), pressed: false };
      if (!(s().moving && s().zoom !== null)) {
        const o = one;
        o.long = setTimeout(() => {
          if (one !== o || o.drag) return;
          o.fired = true;
          mark(o.x, o.y);
          const pt = page(o.x, o.y);
          sendInput({ t: "mouse", tab: s().tab.id, n: drawnN(s().tab.id), type: "mousePressed", ...pt, button: "right", clicks: 1 });
          sendInput({ t: "mouse", tab: s().tab.id, n: drawnN(s().tab.id), type: "mouseReleased", ...pt, button: "right", clicks: 1 });
        }, LONG_PRESS_MS);
      }
    };
    const move = (e: TouchEvent) => {
      if (two && e.touches.length >= 2) {
        e.preventDefault();
        const [a, b] = [e.touches[0]!, e.touches[1]!];
        const z = pinchZoom(two.z, fitRef.current, dist(a, b) / (two.d || 1));
        s().onZoom(z);
        if (scroller.current) {
          const cx = (a.clientX + b.clientX) / 2;
          const cy = (a.clientY + b.clientY) / 2;
          scroller.current.scrollLeft = two.sl - (cx - two.cx);
          scroller.current.scrollTop = two.st - (cy - two.cy);
        }
        return;
      }
      if (!one) return;
      e.preventDefault();
      const t = e.touches[0]!;
      if (!one.drag && Math.hypot(t.clientX - one.x, t.clientY - one.y) > TAP_SLOP) {
        one.drag = true;
        if (one.long) clearTimeout(one.long);
      }
      if (!one.drag) return;
      const dx = one.lx - t.clientX;
      const dy = one.ly - t.clientY;
      one.lx = t.clientX;
      one.ly = t.clientY;
      one.v.push({ x: dx, y: dy, t: performance.now() });
      if (one.v.length > 5) one.v.shift();
      if (s().moving && s().zoom !== null && scroller.current) {
        scroller.current.scrollLeft += dx;
        scroller.current.scrollTop += dy;
        return;
      }
      if (selectingText()) {
        for (const f of textDragFrames("move", one.pressed, one.from, page(t.clientX, t.clientY), s().tab.id, drawnN(s().tab.id), hold)) sendInput(f);
        one.pressed = true;
        return;
      }
      wheel(t.clientX, t.clientY, dx, dy);
    };
    const end = (e: TouchEvent) => {
      if (two) {
        if (e.touches.length < 2) two = null;
        return;
      }
      const o = one;
      one = null;
      if (!o) return;
      if (o.long) clearTimeout(o.long);
      if (o.fired) return;
      const now = performance.now();
      if (!o.drag) {
        if (now - o.t > TAP_MS * 3 || (s().moving && s().zoom !== null)) return;
        mark(o.x, o.y);
        const pt = page(o.x, o.y);
        const tabId = s().tab.id;
        sendInput({ t: "touch", tab: tabId, n: drawnN(tabId), type: "touchStart", points: [{ ...pt, id: 0 }] });
        sendInput({ t: "touch", tab: tabId, n: drawnN(tabId), type: "touchEnd", points: [] });
        return;
      }
      // Select text's drag ends with the left button's release, whose sq asks for the page's selection; no flick.
      if (o.pressed) {
        for (const f of textDragFrames("end", true, o.from, page(o.lx, o.ly), s().tab.id, drawnN(s().tab.id), hold)) sendInput(f);
        return;
      }
      // A flick: the last moves' speed carries on as a wheel that decays over a second.
      const recent = o.v.filter((v) => now - v.t < 100);
      if (!recent.length || (s().moving && s().zoom !== null)) return;
      const span = Math.max(16, now - recent[0]!.t);
      let vx = recent.reduce((a, v) => a + v.x, 0) / span;
      let vy = recent.reduce((a, v) => a + v.y, 0) / span;
      if (Math.hypot(vx, vy) < 0.3) return;
      const t0 = now;
      let last = now;
      const step = () => {
        const t = performance.now();
        const dt = t - last;
        last = t;
        if (t - t0 > FLING_MS) return;
        vx *= 0.92;
        vy *= 0.92;
        if (Math.hypot(vx, vy) < 0.05) return;
        wheel(o.lx, o.ly, vx * dt, vy * dt);
        fling = requestAnimationFrame(step);
      };
      fling = requestAnimationFrame(step);
    };
    // WebKit's own pinch: cancelled inside the frame's box only.
    const gesture = (e: Event) => e.preventDefault();
    el.addEventListener("touchstart", start, { passive: false });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
    el.addEventListener("gesturestart", gesture);
    return () => {
      cancelAnimationFrame(fling);
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
      el.removeEventListener("gesturestart", gesture);
    };
  }, []);

  // Keys while the frame holds them.
  const down = useRef(new Map<string, Stroke>());
  const sendStroke = (s: Stroke, which: "down" | "up" | "both") => {
    for (const f of strokeFrames(s, which)) sendInput({ t: "key", tab, n: n(), ...f, ...(asksSelection({ t: "key", type: f.type }) ? { sq: sq() } : {}) });
  };
  const copyNow = () => void copyPageSelection(tab);
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (p.inert) return;
    const a = keyAction(e.nativeEvent as KeyInput, IS_MAC);
    if (a.kind === "own") {
      if ((e.code === "KeyL" || e.key.toLowerCase() === "l") && !e.shiftKey) {
        e.preventDefault();
        p.onLeave();
      }
      return; // the page's own handlers act (Cmd+Shift+B, Ctrl+backtick, Close focused pane)
    }
    if (a.kind === "none" || a.kind === "paste") return;
    e.preventDefault();
    p.onKeySent();
    if (a.kind === "copy") copyNow();
    else if (a.kind === "text") sendInput({ t: "text", tab, n: n(), text: a.text, sq: sq() });
    else if (a.kind === "strokes") for (const s of a.strokes) sendStroke(s, "both");
    else {
      if (e.repeat && down.current.has(e.code)) {
        sendStroke(a.stroke, "down");
        return;
      }
      down.current.set(e.code, a.stroke);
      sendStroke(a.stroke, "down");
    }
  };
  const onKeyUp = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const s = down.current.get(e.code);
    if (!s) return;
    down.current.delete(e.code);
    sendStroke(s, "up");
  };
  const releaseAll = () => {
    for (const s of down.current.values()) sendStroke(s, "up");
    down.current.clear();
  };
  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    if (p.inert) return;
    e.preventDefault();
    const text = pasteText(e.clipboardData.getData("text/plain"));
    if (text) sendInput({ t: "text", tab, n: n(), text, sq: sq() });
  };

  // Esc in the frame is the page's (the layer over the chat passes it on, escape.ts).
  const escTake = useCallback(() => {
    if (document.activeElement !== frame.current) return false;
    sendStroke({ key: "Escape", code: "Escape", vk: 27, mods: 0 }, "both");
    return true;
  }, [tab]);
  useEffect(() => onEscape(escTake), [escTake]);

  const zoomed = p.zoom !== null;
  // The frame's place in the scrolled content: the 4 px inset, centred while it fits, at the top left when zoomed.
  const frameLeft = 4 + (zoomed ? 0 : Math.max(0, Math.floor((box.w - 8 - drawnW) / 2)));
  const frameTop = 4 - shiftY;
  const stageRect = { w: Math.max(box.w, drawnW + 8), h: Math.max(box.h, drawnH + 8), left: frameLeft, top: frameTop };
  return (
    <div ref={stage} className={`bp-stage${zoomed ? " is-zoomed" : ""}${p.moving && zoomed ? " is-moving" : ""}`} data-testid="browser-stage">
      <div ref={scroller} className="bp-stage-scroll">
        <div
          ref={frame}
          id={p.frameId}
          className={`bp-frame${p.dim ? " is-dim" : ""}`}
          style={{ width: drawnW || undefined, height: drawnH || undefined, marginTop: shiftY ? -shiftY : undefined }}
          role="application"
          aria-roledescription="page view"
          aria-label={p.title}
          aria-describedby={`${p.frameId}-d`}
          tabIndex={0}
          data-testid="browser-frame"
          data-keys="false"
          onFocus={(e) => {
            e.currentTarget.classList.add("has-keys");
            e.currentTarget.dataset.keys = "true";
            p.onKeys(true);
          }}
          onBlur={(e) => {
            e.currentTarget.classList.remove("has-keys");
            e.currentTarget.dataset.keys = "false";
            releaseAll();
            p.onKeys(false);
          }}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerMove={onPointerMove}
          onContextMenu={(e) => e.preventDefault()}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onPaste={onPaste}
        >
          <canvas ref={canvas} aria-hidden="true" />
          {marks.map((m) => (
            <span key={m.id} className="bp-tapmark" style={{ left: m.x, top: m.y }} aria-hidden="true" />
          ))}
        </div>
        {p.inFrame ? p.inFrame(facts, drawnW, stageRect) : null}
        <span id={`${p.frameId}-d`} hidden>
          {frameDescription(IS_MAC)}
        </span>
      </div>
      {zoomed ? (
        <div className="bp-zoomkeys">
          <button
            type="button"
            className="bp-pill"
            aria-pressed={p.moving}
            onClick={() => {
              if (!p.moving) setSelectingText(false);
              p.onMoving(!p.moving);
            }}
            data-testid="browser-move"
          >
            <IconMove size={14} />
            Move
          </button>
          <button
            type="button"
            className="bp-pill"
            aria-label="Fit the page to the pane"
            onClick={() => {
              p.onZoom(null);
              p.onMoving(false);
            }}
            data-testid="browser-fit"
          >
            Fit
          </button>
        </div>
      ) : null}
      {p.over}
    </div>
  );
}
