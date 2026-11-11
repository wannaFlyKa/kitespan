// U5 (FIX-U5 1 and 2, DESIGN-U5 8 and 11): the Messages group as the search pane draws it, with React's server
// renderer: the group last with its heading; a chat's first row with its title, Archived for an archived chat, and
// when, then its line (the snippet) with the matched words in bold as text children (never HTML) and dir="auto"; the
// user's own line starts with a quiet "You: " (Claude's replies have none), and the row's name says it too; the
// project in the row's name and, on a laptop, its tooltip; a follow-up row of the same chat is its line alone, named
// with a hidden "<title>: "; the slow line inside the list (hidden there) with its words in a status outside the list;
// "Nothing matches <q>." only once the Messages answer came (or none was due); "Messages could not be searched." only
// when the ask failed and nothing else shows; the field's words in a chat and on /search.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parse } from "../../web/router";
import { resetState } from "../../web/state/store";
import type { Chat } from "../../web/state/types";
import { SearchPane, NOTHING_MATCHES, MESSAGES_FAILED, SEARCHING_MESSAGES, YOU_PREFIX, messageRowName } from "../../web/search/SearchPane";
import { askMaker, forgetKept, type AskSnapshot, type MessageHit } from "../../web/search/messages";
import { corpusKey, openCorpus, resetCorpora } from "../../web/search/corpus";
import { CHATS, PROJECTS, UPLOADS } from "./fixtures";

const CHAT = "demoolxxxxxxxxxxxxxx";
const IDLE = "idleo6xxxxxxxxxxxxxx";
const FAILED = "failloxxxxxxxxxxxxxx";
const WEB = join(import.meta.dir, "..", "..", "web");
const at = (u: string) => parse(new URL(u, "http://127.0.0.1"));

const gm = globalThis as unknown as { matchMedia?: unknown; window?: unknown };
const own = { mm: !gm.matchMedia, win: !gm.window };
let coarse = false;
function viewport(width: number, height: number, touch: boolean) {
  coarse = touch;
  gm.window = { innerWidth: width, innerHeight: height, addEventListener() {}, removeEventListener() {} };
}
const make = askMaker.make;
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
afterEach(() => {
  askMaker.make = make;
  forgetKept();
  resetCorpora();
  viewport(1100, 800, false);
});

function state(chats: Chat[] = CHATS) {
  resetState({ projects: structuredClone(PROJECTS), chats, uploads: structuredClone(UPLOADS), ready: true });
}
async function corpus(paths: string[]) {
  const reply = { v: "v1", source: "git", complete: true, total: paths.length, chars: 0, paths };
  const folder = PROJECTS.find((p) => p.id === CHATS.find((c) => c.id === CHAT)!.projectId)!.folder;
  await openCorpus(CHAT, coarse, { fetcher: (async () => new Response(JSON.stringify(reply), { status: 200 })) as unknown as typeof fetch, later: (run) => run() }, corpusKey(CHAT, folder));
}
/** The pane's ask as a fixed state (the server renderer runs no effect, so nothing is asked). */
function asked(snap: Partial<AskSnapshot>) {
  const s: AskSnapshot = { q: "", on: true, hits: null, answered: false, settled: false, slow: false, failed: false, ...snap };
  askMaker.make = () => ({ set() {}, warm() {}, close() {}, subscribe: () => () => {}, snapshot: () => s });
}
const pane = (path: string, chat: Chat | null = null, place: "column" | "screen" | "pane" = chat ? "column" : "screen") => renderToStaticMarkup(createElement(SearchPane, { route: at(path), chat, place }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const group = (html: string, kind: string) => {
  const i = html.indexOf(`data-kind="${kind}" data-count`);
  if (i < 0) return "";
  const j = html.indexOf('role="group"', i + 1);
  return html.slice(i, j < 0 ? undefined : j);
};
/** A hit whose ranges mark these words in its snippet (each word's first place). */
const hit = (chat: string, message: string, by: MessageHit["by"], snippet: string, ...words: string[]): MessageHit => ({
  chat,
  message,
  by,
  snippet,
  ranges: words.map((w): [number, number] => [snippet.indexOf(w), snippet.indexOf(w) + w.length]).sort((a, b) => a[0] - b[0]),
});
const HITS = [
  hit(IDLE, "m_1", "agent", "…the server keeps only the text in memory, with a cap", "memory", "cap"),
  hit(IDLE, "m_2", "user", "what happens at the memory cap when", "memory", "cap"),
  hit(FAILED, "m_3", "user", "a cap on the memory <b>x</b>", "cap", "memory"),
];

describe("the rows (DESIGN-U5 8)", () => {
  test("Messages is the last group, headed when another group shows; a chat's first row: title, Archived, when, then the line", () => {
    state(CHATS.map((c) => (c.id === FAILED ? { ...c, archived: true } : c)));
    asked({ q: "memory cap", hits: HITS, answered: true, settled: true });
    const html = pane("/search?q=memory%20cap");
    const kinds = [...html.matchAll(/role="group" aria-label="([^"]+)" data-kind="(\w+)"/g)].map((m) => m[2]);
    expect(kinds[kinds.length - 1]).toBe("messages");
    expect(html).toContain('role="group" aria-label="Messages" data-kind="messages"');
    const g = group(html, "messages");
    const rows = [...g.matchAll(/<div id="[^"]+" role="option"[\s\S]*?(?=<div id="[^"]+" role="option"|$)/g)].map((m) => m[0]);
    expect(rows).toHaveLength(3);
    const first = rows[0]!;
    expect(first).toContain('data-kind="messages"');
    expect(first).toMatch(/<span class="srch-msg-head"><span class="srch-title">Summarize the server logs<\/span>/);
    expect(first).toMatch(/<span class="srch-when">(now|\d+ (min|h|d))<\/span>/);
    expect(first).not.toContain("srch-tag");
    // The line: the snippet as text with bold runs, in its own direction; Claude's reply has no speaker word.
    expect(first).toContain('<span class="srch-snippet" dir="auto">…the server keeps only the text in <strong class="srch-hit">memory</strong>, with a <strong class="srch-hit">cap</strong></span>');
    expect(first).not.toContain("srch-who");
    // Its name: every part in order with a comma between each, the project included.
    expect(first).toMatch(/aria-label="Summarize the server logs, scratch, (now|\d+ (min|h|d)), …the server keeps only the text in memory, with a cap"/);
    // A follow-up row of the same chat: its line alone, named with the chat's title first; the user's own line starts
    // with "You: ", in a left-to-right span of its own (so the line's dir="auto" still takes the message's direction).
    expect(rows[1]).toContain("srch-more");
    expect(rows[1]).not.toContain("srch-msg-head");
    expect(rows[1]).toContain('<span class="srch-snippet" dir="auto"><span class="srch-who" dir="ltr">You: </span>what happens at the <strong class="srch-hit">memory</strong> <strong class="srch-hit">cap</strong> when</span>');
    expect(rows[1]).toContain('aria-label="Summarize the server logs: You: what happens at the memory cap when"');
    expect(rows[1]).not.toContain("visually-hidden");
    // An archived chat: the word Archived before the time, and in the name; the user's line with its word.
    expect(rows[2]).toMatch(/<span class="srch-title">Update the date library<\/span><span class="srch-tag">Archived<\/span><span class="srch-when">/);
    expect(rows[2]).toContain('<span class="srch-who" dir="ltr">You: </span>a <strong class="srch-hit">cap</strong>');
    expect(rows[2]).toMatch(/aria-label="Update the date library, scratch, Archived, (now|\d+ (min|h|d)), You: a cap on the memory &lt;b&gt;x&lt;\/b&gt;"/);
    // The word is drawn before the line's text, never inside a bold run.
    expect(g).not.toMatch(/<strong[^>]*>[^<]*You:/);
  });

  test("a row's name: its parts with a comma between each; a later row's: the chat's title, a colon, the line", () => {
    expect(messageRowName("Fix the flaky upload test", "…Next I will run the upload test 20 times.", "agent", { project: "kitespan", archived: false, when: "now" })).toBe("Fix the flaky upload test, kitespan, now, …Next I will run the upload test 20 times.");
    expect(messageRowName("Preview tiles", "…a cap on the memory", "agent", { project: "scratch", archived: true, when: "3 d" })).toBe("Preview tiles, scratch, Archived, 3 d, …a cap on the memory");
    expect(messageRowName("A chat", "the line", "agent", { project: undefined, archived: false, when: "2 h" })).toBe("A chat, 2 h, the line");
    expect(messageRowName("A chat", "the second line", "agent", null)).toBe("A chat: the second line");
  });

  test("the user's own line: its name says You before the line, as the row shows it; Claude's says no speaker", () => {
    expect(YOU_PREFIX).toBe("You: ");
    expect(messageRowName("Fix the flaky upload test", "Run the upload test 20 times.", "user", { project: "kitespan", archived: false, when: "now" })).toBe("Fix the flaky upload test, kitespan, now, You: Run the upload test 20 times.");
    expect(messageRowName("Preview tiles", "…a cap on the memory", "user", { project: "scratch", archived: true, when: "3 d" })).toBe("Preview tiles, scratch, Archived, 3 d, You: …a cap on the memory");
    expect(messageRowName("A chat", "the second line", "user", null)).toBe("A chat: You: the second line");
    // The two lines of the review's finding no longer read alike.
    const said = messageRowName("Fix the flaky upload test", "Run the upload test 20 times.", "user", null);
    const replied = messageRowName("Fix the flaky upload test", "Run the upload test 20 times.", "agent", null);
    expect(said).not.toBe(replied);
  });

  test("on touch the user's line has its word too", () => {
    state();
    viewport(390, 844, true);
    asked({ q: "memory cap", hits: HITS.slice(1, 2), answered: true, settled: true });
    const g = group(pane("/search?q=memory%20cap"), "messages");
    expect(g).toContain('<span class="srch-who" dir="ltr">You: </span>what happens');
    expect(g).toContain('aria-label="Summarize the server logs, scratch, ');
    expect(g).toContain(", You: what happens at the memory cap when");
  });

  test("the project is in the row's name and, on a laptop, its tooltip; touch has no tooltip", () => {
    state();
    asked({ q: "memory cap", hits: HITS.slice(0, 1), answered: true, settled: true });
    const laptop = group(pane("/search?q=memory%20cap"), "messages");
    expect(laptop).toContain('title="Summarize the server logs, scratch"');
    expect(laptop).toContain('aria-label="Summarize the server logs, scratch, ');
    expect(laptop).not.toContain("srch-project");
    viewport(390, 844, true);
    const phone = group(pane("/search?q=memory%20cap"), "messages");
    expect(phone).not.toContain("title=");
    expect(phone).toContain('aria-label="Summarize the server logs, scratch, ');
  });

  test("a snippet's markup is text: <b> in a message shows as those characters", () => {
    state();
    asked({ q: "memory cap", hits: HITS.slice(2), answered: true, settled: true });
    const g = group(pane("/search?q=memory%20cap"), "messages");
    expect(g).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(g).not.toContain("<b>");
  });

  test("Messages rows are options of the one listbox: the active row and the arrows run over them after the others", () => {
    state();
    asked({ q: "summarize", hits: HITS.slice(0, 1), answered: true, settled: true });
    const html = pane("/search?q=summarize");
    const options = [...html.matchAll(/role="option" aria-selected="(true|false)"[^>]*data-kind="(\w+)"/g)].map((m) => [m[1], m[2]]);
    expect(options).toEqual([
      ["true", "chats"],
      ["false", "messages"],
    ]);
    // Two groups: each has its heading, Messages' after Chats'.
    expect([...html.matchAll(/<div class="srch-group-title" role="presentation" aria-hidden="true">(\w+)<\/div>/g)].map((m) => m[1])).toEqual(["Chats", "Messages"]);
  });

  test("in a chat's pane the Chats scope keeps Messages; the Files scope draws none", async () => {
    state();
    await corpus(["docs/memory-cap.md"]);
    const chat = CHATS.find((c) => c.id === CHAT)!;
    asked({ q: "memory cap", hits: HITS, answered: true, settled: true });
    expect(pane(`/c/${CHAT}/search?q=memory%20cap&scope=chats`, chat)).toContain('data-kind="messages" data-count');
    expect(pane(`/c/${CHAT}/search?q=memory%20cap&scope=files`, chat)).not.toContain('data-kind="messages"');
  });
});

describe("the states (DESIGN-U5 8)", () => {
  test("slow: the line inside the list after the groups, hidden there, and its words in a status outside the listbox", () => {
    state();
    asked({ q: "memory cap", slow: true });
    const html = pane("/search?q=memory%20cap");
    expect(SEARCHING_MESSAGES).toBe("Searching messages…");
    expect(html).toContain(`<div class="srch-wait" aria-hidden="true">${SEARCHING_MESSAGES}</div>`);
    expect(html).toContain(`<p class="visually-hidden" role="status">${SEARCHING_MESSAGES}</p>`);
    // In the list after the groups; the status after the list's end (a listbox holds options only).
    const list = html.indexOf('role="listbox"');
    const wait = html.indexOf('<div class="srch-wait"');
    const status = html.indexOf('<p class="visually-hidden" role="status">');
    expect(list).toBeGreaterThan(-1);
    expect(wait).toBeGreaterThan(list);
    expect(html.slice(wait).indexOf("</div></div>")).toBeLessThan(html.slice(wait).indexOf('role="status"'));
    expect(status).toBeGreaterThan(wait);
    // No "Nothing matches" while Messages is still asked.
    expect(html).not.toContain("search-empty");
  });

  test("Nothing matches only once the Messages answer for q came, or when no ask was due", () => {
    state();
    asked({ q: "zzqxw", hits: null, answered: false });
    expect(pane("/search?q=zzqxw")).not.toContain("search-empty");
    asked({ q: "zzqxw", hits: [], answered: true, settled: true });
    expect(text(pane("/search?q=zzqxw"))).toContain(NOTHING_MATCHES("zzqxw"));
    // An answer that is not whole, with asks again to come: not yet.
    asked({ q: "zzqxw", hits: [], answered: true, settled: false });
    expect(pane("/search?q=zzqxw")).not.toContain("search-empty");
    // Under the minimum, nothing is asked: the line comes with the other groups, as before.
    asked({ q: "j", on: false });
    expect(text(pane("/search?q=j"))).toContain(NOTHING_MATCHES("j"));
    // An answer for an older query is not this one's.
    asked({ q: "zzqx", hits: [], answered: true, settled: true });
    expect(pane("/search?q=zzqxw")).not.toContain("search-empty");
  });

  test("a failed ask: its line only when nothing else shows; with other rows, nothing more", () => {
    state();
    asked({ q: "zzqxw", failed: true });
    const none = pane("/search?q=zzqxw");
    expect(MESSAGES_FAILED).toBe("Messages could not be searched.");
    expect(text(none)).toContain(MESSAGES_FAILED);
    expect(text(none)).not.toContain(NOTHING_MATCHES("zzqxw"));
    asked({ q: "summarize", failed: true });
    const some = pane("/search?q=summarize");
    expect(text(some)).not.toContain(MESSAGES_FAILED);
    expect(some).toContain('data-kind="chats"');
  });
});

describe("the field's words (DESIGN-U5 8, 11)", () => {
  test("in a chat: the placeholder Search, the name with messages; on /search both are Search chats and messages", () => {
    state();
    const chat = CHATS.find((c) => c.id === CHAT)!;
    const inChat = pane(`/c/${CHAT}/search`, chat);
    expect(inChat).toContain('aria-label="Search chats, messages, files and commands"');
    expect(inChat).toContain('placeholder="Search"');
    const page = pane("/search");
    expect(page).toContain('aria-label="Search chats and messages"');
    expect(page).toContain('placeholder="Search chats and messages"');
  });
});

describe("the style sheet: tokens only, one line per row on a laptop, 44 px on touch", () => {
  const css = readFileSync(join(WEB, "styles", "search.css"), "utf8");
  test("the line in --dim at the small size (the UI size on touch), its words in --text; one line with an ellipsis", () => {
    // The speaker word has no rule of its own: it takes the line's --dim (and, on a laptop's active row, the row's
    // colour with the line), and it is not bold.
    expect(css.replace(/\/\*[\s\S]*?\*\//g, "")).not.toContain(".srch-who");
    expect(css).toMatch(/\.srch-snippet \{[^}]*white-space: nowrap;[^}]*\}/);
    expect(css).toMatch(/\.srch-snippet \{[^}]*text-overflow: ellipsis;[^}]*\}/);
    expect(css).toMatch(/\.srch-snippet \{[^}]*color: var\(--dim\);[^}]*font-size: var\(--fs-small\);[^}]*\}/);
    expect(css).toMatch(/\.srch-snippet \.srch-hit \{\n  color: var\(--text\);\n\}/);
    expect(css).toMatch(/\.touch \.srch-snippet,[^{]*\{\n  font-size: var\(--fs-ui\);/);
    expect(css).toMatch(/\.srch-when,\n\.srch-tag \{[^}]*font-variant-numeric: tabular-nums;/);
  });
  test("on a laptop's active row every part takes the row's colour; a follow-up row has no height of its own there, 44 px and no hairline on touch", () => {
    expect(css).toContain('body:not(.touch) .menu-row.srch-row:is(:hover, :focus-visible, [data-active="true"]) :is(.srch-dir, .srch-project, .srch-icon, .srch-snippet, .srch-snippet .srch-hit, .srch-when, .srch-tag) {');
    expect(css).toMatch(/body:not\(\.touch\) \.menu-row\.srch-more \{\n  min-height: 0;/);
    expect(css).toMatch(/\.touch \.menu-row\.srch-more \{[^}]*box-shadow: none;[^}]*\}/);
    expect(css).not.toMatch(/\.touch \.menu-row\.srch-more \{[^}]*min-height/);
  });
  test("on touch every line of a chat is 44 px from the next: a follow-up's line in its middle, the first row's line half the rest above its end", () => {
    expect(css).toMatch(/\.touch \.menu-row\.srch-more \{[^}]*justify-content: center;[^}]*padding-top: 0;[^}]*padding-bottom: 0;[^}]*\}/);
    expect(css).toContain(".touch .menu-row.srch-messages:not(.srch-more):has(+ .srch-more) {\n  padding-bottom: calc((var(--touch) - var(--fs-ui) * var(--lh-ui)) / 2);\n}");
  });
});
