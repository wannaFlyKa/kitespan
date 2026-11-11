// The search performance gate (DESIGN.md 9.3 done check 2; build checklist E1 to E3): keystroke p95 under 50 ms at
// 100,000 rows, run 3 times. A script of its own, never inside ui-check's parallel pages: it boots the click-through
// harness once on the search scene (test/click/seed/search.ts: a chat whose folder lists 100,000 paths, and one of
// 20,000), starts its own headless Chrome for Testing, and for each run opens a fresh page in a browser context of its
// own (a kept page would carry its matcher's narrowing into the next run).
//
// A run: open the chat; open the surface (the search pane with Ctrl+K, or the `@` picker with a typed "@" in the
// composer); wait until its list shows the folder's whole count; 8 warm-up keys; the calibration and the load average;
// 108 keys in a closed loop (each key waits for its painted list, then a seeded 0 to 16.7 ms jitter, so keys land at
// any phase of the frame, as a typist's do); the load average again, the Event Timing entries and the long animation
// frames. The warm-up keys are the first keys typed after the surface opened (the first of them is the first query the
// filter answers): their key to list and key to commit are kept in report.json and printed beside the run's p95 as
// information, never in a verdict. A key's latency runs from its keydown's timeStamp to the first frame after the
// commit in which the list's `data-q` equals the field's query (requestAnimationFrame, then a MessageChannel message
// posted inside it, which runs after that frame's rendering). The measuring script goes in with
// Page.addScriptToEvaluateOnNewDocument and reports through Runtime.addBinding; it reads only the page's events and the
// list's `data-q`, `data-count` and rows, so no timing code goes in the app.
//
// Sizes (E2): 1100x800 with a fine pointer at 100,000 rows (the page's own filter), 390x844 with touch at 100,000 rows
// (over the touch limit of 20,000 paths, so the server's filter, and the number includes a loopback round trip), and
// 390x844 at 20,000 rows (the page's filter on the phone). Each for the search pane and the `@` picker. After each
// surface and size's runs, one phase-locked run (no jitter: each key right after the last paint, the pessimistic
// bound) is printed as information; --throttle adds one throttled run on each touch size, also information only.
//
// The verdict (E3): a run fails when its p95 is 50 ms or more, a key never painted its query, a list drew more than 120
// rows, the filter ran on the other side, or the page logged an error. A run is "loaded" when the host's 1-minute load
// is over half its CPUs or its calibration (a fixed scan of 100,000 strings, in a page of its own) is over 1.25 times
// the baseline; a loaded run that fails on its p95 runs once more, and both are printed. The gate passes when each
// surface and size has every one of its runs under 50 ms. It prints one line per run and the verdict, writes
// report.json (every key, the Chrome version, the kitespan commit, each run's Event Timing and long frames) in --out,
// and exits 1 on a failure (2 when it cannot run).
//
// The fake claude only (the harness); the server on the given test port and Chrome on a free port from 9341 to 9349,
// both stopped at the end by the processes this script started.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { boot, buildPage, checkPort, ROOT, type Booted } from "../test/click/harness";
import { GATE_IDS } from "../test/click/seed/ids";
import { GATE, type GateKey } from "../test/click/seed/search";
import { Cdp, sleep } from "./lib/cdp";
import { findChrome, freePort, launchChrome, type OwnChrome } from "./lib/chrome";
import { Page, VIEWPORTS, type Viewport } from "./lib/page";

const USAGE = `Usage: bun scripts/search-gate.ts --port <7941-7949> --out <folder> [options]

  --port <port>       the test port the harness boots kitespan on (7941 to 7949)
  --out <folder>      where report.json goes
  --runs <n>          counted runs per surface and size (default 3; the gate's verdict needs 3)
  --sizes <list>      laptop,phone,phone-20k (default all three)
  --surfaces <list>   pane,picker (default both)
  --dist <folder>     a built page to serve (default: build web/index.html into a scratch folder)
  --chrome <binary>   the Chrome for Testing to start (default: CHROME_PATH, PATH, then the usual install caches)
  --baseline <ms>     the host's calibration baseline (default: measured once at the start)
  --seed <n>          the jitter's seed (default 7)
  --throttle <rate>   also one run at this CPU throttle on each touch size (information only)
  --no-locked         leave out the phase-locked run (information only)`;

// ---------------------------------------------------------------------------------------------------------------
// Arguments

function fail(line: string): never {
  console.error(`search-gate: ${line}`);
  process.exit(2);
}

const FLAGS = new Set(["no-locked"]);
const KNOWN = new Set(["port", "out", "runs", "sizes", "surfaces", "dist", "chrome", "baseline", "seed", "throttle", ...FLAGS]);
const args: Record<string, string> = {};
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") {
      console.log(USAGE);
      process.exit(0);
    }
    if (!a.startsWith("--")) fail(`unexpected argument "${a}" (see --help)`);
    const name = a.slice(2);
    if (!KNOWN.has(name)) fail(`unknown option ${a} (see --help)`);
    if (FLAGS.has(name)) {
      args[name] = "1";
      continue;
    }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) fail(`${a} needs a value (see --help)`);
    args[name] = v;
    i++;
  }
}
if (!args.port) fail("--port is required (see --help)");
if (!args.out) fail("--out is required (see --help)");
const PORT = Number(args.port);
try {
  checkPort(PORT);
} catch (e) {
  fail((e as Error).message);
}
const OUT = resolve(args.out);

function number(name: string, dflt: number, ok: (n: number) => boolean, what: string): number {
  if (args[name] === undefined) return dflt;
  const n = Number(args[name]);
  if (!ok(n)) fail(`--${name} must be ${what}`);
  return n;
}
const RUNS = number("runs", 3, (n) => Number.isInteger(n) && n >= 1 && n <= 20, "a whole number from 1 to 20");
const SEED = number("seed", 7, (n) => Number.isInteger(n) && n >= 0, "a whole number");
const BASELINE = args.baseline === undefined ? null : number("baseline", 0, (n) => Number.isFinite(n) && n > 0, "a time in ms over 0");
const THROTTLE = args.throttle === undefined ? null : number("throttle", 1, (n) => Number.isFinite(n) && n > 1 && n <= 20, "a rate over 1, at most 20");
const LOCKED = !args["no-locked"];

function list<T extends string>(raw: string | undefined, all: readonly T[], what: string): T[] {
  if (!raw) return [...all];
  const items = raw.split(",").map((s) => s.trim()).filter(Boolean);
  for (const i of items) if (!all.includes(i as T)) fail(`unknown ${what} "${i}"; use ${all.join(", ")}`);
  return all.filter((a) => items.includes(a));
}

// ---------------------------------------------------------------------------------------------------------------
// Sizes and surfaces

type SizeId = "laptop" | "phone" | "phone-20k";
type Surface = "pane" | "picker";
type Filter = "page" | "server";

interface Size {
  id: SizeId;
  vp: Viewport;
  gate: GateKey;
  /** Where the filter must run here (shared/corpus.ts: the page holds 100,000 paths on a laptop, 20,000 on touch). */
  filter: Filter;
}

const vpOf = (name: Viewport["name"]) => VIEWPORTS.find((v) => v.name === name)!;
const SIZE: Record<SizeId, Size> = {
  laptop: { id: "laptop", vp: vpOf("laptop"), gate: "big", filter: "page" },
  phone: { id: "phone", vp: vpOf("phone"), gate: "big", filter: "server" },
  "phone-20k": { id: "phone-20k", vp: vpOf("phone"), gate: "phone", filter: "page" },
};
const SIZES = list(args.sizes, ["laptop", "phone", "phone-20k"] as const, "size").map((s) => SIZE[s]);
const SURFACES = list(args.surfaces, ["pane", "picker"] as const, "surface");

const SURFACE_NAME: Record<Surface, string> = { pane: "search pane", picker: "@ picker" };
const sizeLabel = (s: Size) => `${s.vp.width}x${s.vp.height}${s.vp.touch ? " touch" : ""}`;
const rowsLabel = (s: Size) => `${GATE[s.gate].rows.toLocaleString("en-US")} rows`;

/** The field and the list each surface types into and paints; the picker's query is the text after its "@". */
const HOOKS: Record<Surface, { field: string; list: string; strip: string | null }> = {
  pane: { field: '[data-testid="search-input"]', list: '[data-testid="search-results"]', strip: null },
  picker: { field: '[data-testid="composer"] [data-testid="composer-input"]', list: '[data-testid="mention-menu"]', strip: "@" },
};

// ---------------------------------------------------------------------------------------------------------------
// The keys: the same fixed script in every run (build checklist E1's 108 keys: typing runs and Backspace runs, a "/"
// and a ".", a query that matches nothing, and an empty query at the end), after 8 warm-up keys that are not counted.
// Every key changes the query, so every key has a paint to wait for.

type Op = { type: string } | { back: number };
const SCRIPT: Op[] = [
  { type: "srcchatcomposer" },
  { back: 7 },
  { type: "ards" },
  { back: 12 },
  { type: "test/unit" },
  { back: 5 },
  { type: ".tsx" },
  { back: 8 },
  { type: "zzq" },
  { back: 3 },
  { type: "webpanels" },
  { back: 9 },
  { type: "sheetmenu" },
  { back: 9 },
  { type: "a" },
  { back: 1 },
];
const WARM: Op[] = [{ type: "warm" }, { back: 4 }];

interface Key {
  key: string;
  code: string;
  vk: number;
  text?: string;
  /** CDP's bit field: 2 Ctrl, 4 Meta, 8 Shift. */
  modifiers?: number;
}
interface ScriptKey {
  key: Key;
  /** The query after this key (the list's `data-q` to wait for). */
  q: string;
}

const BACKSPACE: Key = { key: "Backspace", code: "Backspace", vk: 8 };
const ESCAPE: Key = { key: "Escape", code: "Escape", vk: 27 };
const CTRL_K: Key = { key: "k", code: "KeyK", vk: 75, modifiers: 2 };
const AT: Key = { key: "@", code: "Digit2", vk: 50, text: "@", modifiers: 8 };

function charKey(ch: string): Key {
  if (/^[a-z]$/.test(ch)) return { key: ch, code: `Key${ch.toUpperCase()}`, vk: ch.toUpperCase().charCodeAt(0), text: ch };
  if (ch === "/") return { key: ch, code: "Slash", vk: 191, text: ch };
  if (ch === ".") return { key: ch, code: "Period", vk: 190, text: ch };
  throw new Error(`the key script has no key for "${ch}"`);
}

function keysOf(ops: Op[]): ScriptKey[] {
  const out: ScriptKey[] = [];
  let q = "";
  for (const op of ops) {
    if ("type" in op)
      for (const ch of op.type) {
        q += ch;
        out.push({ key: charKey(ch), q });
      }
    else
      for (let i = 0; i < op.back; i++) {
        if (!q) throw new Error("the key script deletes past an empty query: that key would change nothing");
        q = q.slice(0, -1);
        out.push({ key: BACKSPACE, q });
      }
  }
  if (q !== "") throw new Error("the key script must end on an empty query");
  return out;
}
const KEYS = keysOf(SCRIPT);
const WARM_KEYS = keysOf(WARM);

/** The field's whole text for a query: the picker's has its "@" before it. */
const fieldText = (surface: Surface, q: string) => (HOOKS[surface].strip ?? "") + q;

/** A seeded jitter of 0 to 16.7 ms (one frame) before each closed-loop key. */
function jitter(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 16.7;
  };
}

// ---------------------------------------------------------------------------------------------------------------
// In the page

const BINDING = "__gateReport";

/**
 * The measuring script, in every document of a run's page before the app's own scripts. It does nothing until the
 * driver arms it with the surface's field and list. keydown (capture) keeps the key's timeStamp; input on the field
 * keeps {query, value, key, input} and marks the echo (the next frame); a MutationObserver sees the list's `data-q`
 * change (the commit), marks the next frame after it and reports. Event Timing (16 ms and over) and long animation
 * frames are kept for the run's report.
 */
const GATE_SCRIPT = `(() => {
  if (window.top !== window || window.__gate) return;
  const g = { armed: null, list: null, seen: undefined, lastKey: null, recs: new Map(), et: [], loaf: [] };
  window.__gate = g;
  const report = (o) => { try { window.${BINDING}(JSON.stringify(o)); } catch {} };
  const afterPaint = (cb) => requestAnimationFrame(() => {
    const tRaf = performance.now();
    const ch = new MessageChannel();
    ch.port1.onmessage = () => cb(tRaf, performance.now());
    ch.port2.postMessage(0);
  });
  const queryOf = (field) => {
    const strip = g.armed.strip;
    if (!strip) return field.value;
    const before = field.value.slice(0, field.selectionStart == null ? field.value.length : field.selectionStart);
    const at = before.lastIndexOf(strip);
    return at < 0 ? null : before.slice(at + strip.length);
  };
  addEventListener("keydown", (e) => { g.lastKey = e.timeStamp; }, true);
  addEventListener("input", (e) => {
    const t = e.target;
    if (!g.armed || !t || !t.matches || !t.matches(g.armed.field)) return;
    const rec = { q: queryOf(t), value: t.value, tKey: g.lastKey, tInput: e.timeStamp, tEcho: null };
    g.lastKey = null;
    if (rec.q !== null) g.recs.set(rec.q, rec);
    afterPaint((tRaf, tPaint) => { rec.tEcho = tPaint; });
  }, true);
  const check = () => {
    if (!g.armed) return;
    if (!g.list || !g.list.isConnected) g.list = document.querySelector(g.armed.list);
    const list = g.list;
    const q = list ? list.getAttribute("data-q") : null;
    if (q === g.seen) return;
    g.seen = q;
    const tCommit = performance.now();
    const rec = q === null ? undefined : g.recs.get(q);
    const count = list ? list.getAttribute("data-count") : null;
    const rows = list ? list.querySelectorAll('[role="option"]').length : 0;
    afterPaint((tRaf, tPaint) => report({
      q, count: count === null ? null : Number(count), rows, tCommit, tRaf, tPaint,
      tKey: rec ? rec.tKey : null, tInput: rec ? rec.tInput : null, tEcho: rec ? rec.tEcho : null, value: rec ? rec.value : null,
    }));
  };
  new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-q"] });
  g.arm = (field, list, strip) => { g.armed = { field, list, strip }; g.list = null; g.seen = undefined; g.recs.clear(); check(); return true; };
  g.clear = () => { g.et.length = 0; g.loaf.length = 0; return true; };
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) g.et.push({ name: e.name, start: e.startTime, duration: e.duration, processingStart: e.processingStart, processingEnd: e.processingEnd, interactionId: e.interactionId }); })
      .observe({ type: "event", durationThreshold: 16, buffered: true });
  } catch (e) { g.etError = String(e); }
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) g.loaf.push({ start: e.startTime, duration: e.duration, blocking: e.blockingDuration }); })
      .observe({ type: "long-animation-frame", buffered: true });
  } catch (e) { g.loafError = String(e); }
})()`;

/**
 * The calibration: a fixed scan of 100,000 path-like strings from a fixed LCG (a lower-case fold and a subsequence
 * test for a query that matches none), in a page of its own, so its number follows the host's CPU and not kitespan.
 */
const CALIBRATION = `(() => {
  if (window.__gateCalib) return true;
  const words = ["index", "main", "app", "config", "server", "client", "helper", "model", "view", "service", "handler", "route", "schema", "test", "search", "upload"];
  const dirs = ["src", "web", "lib", "docs", "test", "tools"];
  let x = 0x2545f491;
  const r = (k) => { x = (Math.imul(x, 1103515245) + 12345) >>> 0; return (x >>> 8) % k; };
  const data = [];
  for (let i = 0; i < 100000; i++) data.push("Pkg" + r(400) + "/" + dirs[r(dirs.length)] + "/" + words[r(words.length)] + "/" + words[r(words.length)] + words[r(words.length)] + i + ".ts");
  window.__gateCalib = (q) => {
    const t0 = performance.now();
    let hits = 0;
    for (let i = 0; i < data.length; i++) {
      const s = data[i].toLowerCase();
      let j = 0;
      for (let k = 0; k < s.length && j < q.length; k++) if (s.charCodeAt(k) === q.charCodeAt(j)) j++;
      if (j === q.length) hits++;
    }
    return { ms: performance.now() - t0, hits };
  };
  return true;
})()`;

// ---------------------------------------------------------------------------------------------------------------
// Statistics: nearest rank

function pct(xs: readonly number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}
interface Stats {
  n: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}
const stats = (xs: readonly number[]): Stats => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), max: xs.length ? Math.max(...xs) : null });
const ms = (x: number | null) => (x === null ? "none" : x.toFixed(1));
const round = (x: number) => Math.round(x * 100) / 100;

// ---------------------------------------------------------------------------------------------------------------
// One run

interface Paint {
  q: string | null;
  count: number | null;
  rows: number;
  tCommit: number;
  tRaf: number;
  tPaint: number;
  tKey: number | null;
  tInput: number | null;
  tEcho: number | null;
  value: string | null;
}

/** The paint reports of one page, and waits for the first one of a query after a mark. */
class Paints {
  readonly all: Paint[] = [];
  private waiting: { q: string; from: number; done: (p: Paint | null) => void }[] = [];

  push(p: Paint) {
    this.all.push(p);
    const at = this.all.length - 1;
    for (const w of [...this.waiting]) if (w.q === p.q && at >= w.from) w.done(p);
  }

  wait(q: string, from: number, timeoutMs: number): Promise<Paint | null> {
    const hit = this.all.slice(from).find((p) => p.q === q);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve) => {
      const w = {
        q,
        from,
        done: (p: Paint | null) => {
          clearTimeout(timer);
          this.waiting = this.waiting.filter((x) => x !== w);
          resolve(p);
        },
      };
      const timer = setTimeout(() => w.done(null), timeoutMs);
      this.waiting.push(w);
    });
  }
}

type RunKind = "counted" | "again" | "locked" | "throttled";

interface KeyResult {
  q: string;
  /** Key to painted list, key to commit, key to the field's echo (ms); absent for a miss. */
  paint?: number;
  commit?: number;
  echo?: number | null;
  rows?: number;
  count?: number | null;
  miss?: string;
}

interface RunResult {
  surface: Surface;
  size: SizeId;
  viewport: { width: number; height: number; scale: number; touch: boolean };
  rowsInFolder: number;
  kind: RunKind;
  /** The counted run's number (1 to RUNS); 0 for an information run. */
  index: number;
  throttle: number;
  filterWanted: Filter;
  filterSeen: Filter | null;
  /** Search route requests during the measured keys. */
  serverSearches: number;
  keys: KeyResult[];
  /** The warm-up keys, the first keys after the surface opened (information only: never in the verdict). */
  first: KeyResult[];
  misses: number;
  paint: Stats;
  commit: Stats;
  echo: Stats;
  maxRows: number;
  loadBefore: number[];
  loadAfter: number[];
  calibration: { median: number | null; all: number[] };
  eventTiming: unknown[];
  longFrames: { start: number; duration: number; blocking: number }[];
  /** The page could not observe Event Timing or long animation frames: their numbers are then unknown, not zero. */
  observerErrors: string[];
  issues: string[];
  error: string | null;
  pass: boolean;
  loaded: boolean;
  /** Why it failed, and what explains it, in words. */
  why: string[];
}

const KEY_WAIT_MS = 5_000;
const READY_MS = 60_000;
const CPUS = cpus().length;
const load3 = () => loadavg().map((x) => round(x));

let cdp: Cdp;
let calibPage: Page;
let baseline: number;
let base: string;

async function calibrate(times: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < times; i++) out.push(round((await calibPage.evaluate<{ ms: number }>("window.__gateCalib('zq')")).ms));
  return out;
}

async function press(page: Page, k: Key) {
  const m = k.modifiers ?? 0;
  const keyBase = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers: m };
  // A text key is a keyDown with its text (keydown, keypress, beforeinput, input); a shortcut is a rawKeyDown.
  await page.send("Input.dispatchKeyEvent", { type: k.text || !(m & 6) ? "keyDown" : "rawKeyDown", ...keyBase, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...keyBase });
}

/** Poll an in-page expression until `ok` holds; returns the last value, or throws `what` with it. */
async function until<T>(page: Page, expr: string, ok: (v: T) => boolean, timeoutMs: number, what: string): Promise<T> {
  const end = Date.now() + timeoutMs;
  let v = await page.evaluate<T>(expr);
  while (!ok(v)) {
    if (Date.now() > end) throw new Error(`${what} (the page shows ${JSON.stringify(v)})`);
    await sleep(50);
    v = await page.evaluate<T>(expr);
  }
  return v;
}

const focusedOn = (sel: string) => `!!(document.activeElement && document.activeElement.matches(${JSON.stringify(sel)}))`;

/** Open the surface with its field focused, and wait until its list shows the folder's whole count (the corpus came). */
async function openSurface(page: Page, surface: Surface, rows: number) {
  const h = HOOKS[surface];
  if (surface === "pane") {
    await press(page, CTRL_K);
    await until<boolean>(page, focusedOn(h.field), Boolean, 5_000, "Ctrl+K did not open the search pane with its field focused");
    const files = `(() => { const g = document.querySelector('${h.list} [data-kind="files"]'); return g ? Number(g.getAttribute("data-count")) : null; })()`;
    await until<number | null>(page, files, (n) => n === rows, READY_MS, `the search pane's Files did not reach ${rows} matches for an empty query`);
    return;
  }
  const at = await page.locate(h.field);
  if (!at) throw new Error("the chat shows no composer field");
  if (at.covered) throw new Error(`the composer field is covered by ${at.covered}`);
  await page.press(at.x, at.y);
  await until<boolean>(page, focusedOn(h.field), Boolean, 5_000, "a press on the composer field did not focus it");
  // A draft that an earlier run left (drafts live on the server) goes first.
  if (await page.evaluate<boolean>(`(() => { const f = document.querySelector(${JSON.stringify(h.field)}); if (!f.value) return false; f.select(); return true; })()`)) {
    await press(page, BACKSPACE);
    await until<string>(page, `document.querySelector(${JSON.stringify(h.field)}).value`, (v) => v === "", 5_000, "the composer field did not empty");
  }
  await press(page, AT);
  const menu = `(() => { const m = document.querySelector('${h.list}'); return m ? [m.getAttribute("data-q"), Number(m.getAttribute("data-count"))] : null; })()`;
  await until<[string | null, number] | null>(page, menu, (m) => !!m && m[0] === "" && m[1] === rows, READY_MS, `the @ picker did not show ${rows} files for an empty filter`);
}

/** Leave the composer as it was: the picker closed and the field empty, saved (a draft is written 250 ms after it changes). */
async function tidy(page: Page, surface: Surface) {
  if (surface !== "picker") return;
  await press(page, ESCAPE);
  const field = JSON.stringify(HOOKS.picker.field);
  if (await page.evaluate<boolean>(`(() => { const f = document.querySelector(${field}); if (!f || !f.value) return false; f.focus(); f.select(); return true; })()`)) await press(page, BACKSPACE);
  await sleep(800);
}

async function typeKey(page: Page, paints: Paints, surface: Surface, k: ScriptKey): Promise<KeyResult> {
  const from = paints.all.length;
  await press(page, k.key);
  const p = await paints.wait(k.q, from, KEY_WAIT_MS);
  if (!p) return { q: k.q, miss: `no list painted "${k.q}" in ${KEY_WAIT_MS} ms` };
  if (p.tKey === null || p.tInput === null) return { q: k.q, miss: `the list painted "${k.q}" with no key event before it` };
  if (p.value !== fieldText(surface, k.q)) return { q: k.q, miss: `the field reads ${JSON.stringify(p.value)}, not ${JSON.stringify(fieldText(surface, k.q))}` };
  return { q: k.q, paint: round(p.tPaint - p.tKey), commit: round(p.tCommit - p.tKey), echo: p.tEcho === null ? null : round(p.tEcho - p.tKey), rows: p.rows, count: p.count };
}

async function oneRun(size: Size, surface: Surface, kind: RunKind, index: number): Promise<RunResult> {
  const rows = GATE[size.gate].rows;
  const throttle = kind === "throttled" ? THROTTLE! : 1;
  const r: RunResult = {
    surface,
    size: size.id,
    viewport: { width: size.vp.width, height: size.vp.height, scale: size.vp.scale, touch: size.vp.touch },
    rowsInFolder: rows,
    kind,
    index,
    throttle,
    filterWanted: size.filter,
    filterSeen: null,
    serverSearches: 0,
    keys: [],
    first: [],
    misses: 0,
    paint: stats([]),
    commit: stats([]),
    echo: stats([]),
    maxRows: 0,
    loadBefore: [],
    loadAfter: [],
    calibration: { median: null, all: [] },
    eventTiming: [],
    longFrames: [],
    observerErrors: [],
    issues: [],
    error: null,
    pass: false,
    loaded: false,
    why: [],
  };
  const page = await Page.open(cdp, size.vp, "dark");
  const paints = new Paints();
  let searches = 0;
  const off = cdp.on((e) => {
    if (e.sessionId !== page.session) return;
    if (e.method === "Runtime.bindingCalled" && e.params.name === BINDING) paints.push(JSON.parse(e.params.payload) as Paint);
    else if (e.method === "Network.requestWillBeSent" && String(e.params.request?.url ?? "").includes("/corpus/search")) searches++;
  });
  try {
    await page.send("Runtime.addBinding", { name: BINDING });
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: GATE_SCRIPT });
    await page.navigate(`${base}/c/${GATE_IDS.chats[size.gate]}`);
    await openSurface(page, surface, rows);
    const h = HOOKS[surface];
    await page.evaluate(`window.__gate.arm(${JSON.stringify(h.field)}, ${JSON.stringify(h.list)}, ${JSON.stringify(h.strip)})`);
    if (throttle > 1) await page.send("Emulation.setCPUThrottlingRate", { rate: throttle });
    for (const k of WARM_KEYS) {
      const w = await typeKey(page, paints, surface, k);
      r.first.push(w);
      if (w.miss) throw new Error(`a warm-up key missed: ${w.miss}`);
    }
    await sleep(300);
    const calib = await calibrate(5);
    r.calibration = { median: pct(calib, 50), all: calib };
    r.loadBefore = load3();
    await page.evaluate("window.__gate.clear()");
    const s0 = searches;
    const jit = jitter(SEED + index);
    let missedInARow = 0;
    for (const k of KEYS) {
      if (kind !== "locked") await sleep(jit());
      const res = await typeKey(page, paints, surface, k);
      r.keys.push(res);
      missedInARow = res.miss ? missedInARow + 1 : 0;
      if (missedInARow >= 5) {
        r.why.push("5 keys in a row painted nothing, so the run stopped");
        break;
      }
    }
    r.loadAfter = load3();
    r.serverSearches = searches - s0;
    r.filterSeen = r.serverSearches > 0 ? "server" : "page";
    const perf = await page.evaluate<{ et: unknown[]; loaf: RunResult["longFrames"]; errors: string[] }>(
      "({ et: window.__gate.et.slice(), loaf: window.__gate.loaf.slice(), errors: [window.__gate.etError, window.__gate.loafError].filter(Boolean) })",
    );
    r.eventTiming = perf.et;
    r.observerErrors = perf.errors;
    r.longFrames = perf.loaf.map((f) => ({ start: round(f.start), duration: round(f.duration), blocking: round(f.blocking ?? 0) }));
    if (throttle > 1) await page.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await tidy(page, surface);
  } catch (e) {
    r.error = (e as Error).message;
  } finally {
    off();
    r.issues = page.takeIssues().map((i) => i.text);
    await page.close();
  }

  const hit = r.keys.filter((k) => k.paint !== undefined);
  r.misses = r.keys.filter((k) => k.miss).length;
  r.paint = stats(hit.map((k) => k.paint!));
  r.commit = stats(hit.map((k) => k.commit!));
  r.echo = stats(hit.flatMap((k) => (typeof k.echo === "number" ? [k.echo] : [])));
  r.maxRows = Math.max(0, ...hit.map((k) => k.rows ?? 0));
  const overCount = hit.find((k) => k.count !== null && k.count !== undefined && (k.rows ?? 0) > k.count);

  const load1 = Math.max(r.loadBefore[0] ?? 0, r.loadAfter[0] ?? 0);
  const calibHigh = r.calibration.median !== null && r.calibration.median > 1.25 * baseline;
  r.loaded = load1 > CPUS / 2 || calibHigh;
  const p95 = r.paint.p95;
  if (r.error) r.why.unshift(`it could not run: ${r.error}`);
  if (!r.error && r.keys.length < KEYS.length && !r.why.length) r.why.push(`only ${r.keys.length} of ${KEYS.length} keys ran`);
  if (r.misses) r.why.push(`${r.misses} key(s) never painted their query (first: ${r.keys.find((k) => k.miss)!.miss})`);
  if (p95 !== null && p95 >= 50) r.why.push(`p95 ${ms(p95)} ms is 50 ms or more`);
  if (r.maxRows > 120) r.why.push(`a list drew ${r.maxRows} rows, over 120`);
  if (overCount) r.why.push(`a list drew ${overCount.rows} rows for a count of ${overCount.count}`);
  if (!r.error && r.filterSeen !== r.filterWanted) r.why.push(`the filter ran on the ${r.filterSeen === "server" ? "server" : "page"}, not the ${r.filterWanted}`);
  if (r.issues.length) r.why.push(`the page logged ${r.issues.length} error(s) (first: ${r.issues[0]})`);
  r.pass = r.why.length === 0 && p95 !== null;
  return r;
}

/** What explains a run's numbers: its load, its calibration against the baseline, its long frames. */
function explain(r: RunResult): string {
  const parts: string[] = [];
  const load1 = Math.max(r.loadBefore[0] ?? 0, r.loadAfter[0] ?? 0);
  if (load1 > CPUS / 2) parts.push(`the 1-minute load ${load1} is over half the ${CPUS} CPUs`);
  if (r.calibration.median !== null && r.calibration.median > 1.25 * baseline) parts.push(`the calibration ${ms(r.calibration.median)} ms is over 1.25 times the baseline ${ms(baseline)} ms`);
  if (r.longFrames.length) {
    const longest = r.longFrames.reduce((a, b) => (b.duration > a.duration ? b : a));
    parts.push(`${r.longFrames.length} long frame(s), the longest ${Math.round(longest.duration)} ms with ${Math.round(longest.blocking)} ms blocking`);
  }
  if (!parts.length) parts.push("no load, calibration or long frame explains it");
  return parts.join("; ");
}

/** The first keys after the surface opened, each query's key to list and key to commit: information, not counted. */
function firstKeys(r: RunResult): string {
  if (!r.first.length) return "first keys none (information)";
  const each = r.first.map((k) => `${JSON.stringify(k.q)} ${k.miss ? "miss" : `${ms(k.paint ?? null)}/${ms(k.commit ?? null)}`}`);
  return `first keys ${each.join(", ")} ms (key to list/key to commit, information)`;
}

function runLine(r: RunResult): string {
  const size = SIZE[r.size];
  const which =
    r.kind === "counted"
      ? `run ${r.index} of ${RUNS}`
      : r.kind === "again"
        ? `run ${r.index} of ${RUNS} again (it failed while loaded)`
        : r.kind === "locked"
          ? "phase-locked run (information only)"
          : `${r.throttle}x CPU run (information only)`;
  const lf = r.longFrames.length;
  const frames = r.observerErrors.length ? "long frames not observed" : `${lf} long frame${lf === 1 ? "" : "s"}`;
  const head = `search-gate: ${which}, ${SURFACE_NAME[r.surface]}, ${sizeLabel(size)}, ${rowsLabel(size)}, ${r.filterSeen ?? r.filterWanted} filter, ${r.paint.n} of ${KEYS.length} keys:`;
  const nums = `key to list p50 ${ms(r.paint.p50)}, p95 ${ms(r.paint.p95)}, max ${ms(r.paint.max)} ms; ${firstKeys(r)}; echo p95 ${ms(r.echo.p95)} ms; ${frames}`;
  const host = `load before ${r.loadBefore.join(" ") || "none"}, after ${r.loadAfter.join(" ") || "none"} on ${CPUS} CPUs; calibration ${ms(r.calibration.median)} ms (baseline ${ms(baseline)})`;
  const why = `${r.why.join("; ")}${r.paint.p95 !== null && r.paint.p95 >= 50 ? ` (${r.loaded ? "loaded: " : ""}${explain(r)})` : ""}`;
  // An information run is not part of the verdict, so it never says PASS or FAIL.
  const counted = r.kind === "counted" || r.kind === "again";
  const verdict = counted ? (r.pass ? "PASS" : `FAIL: ${why}`) : r.pass ? "under 50 ms, not counted" : `not counted: ${why}`;
  return `${head} ${nums}; ${host}: ${verdict}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Main

function kitespanCommit(): { commit: string | null; changedFiles: number | null } {
  const env = { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? tmpdir(), GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
  const git = (more: string[]) => {
    try {
      const p = Bun.spawnSync(["git", "-c", "core.fsmonitor=false", "-C", ROOT, ...more], { env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      return p.exitCode === 0 ? p.stdout.toString() : null;
    } catch {
      return null;
    }
  };
  const status = git(["status", "--porcelain"]);
  return { commit: git(["rev-parse", "--short=12", "HEAD"])?.trim() ?? null, changedFiles: status === null ? null : status.split("\n").filter(Boolean).length };
}

let booted: Booted | null = null;
let chrome: OwnChrome | null = null;
let built: string | null = null;
let stopping = false;
async function cleanup() {
  if (stopping) return;
  stopping = true;
  cdp?.close();
  await chrome?.stop().catch(() => {});
  if (booted) {
    const s = await booted.stop().catch(() => null);
    if (s && s.leftovers.length) console.log(`search-gate: ${s.leftovers.length} process(es) outlived the server and were ended by pid`);
  }
  if (built && !args.dist) rmSync(built, { recursive: true, force: true });
}
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    console.error(`search-gate: ${sig}, stopping`);
    cleanup().finally(() => process.exit(130));
  });

async function main(): Promise<number> {
  mkdirSync(OUT, { recursive: true });
  const started = new Date().toISOString();
  const kitespan = kitespanCommit();
  const binary = args.chrome ?? findChrome();
  if (!binary) fail("no Chrome for Testing found; pass --chrome <binary> or set CHROME_PATH");

  if (args.dist) built = resolve(args.dist);
  else {
    built = mkdtempSync(join(tmpdir(), "search-gate-page-"));
    const b = await buildPage({ out: built });
    console.log(`search-gate: built web/index.html in ${b.ms} ms`);
  }
  booted = await boot({ scene: "search", port: PORT, dist: built, timeoutMs: 60_000 });
  base = booted.base;
  console.log(`search-gate: the search scene (${GATE.big.rows.toLocaleString("en-US")} and ${GATE.phone.rows.toLocaleString("en-US")} rows) on ${base}, pid ${booted.pid}; boot ${booted.timing.bootMs} ms, warm-up ${booted.timing.warmMs} ms`);

  const chromePort = freePort(9341, 9349);
  if (!chromePort) throw new Error("no free port from 9341 to 9349 for Chrome");
  // A fine pointer that hovers for the laptop size, as ui-check gives its pages; touch sizes emulate touch over it.
  chrome = await launchChrome(binary, chromePort, { extraArgs: ["--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2"] });
  cdp = await Cdp.connect(chrome.wsUrl);
  const product = (await cdp.send<{ product: string }>("Browser.getVersion")).product;

  calibPage = await Page.open(cdp, SIZE.laptop.vp, "dark");
  await calibPage.evaluate(CALIBRATION);
  await calibrate(2);
  const atStart = await calibrate(9);
  baseline = BASELINE ?? pct(atStart, 50)!;
  const model = cpus()[0]?.model?.trim() ?? "unknown CPU";
  console.log(
    `search-gate: kitespan ${kitespan.commit ?? "unknown commit"}${kitespan.changedFiles ? ` with ${kitespan.changedFiles} changed file(s)` : ""}, ${product} (pid ${chrome.pid}, port ${chrome.port}), Bun ${Bun.version}, ${CPUS} CPUs (${model}); ` +
      `load ${load3().join(" ")}; calibration baseline ${ms(baseline)} ms (${BASELINE ? "given" : `measured at the start: ${atStart.map(ms).join(", ")}`}); ` +
      `${RUNS} run(s) of ${KEYS.length} keys (after ${WARM_KEYS.length} warm-up keys) per surface and size, jitter seed ${SEED}`,
  );

  const runs: RunResult[] = [];
  const record = (r: RunResult) => {
    runs.push(r);
    console.log(runLine(r));
    return r;
  };
  const verdicts: { size: Size; surface: Surface; pass: boolean; line: string }[] = [];
  for (const size of SIZES)
    for (const surface of SURFACES) {
      const finals: RunResult[] = [];
      for (let i = 1; i <= RUNS; i++) {
        await sleep(1000);
        let r = record(await oneRun(size, surface, "counted", i));
        // A loaded run that fails on its p95 alone runs once more; both are printed and kept.
        if (!r.pass && r.loaded && r.why.length === 1 && r.paint.p95 !== null && r.paint.p95 >= 50) {
          await sleep(1000);
          r = record(await oneRun(size, surface, "again", i));
        }
        finals.push(r);
      }
      if (LOCKED) {
        await sleep(1000);
        record(await oneRun(size, surface, "locked", 0));
      }
      if (THROTTLE && size.vp.touch) {
        await sleep(1000);
        record(await oneRun(size, surface, "throttled", 0));
      }
      const passed = finals.filter((r) => r.pass).length;
      const pass = passed === finals.length;
      const p95s = finals.map((r) => ms(r.paint.p95)).join(", ");
      const line = `search-gate: ${SURFACE_NAME[surface]}, ${sizeLabel(size)}, ${rowsLabel(size)}, ${size.filter} filter: p95 ${p95s} ms; ${passed} of ${finals.length} runs pass: ${pass ? "PASS" : "FAIL"}`;
      verdicts.push({ size, surface, pass, line });
    }

  for (const v of verdicts) console.log(v.line);
  const allPass = verdicts.every((v) => v.pass);
  const failed = verdicts.filter((v) => !v.pass).map((v) => `${SURFACE_NAME[v.surface]} at ${sizeLabel(v.size)} (${rowsLabel(v.size)})`);
  const verdict = allPass
    ? RUNS >= 3
      ? `PASS: every surface and size has ${RUNS} of ${RUNS} runs with p95 under 50 ms`
      : `PASS for ${RUNS} run(s) each; the gate's verdict needs --runs 3`
    : `FAIL: ${failed.join(", ")}`;
  console.log(`search-gate: ${verdict}`);

  const report = {
    tool: "search-gate",
    started,
    finished: new Date().toISOString(),
    verdict,
    pass: allPass,
    kitespan,
    chrome: product,
    bun: Bun.version,
    host: { cpus: CPUS, model, baselineMs: baseline, baselineFrom: BASELINE ? "given" : "measured at the start", baselineSamples: atStart },
    server: { port: PORT, scene: "search" },
    method: {
      latency: "keydown timeStamp to the first frame after the commit in which the list's data-q equals the field's query (requestAnimationFrame, then a MessageChannel message)",
      percentile: "nearest rank",
      jitter: `0 to 16.7 ms before each key, seeded ${SEED} plus the run's number; none in the phase-locked run`,
      loaded: "the 1-minute load over half the CPUs, or the calibration over 1.25 times the baseline",
      keys: KEYS.map((k) => k.key.key),
      warmUp: WARM_KEYS.map((k) => k.key.key),
      firstKeys: "each run's warm-up keys (its first keys after the surface opened) in `first`: key to list and key to commit, information only, never in a verdict",
    },
    sizes: SIZES.map((s) => ({ id: s.id, ...s.vp, rows: GATE[s.gate].rows, filter: s.filter })),
    runs,
  };
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`search-gate: wrote ${join(OUT, "report.json")}`);
  return allPass ? 0 : 1;
}

let code = 2;
try {
  code = await main();
} catch (e) {
  console.error(`search-gate: ${(e as Error).message}`);
  code = 2;
} finally {
  await cleanup();
}
process.exit(code);
