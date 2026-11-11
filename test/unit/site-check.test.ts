// scripts/site-check.ts without a browser (DESIGN-W1 6): the request rule, the static server's path rule and the server
// itself on a test port, the command line and its port checks, the README's line, the reads of a streaming reply, and
// the report's summary. Nothing here starts Chrome.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEMO_REPLIES } from "../../site/demo/lines";
import { ArgError, DEFAULT_BASE, DEVTOOLS_OFFSET, LANG_PATH, S4_GROWS, SITE_SIZES, baseProblem, growingReads, parseArgs, readmeLine, requestAllowed, shownPrefix, sitePath, startSiteServer, summarize, type Args, type CheckRow } from "../../scripts/site-check";
import { pickTestPort } from "../click/ports";

const ROOT = resolve(import.meta.dir, "..", "..");
const O = "http://127.0.0.1:7948";
const B = "/kitespan/";

describe("requestAllowed: only the site's own files, and data:, blob: and about:", () => {
  test("the site's files under the base", () => {
    for (const u of [`${O}/kitespan/`, `${O}/kitespan/index.html`, `${O}/kitespan/zh-CN/`, `${O}/kitespan/assets/page-1a2b.js`, `${O}/kitespan/demo/?device=phone`, `${O}/kitespan/demo/chunk-9f.js#x`])
      expect(requestAllowed(u, O, B)).toBe(true);
  });

  test("data:, about: and this origin's blob:", () => {
    expect(requestAllowed("data:image/svg+xml,%3Csvg%3E", O, B)).toBe(true);
    expect(requestAllowed("about:blank", O, B)).toBe(true);
    expect(requestAllowed("about:srcdoc", O, B)).toBe(true);
    expect(requestAllowed(`blob:${O}/0d7c6a8e-1f2b-4c3d-9e8f-0a1b2c3d4e5f`, O, B)).toBe(true);
    expect(requestAllowed("blob:https://example.com/0d7c6a8e-1f2b-4c3d-9e8f-0a1b2c3d4e5f", O, B)).toBe(false);
  });

  test("another origin: another host, scheme or port", () => {
    for (const u of [
      "https://example.com/kitespan/",
      "https://github.com/wannaFlyKa/kitespan",
      "http://localhost:7948/kitespan/",
      "http://127.0.0.1:7949/kitespan/",
      "https://127.0.0.1:7948/kitespan/",
      "ws://127.0.0.1:7948/kitespan/ws",
      "http://user:pass@127.0.0.1:7948/kitespan/",
    ])
      expect(requestAllowed(u, O, B)).toBe(false);
  });

  test("this origin outside the base, also after the URL's own dot segments", () => {
    for (const u of [`${O}/`, `${O}/favicon.ico`, `${O}/kitespan`, `${O}/kitespanx/`, `${O}/c/k3m7q2x4abk3m7q2x4ab`, `${O}/api/projects`, `${O}/ws`, `${O}/kitespan/../c/x`, `${O}/kitespan/%2e%2e/c/x`])
      expect(requestAllowed(u, O, B)).toBe(false);
  });

  test("a URL that does not parse", () => {
    expect(requestAllowed("not a url", O, B)).toBe(false);
    expect(requestAllowed("", O, B)).toBe(false);
  });

  test("a root base takes the whole origin", () => {
    expect(requestAllowed(`${O}/c/x`, O, "/")).toBe(true);
    expect(requestAllowed("http://127.0.0.1:7941/c/x", O, "/")).toBe(false);
  });
});

describe("sitePath: files of the built folder only, as Pages serves a project page", () => {
  let site = "";
  let outside = "";
  beforeAll(() => {
    const top = mkdtempSync(join(tmpdir(), "site-check-"));
    site = join(top, "site");
    outside = join(top, "outside");
    mkdirSync(join(site, "zh-CN"), { recursive: true });
    mkdirSync(join(site, "assets"));
    mkdirSync(join(site, "empty"));
    mkdirSync(outside);
    writeFileSync(join(site, "index.html"), "<!doctype html><title>en</title>");
    writeFileSync(join(site, "zh-CN", "index.html"), "<!doctype html><title>zh</title>");
    writeFileSync(join(site, "assets", "page a.js"), "export {};");
    writeFileSync(join(site, ".hidden"), "x");
    writeFileSync(join(outside, "secret.txt"), "x");
    symlinkSync(join(outside, "secret.txt"), join(site, "assets", "link.txt"));
  });
  afterAll(() => rmSync(resolve(site, ".."), { recursive: true, force: true }));

  const file = (p: string) => sitePath(site, B, p);

  test("a file, a folder's index.html, and an encoded name", () => {
    expect(file("/kitespan/")).toEqual({ kind: "file", file: join(site, "index.html") });
    expect(file("/kitespan/index.html")).toEqual({ kind: "file", file: join(site, "index.html") });
    expect(file("/kitespan/zh-CN/")).toEqual({ kind: "file", file: join(site, "zh-CN", "index.html") });
    expect(file("/kitespan/assets/page%20a.js")).toEqual({ kind: "file", file: join(site, "assets", "page a.js") });
  });

  test("the base and a folder without their slash go to it", () => {
    expect(file("/kitespan")).toEqual({ kind: "redirect", to: "/kitespan/" });
    expect(file("/kitespan/zh-CN")).toEqual({ kind: "redirect", to: "/kitespan/zh-CN/" });
  });

  test("outside the base: the organisation's own root answers nothing", () => {
    for (const p of ["/", "/index.html", "/favicon.ico", "/c/k3m7q2x4abk3m7q2x4ab", "/kitespanx/", "/api/projects"]) expect(file(p)).toEqual({ kind: "missing" });
  });

  test("dot segments, encoded or not, an encoded slash or backslash, a NUL and a bad escape", () => {
    for (const p of [
      "/kitespan/../index.html",
      "/kitespan/%2e%2e/outside/secret.txt",
      "/kitespan/%2E%2E/%2E%2E/etc/passwd",
      "/kitespan/assets/..%2f..%2findex.html",
      "/kitespan/zh-CN%2findex.html",
      "/kitespan/zh-CN%5cindex.html",
      "/kitespan/./index.html",
      "/kitespan/index.html%00",
      "/kitespan/%zz",
      "/kitespan//index.html",
    ])
      expect(file(p)).toEqual({ kind: "missing" });
  });

  test("a missing file, a dot-file, a folder with no index.html, a file asked as a folder", () => {
    for (const p of ["/kitespan/missing.js", "/kitespan/.hidden", "/kitespan/empty/", "/kitespan/index.html/", "/kitespan/assets/"]) expect(file(p)).toEqual({ kind: "missing" });
  });

  test("a link that leads out of the folder", () => {
    expect(file("/kitespan/assets/link.txt")).toEqual({ kind: "missing" });
  });
});

describe("the static server on a test port", () => {
  const PORT = pickTestPort();
  let top = "";
  let server: ReturnType<typeof startSiteServer> | null = null;
  beforeAll(() => {
    top = mkdtempSync(join(tmpdir(), "site-check-serve-"));
    mkdirSync(join(top, "zh-CN"));
    writeFileSync(join(top, "index.html"), "<!doctype html><title>en</title>");
    writeFileSync(join(top, "zh-CN", "index.html"), "<!doctype html><title>zh</title>");
    writeFileSync(join(top, "site.css"), "body{}");
    server = startSiteServer({ root: top, port: PORT, base: B });
  });
  afterAll(() => {
    server?.stop();
    rmSync(top, { recursive: true, force: true });
  });

  test("serves the files with their types, 301 to a folder's slash, 404 elsewhere, and notes each path", async () => {
    const o = `http://127.0.0.1:${PORT}`;
    expect(server!.origin).toBe(o);
    const page = await fetch(`${o}/kitespan/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toStartWith("text/html");
    expect(await page.text()).toContain("<title>en</title>");
    const css = await fetch(`${o}/kitespan/site.css`);
    expect(css.headers.get("content-type")).toStartWith("text/css");
    await css.text();
    const moved = await fetch(`${o}/kitespan/zh-CN?x=1`, { redirect: "manual" });
    expect(moved.status).toBe(301);
    expect(moved.headers.get("location")).toBe("/kitespan/zh-CN/?x=1");
    for (const p of ["/", "/favicon.ico", "/kitespan/%2e%2e/index.html", "/kitespan/nope.js"]) {
      const r = await fetch(`${o}${p}`, { redirect: "manual" });
      expect(r.status).toBe(404);
      await r.text();
    }
    const post = await fetch(`${o}/kitespan/`, { method: "POST", body: "x" });
    expect(post.status).toBe(405);
    await post.text();
    expect(server!.asked.get("/kitespan/")).toBe(2);
    expect(server!.asked.get("/favicon.ico")).toBe(1);
  });
});

describe("the command line", () => {
  const ok = (extra: string[] = []) => parseArgs(["--site", "/srv/site", "--out", "/srv/out", "--port", "7948", ...extra]) as Args;
  const bad = (argv: string[]) => {
    try {
      parseArgs(argv);
    } catch (e) {
      expect(e).toBeInstanceOf(ArgError);
      return (e as Error).message;
    }
    throw new Error(`no error for ${argv.join(" ")}`);
  };

  test("the defaults: base /kitespan/, both languages, three sizes, both themes", () => {
    const a = ok();
    expect(a).toEqual({ site: "/srv/site", out: "/srv/out", port: 7948, base: DEFAULT_BASE, chrome: null, langs: ["en", "zh-CN"], sizes: [...SITE_SIZES], themes: ["light", "dark"] });
    expect(DEFAULT_BASE).toBe("/kitespan/");
    expect(a.port + DEVTOOLS_OFFSET).toBe(9348);
    expect(SITE_SIZES.map((v) => [v.width, v.height, v.touch])).toEqual([
      [1280, 800, false],
      [1194, 834, true],
      [390, 844, true],
    ]);
  });

  test("the options, and --name=value", () => {
    const a = ok(["--base=/", "--chrome", "/opt/chrome/chrome", "--langs", "zh-CN", "--sizes", "390x844,1280x800", "--themes", "dark"]);
    expect(a.base).toBe("/");
    expect(a.chrome).toBe("/opt/chrome/chrome");
    expect(a.langs).toEqual(["zh-CN"]);
    expect(a.sizes.map((v) => v.width)).toEqual([1280, 390]);
    expect(a.themes).toEqual(["dark"]);
    expect(parseArgs(["--help"])).toBe("help");
    expect(parseArgs(["--site", "x", "-h"])).toBe("help");
  });

  test("the three required ones", () => {
    expect(bad(["--out", "/srv/out", "--port", "7948"])).toContain("--site is required");
    expect(bad(["--site", "/srv/site", "--port", "7948"])).toContain("--out is required");
    expect(bad(["--site", "/srv/site", "--out", "/srv/out"])).toContain("--port is required");
  });

  test("only a test port: 7941 to 7949, never the demo's 7940 or another app's", () => {
    for (const p of ["7941", "7949"]) expect((parseArgs(["--site", "s", "--out", "o", "--port", p]) as Args).port).toBe(Number(p));
    expect(bad(["--site", "s", "--out", "o", "--port", "7940"])).toContain("another app");
    expect(bad(["--site", "s", "--out", "o", "--port", "7681"])).toContain("another app");
    expect(bad(["--site", "s", "--out", "o", "--port", "7950"])).toContain("not a test port");
    expect(bad(["--site", "s", "--out", "o", "--port", "80"])).toContain("not a test port");
    expect(bad(["--site", "s", "--out", "o", "--port", "79x8"])).toContain("port number");
  });

  test("a bad base, a value missing, an unknown option, a repeat, a stray word, an unknown list item", () => {
    expect(bad(["--site", "s", "--out", "o", "--port", "7948", "--base", "kitespan/"])).toContain("--base");
    expect(bad(["--site", "s", "--out", "o", "--port", "7948", "--base", "/kitespan"])).toContain("--base");
    expect(bad(["--site", "s", "--out", "o", "--port", "7948", "--base", "/a/../b/"])).toContain("--base");
    expect(bad(["--site", "--out", "o", "--port", "7948"])).toContain("--site needs a value");
    expect(bad(["--site", "s", "--out", "o", "--port"])).toContain("--port needs a value");
    expect(bad(["--site", "s", "--out", "o", "--port", "7948", "--cdp", "9222"])).toContain("unknown option --cdp");
    expect(bad(["--site", "s", "--site", "t", "--out", "o", "--port", "7948"])).toContain("twice");
    expect(bad(["serve", "--site", "s"])).toContain("unexpected argument");
    expect(bad(["--site", "s", "--out", "o", "--port", "7948", "--sizes", "800x600"])).toContain("unknown size");
    expect(bad(["--site", "s", "--out", "o", "--port", "7948", "--langs", "fr"])).toContain("unknown lang");
    expect(bad(["--site", "s", "--out", "o", "--port", "7948", "--themes", ","])).toContain("at least one");
  });

  test("baseProblem", () => {
    for (const b of ["/", "/kitespan/", "/a/b-c/", "/v1.2/"]) expect(baseProblem(b)).toBeNull();
    for (const b of ["", "kitespan", "/kitespan", "kitespan/", "//", "/a//b/", "/./", "/../", "/a b/", "/%2e/"]) expect(baseProblem(b)).not.toBeNull();
  });
});

describe("the README's line, the page's h1", () => {
  test("after the title and the language link", () => {
    expect(readmeLine("# kitespan\n\n[简体中文](README.zh-CN.md)\n\nA browser UI for `claude`, from [a phone](x.md).\n\nMore.\n")).toBe("A browser UI for claude, from a phone.");
    expect(readmeLine("# kitespan\n\n## Install\n")).toBeNull();
    expect(readmeLine("")).toBeNull();
  });

  test("both READMEs have one", () => {
    const en = readmeLine(readFileSync(join(ROOT, "README.md"), "utf8"));
    const zh = readmeLine(readFileSync(join(ROOT, "README.zh-CN.md"), "utf8"));
    expect(en).toContain("Claude Code CLI");
    expect(zh).toContain("Claude Code CLI");
    expect(en).not.toBe(zh);
    expect(LANG_PATH).toEqual({ en: "", "zh-CN": "zh-CN/" });
  });
});

describe("the reads of a streaming reply", () => {
  const reply = DEMO_REPLIES.en;
  test("shownPrefix: how much of the reply's start the text holds", () => {
    expect(shownPrefix("", reply)).toBe(0);
    expect(shownPrefix(`You: hi ${reply.slice(0, 20)}`, reply)).toBe(20);
    expect(shownPrefix(`before ${reply} after`, reply)).toBe(reply.length);
    expect(shownPrefix("这是一个", DEMO_REPLIES["zh-CN"])).toBe(4);
  });

  test("growingReads counts the partial reads that grew, after where it started", () => {
    expect(growingReads([0, 12, 24, 24, 36, reply.length], 0, reply.length)).toBe(3);
    expect(growingReads([0, reply.length], 0, reply.length)).toBe(0);
    expect(growingReads([4, 4, 30, 60], 4, reply.length)).toBe(2);
    expect(growingReads([50, 20, 60], 0, reply.length)).toBe(2);
  });

  test("FIX-Q1: S4 asks for a reply that grows over many reads; the Chinese reply's few big jumps before it do not pass", () => {
    const zh = DEMO_REPLIES["zh-CN"].length;
    // W1's integrator's reads of the Chinese reply, when the page showed only whole space-separated words.
    const jumps = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 42, 60, 61, zh];
    expect(growingReads(jumps, 0, zh)).toBeLessThan(S4_GROWS);
    // A word (one or two characters) at a time: about two more characters a read.
    const words = Array.from({ length: 40 }, (_, i) => Math.min(zh, i * 2));
    expect(growingReads(words, 0, zh)).toBeGreaterThanOrEqual(S4_GROWS);
  });
});

describe("the report's summary", () => {
  test("counts each status and lists the failures", () => {
    const rows: CheckRow[] = [
      { run: "en 1280x800 light", step: "first screen", status: "pass", text: "the h1 is the README's line" },
      { run: "en 1280x800 light", step: "S1 card", status: "fail", text: "no \"Allowed once\" within 5 s" },
      { run: "zh-CN 390x844 dark", step: "theme", status: "warn", text: "slow" },
      { run: "zh-CN 390x844 dark", step: "end", status: "pass", text: "no service worker" },
    ];
    const s = summarize(rows);
    expect(s).toMatchObject({ total: 4, passed: 2, failed: 1, warned: 1 });
    expect(s.failures).toEqual(['en 1280x800 light: S1 card: no "Allowed once" within 5 s']);
    expect(s.line).toBe("site-check: 4 checks, 2 passed, 1 failed, 1 warning");
    expect(summarize([]).line).toBe("site-check: 0 checks, 0 passed, 0 failed, 0 warnings");
  });
});
