// The route table and the strict decoder (DESIGN.md section 5) as the page reads them (web/routes.ts and web/router.ts
// re-export shared/route.ts): every route parses from its own example, formats back to a canonical URL, keeps only
// allowed query keys within their caps, and an invalid path falls back to a valid parent.
import { describe, expect, test } from "bun:test";
import { APP_EXACT_PATHS, APP_PATH_PREFIXES, ROUTES } from "../../web/routes";
import { decodeQuery, href, isSafeRelativePath, parse } from "../../web/router";

const at = (u: string) => parse(new URL(u, "http://127.0.0.1:7941"));

describe("route table", () => {
  test("names and paths are unique", () => {
    expect(new Set(ROUTES.map((r) => r.name)).size).toBe(ROUTES.length);
    expect(new Set(ROUTES.map((r) => r.path)).size).toBe(ROUTES.length);
  });
  for (const r of ROUTES)
    test(`${r.name}: its example opens it with no fallback`, () => {
      const route = at(r.example);
      expect(route.name).toBe(r.name);
      expect(route.fallbackFrom).toBeUndefined();
    });
  test("every action route pre-fills something or names its confirm button", () => {
    for (const r of ROUTES.filter((x) => x.kind === "action")) expect(r.prefill).not.toBe("nothing");
  });
  test("the server's shell families cover every route example (DESIGN.md 5.1 rule 1)", () => {
    for (const r of ROUTES) {
      const path = new URL(r.example, "http://x").pathname;
      expect(APP_EXACT_PATHS.includes(path) || APP_PATH_PREFIXES.some((p) => path.startsWith(p))).toBe(true);
    }
  });
});

describe("decoder", () => {
  test("params and query values decode", () => {
    const r = at("/c/demoolxxxxxxxxxxxxxx/send?text=Run%20the%20tests%20again&evil=1");
    expect(r.params).toEqual({ chat: "demoolxxxxxxxxxxxxxx" });
    expect(r.query).toEqual({ text: "Run the tests again" });
  });
  test("an enum value outside its list is dropped", () => {
    expect(at("/c/demoolxxxxxxxxxxxxxx/mode?pick=yolo").query).toEqual({});
    expect(at("/c/demoolxxxxxxxxxxxxxx/mode?pick=plan").query).toEqual({ pick: "plan" });
  });
  test("a text value over its cap is dropped, at the cap it stays", () => {
    expect(at(`/c/demoolxxxxxxxxxxxxxx/send?text=${"a".repeat(5001)}`).query).toEqual({});
    expect((at(`/c/demoolxxxxxxxxxxxxxx/send?text=${"a".repeat(5000)}`).query.text as string).length).toBe(5000);
    expect(at(`/c/demoolxxxxxxxxxxxxxx/rename?title=${"t".repeat(121)}`).query).toEqual({});
    expect(at(`/c/demoolxxxxxxxxxxxxxx/rename?title=${"t".repeat(120)}`).query.title).toBe("t".repeat(120));
  });
  test("a repeated key keeps each value and is never split on commas", () => {
    expect(at("/c/asko2xxxxxxxxxxxxxxx/question/rq_ask1?pick=a&pick=b,c").query.pick).toEqual(["a", "b,c"]);
    const five = at("/c/asko2xxxxxxxxxxxxxxx/question/rq_ask1?pick=a&pick=b&pick=c&pick=d&pick=e");
    expect(five.query).toEqual({});
    expect(five.dropped).toBe(true);
  });
  test("a bad value drops that key alone and flags the route", () => {
    const r = at("/c/demoolxxxxxxxxxxxxxx/permission/rq_bash1?answer=always&view=verbose");
    expect(r.query).toEqual({ view: "verbose" });
    expect(r.dropped).toBe(true);
    expect(at("/c/demoolxxxxxxxxxxxxxx?utm=1").dropped).toBeUndefined();
  });
  test("an int outside its range is dropped", () => {
    expect(at("/c/demoolxxxxxxxxxxxxxx/files/src/a.ts?line=0").query).toEqual({});
    expect(at("/c/demoolxxxxxxxxxxxxxx/files/src/a.ts?line=42").query).toEqual({ line: 42 });
  });
  test("control characters never reach a screen", () => {
    expect(decodeQuery({ q: { type: "text", max: 50 } }, new URLSearchParams("q=a%00b"))).toEqual({});
    expect(at("/c/demoolxxxxxxxxxxxxxx/m/ab%00c").name).toBe("chat");
  });
  // The "Trojan Source" pattern: a bidirectional override makes the command or the title on screen read differently
  // from what Run or Save acts on. Such a value is dropped, and the screen says "Part of that link could not be read."
  const enc = encodeURIComponent;
  test("a bidirectional control in a pre-fill drops that value and flags the route", () => {
    const bash = at(`/c/idleo6xxxxxxxxxxxxxx/bash?cmd=${enc("cat \u202etxt.ten-on/pmt/\u202c && echo ok")}`);
    expect(bash.name).toBe("bash");
    expect(bash.query).toEqual({});
    expect(bash.dropped).toBe(true);
    const rename = at(`/c/demoolxxxxxxxxxxxxxx/rename?title=${enc("Release notes \u202etxt.exe")}&view=verbose`);
    expect(rename.query).toEqual({ view: "verbose" });
    expect(rename.dropped).toBe(true);
    expect(at(`/c/idleo6xxxxxxxxxxxxxx/send?text=${enc("abc \u202e")}`).query).toEqual({});
    expect(at(`/c/idleo6xxxxxxxxxxxxxx/slash/compact?args=${enc("keep \u2067x\u2069")}`).query).toEqual({});
    expect(at(`/c/asko2xxxxxxxxxxxxxxx/question/rq_ask1?pick=${enc("Unit tests")}&pick=${enc("\u200fClick-through")}`).query).toEqual({});
  });
  test("every bidirectional mark, isolate and override, the C1 controls and the line separators are refused", () => {
    const spec = { q: { type: "text", max: 50 } } as const;
    for (const ch of ["\u0080", "\u0085", "\u009f", "\u061c", "\u200e", "\u200f", "\u2028", "\u2029", "\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069"])
      expect(decodeQuery(spec, new URLSearchParams({ q: `a${ch}b` }))).toEqual({});
  });
  test("newline and tab stay allowed in text, and other scripts and emoji pass", () => {
    const spec = { q: { type: "text", max: 80 } } as const;
    for (const ok of ["two\nlines", "a\tb", "שלום עולם", "مرحبا", "日本語", "family \u{1f468}\u200d\u{1f469}\u200d\u{1f467}", "café"])
      expect(decodeQuery(spec, new URLSearchParams({ q: ok }))).toEqual({ q: ok });
  });
  test("a path segment with a bidirectional control or a C1 control falls back to the parent", () => {
    expect(isSafeRelativePath("docs/\u202egpj.exe")).toBe(false);
    expect(isSafeRelativePath("docs/a\u0085b")).toBe(false);
    const r = at(`/c/demoolxxxxxxxxxxxxxx/files/docs/${enc("\u202egpj.exe")}`);
    expect(r.name).toBe("files");
    expect(r.params.path).toBe("docs");
    expect(r.fallbackFrom).toBeDefined();
    expect(at(`/settings/${enc("about\u200e")}`).name).toBe("settings");
  });
});

describe("fallback to the nearest valid parent", () => {
  test("a bad block id falls back to the chat", () => {
    const r = at("/c/demoolxxxxxxxxxxxxxx/tool/%3Cscript%3E");
    expect(r.name).toBe("chat");
    expect(r.fallbackFrom).toBe("/c/demoolxxxxxxxxxxxxxx/tool/%3Cscript%3E");
  });
  test("an unknown settings section falls back to Settings", () => {
    expect(at("/settings/secrets").name).toBe("settings");
  });
  test("a bad chat id falls back to home", () => {
    expect(at("/c/../../etc/passwd").name).toBe("home");
  });
  test("an unknown path falls back to home", () => {
    expect(at("/nope/nope").name).toBe("home");
  });
});

describe("file paths in URLs", () => {
  test("only safe relative paths", () => {
    expect(isSafeRelativePath("src/upload.ts")).toBe(true);
    for (const bad of ["/etc/passwd", "../x", "a/../b", "a//b", "", "a/./b"]) expect(isSafeRelativePath(bad)).toBe(false);
  });
  test("a file route keeps its relative path", () => {
    expect(at("/c/demoolxxxxxxxxxxxxxx/files/src/upload.ts").params.path).toBe("src/upload.ts");
    expect(at("/c/demoolxxxxxxxxxxxxxx/files/..%2Fsecret").name).toBe("chat");
  });
});

describe("specific routes", () => {
  test("a session preview needs a UUID", () => {
    expect(at("/p/kitespanxx/session/7c9e6679-7425-40de-944b-e07fc1f90ae7").name).toBe("session");
    expect(at("/p/kitespanxx/session/not-a-uuid").name).toBe("project");
  });
  test("the restart dialog is not a setting key", () => {
    expect(at("/settings/about/restart").name).toBe("restart");
    expect(at("/settings/chats/live-max").name).toBe("setting");
    expect(at("/settings/chats/restart").name).toBe("settingsSection");
  });
  test("the bare / menu and a command row", () => {
    expect(at("/c/idleo6xxxxxxxxxxxxxx/slash").name).toBe("slashMenu");
    expect(at("/c/idleo6xxxxxxxxxxxxxx/slash/compact?args=x").query).toEqual({ args: "x" });
  });
});

describe("href", () => {
  test("builds canonical URLs that parse back", () => {
    const u = href("send", { chat: "demoolxxxxxxxxxxxxxx" }, { text: "a b&c" });
    expect(u).toBe("/c/demoolxxxxxxxxxxxxxx/send?text=a%20b%26c");
    expect(at(u).query.text).toBe("a b&c");
    expect(href("files", { chat: "demoolxxxxxxxxxxxxxx", path: "src/my file.ts" })).toBe("/c/demoolxxxxxxxxxxxxxx/files/src/my%20file.ts");
    expect(href("question", { chat: "asko2xxxxxxxxxxxxxxx", request: "rq_ask1" }, { pick: ["a b", "c,d"] })).toBe("/c/asko2xxxxxxxxxxxxxxx/question/rq_ask1?pick=a%20b&pick=c%2Cd");
  });
});
