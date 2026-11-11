// Iteration 8 (touch; DESIGN-T1 2.3, 2.4 and 2.6; T-5, T-10, T-11, T-28, G-16, G-19, G-42, G-47): on touch a bar's
// tools that open a place show their names (the phone's /chats bar, the medium chats button, the title bar's tools,
// Search with the sidebar hidden), and a list head holds them in a row under the brand, named under their icons, with
// the Browser button never dropped; the glyphs that say their action stay icons. A bar with no room for the words drops
// them (ui/barRoom.ts: the pure rules here; the measure runs in the page). A laptop keeps its icons and tooltips.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parse } from "../../web/router";
import { act, resetState } from "../../web/state/store";
import { DEFAULT_VIEW } from "../../web/state/catalog";
import type { Chat } from "../../web/state/types";
import { Shell } from "../../web/layout/Shell";
import { TopBar } from "../../web/layout/TopBar";
import { ChatListBody } from "../../web/screens/ChatListBody";
import { TITLE_SHARE, barTight, headTight, titleTight } from "../../web/ui/barRoom";
import { CHATS, PROJECTS } from "./fixtures";

const C = "demoolxxxxxxxxxxxxxx";
const at = (u: string) => parse(new URL(u, "http://127.0.0.1"));
const gm = globalThis as unknown as { matchMedia?: unknown; window?: unknown; history?: unknown };
const own = { mm: !gm.matchMedia, win: !gm.window, hist: !gm.history };
let coarse = false;
function viewport(width: number, height: number, touch: boolean) {
  coarse = touch;
  gm.window = { innerWidth: width, innerHeight: height, addEventListener() {}, removeEventListener() {} };
}
beforeAll(() => {
  gm.matchMedia = (q: string) => ({ matches: coarse && q === "(pointer: coarse)", addEventListener() {}, removeEventListener() {} });
  gm.history ??= { state: null };
});
beforeEach(() => resetState({ projects: structuredClone(PROJECTS), chats: structuredClone(CHATS), ready: true, view: { ...DEFAULT_VIEW } }));
afterAll(() => {
  if (own.mm) delete gm.matchMedia;
  if (own.win) delete gm.window;
  if (own.hist) delete gm.history;
  resetState();
});

const chat = () => CHATS.find((c) => c.id === C) as Chat;
const bar = (url: string, withChat = true) => renderToStaticMarkup(createElement(TopBar, { route: at(url), chat: withChat ? chat() : undefined }));
const shell = (url: string) => renderToStaticMarkup(createElement(Shell, { route: at(url), chat: chat(), side: () => createElement("div"), children: createElement("div", { className: "chat-screen" }) }));
/** The element whose attributes match `attr`, as its opening tag and its text. */
const tool = (html: string, attr: RegExp): { tag: string; text: string } | null => {
  const m = new RegExp(`<(a|button)\\b([^>]*${attr.source}[^>]*)>([\\s\\S]*?)</\\1>`).exec(html);
  return m ? { tag: m[2]!, text: m[3]!.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, "").trim() } : null;
};
const head = (html: string) => /<div class="scr-head-tools" data-testid="head-tools">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? null;

describe("the room rules (ui/barRoom.ts)", () => {
  test("a bar is tight when its heading's whole words, its named tools and their gaps need more than its width", () => {
    // The phone's /chats bar at 390 px: "Chats" and Search, Browser and New named fit at text size 1.
    expect(barTight({ width: 390, pad: 8, gap: 0, heading: 66, tools: [92, 104, 74] })).toBe(false);
    // At text size 1.3 the words grow and the icons do not: "Chats" would be cut.
    expect(barTight({ width: 390, pad: 8, gap: 0, heading: 84, tools: [108, 124, 88] })).toBe(true);
    // Exactly full is not tight; a gap before each tool counts.
    expect(barTight({ width: 300, pad: 0, gap: 0, heading: 100, tools: [100, 100] })).toBe(false);
    expect(barTight({ width: 300, pad: 0, gap: 8, heading: 100, tools: [100, 100] })).toBe(true);
  });
  test("a title band is tight when the title gets less than its whole width or 40% of the band, or a tool runs past its end", () => {
    expect(TITLE_SHARE).toBe(0.4);
    // The large tablet's column form at 1024 px: a 604 px band whose named tools left the title 12 px (G-47).
    expect(titleTight({ band: 604, title: 161, titleNow: 12, past: false })).toBe(true);
    expect(titleTight({ band: 604, title: 161, titleNow: 161, past: false })).toBe(false);
    // A long title keeps 40% of the band (241.6 px), and is cut past it.
    expect(titleTight({ band: 604, title: 400, titleNow: 250, past: false })).toBe(false);
    expect(titleTight({ band: 604, title: 400, titleNow: 200, past: false })).toBe(true);
    // Hide session rail past the band's end, into the side column (G-47).
    expect(titleTight({ band: 604, title: 161, titleNow: 161, past: true })).toBe(true);
  });
  test("a touch list head is tight when one name is still wider than its tool", () => {
    expect(headTight([{ name: 40, box: 62 }, { name: 54, box: 62 }])).toBe(false);
    expect(headTight([{ name: 40, box: 62 }, { name: 66, box: 62 }])).toBe(true);
    expect(headTight([])).toBe(false);
  });
});

describe("the phone's /chats bar (390 px)", () => {
  test("on touch Search, Browser and New show their names beside their icons", () => {
    viewport(390, 844, true);
    const html = bar("/chats", false);
    for (const [attr, name] of [[/class="btn ghost scr-bar-tool scr-search scr-bar-search"/, "Search"], [/data-testid="browser-button"/, "Browser"], [/class="btn ghost scr-bar-tool scr-bar-compose"/, "New"]] as const) {
      const t = tool(html, attr);
      expect([name, t?.text]).toEqual([name, name]);
    }
    expect(tool(html, /data-testid="browser-button"/)!.tag).toContain("btn ghost scr-bar-tool scr-browser");
    expect(html).toContain('<span class="scr-bar-heading">Chats</span>');
  });
  test("a narrow window with a mouse keeps the icons and their tooltips (T-24)", () => {
    viewport(390, 844, false);
    const html = bar("/chats", false);
    expect(tool(html, /aria-label="Search"/)!.tag).toContain('class="icon-btn scr-search scr-bar-search"');
    expect(tool(html, /aria-label="Search"/)!.text).toBe("");
    expect(tool(html, /aria-label="New"/)!.tag).toContain('title="New"');
  });
});

describe("a list head: the tools in a row under the brand, named under their icons; the Browser never drops (T-11)", () => {
  test("the medium drawer at 834 px: Search, Browser and New", () => {
    viewport(834, 1194, true);
    const tools = head(renderToStaticMarkup(createElement(ChatListBody, { route: at("/chats"), variant: "drawer" })));
    expect(tools).not.toBeNull();
    const names = [...tools!.matchAll(/<span class="scr-head-name">([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(names).toEqual(["Search", "Browser", "New"]);
    expect(tools).toMatch(/class="scr-head-tool scr-search"/);
    expect(tools).toMatch(/class="scr-head-tool scr-browser"/);
    expect(tools).toMatch(/class="scr-head-tool scr-compose"/);
  });
  test("the large tablet's sidebar at 1024 px: Hide sidebar ends the row, so the brand has its line to itself", () => {
    viewport(1024, 1366, true);
    const html = shell(`/c/${C}`);
    const tools = head(html)!;
    expect([...tools.matchAll(/<span class="scr-head-name">([^<]*)<\/span>/g)].map((m) => m[1])).toEqual(["Search", "Browser", "New", "Hide sidebar"]);
    expect(tools).toMatch(/<button type="button" class="scr-head-tool sidebar-hide"[^>]*data-testid="sidebar-hide"/);
    // Nothing else sits on the brand's line.
    expect(html).toMatch(/<div class="scr-list-head"><a href="\/" class="scr-brand" aria-label="kitespan, home">kitespan<\/a><div class="scr-head-tools"/);
  });
  test("a laptop: icons with tooltips on the brand's line, the Browser among them; Hide sidebar before the head", () => {
    viewport(1280, 800, false);
    const html = shell(`/c/${C}`);
    const tools = head(html)!;
    expect(tools).not.toContain("scr-head-name");
    expect(tools).toContain('data-testid="browser-button"');
    expect(tools).toMatch(/class="icon-btn scr-compose"[^>]*title="New"/);
    expect(html).toMatch(/<button type="button" class="icon-btn sidebar-hide" aria-label="Hide sidebar" title="Hide sidebar" data-testid="sidebar-hide">/);
  });
  test("the head's CSS: a row of its own on touch, its names dropped where tight, the brand's ring inset (screens.css)", () => {
    const css = readFileSync(join(import.meta.dir, "..", "..", "web", "styles", "screens.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toMatch(/\.touch \.scr-head-tools \{\s*flex: 1 0 100%;/);
    expect(css).toMatch(/\.scr-head-tool \{[^}]*min-height: 52px;/);
    expect(css).toMatch(/\.scr-list-head\[data-tight\] \.scr-head-name \{\s*position: absolute;[^}]*clip-path: inset\(50%\);/);
    expect(css).toMatch(/\.touch \.scr-brand:focus-visible \{\s*outline-offset: -2px;/);
    // A name follows the user's text size: no 12 px cap.
    expect(/\.scr-head-name \{([^}]*)\}/.exec(css)![1]).not.toContain("12px");
  });
});

describe("the chat's title bars", () => {
  test("medium touch: the chats button shows its name; the menu button stays an icon; the title is not draggable", () => {
    viewport(834, 1194, true);
    const html = bar(`/c/${C}`);
    const chats = tool(html, /class="btn ghost scr-bar-tool scr-bar-chats"/);
    expect(chats?.text).toBe("Chats");
    expect(chats!.tag).not.toContain("aria-label");
    const more = tool(html, /aria-label="Session menu"/);
    expect(more?.text).toBe("");
    expect(html).toMatch(/<span class="scr-bar-press"><a [^>]*class="scr-bar-title scr-bar-title-touch"[^>]*draggable="false"/);
  });
  test("the phone: the chats button is Back, an arrow; the over-chat screens keep Back's word", () => {
    viewport(390, 844, true);
    expect(tool(bar(`/c/${C}`), /class="icon-btn scr-bar-chats"/)!.tag).toContain('aria-label="Chats"');
    expect(bar(`/c/${C}/uploads`)).toMatch(/class="scr-bar-back"[^>]*>[\s\S]*<span>Chat<\/span>/);
  });
  test("the large tablet with the sidebar hidden: Search first in the title bar, named, beside Show sidebar (T-10)", () => {
    viewport(1024, 1366, true);
    act.setView({ sidebarHidden: true });
    const html = shell(`/c/${C}`);
    const search = tool(html, /data-testid="topbar-search"/);
    expect(search?.text).toBe("Search");
    expect(search!.tag).toContain("btn ghost scr-bar-tool scr-search");
    expect(html).toMatch(/<div class="scr-bar-tools"><a [^>]*data-testid="topbar-search"/);
    expect(tool(html, /data-testid="sidebar-show"/)?.text).toBe("Show sidebar");
    expect(html).toMatch(/class="scr-bar-title"[^>]*draggable="false"/);
  });
  test("a laptop with the sidebar hidden: Search as an icon with its key in the tooltip", () => {
    viewport(1280, 800, false);
    act.setView({ sidebarHidden: true });
    const search = tool(shell(`/c/${C}`), /data-testid="topbar-search"/);
    expect(search!.tag).toMatch(/class="icon-btn scr-search scr-bar-icon" aria-label="Search" aria-keyshortcuts="(Meta|Control)\+K" title="Search \((Cmd|Ctrl)\+K\)"/);
    expect(search!.text).toBe("");
  });
  test("with the sidebar shown there is no title bar Search (the sidebar's head has it)", () => {
    viewport(1280, 800, false);
    expect(shell(`/c/${C}`)).not.toContain('data-testid="topbar-search"');
  });
  test("a tight bar drops every tool's word, the dot's mark kept (screens.css)", () => {
    const css = readFileSync(join(import.meta.dir, "..", "..", "web", "styles", "screens.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toMatch(/\.touch \.scr-bar\[data-tight\] \.scr-bar-tool > span:not\(\.dot\) \{\s*position: absolute;/);
    expect(css).toMatch(/@container topbar \(width < 400px\) \{[\s\S]*?\.scr-bar-chats\.scr-bar-tool > span \{\s*position: absolute;/);
  });
});

describe("Settings' device view has its heading on medium touch (G-42)", () => {
  test("/settings/notifications/device/<id> at 768 px: the bar says Settings", () => {
    viewport(768, 1024, true);
    expect(bar("/settings/notifications/device/k3m7q2x4abk3m7q2", false)).toContain('<span class="scr-bar-heading">Settings</span>');
  });
  test("the folder gives way before the title (screens.css)", () => {
    const css = readFileSync(join(import.meta.dir, "..", "..", "web", "styles", "screens.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toMatch(/\.scr-bar-folder \{\s*flex: 1 1 0;\s*max-width: -webkit-max-content;\s*max-width: max-content;/);
    expect(css).toMatch(/\.scr-bar-titlewrap \{[^}]*flex: 0 1 auto;/);
  });
});
