// The chat lists on the real store (BUILD-CHECKLIST B6, E3, E4; DESIGN.md 6.2, 6.9, 7.7; D48; MINIMALISM M4, M6 to M10):
// archived chats are out of the groups, their counts, Recent and the project page, and only in the archived view that
// the Archived row opens, which shows only while an archived chat exists; a heading counts its waiting chats only while
// folded; a row under the Needs input filter drops the word; the foot says nothing while the socket is open; a row's
// menu ends with Archive (Stop and archive on a busy chat, Unarchive on an archived one) and Delete; Home shows Recent
// only where no docked sidebar lists the same chats; the swipe on a touch row only moves the row, and the tap that
// closes its actions opens nothing; the bar names /chats only on the phone and no later route's page (M31); and the
// phone's list shows the line of a request the server refused.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parse } from "../../web/router";
import { resetState } from "../../web/state/store";
import type { Chat } from "../../web/state/types";
import { ChatListBody, headingCount, listGroups, rowMenuItems, showArchivedRow, shownGroups, swallowNextClick, viewHref } from "../../web/screens/ChatListBody";
import { ChatList } from "../../web/screens/ChatList";
import { screenTitle } from "../../web/layout/TopBar";
import { mixesProjects, recentChats, showsRecent } from "../../web/screens/Home";
import { isBusy, SCREEN_NOTICE_MS } from "../../web/screens/common";
import { NOTICE_MS } from "../../web/chat/ChatScreen";
import { CHATS, PROJECTS } from "./fixtures";

const ARCHIVED = "oldo5xxxxxxxxxxxxxxx"; // "Try the markdown renderer", asleep
const IDLE = "idleo6xxxxxxxxxxxxxx";
const WAITING = "demoolxxxxxxxxxxxxxx";
const RUNNING = "runo4xxxxxxxxxxxxxxx";

const withArchived = (): Chat[] => CHATS.map((c) => (c.id === ARCHIVED ? { ...c, archived: true } : { ...c }));
const byId = (chats: Chat[], id: string) => chats.find((c) => c.id === id)!;
const text = (html: string) => html.replace(/<span class="visually-hidden">[^<]*<\/span>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

// The list reads the viewport (layout/size.ts): a laptop window with a mouse, or a phone with touch, for these renders.
const gm = globalThis as unknown as { matchMedia?: unknown; window?: unknown };
const own = { mm: !gm.matchMedia, win: !gm.window };
let coarse = false;
function viewport(width: number, height: number, touch: boolean) {
  coarse = touch;
  gm.window = { innerWidth: width, innerHeight: height, addEventListener() {}, removeEventListener() {} };
}
beforeAll(() => {
  gm.matchMedia = (q: string) => ({ matches: coarse && q === "(pointer: coarse)", addEventListener() {}, removeEventListener() {} });
  viewport(1100, 800, false);
});
afterAll(() => {
  if (own.mm) delete gm.matchMedia;
  if (own.win) delete gm.window;
  resetState();
});

function render(path: string, chats: Chat[], net: "open" | "down" = "open", variant: "sidebar" | "screen" = "sidebar") {
  resetState({ projects: structuredClone(PROJECTS), chats, net, ready: true });
  return renderToStaticMarkup(createElement(ChatListBody, { route: parse(new URL(path, "http://127.0.0.1")), variant }));
}

describe("the groups and the archived view (D48, 6.2)", () => {
  test("an archived chat is out of every group and every count, and only the archived view lists it", () => {
    const chats = withArchived();
    for (const view of ["all", "working", "needs-input"] as const) {
      const ids = listGroups(chats, PROJECTS, view).flatMap((g) => g.shown.map((c) => c.id));
      expect(ids).not.toContain(ARCHIVED);
    }
    const archived = listGroups(chats, PROJECTS, "archived");
    expect(archived.flatMap((g) => g.shown.map((c) => c.id))).toEqual([ARCHIVED]);
    expect(shownGroups(archived, "archived").map((g) => g.project.id)).toEqual(["scratchxxx"]);
    expect(archived.every((g) => g.needs === 0)).toBe(true);
  });

  test("the All view keeps every project's heading; a filter keeps only the groups it has rows for", () => {
    const groups = listGroups(CHATS, PROJECTS, "working");
    expect(shownGroups(groups, "working").map((g) => g.project.id)).toEqual(["notesxxxxx", "scratchxxx"]);
    expect(shownGroups(listGroups(CHATS, PROJECTS, "all"), "all").length).toBe(PROJECTS.length);
  });

  test("a heading counts its chats that need input only while it is folded (M6)", () => {
    const kitespan = listGroups(CHATS, PROJECTS, "all").find((g) => g.project.id === "kitespanxx")!;
    expect(kitespan.needs).toBe(2);
    expect(headingCount(kitespan, false)).toBeNull();
    expect(headingCount(kitespan, true)).toBe(2);
    expect(headingCount({ needs: 0 }, true)).toBeNull();
  });

  test("the Archived row shows only while an archived chat exists, and opens /chats?filter=archived", () => {
    expect(showArchivedRow(CHATS)).toBe(false);
    expect(showArchivedRow(withArchived())).toBe(true);
    expect(viewHref("archived")).toBe("/chats?filter=archived");
    expect(viewHref("all")).toBe("/chats");
  });
});

describe("the list as it renders", () => {
  test("All: the archived chat is not listed; the Archived row is, at the end, with no count", () => {
    const html = render("/", withArchived());
    expect(html).not.toContain(`href="/c/${ARCHIVED}"`);
    expect(html).toContain(`href="/c/${IDLE}"`);
    const row = html.match(/<a href="\/chats\?filter=archived"[^>]*data-testid="archived-row"[^>]*>([^<]*)<\/a>/);
    expect(row?.[1]).toBe("Archived");
    expect(html.indexOf('data-testid="archived-row"')).toBeGreaterThan(html.lastIndexOf('class="scr-row"'));
  });

  test("no archived chat: no Archived row", () => {
    expect(render("/", CHATS.map((c) => ({ ...c })))).not.toContain('data-testid="archived-row"');
  });

  test("/chats?filter=archived lists the archived chats only, under its title, with no segment on", () => {
    const html = render("/chats?filter=archived", withArchived(), "open", "screen");
    expect(html).toContain(`href="/c/${ARCHIVED}"`);
    expect(html).not.toContain(`href="/c/${IDLE}"`);
    expect(html).not.toContain('aria-checked="true"');
    expect(html).toMatch(/<h2 class="scr-view-title"[^>]*>Archived<\/h2>/);
    expect(html).not.toContain('data-testid="archived-row"');
    // An archived group starts no chat: no New chat in it.
    expect(html).not.toContain("New chat in scratch");
  });

  test("a heading's name is the link to its project; an open heading shows no count", () => {
    const html = render("/", CHATS.map((c) => ({ ...c })));
    expect(html).toMatch(/<a href="\/p\/kitespanxx" class="scr-group-name"[^>]*>kitespan<\/a>/);
    expect(html).not.toContain("scr-group-needs");
    expect(html).toContain('aria-label="New chat in kitespan"');
  });

  test("under the Needs input filter a row keeps its dot and drops the word (M7); elsewhere the word leads", () => {
    const filtered = render("/chats?filter=needs-input", CHATS.map((c) => ({ ...c })), "open", "screen");
    expect(filtered).toContain('class="dot waiting"');
    expect(text(filtered)).not.toContain("Needs input Fix the flaky upload test");
    expect(text(render("/", CHATS.map((c) => ({ ...c }))))).toContain("Needs input Fix the flaky upload test");
  });

  test("under the Working filter a row keeps its dot and drops the word Working (M7); its state is still read out", () => {
    const running = byId(CHATS, RUNNING);
    const filtered = render("/chats?filter=working", CHATS.map((c) => ({ ...c })), "open", "screen");
    expect(filtered).toContain('class="dot running"');
    expect(filtered).not.toContain('<span class="scr-meta scr-meta-working">Working</span>');
    expect(filtered).toMatch(/<span class="scr-meta"><span class="visually-hidden">Working, <\/span>/);
    expect(text(filtered)).toContain(running.title);
    // Under All the word stays.
    expect(render("/chats", CHATS.map((c) => ({ ...c })), "open", "screen")).toContain('<span class="scr-meta scr-meta-working">Working</span>');
  });

  test("the foot says nothing while the socket is open, and Reconnecting... only while it is not (M4)", () => {
    const open = render("/", CHATS.map((c) => ({ ...c })), "open");
    expect(open).not.toContain("Connected");
    expect(open).toMatch(/<p class="scr-conn" role="status" data-testid="connection" data-state="connected"><\/p>/);
    expect(render("/", CHATS.map((c) => ({ ...c })), "down")).toContain("Reconnecting...");
  });

  test("on touch the + of a heading shows its name, and a row shows no swipe actions until it is swiped", () => {
    viewport(390, 844, true);
    try {
      const html = render("/chats", CHATS.map((c) => ({ ...c })), "open", "screen");
      expect(html).toContain('<span class="scr-group-act-name">New chat</span>');
      expect(html).not.toContain(">Project<");
      expect(html).not.toContain('data-testid="row-swipe"');
    } finally {
      viewport(1100, 800, false);
    }
  });
});

describe("a row's menu (6.2, 6.10)", () => {
  test("Rename, Open in terminal, then Archive and Delete, last", () => {
    expect(rowMenuItems(byId(CHATS, IDLE))).toEqual(["Rename", "Open in terminal", "Archive", "Delete"]);
  });
  test("a busy chat's item reads Stop and archive: a turn runs, a card waits, or a task that is not ambient runs", () => {
    expect(rowMenuItems(byId(CHATS, RUNNING))).toEqual(["Rename", "Open in terminal", "Stop and archive", "Delete"]);
    expect(rowMenuItems(byId(CHATS, WAITING))[2]).toBe("Stop and archive");
    const idle = byId(CHATS, IDLE);
    expect(isBusy({ ...idle, tasks: [{ taskId: "t1", description: "build", ambient: false }] })).toBe(true);
    expect(isBusy({ ...idle, tasks: [{ taskId: "t1", description: "watch", ambient: true }] })).toBe(false);
    expect(isBusy({ ...idle, turn: 7 })).toBe(true);
    expect(isBusy({ ...idle, serverState: "sleeping", state: "sleeping", tasks: [{ taskId: "t1", description: "old", ambient: false }] })).toBe(false);
  });
  test("an archived row offers Unarchive and Delete only", () => {
    expect(rowMenuItems(byId(withArchived(), ARCHIVED))).toEqual(["Unarchive", "Delete"]);
  });
});

describe("Home's lists (6.9, M9, M10)", () => {
  test("Recent is the 10 newest chats that are not archived", () => {
    const recent = recentChats(withArchived());
    expect(recent.map((c) => c.id)).not.toContain(ARCHIVED);
    expect(recent.length).toBe(9);
    expect(recent[0]!.updatedAt >= recent[recent.length - 1]!.updatedAt).toBe(true);
  });
  test("Recent shows where no docked sidebar lists the same chats", () => {
    expect([showsRecent("docked"), showsRecent("drawer"), showsRecent("screen")]).toEqual([false, true, true]);
  });
  test("the phone names a Recent row's project only when Recent mixes projects", () => {
    expect(mixesProjects(CHATS)).toBe(true);
    expect(mixesProjects(CHATS.filter((c) => c.projectId === "scratchxxx"))).toBe(false);
  });
});

describe("a swipe alone sends nothing (principle 3, 7.7)", () => {
  test("the row's pointer handlers only move the row; acting is in the buttons' click handlers", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "web", "screens", "ChatListBody.tsx"), "utf8");
    const from = src.indexOf("const onPointerDown");
    const to = src.indexOf("const x = drag");
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const handlers = src.slice(from, to);
    for (const acting of ["act.", "pressArchive(", "navigate(", "archive()"]) expect([acting, handlers.includes(acting)]).toEqual([acting, false]);
  });
});

describe("a tap anywhere else only closes the swipe actions (7.7)", () => {
  /** An event at a time stamp, which records whether a listener stopped it (the flag itself resets after dispatch). */
  const ev = (type: string, at: number) => {
    const e = new Event(type, { cancelable: true, bubbles: true }) as Event & { stopped?: boolean };
    Object.defineProperty(e, "timeStamp", { value: at });
    e.stopPropagation = () => {
      e.stopped = true;
      Event.prototype.stopPropagation.call(e);
    };
    return e;
  };
  test("the click that ends the closing tap is swallowed before any handler, wherever it lands, and only that one", () => {
    // The listener is window's, in the capture phase: stopping the click there keeps it from every element under it.
    const win = new EventTarget();
    swallowNextClick(win, 10);
    win.dispatchEvent(ev("pointerup", 20));
    const first = ev("click", 21);
    win.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true); // a link does not follow its href
    expect(first.stopped).toBe(true); // and no handler under window hears it
    const next = ev("click", 400);
    win.dispatchEvent(next);
    expect([next.defaultPrevented, next.stopped]).toEqual([false, undefined]);
  });
  test("a tap that became a scroll, or a later press, stops the wait: the next tap acts", () => {
    const win = new EventTarget();
    swallowNextClick(win, 10);
    win.dispatchEvent(ev("pointercancel", 30));
    const a = ev("click", 500);
    win.dispatchEvent(a);
    expect(a.defaultPrevented).toBe(false);
    swallowNextClick(win, 600);
    win.dispatchEvent(ev("pointerdown", 900)); // the swipe's own tap gave no click; this is a new press
    const b = ev("click", 950);
    win.dispatchEvent(b);
    expect(b.defaultPrevented).toBe(false);
  });
  test("the row's page listener swallows the closing tap for every target but the actions", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "web", "screens", "ChatListBody.tsx"), "utf8");
    const at = src.indexOf("const down = (e: PointerEvent) =>");
    const body = src.slice(at, src.indexOf("};", at));
    expect(body).toContain("if (actions.current?.contains(t)) return;");
    expect(body).toContain("swallowNextClick(window, e.timeStamp);");
    expect(body).not.toContain("closing");
  });
});

describe("the bar's title (M31: no second title over a page's own large title)", () => {
  test("/chats: the phone's list screen says Chats; on a laptop the main column under it is Home, so nothing", () => {
    expect(screenTitle("chats", "screen")).toBe("Chats");
    expect(screenTitle("chats", "docked")).toBe("");
    expect(screenTitle("chats", "drawer")).toBe("");
  });
  test("/search has its large title, so the bar names nothing; Settings keeps its name; the Browser has none of its own", () => {
    for (const name of ["search", "chatSearch", "home", "new", "project"]) expect([name, screenTitle(name, "docked")]).toEqual([name, ""]);
    expect(screenTitle("settings", "docked")).toBe("Settings");
    // Iteration 7: /browser is the pane itself, with no large title, so a bar that shows over it names it.
    for (const name of ["browser", "browserTab"]) expect(screenTitle(name, "screen")).toBe("Browser");
  });
});

describe("a refused request's line on a screen with no chat (D48 Archive from a row)", () => {
  test("the phone's chat list shows the line at its top; a good list shows none", () => {
    viewport(390, 844, true);
    try {
      const route = parse(new URL("/chats", "http://127.0.0.1"));
      resetState({ projects: structuredClone(PROJECTS), chats: CHATS.map((c) => ({ ...c })), net: "open", ready: true, notice: "That chat is not here. It may have been deleted." });
      const html = renderToStaticMarkup(createElement(ChatList, { route }));
      expect(html).toMatch(/<p class="notice fallback-line" role="status" data-testid="screen-notice">That chat is not here\. It may have been deleted\.<\/p>/);
      resetState({ projects: structuredClone(PROJECTS), chats: CHATS.map((c) => ({ ...c })), net: "open", ready: true });
      expect(renderToStaticMarkup(createElement(ChatList, { route }))).not.toContain("screen-notice");
    } finally {
      viewport(1100, 800, false);
    }
  });
  test("it stays as long as the chat screen's line does", () => {
    expect(SCREEN_NOTICE_MS).toBe(NOTICE_MS);
  });
});
