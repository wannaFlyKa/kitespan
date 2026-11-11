// The browser pane as it draws (DESIGN-B1 4, 7.3), with React's server renderer and the pane's state set by frames as
// the server sends them: where Shell puts it at each size by the dock rule (D-13: docked at 420 px or more, else over
// the chat; the phone's page with Back "Chat" and "Browser"), its parts' names and roles (4.18: the tab list with each
// Close beside its tab, the bar, the address field, the frame as an application with its description, More as a
// popover), the browser's states and their words (4.13), the dialog card's focus rule and its 500 ms guard (F10), the
// file cards' words (F15), the hidden field's hints from a focus frame (F6), the links rule (PA-14), the needs-you dot's
// rule (F20), the title bar's and the pane bar's Browser buttons, and Settings > Browser's words.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BrowserHostView, BrowserTabView } from "../../shared/browser";
import { parse } from "../../web/router";
import { resetState } from "../../web/state/store";
import { Shell } from "../../web/layout/Shell";
import { TopBar } from "../../web/layout/TopBar";
import { configureBrowser, receive, resetBrowser } from "../../web/browser/store";
import { HostState, hostWords } from "../../web/browser/states";
import { DIALOG_GUARD_MS, dialogButtons, dialogFocus, dialogText, dialogTitle, guardOver } from "../../web/browser/DialogCard";
import { fileIsClaudes, filePlain, fileTitle, fileWhere, FILE_LINES } from "../../web/browser/fileWords";
import { echoOf, fieldHints } from "../../web/browser/Keyboard";
import { More, sizeNote } from "../../web/browser/More";
import { linkAction, LINK_WORDS } from "../../web/browser/links";
import { markChatLink } from "../../web/browser/nav";
import { stripTabs, TabRows } from "../../web/browser/TabStrip";
import { SectionBody } from "../../web/screens/Settings";
import { needsYou, NEEDS_WORDS } from "../../web/browser/dot";
import { browserRowValue, BROWSER_SETTING_WORDS } from "../../web/settings/Browser";
import { frameDescription, pasteText } from "../../web/browser/Stage";
import { IS_MAC } from "../../web/ui/shortcuts";
import { pickerName, pickerShows } from "../../web/browser/Pickers";
import { CHATS, PROJECTS } from "./fixtures";

const CHAT = "demoolxxxxxxxxxxxxxx";
const TAB = "q2x4abk3m7";
const TAB2 = "m7q2x4abk3";
const at = (u: string) => parse(new URL(u, "http://127.0.0.1"));
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const gm = globalThis as unknown as { matchMedia?: unknown; window?: unknown; localStorage?: unknown };
const own = { mm: !gm.matchMedia, win: !gm.window, ls: !gm.localStorage };
let coarse = false;
function viewport(width: number, height: number, touch: boolean) {
  coarse = touch;
  gm.window = { innerWidth: width, innerHeight: height, addEventListener() {}, removeEventListener() {} };
}
const store = new Map<string, string>();
beforeAll(() => {
  gm.matchMedia = (q: string) => ({ matches: coarse && q === "(pointer: coarse)", addEventListener() {}, removeEventListener() {} });
  gm.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
});
afterAll(() => {
  if (own.mm) delete gm.matchMedia;
  if (own.win) delete gm.window;
  if (own.ls) delete gm.localStorage;
  resetState();
  resetBrowser();
});

const tab = (id: string, extra: Partial<BrowserTabView> = {}): BrowserTabView => ({
  id,
  url: "http://localhost:3000/book",
  title: "Ridgeway Trails: book a walk",
  loading: false,
  canBack: true,
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
const RUNNING: BrowserHostView = { state: "running", how: "started", version: "154.0.8037.57", port: 9340 };
function open(host: BrowserHostView = RUNNING, tabs: BrowserTabView[] = [tab(TAB), tab(TAB2, { title: "Pull request 214", url: "https://git.example.com/pull/214" })]) {
  configureBrowser(null);
  receive({ t: "opened", host, tabs, acting: [], downloads: [] });
}
function shell(url: string) {
  const route = at(url);
  const chat = CHATS.find((c) => c.id === CHAT)!;
  return renderToStaticMarkup(createElement(Shell, { route, chat, side: () => null, children: createElement("div", { "data-testid": "chat" }) }));
}
beforeEach(() => {
  store.clear();
  resetState({ projects: structuredClone(PROJECTS), chats: CHATS.map((c) => ({ ...c })), net: "open", ready: true });
  viewport(1280, 800, false);
  open();
});

describe("where it shows (DESIGN-B1 4.1, D-13)", () => {
  test("1280 x 800: docked in the side column at 512 px", () => {
    const html = shell(`/c/${CHAT}/browser/${TAB}`);
    expect(html).toContain('data-browser="docked"');
    expect(html).toContain("--side-w:512px");
    expect(html).toMatch(/class="side-col bp-col"/);
    expect(html).toContain('aria-label="Browser"');
  });
  test("1100 x 800: over the chat at 550 px, with Close browser", () => {
    viewport(1100, 800, false);
    const html = shell(`/c/${CHAT}/browser/${TAB}`);
    expect(html).toContain('data-browser="over"');
    expect(html).toContain("width:min(550px, calc(100% - 0px))");
    expect(html).toContain('aria-label="Close browser"');
  });
  test("1194 x 834 touch: docked at 618 beside the pane bar, whose Browser button is lit", () => {
    viewport(1194, 834, true);
    const html = shell(`/c/${CHAT}/browser/${TAB}`);
    expect(html).toContain('data-browser="docked"');
    expect(html).toContain("--side-w:618px");
    expect(html).toMatch(/class="pane-bar-btn on"[^>]*aria-current="page"[^>]*title="Close browser"/);
  });
  test("834 x 1194 touch: over the chat at the whole width beside the pane bar", () => {
    viewport(834, 1194, true);
    const html = shell(`/c/${CHAT}/browser/${TAB}`);
    expect(html).toContain('data-browser="over"');
    expect(html).toContain("width:min(778px, calc(100% - var(--pane-bar-w)))");
  });
  test("390 x 844: the phone's own page over the chat, with Back Chat and Browser in the title bar", () => {
    viewport(390, 844, true);
    const html = shell(`/c/${CHAT}/browser/${TAB}`);
    expect(html).toContain('data-browser="page"');
    expect(text(html)).toContain("Chat Browser");
    // The phone has no strip: the foot's Tabs button opens the sheet.
    expect(html).not.toContain('role="tablist"');
    expect(html).toContain('aria-label="Tabs, 2 open"');
  });
  test("in a pair with the Terminal: the Browser above, the column at the Browser's rule", () => {
    const html = shell(`/c/${CHAT}/browser/${TAB}?below=shell`);
    expect(html).toContain('data-split="two"');
    expect(html).toContain('data-kind="browser"');
    expect(html).toContain("--side-w:512px");
  });
  test("over the chat, a pair shows the URL's own view alone", () => {
    viewport(1100, 800, false);
    const html = shell(`/c/${CHAT}/browser/${TAB}?below=shell`);
    expect(html).not.toContain('data-split="two"');
    expect(html).toContain('data-browser="over"');
  });
});

describe("its parts' names and roles (DESIGN-B1 4.18)", () => {
  const html = () => shell(`/c/${CHAT}/browser/${TAB}`);
  test("the tab list: each tab a tab, its Close a button beside it in a presentation wrapper", () => {
    const h = html();
    expect(h).toContain('role="tablist" aria-label="Tabs"');
    expect(h).toMatch(/<div class="bp-tab-wrap is-open" role="presentation"><button type="button" role="tab" class="bp-tab" aria-selected="true" aria-controls="bp-frame-column"/);
    // The Close button is the tab's sibling, not its child.
    expect(h).toMatch(/<\/button><button type="button" class="icon-btn bp-tab-x" aria-label="Close Ridgeway Trails: book a walk"/);
    expect(h).toContain('aria-label="New tab"');
  });
  test("the bar: a toolbar named Page, Back, Forward, Reload, the Address field, More as a dialog popup", () => {
    const h = html();
    expect(h).toContain('role="toolbar" aria-label="Page"');
    expect(h).toContain('aria-label="Back"');
    expect(h).toMatch(/aria-label="Forward"[^>]*disabled/);
    expect(h).toContain('aria-label="Reload"');
    expect(h).toMatch(/<input[^>]*aria-label="Address"[^>]*inputMode="url"[^>]*enterKeyHint="go"/);
    expect(h).toMatch(/aria-label="More"[^>]*aria-haspopup="dialog"[^>]*aria-expanded="false"/);
  });
  test("the field at rest: the host, then the rest", () => {
    expect(html()).toMatch(/class="bp-url is-rest".*<span class="bp-url-host">localhost:3000<\/span><span class="bp-url-rest">\/book<\/span>/);
  });
  test("the frame: an application in the Tab order, named by the page's title, described by the way out", () => {
    const h = html();
    expect(h).toMatch(/role="application" aria-roledescription="page view" aria-label="Ridgeway Trails: book a walk" aria-describedby="bp-frame-column-d" tabindex="0"/);
    expect(frameDescription(true)).toBe("Clicks and keys go to the page in the shared browser. Press Cmd+L to leave the page.");
    expect(frameDescription(false)).toBe("Clicks and keys go to the page in the shared browser. Press Ctrl+L to leave the page.");
    // The page's own words for this platform's key (IS_MAC: Cmd on macOS, Ctrl elsewhere).
    expect(h).toContain(frameDescription(IS_MAC));
  });
  test("a tab that a link names and that is gone: 5.4's line, and the pane shows another", () => {
    const h = shell(`/c/${CHAT}/browser/zzzzzzzzzz`);
    expect(text(h)).toContain("That tab is not open any more.");
    expect(h).toContain('data-tab="');
  });
  test("a url pre-fill: a new tab's field holds it, with the line, and nothing opens", () => {
    const h = shell(`/c/${CHAT}/browser?url=${encodeURIComponent("http://localhost:5173/")}`);
    expect(h).toContain('value="http://localhost:5173/"');
    expect(text(h)).toContain("Address from an external link");
    expect(h).toContain('data-tab="draft"');
  });
  test("a url pre-fill of another scheme fills nothing: 5.4's line, no draft, no external-link line (PAGE-B1 2.1)", () => {
    for (const raw of ["javascript:alert(1)", "ftp://example.com/"]) {
      const h = shell(`/c/${CHAT}/browser?url=${encodeURIComponent(raw)}`);
      expect([raw, text(h).includes("That address cannot open here.")]).toEqual([raw, true]);
      expect([raw, text(h).includes("Address from an external link")]).toEqual([raw, false]);
      expect([raw, h.includes(`value="${raw}"`), h.includes('data-tab="draft"')]).toEqual([raw, false, false]);
    }
  });
  test("a chat link's address that waits for Go (the browser off, or its socket not open in time) has no external-link line", () => {
    const url = "https://example.com/from-chat";
    markChatLink(url);
    const h = shell(`/c/${CHAT}/browser?url=${encodeURIComponent(url)}`);
    expect(h).toContain(`value="${url}"`);
    expect(text(h)).not.toContain("Address from an external link");
    // The same address from anywhere else is an external link.
    expect(text(shell(`/c/${CHAT}/browser?url=${encodeURIComponent("https://example.com/other")}`))).toContain("Address from an external link");
  });
  test("the phone's Tabs sheet: a plain list of rows, the open tab's row current, each Close a sibling button (no listbox)", () => {
    const rows = stripTabs([tab(TAB), tab(TAB2, { title: "Pull request 214", url: "https://git.example.com/pull/214" })], [], true, null);
    const h = renderToStaticMarkup(createElement(TabRows, { tabs: rows, shown: TAB2, onShow() {}, onCloseTab() {} }));
    expect(h).not.toContain('role="listbox"');
    expect(h).not.toContain('role="option"');
    expect(h).not.toContain("aria-selected");
    expect(h.match(/aria-current="true"/g)?.length).toBe(1);
    expect(h).toMatch(/<button type="button" class="bp-tab-row-pick" aria-current="true"[^>]*>.*Pull request 214/);
    expect(h).toMatch(/<\/button><button type="button" class="icon-btn" aria-label="Close Pull request 214"/);
  });
  test("no tabs: No tabs are open, with New tab", () => {
    open(RUNNING, []);
    expect(text(shell(`/c/${CHAT}/browser`))).toContain("No tabs are open New tab");
  });
  test("a crashed tab, a hidden tab, too many viewers: over the stage, the head and the bar stay", () => {
    open(RUNNING, [tab(TAB, { crashed: true })]);
    let h = shell(`/c/${CHAT}/browser/${TAB}`);
    expect(text(h)).toContain("This page crashed Reload");
    expect(h).toContain('role="tablist"');
    open(RUNNING, [tab(TAB, { hidden: true }), tab(TAB2, { opener: TAB, title: "Sign in" })]);
    h = shell(`/c/${CHAT}/browser/${TAB}`);
    expect(text(h)).toContain("This tab is behind Sign in. Show");
  });
  test("a dialog waits in another tab: that tab's needs-you dot, in its name", () => {
    open(RUNNING, [tab(TAB), tab(TAB2, { dialog: 4, title: "Pull request 214" })]);
    const h = shell(`/c/${CHAT}/browser/${TAB}`);
    expect(h).toContain('aria-label="Pull request 214, needs an answer"');
    expect(h).toMatch(/<span class="dot waiting" aria-hidden="true"><\/span><span class="bp-tab-title">Pull request 214/);
  });
});

describe("the browser's states (DESIGN-B1 4.13)", () => {
  const words = (h: BrowserHostView) => text(renderToStaticMarkup(createElement(HostState, { host: h })));
  test("off: never started, and stopped with its tabs saved (F23)", () => {
    expect(words({ state: "off", port: 9340, saved: 0 })).toBe("The browser is off Start a browser that you and Claude share. It keeps your sign-ins. Start browser");
    expect(words({ state: "off", port: 9340, saved: 3 })).toBe("The browser is stopped Its tabs come back when it starts. Start browser");
  });
  test("missing, and a bad path", () => {
    expect(words({ state: "missing", port: 9340, reason: "none" })).toBe("No browser on this host kitespan needs Google Chrome or Chromium. Install one, then try again. Try again");
    expect(words({ state: "missing", port: 9340, reason: "bad_path" })).toBe("The configured browser cannot run here Settings > Browser shows the path that kitespan tried. Try again Open Settings");
  });
  test("the two port states say where Claude's tools connect, with the configured port (F1)", () => {
    expect(words({ state: "port_own", port: 9555 })).toBe("Port 9555 is in use Port 9555 is used by another program of yours. Claude's browser tools connect to that program, not to kitespan's browser. Try again Change the port");
    expect(words({ state: "port_other", port: 9340 })).toBe(
      "Port 9340 is held by another account Port 9340 is held by another account on this machine. Claude's browser tools would connect to its program. Do not use them until the port is free, or change the port. Try again Change the port",
    );
    expect(renderToStaticMarkup(createElement(HostState, { host: { state: "port_own", port: 9340 } }))).toContain('href="/settings/browser"');
  });
  test("crashed six times; starting after a crash; stopping; a plain start's words wait 300 ms", () => {
    expect(words({ state: "crashed", port: 9340 })).toBe("The browser stopped It stopped six times in ten minutes. Its tabs come back when it starts. Start browser");
    expect(words({ state: "starting", port: 9340, attempt: 2 })).toBe("The browser stopped. Starting it again…");
    expect(words({ state: "stopping", port: 9340 })).toBe("Stopping the browser…");
    expect(words({ state: "starting", port: 9340 })).toBe("");
    expect(hostWords({ state: "starting", port: 9340 })).toMatchObject({ title: "Starting the browser…", late: true });
  });
  test("the pane in a state is the state alone (the head and the bar go)", () => {
    open({ state: "off", port: 9340, saved: 2 });
    const h = shell(`/c/${CHAT}/browser`);
    expect(text(h)).toContain("The browser is stopped");
    expect(h).not.toContain('role="tablist"');
  });
});

describe("the dialog card (DESIGN-B1 4.6, F10, F16 (3), F19)", () => {
  test("Chrome's titles and buttons", () => {
    expect(dialogTitle({ type: "confirm", host: "localhost:3000", embedded: false })).toBe("localhost:3000 says");
    expect(dialogTitle({ type: "alert", host: "ads.example", embedded: true })).toBe("An embedded page at ads.example says");
    expect(dialogTitle({ type: "beforeunload", host: "x", embedded: false })).toBe("Leave site?");
    expect(dialogText({ type: "beforeunload", message: "ignored" })).toBe("Changes you made may not be saved.");
    expect(dialogButtons("alert")).toEqual(["ok"]);
    expect(dialogButtons("prompt")).toEqual(["cancel", "ok"]);
    expect(dialogButtons("beforeunload")).toEqual(["cancel", "leave"]);
  });
  test("the focus: the card itself while the frame had the keys or a key went in the last second; else OK on a laptop", () => {
    expect(dialogFocus({ frameHadKeys: true, lastKeyAt: 0, now: 10_000, touch: false, onScreen: true })).toBe("card");
    expect(dialogFocus({ frameHadKeys: false, lastKeyAt: 9_500, now: 10_000, touch: false, onScreen: true })).toBe("card");
    expect(dialogFocus({ frameHadKeys: false, lastKeyAt: 8_000, now: 10_000, touch: false, onScreen: true })).toBe("ok");
    expect(dialogFocus({ frameHadKeys: false, lastKeyAt: 0, now: 10_000, touch: true, onScreen: true })).toBe("none");
  });
  test("its buttons ignore presses for 500 ms after it shows", () => {
    expect(DIALOG_GUARD_MS).toBe(500);
    expect(guardOver(1000, 1499)).toBe(false);
    expect(guardOver(1000, 1500)).toBe(true);
  });
  test("drawn over the stage on every viewer, as an alertdialog named by its title and described by the message", () => {
    open(RUNNING, [tab(TAB, { dialog: 2 })]);
    receive({ t: "dialog", tab: TAB, id: 2, type: "confirm", message: "Book the Ridge Loop?", defaultPrompt: "", host: "localhost:3000", embedded: false });
    const h = shell(`/c/${CHAT}/browser/${TAB}`);
    expect(h).toMatch(/role="alertdialog" aria-labelledby="bp-dlg-t-q2x4abk3m7-2" aria-describedby="bp-dlg-m-q2x4abk3m7-2" tabindex="-1"/);
    expect(text(h)).toContain("localhost:3000 says Book the Ridge Loop? Cancel OK");
  });
});

describe("the file cards (DESIGN-B1 4.7, F15)", () => {
  test("the user's chooser and Claude's: the chooser frame's `by`, which the server decided when it opened", () => {
    expect(fileTitle({ multiple: false, by: "pane" })).toBe("The page asks for a file");
    expect(fileTitle({ multiple: true, by: "pane" })).toBe("The page asks for files");
    expect(fileTitle({ multiple: false, by: "claude" })).toBe("Claude opened a file field");
    expect(fileTitle({ multiple: true, by: "claude" })).toBe("Claude opened a file field");
    expect(fileTitle({ multiple: false, by: "other" })).toBe("The page asks for a file");
    expect(fileWhere({ host: "localhost:3000", label: "Signed waiver" })).toBe("localhost:3000, for Signed waiver");
    expect(fileWhere({ host: "localhost:3000", label: "" })).toBe("localhost:3000");
    expect(FILE_LINES.told).toBe("Tell Claude you chose the file. Its browser tools still see the file field as open.");
  });
  test("whose the card is, and its plain button (Esc): from the frame's `by` alone, the rule that FileCard draws and the live test checks", () => {
    expect([fileIsClaudes({ by: "claude" }), fileIsClaudes({ by: "pane" }), fileIsClaudes({ by: "other" })]).toEqual([true, false, false]);
    expect([filePlain({ by: "claude" }), filePlain({ by: "pane" }), filePlain({ by: "other" })]).toEqual(["Leave it to Claude", "Cancel", "Cancel"]);
  });
  const CLAUDES = "Claude opened a file field localhost:3000, for Signed waiver The file goes into this chat's uploads, then to the page. Leave it to Claude Choose file";
  test("Claude's card offers Leave it to Claude, and stays Claude's when the click's result clears the acting list", () => {
    open(RUNNING, [tab(TAB, { chooser: 7 })]);
    receive({ t: "acting", list: [{ chat: CHAT, tool: "browser_click", tab: TAB, since: "2026-11-09T10:00:00.000Z" }] });
    receive({ t: "chooser", tab: TAB, id: 7, mode: "selectSingle", accept: [".pdf"], multiple: false, label: "Signed waiver", host: "localhost:3000", by: "claude" });
    expect(text(shell(`/c/${CHAT}/browser/${TAB}`))).toContain(CLAUDES);
    receive({ t: "acting", list: [] });
    expect(text(shell(`/c/${CHAT}/browser/${TAB}`))).toContain(CLAUDES);
  });
  test("Claude's card with no browser call running at all (a viewer that opens the pane later)", () => {
    open(RUNNING, [tab(TAB, { chooser: 3 })]);
    receive({ t: "chooser", tab: TAB, id: 3, mode: "selectSingle", accept: [".pdf"], multiple: false, label: "Signed waiver", host: "localhost:3000", by: "claude" });
    expect(text(shell(`/c/${CHAT}/browser/${TAB}`))).toContain(CLAUDES);
  });
  test("the chooser frame again with the same id, now by other (the chat that opened it ended): the same card, with the page's words and Cancel", () => {
    open(RUNNING, [tab(TAB, { chooser: 7 })]);
    receive({ t: "chooser", tab: TAB, id: 7, mode: "selectSingle", accept: [".pdf"], multiple: false, label: "Signed waiver", host: "localhost:3000", by: "claude" });
    expect(text(shell(`/c/${CHAT}/browser/${TAB}`))).toContain(CLAUDES);
    receive({ t: "chooser", tab: TAB, id: 7, mode: "selectSingle", accept: [".pdf"], multiple: false, label: "Signed waiver", host: "localhost:3000", by: "other" });
    const html = shell(`/c/${CHAT}/browser/${TAB}`);
    expect(text(html)).toContain("The page asks for a file localhost:3000, for Signed waiver The file goes into this chat's uploads, then to the page. Cancel Choose file");
    expect(text(html)).not.toContain("Leave it to Claude");
    expect(html.match(/data-testid="browser-file"/g)?.length).toBe(1);
  });
  test("a chooser that the server did not mark as Claude's is the page's, even while a call of Claude's runs", () => {
    open(RUNNING, [tab(TAB, { chooser: 8 })]);
    receive({ t: "acting", list: [{ chat: CHAT, tool: "browser_click", tab: null, since: "2026-11-09T10:00:00.000Z" }] });
    receive({ t: "chooser", tab: TAB, id: 8, mode: "selectSingle", accept: [".pdf"], multiple: false, label: "Signed waiver", host: "localhost:3000", by: "other" });
    const t = text(shell(`/c/${CHAT}/browser/${TAB}`));
    expect(t).toContain("The page asks for a file localhost:3000, for Signed waiver The file goes into this chat's uploads, then to the page. Cancel Choose file");
    expect(t).not.toContain("Leave it to Claude");
  });
});

describe("the keyboard on touch (DESIGN-B1 4.10, F6)", () => {
  const f = (type: string, extra: Partial<{ inputmode: string | null; enterkeyhint: string | null; password: boolean }> = {}) => ({ editable: true as const, type, inputmode: null, enterkeyhint: null, password: false, box: { x: 0, y: 0, w: 1, h: 1 }, ...extra });
  test("the hidden field copies the type as inputmode, and the page's own hints", () => {
    expect(fieldHints(f("email")).inputMode).toBe("email");
    expect(fieldHints(f("url")).inputMode).toBe("url");
    expect(fieldHints(f("tel")).inputMode).toBe("tel");
    expect(fieldHints(f("number")).inputMode).toBe("numeric");
    expect(fieldHints(f("search")).inputMode).toBe("search");
    expect(fieldHints(f("text", { inputmode: "decimal", enterkeyhint: "send" }))).toMatchObject({ inputMode: "decimal", enterKeyHint: "send" });
    expect(fieldHints(f("text", { inputmode: "<script>" })).inputMode).toBe("text");
  });
  test("autocorrect, capitals and spell check off for password, email and url", () => {
    for (const t of ["email", "url"]) expect(fieldHints(f(t))).toMatchObject({ autoCorrect: "off", autoCapitalize: "off", spellCheck: false });
    expect(fieldHints(f("password", { password: true }))).toMatchObject({ autoCorrect: "off", spellCheck: false });
    expect(fieldHints(f("textarea"))).toMatchObject({ autoCorrect: "on", spellCheck: true });
  });
  test("the echo: the last 20 characters, never for a password", () => {
    expect(echoOf("abcdefghijklmnopqrs", "tuv", false)).toBe("cdefghijklmnopqrstuv");
    expect(echoOf("abc", "d", true)).toBe("");
  });
  test("the foot: Keyboard lights while the page's field has the focus", () => {
    viewport(1194, 834, true);
    receive({ t: "focus", tab: TAB, ...f("email") });
    const h = shell(`/c/${CHAT}/browser/${TAB}`);
    expect(h).toMatch(/class="bp-foot-btn is-invite" aria-pressed="false"/);
    expect(h).toMatch(/<textarea class="bp-type" aria-label="Type into the page" inputMode="email"/);
  });
});

describe("More (DESIGN-B1 4.2, 4.11, F21, F25)", () => {
  const more = (t: BrowserTabView | null) =>
    renderToStaticMarkup(
      createElement(More, {
        open: true,
        onClose() {},
        anchor: { current: null },
        tab: t,
        onSize() {},
        zoom: null,
        canZoomIn: true,
        onZoomIn() {},
        onZoomOut() {},
        moving: false,
        onMove() {},
        fullHref: "/browser/q2x4abk3m7",
        downloads: [],
        links: false,
        onLinks() {},
      }),
    );
  test("a non-modal popover, role dialog, named More, with ordinary controls", () => {
    const h = more(tab(TAB));
    expect(h).toMatch(/class="menu bp-more" role="dialog" aria-label="More"/);
    expect(h).not.toContain("aria-modal");
    expect(h).toContain('role="radiogroup" aria-label="Page size"');
    expect(text(h)).toContain("Page size, for everyone on this tab Desktop Phone Zoom, on this device");
    expect(text(h)).toContain("Open full size Copy address Downloads Open chat links here");
  });
  test("another client's size: neither segment lit, and who set it", () => {
    expect(sizeNote(tab(TAB, { size: { kind: "other", w: 1024, h: 700, by: "claude" } }))).toBe("1024 x 700, set by Claude");
    expect(sizeNote(tab(TAB, { size: { kind: "other", w: 800, h: 600, by: "other" } }))).toBe("800 x 600, set elsewhere");
    const h = more(tab(TAB, { size: { kind: "other", w: 1024, h: 700, by: "claude" } }));
    expect(h).toContain('data-none="true"');
  });
});

describe("chat links (DESIGN-B1 4.15, PA-14)", () => {
  test("the first plain click asks; then the preference; a modified click or a refused link opens a new tab", () => {
    expect(linkAction({ href: "https://example.com/", plain: true, pref: "ask", refused: false })).toBe("ask");
    expect(linkAction({ href: "https://example.com/", plain: true, pref: "pane", refused: false })).toBe("pane");
    expect(linkAction({ href: "https://example.com/", plain: true, pref: "tab", refused: false })).toBe("tab");
    expect(linkAction({ href: "https://example.com/", plain: false, pref: "pane", refused: false })).toBe("tab");
    expect(linkAction({ href: "http://127.0.0.1:7948/c/x", plain: true, pref: "pane", refused: true })).toBe("tab");
    expect(linkAction({ href: "mailto:a@b.c", plain: true, pref: "pane", refused: false })).toBe("tab");
    expect(LINK_WORDS).toEqual({
      title: "Open links in the browser pane?",
      line: "Links from chats can open in the browser that you share with Claude, or in a new tab here.",
      where: "You can change this in Settings > Browser.",
      tab: "New tab",
      pane: "Browser pane",
    });
  });
});

describe("the needs-you dot (DESIGN-B1 4.4, F20)", () => {
  test("a dialog or a chooser waits in a tab that no view shows", () => {
    const tabs = [tab(TAB, { dialog: 1 }), tab(TAB2)];
    expect(needsYou(tabs, new Set())).toBe(true);
    expect(needsYou(tabs, new Set([TAB]))).toBe(false);
    expect(needsYou([tab(TAB, { chooser: 3 })], new Set([TAB2]))).toBe(true);
    expect(NEEDS_WORDS).toBe(", the browser needs an answer");
  });
  test("the title bar's Browser tool: its key in the tooltip, and the dot with its words while the pane is closed", () => {
    open(RUNNING, [tab(TAB, { dialog: 1 })]);
    const chat = CHATS.find((c) => c.id === CHAT)!;
    const h = renderToStaticMarkup(createElement(TopBar, { route: at(`/c/${CHAT}`), chat }));
    expect(h).toMatch(/aria-label="Browser, the browser needs an answer"[^>]*title="Browser: the browser needs an answer"/);
    expect(h).toContain('class="dot waiting bp-tool-dot"');
    open();
    const h2 = renderToStaticMarkup(createElement(TopBar, { route: at(`/c/${CHAT}`), chat }));
    // The platform's key: Cmd+Shift+B (Meta) on macOS, Ctrl+Shift+B elsewhere.
    const [aria, words] = IS_MAC ? ["Meta", "Cmd"] : ["Control", "Ctrl"];
    expect(h2).toMatch(new RegExp(`aria-label="Browser"[^>]*aria-keyshortcuts="${aria}\\+Shift\\+B"[^>]*title="Browser \\(${words}\\+Shift\\+B\\)"`));
  });
});

describe("the phone's ways in (F20)", () => {
  test("the session menu's button wears the dot while a page waits; the chat list's Browser button too", () => {
    viewport(390, 844, true);
    open(RUNNING, [tab(TAB, { chooser: 2 })]);
    const chat = CHATS.find((c) => c.id === CHAT)!;
    const bar = renderToStaticMarkup(createElement(TopBar, { route: at(`/c/${CHAT}`), chat }));
    expect(bar).toMatch(/aria-label="Session menu, the browser needs an answer"/);
    const list = renderToStaticMarkup(createElement(TopBar, { route: at("/chats") }));
    expect(list).toMatch(/aria-label="Browser, the browser needs an answer"[^>]*data-testid="browser-button"/);
    open();
    expect(renderToStaticMarkup(createElement(TopBar, { route: at(`/c/${CHAT}`), chat }))).toMatch(/aria-label="Session menu" aria-haspopup/);
  });
});

describe("Settings > Browser (DESIGN-B1 4.14, S3)", () => {
  test("the Browser row's value", () => {
    expect(browserRowValue(RUNNING)).toBe("Running, Chrome 154.0.8037.57");
    expect(browserRowValue({ state: "off", port: 9340, saved: 0 })).toBe("Off");
    expect(browserRowValue({ state: "off", port: 9340, saved: 4 })).toBe("Stopped");
    expect(browserRowValue({ state: "missing", port: 9340, reason: "none" })).toBe("Not found");
    expect(browserRowValue({ state: "starting", port: 9340 })).toBe("Starting");
    expect(browserRowValue({ state: "port_own", port: 9340 })).toBe("Port 9340 is used by another program of yours. Claude's browser tools connect to that program, not to kitespan's browser.");
  });
  test("Open chat links: a segmented control where its words fit; a menu (a sheet on the phone) where the section is narrow, as Settings' other long choices", () => {
    const section = (phone: boolean) => renderToStaticMarkup(createElement(SectionBody, { id: "browser", ctx: { touch: phone, laptop: !phone, phone, narrow: phone } }));
    const wide = section(false);
    expect(wide).toMatch(/role="radiogroup" aria-label="Open chat links"/);
    expect(wide).not.toContain('data-testid="browser-links-button"');
    viewport(390, 844, true);
    const narrow = section(true);
    expect(narrow).not.toMatch(/role="radiogroup" aria-label="Open chat links"/);
    expect(narrow).toMatch(/data-testid="browser-links-button" aria-haspopup="menu"/);
    expect(text(narrow)).toContain("Open chat links Ask the first time");
  });
  test("Clear browsing data names what goes, and that the tabs go (S3)", () => {
    expect(BROWSER_SETTING_WORDS.clearLine).toBe("Sign-ins, cookies, history, site data and cache of the shared browser. Downloads stay.");
    expect(BROWSER_SETTING_WORDS.clearRunning).toBe("Every site signs out, for Claude too. The browser restarts with no tabs.");
    expect(BROWSER_SETTING_WORDS.clearOff).toBe("Every site signs out, for Claude too. Its saved tabs go.");
    expect(BROWSER_SETTING_WORDS.notStopped).toBe("The browser did not stop, so nothing was cleared.");
  });
});

describe("small rules", () => {
  test("a paste gives the page text with no control but tab and line feed", () => {
    expect(pasteText("a\r\nb\rc\td\u0007e\u001b")).toBe("a\nb\nc\tde");
  });
  test("a picker's name, and when it shows (F7)", () => {
    expect(pickerName({ kind: "select", label: "" })).toBe("Choose an option");
    expect(pickerName({ kind: "color", label: "Tag colour" })).toBe("Tag colour");
    expect(pickerShows({ kind: "select", open: true }, false, true)).toBe(true);
    expect(pickerShows({ kind: "select", open: false }, true, true)).toBe(false);
    expect(pickerShows({ kind: "date", open: false }, true, true)).toBe(true);
    expect(pickerShows({ kind: "date", open: false }, false, true)).toBe(false);
    expect(pickerShows({ kind: "date", open: true }, false, false)).toBe(true);
  });
});
