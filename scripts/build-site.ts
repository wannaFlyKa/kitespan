// Build the landing page and its demo (DESIGN-W1 5.2), a static site for GitHub Pages, into one folder (dist/site by
// default, git-ignored): index.html (English) and zh-CN/index.html, cut from the two READMEs by site/render.ts; their
// script and stylesheet in assets/ (site/page.ts, site/site.css with kitespan's own tokens); and demo/, the app itself
// built with the demo's stand-in for the server (site/demo/build.ts). Every path is relative, so the same build works
// under any base path (the project page's /kitespan/, or a folder opened by hand). Before it writes, the folder must be
// absent, empty, or hold only what an earlier site build made (removed file by file, never a folder's other contents);
// after it, every page holds a Content-Security-Policy with no network call, no src, href, url() or import starts with
// a slash, and every outside link is on the list below.
//
// Usage: bun scripts/build-site.ts [--out <folder>]

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { buildDemo } from "../site/demo/build";
import { landingCsp, PAGE_FILE, REPO_URL, renderPage } from "../site/render";
import { THEME_SCRIPT } from "../site/theme";
import { LANGS } from "../site/words";

const ROOT = resolve(import.meta.dir, "..");

/** The outside links the site may hold, besides the repository and its files on GitHub (linkAllowed): Bun's install
 * page, and the Claude Agent SDK's terms (the READMEs' From source). */
export const OUTSIDE_LINKS = ["https://bun.com/docs/installation", "https://code.claude.com/docs/en/legal-and-compliance"];

/** Whether a file of the out folder (its path from the folder, with `/`) is one that a site build makes. */
export function siteMade(rel: string): boolean {
  return rel === "index.html" || rel === "zh-CN/index.html" || /^(assets|demo)\/[^/]/.test(rel);
}

/** Whether an https link may be on the site: the repository, its README, a file of it that exists, or a listed page. */
export function linkAllowed(href: string, root: string): boolean {
  if (href === REPO_URL || href === `${REPO_URL}#readme`) return true;
  const file = href.startsWith(`${REPO_URL}/blob/main/`) ? href.slice(`${REPO_URL}/blob/main/`.length) : null;
  if (file !== null) {
    if (!file || /[?#]/.test(file) || file.split("/").includes("..")) return false;
    const full = join(root, file);
    return !relative(root, full).startsWith("..") && existsSync(full) && lstatSync(full).isFile();
  }
  return OUTSIDE_LINKS.includes(href);
}

/** What in one built file breaks the site's rules: a path from the root, http:, an unlisted link, no CSP. */
export function fileProblems(rel: string, text: string, root: string): string[] {
  const out: string[] = [];
  if (rel.endsWith(".html")) {
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(text)?.[1];
    if (!csp) out.push(`${rel}: no Content-Security-Policy meta`);
    else if (!/(^|; )connect-src 'none'(;|$)/.test(csp)) out.push(`${rel}: its Content-Security-Policy allows network calls`);
    for (const m of text.matchAll(/\s(src|href)="([^"]*)"/g)) {
      const value = m[2]!;
      if (value.startsWith("/")) out.push(`${rel}: ${m[1]}="${value}" starts with a slash`);
      else if (/^http:/i.test(value)) out.push(`${rel}: ${m[1]}="${value}" is http`);
      else if (/^https:/i.test(value) && !linkAllowed(value, root)) out.push(`${rel}: ${m[1]}="${value}" is not on the site's list of links`);
      else if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^(https|data):/i.test(value)) out.push(`${rel}: ${m[1]}="${value}" has another scheme`);
    }
  }
  if (rel.endsWith(".css") || rel.endsWith(".html")) {
    for (const m of text.matchAll(/url\(\s*(["']?)([^"')]*)\1\s*\)/g)) {
      const value = m[2]!;
      if (value.startsWith("/") || /^https?:/i.test(value)) out.push(`${rel}: url(${value}) is not relative`);
    }
  }
  if (rel.endsWith(".js") || rel.endsWith(".html")) {
    for (const re of [/\bimport\s*\(\s*["'`]\//g, /\bfrom\s*["'`]\//g, /\bimport\s*["'`]\//g]) {
      const m = re.exec(text);
      if (m) out.push(`${rel}: an import from the root (${JSON.stringify(text.slice(m.index, m.index + 40))})`);
    }
  }
  return out;
}

/** Every file under a folder, as paths from it with `/`, and every folder under it (deepest last); a link stops it. */
function walk(dir: string, base = dir): { files: string[]; dirs: string[] } {
  const files: string[] = [];
  const dirs: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = relative(base, full).split(sep).join("/");
    const st = lstatSync(full);
    if (st.isDirectory()) {
      dirs.push(rel);
      const inner = walk(full, base);
      files.push(...inner.files);
      dirs.push(...inner.dirs);
    } else files.push(st.isFile() ? rel : `${rel} (not a plain file)`);
  }
  return { files, dirs };
}

/** Make the out folder ready: absent or empty, or clear of an earlier site build's files only. */
export function clearOut(out: string) {
  if (!existsSync(out)) {
    mkdirSync(out, { recursive: true });
    return;
  }
  if (!lstatSync(out).isDirectory()) throw new Error(`${out} is not a folder`);
  const { files, dirs } = walk(out);
  const foreign = [...files.filter((f) => !siteMade(f)), ...dirs.filter((d) => d !== "zh-CN" && !siteMade(`${d}/x`)).map((d) => `${d}/`)];
  if (foreign.length) throw new Error(`${out} holds files that the site build did not make: ${foreign.slice(0, 5).join(", ")}${foreign.length > 5 ? ", ..." : ""}`);
  for (const f of files) unlinkSync(join(out, f));
  for (const d of dirs.sort((a, b) => b.split("/").length - a.split("/").length)) rmdirSync(join(out, d));
}

export interface SiteBuild {
  /** Every file written, as paths from the out folder with `/`, sorted. */
  files: string[];
  bytes: number;
}

export async function buildSite({ root, out, quiet = false }: { root: string; out: string; quiet?: boolean }): Promise<SiteBuild> {
  clearOut(out);

  // The demo: the app with the stand-in for the server, in demo/.
  await buildDemo({ out });
  if (!existsSync(join(out, "demo", "index.html"))) throw new Error("the demo's build wrote no demo/index.html");

  // The landing pages' script and stylesheet.
  const assets = join(out, "assets");
  const result = await Bun.build({
    entrypoints: [join(root, "site", "page.ts"), join(root, "site", "site.css")],
    outdir: assets,
    naming: "[name]-[hash].[ext]",
    minify: true,
    target: "browser",
    sourcemap: "none",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!result.success) throw new Error(`the page's script or stylesheet did not build:\n${result.logs.map(String).join("\n")}`);
  // One script and one stylesheet (Bun lists a stylesheet entry as an asset).
  const entry = (ext: string) => {
    const found = result.outputs.filter((o) => o.path.endsWith(ext));
    if (found.length !== 1) throw new Error(`the page's build made ${found.length} ${ext} files, not one`);
    return basename(found[0]!.path);
  };
  const files = { js: entry(".js"), css: entry(".css") };

  // The two pages, from the READMEs, with the app's own tab icon and the theme script's hash in their policy.
  const icon = /<link rel="icon" href="([^"]+)"/.exec(readFileSync(join(root, "web", "index.html"), "utf8"))?.[1];
  if (!icon) throw new Error("web/index.html has no tab icon");
  const csp = landingCsp(createHash("sha256").update(THEME_SCRIPT, "utf8").digest("base64"));
  for (const lang of LANGS) {
    const readme = readFileSync(join(root, lang === "en" ? "README.md" : "README.zh-CN.md"), "utf8");
    const file = join(out, PAGE_FILE[lang]);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, renderPage({ lang, readme, assets: files, csp, icon }));
  }

  // The site's rules, on every file written.
  const written = walk(out).files;
  const problems = written.flatMap((rel) => (/\.(html|css|js)$/.test(rel) ? fileProblems(rel, readFileSync(join(out, rel), "utf8"), root) : []));
  const foreign = written.filter((f) => !siteMade(f));
  for (const f of foreign) problems.push(`${f}: not a file that the site build makes`);
  if (problems.length) throw new Error(`the built site breaks its rules:\n${problems.join("\n")}`);

  let bytes = 0;
  let zipped = 0;
  for (const rel of written) {
    const body = readFileSync(join(out, rel));
    const gz = /\.(js|css|html|svg|json)$/.test(rel) ? Bun.gzipSync(body, { level: 9 }).length : body.length;
    bytes += body.length;
    zipped += gz;
    if (!quiet) console.log(`${rel}  ${body.length} B  (gzip ${gz} B)`);
  }
  if (!quiet) console.log(`built ${out}: ${written.length} files, ${bytes} B, ${zipped} B gzipped`);
  return { files: written, bytes };
}

if (import.meta.main) {
  const at = process.argv.indexOf("--out");
  const given = at > 0 ? process.argv[at + 1] : undefined;
  if (at > 0 && !given) {
    console.error("usage: bun scripts/build-site.ts [--out <folder>]");
    process.exit(2);
  }
  const out = given ? (isAbsolute(given) ? given : resolve(given)) : join(ROOT, "dist", "site");
  try {
    await buildSite({ root: ROOT, out });
  } catch (e) {
    console.error(`build-site: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
