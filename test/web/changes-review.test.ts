// U1 review (the design critique and whose changes): the list's foot names another chat's changes apart from the
// user's; the fallback's head says "changed", as the git card and the turn line above it agree; a file with no counts
// (a pure rename, an empty new file) says what it is in the card and in its view; the list's status words and counts
// stand in columns and read at the card's type on touch; a tab is four characters; and a changes route entered from
// outside the page (a first load, a reload, Back or Forward) lands on its card on every size.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cardModel, elsewhereFoot, readSummary, rowLabel, type ChangesNote } from "../../web/changes/model";
import { ChangesCard } from "../../web/changes/ChangesCard";
import { DiffOf, ListBody } from "../../web/changes/ChangesView";
import { changesLanding } from "../../web/changes/nav";
import { parsePath } from "../../shared/route";

const WEB = join(import.meta.dir, "..", "..", "web");
const src = (...p: string[]) => readFileSync(join(WEB, ...p), "utf8");
const C = "demoolxxxxxxxxxxxxxx";
const T = "k3m7q2x4ab";

describe("whose changes: the list's foot", () => {
  test("another chat's changes in the folder have a line of their own; the user's keep theirs", () => {
    expect(elsewhereFoot(1)).toBe("1 other file changed by another chat in this folder.");
    expect(elsewhereFoot(3)).toBe("3 other files changed by other chats in this folder.");
    expect(elsewhereFoot(0)).toBeNull();
    const s = readSummary({ id: T, at: [], how: "git", total: 1, added: 1, removed: 0, others: 1, elsewhere: 2, files: [{ path: "a.ts", added: 1, removed: 0, status: "M" }] })!;
    expect(s.elsewhere).toBe(2);
    const html = renderToStaticMarkup(createElement(ListBody, { summary: s, link: (p: string) => `/x/${p}` }));
    expect(html).toContain('<p class="chg-foot">1 other file changed while Claude was not running a tool.</p>');
    expect(html).toContain('<p class="chg-foot">2 other files changed by other chats in this folder.</p>');
    expect(readSummary({ id: T, at: [], how: "git", total: 0, added: 0, removed: 0, others: 0, elsewhere: -1, files: [] })!.elsewhere).toBeUndefined();
  });
});

describe("the fallback's head agrees with the turn line above it (6.12)", () => {
  test("Claude's own edits: N files changed, as the git card (the panel's line says it is the fallback)", () => {
    const note: ChangesNote = { id: T, at: ["u1"], how: "edits", total: 2, added: 5, removed: 0, files: [{ path: "a.ts", added: 2, removed: 0, status: "M" }, { path: "b.md", added: 3, removed: 0, status: "A" }] };
    expect(cardModel(note).head?.words).toBe("2 files changed");
    expect(cardModel({ ...note, total: 1, files: note.files.slice(0, 1) }).line).toBe("1 file changed");
  });
});

describe("a file with no counts says what it is", () => {
  const renamed = { path: "src/cli/send.ts", added: 0, removed: 0, status: "R" as const, from: "src/cli/push.ts" };
  const empty = { path: "src/empty.ts", added: 0, removed: 0, status: "A" as const };
  test("in the card: Renamed (or New, Deleted) in the counts' place, as Binary is; read in its name too", () => {
    const note: ChangesNote = { id: T, at: ["u1"], how: "git", total: 3, added: 1, removed: 0, files: [renamed, empty, { path: "a.ts", added: 1, removed: 0, status: "M" }] };
    const html = renderToStaticMarkup(createElement(ChangesCard, { note, chatId: C, route: parsePath(`/c/${C}`), live: true, phone: false, open: null }));
    expect(html).toContain('aria-label="src/cli/send.ts, Renamed"');
    expect(html).toContain('<span class="chg-word" aria-hidden="true">Renamed</span>');
    expect(html).toContain('<span class="chg-word" aria-hidden="true">New</span>');
    expect(rowLabel(renamed)).toBe("src/cli/send.ts, Renamed");
  });
  test("in the list the status word is its own column, so the end shows no second Renamed", () => {
    const s = readSummary({ id: T, at: [], how: "git", total: 2, added: 1, removed: 0, others: 0, files: [renamed, { path: "a.ts", added: 1, removed: 0, status: "M" }] })!;
    const html = renderToStaticMarkup(createElement(ListBody, { summary: s, link: (p: string) => `/x/${p}` }));
    expect(html.match(/>Renamed</g)?.length).toBe(1);
    expect(html).toContain('aria-label="src/cli/send.ts, Renamed"');
    // A plain edit keeps an empty status cell, so the counts stay in their column.
    expect(html).toContain('<span class="chg-word chg-status" aria-hidden="true"></span>');
  });
  test("in the view: one quiet line where there are no lines to show", () => {
    expect(renderToStaticMarkup(createElement(DiffOf, { diff: { ...renamed, hunks: [] } }))).toContain("The content did not change.");
    expect(renderToStaticMarkup(createElement(DiffOf, { diff: { ...empty, hunks: [] } }))).toContain("An empty file.");
    expect(renderToStaticMarkup(createElement(DiffOf, { diff: { path: "gone.ts", added: 0, removed: 0, status: "D", hunks: [] } }))).toContain("An empty file.");
  });
});

describe("the list's type and columns, the diff's tabs (the styles)", () => {
  const css = src("styles", "changes.css");
  test("the list's rows read at the card's size on touch (not the touch size of the panel's other lists), 44 px high", () => {
    expect(css).toMatch(/\.touch \.chg-list-row \{[^}]*font-size: var\(--fs-small\)/);
    expect(css).not.toMatch(/\.touch \.chg-list-row \{[^}]*min-height/);
  });
  test("the status words and the counts stand in columns: the list is a grid whose rows share its tracks", () => {
    expect(css).toMatch(/\.chg-list \{[^}]*display: grid;[^}]*grid-template-columns: minmax\(0, 1fr\) max-content max-content/);
    expect(css).toMatch(/\.chg-list > li \{[^}]*grid-template-columns: subgrid/);
    expect(css).toMatch(/\.chg-list-row \{[^}]*grid-template-columns: subgrid/);
  });
  test("a tab is four characters, as the chat's code blocks", () => {
    expect(css).toMatch(/\.chg-diff \{[^}]*tab-size: 4/);
  });
});

describe("a changes route entered from outside the page lands on its card on every size", () => {
  const r = parsePath(`/c/${C}/changes/${T}/src/a.ts`);
  test("the phone always; the laptop and the tablet when the page opened on it or came to it by Back or Forward", () => {
    expect(changesLanding(r, true)).toBe(T);
    expect(changesLanding(r, false, true)).toBe(T);
    // The card's own row opened it: the reader's place stays.
    expect(changesLanding(r, false, false)).toBeNull();
    expect(changesLanding(parsePath(`/c/${C}/shell`), false, true)).toBeNull();
  });
  test("ChatView marks the card only on the phone, and asks whether the route came from outside", () => {
    const view = src("chat", "ChatView.tsx");
    expect(view).toContain("changesLanding(route, phone, enteredFromOutside");
    expect(view).toMatch(/highlightId = [^;]*phone && landed/);
  });
});
