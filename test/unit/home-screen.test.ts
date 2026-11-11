// The home-screen app (FIX-U6; owner rows 112 and 113): the icons kept in web/icons/ (the SVG source and the PNGs that
// scripts/make-icons.ts makes from it, with its record of both, sources.json), the web app manifest, how the server
// serves both as the page's own files and lets the browser's manifest fetch through its guards, and the build that
// puts them and the two head links in dist.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { APP_ICONS, MANIFEST_FILE, MANIFEST_TYPE, MASKABLE_SAFE_RADIUS, appManifest, homeScreenLinks } from "../../shared/home-screen";
import { createGate } from "../../server/gate/guards";
import { createApp, type App, type Upgrader } from "../../server/http/app";
import { ASSET_PREFIX, HASHED_NAME, loadSite, type Site } from "../../server/http/static";
import { readPng } from "./png";
import { SOURCES_FILE, staleIcons, type IconSources } from "../../scripts/lib/icon-sources";

const ROOT = resolve(import.meta.dir, "..", "..");
const ICONS = join(ROOT, "web", "icons");
const TILE: [number, number, number] = [0x1d, 0x1d, 0x1f];
const isTile = ([r, g, b, a]: number[]) => r === TILE[0] && g === TILE[1] && b === TILE[2] && a === 255;
const dir = mkdtempSync(join(tmpdir(), "kitespan-home-screen-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the icons (web/icons/)", () => {
  const svg = (name: string) => readFileSync(join(ICONS, name), "utf8");

  test("the SVG sources are the tab's mark on a 512 grid: the graphite tile and the white chevron, round caps and joins", () => {
    for (const name of ["mark-any.svg", "mark-full.svg"]) {
      const s = svg(name);
      expect(s).toContain('viewBox="0 0 512 512"');
      expect(s).toContain('fill="#1d1d1f"');
      expect(s).toContain('<path d="M140 340.25 L256 151.75 L372 340.25" fill="none" stroke="#ffffff" stroke-width="52" stroke-linecap="round" stroke-linejoin="round"/>');
    }
    // The rounded tile for the "any" icons (the tab's 25% corner); the full-bleed one is masked by the platform.
    expect(svg("mark-any.svg")).toContain('<rect width="512" height="512" rx="128" fill="#1d1d1f"/>');
    expect(svg("mark-full.svg")).toContain('<rect width="512" height="512" fill="#1d1d1f"/>');
    // The same colours as the tab icon on a light device (web/index.html).
    const tab = /<link rel="icon" href="([^"]+)"/.exec(readFileSync(join(ROOT, "web", "index.html"), "utf8"))![1]!;
    expect(decodeURIComponent(tab)).toContain("rect{fill:#1d1d1f}path{stroke:#ffffff}");
  });

  test("each icon is a PNG of its size; the 'any' icons are clear outside the rounded tile, the others opaque to the edge", () => {
    expect(APP_ICONS.map((i) => [i.file, i.size, i.source, i.purpose])).toEqual([
      ["icon-192.png", 192, "mark-any.svg", "any"],
      ["icon-512.png", 512, "mark-any.svg", "any"],
      ["icon-maskable-512.png", 512, "mark-full.svg", "maskable"],
      ["apple-touch-icon.png", 180, "mark-full.svg", null],
    ]);
    for (const icon of APP_ICONS) {
      const png = readPng(readFileSync(join(ICONS, icon.file)));
      const n = icon.size;
      expect([icon.file, png.width, png.height]).toEqual([icon.file, n, n]);
      const corners = [png.at(0, 0), png.at(n - 1, 0), png.at(0, n - 1), png.at(n - 1, n - 1)];
      // The tile shows between the chevron's legs, and the chevron's apex is white.
      expect(isTile(png.at(Math.round(n / 2), Math.round(n * 0.78)))).toBe(true);
      expect(png.at(Math.round(n / 2), Math.round((n * 160) / 512))).toEqual([255, 255, 255, 255]);
      if (icon.source === "mark-any.svg") {
        expect(png.colorType).toBe(6);
        for (const c of corners) expect(c[3]).toBe(0);
      } else {
        for (const c of corners) expect(isTile(c)).toBe(true);
        let clear = 0;
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (png.at(x, y)[3] !== 255) clear++;
        expect([icon.file, clear]).toEqual([icon.file, 0]);
      }
    }
  });

  test("each kept PNG was made from its SVG as it is now: web/icons/sources.json, which scripts/make-icons.ts writes", () => {
    const record = JSON.parse(readFileSync(join(ICONS, SOURCES_FILE), "utf8")) as IconSources;
    expect(Object.keys(record)).toEqual(APP_ICONS.map((i) => i.file));
    for (const i of APP_ICONS) expect([i.file, record[i.file]!.source]).toEqual([i.file, i.source]);
    const stale = staleIcons(ICONS);
    expect(stale.length ? `run bun scripts/make-icons.ts (${stale.join("; ")})` : "").toBe("");
  });

  test("an SVG changed without a new render, or a PNG put in by hand, is found (no Chrome needed)", () => {
    const copy = join(dir, "icons-copy");
    cpSync(ICONS, copy, { recursive: true });
    expect(staleIcons(copy)).toEqual([]);
    // The stroke made heavier in the rounded tile's source only: its two PNGs are stale, the others are not.
    const any = join(copy, "mark-any.svg");
    writeFileSync(any, readFileSync(any, "utf8").replace('stroke-width="52"', 'stroke-width="60"'));
    expect(staleIcons(copy)).toEqual(["icon-192.png: mark-any.svg changed after it was made", "icon-512.png: mark-any.svg changed after it was made"]);
    writeFileSync(any, readFileSync(join(ICONS, "mark-any.svg")));
    writeFileSync(join(copy, "apple-touch-icon.png"), readFileSync(join(ICONS, "icon-192.png")));
    expect(staleIcons(copy)).toEqual(["apple-touch-icon.png: not the PNG that was made"]);
    rmSync(join(copy, SOURCES_FILE));
    expect(staleIcons(copy)).toEqual([`no ${SOURCES_FILE}`]);
  });

  test("the maskable icon keeps the whole chevron inside its safe zone, a centred circle of 40% of the width", () => {
    const icon = APP_ICONS.find((i) => i.purpose === "maskable")!;
    const png = readPng(readFileSync(join(ICONS, icon.file)));
    const c = icon.size / 2;
    let far = 0;
    for (let y = 0; y < icon.size; y++)
      for (let x = 0; x < icon.size; x++) if (!isTile(png.at(x, y))) far = Math.max(far, Math.hypot(x + 0.5 - c, y + 0.5 - c));
    expect(far).toBeGreaterThan(icon.size * 0.25); // the chevron is there
    expect(far).toBeLessThanOrEqual(icon.size * MASKABLE_SAFE_RADIUS);
  });
});

describe("the web app manifest", () => {
  test("the page's name, / as its id, start and scope, standalone, the default look's colours and the three icons", () => {
    expect(appManifest("kitespan")).toEqual({
      id: "/",
      name: "kitespan",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#ffffff",
      theme_color: "#ffffff",
      icons: [
        { src: "/assets/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/assets/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        { src: "/assets/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
    });
    expect(appManifest("kitespan").name).toBe("kitespan");
  });

  test("the head's two links: the manifest, and the 180 px icon iOS takes over the manifest's; every name is under /assets/", () => {
    expect(homeScreenLinks()).toBe('<link rel="manifest" href="/assets/manifest.webmanifest" crossorigin="use-credentials"><link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">');
    const named = [...homeScreenLinks().matchAll(/href="([^"]+)"/g), ...JSON.stringify(appManifest("x")).matchAll(/"src":"([^"]+)"/g)].map((m) => m[1]!);
    for (const href of named) expect(href.startsWith(ASSET_PREFIX)).toBe(true);
    // A stable name, never taken for a hashed one: the server revalidates it rather than keep it for a year.
    for (const name of [MANIFEST_FILE, ...APP_ICONS.map((i) => i.file)]) expect([name, HASHED_NAME.test(name)]).toEqual([name, false]);
  });
});

describe("served like the page", () => {
  const PORT = 7942;
  const OWN = `http://127.0.0.1:${PORT}`;
  const MANIFEST = JSON.stringify(appManifest("kitespan"));
  const gate = createGate(PORT, []);
  const noServer: Upgrader = { upgrade: () => false };
  let site: Site;
  let app: App;
  beforeAll(() => {
    const dist = join(dir, "dist");
    mkdirSync(dist);
    writeFileSync(join(dist, "index.html"), `<!doctype html><html><head>${homeScreenLinks()}</head><body></body></html>`);
    writeFileSync(join(dist, MANIFEST_FILE), MANIFEST);
    for (const i of APP_ICONS) writeFileSync(join(dist, i.file), readFileSync(join(ICONS, i.file)));
    site = loadSite(dist, gate.origins);
    app = createApp({ gate, site, api: { handle: async () => new Response("api", { status: 500 }) }, sockets: {} });
  });
  const get = (path: string, headers: Record<string, string> = {}) => app.fetch(new Request(OWN + path, { headers: { host: `127.0.0.1:${PORT}`, ...headers } }), noServer).then((r) => r!);

  test("the manifest goes out as application/manifest+json (gzipped when the browser takes it); each icon as image/png; all revalidated", async () => {
    const plain = await get(`/assets/${MANIFEST_FILE}`);
    expect(plain.status).toBe(200);
    expect(plain.headers.get("content-type")).toBe(MANIFEST_TYPE);
    expect(plain.headers.get("cache-control")).toBe("no-cache");
    expect(await plain.text()).toBe(MANIFEST);
    const gz = await get(`/assets/${MANIFEST_FILE}`, { "accept-encoding": "gzip" });
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await gz.arrayBuffer())))).toBe(MANIFEST);
    for (const i of APP_ICONS) {
      const res = await get(`/assets/${i.file}`, { "accept-encoding": "gzip" });
      expect([i.file, res.status, res.headers.get("content-type"), res.headers.get("cache-control"), res.headers.get("content-encoding")]).toEqual([i.file, 200, "image/png", "no-cache", null]);
      expect(Buffer.from(await res.arrayBuffer()).equals(readFileSync(join(ICONS, i.file)))).toBe(true);
      expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    }
  });

  test("the browser's manifest fetch passes the guards: no cookie, a CORS-mode GET with or without its own Origin", async () => {
    const chromeFetch = { "sec-fetch-dest": "manifest", "sec-fetch-mode": "cors", "sec-fetch-site": "same-origin", accept: "*/*" };
    expect((await get(`/assets/${MANIFEST_FILE}`, chromeFetch)).status).toBe(200);
    expect((await get(`/assets/${MANIFEST_FILE}`, { ...chromeFetch, origin: OWN })).status).toBe(200);
    // The policy has no manifest-src, so default-src 'self' covers the manifest.
    expect(site.safe.csp).not.toContain("manifest-src");
    expect(site.safe.csp).toContain("default-src 'self'");
    // The Host guard still holds for these files.
    expect((await get(`/assets/${MANIFEST_FILE}`, { host: `rebind.example:${PORT}` })).status).toBe(403);
  });
});

describe("the build (scripts/build-web.ts)", () => {
  test(
    "puts the manifest named by the page's title, the four icons as they are kept, and the two links in the built page's head",
    () => {
      const out = join(dir, "built");
      const r = spawnSync(process.execPath, [join(ROOT, "scripts", "build-web.ts"), "--out", out], { cwd: ROOT, env: { PATH: `${resolve(process.execPath, "..")}:/usr/bin:/bin`, HOME: dir }, encoding: "utf8" });
      expect(r.status).toBe(0);
      const html = readFileSync(join(out, "index.html"), "utf8");
      const title = /<title>([^<]+)<\/title>/.exec(html)![1]!;
      expect(title).toBe("kitespan");
      expect(JSON.parse(readFileSync(join(out, MANIFEST_FILE), "utf8"))).toEqual(appManifest(title));
      for (const i of APP_ICONS) expect([i.file, readFileSync(join(out, i.file)).equals(readFileSync(join(ICONS, i.file)))]).toEqual([i.file, true]);
      const head = html.slice(0, html.indexOf("</head>"));
      expect(head).toContain(homeScreenLinks());
      expect(html.split(homeScreenLinks()).length).toBe(2);
      expect(head).toContain('<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)"');
      expect(head).toContain('<meta name="theme-color" content="#1c1c1e" media="(prefers-color-scheme: dark)"');
      expect(existsSync(join(out, "mark-any.svg"))).toBe(false);
    },
    60_000,
  );
});
