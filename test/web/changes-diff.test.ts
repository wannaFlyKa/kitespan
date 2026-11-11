// U1 (FIX-U1 section 2, DESIGN-U1 7 and 11): the changes view in the side panel. The diff's rows from the server's
// hunks (both line numbers, the sign, the seam between hunks with git's context line, a note line with no number),
// the number column's width, the one-line states (binary, large, long, gone, failed, slow, not in the turn, no longer
// kept, a notebook), the file's line (New file, Deleted, Renamed from), the fallback's line and its reasons, the list's
// foot, the reads (what each answer gives), and the markup and styles: unified, long lines wrap, tokens only.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CHANGES_WORDS, diffRows, fallbackLine, fileNote, listFoot, moreLines, numberWidth, readDiff, readSummary, tooLarge, type DiffHunk } from "../../web/changes/model";
import { diffState, summaryState } from "../../web/changes/api";
import { DiffBody, FileHead, ListBody } from "../../web/changes/ChangesView";

const WEB = join(import.meta.dir, "..", "..", "web");
const src = (...p: string[]) => readFileSync(join(WEB, ...p), "utf8");

const HUNKS: DiffHunk[] = [
  {
    oldStart: 18,
    oldLines: 7,
    newStart: 18,
    newLines: 8,
    context: 'describe("upload", () => {',
    lines: ['   test("sends the file", async () => {', "     const server = await fakeServer();", "-    await server.start();", '-    const done = server.waitFor("uploaded");', "+    // Listen first.", '+    const done = server.waitFor("uploaded");', "+    await server.start();", "     await done;", "   });"],
  },
  { oldStart: 61, oldLines: 2, newStart: 62, newLines: 3, context: "", lines: ["     const big = 1;", "-    old();", "+    fresh();", "+    more();", "\\ No newline at end of file"] },
];

describe("the diff's rows (DESIGN-U1 7.3)", () => {
  const rows = diffRows(HUNKS);
  test("both line numbers: context lines both, removed the old one, added the new one", () => {
    const lines = rows.filter((r) => r.k === "line");
    expect(lines.slice(0, 9).map((r) => (r.k === "line" ? [r.sign, r.old, r.new] : null))).toEqual([
      [" ", 18, 18],
      [" ", 19, 19],
      ["-", 20, null],
      ["-", 21, null],
      ["+", null, 20],
      ["+", null, 21],
      ["+", null, 22],
      [" ", 22, 23],
      [" ", 23, 24],
    ]);
    // The sign is not part of the text.
    expect(lines[2]!.k === "line" && lines[2]!.text).toBe("    await server.start();");
  });

  test("each hunk starts with its context line; a seam (the dashed hairline) only between hunks", () => {
    const heads = rows.filter((r) => r.k === "hunk");
    expect(heads.map((h) => (h.k === "hunk" ? [h.context, h.seam] : null))).toEqual([
      ['describe("upload", () => {', false],
      ["", true],
    ]);
    expect(rows[0]!.k).toBe("hunk");
  });

  test("a note line ('No newline at end of file') has no number and no sign", () => {
    const note = rows[rows.length - 1]!;
    expect(note).toEqual({ k: "note", text: "No newline at end of file" });
  });

  test("the number column is as wide as the widest number", () => {
    expect(numberWidth(HUNKS)).toBe(2);
    expect(numberWidth([{ ...HUNKS[0]!, oldStart: 998, newStart: 1001 }])).toBe(4);
    expect(numberWidth([])).toBe(1);
  });
});

describe("the one-line states and the file's line (DESIGN-U1 7.3, 11)", () => {
  test("binary, large, long", () => {
    expect(CHANGES_WORDS.binaryLine).toBe("A binary file: it has no lines to show.");
    expect(tooLarge(4_200_000)).toBe("This file is too large to compare here (4.2 MB).");
    expect(tooLarge(1_500_000_000)).toBe("This file is too large to compare here (1.5 GB).");
    expect(moreLines(1412)).toBe("1,412 more lines");
    expect(moreLines(1)).toBe("1 more line");
  });
  test("gone, failed, slow, not in the turn, no longer kept, a notebook", () => {
    expect(CHANGES_WORDS.gone).toBe("This diff is no longer available.");
    expect(CHANGES_WORDS.failed).toBe("This diff could not be read.");
    expect(CHANGES_WORDS.tryAgain).toBe("Try again");
    expect(CHANGES_WORDS.reading).toBe("Reading the diff…");
    expect(CHANGES_WORDS.notInTurn).toBe("That file is not in this turn's changes.");
    expect(CHANGES_WORDS.notKept).toBe("These changes are no longer kept.");
    expect(CHANGES_WORDS.notebook).toBe("This notebook's diff is not shown.");
  });
  test("New file, Deleted, Renamed from <old path>; a plain edit says nothing", () => {
    expect(fileNote({ status: "A" })).toBe("New file");
    expect(fileNote({ status: "D" })).toBe("Deleted");
    expect(fileNote({ status: "R", from: "test/unit/upload.test.ts" })).toBe("Renamed from test/unit/upload.test.ts");
    expect(fileNote({ status: "M" })).toBeNull();
  });
  test("the fallback's line and its reasons", () => {
    expect(fallbackLine("not_git")).toBe("Claude's own edits only. This folder is not a git repository.");
    expect(fallbackLine("no_git")).toBe("Claude's own edits only. git is not installed.");
    expect(fallbackLine("refused")).toBe("Claude's own edits only. This repository's git config could run a program, so kitespan does not read it.");
    expect(fallbackLine("no_start")).toBe("Claude's own edits only. git could not read this folder when the turn started.");
    expect(fallbackLine("failed")).toBe("Claude's own edits only. git could not read this turn's changes.");
    expect(fallbackLine("full")).toBe("Claude's own edits only. This chat's saved changes reached kitespan's 256 MiB limit.");
    expect(fallbackLine(undefined)).toBe("Claude's own edits only.");
  });
  test("the list's foot: the changes left out", () => {
    expect(listFoot(2)).toBe("2 other files changed while Claude was not running a tool.");
    expect(listFoot(1)).toBe("1 other file changed while Claude was not running a tool.");
    expect(listFoot(0)).toBeNull();
  });
});

describe("the reads (DESIGN-U1 9)", () => {
  const summary = { id: "k3m7q2x4ab", at: ["u1"], how: "git", total: 2, added: 3, removed: 1, others: 2, files: [{ path: "a.ts", added: 2, removed: 1, status: "M" }, { path: "b.png", added: 0, removed: 0, status: "A", binary: true }] };
  test("a summary is read defensively: a bad file is left out, a bad answer is none", () => {
    expect(readSummary(summary)?.files.length).toBe(2);
    expect(readSummary(summary)?.others).toBe(2);
    expect(readSummary({ ...summary, files: [{ path: "../etc/passwd", added: 1, removed: 0, status: "M" }, { path: "a.ts", added: -1, removed: 0, status: "M" }] })?.files).toEqual([]);
    expect(readSummary({ ...summary, id: "BAD" })).toBeNull();
    expect(readSummary(null)).toBeNull();
    expect(readSummary({ ...summary, how: "magic" })).toBeNull();
  });
  test("a diff is read defensively", () => {
    const d = readDiff({ path: "a.ts", status: "M", hunks: HUNKS, cut: { shown: 3000, more: 1412 } });
    expect(d?.hunks.length).toBe(2);
    expect(d?.cut).toEqual({ shown: 3000, more: 1412 });
    expect(readDiff({ path: "a.ts", status: "M", hunks: [{ oldStart: 1 }] })?.hunks).toEqual([]);
    expect(readDiff({ path: "big.json", status: "A", large: { bytes: 4_200_000 }, hunks: [] })?.large).toEqual({ bytes: 4_200_000 });
    expect(readDiff("nope")).toBeNull();
  });
  test("what each answer gives: 404 is gone (the summary) or not in the turn (a path the summary lacks)", () => {
    expect(summaryState({ status: 200, body: summary })).toEqual({ phase: "ok", summary: readSummary(summary)! });
    expect(summaryState({ status: 404, body: null })).toEqual({ phase: "gone" });
    expect(summaryState({ status: 500, body: null })).toEqual({ phase: "failed" });
    expect(summaryState({ status: 0, body: null })).toEqual({ phase: "failed" });
    const s = readSummary(summary)!;
    expect(diffState({ status: 404, body: null }, s, "a.ts")).toEqual({ phase: "gone" });
    expect(diffState({ status: 404, body: null }, s, "c.ts")).toEqual({ phase: "missing" });
    expect(diffState({ status: 410, body: null }, s, "a.ts")).toEqual({ phase: "gone" });
    expect(diffState({ status: 503, body: null }, s, "a.ts")).toEqual({ phase: "failed" });
    expect(diffState({ status: 200, body: { path: "a.ts", status: "M", hunks: HUNKS } }, s, "a.ts").phase).toBe("ok");
    expect(diffState({ status: 200, body: "garbage" }, s, "a.ts")).toEqual({ phase: "failed" });
    // The server's own word for what is not there (shared/changes.ts ChangesMissing), with its status or in a 200 answer
    // (a read that is not there need not be a failed request in the browser's log, DESIGN 5.5 step 5).
    expect(diffState({ status: 404, body: { state: "no_turn" } }, s, "a.ts")).toEqual({ phase: "notKept" });
    expect(diffState({ status: 404, body: { state: "no_file" } }, s, "a.ts")).toEqual({ phase: "missing" });
    expect(diffState({ status: 200, body: { state: "gone" } }, s, "a.ts")).toEqual({ phase: "gone" });
    expect(diffState({ status: 200, body: { state: "no_file" } }, s, "a.ts")).toEqual({ phase: "missing" });
    expect(diffState({ status: 200, body: { state: "no_turn" } }, s, "a.ts")).toEqual({ phase: "notKept" });
    expect(summaryState({ status: 200, body: { state: "no_turn" } })).toEqual({ phase: "gone" });
  });
});

describe("the view's markup", () => {
  test("a unified diff: two number columns, the sign, the text; the tints by class; a hidden word for each change", () => {
    const html = renderToStaticMarkup(createElement(DiffBody, { hunks: HUNKS, cut: { shown: 14, more: 1412 } }));
    expect(html).toContain('class="chg-diff"');
    expect(html).toContain("--ln-w:2ch");
    expect(html).toContain('<div class="chg-dl is-del"><span class="chg-ln">20</span><span class="chg-ln"></span><span class="chg-sign" aria-hidden="true">-</span><span class="chg-lt"><span class="visually-hidden">Removed, line 20 </span>    await server.start();</span></div>');
    expect(html).toContain('<span class="visually-hidden">Added, line 20 </span>');
    expect(html).toContain('<div class="chg-hunk" role="separator" aria-label="describe(&quot;upload&quot;, () =&gt; {">');
    expect(html).toContain('class="chg-hunk is-seam"');
    expect(html).toContain('<p class="chg-say">1,412 more lines</p>');
    // The numbers are not copied with a selection of the code.
    expect(src("styles", "changes.css")).toMatch(/\.chg-ln \{[^}]*user-select: none/);
  });
  test("a new or a deleted file has one side only: one number column, no empty one", () => {
    const added = renderToStaticMarkup(createElement(DiffBody, { hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, context: "", lines: ["+a", "+b"] }] }));
    expect(added).toContain("--ln-n:1");
    expect(added).toContain('<div class="chg-dl is-add"><span class="chg-ln">1</span><span class="chg-sign" aria-hidden="true">+</span>');
    const gone = renderToStaticMarkup(createElement(DiffBody, { hunks: [{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, context: "", lines: ["-a"] }] }));
    expect(gone).toContain('<div class="chg-dl is-del"><span class="chg-ln">1</span><span class="chg-sign" aria-hidden="true">-</span>');
    expect(renderToStaticMarkup(createElement(DiffBody, { hunks: HUNKS }))).toContain("--ln-n:2");
    expect(src("styles", "changes.css")).toContain("grid-template-columns: repeat(var(--ln-n), var(--ln-w)) 1ch minmax(0, 1fr)");
  });

  test("the file's head: its name, its counts, its folder in --dim, one line for a new, deleted or renamed file", () => {
    const html = renderToStaticMarkup(createElement(FileHead, { file: { path: "test/unit/upload-wait.test.ts", added: 4, removed: 2, status: "R", from: "test/unit/upload.test.ts" } }));
    expect(html).toContain('<h2 class="side-page-title chg-file-name">upload-wait.test.ts</h2>');
    expect(html).toContain('<p class="chg-file-dir"><bdi>test/unit/</bdi></p>');
    expect(html).toContain('<p class="chg-file-note">Renamed from test/unit/upload.test.ts</p>');
    expect(html).toContain(">+4<");
    const bin = renderToStaticMarkup(createElement(FileHead, { file: { path: "logo.bin", added: 0, removed: 0, status: "A", binary: true } }));
    expect(bin).toContain('<span class="chg-word" aria-hidden="true">Binary</span>');
    expect(bin).not.toContain("chg-file-dir");
  });
  test("the list: each file with its word (New, Deleted, Renamed) and its counts; the foot for the changes left out", () => {
    const s = readSummary({ id: "k3m7q2x4ab", at: [], how: "git", total: 3, added: 5, removed: 41, others: 2, files: [{ path: "a.ts", added: 5, removed: 0, status: "A" }, { path: "old.ts", added: 0, removed: 41, status: "D" }, { path: "new.ts", added: 0, removed: 0, status: "R", from: "was.ts" }] })!;
    const html = renderToStaticMarkup(createElement(ListBody, { summary: s, link: (p: string) => `/x/${p}` }));
    expect(html).toContain('<ul class="group side-group chg-list">');
    expect(html).toContain('<a href="/x/a.ts" class="group-row chg-list-row" aria-label="a.ts, New, 5 added"');
    expect(html).toContain('aria-label="old.ts, Deleted, 41 removed"');
    expect(html).toContain('<span class="chg-word chg-status" aria-hidden="true">Deleted</span>');
    expect(html).toContain('<span class="chg-word chg-status" aria-hidden="true">Renamed</span>');
    expect(html).toContain('<p class="chg-foot">2 other files changed while Claude was not running a tool.</p>');
  });
  test("nothing in the view acts on the files: no button but Close, Back and Try again", () => {
    const view = src("changes", "ChangesView.tsx");
    const buttons = [...view.matchAll(/<button[^>]*>/g)].length;
    expect(buttons).toBeLessThanOrEqual(2);
    for (const word of ["Revert", "Stage", "Discard", "Apply", "apiSend"]) expect([word, view.includes(word)]).toEqual([word, false]);
    expect(src("changes", "api.ts")).not.toContain("apiSend");
  });
});

describe("the view's styles (DESIGN-U1 7.3)", () => {
  const css = src("styles", "changes.css");
  test("long lines always wrap under their own text: no sideways scroll", () => {
    expect(css).toMatch(/\.chg-lt \{[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;/);
    expect(css).not.toMatch(/\.chg-diff \{[^}]*overflow-x: (auto|scroll)/);
  });
  test("the Edit row's tints and the code ground; the seam is a dashed hairline in --faint; tokens only", () => {
    expect(css).toContain("color-mix(in srgb, var(--ok) 14%, transparent)");
    expect(css).toContain("color-mix(in srgb, var(--danger) 14%, transparent)");
    expect(css).toMatch(/\.chg-diff \{[^}]*background: var\(--code-bg\)/);
    expect(css).toMatch(/\.chg-hunk\.is-seam \{[^}]*border-top: 1px dashed var\(--hairline\)/);
    expect(css).toMatch(/\.chg-hunk \{[^}]*color: var\(--faint\)/);
    expect(css).toMatch(/\.chg-view-head \{[^}]*min-height: var\(--header-h\)/);
  });
  test("no motion of its own (the panel's own slide is the column's)", () => {
    expect(css).not.toMatch(/animation|transition/);
  });
});
