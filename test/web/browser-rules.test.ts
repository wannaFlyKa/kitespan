// The browser pane's rules as plain functions (DESIGN-B1 7.1, page side): the width and dock rule at each width of
// section 4.1 (D-13), the bar's fit rule (F5), the chip's three forms and the tabs' one mark (F13, F20), the slow
// line's timer (F8) and the copy path's pending rule (F3).
import { describe, expect, test } from "bun:test";
import type { BrowserActing, BrowserTabView } from "../../shared/browser";
import { BROWSER_MIN, barFit, browserLayout } from "../../web/browser/layout";
import { chipOf, tabMark } from "../../web/browser/claude";
import { SlowLine } from "../../web/browser/slow";
import { CopyHold, asksSelection } from "../../web/browser/copy";

const lap = (width: number) => ({ size: "laptop" as const, width });

describe("the width and dock rule (DESIGN-B1 4.1, D-13)", () => {
  // Window | the Browser (the design's table).
  const rows: [number, boolean, "column" | "over", number][] = [
    [1920, false, "column", 960],
    [1440, false, "column", 672],
    [1280, false, "column", 512],
    [1280, true, "column", 640],
    [1200, false, "column", 432],
    [1100, false, "over", 550],
    [1087, false, "over", 544],
    [1000, false, "over", 500],
  ];
  for (const [w, hidden, form, width] of rows)
    test(`${w}${hidden ? ", sidebar hidden" : ""}: ${form}, ${width}`, () => {
      expect(browserLayout(lap(w), { sidebarHidden: hidden })).toEqual({ form, width });
    });
  test("medium touch 1194 x 834 docks at 618; 834 x 1194 opens over the chat beside the pane bar at 778", () => {
    expect(browserLayout({ size: "medium", width: 1194 }, {})).toEqual({ form: "pane", width: 618 });
    expect(browserLayout({ size: "medium", width: 834 }, {})).toEqual({ form: "over", width: 778 });
  });
  test("the phone: its own page", () => {
    expect(browserLayout({ size: "phone", width: 390 }, {})).toEqual({ form: "page", width: 390 });
  });
  test("it docks only where the column is at least 420 px", () => {
    expect(BROWSER_MIN).toBe(420);
    for (let w = 1000; w <= 2400; w += 7) {
      const l = browserLayout(lap(w), {});
      if (l.form === "column") expect(l.width).toBeGreaterThanOrEqual(420);
      // The chat keeps 520 px beside it.
      if (l.form === "column") expect(w - 248 - l.width).toBeGreaterThanOrEqual(520);
    }
  });
  test("a laptop under 1,000 px (the sidebar a drawer): over the chat at the rule's width", () => {
    expect(browserLayout(lap(900), {})).toEqual({ form: "over", width: 480 });
  });
});

describe("the bar's fit rule (F5): the field keeps 160 px", () => {
  test("room for the long chip: the long chip", () => {
    expect(barFit({ room: 500, chipLong: 140, chipNarrow: 40, nav: 60, touch: false })).toEqual({ chip: "long", navInFoot: false });
  });
  test("no room for the long chip: the narrow form", () => {
    expect(barFit({ room: 260, chipLong: 228, chipNarrow: 113, nav: 0, touch: false })).toEqual({ chip: "narrow", navInFoot: false });
  });
  test("on touch, still short with the narrow chip: Back and Forward go to the foot", () => {
    expect(barFit({ room: 300, chipLong: 228, chipNarrow: 113, nav: 88, touch: true })).toEqual({ chip: "narrow", navInFoot: true });
    expect(barFit({ room: 300, chipLong: 228, chipNarrow: 113, nav: 88, touch: false })).toEqual({ chip: "narrow", navInFoot: false });
  });
  test("no chip: only Back and Forward can move", () => {
    expect(barFit({ room: 200, chipLong: 0, chipNarrow: 0, nav: 88, touch: true })).toEqual({ chip: null, navInFoot: true });
    expect(barFit({ room: 400, chipLong: 0, chipNarrow: 0, nav: 88, touch: true })).toEqual({ chip: null, navInFoot: false });
  });
});

const tab = (id: string, extra: Partial<BrowserTabView> = {}): BrowserTabView => ({
  id,
  url: "http://localhost:3000/",
  title: id,
  loading: false,
  canBack: false,
  canForward: false,
  by: "user",
  opener: null,
  crashed: false,
  hidden: false,
  dialog: null,
  chooser: null,
  size: { kind: "desktop", w: 1280, h: 800, by: "user" },
  claudeLast: null,
  ...extra,
});
const CHAT_A = "k3m7q2x4abk3m7q2x4ab";
const CHAT_B = "m7q2x4abk3m7q2x4abk3";
const call = (tabId: string | null, chat = CHAT_A, tool = "browser_click"): BrowserActing => ({ chat, tool, tab: tabId, since: "2026-11-09T10:00:00.000Z" });

describe("the chip's three forms (DESIGN-B1 4.4)", () => {
  test("in this tab: a status; beside another chat, a link to the acting chat", () => {
    expect(chipOf({ acting: [call("aaaaaaaaaa")], shown: "aaaaaaaaaa", besideChat: CHAT_A, hostState: "running" })).toEqual({ form: "here", chat: CHAT_A, link: false });
    expect(chipOf({ acting: [call("aaaaaaaaaa")], shown: "aaaaaaaaaa", besideChat: CHAT_B, hostState: "running" })).toEqual({ form: "here", chat: CHAT_A, link: true });
    expect(chipOf({ acting: [call("aaaaaaaaaa")], shown: "aaaaaaaaaa", besideChat: null, hostState: "running" })).toEqual({ form: "here", chat: CHAT_A, link: false });
  });
  test("in another tab: a button that shows it", () => {
    expect(chipOf({ acting: [call("bbbbbbbbbb")], shown: "aaaaaaaaaa", besideChat: CHAT_A, hostState: "running" })).toEqual({ form: "other", tab: "bbbbbbbbbb", chat: CHAT_A });
  });
  test("the tab unknown (browser_navigate, browser_tabs, browser_close): a status, no tab", () => {
    expect(chipOf({ acting: [call(null, CHAT_A, "browser_navigate")], shown: "aaaaaaaaaa", besideChat: CHAT_A, hostState: "running" })).toEqual({ form: "unknown" });
  });
  test("this tab wins over another, another over unknown", () => {
    expect(chipOf({ acting: [call(null), call("bbbbbbbbbb"), call("aaaaaaaaaa", CHAT_B)], shown: "aaaaaaaaaa", besideChat: CHAT_A, hostState: "running" })).toEqual({ form: "here", chat: CHAT_B, link: true });
    expect(chipOf({ acting: [call(null), call("bbbbbbbbbb")], shown: "aaaaaaaaaa", besideChat: CHAT_A, hostState: "running" })?.form).toBe("other");
  });
  test("off with no call, and in the port states (F1)", () => {
    expect(chipOf({ acting: [], shown: "aaaaaaaaaa", besideChat: CHAT_A, hostState: "running" })).toBeNull();
    expect(chipOf({ acting: [call("aaaaaaaaaa")], shown: "aaaaaaaaaa", besideChat: CHAT_A, hostState: "port_own" })).toBeNull();
    expect(chipOf({ acting: [call("aaaaaaaaaa")], shown: "aaaaaaaaaa", besideChat: CHAT_A, hostState: "port_other" })).toBeNull();
  });
});

describe("a tab's one mark (DESIGN-B1 4.2)", () => {
  test("the needs-you dot first, then the working mark, then the pointer", () => {
    const t = tab("aaaaaaaaaa", { dialog: 3, claudeLast: CHAT_A });
    expect(tabMark(t, [call("aaaaaaaaaa")])).toBe("dot");
    expect(tabMark(tab("aaaaaaaaaa", { chooser: 1 }), [])).toBe("dot");
    expect(tabMark(tab("aaaaaaaaaa", { claudeLast: CHAT_A }), [call("aaaaaaaaaa")])).toBe("working");
    expect(tabMark(tab("aaaaaaaaaa", { claudeLast: CHAT_A }), [call(null)])).toBe("pointer");
    expect(tabMark(tab("aaaaaaaaaa"), [call("bbbbbbbbbb")])).toBeNull();
  });
});

describe("the slow line (F8)", () => {
  test("a pong more than 1.5 s after its ping shows it; two pongs within 500 ms take it away", () => {
    const s = new SlowLine();
    s.sent(1, 0);
    s.got(1, 300);
    expect(s.slow).toBe(false);
    s.sent(2, 1000);
    s.got(2, 2600);
    expect(s.slow).toBe(true);
    s.sent(3, 3000);
    s.got(3, 3400);
    expect(s.slow).toBe(true);
    s.sent(4, 5000);
    s.got(4, 5100);
    expect(s.slow).toBe(false);
  });
  test("a ping still unanswered after 1.5 s shows it at once", () => {
    const s = new SlowLine();
    s.sent(1, 0);
    s.tick(1400);
    expect(s.slow).toBe(false);
    s.tick(1501);
    expect(s.slow).toBe(true);
  });
  test("a fast pong between two slow ones restarts the count", () => {
    const s = new SlowLine();
    s.sent(1, 0);
    s.got(1, 2000);
    s.sent(2, 2100);
    s.got(2, 2200);
    s.sent(3, 2300);
    s.got(3, 4000);
    s.sent(4, 4100);
    s.got(4, 4200);
    expect(s.slow).toBe(true);
    s.sent(5, 4300);
    s.got(5, 4400);
    expect(s.slow).toBe(false);
  });
  test("an unknown pong changes nothing; reset clears it", () => {
    const s = new SlowLine();
    s.sent(1, 0);
    s.got(9, 5000);
    s.tick(1600);
    expect(s.slow).toBe(true);
    s.reset();
    expect(s.slow).toBe(false);
  });
});

describe("the copy path (F3, DESIGN 7.10 rule 2)", () => {
  test("the newest selection the page holds is what Copy writes", () => {
    const c = new CopyHold();
    expect(c.copy()).toEqual({ text: "", pending: false });
    const sq = c.next();
    c.got(sq, "Ridge Loop", false);
    expect(c.copy()).toEqual({ text: "Ridge Loop", pending: false });
  });
  test("while an input with sq waits for its answer, Copy is pending (Copy failed, with the held text)", () => {
    const c = new CopyHold();
    c.got(c.next(), "old", false);
    c.next();
    expect(c.copy()).toEqual({ text: "old", pending: true });
  });
  test("an answer to an older input never replaces a newer one", () => {
    const c = new CopyHold();
    const a = c.next();
    const b = c.next();
    c.got(b, "new", false);
    c.got(a, "older", false);
    expect(c.copy()).toEqual({ text: "new", pending: false });
  });
  test("a cut selection says so; a new tab starts empty", () => {
    const c = new CopyHold();
    c.got(c.next(), "x".repeat(10), true);
    expect(c.copy().cut).toBe(true);
    c.clear();
    expect(c.copy()).toEqual({ text: "", pending: false });
  });
  test("every key that goes down, every text and a left release ask for the selection again; a key's release, a move, a wheel and a touch do not", () => {
    for (const type of ["keyDown", "rawKeyDown"] as const) expect([type, asksSelection({ t: "key", type })]).toEqual([type, true]);
    expect(asksSelection({ t: "key", type: "keyUp" })).toBe(false);
    expect(asksSelection({ t: "text" })).toBe(true);
    expect(asksSelection({ t: "mouse", type: "mouseReleased", button: "left" })).toBe(true);
    expect(asksSelection({ t: "mouse", type: "mouseReleased", button: "right" })).toBe(false);
    expect(asksSelection({ t: "mouse", type: "mouseMoved", button: "left" })).toBe(false);
    expect(asksSelection({ t: "mouse", type: "mouseWheel" })).toBe(false);
    expect(asksSelection({ t: "touch", type: "touchEnd" })).toBe(false);
  });
  // The review's two sequences (D-15: the copy is the page's current selection, never text that is gone).
  test("Ctrl+A, then a typed key over the selection: Copy waits for the key's answer, then has nothing to write", () => {
    const c = new CopyHold();
    c.got(c.next(), "one two three", false); // Ctrl+A's answer
    expect(c.copy()).toEqual({ text: "one two three", pending: false });
    expect(asksSelection({ t: "key", type: "keyDown" })).toBe(true); // "x" goes down with sq
    const x = c.next();
    expect(c.copy().pending).toBe(true);
    c.got(x, "", false);
    expect(c.copy()).toEqual({ text: "", pending: false });
  });
  test("Ctrl+A, then an arrow that collapses the selection: the arrow's answer, empty, is what Copy has", () => {
    const c = new CopyHold();
    c.got(c.next(), "one two three", false);
    expect(asksSelection({ t: "key", type: "rawKeyDown" })).toBe(true); // ArrowRight
    c.got(c.next(), "", false);
    expect(c.copy()).toEqual({ text: "", pending: false });
  });
  test("a navigation clears the held text, and an answer to an input sent before it is dropped", () => {
    const c = new CopyHold();
    c.got(c.next(), "old page", false);
    const before = c.next();
    c.clear();
    c.got(before, "old page, late", false);
    expect(c.copy()).toEqual({ text: "", pending: false });
    const after = c.next();
    c.got(after, "new page", false);
    expect(c.copy()).toEqual({ text: "new page", pending: false });
  });
});
