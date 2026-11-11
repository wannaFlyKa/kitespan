// U1 (FIX-U1 section 2, DESIGN-U1 6 and 11): the changed-files card at a turn's end. Its model (the head's words and
// counts, the rows, a blank 0, "N more files", Binary and Too large, the fallback's "changed", one file with no head,
// the names a screen reader reads, the open row), its markup (links, aria-current, the phone's one line with no link),
// which turn each card belongs to (the summary's first rows, else where its event came), and its styles (tokens only,
// 44 px on touch). Rendered with React's server renderer.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CHANGES_WORDS, cardModel, changesByTurn, countParts, rowLabel, type ChangesNote } from "../../web/changes/model";
import { ChangesCard } from "../../web/changes/ChangesCard";
import { parsePath } from "../../shared/route";
import { turnList, turnsOf } from "../../web/chat/turns";
import type { Item, TurnMark } from "../../web/state/types";

const WEB = join(import.meta.dir, "..", "..", "web");
const src = (...p: string[]) => readFileSync(join(WEB, ...p), "utf8");

const C = "demoolxxxxxxxxxxxxxx";
const T = "k3m7q2x4ab";

const three: ChangesNote = {
  id: T,
  at: ["u1"],
  how: "git",
  total: 3,
  added: 42,
  removed: 18,
  files: [
    { path: "test/unit/upload.test.ts", added: 12, removed: 3, status: "M" },
    { path: "test/fake-server/events.ts", added: 28, removed: 15, status: "M" },
    { path: "docs/testing.md", added: 2, removed: 0, status: "M" },
  ],
};

const card = (note: ChangesNote, opts: { open?: string | null; phone?: boolean; route?: string } = {}) =>
  renderToStaticMarkup(createElement(ChangesCard, { note, chatId: C, route: parsePath(opts.route ?? `/c/${C}`), live: true, phone: !!opts.phone, open: opts.open ?? null }));

describe("the card's model (DESIGN-U1 6.1, 11)", () => {
  test("the head: git's own phrase and the turn's totals; a row per file", () => {
    const m = cardModel(three);
    expect(m.head).toEqual({ words: "3 files changed", added: 42, removed: 18, label: "3 files changed, 42 lines added, 18 removed" });
    expect(m.rows.map((r) => [r.path, r.added, r.removed])).toEqual([
      ["test/unit/upload.test.ts", 12, 3],
      ["test/fake-server/events.ts", 28, 15],
      ["docs/testing.md", 2, 0],
    ]);
    expect(m.more).toBe(0);
  });

  test("one file: its row alone, no head", () => {
    const m = cardModel({ ...three, total: 1, added: 12, removed: 3, files: three.files.slice(0, 1) });
    expect(m.head).toBeNull();
    expect(m.rows.length).toBe(1);
    expect(m.line).toBe("1 file changed");
  });

  test("more than five files: four rows and a fifth, N more files (the event holds five)", () => {
    const files = Array.from({ length: 5 }, (_, i) => ({ path: `src/f${i}.ts`, added: i, removed: 1, status: "M" as const }));
    const seven = cardModel({ ...three, total: 7, files });
    expect([seven.rows.length, seven.more, seven.moreWords]).toEqual([4, 3, "3 more files"]);
    const five = cardModel({ ...three, total: 5, files });
    expect([five.rows.length, five.more]).toEqual([5, 0]);
    expect(cardModel({ ...three, total: 6, files }).moreWords).toBe("2 more files");
  });

  test("the fallback (Claude's own edits): N files changed too (review: the turn line above says edited and wrote)", () => {
    expect(cardModel({ ...three, how: "edits" }).head?.words).toBe("3 files changed");
    expect(cardModel({ ...three, how: "edits", total: 1, files: three.files.slice(0, 1) }).line).toBe("1 file changed");
  });

  test("the counts: +N and -N, a part that is 0 left blank (its slot stays)", () => {
    expect(countParts(12, 3)).toEqual({ add: "+12", del: "-3" });
    expect(countParts(2, 0)).toEqual({ add: "+2", del: "" });
    expect(countParts(0, 41)).toEqual({ add: "", del: "-41" });
    expect(countParts(0, 0)).toEqual({ add: "", del: "" });
    expect(countParts(1234, 0)).toEqual({ add: "+1,234", del: "" });
  });

  test("Binary and Too large in the counts' place; the names a screen reader reads", () => {
    expect(rowLabel({ path: "test/unit/upload.test.ts", added: 12, removed: 3, status: "M" })).toBe("test/unit/upload.test.ts, 12 added, 3 removed");
    expect(rowLabel({ path: "docs/testing.md", added: 2, removed: 0, status: "M" })).toBe("docs/testing.md, 2 added");
    expect(rowLabel({ path: "old.ts", added: 0, removed: 41, status: "D" })).toBe("old.ts, 41 removed");
    expect(rowLabel({ path: "a.ts", added: 1, removed: 1, status: "M" })).toBe("a.ts, 1 added, 1 removed");
    expect(rowLabel({ path: "assets/logo.bin", added: 0, removed: 0, status: "A", binary: true })).toBe("assets/logo.bin, Binary");
    expect(rowLabel({ path: "data/big.json", added: 0, removed: 0, status: "A", large: true })).toBe("data/big.json, Too large");
    expect(cardModel({ ...three, total: 1, added: 1, removed: 0, files: [{ path: "a.ts", added: 1, removed: 0, status: "A" }] }).label).toBe("1 file changed, 1 line added");
    expect(CHANGES_WORDS.binary).toBe("Binary");
    expect(CHANGES_WORDS.large).toBe("Too large");
  });
});

describe("the card's markup", () => {
  test("a section named by its head; the head opens the turn's list, each row its file's diff", () => {
    const html = card(three);
    expect(html).toContain('data-testid="changes-card"');
    expect(html).toContain(`data-item-id="changes-${T}"`);
    expect(html).toContain('aria-label="3 files changed, 42 lines added, 18 removed"');
    expect(html).toContain(`href="/c/${C}/changes/${T}"`);
    expect(html).toContain(`href="/c/${C}/changes/${T}/test/unit/upload.test.ts"`);
    expect(html).toContain('<span class="chg-title">3 files changed</span>');
    // The path's folder part dimmed before its name (the Outputs card's form).
    expect(html).toContain('<span class="side-pl-dir"><bdi>test/unit/</bdi></span><span class="side-pl-name">upload<wbr/>.test<wbr/>.ts</span>');
    // A blank 0: the slot stays, empty.
    expect(html).toContain('<span class="chg-count" aria-hidden="true"><span class="is-add">+2</span><span class="is-del"></span></span>');
    expect(html).not.toContain("aria-current");
  });

  test("the open row: the head while the panel shows the list, a file's row while it shows that file", () => {
    expect(card(three, { open: "" })).toMatch(/class="chg-head" aria-current="page"/);
    const file = card(three, { open: "docs/testing.md" });
    expect(file).toMatch(/aria-current="page"[^>]*href="\/c\/[a-z2-7]+\/changes\/[a-z2-7]+\/docs\/testing.md"|href="\/c\/[a-z2-7]+\/changes\/[a-z2-7]+\/docs\/testing.md"[^>]*aria-current="page"/);
    expect(file.match(/aria-current/g)?.length).toBe(1);
  });

  test("with the Terminal open, a row's link puts the diff above it", () => {
    expect(card(three, { route: `/c/${C}/shell` })).toContain(`href="/c/${C}/changes/${T}/test/unit/upload.test.ts?below=shell"`);
  });

  test("more than five: N more files opens the turn's list, in the link colour", () => {
    const files = Array.from({ length: 5 }, (_, i) => ({ path: `src/f${i}.ts`, added: i + 1, removed: 0, status: "M" as const }));
    const html = card({ ...three, total: 9, files });
    expect(html).toContain(`<a href="/c/${C}/changes/${T}" class="chg-row chg-more"`);
    expect(html).toContain("5 more files");
    expect(html.match(/class="chg-row"/g)?.length).toBe(4);
  });

  test("one file: no head", () => {
    const html = card({ ...three, total: 1, added: 12, removed: 3, files: three.files.slice(0, 1) });
    expect(html).not.toContain("chg-head");
    expect(html).toContain('aria-label="1 file changed, 12 lines added, 3 removed"');
  });

  test("the phone: the head alone, plain text, no link, no rows (row 115)", () => {
    const html = card(three, { phone: true });
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("chg-row");
    expect(html).toContain('class="chg-line-phone"');
    expect(html).toContain("3 files changed");
    expect(html).toContain(">+42<");
    expect(html).toContain(">-18<");
    expect(html).toContain(`data-item-id="changes-${T}"`);
    expect(card({ ...three, total: 1, added: 12, removed: 3, files: three.files.slice(0, 1) }, { phone: true })).toContain("1 file changed");
  });
});

describe("which turn a card belongs to (DESIGN-U1 5: the summary's `at`)", () => {
  const u = (id: string): Item => ({ kind: "user", id, text: id });
  const a = (id: string): Item => ({ kind: "assistant", id, markdown: id });
  const tool = (id: string): Item => ({ kind: "tool", id, name: "Edit", summary: "src/a.ts", status: "done" } as unknown as Item);
  const items: Item[] = [u("u1"), tool("t1"), tool("t2"), a("a1"), u("u2"), a("a2")];
  const marks: TurnMark[] = [
    { k: "start", by: "user", at: [], seq: 1 },
    { k: "end", at: ["a1", "t2", "t1"], seq: 5, ok: true, subtype: "success", durationMs: 1000, uuids: ["u1"], live: false },
    { k: "start", by: "user", at: ["a1"], seq: 6 },
    { k: "end", at: ["a2", "u2"], seq: 8, ok: true, subtype: "success", durationMs: 1000, uuids: ["u2"], live: false },
  ];
  const turns = turnList(turnsOf(items, marks, { running: false, waiting: false, partial: false }));

  test("by the turn's first rows; a note whose rows are not drawn belongs to no turn", () => {
    const first: ChangesNote = { ...three, id: "aaaaaaaaaa", at: ["u1"] };
    const second: ChangesNote = { ...three, id: "bbbbbbbbbb", at: ["gone", "u2"] };
    const none: ChangesNote = { ...three, id: "cccccccccc", at: ["zz"] };
    const map = changesByTurn(turns, [first, second, none]);
    expect(turns.map((t) => map.get(t.id)?.id ?? null)).toEqual(["aaaaaaaaaa", "bbbbbbbbbb"]);
  });

  test("a turn whose first rows are on an older page: where its event came (its turn's last rows)", () => {
    const cut: ChangesNote = { ...three, id: "dddddddddd", at: ["older1"], near: ["a1", "t2"] };
    const map = changesByTurn(turns, [cut]);
    expect(map.get(turns[0]!.id)?.id).toBe("dddddddddd");
  });

  test("one card per turn: the newest note wins", () => {
    const one: ChangesNote = { ...three, id: "aaaaaaaaaa", at: ["u1"] };
    const again: ChangesNote = { ...three, id: "eeeeeeeeee", at: ["u1"] };
    expect(changesByTurn(turns, [one, again]).get(turns[0]!.id)?.id).toBe("eeeeeeeeee");
  });
});

describe("the place in the column (DESIGN-U1 6.1)", () => {
  test("ChatView draws a turn's card after its last part, folded or open, in every view", () => {
    const view = src("chat", "ChatView.tsx");
    // One place, at the end of each turn's parts: after the open turn's entries and after the folded turn's parts.
    expect(view.match(/card\.node\(\)/g)?.length).toBe(2);
    expect(view).toContain("changesByTurn(");
  });
});

describe("the styles (DESIGN-U1 6.3: tokens only)", () => {
  const css = src("styles", "changes.css");
  test("no colour, radius or size of its own; the counts tabular in the UI face", () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    for (const t of ["--hairline", "--r-card", "--row-h", "--dim", "--ok", "--danger", "--accent-ui", "--hover", "--selected", "--ring", "--fs-small", "--fs-meta"]) expect([t, css.includes(`var(${t})`)]).toEqual([t, true]);
    expect(css).toMatch(/\.chg-count \{[^}]*font-variant-numeric: tabular-nums/);
    expect(css).not.toMatch(/\.chg-count \{[^}]*font-family/);
    expect(src("styles", "app.css")).toContain('@import "./changes.css";');
  });
  test("the open row is --selected; the focus ring is the look's; no shadow, no fill on the box", () => {
    expect(css).toMatch(/\[aria-current="page"\] \{[^}]*background: var\(--selected\)/);
    expect(css).toMatch(/:focus-visible \{[^}]*outline: 2px solid var\(--ring\)/);
    expect(css).not.toContain("box-shadow");
    expect(css).toMatch(/\.chg-card \{[^}]*border: 1px solid var\(--hairline\)/);
  });
});
