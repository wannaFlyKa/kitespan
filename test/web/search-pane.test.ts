// The search pane as it draws (DESIGN.md 9.3, 6.7, 7.2, 7.3; BUILD-CHECKLIST C4, D3), with React's server renderer:
// the field (a text combobox over a listbox), the list's root with the query its rows answer and their true count, at
// most 120 rows, the matched letters in bold as text children, three groups (the uploads inside Files), a group
// heading only when two groups have rows, the
// scope control only with two kinds, one line when nothing matches and none before the file list came, no count and
// no helper line; and where Shell draws it: the laptop's column, the tablet's docked pane with the bar's Search lit,
// the phone's own page over the chat with Back "Chat" and "Search" in the bar, and the phone's /chats bar's Search.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parse } from "../../web/router";
import { resetState } from "../../web/state/store";
import type { Chat } from "../../web/state/types";
import { SearchPane, NOTHING_MATCHES } from "../../web/search/SearchPane";
import { Shell } from "../../web/layout/Shell";
import { TopBar } from "../../web/layout/TopBar";
import { corpusKey, openCorpus, resetCorpora } from "../../web/search/corpus";
import { askMaker } from "../../web/search/messages";
import { CHATS, PROJECTS, UPLOADS } from "./fixtures";

const CHAT = "demoolxxxxxxxxxxxxxx";
const at = (u: string) => parse(new URL(u, "http://127.0.0.1"));
const WEB = join(import.meta.dir, "..", "..", "web");

const gm = globalThis as unknown as { matchMedia?: unknown; window?: unknown };
const own = { mm: !gm.matchMedia, win: !gm.window };
let coarse = false;
function viewport(width: number, height: number, touch: boolean) {
  coarse = touch;
  gm.window = { innerWidth: width, innerHeight: height, addEventListener() {}, removeEventListener() {} };
}
beforeAll(() => {
  gm.matchMedia = (q: string) => ({ matches: coarse && q === "(pointer: coarse)", addEventListener() {}, removeEventListener() {} });
  viewport(1100, 800, false);
});
afterAll(() => {
  if (own.mm) delete gm.matchMedia;
  if (own.win) delete gm.window;
  resetState();
  resetCorpora();
});
afterEach(() => resetCorpora());

const withCommands = (): Chat[] =>
  CHATS.map((c) =>
    c.id === CHAT
      ? {
          ...c,
          commands: [
            { name: "compact", description: "Clear the history but keep a summary", argumentHint: "", aliases: [], builtin: true, terminalOnly: false },
            { name: "review-notes", description: "A command of the user's own", argumentHint: "[file]", aliases: ["rn"], builtin: false, terminalOnly: false },
          ],
        }
      : c,
  );

function state(chats: Chat[] = withCommands()) {
  resetState({ projects: structuredClone(PROJECTS), chats, uploads: structuredClone(UPLOADS), ready: true });
}

/** A page copy of the chat folder's list, as the corpus read leaves it (kept under the folder, as the pane reads it). */
async function corpus(paths: string[]) {
  const reply = { v: "v1", source: "git", complete: true, total: paths.length, chars: 0, paths };
  const folder = PROJECTS.find((p) => p.id === CHATS.find((c) => c.id === CHAT)!.projectId)!.folder;
  await openCorpus(CHAT, coarse, { fetcher: (async () => new Response(JSON.stringify(reply), { status: 200 })) as unknown as typeof fetch, later: (run) => run() }, corpusKey(CHAT, folder));
}

const pane = (path: string, place: "column" | "pane" | "over" | "page" | "screen" = "column", chat: Chat | null = null) =>
  renderToStaticMarkup(createElement(SearchPane, { route: at(path), chat, place }));
const chatOf = (id = CHAT) => withCommands().find((c) => c.id === id)!;
const attr = (html: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(html)?.[1];
const count = (html: string, s: string) => html.split(s).length - 1;
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("the field and the list (C4)", () => {
  test("a text combobox (never type=search) over a listbox, with no autocorrect, 16 px from the look's --fs-input", () => {
    state();
    const html = pane("/search?q=flaky", "screen");
    expect(html).toMatch(/<input[^>]*type="text"[^>]*role="combobox"/);
    expect(html).not.toContain('type="search"');
    for (const a of ['autoComplete="off"', 'autoCapitalize="none"', 'autoCorrect="off"', 'spellCheck="false"', 'aria-autocomplete="list"'])
      expect(html.toLowerCase()).toContain(a.toLowerCase());
    const list = attr(html, "aria-controls");
    expect(html).toContain(`id="${list}" role="listbox"`);
    expect(attr(html, "aria-activedescendant")).toBe(`${list}-0`);
    expect(html).toMatch(/role="option" aria-selected="true"[^>]*data-active="true"/);
    expect(readFileSync(join(WEB, "styles", "search.css"), "utf8")).toMatch(/\.srch-field \{[^}]*font-size: var\(--fs-input\)/);
  });

  test("the list's root carries the query its rows answer and their true count; the matched letters are bold text", () => {
    state();
    const html = pane("/search?q=flaky", "screen");
    expect(attr(html, "data-q")).toBe("flaky");
    expect(attr(html, "data-count")).toBe("1");
    expect(html).toContain('<strong class="srch-hit">');
    expect(html.replace(/<[^>]+>/g, "")).toContain("Fix the flaky upload test, Needs input");
    // One group: no heading. No count, no helper line, no key hints.
    expect(html).not.toContain("srch-group-title");
    expect(text(html)).not.toMatch(/\b1 result|results|Enter|↑|↓|Esc/);
  });

  test("/search finds chats by title only, the archived ones left out; no scope control and no close button there", () => {
    state(withCommands().map((c) => (c.title === "Plan the search index" ? { ...c, archived: true } : c)));
    const html = pane("/search?q=search", "screen");
    expect(text(html)).not.toContain("Plan the search index");
    expect(html).not.toContain('role="radiogroup"');
    expect(html).not.toContain('data-testid="search-close"');
  });

  test("one line when nothing matches, in the / menu's form; nothing before the query is typed", () => {
    state();
    // U5: the line waits for the Messages answer for the query too (test/web/search-text-pane.test.ts): here it came, empty.
    const made = askMaker.make;
    askMaker.make = () => ({ set() {}, warm() {}, close() {}, subscribe: () => () => {}, snapshot: () => ({ q: "zzqx", on: true, hits: [], answered: true, settled: true, slow: false, failed: false }) });
    let none: string;
    try {
      none = pane("/search?q=zzqx", "screen");
    } finally {
      askMaker.make = made;
    }
    expect(text(none)).toContain(NOTHING_MATCHES("zzqx"));
    expect(NOTHING_MATCHES("zzqx")).toBe("Nothing matches zzqx.");
    expect(pane("/search", "screen")).not.toContain("search-empty");
  });

  test("in a chat, before the file list came, no line even when nothing else matches", () => {
    state();
    const html = pane(`/c/${CHAT}/search?q=zzqx`, "column", chatOf());
    expect(html).not.toContain("search-empty");
    expect(attr(html, "data-count")).toBe("0");
  });

  test("in a chat: chats, files (the folder's, then the uploads) and commands, each group headed, the scope control with the kinds here, none on", async () => {
    state();
    viewport(1100, 800, false);
    await corpus(["web/composer/Composer.tsx", "docs/flaky-notes.md", "a/b/c/run.log"]);
    const html = pane(`/c/${CHAT}/search`, "column", chatOf());
    expect([...html.matchAll(/data-kind="(chats|files|uploads|commands)" data-count/g)].map((m) => m[1])).toEqual(["chats", "files", "commands"]);
    expect(count(html, 'class="srch-group-title"')).toBe(3);
    expect(html).not.toContain(">Uploads<");
    // The uploads are rows of Files, after the folder's files.
    const filesGroup = html.slice(html.indexOf('data-kind="files" data-count'), html.indexOf('data-kind="commands" data-count'));
    expect([...filesGroup.matchAll(/data-kind="(files|uploads)" data-testid="search-row"/g)].map((m) => m[1])).toEqual(["files", "files", "files", "uploads", "uploads"]);
    expect(html).toContain('role="radiogroup" aria-label="Show only"');
    for (const id of ["search-scope-chats", "search-scope-files", "search-scope-commands"]) expect(html).toContain(id);
    expect(html).not.toContain('aria-checked="true"');
    expect(html).toContain('data-none="true"');
    expect(html).toContain('data-testid="search-close"');
    // The file row: the folder part dimmed before the name.
    expect(html).toMatch(/<span class="srch-dir"><bdi>web\/composer\/<\/bdi><\/span><span class="srch-name" dir="auto">Composer.tsx<\/span>/);
    // The command row is the / menu's.
    expect(html).toContain('<span class="cmp-slash-name">/<span dir="auto">compact</span></span>');
  });

  test("a file deep in a folder: the highlight is on its name (D189); the files scope keeps the files and the uploads", async () => {
    state();
    await corpus(["web/composer/Composer.tsx", "server/compose.ts"]);
    const html = pane(`/c/${CHAT}/search?q=comp&scope=files`, "column", chatOf());
    expect([...html.matchAll(/data-kind="(chats|files|uploads|commands)" data-count/g)].map((m) => m[1])).toEqual(["files"]);
    expect(html).toContain('<span class="srch-name" dir="auto"><strong class="srch-hit">Comp</strong>oser.tsx</span>');
    expect(html).toMatch(/aria-checked="true"[^>]*data-value="files"/);
  });

  test("at most 120 rows, with the true count", async () => {
    state();
    await corpus(Array.from({ length: 5_000 }, (_, i) => `src/part${i}/item${i}.ts`));
    const html = pane(`/c/${CHAT}/search?q=item&scope=files`, "column", chatOf());
    expect(count(html, 'role="option"')).toBe(120);
    expect(attr(html, "data-count")).toBe("5000");
  });

  test("an archived chat's pane offers no command", () => {
    state();
    const html = pane(`/c/${CHAT}/search?q=compact`, "column", { ...chatOf(), archived: true });
    expect(html).not.toContain('data-kind="commands"');
  });

  test("no HTML from a name: the search files build no markup from strings", () => {
    for (const f of readdirSync(join(WEB, "search"))) {
      const src = readFileSync(join(WEB, "search", f), "utf8");
      expect([f, /innerHTML|dangerouslySetInnerHTML/.test(src)]).toEqual([f, false]);
    }
  });
});

describe("where Shell draws it (5.3, D3)", () => {
  const shell = (path: string) => {
    const route = at(path);
    const chat = withCommands().find((c) => c.id === CHAT)!;
    return renderToStaticMarkup(createElement(Shell, { route, chat, side: () => createElement("div", { "data-testid": "side-panel" }), children: createElement("div", { className: "chat-screen" }) }));
  };
  afterEach(() => viewport(1100, 800, false));

  test("a laptop at 1100 px: the side panel's column, the pane in it, not the cards", () => {
    state();
    viewport(1100, 800, false);
    const html = shell(`/c/${CHAT}/search`);
    expect(html).toContain('class="side-col srch-col"');
    expect(html).toContain('data-place="column"');
    expect(html).not.toContain('data-testid="side-panel"');
  });

  test("a laptop at 1,040 px: over the chat, with the pane bar's Search lit and Details not", () => {
    state();
    viewport(1040, 800, false);
    const html = shell(`/c/${CHAT}/search`);
    expect(html).toContain('data-side="over"');
    expect(html).toContain('data-place="over"');
    expect(html).toMatch(/class="pane-bar-btn on"[^>]*aria-label="Search"[^>]*aria-current="page"/);
    expect(html).not.toMatch(/class="pane-bar-btn on"[^>]*aria-label="Details"/);
  });

  test("a tablet: the docked pane from the bar's Search, which shows its name and is lit; no title in the pane", () => {
    state();
    viewport(834, 1194, true);
    const html = shell(`/c/${CHAT}/search`);
    expect(html).toContain('data-side="pane"');
    expect(html).toContain('data-place="pane"');
    expect(html).toMatch(/class="pane-bar-btn on"[^>]*aria-current="page"[^>]*>.*?<span class="pane-bar-name">Search<\/span>/);
    expect(html).not.toContain("srch-group-title\">Search");
    // Elsewhere the bar's Search opens the chat's pane.
    expect(shell(`/c/${CHAT}`)).toContain(`href="/c/${CHAT}/search"`);
  });

  test("the phone: its own page over the chat (mounted, hidden), Back \"Chat\" and \"Search\" in the bar, no sheet", () => {
    state();
    viewport(390, 844, true);
    const html = shell(`/c/${CHAT}/search`);
    expect(html).toContain('data-search="page"');
    expect(html).toContain('data-place="page"');
    expect(html).toContain('class="chat-screen"');
    expect(html).not.toContain('data-testid="side-panel"');
    expect(text(html)).toMatch(/^Chat Search/);
    expect(readFileSync(join(WEB, "styles", "search.css"), "utf8")).toContain('.shell-phone[data-search="page"] > .main > .chat-screen {\n  display: none;');
  });

  test("the phone's /chats bar: Search beside New; /search has Back and its name", () => {
    state();
    viewport(390, 844, true);
    const chats = renderToStaticMarkup(createElement(TopBar, { route: at("/chats") }));
    expect(chats).toMatch(/href="\/search"[^>]*aria-label="Search".*aria-label="New"/);
    expect(chats).not.toContain('title="Search');
    const search = renderToStaticMarkup(createElement(TopBar, { route: at("/search") }));
    expect(text(search)).toBe("Back Search");
  });
});

describe("the style sheet (plan v3: tokens only)", () => {
  test("search.css holds no literal colour, radius, font or font size in px or rem", () => {
    const css = readFileSync(join(WEB, "styles", "search.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const bad: string[] = [];
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g))
      for (const decl of m[2]!.split(";")) {
        const i = decl.indexOf(":");
        if (i < 0) continue;
        const prop = decl.slice(0, i).trim();
        const value = decl.slice(i + 1).trim();
        const v = value.replace(/var\([^)]*\)/g, "");
        if (/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\b(white|black)\b/i.test(v)) bad.push(`${prop}: ${value}`);
        if (/radius/.test(prop) && !/var\(--r-/.test(value) && /\d/.test(v)) bad.push(`${prop}: ${value}`);
        if ((prop === "font-family" || prop === "font") && !/^var\(--font-|^inherit$/.test(value)) bad.push(`${prop}: ${value}`);
        if (prop === "font-size" && /\d(px|rem)\b/.test(v)) bad.push(`${prop}: ${value}`);
      }
    expect(bad).toEqual([]);
  });
  test("the matched letters are bold in the row's own colour; the dimmed parts give way under the glass look's highlight", () => {
    const css = readFileSync(join(WEB, "styles", "search.css"), "utf8");
    expect(css).toMatch(/\.srch-hit \{\n  font-weight: var\(--weight-strong\);\n\}/);
    expect(css.replace(/\/\*[\s\S]*?\*\//g, "")).not.toContain("--accent-text");
    expect(css).toContain('body:not(.touch) .menu-row.srch-row:is(:hover, :focus-visible, [data-active="true"]) :is(.srch-dir');
  });
});
