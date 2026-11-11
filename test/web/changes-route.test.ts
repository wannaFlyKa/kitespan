// U1 (FIX-U1 section 2, DESIGN-U1 7.1 and 8): the changes view's URL form and its place in U4's split side panel.
// The two routes (a turn's list, one file's diff), the summary id's pattern, the reserved whole-chat forms, the parent
// fallback, the pair values up to 1,043 characters, the sixth kind and its name, the column's width (the Terminal's
// rule), where an opener outside the panel (a card row) and a link inside it go, what closing gives, and the phone,
// which opens the chat at the card.
import { describe, expect, test } from "bun:test";
import { PANE_ROUTES, PANE_VALUE_MAX, PANEL_ROUTES, ROUTE_BY_NAME, href, paneKindOf, paneRouteOf, paneValueOf, parsePath, type Route } from "../../shared/route";
import { halfBack, halfClose, halfLink, halfName, halfTitle, halvesOf, kindShown, openHref, pairOf, sideWidth } from "../../web/layout/split";
import { conversationShows } from "../../web/chat/seen";
import { CHANGES_ROUTES, changesHref, changesLanding, changesShown } from "../../web/changes/nav";

const C = "demoolxxxxxxxxxxxxxx";
const T = "k3m7q2x4ab";
const FILE = "test/unit/upload.test.ts";
const at = (u: string): Route => parsePath(u);
const P = (rest: string) => `/c/${C}/${rest}`;

describe("the two routes (DESIGN-U1 8.1)", () => {
  test("a turn's list and one file's diff: views that pre-fill nothing", () => {
    const list = at(P(`changes/${T}`));
    expect([list.name, list.params, list.fallbackFrom, list.dropped]).toEqual(["changesTurn", { chat: C, turn: T }, undefined, undefined]);
    const file = at(P(`changes/${T}/${FILE}`));
    expect([file.name, file.params, file.fallbackFrom]).toEqual(["changesFile", { chat: C, turn: T, path: FILE }, undefined]);
    for (const name of ["changesTurn", "changesFile"]) {
      const def = ROUTE_BY_NAME[name]!;
      expect(def.kind).toBe("view");
      expect(def.prefill).toBe("nothing");
      // The transcript view and U4's pair; no other key (no `line` this round).
      expect(Object.keys(def.query).sort()).toEqual(["above", "below", "view"]);
      expect(at(def.example).name).toBe(name);
    }
    expect(at(P(`changes/${T}/${FILE}?view=verbose&line=4`)).query).toEqual({ view: "verbose" });
  });

  test("the summary id is 10 symbols of [a-z2-7]; anything else falls back to the chat", () => {
    for (const bad of ["K3M7Q2X4AB", "k3m7q2x4a", "k3m7q2x4abc", "k3m7q2x4a1", "k3m7q2x4a-"]) {
      const r = at(P(`changes/${bad}`));
      expect([bad, r.name, r.params.chat, !!r.fallbackFrom]).toEqual([bad, "chat", C, true]);
    }
  });

  test("the whole chat's forms are reserved for the next round: this round they open the chat", () => {
    for (const u of [P("changes"), P("changes/all"), P(`changes/all/${FILE}`)]) {
      const r = at(u);
      expect([u, r.name, r.params.chat, !!r.fallbackFrom]).toEqual([u, "chat", C, true]);
    }
  });

  test("a path that is not safe never opens as itself: the nearest valid parent", () => {
    // Inside one segment (an escaped slash), a control character: the decoder refuses the path.
    for (const bad of ["a%2F..%2Fb", "a%00b", "a%2F%2Fb"]) {
      const r = at(P(`changes/${T}/${bad}`));
      expect([bad, !!r.fallbackFrom]).toEqual([bad, true]);
    }
    // Dot segments, also escaped, are the URL's own to resolve: what is left never climbs out.
    for (const odd of ["a/%2E%2E/b", "%2E%2E/etc/passwd", "a/%2E/b", "a/./b"]) {
      const r = at(P(`changes/${T}/${odd}`));
      const segs = String(r.params.path ?? "").split("/");
      expect([odd, segs.includes(".."), segs.includes(".")]).toEqual([odd, false, false]);
    }
  });

  test("the builder writes each segment of the path escaped, and the decoder reads it back", () => {
    const u = changesHref(C, T, "my notes/plan 100%.md");
    expect(u).toBe(P(`changes/${T}/my%20notes/plan%20100%25.md`));
    expect(at(u).params.path).toBe("my notes/plan 100%.md");
    expect(changesHref(C, T)).toBe(P(`changes/${T}`));
    expect(changesHref(C, T, FILE, "verbose")).toBe(P(`changes/${T}/${FILE}?view=verbose`));
  });
});

describe("the sixth kind of the split side panel (DESIGN-U1 7.1, 8.2)", () => {
  test("both routes are panel views of the kind changes, named Changes", () => {
    for (const name of ["changesTurn", "changesFile"]) {
      expect(PANEL_ROUTES.has(name)).toBe(true);
      expect(PANE_ROUTES.has(name)).toBe(true);
      expect(paneKindOf(name)).toBe("changes");
      expect(CHANGES_ROUTES.has(name)).toBe(true);
    }
    expect(halfTitle(at(P(`changes/${T}`)))).toBe("Changes");
    expect(halfTitle(at(P(`changes/${T}/${FILE}`)))).toBe("Changes");
    // A folded half's head names the file, as a file's half does.
    expect(halfName(at(P(`changes/${T}/${FILE}`)))).toBe("upload.test.ts");
    expect(halfName(at(P(`changes/${T}`)))).toBe("Changes");
  });

  test("the pair values: changes/<turn> and changes/<turn>/<path>, at most 1,043 characters", () => {
    expect(paneValueOf(at(P(`changes/${T}?below=shell`)))).toBe(`changes/${T}`);
    expect(paneValueOf(at(P(`changes/${T}/${FILE}?below=shell`)))).toBe(`changes/${T}/${FILE}`);
    expect(paneRouteOf(C, `changes/${T}`)?.name).toBe("changesTurn");
    expect(paneRouteOf(C, `changes/${T}/${FILE}`)?.params.path).toBe(FILE);
    expect(PANE_VALUE_MAX).toBe(1043);
    const long = `changes/${T}/${"a/".repeat(511)}bb`;
    expect(long.length).toBe(1043);
    expect(at(P(`shell?above=${long}`)).query).toEqual({ above: long });
    const over = at(P(`shell?above=${long}c`));
    expect([over.query.above, over.dropped]).toEqual([undefined, true]);
    // A file's 1,024-character path still fits beside files/ (1,030).
    expect(paneRouteOf(C, `files/${"a/".repeat(511)}bb`)?.name).toBe("files");
  });

  test("a diff above the Terminal, the Terminal below a list; never two changes views, never a reserved form", () => {
    const p = pairOf(at(P(`changes/${T}/${FILE}?below=shell`)))!;
    expect(halvesOf(p).map((h) => `${h.slot} ${h.kind}`)).toEqual(["upper changes", "lower terminal"]);
    const q = pairOf(at(P(`shell?above=changes/${T}`)))!;
    expect(halvesOf(q).map((h) => `${h.slot} ${h.kind} ${h.path ? "path" : "other"}`)).toEqual(["upper changes other", "lower terminal path"]);
    // The same kind twice, a summary id that does not parse, a reserved form: the key is dropped (5.4's line).
    for (const u of [P(`changes/${T}?below=changes/${T}/${FILE}`), P("shell?above=changes/all"), P("shell?above=changes"), P("shell?above=changes/BAD")]) {
      const r = at(u);
      expect([u, r.dropped, r.query.above ?? r.query.below]).toEqual([u, true, undefined]);
    }
    // Context above a diff, a diff above the side chat.
    expect(pairOf(at(P(`changes/${T}/${FILE}?above=context`)))).not.toBeNull();
    expect(pairOf(at(P(`changes/${T}?below=btw`)))).not.toBeNull();
  });
});

describe("where a card row opens (an opener outside the panel, DESIGN-U4 4.2)", () => {
  const row = changesHref(C, T, FILE);
  const head = changesHref(C, T);
  test("nothing open: the diff alone", () => {
    expect(openHref(at(`/c/${C}`), row, true, false)).toBe(row);
    expect(openHref(at(`/c/${C}/m/toolu_01AbCdEf`), row, true, false)).toBe(row);
  });
  test("with the Terminal open the diff lands above it; in a pair it takes the half that is not the Terminal", () => {
    expect(openHref(at(P("shell")), row, true)).toBe(`${row}?below=shell`);
    expect(openHref(at(P(`files/src/a.ts?below=shell`)), row, true)).toBe(`${row}?below=shell`);
    expect(openHref(at(P("shell?above=outputs")), head, true)).toBe(`${head}?below=shell`);
  });
  test("a changes view open: the row replaces it in its own half", () => {
    expect(openHref(at(head), row, true)).toBe(row);
    expect(openHref(at(`${head}?below=shell`), row, true)).toBe(`${row}?below=shell`);
    expect(openHref(at(P(`shell?above=changes/${T}/docs/testing.md`)), row, true)).toBe(`${row}?below=shell`);
  });
  test("over the chat and on the phone the row replaces the view and makes no pair", () => {
    expect(openHref(at(P("shell")), row, false)).toBe(row);
  });
});

describe("links inside the view, and its close", () => {
  const upper = (u: string) => halvesOf(pairOf(at(u))!).find((h) => h.slot === "upper")!.route;
  test("a file of the list opens in the list's own half; < Changes goes back in it", () => {
    expect(halfLink(upper(P(`changes/${T}?below=shell`)), changesHref(C, T, FILE))).toBe(P(`changes/${T}/${FILE}?below=shell`));
    expect(halfBack(upper(P(`changes/${T}/${FILE}?below=shell`)), changesHref(C, T))).toBe(P(`changes/${T}?below=shell`));
    // Alone: as it is.
    expect(halfLink(at(P(`changes/${T}`)), changesHref(C, T, FILE))).toBe(changesHref(C, T, FILE));
  });
  test("Close changes gives the whole column to the other half; alone it is no half (it closes to the chat)", () => {
    expect(halfClose(upper(P(`changes/${T}/${FILE}?below=shell`)))).toBe(P("shell"));
    expect(halfClose(at(P(`changes/${T}`)))).toBeNull();
  });
  test("which turn and file the panel shows (the card marks that row)", () => {
    expect(changesShown(at(P(`changes/${T}`)), true)).toEqual({ turn: T, path: null });
    expect(changesShown(at(P(`changes/${T}/${FILE}?below=shell`)), true)).toEqual({ turn: T, path: FILE });
    expect(changesShown(at(P(`shell?above=changes/${T}/${FILE}`)), true)).toEqual({ turn: T, path: FILE });
    // Over the chat the URL's own view alone shows.
    expect(changesShown(at(P(`shell?above=changes/${T}/${FILE}`)), false)).toBeNull();
    expect(changesShown(at(P(`changes/${T}`)), false)).toEqual({ turn: T, path: null });
    expect(changesShown(at(P("shell")), true)).toBeNull();
    expect(kindShown(at(P(`changes/${T}`)), "changes", true)?.name).toBe("changesTurn");
  });
});

describe("the column's width: the Terminal's rule (DESIGN-U1 7.1)", () => {
  const laptop = (width: number) => ({ size: "laptop" as const, width });
  test("on a laptop clamp(420, 40%, 720), narrowed so the chat keeps 520, down to 320", () => {
    expect([1440, 1280, 1100].map((w) => sideWidth(laptop(w), {}, false, true))).toEqual([576, 512, 332]);
    expect([1440, 1280, 1100].map((w) => sideWidth(laptop(w), {}, true))).toEqual([576, 512, 332]);
    // The cards and the other views keep 320.
    expect(sideWidth(laptop(1280), {}, false)).toBe(320);
  });
  test("on medium touch 40% of the window, narrowed so the chat keeps 520, at least the side pane's own", () => {
    expect(sideWidth({ size: "medium", width: 1194 }, {}, false, true)).toBe(478);
    expect(sideWidth({ size: "medium", width: 834 }, {}, false, true)).toBe(320);
    expect(sideWidth({ size: "medium", width: 700 }, {}, false, true)).toBe(280);
    // The Terminal alone keeps the tablet's 320 (U4), and a pair with the Terminal takes the diff's.
    expect(sideWidth({ size: "medium", width: 1194 }, {}, true)).toBe(320);
    expect(sideWidth({ size: "medium", width: 1194 }, {}, true, true)).toBe(478);
  });
});

describe("the phone (row 115, DESIGN-U1 8.4)", () => {
  test("a changes route opens the chat, at the turn's card line; the URL is not rewritten", () => {
    expect(conversationShows(at(P(`changes/${T}`)), true)).toBe(true);
    expect(conversationShows(at(P(`changes/${T}/${FILE}?below=shell`)), true)).toBe(true);
    // Other panel views still cover the chat on the phone.
    expect(conversationShows(at(P("context")), true)).toBe(false);
    expect(changesLanding(at(P(`changes/${T}/${FILE}`)), true)).toBe(T);
    expect(changesLanding(at(P(`changes/${T}`)), true)).toBe(T);
    expect(changesLanding(at(P(`changes/${T}`)), false)).toBeNull();
    expect(changesLanding(at(P("shell")), true)).toBeNull();
    // A link with a pair key is the path's view: the chat at the card too.
    expect(changesLanding(at(P(`shell?above=changes/${T}`)), true)).toBeNull();
  });
  test("the reserved and bad forms are the chat's own fallback, with no landing", () => {
    expect(changesLanding(at(P("changes")), true)).toBeNull();
    expect(href("chat", { chat: C })).toBe(`/c/${C}`);
  });
});
