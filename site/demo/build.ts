// The demo frame's build (DESIGN-W1 4.2): kitespan's own page, web/index.html and everything it imports, built a
// second time for the site, into <out>/demo/. Only this build swaps modules, with a Bun plugin:
//
// - the entry: web/index.html's `./main.tsx` resolves to site/demo/frame.tsx, which puts in the stand-in (shim.ts),
//   then imports web/main.tsx unchanged, then the bridge;
// - three modules of the app, each for one in site/demo/swap/ that re-exports it with the demo's part (DEMO_SWAPS):
//   Settings > Notifications' words, whose `unsupported` line says the demo's; the downloads, which answer with the
//   demo's line; and the update words, whose refusal for the demo's Check now says the demo's line. The importers name
//   each by a relative path ("./words", "../notify/words", "../../shared/update", ...), so the plugin works out each
//   relative import's target itself.
//
// A swap that did not hit (a renamed file) fails the build. No file of web/ changes, and the app's own build
// (scripts/build-web.ts) has no plugin: test/unit/demo-bundle.test.ts proves that its bundle holds nothing of the demo.
// No publicPath: the page names its chunks ./chunk-*.js and the lazy chunk is imported relative to its module, so both
// hold after the frame moves its URL (shim.ts). After the build, the page keeps web/index.html's markup only: its inline
// script (the old name's storage keys moved, and the stored look applied before the first paint) and its comments go,
// because that script reads and moves the origin's real storage before the shim runs, while the frame's storage is the
// shim's own, in memory; so in the frame it would do nothing but publish its words. Then the Content-Security-Policy
// goes in the page's head, with no inline script allowed. None of build-web.ts's steps after its build run here: the
// demo is no home-screen app (no manifest, no icons, no service worker).

import type { BunPlugin } from "bun";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
export const WEB_INDEX = join(ROOT, "web", "index.html");
export const FRAME_ENTRY = join(ROOT, "site", "demo", "frame.tsx");

/** A module of the app that the demo's build swaps, the module it becomes, and the files that import it (each must hit). */
export interface DemoSwap {
  file: string;
  swap: string;
  importers: readonly string[];
}

/** The modules swapped in the demo's build only (paths from the repository's root). */
export const DEMO_SWAPS: readonly DemoSwap[] = [
  { file: "web/notify/words.ts", swap: "site/demo/swap/notify-words.ts", importers: ["web/notify/gate.ts", "web/notify/device.ts", "web/screens/Settings.tsx", "web/settings/Notifications.tsx"] },
  {
    file: "web/panels/download.ts",
    swap: "site/demo/swap/download.ts",
    importers: ["web/chat/items/Files.tsx", "web/panels/cards.tsx", "web/panels/details.tsx", "web/panels/file.tsx", "web/panels/parts.tsx", "web/panels/uploads.tsx"],
  },
  { file: "shared/update.ts", swap: "site/demo/swap/update-words.ts", importers: ["web/screens/Settings.tsx", "web/settings/about.tsx", "web/update/UpdateDialog.tsx", "web/update/state.ts"] },
];

/** A relative import's last part, for the plugin's filter: words, download or update, with or without .ts. */
const SWAP_FILTER = new RegExp(`(^|/)(${DEMO_SWAPS.map((s) => s.file.split("/").pop()!.replace(/\.ts$/, "")).join("|")})(\.ts)?$`);

/** The demo page's Content-Security-Policy (DESIGN-W1 5.2): nothing from another origin, no inline script, no network. */
export function demoCsp(): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/** The inline scripts of a page (a `<script>` with no src), their text as the browser hashes it. */
export function inlineScripts(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) if (!/\bsrc\s*=/i.test(m[1]!)) out.push(m[2]!);
  return out;
}

/**
 * The built page as the demo serves it: without web/index.html's inline script (exactly one, else the page changed and
 * this must be looked at again) and its comments, with the CSP meta right after its `<meta charset>`, so it holds
 * before any script.
 */
export function demoPage(html: string): string {
  const scripts = inlineScripts(html);
  if (scripts.length !== 1) throw new Error(`the demo page has ${scripts.length} inline scripts, not web/index.html's one`);
  const page = html
    .replace(/<script\b(?![^>]*\bsrc\s*=)[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n(?:[ \t]*\n)+/g, "\n");
  if (inlineScripts(page).length || page.includes("<!--")) throw new Error("the demo page still holds an inline script or a comment");
  const charset = /<meta\s+charset\s*=\s*["']?utf-8["']?\s*\/?>/i.exec(page);
  if (!charset) throw new Error("the demo page has no <meta charset>, where its CSP goes");
  const meta = `<meta http-equiv="Content-Security-Policy" content="${demoCsp()}">`;
  const at = charset.index + charset[0].length;
  return page.slice(0, at) + meta + page.slice(at);
}

/** The plugin's swaps, with the entry's hits and, per swapped file, the importers that hit. */
export function demoPlugin(hits: { entry: number; swaps: Map<string, Set<string>> }): BunPlugin {
  return {
    name: "kitespan-demo",
    setup(b) {
      b.onResolve({ filter: /^\.\/main\.tsx$/ }, (a) => {
        if (a.importer !== WEB_INDEX) return undefined;
        hits.entry++;
        return { path: FRAME_ENTRY };
      });
      b.onResolve({ filter: SWAP_FILTER }, (a) => {
        if (!a.path.startsWith(".")) return undefined;
        const target = relative(ROOT, resolve(dirname(a.importer), a.path.endsWith(".ts") ? a.path : `${a.path}.ts`));
        const swap = DEMO_SWAPS.find((s) => s.file === target);
        // The swap module's own imports of the app's module stay the app's.
        if (!swap || a.importer === join(ROOT, swap.swap)) return undefined;
        const set = hits.swaps.get(swap.file) ?? new Set<string>();
        set.add(relative(ROOT, a.importer));
        hits.swaps.set(swap.file, set);
        return { path: join(ROOT, swap.swap) };
      });
    },
  };
}

function filesUnder(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p, base));
    else out.push(relative(base, p));
  }
  return out;
}

/**
 * Build the demo frame into `<out>/demo/`. Resolves with the files written (relative to `out`); throws when the
 * build fails or a swap did not hit.
 */
export async function buildDemo(opts: { out: string }): Promise<{ files: string[] }> {
  const dir = join(opts.out, "demo");
  const hits = { entry: 0, swaps: new Map<string, Set<string>>() };
  const result = await Bun.build({
    entrypoints: [WEB_INDEX],
    outdir: dir,
    target: "browser",
    minify: true,
    splitting: true,
    sourcemap: "none",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [demoPlugin(hits)],
  });
  if (!result.success) throw new Error(`the demo build failed:\n${result.logs.map(String).join("\n")}`);
  if (hits.entry !== 1) throw new Error(`the demo build swapped web/index.html's entry ${hits.entry} times, not once`);
  for (const s of DEMO_SWAPS) {
    const missed = s.importers.filter((f) => !hits.swaps.get(s.file)?.has(f));
    if (missed.length) throw new Error(`the demo build did not swap ${s.file} for ${missed.join(", ")}`);
  }
  const page = join(dir, "index.html");
  if (!existsSync(page)) throw new Error(`the demo build wrote no ${page}`);
  writeFileSync(page, demoPage(readFileSync(page, "utf8")));
  return { files: filesUnder(dir).map((f) => join("demo", f)) };
}
