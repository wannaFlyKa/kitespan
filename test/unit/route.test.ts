// The route table, the strict decoder and the encoder (DESIGN.md section 5), with kitespan's real ids. Ported from the
// prototype's router tests (test/prototype-router.test.ts, which still covers the prototype's own copy).
import { describe, expect, test } from "bun:test";
import {
  APP_EXACT_PATHS,
  APP_PATH_PREFIXES,
  CHAT_FILTERS,
  PANE_ROUTES,
  PANEL_ROUTES,
  ROUTES,
  ROUTE_BY_NAME,
  ROUTE_PATTERNS,
  SEARCH_SCOPES,
  decodeQuery,
  href,
  isAppPath,
  isSafeRelativePath,
  parse,
  parsePath,
  routePattern,
} from "../../shared/route";

const C = "k3m7q2x4abk3m7q2x4ab";
const P = "k3m7q2x4ab";
const S = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const at = (u: string) => parse(new URL(u, "http://127.0.0.1:7941"));
const enc = encodeURIComponent;

describe("route table", () => {
  test("names and paths are unique", () => {
    expect(new Set(ROUTES.map((r) => r.name)).size).toBe(ROUTES.length);
    expect(new Set(ROUTES.map((r) => r.path)).size).toBe(ROUTES.length);
  });
  for (const r of ROUTES)
    test(`${r.name}: its example opens it with no fallback and no dropped value`, () => {
      const route = at(r.example);
      expect(route.name).toBe(r.name);
      expect(route.fallbackFrom).toBeUndefined();
      expect(route.dropped).toBeUndefined();
    });
  test("every action route pre-fills something or names its button", () => {
    for (const r of ROUTES.filter((x) => x.kind === "action")) expect(r.prefill).not.toBe("nothing");
  });
  test("the prototype-only routes are gone from the real app", () => {
    expect(ROUTE_BY_NAME.design).toBeUndefined();
    expect(ROUTE_BY_NAME.spikeBrowser).toBeUndefined();
    expect(at("/design").name).toBe("home");
  });
  test("the panel and pane sets name real routes", () => {
    for (const n of PANE_ROUTES) expect(ROUTE_BY_NAME[n]).toBeDefined();
    for (const n of PANEL_ROUTES) expect(PANE_ROUTES.has(n)).toBe(true);
  });
});

describe("archive and delete (D48)", () => {
  test("/c/<chat>/archive and /c/<chat>/delete are v0.1 core action routes that act only on their button", () => {
    for (const name of ["archive", "delete"]) {
      const def = ROUTE_BY_NAME[name]!;
      expect(def.kind).toBe("action");
      expect(def.milestone).toStartWith("v0.1 core");
      expect(Object.keys(def.query)).toEqual(["view"]);
    }
    expect(at(`/c/${C}/archive`).params).toEqual({ chat: C });
    expect(at(`/c/${C}/delete?view=verbose`).query).toEqual({ view: "verbose" });
  });
  test("they pre-fill nothing: any other key is ignored", () => {
    const r = at(`/c/${C}/delete?confirm=1&stop=1`);
    expect(r.name).toBe("delete");
    expect(r.query).toEqual({});
    expect(r.dropped).toBeUndefined();
  });
  test("the chat list's archived view", () => {
    expect(CHAT_FILTERS).toContain("archived");
    expect(at("/chats?filter=archived").query).toEqual({ filter: "archived" });
    expect(at("/chats?filter=deleted").query).toEqual({});
    expect(at("/chats?filter=deleted").dropped).toBe(true);
  });
  test("a bad chat id on either path falls back to Home", () => {
    expect(at("/c/c_demo01/archive").name).toBe("home");
    expect(at(`/c/${C}x/delete`).name).toBe("home");
  });
});

describe("decoder", () => {
  test("params and query values decode; unknown keys are ignored", () => {
    const r = at(`/c/${C}/send?text=Run%20the%20tests%20again&evil=1`);
    expect(r.params).toEqual({ chat: C });
    expect(r.query).toEqual({ text: "Run the tests again" });
    expect(r.dropped).toBeUndefined();
  });
  test("ids must match their patterns", () => {
    expect(at("/c/c_demo01").name).toBe("home");
    expect(at(`/c/${C.toUpperCase()}`).name).toBe("home");
    expect(at(`/p/${P}`).name).toBe("project");
    expect(at("/p/k3m7q2x9ab").name).toBe("home"); // 9 is not in [a-z2-7]
    expect(at(`/p/${P}/session/${S.toUpperCase()}`).name).toBe("project");
  });
  test("an enum value outside its list is dropped", () => {
    expect(at(`/c/${C}/mode?pick=yolo`).query).toEqual({});
    expect(at(`/c/${C}/mode?pick=dontAsk`).query).toEqual({});
    expect(at(`/c/${C}/mode?pick=plan`).query).toEqual({ pick: "plan" });
    expect(at(`/c/${C}/effort?pick=xhigh`).query).toEqual({ pick: "xhigh" });
  });
  test("the new-chat form's project must be a project id", () => {
    expect(at(`/new?project=${P}`).query).toEqual({ project: P });
    expect(at("/new?project=..%2Fetc").query).toEqual({});
    expect(at("/new?project=..%2Fetc").dropped).toBe(true);
  });
  test("a text value just under, at and over its cap", () => {
    expect((at(`/c/${C}/send?text=${"a".repeat(4999)}`).query.text as string).length).toBe(4999);
    expect((at(`/c/${C}/send?text=${"a".repeat(5000)}`).query.text as string).length).toBe(5000);
    expect(at(`/c/${C}/send?text=${"a".repeat(5001)}`).query).toEqual({});
    for (const [path, key] of [["bash", "cmd"], ["slash/compact", "args"]] as const) {
      expect(at(`/c/${C}/${path}?${key}=${"b".repeat(5000)}`).query[key]).toBe("b".repeat(5000));
      expect(at(`/c/${C}/${path}?${key}=${"b".repeat(5001)}`).query).toEqual({});
    }
    expect(at(`/c/${C}/rename?title=${"t".repeat(119)}`).query.title).toBe("t".repeat(119));
    expect(at(`/c/${C}/rename?title=${"t".repeat(120)}`).query.title).toBe("t".repeat(120));
    expect(at(`/c/${C}/rename?title=${"t".repeat(121)}`).query).toEqual({});
    expect(at(`/settings/chats/live-max?value=${"9".repeat(121)}`).query).toEqual({});
  });
  test("a repeated key keeps each value and is never split on commas", () => {
    expect(at(`/c/${C}/question/toolu_1?pick=a&pick=b,c`).query.pick).toEqual(["a", "b,c"]);
    const five = at(`/c/${C}/question/toolu_1?pick=a&pick=b&pick=c&pick=d&pick=e`);
    expect(five.query).toEqual({});
    expect(five.dropped).toBe(true);
  });
  test("a single-valued key given two different values is dropped", () => {
    expect(at(`/c/${C}/send?text=a&text=b`).query).toEqual({});
    expect(at(`/c/${C}/send?text=a&text=a`).query).toEqual({ text: "a" });
  });
  test("a bad value drops that key alone and flags the route", () => {
    const r = at(`/c/${C}/permission/toolu_1?answer=always&view=verbose`);
    expect(r.query).toEqual({ view: "verbose" });
    expect(r.dropped).toBe(true);
    expect(at(`/c/${C}?utm=1`).dropped).toBeUndefined();
  });
  test("an int outside its range is dropped", () => {
    expect(at(`/c/${C}/files/src/a.ts?line=0`).query).toEqual({});
    expect(at(`/c/${C}/files/src/a.ts?line=10000001`).query).toEqual({});
    expect(at(`/c/${C}/files/src/a.ts?line=42`).query).toEqual({ line: 42 });
    expect(at(`/c/${C}/files/src/a.ts?line=4e1`).query).toEqual({});
  });
  test("a query value whose percent escape does not decode is dropped and flags the route (5.4)", () => {
    for (const bad of ["%E0%A4%A", "caf%C3%A9%FF", "%", "50%25%"]) {
      const r = at(`/c/${C}/send?text=${bad}`);
      expect(r.name).toBe("send");
      expect(r.query).toEqual({});
      expect(r.dropped).toBe(true);
      expect(parsePath(`/c/${C}/send?text=${bad}`).dropped).toBe(true);
    }
    // Only the bad key goes; a good escape, a plus as a space and an unknown key with a bad escape still read.
    const both = at(`/c/${C}/rename?title=%E0%A4%A&view=verbose`);
    expect(both.query).toEqual({ view: "verbose" });
    expect(both.dropped).toBe(true);
    const good = at(`/c/${C}/send?text=caf%C3%A9+au+lait&utm=%FF`);
    expect(good.query).toEqual({ text: "café au lait" });
    expect(good.dropped).toBeUndefined();
    // A literal replacement character that the link encodes properly is text like any other.
    expect(at(`/c/${C}/send?text=${enc("a�b")}`).query).toEqual({ text: "a�b" });
  });
  test("control characters never reach a screen", () => {
    expect(decodeQuery({ q: { type: "text", max: 50 } }, new URLSearchParams("q=a%00b"))).toEqual({});
    expect(at(`/c/${C}/m/ab%00c`).name).toBe("chat");
  });
  test("a bidirectional control in a pre-fill drops that value and flags the route", () => {
    const bash = at(`/c/${C}/bash?cmd=${enc("cat \u202etxt.ten-on/pmt/\u202c && echo ok")}`);
    expect(bash.name).toBe("bash");
    expect(bash.query).toEqual({});
    expect(bash.dropped).toBe(true);
    const rename = at(`/c/${C}/rename?title=${enc("Release notes \u202etxt.exe")}&view=verbose`);
    expect(rename.query).toEqual({ view: "verbose" });
    expect(rename.dropped).toBe(true);
    expect(at(`/c/${C}/send?text=${enc("abc \u202e")}`).query).toEqual({});
    expect(at(`/c/${C}/question/toolu_1?pick=${enc("Unit tests")}&pick=${enc("\u200fClick-through")}`).query).toEqual({});
  });
  test("every bidirectional mark, isolate and override, the C1 controls and the line separators are refused", () => {
    const spec = { q: { type: "text", max: 50 } } as const;
    for (const ch of ["\u0080", "\u0085", "\u009f", "\u061c", "\u200e", "\u200f", "\u2028", "\u2029", "\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069"])
      expect(decodeQuery(spec, new URLSearchParams({ q: `a${ch}b` }))).toEqual({});
  });
  test("newline and tab stay allowed in text, and other scripts and emoji pass", () => {
    const spec = { q: { type: "text", max: 80 } } as const;
    for (const s of ["two\nlines", "a\tb", "\u05e9\u05dc\u05d5\u05dd", "\u0645\u0631\u062d\u0628\u0627", "\u65e5\u672c\u8a9e", "family \u{1f468}\u200d\u{1f469}\u200d\u{1f467}", "caf\u00e9"])
      expect(decodeQuery(spec, new URLSearchParams({ q: s }))).toEqual({ q: s });
  });
  test("a malformed percent escape falls back to the parent", () => {
    const r = at(`/c/${C}/tool/%E0%A4%A`);
    expect(r.name).toBe("chat");
    expect(r.fallbackFrom).toBeDefined();
  });
});

describe("fallback to the nearest valid parent", () => {
  test("a bad block id falls back to the chat", () => {
    const r = at(`/c/${C}/tool/%3Cscript%3E`);
    expect(r.name).toBe("chat");
    expect(r.fallbackFrom).toBe(`/c/${C}/tool/%3Cscript%3E`);
  });
  test("an unknown chat view falls back to the chat", () => {
    expect(at(`/c/${C}/contxt`).name).toBe("chat");
  });
  test("an unknown settings section or key falls back to its parent", () => {
    expect(at("/settings/secrets").name).toBe("settings");
    expect(at("/settings/chats/nope").name).toBe("settingsSection");
    expect(at(`/settings/${enc("about\u200e")}`).name).toBe("settings");
  });
  test("a bad chat id and an unknown path fall back to Home", () => {
    expect(at("/c/../../etc/passwd").name).toBe("home");
    expect(at("/nope/nope").name).toBe("home");
  });
  test("a fuzz run of random paths and queries never throws", () => {
    const parts = ["c", "p", C, P, S, "files", "..", "%", "%E0", "%00", "\u202e", "send", "settings", "about", "x".repeat(70), "", "?", "&", "=", "pick", "text"];
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
    for (let i = 0; i < 20000; i++) {
      let u = "/";
      for (let j = rnd(6); j > 0; j--) u += `${parts[rnd(parts.length)]}/`;
      u += `?${parts[rnd(parts.length)]}=${parts[rnd(parts.length)]}&${parts[rnd(parts.length)]}=${parts[rnd(parts.length)]}`;
      expect(() => parsePath(u)).not.toThrow();
      expect(parsePath(u).def).toBeDefined();
    }
  });
});

describe("file paths in URLs", () => {
  test("only safe relative paths", () => {
    expect(isSafeRelativePath("src/upload.ts")).toBe(true);
    for (const bad of ["/etc/passwd", "../x", "a/../b", "a//b", "", "a/./b", "docs/\u202egpj.exe", "docs/a\u0085b"]) expect(isSafeRelativePath(bad)).toBe(false);
  });
  test("a file route keeps its relative path; a bad one falls back", () => {
    expect(at(`/c/${C}/files/src/upload.ts`).params.path).toBe("src/upload.ts");
    expect(at(`/c/${C}/files/src/my%20file.ts`).params.path).toBe("src/my file.ts");
    expect(at(`/c/${C}/files/..%2Fsecret`).name).toBe("chat");
    const r = at(`/c/${C}/files/docs/${enc("\u202egpj.exe")}`);
    expect(r.name).toBe("files");
    expect(r.params.path).toBe("docs");
    expect(r.fallbackFrom).toBeDefined();
  });
});

describe("specific routes", () => {
  test("a session preview needs a UUID", () => {
    expect(at(`/p/${P}/session/${S}`).name).toBe("session");
    expect(at(`/p/${P}/session/not-a-uuid`).name).toBe("project");
  });
  test("the restart dialog is not a setting key", () => {
    expect(at("/settings/about/restart").name).toBe("restart");
    expect(at("/settings/chats/live-max").name).toBe("setting");
    expect(at("/settings/chats/restart").name).toBe("settingsSection");
  });
  test("the bare / menu and a command row", () => {
    expect(at(`/c/${C}/slash`).name).toBe("slashMenu");
    expect(at(`/c/${C}/slash/plugin:review?args=x`).query).toEqual({ args: "x" });
  });
  test("the Terminal pane types only the resume command", () => {
    expect(at(`/c/${C}/shell?type=resume`).query).toEqual({ type: "resume" });
    expect(at(`/c/${C}/shell?type=${enc("rm -rf ~")}`).query).toEqual({});
  });
});

describe("href", () => {
  test("builds canonical URLs that parse back", () => {
    const u = href("send", { chat: C }, { text: "a b&c" });
    expect(u).toBe(`/c/${C}/send?text=a%20b%26c`);
    expect(at(u).query.text).toBe("a b&c");
    expect(href("files", { chat: C, path: "src/my file.ts" })).toBe(`/c/${C}/files/src/my%20file.ts`);
    expect(href("question", { chat: C, request: "toolu_1" }, { pick: ["a b", "c,d"] })).toBe(`/c/${C}/question/toolu_1?pick=a%20b&pick=c%2Cd`);
    expect(href("archive", { chat: C })).toBe(`/c/${C}/archive`);
    expect(href("chats", {}, { filter: "archived" })).toBe("/chats?filter=archived");
    expect(href("nope")).toBe("/");
  });
  test("every example formats back to itself", () => {
    for (const r of ROUTES) {
      const route = at(r.example);
      expect(href(route.name, route.params, route.query)).toBe(r.example);
    }
  });
  test("keys outside the route's allowlist are never written", () => {
    expect(href("delete", { chat: C }, { confirm: "1" })).toBe(`/c/${C}/delete`);
  });
});

describe("the app route families the server answers with the page (5.1 rule 1)", () => {
  test("every route example is inside a family", () => {
    for (const r of ROUTES) expect(isAppPath(new URL(r.example, "http://x").pathname)).toBe(true);
  });
  test("paths outside the families, and a prefix's bare form, are not", () => {
    for (const p of ["/c", "/p", "/api", "/api/health", "/ws", "/ws/shell", "/assets/app.js", "/design", "/spike/browser", "/signin", "/favicon.ico", "/c/", "/settingsx", "/chatsx"]) expect(isAppPath(p)).toBe(false);
    for (const p of ["/", "/new", "/chats", "/settings", "/settings/about", "/browser", `/c/${C}`, `/p/${P}`]) expect(isAppPath(p)).toBe(true);
  });
  test("the lists match DESIGN 5.1 rule 1 less the prototype-only paths", () => {
    expect([...APP_EXACT_PATHS].sort()).toEqual(["/", "/browser", "/chats", "/new", "/search", "/settings"]);
    expect([...APP_PATH_PREFIXES].sort()).toEqual(["/browser/", "/c/", "/p/", "/settings/"]);
  });
});

describe("route patterns for log lines", () => {
  test("a path gives its pattern, never itself", () => {
    expect(routePattern(`/c/${C}/files/src/secret.txt`)).toBe("/c/:chat/files/*");
    expect(routePattern(`/c/${C}`)).toBe("/c/:chat");
    expect(routePattern("/settings/chats/live-max")).toBe("/settings/:section/:key");
    expect(routePattern("/")).toBe("/");
  });
  test("a path that does not parse, or is outside the families, gives null", () => {
    expect(routePattern(`/c/${C}/contxt`)).toBeNull();
    expect(routePattern("/api/uploads")).toBeNull();
    expect(routePattern("/etc/passwd")).toBeNull();
  });
  test("every pattern is listed", () => {
    for (const r of ROUTES) expect(ROUTE_PATTERNS).toContain(routePattern(new URL(r.example, "http://x").pathname)!);
  });
});

describe("the search routes (v0.3 search, DESIGN.md 9.3, 5.2, 5.3)", () => {
  test("the three paths: /search, the chat's search pane and the @ picker", () => {
    expect(at("/search?q=upload")).toMatchObject({ name: "search", params: {}, query: { q: "upload" } });
    expect(at(`/c/${C}/search?q=upl&scope=files`)).toMatchObject({ name: "chatSearch", params: { chat: C }, query: { q: "upl", scope: "files" } });
    expect(at(`/c/${C}/mention?q=upl`)).toMatchObject({ name: "mention", params: { chat: C }, query: { q: "upl" } });
    for (const r of [at("/search"), at(`/c/${C}/search`), at(`/c/${C}/mention`)]) {
      expect(r.query).toEqual({});
      expect(r.fallbackFrom).toBeUndefined();
      expect(r.dropped).toBeUndefined();
    }
  });
  test("each is a view of v0.3 search: it pre-fills and never acts", () => {
    for (const name of ["search", "chatSearch", "mention"]) {
      const def = ROUTE_BY_NAME[name]!;
      expect(def.kind).toBe("view");
      expect(def.milestone).toBe("v0.3 search");
      expect(def.prefill).toContain("q");
    }
    expect(Object.keys(ROUTE_BY_NAME.search!.query)).toEqual(["q"]);
    // U4: the pane is a side panel view, so it takes the split panel's other view too (route-pair.test.ts).
    expect(Object.keys(ROUTE_BY_NAME.chatSearch!.query)).toEqual(["q", "scope", "view", "above", "below"]);
    expect(Object.keys(ROUTE_BY_NAME.mention!.query)).toEqual(["q", "view"]);
    expect(ROUTE_BY_NAME.chatSearch!.prefill).toContain("a command's pick only fills the composer");
    expect(ROUTE_BY_NAME.mention!.prefill).toContain("no chip until a pick");
  });
  test("scope is files, chats or commands, on the chat's pane only; a bogus scope drops its key alone", () => {
    expect([...SEARCH_SCOPES]).toEqual(["files", "chats", "commands"]);
    for (const scope of SEARCH_SCOPES) expect(at(`/c/${C}/search?scope=${scope}`).query).toEqual({ scope });
    const bogus = at(`/c/${C}/search?q=upl&scope=bogus`);
    expect(bogus).toMatchObject({ name: "chatSearch", query: { q: "upl" }, dropped: true });
    // /search holds q only: its old scope key is unknown now, so it is ignored, not flagged.
    const global = at("/search?q=a&scope=files");
    expect(global.query).toEqual({ q: "a" });
    expect(global.dropped).toBeUndefined();
    expect(at(`/c/${C}/mention?scope=files`).query).toEqual({});
  });
  test("q holds at most 5,000 characters: over its cap it fills nothing and flags the route (5.4)", () => {
    for (const path of ["/search", `/c/${C}/search`, `/c/${C}/mention`]) {
      expect((at(`${path}?q=${"q".repeat(5000)}`).query.q as string).length).toBe(5000);
      const over = at(`${path}?q=${"q".repeat(5001)}&view=verbose`);
      expect(over.query.q).toBeUndefined();
      expect(over.dropped).toBe(true);
      expect(at(`${path}?q=${enc("a\u202eb")}`).query.q).toBeUndefined();
    }
    expect(at(`/c/${C}/search?q=${enc("café 日本 @src")}`).query.q).toBe("café 日本 @src");
  });
  test("the chat's search pane is a side panel view; the picker and /search are not", () => {
    expect(PANEL_ROUTES.has("chatSearch")).toBe(true);
    expect(PANE_ROUTES.has("chatSearch")).toBe(true);
    for (const name of ["mention", "search"]) {
      expect(PANEL_ROUTES.has(name)).toBe(false);
      expect(PANE_ROUTES.has(name)).toBe(false);
    }
  });
  test("a bad chat id falls back to Home; a deeper path falls back to the route", () => {
    expect(at("/c/c_demo01/search?q=x").name).toBe("home");
    expect(at(`/c/${C}x/mention`).name).toBe("home");
    const deeper = at(`/c/${C}/mention/extra?q=x`);
    expect(deeper.name).toBe("mention");
    expect(deeper.fallbackFrom).toBeDefined();
    expect(at(`/c/${C}/searc`).name).toBe("chat");
  });
  test("href writes them back, a space as %20, and their patterns go in log lines", () => {
    expect(href("search", {}, { q: "release notes" })).toBe("/search?q=release%20notes");
    expect(href("chatSearch", { chat: C }, { q: "a b&c", scope: "files" })).toBe(`/c/${C}/search?q=a%20b%26c&scope=files`);
    expect(href("mention", { chat: C }, { q: "web/comp" })).toBe(`/c/${C}/mention?q=web%2Fcomp`);
    expect(at(href("mention", { chat: C }, { q: "web/comp" })).query.q).toBe("web/comp");
    expect(routePattern("/search")).toBe("/search");
    expect(routePattern(`/c/${C}/search`)).toBe("/c/:chat/search");
    expect(routePattern(`/c/${C}/mention`)).toBe("/c/:chat/mention");
    expect(isAppPath("/search")).toBe(true);
    expect(isAppPath(`/c/${C}/mention`)).toBe(true);
  });
});

describe("an environment's Rename and Remove (row 99)", () => {
  test("/p/<project>/rename and /p/<project>/remove are action routes that act only on their button", () => {
    for (const name of ["projectRename", "projectRemove"]) {
      const def = ROUTE_BY_NAME[name]!;
      expect(def.kind).toBe("action");
      expect(def.prefill).not.toBe("nothing");
    }
    expect(ROUTE_BY_NAME.projectRename!.path).toBe("/p/:project/rename");
    expect(ROUTE_BY_NAME.projectRemove!.path).toBe("/p/:project/remove");
    expect(Object.keys(ROUTE_BY_NAME.projectRename!.query)).toEqual(["name"]);
    expect(Object.keys(ROUTE_BY_NAME.projectRemove!.query)).toEqual([]);
    expect(at(`/p/${P}/rename`)).toMatchObject({ name: "projectRename", params: { project: P }, query: {} });
    expect(at(`/p/${P}/remove`)).toMatchObject({ name: "projectRemove", params: { project: P }, query: {} });
  });
  test("a link pre-fills the name, at most 80 characters with no control character; Remove takes no key", () => {
    expect(at(`/p/${P}/rename?name=${enc("web app")}`).query).toEqual({ name: "web app" });
    expect((at(`/p/${P}/rename?name=${"n".repeat(80)}`).query.name as string).length).toBe(80);
    const over = at(`/p/${P}/rename?name=${"n".repeat(81)}`);
    expect(over.query).toEqual({});
    expect(over.dropped).toBe(true);
    expect(at(`/p/${P}/rename?name=${enc("a\u202eb")}`).query).toEqual({});
    const remove = at(`/p/${P}/remove?confirm=1`);
    expect(remove.name).toBe("projectRemove");
    expect(remove.query).toEqual({});
    expect(remove.dropped).toBeUndefined();
  });
  test("a bad project id falls back to Home; a deeper path falls back to the route", () => {
    expect(at("/p/k3m7q2x9ab/rename").name).toBe("home");
    expect(at(`/p/${P}x/remove`).name).toBe("home");
    const deeper = at(`/p/${P}/remove/now`);
    expect(deeper.name).toBe("projectRemove");
    expect(deeper.fallbackFrom).toBeDefined();
    expect(at(`/p/${P}/renam`).name).toBe("project");
    expect(at(`/p/${P}/session/${S}`).name).toBe("session");
  });
  test("href writes them back and their patterns go in log lines", () => {
    expect(href("projectRename", { project: P }, { name: "a b&c" })).toBe(`/p/${P}/rename?name=a%20b%26c`);
    expect(href("projectRemove", { project: P }, { name: "x" })).toBe(`/p/${P}/remove`);
    expect(routePattern(`/p/${P}/rename`)).toBe("/p/:project/rename");
    expect(routePattern(`/p/${P}/remove`)).toBe("/p/:project/remove");
    expect(isAppPath(`/p/${P}/remove`)).toBe(true);
  });
});

describe("Open on phone (v0.6 touch, DESIGN 7.9 and 9.6)", () => {
  test("/c/<chat>/phone is a view of the chat that pre-fills nothing; its view key stays", () => {
    const def = ROUTE_BY_NAME.phone!;
    expect(def).toMatchObject({ path: "/c/:chat/phone", kind: "view", prefill: "nothing", milestone: "v0.6 touch" });
    expect(Object.keys(def.query)).toEqual(["view"]);
    expect(at(`/c/${C}/phone`)).toMatchObject({ name: "phone", params: { chat: C }, query: {} });
    expect(at(`/c/${C}/phone?view=verbose`).query).toEqual({ view: "verbose" });
    // No other key reads: the code's path comes from the page that opened it, never from the URL.
    const extra = at(`/c/${C}/phone?path=%2Fetc&origin=https%3A%2F%2Fevil.example`);
    expect(extra.query).toEqual({});
    expect(extra.dropped).toBeUndefined();
    // It is no view of the side panel, so it never takes a pane's place.
    expect(PANE_ROUTES.has("phone")).toBe(false);
  });
  test("a bad chat id falls back to Home, a deeper path to the route, a bad view drops the key (5.4)", () => {
    expect(at("/c/c_demo01/phone")).toMatchObject({ name: "home", fallbackFrom: "/c/c_demo01/phone" });
    const deeper = at(`/c/${C}/phone/now`);
    expect(deeper.name).toBe("phone");
    expect(deeper.fallbackFrom).toBeDefined();
    const bad = at(`/c/${C}/phone?view=loud`);
    expect(bad.query).toEqual({});
    expect(bad.dropped).toBe(true);
  });
  test("href writes it back, and its pattern goes in log lines", () => {
    expect(href("phone", { chat: C })).toBe(`/c/${C}/phone`);
    expect(href("phone", { chat: C }, { view: "thinking", path: "/etc" })).toBe(`/c/${C}/phone?view=thinking`);
    expect(routePattern(`/c/${C}/phone`)).toBe("/c/:chat/phone");
    expect(isAppPath(`/c/${C}/phone`)).toBe(true);
  });
});
