// The frame and the page (DESIGN-B1 4.3, 4.20; SPIKE 3.7): where the frame sits on the stage, how a point on it maps
// to the page's viewport, the local zoom's steps, and the frame size and pacing each size class asks of the server.
// Plain numbers, so a unit test checks them; Stage.tsx measures and draws.
import { BROWSER_LIMITS } from "../../shared/browser";
import type { SizeClass } from "../layout/size";

/** The stage keeps this inset round the frame for the ring outside it (DESIGN-B1 4.2: 1 px gap and 2 px line, and room). */
export const STAGE_INSET = 4;

/** What a frame's header says of the page it shows (shared/browser.ts CastHeader). */
export interface FrameFacts {
  /** The page's viewport width and height in CSS px (Chrome's deviceWidth and deviceHeight). */
  dw: number;
  dh: number;
  /** pageScaleFactor: a pinch inside the page, or a phone page's own scale. */
  psf: number;
  /** offsetTop: the top controls' height (0 in every frame seen so far, SPIKE 3.7). */
  top: number;
}

/**
 * The frame's fitted box on a stage `stageW` x `stageH` (CSS px): the page `pageW` x `pageH` fitted whole (contain),
 * inside the inset, never larger than the page's own size. Whole pixels, at least 1.
 */
export function fitBox(stageW: number, stageH: number, pageW: number, pageH: number, inset = STAGE_INSET): { w: number; h: number; scale: number } {
  const bw = Math.max(1, stageW - 2 * inset);
  const bh = Math.max(1, stageH - 2 * inset);
  if (!(pageW > 0) || !(pageH > 0)) return { w: bw, h: bh, scale: 1 };
  const scale = Math.min(bw / pageW, bh / pageH, 1);
  return { w: Math.max(1, Math.floor(pageW * scale)), h: Math.max(1, Math.floor(pageH * scale)), scale };
}

/**
 * A point on the frame (`fx`, `fy` in CSS px from the drawn frame's top left; the drawn frame is `boxW` wide, the local
 * zoom included) to the page's viewport (CSS px), for Input.dispatchMouseEvent and dispatchTouchEvent: SPIKE 3.7's
 * verified `x = fx / zoom / pageScaleFactor`, and R8's `y = (fy / zoom - offsetTop) / pageScaleFactor`, with
 * zoom = boxW / deviceWidth. Rounded to a tenth of a pixel; clamped to the limits the validator takes.
 */
export function toPage(fx: number, fy: number, boxW: number, f: FrameFacts): { x: number; y: number } {
  const zoom = boxW > 0 && f.dw > 0 ? boxW / f.dw : 1;
  const psf = f.psf > 0 ? f.psf : 1;
  const x = fx / zoom / psf;
  const y = (fy / zoom - (Number.isFinite(f.top) ? f.top : 0)) / psf;
  const clamp = (v: number) => Math.min(BROWSER_LIMITS.coordMax, Math.max(BROWSER_LIMITS.coordMin, Math.round(v * 10) / 10));
  return { x: clamp(x), y: clamp(y) };
}

/** The other way: a box in the page's viewport (a picker's control, the focused field) to the drawn frame (CSS px). */
export function toFrame(box: { x: number; y: number; w: number; h: number }, boxW: number, f: FrameFacts): { x: number; y: number; w: number; h: number } {
  const zoom = boxW > 0 && f.dw > 0 ? boxW / f.dw : 1;
  const psf = f.psf > 0 ? f.psf : 1;
  const top = Number.isFinite(f.top) ? f.top : 0;
  return { x: box.x * psf * zoom, y: (box.y * psf + top) * zoom, w: box.w * psf * zoom, h: box.h * psf * zoom };
}

// ---- the local zoom (DESIGN-B1 4.3, PAGE 4): Fit, then steps of the page's own size above Fit, up to 200%

/** The steps, as a share of the page's own size (1 is 100%). Fit is below the first one that is larger than it. */
export const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2] as const;
export const ZOOM_MAX = 2;

/**
 * The zoom as the share of the page's own size that the frame shows at (`fit` is the fitted scale): null is Fit. The
 * next step in: the first step above the current share (and above Fit); none past 200%.
 */
export function zoomIn(now: number | null, fit: number): number | null {
  const at = now ?? fit;
  const next = ZOOM_STEPS.find((s) => s > at + 0.001 && s > fit + 0.001);
  return next ?? (at < ZOOM_MAX ? ZOOM_MAX : now);
}

/** The next step out: the last step below the current share; at or below Fit, Fit (null). */
export function zoomOut(now: number | null, fit: number): number | null {
  if (now === null) return null;
  const prev = [...ZOOM_STEPS].reverse().find((s) => s < now - 0.001);
  return prev === undefined || prev <= fit + 0.001 ? null : prev;
}

/** A pinch's zoom: the share it reaches, between Fit and 200%; at Fit or below, Fit (null). */
export function pinchZoom(start: number | null, fit: number, ratio: number): number | null {
  const at = (start ?? fit) * (ratio > 0 ? ratio : 1);
  if (at <= fit + 0.001) return null;
  return Math.min(ZOOM_MAX, at);
}

/** The zoom's words in More: "Fit", or the percent of the page's own size. */
export function zoomWords(now: number | null): string {
  return now === null ? "Fit" : `${Math.round(now * 100)}%`;
}

// ---- what each size class asks of the server (DESIGN-B1 4.20, design values to tune)

export interface ViewAsk {
  /** The frame box asked for, in CSS px, never wider than the page's own width. */
  w: number;
  h: number;
  /** The device pixel ratio, capped at 2. */
  dpr: number;
  q: number;
  credit: number;
}

const PACE: Record<SizeClass, { q: number; credit: number }> = {
  phone: { q: 50, credit: 1 },
  medium: { q: 60, credit: 2 },
  laptop: { q: 70, credit: 3 },
};

/**
 * The `view` frame's sizes for a frame drawn `boxW` x `boxH` (CSS px, the zoom included) of a page `pageW` x `pageH`:
 * the box, never wider or taller than the page's own size, at the device's pixel ratio capped at 2, with the size
 * class's quality and credit. Whole numbers within the validator's ranges.
 */
export function viewAsk(size: SizeClass, boxW: number, boxH: number, pageW: number, pageH: number, dpr: number): ViewAsk {
  const L = BROWSER_LIMITS;
  const box = (v: number, page: number) => Math.min(L.viewBoxMax, Math.max(L.viewBoxMin, Math.round(page > 0 ? Math.min(v, page) : v)));
  const ratio = Math.min(2, Math.max(L.dprMin, Number.isFinite(dpr) ? dpr : 1));
  const p = PACE[size];
  return { w: box(boxW, pageW), h: box(boxH, pageH), dpr: Math.round(ratio * 100) / 100, q: p.q, credit: p.credit };
}

/** Two asks differ enough to ask again (a size change of more than 8 px either way, or another quality or credit). */
export function askChanged(a: ViewAsk | null, b: ViewAsk): boolean {
  if (!a) return true;
  return Math.abs(a.w - b.w) > 8 || Math.abs(a.h - b.h) > 8 || a.dpr !== b.dpr || a.q !== b.q || a.credit !== b.credit;
}
