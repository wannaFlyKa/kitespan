// What the page draws before the server's first answer (DESIGN.md 5.1 rule 5: an id is judged only after welcome and
// the chat list, "never against an empty list from before that answer"). Before the first chat list nothing draws;
// after the dial deadline, when the server still has not answered, only the connection line shows: no route, so no
// "That chat is not here." and no "No chats yet." against a list that is not known.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BootWait, bootView } from "../../web/App";

const WEB = join(import.meta.dir, "..", "..", "web");

describe("before the first chat list", () => {
  test("nothing at first; after the dial deadline the connection line; the screens once the list came", () => {
    expect(bootView(false, false)).toBe("none");
    expect(bootView(false, true)).toBe("wait");
    expect(bootView(true, false)).toBe("app");
    expect(bootView(true, true)).toBe("app");
  });

  test("the wait shows only the connection line, never a 5.4 line or an empty list's line", () => {
    const html = renderToStaticMarkup(createElement(BootWait));
    expect(html).toContain("Reconnecting...");
    expect(html).toContain('role="status"');
    for (const line of ["is not here", "No chats yet", "not waiting", "not in this"]) expect(html).not.toContain(line);
  });

  test("App draws its screens only when the store is ready (no deadline fallback to the routes)", () => {
    const src = readFileSync(join(WEB, "App.tsx"), "utf8");
    expect(src).not.toMatch(/return ready \|\| late/);
    expect(src).toMatch(/bootView\(/);
  });
});
