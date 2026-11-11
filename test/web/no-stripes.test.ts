// The owner's rule (2026-10-30): no coloured side stripe on a card, row or block ("this is very AI, remove it
// everywhere, only add it if necessary"). A one-sided border is allowed only as a 1 px --hairline divider between
// panes; the one exception is the Markdown quote, whose thin grey rule is what says "quoted". An inset shadow drawn
// on one side is the same stripe, so it is checked too, and so are the components' inline styles.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "..", "web");
const STYLES = join(SRC, "styles");
const SIDES = /^border-(left|right|inline-start|inline-end)(-width|-color|-style)?$/;
const ALLOWED: Record<string, string> = { ".chat-md blockquote": "2px solid var(--fill-strong)" };

/** Every declaration in a style sheet with its selector (nested @media blocks are walked). */
function declarations(css: string): { selector: string; prop: string; value: string }[] {
  const out: { selector: string; prop: string; value: string }[] = [];
  const walk = (text: string) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf("{", i);
      if (open < 0) break;
      const head = text.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      for (; j < text.length && depth > 0; j++) {
        if (text[j] === "{") depth++;
        else if (text[j] === "}") depth--;
      }
      const body = text.slice(open + 1, j - 1);
      if (head.startsWith("@")) walk(body);
      else
        for (const decl of body.split(";")) {
          const at = decl.indexOf(":");
          if (at > 0) out.push({ selector: head.replace(/\s+/g, " "), prop: decl.slice(0, at).trim(), value: decl.slice(at + 1).trim() });
        }
      i = j;
    }
  };
  walk(css.replace(/\/\*[\s\S]*?\*\//g, ""));
  return out;
}

const sheets = readdirSync(STYLES).filter((f) => f.endsWith(".css"));

describe("no side stripes", () => {
  for (const sheet of sheets) {
    test(`${sheet}: one-sided borders are 1 px hairline dividers`, () => {
      const bad = declarations(readFileSync(join(STYLES, sheet), "utf8"))
        .filter((d) => SIDES.test(d.prop))
        .filter((d) => !(d.prop.match(/^border-(left|right|inline-start|inline-end)$/) && /^(1px solid var\(--hairline\)|0|none)$/.test(d.value)))
        .filter((d) => ALLOWED[d.selector] !== d.value || d.prop !== "border-left")
        .map((d) => `${d.selector} { ${d.prop}: ${d.value} }`);
      expect(bad).toEqual([]);
    });

    test(`${sheet}: no one-sided inset shadow`, () => {
      const bad = declarations(readFileSync(join(STYLES, sheet), "utf8"))
        .filter((d) => d.prop === "box-shadow" && /inset\s+-?(?:[1-9][0-9.]*|0?\.[0-9]+)px\s+0(?:px)?\s+0/.test(d.value))
        .map((d) => `${d.selector} { box-shadow: ${d.value} }`);
      expect(bad).toEqual([]);
    });
  }

  test("components set no side border in inline styles", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name));
        else if (e.name.endsWith(".tsx")) files.push(join(dir, e.name));
      }
    };
    walk(SRC);
    const bad = files.filter((f) => /\bborder(Left|Right|InlineStart|InlineEnd)\s*:/.test(readFileSync(f, "utf8")));
    expect(bad).toEqual([]);
  });
});
