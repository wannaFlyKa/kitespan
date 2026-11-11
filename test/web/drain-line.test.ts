// The drain notice on the page (DESIGN.md 4.10 step 3; build checklist S9, L14) and an upload that the restart cut
// (S18). While Restart when they finish waits, the chat list's foot and a chat's screen show the server's line with
// Cancel restart and Restart now, until the notice goes; an upload whose connection the restart's stop cut shows one
// short line. Rendered with React's server renderer.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "../../web/net/api";
import { parse } from "../../web/router";
import { ChatListBody } from "../../web/screens/ChatListBody";
import { DrainLine } from "../../web/settings/DrainLine";
import { RESTART_WORDS } from "../../web/settings/restart";
import { UPLOAD_CUT_LINE, resetState, uploadFailedLine } from "../../web/state/store";

const WEB = join(import.meta.dir, "..", "..", "web");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const ids = (html: string) => [...html.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]!);
const LINE = "kitespan restarts when the running turns end.";

const g = globalThis as unknown as { matchMedia?: unknown; window?: unknown };
const was = { mm: g.matchMedia, win: g.window, hadMm: "matchMedia" in g, hadWin: "window" in g };
beforeAll(() => {
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  g.window = { innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {} };
});
afterAll(() => {
  if (was.hadMm) g.matchMedia = was.mm;
  else delete g.matchMedia;
  if (was.hadWin) g.window = was.win;
  else delete g.window;
  resetState();
});

describe("the drain notice's line (S9, L14)", () => {
  test("while the drain waits: the line with Cancel restart and Restart now; none otherwise", () => {
    resetState({ ready: true, restartWait: { id: "restart", text: LINE } });
    const html = renderToStaticMarkup(createElement(DrainLine));
    expect(text(html)).toContain(LINE);
    expect(ids(html)).toEqual(["drain-line", "drain-cancel", "drain-now"]);
    expect(text(html)).toContain(RESTART_WORDS.cancel);
    expect(text(html)).toContain(RESTART_WORDS.now);
    expect(RESTART_WORDS.cancel).toBe("Cancel restart");
    expect(RESTART_WORDS.now).toBe("Restart now");
    resetState({ ready: true, restartWait: null });
    expect(renderToStaticMarkup(createElement(DrainLine))).toBe("");
  });

  test("the chat list's foot shows it", () => {
    resetState({ ready: true, restartWait: { id: "restart", text: LINE } });
    const html = renderToStaticMarkup(createElement(ChatListBody, { route: parse(new URL("/", "http://127.0.0.1")), variant: "sidebar" }));
    expect(ids(html)).toContain("drain-line");
  });

  test("a chat's screen shows it in place of its notice line, and its buttons act on their click only", () => {
    const screen = readFileSync(join(WEB, "chat", "ChatScreen.tsx"), "utf8");
    expect(screen).toContain("<DrainLine");
    const line = readFileSync(join(WEB, "settings", "DrainLine.tsx"), "utf8");
    expect(line).toContain("onClick={() => void act.cancelRestart()}");
    expect(line).toContain('onClick={() => void act.restart("now")}');
  });
});

describe("an upload that the restart's stop cut (S18)", () => {
  test("one short line while kitespan restarts; any other failure keeps its own line", () => {
    const cut = new ApiError(0, "network", "kitespan could not be reached.");
    expect(UPLOAD_CUT_LINE).toBe("The restart stopped the upload. Try again.");
    expect(uploadFailedLine(cut, true)).toBe(UPLOAD_CUT_LINE);
    expect(uploadFailedLine(cut, false)).toBe("kitespan could not be reached.");
    expect(uploadFailedLine(new ApiError(413, "too_large", "That file is larger than the 100 MB limit."), true)).toBe("That file is larger than the 100 MB limit.");
  });
});
