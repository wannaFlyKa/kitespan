// T-31 (DESIGN-T1 2.7): a name wraps at its own punctuation first. breakable(text) puts a <wbr> before each "." and
// "_" (not at the name's start) and after each "/", so a narrow row breaks "UPLOAD-RETRIES.md" before ".md" and never
// inside a word; a <wbr> is no character, so the text a reader selects and copies is the name exactly.
import { describe, expect, test } from "bun:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { breakParts, breakable } from "../../web/ui/breakable";

const html = (text: string) => renderToStaticMarkup(createElement(Fragment, null, breakable(text)));
const textOf = (markup: string) => markup.replace(/<wbr\/?>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'");

describe("breakable", () => {
  test("a <wbr> before each . and _ and after each /", () => {
    expect(html("UPLOAD-RETRIES.md")).toBe("UPLOAD-RETRIES<wbr/>.md");
    expect(html("src/http/retry_test.ts")).toBe("src/<wbr/>http/<wbr/>retry<wbr/>_test<wbr/>.ts");
    expect(html("/Users/me/work/kitespan/docs/UPLOAD-RETRIES.md")).toBe("/<wbr/>Users/<wbr/>me/<wbr/>work/<wbr/>kitespan/<wbr/>docs/<wbr/>UPLOAD-RETRIES<wbr/>.md");
    expect(breakParts("upload.test.ts")).toEqual(["upload", ".test", ".ts"]);
  });

  test("none at the start, and none inside a run of signs", () => {
    expect(html(".env")).toBe(".env");
    expect(html("_private")).toBe("_private");
    expect(html("docs/.env")).toBe("docs/<wbr/>.env");
    expect(breakParts("__init__.py")).toEqual(["__init", "__.py"]);
    expect(breakParts("a..b")).toEqual(["a", "..b"]);
  });

  test("a name with no such sign is the text itself, and an end slash takes no break after it", () => {
    expect(breakable("README")).toBe("README");
    expect(breakable("")).toBe("");
    expect(html("UPLOAD-RETRIES")).toBe("UPLOAD-RETRIES");
    expect(breakParts("src/")).toEqual(["src/"]);
  });

  test("the rendered text is the input exactly: no character added, no U+200B", () => {
    for (const s of ["UPLOAD-RETRIES.md", "src/http/retry_test.ts", ".env", "a b/c d.txt", "/tmp/kitespan-uploads-dev/u-1/pasted.png", "weird<&>\"'.md", "名前_ファイル.txt"]) {
      const out = html(s);
      expect(out).not.toContain("​");
      expect(textOf(out)).toBe(s);
      expect(breakParts(s).join("")).toBe(s);
    }
  });
});
