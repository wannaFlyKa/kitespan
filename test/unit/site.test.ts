// The landing page's build (DESIGN-W1 5.4): scripts/build-site.ts into a fresh folder makes exactly the site's files;
// every src, href and url() of every page is relative and names a file that the build wrote; each page is its README's
// (its first line as the h1, the sections of DESIGN-W1 1.1 in order, the minimum Claude Code version, Bun's version, the
// disclaimer, the install commands of shared/release.ts); every page's Content-Security-Policy forbids network calls
// and lists the hash of each inline script; the outside links are exactly the listed ones (not fetched); and the README
// cutting stops on a missing heading, raw HTML, an image or a command that is not the release's.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import { NO_SIGN_IN } from "../../server/adapters/adapters";
import { CLAUDE_CODE_MINIMUM } from "../../server/agents/claude/background";
import { BREW_FORMULA, RELEASE_REPO, RELEASES_URL } from "../../shared/release";
import { buildSite, clearOut, fileProblems, linkAllowed, siteMade, type SiteBuild } from "../../scripts/build-site";
import { cutSection, PAGE_FILE, ReadmeError, readmeParts, renderPage } from "../../site/render";
import { THEME_SCRIPT } from "../../site/theme";
import { LANGS, WORDS, type Lang } from "../../site/words";

const ROOT = resolve(import.meta.dir, "..", "..");
const REPO = `https://github.com/${RELEASE_REPO}`;
const README: Record<Lang, string> = { en: readFileSync(join(ROOT, "README.md"), "utf8"), "zh-CN": readFileSync(join(ROOT, "README.zh-CN.md"), "utf8") };
const VERSION = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;

const dir = mkdtempSync(join(tmpdir(), "site-test-"));
const out = join(dir, "site");
let built: SiteBuild;
const page = (rel: string) => readFileSync(join(out, rel), "utf8");
/** The text of an HTML fragment: tags dropped, the entities marked writes put back, blanks as one space. */
const text = (html: string) =>
  html
    .replace(/<[^>]*>/g, "")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const attrs = (html: string, name: string) => [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, "g"))].map((m) => m[1]!);
const csp = (html: string) => /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html)?.[1] ?? "";
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("base64");
/** The README's text with its line breaks as spaces. */
const flatReadme = (lang: Lang) => README[lang].replace(/\s+/g, " ");
/** The Claude Agent SDK's terms, which the READMEs and the pages link. */
const SDK_TERMS = "https://code.claude.com/docs/en/legal-and-compliance";

beforeAll(async () => {
  built = await buildSite({ root: ROOT, out, quiet: true });
}, 120_000);

afterAll(() => {
  if (existsSync(out)) {
    clearOut(out);
    rmdirSync(out);
  }
  rmdirSync(dir);
});

describe("the built site", () => {
  test("it holds the two pages, one script and one stylesheet in assets/, and the demo, and nothing else", () => {
    expect(built.files).toContain("index.html");
    expect(built.files).toContain("zh-CN/index.html");
    expect(built.files).toContain("demo/index.html");
    for (const f of built.files) expect(siteMade(f), f).toBe(true);
    const assets = built.files.filter((f) => f.startsWith("assets/"));
    expect(assets.length).toBe(2);
    expect(assets.filter((f) => /^assets\/page-[a-z0-9]+\.js$/.test(f)).length).toBe(1);
    expect(assets.filter((f) => /^assets\/site-[a-z0-9]+\.css$/.test(f)).length).toBe(1);
    expect(built.bytes).toBeGreaterThan(0);
  });

  test("every src, href and url() of every page and stylesheet is relative and names a file of the build", () => {
    const missing: string[] = [];
    for (const rel of built.files.filter((f) => /\.(html|css)$/.test(f))) {
      const body = page(rel);
      const refs = [...attrs(body, "src"), ...attrs(body, "href"), ...attrs(body, "data-demo"), ...[...body.matchAll(/url\(\s*(["']?)([^"')]*)\1\s*\)/g)].map((m) => m[2]!)];
      for (const ref of refs) {
        expect(ref.startsWith("/"), `${rel}: ${ref}`).toBe(false);
        if (/^(https|data):/.test(ref) || ref.startsWith("#")) continue;
        expect(ref, `${rel}: ${ref}`).not.toMatch(/^[a-z][a-z0-9+.-]*:/i);
        let target = posix.normalize(posix.join(posix.dirname(rel), ref.split(/[?#]/)[0]!));
        if (ref.split(/[?#]/)[0]!.endsWith("/") || target === ".") target = posix.join(target, "index.html");
        if (!built.files.includes(target)) missing.push(`${rel}: ${ref} (${target})`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("each landing page links the other language's page, its own top and its demo", () => {
    const en = page("index.html");
    const zh = page("zh-CN/index.html");
    expect(en).toContain('<a href="zh-CN/" lang="zh-CN" hreflang="zh-CN">简体中文</a>');
    expect(zh).toContain('<a href="../" lang="en" hreflang="en">English</a>');
    expect(en).toContain('<link rel="alternate" hreflang="zh-CN" href="zh-CN/">');
    expect(zh).toContain('<link rel="alternate" hreflang="en" href="../">');
    expect(en).toContain('data-demo="./demo/"');
    expect(zh).toContain('data-demo="../demo/"');
    for (const p of [en, zh]) expect(p).toContain('<a class="mark" href="./">');
  });

  test("every page's policy allows no network call, and lists the hash of each inline script it holds", () => {
    for (const rel of built.files.filter((f) => f.endsWith(".html"))) {
      const body = page(rel);
      const policy = csp(body);
      expect(policy, rel).toMatch(/(^|; )connect-src 'none'(;|$)/);
      expect(policy, rel).toMatch(/(^|; )object-src 'none'(;|$)/);
      expect(policy, rel).toMatch(/(^|; )base-uri 'none'(;|$)/);
      // The policy comes before any script or stylesheet that it governs.
      expect(body.indexOf("Content-Security-Policy"), rel).toBeLessThan(body.search(/<script|<link rel="stylesheet"/));
      const scriptSrc = policy.split("; ").find((d) => d.startsWith("script-src "))!;
      expect(scriptSrc, rel).not.toContain("'unsafe-inline'");
      expect(scriptSrc, rel).not.toContain("'unsafe-eval'");
      for (const m of body.matchAll(/<script>([\s\S]*?)<\/script>/g)) expect(scriptSrc, rel).toContain(`'sha256-${sha256(m[1]!)}'`);
    }
    for (const lang of LANGS) {
      const body = page(PAGE_FILE[lang]);
      expect(body).toContain(`<script>${THEME_SCRIPT}</script>`);
      expect(csp(body)).toContain("frame-src 'self'");
      expect(csp(body)).toContain("worker-src 'none'");
      expect(csp(body)).toContain("form-action 'none'");
    }
  });

  test("the landing page's script holds no React and no Copy of the app: the app runs only in its frames", () => {
    const js = page(built.files.find((f) => /^assets\/page-.*\.js$/.test(f))!);
    expect(js).not.toContain("enqueueForceUpdate");
    expect(js).not.toContain("react.dev");
    expect(js).not.toContain("useState");
  });

  test("the build's own rule check passes on what it wrote (and is the one that guards a later change)", () => {
    const problems = built.files.filter((f) => /\.(html|css|js)$/.test(f)).flatMap((f) => fileProblems(f, page(f), ROOT));
    expect(problems).toEqual([]);
  });
});

describe("each landing page is its README", () => {
  for (const lang of LANGS) {
    const w = WORDS[lang];
    const h = w.headings;
    const body = () => page(PAGE_FILE[lang]);

    test(`${lang}: its lang, and the README's first line as the h1 and the description`, () => {
      expect(body()).toContain(`<html lang="${lang}">`);
      const line = README[lang].split("\n")[4]!;
      expect(line.length).toBeGreaterThan(20);
      const h1 = /<h1 id="line">([\s\S]*?)<\/h1>/.exec(body())?.[1] ?? "";
      expect(text(h1)).toBe(line);
      expect(body()).toContain(`<meta name="description" content="${line}">`);
      expect(body()).toContain("<title>kitespan</title>");
    });

    test(`${lang}: the sections of DESIGN-W1 1.1, in order`, () => {
      const headings = [...body().matchAll(/<(h[1-3])\b[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => `${m[1]} ${text(m[2]!)}`);
      expect(headings.slice(1)).toEqual([
        `h2 ${h.why}`,
        `h2 ${h.who}`,
        `h2 ${h.install}`,
        `h3 ${h.requirements}`,
        `h3 ${h.script}`,
        `h3 ${h.brew}`,
        `h3 ${h.source}`,
        `h2 ${h.works}`,
        `h2 ${h.remote}`,
      ]);
    });

    test(`${lang}: the README's words: the opening, the story, the audience, the tables, the licence and the trademarks`, () => {
      const page = text(body());
      for (const heading of [h.why, h.who, h.works, h.licence, h.trademarks]) {
        const md = cutSection(README[lang], heading);
        // Each paragraph's first words (a table's first row) are on the page, with the README's own Markdown taken off.
        for (const block of md.split(/\n\s*\n/)) {
          const first = block.split("\n")[0]!.replace(/^[-|#\s]+/, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*]/g, "").split("|")[0]!.trim();
          if (first && !/^-+$/.test(first)) expect(page, `${lang} ${heading}: ${first}`).toContain(first.slice(0, 40));
        }
      }
      expect(page).toContain(`Claude Code ${CLAUDE_CODE_MINIMUM}`);
      expect(page).toContain(lang === "en" ? "Bun 1.3.14 or later" : "Bun 1.3.14 或更高版本");
    });

    test(`${lang}: the install commands are the release's, each with its Copy button, named after its way`, () => {
      const code = [...body().matchAll(/<div class="cmd"><pre><code>([\s\S]*?)<\/code><\/pre><button type="button" class="copy-btn" aria-label="([^"]*)">([^<]*)<\/button><\/div>/g)];
      expect(code.map((m) => text(m[1]!))).toEqual([
        `curl -fsSL ${RELEASES_URL}/latest/download/install.sh | sh`,
        `brew install ${BREW_FORMULA}`,
        `git clone ${REPO}.git kitespan cd kitespan bun install --frozen-lockfile --omit=optional bun run build`,
      ]);
      // A screen reader's list of buttons tells the three apart; each name starts with the button's own word.
      expect(code.map((m) => text(m[2]!))).toEqual([h.script, h.brew, h.source].map((way) => w.copyName(way)));
      for (const m of code) {
        expect(text(m[2]!).startsWith(w.copy)).toBe(true);
        expect(m[3]).toBe(w.copy);
      }
      expect(body()).not.toContain("this repository&gt;");
    });

    test(`${lang}: after the commands, the README's paragraph on the SDK: Anthropic's, under its own terms, fetched by each way`, () => {
      const b = body();
      const after = b.slice(b.lastIndexOf('<div class="cmd">'), b.indexOf(`<h2>${h.works}</h2>`));
      const want =
        lang === "en"
          ? ["`--omit=optional` keeps the SDK's bundled Claude Code binaries out", "The Claude Agent SDK is Anthropic's, under its own terms", "Each install way above fetches it the same way."]
          : ["`--omit=optional` 让 SDK 自带的 Claude Code 二进制文件不被安装", "Claude Agent SDK 属于 Anthropic，适用它自己的条款", "上面每种安装方式都以同样的方式获取它。"];
      for (const words of want) {
        expect(flatReadme(lang)).toContain(words);
        expect(text(after)).toContain(words.replace(/`/g, ""));
      }
      expect(attrs(after, "href")).toEqual([SDK_TERMS]);
    });

    test(`${lang}: every table's header cells have words, so a screen reader reads each column under its name`, () => {
      const heads = [...body().matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((m) => text(m[1]!));
      expect(heads.length).toBeGreaterThan(0);
      expect(heads.filter((t) => !t)).toEqual([]);
    });

    test(`${lang}: no kitespan version but package.json's`, () => {
      for (const m of body().matchAll(/(?:KITESPAN_VERSION=|kitespan-)(\d+\.\d+\.\d+)/g)) expect(m[1]).toBe(VERSION);
    });

    test(`${lang}: the site's own words`, () => {
      const b = body();
      expect(b).toContain(`aria-label="${w.darkTheme}" title="${w.darkTheme}"`);
      expect(b).toContain(`role="radiogroup" aria-label="${w.device}"`);
      expect(b).toContain(`data-label="${w.phone}"`);
      expect(b).toContain(`data-label="${w.laptop}"`);
      expect(b).toContain(`<p class="note">${w.note}</p>`);
      expect(b).toContain(`<noscript><p class="no-script">${w.noScript}</p></noscript>`);
      expect(b).toContain(`<nav aria-label="${w.links}">`);
      for (const word of [w.readme, w.contributing, w.security, w.github]) expect(b).toContain(`>${word}</a>`);
    });
  }

  test("en: the remote-access disclaimer as the server prints it", () => {
    expect(text(page("index.html"))).toContain(NO_SIGN_IN);
  });

  test("the two languages have the same words, none empty", () => {
    const keys = (o: object): string[] => Object.entries(o).flatMap(([k, v]) => (typeof v === "object" ? keys(v).map((s) => `${k}.${s}`) : [k]));
    expect(keys(WORDS["zh-CN"])).toEqual(keys(WORDS.en));
    for (const lang of LANGS) for (const v of Object.values(WORDS[lang]).flatMap((v) => (typeof v === "object" ? Object.values(v) : [v]))) expect(String(v).trim().length).toBeGreaterThan(0);
  });
});

describe("the outside links", () => {
  test("they are exactly the listed ones, each https (a new one fails here until it is listed); not fetched", () => {
    const links = new Set<string>();
    for (const lang of LANGS) for (const href of attrs(page(PAGE_FILE[lang]), "href")) if (/^[a-z]+:/.test(href) && !href.startsWith("data:")) links.add(href);
    expect([...links].sort()).toEqual(
      [
        REPO,
        `${REPO}#readme`,
        `${REPO}/blob/main/CONTRIBUTING.md`,
        `${REPO}/blob/main/LICENSE`,
        `${REPO}/blob/main/NOTICE`,
        `${REPO}/blob/main/README.zh-CN.md`,
        `${REPO}/blob/main/SECURITY.md`,
        `${REPO}/blob/main/test/live/README.md`,
        "https://bun.com/docs/installation",
        SDK_TERMS,
      ].sort(),
    );
    for (const l of links) expect(linkAllowed(l, ROOT), l).toBe(true);
  });

  test("a link to a file that is not in the repository, outside it, or elsewhere is refused", () => {
    expect(linkAllowed(`${REPO}/blob/main/NOPE.md`, ROOT)).toBe(false);
    expect(linkAllowed(`${REPO}/blob/main/../x`, ROOT)).toBe(false);
    expect(linkAllowed(`${REPO}/blob/main/test`, ROOT)).toBe(false);
    expect(linkAllowed(`${REPO}/blob/main/LICENSE?x=1`, ROOT)).toBe(false);
    expect(linkAllowed("https://example.com/", ROOT)).toBe(false);
    expect(linkAllowed(`${REPO}/issues`, ROOT)).toBe(false);
  });
});

describe("the build's rules for a written file", () => {
  const head = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'none'">`;
  test("a path from the root, http, an unlisted link, another scheme or a missing policy stops the build", () => {
    expect(fileProblems("a.html", `${head}<script src="/x.js"></script>`, ROOT)).toHaveLength(1);
    expect(fileProblems("a.html", `${head}<a href="http://example.com/">x</a>`, ROOT)).toHaveLength(1);
    expect(fileProblems("a.html", `${head}<a href="https://example.com/">x</a>`, ROOT)).toHaveLength(1);
    expect(fileProblems("a.html", `${head}<a href="javascript:alert(1)">x</a>`, ROOT)).toHaveLength(1);
    expect(fileProblems("a.html", `<a href="./b.html">x</a>`, ROOT)).toEqual(["a.html: no Content-Security-Policy meta"]);
    expect(fileProblems("a.html", `<meta http-equiv="Content-Security-Policy" content="default-src 'self'">`, ROOT)).toHaveLength(1);
    expect(fileProblems("a.css", `a{background:url(/x.png)}`, ROOT)).toHaveLength(1);
    expect(fileProblems("a.css", `a{background:url("https://example.com/x.png")}`, ROOT)).toHaveLength(1);
    expect(fileProblems("a.js", `import("/chunk.js")`, ROOT)).toHaveLength(1);
    expect(fileProblems("a.js", `import{a}from"/chunk.js"`, ROOT)).toHaveLength(1);
  });

  test("relative paths, data: URLs, anchors and listed links pass", () => {
    expect(fileProblems("a.html", `${head}<link rel="icon" href="data:image/svg+xml,x"><a href="#top">x</a><a href="zh-CN/">x</a><a href="${REPO}">x</a>`, ROOT)).toEqual([]);
    expect(fileProblems("a.css", `a{background:url(data:image/svg+xml,x)}b{background:url(./x.png)}`, ROOT)).toEqual([]);
    expect(fileProblems("a.js", `import("./chunk-1.js");import{a}from"./chunk-2.js"`, ROOT)).toEqual([]);
  });
});

describe("the out folder", () => {
  test("a folder that holds another file, or a link, stops the build and keeps everything", () => {
    const d = mkdtempSync(join(tmpdir(), "site-out-"));
    try {
      writeFileSync(join(d, "index.html"), "old");
      writeFileSync(join(d, "notes.txt"), "mine");
      expect(() => clearOut(d)).toThrow("holds files that the site build did not make: notes.txt");
      expect(existsSync(join(d, "index.html"))).toBe(true);
      unlinkSync(join(d, "notes.txt"));
      mkdirSync(join(d, "assets"));
      symlinkSync(join(d, "index.html"), join(d, "assets", "link.js"));
      expect(() => clearOut(d)).toThrow("not a plain file");
      unlinkSync(join(d, "assets", "link.js"));
      mkdirSync(join(d, "other"));
      expect(() => clearOut(d)).toThrow("other/");
      rmdirSync(join(d, "other"));
    } finally {
      clearOut(d);
      rmdirSync(d);
    }
  });

  test("an earlier build's files are cleared, file by file", () => {
    const d = mkdtempSync(join(tmpdir(), "site-out-"));
    try {
      for (const f of ["index.html", "zh-CN/index.html", "assets/page-1.js", "demo/index.html", "demo/chunk-1.js"]) {
        mkdirSync(join(d, f, ".."), { recursive: true });
        writeFileSync(join(d, f), "old");
      }
      clearOut(d);
      expect(existsSync(join(d, "index.html"))).toBe(false);
      expect(existsSync(join(d, "demo"))).toBe(false);
    } finally {
      rmdirSync(d);
    }
  });
});

describe("the README cutting (renderPage alone)", () => {
  const input = (readme: string, lang: Lang = "en") => ({ lang, readme, assets: { js: "page-1.js", css: "site-1.css" }, csp: "default-src 'self'; connect-src 'none'", icon: "data:image/svg+xml,x" });

  test("both READMEs render as they are", () => {
    for (const lang of LANGS) expect(() => renderPage(input(README[lang], lang))).not.toThrow();
  });

  test("a missing heading stops it, naming the heading", () => {
    const md = README.en.replace("## Who it is for\n", "## Who it is\n");
    expect(() => renderPage(input(md))).toThrow(ReadmeError);
    expect(() => renderPage(input(md))).toThrow('README.md has no "## Who it is for" heading');
  });

  test("a ### inside a section stays in it, and a # inside a code block is not a heading", () => {
    const md = README.en.replace("## Why it exists\n", "## Why it exists\n\n### On the way\n\n```sh\n# a comment\n## not a heading\n```\n");
    const why = readmeParts(md, "en").why;
    expect(why).toContain("<h3>On the way</h3>");
    expect(why).toContain("## not a heading");
    expect(why).toContain("super commuter");
  });

  test("raw HTML or an image in a section stops it", () => {
    expect(() => renderPage(input(README.en.replace("## Why it exists\n", "## Why it exists\n\n<img src=x>\n")))).toThrow("raw HTML");
    expect(() => renderPage(input(README.en.replace("## Who it is for\n", "## Who it is for\n\nSee <b>this</b>.\n")))).toThrow("raw HTML");
    expect(() => renderPage(input(README.en.replace("## Why it exists\n", "## Why it exists\n\n![a shot](shot.png)\n")))).toThrow("an image");
  });

  test("an install command that is not the release's stops it", () => {
    expect(() => renderPage(input(README.en.replace(`brew install ${BREW_FORMULA}`, "brew install someone/tap/kitespan")))).toThrow("shared/release.ts");
  });

  test("a relative link goes to the repository's file on GitHub; the others stay", () => {
    const parts = readmeParts(README.en, "en");
    expect(parts.works).toContain(`href="${REPO}/blob/main/test/live/README.md"`);
    expect(parts.licence).toContain(`href="${REPO}/blob/main/LICENSE"`);
    expect(parts.requirements).toContain('href="https://bun.com/docs/installation"');
  });
});
