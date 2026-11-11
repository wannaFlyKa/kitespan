// The browser pane's frame (DESIGN-B1 4.3, 4.20; SPIKE 3.7): the fitted box with the ring's inset, the frame-to-page
// mapping with the local zoom and pageScaleFactor (and R8's offsetTop form), the way back for a picker's anchor, the
// zoom's steps and the pinch, and the view each size class asks for.
import { describe, expect, test } from "bun:test";
import { askChanged, fitBox, pinchZoom, STAGE_INSET, toFrame, toPage, viewAsk, zoomIn, zoomOut, zoomWords } from "../../web/browser/mapping";

const DESK = { dw: 1280, dh: 800, psf: 1, top: 0 };

describe("fitBox", () => {
  test("a Desktop tab in the 512 px laptop column keeps the 4 px inset and the page's shape", () => {
    // DESIGN-B1 4.1: 1,280 with the sidebar docked: the column is 512, so the frame is 8 px narrower: 504 x 315.
    const f = fitBox(512, 718, 1280, 800);
    expect(STAGE_INSET).toBe(4);
    expect(f.w).toBe(504);
    expect(f.h).toBe(315);
    expect(f.scale).toBeCloseTo(0.39375, 4);
  });
  test("the frame never shows larger than the page's own size", () => {
    expect(fitBox(1600, 1200, 390, 844)).toEqual({ w: 390, h: 844, scale: 1 });
  });
  test("a short stage fits by height", () => {
    const f = fitBox(1032, 300, 1280, 800);
    expect(f.h).toBe(292);
    expect(f.w).toBe(467);
  });
  test("no page size yet: the box", () => {
    expect(fitBox(100, 50, 0, 0)).toEqual({ w: 92, h: 42, scale: 1 });
  });
});

describe("toPage", () => {
  test("Fit: the frame's point scaled to the page", () => {
    // A 504 px frame of a 1280 px page: the frame's centre is the page's centre.
    expect(toPage(252, 157.5, 504, DESK)).toEqual({ x: 640, y: 400 });
  });
  test("the local zoom is in the drawn width: twice as wide, half the page px per frame px", () => {
    expect(toPage(252, 157.5, 1008, DESK)).toEqual({ x: 320, y: 200 });
  });
  test("pageScaleFactor divides too (SPIKE 3.7, the correction)", () => {
    expect(toPage(390, 422, 390, { dw: 390, dh: 844, psf: 2, top: 0 })).toEqual({ x: 195, y: 211 });
    expect(toPage(155.2, 100, 390, { dw: 390, dh: 844, psf: 0.398, top: 0 }).x).toBeCloseTo(390, 0);
  });
  test("R8's form: offsetTop comes off before the scale divides", () => {
    expect(toPage(0, 100, 390, { dw: 390, dh: 844, psf: 2, top: 20 })).toEqual({ x: 0, y: 40 });
  });
  test("clamped to the validator's range", () => {
    expect(toPage(-50, 1e9, 100, DESK)).toEqual({ x: -1, y: 10000 });
  });
  test("toFrame is toPage's inverse", () => {
    const f = { dw: 1280, dh: 800, psf: 1.5, top: 12 };
    const r = toFrame({ x: 100, y: 200, w: 40, h: 20 }, 640, f);
    const back = toPage(r.x, r.y, 640, f);
    expect(back.x).toBeCloseTo(100, 1);
    expect(back.y).toBeCloseTo(200, 1);
    expect(r.w).toBeCloseTo(40 * 1.5 * 0.5, 5);
  });
});

describe("the local zoom", () => {
  test("in: from Fit to the first step above it, up to 200%", () => {
    expect(zoomIn(null, 0.39)).toBe(0.5);
    expect(zoomIn(0.5, 0.39)).toBe(0.67);
    expect(zoomIn(1.5, 0.39)).toBe(2);
    expect(zoomIn(2, 0.39)).toBe(2);
    // A fit above a step skips it: a 0.8 fit goes to 100%.
    expect(zoomIn(null, 0.8)).toBe(1);
  });
  test("out: a step back, and Fit at or below the fitted scale", () => {
    expect(zoomOut(null, 0.39)).toBeNull();
    expect(zoomOut(0.67, 0.39)).toBe(0.5);
    expect(zoomOut(0.5, 0.39)).toBeNull();
    expect(zoomOut(1, 0.8)).toBeNull();
  });
  test("a pinch between Fit and 200%", () => {
    expect(pinchZoom(null, 0.3, 2)).toBeCloseTo(0.6, 5);
    expect(pinchZoom(0.6, 0.3, 0.4)).toBeNull();
    expect(pinchZoom(1.5, 0.3, 3)).toBe(2);
  });
  test("its words", () => {
    expect(zoomWords(null)).toBe("Fit");
    expect(zoomWords(0.67)).toBe("67%");
  });
});

describe("viewAsk (DESIGN-B1 4.20)", () => {
  test("a phone: quality 50, credit 1, DPR capped at 2, never wider than the page", () => {
    // A Desktop tab on a 390 px phone: the box's 382 CSS px at DPR 3 asks 382 at DPR 2 (the server makes it 764).
    expect(viewAsk("phone", 382, 238, 1280, 800, 3)).toEqual({ w: 382, h: 238, dpr: 2, q: 50, credit: 1 });
  });
  test("medium touch 60 and 2; a laptop 70 and 3", () => {
    expect(viewAsk("medium", 609, 380, 1280, 800, 2)).toMatchObject({ q: 60, credit: 2, dpr: 2 });
    expect(viewAsk("laptop", 504, 315, 1280, 800, 1)).toMatchObject({ q: 70, credit: 3, dpr: 1 });
  });
  test("zoomed past the page's own size: the page's size", () => {
    expect(viewAsk("laptop", 2560, 1600, 1280, 800, 1)).toMatchObject({ w: 1280, h: 800 });
  });
  test("within the validator's ranges", () => {
    expect(viewAsk("laptop", 0, 99999, 0, 0, 0.5)).toEqual({ w: 1, h: 4096, dpr: 1, q: 70, credit: 3 });
  });
  test("a change of a few pixels asks nothing new", () => {
    const a = viewAsk("laptop", 504, 315, 1280, 800, 1);
    expect(askChanged(null, a)).toBe(true);
    expect(askChanged(a, viewAsk("laptop", 510, 318, 1280, 800, 1))).toBe(false);
    expect(askChanged(a, viewAsk("laptop", 640, 400, 1280, 800, 1))).toBe(true);
  });
});
