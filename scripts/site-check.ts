// The site check (DESIGN-W1 6): the built site (scripts/build-site.ts) served under its Pages base path, and every page
// in a headless Chrome of its own (scripts/lib/chrome.ts) at 1280x800, 1194x834 (touch) and 390x844 (touch), light and
// dark, English and Simplified Chinese. Each run checks the first screen (the h1 is the README's line, the stage fits,
// nothing scrolls sideways, the frames' sizes and titles, the hidden frame inert, the app up in each frame), the
// keyboard (no focus in a frame that does not show, after the load or after S1; the first Tab on the mark link, and Tab
// from the device switch into the shown frame), the theme button (the page and its frames), the device switch, the
// demo's scenes clicked with real input (S1 the card answered on the phone; S2 the laptop's diff, and S1's answer there;
// S3 search; S4 a send and its scripted reply; S5 the line of each control that does not run, in its place), the
// commands at their blocks' size, and the language link there and back; and each language once without script (its
// line, no note, no frame). All the time, in every frame: no request but
// to the site's own base URL (or data:, blob: and about:), no WebSocket, EventSource or service worker, no CSP
// violation, console error, exception or HTTP status of 400 or more; every img has an alt, every iframe a title, every
// svg of the landing page is hidden or named. Screenshots and report.json go to --out. Exit 1 when a check fails, 2 on
// bad arguments or when it cannot run. Chrome resolves no name but the loopback ones, so nothing reaches the network.
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { DEMO_HOST, DEMO_LINES, DEMO_REPLIES, EXAMPLE_CHAT, START_ROUTES } from "../site/demo/lines";
import { LANGS, WORDS, type Lang } from "../site/words";
import { checkPort } from "../test/click/ports";
import { Cdp, sleep } from "./lib/cdp";
import { findChrome, launchChrome, portFree, type OwnChrome } from "./lib/chrome";
import { Page, type Theme, type Viewport } from "./lib/page";

const ROOT = resolve(import.meta.dir, "..");

export const USAGE = `Usage: bun scripts/site-check.ts --site <built folder> --out <folder> --port <port> [options]

  --site <folder>    the built site (bun scripts/build-site.ts --out <folder>)
  --out <folder>     where report.json and the screenshots go
  --port <port>      the port the site is served on, 7941 to 7949; Chrome's DevTools port is this one plus 1400
  --base <path>      the site's base path, as GitHub Pages serves a project page (default /kitespan/)
  --chrome <binary>  the Chrome to start (default: CHROME_PATH, PATH, then the usual install caches)
  --langs <list>     en,zh-CN (default: both)
  --sizes <list>     1280x800,1194x834,390x844 (default: all three)
  --themes <list>    light,dark (default: both)`;

export const DEFAULT_BASE = "/kitespan/";
/** Chrome's DevTools port is the site's port plus this: 9341 to 9349. */
export const DEVTOOLS_OFFSET = 1400;
/** Under this width the page takes its phone form: one full-width frame and no device switch (DESIGN-W1 1.2). */
export const WIDE = 900;

/** The three sizes (DESIGN-W1 6): the laptop with a fine pointer, the tablet and the phone with touch. */
export const SITE_SIZES: readonly Viewport[] = [
  { name: "laptop", width: 1280, height: 800, scale: 1, mobile: false, touch: false },
  { name: "medium", width: 1194, height: 834, scale: 2, mobile: true, touch: true },
  { name: "phone", width: 390, height: 844, scale: 3, mobile: true, touch: true },
];
const sizeName = (v: Viewport) => `${v.width}x${v.height}`;
const THEMES: readonly Theme[] = ["light", "dark"];

/** Each language's page under the base, and its README. */
export const LANG_PATH: Record<Lang, string> = { en: "", "zh-CN": "zh-CN/" };
const README_FILE: Record<Lang, string> = { en: "README.md", "zh-CN": "README.zh-CN.md" };

// Headless Chrome has no pointing device; these Blink settings give its pages a fine pointer that hovers, as a laptop
// has, while touch emulation still makes the touch sizes coarse (the same flag as scripts/ui-check.ts).
const FINE_POINTER = "--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2";

/** The click-through seed's words that the scenes look for (test/click/seed/fixture.ts, web/chat/cards/labels.ts). */
const CHAT_TITLE = "Fix the flaky upload test";
const CARD_TITLE = "Allow Claude to use Bash?";
const ALLOWED_ONCE = "Allowed once";
const ALLOW_REPLY = "Built. The last run passes too.";
const FIRST_FILE = "upload.ts";
const SECOND_FILE = "upload.test.ts";
const SEARCH_WORD = "upload";
const MESSAGE = "What runs in this demo?";
const UPLOAD_NAME = "site-check-upload.txt";

// ---------------------------------------------------------------------------------------------------------------
// Arguments

export class ArgError extends Error {}

export interface Args {
  site: string;
  out: string;
  port: number;
  base: string;
  chrome: string | null;
  langs: Lang[];
  sizes: Viewport[];
  themes: Theme[];
}

const KNOWN = new Set(["site", "out", "port", "base", "chrome", "langs", "sizes", "themes"]);

/** Why a base path cannot be served, or null: it starts and ends with a slash, and its parts are plain names. */
export function baseProblem(base: string): string | null {
  if (base === "/") return null;
  if (!base.startsWith("/") || !base.endsWith("/")) return `must start and end with a slash, not "${base}"`;
  for (const p of base.slice(1, -1).split("/")) if (!/^[A-Za-z0-9_~-][A-Za-z0-9._~-]*$/.test(p)) return `has a part that is not a plain name: "${base}"`;
  return null;
}

function listOf<T extends string>(raw: string | undefined, all: readonly T[], what: string): T[] {
  if (raw === undefined) return [...all];
  const items = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (!items.length) throw new ArgError(`--${what}s needs at least one of ${all.join(", ")}`);
  for (const i of items) if (!all.includes(i as T)) throw new ArgError(`unknown ${what} "${i}"; use ${all.join(", ")}`);
  return all.filter((a) => items.includes(a));
}

/** The command line, or "help". A problem throws an ArgError (the script exits 2). */
export function parseArgs(argv: readonly string[]): Args | "help" {
  const raw: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") return "help";
    if (!a.startsWith("--")) throw new ArgError(`unexpected argument "${a}" (see --help)`);
    const eq = a.indexOf("=");
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    let value: string | undefined;
    if (eq > 0) value = a.slice(eq + 1);
    else {
      value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new ArgError(`--${key} needs a value (see --help)`);
      i++;
    }
    if (!KNOWN.has(key)) throw new ArgError(`unknown option --${key} (see --help)`);
    if (key in raw) throw new ArgError(`--${key} is given twice`);
    raw[key] = value;
  }
  for (const k of ["site", "out", "port"]) if (!raw[k]) throw new ArgError(`--${k} is required (see --help)`);
  if (!/^\d+$/.test(raw.port!)) throw new ArgError(`--port must be a port number, not "${raw.port}"`);
  const port = Number(raw.port);
  try {
    checkPort(port);
  } catch (e) {
    throw new ArgError((e as Error).message);
  }
  const base = raw.base ?? DEFAULT_BASE;
  const why = baseProblem(base);
  if (why) throw new ArgError(`--base ${why}`);
  if (raw.chrome === "") throw new ArgError("--chrome needs a value (see --help)");
  const sizes = listOf(raw.sizes, SITE_SIZES.map(sizeName), "size").map((n) => SITE_SIZES.find((v) => sizeName(v) === n)!);
  return {
    site: resolve(raw.site!),
    out: resolve(raw.out!),
    port,
    base,
    chrome: raw.chrome ?? null,
    langs: listOf(raw.langs, LANGS, "lang"),
    sizes,
    themes: listOf(raw.themes, THEMES, "theme"),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The request rule and the static server

/**
 * Whether the page may ask for this URL: the site's own files (this origin, under the base path), or a data:, an
 * about: or this origin's blob: URL. Another origin, another scheme or port, and this origin outside the base are not.
 */
export function requestAllowed(url: string, origin: string, base: string): boolean {
  if (url.startsWith("data:") || url.startsWith("about:")) return true;
  if (url.startsWith("blob:")) return url.startsWith(`blob:${origin}/`);
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.origin === origin && u.username === "" && u.password === "" && u.pathname.startsWith(base);
}

export type SiteAnswer = { kind: "file"; file: string } | { kind: "redirect"; to: string } | { kind: "missing" };

/**
 * What the static server answers for a path (the URL's pathname, still encoded), as GitHub Pages would: a file of the
 * built folder under the base; a folder's index.html, and a folder asked without its slash is sent to it; 404 for
 * anything outside the base (the organisation's own root), a missing file, and a part that is empty, ".", "..", a
 * dot-file (the Pages artifact leaves them out), or holds a slash, a backslash or a NUL once decoded. A path never
 * leaves the folder, also through a link.
 */
export function sitePath(root: string, base: string, pathname: string): SiteAnswer {
  const missing: SiteAnswer = { kind: "missing" };
  if (base !== "/" && pathname === base.slice(0, -1)) return { kind: "redirect", to: base };
  if (!pathname.startsWith(base)) return missing;
  const rest = pathname.slice(base.length);
  const folderAsked = rest === "" || rest.endsWith("/");
  const raw = rest === "" ? [] : (folderAsked ? rest.slice(0, -1) : rest).split("/");
  const parts: string[] = [];
  for (const r of raw) {
    let p: string;
    try {
      p = decodeURIComponent(r);
    } catch {
      return missing;
    }
    if (p === "" || p.startsWith(".") || /[/\\\0]/.test(p)) return missing;
    parts.push(p);
  }
  let file = join(root, ...parts);
  let st;
  try {
    st = statSync(file);
  } catch {
    return missing;
  }
  if (st.isDirectory()) {
    if (!folderAsked) return { kind: "redirect", to: `${pathname}/` };
    file = join(file, "index.html");
    try {
      if (!statSync(file).isFile()) return missing;
    } catch {
      return missing;
    }
  } else if (folderAsked || !st.isFile()) return missing;
  try {
    const real = realpathSync(file);
    const top = realpathSync(root);
    if (!real.startsWith(top + sep)) return missing;
  } catch {
    return missing;
  }
  return { kind: "file", file };
}

export interface SiteServer {
  origin: string;
  /** Every path asked, with how many times. */
  asked: Map<string, number>;
  stop(): void;
}

/** Serve the built folder at http://127.0.0.1:<port><base>; files only (sitePath), GET and HEAD only. */
export function startSiteServer(opts: { root: string; port: number; base: string }): SiteServer {
  const asked = new Map<string, number>();
  const plain = (status: number, text: string, headers: Record<string, string> = {}) =>
    new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers } });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port,
    development: false,
    fetch(req) {
      const url = new URL(req.url);
      asked.set(url.pathname, (asked.get(url.pathname) ?? 0) + 1);
      if (req.method !== "GET" && req.method !== "HEAD") return plain(405, "Method not allowed", { allow: "GET, HEAD" });
      const a = sitePath(opts.root, opts.base, url.pathname);
      if (a.kind === "redirect") return new Response(null, { status: 301, headers: { location: a.to + url.search, "cache-control": "no-store" } });
      if (a.kind === "missing") return plain(404, "Not found");
      return new Response(Bun.file(a.file), { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, asked, stop: () => void server.stop(true) };
}

// ---------------------------------------------------------------------------------------------------------------
// Small pure parts

/** The README's one line (the page's h1): the first line after the title and the language link, as plain text. */
export function readmeLine(md: string): string | null {
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    if (line === "" || /^# /.test(line) || /^\[[^\]]+\]\([^)\s]+\)$/.test(line)) continue;
    if (line.startsWith("#")) return null;
    return line
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
  }
  return null;
}

/** How much of the reply's start the text shows (a start that it holds means every shorter one too). */
export function shownPrefix(text: string, reply: string): number {
  let lo = 0;
  let hi = reply.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (text.includes(reply.slice(0, mid))) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * S4: how many reads 50 ms apart a streaming reply must grow over. The page shows a reply a word at a time, and a
 * Chinese one a word that Intl.Segmenter finds, one or two characters (FIX-Q1), so the scripted replies grow over
 * many reads in both languages; a page that showed only whole space-separated words grew the Chinese one over three.
 */
export const S4_GROWS = 10;

/** The reads of a streaming reply that showed part of it, each longer than the one before (after `from`). */
export function growingReads(reads: readonly number[], from: number, whole: number): number {
  let n = 0;
  let last = from;
  for (const r of reads) {
    if (r > last && r < whole) {
      n++;
      last = r;
    }
  }
  return n;
}

export type Status = "pass" | "fail" | "warn";
export interface CheckRow {
  run: string;
  step: string;
  status: Status;
  text: string;
}

export interface Summary {
  total: number;
  passed: number;
  failed: number;
  warned: number;
  line: string;
  failures: string[];
}

export function summarize(rows: readonly CheckRow[]): Summary {
  const count = (s: Status) => rows.filter((r) => r.status === s).length;
  const passed = count("pass");
  const failed = count("fail");
  const warned = count("warn");
  const line = `site-check: ${rows.length} checks, ${passed} passed, ${failed} failed, ${warned} warning${warned === 1 ? "" : "s"}`;
  return { total: rows.length, passed, failed, warned, line, failures: rows.filter((r) => r.status === "fail").map((r) => `${r.run}: ${r.step}: ${r.text}`) };
}

const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ---------------------------------------------------------------------------------------------------------------
// In-page parts (run in the landing page; the frames are the site's own, so the page reaches into them)

/**
 * Installed in every document before its own scripts: the CSP violations it sees go to the landing page's list
 * (window.__siteCheck.csp), which the check reads and empties after each step.
 */
const CSP_LISTENER = `(() => {
  let sink;
  try { sink = window.top.__siteCheck || (window.top.__siteCheck = { csp: [] }); } catch (e) { sink = window.__siteCheck || (window.__siteCheck = { csp: [] }); }
  const where = location.pathname;
  document.addEventListener("securitypolicyviolation", (e) => {
    sink.csp.push((e.effectiveDirective || e.violatedDirective) + " blocked " + (e.blockedURI || "an inline part") + " in " + where + (e.sourceFile ? " (" + e.sourceFile.replace(/^[a-z]+:\\/\\/[^/]+/, "") + ":" + e.lineNumber + ")" : ""));
  });
})();`;

const PRE = `
  const norm = (s) => String(s == null ? "" : s).replace(/\\s+/g, " ").trim();
  const describe = (el) => {
    if (!el || !el.tagName) return String(el);
    const id = el.getAttribute("data-testid");
    const cls = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".") : "";
    return el.tagName.toLowerCase() + cls + (id ? "[data-testid=" + id + "]" : "");
  };
  const shownIn = (w, el) => {
    if (!el || !el.getClientRects().length) return false;
    if (el.closest('[hidden="until-found"]')) return false;
    const cs = w.getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.visibility !== "collapse";
  };
  const frames = () => [...document.querySelectorAll(".device iframe")];
  const roleOf = (f) => (f.closest(".laptop") ? "laptop" : f.closest(".phone") ? "phone" : "other");
  const onPage = (f) => shownIn(window, f) && !f.closest("[inert]");
  const frameOf = (which) => frames().find((f) => (which === "shown" ? onPage(f) : roleOf(f) === which)) || null;
`;

type Which = "phone" | "laptop" | "shown";

interface FrameInfo {
  role: string;
  title: string | null;
  src: string | null;
  shown: boolean;
  visibility: string;
  inert: boolean;
  ariaHidden: boolean;
  w: number;
  h: number;
  path: string | null;
  up: boolean;
  theme: string | null;
  sideways: boolean;
  imgsNoAlt: string[];
  waitingDots: number;
}

const FRAMES = (title: string) => `(() => { ${PRE}
  return frames().map((f) => {
    let d = null;
    try { d = f.contentDocument; } catch (e) {}
    const w = f.contentWindow;
    const de = d ? d.documentElement : null;
    return {
      role: roleOf(f),
      title: f.getAttribute("title"),
      src: f.getAttribute("src"),
      shown: onPage(f),
      visibility: getComputedStyle(f).visibility,
      inert: !!f.closest("[inert]"),
      ariaHidden: !!f.closest('[aria-hidden="true"]'),
      w: w ? w.innerWidth : 0,
      h: w ? w.innerHeight : 0,
      path: d && w ? w.location.pathname + w.location.search : null,
      up: !!d && [...d.querySelectorAll('[data-testid="topbar"]')].some((b) => norm(b.textContent).includes(${JSON.stringify(title)})),
      theme: de ? de.getAttribute("data-theme") : null,
      sideways: !!de && de.scrollWidth > de.clientWidth + 1,
      imgsNoAlt: d ? [...d.images].filter((i) => !i.hasAttribute("alt")).map((i) => describe(i) + " " + (i.getAttribute("src") || "").slice(0, 60)) : [],
      waitingDots: d ? d.querySelectorAll(".dot.waiting").length : 0,
    };
  });
})()`;

interface LandingInfo {
  lang: string;
  path: string;
  theme: string | null;
  pressed: string | null;
  h1: string | null;
  sideways: boolean;
  scrollWidth: number;
  clientWidth: number;
  noteBottom: number | null;
  innerHeight: number;
  radios: { label: string; checked: string | null }[];
  groupShown: boolean;
  on: string | null;
  hreflang: { lang: string | null; href: string | null } | null;
  imgsNoAlt: string[];
  iframesNoTitle: number;
  svgsUnnamed: string[];
}

const LANDING = `(() => { ${PRE}
  const de = document.documentElement;
  const h1 = document.querySelector(".stage h1");
  const note = document.querySelector(".note");
  const button = document.querySelector(".top button[aria-pressed]");
  const group = document.querySelector('.stage [role="radiogroup"]');
  const device = document.querySelector(".device");
  const link = document.querySelector(".top a[hreflang]");
  return {
    lang: de.lang,
    path: location.pathname,
    theme: de.getAttribute("data-theme"),
    pressed: button ? button.getAttribute("aria-pressed") : null,
    h1: h1 ? norm(h1.textContent) : null,
    sideways: de.scrollWidth > de.clientWidth + 1,
    scrollWidth: de.scrollWidth,
    clientWidth: de.clientWidth,
    noteBottom: note && note.getClientRects().length ? Math.round(note.getBoundingClientRect().bottom) : null,
    innerHeight,
    radios: group ? [...group.querySelectorAll('[role="radio"]')].map((r) => ({ label: norm(r.textContent), checked: r.getAttribute("aria-checked") })) : [],
    groupShown: !!group && shownIn(window, group),
    on: device ? device.getAttribute("data-on") : null,
    hreflang: link ? { lang: link.getAttribute("hreflang"), href: link.getAttribute("href") } : null,
    imgsNoAlt: [...document.images].filter((i) => !i.hasAttribute("alt")).map((i) => describe(i) + " " + (i.getAttribute("src") || "").slice(0, 60)),
    iframesNoTitle: [...document.querySelectorAll("iframe")].filter((f) => !norm(f.getAttribute("title"))).length,
    svgsUnnamed: [...document.querySelectorAll("svg")].filter((s) => !s.parentElement.closest("svg") && !s.closest('[aria-hidden="true"]') && !s.querySelector(":scope > title")).map((s) => describe(s.parentElement) + " > svg"),
  };
})()`;

/** Where the landing page's keyboard focus is: the page itself, the mark link, a device radio, a frame (shown or not). */
interface Focus {
  kind: "page" | "mark" | "radio" | "other radio" | "frame" | "hidden frame" | "other";
  label: string;
}

const FOCUS = `(() => { ${PRE}
  const a = document.activeElement;
  if (!a || a === document.body || a === document.documentElement) return { kind: "page", label: "the page" };
  if (a.tagName === "IFRAME") {
    let inner = "";
    try {
      const e = a.contentDocument && a.contentDocument.activeElement;
      if (e && e !== a.contentDocument.body) inner = describe(e) + (e.getAttribute("aria-label") ? " " + JSON.stringify(e.getAttribute("aria-label")) : "");
    } catch (e) {}
    return { kind: onPage(a) ? "frame" : "hidden frame", label: "the " + roleOf(a) + " frame" + (inner ? " at " + inner : "") };
  }
  if (a.matches(".top a.mark")) return { kind: "mark", label: "the mark link" };
  if (a.matches('.stage [role="radio"]')) return { kind: a.getAttribute("aria-checked") === "true" ? "radio" : "other radio", label: "the radio " + JSON.stringify(norm(a.textContent)) };
  return { kind: "other", label: describe(a) + " " + JSON.stringify(norm(a.textContent).slice(0, 40)) };
})()`;

/** The keyboard's Tab on the landing page (Shift with it when `back`). */
async function pressTab(page: Page, back = false) {
  const base = { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers: back ? 8 : 0 };
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await sleep(120);
}

/** Run `body` (which returns a value) in a frame's document, with w (its window), d (its document) and shown(el). */
async function inFrame<T>(page: Page, which: Which, body: string): Promise<T | null> {
  try {
    const r = await page.evaluate<{ ok: boolean; v?: T }>(`(() => { ${PRE}
      const f = frameOf(${JSON.stringify(which)});
      if (!f) return { ok: false };
      let d = null;
      try { d = f.contentDocument; } catch (e) {}
      if (!d || !d.body) return { ok: false };
      const w = f.contentWindow;
      const shown = (el) => shownIn(w, el);
      return { ok: true, v: (() => { ${body} })() };
    })()`);
    return r && r.ok ? (r.v as T) : null;
  } catch (e) {
    // A frame between documents reads as none; a mistake in this script's own code is the check's, so it stops.
    if (/SyntaxError|ReferenceError/.test((e as Error).message)) throw e;
    return null;
  }
}

const frameText = async (page: Page, which: Which, selector = "body") =>
  (await inFrame<string>(page, which, `const el = [...d.querySelectorAll(${JSON.stringify(selector)})].find(shown); return el ? norm(el.innerText) : "";`)) ?? "";

const framePath = async (page: Page, which: Which) => (await inFrame<string>(page, which, "return w.location.pathname + w.location.search;")) ?? "";

/** Go to an app URL inside a frame as the app's own links do: a new history entry, then the router reads it. */
async function frameGo(page: Page, which: Which, path: string) {
  await inFrame(page, which, `w.history.pushState(w.history.state, "", ${JSON.stringify(path)}); w.dispatchEvent(new w.PopStateEvent("popstate", { state: w.history.state })); return true;`);
  await sleep(400);
}

interface At {
  x: number;
  y: number;
  inView: boolean;
  covered: string | null;
  topCovered: string | null;
  label: string;
}

/** The page's point of the first shown element in a frame that matches (and holds `text`), scrolled into view. */
function locateIn(page: Page, which: Which, selector: string, text?: string): Promise<At | null> {
  return inFrame<At | null>(
    page,
    which,
    `const want = ${JSON.stringify(text ?? null)};
    const el = [...d.querySelectorAll(${JSON.stringify(selector)})].filter(shown).find((e) => want === null || norm(e.textContent).includes(want) || (e.getAttribute("aria-label") || "").includes(want));
    if (!el) return null;
    // Into view inside the frame; an element's scrollIntoView scrolls the landing page too, which stays where it was.
    const pageX = scrollX, pageY = scrollY;
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    if (scrollX !== pageX || scrollY !== pageY) scrollTo(pageX, pageY);
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const at = d.elementFromPoint(x, y);
    const fr = f.getBoundingClientRect();
    if (fr.top < 0 || fr.bottom > innerHeight) f.scrollIntoView({ block: "nearest", behavior: "instant" });
    const fb = f.getBoundingClientRect();
    const cs = getComputedStyle(f);
    const sx = f.offsetWidth ? fb.width / f.offsetWidth : 1;
    const sy = f.offsetHeight ? fb.height / f.offsetHeight : 1;
    const X = fb.left + (f.clientLeft + parseFloat(cs.paddingLeft) + x) * sx;
    const Y = fb.top + (f.clientTop + parseFloat(cs.paddingTop) + y) * sy;
    const top = document.elementFromPoint(X, Y);
    return { x: X, y: Y, inView: X >= 0 && Y >= 0 && X <= innerWidth && Y <= innerHeight, covered: at && !(at === el || el.contains(at)) ? describe(at) : null, topCovered: top !== f ? describe(top) : null, label: describe(el) };`,
  );
}

/** A real press (a click, or a tap on a touch size) on an element in a frame; null, or why it could not press. */
async function pressIn(page: Page, which: Which, selector: string, text?: string): Promise<string | null> {
  const at = await locateIn(page, which, selector, text);
  if (!at) return `no shown ${selector}${text ? ` with "${text}"` : ""} in the ${which} frame`;
  if (!at.inView) return `${at.label} in the ${which} frame is outside the window`;
  if (at.covered) return `${at.label} in the ${which} frame is covered by ${at.covered}`;
  if (at.topCovered) return `the ${which} frame at ${at.label} is covered by the page's ${at.topCovered}`;
  await page.press(at.x, at.y);
  return null;
}

/** A real press on the landing page's own element: the index-th shown one that matches. */
async function pressTop(page: Page, selector: string, index = 0): Promise<string | null> {
  const at = await page
    .evaluate<{ x: number; y: number; covered: string | null; label: string } | null>(
      `(() => { ${PRE}
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((e) => shownIn(window, e))[${index}];
      if (!el) return null;
      el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const at = document.elementFromPoint(x, y);
      return { x, y, covered: at && !(at === el || el.contains(at)) ? describe(at) : null, label: describe(el) };
    })()`,
    )
    .catch(() => null);
  if (!at) return `no shown ${selector}${index ? ` number ${index + 1}` : ""} on the page`;
  if (at.covered) return `${at.label} is covered by ${at.covered}`;
  await page.press(at.x, at.y);
  return null;
}

async function typeText(page: Page, text: string) {
  for (const ch of text) {
    await page.send("Input.insertText", { text: ch });
    await sleep(20);
  }
}

/** Read until `ok` holds or `ms` passes; the last read either way. */
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms: number, every = 100): Promise<T> {
  const end = Date.now() + ms;
  let v = await read();
  while (!ok(v) && Date.now() < end) {
    await sleep(every);
    v = await read();
  }
  return v;
}

// ---------------------------------------------------------------------------------------------------------------
// One run: a language, a size and a theme

class Checks {
  rows: CheckRow[] = [];
  add(run: string, step: string, status: Status, text: string) {
    this.rows.push({ run, step, status, text });
    if (status !== "pass") console.log(`site-check: ${status === "fail" ? "FAIL" : "warn"} ${run}: ${step}: ${text}`);
  }
  /** One check: its pass text, or its fail text when `ok` is false. */
  that(run: string, step: string, ok: boolean, pass: string, fail: string) {
    this.add(run, step, ok ? "pass" : "fail", ok ? pass : fail);
    return ok;
  }
}

interface Ctx {
  cdp: Cdp;
  origin: string;
  base: string;
  out: string;
  checks: Checks;
  readme: Record<Lang, string | null>;
  upload: string;
  /** The run on screen and its browser context, for the browser-wide events (a service worker). */
  current: { run: string; contextId: string; step: () => string } | null;
}

/** Watch one page's events and those of every target attached under it: requests, sockets, workers, the console. */
function watchPage(ctx: Ctx, page: Page, run: string, step: () => string) {
  const children = new Set<string>();
  let requests = 0;
  const fail = (text: string) => ctx.checks.add(run, step(), "fail", clip(text, 240));
  const off = ctx.cdp.on((e) => {
    const own = e.sessionId === page.session;
    const child = e.sessionId !== undefined && children.has(e.sessionId);
    if (!own && !child) return;
    const p = e.params;
    switch (e.method) {
      case "Target.attachedToTarget": {
        const s = p.sessionId as string;
        children.add(s);
        const type = p.targetInfo?.type;
        if (type === "service_worker" || type === "shared_worker") fail(`a ${type.replace("_", " ")} started: ${p.targetInfo?.url}`);
        for (const m of ["Network.enable", "Runtime.enable", "Log.enable"]) void ctx.cdp.send(m, {}, s).catch(() => {});
        void ctx.cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, s).catch(() => {});
        void ctx.cdp.send("Runtime.runIfWaitingForDebugger", {}, s).catch(() => {});
        break;
      }
      case "Network.requestWillBeSent": {
        const url = String(p.request?.url ?? "");
        requests++;
        if (!requestAllowed(url, ctx.origin, ctx.base)) fail(`a request off the site: ${p.request?.method ?? "GET"} ${url}`);
        if (p.type === "EventSource") fail(`an EventSource: ${url}`);
        break;
      }
      case "Network.webSocketCreated":
        fail(`a WebSocket: ${p.url}`);
        break;
      // The page's own console, exceptions and statuses are Page's issues; a target under it reports here.
      case "Runtime.consoleAPICalled":
        if (child && (p.type === "error" || p.type === "assert")) fail(`console.${p.type} in a worker or frame: ${(p.args ?? []).map((a: any) => a.value ?? a.description ?? a.type).join(" ")}`);
        break;
      case "Runtime.exceptionThrown":
        if (child) fail(`uncaught in a worker or frame: ${p.exceptionDetails?.exception?.description?.split("\n")[0] ?? p.exceptionDetails?.text}`);
        break;
      case "Network.responseReceived":
        if (child && p.response?.status >= 400) fail(`HTTP ${p.response.status} ${p.response.url}`);
        break;
    }
  });
  return { off, requests: () => requests };
}

async function shot(page: Page, file: string, format: "png" | "jpeg" = "jpeg"): Promise<string> {
  const { data } = await page.send<{ data: string }>("Page.captureScreenshot", format === "png" ? { format } : { format, quality: 80 });
  await Bun.write(file, Buffer.from(data, "base64"));
  return file;
}

/** The whole page, about 800 pixels wide, in parts of 1,600 CSS px from the top (`<name>-1.jpg`, `<name>-2.jpg`, ...). */
async function fullShot(page: Page, vp: Viewport, name: (part: number) => string): Promise<string[]> {
  const m = await page.send<{ cssContentSize?: { height: number }; contentSize: { height: number } }>("Page.getLayoutMetrics");
  const height = Math.min(16000, Math.ceil(m.cssContentSize?.height ?? m.contentSize.height));
  const scale = Math.min(1, 800 / (vp.width * vp.scale));
  const files: string[] = [];
  for (let y = 0, part = 1; y < height; y += 1600, part++) {
    const clip = { x: 0, y, width: vp.width, height: Math.min(1600, height - y), scale };
    const { data } = await page.send<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 70, captureBeyondViewport: true, clip });
    await Bun.write(name(part), Buffer.from(data, "base64"));
    files.push(name(part));
  }
  await page.metrics();
  return files;
}

async function oneRun(ctx: Ctx, lang: Lang, vp: Viewport, theme: Theme): Promise<{ run: string; ms: number; shots: string[]; requests: number }> {
  const run = `${lang} ${sizeName(vp)} ${theme}`;
  const tag = `${lang}-${sizeName(vp)}-${theme}`;
  const t0 = Date.now();
  const wide = vp.width >= WIDE;
  const words = WORDS[lang];
  const other: Lang = lang === "en" ? "zh-CN" : "en";
  const C = ctx.checks;
  const shots: string[] = [];
  const out = (name: string, ext = "jpg") => join(ctx.out, `${tag}-${name}.${ext}`);
  let step = "load";
  const that = (ok: boolean, pass: string, fail: string) => C.that(run, step, ok, pass, fail);
  const failNow = (text: string) => C.add(run, step, "fail", text);
  const page = await Page.open(ctx.cdp, vp, theme);
  ctx.current = { run, contextId: page.contextId, step: () => step };
  const watch = watchPage(ctx, page, run, () => step);

  /** Page's console, exception and request issues, and the CSP violations, as failures of the step. */
  const sweep = async () => {
    for (const i of page.takeIssues()) failNow(clip(`${i.kind}: ${i.text}`, 240));
    const csp = await page.evaluate<string[]>("window.__siteCheck ? window.__siteCheck.csp.splice(0) : []").catch(() => [] as string[]);
    for (const v of csp) failNow(clip(`CSP violation: ${v}`, 240));
  };
  const readFrames = async () => (await page.evaluate<FrameInfo[]>(FRAMES(CHAT_TITLE)).catch(() => [] as FrameInfo[])) ?? [];
  const readFocus = async () => (await page.evaluate<Focus>(FOCUS).catch(() => null)) ?? { kind: "page", label: "nothing it could read" };
  /** The focus over a moment (the apps focus their own elements as they start, and after a card's answer). */
  const focusFor = async (ms: number) => {
    const reads: Focus[] = [];
    for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) reads.push(await readFocus());
    return { stray: reads.find((f) => f.kind === "hidden frame") ?? null, last: reads.at(-1) ?? null };
  };
  const readLanding = () => page.evaluate<LandingInfo>(LANDING);
  const pageUrl = (l: Lang) => `${ctx.origin}${ctx.base}${LANG_PATH[l]}`;

  try {
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: CSP_LISTENER });
    await page.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await page.send("DOM.enable").catch(() => {});

    // ---- the first screen
    step = "first screen";
    await page.navigate(pageUrl(lang));
    const want = wide ? 2 : 1;
    const frames = await until(readFrames, (fs) => fs.length >= want && fs.every((f) => f.up), 20000, 200);
    const L = await readLanding();
    that(L.lang === lang, `<html lang="${lang}">`, `<html lang> is "${L.lang}", not "${lang}"`);
    const line = ctx.readme[lang];
    that(line !== null && L.h1 === line, "the h1 is the README's line", `the h1 is ${JSON.stringify(L.h1)}, the README's line ${JSON.stringify(line)}`);
    that(!L.sideways, "nothing scrolls sideways", `the page scrolls sideways (${L.scrollWidth} > ${L.clientWidth})`);
    if (wide) that(L.noteBottom !== null && L.noteBottom <= L.innerHeight, `the stage fits (the note ends at ${L.noteBottom} of ${L.innerHeight})`, L.noteBottom === null ? "the note (.note) does not show" : `the note ends at ${L.noteBottom}, below the window's ${L.innerHeight}`);
    that(!L.imgsNoAlt.length, "every img has an alt", `img without an alt: ${L.imgsNoAlt.join(", ")}`);
    that(L.iframesNoTitle === 0, "every iframe has a title", `${L.iframesNoTitle} iframe(s) without a title`);
    that(!L.svgsUnnamed.length, "every svg is hidden or named", `svg with neither aria-hidden nor a title: ${L.svgsUnnamed.slice(0, 5).join(", ")}`);
    if (wide) {
      that(L.groupShown && L.radios.length === 2, `the device switch has two radios (${L.radios.map((r) => r.label).join(", ")})`, `the device switch (a radiogroup in .stage) ${L.groupShown ? `has ${L.radios.length} radios` : "does not show"}`);
      that(L.on === "phone" && L.radios[0]?.checked === "true" && L.radios[0]?.label === words.phone, "the phone shows first", `.device data-on is ${JSON.stringify(L.on)} and the first radio ${JSON.stringify(L.radios[0] ?? null)}`);
      const phone = frames.find((f) => f.role === "phone");
      const laptop = frames.find((f) => f.role === "laptop");
      that(!!phone && !!laptop, "a phone frame and a laptop frame", `the frames under .device are ${JSON.stringify(frames.map((f) => f.role))}`);
      if (phone) {
        that(phone.title === words.phoneTitle, `the phone frame's title "${phone.title}"`, `the phone frame's title is ${JSON.stringify(phone.title)}, not "${words.phoneTitle}"`);
        that(phone.shown, "the phone frame shows", "the phone frame does not show");
        that(Math.abs(phone.w - 390) <= 1 && phone.h >= 560, `the phone frame is ${phone.w}x${phone.h} inside`, `the phone frame is ${phone.w}x${phone.h} inside, not 390 wide and at least 560 tall`);
      }
      if (laptop) {
        const min = vp.width >= 1280 ? 1100 : 1088;
        that(laptop.title === words.laptopTitle, `the laptop frame's title "${laptop.title}"`, `the laptop frame's title is ${JSON.stringify(laptop.title)}, not "${words.laptopTitle}"`);
        that(laptop.w >= min && laptop.h >= 560, `the laptop frame is ${laptop.w}x${laptop.h} inside`, `the laptop frame is ${laptop.w}x${laptop.h} inside, not at least ${min}x560`);
        that(!laptop.shown && laptop.visibility === "hidden" && laptop.inert && laptop.ariaHidden, "the hidden laptop frame is hidden, inert and aria-hidden", `the laptop frame while the phone shows: visibility ${laptop.visibility}, inert ${laptop.inert}, aria-hidden ${laptop.ariaHidden}`);
      }
    } else {
      that(!L.groupShown, "no device switch on a phone", "the device switch shows on a phone");
      const full = frames.filter((f) => f.shown);
      that(full.length === 1, "one frame shows", `${full.length} frames show`);
      const f = full[0];
      if (f) {
        that(f.title === words.demoTitle, `the frame's title "${f.title}"`, `the full-width frame's title is ${JSON.stringify(f.title)}, not "${words.demoTitle}"`);
        that(Math.abs(f.w - vp.width) <= 1 && f.h >= 560, `the frame is ${f.w}x${f.h} inside`, `the full-width frame is ${f.w}x${f.h} inside, not ${vp.width} wide and at least 560 tall`);
      }
      for (const h of frames.filter((x) => !x.shown)) that(h.inert && h.ariaHidden, `the hidden ${h.role} frame is inert`, `a hidden ${h.role} frame is not inert and aria-hidden`);
    }
    for (const f of frames) {
      that(f.up, `the app is up in the ${f.role} frame (${f.path})`, `the ${f.role} frame shows no title bar with "${CHAT_TITLE}" (at ${f.path ?? "no document"})`);
      that(!f.sideways, `nothing scrolls sideways in the ${f.role} frame`, `the ${f.role} frame scrolls sideways`);
      that(!f.imgsNoAlt.length, `every img in the ${f.role} frame has an alt`, `img without an alt in the ${f.role} frame: ${f.imgsNoAlt.join(", ")}`);
    }
    shots.push(await shot(page, out("first", "png"), "png"));
    await sweep();

    // ---- the keyboard: nothing in a frame that does not show holds the focus; Tab starts at the top of the page and
    // goes from the device switch into the shown frame (DESIGN-W1 2.2)
    step = "keyboard";
    const early = await focusFor(1800);
    that(!early.stray, `after the load the focus stays out of the hidden frame (${early.last?.label})`, `after the load the focus is in ${early.stray?.label}, which does not show`);
    const walk: Focus[] = [];
    for (let i = 0; i < 8; i++) {
      await pressTab(page);
      const f = await readFocus();
      walk.push(f);
      if (f.kind === "frame" || f.kind === "hidden frame") break;
    }
    const tabs = walk.map((f) => f.label).join(", ");
    that(walk[0]?.kind === "mark", "the first Tab lands on the mark link", `the first Tab lands on ${walk[0]?.label ?? "nothing"} (${tabs})`);
    const into = walk.findIndex((f) => f.kind === "frame" || f.kind === "hidden frame");
    const enters = into > 0 && walk[into]!.kind === "frame" && (!wide || walk[into - 1]!.kind === "radio");
    that(enters, wide ? `Tab goes from the device switch into the shown frame (${tabs})` : `Tab goes into the demo's frame (${tabs})`, `Tab goes ${tabs}`);
    await page.evaluate("document.activeElement && document.activeElement.blur && document.activeElement.blur()").catch(() => {});

    // ---- the theme button: the page and its frames, and back
    step = "theme";
    const flipped: Theme = theme === "dark" ? "light" : "dark";
    for (const to of [flipped, theme]) {
      const why = await pressTop(page, ".top button[aria-pressed]");
      if (why) {
        failNow(why);
        break;
      }
      const after = await until(readLanding, (x) => x.theme === to, 2000);
      that(after.theme === to && after.pressed === String(to === "dark"), `the button sets ${to} (aria-pressed ${after.pressed})`, `after the press <html data-theme> is ${JSON.stringify(after.theme)} and aria-pressed ${JSON.stringify(after.pressed)}; expected ${to}`);
      const fs = await until(readFrames, (x) => x.every((f) => f.theme === to), 3000);
      that(fs.length > 0 && fs.every((f) => f.theme === to), `the frames follow (${to})`, `the frames' data-theme: ${JSON.stringify(fs.map((f) => `${f.role} ${f.theme}`))}; expected ${to}`);
    }
    await sweep();

    // ---- S1: the card answered on the phone
    step = "S1 card";
    const s1: Which = wide ? "phone" : "shown";
    const card = await until(() => frameText(page, s1), (t) => t.includes(CARD_TITLE), 8000, 200);
    if (that(card.includes(CARD_TITLE), `"${CARD_TITLE}" waits`, `the ${s1} frame does not show "${CARD_TITLE}"`)) {
      const before = await readFrames();
      const mine = before.find((f) => (wide ? f.role === "phone" : f.shown));
      that((mine?.waitingDots ?? 0) > 0, "the needs-you dot shows", "no needs-you dot (.dot.waiting) shows before the answer");
      const why = await pressIn(page, s1, '[data-testid="confirm-once"]');
      if (why) failNow(why);
      else {
        const t = await until(() => frameText(page, s1), (x) => x.includes(ALLOW_REPLY) && x.includes(ALLOWED_ONCE), 5000, 150);
        that(t.includes(ALLOWED_ONCE), `"${ALLOWED_ONCE}"`, `no "${ALLOWED_ONCE}" within 5 s of Allow once`);
        that(t.includes(ALLOW_REPLY), `"${ALLOW_REPLY}" within 5 s`, `no "${ALLOW_REPLY}" within 5 s of Allow once`);
        const fs = await until(readFrames, (x) => x.every((f) => f.waitingDots === 0), 3000);
        that(fs.every((f) => f.waitingDots === 0), "the needs-you dot is gone in every frame", `needs-you dots left: ${JSON.stringify(fs.map((f) => `${f.role} ${f.waitingDots}`))}`);
        // The answer reached the other device too, whose app would focus its message box: not while it is hidden.
        const kept = await focusFor(1500);
        that(!kept.stray, `after Allow once the focus stays out of the hidden frame (${kept.last?.label})`, `after Allow once the focus is in ${kept.stray?.label}, which does not show`);
      }
    }
    shots.push(await shot(page, out("s1")));
    await sweep();

    // ---- the device switch, and S2 on the laptop
    if (wide) {
      step = "device switch";
      const why = await pressTop(page, '.stage [role="radiogroup"] [role="radio"]', 1);
      if (why) failNow(why);
      const L2 = await until(readLanding, (x) => x.on === "laptop", 2000);
      that(L2.on === "laptop" && L2.radios[1]?.checked === "true" && L2.radios[1]?.label === words.laptop, `${words.laptop} shows the laptop`, `after the press .device data-on is ${JSON.stringify(L2.on)} and the radios ${JSON.stringify(L2.radios)}`);
      const fs = await readFrames();
      const phone = fs.find((f) => f.role === "phone");
      const laptop = fs.find((f) => f.role === "laptop");
      that(!!laptop?.shown, "the laptop frame shows", "the laptop frame does not show after the switch");
      that(!!phone && !phone.shown && phone.visibility === "hidden" && phone.inert && phone.ariaHidden, "the phone frame is hidden, inert and aria-hidden", `the phone frame after the switch: ${JSON.stringify(phone && { shown: phone.shown, visibility: phone.visibility, inert: phone.inert, ariaHidden: phone.ariaHidden })}`);
      await sleep(300);
      shots.push(await shot(page, out("laptop", "png"), "png"));
      await sweep();

      if (theme === "light") {
        step = "S2 review";
        // The diff's lines in view: each row's shown height in lines of its text (a long line wraps in the column).
        const view = () =>
          inFrame<{ text: string; kind: string | null; lines: number; rows: number; all: number; env: string | null; path: string }>(
            page,
            "laptop",
            `const v = [...d.querySelectorAll('[data-testid="changes-view"]')].find(shown);
            const env = [...d.querySelectorAll('[data-testid="side-environment"]')].find(shown);
            const path = w.location.pathname + w.location.search;
            if (!v) return { text: "", kind: null, lines: 0, rows: 0, all: 0, env: env ? norm(env.innerText) : null, path };
            const vr = v.getBoundingClientRect();
            const bottom = Math.min(vr.bottom, w.innerHeight);
            const all = [...v.querySelectorAll('[data-testid="changes-diff"] .chg-dl')];
            let lines = 0, rows = 0;
            for (const r of all) {
              const b = r.getBoundingClientRect();
              const h = Math.min(b.bottom, bottom) - Math.max(b.top, vr.top);
              if (h <= 0) continue;
              const t = w.getComputedStyle(r.querySelector(".chg-lt") || r);
              const lh = parseFloat(t.lineHeight) || parseFloat(t.fontSize) * 1.4 || 18;
              lines += Math.floor(h / lh + 0.25);
              if (b.top >= vr.top - 1 && b.bottom <= bottom + 1) rows++;
            }
            return { text: norm(v.innerText).slice(0, 400), kind: v.getAttribute("data-view"), lines, rows, all: all.length, env: env ? norm(env.innerText) : null, path };`,
          );
        const v1 = await until(view, (x) => !!x && x.lines >= 12, 5000, 200);
        that(!!v1 && v1.text.includes(FIRST_FILE) && v1.lines >= 12, `the side panel shows ${FIRST_FILE}: ${v1?.lines} diff lines in view (${v1?.rows} rows)`, `the side panel's diff: ${JSON.stringify(v1 && { path: v1.path, kind: v1.kind, lines: v1.lines, rows: v1.rows, all: v1.all, text: v1.text.slice(0, 120) })}; expected ${FIRST_FILE} with at least 12 lines in view`);
        that(!!v1?.env && new RegExp(`\\b${DEMO_HOST}\\b`).test(v1.env), `the Environment card names ${DEMO_HOST}`, `the Environment card ${v1?.env ? `reads ${JSON.stringify(clip(v1.env, 100))}` : "does not show"}; expected ${DEMO_HOST}`);
        const chat = await frameText(page, "laptop", '[data-testid="conversation"]');
        that(chat.includes(ALLOW_REPLY), "the laptop's chat has S1's answer", `the laptop's chat does not show "${ALLOW_REPLY}" (one chat on every device)`);
        const why2 = await pressIn(page, "laptop", '[data-testid="changes-row"]', SECOND_FILE);
        if (why2) failNow(why2);
        else {
          const v2 = await until(view, (x) => !!x && x.kind === "file" && x.text.includes(SECOND_FILE) && x.all > 0, 4000, 150);
          that(!!v2 && v2.kind === "file" && v2.text.includes(SECOND_FILE) && v2.all > 0, `the card's row opens ${SECOND_FILE}'s diff (${v2?.all} rows)`, `after the row ${SECOND_FILE}: ${JSON.stringify(v2 && { path: v2.path, kind: v2.kind, all: v2.all, text: v2.text.slice(0, 120) })}`);
        }
        shots.push(await shot(page, out("s2")));
        await sweep();
      }
    }

    const scenes = theme === "light" && (vp.width === 1280 || !wide);
    const dev: Which = wide ? "laptop" : "shown";
    /**
     * The example chat in a frame, at its end: where it is already, else by its own link (the list's row), else by the
     * router; then the chat's own Jump to latest when it shows, as a visitor would press it.
     */
    const openChat = async (which: Which) => {
      const chat = `/c/${EXAMPLE_CHAT}`;
      const at = await framePath(page, which);
      const there = (at === chat || at.startsWith(`${chat}/m/`) || at.startsWith(`${chat}?`)) && (await locateIn(page, which, '[data-testid="composer-input"]'));
      if (!there) {
        if (await pressIn(page, which, `a[href="${chat}"]`)) await frameGo(page, which, chat);
        else await sleep(400);
      }
      if (await locateIn(page, which, ".chat-jump")) {
        await pressIn(page, which, ".chat-jump");
        await sleep(400);
      }
    };

    // ---- S3: search
    if (scenes) {
      step = "S3 search";
      const button = 'a[aria-label="Search"], button[aria-label="Search"]';
      if (!(await locateIn(page, dev, button))) await frameGo(page, dev, "/chats");
      let why = await pressIn(page, dev, button);
      if (!why) {
        const field = await until(() => locateIn(page, dev, '[data-testid="search-input"]'), (x) => !!x, 3000);
        why = field ? await pressIn(page, dev, '[data-testid="search-input"]') : `Search opened no search field (at ${await framePath(page, dev)})`;
      }
      if (why) failNow(why);
      else {
        await typeText(page, SEARCH_WORD);
        const hits = () => inFrame<number>(page, dev, `return [...d.querySelectorAll('.srch-group[data-kind="messages"] [role="option"]')].filter(shown).length;`);
        const n = (await until(hits, (x) => (x ?? 0) >= 2, 6000, 200)) ?? 0;
        that(n >= 2, `Messages has ${n} hits for "${SEARCH_WORD}"`, `Messages has ${n} hits for "${SEARCH_WORD}", not at least two`);
        shots.push(await shot(page, out("s3")));
        if (n) {
          const why2 = await pressIn(page, dev, '.srch-group[data-kind="messages"] [role="option"]');
          if (why2) failNow(why2);
          else {
            const p = await until(() => framePath(page, dev), (x) => x.startsWith("/c/") && !/\/search\b/.test(x), 4000);
            const shownChat = await inFrame<boolean>(page, dev, `return [...d.querySelectorAll('[data-testid="conversation"]')].some(shown);`);
            that(p.startsWith("/c/") && !!shownChat, `the first hit opens its chat (${p})`, `the first hit left the frame at ${p}${shownChat ? "" : " with no conversation shown"}`);
          }
        }
      }
      await sweep();
    }

    // ---- S4: a send, and the scripted reply that streams in
    if (scenes) {
      step = "S4 send";
      await openChat(dev);
      const reply = DEMO_REPLIES[lang].replace(/\s+/g, " ").trim();
      const read = () => frameText(page, dev, '[data-testid="conversation"]');
      const box = await until(() => locateIn(page, dev, '[data-testid="composer-input"]'), (x) => !!x, 4000);
      let why = box ? await pressIn(page, dev, '[data-testid="composer-input"]') : `no message box in the ${dev} frame`;
      const from = shownPrefix(await read(), reply);
      if (!why) {
        await typeText(page, MESSAGE);
        why = await pressIn(page, dev, '[data-testid="composer-send"], [data-testid="confirm-send"]');
      }
      if (why) failNow(why);
      else {
        const t1 = Date.now();
        const reads: number[] = [];
        let bubble = false;
        let text = "";
        // Reads 50 ms apart, so a reply that grows a word at a time grows over many of them (S4_GROWS).
        while (Date.now() - t1 < 6000) {
          await sleep(50);
          text = await read();
          bubble ||= text.includes(MESSAGE);
          const n = shownPrefix(text, reply);
          reads.push(n);
          if (n >= reply.length) break;
        }
        const ms = Date.now() - t1;
        const whole = reads.at(-1) === reply.length;
        const grew = growingReads(reads, from, reply.length);
        that(bubble, "the message shows", `the sent message "${MESSAGE}" does not show`);
        that(whole, `the scripted reply is whole after ${ms} ms`, `the scripted reply is not whole within 6 s (${reads.at(-1) ?? 0} of ${reply.length} characters)`);
        that(grew >= S4_GROWS, `the reply grew over ${grew} reads 50 ms apart (${JSON.stringify(reads)} of ${reply.length})`, `the reply grew over ${grew} reads 50 ms apart, not at least ${S4_GROWS} (${JSON.stringify(reads)} of ${reply.length})`);
      }
      shots.push(await shot(page, out("s4")));
      await sweep();
    }

    // ---- S5: what does not run, each with its line in place (the laptop)
    if (theme === "light" && vp.width === 1280) {
      step = "S5 lines";
      const sees = async (key: keyof typeof DEMO_LINES, what: string) => {
        const t = await until(() => frameText(page, "laptop"), (x) => x.includes(DEMO_LINES[key]), 6000, 200);
        that(t.includes(DEMO_LINES[key]), `${what}: "${DEMO_LINES[key]}"`, `${what} does not show "${DEMO_LINES[key]}" (at ${await framePath(page, "laptop")})`);
        shots.push(await shot(page, out(`s5-${key}`)));
      };
      await frameGo(page, "laptop", `/c/${EXAMPLE_CHAT}/shell`);
      await sees("terminal", "the Terminal pane");

      await frameGo(page, "laptop", "/settings/about");
      const check = await until(() => locateIn(page, "laptop", '[data-testid="check-now"]'), (x) => !!x, 4000);
      const why = check ? await pressIn(page, "laptop", '[data-testid="check-now"]') : "Settings > About shows no Check now";
      if (why) failNow(why);
      else {
        await sees("update", "Check now");
        // The line is Check now's own (a refused check, in its row), not the screen's notice that follows elsewhere.
        const row = await frameText(page, "laptop", '[data-testid="setting-check-now"]');
        const notice = await frameText(page, "laptop", ".set-notice");
        that(row.includes(DEMO_LINES.update) && !notice.includes(DEMO_LINES.update), "Check now's line is in its own row", `Check now's line: in its row ${row.includes(DEMO_LINES.update)}, as the notice ${notice.includes(DEMO_LINES.update)}`);
      }

      await frameGo(page, "laptop", "/settings/notifications");
      await sees("notifications", "Settings > Notifications");
      const elsewhere = await frameText(page, "laptop");
      that(!elsewhere.includes(DEMO_LINES.update), "Check now's line stays in About", `Settings > Notifications shows Check now's line "${DEMO_LINES.update}" too`);

      await openChat("laptop");
      const box = await until(() => locateIn(page, "laptop", '[data-testid="composer-input"]'), (x) => !!x, 4000);
      const why2 = box ? await pressIn(page, "laptop", '[data-testid="composer-input"]') : "no message box in the laptop frame";
      if (why2) failNow(why2);
      else {
        await typeText(page, "!ls");
        await page.key("Enter");
        await sees("commands", "A ! command");
      }

      const input = await page.send<{ result?: { objectId?: string } }>("Runtime.evaluate", {
        expression: `(() => { ${PRE} const f = frameOf("laptop"); const d = f && f.contentDocument; return d ? d.querySelector('[data-testid="composer-file-input"]') : null; })()`,
        returnByValue: false,
      });
      const objectId = input.result?.objectId;
      if (!objectId) failNow("the laptop frame's message box has no file input (composer-file-input)");
      else {
        const set = await page.send("DOM.setFileInputFiles", { files: [ctx.upload], objectId }).then(
          () => null,
          (e: Error) => e.message,
        );
        void page.send("Runtime.releaseObject", { objectId }).catch(() => {});
        if (set) failNow(`the file could not be set on the file input: ${set}`);
        else await sees("files", "A file added");
      }

      // A download: the Outputs card's Download beside upload.ts, then the file's own view.
      await frameGo(page, "laptop", START_ROUTES.laptop);
      const dl = '[aria-label="Download upload.ts"]';
      const where = await until(() => locateIn(page, "laptop", dl), (x) => !!x, 4000);
      const why3 = where ? await pressIn(page, "laptop", dl) : `the laptop frame shows no ${dl} (at ${await framePath(page, "laptop")})`;
      if (why3) failNow(why3);
      else await sees("downloads", "Download in Outputs");
      await frameGo(page, "laptop", `/c/${EXAMPLE_CHAT}/files/src/upload.ts`);
      const view = await until(() => frameText(page, "laptop", '[data-testid="file-download"]'), (t) => t.includes(DEMO_LINES.downloads), 4000);
      that(view.includes(DEMO_LINES.downloads), `the file's own view: "${DEMO_LINES.downloads}"`, `the file's view of src/upload.ts reads ${JSON.stringify(clip(view, 100))}, not "${DEMO_LINES.downloads}"`);
      await sweep();
    }

    // ---- the whole page, then the language link there and back
    step = "whole page";
    const type = await page.evaluate<{ code: string | null; pre: string | null }>(`(() => { const c = document.querySelector(".cmd code"), p = document.querySelector(".cmd pre"); return { code: c ? getComputedStyle(c).fontSize : null, pre: p ? getComputedStyle(p).fontSize : null }; })()`);
    that(!!type.code && type.code === type.pre, `the commands are at their blocks' size (${type.code})`, `the commands are ${type.code}, their blocks ${type.pre}`);
    await page.evaluate("window.scrollTo(0, 0)").catch(() => {});
    shots.push(...(await fullShot(page, vp, (part) => out(`page-${part}`))));
    await sweep();

    step = "language link";
    const hop = async (from: Lang, to: Lang) => {
      const before = await readLanding();
      if (!that(before.hreflang?.lang === to, `the language link goes to ${to}`, `the top bar's language link (a[hreflang]) is ${JSON.stringify(before.hreflang)}, not to ${to}`)) return false;
      await sweep();
      const load = ctx.cdp.expect("Page.loadEventFired", { sessionId: page.session, timeoutMs: 20000 });
      const why = await pressTop(page, ".top a[hreflang]");
      if (why) {
        load.cancel();
        failNow(why);
        return false;
      }
      await load.promise.catch(() => null);
      await page.metrics();
      await page.settle();
      const after = await readLanding();
      return that(after.path === `${ctx.base}${LANG_PATH[to]}` && after.lang === to, `${from} to ${to}: ${after.path}`, `the language link from ${from} opened ${after.path} with lang "${after.lang}", not ${ctx.base}${LANG_PATH[to]} with "${to}"`);
    };
    if (await hop(lang, other)) await hop(other, lang);
    await until(readFrames, (fs) => fs.length > 0 && fs.every((f) => f.up), 15000, 200);

    step = "end";
    const sw = await page.evaluate<number>("(async () => navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).length : 0)()").catch(() => 0);
    that(sw === 0, "no service worker", `${sw} service worker registration(s)`);
    await sweep();
    that(true, `${watch.requests()} requests checked`, "");
  } finally {
    watch.off();
    ctx.current = null;
    await page.close();
  }
  return { run, ms: Date.now() - t0, shots, requests: watch.requests() };
}

/** A page without script: the demo's one line in the device's place, and no note, switch, theme button or frame. */
async function noScriptRun(ctx: Ctx, lang: Lang, vp: Viewport, theme: Theme): Promise<{ run: string; ms: number; shots: string[]; requests: number }> {
  const run = `${lang} ${sizeName(vp)} ${theme} without script`;
  const t0 = Date.now();
  const step = "no script";
  const C = ctx.checks;
  const that = (ok: boolean, pass: string, fail: string) => C.that(run, step, ok, pass, fail);
  const page = await Page.open(ctx.cdp, vp, theme);
  ctx.current = { run, contextId: page.contextId, step: () => step };
  const watch = watchPage(ctx, page, run, () => step);
  const shots: string[] = [];
  try {
    await page.send("Emulation.setScriptExecutionDisabled", { value: true });
    await page.navigate(`${ctx.origin}${ctx.base}${LANG_PATH[lang]}`);
    await page.settle();
    const r = await page.evaluate<{ line: boolean; text: string; note: boolean; seg: boolean; theme: boolean; frames: number }>(`(() => {
      const shown = (s) => { const e = document.querySelector(s); return !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden"; };
      const line = document.querySelector(".no-script");
      return { line: shown(".no-script"), text: line ? line.textContent.trim() : "", note: shown(".note"), seg: shown(".stage .seg"), theme: shown(".theme-btn"), frames: document.querySelectorAll("iframe").length };
    })()`);
    const words = WORDS[lang];
    that(r.line && r.text === words.noScript, `"${words.noScript}" in the device's place`, `the no-script line ${r.line ? `reads ${JSON.stringify(r.text)}` : "does not show"}`);
    that(!r.note, "the demo's note does not show", `the demo's note "${words.note}" shows, about a demo that is not there`);
    that(!r.seg && !r.theme && r.frames === 0, "no device switch, theme button or frame", `without script: switch ${r.seg}, theme button ${r.theme}, ${r.frames} frame(s)`);
    shots.push(await shot(page, join(ctx.out, `${lang}-${sizeName(vp)}-${theme}-noscript.png`), "png"));
    for (const i of page.takeIssues()) C.add(run, step, "fail", clip(`${i.kind}: ${i.text}`, 240));
    that(true, `${watch.requests()} requests checked`, "");
  } finally {
    watch.off();
    ctx.current = null;
    await page.close();
  }
  return { run, ms: Date.now() - t0, shots, requests: watch.requests() };
}

// ---------------------------------------------------------------------------------------------------------------
// Main

export async function main(argv: readonly string[]): Promise<number> {
  let args: Args;
  try {
    const a = parseArgs(argv);
    if (a === "help") {
      console.log(USAGE);
      return 0;
    }
    args = a;
  } catch (e) {
    if (e instanceof ArgError) {
      console.error(`site-check: ${e.message}`);
      return 2;
    }
    throw e;
  }
  const cannot = (line: string) => {
    console.error(`site-check: ${line}`);
    return 2;
  };
  for (const l of args.langs) if (!existsSync(join(args.site, LANG_PATH[l], "index.html"))) return cannot(`${args.site} holds no ${LANG_PATH[l]}index.html: build the site first (bun scripts/build-site.ts --out <folder>)`);
  const devtools = args.port + DEVTOOLS_OFFSET;
  if (!portFree(devtools)) return cannot(`Chrome's DevTools port ${devtools} is in use`);
  const binary = args.chrome ?? findChrome();
  if (!binary) return cannot("no Chrome found; pass --chrome <binary> or set CHROME_PATH");
  mkdirSync(args.out, { recursive: true });
  const upload = join(args.out, UPLOAD_NAME);
  writeFileSync(upload, "A small text file that the site check adds to the demo's message box.\n");
  const readme = {} as Record<Lang, string | null>;
  for (const l of LANGS) readme[l] = readmeLine(readFileSync(join(ROOT, README_FILE[l]), "utf8"));

  let server: SiteServer;
  try {
    server = startSiteServer({ root: args.site, port: args.port, base: args.base });
  } catch (e) {
    return cannot(`could not serve the site on 127.0.0.1:${args.port}: ${(e as Error).message}`);
  }
  let chrome: OwnChrome | null = null;
  let cdp: Cdp | null = null;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    cdp?.close();
    await chrome?.stop();
    server.stop();
  };
  const onSignal = (code: number) => () => void stop().finally(() => process.exit(code));
  process.once("SIGINT", onSignal(130));
  process.once("SIGTERM", onSignal(143));

  const t0 = Date.now();
  const checks = new Checks();
  const runs: { run: string; ms: number; shots: string[]; requests: number }[] = [];
  let product = "";
  try {
    try {
      chrome = await launchChrome(binary, devtools, { extraArgs: [FINE_POINTER] });
      cdp = await Cdp.connect(chrome.wsUrl);
    } catch (e) {
      await stop();
      return cannot(`could not start ${binary}: ${(e as Error).message}`);
    }
    product = (await cdp.send<{ product: string }>("Browser.getVersion")).product;
    const ctx: Ctx = { cdp, origin: server.origin, base: args.base, out: args.out, checks, readme, upload, current: null };
    // A service worker or shared worker anywhere in the run's browser context fails that run.
    await cdp.send("Target.setDiscoverTargets", { discover: true });
    cdp.on((e) => {
      if (e.method !== "Target.targetCreated" || e.sessionId) return;
      const info = e.params.targetInfo ?? {};
      if ((info.type === "service_worker" || info.type === "shared_worker") && ctx.current && info.browserContextId === ctx.current.contextId) checks.add(ctx.current.run, ctx.current.step(), "fail", `a ${String(info.type).replace("_", " ")} started: ${info.url}`);
    });
    console.log(`site-check: ${args.site} at ${server.origin}${args.base} with ${product} (DevTools on ${devtools}); ${args.langs.join(", ")}; ${args.sizes.map(sizeName).join(", ")}; ${args.themes.join(", ")}`);
    for (const lang of args.langs)
      for (const vp of args.sizes)
        for (const theme of args.themes) {
          const run = `${lang} ${sizeName(vp)} ${theme}`;
          const before = checks.rows.length;
          try {
            runs.push(await oneRun(ctx, lang, vp, theme));
          } catch (e) {
            checks.add(run, "run", "fail", `the run could not finish: ${(e as Error).message}`);
          }
          const mine = summarize(checks.rows.slice(before));
          console.log(`site-check: ${run}: ${mine.passed} passed, ${mine.failed} failed`);
          if (cdp.closed) {
            checks.add(run, "run", "fail", "the browser went away");
            break;
          }
        }
    for (const lang of args.langs) {
      if (cdp.closed) break;
      const run = `${lang} ${sizeName(args.sizes[0]!)} ${args.themes[0]!} without script`;
      const before = checks.rows.length;
      try {
        runs.push(await noScriptRun(ctx, lang, args.sizes[0]!, args.themes[0]!));
      } catch (e) {
        checks.add(run, "run", "fail", `the run could not finish: ${(e as Error).message}`);
      }
      const mine = summarize(checks.rows.slice(before));
      console.log(`site-check: ${run}: ${mine.passed} passed, ${mine.failed} failed`);
    }
  } finally {
    await stop();
  }
  const summary = summarize(checks.rows);
  const asked = Object.fromEntries([...server.asked.entries()].sort(([a], [b]) => a.localeCompare(b)));
  const report = { site: args.site, origin: server.origin, base: args.base, chrome: product, seconds: Math.round((Date.now() - t0) / 1000), summary: { total: summary.total, passed: summary.passed, failed: summary.failed, warned: summary.warned }, failures: summary.failures, runs, asked, checks: checks.rows };
  writeFileSync(join(args.out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`${summary.line}; ${report.seconds} s; report ${join(args.out, "report.json")}`);
  return summary.failed ? 1 : 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
