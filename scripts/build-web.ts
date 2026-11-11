// Build the page ahead of time (DESIGN.md 4.6 "Serving"): web/index.html and everything it imports, as production
// React, into one flat folder (dist/web by default) that the server's static layer serves (server/http/static.ts):
// the page itself at every app route, and each built file at /assets/<name>, so the page points at /assets/. A
// dynamic import gets its own chunk (xterm loads only when a Terminal pane opens). The server gzips each text file
// itself when the browser accepts it, so no .gz copy is written; the sizes are printed for the record. Last, the build
// stamp: build.json with the checkout's HEAD that was built (null outside a git checkout), which Settings > About
// reads for "Restart to apply" and the restart's preflight checks (DESIGN.md 4.10). Before it, the home-screen app
// (FIX-U6): the web app manifest, named by the built page's title, and the icons kept in web/icons/ (made from their
// SVG by scripts/make-icons.ts) under stable names, because the manifest names them and Bun does not rewrite a
// manifest's contents; then the manifest's link and iOS's apple-touch-icon link at the end of the page's head. R130:
// the service worker (web/sw.ts, push and notificationclick only) as one classic script, sw.js, which the server
// serves at /sw.js.
//
// Usage: bun scripts/build-web.ts [--out <folder>]

import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { gitHead, gitOptions } from "../server/update/git";
import { BUILD_STAMP, stampText } from "../server/update/stamp";
import { APP_ICONS, MANIFEST_FILE, appManifest, homeScreenLinks } from "../shared/home-screen";
import { SERVICE_WORKER_FILE } from "../shared/push";
import { buildWorker } from "../server/http/worker";

const ROOT = resolve(import.meta.dir, "..");
const outArg = process.argv.indexOf("--out");
const given = outArg > 0 ? process.argv[outArg + 1] : undefined;
const out = given ? (isAbsolute(given) ? given : resolve(given)) : join(ROOT, "dist", "web");

// The folder is flat: clear its files from an earlier build, and nothing else (never a folder, never a link's target).
mkdirSync(out, { recursive: true });
for (const name of readdirSync(out)) {
  const file = join(out, name);
  if (lstatSync(file).isFile()) unlinkSync(file);
}

const result = await Bun.build({
  entrypoints: [join(ROOT, "web", "index.html")],
  outdir: out,
  minify: true,
  publicPath: "/assets/",
  splitting: true,
  define: { "process.env.NODE_ENV": '"production"' },
  sourcemap: "none",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
if (!existsSync(join(out, "index.html"))) {
  console.error(`build-web: no index.html in ${out}`);
  process.exit(1);
}

const pageFile = join(out, "index.html");
const page = readFileSync(pageFile, "utf8");
const title = /<title>([^<&]*)<\/title>/.exec(page)?.[1]?.trim();
if (!title || !page.includes("</head>")) {
  console.error(`build-web: the built page needs a plain <title> (the web app manifest's name) and a </head> (where its link goes)`);
  process.exit(1);
}
writeFileSync(join(out, MANIFEST_FILE), JSON.stringify(appManifest(title)));
for (const icon of APP_ICONS) copyFileSync(join(ROOT, "web", "icons", icon.file), join(out, icon.file));
writeFileSync(pageFile, page.replace("</head>", `${homeScreenLinks()}</head>`));
writeFileSync(join(out, SERVICE_WORKER_FILE), await buildWorker(ROOT));
writeFileSync(join(out, BUILD_STAMP), stampText(await gitHead(ROOT, gitOptions(process.env))));

let total = 0;
let zipped = 0;
for (const name of readdirSync(out).sort()) {
  const file = join(out, name);
  if (!lstatSync(file).isFile()) continue;
  const body = readFileSync(file);
  const gz = /\.(js|css|html|svg|json|webmanifest)$/.test(name) ? Bun.gzipSync(body, { level: 9 }).length : body.length;
  total += body.length;
  zipped += gz;
  console.log(`${name}  ${body.length} B  (gzip ${gz} B)`);
}
console.log(`built ${out}: ${total} B, ${zipped} B gzipped`);
