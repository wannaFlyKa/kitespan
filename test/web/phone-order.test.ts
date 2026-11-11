// FIX-Q1 2: the phone's card buttons are in the order the eye reads. On the phone a card's answers (and a dialog's)
// stack with the main action on top; they used to be drawn main action last and turned over by the CSS
// (column-reverse), so Tab and a screen reader met Deny first. Now where they stack the main action comes first in the
// DOM too, and the CSS keeps that order, so the look is the same at every size. The real layout's order is ui-check's
// (the route check reads the buttons' places on screen); here the markup and the styles.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WaitingCard } from "../../web/chat/cards/WaitingCard";
import { TerminalBody } from "../../web/dialogs/ChatDialogs";
import { parse } from "../../web/router";
import { RestartBody } from "../../web/settings/RestartDialog";
import { restartLists } from "../../web/settings/restart";
import { resetState } from "../../web/state/store";
import type { Chat } from "../../web/state/types";
import { CHATS, scripted } from "./fixtures";

const gm = globalThis as unknown as { matchMedia?: unknown; window?: unknown };
const was = { mm: gm.matchMedia, win: gm.window, hadMm: "matchMedia" in gm, hadWin: "window" in gm };
let coarse = false;
function viewport(width: number, height: number, touch: boolean) {
  coarse = touch;
  gm.window = { innerWidth: width, innerHeight: height, addEventListener() {}, removeEventListener() {} };
}
beforeAll(() => {
  gm.matchMedia = (q: string) => ({ matches: coarse && q === "(pointer: coarse)", addEventListener() {}, removeEventListener() {} });
});
afterAll(() => {
  if (was.hadMm) gm.matchMedia = was.mm;
  else delete gm.matchMedia;
  if (was.hadWin) gm.window = was.win;
  else delete gm.window;
  resetState();
});

const PHONE = () => viewport(390, 844, true);
const LAPTOP = () => viewport(1280, 800, false);

/** The test ids of the buttons in a card's answer row (or a dialog's), in DOM order. */
function rowOrder(html: string, row: "chat-card-actions" | "dialog-actions"): string[] {
  const at = html.indexOf(`class="${row}`);
  expect(at).toBeGreaterThan(-1);
  const end = html.indexOf("</section>", at) > 0 ? html.indexOf("</section>", at) : html.length;
  return [...html.slice(at, end).matchAll(/<button[^>]*data-testid="([^"]+)"/g)].map((m) => m[1]!);
}

function card(kind: string): string {
  const chat = CHATS.find((c) => c.pending.some((k) => k.kind === kind))!;
  const k = chat.pending.find((x) => x.kind === kind)!;
  resetState({ chats: structuredClone(CHATS), ready: true });
  return renderToStaticMarkup(createElement(WaitingCard, { chat, card: k, index: chat.pending.indexOf(k), route: parse(new URL(`/c/${chat.id}`, "http://127.0.0.1")) }));
}

describe("a card's buttons in the order the eye reads (FIX-Q1)", () => {
  test("on the phone the main action comes first in the DOM: permission, question, plan, form and dialog cards", () => {
    PHONE();
    expect(rowOrder(card("permission"), "chat-card-actions")).toEqual(["confirm-once", "confirm-session", "confirm-deny"]);
    expect(rowOrder(card("question"), "chat-card-actions")).toEqual(["confirm-submit"]);
    // The plan card's options are a list, the first option first, at every size.
    expect(rowOrder(card("plan"), "chat-card-actions")).toEqual(["confirm-auto", "confirm-manual", "confirm-keep-planning"]);
    expect(rowOrder(card("elicitation"), "chat-card-actions")).toEqual(["confirm-accept", "confirm-decline", "confirm-cancel"]);
    const dialog = rowOrder(card("dialog"), "chat-card-actions");
    const primary = CHATS.flatMap((c) => c.pending).find((k) => k.kind === "dialog")!;
    expect(dialog[0]).toBe(`confirm-${(primary as { choices: { id: string; primary?: boolean }[] }).choices.find((c) => c.primary)!.id}`);
  });

  test("on the laptop the row keeps today's order, the main action last at the right", () => {
    LAPTOP();
    expect(rowOrder(card("permission"), "chat-card-actions")).toEqual(["confirm-deny", "confirm-session", "confirm-once"]);
    expect(rowOrder(card("elicitation"), "chat-card-actions")).toEqual(["confirm-cancel", "confirm-decline", "confirm-accept"]);
    expect(rowOrder(card("plan"), "chat-card-actions")).toEqual(["confirm-auto", "confirm-manual", "confirm-keep-planning"]);
    // The phone's order is the laptop's turned over, for every card but the plan's list.
    for (const kind of ["permission", "question", "elicitation", "dialog"]) {
      LAPTOP();
      const row = rowOrder(card(kind), "chat-card-actions");
      PHONE();
      expect(rowOrder(card(kind), "chat-card-actions")).toEqual([...row].reverse());
    }
  });

  test("the styles stack the phone's buttons in DOM order (no column-reverse), as they stack a row that does not fit", () => {
    const strip = (f: string) => readFileSync(join(import.meta.dir, "..", "..", "web", "styles", f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const chat = strip("chat.css");
    const base = strip("base.css");
    expect(chat).toMatch(/\.chat-card-actions\[data-fit="stack"\],\s*\[data-size="phone"\] \.chat-card-actions \{\s*flex-direction: column;/);
    expect(base).toMatch(/body\[data-size="phone"\] \.dialog-actions \{\s*flex-direction: column;/);
    for (const css of [chat, base]) expect(css).not.toMatch(/(chat-card-actions|dialog-actions)[^{]*\{[^}]*column-reverse/);
  });
});

describe("a dialog's buttons in the order the eye reads on the phone (FIX-Q1)", () => {
  const SID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
  const live = (): Chat =>
    scripted({ id: "k3m7q2x4abk3m7q2x4ab", projectId: "k3m7q2x4ab", title: "Ship", titleSource: "first-prompt", state: "running", updatedAt: "2026-11-02T08:00:00.000Z", sessionId: SID, model: "default", effort: "default", mode: "default", items: [{ id: "u1", kind: "user", text: "go" }], pending: [], context: { usedPct: 0, usedTokens: 0, windowTokens: 0, parts: [] }, connectors: [], outputs: [] });

  test("Copy the command: End it here, the main action, on top of Copy a fork command on the phone's sheet; the laptop's row as before", () => {
    LAPTOP();
    resetState({ chats: [live()], ready: true });
    const body = (sheet: boolean) => renderToStaticMarkup(createElement(TerminalBody, { chat: live(), folder: "/work", sheet, onClose: () => {} }));
    expect(rowOrder(body(false), "dialog-actions")).toEqual(["confirm-copy-fork", "confirm-end-here"]);
    PHONE();
    expect(rowOrder(body(true), "dialog-actions")).toEqual(["confirm-end-here", "confirm-copy-fork"]);
  });

  test("Restart: Restart when they finish on top, Restart now with its clause under it on the phone; the laptop's row as before", () => {
    const running = scripted({ ...live(), serverState: "running" } as Chat);
    const lists = restartLists([running], []);
    const body = (sheet: boolean, wait: { text: string } | null = null) => renderToStaticMarkup(createElement(RestartBody, { lists, ask: null, wait, sheet, onClose: () => {} }));
    LAPTOP();
    expect(rowOrder(body(false), "dialog-actions")).toEqual(["confirm-restart-now", "confirm-restart"]);
    PHONE();
    expect(rowOrder(body(true), "dialog-actions")).toEqual(["confirm-restart", "confirm-restart-now"]);
    expect(rowOrder(body(true, { text: "Waits" }), "dialog-actions")).toEqual(["confirm-cancel-restart", "confirm-restart-now"]);
    // The clause stays right under Restart now.
    const html = body(true);
    expect(html.indexOf('data-testid="restart-clause"')).toBeGreaterThan(html.indexOf('data-testid="confirm-restart-now"'));
  });
});
