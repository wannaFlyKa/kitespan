// U4 (FIX-U4, DESIGN-U4): two views in the side panel, one above the other. The page's rules as plain functions
// (web/layout/split.ts): the pair a URL names and its halves top to bottom, where a link inside a half goes, where an
// opener outside the panel goes (rules 1 to 4), what closing a half gives, the two spellings of one pair, the
// toggles' lit state, the column's width with and without the Terminal as the window narrows, the divider's limits,
// keys and drag, the fold of a short column, and the share the device keeps.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { href, parse, type Route } from "../../web/router";
import {
  SPLIT_MIN,
  SPLIT_MIN_TOUCH,
  SPLIT_STEP,
  cleanSplit,
  halfBack,
  halfClose,
  halfLink,
  halfOwnHref,
  halfTitle,
  halvesOf,
  kindShown,
  kindToggle,
  openHref,
  pairHref,
  pairOf,
  railShowHref,
  samePair,
  shareOf,
  sideWidth,
  splitDrag,
  splitFolds,
  splitKey,
  splitRange,
  splitShows,
} from "../../web/layout/split";
import { shellLayout } from "../../web/layout/size";
import { shownScope } from "../../web/search/SearchPane";
import { loadView } from "../../web/state/store";

const C = "demoolxxxxxxxxxxxxxx";
const X = "5e1d7a20-3b4c-4d5e-8f60-71829304a5b6";
const at = (u: string): Route => parse(new URL(u, "http://127.0.0.1"));
const P = (rest: string) => `/c/${C}/${rest}`;
const FILE = "test/unit/upload.test.ts";

/** The halves top to bottom as "<value> <path or other>". */
const halves = (u: string) => {
  const p = pairOf(at(u));
  return p ? halvesOf(p).map((h) => `${h.value} ${h.path ? "path" : "other"}`) : null;
};

describe("the pair a URL names", () => {
  test("the URL's own view and the other view, top to bottom; the Terminal below", () => {
    expect(halves(P(`files/${FILE}?below=shell`))).toEqual([`files/${FILE} path`, "shell other"]);
    expect(halves(P(`shell?type=resume&above=files/${FILE}`))).toEqual([`files/${FILE} other`, "shell path"]);
    expect(halves(P("search?q=upload&below=shell"))).toEqual(["search path", "shell other"]);
    expect(halves(P(`files/${FILE}?above=outputs`))).toEqual(["outputs other", `files/${FILE} path`]);
    expect(halves(P("context?below=btw"))).toEqual(["context path", "btw other"]);
    expect(halves(P(`btw/${X}?above=details`))).toEqual(["details other", `btw/${X} path`]);
  });
  test("one view, a refused pair, a route outside the panel: no pair", () => {
    for (const u of [P("context"), P("context?below=outputs"), P("shell?below=context"), `/c/${C}?below=shell`, P("send?text=hi&below=shell")]) expect([u, pairOf(at(u))]).toEqual([u, null]);
  });
  test("each half is a route of its own: the URL's own view keeps its keys, the other has the transcript view only", () => {
    const p = pairOf(at(P("search?q=upl&scope=files&view=verbose&below=shell")))!;
    expect([p.path.route.name, p.path.route.query]).toEqual(["chatSearch", { q: "upl", scope: "files", view: "verbose", below: "shell" }]);
    expect([p.other.route.name, p.other.route.query]).toEqual(["shell", { view: "verbose" }]);
    expect(p.path.route.half).toEqual({ url: P("search?q=upl&scope=files&view=verbose&below=shell"), slot: "upper", path: true });
    expect(p.other.route.half).toEqual({ url: P("search?q=upl&scope=files&view=verbose&below=shell"), slot: "lower", path: false });
    // A link pre-fills only the URL's own view: the other half never types, fills or marks.
    const q = pairOf(at(P("outputs?below=shell")))!;
    expect(q.other.route.query).toEqual({});
  });
  test("the halves' names (the divider is named for the upper one)", () => {
    const names = ["details", "environment", "context", "connectors", "outputs", "uploads", `files/${FILE}`, "search", "btw", `btw/${X}`, "shell"].map((v) => halfTitle(at(P(v))));
    expect(names).toEqual(["Details", "Environment", "Context", "Connectors", "Outputs", "Uploads", "Files", "Search", "Side chat", "Side chat", "Terminal"]);
    expect(halfTitle(at(`/c/${C}`))).toBe("Details");
  });
});

describe("pairHref: the builder of a pair", () => {
  test("the view used last is the path; the other goes above or below it", () => {
    expect(pairHref(P(`files/${FILE}`), { value: "shell", slot: "lower" })).toBe(P(`files/${FILE}?below=shell`));
    expect(pairHref(P("shell?type=resume"), { value: "outputs", slot: "upper" })).toBe(P("shell?type=resume&above=outputs"));
    expect(pairHref(P("context?view=verbose&below=shell"), { value: "btw", slot: "lower" })).toBe(P("context?view=verbose&below=btw"));
    expect(pairHref(P("context?below=shell"), null)).toBe(P("context"));
  });
  test("never a pair the decoder refuses: the Terminal above, the same kind", () => {
    expect(pairHref(P("context"), { value: "shell", slot: "upper" })).toBe(P("context"));
    expect(pairHref(P("context"), { value: "outputs", slot: "lower" })).toBe(P("context"));
  });
});

describe("a link inside a half navigates that half (4.2)", () => {
  const half = (u: string, slot: "upper" | "lower") => {
    const p = pairOf(at(u))!;
    return halvesOf(p).find((h) => h.slot === slot)!.route;
  };
  test("today's drill-downs stay in their half: the cards to Context, Outputs to a file and back, a search pick", () => {
    expect(halfLink(half(P("details?below=shell"), "upper"), P("context"))).toBe(P("context?below=shell"));
    expect(halfLink(half(P("outputs?below=shell"), "upper"), P(`files/${FILE}`))).toBe(P(`files/${FILE}?below=shell`));
    expect(halfLink(half(P(`files/${FILE}?below=shell`), "upper"), P("outputs"))).toBe(P("outputs?below=shell"));
    expect(halfLink(half(P("search?q=upl&below=shell"), "upper"), P(`files/${FILE}`))).toBe(P(`files/${FILE}?below=shell`));
    // The other half (here the upper one, the Terminal the URL's own view) navigates the same way.
    expect(halfLink(half(P("shell?above=details"), "upper"), P("uploads"))).toBe(P("uploads?below=shell"));
    // The side chat below the cards: a card's link keeps the side chat below.
    expect(halfLink(half(P("btw?above=details"), "upper"), P("environment"))).toBe(P("environment?below=btw"));
  });
  test("a view whose kind the other half shows goes to that half", () => {
    expect(halfLink(half(P("outputs?below=uploads"), "upper"), P(`files/${FILE}`))).toBe(P(`files/${FILE}?above=outputs`));
    expect(halfLink(half(P("uploads?above=search"), "upper"), P(`files/${FILE}`))).toBe(P(`files/${FILE}?above=search`));
  });
  test("the view keeps the transcript view; a link out of the panel leaves the pair", () => {
    expect(halfLink(half(P("details?view=verbose&below=shell"), "upper"), P("context?view=verbose"))).toBe(P("context?view=verbose&below=shell"));
    expect(halfLink(half(P("details?below=shell"), "upper"), P("slash/compact"))).toBe(P("slash/compact"));
    expect(halfLink(half(P("search?below=shell"), "upper"), `/c/${C}/m/toolu_01AbCdEf?mark=upl`)).toBe(`/c/${C}/m/toolu_01AbCdEf?mark=upl`);
    expect(halfLink(half(P("search?below=shell"), "upper"), "/c/oldo5xxxxxxxxxxxxxx")).toBe("/c/oldo5xxxxxxxxxxxxxx");
  });
  test("a route that is no half: the link as it is", () => {
    expect(halfLink(at(P("details")), P("context"))).toBe(P("context"));
  });
  test("typing in the half that is not the URL's own view makes it the URL's own view; the places stay", () => {
    expect(halfLink(half(P("shell?above=search"), "upper"), href("chatSearch", { chat: C }, { q: "upl" }))).toBe(P("search?q=upl&below=shell"));
    expect(halfLink(half(P("context?below=btw"), "lower"), P("btw"))).toBe(P("btw?above=context"));
  });
  test("halfOwnHref: the side box's first letter or Send in the other half makes it the URL's own view, in place (review U4)", () => {
    expect(halfOwnHref(half(P("context?above=btw"), "upper"))).toBe(P("btw?below=context"));
    expect(halfOwnHref(half(P("context?below=btw"), "lower"))).toBe(P("btw?above=context"));
    expect(halfOwnHref(half(P("shell?above=btw"), "upper"))).toBe(P("btw?below=shell"));
    expect(halfOwnHref(half(P(`context?view=verbose&below=btw/${X}`), "lower"))).toBe(P(`btw/${X}?view=verbose&above=context`));
    // The URL's own view already, or no half: nothing to do.
    expect(halfOwnHref(half(P("btw?above=context"), "lower"))).toBeNull();
    expect(halfOwnHref(at(P("btw")))).toBeNull();
    // Then the next opener takes the half that was not typed in (4.2 rule 4).
    expect(openHref(at(P("btw?below=context")), P("search"), true)).toBe(P("search?above=btw"));
  });
});

describe("a back row inside a half goes back in its own place (review U4)", () => {
  const half = (u: string, slot: "upper" | "lower") => halvesOf(pairOf(at(u))!).find((h) => h.slot === slot)!.route;
  test("its target of a kind the other half shows: the target alone (this half closes), never the same URL or the other half", () => {
    // "< Uploads" below the cards (back to Details) was the URL on screen; now the cards take the whole column.
    expect(halfBack(half(P("details?below=uploads"), "lower"), P("details"))).toBe(P("details"));
    // "< Uploads" above Context changed the lower half to the cards; now the cards alone.
    expect(halfBack(half(P("context?above=uploads"), "upper"), P("details"))).toBe(P("details"));
    // "< Outputs" on a file below the cards made the upper half Outputs; now Outputs alone.
    expect(halfBack(half(P(`details?below=files/${FILE}`), "lower"), P("outputs"))).toBe(P("outputs"));
    expect(halfBack(half(P(`details?view=verbose&below=files/${FILE}`), "lower"), P("outputs?view=verbose"))).toBe(P("outputs?view=verbose"));
  });
  test("any other back row goes back in its half, the other half staying (the link rule)", () => {
    expect(halfBack(half(P("context?below=shell"), "upper"), P("details"))).toBe(P("details?below=shell"));
    expect(halfBack(half(P(`files/${FILE}?below=shell`), "upper"), P("outputs"))).toBe(P("outputs?below=shell"));
    expect(halfBack(half(P("context?above=uploads"), "lower"), P("details"))).toBe(P("details?above=uploads"));
    expect(halfBack(half(P("context?below=btw"), "upper"), P("details"))).toBe(P("details?below=btw"));
    // A route that is no half: as it is.
    expect(halfBack(at(P("context")), P("details"))).toBe(P("details"));
  });
});

describe("the search pane as the other half keeps its scope, as its field keeps its text (review U4)", () => {
  test("the URL's own view shows the URL's scope; the other half, whose URL holds none, the scope it showed", () => {
    const own = pairOf(at(P("search?q=upl&scope=files&above=outputs")))!;
    expect(shownScope(own.path.route, null)).toBe("files");
    expect(shownScope(own.path.route, "chats")).toBe("files");
    const other = pairOf(at(P("files/docs/UPLOAD-RETRIES.md?below=search")))!;
    expect(other.other.route.query).toEqual({});
    expect(shownScope(other.other.route, "files")).toBe("files");
    // Opened as the other half (a link, a reload): plain, every kind.
    expect(shownScope(other.other.route, null)).toBeNull();
    // One view, as before.
    expect(shownScope(at(P("search?q=upl&scope=commands")), null)).toBe("commands");
    expect(shownScope(at(P("search?q=upl")), "files")).toBeNull();
  });
});

describe("closing a half gives the whole panel to the other (4.3)", () => {
  test("the other view alone: the URL's own view with its keys, or the other's path with the transcript view", () => {
    const p = pairOf(at(P("search?q=upl&view=verbose&below=shell")))!;
    expect(halfClose(p.path.route)).toBe(P("shell?view=verbose"));
    expect(halfClose(p.other.route)).toBe(P("search?q=upl&view=verbose"));
    const q = pairOf(at(P(`shell?type=resume&above=files/${FILE}`)))!;
    expect(halfClose(q.path.route)).toBe(P(`files/${FILE}`));
    expect(halfClose(q.other.route)).toBe(P("shell?type=resume"));
  });
  test("a route that is no half closes as before", () => {
    expect(halfClose(at(P("shell")))).toBeNull();
  });
});

describe("an opener outside the panel (4.2 rules 1 to 4)", () => {
  const open = (from: string, to: string, live = true) => openHref(at(from), to, live);
  test("1. its kind shows in a half: that half shows it, in its place", () => {
    expect(open(P("outputs?below=shell"), P("context"))).toBe(P("context?below=shell"));
    expect(open(P("shell?above=outputs"), P("context"))).toBe(P("context?below=shell"));
    expect(open(P("context"), P("details"))).toBe(P("details"));
    expect(open(P("shell?above=details"), P("shell?type=resume"))).toBe(P("shell?type=resume&above=details"));
  });
  test("2. nothing shows (the chat, the cards at rest): it opens alone", () => {
    expect(open(`/c/${C}`, P("shell"))).toBe(P("shell"));
    expect(open(`/c/${C}?view=verbose`, P("btw?view=verbose"))).toBe(P("btw?view=verbose"));
    expect(open(P("send?text=hi"), P("search"))).toBe(P("search"));
  });
  test("2. the laptop's cards at rest (the session rail shown): /c/<chat>/details is the chat's own view, so an opener opens alone there too", () => {
    expect(openHref(at(P("details")), P("shell"), true, true)).toBe(P("shell"));
    expect(openHref(at(P("details")), P("btw"), true, true)).toBe(P("btw"));
    expect(openHref(at(P("details?view=verbose")), P("search?view=verbose"), true, true)).toBe(P("search?view=verbose"));
    // Not at rest (the tablet's Details pane, a hidden session rail): the cards are a view, and the new one pairs.
    expect(openHref(at(P("details")), P("shell"), true, false)).toBe(P("shell?above=details"));
    // A detail view or a pair is no rest.
    expect(openHref(at(P("context")), P("shell"), true, true)).toBe(P("shell?above=context"));
    expect(openHref(at(P("details?below=btw")), P("shell"), true, true)).toBe(P("shell?above=details"));
  });
  test("3. one view shows: the new one opens below it, but the Terminal always takes the lower half", () => {
    expect(open(P("shell"), P("outputs"))).toBe(P("outputs?below=shell"));
    expect(open(P("outputs"), P("shell"))).toBe(P("shell?above=outputs"));
    expect(open(P("details"), P("btw"))).toBe(P("btw?above=details"));
    expect(open(P("search?q=upl"), P("details"))).toBe(P("details?above=search"));
    expect(open(P(`files/${FILE}?line=3`), P("shell?type=resume"))).toBe(P(`shell?type=resume&above=files/${FILE}`));
  });
  test("4. two views show: the new one takes the half that is not the Terminal; with no Terminal, the half not used last", () => {
    expect(open(P("outputs?below=shell"), P("search"))).toBe(P("search?below=shell"));
    expect(open(P("shell?above=outputs"), P("btw"))).toBe(P("btw?below=shell"));
    expect(open(P("context?below=btw"), P("search"))).toBe(P("search?above=context"));
    expect(open(P("btw?above=context"), P("search"))).toBe(P("search?below=btw"));
    // A Terminal opened into a pair without it takes the lower half, in place.
    expect(open(P("context?below=btw"), P("shell"))).toBe(P("shell?above=context"));
    expect(open(P("btw?above=context"), P("shell"))).toBe(P("shell?above=context"));
  });
  test("where the split cannot show (over the chat, the phone) an opener replaces the view and makes no pair", () => {
    expect(open(P("outputs"), P("shell"), false)).toBe(P("shell"));
    expect(open(P("outputs?below=shell"), P("search"), false)).toBe(P("search"));
  });
  test("a view of another chat, or no panel view, opens as it is", () => {
    expect(open(P("outputs"), "/c/oldo5xxxxxxxxxxxxxx/shell")).toBe("/c/oldo5xxxxxxxxxxxxxx/shell");
    expect(open(P("outputs"), P("send?text=hi"))).toBe(P("send?text=hi"));
  });
});

describe("Show session rail (4.3): the cards always take the upper half, as the Terminal always takes the lower one", () => {
  const cards = P("details");
  test("the view that shows alone goes below the cards, so a side chat's box keeps the panel's foot", () => {
    expect(railShowHref(at(P("shell")), cards)).toBe(P("details?below=shell"));
    expect(railShowHref(at(P("btw")), cards)).toBe(P("details?below=btw"));
    expect(railShowHref(at(P("search?q=upl&scope=files")), cards)).toBe(P("details?below=search"));
    expect(railShowHref(at(P(`btw/${X}?view=verbose`)), P("details?view=verbose"))).toBe(P(`details?view=verbose&below=btw/${X}`));
    // The other openers keep rule 3 (the new view below the one that shows).
    expect(openHref(at(P("btw")), cards, true)).toBe(P("details?above=btw"));
  });
  test("in a pair the lower half stays and the cards take the upper one's place", () => {
    expect(railShowHref(at(P("search?below=shell")), cards)).toBe(P("details?below=shell"));
    expect(railShowHref(at(P("shell?above=btw")), cards)).toBe(P("details?below=shell"));
    expect(railShowHref(at(P("search?below=btw")), cards)).toBe(P("details?below=btw"));
    expect(railShowHref(at(P("search?above=btw")), cards)).toBe(P("details?below=search"));
  });
});

describe("the toggles: lit while a half shows their kind; a second press closes that half", () => {
  const chat = `/c/${C}`;
  test("two lit at once in a pair", () => {
    const r = at(P(`files/${FILE}?below=shell`));
    expect(kindShown(r, "files", true)?.name).toBe("files");
    expect(kindShown(r, "terminal", true)?.name).toBe("shell");
    expect(kindShown(r, "details", true)).toBeNull();
    expect(kindToggle(r, "terminal", P("shell"), true, chat)).toEqual({ on: true, to: P(`files/${FILE}`), close: true });
    expect(kindToggle(r, "files", P("uploads"), true, chat)).toEqual({ on: true, to: P("shell"), close: true });
    expect(kindToggle(r, "search", P("search"), true, chat)).toEqual({ on: false, to: P("search?below=shell"), close: false });
  });
  test("one view: it alone is lit, and closes to the chat", () => {
    expect(kindToggle(at(P("outputs")), "details", P("details"), true, chat)).toEqual({ on: true, to: chat, close: true });
    expect(kindToggle(at(P("outputs")), "terminal", P("shell"), true, chat)).toEqual({ on: false, to: P("shell?above=outputs"), close: false });
  });
  test("over the chat only the URL's own view shows: it alone is lit", () => {
    const r = at(P(`files/${FILE}?below=shell`));
    expect(kindShown(r, "terminal", false)).toBeNull();
    expect(kindToggle(r, "files", P("uploads"), false, chat)).toEqual({ on: true, to: chat, close: true });
    expect(kindToggle(r, "terminal", P("shell"), false, chat)).toEqual({ on: false, to: P("shell"), close: false });
  });
});

describe("one pair, two spellings: one view for the router (6.4)", () => {
  test("the same views in the same places", () => {
    expect(samePair(P("btw?above=context"), P("context?below=btw"))).toBe(true);
    expect(samePair(P("shell?above=outputs"), P("outputs?below=shell"))).toBe(true);
    expect(samePair(P("shell?view=verbose&above=outputs"), P("outputs?view=verbose&below=shell"))).toBe(true);
  });
  test("not when a place, a view, the URL's own keys or the transcript view differ, nor for one view", () => {
    expect(samePair(P("btw?above=context"), P("btw?above=outputs"))).toBe(false);
    expect(samePair(P("search?q=upl&below=shell"), P("shell?above=search"))).toBe(false);
    expect(samePair(P("shell?above=outputs"), P("outputs?view=verbose&below=shell"))).toBe(false);
    expect(samePair(P("outputs"), P("outputs"))).toBe(false);
  });
});

describe("the width rules (7): the split costs the chat no width", () => {
  const laptop = (width: number) => ({ size: "laptop" as const, width });
  test("where the split shows: the laptop's column and the tablet's docked pane; never over the chat or on the phone", () => {
    const shows = (size: "laptop" | "medium" | "phone", width: number, sidebarHidden = false) => splitShows(shellLayout({ size, width }, { sidebarHidden }));
    expect([1440, 1280, 1200, 1088].map((w) => shows("laptop", w))).toEqual([true, true, true, true]);
    expect([1087, 1050, 1000].map((w) => shows("laptop", w))).toEqual([false, false, false]);
    expect([999, 900, 840].map((w) => shows("laptop", w))).toEqual([true, true, true]);
    expect([839, 700, 600].map((w) => shows("laptop", w))).toEqual([false, false, false]);
    expect(shows("laptop", 1050, true)).toBe(true); // a hidden sidebar gives its room back
    expect([1194, 834, 700].map((w) => shows("medium", w))).toEqual([true, true, true]);
    expect(shows("phone", 390)).toBe(false);
  });
  test("the column: the Terminal's width while it is a half, else the side pane's (the chat keeps 520 px where it docks)", () => {
    const term = [1440, 1280, 1200, 1088, 999, 900, 840].map((w) => sideWidth(laptop(w), {}, true));
    expect(term).toEqual([576, 512, 432, 320, 420, 380, 320]);
    for (const [w, col] of [[1440, 576], [1280, 512], [1200, 432], [1088, 320]] as const) expect(w - 248 - col).toBeGreaterThanOrEqual(520);
    for (const [w, col] of [[999, 420], [900, 380], [840, 320]] as const) expect(w - col).toBeGreaterThanOrEqual(520);
    expect([1440, 1280, 1088].map((w) => sideWidth(laptop(w), {}, false))).toEqual([320, 320, 320]);
    expect(sideWidth({ size: "medium", width: 1194 }, {}, true)).toBe(320);
    expect(sideWidth({ size: "medium", width: 700 }, {}, false)).toBe(280);
  });
});

describe("the divider (5)", () => {
  test("each half keeps 200 px on a laptop, 240 px on touch; equal halves by default", () => {
    expect([SPLIT_MIN, SPLIT_MIN_TOUCH, SPLIT_STEP]).toEqual([200, 240, 16]);
    expect(splitRange(800, false)).toEqual({ min: 200, max: 600, def: 400, now: 400 });
    expect(splitRange(834, true)).toEqual({ min: 240, max: 594, def: 417, now: 417 });
    expect(splitRange(900, false, 0.25)).toEqual({ min: 200, max: 700, def: 450, now: 225 });
    expect(splitRange(800, false, 0.05).now).toBe(200);
    expect(splitRange(800, false, 0.99).now).toBe(600);
  });
  test("a column too short for two halves folds the half not used last to its head (under 401 px, 481 on touch)", () => {
    expect([splitFolds(400, false), splitFolds(401, false), splitFolds(480, true), splitFolds(481, true)]).toEqual([true, false, true, false]);
  });
  test("Up and Down move it 16 px, Home and End to the limits; no other key", () => {
    const r = splitRange(800, false);
    expect(["ArrowUp", "ArrowDown", "Home", "End", "ArrowLeft", "Enter", "PageUp"].map((k) => splitKey(k, r))).toEqual([384, 416, 200, 600, null, null, null]);
    const low = { ...r, now: 205 };
    expect(splitKey("ArrowUp", low)).toBe(200);
    expect(splitKey("ArrowDown", { ...r, now: 595 })).toBe(600);
  });
  test("a drag follows the pointer within the limits, in whole pixels", () => {
    const r = splitRange(800, false);
    expect([splitDrag(400, -50.4, r), splitDrag(400, 1000, r), splitDrag(400, -1000, r)]).toEqual([350, 600, 200]);
  });
  test("the device keeps the upper half's share (0 to 1), read defensively; never a URL", () => {
    expect(shareOf(320, 800)).toBe(0.4);
    expect([0.5, 0, 1, 0.3333].map(cleanSplit)).toEqual([0.5, 0, 1, 0.3333]);
    for (const bad of [-0.1, 1.1, "0.5", null, undefined, NaN, Infinity, {}]) expect(cleanSplit(bad)).toBeUndefined();
    const kv = (v: unknown) => ({ getItem: () => JSON.stringify(v), setItem() {}, removeItem() {}, key: () => null, length: 1 });
    expect(loadView(kv({ split: 0.3 })).split).toBe(0.3);
    expect(loadView(kv({ split: 7 })).split).toBeUndefined();
    expect(loadView(kv({ split: "0.3" })).split).toBeUndefined();
  });
});

describe("the copy dialog over the Terminal keeps the pair under it", () => {
  const g = globalThis as { history?: unknown };
  const had = g.history;
  beforeEach(() => {
    g.history = { state: { from: P("outputs?below=shell") } };
  });
  afterEach(() => {
    if (had === undefined) delete g.history;
    else g.history = had;
  });
  test("the Terminal is its view, the other half above it", () => {
    expect(halves(P("terminal?above=outputs"))).toEqual(["outputs other", "shell path"]);
    expect(kindShown(at(P("terminal?above=outputs")), "terminal", true)?.name).toBe("terminal");
  });
  test("with no Terminal behind it, it is no pair", () => {
    g.history = { state: { from: P("outputs") } };
    expect(pairOf(at(P("terminal?above=outputs")))).toBeNull();
  });
});
