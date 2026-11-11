// The shell's layout rules (DESIGN.md 6.1, 6.2, 7.3 and 5.3), from the pure function the Shell, TopBar and Sidebar read:
// where the sidebar docks, when the side panel is a column and when its pane opens over the chat, and the medium pane.
import { describe, expect, test } from "bun:test";
import { CHAT_MIN, PANEL_W, SIDEBAR_W, computeSizeClass, mediumPaneWidth, shellLayout } from "../../web/layout/size";
import { nextHeightMark } from "../../web/layout/heightMark";
import { CHATS, PROJECTS } from "./fixtures";
import { popupIsSheet } from "../../web/ui/primitives";
import { chatOrder, listedChats, shortcutFor, stepChat } from "../../web/ui/shortcuts";

const laptop = (width: number) => shellLayout({ size: "laptop", width });
const PANE_BAR_TOUCH = 56; // tokens.css: --pane-bar-w on touch

describe("the laptop layout", () => {
  test("at 1100 px the sidebar docks and the side panel is a column beside 532 px of chat", () => {
    expect(laptop(1100)).toEqual({ size: "laptop", sidebar: "docked", side: "column", paneOver: false, paneBar: false });
    expect(1100 - SIDEBAR_W - PANEL_W).toBe(532);
  });
  test("the column needs the chat column to keep 520 px: 1088 px is the first width that has it", () => {
    expect(1088 - SIDEBAR_W - PANEL_W).toBe(CHAT_MIN);
    expect(laptop(1088).side).toBe("column");
    expect(laptop(1087)).toEqual({ size: "laptop", sidebar: "docked", side: "pane", paneOver: true, paneBar: true });
  });
  test("from 1,000 to 1,087 px the pane bar opens the pane over the chat", () => {
    for (const w of [1000, 1024, 1080]) expect(laptop(w)).toMatchObject({ sidebar: "docked", side: "pane", paneOver: true, paneBar: true });
  });
  test("under 1,000 px the sidebar is a drawer, and the chat keeps room for the column", () => {
    for (const w of [841, 900, 999]) expect(laptop(w)).toEqual({ size: "laptop", sidebar: "drawer", side: "column", paneOver: false, paneBar: false });
  });
});

describe("medium touch and the phone", () => {
  test("medium: the chat list in a drawer, a pane bar and one docked pane (D26)", () => {
    expect(shellLayout({ size: "medium", width: 834 })).toEqual({ size: "medium", sidebar: "drawer", side: "pane", paneOver: false, paneBar: true });
  });
  test("the medium pane is 320 px from an 800 px window, else 40% (DESIGN.md 7.3's numbers)", () => {
    expect(mediumPaneWidth(800)).toBe(320);
    expect(834 - mediumPaneWidth(834) - PANE_BAR_TOUCH).toBe(458);
    expect(768 - mediumPaneWidth(768) - PANE_BAR_TOUCH).toBe(405);
    expect(626 - mediumPaneWidth(626) - PANE_BAR_TOUCH).toBe(320);
    expect(mediumPaneWidth(799)).toBe(320);
    expect(mediumPaneWidth(700)).toBe(280);
  });
  test("the phone: one screen at a time, the side cards in a sheet", () => {
    expect(shellLayout({ size: "phone", width: 390 })).toEqual({ size: "phone", sidebar: "screen", side: "sheet", paneOver: false, paneBar: false });
  });
});

describe("every size class reaches the side panel and the chat list", () => {
  const cases: [number, number, boolean][] = [
    [390, 844, true],
    [844, 390, true],
    [834, 1194, true],
    [1194, 834, true],
    [1024, 1366, true],
    [700, 900, false],
    [900, 800, false],
    [1024, 768, false],
    [1100, 800, false],
    [1440, 900, false],
  ];
  for (const [w, h, coarse] of cases)
    test(`${w} x ${h}${coarse ? " with touch" : ""}`, () => {
      const l = shellLayout({ size: computeSizeClass(w, h, coarse), width: w });
      // A side panel path shows the panel in some form: a column, a pane (docked or over the chat), or the sheet.
      expect(["column", "pane", "sheet"]).toContain(l.side);
      if (l.side === "pane") expect(l.paneBar).toBe(true);
      // /chats shows the list: docked (it takes the focus), a drawer, or the phone's screen.
      expect(["docked", "drawer", "screen"]).toContain(l.sidebar);
    });
});

describe("size classes (DESIGN.md 7.1)", () => {
  test("a narrow fine-pointer window keeps the code's layout: the phone's under 600 px, the medium one to 840 px (T-24)", () => {
    // DESIGN-T1 T-24 (owner question Q10): a laptop window is sized by its width, so a 360 x 800 or 390 x 844 window
    // with no touch gets the phone's layout, and a 700 x 900 one the medium layout, without the touch rules (the
    // body's touch class is its own question, size.ts read).
    expect([computeSizeClass(360, 800, false), computeSizeClass(390, 844, false), computeSizeClass(599, 900, false)]).toEqual(["phone", "phone", "phone"]);
    expect([computeSizeClass(600, 900, false), computeSizeClass(700, 900, false), computeSizeClass(840, 400, false)]).toEqual(["medium", "medium", "medium"]);
    expect(computeSizeClass(841, 400, false)).toBe("laptop");
    expect(shellLayout({ size: computeSizeClass(390, 844, false), width: 390 })).toMatchObject({ size: "phone", side: "sheet" });
  });
  test("the terminal app's cases: 820 x 1180 coarse is medium both ways, 1024 x 1366 is large", () => {
    expect([computeSizeClass(820, 1180, true), computeSizeClass(1180, 820, true)]).toEqual(["medium", "medium"]);
    expect(computeSizeClass(1024, 1366, true)).toBe("laptop");
    expect([599, 600, 840, 841].map((side) => computeSizeClass(side, 2000, true))).toEqual(["phone", "medium", "medium", "laptop"]);
  });
  test("an 851 x 1100 tablet stays large while a keyboard shrinks innerHeight to 780: the short side uses the mark H", () => {
    let mark = nextHeightMark(null, 851, 1100);
    expect(computeSizeClass(851, mark.height, true)).toBe("laptop");
    mark = nextHeightMark(mark, 851, 780); // the keyboard shrinks the layout viewport (Android, resizes-content)
    expect(mark.height).toBe(1100);
    expect(computeSizeClass(851, mark.height, true)).toBe("laptop");
    // So does the 1024 x 1366 tablet whose layout shrinks to 760 while the user types.
    expect(computeSizeClass(1024, nextHeightMark(nextHeightMark(null, 1024, 1366), 1024, 760).height, true)).toBe("laptop");
  });
  test("the mark starts again when innerWidth changes (a rotation, a new window size)", () => {
    const portrait = nextHeightMark(null, 834, 1194);
    const landscape = nextHeightMark(portrait, 1194, 834);
    expect(landscape).toEqual({ width: 1194, height: 834 });
    expect(nextHeightMark(landscape, 1194, 900)).toEqual({ width: 1194, height: 900 });
  });
  test("a touch laptop with a fine pointer is sized by its width alone", () => {
    // The coarse argument is (pointer: coarse) only; maxTouchPoints sets the touch rules, not the class.
    expect(computeSizeClass(1366, 768, false)).toBe("laptop");
    expect(computeSizeClass(1280, 800, false)).toBe("laptop");
    expect(computeSizeClass(1366, 768, true)).toBe("medium"); // the same window with a coarse pointer is a tablet
  });
  test("a bad read gives the laptop layout", () => {
    expect([computeSizeClass(0, 0, true), computeSizeClass(Number.NaN, 800, false), computeSizeClass(800, 0, true)]).toEqual(["laptop", "laptop", "laptop"]);
  });
});

describe("pickers and menus per size class (DESIGN.md 5.3)", () => {
  test("a menu above its button on a laptop and a tablet, a bottom sheet on the phone or with no anchor", () => {
    expect([popupIsSheet("laptop", true), popupIsSheet("medium", true), popupIsSheet("phone", true)]).toEqual([false, false, true]);
    expect([popupIsSheet("laptop", false), popupIsSheet("medium", false)]).toEqual([true, true]);
  });
});

describe("the window shortcuts (DESIGN.md 6.11)", () => {
  const key = (k: string, code: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "shiftKey" | "altKey", boolean>> = {}) =>
    shortcutFor({ key: k, code, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });
  test("Cmd or Ctrl and the slash key shows the shortcuts; with Shift and a square bracket, the next or previous chat", () => {
    expect([key("/", "Slash", { metaKey: true }), key("/", "Slash", { ctrlKey: true }), key("/", "Digit7", { ctrlKey: true, shiftKey: true })]).toEqual(["shortcuts", "shortcuts", "shortcuts"]);
    expect([key("}", "BracketRight", { metaKey: true, shiftKey: true }), key("{", "BracketLeft", { ctrlKey: true, shiftKey: true })]).toEqual(["next", "previous"]);
    expect([key("/", "Slash"), key("]", "BracketRight", { metaKey: true }), key("/", "Slash", { ctrlKey: true, altKey: true })]).toEqual([null, null, null]);
  });
  test("the sidebar's order: the projects in order, each one's chats newest first; the steps go round the ends", () => {
    const order = chatOrder(PROJECTS, CHATS);
    const last = order[order.length - 1]!;
    expect(order.slice(0, 2)).toEqual(["demoolxxxxxxxxxxxxxx", "asko2xxxxxxxxxxxxxxx"]); // kitespan: 2 min ago, then 9 min ago
    expect(order.length).toBe(CHATS.length);
    expect(stepChat(order, "demoolxxxxxxxxxxxxxx", 1)).toBe("asko2xxxxxxxxxxxxxxx");
    expect(stepChat(order, "demoolxxxxxxxxxxxxxx", -1)).toBe(last);
    expect(stepChat(order, last, 1)).toBe("demoolxxxxxxxxxxxxxx");
    expect([stepChat(order, undefined, 1), stepChat(order, undefined, -1), stepChat([], "demoolxxxxxxxxxxxxxx", 1)]).toEqual([order[0]!, last, null]);
  });
  test("the steps follow the chats the list shows: its filter and folded projects; no list on screen gives null", () => {
    const row = (to: string, shown = true) => ({ getAttribute: (n: string) => (n === "href" ? to : null), getClientRects: () => (shown ? [{}] : []) });
    const page = (lists: ReturnType<typeof row>[], rows: ReturnType<typeof row>[]) => ({
      querySelectorAll: (q: string) => (q === ".scr-list" ? lists : q === ".scr-list a.scr-row" ? rows : []),
    });
    // The sidebar with the Needs input filter: four rows, so a step from asko2xxxxxxxxxxxxxxx goes to elico7xxxxxxxxxxxxxx, never to a hidden chat.
    const filtered = page([row("")], [row("/c/demoolxxxxxxxxxxxxxx"), row("/c/asko2xxxxxxxxxxxxxxx"), row("/c/elico7xxxxxxxxxxxxxx"), row("/c/plano3xxxxxxxxxxxxxx")]);
    const order = listedChats(filtered)!;
    expect(order).toEqual(["demoolxxxxxxxxxxxxxx", "asko2xxxxxxxxxxxxxxx", "elico7xxxxxxxxxxxxxx", "plano3xxxxxxxxxxxxxx"]);
    expect([stepChat(order, "asko2xxxxxxxxxxxxxxx", 1), stepChat(order, "plano3xxxxxxxxxxxxxx", 1), stepChat(order, "demoolxxxxxxxxxxxxxx", -1)]).toEqual(["elico7xxxxxxxxxxxxxx", "demoolxxxxxxxxxxxxxx", "plano3xxxxxxxxxxxxxx"]);
    // A row that is not drawn, a link that is not a chat, and a repeat are left out.
    expect(listedChats(page([row("")], [row("/c/demoolxxxxxxxxxxxxxx"), row("/c/asko2xxxxxxxxxxxxxxx", false), row("/new"), row("/c/demoolxxxxxxxxxxxxxx"), row("/c/runo4xxxxxxxxxxxxxxx/uploads")]))).toEqual(["demoolxxxxxxxxxxxxxx"]);
    // A list that shows no chat (a filter with none): no step. No list on screen (a closed drawer): null, chatOrder decides.
    expect(listedChats(page([row("")], []))).toEqual([]);
    expect(stepChat([], "demoolxxxxxxxxxxxxxx", 1)).toBe(null);
    expect(listedChats(page([row("", false)], [row("/c/demoolxxxxxxxxxxxxxx")]))).toBe(null);
    expect(listedChats(page([], []))).toBe(null);
  });
});
