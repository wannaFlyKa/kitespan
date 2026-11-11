// The composer's side of the files flow (D37, D50): pasted names, and the chips over the field, which are the draft's
// upload ids and nothing in the text (the server adds the references at send). Also: composer.css uses only tokens
// (plan v3), so each of the four looks restyles the composer, and the field is its own direction island. No browser.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Upload } from "../../web/state/types";
import { chipsOf, pastedFacts, unknownIds, uploadFromView, waitsForUpload } from "../../web/composer/attach";
import { DraftChip } from "../../web/composer/Chip";

const WEB = join(import.meta.dir, "..", "..", "web");
const up = (id: string, path: string, state: Upload["state"] = "done"): Upload => ({
  id,
  chatId: "c1",
  name: path.split("/").pop() || "x",
  size: 1200,
  type: "text/plain",
  path,
  folder: "temp",
  dir: path.slice(0, path.lastIndexOf("/")),
  at: "2026-01-01T00:00:00.000Z",
  state,
  progress: state === "uploading" ? 0.5 : 1,
});
const A = "/tmp/kitespan-uploads-dev/u-aaaaaa/notes.txt";
const B = "/tmp/kitespan-uploads-dev/u-bbbbbb/my screen.png";

describe("pasted files", () => {
  test("a pasted image without a name of its own goes nameless, so act.upload names it pasted.<subtype>", () => {
    const out = pastedFacts([
      { name: "image.png", size: 5, type: "image/png" },
      { name: "", size: 5, type: "image/jpeg" },
      { name: "diagram.png", size: 5, type: "image/png" },
      { name: "image.png", size: 5, type: "" },
      { name: "notes.txt", size: 5, type: "text/plain" },
    ]);
    expect(out.map((f) => f.name)).toEqual(["", "", "diagram.png", "image.png", "notes.txt"]);
    expect(out[0]).toEqual({ name: "", size: 5, type: "image/png" });
  });
});

describe("the chips are the draft's uploads (D50)", () => {
  const none = new Set<string>();
  test("the draft's ids show in its order; an earlier upload the draft does not name does not", () => {
    const list = [up("u1", A), up("u2", B), up("u3", "/tmp/old/u-cccccc/old.log")];
    expect(chipsOf({ chatId: "c1", ids: ["u2", "u1"], uploads: list, putAside: none }).map((u) => u.id)).toEqual(["u2", "u1"]);
    expect(chipsOf({ chatId: "c1", ids: [], uploads: list, putAside: none })).toEqual([]);
  });
  test("a file on its way from this page shows after them, and Send waits for it", () => {
    const list = [up("u1", A), up("up-pending-1", "", "uploading")];
    const chips = chipsOf({ chatId: "c1", ids: ["u1"], uploads: list, putAside: none });
    expect(chips.map((u) => u.id)).toEqual(["u1", "up-pending-1"]);
    expect(waitsForUpload(chips)).toBe(true);
    expect(waitsForUpload(chipsOf({ chatId: "c1", ids: ["u1"], uploads: [up("u1", A)], putAside: none }))).toBe(false);
  });
  test("a failed upload shows until Remove, or until a Send puts it aside", () => {
    const failed = { ...up("u9", ""), state: "failed" as const, error: "That file is larger than the 100 MB limit." };
    expect(chipsOf({ chatId: "c1", ids: [], uploads: [failed], putAside: none }).map((u) => u.id)).toEqual(["u9"]);
    expect(chipsOf({ chatId: "c1", ids: [], uploads: [failed], putAside: new Set(["u9"]) })).toEqual([]);
  });
  test("an id another page added: a chip at once, named once the chat's list is read again", () => {
    const list = [up("u1", A)];
    expect(unknownIds(["u1", "u7"], list)).toEqual(["u7"]);
    const first = chipsOf({ chatId: "c1", ids: ["u1", "u7"], uploads: list, putAside: none });
    expect(first[1]).toMatchObject({ id: "u7", unknown: true, name: "", path: "" });
    const read = new Map([["u7", uploadFromView({ id: "u7", chat: "c1", project: "p1", name: "plan.md", size: 40, type: "text/markdown", path: "/tmp/x/u-dddddd/plan.md" }, "c1")]]);
    expect(unknownIds(["u1", "u7"], list, read)).toEqual([]);
    expect(chipsOf({ chatId: "c1", ids: ["u1", "u7"], uploads: list, extra: read, putAside: none })[1]).toMatchObject({ id: "u7", name: "plan.md", dir: "/tmp/x/u-dddddd", state: "done" });
  });
});

describe("a chip shows its path on a tap, and the field never holds one", () => {
  const render = (u: Upload, open: boolean) => renderToStaticMarkup(createElement(DraftChip, { upload: u, open, pathId: "p", onToggle() {}, onRemove() {} }));
  test("a done chip's body is a button that says it shows the path; Remove is its own button", () => {
    const html = render(up("u1", A), false);
    expect(html).toContain('data-testid="attach-u1"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Show its path");
    expect(html).toContain('data-testid="attach-remove"');
    expect(html).toContain(">1 KB<");
    expect(render(up("u1", A), true)).toContain('aria-controls="p"');
    // The chip never prints the path itself: the composer's one line under the chips does, after the tap.
    expect(html.replace(/title="[^"]*"/, "")).not.toContain(A);
  });
  test("a chip on its way, a failed one and one not read yet have no path to show", () => {
    expect(render(up("u2", "", "uploading"), false)).not.toContain("aria-expanded");
    const failed = render({ ...up("u3", ""), state: "failed", error: "That file is larger than the 100 MB limit." }, false);
    expect(failed).toContain("That file is larger than the 100 MB limit.");
    expect(failed).not.toContain("aria-expanded");
    expect(render({ ...up("u4", ""), name: "", unknown: true } as Upload, false)).toContain(">File<");
  });
  test("the composer adds no reference to the field: the server adds them at send", () => {
    const src = readFileSync(join(WEB, "composer", "Composer.tsx"), "utf8");
    for (const gone of ["draftWithRefs", "draftWithoutRef", "refsInMode", "refEdit", "uploadRef"]) expect(src).not.toContain(gone);
    expect(src).toContain('data-testid="composer-chip-path"');
    // dir="auto" isolates the field's text, so a typed or pasted right-to-left override cannot reorder the text around it.
    expect(src).toMatch(/<textarea\s+ref=\{field\}\s+className="cmp-input"\s+data-testid="composer-input"\s+dir="auto"/);
  });
});

describe("composer.css uses only tokens (plan v3)", () => {
  const css = readFileSync(join(WEB, "styles", "composer.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const decls = [...css.matchAll(/([a-z-]+)\s*:\s*([^;{}]+);/g)].map((m) => [m[1]!, m[2]!.trim()] as const);
  test("no literal colour, shadow colour, radius, font, font size, font weight or material", () => {
    const bad: string[] = [];
    for (const [prop, value] of decls) {
      const v = value.replace(/var\([^)]*\)/g, "");
      if (/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|color-mix\(|\b(white|black)\b/i.test(v)) bad.push(`${prop}: ${value}`);
      if (/radius/.test(prop) && /\d/.test(v)) bad.push(`${prop}: ${value}`);
      if ((prop === "font-family" || prop === "font") && !/^var\(--font-|^inherit$/.test(value)) bad.push(`${prop}: ${value}`);
      if (prop === "font-size" && !/^(var\(--fs-[a-z0-9-]+\)|inherit)$/.test(value)) bad.push(`${prop}: ${value}`);
      if (prop === "font-weight" && !/^var\(--(weight-strong|fw-regular)\)$/.test(value)) bad.push(`${prop}: ${value}`);
      if (/backdrop-filter/.test(prop)) bad.push(`${prop}: ${value}`);
    }
    expect(bad).toEqual([]);
  });
  test("every token it reads is defined in tokens.css", () => {
    const tokens = readFileSync(join(WEB, "styles", "tokens.css"), "utf8");
    const defined = new Set([...tokens.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
    const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]!));
    expect([...used].filter((t) => !defined.has(t))).toEqual([]);
  });
  test("on touch the mode and model pills and a chip's Remove are 44 px buttons", () => {
    expect(css).toMatch(/\.touch \.cmp-pick,[^{]*\{[^}]*height: var\(--touch\)/);
    expect(css).toMatch(/\.touch \.cmp-attach \.attach-remove \{[^}]*width: var\(--touch\);[^}]*height: var\(--touch\)/);
    expect(css).toMatch(/\.touch \.cmp-forget \{[^}]*min-height: var\(--touch\)/);
  });
});
