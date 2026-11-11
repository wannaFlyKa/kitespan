// G-34 (DESIGN-T1 2.8): Safari on iOS and iPadOS reads user-select only with its -webkit- prefix, and the page's build
// adds no prefix, so a rule that keeps line numbers, diff signs or a code head's label out of a long-press selection
// must say both. Every rule of web/styles that sets `user-select: none` also sets `-webkit-user-select: none`.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const STYLES = join(import.meta.dir, "..", "..", "web", "styles");

/** Each rule's selector and body, comments left out; nested blocks (media, container) give their own rules. */
export function rulesOf(css: string): { selector: string; body: string; line: number }[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  const out: { selector: string; body: string; line: number }[] = [];
  const re = /([^{}]*)\{([^{}]*)\}/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push({ selector: m[1]!.trim(), body: m[2]!, line: text.slice(0, m.index + m[1]!.length).split("\n").length });
  }
  return out;
}

describe("-webkit-user-select beside user-select", () => {
  test("the rule reader finds a nested rule and its line", () => {
    const rules = rulesOf("a { color: red; }\n@media (x) {\n  .b {\n    user-select: none;\n  }\n}\n");
    expect(rules.map((r) => r.selector)).toEqual(["a", ".b"]);
    expect(rules[1]!.line).toBe(3);
  });

  test("every rule with user-select: none has its -webkit- twin", () => {
    const missing: string[] = [];
    const files = readdirSync(STYLES).filter((f) => f.endsWith(".css"));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      for (const r of rulesOf(readFileSync(join(STYLES, f), "utf8"))) {
        const plain = /(^|[;\s])user-select:\s*none\b/.test(r.body);
        const prefixed = /-webkit-user-select:\s*none\b/.test(r.body);
        if (plain && !prefixed) missing.push(`${f}:${r.line} ${r.selector}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
