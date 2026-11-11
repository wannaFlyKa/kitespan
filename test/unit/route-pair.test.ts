// U4 (FIX-U4, DESIGN-U4 6): the side panel's two views in one URL. The URL's own view is the one used last, with its
// own keys; `above=` or `below=` names the other view as its path after /c/<chat>/ (details, environment, context,
// connectors, outputs, uploads, files/<relative path>, search, btw, btw/<exchange>, shell, and U1's changes/<turn> and
// changes/<turn>/<relative path>), with no keys of its own.
// The decoder refuses, each by dropping its key and flagging the route (5.4's "Part of that link could not be read."):
// both keys at once (both go), a value that is not a panel view (an action or card route, a page, the copy dialog, a
// path outside the table), a bad param, the same kind as the URL's own view, the Terminal above, anything below the
// Terminal, and a key repeated with two values. A route with no such key ignores it. The builder writes the value with
// its slashes as they are and never writes a pair the decoder refuses.
import { describe, expect, test } from "bun:test";
import { PAIR_KEYS, PANE_ROUTES, PANE_VALUE_MAX, ROUTE_BY_NAME, href, paneKindOf, paneRouteOf, paneValueOf, parsePath, routePattern, type Route } from "../../shared/route";

const C = "k3m7q2x4abk3m7q2x4ab";
const X = "5e1d7a20-3b4c-4d5e-8f60-71829304a5b6";
/** U1: a turn's changes summary. */
const T = "q7m2x4k3ab";
const at = (u: string): Route => parsePath(u);
const FILE = "test/unit/upload.test.ts";

/** Every view of the side panel, as a value and as the route it names. */
const VALUES: [string, string][] = [
  ["details", "details"],
  ["environment", "environment"],
  ["context", "context"],
  ["connectors", "connectors"],
  ["outputs", "outputs"],
  ["uploads", "uploads"],
  [`files/${FILE}`, "files"],
  ["search", "chatSearch"],
  ["btw", "sideChat"],
  [`btw/${X}`, "sideExchange"],
  ["shell", "shell"],
  [`changes/${T}`, "changesTurn"],
  [`changes/${T}/${FILE}`, "changesFile"],
  ["browser", "chatBrowser"],
  ["browser/q2x4abk3m7", "chatBrowserTab"],
];

describe("the kinds and the values", () => {
  test("seven kinds: the pane bar's five (Details, Files, Terminal, Search and Side chat), U1's changes and iteration 7's browser", () => {
    expect(Object.fromEntries([...PANE_ROUTES, "terminal"].map((n) => [n, paneKindOf(n)]))).toEqual({
      details: "details",
      environment: "details",
      context: "details",
      connectors: "details",
      outputs: "details",
      uploads: "files",
      files: "files",
      chatSearch: "search",
      sideChat: "side",
      sideExchange: "side",
      changesTurn: "changes",
      changesFile: "changes",
      chatBrowser: "browser",
      chatBrowserTab: "browser",
      shell: "terminal",
      terminal: "terminal",
    });
    for (const n of ["chat", "send", "message", "permission", "background", "rename", "search", "mention", "home"]) expect([n, paneKindOf(n)]).toEqual([n, null]);
  });
  test("a value is the view's path after /c/<chat>/, and names its route", () => {
    for (const [value, name] of VALUES) {
      const r = paneRouteOf(C, value);
      expect([value, r?.name]).toEqual([value, name]);
      expect(paneValueOf(r!)).toBe(value);
      expect(r!.params.chat).toBe(C);
    }
    expect(paneValueOf(at(`/c/${C}/files/${FILE}?line=4&below=shell`))).toBe(`files/${FILE}`);
    // The copy dialog over the Terminal is the Terminal's view in a pair.
    expect(paneValueOf(at(`/c/${C}/terminal`))).toBe("shell");
    expect(paneValueOf(at(`/c/${C}`))).toBeNull();
  });
  test("a file's name keeps every character its path may hold", () => {
    expect(paneRouteOf(C, "files/my notes/plan 100%.md")?.params.path).toBe("my notes/plan 100%.md");
    expect(paneRouteOf(C, "files/文档/計画.md")?.params.path).toBe("文档/計画.md");
  });
  test("every key is on every panel route and on the copy dialog, and on no other", () => {
    expect(PAIR_KEYS).toEqual(["above", "below"]);
    for (const def of Object.values(ROUTE_BY_NAME)) {
      const has = PAIR_KEYS.map((k) => k in def.query);
      expect([def.name, has]).toEqual([def.name, PANE_ROUTES.has(def.name) || def.name === "terminal" ? [true, true] : [false, false]]);
    }
  });
});

describe("parse: a pair", () => {
  test("the design's examples", () => {
    const a = at(`/c/${C}/files/${FILE}?below=shell`);
    expect([a.name, a.params.path, a.query, a.dropped]).toEqual(["files", FILE, { below: "shell" }, undefined]);
    const b = at(`/c/${C}/shell?type=resume&above=files/${FILE}`);
    expect([b.name, b.query, b.dropped]).toEqual(["shell", { type: "resume", above: `files/${FILE}` }, undefined]);
    expect(at(`/c/${C}/search?q=upload&below=shell`).query).toEqual({ q: "upload", below: "shell" });
    expect(at(`/c/${C}/files/${FILE}?above=outputs`).query).toEqual({ above: "outputs" });
    expect(at(`/c/${C}/context?below=btw`).query).toEqual({ below: "btw" });
  });
  test("every kind pairs with every other kind, in either place but the Terminal's", () => {
    for (const [own, ownName] of VALUES)
      for (const [other, otherName] of VALUES) {
        const sameKind = paneKindOf(ownName) === paneKindOf(otherName);
        for (const key of PAIR_KEYS) {
          const r = at(`/c/${C}/${own}?${key}=${other}`);
          const terminalMisplaced = (key === "above" && otherName === "shell") || (key === "below" && ownName === "shell");
          const ok = !sameKind && !terminalMisplaced;
          expect([own, key, other, r.name, r.query[key] ?? null, r.dropped ?? false]).toEqual([own, key, other, ownName, ok ? other : null, !ok]);
        }
      }
  });
  test("a value written with its slashes escaped reads the same", () => {
    expect(at(`/c/${C}/shell?above=files%2Ftest%2Funit%2Fupload.test.ts`).query).toEqual({ above: `files/${FILE}` });
    expect(at(`/c/${C}/shell?above=files/my%20notes.md`).query).toEqual({ above: "files/my notes.md" });
  });
  test("the copy dialog over the Terminal keeps the half above it", () => {
    expect(at(`/c/${C}/terminal?above=outputs`).query).toEqual({ above: "outputs" });
    const r = at(`/c/${C}/terminal?below=outputs`);
    expect([r.query, r.dropped]).toEqual([{}, true]);
  });
  test("the transcript view goes with the URL's own view", () => {
    expect(at(`/c/${C}/outputs?view=verbose&below=shell`).query).toEqual({ view: "verbose", below: "shell" });
  });
});

describe("parse: the refusals (the key goes, the URL's own view shows alone, 5.4's line)", () => {
  const refused = (u: string, kept: Record<string, string> = {}) => {
    const r = at(u);
    expect([u, r.query as Record<string, unknown>, r.dropped, r.fallbackFrom]).toEqual([u, kept, true, undefined]);
  };
  test("both keys at once: both go", () => {
    refused(`/c/${C}/context?above=search&below=shell`);
    refused(`/c/${C}/context?above=bogus&below=shell`);
    refused(`/c/${C}/outputs?view=verbose&below=shell&above=search`, { view: "verbose" });
  });
  test("a value that is not a panel view", () => {
    for (const v of ["send", "stop", "rename", "permission/toolu_01AbCdEf", "background/3f9a1c2e", "terminal", "slash", "m/toolu_01AbCdEf", "nope", "files", "btw/x/y", "", "%20"]) refused(`/c/${C}/context?below=${v}`);
  });
  test("a bad param: an unsafe path, an exchange that is not a UUID, a percent escape that does not decode", () => {
    for (const v of ["files/../etc/passwd", "files//a.ts", "files/./a.ts", "files/a.ts/", "/files/a.ts", "btw/not-a-uuid", "btw/5E1D7A20-3B4C-4D5E-8F60-71829304A5B6", "files%2", "files/a%ZZ"]) refused(`/c/${C}/context?below=${v}`);
  });
  test("no query or hash part inside the value, no control character, at most 1,043 characters (U1's changes/<turn>/<path>)", () => {
    expect(PANE_VALUE_MAX).toBe(1043);
    const diff = `changes/${T}/${"a/".repeat(511)}bb`;
    expect(diff.length).toBe(1043);
    expect(at(`/c/${C}/shell?above=${diff}`).query).toEqual({ above: diff });
    refused(`/c/${C}/shell?above=${diff}c`);
    refused(`/c/${C}/context?below=files%2Fa.ts%3Fline%3D3`);
    refused(`/c/${C}/context?below=files%2Fa.ts%23L3`);
    refused(`/c/${C}/context?below=files%2Fa%0A.ts`);
    refused(`/c/${C}/context?below=files%2Fa%E2%80%AE.ts`);
    const long = `files/${"a/".repeat(511)}bb`;
    expect(long.length).toBe(1030);
    expect(at(`/c/${C}/context?below=${long}`).query).toEqual({ below: long });
    // A file's path is still at most 1,024 characters.
    refused(`/c/${C}/context?below=files/${"a/".repeat(511)}bbc`);
  });
  test("the same kind as the URL's own view", () => {
    refused(`/c/${C}/context?below=outputs`);
    refused(`/c/${C}/details?below=connectors`);
    refused(`/c/${C}/files/a.ts?above=uploads`);
    refused(`/c/${C}/btw?below=btw/${X}`);
    refused(`/c/${C}/search?q=upl&below=search`, { q: "upl" });
  });
  test("the Terminal above, or anything below the Terminal", () => {
    refused(`/c/${C}/context?above=shell`);
    refused(`/c/${C}/shell?below=context`);
    refused(`/c/${C}/shell?type=resume&below=outputs`, { type: "resume" });
  });
  test("a key repeated with two values (the same value twice reads once)", () => {
    refused(`/c/${C}/context?below=shell&below=btw`);
    expect(at(`/c/${C}/context?below=shell&below=shell`).query).toEqual({ below: "shell" });
  });
  test("a route with no such key ignores it, with no line (5.1 rule 6)", () => {
    for (const u of [`/c/${C}?below=shell`, `/c/${C}/send?text=hi&below=shell`, `/c/${C}/m/toolu_01AbCdEf?above=outputs`, `/c/${C}/rename?above=context`]) {
      const r = at(u);
      expect([u, "above" in r.query || "below" in r.query, r.dropped]).toEqual([u, false, undefined]);
    }
  });
  test("a refused pair never moves the URL's own view to its parent", () => {
    expect(at(`/c/${C}/files/${FILE}?above=uploads`).name).toBe("files");
    expect(at(`/c/${C}/shell?below=shell`).name).toBe("shell");
  });
});

describe("href: the builder", () => {
  test("writes the other view after the URL's own keys, its slashes as they are, a space as %20", () => {
    expect(href("files", { chat: C, path: FILE }, { below: "shell" })).toBe(`/c/${C}/files/${FILE}?below=shell`);
    expect(href("shell", { chat: C }, { type: "resume", view: "verbose", above: `files/${FILE}` })).toBe(`/c/${C}/shell?type=resume&view=verbose&above=files/${FILE}`);
    expect(href("chatSearch", { chat: C }, { q: "up load", below: "shell" })).toBe(`/c/${C}/search?q=up%20load&below=shell`);
    expect(href("context", { chat: C }, { below: "files/my notes/a&b=c.md" })).toBe(`/c/${C}/context?below=files/my%20notes/a%26b%3Dc.md`);
  });
  test("what it writes parses back to the same pair", () => {
    for (const [own, ownName] of VALUES)
      for (const [other] of VALUES) {
        const base = paneRouteOf(C, own)!;
        for (const key of PAIR_KEYS) {
          const u = href(ownName, base.params, { view: "thinking", [key]: other });
          const r = at(u);
          const kept = typeof r.query[key] === "string";
          expect(r.dropped).toBeUndefined();
          if (kept) expect([u, r.name, r.query[key], r.query.view]).toEqual([u, ownName, other, "thinking"]);
          expect(href(r.name, r.params, r.query)).toBe(u);
        }
      }
  });
  test("never writes a pair that the decoder refuses: above=shell, a below on the Terminal, the same kind, both keys", () => {
    expect(href("context", { chat: C }, { above: "shell" })).toBe(`/c/${C}/context`);
    expect(href("shell", { chat: C }, { below: "context" })).toBe(`/c/${C}/shell`);
    expect(href("context", { chat: C }, { below: "outputs" })).toBe(`/c/${C}/context`);
    expect(href("context", { chat: C }, { above: "search", below: "shell" })).toBe(`/c/${C}/context`);
    expect(href("context", { chat: C }, { below: "send" })).toBe(`/c/${C}/context`);
    expect(href("send", { chat: C }, { text: "hi", below: "shell" })).toBe(`/c/${C}/send?text=hi`);
  });
  test("a log line keeps the route pattern only, never the other view", () => {
    expect(routePattern(`/c/${C}/files/${FILE}`)).toBe("/c/:chat/files/*");
    expect(routePattern(`/c/${C}/context`)).toBe("/c/:chat/context");
  });
});
