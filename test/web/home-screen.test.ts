// The home-screen app in the page (FIX-U6; owner rows 112 and 113). The theme colour: each look's --bg in light and
// dark (tokens.css), in web/index.html's two theme-color metas before the first paint and kept in step by applyLook,
// so the status bar wears the title bar's colour, and while a scrim shows the --bg under the look's --scrim (Scrim,
// dimThemeColor). And a way back of the page's own on the screens whose only way to their parent was the browser's
// Back, which a home-screen app does not have: the environment page and a session's preview (Back to the project,
// named by it, or "Chat" back to the chat they were opened from in the page) at every size, and /search on the tablet
// (Back, then "Search"). And the safe areas: the phone, the tablet and the large iPad (the laptop's layout on touch).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SCRIMS, THEME_COLORS, themeColorMetas, underScrim, type ThemeLook } from "../../shared/home-screen";
import { parse, pushedState } from "../../web/router";
import { DEFAULT_VIEW, LOOK_IDS, lookOf } from "../../web/state/catalog";
import { SETTINGS_KEY, resetState } from "../../web/state/store";
import type { ViewPrefs } from "../../web/state/types";
import { applyLook, dimThemeColor, type MetaTarget } from "../../web/ui/look";
import { TopBar } from "../../web/layout/TopBar";
import { CHATS, PROJECTS } from "./fixtures";

const WEB = join(import.meta.dir, "..", "..", "web");
const THEMES = ["light", "dark", "system"] as const;

describe("the theme colour follows the worn look and theme", () => {
  /** A look's --bg in one of tokens.css's blocks: its light block, its dark block, or the System theme's dark copy. */
  const css = readFileSync(join(WEB, "styles", "tokens.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  function block(look: ThemeLook, which: "light" | "dark" | "system-dark"): string {
    const sel =
      which === "light" ? `[data-look="${look}"] {` : which === "dark" ? `[data-look="${look}"][data-theme="dark"] {` : `[data-look="${look}"]:not([data-theme="light"]) {`;
    const at = css.indexOf(sel);
    if (at < 0) throw new Error(`tokens.css has no ${sel}`);
    return css.slice(at, css.indexOf("}", at));
  }
  const bg = (look: ThemeLook, which: "light" | "dark" | "system-dark") => /--bg:\s*(#[0-9a-f]{6})\s*;/i.exec(block(look, which))![1]!.toLowerCase();
  const scrim = (look: ThemeLook, which: "light" | "dark" | "system-dark") => {
    const m = /--scrim:\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)\s*;/.exec(block(look, which));
    if (!m) throw new Error(`no rgba --scrim for ${look} ${which}`);
    return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  };

  test("each look's colours are its --bg in tokens.css: light, dark, and the System theme's dark copy", () => {
    expect(Object.keys(THEME_COLORS)).toEqual([...LOOK_IDS]);
    for (const look of LOOK_IDS) {
      expect([look, THEME_COLORS[look].light]).toEqual([look, bg(look, "light")]);
      expect([look, THEME_COLORS[look].dark]).toEqual([look, bg(look, "dark")]);
      expect([look, THEME_COLORS[look].dark]).toEqual([look, bg(look, "system-dark")]);
    }
  });

  test("System gives the light and the dark meta each its own colour; Light and Dark put theirs in both", () => {
    expect(themeColorMetas("paper", "system")).toEqual({ light: "#faf9f5", dark: "#262624" });
    expect(themeColorMetas("paper", "light")).toEqual({ light: "#faf9f5", dark: "#faf9f5" });
    expect(themeColorMetas("paper", "dark")).toEqual({ light: "#262624", dark: "#262624" });
    expect(themeColorMetas("editor", "dark")).toEqual({ light: "#181818", dark: "#181818" });
  });

  const html = readFileSync(join(WEB, "index.html"), "utf8");
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;

  test("web/index.html: two theme-color metas with Glass's colours, before the script that sets them; no legacy app metas", () => {
    const light = html.indexOf('<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />');
    const dark = html.indexOf('<meta name="theme-color" content="#1c1c1e" media="(prefers-color-scheme: dark)" />');
    expect(light).toBeGreaterThan(0);
    expect(dark).toBeGreaterThan(light);
    expect(html.indexOf("<script>")).toBeGreaterThan(dark);
    expect(html.match(/<meta name="theme-color"/g)?.length).toBe(2);
    // The research found these not needed or replaced (DESIGN-U6 12.1); the build adds the manifest's and the icon's links.
    for (const legacy of ["apple-mobile-web-app-capable", "apple-mobile-web-app-status-bar-style", "mobile-web-app-capable", "apple-mobile-web-app-title", "apple-touch-startup-image", 'rel="manifest"', 'rel="apple-touch-icon"'])
      expect([legacy, html.includes(legacy)]).toEqual([legacy, false]);
    expect(html).toContain("viewport-fit=cover");
  });

  /** Run the inline script as the first paint does, over stand-in metas; returns their contents, light then dark. */
  function firstPaint(stored: unknown, metas = ["(prefers-color-scheme: light)", "(prefers-color-scheme: dark)"]): string[] {
    const content = metas.map(() => "");
    const els = metas.map((media, i) => ({ getAttribute: (k: string) => (k === "media" ? media : null), setAttribute: (k: string, v: string) => void (k === "content" && (content[i] = v)) }));
    const doc = {
      documentElement: { setAttribute() {} },
      querySelectorAll: (sel: string) => (sel === 'meta[name="theme-color"]' ? els : []),
    };
    const kv = { getItem: (k: string) => (k === SETTINGS_KEY ? JSON.stringify(stored) : null) };
    new Function("localStorage", "document", script)(kv, doc);
    return content;
  }

  test("the inline script puts the stored look and theme's colours in both metas before the first paint, glass for a look it does not know", () => {
    for (const look of [...LOOK_IDS, "noir", "solarized", "constructor", undefined])
      for (const theme of [...THEMES, "bogus", undefined]) {
        const worn = lookOf(look) ?? "glass";
        const want = themeColorMetas(worn, theme === "light" || theme === "dark" ? theme : "system");
        expect([look, theme, firstPaint({ look, theme })]).toEqual([look, theme, [want.light, want.dark]]);
      }
    // Unreadable settings leave the head's own colours; a page with no metas (the 404 page) has nothing to set.
    expect(firstPaint(undefined)).toEqual(["#ffffff", "#1c1c1e"]);
    expect(() => firstPaint({ look: "paper" }, [])).not.toThrow();
  });

  test("applyLook puts the look's colours in both metas on every change of look or theme, and only touches the metas", () => {
    const attrs = new Map<string, string>();
    const root = { getAttribute: (k: string) => attrs.get(k) ?? null, setAttribute: (k: string, v: string) => void attrs.set(k, v), removeAttribute: (k: string) => void attrs.delete(k) };
    const content = { light: "", dark: "" };
    const metas: MetaTarget[] = (["light", "dark"] as const).map((m) => ({
      getAttribute: (k: string) => (k === "media" ? `(prefers-color-scheme: ${m})` : null),
      setAttribute: (k: string, v: string) => void (k === "content" && (content[m] = v)),
    }));
    for (const look of LOOK_IDS)
      for (const theme of THEMES) {
        applyLook({ look, theme }, root, metas);
        expect([look, theme, content]).toEqual([look, theme, themeColorMetas(look, theme)]);
      }
    // The same look again changes no attribute, and the metas still hold its colours.
    content.light = content.dark = "";
    expect(applyLook({ look: "editor", theme: "system" }, root, metas)).toBe(false);
    expect(content).toEqual(themeColorMetas("editor", "system"));
  });

  test("each look's scrim is its --scrim in tokens.css: light, dark, and the System theme's dark copy", () => {
    expect(Object.keys(SCRIMS)).toEqual([...LOOK_IDS]);
    for (const look of LOOK_IDS) {
      expect([look, [...SCRIMS[look].light]]).toEqual([look, scrim(look, "light")]);
      expect([look, [...SCRIMS[look].dark]]).toEqual([look, scrim(look, "dark")]);
      expect([look, [...SCRIMS[look].dark]]).toEqual([look, scrim(look, "system-dark")]);
    }
  });

  test("while a scrim shows, each meta holds the look's --bg under it: Glass #bfbfbf and #0e0e0f, as the page's top is then", () => {
    expect(themeColorMetas("glass", "system", 1)).toEqual({ light: "#bfbfbf", dark: "#0e0e0f" });
    expect(themeColorMetas("glass", "light", 1)).toEqual({ light: "#bfbfbf", dark: "#bfbfbf" });
    expect(themeColorMetas("glass", "dark", 1)).toEqual({ light: "#0e0e0f", dark: "#0e0e0f" });
    // Paper's light scrim is its warm ink at 30%, not black: 31,30,29 over #faf9f5.
    expect(themeColorMetas("paper", "system", 1)).toEqual({ light: "#b8b7b4", dark: "#131312" });
    // Two scrims (a sheet over a drawer) dim twice; none is the plain --bg.
    expect(themeColorMetas("glass", "light", 2)).toEqual({ light: "#8f8f8f", dark: "#8f8f8f" });
    for (const look of LOOK_IDS) for (const theme of THEMES) expect(themeColorMetas(look, theme, 0)).toEqual(themeColorMetas(look, theme));
    expect(underScrim("#ffffff", [0, 0, 0, 0.25])).toBe("#bfbfbf");
  });

  test("dimThemeColor: the metas dim while any scrim shows and come back with the last; a look's change keeps them dimmed", () => {
    const attrs = new Map<string, string>();
    const root = { getAttribute: (k: string) => attrs.get(k) ?? null, setAttribute: (k: string, v: string) => void attrs.set(k, v), removeAttribute: (k: string) => void attrs.delete(k) };
    const content = { light: "", dark: "" };
    const metas: MetaTarget[] = (["light", "dark"] as const).map((m) => ({
      getAttribute: (k: string) => (k === "media" ? `(prefers-color-scheme: ${m})` : null),
      setAttribute: (k: string, v: string) => void (k === "content" && (content[m] = v)),
    }));
    applyLook({ look: "glass", theme: "system" }, root, metas);
    expect(content).toEqual({ light: "#ffffff", dark: "#1c1c1e" });
    dimThemeColor(true, metas);
    expect(content).toEqual({ light: "#bfbfbf", dark: "#0e0e0f" });
    dimThemeColor(true, metas);
    expect(content).toEqual(themeColorMetas("glass", "system", 2));
    dimThemeColor(false, metas);
    expect(content).toEqual({ light: "#bfbfbf", dark: "#0e0e0f" });
    applyLook({ look: "paper", theme: "dark" }, root, metas);
    expect(content).toEqual(themeColorMetas("paper", "dark", 1));
    dimThemeColor(false, metas);
    expect(content).toEqual({ light: "#262624", dark: "#262624" });
    // A stray second close never goes below none.
    dimThemeColor(false, metas);
    expect(content).toEqual({ light: "#262624", dark: "#262624" });
    applyLook({ look: "glass", theme: "system" }, root, metas);
  });

  test("every scrim of the page is ui/primitives.tsx's Scrim, which dims the metas as it shows and goes", () => {
    const own: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && readFileSync(p, "utf8").includes('className="scrim"')) own.push(p.slice(WEB.length + 1));
      }
    };
    walk(WEB);
    expect(own).toEqual(["ui/primitives.tsx"]);
    const prim = readFileSync(join(WEB, "ui", "primitives.tsx"), "utf8");
    expect(prim.match(/className="scrim"/g)?.length).toBe(1);
    expect(prim).toMatch(/export function Scrim[\s\S]*?dimThemeColor\(true\);\s*return \(\) => dimThemeColor\(false\);[\s\S]*?className="scrim"[\s\S]*?onClick\(\);/);
  });
});

describe("a way back of the page's own (a home-screen app has no browser Back)", () => {
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
  const state = (view: Partial<ViewPrefs> = {}) => resetState({ projects: structuredClone(PROJECTS), chats: [], ready: true, view: { ...DEFAULT_VIEW, ...view } });
  const bar = (path: string) => renderToStaticMarkup(createElement(TopBar, { route: parse(new URL(path, "http://127.0.0.1")) }));
  const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const P = PROJECTS[0]!;
  const SESSION = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
  const SIZES: [string, number, number, boolean][] = [
    ["phone", 390, 844, true],
    ["tablet", 834, 1194, true],
    ["laptop under 1,000 px", 900, 800, false],
    ["laptop", 1280, 800, false],
  ];

  test("the environment page and a session's preview: Back to the project, named by it, in the chats button's and the heading's place", () => {
    state();
    for (const [size, w, h, touch] of SIZES) {
      viewport(w, h, touch);
      for (const path of [`/p/${P.id}/environment`, `/p/${P.id}/session/${SESSION}`]) {
        const html = bar(path);
        const back = /<a [^>]*class="scr-bar-back"[^>]*>[\s\S]*?<\/a>/.exec(html)?.[0] ?? "";
        expect([size, path, /href="([^"]+)"/.exec(back)?.[1], text(back)]).toEqual([size, path, `/p/${P.id}`, P.name]);
        expect(back).toContain(`aria-label="Back to ${P.name}"`);
        expect([size, path, html.includes('aria-label="Chats"'), html.includes("scr-bar-heading")]).toEqual([size, path, false, false]);
      }
    }
  });

  test("opened from a chat in this page (its Details' Environment row, the refused start's Environment button): Back goes back to that chat", () => {
    const gh = globalThis as unknown as { history?: { state: unknown } };
    const ownHistory = !gh.history;
    const chat = CHATS.find((c) => c.projectId === P.id)!;
    resetState({ projects: structuredClone(PROJECTS), chats: structuredClone(CHATS), ready: true, view: { ...DEFAULT_VIEW } });
    const backOf = (path: string) => {
      const html = bar(path);
      const back = /<a [^>]*class="scr-bar-back"[^>]*>[\s\S]*?<\/a>/.exec(html)?.[0] ?? "";
      return { href: /href="([^"]+)"/.exec(back)?.[1] ?? null, text: text(back), aria: /aria-label="([^"]*)"/.exec(back)?.[1] ?? null };
    };
    const toChat = (from: string) => ({ href: from, text: "Chat", aria: `Back to ${chat.title}` });
    const toProject = { href: `/p/${P.id}`, text: P.name, aria: `Back to ${P.name}` };
    try {
      for (const [size, w, h, touch] of SIZES) {
        viewport(w, h, touch);
        for (const path of [`/p/${P.id}/environment`, `/p/${P.id}/session/${SESSION}`]) {
          // The entry behind, pushed by this page: the chat's Environment detail, its Details, the chat itself.
          for (const from of [`/c/${chat.id}/environment`, `/c/${chat.id}/details`, `/c/${chat.id}`, `/c/${chat.id}?view=verbose`]) {
            gh.history = { state: pushedState(null, from) };
            expect([size, path, from, backOf(path)]).toEqual([size, path, from, toChat(from)]);
          }
          // A direct link (no entry of this page behind), a trail from an earlier document, the project page, a
          // screen that is not a chat's, or a chat that is not in the list: Back to the project.
          const others: unknown[] = [null, { from: `/c/${chat.id}`, back: [`/c/${chat.id}`] }, pushedState(null, `/p/${P.id}`), pushedState(null, "/settings"), pushedState(null, "/c/zzzzzzzzzzzzzzzzzzzz"), pushedState(null, `/c/${chat.id}/archive`)];
          for (const st of others) {
            gh.history = { state: st };
            expect([size, path, st, backOf(path)]).toEqual([size, path, st, toProject]);
          }
        }
      }
    } finally {
      if (ownHistory) delete gh.history;
    }
  });

  test("with the docked sidebar hidden (row 82), Show sidebar keeps its place before the Back", () => {
    state({ sidebarHidden: true });
    viewport(1280, 800, false);
    const html = bar(`/p/${P.id}/environment`);
    expect(html).toMatch(/data-testid="sidebar-show"[\s\S]*class="scr-bar-back"/);
  });

  test("an unknown project shows Home there, so the bar keeps the chats button and has no Back", () => {
    state();
    viewport(390, 844, true);
    const html = bar("/p/zzzzzzzzzz/environment");
    expect(html).toContain('aria-label="Chats"');
    expect(html).not.toContain("scr-bar-back");
  });

  test("/search on the tablet has Back and its name, as on the phone; a laptop's bar has neither", () => {
    state();
    for (const [size, w, h, touch] of SIZES) {
      viewport(w, h, touch);
      const html = bar("/search");
      expect([size, text(html) === "Back Search"]).toEqual([size, w < 1000 && touch]);
    }
  });
});

describe("the safe areas of a home-screen app (the click-through's standalone flow found these; the browser's insets are 0)", () => {
  const css = (name: string) => readFileSync(join(WEB, "styles", name), "utf8");
  test("on the phone a page's last row and the search list's end above the home indicator", () => {
    expect(css("screens.css")).toContain('[data-size="phone"] .scr-col {\n  padding: var(--s4) max(var(--s3), env(safe-area-inset-right)) max(var(--s6), env(safe-area-inset-bottom)) max(var(--s3), env(safe-area-inset-left));');
    expect(css("search.css")).toContain(".touch .srch-list {\n  padding: 0 0 max(var(--s3), env(safe-area-inset-bottom));");
  });
  // The tablet (medium), and the large iPad (1366x1024 touch), which kitespan lays out as a laptop: there the sidebar,
  // the title bar and every column run to the top of the screen, so each starts below the top safe area.
  test("on the tablet and the large iPad the pane bar and each docked pane's head start below the status bar, level with the title bar's row", () => {
    const layout = css("layout.css");
    expect(layout).toContain(".shell-medium > .pane-bar,\n.touch .shell-laptop > .pane-bar {\n  padding-top: calc(var(--s2) + env(safe-area-inset-top));");
    expect(layout).toContain(
      ".shell-medium .side-pane .side-pane-head,\n.shell-medium .side-pane .term-head,\n.touch .shell-laptop .side-pane .side-pane-head,\n.touch .shell-laptop .side-pane .term-head,\n.touch .shell-laptop .side-col .term-head {\n  min-height: calc(var(--header-h) + env(safe-area-inset-top));\n  padding-top: env(safe-area-inset-top);",
    );
    // The search pane's head has a top padding of its own (search.css .srch-head, --s2 over the field): the inset is
    // added to it, so in a browser tab (inset 0) the field keeps its 8 px above it.
    expect(layout).toContain(
      ".shell-medium .side-pane .srch-head,\n.touch .shell-laptop .side-pane .srch-head,\n.touch .shell-laptop .side-col .srch-head {\n  min-height: calc(var(--header-h) + env(safe-area-inset-top));\n  padding-top: calc(var(--s2) + env(safe-area-inset-top));",
    );
    expect(css("search.css")).toMatch(/\n\.srch-head \{[^}]*\n {2}padding: var\(--s2\) var\(--s2\) var\(--s2\) var\(--s3\);/);
    // The title bar beside them grows by the same inset on touch.
    expect(css("screens.css")).toContain(".scr-bar-touch {\n  height: calc(var(--header-h) + env(safe-area-inset-top));");
    // A touch pane's width handle starts under the title bar, with its inset.
    expect(layout).toContain(".touch .pane-handle {\n  top: calc(var(--header-h) + env(safe-area-inset-top));");
  });
  test("on the large iPad the laptop's title bar, the sidebar (Hide sidebar with it), the cards in their column and the drawer start below the status bar", () => {
    const layout = css("layout.css");
    expect(layout).toContain(".touch .shell-laptop > .main-col > .scr-bar {\n  height: calc(var(--header-h) + env(safe-area-inset-top));\n  padding-top: env(safe-area-inset-top);");
    expect(layout).toContain(".touch .shell-laptop > .sidebar,\n.touch .shell-drawer {\n  padding-top: env(safe-area-inset-top);");
    expect(layout).toContain(".touch .shell-laptop .side-mode-column {\n  padding-top: calc(var(--s3) + env(safe-area-inset-top));");
    expect(css("panels.css")).toContain(".side-mode-column {\n  padding: var(--s3) var(--s3) var(--s5);");
    // Iteration 8: on touch Hide sidebar is a tool of the head's row, under the brand (screens.css), so it starts below
    // the status bar with the sidebar's own top padding.
    expect(layout).toContain(".touch .sidebar-hide {\n  position: static;");
    // A laptop's pointer has none of it: every rule above is under .touch (or the tablet's own shell).
    const blocks = [...layout.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[2]!.includes("safe-area-inset-top"));
    for (const m of blocks) for (const sel of m[1]!.split(/,(?![^(]*\))/)) expect([sel.trim(), /\.touch|\.shell-medium|\.shell-phone|:root/.test(sel)]).toEqual([sel.trim(), true]);
  });
  test("a laptop's bar Back (the environment page, a session's preview) is one of the bar's buttons: their corner, a hover that is not its press", () => {
    const screens = css("screens.css");
    const rule = (sel: string) => {
      const at = screens.indexOf(`\n${sel} {`);
      return at < 0 ? null : screens.slice(at, screens.indexOf("}", at));
    };
    const laptop = rule(".scr-bar:not(.scr-bar-touch) > .scr-bar-back");
    expect(laptop).toContain("border-radius: var(--r-btn);");
    // .btn ghost's: --hover under the pointer, --fill while pressed (base.css), so a press shows.
    expect(rule(".scr-bar:not(.scr-bar-touch) > .scr-bar-back:hover")).toContain("background: var(--hover);");
    const active = rule(".scr-bar:not(.scr-bar-touch) > .scr-bar-back:active");
    expect(active).toContain("background: var(--fill);");
    // The press is written after the hover with the same weight, so it wins while both match.
    expect(screens.indexOf(".scr-bar:not(.scr-bar-touch) > .scr-bar-back:active {")).toBeGreaterThan(screens.indexOf(".scr-bar:not(.scr-bar-touch) > .scr-bar-back:hover {"));
    // No hover anywhere wears a press's --fill.
    const hoverFill: string[] = [];
    for (const name of readdirSync(join(WEB, "styles")).filter((n) => n.endsWith(".css"))) {
      const text = css(name).replace(/\/\*[\s\S]*?\*\//g, "");
      for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) if (m[1]!.includes(":hover") && /var\(--fill\)/.test(m[2]!)) hoverFill.push(`${name}: ${m[1]!.trim()}`);
    }
    expect(hoverFill).toEqual([]);
  });
  test("the tablet's composer ends above the home indicator, as the waiting card in its place does (the phone's has its own)", () => {
    expect(css("composer.css")).toMatch(/\n\.cmp \{[^}]*\n {2}padding: var\(--s2\) var\(--s5\) max\(var\(--s4\), env\(safe-area-inset-bottom\)\);\n/);
    expect(css("chat.css")).toContain(".chat-dock {\n  padding: var(--s2) 0 var(--s4);\n  padding-bottom: max(var(--s4), env(safe-area-inset-bottom));");
    expect(css("composer.css")).toContain(".cmp.is-phone {\n  max-width: calc(var(--measure) + 2 * var(--s3));\n  padding: 0 var(--s3) max(var(--s3), env(safe-area-inset-bottom));");
  });
});
