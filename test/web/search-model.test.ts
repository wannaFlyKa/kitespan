// The search pane's model (DESIGN.md 9.3, 6.7, 6.11; BUILD-CHECKLIST C3 to C5): the three groups and their budget of
// 120 rows with a floor each, the true counts, the scope, the archived chats left out, the highlight's pieces, the keys of
// the pane's field with the IME guard, the active row that goes back to the first on each new query, where a pick and
// a close go, and Search's key (Cmd+K on macOS, Ctrl+K elsewhere, never Ctrl+K on macOS).
import { describe, expect, test } from "bun:test";
import type { FileRows } from "../../web/search/engine";
import { SECTION_FLOOR, activeFor, allot, clampActive, flatRows, moveActive, paneKey, pieces, scopesHere, searchSections, type SearchInput } from "../../web/search/sections";
import { closeHref, pickHref, searchHref, searchOpenHref } from "../../web/search/nav";
import { IS_MAC, keyLabel, searchKeyHere, shortcutFor } from "../../web/ui/shortcuts";
import { composingKey } from "../../web/ui/primitives";
import { searchTitle } from "../../web/layout/SearchButton";
import { visibleChats } from "../../web/state/store";
import type { MenuRow } from "../../web/composer/draft";
import type { Chat, Upload } from "../../web/state/types";
import { CHATS, COMMANDS, UPLOADS } from "./fixtures";

const CHAT = "demoolxxxxxxxxxxxxxx";
const files = (q: string, paths: string[], count = paths.length): FileRows => ({
  q,
  count,
  rows: paths.map((path) => ({ path, nameStart: path.lastIndexOf("/") + 1, nameRanges: [] })),
});
const input = (over: Partial<SearchInput>): SearchInput => ({ q: "", scope: null, chats: [], files: null, uploads: [], commands: null, ...over });
const manyChats = (n: number): Chat[] => Array.from({ length: n }, (_, i) => ({ ...CHATS[0]!, id: `chat${String(i).padStart(16, "x")}`, title: `Fix item ${i}`, updatedAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString() }));

describe("the groups and their budget (C3)", () => {
  test("each group keeps a floor inside the 120, then the rest go in the groups' order", () => {
    expect(allot([500, 500, 3, 500])).toEqual([20 + 57, 20, 3, 20]);
    expect(allot([500, 500, 3, 500]).reduce((a, b) => a + b, 0)).toBe(120);
    expect(allot([0, 300, 0, 0])).toEqual([0, 120, 0, 0]);
    expect(allot([5, 7, 0, 2])).toEqual([5, 7, 0, 2]);
    expect(allot([10, 300, 0, 300])).toEqual([10, 20 + 70, 0, 20]);
  });

  test("many files cannot push the chats and the commands out of view; each count is the true total", () => {
    const paths = Array.from({ length: 120 }, (_, i) => `src/fix/file${i}.ts`);
    const commands: MenuRow[] = Array.from({ length: 60 }, (_, i) => ({ name: `fix-${i}`, hint: "x", source: "user" }));
    const r = searchSections(input({ q: "fix", chats: manyChats(40), files: files("fix", paths, 9_000), commands }));
    expect(r.sections.map((s) => [s.kind, s.count, s.rows.length])).toEqual([
      ["chats", 40, 40],
      ["files", 9_000, 60],
      ["commands", 60, SECTION_FLOOR],
    ]);
    expect(r.rows).toBe(120);
    expect(r.count).toBe(40 + 9_000 + 60);
    expect(flatRows(r)).toHaveLength(120);
  });

  test("the chats by title, newest first among equals; archived chats are left out, as the lists leave them out", () => {
    const chats = CHATS.map((c) => (c.title === "Plan the search index" ? { ...c, archived: true } : c));
    const r = searchSections(input({ q: "", chats: visibleChats(chats) }));
    const titles = r.sections[0]!.rows.map((h) => (h.kind === "chats" ? h.chat.title : ""));
    expect(titles).not.toContain("Plan the search index");
    const dates = r.sections[0]!.rows.map((h) => (h.kind === "chats" ? Date.parse(h.chat.updatedAt) : 0));
    expect(dates).toEqual([...dates].sort((a, b) => b - a));
    const hit = searchSections(input({ q: "flaky", chats: visibleChats(chats) })).sections[0]!.rows[0]!;
    // Greedy from the left (L15): the F of "Fix", then "laky".
    expect(hit).toMatchObject({ kind: "chats", ranges: [[0, 1], [9, 13]] });
  });

  test("a space is AND on a title too; a group with no row is not there at all", () => {
    const r = searchSections(input({ q: "fix test", chats: CHATS, uploads: UPLOADS[CHAT]!, commands: COMMANDS as MenuRow[] }));
    expect(r.sections.map((s) => s.kind)).toEqual(["chats"]);
    expect(r.sections[0]!.rows.map((h) => (h.kind === "chats" ? h.chat.title : ""))).toEqual(["Fix the flaky upload test"]);
    expect(searchSections(input({ q: "zzzq", chats: CHATS, commands: COMMANDS as MenuRow[] })).sections).toEqual([]);
  });

  test("uploads by their name only, as rows of Files; a failed upload is no file", () => {
    const failed: Upload = { ...UPLOADS[CHAT]![0]!, id: "up_bad", name: "broken-run.log", path: "", state: "failed" };
    const r = searchSections(input({ q: "run", uploads: [...UPLOADS[CHAT]!, failed] }));
    expect(r.sections.map((s) => [s.kind, s.count])).toEqual([["files", 1]]);
    const up = r.sections[0]!.rows[0]!;
    expect(up.kind === "uploads" && up.path.slice(up.nameStart)).toBe("flaky-run.log");
    expect(up.ranges).toEqual([[6, 9]]);
    // The upload folder in its path matches nothing: not its random folder, not a term with "/".
    expect(searchSections(input({ q: "u-7hx/", uploads: UPLOADS[CHAT]! })).sections).toEqual([]);
    expect(searchSections(input({ q: "u-7hx", uploads: UPLOADS[CHAT]! })).sections).toEqual([]);
  });

  test("commands by name and alias, with a typed / before the name; the ranges index the name", () => {
    const rows: MenuRow[] = [...(COMMANDS as MenuRow[]), { name: "review-notes", hint: "x", source: "user", aliases: ["rn"] }];
    const r = searchSections(input({ q: "/compa", commands: rows }));
    expect(r.sections[0]!.rows[0]).toMatchObject({ kind: "commands", ranges: [[0, 5]] });
    const alias = searchSections(input({ q: "rn", commands: rows })).sections[0]!.rows.map((h) => (h.kind === "commands" ? h.command.name : ""));
    expect(alias).toContain("review-notes");
  });

  test("scope keeps one group: files keeps the files and the uploads", () => {
    const all = input({ q: "", chats: CHATS, files: files("", ["a/flaky.ts"]), uploads: UPLOADS[CHAT]!, commands: COMMANDS as MenuRow[] });
    const only = searchSections({ ...all, scope: "files" });
    expect(only.sections.map((s) => s.kind)).toEqual(["files"]);
    expect(flatRows(only).map((h) => h.kind)).toEqual(["files", "uploads", "uploads"]);
    expect(searchSections({ ...all, scope: "chats" }).sections.map((s) => s.kind)).toEqual(["chats"]);
    expect(searchSections({ ...all, scope: "commands" }).sections.map((s) => s.kind)).toEqual(["commands"]);
    expect(searchSections(all).sections.map((s) => s.kind)).toEqual(["chats", "files", "commands"]);
  });

  test("the list's query: the field's deferred query, or the server's older answer while it lags", () => {
    expect(searchSections(input({ q: "abc", files: files("abc", ["x/abc.ts"]) })).q).toBe("abc");
    expect(searchSections(input({ q: "abcd", files: files("abc", ["x/abc.ts"]) })).q).toBe("abc");
  });

  test("the scope control: only the kinds this chat has at all, and only when there are two", () => {
    expect(scopesHere({ chats: true, files: true, commands: false })).toEqual(["chats", "files"]);
    expect(scopesHere({ chats: true, files: false, commands: false })).toEqual([]);
    expect(scopesHere({ chats: true, files: true, commands: true })).toEqual(["chats", "files", "commands"]);
  });
});

describe("the highlight (A4)", () => {
  test("plain and matched pieces in order; a bad range is clamped, never thrown", () => {
    expect(pieces("Composer.tsx", [[0, 4]])).toEqual([
      { text: "Comp", hit: true },
      { text: "oser.tsx", hit: false },
    ]);
    expect(pieces("abc", [])).toEqual([{ text: "abc", hit: false }]);
    expect(pieces("abc", [[1, 2], [2, 3]]).map((p) => p.text)).toEqual(["a", "b", "c"]);
    expect(pieces("abc", [[2, 99], [-5, 1]]).map((p) => [p.text, p.hit])).toEqual([["ab", false], ["c", true]]);
    expect(pieces("", [[0, 1]])).toEqual([{ text: "", hit: false }]);
  });
});

describe("the keys of the pane's field (C4, L13)", () => {
  const k = (key: string, more: Record<string, unknown> = {}, coarse = false) => paneKey({ key, ...more }, coarse);
  test("Up and Down move, Enter picks, Esc closes; Shift or a modifier on Enter does nothing", () => {
    expect([k("ArrowDown"), k("ArrowUp"), k("Enter"), k("Escape"), k("a"), k("Tab")]).toEqual(["down", "up", "pick", "close", null, null]);
    expect([k("Enter", { shiftKey: true }), k("Enter", { metaKey: true }), k("ArrowDown", { altKey: true })]).toEqual([null, null, null]);
  });
  test("while an input method composes with a fine pointer, its keys are its own; on touch Enter picks at once", () => {
    for (const key of ["ArrowDown", "ArrowUp", "Enter", "Escape"]) {
      expect(k(key, { isComposing: true })).toBeNull();
      expect(k(key, { keyCode: 229 })).toBeNull();
    }
    expect(k("Enter", { isComposing: true }, true)).toBe("pick");
    expect([composingKey({ isComposing: true }, false), composingKey({ keyCode: 229 }, false), composingKey({ isComposing: true }, true), composingKey({}, false)]).toEqual([true, true, false, false]);
  });
  test("the active row goes round the ends, stays inside a shorter list, and goes back to the first on a new query", () => {
    expect([moveActive(0, 3, 1), moveActive(2, 3, 1), moveActive(0, 3, -1), moveActive(5, 0, 1)]).toEqual([1, 0, 2, 0]);
    expect([clampActive(7, 3), clampActive(-1, 3), clampActive(2, 0)]).toEqual([2, 0, 0]);
    // ArrowDown twice under "fla", then one more letter: the list of "flak" starts at its first row.
    const sel = { q: "fla", i: 2 };
    expect(activeFor(sel, "fla", 10)).toBe(2);
    expect(activeFor(sel, "flak", 10)).toBe(0);
    expect(activeFor(sel, "fla", 2)).toBe(1);
  });
});

describe("where the pane goes (5.1 rule 4, 5.5)", () => {
  const chat = (id: string, title: string): Chat => ({ ...CHATS[0]!, id, title });
  test("its own URL: q and scope in a chat, q only on /search; opening it writes no query", () => {
    expect(searchHref(CHAT, "upl", "files", "verbose")).toBe(`/c/${CHAT}/search?q=upl&scope=files&view=verbose`);
    expect(searchHref(CHAT, "", null)).toBe(`/c/${CHAT}/search`);
    expect(searchHref(null, "a b", "files")).toBe("/search?q=a%20b");
    expect([searchOpenHref(CHAT), searchOpenHref(CHAT, "thinking"), searchOpenHref(null), searchOpenHref(undefined)]).toEqual([`/c/${CHAT}/search`, `/c/${CHAT}/search?view=thinking`, "/search", "/search"]);
  });
  test("a pick is a navigation: a chat, a file's page, the chat's uploads, a command in the composer", () => {
    const other = "idleo6xxxxxxxxxxxxxx";
    expect(pickHref({ kind: "chats", key: "c", chat: chat(other, "x"), ranges: [] }, CHAT, "verbose")).toBe(`/c/${other}`);
    expect(pickHref({ kind: "files", key: "f", path: "web/a b.ts", nameStart: 4, ranges: [] }, CHAT)).toBe(`/c/${CHAT}/files/web/a%20b.ts`);
    expect(pickHref({ kind: "uploads", key: "u", upload: UPLOADS[CHAT]![0]!, path: "/tmp/x", nameStart: 5, ranges: [] }, CHAT, "verbose")).toBe(`/c/${CHAT}/uploads?view=verbose`);
    expect(pickHref({ kind: "commands", key: "k", command: { name: "compact", hint: "", source: "built-in" }, ranges: [] }, CHAT)).toBe(`/c/${CHAT}/slash/compact`);
  });
  test("Esc goes back to where the user was in this chat (the chat, or a view of its side pane), else to the chat", () => {
    const here = `/c/${CHAT}`;
    expect(closeHref(CHAT, undefined, `${here}/details`, true)).toBe(`${here}/details`);
    expect(closeHref(CHAT, undefined, here, true)).toBe(here);
    expect(closeHref(CHAT, undefined, `${here}/uploads`, true)).toBe(`${here}/uploads`);
    // Not this document's entry, another chat, a composer route, the search itself, or nothing: the chat.
    expect(closeHref(CHAT, undefined, `${here}/details`, false)).toBe(here);
    expect(closeHref(CHAT, "verbose", "/c/idleo6xxxxxxxxxxxxxx", true)).toBe(`${here}?view=verbose`);
    expect(closeHref(CHAT, undefined, `${here}/slash/compact`, true)).toBe(here);
    expect(closeHref(CHAT, undefined, `${here}/search?q=x`, true)).toBe(here);
    expect(closeHref(CHAT, undefined, "//evil.example/c", true)).toBe(here);
    expect(closeHref(CHAT, undefined, undefined, true)).toBe(here);
    // /search: the page before, or Home.
    expect(closeHref(null, undefined, "/settings/about", true)).toBe("/settings/about");
    expect(closeHref(null, undefined, "/search?q=a", true)).toBe("/");
    expect(closeHref(null, undefined, undefined, false)).toBe("/");
  });
});

describe("Search's key (6.11, C5)", () => {
  const key = (k: string, code: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "shiftKey" | "altKey", boolean>>, mac: boolean) =>
    shortcutFor({ key: k, code, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods }, mac);
  test("Cmd+K on macOS, Ctrl+K elsewhere; Ctrl+K on macOS stays the field's text key", () => {
    expect(key("k", "KeyK", { metaKey: true }, true)).toBe("search");
    expect(key("k", "KeyK", { ctrlKey: true }, false)).toBe("search");
    expect(key("k", "KeyK", { ctrlKey: true }, true)).toBeNull();
    expect(key("k", "KeyK", { metaKey: true }, false)).toBeNull();
    // A layout that puts K elsewhere still has its letter; a capital from Caps Lock is the same key.
    expect([key("K", "KeyK", { ctrlKey: true }, false), key("k", "KeyX", { metaKey: true }, true)]).toEqual(["search", "search"]);
  });
  test("not with Shift, Alt or the other modifier as well, and not with no modifier", () => {
    expect(key("K", "KeyK", { metaKey: true, shiftKey: true }, true)).toBeNull();
    expect(key("k", "KeyK", { ctrlKey: true, altKey: true }, false)).toBeNull();
    expect(key("k", "KeyK", { ctrlKey: true, metaKey: true }, false)).toBeNull();
    expect(key("k", "KeyK", { ctrlKey: true, metaKey: true }, true)).toBeNull();
    expect(key("k", "KeyK", {}, false)).toBeNull();
  });
  test("the other shortcuts keep their keys on both platforms", () => {
    expect([key("/", "Slash", { metaKey: true }, true), key("/", "Slash", { ctrlKey: true }, false)]).toEqual(["shortcuts", "shortcuts"]);
    expect(key("}", "BracketRight", { ctrlKey: true, shiftKey: true }, false)).toBe("next");
  });
  test("never inside the Terminal pane, where Ctrl+K is the shell's, and never while an input method composes", () => {
    const g = globalThis as unknown as { Element?: unknown };
    const had = "Element" in g;
    const was = g.Element;
    class FakeElement {
      constructor(private inTerm: boolean) {}
      closest(sel: string) {
        return this.inTerm && sel.includes(".term-pane") ? this : null;
      }
    }
    g.Element = FakeElement;
    try {
      expect(searchKeyHere({ target: new FakeElement(false) as unknown as EventTarget, isComposing: false, keyCode: 75 })).toBe(true);
      expect(searchKeyHere({ target: new FakeElement(true) as unknown as EventTarget, isComposing: false, keyCode: 75 })).toBe(false);
      expect(searchKeyHere({ target: new FakeElement(false) as unknown as EventTarget, isComposing: true, keyCode: 75 })).toBe(false);
      expect(searchKeyHere({ target: null, isComposing: false, keyCode: 229 })).toBe(false);
    } finally {
      if (had) g.Element = was;
      else delete g.Element;
    }
  });
  test("the key as the platform writes it: in the Search button's tooltip on a laptop, none on touch", () => {
    expect([keyLabel("k", true), keyLabel("k", false)]).toEqual(["Cmd+K", "Ctrl+K"]);
    expect([searchTitle(false, true), searchTitle(false, false), searchTitle(true)]).toEqual(["Search (Cmd+K)", "Search (Ctrl+K)", undefined]);
    expect(typeof IS_MAC).toBe("boolean");
  });
});

describe("the field's first focus (L12)", () => {
  test("a pane that mounts just after the key takes the focus on touch too; later, or with no key, it does not", async () => {
    const { openSearchFocused, takeKeyOpened } = await import("../../web/search/focus");
    openSearchFocused(1_000);
    expect(takeKeyOpened(1_200)).toBe(true);
    expect(takeKeyOpened(1_300)).toBe(false); // read once
    openSearchFocused(1_000);
    expect(takeKeyOpened(2_500)).toBe(false);
  });
});

describe("the chat rows rank again only when what they show changes", () => {
  test("a streamed item leaves the key as it was; a title, a state or an archive changes it", async () => {
    const { chatsKey } = await import("../../web/search/useSearch");
    const key = chatsKey(CHATS);
    const streamed = CHATS.map((c, i) => (i === 0 ? { ...c, items: [...c.items, { kind: "user" as const, id: "m_new", text: "more" }] } : c));
    expect(chatsKey(streamed)).toBe(key);
    for (const change of [{ title: "Renamed" }, { state: "failed" as const }, { archived: true }]) expect(chatsKey(CHATS.map((c, i) => (i === 0 ? { ...c, ...change } : c)))).not.toBe(key);
  });
});

describe("the layers' Esc and the IME guard (L13)", () => {
  test("Esc while an input method composes leaves the layer open and reaches no older surface", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(import.meta.dir, "..", "..", "web", "ui", "primitives.tsx"), "utf8");
    const esc = src.slice(src.indexOf('if (e.key === "Escape") {'), src.indexOf("t.close.current?.();"));
    // On touch the key says nothing of a composition, so the document's tracker does (T-18, composer/composition.ts).
    expect(esc).toMatch(/if \(composingKey\(e, coarseNow\(\)\) \|\| imeHolds\(\)\) \{\s*e\.stopImmediatePropagation\(\);\s*return;\s*\}/);
    expect(esc.indexOf("composingKey")).toBeLessThan(esc.indexOf("e.preventDefault()"));
  });
});
