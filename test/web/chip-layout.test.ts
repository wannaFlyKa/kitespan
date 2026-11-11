// Row 76 (DECISIONS-OWNER, W19d; the owner's report of 2026-11-02): in a chat's box and in the new-chat form, the
// command chip never takes more of its line than leaves the field about 8em; a longer name is cut with an ellipsis and
// the whole name is the chip's title (the / menu shows it too); when the line is too narrow for the chip and the field
// side by side, the field starts flush left on a line of its own; Send never leaves the box; nothing is centred. With a
// mention chip and a 40-character plugin command (<plugin>:<command>) the phone's field was 0 px wide, Send was
// pushed out of the box and "all tests" typed key by key came out as "stset lla". No browser here: the parts are read
// from the sources and the stylesheets (the click-through measures the real page: scripts/ui-check.ts chip-layout and
// the form's flows).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WEB = join(import.meta.dir, "..", "..", "web");
const src = (...p: string[]) => readFileSync(join(WEB, ...p), "utf8");
const css = (file: string) => src("styles", file).replace(/\/\*[\s\S]*?\*\//g, "");
/** `part` is in `text` (a short failure line, not the whole file). */
const has = (text: string, part: string) => expect([part, text.includes(part)]).toEqual([part, true]);

/** The declarations of the rule whose selector list is exactly `selector` (the first one), or null. */
function rule(sheet: string, selector: string): string | null {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(sheet); m; m = re.exec(sheet)) if (m[1]!.trim() === selector) return m[2]!;
  return null;
}

/** The body of the first @container block in `sheet`, with its condition. */
function containerBlock(sheet: string): { cond: string; body: string } | null {
  const at = sheet.indexOf("@container");
  if (at < 0) return null;
  const open = sheet.indexOf("{", at);
  let depth = 1;
  let i = open + 1;
  for (; i < sheet.length && depth; i++) depth += sheet[i] === "{" ? 1 : sheet[i] === "}" ? -1 : 0;
  return { cond: sheet.slice(at + "@container".length, open).trim(), body: sheet.slice(open + 1, i - 1) };
}

const composerCss = css("composer.css");

describe("the line that holds the chip and the field (composer.css .cmp-line)", () => {
  test("one flex line that may wrap, in the field's own font size, so its em is the field's", () => {
    const line = rule(composerCss, ".cmp-line");
    expect(line).not.toBeNull();
    expect(line).toMatch(/display:\s*flex;/);
    expect(line).toMatch(/flex-wrap:\s*wrap;/);
    expect(line).toMatch(/min-width:\s*0;/);
    expect(line).toMatch(/flex:\s*1 1 0(px)?;/);
    expect(line).toMatch(/font-size:\s*var\(--fs-prose\);/);
    expect(line).toMatch(/container-type:\s*inline-size;/);
    expect(rule(composerCss, ".touch .cmp-line")).toMatch(/font-size:\s*var\(--fs-input\);/);
    // Laid out from the start: no centring of the field's text or of the line's items.
    expect(line).not.toMatch(/justify-content:\s*center/);
  });
  test("the chip shrinks and leaves the field 8em of the line; its name is cut with an ellipsis", () => {
    const chip = rule(composerCss, ".cmp-line > .cmp-chip.is-slash");
    expect(chip).toMatch(/flex:\s*0 1 auto;/);
    expect(chip).toMatch(/min-width:\s*0;/);
    expect(chip).toMatch(/max-width:\s*calc\(100% - 8 \* var\(--fs-prose\) - var\(--s2\)\);/);
    expect(rule(composerCss, ":where(.touch) .cmp-line > .cmp-chip.is-slash")).toMatch(/max-width:\s*calc\(100% - 8 \* var\(--fs-input\) - var\(--s2\)\);/);
    const name = rule(composerCss, ".cmp-chip-name");
    expect(name).toMatch(/min-width:\s*0;/);
    expect(name).toMatch(/overflow:\s*hidden;/);
    expect(name).toMatch(/text-overflow:\s*ellipsis;/);
    expect(name).toMatch(/white-space:\s*nowrap;/);
  });
  test("the field keeps 8em (all of a narrower line), and grows into the rest", () => {
    const field = rule(composerCss, ".cmp-line > textarea");
    expect(field).toMatch(/flex:\s*1 1 calc\(8 \* var\(--fs-prose\)\);/);
    expect(field).toMatch(/min-width:\s*min\(100%, calc\(8 \* var\(--fs-prose\)\)\);/);
    const touch = rule(composerCss, ":where(.touch) .cmp-line > textarea");
    expect(touch).toMatch(/flex:\s*1 1 calc\(8 \* var\(--fs-input\)\);/);
    expect(touch).toMatch(/min-width:\s*min\(100%, calc\(8 \* var\(--fs-input\)\)\);/);
  });
  test("a line too narrow for both: the chip takes the first line, and the field its own, flush left", () => {
    const block = containerBlock(composerCss);
    expect(block).not.toBeNull();
    expect(block!.cond).toMatch(/^\(width < 12em\)$/);
    expect(rule(block!.body, ".cmp-line > .cmp-chip.is-slash")).toMatch(/max-width:\s*100%;/);
    // The touch sizes' own rules weigh no more than these (:where), so these win there too.
    expect(composerCss).not.toMatch(/(^|\n)\.touch \.cmp-line > /);
    expect(composerCss.indexOf(":where(.touch) .cmp-line > textarea")).toBeLessThan(composerCss.indexOf("@container"));
    expect(rule(block!.body, ".cmp-line > .cmp-chip.is-slash ~ textarea")).toMatch(/flex-basis:\s*100%;/);
  });
  test("the / menu shows the whole name: one line while it fits, wrapped inside its row when it is longer", () => {
    const name = rule(composerCss, ".cmp-slash-name");
    expect(name).toMatch(/flex:\s*0 1 auto;/);
    expect(name).toMatch(/min-width:\s*0;/);
    expect(name).toMatch(/overflow-wrap:\s*anywhere;/);
    expect(name).not.toMatch(/white-space:\s*nowrap|text-overflow/);
    // The hint gives way first: it starts from no width of its own.
    expect(rule(composerCss, ".cmp-slash-hint")).toMatch(/flex:\s*1;/);
  });
  test("Send and the round keys never shrink, so the line gives way first", () => {
    expect(rule(composerCss, ".cmp-key")).toMatch(/flex:\s*none;/);
  });
  test("nothing in the field's row is centred sideways", () => {
    for (const sel of [".cmp-field", ".cmp-line", ".cmp-input", ".cmp-chip", ".cmp-chip.is-slash", ".cmp-chip-name"]) {
      const body = rule(composerCss, sel) ?? "";
      expect([sel, /text-align:\s*center|justify-content:\s*center/.test(body)]).toEqual([sel, false]);
    }
  });
});

describe("the composer's part (web/composer/Composer.tsx)", () => {
  const composer = src("composer", "Composer.tsx");
  test("the chip and the field share the line; +, @ and Send stay outside it, in the field's row", () => {
    expect(/<div className="cmp-line">\s*\{chip\}\s*<textarea\s/.test(composer)).toBe(true);
    const row = composer.slice(composer.indexOf('<div className="cmp-field">'), composer.indexOf('{phone ? null : (\n              <div className="cmp-bar">'));
    const order = ["{phone ? plusButton : null}", "{phone ? atButton : null}", '<div className="cmp-line">', "<textarea", "</div>", "{phone ? (held ? (canStop ? stopButton : copyButton) : stopShared ? stopButton : sendButton) : null}"].map((p) => row.indexOf(p));
    expect(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]!))).toBe(true);
  });
  test("the command chip: its name in a span that is cut, the whole name in its title", () => {
    has(composer, '<span className="cmp-chip is-slash" aria-hidden="true" title={d.command ? `/${d.command}` : undefined}>');
    has(composer, '<span className="cmp-chip-name">/{d.command ?? ""}</span>');
  });
});

describe("the chips over the field (W19d): the form's as the chat's, and one row never scrolls", () => {
  const screensCss = css("screens.css");
  test("the form's chip row is capped at about 2.3 rows and scrolls inside the box, as the chat's (.cmp-attach)", () => {
    const form = rule(screensCss, ".scr-attachments");
    const chat = rule(composerCss, ".cmp-attach");
    expect(chat).toMatch(/max-height:\s*calc\(2\.3 \* 40px \+ 2 \* var\(--s2\) \+ 4px\);/);
    expect(form).toMatch(/max-height:\s*calc\(2\.3 \* 40px \+ 2 \* var\(--s2\) \+ 4px\);/);
    expect(form).toMatch(/overflow-y:\s*auto;/);
    expect(form).toMatch(/overscroll-behavior:\s*contain;/);
    expect(form).toMatch(/align-content:\s*flex-start;/);
    // Room for a Remove button's focus ring inside the scroll box.
    expect(form).toMatch(/padding:\s*2px;/);
    expect(rule(screensCss, ".touch .scr-attachments")).toMatch(/max-height:\s*calc\(2\.3 \* var\(--touch\) \+ 2 \* var\(--s2\) \+ 4px\);/);
    // A chip just added comes into view, as in a chat's box.
    const formTsx = src("screens", "NewChatForm.tsx");
    has(formTsx, '<div ref={attachRow} className="scr-attachments" aria-label="Attachments" role="group">');
    has(formTsx, "if (row && chipTotal > chipCount.current) row.scrollTop = row.scrollHeight;");
  });
  test("on touch, Remove is the 44 px target itself, so its hit area stays inside the chip and one row of chips does not scroll", () => {
    // base.css widens the 20 px circle's hit area by 12 px each side on touch; in the boxes the button is 44 px already.
    expect(css("base.css")).toMatch(/\.touch \.attach-remove::after \{\s*inset: -12px;/);
    for (const [sheet, sel] of [
      [composerCss, ".touch .cmp-attach .attach-remove::after"],
      [screensCss, ".touch .scr-attachments .attach-remove::after"],
    ] as const) {
      const r = rule(sheet, sel);
      expect([sel, r !== null && /inset:\s*0;/.test(r)]).toEqual([sel, true]);
    }
  });
});
