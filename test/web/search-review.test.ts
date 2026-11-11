// The search pane after its review (iteration 3, area PANE): Enter waits for the list of the field's query; an upload
// matches by its name, never by the host folders of its path; a query that starts with `/` puts the commands first;
// three groups (the uploads inside Files, 6.7); the file hits and the sorted chats are kept between keys; the server is
// asked with the field's query while the rows follow the deferred one; a scope with no files scans none; one corpus
// per folder, so a second chat of the same project sends the v it holds; Esc gives the focus back; the list rides the
// on-screen keyboard; the matched letters bold in the text colour; /search full width on a tablet; and a list whose
// flex basis is 0, so a relayout never measures its rows' content height.
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Searcher } from "../../shared/match";
import type { CorpusReply, CorpusSearchReply } from "../../shared/corpus";
import { parse } from "../../web/router";
import { resetState } from "../../web/state/store";
import type { Chat, Upload } from "../../web/state/types";
import type { MenuRow } from "../../web/composer/draft";
import * as sections from "../../web/search/sections";
import * as corpusMod from "../../web/search/corpus";
import * as focusMod from "../../web/search/focus";
import { createFileEngine, type FileRows } from "../../web/search/engine";
import { SearchPane } from "../../web/search/SearchPane";
import { CHATS, COMMANDS, PROJECTS, UPLOADS } from "./fixtures";

const { searchSections, flatRows } = sections;
const { openCorpus, corpusOf, resetCorpora } = corpusMod;

const CHAT = "demoolxxxxxxxxxxxxxx";
/** A second chat of the same project (kitespanxx, folder ~/src/kitespan). */
const SIBLING = "asko2xxxxxxxxxxxxxxx";
const FOLDER = PROJECTS.find((p) => p.id === "kitespanxx")!.folder;
const WEB = join(import.meta.dir, "..", "..", "web");
const css = () => readFileSync(join(WEB, "styles", "search.css"), "utf8");
const src = (...p: string[]) => readFileSync(join(WEB, ...p), "utf8");

const files = (q: string, paths: string[], count = paths.length): FileRows => ({
  q,
  count,
  rows: paths.map((path) => ({ path, nameStart: path.lastIndexOf("/") + 1, nameRanges: [] })),
});
type Input = Parameters<typeof searchSections>[0];
const input = (over: Partial<Input>): Input => ({ q: "", scope: null, chats: [], files: null, uploads: [], commands: null, ...over });
const upload = (name: string, path: string, id = `up_${name}`): Upload => ({ ...UPLOADS[CHAT]![0]!, id, name, path, dir: path.slice(0, path.lastIndexOf("/")) });

const gm = globalThis as unknown as { matchMedia?: unknown; window?: unknown };
const own = { mm: !gm.matchMedia, win: !gm.window };
beforeAll(() => {
  gm.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  gm.window = { innerWidth: 1100, innerHeight: 800, addEventListener() {}, removeEventListener() {} };
});
afterAll(() => {
  if (own.mm) delete gm.matchMedia;
  if (own.win) delete gm.window;
  resetState();
  resetCorpora();
});
afterEach(() => resetCorpora());

describe("Enter waits for the list of the field's query (finding 1)", () => {
  const hit = (path: string) => ({ kind: "files" as const, key: `f:${path}`, path, nameStart: path.lastIndexOf("/") + 1, ranges: [] });
  test("a list that answers an older query, or before the file list came, makes Enter wait; then it picks the active row", () => {
    const rows = [hit("assets/team-notes.md"), hit("docs/launch plan.md")];
    expect(sections.enterPick(rows, 0, "", "launch", true)).toBe("wait");
    expect(sections.enterPick(rows, 1, "launch", "launch", false)).toBe("wait");
    expect(sections.enterPick(rows, 1, "launch", "launch", true)).toBe(rows[1]!);
    expect(sections.enterPick([], 0, "launch", "launch", true)).toBeNull();
  });
  test("the pane's Enter goes through that rule and a pick that waited runs when the list lands", () => {
    const pane = src("search", "SearchPane.tsx");
    expect(pane).toContain("enterPick(rows, active, result.q, q, settled)");
    expect(pane).toMatch(/waiting\.current = q/);
  });
});

describe("an upload matches by its name, never by the host folders of its path (finding 2)", () => {
  const report = upload("report.pdf", "/var/tmp/state/kitespan/uploads/u-7hx2md/report.pdf");
  test("the host folders match nothing; the name does, with its ranges", () => {
    for (const q of ["var", "tmp", "state", "/comp", "comp", "u-7hx", "uploads", "kitespan"]) expect([q, searchSections(input({ q, uploads: [report] })).sections.length]).toEqual([q, 0]);
    const r = searchSections(input({ q: "report", uploads: [report] }));
    expect(flatRows(r)[0]).toMatchObject({ kind: "uploads", ranges: [[0, 6]] });
  });
  test("a query that starts with / puts the commands first, so Enter on it takes the command", () => {
    const r = searchSections(input({ q: "/comp", files: files("/comp", ["web/composer/Composer.tsx"]), uploads: [upload("flaky-run.log", "/tmp/x/state/kitespan/uploads/u-k3v9q2/flaky-run.log")], commands: COMMANDS as MenuRow[] }));
    expect(r.sections.map((s) => s.kind)).toEqual(["commands", "files"]);
    expect(flatRows(r)[0]).toMatchObject({ kind: "commands", command: { name: "compact" } });
    // Without the slash the groups keep their order.
    expect(searchSections(input({ q: "comp", files: files("comp", ["web/composer/Composer.tsx"]), commands: COMMANDS as MenuRow[] })).sections.map((s) => s.kind)).toEqual(["files", "commands"]);
  });
});

describe("three groups: the uploads inside Files (finding 6, DESIGN 6.7)", () => {
  const ups = UPLOADS[CHAT]!;
  test("one Files group with one heading: the folder's files, then the chat's uploads; its count is both", () => {
    const r = searchSections(input({ q: "", chats: CHATS, files: files("", ["a/flaky.ts", "b/run.ts"], 7), uploads: ups, commands: COMMANDS as MenuRow[] }));
    expect(r.sections.map((s) => s.kind)).toEqual(["chats", "files", "commands"]);
    const f = r.sections.find((s) => s.kind === "files")!;
    expect(f.rows.map((h) => h.kind)).toEqual(["files", "files", "uploads", "uploads"]);
    expect(f.count).toBe(7 + 2);
    // U5 added the fourth group, Messages, last (test/web/search-text-model.test.ts); still no Uploads group.
    expect(Object.keys(sections.SECTION_TITLE)).toEqual(["chats", "files", "commands", "messages"]);
    expect(searchSections(input({ q: "", files: files("", ["a/flaky.ts"]), uploads: ups, scope: "files" })).sections.map((s) => s.kind)).toEqual(["files"]);
  });
  test("many matching files cannot push the uploads out of their group", () => {
    const paths = Array.from({ length: 120 }, (_, i) => `src/run/file${i}.ts`);
    const r = searchSections(input({ q: "", chats: CHATS, files: files("", paths, 9_000), uploads: ups, commands: COMMANDS as MenuRow[] }));
    const f = r.sections.find((s) => s.kind === "files")!;
    expect(f.rows.slice(-2).map((h) => h.kind)).toEqual(["uploads", "uploads"]);
    expect(r.rows).toBe(120);
  });
});

describe("the work per key (finding 12)", () => {
  test("the same file answer gives the same hit objects, so an unchanged row is not drawn again", () => {
    const answer = files("ab", ["x/ab.ts", "y/abc.ts"]);
    const one = searchSections(input({ q: "ab", files: answer }));
    const two = searchSections(input({ q: "abc", files: answer }));
    expect(flatRows(two)[0]).toBe(flatRows(one)[0]!);
    expect(flatRows(two)[1]).toBe(flatRows(one)[1]!);
  });
  test("the chats are sorted newest first once per list, not again on each key", () => {
    const chats = [...CHATS];
    searchSections(input({ q: "f", chats }));
    const parse = spyOn(Date, "parse");
    try {
      searchSections(input({ q: "fi", chats }));
      searchSections(input({ q: "fix", chats }));
      expect(parse).toHaveBeenCalledTimes(0);
    } finally {
      parse.mockRestore();
    }
  });
});

describe("the server is asked with the field's query (finding 9)", () => {
  test("the server route keeps its last two answers: the deferred query gets its own while the newest lands", async () => {
    const asked: string[] = [];
    const engine = createFileEngine({
      at: "server",
      search: async (q) => {
        asked.push(q);
        return { v: "v", total: 3, count: 1, rows: [{ path: `d/${q}.ts`, nameRanges: [] }] } satisfies CorpusSearchReply;
      },
    });
    let landed = 0;
    engine.subscribe(() => landed++);
    engine.ask("la");
    while (landed < 1) await Bun.sleep(1);
    engine.ask("lau");
    while (landed < 2) await Bun.sleep(1);
    expect(engine.rows("la")?.q).toBe("la");
    expect(engine.rows("lau")?.q).toBe("lau");
    expect(engine.rows("other")?.q).toBe("lau");
    // Back to a query it holds: no new request.
    engine.ask("la");
    await Bun.sleep(5);
    expect(asked).toEqual(["la", "lau"]);
    engine.close();
  });
  test("files that answer the field's newer query than the deferred one: the list says the deferred query", () => {
    expect(searchSections(input({ q: "la", filesAhead: true, files: files("lau", ["x/lau.ts"]) })).q).toBe("la");
    expect(searchSections(input({ q: "lau", files: files("la", ["x/la.ts"]) })).q).toBe("la");
  });
  test("the pane asks with the field's value; the rows follow the deferred one", () => {
    expect(src("search", "SearchPane.tsx")).toContain("usePaneData(chat, shown, scope, q)");
    const hook = src("search", "useSearch.ts");
    expect(hook).toMatch(/export function useFileRows\(engine: FileEngine \| null, q: string, ask: string = q\)/);
    expect(hook).toMatch(/engine\?\.ask\(ask\);\s*\}, \[engine, ask\]\)/);
  });
});

describe("a scope with no files scans none (finding 10)", () => {
  const withCommands = (): Chat[] => CHATS.map((c) => (c.id === CHAT ? { ...c, commands: [{ name: "compact", description: "x", argumentHint: "", aliases: [], builtin: true, terminalOnly: false }] } : c));
  const chatOf = () => withCommands().find((c) => c.id === CHAT)!;
  const corpus = async (paths: string[], chat = CHAT) => {
    const reply: CorpusReply = { v: "v1", source: "git", complete: true, total: paths.length, chars: 0, paths };
    await openCorpus(chat, false, { fetcher: (async () => new Response(JSON.stringify(reply), { status: 200 })) as unknown as typeof fetch, later: (run) => run() }, corpusMod.corpusKey(chat, FOLDER));
  };
  const pane = (path: string, chat: Chat) => renderToStaticMarkup(createElement(SearchPane, { route: parse(new URL(path, "http://127.0.0.1")), chat, place: "column" }));

  test("scope=chats and scope=commands: no scan of the folder's files; scope=files scans", async () => {
    resetState({ projects: structuredClone(PROJECTS), chats: withCommands(), uploads: structuredClone(UPLOADS), ready: true });
    await corpus(["web/composer/Composer.tsx", "src/compact.ts"]);
    const scan = spyOn(Searcher.prototype, "search");
    try {
      pane(`/c/${CHAT}/search?q=comp&scope=chats`, chatOf());
      pane(`/c/${CHAT}/search?q=comp&scope=commands`, chatOf());
      expect(scan).toHaveBeenCalledTimes(0);
      const html = pane(`/c/${CHAT}/search?q=comp&scope=files`, chatOf());
      expect(scan.mock.calls.length).toBeGreaterThan(0);
      expect(html).toContain("Composer.tsx");
    } finally {
      scan.mockRestore();
    }
  });

  test("one corpus per folder: a second chat of the project sees the list the first one read", async () => {
    resetState({ projects: structuredClone(PROJECTS), chats: withCommands(), uploads: structuredClone(UPLOADS), ready: true });
    await corpus(["web/composer/Composer.tsx"]);
    const sibling = withCommands().find((c) => c.id === SIBLING)!;
    expect(pane(`/c/${SIBLING}/search?q=composer&scope=files`, sibling)).toContain("Composer.tsx");
  });
});

describe("one corpus per folder (finding 11)", () => {
  const key = (chat: string) => corpusMod.corpusKey(chat, FOLDER);
  function server(replies: (CorpusReply | CorpusSearchReply)[]) {
    const asked: URL[] = [];
    const fetcher = (async (u: string | URL | Request) => {
      asked.push(new URL(String(u), "http://127.0.0.1"));
      return new Response(JSON.stringify(replies.shift()), { status: 200 });
    }) as typeof fetch;
    return { fetcher, asked };
  }
  test("the key is the chat's folder (a chat with no known folder keeps its own)", () => {
    expect(key(CHAT)).toBe(key(SIBLING));
    expect(corpusMod.corpusKey(CHAT, null)).toBe(CHAT);
    expect(corpusMod.corpusKey(CHAT, "/a")).not.toBe(corpusMod.corpusKey(CHAT, "/b"));
  });
  test("a second chat of the folder sends the v the page holds, and the server's same keeps the one prepared copy", async () => {
    const s = server([{ v: "same1", source: "git", complete: true, total: 1, chars: 4, paths: ["a.ts"] }, { v: "same1", same: true }]);
    await openCorpus(CHAT, false, { fetcher: s.fetcher, later: (run) => run() }, key(CHAT));
    const held = corpusOf(key(CHAT));
    await openCorpus(SIBLING, false, { fetcher: s.fetcher, later: (run) => run() }, key(SIBLING));
    expect(s.asked.map((u) => [u.pathname, u.searchParams.get("v")])).toEqual([
      [`/api/chats/${CHAT}/corpus`, null],
      [`/api/chats/${SIBLING}/corpus`, "same1"],
    ]);
    expect(corpusOf(key(SIBLING))).toBe(held);
  });
  test("over the limit, a same answer for another chat asks the search route through that chat", async () => {
    const s = server([
      { v: "big1", source: "git", complete: false, total: 100_000, chars: 9_000_000, paths: null },
      { v: "big1", same: true },
      { v: "big1", total: 100_000, count: 0, rows: [] },
    ]);
    await openCorpus(CHAT, true, { fetcher: s.fetcher }, key(CHAT));
    await openCorpus(SIBLING, true, { fetcher: s.fetcher }, key(SIBLING));
    const engine = createFileEngine(corpusOf(key(SIBLING)).source!);
    let landed = 0;
    engine.subscribe(() => landed++);
    engine.ask("x");
    while (!landed) await Bun.sleep(1);
    expect(s.asked[2]!.pathname).toBe(`/api/chats/${SIBLING}/corpus/search`);
    engine.close();
  });
});

describe("Esc gives the focus back (finding 3)", () => {
  const el = (connected = true, shown = true) => ({ isConnected: connected, getClientRects: () => (shown ? [{}] : []), focus() {} });
  test("to the element that opened the pane, else the composer field on a laptop, else nothing on touch", () => {
    const opener = el();
    const composer = el();
    const out = () => false;
    expect(focusMod.focusBackTo(opener, composer, out, false)).toBe(opener);
    expect(focusMod.focusBackTo(el(false), composer, out, false)).toBe(composer);
    expect(focusMod.focusBackTo(el(true, false), composer, out, false)).toBe(composer);
    expect(focusMod.focusBackTo(null, composer, out, false)).toBe(composer);
    expect(focusMod.focusBackTo(null, composer, out, true)).toBeNull();
    expect(focusMod.focusBackTo(opener, composer, (x) => x === opener, false)).toBe(composer);
  });
  test("the pane records the opener as it opens and gives the focus back when Esc or Close closes it", () => {
    const pane = src("search", "SearchPane.tsx");
    expect(pane).toContain("closing.current = true");
    expect(pane).toContain("focusBackTo(");
  });
});

describe("the list rides the on-screen keyboard on touch (finding 4, DESIGN 7.8)", () => {
  test("the shell rides while the keyboard is up and the focus is in a search surface: its height and its move", () => {
    const shell = src("layout", "Shell.tsx");
    expect(shell).toMatch(/srch-riding/);
    expect(shell).toMatch(/useFocusInside\("\.srch"/);
    expect(css()).toMatch(/\.shell\.srch-riding \{\n  position: fixed;\n  top: 0;\n  right: 0;\n  left: 0;\n\}/);
  });
});

describe("the style sheet (findings 5, 7, 8)", () => {
  test("the matched letters are bold in the row's own colour, as the @ picker draws them", () => {
    const rule = /\.srch-hit \{([^}]*)\}/.exec(css())?.[1] ?? "";
    expect(rule).toContain("font-weight: var(--weight-strong)");
    expect(rule).not.toContain("color");
  });
  test("/search is full width on a tablet (5.3), as on the phone", () => {
    expect(css()).toMatch(/\.shell-medium \.srch-page > \.srch,\n\.shell-phone \.srch-page > \.srch \{\n  max-width: none;/);
  });
  test("the list's flex basis is 0: its box comes from the pane, never from its rows' content", () => {
    expect(css()).toMatch(/\.srch-list \{\n  flex: 1 1 0;\n  min-height: 0;/);
  });
});
