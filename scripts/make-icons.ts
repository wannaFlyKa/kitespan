// Make the home-screen icons (shared/home-screen.ts APP_ICONS) from their SVG sources in web/icons/, with the headless
// Chrome that the click-through uses (scripts/lib/chrome.ts). Each SVG is drawn as an image of the icon's size, at
// device scale 1, over a transparent ground, and Chrome's own PNG of exactly that box is the icon. The PNGs are kept
// in git beside the SVG, so the build (scripts/build-web.ts) needs no browser; run this after a change to an SVG.
// Beside them it writes sources.json (scripts/lib/icon-sources.ts): each PNG with the SHA-256 of the SVG it was made
// from and its own, which bun test checks with no browser, so an SVG changed without a new render fails a test.
// With --check it writes nothing and exits 1 when a kept PNG differs from a fresh render (two renders with the same
// Chrome give the same bytes) or sources.json is not the one this run would write.
//
// Usage: bun scripts/make-icons.ts [--check] [--out <folder>] [--chrome <binary>] [--port <port>]
//   --out     where the PNGs go (default web/icons, beside the SVG)
//   --chrome  the Chrome for Testing to start (default: as the click-through finds one)
//   --port    the DevTools port for that Chrome (default: a free port from 9341 to 9349)

import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { APP_ICONS, type AppIcon } from "../shared/home-screen";
import { Cdp } from "./lib/cdp";
import { findChrome, freePort, launchChrome } from "./lib/chrome";
import { SOURCES_FILE, sha256, sourcesText, type IconSources } from "./lib/icon-sources";

const ROOT = resolve(import.meta.dir, "..");
const ICONS = join(ROOT, "web", "icons");

function option(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  if (!v || v.startsWith("--")) fail(`${name} needs a value`);
  return v;
}

function fail(line: string): never {
  console.error(`make-icons: ${line}`);
  process.exit(2);
}

const check = process.argv.includes("--check");
const outArg = option("--out");
const out = outArg ? (isAbsolute(outArg) ? outArg : resolve(outArg)) : ICONS;
const binary = option("--chrome") ?? findChrome();
if (!binary) fail("no Chrome for Testing found; pass --chrome <binary> or set CHROME_PATH");
const portArg = option("--port");
const port = portArg ? Number(portArg) : freePort(9341, 9349);
if (!port || !Number.isInteger(port) || port < 1024 || port > 65535) fail(portArg ? `--port ${portArg} is not a port` : "no free port from 9341 to 9349 for Chrome");

/** A page that holds only the icon's image, at its exact size in the top left corner. */
function page(icon: AppIcon): string {
  const svg = readFileSync(join(ICONS, icon.source));
  const src = `data:image/svg+xml;base64,${svg.toString("base64")}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}img{display:block}</style></head><body><img src="${src}" width="${icon.size}" height="${icon.size}" alt=""></body></html>`;
  return `data:text/html;base64,${Buffer.from(html).toString("base64")}`;
}

const chrome = await launchChrome(binary, port).catch((e: Error) => fail(`could not start ${binary}: ${e.message}`));
let differ = 0;
const record: IconSources = {};
try {
  const cdp = await Cdp.connect(chrome.wsUrl);
  const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  for (const icon of APP_ICONS) {
    const n = icon.size;
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: n, height: n, deviceScaleFactor: 1, mobile: false }, sessionId);
    await cdp.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } }, sessionId);
    const load = cdp.expect("Page.loadEventFired", { sessionId });
    await cdp.send("Page.navigate", { url: page(icon) }, sessionId);
    await load.promise;
    await cdp.send("Runtime.evaluate", { expression: "Promise.all([...document.images].map((i) => i.decode()))", awaitPromise: true }, sessionId);
    const shot = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: n, height: n, scale: 1 }, captureBeyondViewport: false }, sessionId);
    const png = Buffer.from(shot.data, "base64");
    const file = join(out, icon.file);
    record[icon.file] = { source: icon.source, svg: sha256(readFileSync(join(ICONS, icon.source))), png: sha256(png) };
    if (check) {
      let kept: Buffer | null = null;
      try {
        kept = readFileSync(file);
      } catch {}
      const same = kept !== null && kept.equals(png);
      if (!same) differ++;
      console.log(`${icon.file}  ${same ? "same" : kept ? "differs from a fresh render" : "missing"}`);
    } else {
      writeFileSync(file, png);
      console.log(`${icon.file}  ${n} x ${n}  ${png.length} B  (from ${icon.source})`);
    }
  }
  cdp.close();
} finally {
  await chrome.stop();
}
const recordFile = join(out, SOURCES_FILE);
if (check) {
  let kept: string | null = null;
  try {
    kept = readFileSync(recordFile, "utf8");
  } catch {}
  const same = kept === sourcesText(record);
  if (!same) differ++;
  console.log(`${SOURCES_FILE}  ${same ? "same" : kept === null ? "missing" : "differs from this render's"}`);
} else {
  writeFileSync(recordFile, sourcesText(record));
  console.log(`${SOURCES_FILE}  the SHA-256 of each PNG and of its SVG`);
}
if (check && differ) {
  console.error(`make-icons: ${differ} file${differ > 1 ? "s differ" : " differs"}; run bun scripts/make-icons.ts to make them again`);
  process.exit(1);
}
