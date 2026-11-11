// Owner row 92: "kitespan" at the top left of the chat list is a link to Home (/), the app's own link, so a plain click
// navigates in place and a middle or Cmd-click opens a new tab. It shows wherever the list's head does: the laptop
// sidebar (docked, or the drawer under 1,000 px) and the tablet's drawer; the phone's list screen has no head. Its name
// is "kitespan, home", and the keyboard's focus shows the ring.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parse } from "../../web/router";
import { resetState } from "../../web/state/store";
import { DEFAULT_VIEW } from "../../web/state/catalog";
import type { Chat } from "../../web/state/types";
import { Shell } from "../../web/layout/Shell";
import { ChatListBody } from "../../web/screens/ChatListBody";
import { CHATS, PROJECTS } from "./fixtures";

const CHAT = "demoolxxxxxxxxxxxxxx";
const at = (u: string) => parse(new URL(u, "http://127.0.0.1"));

const gm = globalThis as unknown as { matchMedia?: unknown; window?: unknown; history?: unknown };
const own = { mm: !gm.matchMedia, win: !gm.window, hist: !gm.history };
let coarse = false;
function viewport(width: number, height: number, touch: boolean) {
  coarse = touch;
  gm.window = { innerWidth: width, innerHeight: height, addEventListener() {}, removeEventListener() {} };
}
beforeAll(() => {
  gm.matchMedia = (q: string) => ({ matches: coarse && q === "(pointer: coarse)", addEventListener() {}, removeEventListener() {} });
  gm.history ??= { state: null };
  resetState({ projects: structuredClone(PROJECTS), chats: structuredClone(CHATS), ready: true, view: { ...DEFAULT_VIEW } });
});
afterAll(() => {
  if (own.mm) delete gm.matchMedia;
  if (own.win) delete gm.window;
  if (own.hist) delete gm.history;
  resetState();
});

const chatOf = (): Chat => CHATS.find((c) => c.id === CHAT)!;
const shell = (path: string) =>
  renderToStaticMarkup(createElement(Shell, { route: at(path), chat: chatOf(), side: () => createElement("div"), children: createElement("div", { className: "chat-screen" }) }));
/** The list head's links and buttons, each as its tag and attributes, with its text. */
const head = (html: string) => {
  const m = /<div class="scr-list-head">([\s\S]*?)<\/div>/.exec(html);
  return m ? m[1]! : null;
};
const BRAND = /<a href="\/" class="scr-brand" aria-label="kitespan, home">kitespan<\/a>/;

describe("kitespan at the top left is a link to Home", () => {
  test("the laptop's docked sidebar (1280 and 1100 px), and the large touch tablet's", () => {
    for (const [w, h, touch] of [[1280, 800, false], [1100, 800, false], [1366, 1024, true]] as const) {
      viewport(w, h, touch);
      const top = head(shell(`/c/${CHAT}`));
      expect([w, top !== null && BRAND.test(top)]).toEqual([w, true]);
      // The link comes first in the head: the order on the screen, and the keyboard's.
      expect(top!.indexOf("scr-brand")).toBeLessThan(top!.indexOf('aria-label="Search'));
    }
  });

  test("the drawer's list (the tablet at 834 x 1194, a laptop window under 1,000 px), from /chats", () => {
    for (const [w, h, touch] of [[834, 1194, true], [900, 800, false]] as const) {
      viewport(w, h, touch);
      const html = renderToStaticMarkup(createElement(ChatListBody, { route: at("/chats"), variant: "drawer" }));
      expect([w, BRAND.test(head(html) ?? "")]).toEqual([w, true]);
    }
  });

  test("the phone's list screen has no head, so no such link (unchanged)", () => {
    viewport(390, 844, true);
    const html = renderToStaticMarkup(createElement(ChatListBody, { route: at("/chats"), variant: "screen" }));
    expect(html).not.toContain("scr-brand");
    expect(html).not.toContain("kitespan, home");
  });

  test("its look: the brand's own colour, no underline, the focus ring kept, a 44 px target on touch (screens.css)", () => {
    const css = readFileSync(join(import.meta.dir, "..", "..", "web", "styles", "screens.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = (sel: string) => new RegExp(`(^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`).exec(css)?.[2] ?? "";
    expect(rule(".scr-brand")).toContain("color: var(--text)");
    expect(rule(".scr-brand")).toContain("text-decoration: none");
    expect(css).not.toMatch(/\.scr-brand[^{]*\{[^}]*outline: (none|0)/);
    expect(rule(".touch .scr-brand")).toContain("min-height: var(--touch)");
  });
});
