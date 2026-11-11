// Row 82 (W19f): the panes' drag handles and the sidebar's Hide and Show. On a laptop and on the tablet sizes, the
// left sidebar and the right side pane (Details, the search pane, the Terminal pane and every other docked pane) each
// have a handle on their inner edge: a separator (role, aria-valuenow, aria-valuemin, aria-valuemax; the arrows move it
// 16 px, Home and End go to the ends; a double-click puts the default back), within a minimum (240 px for the sidebar,
// where its filter and its head fit in every look, 280 px for the side pane) and a maximum that keeps the chat column
// 420 px wide. The widths and the sidebar's hidden state are the device's own (local storage, beside the session
// rail's), never a URL; one CSS variable per pane carries the width, registered as not inherited, and the handle holds
// its own place, so a drag restyles the shell and the handle only. On touch the handle starts under the title bar and
// shows a grip. The phone is unchanged.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parse } from "../../web/router";
import { loadView, resetState } from "../../web/state/store";
import { DEFAULT_VIEW } from "../../web/state/catalog";
import type { Chat, ViewPrefs } from "../../web/state/types";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHAT_KEEP, PANE_STEP, SIDE_MAX, SIDE_MIN, SIDEBAR_MAX, SIDEBAR_MIN, cleanWidths, dragWidth, keyWidth, paneRanges, resizable, restoreDefault, type PaneInput, type PaneRange } from "../../web/layout/panes";
import { PANEL_W, SIDEBAR_W, mediumPaneWidth, shellLayout, terminalLayout } from "../../web/layout/size";
import { Shell } from "../../web/layout/Shell";
import { TopBar } from "../../web/layout/TopBar";
import { SIDEBAR_HIDE, SIDEBAR_SHOW } from "../../web/layout/Sidebar";
import { CHATS, PROJECTS } from "./fixtures";

const CHAT = "demoolxxxxxxxxxxxxxx";
const at = (u: string) => parse(new URL(u, "http://127.0.0.1"));

const gm = globalThis as unknown as { matchMedia?: unknown; window?: unknown };
const own = { mm: !gm.matchMedia, win: !gm.window };
let coarse = false;
function viewport(width: number, height: number, touch: boolean) {
  coarse = touch;
  gm.window = { innerWidth: width, innerHeight: height, addEventListener() {}, removeEventListener() {} };
}
beforeAll(() => {
  gm.matchMedia = (q: string) => ({ matches: coarse && q === "(pointer: coarse)", addEventListener() {}, removeEventListener() {} });
  viewport(1280, 800, false);
});
afterAll(() => {
  if (own.mm) delete gm.matchMedia;
  if (own.win) delete gm.window;
  resetState();
});

function state(view: Partial<ViewPrefs> = {}) {
  resetState({ projects: structuredClone(PROJECTS), chats: structuredClone(CHATS), ready: true, view: { ...DEFAULT_VIEW, ...view } });
}

const chatOf = (): Chat => CHATS.find((c) => c.id === CHAT)!;
const shell = (path: string) =>
  renderToStaticMarkup(createElement(Shell, { route: at(path), chat: chatOf(), side: () => createElement("div", { "data-testid": "side-panel" }), children: createElement("div", { className: "chat-screen" }) }));
/** The separators in the markup, each as its attributes. */
const separators = (html: string) =>
  [...html.matchAll(/<div[^>]*role="separator"[^>]*>/g)].map((m) => Object.fromEntries([...m[0].matchAll(/([a-z-]+)="([^"]*)"/g)].map((a) => [a[1]!, a[2]!])));
const shellStyle = (html: string) => /<div class="shell [^"]*"[^>]*style="([^"]*)"/.exec(html)?.[1] ?? "";

// ---------------------------------------------------------------------------------------------------------------
// The width rules (pure)

const laptopColumn = (width: number, widths = {}) => paneRanges({ width, touch: false, sidebar: true, right: { pane: "side", def: PANEL_W }, bar: false, widths });

describe("the width rules", () => {
  test("the minimums, and the defaults the design gives (248 px, 320 px)", () => {
    // 240 px: the narrowest sidebar whose filter ("Needs input") stays on one line and whose head ("kitespan", Search,
    // New and, on touch, the 44 px Hide sidebar) does not run together, in all four looks (a probe in Chrome: 236 px
    // on a laptop, 240 px on a large touch tablet).
    expect([SIDEBAR_MIN, SIDE_MIN, CHAT_KEEP, PANE_STEP]).toEqual([240, 280, 420, 16]);
    const r = laptopColumn(1280);
    expect(r.sidebar).toEqual({ min: 240, max: 480, def: SIDEBAR_W, now: 248, reach: 480 });
    expect(r.right).toEqual({ min: 280, max: 612, def: 320, now: 320, reach: 620 });
  });
  test("a maximum keeps the chat column 420 px wide beside the other pane as it is", () => {
    for (const width of [1100, 1280, 1440]) {
      const r = laptopColumn(width);
      expect(width - r.sidebar!.max - r.right!.now).toBeGreaterThanOrEqual(CHAT_KEEP);
      expect(width - r.sidebar!.now - r.right!.max).toBeGreaterThanOrEqual(CHAT_KEEP);
    }
    expect(laptopColumn(1100).sidebar!.max).toBe(360);
    expect(laptopColumn(1100).right!.max).toBe(432);
    expect(laptopColumn(2560).sidebar!.max).toBe(SIDEBAR_MAX);
    expect(laptopColumn(2560).right!.max).toBe(SIDE_MAX);
  });
  test("a chosen width shows as chosen, within its range", () => {
    const r = laptopColumn(1280, { sidebar: 300, side: 400 });
    expect([r.sidebar!.now, r.right!.now]).toEqual([300, 400]);
    expect(r.sidebar!.max).toBe(1280 - CHAT_KEEP - 400);
    expect(r.right!.max).toBe(1280 - CHAT_KEEP - 300);
  });
  test("in a smaller window chosen widths give way, the side pane's first, so the chat keeps 420 px", () => {
    const r = laptopColumn(1100, { sidebar: 480, side: 600 });
    expect(r.right!.now).toBe(SIDE_MIN);
    expect(r.sidebar!.now).toBe(1100 - CHAT_KEEP - SIDE_MIN);
    expect(1100 - r.sidebar!.now - r.right!.now).toBe(CHAT_KEEP);
    // A wide sidebar the user chose: the Terminal pane's default gives way to it, never the other way round.
    const def = terminalLayout({ size: "laptop", width: 1280 }).width;
    const t = paneRanges({ width: 1280, touch: false, sidebar: true, right: { pane: "term", def }, bar: false, widths: { sidebar: 480 } });
    expect([t.sidebar!.now, t.right!.now]).toEqual([480, 1280 - CHAT_KEEP - 480]);
  });
  test("the Terminal pane keeps its own width", () => {
    const def = terminalLayout({ size: "laptop", width: 1280 }).width;
    const r = paneRanges({ width: 1280, touch: false, sidebar: true, right: { pane: "term", def }, bar: false, widths: { side: 400, term: 560 } });
    expect(r.right!.now).toBe(560);
    expect(paneRanges({ width: 1280, touch: false, sidebar: true, right: { pane: "term", def }, bar: false, widths: { side: 400 } }).right!.now).toBe(def);
  });
  test("the tablet's docked pane (834 px, the pane bar beside it): 280 to 358 px, the default 320", () => {
    const r = paneRanges({ width: 834, touch: true, sidebar: false, right: { pane: "side", def: mediumPaneWidth(834) }, bar: true, widths: {} });
    expect(r.sidebar).toBeNull();
    expect(r.right).toEqual({ min: 280, max: 834 - 56 - CHAT_KEEP, def: 320, now: 320, reach: 834 - 56 - CHAT_KEEP });
    expect(resizable(r.right)).toBe(true);
  });
  test("a narrow tablet keeps the design's default; with no room the handle has no range", () => {
    const at768 = paneRanges({ width: 768, touch: true, sidebar: false, right: { pane: "side", def: mediumPaneWidth(768) }, bar: true, widths: {} }).right!;
    expect(at768).toEqual({ min: 280, max: 307, def: 307, now: 307, reach: 307 });
    const at700 = paneRanges({ width: 700, touch: true, sidebar: false, right: { pane: "side", def: mediumPaneWidth(700) }, bar: true, widths: {} }).right!;
    expect(resizable(at700)).toBe(false);
    expect(at700.now).toBe(mediumPaneWidth(700));
  });
  test("the arrows move by 16 px toward the pane's growing side; Home and End go to the ends; other keys do nothing", () => {
    const r: PaneRange = { min: 200, max: 360, def: 248, now: 248, reach: 360 };
    expect(keyWidth("ArrowRight", r, "right")).toBe(264);
    expect(keyWidth("ArrowLeft", r, "right")).toBe(232);
    expect(keyWidth("ArrowLeft", r, "left")).toBe(264);
    expect(keyWidth("ArrowRight", r, "left")).toBe(232);
    expect(keyWidth("Home", r, "right")).toBe(200);
    expect(keyWidth("End", r, "left")).toBe(360);
    expect(keyWidth("ArrowRight", { ...r, now: 352 }, "right")).toBe(360);
    expect(keyWidth("ArrowLeft", { ...r, now: 205 }, "right")).toBe(200);
    for (const k of ["a", "Enter", "ArrowUp", "Tab"]) expect([k, keyWidth(k, r, "right")]).toEqual([k, null]);
  });
  test("a drag moves the edge with the pointer, within the range, in whole pixels", () => {
    const r: PaneRange = { min: 280, max: 612, def: 320, now: 320, reach: 620 };
    expect(dragWidth(320, -60.4, r, "left")).toBe(380);
    expect(dragWidth(320, 60, r, "left")).toBe(280);
    expect(dragWidth(320, -1000, r, "left")).toBe(612);
    expect(dragWidth(248, 40, { min: 200, max: 480 }, "right")).toBe(288);
  });
  test("a pane that the other pane holds at its minimum keeps its handle: its range is one width, its reach more", () => {
    // 1280 px: the sidebar at its minimum and the side pane dragged to its largest; the sidebar can go no wider until
    // the side pane gives room, but a double-click can still put its default back.
    const r = laptopColumn(1280, { sidebar: SIDEBAR_MIN, side: 1280 - CHAT_KEEP - SIDEBAR_MIN });
    expect(r.sidebar).toEqual({ min: SIDEBAR_MIN, max: SIDEBAR_MIN, def: SIDEBAR_W, now: SIDEBAR_MIN, reach: 480 });
    expect(resizable(r.sidebar)).toBe(true);
    // 1100 px: the side pane at 280 beside the widest sidebar that leaves it room.
    const s = laptopColumn(1100, { sidebar: 1100 - CHAT_KEEP - SIDE_MIN });
    expect(s.right).toMatchObject({ min: SIDE_MIN, max: SIDE_MIN, now: SIDE_MIN });
    expect(resizable(s.right)).toBe(true);
    // No room even with the other pane at its narrowest (a 700 px tablet): no handle, as before.
    expect(resizable(paneRanges({ width: 700, touch: true, sidebar: false, right: { pane: "side", def: mediumPaneWidth(700) }, bar: true, widths: {} }).right)).toBe(false);
  });
  test("a double-click puts the default back, the other pane's chosen width giving the room it needs", () => {
    const at = (width: number, widths: PaneInput["widths"]): PaneInput => ({ width, touch: false, sidebar: true, right: { pane: "side", def: PANEL_W }, bar: false, widths });
    // The side pane's default beside the widest sidebar (1100 px): the sidebar gives 40 px, so the side pane is 320.
    const side = restoreDefault(at(1100, { sidebar: 400 }), "right");
    expect(side).toEqual({ sidebar: 1100 - CHAT_KEEP - PANEL_W });
    expect(paneRanges(at(1100, side)).right!.now).toBe(PANEL_W);
    // The sidebar's default beside the widest side pane (1280 px): the side pane gives way as a chosen width does.
    const sb = restoreDefault(at(1280, { sidebar: SIDEBAR_MIN, side: 620 }), "sidebar");
    expect(sb).toEqual({ side: 620 });
    expect([paneRanges(at(1280, sb)).sidebar!.now, paneRanges(at(1280, sb)).right!.now]).toEqual([SIDEBAR_W, 1280 - CHAT_KEEP - SIDEBAR_W]);
    // Where the default fits, only that pane's width goes; the Terminal pane's width is its own.
    expect(restoreDefault(at(1440, { sidebar: 300, side: 400, term: 600 }), "right")).toEqual({ sidebar: 300, term: 600 });
    expect(restoreDefault(at(1440, { sidebar: 300, side: 400 }), "sidebar")).toEqual({ side: 400 });
    // The sidebar never goes under its minimum to make room.
    expect(restoreDefault({ ...at(1100, { sidebar: 480 }), right: { pane: "term", def: 480 } }, "right")).toEqual({ sidebar: SIDEBAR_MIN });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The device's own: local storage, read defensively

describe("the stored widths and the sidebar's hidden state", () => {
  const kv = (value: unknown) => {
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    return { getItem: () => raw, setItem() {}, removeItem() {}, key: () => null, length: 1 };
  };
  test("by default: no width chosen, the sidebar shown", () => {
    expect(DEFAULT_VIEW).toEqual({ railHidden: false, sidebarHidden: false, widths: {} });
    expect(loadView(null)).toEqual(DEFAULT_VIEW);
  });
  test("a stored value comes back; anything else is left out", () => {
    expect(loadView(kv({ railHidden: true, sidebarHidden: true, widths: { sidebar: 300, side: 400.4, term: 600 } }))).toEqual({ railHidden: true, sidebarHidden: true, widths: { sidebar: 300, side: 400, term: 600 } });
    expect(loadView(kv({ sidebarHidden: "yes", widths: { sidebar: "300", side: 99999, term: Number.NaN, other: 5 } }))).toEqual(DEFAULT_VIEW);
    expect(loadView(kv("not json"))).toEqual(DEFAULT_VIEW);
    expect(loadView(kv({ widths: [300] }))).toEqual(DEFAULT_VIEW);
    expect(cleanWidths({ sidebar: SIDEBAR_MIN - 1, side: SIDE_MAX + 1 })).toEqual({});
    // A sidebar width kept before the minimum was 240 px reads as no choice (the default again).
    expect(loadView(kv({ widths: { sidebar: 200, side: 400 } })).widths).toEqual({ side: 400 });
    expect(cleanWidths({ sidebar: SIDEBAR_MAX, side: SIDE_MIN })).toEqual({ sidebar: SIDEBAR_MAX, side: SIDE_MIN });
  });
  test("never a URL: no route or link carries a width or the hidden state", () => {
    state({ sidebarHidden: true, widths: { sidebar: 300, side: 400 } });
    viewport(1280, 800, false);
    const html = shell(`/c/${CHAT}`);
    expect(html).not.toMatch(/href="[^"]*(width|hidden|sidebar|=300|=400)[^"]*"/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The layout with the sidebar hidden

describe("the layout with the sidebar hidden", () => {
  test("a laptop from 1,000 px: no sidebar column, and its room goes to the chat (the side panel docks at 1,040 px)", () => {
    expect(shellLayout({ size: "laptop", width: 1040 }, { sidebarHidden: true })).toEqual({ size: "laptop", sidebar: "hidden", side: "column", paneOver: false, paneBar: false });
    expect(shellLayout({ size: "laptop", width: 1040 })).toMatchObject({ sidebar: "docked", side: "pane", paneOver: true });
    expect(terminalLayout({ size: "laptop", width: 1040 }, { sidebarHidden: true }).form).toBe("column");
    expect(terminalLayout({ size: "laptop", width: 1040 }).form).toBe("over");
  });
  test("where the sidebar does not dock, hiding it changes nothing", () => {
    for (const [size, width] of [["laptop", 900], ["medium", 834], ["phone", 390]] as const) expect(shellLayout({ size, width }, { sidebarHidden: true })).toEqual(shellLayout({ size, width }));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Where Shell and the title bar draw them

describe("the handles in the shell", () => {
  afterEach(() => viewport(1280, 800, false));

  test("a laptop (1280 px): one separator on each inner edge, focusable, with its value and its range", () => {
    state();
    viewport(1280, 800, false);
    const html = shell(`/c/${CHAT}`);
    const [left, right] = separators(html);
    expect(separators(html).length).toBe(2);
    expect(left).toMatchObject({ "aria-orientation": "vertical", "aria-label": "Sidebar width", "aria-valuenow": "248", "aria-valuemin": "240", "aria-valuemax": "480", tabindex: "0", "aria-controls": "fd-sidebar", "data-testid": "pane-handle-sidebar" });
    expect(right).toMatchObject({ "aria-orientation": "vertical", "aria-label": "Side pane width", "aria-valuenow": "320", "aria-valuemin": "280", "aria-valuemax": "612", tabindex: "0", "aria-controls": "fd-side", "data-testid": "pane-handle-side" });
    expect(html).toContain('id="fd-sidebar"');
    expect(html).toContain('id="fd-side"');
  });

  test("one CSS variable per pane carries the width, and the grid reads it", () => {
    state({ widths: { sidebar: 300, side: 400 } });
    viewport(1280, 800, false);
    const html = shell(`/c/${CHAT}`);
    const style = shellStyle(html);
    expect(style).toContain("grid-template-columns:var(--sidebar-w) minmax(0, 1fr) var(--side-w)");
    expect(style).toContain("--sidebar-w:300px");
    expect(style).toContain("--side-w:400px");
    expect(separators(html).map((s) => s["aria-valuenow"])).toEqual(["300", "400"]);
  });

  test("each handle holds its own place in px, so a drag never reads an inherited variable", () => {
    state({ widths: { sidebar: 300, side: 400 } });
    viewport(1280, 800, false);
    expect(separators(shell(`/c/${CHAT}`)).map((s) => s.style)).toEqual(["left:300px", "right:400px"]);
    state();
    viewport(834, 1194, true);
    expect(separators(shell(`/c/${CHAT}/details`)).map((s) => s.style)).toEqual(["right:calc(320px + var(--pane-bar-w))"]);
  });

  test("the width variables are registered as not inherited, so a move restyles the shell, not the transcript (layout.css)", () => {
    const css = readFileSync(join(import.meta.dir, "..", "..", "web", "styles", "layout.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toMatch(/@property --sidebar-w \{\s*syntax: "<length>";\s*inherits: false;\s*initial-value: 248px;\s*\}/);
    expect(css).toMatch(/@property --side-w \{\s*syntax: "<length>";\s*inherits: false;\s*initial-value: 320px;\s*\}/);
    // Nothing under the shell reads them: only the shell's own columns (Shell.tsx) do.
    expect(css).not.toMatch(/var\(--(sidebar|side)-w\)/);
    // A drag's start and end mark the shell and the handle only: no rule restyles every element under the shell.
    expect(css).not.toMatch(/\[data-resizing\]\s*\*/);
    const handle = readFileSync(join(import.meta.dir, "..", "..", "web", "ui", "PaneHandle.tsx"), "utf8");
    expect(handle).toContain("host.current?.style.setProperty(cssVar, `${w}px`);");
    expect(handle).toContain("Object.assign(self.current.style, place(w));");
  });

  test("a pane held at its minimum by the other pane keeps its separator, with its one-width range", () => {
    state({ widths: { sidebar: SIDEBAR_MIN, side: 1280 - CHAT_KEEP - SIDEBAR_MIN } });
    viewport(1280, 800, false);
    const [left] = separators(shell(`/c/${CHAT}`));
    expect(left).toMatchObject({ "data-testid": "pane-handle-sidebar", "aria-valuenow": String(SIDEBAR_MIN), "aria-valuemin": String(SIDEBAR_MIN), "aria-valuemax": String(SIDEBAR_MIN), tabindex: "0" });
  });

  test("on touch the handle starts under the title bar and shows a grip on its edge; a laptop's has none", () => {
    state();
    viewport(834, 1194, true);
    const touch = shell(`/c/${CHAT}/details`);
    expect(touch).toMatch(/role="separator"[^>]*><span class="pane-grip" aria-hidden="true"><\/span><\/div>/);
    viewport(1280, 800, false);
    expect(shell(`/c/${CHAT}`)).not.toContain("pane-grip");
    const css = readFileSync(join(import.meta.dir, "..", "..", "web", "styles", "layout.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    // Under the title bar with its top safe area (a home-screen app, FIX-U6; 0 in a browser tab).
    expect(css).toMatch(/\.touch \.pane-handle \{[^}]*top: calc\(var\(--header-h\) \+ env\(safe-area-inset-top\)\);/);
    expect(css).toMatch(/\.pane-grip \{[^}]*width: 4px;[^}]*height: 32px;[^}]*background: var\(--hairline-strong\);/);
  });

  test("the Terminal column and the search pane take the same handle, the terminal at its own width", () => {
    state({ widths: { side: 400 } });
    viewport(1280, 800, false);
    const term = shell(`/c/${CHAT}/shell`);
    const def = terminalLayout({ size: "laptop", width: 1280 }).width;
    expect(separators(term).map((s) => s["data-testid"])).toEqual(["pane-handle-sidebar", "pane-handle-side"]);
    expect(separators(term)[1]!["aria-valuenow"]).toBe(String(def));
    expect(shellStyle(term)).toContain(`--side-w:${def}px`);
    const search = shell(`/c/${CHAT}/search`);
    expect(separators(search)[1]!["aria-valuenow"]).toBe("400");
  });

  test("the sidebar's Hide button sits at its top; hidden, the title bar holds Show", () => {
    state();
    viewport(1280, 800, false);
    const html = shell(`/c/${CHAT}`);
    expect(html).toMatch(/<nav class="sidebar[^"]*"[^>]*id="fd-sidebar"[^>]*><button[^>]*aria-label="Hide sidebar"/);
    expect(html).not.toContain(`aria-label="${SIDEBAR_SHOW}"`);
    state({ sidebarHidden: true });
    const hidden = shell(`/c/${CHAT}`);
    expect(hidden).toContain('data-sidebar="hidden"');
    expect(hidden).not.toContain('data-testid="sidebar"');
    expect(hidden).not.toContain(`aria-label="${SIDEBAR_HIDE}"`);
    expect(hidden).toMatch(/<header class="topbar scr-bar"[^>]*><button[^>]*aria-label="Show sidebar"[^>]*data-testid="sidebar-show"/);
    expect(separators(hidden).map((s) => s["data-testid"])).toEqual(["pane-handle-side"]);
    expect(shellStyle(hidden)).toContain("grid-template-columns:minmax(0, 1fr) var(--side-w)");
  });

  test("a large touch tablet (1366 x 1024): Show sidebar shows its name, as the rail's toggle does; a laptop's is an icon with a tooltip", () => {
    state({ sidebarHidden: true });
    viewport(1366, 1024, true);
    const bar = shell(`/c/${CHAT}`);
    const show = /<button[^>]*data-testid="sidebar-show"[^>]*>[\s\S]*?<\/button>/.exec(bar)?.[0] ?? "";
    expect(show).toContain(`<span>${SIDEBAR_SHOW}</span>`);
    expect(show).not.toContain("aria-label=");
    expect(show).not.toContain("title=");
    expect(renderToStaticMarkup(createElement(TopBar, { route: at("/settings") }))).toContain(`<span>${SIDEBAR_SHOW}</span>`);
    viewport(1280, 800, false);
    const laptop = /<button[^>]*data-testid="sidebar-show"[^>]*>[\s\S]*?<\/button>/.exec(shell(`/c/${CHAT}`))?.[0] ?? "";
    expect(laptop).toContain(`aria-label="${SIDEBAR_SHOW}"`);
    expect(laptop).toContain(`title="${SIDEBAR_SHOW}"`);
    expect(laptop).not.toContain("<span>");
  });

  test("a screen with no chat: Show in its bar while the sidebar is hidden, and no Chats button beside it", () => {
    state({ sidebarHidden: true });
    viewport(1280, 800, false);
    const home = renderToStaticMarkup(createElement(TopBar, { route: at("/") }));
    expect(home).toContain(`aria-label="${SIDEBAR_SHOW}"`);
    expect(home).not.toContain('aria-label="Chats"');
    state();
    expect(renderToStaticMarkup(createElement(TopBar, { route: at("/") }))).not.toContain(`aria-label="${SIDEBAR_SHOW}"`);
  });

  test("the session rail hidden: no side handle; a pane over the chat (1,040 px) has none either", () => {
    state({ railHidden: true });
    viewport(1280, 800, false);
    expect(separators(shell(`/c/${CHAT}`)).map((s) => s["data-testid"])).toEqual(["pane-handle-sidebar"]);
    state();
    viewport(1040, 800, false);
    const over = shell(`/c/${CHAT}/details`);
    expect(over).toContain('data-side="over"');
    expect(separators(over).map((s) => s["data-testid"])).toEqual(["pane-handle-sidebar"]);
  });

  test("the tablet (834 x 1194, touch): the docked pane's handle, none with no pane open and none for the drawer's list", () => {
    state();
    viewport(834, 1194, true);
    const html = shell(`/c/${CHAT}/details`);
    expect(separators(html).map((s) => [s["data-testid"], s["aria-valuenow"], s["aria-valuemin"], s["aria-valuemax"]])).toEqual([["pane-handle-side", "320", "280", String(834 - 56 - CHAT_KEEP)]]);
    expect(shellStyle(html)).toContain("grid-template-columns:minmax(0, 1fr) var(--side-w) var(--pane-bar-w)");
    expect(separators(shell(`/c/${CHAT}`))).toEqual([]);
    expect(separators(shell(`/c/${CHAT}/shell`)).map((s) => s["data-testid"])).toEqual(["pane-handle-side"]);
    expect(html).not.toContain(`aria-label="${SIDEBAR_HIDE}"`);
  });

  test("the phone is unchanged: no handle, no Hide or Show, no width variable", () => {
    state({ sidebarHidden: true, widths: { sidebar: 300, side: 400 } });
    viewport(390, 844, true);
    for (const path of [`/c/${CHAT}`, `/c/${CHAT}/details`, `/c/${CHAT}/search`, `/c/${CHAT}/shell`]) {
      const html = shell(path);
      expect([path, separators(html).length]).toEqual([path, 0]);
      expect(html).toContain('data-sidebar="screen"');
      expect(html).not.toContain("--side-w");
      expect(html).not.toContain(SIDEBAR_SHOW);
      expect(html).not.toContain(SIDEBAR_HIDE);
    }
  });
});
