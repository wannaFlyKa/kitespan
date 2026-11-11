// The built page in memory (DESIGN.md 4.10; L19): the server reads every built file when it starts, as it reads the
// page, so a build under the running server (bin/update.sh: scripts/build-web.ts empties the folder and writes files
// with new hashed names) never takes away what this server's page asks for. A reload still gets its script, and an
// open page still gets the Terminal pane's lazy chunk.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMMUTABLE, loadSite } from "../../server/http/static";

const dir = mkdtempSync(join(tmpdir(), "kitespan-static-"));
const PAGE =
  `<!doctype html><html><head><link rel="stylesheet" href="/assets/index-fs0q8gwg.css"></head>` +
  `<body><script type="module" src="/assets/index-0ba8jk69.js"></script></body></html>`;
/** The page's script, its lazy xterm chunk, its style sheet and a file with no hash in its name. */
const FILES: Record<string, string> = {
  "index-0ba8jk69.js": 'const pane = () => import("./chunk-a10jenkc.js");\n'.repeat(80),
  "chunk-a10jenkc.js": "export const terminal = 1;\n".repeat(120),
  "index-fs0q8gwg.css": "body{margin:0}",
  "logo.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>",
};

/** A fresh build folder with the page and FILES. */
function build(name: string): string {
  const dist = join(dir, name);
  mkdirSync(dist);
  writeFileSync(join(dist, "index.html"), PAGE);
  for (const [file, text] of Object.entries(FILES)) writeFileSync(join(dist, file), text);
  return dist;
}

/** What scripts/build-web.ts does first: every file of the folder goes. */
function empty(dist: string): void {
  for (const name of readdirSync(dist)) unlinkSync(join(dist, name));
}

const get = (name: string, encoding?: string) =>
  new Request(`http://127.0.0.1:7941/assets/${name}`, { headers: encoding ? { "accept-encoding": encoding } : {} });

afterAll(() => {
  for (const sub of readdirSync(dir)) {
    empty(join(dir, sub));
    rmdirSync(join(dir, sub));
  }
  rmdirSync(dir);
});

describe("the built files are read at start (L19)", () => {
  test("with the build folder emptied, the page, its script, the lazy chunk and the style sheet are served as they were", async () => {
    const dist = build("emptied");
    const site = loadSite(dist, []);
    empty(dist);
    expect(readdirSync(dist)).toEqual([]);
    for (const [name, text] of Object.entries(FILES)) {
      const res = site.asset(get(name), name);
      expect(res?.status).toBe(200);
      expect(await res!.text()).toBe(text);
    }
    expect(site.asset(get("index-0ba8jk69.js"), "index-0ba8jk69.js")!.headers.get("cache-control")).toBe(IMMUTABLE);
    expect(site.asset(get("logo.svg"), "logo.svg")!.headers.get("cache-control")).toBe("no-cache");
    const page = site.shell(new Request("http://127.0.0.1:7941/c/k3m7q2x4abk3m7q2x4ab"));
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(PAGE);
  });

  test("gzip still works from memory, and only when the browser accepts it", async () => {
    const dist = build("gzip");
    const site = loadSite(dist, []);
    empty(dist);
    const name = "chunk-a10jenkc.js";
    for (let i = 0; i < 2; i++) {
      const gz = site.asset(get(name, "gzip, br"), name)!;
      expect(gz.headers.get("content-encoding")).toBe("gzip");
      expect(gz.headers.get("vary")).toBe("accept-encoding");
      const body = new Uint8Array(await gz.arrayBuffer());
      expect(body.length).toBeLessThan(FILES[name]!.length);
      expect(new TextDecoder().decode(Bun.gunzipSync(body))).toBe(FILES[name]!);
    }
    const plain = site.asset(get(name, "identity"), name)!;
    expect(plain.headers.get("content-encoding")).toBe(null);
    expect(await plain.text()).toBe(FILES[name]!);
  });

  test("a later build's files are not this server's: a new name is not served, and a changed file is served as it was", async () => {
    const dist = build("later");
    const site = loadSite(dist, []);
    empty(dist);
    writeFileSync(join(dist, "index-zz99yy88.js"), "the next build");
    writeFileSync(join(dist, "logo.svg"), "<svg>changed</svg>");
    expect(site.asset(get("index-zz99yy88.js"), "index-zz99yy88.js")).toBe(null);
    expect(await site.asset(get("logo.svg"), "logo.svg")!.text()).toBe(FILES["logo.svg"]!);
  });

  test("the names that were never served stay unserved: the page itself, a .gz name, a dot file", () => {
    const dist = build("names");
    writeFileSync(join(dist, ".hidden"), "x");
    writeFileSync(join(dist, "index-0ba8jk69.js.gz"), "x");
    const site = loadSite(dist, []);
    for (const name of ["index.html", ".hidden", "index-0ba8jk69.js.gz", "missing-0ba8jk69.js", "../index.html"]) expect(site.asset(get(name), name)).toBe(null);
  });
});
