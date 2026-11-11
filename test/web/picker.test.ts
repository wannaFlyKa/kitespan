// The `@` picker on the page (web/composer/MentionMenu.tsx, Chip.tsx, composer.css; DESIGN.md 6.4, 7.2, 7.5, 9.3;
// BUILD-CHECKLIST C6, D1, D2): rows of the chat folder's files from the search engine, the folder part dimmed before
// the name and the name's matched letters in bold, as text (never HTML); the root carries the query its rows answer
// and their true count (the gate's hook); one line once the list came and nothing matches, and nothing before; only a
// mouse moves the highlight; the mention chip (its Remove deletes nothing); the touch `@` button keeps the field's
// focus. No browser: the components render with react-dom/server, and their elements are pressed as functions.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { prepareCorpus } from "../../shared/match";
import { createFileEngine, type FileRows } from "../../web/search/engine";
import { AtButton, MentionMenu, blankPicker, markedName, mentionRow, mentionRows } from "../../web/composer/MentionMenu";
import { MentionChip } from "../../web/composer/Chip";
import { mentionChipsOf } from "../../web/composer/attach";

const WEB = join(import.meta.dir, "..", "..", "web");
const src = (...p: string[]) => readFileSync(join(WEB, ...p), "utf8");
const noop = () => {};
const menu = (rows: FileRows | null, active = 0) => renderToStaticMarkup(createElement(MentionMenu, { id: "m", rows, active, onPick: noop, onHover: noop, onClose: noop }));

const PATHS = ["web/composer/Composer.tsx", "web/composer/SlashMenu.tsx", "README.md", "docs/compose.md", "test/web/composer.test.ts"];
const engine = createFileEngine({ at: "page", corpus: prepareCorpus(PATHS, "v1") });

describe("the picker's rows (6.4)", () => {
  test("the folder's files for the filter, best first: the folder part dimmed, the name's matched letters in bold", () => {
    const rows = engine.rows("comp")!;
    expect(rows.q).toBe("comp");
    expect(rows.rows[0]!.path).toBe("web/composer/Composer.tsx");
    const html = menu(rows);
    expect(html).toContain('role="listbox"');
    expect(html).toContain('data-testid="mention-menu"');
    expect(html).toContain('data-q="comp"');
    expect(html).toContain(`data-count="${rows.count}"`);
    // The pane's rule (search.css .srch-path): one line, the folder part cut at its start (its own order kept in a
    // bdi), the name whole; the full path is the row's title, and the chip shows it after a pick (a tap on touch).
    expect(html).toContain('<span class="cmp-mention-path" title="web/composer/Composer.tsx"><span class="cmp-mention-dir"><bdi>web/composer/</bdi></span><span class="cmp-mention-name"><strong>Comp</strong>oser.tsx</span></span>');
    // A file at the folder's top has no folder part.
    expect(html).toMatch(/data-path="docs\/compose\.md"/);
    expect([...html.matchAll(/role="option"/g)].length).toBe(rows.rows.length);
    // The first row is the active one; the field points at it (aria-activedescendant, Composer.tsx).
    expect(html).toContain('id="m-0" role="option" aria-selected="true" data-path="web/composer/Composer.tsx" data-active="true"');
    expect(html).not.toContain('id="m-1" role="option" aria-selected="true"');
  });

  test("an empty filter lists the folder's files; at most 120 rows, with the true count", () => {
    const many = createFileEngine({ at: "page", corpus: prepareCorpus(Array.from({ length: 500 }, (_, i) => `src/f${i}.ts`)) });
    const rows = many.rows("")!;
    expect(rows.count).toBe(500);
    expect(rows.rows.length).toBe(120);
    const html = menu(rows);
    expect([...html.matchAll(/role="option"/g)].length).toBe(120);
    expect(html).toContain('data-count="500"');
  });

  test("one line once the list came and nothing matches; nothing before it came, when the search failed, or for an empty folder", () => {
    const none = engine.rows("zzzz")!;
    expect(none.count).toBe(0);
    const html = menu(none);
    expect(html).toContain('<p class="cmp-slash-empty" data-testid="mention-empty">No file matches @zzzz.</p>');
    expect(html).not.toContain("is-blank");
    for (const rows of [null, { q: "x", count: 0, rows: [], failed: true as const }, { q: "", count: 0, rows: [] }]) {
      expect(blankPicker(rows)).toBe(true);
      const blank = menu(rows);
      expect(blank).toContain("menu cmp-slash cmp-mention is-blank");
      expect(blank).not.toContain("No file matches");
      expect(blank).not.toContain('role="option"');
    }
    // Before the list came the root says no query: the gate waits for its rows.
    expect(menu(null)).not.toContain("data-q=");
  });

  test("the name's ranges are text children, clamped to the name; no HTML is made from a name or a path", () => {
    const parts = markedName("Composer.tsx", [[0, 4], [8, 9], [11, 40]]) as (string | ReactElement)[];
    expect(renderToStaticMarkup(createElement("span", null, ...parts))).toBe("<span><strong>Comp</strong>oser<strong>.</strong>ts<strong>x</strong></span>");
    expect(renderToStaticMarkup(createElement("span", null, ...(markedName("<b>x</b>.md", [[0, 3]]) as ReactElement[])))).toBe("<span><strong>&lt;b&gt;</strong>x&lt;/b&gt;.md</span>");
    for (const f of [src("composer", "MentionMenu.tsx"), src("composer", "mention.ts"), src("composer", "Chip.tsx"), src("chat", "items", "Files.tsx")]) {
      expect(f).not.toContain("dangerouslySetInnerHTML");
      expect(f).not.toContain("innerHTML");
    }
  });

  test("a row's tap picks it; only a mouse moves the highlight, so a finger that scrolls the rows picks nothing", () => {
    const picked: number[] = [];
    const hovered: number[] = [];
    const list = engine.rows("comp")!;
    const onPick = (i: number) => picked.push(i);
    const onHover = (i: number) => hovered.push(i);
    const rows = list.rows.map((row, index) => mentionRow({ id: "m", row, index, active: index === 0, onPick, onHover })) as ReactElement<{ onClick: () => void; onPointerMove: (e: { pointerType: string }) => void }>[];
    rows[1]!.props.onPointerMove({ pointerType: "touch" });
    rows[1]!.props.onPointerMove({ pointerType: "pen" });
    expect(hovered).toEqual([]);
    rows[1]!.props.onPointerMove({ pointerType: "mouse" });
    rows[0]!.props.onPointerMove({ pointerType: "mouse" });
    expect(hovered).toEqual([1]);
    rows[2]!.props.onClick();
    expect(picked).toEqual([2]);
  });

  test("the rows are memo rows with the same callbacks each render: a new highlight redraws the two rows it moved between", () => {
    const rows = engine.rows("comp")!;
    const a = mentionRows({ id: "m", rows, active: 0, onPick: noop, onHover: noop }) as ReactElement<Record<string, unknown>>[];
    const b = mentionRows({ id: "m", rows, active: 1, onPick: noop, onHover: noop }) as ReactElement<Record<string, unknown>>[];
    const memo = Symbol.for("react.memo");
    expect((a[0]!.type as { $$typeof?: symbol }).$$typeof).toBe(memo);
    const changed = a.map((el, i) => Object.keys(el.props).some((k) => el.props[k] !== b[i]!.props[k]));
    expect(changed).toEqual(a.map((_, i) => i === 0 || i === 1));
    // The picker itself is memo too: a composer render with the same rows (a streamed piece of the chat, a key that
    // changes no filter) skips it, because the composer hands it callbacks that keep their identity.
    expect((MentionMenu as unknown as { $$typeof?: symbol }).$$typeof).toBe(memo);
    const composer = src("composer", "Composer.tsx");
    expect(composer).toContain("<MentionMenu id={mentionId} rows={fileRows} active={mentionAt} maxHeight={slashMaxHeight} onPick={onMentionPick} onHover={setMentionActive} onClose={onMentionClose} />");
    expect(composer).toContain("const onMentionPick = useCallback((i: number) => live.current.pickMention(i), []);");
    expect(composer).toContain("const onMentionClose = useCallback(() => live.current.closeMention(), []);");
  });

  test("the picker keeps the field's focus (a press on it is prevented) and is a layer, so Esc closes it before Stop", () => {
    const code = src("composer", "MentionMenu.tsx");
    expect(code).toContain("onPointerDown={(e) => e.preventDefault()}");
    expect(code).toContain("useLayer({ active: true, box, onClose });");
  });
});

describe("the mention chip (6.4, owner row 54)", () => {
  const [chip] = mentionChipsOf(["web/composer/Composer.tsx"], "/work/kitespan/");
  const render = (open: boolean, onRemove = noop) => renderToStaticMarkup(createElement(MentionChip, { mention: chip!, open, pathId: "p", onToggle: noop, onRemove }));
  test("a file icon, the name, its folder part as its second line; a tap shows the absolute path", () => {
    expect(chip).toEqual({ path: "web/composer/Composer.tsx", name: "Composer.tsx", dir: "web/composer", abs: "/work/kitespan/web/composer/Composer.tsx", image: false });
    const html = render(false);
    expect(html).toContain('data-testid="mention-chip"');
    expect(html).toContain('data-path="web/composer/Composer.tsx"');
    expect(html).toContain('<span class="attach-name">Composer.tsx</span>');
    expect(html).toContain(">web/composer</span>");
    expect(html).toContain('title="/work/kitespan/web/composer/Composer.tsx"');
    expect(html).toContain('aria-label="Composer.tsx, in web/composer. Show its path"');
    expect(html).toContain('aria-expanded="false"');
    expect(render(true)).toContain('aria-expanded="true" aria-controls="p"');
    // No size: a folder's file is not an upload.
    expect(html).not.toMatch(/\d+ (B|KB|MB)/);
  });
  test("a file at the folder's top, an image, and no folder known", () => {
    const [top, pic] = mentionChipsOf(["README.md", "img/shot.PNG"], null);
    expect(top).toMatchObject({ name: "README.md", dir: "", abs: null, image: false });
    expect(pic).toMatchObject({ name: "shot.PNG", dir: "img", image: true });
    const html = renderToStaticMarkup(createElement(MentionChip, { mention: top!, open: false, pathId: "p", onToggle: noop, onRemove: noop }));
    expect(html).toContain('aria-label="README.md, in the chat&#x27;s folder. Show its path"');
    expect(html).not.toContain("mention-dir");
  });
  test("Remove takes it out of the message box only: its own test id, and act.removeMention (no upload's DELETE)", () => {
    const html = render(false);
    expect(html).toContain('data-testid="mention-remove"');
    expect(html).toContain('aria-label="Remove Composer.tsx"');
    expect(html).not.toContain('data-testid="attach-remove"');
    const composer = src("composer", "Composer.tsx");
    const remove = composer.slice(composer.indexOf("const removeMentionChip = "), composer.indexOf("const openPopup = "));
    expect(remove).toContain("act.removeMention(chat.id, path);");
    expect(remove).not.toContain("removeUpload");
  });
});

describe("the @ button on touch (7.5, D2)", () => {
  type Btn = ReactElement<{ onPointerDown: (e: { preventDefault: () => void }) => void; onClick: () => void; className: string }>;
  test("its press keeps the field's focus, as Send's does; its click opens the picker", () => {
    let opened = 0;
    let closed = 0;
    const el = AtButton({ open: false, onOpen: () => opened++, onClose: () => closed++ }) as Btn;
    let prevented = 0;
    el.props.onPointerDown({ preventDefault: () => prevented++ });
    expect(prevented).toBe(1);
    el.props.onClick();
    expect([opened, closed]).toEqual([1, 0]);
    const html = renderToStaticMarkup(createElement(AtButton, { open: true, onOpen: noop, onClose: noop }));
    expect(html).toContain('class="icon-btn cmp-at-btn"');
    expect(html).toContain('data-testid="composer-at"');
    expect(html).toContain('aria-label="Mention a file"');
    expect(html).toContain('aria-expanded="true"');
  });
  test("a tap while the picker shows closes it, as its aria-expanded says, and puts no second @ in the field", () => {
    let opened = 0;
    let closed = 0;
    const el = AtButton({ open: true, onOpen: () => opened++, onClose: () => closed++ }) as Btn;
    el.props.onClick();
    expect([opened, closed]).toEqual([0, 1]);
    // The composer's close: the picker goes, a typed filter stays as text (a link's token goes, as with Esc).
    const composer = src("composer", "Composer.tsx");
    const close = composer.slice(composer.indexOf("const closeAtPicker = "), composer.indexOf("const removeMentionChip = "));
    expect(close).toContain("closeMention();");
    expect(close).not.toContain("insertAt");
  });
});

describe("composer.css for the picker (7.2, 7.5)", () => {
  const css = src("styles", "composer.css").replace(/\/\*[\s\S]*?\*\//g, "");
  test("the picker is the / menu's frame (risen from the slab, its height rule, overscroll contained), drawn only with rows", () => {
    expect(src("composer", "MentionMenu.tsx")).toContain("className={`menu cmp-slash cmp-mention");
    expect(css).toMatch(/\.menu\.cmp-slash \{[^}]*bottom: calc\(100% \+ 6px\);[^}]*overscroll-behavior: contain;/);
    expect(css).toMatch(/\.menu\.cmp-mention\.is-blank \{\s*display: none;\s*\}/);
    // A path is one line, as in the search pane (search.css .srch-path): the name keeps its width and is never broken,
    // and the folder part takes what is left, cut at its start, so the slash before the name stays. A 300-character
    // path is one 44 px row on the phone, not a third of the picker.
    expect(css).toMatch(/\.cmp-mention-path \{[^}]*display: flex;[^}]*min-width: 0;[^}]*overflow: hidden;[^}]*white-space: nowrap;/);
    expect(css).toMatch(/\.cmp-mention-dir \{[^}]*flex: 0 1 auto;[^}]*min-width: 0;[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*direction: rtl;[^}]*text-align: left;/);
    expect(css).toMatch(/\.cmp-mention-name \{[^}]*flex: none;[^}]*max-width: 100%;[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;/);
    expect(css).toMatch(/\.cmp-mention-dir \+ \.cmp-mention-name \{\s*max-width: calc\(100% - 2em\);/);
    expect(css).not.toMatch(/\.cmp-mention-[a-z]+ \{[^}]*overflow-wrap: anywhere;/);
    // On the phone, the sheet's top corners; its rows are the touch menu's 44 px rows (base.css .touch .menu-row).
    expect(css).toMatch(/\.cmp\.is-phone \.menu\.cmp-mention \{[^}]*border-top-left-radius: var\(--r-sheet\);/);
    expect(src("styles", "base.css")).toMatch(/\.touch \.menu-row \{[^}]*min-height: var\(--touch\);/);
  });
  test("the @ button is a 44 px target on touch (--btn-h)", () => {
    expect(css).toMatch(/\.icon-btn\.cmp-at-btn \{[^}]*width: var\(--btn-h\);[^}]*height: var\(--btn-h\);/);
    const tokens = src("styles", "tokens.css");
    expect(tokens).toMatch(/body\.touch,[^{]*\{[^}]*--btn-h: var\(--touch\);/);
    expect(tokens).toContain("--touch: 44px;");
  });
});

describe("the picker asks with the field's filter (the pane's finding 9, shared by the picker)", () => {
  test("the rows follow the deferred filter, and the server is asked for the field's own filter at once", () => {
    const composer = src("composer", "Composer.tsx");
    expect(composer).toContain("const mentionFilter = useDeferredValue(mentionShown ? mention.filter : \"\");");
    expect(composer).toContain("useFileRows(mentionShown ? fileEngine : null, mentionFilter, mentionShown ? mention.filter : \"\")");
  });
});
