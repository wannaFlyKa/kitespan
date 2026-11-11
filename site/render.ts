// The landing page's HTML (DESIGN-W1 1 and 5.2), one per language, from that language's README: its first line is the
// page's h1, and its sections, cut by their headings and rendered with marked, are the page's text, so the site never
// holds a second copy of the README's words. The install commands come from shared/release.ts, and the build stops when
// the README shows another one. A missing heading, raw HTML or an image in a section stops the build too: the page loads
// nothing from another origin. Pure code: no DOM, no Bun API; scripts/build-site.ts reads the files and writes the pages.
import { Marked, type Token } from "marked";
import { BREW_FORMULA, INSTALLER_FILE, RELEASE_REPO, RELEASES_URL } from "../shared/release";
import { THEME_SCRIPT } from "./theme";
import { WORDS, type Lang, type SiteWords } from "./words";

export const REPO_URL = `https://github.com/${RELEASE_REPO}`;
export const INSTALL_COMMAND = `curl -fsSL ${RELEASES_URL}/latest/download/${INSTALLER_FILE} | sh`;
export const BREW_COMMAND = `brew install ${BREW_FORMULA}`;
/** The README's source block says `git clone <this repository> kitespan`; a page can say where the repository is. */
export const REPOSITORY_PLACEHOLDER = "<this repository>";
export const CLONE_URL = `${REPO_URL}.git`;

/** Where each page sits under the site's root, and the path from it back to the root. */
export const PAGE_FILE: Record<Lang, string> = { en: "index.html", "zh-CN": "zh-CN/index.html" };
const ROOT_PREFIX: Record<Lang, string> = { en: "./", "zh-CN": "../" };

/** The landing pages' policy: their own files, the theme script by its hash, frames of the site only, no network call. */
export function landingCsp(themeScriptHash: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'sha256-${themeScriptHash}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'none'",
    "frame-src 'self'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

export class ReadmeError extends Error {}

const marked = new Marked({ gfm: true, async: false });

/** Whether a line opens or closes a fenced code block (``` or ~~~), so a `#` inside one is never taken for a heading. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * The body of the section `<#…#> <heading>` (level 2 or 3): the lines after it up to the next heading of that level or
 * higher, outside code blocks. A deeper heading stays in. Throws when the heading is not there.
 */
export function cutSection(md: string, heading: string, level: 2 | 3 = 2, where = "README"): string {
  const lines = md.split("\n");
  const marks = "#".repeat(level);
  let fence: string | null = null;
  let at = -1;
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const f = FENCE.exec(line);
    const inFence = fence !== null;
    if (f) {
      if (fence === null) fence = f[1]![0]!;
      else if (f[1]![0] === fence) fence = null;
    }
    if (at < 0) {
      if (!inFence && !f && line.trimEnd() === `${marks} ${heading}`) at = i;
      continue;
    }
    if (!inFence && !f && new RegExp(`^#{1,${level}} `).test(line)) break;
    out.push(line);
  }
  if (at < 0) throw new ReadmeError(`${where} has no "${marks} ${heading}" heading`);
  return out.join("\n").trim();
}

/** The paragraphs (blocks between blank lines) of a piece of Markdown. */
const blocks = (md: string) => md.split(/\n[ \t]*\n/).map((p) => p.trim()).filter(Boolean);

/** The first fenced `sh` block of a piece of Markdown, without its fences. */
export function firstShBlock(md: string, where: string): string {
  const m = /^```sh\n([\s\S]*?)\n```$/m.exec(md);
  if (!m) throw new ReadmeError(`${where} holds no sh block`);
  return m[1]!;
}

/** The README's top: its one line (the page's h1) and the paragraphs before its first `##`. */
export function readmeTop(md: string, where = "README"): { line: string; opening: string[] } {
  const top = md.split(/\n## /)[0]!;
  const parts = blocks(top).filter((p) => !/^# /.test(p) && !/^\[[^\]]+\]\(README[^)]*\.md\)$/.test(p));
  const [line, ...opening] = parts;
  if (!line || /\n/.test(line)) throw new ReadmeError(`${where} needs its one line after the title and the language link`);
  return { line, opening };
}

/** A link of a README section, as the page shows it: a relative one points at the repository's file on GitHub. */
export function pageHref(href: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) return href;
  return `${REPO_URL}/blob/main/${href.replace(/^\.\//, "")}`;
}

/** Markdown to HTML; raw HTML and images stop the build, relative links go to the repository's files. */
export function markdownHtml(md: string, where: string): string {
  const tokens = marked.lexer(md);
  marked.walkTokens(tokens, (t: Token) => {
    if (t.type === "html") throw new ReadmeError(`${where} holds raw HTML (${JSON.stringify(t.raw.trim().slice(0, 40))}), which the page does not show`);
    if (t.type === "image") throw new ReadmeError(`${where} holds an image (${t.href}), which the page does not load`);
    if (t.type === "link") t.href = pageHref(t.href);
  });
  return (marked.parser(tokens) as string).trim();
}

/** One line of inline Markdown as HTML (the h1), refusing raw HTML. */
function inlineHtml(md: string, where: string): string {
  const html = markdownHtml(md, where);
  const m = /^<p>([\s\S]*)<\/p>$/.exec(html);
  if (!m) throw new ReadmeError(`${where}: the one line is not a paragraph`);
  return m[1]!;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The parts of a README that the page shows, as HTML, with the commands to copy. */
export interface ReadmeParts {
  line: string;
  description: string;
  opening: string[];
  why: string;
  who: string;
  requirements: string;
  commands: { script: string; brew: string; source: string };
  /** The README's words after the source block: the SDK, whose terms are Anthropic's, and how each way fetches it. */
  sourceNote: string;
  works: string;
  remote: string;
  licence: string;
  trademarks: string;
}

export function readmeParts(md: string, lang: Lang): ReadmeParts {
  const where = lang === "en" ? "README.md" : "README.zh-CN.md";
  const h = WORDS[lang].headings;
  const cut = (heading: string) => cutSection(md, heading, 2, where);
  const top = readmeTop(md, where);
  const line = inlineHtml(top.line, where);
  const install = cut(h.install);
  const shown = (heading: string) => firstShBlock(cutSection(install, heading, 3, `${where} ## ${h.install}`), `${where} ### ${heading}`);
  for (const [heading, want] of [
    [h.script, INSTALL_COMMAND],
    [h.brew, BREW_COMMAND],
  ] as const) {
    const got = shown(heading);
    if (got !== want) throw new ReadmeError(`${where} ### ${heading} shows ${JSON.stringify(got)}, not ${JSON.stringify(want)} (shared/release.ts)`);
  }
  const source = shown(h.source);
  if (!source.includes(REPOSITORY_PLACEHOLDER)) throw new ReadmeError(`${where} ### ${h.source} has no ${REPOSITORY_PLACEHOLDER} to fill in`);
  const sourceWhere = `${where} ### ${h.source}`;
  const sourceNote = cutSection(install, h.source, 3, `${where} ## ${h.install}`).replace(/^```sh\n[\s\S]*?\n```$/m, "").trim();
  if (!sourceNote) throw new ReadmeError(`${sourceWhere} has no words after its commands (the SDK's terms)`);
  const remote = blocks(cut(h.remote)).slice(0, 2);
  if (remote.length < 2) throw new ReadmeError(`${where} ## ${h.remote} needs its two paragraphs`);
  return {
    line,
    description: line.replace(/<[^>]*>/g, ""),
    opening: top.opening.map((p) => markdownHtml(p, where)),
    why: markdownHtml(cut(h.why), `${where} ## ${h.why}`),
    who: markdownHtml(cut(h.who), `${where} ## ${h.who}`),
    requirements: markdownHtml(cut(h.requirements), `${where} ## ${h.requirements}`),
    commands: { script: INSTALL_COMMAND, brew: BREW_COMMAND, source: source.split(REPOSITORY_PLACEHOLDER).join(CLONE_URL) },
    sourceNote: markdownHtml(sourceNote, sourceWhere),
    works: markdownHtml(cut(h.works), `${where} ## ${h.works}`),
    remote: markdownHtml(remote.join("\n\n"), `${where} ## ${h.remote}`),
    licence: markdownHtml(cut(h.licence), `${where} ## ${h.licence}`),
    trademarks: markdownHtml(cut(h.trademarks), `${where} ## ${h.trademarks}`),
  };
}

/** kitespan's mark (the tab icon's square and chevron), in the text's colour with the page's ground for the chevron. */
const MARK =
  '<svg viewBox="0 0 16 16" width="22" height="22" aria-hidden="true"><rect width="16" height="16" rx="4" fill="currentColor"/><path class="mark-chevron" d="M4 10.5 8 4l4 6.5" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
/** The theme button's face: a circle, half filled. */
const THEME_ICON =
  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 1.75a6.25 6.25 0 0 1 0 12.5z" fill="currentColor"/></svg>';

export interface PageInput {
  lang: Lang;
  /** That language's README. */
  readme: string;
  /** The built page script's and stylesheet's file names in assets/. */
  assets: { js: string; css: string };
  /** The Content-Security-Policy, for the meta tag. */
  csp: string;
  /** The app's tab icon (web/index.html's), a data: URL. */
  icon: string;
}

/** One landing page. Every path in it is relative, so the same build works under any base path. */
export function renderPage({ lang, readme, assets, csp, icon }: PageInput): string {
  const w: SiteWords = WORDS[lang];
  const h = w.headings;
  const root = ROOT_PREFIX[lang];
  const r = readmeParts(readme, lang);
  if (!/^data:/.test(icon)) throw new ReadmeError("the tab icon must be a data: URL, so the page asks for no /favicon.ico");
  const cmd = (text: string, way: string) =>
    `<div class="cmd"><pre><code>${esc(text)}</code></pre><button type="button" class="copy-btn" aria-label="${esc(w.copyName(way))}">${esc(w.copy)}</button></div>`;
  const readmeLink = lang === "en" ? `${REPO_URL}#readme` : `${REPO_URL}/blob/main/README.zh-CN.md`;
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${esc(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<meta name="description" content="${r.description}">
<title>kitespan</title>
<link rel="icon" href="${esc(icon)}">
<link rel="alternate" hreflang="${w.other.lang}" href="${w.other.href}">
<script>${THEME_SCRIPT}</script>
<link rel="stylesheet" href="${root}assets/${esc(assets.css)}">
<script type="module" src="${root}assets/${esc(assets.js)}"></script>
</head>
<body class="site">
<header class="top">
<a class="mark" href="./">${MARK}kitespan</a>
<div class="top-links">
<a href="${w.other.href}" lang="${w.other.lang}" hreflang="${w.other.lang}">${esc(w.other.name)}</a>
<a href="${REPO_URL}">${esc(w.github)}</a>
<button type="button" class="icon-btn theme-btn" aria-pressed="false" aria-label="${esc(w.darkTheme)}" title="${esc(w.darkTheme)}">${THEME_ICON}</button>
</div>
</header>
<main>
<section class="stage" aria-labelledby="line">
<div class="stage-row">
<h1 id="line">${r.line}</h1>
<div class="seg seg-small" role="radiogroup" aria-label="${esc(w.device)}" style="--seg-count: 2; --seg-index: 0">
<button type="button" class="seg-item" role="radio" aria-checked="true" tabindex="0" data-device="phone"><span class="seg-label" data-label="${esc(w.phone)}">${esc(w.phone)}</span></button>
<button type="button" class="seg-item" role="radio" aria-checked="false" tabindex="-1" data-device="laptop"><span class="seg-label" data-label="${esc(w.laptop)}">${esc(w.laptop)}</span></button>
</div>
</div>
<div class="device" data-on="phone" data-demo="${root}demo/">
<div class="phone"></div>
<div class="laptop"><div class="screen"></div><div class="base"></div></div>
<noscript><p class="no-script">${esc(w.noScript)}</p></noscript>
</div>
<p class="note">${esc(w.note)}</p>
</section>
<div class="doc">
${r.opening.join("\n")}
<h2>${esc(h.why)}</h2>
${r.why}
<h2>${esc(h.who)}</h2>
${r.who}
<h2>${esc(h.install)}</h2>
<h3>${esc(h.requirements)}</h3>
${r.requirements}
<h3>${esc(h.script)}</h3>
${cmd(r.commands.script, h.script)}
<h3>${esc(h.brew)}</h3>
${cmd(r.commands.brew, h.brew)}
<h3>${esc(h.source)}</h3>
${cmd(r.commands.source, h.source)}
${r.sourceNote}
<h2>${esc(h.works)}</h2>
${r.works}
<h2>${esc(h.remote)}</h2>
${r.remote}
</div>
</main>
<footer class="foot doc">
${r.licence}
${r.trademarks}
<nav aria-label="${esc(w.links)}">
<a href="${readmeLink}">${esc(w.readme)}</a>
<a href="${REPO_URL}/blob/main/CONTRIBUTING.md">${esc(w.contributing)}</a>
<a href="${REPO_URL}/blob/main/SECURITY.md">${esc(w.security)}</a>
</nav>
</footer>
</body>
</html>
`;
}
