// Row 79 (W19e): the chat follows its end only while the reader is at it. A reveal grows the column on every frame,
// and the view put itself back at the end each time while the reader was within 90 px of it, so a finger's drag (less
// than that per frame) or a small wheel step could never leave the end. Now any move toward the start stops following
// at once; only a move back near the end starts it again. The rule is pure (web/chat/follow.ts); ChatView feeds it the
// scroller's events. The column here is a stand-in: its height grows by 20 px a frame, as a reveal's does.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NEAR_BOTTOM, followedTo, newFollow, onKey, onScrolled, onTouchEnd, onTouchMove, onTouchStart, onWheel, type Follow } from "../../web/chat/follow";

/** A scroller 800 px high over a column that grows; `frame` grows it and, while the view follows, scrolls to the end. */
function column() {
  const f = newFollow();
  const view = { height: 3000, top: 2200, client: 800 };
  const gap = () => view.height - view.top - view.client;
  const scrollTo = (top: number) => {
    view.top = Math.max(0, Math.min(top, view.height - view.client));
    return onScrolled(f, view.top, gap());
  };
  const frame = (grow = 20) => {
    view.height += grow;
    // The column's ResizeObserver: while the view follows, it scrolls to the end itself.
    if (f.stick) {
      view.top = view.height - view.client;
      followedTo(f, view.top);
      // Its scroll event comes a frame later.
      onScrolled(f, view.top, gap());
    }
  };
  followedTo(f, view.top);
  return { f, view, gap, scrollTo, frame };
}

describe("following the end while text reveals", () => {
  test("a finger's drag of a few px a frame leaves the end, and the view stays where the reader took it", () => {
    const c = column();
    for (let i = 0; i < 10; i++) c.frame();
    expect(c.gap()).toBe(0);
    // A drag of 300 px in steps of 20 px, one a frame, while the reply reveals.
    onTouchStart(c.f, 400);
    let y = 400;
    for (let i = 0; i < 15; i++) {
      y += 20;
      onTouchMove(c.f, y, c.view.top);
      c.scrollTo(c.view.top - 20);
      c.frame();
    }
    onTouchEnd(c.f);
    expect(c.f.stick).toBe(false);
    for (let i = 0; i < 30; i++) c.frame();
    // 300 px of drag plus 45 frames of growth that the view no longer followed.
    expect(c.gap()).toBeGreaterThan(300);
  });

  test("a wheel or trackpad step of 10 px up leaves the end; a step down near the end follows again", () => {
    const c = column();
    c.frame();
    onWheel(c.f, -10, c.view.top);
    c.scrollTo(c.view.top - 10);
    expect(c.f.stick).toBe(false);
    for (let i = 0; i < 3; i++) c.frame();
    expect(c.gap()).toBe(70);
    expect(c.gap()).toBeLessThan(NEAR_BOTTOM);
    // Back down: within NEAR_BOTTOM of the end, the view follows again.
    onWheel(c.f, 40, c.view.top);
    c.scrollTo(c.view.top + 40);
    expect(c.f.stick).toBe(true);
    c.frame();
    expect(c.gap()).toBe(0);
  });

  test("a key that scrolls up leaves the end; a scrollbar drag up does too", () => {
    const c = column();
    onKey(c.f, "PageUp", false, c.view.top);
    expect(c.f.stick).toBe(false);
    const d = column();
    d.f.dragging = true;
    d.scrollTo(d.view.top - 5);
    expect(d.f.stick).toBe(false);
    const e = column();
    onKey(e.f, "ArrowDown", false, e.view.top);
    onKey(e.f, " ", false, e.view.top);
    expect(e.f.stick).toBe(true);
    onKey(e.f, " ", true, e.view.top);
    expect(e.f.stick).toBe(false);
  });

  test("at the top, or with nothing to scroll, a move up moves nothing and the view keeps following", () => {
    const f = newFollow();
    onWheel(f, -40, 0);
    onTouchStart(f, 100);
    onTouchMove(f, 160, 0);
    onKey(f, "PageUp", false, 0);
    expect(f.stick).toBe(true);
  });

  test("the view's own scroll, reported a frame later, and a column that got shorter near the end keep it following", () => {
    const c = column();
    c.frame();
    // The browser clamps the scroll when the column gets 30 px shorter at its end: no input, so not the reader's move.
    c.view.height -= 30;
    c.scrollTo(c.view.height - c.view.client);
    expect(c.f.stick).toBe(true);
    c.frame();
    expect(c.gap()).toBe(0);
  });

  test("a move far from the end with no input seen (a scroll the page could not tell apart) stops following, as before", () => {
    const f: Follow = newFollow();
    expect(onScrolled(f, 100, NEAR_BOTTOM + 10)).toBe(false);
  });

  test("ChatView feeds the rule the scroller's events and follows the end only while it says so", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "web", "chat", "ChatView.tsx"), "utf8");
    for (const name of ["onWheel", "onTouchStart", "onTouchMove", "onTouchEnd", "onKey", "onScrolled", "followedTo"]) expect(src).toContain(`${name}(`);
    expect(src).not.toMatch(/stick\.current = el\.scrollHeight - el\.scrollTop - el\.clientHeight < NEAR_BOTTOM/);
  });
});

// S1: ChatView does a scroll's work once a frame, in that frame's callbacks, after the reply's reveal has drawn in it,
// so the gap it measures includes that frame's growth. A height kept from the column's observer to measure against
// instead was stale after the view placed a linked row itself (a layout effect, before the observer saw the rows): it
// read a reader 4294 px above the end as at the end, and Jump to latest went (row 116; the lead's full run on b0b20a5).
describe("a scroll's work after the frame's reveal (S1)", () => {
  test("a linked row placed far above the end of the chat: the view does not follow, so Jump to latest stays", () => {
    const f = newFollow();
    // The chat opened at its end, then the view placed the linked row 4294 px above it; the scroll comes a frame later.
    followedTo(f, 9000);
    expect(onScrolled(f, 4706, 4294)).toBe(false);
    expect(f.stick).toBe(false);
  });

  test("back at the end in a frame whose reveal added less than NEAR_BOTTOM: the view follows again", () => {
    const f = newFollow();
    onWheel(f, -300, 2200);
    expect(onScrolled(f, 1900, 320)).toBe(false);
    // The End key; the frame's reveal added a line (24 px) before the scroll's work read the gap.
    expect(onScrolled(f, 2220, 24)).toBe(true);
  });

  test("ChatView measures the gap now, keeps no height from its observer, and reads the rail's mark in the same frame", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "web", "chat", "ChatView.tsx"), "utf8");
    const body = src.slice(src.indexOf("scrolledNow.current = () => {"), src.indexOf("useEffect(() => () => cancelAnimationFrame(scrollFrame.current), []);"));
    expect(body.length).toBeGreaterThan(100);
    expect(body).toContain("onScrolled(follow, top, el.scrollHeight - top - el.clientHeight)");
    expect(body).toContain("readRail();");
    expect(body).not.toContain("trackRail(");
    expect(src).not.toContain("seenHeight");
  });
});
