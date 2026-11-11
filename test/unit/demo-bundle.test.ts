// The demo stays out of the product (FIX-W1 1.2, DESIGN-W1 4.2): the app's own build (scripts/build-web.ts, as `bun run
// build` makes it) holds none of the demo's code or data, while the site's builds of the demo hold all of it, so the
// test's needles are real. Also: no file of web/ imports anything of site/, and site/demo/shim.ts, which must run before
// the app's first module, imports nothing from web/.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DEMO_SWAPS, buildDemo, demoCsp, inlineScripts } from "../../site/demo/build";
import { DEMO_LINES, DEMO_REPLIES, DEMO_ROOT, DEMO_TAG } from "../../site/demo/lines";

const ROOT = resolve(import.meta.dir, "..", "..");
const scratch = mkdtempSync(join(tmpdir(), "kitespan-demo-bundle-"));
const APP = join(scratch, "app");
const SITE = join(scratch, "site");

/**
 * The demo's own words and marks: none may be in the app's bundle. The kinds of the port's messages (site/demo/port.ts)
 * stand for the stand-in's code: string literals, so a minified build keeps them, where it renames classes and functions.
 */
const NEEDLES = [...Object.values(DEMO_LINES), ...Object.values(DEMO_REPLIES), DEMO_TAG, DEMO_ROOT, '"ws-open"', '"ws-message"', '"http-reply"'];

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

const textOf = (files: string[]) => files.filter((f) => /\.(js|css|html|json|webmanifest)$/.test(f)).map((f) => readFileSync(f, "utf8"));

let appFiles: string[] = [];
let siteFiles: string[] = [];
let built: string[] = [];

beforeAll(async () => {
  // The app exactly as `bun run build` makes it.
  const proc = Bun.spawn([process.execPath, "--no-env-file", join(ROOT, "scripts", "build-web.ts"), "--out", APP], { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: scratch, TMPDIR: tmpdir() } });
  const [, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`build-web failed (exit ${code}): ${err.slice(-2000)}`);
  appFiles = filesUnder(APP);
  // The site's two builds of the demo: the frame (buildDemo) and the stand-in server, as the landing page bundles it.
  built = (await buildDemo({ out: SITE })).files;
  const server = await Bun.build({ entrypoints: [join(ROOT, "site", "demo", "server.ts")], outdir: join(SITE, "server"), target: "browser", minify: true });
  if (!server.success) throw new Error(server.logs.map(String).join("\n"));
  siteFiles = filesUnder(SITE);
}, 180_000);

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("the app's own bundle", () => {
  test("is a real build: the page, its chunks and the home-screen files", () => {
    const names = appFiles.map((f) => f.slice(APP.length + 1));
    expect(names).toContain("index.html");
    expect(names).toContain("sw.js");
    expect(names.some((n) => n.endsWith(".js") && n !== "sw.js")).toBe(true);
  });

  test("holds none of the demo's lines, replies, tag, folders or port messages", () => {
    const texts = textOf(appFiles);
    for (const n of NEEDLES) expect({ needle: n, found: texts.some((t) => t.includes(n)) }).toEqual({ needle: n, found: false });
  });
});

describe("the site's builds of the demo", () => {
  test("hold each of those needles, so the check above can fail", () => {
    const texts = textOf(siteFiles);
    for (const n of NEEDLES) expect({ needle: n, found: texts.some((t) => t.includes(n)) }).toEqual({ needle: n, found: true });
    // The frame's own build holds the port's messages too, not only the landing page's server.
    const frame = textOf(siteFiles.filter((f) => f.startsWith(join(SITE, "demo") + "/")));
    for (const n of ['"ws-open"', '"http-reply"']) expect({ needle: n, found: frame.some((t) => t.includes(n)) }).toEqual({ needle: n, found: true });
  });

  test("the frame is the app's page with the stand-in first and the demo's Notifications line", () => {
    expect(built).toContain("demo/index.html");
    const page = readFileSync(join(SITE, "demo", "index.html"), "utf8");
    const scripts = [...page.matchAll(/<script type="module"[^>]*src="([^"]+)"/g)].map((m) => m[1]!);
    expect(scripts.length).toBe(1);
    // Relative to the frame's own folder: the chunks load from demo/ under any base path.
    expect(scripts[0]).toMatch(/^\.\/chunk-[a-z0-9]+\.js$/);
    const entry = readFileSync(join(SITE, "demo", scripts[0]!), "utf8");
    expect(entry).toContain(DEMO_LINES.notifications);
    // The shim's work comes before the store's module code in the bundle (ES module order).
    const shim = entry.indexOf(DEMO_TAG);
    const store = entry.indexOf('"kitespan.settings"', shim + 1);
    expect(shim).toBeGreaterThan(0);
    expect(store).toBeGreaterThan(shim);
    // None of build-web.ts's later steps: the demo is no home-screen app.
    for (const f of ["manifest.webmanifest", "sw.js", "build.json"]) expect(built).not.toContain(`demo/${f}`);
  });

  test("its CSP is right after <meta charset>, with no network and no inline script", () => {
    const page = readFileSync(join(SITE, "demo", "index.html"), "utf8");
    const m = /<meta\s+charset="utf-8"\s*\/?><meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(page);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(demoCsp());
    expect(m![1]).toContain("connect-src 'none'");
    expect(m![1]).toContain("script-src 'self';");
  });

  test("the page holds web/index.html's markup only: not its storage and look script, not its comments", () => {
    // That script moves the old name's keys of the origin's real storage and reads the look from it before the shim
    // runs; in the frame the storage is the shim's own, so it would do nothing but publish its words.
    const page = readFileSync(join(SITE, "demo", "index.html"), "utf8");
    expect(inlineScripts(readFileSync(join(ROOT, "web", "index.html"), "utf8")).length).toBe(1);
    expect(inlineScripts(page)).toEqual([]);
    expect(page).not.toContain("<!--");
    expect(page).toContain('<div id="root"></div>');
    expect(page).toContain('<link rel="icon" href="data:image/svg+xml,');
  });

  test("each swap's importers name the swapped module by a relative path, as the plugin resolves it", () => {
    expect(DEMO_SWAPS.map((s) => s.file)).toEqual(["web/notify/words.ts", "web/panels/download.ts", "shared/update.ts"]);
    for (const s of DEMO_SWAPS) {
      const name = s.file.split("/").pop()!.replace(/\.ts$/, "");
      for (const f of s.importers) {
        const specs = [...readFileSync(join(ROOT, f), "utf8").matchAll(/from "(\.{1,2}\/[^"]+)"/g)].map((m) => m[1]!).filter((spec) => resolve(dirname(join(ROOT, f)), `${spec}.ts`) === join(ROOT, s.file));
        expect({ f, name, found: specs.length > 0 }).toEqual({ f, name, found: true });
      }
    }
  });
});

describe("the boundaries", () => {
  const sources = (dir: string) => filesUnder(join(ROOT, dir)).filter((f) => /\.(ts|tsx|html|css)$/.test(f));
  /** A module's import specifiers: `from "..."`, a bare `import "..."` and `import("...")`. */
  const imports = (text: string) => [...text.matchAll(/\bfrom\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1] ?? m[2] ?? m[3]!);

  test("no file of web/ imports site/", () => {
    const bad: string[] = [];
    for (const f of sources("web")) for (const spec of imports(readFileSync(f, "utf8"))) if (resolve(dirname(f), spec).startsWith(join(ROOT, "site"))) bad.push(`${f.slice(ROOT.length + 1)}: ${spec}`);
    expect(bad).toEqual([]);
  });

  test("site/demo/shim.ts imports only the demo's own modules and shared/", () => {
    const f = join(ROOT, "site", "demo", "shim.ts");
    const specs = imports(readFileSync(f, "utf8"));
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) {
      const target = resolve(dirname(f), spec);
      expect({ spec, ok: target.startsWith(join(ROOT, "site", "demo")) || target.startsWith(join(ROOT, "shared")) }).toEqual({ spec, ok: true });
    }
    // And so do the modules it imports.
    for (const dep of ["lines.ts", "port.ts"]) for (const spec of imports(readFileSync(join(ROOT, "site", "demo", dep), "utf8"))) expect(spec.startsWith("./") || spec.startsWith("../../shared/")).toBe(true);
  });
});
