// U4 (FIX-U4 section 2, DESIGN-U4): the split side panel as the shell draws it. On a laptop's column and the tablet's
// docked pane a URL with a pair shows two halves, one above the other, the Terminal always below, with one divider
// between them in the DOM: a focusable horizontal separator named "<upper half> height", its value the upper half's
// height in px within 200 px (240 on touch) of each end, controlling the upper half. Each view keeps its own region
// name. The title bar's tools and the pane bar light every kind a half shows, and a press on a lit one closes its half;
// the session rail toggle closes a Details or Files half, or brings the cards in above a Terminal, a search pane or a
// side chat. Over the chat (1,000 to 1,087 px with the sidebar docked) and on the phone the URL's own view shows alone,
// with no divider. Close focused pane is Cmd backslash on macOS and Ctrl backslash elsewhere, and the terminal passes
// it to the page on macOS only (off macOS Ctrl backslash is the shell's quit key).
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parse, type Route } from "../../web/router";
import { resetState } from "../../web/state/store";
import { DEFAULT_VIEW } from "../../web/state/catalog";
import type { Chat, ViewPrefs } from "../../web/state/types";
import { Shell } from "../../web/layout/Shell";
import { TopBar } from "../../web/layout/TopBar";
import { SidePanel } from "../../web/panels/SidePanel";
import { terminalToggleTarget } from "../../web/terminal/route";
import { isCloseFocusedPane } from "../../web/terminal/keys";
import { IS_MAC, shortcutFor } from "../../web/ui/shortcuts";
import { SHORTCUTS, paneKeyNote } from "../../web/screens/Settings";
import { CHATS, PROJECTS } from "./fixtures";

const CHAT = "demoolxxxxxxxxxxxxxx";
const WEB = join(import.meta.dir, "..", "..", "web");
const FILE = "src/upload.ts";
const at = (u: string): Route => parse(new URL(u, "http://127.0.0.1"));
const P = (rest: string) => `/c/${CHAT}/${rest}`;

const gm = globalThis as unknown as { matchMedia?: unknown; window?: unknown };
const own = { mm: !gm.matchMedia, win: !gm.window };
let coarse = false;
function viewport(width: number, height: number, touch: boolean) {
  coarse = touch;
  gm.window = { innerWidth: width, innerHeight: height, addEventListener() {}, removeEventListener() {} };
}
beforeAll(() => {
  gm.matchMedia = (q: string) => ({ matches: coarse && q === "(pointer: coarse)", addEventListener() {}, removeEventListener() {} });
});
afterAll(() => {
  if (own.mm) delete gm.matchMedia;
  if (own.win) delete gm.window;
  resetState();
});

function state(view: Partial<ViewPrefs> = {}) {
  resetState({ projects: structuredClone(PROJECTS), chats: structuredClone(CHATS), ready: true, sideQuestions: true, view: { ...DEFAULT_VIEW, ...view } });
}
const chatOf = (): Chat => CHATS.find((c) => c.id === CHAT)!;
/** The shell with the real side panel, so each half's own markup shows. */
const shell = (path: string) =>
  renderToStaticMarkup(
    createElement(Shell, {
      route: at(path),
      chat: chatOf(),
      side: (mode, r = at(path), reads = true) => createElement(SidePanel, { chat: chatOf(), route: r, mode, reads }),
      children: createElement("div", { className: "chat-screen" }),
    }),
  );
/** The horizontal separators, each as its attributes. */
const dividers = (html: string) =>
  [...html.matchAll(/<div[^>]*role="separator"[^>]*>/g)]
    .map((m) => Object.fromEntries([...m[0].matchAll(/([a-z-]+)="([^"]*)"/g)].map((a) => [a[1]!, a[2]!])))
    .filter((a) => a["aria-orientation"] === "horizontal");
/** The halves in DOM order: their place and kind, and the divider between them. */
const order = (html: string) => [...html.matchAll(/data-half="(upper|lower)" data-kind="([a-z]+)"|data-testid="split-divider"/g)].map((m) => (m[1] ? `${m[1]} ${m[2]}` : "divider"));

beforeEach(() => {
  viewport(1280, 800, false);
  state();
});

describe("a laptop (1280 x 800): two halves in the column, the Terminal below", () => {
  test("a file above the Terminal: the halves and the divider between them, in the DOM's order", () => {
    const html = shell(P(`files/${FILE}?below=shell`));
    expect(html).toMatch(/<aside id="fd-side" class="side-col split" style="--split-top:400px;grid-template-rows:var\(--split-top\) minmax\(0, 1fr\)">/);
    expect(order(html)).toEqual(["upper files", "divider", "lower terminal"]);
    expect(html).toContain('data-view="file"');
    expect(html).toContain('data-testid="terminal-pane"');
    expect(html).toContain('data-split="two"');
  });
  test("the divider: a focusable horizontal separator named for the upper half, with its value and its range", () => {
    const [d] = dividers(shell(P(`files/${FILE}?below=shell`)));
    expect(d).toMatchObject({ "aria-label": "Files height", "aria-controls": "fd-split-upper", "aria-valuenow": "400", "aria-valuemin": "200", "aria-valuemax": "600", tabindex: "0", class: "split-divider", style: "top:396px" });
    expect(dividers(shell(P("search?q=upl&below=shell")))[0]!["aria-label"]).toBe("Search height");
    expect(dividers(shell(P("shell?above=outputs")))[0]!["aria-label"]).toBe("Outputs height");
    expect(dividers(shell(P("context?below=btw")))[0]!["aria-label"]).toBe("Context height");
    // A laptop's divider has no grip; the seam and the focus line are its look.
    expect(shell(P(`files/${FILE}?below=shell`))).not.toContain("split-grip");
  });
  test("each half keeps its own region name", () => {
    const html = shell(P("search?q=upl&below=shell"));
    expect(html).toMatch(/role="search" aria-label="Search"/);
    expect(html).toMatch(/<section class="term-pane term-mode-column"[^>]*aria-label="Terminal"/);
    const side = shell(P("context?below=btw"));
    expect(side).toMatch(/role="region" aria-label="Context"/);
    expect(side).toMatch(/role="region" aria-label="Side chat"/);
  });
  test("the column keeps the Terminal's width while it is a half, else the side pane's: the chat keeps 520 px", () => {
    expect(shell(P(`files/${FILE}?below=shell`))).toContain("--side-w:512px");
    expect(shell(P("context?below=btw"))).toContain("--side-w:320px");
  });
  test("the device's divider place: its share of the column, within the limits", () => {
    state({ split: 0.3 });
    expect(dividers(shell(P(`files/${FILE}?below=shell`)))[0]!["aria-valuenow"]).toBe("240");
    state({ split: 0.05 });
    expect(dividers(shell(P(`files/${FILE}?below=shell`)))[0]!["aria-valuenow"]).toBe("200");
  });
  test("a Details or Files view in a half keeps the column's form: no head of its own, its back row its head", () => {
    const html = shell(P(`files/${FILE}?below=shell`));
    expect(html).toContain('class="side-panel side-mode-column"');
    expect(html).not.toContain("side-pane-head");
  });
  test("a half's back row goes back in its own place; with its target's kind in the other half, the target alone", () => {
    const backs = (u: string) => [...shell(u).matchAll(/<a href="([^"]*)" class="side-back[^"]*" aria-label="([^"]*)"/g)].map((m) => `${m[2]}: ${m[1]!.replace(/&amp;/g, "&")}`);
    expect(backs(P("details?below=uploads"))).toEqual([`Back to Details from Uploads: /c/${CHAT}/details`]);
    expect(backs(P("context?above=uploads"))).toEqual([`Back to Details from Uploads: /c/${CHAT}/details`, `Back to Details from Context: /c/${CHAT}/details?above=uploads`]);
    expect(backs(P(`details?below=files/${FILE}`))).toEqual([`Back to Outputs: /c/${CHAT}/outputs`]);
    expect(backs(P(`files/${FILE}?below=shell`))).toEqual([`Back to Outputs: /c/${CHAT}/outputs?below=shell`]);
  });
  test("a window too short for two halves folds the half not used last to its head, with no divider", () => {
    viewport(1280, 380, false);
    const html = shell(P(`files/${FILE}?below=shell`));
    expect(dividers(html)).toEqual([]);
    expect(html).toContain('data-split="folded-lower"');
    expect(html).toMatch(/class="split-half split-lower is-folded"/);
    expect(html).toContain("grid-template-rows:minmax(0, 1fr) calc(var(--header-h) + 1px)");
  });
  test("a folded Details or Files half (no head of its own on a laptop) shows a one-row head with its name, not a link", () => {
    viewport(1280, 380, false);
    const fold = (u: string) => [...shell(u).matchAll(/class="split-half split-(upper|lower) is-folded"[^>]*><div class="split-fold-head" aria-hidden="true">([^<]*)<\/div>/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(fold(P(`shell?above=files/${FILE}`))).toEqual(["upper upload.ts"]);
    expect(fold(P("shell?above=details"))).toEqual(["upper Details"]);
    expect(fold(P("btw?above=outputs"))).toEqual(["upper Outputs"]);
    expect(fold(P("uploads?above=context"))).toEqual(["upper Context"]);
    // The Terminal, the search pane and the side chat fold to their own heads.
    for (const u of [P(`files/${FILE}?below=shell`), P("context?below=btw"), P("outputs?below=search")]) expect([u, fold(u), shell(u).includes("split-fold-head")]).toEqual([u, [], false]);
    // Not folded: no such head.
    viewport(1280, 800, false);
    expect(shell(P(`shell?above=files/${FILE}`))).not.toContain("split-fold-head");
  });
  test("one view: no divider, the view as before", () => {
    for (const u of [P("shell"), P("outputs"), P("search"), `/c/${CHAT}`]) expect([u, dividers(shell(u))]).toEqual([u, []]);
    expect(shell(P("shell"))).toContain('class="side-col term-col"');
    expect(shell(P("search"))).toContain('class="side-col srch-col"');
    // A refused pair shows the URL's own view alone.
    expect(order(shell(P("context?below=outputs")))).toEqual([]);
  });
  test("the Terminal's half: Copy the command keeps the view above it under the copy dialog, Close closes the half", () => {
    const html = shell(P(`files/${FILE}?below=shell`));
    expect(html).toContain(`href="/c/${CHAT}/terminal?above=files/src/upload.ts" class="btn ghost term-copy"`);
    expect(shell(P("shell?above=outputs"))).toContain(`href="/c/${CHAT}/terminal?above=outputs" class="btn ghost term-copy"`);
    // Alone, as before.
    expect(shell(P("shell"))).toContain(`href="/c/${CHAT}/terminal" class="btn ghost term-copy"`);
  });
  test("both halves side panel views: one of them reads the cards' facts", () => {
    const src = readFileSync(join(WEB, "layout", "Shell.tsx"), "utf8");
    expect(src).toContain("panel!(mode, v.route, v === reader)");
    expect(readFileSync(join(WEB, "panels", "SidePanel.tsx"), "utf8")).toContain("usePanelReads(chat, reads);");
  });
});

describe("the title bar and the session rail toggle", () => {
  const bar = (u: string) => renderToStaticMarkup(createElement(Shell, { route: at(u), chat: chatOf(), side: () => null, children: null }));
  test("both tools light for the halves they show; a press closes that half", () => {
    const html = bar(P("context?below=btw"));
    expect(html).toMatch(new RegExp(`href="/c/${CHAT}/context"[^>]*class="icon-btn scr-bar-icon on"[^>]*aria-label="Close side chat"`));
    expect(html).toMatch(new RegExp(`href="/c/${CHAT}/shell\\?type=resume&amp;above=context"[^>]*aria-label="Open in terminal"`));
    const t = bar(P(`files/${FILE}?below=shell`));
    expect(t).toMatch(new RegExp(`href="/c/${CHAT}/files/src/upload.ts"[^>]*class="icon-btn scr-bar-icon on"[^>]*aria-label="Close terminal"`));
  });
  test("a Details or Files half: Hide session rail (it closes that half)", () => {
    expect(bar(P(`files/${FILE}?below=shell`))).toContain('aria-label="Hide session rail"');
    expect(bar(P("shell?above=details"))).toContain('aria-label="Hide session rail"');
  });
  test("the Terminal, the search pane or the side chat alone or as a pair: Show session rail (the cards come in)", () => {
    for (const u of [P("shell"), P("search"), P("btw"), P("search?below=shell"), P("btw?below=shell")]) expect([u, bar(u).includes('aria-label="Show session rail"')]).toEqual([u, true]);
  });
  test("the cards at rest at /c/<chat>/details (the session rail shown): the title bar's tools open alone, as from /c/<chat>", () => {
    for (const u of [`/c/${CHAT}`, P("details")]) {
      const html = bar(u);
      expect([u, new RegExp(`href="/c/${CHAT}/shell\\?type=resume"[^>]*aria-label="Open in terminal"`).test(html)]).toEqual([u, true]);
      expect([u, new RegExp(`href="/c/${CHAT}/btw"[^>]*aria-label="Side chat"`).test(html)]).toEqual([u, true]);
    }
    // With the session rail hidden, /c/<chat>/details is a view of its own: the Terminal opens below it.
    state({ railHidden: true });
    expect(bar(P("details"))).toMatch(new RegExp(`href="/c/${CHAT}/shell\\?type=resume&amp;above=details"[^>]*aria-label="Open in terminal"`));
  });
  test("at rest, as before: the cards, or one side panel view alone", () => {
    expect(bar(`/c/${CHAT}`)).toContain('aria-label="Hide session rail"');
    expect(bar(P("outputs"))).toContain('aria-label="Hide session rail"');
    state({ railHidden: true });
    expect(bar(`/c/${CHAT}`)).toContain('aria-label="Show session rail"');
  });
  test("the folder shows in the title bar only while nothing shows beside the chat (M3)", () => {
    state({ railHidden: true });
    const folder = PROJECTS.find((p) => p.id === chatOf().projectId)!.folder;
    expect(bar(`/c/${CHAT}`)).toContain(folder);
    expect(bar(P("shell"))).not.toContain(`>${folder}<`);
  });
});

describe("the tablet (1194 x 834, touch): the pair in the docked pane", () => {
  beforeEach(() => viewport(1194, 834, true));
  test("two halves, the grip on the divider, both kinds lit in the pane bar", () => {
    const html = shell(P(`files/${FILE}?below=shell`));
    expect(html).toContain('class="side-pane split"');
    expect(order(html)).toEqual(["upper files", "divider", "lower terminal"]);
    const [d] = dividers(html);
    expect(d).toMatchObject({ "aria-label": "Files height", "aria-valuenow": "417", "aria-valuemin": "240", "aria-valuemax": "594", style: "top:401px" });
    expect(html).toContain('<span class="split-grip" aria-hidden="true"></span>');
    const lit = [...html.matchAll(/class="pane-bar-btn on"[^>]*title="([^"]+)"/g)].map((m) => m[1]);
    expect(lit).toEqual(["Close Files", "Close Terminal"]);
    expect(html).toMatch(new RegExp(`href="/c/${CHAT}/shell"[^>]*class="pane-bar-btn on"[^>]*title="Close Files"`));
    expect(html).toMatch(new RegExp(`href="/c/${CHAT}/search\\?below=shell"[^>]*class="pane-bar-btn"[^>]*title="Search"`));
  });
  test("in a half, a side panel view's head that would hold only Close is left out (its lit pane bar button closes it)", () => {
    for (const u of [P(`files/${FILE}?below=shell`), P("details?below=shell"), P("uploads?below=btw"), P("shell?above=uploads")]) expect([u, shell(u).includes("side-pane-head"), shell(u).includes('class="side-panel side-mode-pane side-no-head"')]).toEqual([u, false, true]);
    // In the upper half the top safe area that the head held is the view's own top padding (a home-screen app).
    expect(readFileSync(join(WEB, "styles", "layout.css"), "utf8")).toMatch(/\.shell-medium \.side-pane\.split > \.split-upper > \.side-no-head \{\s*padding-top: env\(safe-area-inset-top\);\s*\}/);
    // A head with a back row stays, with its Close.
    expect(shell(P("context?below=shell"))).toMatch(/<div class="side-pane-head"><a href="[^"]*" class="side-back" aria-label="Back to Details from Context">[\s\S]*?aria-label="Close Context"/);
    // One view keeps its head, as before.
    expect(shell(P("uploads"))).toMatch(/<div class="side-pane-head">[\s\S]*?aria-label="Close Uploads"/);
    expect(shell(P(`files/${FILE}`))).toMatch(/<div class="side-pane-head">[\s\S]*?aria-label="Close Files"/);
  });
  test("portrait (834 x 1194): the same, the halves 597 px", () => {
    viewport(834, 1194, true);
    expect(dividers(shell(P(`files/${FILE}?below=shell`)))[0]!["aria-valuenow"]).toBe("597");
  });
});

describe("over the chat and on the phone: the URL's own view alone", () => {
  test("1,050 x 800 with the sidebar docked: the path's view over the chat, it alone lit", () => {
    viewport(1050, 800, false);
    const html = shell(P(`files/${FILE}?below=shell`));
    expect(html).toContain('data-side="over"');
    expect(dividers(html)).toEqual([]);
    expect(html).not.toContain('data-testid="terminal-pane"');
    const lit = [...html.matchAll(/class="pane-bar-btn on"[^>]*title="([^"]+)"/g)].map((m) => m[1]);
    expect(lit).toEqual(["Close Files"]);
    // An opener there replaces the view and makes no pair.
    expect(html).toMatch(new RegExp(`href="/c/${CHAT}/search"[^>]*class="pane-bar-btn"`));
  });
  test("390 x 844 (touch): no split, no divider; the path's view in its phone form", () => {
    viewport(390, 844, true);
    const side = () => createElement("div", { "data-testid": "side-sheet" });
    for (const u of [P(`files/${FILE}?below=shell`), P("shell?above=outputs"), P("search?q=upl&below=shell")]) {
      const html = renderToStaticMarkup(createElement(Shell, { route: at(u), chat: chatOf(), side, children: createElement("div", { className: "chat-screen" }) }));
      expect([u, dividers(html), html.includes("split-half"), html.includes("fd-side")]).toEqual([u, [], false, false]);
    }
    const term = renderToStaticMarkup(createElement(Shell, { route: at(P("shell?above=outputs")), chat: chatOf(), side, children: null }));
    expect(term).toContain('data-terminal="page"');
    expect(term).not.toContain('data-testid="side-sheet"');
  });
});

describe("the keys", () => {
  test("Ctrl+backtick in a pair closes the Terminal's half, and opens it below one view", () => {
    expect(terminalToggleTarget(at(P(`files/${FILE}?below=shell`)), CHAT, true)).toEqual({ to: P(`files/${FILE}`), close: true });
    expect(terminalToggleTarget(at(P("shell?type=resume&above=outputs")), CHAT, true)).toEqual({ to: P("outputs"), close: true });
    expect(terminalToggleTarget(at(P("outputs")), CHAT, true)).toEqual({ to: P("shell?above=outputs"), close: false });
    expect(terminalToggleTarget(at(`/c/${CHAT}`), CHAT, true)).toEqual({ to: P("shell"), close: false });
    // Where the split does not show, as before.
    expect(terminalToggleTarget(at(P("outputs")), CHAT, false)).toEqual({ to: P("shell"), close: false });
  });
  test("Close focused pane: Cmd backslash on macOS, Ctrl backslash elsewhere, with no other modifier", () => {
    const k = (e: Partial<KeyboardEvent>) => ({ key: "\\", code: "Backslash", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...e });
    expect(shortcutFor(k({ metaKey: true }), true)).toBe("pane");
    expect(shortcutFor(k({ ctrlKey: true }), false)).toBe("pane");
    expect(shortcutFor(k({ ctrlKey: true }), true)).toBeNull();
    expect(shortcutFor(k({ metaKey: true }), false)).toBeNull();
    expect(shortcutFor(k({ metaKey: true, shiftKey: true }), true)).toBeNull();
    expect(shortcutFor(k({ metaKey: true, altKey: true }), true)).toBeNull();
    expect(isCloseFocusedPane(k({ metaKey: true }), true)).toBe(true);
    expect(isCloseFocusedPane(k({ ctrlKey: true }), false)).toBe(true);
    // A layout that types the backslash on another key still has it.
    expect(isCloseFocusedPane(k({ metaKey: true, code: "IntlBackslash" }), true)).toBe(true);
  });
  test("the terminal passes Cmd backslash to the page on macOS only; off macOS Ctrl backslash stays the shell's", () => {
    const xterm = readFileSync(join(WEB, "terminal", "xterm.ts"), "utf8");
    expect(xterm).toMatch(/if \(isTerminalToggle\(e\)\) return false;\n\s*\/\/[^\n]*\n(\s*\/\/[^\n]*\n)*\s*if \(IS_MAC_KEYS && isCloseFocusedPane\(e, true\)\) return false;/);
    const shortcuts = readFileSync(join(WEB, "ui", "shortcuts.ts"), "utf8");
    expect(shortcuts).toContain('if (want === "pane" && !paneKeyHere(e)) return;');
  });
  test("Settings lists Close focused pane between Toggle terminal pane and Open side chat (Desktop's order)", () => {
    const words = SHORTCUTS.map((s) => s.words);
    expect(words.slice(words.indexOf("Toggle terminal pane"), words.indexOf("Open side chat") + 1)).toEqual(["Toggle terminal pane", "Close focused pane", "Open side chat"]);
    expect(SHORTCUTS.find((s) => s.words === "Close focused pane")!.keys).toEqual([["Cmd", "\\"]]);
  });
  test("off macOS its row says where it acts: inside the terminal Ctrl backslash is the shell's quit key; on macOS no note", () => {
    expect(paneKeyNote(false)).toBe("Outside the terminal pane");
    expect(paneKeyNote(true)).toBeUndefined();
    // This platform's row (the tests run off macOS) carries the note, drawn as the other rows' notes are.
    expect(SHORTCUTS.find((s) => s.words === "Close focused pane")!.note).toBe(IS_MAC ? undefined : "Outside the terminal pane");
    expect(SHORTCUTS.find((s) => s.words === "Toggle terminal pane")!.note).toBeUndefined();
  });
});

describe("the look (layout.css): tokens only, no new motion", () => {
  const css = readFileSync(join(WEB, "styles", "layout.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  test("the upper half's height is a registered, not inherited variable that only the column reads", () => {
    expect(css).toMatch(/@property --split-top \{\s*syntax: "<length>";\s*inherits: false;\s*initial-value: 0px;\s*\}/);
    expect(css.match(/var\(--split-top\)/g) ?? []).toEqual([]);
  });
  test("the seam is the lower half's hairline; hover, focus and a drag light the divider's line; the grip on touch", () => {
    expect(css).toMatch(/\.split > \.split-lower \{[^}]*border-top: 1px solid var\(--hairline\);/);
    expect(css).toMatch(/\.split-divider:hover::after \{\s*background: var\(--hairline-strong\);/);
    expect(css).toMatch(/\.split-divider:focus-visible::after,\s*\.split-divider\[data-dragging\]::after \{\s*background: var\(--ring\);/);
    expect(css).toMatch(/\.split-grip \{[^}]*width: 32px;[^}]*height: 4px;[^}]*border-radius: var\(--r-pill\);[^}]*background: var\(--hairline-strong\);/);
    expect(css).toMatch(/\.split-divider \{[^}]*height: 8px;[^}]*cursor: row-resize;/);
    expect(css).toMatch(/\.touch \.split-divider \{\s*height: 20px;/);
  });
  test("one view's half is no box of its own (the view lays out as before)", () => {
    expect(css).toMatch(/\.split-half \{\s*display: contents;\s*\}/);
  });
  test("no motion of its own: no animation or transition on the halves or the divider", () => {
    const split = [...css.matchAll(/(\.split[^{]*)\{([^}]*)\}/g)].map((m) => m[2]!);
    for (const body of split) expect(body).not.toMatch(/animation|transition/);
  });
});
