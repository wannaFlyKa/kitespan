// The browser pane's click-through flows (DESIGN-B1 7.4, page side; iteration 7 B2), on a kitespan whose seed has a
// browser.json (the harness's boot option `browser`: Chrome for Testing, a free test port from 9341 to 9349 that is
// not 9340, and loopbackOnly), with the local test site (test/click/browser-site.ts) on 127.0.0.1. scripts/ui-check.ts runs them;
// they take what they need as arguments, so a scratch driver can run them too.
//
// - browser-pane (1280x800, 1194x834 and 390x844 with touch; light and dark): /c/<chat>/browser from its state
//   (Start browser on the first run), docked beside the chat at 512 px and 618 px or the phone's own page; its parts'
//   names and roles; New tab focuses the address field inside the press; a page of the test site in the frame; a tap
//   (or a click) on the page's select opens the app's own list (a sheet on the phone) and a pick reaches the page; a
//   confirm() shows the dialog card, whose OK reaches the page; typed keys reach a page's field (the Keyboard button's
//   hidden field on touch); a wheel or a drag scrolls the page; on touch the address field, Go while the user types, a
//   tab's Close and the foot's buttons are 44 px or more; no console error, exception or failed request. The keys:
//   Esc in the address field puts the tab's address back, and with nothing typed closes the Browser over the chat; on a
//   laptop the app's list holds the keys (Down and Enter pick, Esc closes it and the page's own popup); Esc on the
//   dialog card is Cancel, over the chat too; the focus goes back to the frame when a card or a list closes; Esc closes
//   More with the focus on its button. The phone's Tabs sheet is a plain list with the open tab's row current. A
//   javascript: pre-fill fills nothing and says "That address cannot open here.".
// - browser-looks (1280x800 light): the pane on a page in each of the four looks, a shot of each.
// - browser-stop (1280x800): Settings > Browser's Stop browser asks first, the pane says the browser is stopped, and
//   Start browser brings its tabs back.
// - browser-cases (FIX-B2 2's sizes: 1280x800, and 834x1194 and 390x844 with touch; light and dark): a date picked in
//   the app's own calendar reaches the page; a file chooser that a tap opens takes a file of this device through
//   kitespan's uploads (the chat's; on the phone, on /browser with no chat in reach, the browser's own); a tab that a
//   page's link opens is followed, with Back to its opener. On the laptop: the calendar by its keys; Ctrl+C writes the
//   page's current selection (never text that an arrow or a typed key took away); a chat link's Browser pane, on a page
//   whose browser socket was not open yet, opens the link in a new tab. At each size, Settings > Browser's Open chat
//   links shows its words whole (on the phone, Settings' choice menu).
// - browser-restart (the three sizes at once): three viewers of one tab, each with its own cast, see one viewer's
//   navigation; Chrome stopped and started brings the tabs back under their ids; a reboot stand-in (kitespan's quit,
//   which stops Chrome, then the profile's session folders removed and a new kitespan) reopens the saved URLs at Start;
//   a kitespan restart (POST /api/restart) keeps every tab, and its successor adopts the running Chrome.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "../../shared/protocol";
import { Cdp, sleep } from "./cdp";
import { Page, sizeTag, type Theme, type Viewport } from "./page";

export interface BrowserFinding {
  code: string;
  text: string;
}

export interface BrowserFlowResult {
  name: string;
  route: string;
  /** The size's tag (page.ts sizeTag). */
  size: string;
  theme: Theme;
  path: string;
  failures: BrowserFinding[];
  warnings: BrowserFinding[];
  note: string;
  shot?: string;
  details: Record<string, unknown>;
  ms: number;
}

export interface BrowserFlowCtx {
  cdp: Cdp;
  /** kitespan's base URL. */
  base: string;
  /** The chat beside the pane. */
  chat: string;
  /** The local test site's base URL. */
  site: string;
  /** Where the shots go. */
  shots: string;
  /** A shot's file name for this flow, size and theme. */
  shotName: (flow: string, vp: Viewport, theme: Theme, extra?: string) => string;
  /** A folder for the files that a flow hands to the page (the file chooser's). */
  files: string;
  /** The shared browser's debugging port, for the reads a stand-in Claude makes there (a native popup's state). */
  sharedPort?: number;
}

/** What browser-restart needs of the kitespan under test beyond its address. */
export interface BrowserLife {
  /** kitespan's quit (a SIGTERM, as a shutdown sends), then a new kitespan on the same state folder and port. */
  quit: () => Promise<void>;
  /** The shared browser's profile folder (<state>/browser/profile). */
  profile: string;
  /** The shared browser's debugging port. */
  cdpPort: number;
  /** Whether nothing listens on a port of 127.0.0.1. */
  portFree: (port: number) => boolean;
}

/** The pane's sizes: the laptop at 1280x800, the tablet at 1194x834 and the phone at 390x844, both with touch. */
export const BROWSER_SIZES: readonly Viewport[] = [
  { name: "laptop", width: 1280, height: 800, scale: 1, mobile: false, touch: false },
  { name: "medium", width: 1194, height: 834, scale: 2, mobile: true, touch: true },
  { name: "phone", width: 390, height: 844, scale: 3, mobile: true, touch: true },
];
/** And the two where the Browser opens over the chat (DESIGN-B1 4.1, D-13): 1100x800, and 834x1194 with touch. */
export const BROWSER_OVER_SIZES: readonly Viewport[] = [
  { name: "laptop", width: 1100, height: 800, scale: 1, mobile: false, touch: false },
  { name: "medium", width: 834, height: 1194, scale: 2, mobile: true, touch: true },
];
/** The done line's sizes (BUILD-BRIEF 1, FIX-B2 2): 1280x800, and 834x1194 and 390x844 with touch. */
export const BROWSER_DONE_SIZES: readonly Viewport[] = [BROWSER_SIZES[0]!, BROWSER_OVER_SIZES[1]!, BROWSER_SIZES[2]!];

/** Where the Browser shows at a size and how wide (DESIGN-B1 4.1's table). */
export function expectedPlace(vp: Viewport): { place: "docked" | "over" | null; w: number } {
  if (vp.name === "phone") return { place: null, w: vp.width };
  if (vp.name === "medium") return vp.width - 56 - 520 >= 420 ? { place: "docked", w: vp.width - 56 - 520 } : { place: "over", w: vp.width - 56 };
  const rule = Math.round(Math.min(960, Math.max(480, vp.width / 2)));
  const room = vp.width - (vp.width >= 1000 ? 248 : 0);
  const beside = Math.min(rule, room - 520);
  return beside >= 420 ? { place: "docked", w: beside } : { place: "over", w: Math.min(rule, room) };
}

/**
 * The shared browser's test port: the first free one from the top of 9341 to 9349, passing over the ports that other
 * runs name for their own Chrome (9345, 9346, 9348 and 9349), so a test that picks from the bottom rarely meets it.
 */
export function sharedBrowserPort(free: (port: number) => boolean): number | null {
  return [9347, 9344, 9343, 9342].find(free) ?? null;
}

/** Stop the shared browser through kitespan's own Stop (Settings > Browser), so it never outlives a run. */
export async function stopBrowser(base: string): Promise<number | string> {
  return fetch(`${base}/api/browser/stop`, { method: "POST", headers: { "x-kitespan": "1", "content-type": "application/json", origin: base }, body: "{}" })
    .then((r) => r.status)
    .catch((e: Error) => e.message);
}

const shown = `const shown = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";`;

/** What the pane shows now (read in the page). */
interface PaneLook {
  state: string | null;
  place: string | null;
  paneW: number;
  tab: string | null;
  tabs: string[];
  /** The open tab's title: the frame's name (the phone has no strip). */
  title: string;
  /** The Keyboard button lights (a field on the page has the focus). */
  invite: boolean;
  /** The frame's box; `cw`, its canvas's width in pixels (the cast's frame size for this viewer); `dim`, dimmed. */
  frame: { x: number; y: number; w: number; h: number; drawn: boolean; keys: boolean; cw: number; dim: boolean } | null;
  /** The pane says Reconnecting... (its socket is down; the last frame stays, dimmed). */
  reconnecting: boolean;
  picker: boolean;
  dialog: boolean;
  active: string | null;
  small: string[];
  names: { tablist: boolean; toolbar: boolean; address: boolean; frameRole: string | null; frameDesc: string | null; more: string | null };
}

const LOOK = `JSON.stringify((() => {
  ${shown}
  const pane = [...document.querySelectorAll('[data-testid="browser-pane"]')].find(shown);
  const shell = document.querySelector(".shell");
  const f = pane && pane.querySelector('[data-testid="browser-frame"]');
  const r = f && f.getBoundingClientRect();
  const c = f && f.querySelector("canvas");
  const touch = document.body.classList.contains("touch");
  const small = [];
  if (pane && touch) for (const el of pane.querySelectorAll('button, a[href], input, [role="tab"]')) {
    if (!shown(el) || el.closest(".bp-chip-probes, .bp-pop, .bp-card-wrap, .term-keys")) continue;
    const b = el.getBoundingClientRect();
    if (b.width < 43.5 || b.height < 43.5) small.push((el.getAttribute("aria-label") || el.getAttribute("data-testid") || el.textContent || el.tagName).trim().slice(0, 40) + " " + Math.round(b.width) + "x" + Math.round(b.height));
  }
  const desc = f && document.getElementById(f.getAttribute("aria-describedby") || "");
  const more = pane && pane.querySelector('[data-testid="browser-more"]');
  return {
    state: pane ? pane.dataset.state : null,
    place: shell ? (shell.dataset.browser || null) : null,
    paneW: pane ? Math.round(pane.getBoundingClientRect().width) : 0,
    tab: pane ? (pane.dataset.tab || null) : null,
    tabs: pane ? [...pane.querySelectorAll('[data-testid="browser-tab"]')].map((t) => (t.getAttribute("title") || "") + (t.getAttribute("aria-selected") === "true" ? " (open)" : "")) : [],
    title: f ? (f.getAttribute("aria-label") || "") : "",
    invite: !!(pane && pane.querySelector('[data-testid="browser-keyboard"].is-invite')),
    frame: r ? { x: r.x, y: r.y, w: r.width, h: r.height, drawn: !!c && c.width > 10, keys: f.dataset.keys === "true", cw: c ? c.width : 0, dim: f.classList.contains("is-dim") } : null,
    reconnecting: !!pane && [...pane.querySelectorAll(".bp-pill")].some((el) => shown(el) && el.textContent.includes("Reconnecting")),
    picker: [...document.querySelectorAll('[data-testid="browser-picker"], [data-testid="browser-picker-sheet"]')].some(shown),
    dialog: [...document.querySelectorAll('[data-testid="browser-dialog"]')].some(shown),
    active: document.activeElement ? (document.activeElement.getAttribute("data-testid") || document.activeElement.tagName) : null,
    small,
    names: {
      tablist: !!(pane && pane.querySelector('[role="tablist"][aria-label="Tabs"]')),
      toolbar: !!(pane && pane.querySelector('[role="toolbar"][aria-label="Page"]')),
      address: !!(pane && pane.querySelector('input[aria-label="Address"]')),
      frameRole: f ? f.getAttribute("role") + "/" + f.getAttribute("aria-roledescription") : null,
      frameDesc: desc ? desc.textContent : null,
      more: more ? more.getAttribute("aria-haspopup") : null,
    },
  };
})())`;

async function look(page: Page): Promise<PaneLook> {
  return JSON.parse(await page.evaluate<string>(LOOK)) as PaneLook;
}

async function until(page: Page, ok: (l: PaneLook) => boolean, ms = 15000): Promise<PaneLook> {
  const end = Date.now() + ms;
  let l = await look(page);
  while (!ok(l) && Date.now() < end) {
    await sleep(150);
    l = await look(page);
  }
  return l;
}

async function centre(page: Page, selector: string): Promise<{ x: number; y: number } | null> {
  return page.evaluate(`(() => { ${shown} const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(shown); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
}

async function press(page: Page, selector: string): Promise<boolean> {
  const at = await centre(page, selector);
  if (!at) return false;
  await page.press(at.x, at.y);
  return true;
}

/** A key with its code and virtual key code, down and up, as a keyboard sends it. */
async function key(page: Page, k: string, code: string, vk: number, mods = 0, text?: string) {
  await page.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers: mods, ...(text ? { text } : {}) });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
}

async function typeKeys(page: Page, s: string) {
  for (const ch of s) await key(page, ch, `Key${ch.toUpperCase()}`, ch.toUpperCase().charCodeAt(0), 0, ch);
}

/** The open tab's title (the test site writes each result into it). */
const openTitle = (l: PaneLook) => l.title;

/** Open `url` in the tab on screen: the address field, its text replaced, Enter; wait for the tab's title. */
async function openUrl(page: Page, url: string, title: string, fail: (t: string) => void): Promise<PaneLook> {
  if (!(await press(page, '[data-testid="browser-address"]'))) fail("no address field");
  await sleep(150);
  await key(page, "a", "KeyA", 65, 2); // Ctrl+A in kitespan's own field selects its text
  await page.send("Input.insertText", { text: url });
  await page.key("Enter");
  const l = await until(page, (x) => openTitle(x) === title && !!x.frame?.drawn, 20000);
  if (openTitle(l) !== title) fail(`after Go the open tab's title is "${openTitle(l)}", not "${title}"`);
  await sleep(400); // the cast's frame of the new page
  return l;
}

/** Press a point of the page shown in the frame, given as shares of the frame's width and height. */
async function pressFrame(page: Page, l: PaneLook, fx: number, fy: number) {
  if (!l.frame) return;
  await page.press(l.frame.x + l.frame.w * fx, l.frame.y + l.frame.h * fy);
}

/** The page's path and query now (an Esc that closes the Browser over the chat changes it). */
const here = (page: Page) => page.evaluate<string>("location.pathname + location.search");

/** The first shown match's box, or null. */
async function boxOf(page: Page, selector: string): Promise<{ w: number; h: number } | null> {
  return page.evaluate(`(() => { ${shown} const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(shown); if (!el) return null; const b = el.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; })()`);
}

/** What the focus is on (its test id, else its tag), and whether it is inside `selector`. */
async function focusIn(page: Page, selector: string): Promise<{ at: string | null; inside: boolean }> {
  return page.evaluate(`(() => { const a = document.activeElement; return { at: a ? (a.getAttribute("data-testid") || a.tagName) : null, inside: !!(a && a.closest(${JSON.stringify(selector)})) }; })()`);
}

/**
 * An expression read in the shared browser's tab whose address starts with `prefix`, as a raw CDP client of its own
 * (the way a stand-in Claude reaches the tab); null when there is no such tab or no answer.
 */
async function inShared<T>(port: number | undefined, prefix: string, expression: string): Promise<T | null> {
  if (!port) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
    const list = (await res.json()) as { type: string; url: string; webSocketDebuggerUrl?: string }[];
    const t = list.find((x) => x.type === "page" && x.url.startsWith(prefix) && x.webSocketDebuggerUrl);
    if (!t) return null;
    const c = await Cdp.connect(t.webSocketDebuggerUrl!, { timeoutMs: 3000, requestTimeoutMs: 3000 });
    try {
      const r = await c.send<{ result?: { value?: unknown } }>("Runtime.evaluate", { expression, returnByValue: true });
      return (r.result?.value ?? null) as T | null;
    } finally {
      c.close();
    }
  } catch {
    return null;
  }
}

function result(name: string, route: string, vp: Viewport, theme: Theme, path: string): BrowserFlowResult {
  // Two sizes share a size name (1280x800 and 1100x800; 1194x834 and 834x1194): the details name the pixels.
  return { name, route, size: sizeTag(vp), theme, path, failures: [], warnings: [], note: "", details: { viewport: `${vp.width}x${vp.height}` }, ms: 0 };
}

/**
 * browser-pane: the pane at one size and theme (see the head of this file). `first`: the first run of a boot (the
 * browser is off: its state, then Start browser).
 */
export async function browserPaneFlow(ctx: BrowserFlowCtx, vp: Viewport, theme: Theme, first: boolean): Promise<BrowserFlowResult> {
  const t0 = Date.now();
  const path = `/c/${ctx.chat}/browser`;
  const r = result("browser-pane", "chatBrowser", vp, theme, path);
  r.note = "start, the place and width, names, New tab's focus, a select, a dialog, typing, scrolling, 44 px targets";
  const fail = (text: string, code = "flow") => r.failures.push({ code, text });
  const page = await Page.open(ctx.cdp, vp, theme);
  try {
    await page.navigate(ctx.base + path);
    let l = await until(page, (x) => !!x.state && x.state !== "connecting", 10000);
    if (first) {
      if (l.state !== "off") fail(`the first open shows the state "${l.state}", not off`);
      const shot = ctx.shotName("browser-off", vp, theme);
      await page.screenshot(join(ctx.shots, shot)).catch(() => {});
      r.details.offShot = shot;
    }
    if (l.state !== "running") {
      if (!(await press(page, '[data-testid="browser-start"]'))) fail("no Start browser in the off state");
      l = await until(page, (x) => x.state === "running", 30000);
      if (l.state !== "running") return (fail(`after Start browser the state is "${l.state}"`), r);
    }
    // The place and the width (DESIGN-B1 4.1): docked at 512 px at 1280 x 800, at 618 px at 1194 x 834, the phone's page.
    const want = expectedPlace(vp);
    const shellPlace = await page.evaluate<string | null>(`document.querySelector(".shell")?.dataset.browser ?? null`);
    r.details.place = { shell: shellPlace, paneW: l.paneW };
    if (vp.name === "phone") {
      if ((await page.evaluate<string | null>(`document.querySelector(".shell-phone")?.dataset.browser ?? null`)) !== "page") fail("the phone does not show the Browser as its own page");
    } else if (shellPlace !== want.place) fail(`the Browser is "${shellPlace}", not ${want.place}`);
    if (Math.abs(l.paneW - want.w) > 2) fail(`the Browser is ${l.paneW} px wide, not ${want.w}`);
    // Names and roles (DESIGN-B1 4.18).
    if (vp.name !== "phone" && !l.names.tablist) fail("no tab list named Tabs");
    if (!l.names.toolbar) fail("no toolbar named Page");
    if (!l.names.address) fail("no field named Address");
    if (l.names.more !== "dialog") fail(`More's popup is "${l.names.more}", not a dialog`);
    // A tab to work in: New tab focuses the address field inside the press (F24).
    if (first) {
      const newSel = vp.name === "phone" ? '[data-testid="browser-tabs-button"]' : '[data-testid="browser-new"]';
      if (!(await press(page, newSel))) fail("no New tab");
      if (vp.name === "phone") {
        await sleep(400);
        if (!(await press(page, '[data-testid="browser-tabs-sheet"] [data-testid="browser-new"]'))) fail("the Tabs sheet has no New tab");
      }
      await sleep(250);
      const active = await page.evaluate<string | null>(`document.activeElement?.getAttribute("data-testid") ?? null`);
      if (active !== "browser-address") fail(`after New tab the focus is on ${active}, not the address field`);
      await page.send("Input.insertText", { text: `${ctx.site}/select` });
      await page.key("Enter");
      l = await until(page, (x) => openTitle(x) === "select" && !!x.frame?.drawn, 20000);
      if (vp.name === "phone") l = await until(page, (x) => !!x.frame?.drawn, 20000);
    } else l = await openUrl(page, `${ctx.site}/select`, "select", fail);
    await sleep(500);
    if (l.frame?.drawn !== true) fail("no frame drawn of the test page");
    r.details.frame = l.frame;
    if (vp.name !== "phone" && l.names.frameRole !== "application/page view") fail(`the frame is "${l.names.frameRole}"`);
    if (!l.names.frameDesc?.startsWith("Clicks and keys go to the page in the shared browser.")) fail(`the frame's description is "${l.names.frameDesc}"`);
    if (vp.touch && l.small.length) fail(`controls under 44 px on touch: ${l.small.slice(0, 6).join("; ")}`);
    const shot = ctx.shotName("browser-pane", vp, theme);
    await page.screenshot(join(ctx.shots, shot)).catch(() => {});
    r.shot = shot;
    const over = expectedPlace(vp).place === "over";
    const at = await here(page);

    // The address field while the user types (DESIGN 7.7, PAGE-B1 17): Go shows, a 44 px target on touch; Esc puts the
    // tab's address back and keeps the Browser; a second Esc, with nothing typed, is the layer's over the chat (it closes).
    const tabUrl = `${ctx.site}/select`;
    if (!(await press(page, '[data-testid="browser-address"]'))) fail("no address field");
    await sleep(150);
    await key(page, "a", "KeyA", 65, 2);
    await page.send("Input.insertText", { text: "example.test" });
    await sleep(200);
    const go = await boxOf(page, '[data-testid="browser-go"]');
    r.details.go = go;
    if (!go) fail("typing in the address field shows no Go");
    else if (vp.touch && (go.w < 43.5 || go.h < 43.5)) fail(`Go in the address field is ${go.w}x${go.h} on touch, under 44 px`);
    const goShot = ctx.shotName("browser-typing-address", vp, theme);
    await page.screenshot(join(ctx.shots, goShot)).catch(() => {});
    r.details.goShot = goShot;
    await key(page, "Escape", "Escape", 27);
    await sleep(250);
    const field = () => page.evaluate<string | null>(`document.querySelector('[data-testid="browser-address"]')?.value ?? null`);
    const back = await field();
    if (back !== tabUrl) fail(`Esc in the address field left "${back}" in it, not the tab's address`);
    if ((await here(page)) !== at) fail(`Esc in the address field with typed text changed the page to ${await here(page)}`);
    await key(page, "Escape", "Escape", 27);
    await sleep(400);
    const after = await here(page);
    r.details.escTwice = after;
    if (over) {
      if (after !== `/c/${ctx.chat}`) fail(`over the chat, a second Esc in the address field (nothing typed) left the page at ${after}, not the chat`);
      await page.navigate(ctx.base + at);
      l = await until(page, (x) => x.state === "running" && openTitle(x) === "select" && !!x.frame?.drawn, 15000);
    } else if (after !== at) fail(`a second Esc in the address field changed the page to ${after}`);
    if (vp.touch) await page.evaluate(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);

    // A select (DESIGN-B1 4.5): a tap anywhere on the page's full-size select opens the app's own list. On a laptop the
    // list holds the keys (PAGE-B1 17): Down and Enter pick in it, the focus goes back to the frame, and Esc closes the
    // list and the page's own invisible popup (pick_cancel), over the chat too.
    await pressFrame(page, l, 0.5, 0.5);
    l = await until(page, (x) => x.picker, 6000);
    if (!l.picker) fail("a tap on the page's select opened no picker");
    else if (!vp.touch) {
      const pickShot = ctx.shotName("browser-select", vp, theme);
      await page.screenshot(join(ctx.shots, pickShot)).catch(() => {});
      r.details.selectShot = pickShot;
      const f = await focusIn(page, '[data-testid="browser-select"]');
      if (!f.inside) fail(`with the app's list open the focus is on ${f.at}, not the list, so its keys go to the page`);
      await key(page, "ArrowDown", "ArrowDown", 40);
      await key(page, "Enter", "Enter", 13, 0, "\r");
      l = await until(page, (x) => openTitle(x) === "s=Banana" && !x.picker, 8000);
      if (openTitle(l) !== "s=Banana" || l.picker) fail(`after Down and Enter in the list the page's title is "${openTitle(l)}"${l.picker ? " and the list is still open" : ""}, not s=Banana`);
      else if (l.active !== "browser-frame") fail(`after the list's pick the focus is on ${l.active}, not the frame`);
      await pressFrame(page, l, 0.5, 0.5);
      l = await until(page, (x) => x.picker, 6000);
      if (!l.picker) fail("a second click on the page's select opened no picker");
      else {
        await sleep(200);
        await key(page, "Escape", "Escape", 27);
        l = await until(page, (x) => !x.picker, 4000);
        if (l.picker) fail("Esc in the app's list left it open");
        const now = await here(page);
        if (now !== at) {
          fail(`Esc in the app's list closed the Browser (the page is ${now})`);
          await page.navigate(ctx.base + at);
          l = await until(page, (x) => x.state === "running" && !!x.frame?.drawn, 15000);
        } else if (l.active !== "browser-frame") fail(`after Esc in the list the focus is on ${l.active}, not the frame`);
        await sleep(300);
        const open = await inShared<boolean>(ctx.sharedPort, tabUrl, `document.getElementById("s").matches(":open")`);
        r.details.nativeOpenAfterEsc = open;
        if (ctx.sharedPort && open !== false) fail(`after Esc in the app's list the page's own select popup is ${open === null ? "unknown" : "still open"}`);
      }
    } else {
      const pickShot = ctx.shotName("browser-select", vp, theme);
      await page.screenshot(join(ctx.shots, pickShot)).catch(() => {});
      r.details.selectShot = pickShot;
      const row = await page.evaluate<{ x: number; y: number } | null>(`(() => { ${shown} const el = [...document.querySelectorAll('[data-testid="browser-select"] [role="option"]')].find((o) => shown(o) && o.textContent.trim() === "Banana"); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
      if (!row) fail("the picker has no Banana row");
      else {
        await page.press(row.x, row.y);
        l = await until(page, (x) => openTitle(x) === "s=Banana", 8000);
        if (openTitle(l) !== "s=Banana") fail(`after the pick the page's title is "${openTitle(l)}", not s=Banana`);
      }
    }

    // The phone's Tabs sheet (DESIGN-B1 4.18): a plain list, the open tab's row current; never a listbox whose options
    // the browser drops, so a screen reader can tell which tab is open.
    if (vp.name === "phone") {
      if (!(await press(page, '[data-testid="browser-tabs-button"]'))) fail("no Tabs button");
      else if (!(await untilShown(page, '[data-testid="browser-tabs-sheet"]', 4000))) fail("the Tabs button opened no sheet");
      else {
        const sheet = await page.evaluate<{ listbox: boolean; option: boolean; current: string[] }>(`(() => { const s = document.querySelector('[data-testid="browser-tabs-sheet"]'); return { listbox: !!s.querySelector('[role="listbox"]'), option: !!s.querySelector('[role="option"]'), current: [...s.querySelectorAll('[aria-current="true"]')].map((e) => e.textContent.trim()) }; })()`);
        await page.send("Accessibility.enable").catch(() => {});
        const tree = await page.send<{ nodes: { role?: { value?: string }; name?: { value?: string }; ignored?: boolean }[] }>("Accessibility.getFullAXTree").catch(() => ({ nodes: [] }));
        const roles = tree.nodes.filter((n) => !n.ignored).map((n) => `${n.role?.value ?? ""} ${JSON.stringify(n.name?.value ?? "")}`);
        r.details.tabsSheet = { ...sheet, ax: roles.filter((x) => /^(listbox|option|list|listitem) /.test(x)) };
        if (sheet.listbox || sheet.option || roles.some((x) => x.startsWith("listbox ") || x.startsWith("option "))) fail(`the Tabs sheet is a listbox (${roles.filter((x) => /^(listbox|option) /.test(x)).join("; ")}), whose options the browser drops`);
        if (sheet.current.length !== 1 || !sheet.current[0]!.includes(openTitle(l))) fail(`the Tabs sheet's current rows are ${JSON.stringify(sheet.current)}, not the open tab "${openTitle(l)}" alone`);
        await page.send("Accessibility.disable").catch(() => {});
        // The sheet slides up as it opens: Done is pressed once it stands still inside the window.
        const doneAt = () => page.evaluate<number | null>(`(() => { const d = document.querySelector('[data-testid="browser-tabs-sheet"] [data-testid="sheet-done"]'); if (!d) return null; const b = d.getBoundingClientRect(); return b.bottom <= innerHeight ? Math.round(b.y) : null; })()`);
        const still = Date.now() + 3000;
        let was = await doneAt();
        for (;;) {
          await sleep(100);
          const now = await doneAt();
          if ((now !== null && now === was) || Date.now() > still) break;
          was = now;
        }
        await press(page, '[data-testid="browser-tabs-sheet"] [data-testid="sheet-done"]');
        const end = Date.now() + 3000;
        while ((await shownNow(page, '[data-testid="browser-tabs-sheet"]')) && Date.now() < end) await sleep(100);
        if (await shownNow(page, '[data-testid="browser-tabs-sheet"]')) {
          fail("the Tabs sheet's Done left it open");
          await page.screenshot(join(ctx.shots, ctx.shotName("browser-tabs-sheet-stuck", vp, theme))).catch(() => {});
        }
        await page.evaluate(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
        await sleep(300);
      }
    }

    // A dialog (DESIGN-B1 4.6): confirm() from the page's middle button; the card holds the focus (the frame had the
    // keys), and Esc on it is Cancel, over the chat too (the layer's Esc goes to the card first); then OK after its
    // guard. Each time the card goes, the focus goes back to the frame, never to the page's body.
    l = await openUrl(page, `${ctx.site}/dialogs`, "dialogs", fail);
    const atDialogs = await here(page);
    await pressFrame(page, l, 0.5, 0.5);
    l = await until(page, (x) => x.dialog, 8000);
    if (!l.dialog) fail("confirm() showed no dialog card");
    else {
      if (l.active !== "browser-dialog") fail(`the dialog card does not hold the focus (it is on ${l.active})`);
      await sleep(600);
      await key(page, "Escape", "Escape", 27);
      l = await until(page, (x) => openTitle(x) === "confirm=false" && !x.dialog, 6000);
      const now = await here(page);
      if (now !== atDialogs) {
        fail(`Esc on the dialog card closed the Browser (the page is ${now}), and the page's dialog waits`);
        await page.navigate(ctx.base + atDialogs);
        l = await until(page, (x) => x.dialog, 10000);
        await sleep(600);
        await press(page, '[data-testid="browser-dialog-cancel"]');
        l = await until(page, (x) => !x.dialog && !!x.frame?.drawn, 6000);
      } else if (openTitle(l) !== "confirm=false") fail(`after Esc on the dialog card the page's title is "${openTitle(l)}", not confirm=false`);
      else if (l.active !== "browser-frame") fail(`after Esc on the dialog card the focus is on ${l.active}, not the frame`);
    }
    await pressFrame(page, l, 0.5, 0.5);
    l = await until(page, (x) => x.dialog, 8000);
    if (!l.dialog) fail("a second confirm() showed no dialog card");
    else {
      const dShot = ctx.shotName("browser-dialog", vp, theme);
      await page.screenshot(join(ctx.shots, dShot)).catch(() => {});
      r.details.dialogShot = dShot;
      const title = await page.evaluate<string>(`document.querySelector('[data-testid="browser-dialog"] .chat-card-title')?.textContent ?? ""`);
      if (!/^127\.0\.0\.1:\d+ says$/.test(title)) fail(`the card's title is "${title}"`);
      await sleep(600);
      if (!(await press(page, '[data-testid="browser-dialog-ok"]'))) fail("the card has no OK");
      l = await until(page, (x) => openTitle(x) === "confirm=true" && !x.dialog, 8000);
      if (openTitle(l) !== "confirm=true") fail(`after OK the page's title is "${openTitle(l)}", not confirm=true`);
      else if (l.active !== "browser-frame") fail(`after OK on the dialog card the focus is on ${l.active}, not the frame`);
    }

    // More (DESIGN-B1 4.2): Esc closes the popover with the focus on its own button too, and the focus stays there.
    if (vp.name !== "phone") {
      if (!(await press(page, '[data-testid="browser-more"]'))) fail("no More");
      else if (!(await untilShown(page, '[data-testid="browser-more-pop"]', 3000))) fail("More opened no popover");
      else {
        await key(page, "Escape", "Escape", 27);
        await sleep(300);
        const still = await shownNow(page, '[data-testid="browser-more-pop"]');
        const f = await focusIn(page, '[data-testid="browser-more"]');
        if (still) fail(`Esc with the focus on ${f.at} left More's popover open`);
        else if (f.at !== "browser-more") fail(`after Esc closed More the focus is on ${f.at}, not More`);
        if ((await here(page)) !== atDialogs) fail(`Esc on More changed the page to ${await here(page)}`);
      }
    }

    // A url pre-fill of another scheme (PAGE-B1 2.1): 5.4's line, nothing in the field, no draft, no external-link line.
    await page.navigate(ctx.base + `${path}?url=${encodeURIComponent("javascript:alert(1)")}`);
    l = await until(page, (x) => x.state === "running" && !!x.frame?.drawn, 15000);
    await sleep(300);
    const pre = await page.evaluate<{ line: string; field: string | null; external: boolean }>(`(() => { ${shown} const line = [...document.querySelectorAll('[data-testid="browser-line"]')].find(shown); return { line: line ? line.textContent.trim() : "", field: document.querySelector('[data-testid="browser-address"]')?.value ?? null, external: [...document.querySelectorAll('[data-testid="browser-from-link"]')].some(shown) }; })()`);
    r.details.refusedPrefill = { ...pre, tab: l.tab };
    if (pre.line !== "That address cannot open here." || pre.external || l.tab === "draft" || (pre.field ?? "").startsWith("javascript:")) fail(`a javascript: pre-fill shows the line "${pre.line}", the field "${pre.field}", tab ${l.tab}${pre.external ? ", Address from an external link" : ""}`);

    // Typing (DESIGN-B1 4.3, 4.10): into the page's Name field; the change shows in the title after Tab.
    l = await openUrl(page, `${ctx.site}/inputs`, "inputs", fail);
    // The Name field: the form's second row, near its left (about page px 120, 80 of the 1280 px page).
    const scale = l.frame ? l.frame.w / 1280 : 1;
    if (l.frame) await page.press(l.frame.x + 120 * scale, l.frame.y + 80 * scale);
    await sleep(500);
    if (vp.touch) {
      if (!(await press(page, '[data-testid="browser-keyboard"]'))) fail("no Keyboard button on touch");
      await sleep(250);
      const active = await page.evaluate<string | null>(`document.activeElement?.getAttribute("data-testid") ?? null`);
      if (active !== "browser-type") fail(`after the Keyboard button the focus is on ${active}, not the hidden field`);
      await page.send("Input.insertText", { text: "xyz" });
      await sleep(200);
      if (!(await press(page, '[data-testid="browser-keys"] button:nth-child(2)'))) fail("no Tab key in the key row");
    } else {
      const keys = (await look(page)).frame?.keys;
      if (!keys) fail("a click in the frame did not give it the keys");
      await typeKeys(page, "xyz");
      await key(page, "Tab", "Tab", 9);
    }
    l = await until(page, (x) => /xyz/.test(openTitle(x)), 8000);
    if (!/xyz/.test(openTitle(l))) {
      fail(`typed text did not reach the page's field (its title is "${openTitle(l)}"; the Keyboard button ${l.invite ? "lit" : "not lit"})`);
      await page.screenshot(join(ctx.shots, ctx.shotName("browser-typing", vp, theme))).catch(() => {});
    }
    r.details.typed = openTitle(l);
    if (vp.touch) await page.evaluate(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);

    // Scrolling (DESIGN-B1 4.3): the wheel on a laptop, a one-finger drag on touch; the page's Top button scrolls away.
    l = await openUrl(page, `${ctx.site}/scroll`, "scroll", fail);
    if (l.frame) {
      const x = l.frame.x + l.frame.w / 2;
      const y = l.frame.y + l.frame.h / 2;
      if (vp.touch) {
        await page.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
        for (let i = 1; i <= 8; i++) await page.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - i * 20 }] });
        await page.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      } else await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: 800 });
      await sleep(900);
      await pressFrame(page, l, 0.5, 0.05);
      await sleep(900);
      l = await look(page);
      if (openTitle(l) === "top pressed") fail("the page did not scroll: the press found its Top button");
    }
    for (const i of page.takeIssues()) fail(`${i.kind}: ${i.text}`, "issue");
  } catch (e) {
    fail(`the check could not run: ${(e as Error).message}`, "run");
  } finally {
    await page.close().catch(() => {});
  }
  r.ms = Date.now() - t0;
  return r;
}

/** browser-looks: the pane at 1280x800 light in one look (glass, paper, mono, editor), with the test page. */
/**
 * browser-select (T-13, G-18; v0.6 touch): on the test site's plain page, More > Select text, a finger's drag over the
 * page's words, and the touch foot's Copy: the clipboard holds the words. The switch goes off with the next More's.
 */
export async function browserSelectFlow(ctx: BrowserFlowCtx, vp: Viewport, theme: Theme): Promise<BrowserFlowResult> {
  const t0 = Date.now();
  const path = `/c/${ctx.chat}/browser`;
  const r = result("browser-select", "chatBrowser", vp, theme, path);
  const fail = (text: string, code = "flow") => r.failures.push({ code, text });
  const page = await Page.open(ctx.cdp, vp, theme);
  const words = `Kitespan select ${sizeTag(vp)}`;
  try {
    await ctx.cdp.send("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"], origin: ctx.base, browserContextId: page.contextId }).catch(() => {});
    await page.navigate(ctx.base + path);
    let l = await until(page, (x) => !!x.state && x.state !== "connecting", 10000);
    if (l.state !== "running") {
      await press(page, '[data-testid="browser-start"]');
      l = await until(page, (x) => x.state === "running", 30000);
    }
    if (l.state !== "running") return (fail(`the browser is "${l.state}", not running`), r);
    l = await openUrl(page, `${ctx.site}/plain?t=${encodeURIComponent(words)}`, words, fail);
    if (!(await press(page, '[data-testid="browser-more"]'))) fail("no More");
    else if (!(await untilShown(page, '[data-testid="browser-select-text"]', 3000))) fail("More has no Select text on touch");
    else {
      // The phone's More is a sheet that rises in: the tap waits until it stands still.
      await page.evaluate(`Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null))).then(() => true)`);
      await sleep(200);
      await press(page, '[data-testid="browser-select-text"]');
      await sleep(500);
      if (await shownNow(page, '[data-testid="browser-more-pop"]')) fail("Select text does not close More");
      r.details.afterSwitch = await page.evaluate(`({ copy: !!document.querySelector('[data-testid="browser-copy"]'), sheet: !!document.querySelector(".sheet"), more: !!document.querySelector('[data-testid="browser-more-pop"]') })`);
      l = await look(page);
      r.details.frame = l.frame;
      if (!l.frame) return (fail("the frame does not show"), r);
      // A drag over the page's top: its one paragraph of words.
      const f = l.frame;
      const pt = (x: number, y: number) => [{ x, y, radiusX: 4, radiusY: 4, force: 1 }];
      // From below and right of the page's one paragraph back to its top-left corner (above it, in its 16 px of margin), so
      // the selection holds its first letter; the finger never starts at the screen's left edge, which on the phone is
      // the app's swipe back.
      const y0 = f.y + 8;
      const y1 = f.y + Math.min(f.h * 0.25, 160);
      const x0 = f.x + 1;
      const x1 = f.x + f.w * 0.9;
      await page.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pt(x1, y1) });
      for (let i = 1; i <= 10; i++) {
        await page.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pt(x1 + ((x0 - x1) * i) / 10, y1 + ((y0 - y1) * i) / 10) });
        await sleep(40);
      }
      await page.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await sleep(1200);
      r.details.afterDrag = await page.evaluate(`({ path: location.pathname + location.search, active: document.activeElement && (document.activeElement.getAttribute("data-testid") || document.activeElement.tagName), copy: !!document.querySelector('[data-testid="browser-copy"]') })`);
      if (!(await untilShown(page, '[data-testid="browser-copy"]', 3000))) fail("the touch foot shows no Copy while Select text is on");
      else {
        await press(page, '[data-testid="browser-copy"]');
        await sleep(600);
        const clip = await page.evaluate<string | null>(`navigator.clipboard.readText().catch(() => null)`);
        r.details.clipboard = clip;
        if (!clip || !clip.includes(words)) fail(`after the drag and Copy the clipboard holds "${clip}", not "${words}"`, "copy");
      }
      const shot = ctx.shotName("browser-select", vp, theme);
      await page.screenshot(join(ctx.shots, shot)).catch(() => {});
      r.shot = join(ctx.shots, shot);
    }
    r.note = "More > Select text, a drag over the page, the foot's Copy";
    for (const i of page.takeIssues()) r.failures.push({ code: i.kind === "request" ? "request" : "error", text: i.text });
  } catch (e) {
    fail(`the flow could not run: ${(e as Error).message}`, "run");
  } finally {
    r.ms = Date.now() - t0;
    await page.close();
  }
  return r;
}

export async function browserLookFlow(ctx: BrowserFlowCtx, look: string): Promise<BrowserFlowResult> {
  const t0 = Date.now();
  const vp = BROWSER_SIZES[0]!;
  const path = `/c/${ctx.chat}/browser`;
  const r = result("browser-looks", "chatBrowser", vp, "light", path);
  r.note = `the pane in the ${look} look`;
  const page = await Page.open(ctx.cdp, vp, "light");
  try {
    await page.navigate(ctx.base + path);
    // The look on the root, as Settings > Appearance > Look sets it (glass: none), as the other look flows do.
    await page.evaluate(`(() => { const r = document.documentElement; ${look === "glass" ? `r.removeAttribute("data-look")` : `r.setAttribute("data-look", ${JSON.stringify(look)})`}; return true; })()`);
    const l = await until(page, (x) => x.state === "running" && !!x.frame?.drawn, 15000);
    if (l.state !== "running" || !l.frame?.drawn) r.failures.push({ code: "flow", text: `the pane shows "${l.state}" with ${l.frame?.drawn ? "a" : "no"} frame` });
    const got = await page.evaluate<string | null>(`document.documentElement.getAttribute("data-look")`);
    if ((got ?? "glass") !== look) r.failures.push({ code: "flow", text: `the page's look is "${got}"` });
    await sleep(500);
    const shot = ctx.shotName("browser-look", vp, "light", look);
    await page.screenshot(join(ctx.shots, shot)).catch(() => {});
    r.shot = shot;
    for (const i of page.takeIssues()) r.failures.push({ code: "issue", text: `${i.kind}: ${i.text}` });
  } catch (e) {
    r.failures.push({ code: "run", text: `the check could not run: ${(e as Error).message}` });
  } finally {
    await page.close().catch(() => {});
  }
  r.ms = Date.now() - t0;
  return r;
}

/** browser-stop: Settings > Browser's Stop browser (with its confirm), the stopped state, and Start browser again. */
export async function browserStopFlow(ctx: BrowserFlowCtx, theme: Theme): Promise<BrowserFlowResult> {
  const t0 = Date.now();
  const vp = BROWSER_SIZES[0]!;
  const path = "/settings/browser";
  const r = result("browser-stop", "settingsSection", vp, theme, path);
  r.note = "Stop browser asks first; the pane says stopped; Start browser brings the tabs back";
  const fail = (text: string, code = "flow") => r.failures.push({ code, text });
  const page = await Page.open(ctx.cdp, vp, theme);
  try {
    await page.navigate(ctx.base + `/c/${ctx.chat}/browser`);
    const before = await until(page, (x) => x.state === "running" && x.tabs.length > 0, 15000);
    r.details.before = before.tabs;
    await page.navigate(ctx.base + path);
    await sleep(800);
    const shot = ctx.shotName("browser-settings", vp, theme);
    await page.screenshot(join(ctx.shots, shot)).catch(() => {});
    r.shot = shot;
    const words = await page.evaluate<string>(`document.querySelector('[data-testid="settings-browser"]')?.textContent ?? ""`);
    for (const w of ["Running, Chrome", "Browser program", "Port", "Claude's browser tools", "claude mcp add -s user playwright", "Open chat links", "Profile folder", "Clear browsing data"]) if (!words.includes(w)) fail(`Settings > Browser lacks "${w}"`);
    if (!(await press(page, '[data-testid="browser-stop"]'))) fail("no Stop browser");
    await sleep(400);
    const asked = await page.evaluate<string>(`document.querySelector('[data-testid="browser-stop-confirm"]')?.textContent ?? ""`);
    if (!asked.includes("Stop the browser?") || !asked.includes("Claude's browser tools fail until it starts again.")) fail(`the confirm says "${asked.slice(0, 120)}"`);
    if (!(await press(page, '[data-testid="browser-stop-go"]'))) fail("the confirm has no Stop browser");
    await page.navigate(ctx.base + `/c/${ctx.chat}/browser`);
    const off = await until(page, (x) => x.state === "off", 20000);
    if (off.state !== "off") fail(`after Stop the pane shows "${off.state}"`);
    const text = await page.evaluate<string>(`document.querySelector('[data-testid="browser-state"]')?.textContent ?? ""`);
    if (!text.includes("The browser is stopped")) fail(`the stopped pane says "${text}"`);
    const sShot = ctx.shotName("browser-stopped", vp, theme);
    await page.screenshot(join(ctx.shots, sShot)).catch(() => {});
    r.details.stoppedShot = sShot;
    if (!(await press(page, '[data-testid="browser-start"]'))) fail("the stopped state has no Start browser");
    // The saved tabs come back (each loads again, so its title comes when its page has loaded).
    const titles = (t: string[]) => t.map((s) => s.replace(/ \(open\)$/, "")).filter((s) => s !== "New tab").sort();
    const back = await until(page, (x) => x.state === "running" && JSON.stringify(titles(x.tabs)) === JSON.stringify(titles(before.tabs)), 30000);
    r.details.after = back.tabs;
    if (back.state !== "running") fail(`after Start the pane shows "${back.state}"`);
    else if (JSON.stringify(titles(back.tabs)) !== JSON.stringify(titles(before.tabs))) fail(`the tabs after Start are ${JSON.stringify(back.tabs)}, before ${JSON.stringify(before.tabs)}`);
    for (const i of page.takeIssues()) fail(`${i.kind}: ${i.text}`, "issue");
  } catch (e) {
    fail(`the check could not run: ${(e as Error).message}`, "run");
  } finally {
    await page.close().catch(() => {});
  }
  r.ms = Date.now() - t0;
  return r;
}

// ---------------------------------------------------------------------------------------------------------------
// FIX-B2 2's done line: the cases that browser-pane and browser-stop do not cover

async function shownNow(page: Page, selector: string): Promise<boolean> {
  return page.evaluate<boolean>(`(() => { ${shown} return [...document.querySelectorAll(${JSON.stringify(selector)})].some(shown); })()`);
}

async function untilShown(page: Page, selector: string, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!(await shownNow(page, selector))) {
    if (Date.now() > end) return false;
    await sleep(150);
  }
  return true;
}

/** The first shown match's name (its aria-label) or, with `text`, its words. */
async function wordsOf(page: Page, selector: string, text = false): Promise<string> {
  return page.evaluate<string>(`(() => { ${shown} const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(shown); return el ? (${text ? "" : `el.getAttribute("aria-label") || `}el.textContent || "").trim() : ""; })()`);
}

interface ServerTab {
  id: string;
  url: string;
  title: string;
}

/** The host's state and the tabs as the server holds them, from a pane socket of the flow's own (`opened`, DESIGN-B1 3.4). */
/** Why the last serverView found nothing (a flow's failure line names it). */
let viewProblem = "";

export function serverView(base: string): Promise<{ host: { state: string; how?: string }; tabs: ServerTab[] } | null> {
  viewProblem = "";
  return new Promise((resolveIt) => {
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    // Settle first: Bun runs onclose inside close(), which would settle it again with null.
    const done = (x: { host: { state: string; how?: string }; tabs: ServerTab[] } | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      resolveIt(x);
      try {
        ws?.close();
      } catch {}
    };
    timer = setTimeout(() => ((viewProblem = "no opened frame in 5 s"), done(null)), 5000);
    try {
      // Bun's WebSocket takes headers: the Origin check wants kitespan's own origin.
      ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws/browser`, { headers: { origin: base } } as unknown as string[]);
    } catch (e) {
      viewProblem = `the socket did not open: ${(e as Error).message}`;
      return done(null);
    }
    ws.onopen = () => ws?.send(JSON.stringify({ t: "open", v: PROTOCOL_VERSION }));
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      try {
        const f = JSON.parse(e.data) as { t: string; host?: { state: string; how?: string }; tabs?: ServerTab[] };
        if (f.t === "opened" && f.host && f.tabs) done({ host: f.host, tabs: f.tabs });
      } catch {}
    };
    ws.onerror = (e) => ((viewProblem ||= `a socket error: ${(e as ErrorEvent).message ?? "no message"}`), done(null));
    ws.onclose = (e) => ((viewProblem ||= `closed with ${e.code} ${e.reason}`), done(null));
  });
}

/** GET /api/browser's host state, or null while nothing answers. */
async function hostNow(base: string): Promise<{ state: string; how?: string } | null> {
  try {
    const r = await fetch(`${base}/api/browser`, { signal: AbortSignal.timeout(3000) });
    return r.ok ? ((await r.json()) as { host: { state: string; how?: string } }).host : null;
  } catch {
    return null;
  }
}

/**
 * browser-cases: at one of the done line's sizes, a date, a file chooser through kitespan's uploads, and a tab that a
 * page opens (see the head of this file). The browser runs (browser-pane started it).
 */
export async function browserCasesFlow(ctx: BrowserFlowCtx, vp: Viewport, theme: Theme): Promise<BrowserFlowResult> {
  const t0 = Date.now();
  const path = `/c/${ctx.chat}/browser`;
  const r = result("browser-cases", "chatBrowser", vp, theme, path);
  r.note = "a date, a file chooser through kitespan's uploads, a tab that a page's link opens and Back to its opener";
  const fail = (text: string, code = "flow") => r.failures.push({ code, text });
  const page = await Page.open(ctx.cdp, vp, theme);
  // This device's own file dialog: the flow answers it with a file of its own, as the + menu's flow does.
  let chooser: { backendNodeId: number } | null = null;
  const off = ctx.cdp.on((e) => {
    if (e.sessionId === page.session && e.method === "Page.fileChooserOpened") chooser = e.params as { backendNodeId: number };
  });
  mkdirSync(ctx.files, { recursive: true });
  const file = join(ctx.files, "note.txt");
  writeFileSync(file, "a note from the click-through\n");
  try {
    await page.send("DOM.enable");
    await page.send("Page.setInterceptFileChooserDialog", { enabled: true });
    await page.navigate(ctx.base + path);
    let l = await until(page, (x) => x.state === "running" && !!x.frame?.drawn, 20000);
    if (l.state !== "running") return (fail(`the pane shows "${l.state}", not the running browser`), r);

    // A date (DESIGN-B1 4.5): on touch a tap that focuses the field shows the app's calendar; on a laptop it shows
    // once Chrome's own calendar is open (Alt+Down here: B1 w3 line 16). A day picked in it reaches the page.
    l = await openUrl(page, `${ctx.site}/date`, "date", fail);
    await pressFrame(page, l, 0.3, 0.5);
    if (!vp.touch) {
      await sleep(400);
      await key(page, "ArrowDown", "ArrowDown", 40, 1);
    }
    if (!(await untilShown(page, '[data-testid="browser-date"]', 6000))) fail(`${vp.touch ? "a tap on" : "Alt+Down in"} the page's date field showed no calendar`);
    else if (!vp.touch) {
      // On a laptop the grid holds the keys (PAGE-B1 17): two days on with Right, Enter picks; the focus goes back to the frame.
      const shot = ctx.shotName("browser-date", vp, theme);
      await page.screenshot(join(ctx.shots, shot)).catch(() => {});
      r.details.dateShot = shot;
      const f = await focusIn(page, '[data-testid="browser-date"]');
      if (!f.inside) fail(`with the app's calendar open the focus is on ${f.at}, not the calendar, so its keys go to the page`);
      await key(page, "ArrowRight", "ArrowRight", 39);
      await key(page, "ArrowRight", "ArrowRight", 39);
      await key(page, "Enter", "Enter", 13, 0, "\r");
      l = await until(page, (x) => openTitle(x) === "d=2026-11-11" && !x.picker, 8000);
      if (openTitle(l) !== "d=2026-11-11") fail(`after Right, Right and Enter in the calendar the page's title is "${openTitle(l)}", not d=2026-11-11`);
      else if (l.picker) fail("the calendar stays open after the pick");
      else if (l.active !== "browser-frame") fail(`after the calendar's pick the focus is on ${l.active}, not the frame`);
    } else {
      const shot = ctx.shotName("browser-date", vp, theme);
      await page.screenshot(join(ctx.shots, shot)).catch(() => {});
      r.details.dateShot = shot;
      if (!(await press(page, '[data-testid="browser-date"] [data-day="2026-11-20"]'))) fail("the calendar has no 20 November 2026");
      l = await until(page, (x) => openTitle(x) === "d=2026-11-20" && !x.picker, 8000);
      if (openTitle(l) !== "d=2026-11-20") fail(`after the pick the page's title is "${openTitle(l)}", not d=2026-11-20`);
      else if (l.picker) fail("the calendar stays open after the pick");
    }

    // Copy from the frame (DESIGN-B1 4.3, D-15), on a laptop: Ctrl+C writes the page's current selection, never text
    // that a typed key or an arrow took away (this page's clipboard is read back).
    if (!vp.touch) {
      await ctx.cdp.send("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"], origin: ctx.base, browserContextId: page.contextId }).catch(() => {});
      const clip = () => page.evaluate<string>("navigator.clipboard.readText()").catch((e: Error) => `(unread: ${e.message})`);
      const setClip = (s: string) => page.evaluate(`navigator.clipboard.writeText(${JSON.stringify(s)}).then(() => true)`).catch(() => false);
      const copy = async () => {
        await key(page, "c", "KeyC", 67, 2);
        await sleep(300);
        return clip();
      };
      l = await openUrl(page, `${ctx.site}/text`, "text", fail);
      await pressFrame(page, l, 0.5, 0.3);
      await sleep(400);
      await key(page, "a", "KeyA", 65, 2);
      await sleep(500);
      const all = await copy();
      if (all !== "one two three") fail(`Ctrl+A then Ctrl+C in the page's textarea wrote "${all}", not "one two three"`);
      await setClip("SENTINEL");
      await key(page, "a", "KeyA", 65, 2);
      await sleep(400);
      await key(page, "ArrowRight", "ArrowRight", 39);
      await sleep(500);
      const collapsed = await copy();
      if (collapsed !== "SENTINEL") fail(`Ctrl+A, an arrow that collapsed the selection, then Ctrl+C wrote "${collapsed}": nothing was selected`);
      await key(page, "a", "KeyA", 65, 2);
      await sleep(400);
      await typeKeys(page, "x");
      await sleep(500);
      const typed = await copy();
      if (typed !== "SENTINEL") fail(`Ctrl+A, a key typed over the selection, then Ctrl+C wrote "${typed}": nothing was selected`);
      r.details.copy = { all, collapsed, typed };
    }

    // A link in Claude's text on a page that has not opened the browser's socket yet (a device's first use, when the
    // question shows): Browser pane opens the link in a new tab of the shared browser, not a draft that waits for Go.
    if (vp.name === "laptop") {
      const fresh = await Page.open(ctx.cdp, vp, theme);
      try {
        await fresh.navigate(ctx.base + `/c/${ctx.chat}`);
        await sleep(1500);
        const linkUrl = `${ctx.site}/plain?t=from%20chat`;
        const added = await fresh.evaluate<boolean>(`(() => { const all = [...document.querySelectorAll(".chat-assistant")]; const a = all[all.length - 1]; if (!a) return false; const p = a.querySelector(".chat-md p") || a; const l = document.createElement("a"); l.href = ${JSON.stringify(linkUrl)}; l.textContent = "the site link"; l.id = "ui-chat-link"; p.append(" ", l); l.scrollIntoView({ block: "center" }); return true; })()`);
        if (!added) fail("the chat has no reply of Claude's to hold a link");
        else {
          await sleep(300);
          await press(fresh, "#ui-chat-link");
          if (!(await untilShown(fresh, '[data-testid="browser-links-question"]', 4000))) fail("the first click on a chat link asked nothing");
          else {
            await press(fresh, '[data-testid="browser-links-pane"]');
            const lk = await until(fresh, (x) => x.state === "running" && openTitle(x) === "from chat" && !!x.frame?.drawn, 15000);
            const now = await here(fresh);
            r.details.chatLink = { now, tab: lk.tab, title: openTitle(lk) };
            if (!/^\/c\/[^/]+\/browser\/[a-z2-7]{10}$/.test(now) || lk.tab === "draft" || openTitle(lk) !== "from chat") fail(`Browser pane for a chat link on a device's first use shows ${now} (tab ${lk.tab}, "${openTitle(lk)}"), not the link open in a new tab`);
            if (await shownNow(fresh, '[data-testid="browser-from-link"]')) fail("a chat link's address says it came from an external link");
            await fresh.screenshot(join(ctx.shots, ctx.shotName("browser-chat-link", vp, theme))).catch(() => {});
          }
        }
        for (const i of fresh.takeIssues()) fail(`chat link page: ${i.kind}: ${i.text}`, "issue");
      } finally {
        await fresh.close().catch(() => {});
      }
    }

    // A file chooser (DESIGN-B1 4.7): a tap opens the page's file field; the card's Choose file opens this device's
    // own file dialog inside the press; the file goes up through kitespan's uploads and reaches the page. The chat's
    // uploads beside a chat; on the phone the case runs on /browser, its own Browser page with no chat in reach, so
    // the file goes into the browser's own uploads (POST /api/uploads?browser=1).
    const noChat = vp.name === "phone";
    r.details.chooserOwner = noChat ? "browser" : "chat";
    if (noChat) {
      await page.navigate(ctx.base + "/browser");
      l = await until(page, (x) => x.state === "running" && !!x.frame?.drawn, 20000);
    }
    l = await openUrl(page, `${ctx.site}/chooser`, "chooser", fail);
    await pressFrame(page, l, 0.5, 0.5);
    if (!(await untilShown(page, '[data-testid="browser-file"]', 8000))) fail("a tap on the page's file field showed no file card");
    else {
      const title = await wordsOf(page, '[data-testid="browser-file"] .chat-card-title', true);
      if (title !== "The page asks for a file") fail(`the file card's title is "${title}"`);
      const from = await wordsOf(page, '[data-testid="browser-file"] .chat-card-from', true);
      const want = noChat ? "The file goes into kitespan's browser uploads, then to the page." : "The file goes into this chat's uploads, then to the page.";
      if (from !== want) fail(`the file card says "${from}", not "${want}"`);
      const shot = ctx.shotName("browser-file", vp, theme);
      await page.screenshot(join(ctx.shots, shot)).catch(() => {});
      r.details.fileShot = shot;
      chooser = null;
      if (!(await press(page, '[data-testid="browser-file-choose"]'))) fail("the file card has no Choose file");
      const c0 = Date.now();
      while (!chooser && Date.now() - c0 < 3000) await sleep(50);
      const picked = chooser as { backendNodeId: number } | null;
      if (!picked) fail("Choose file opened no file dialog of this device");
      else {
        await page.send("DOM.setFileInputFiles", { files: [file], backendNodeId: picked.backendNodeId });
        l = await until(page, (x) => openTitle(x) === "file=note.txt", 10000);
        if (openTitle(l) !== "file=note.txt") fail(`after the pick the page's title is "${openTitle(l)}", not file=note.txt`);
        else if (await untilShown(page, '[data-testid="browser-file"]', 300)) fail("the file card stays open after the file reached the page");
      }
    }

    if (noChat) {
      await page.navigate(ctx.base + path);
      l = await until(page, (x) => x.state === "running" && !!x.frame?.drawn, 20000);
    }

    // A tab that a page opens (DESIGN-B1 4.9, D-12): the device whose tap opened it follows it, with Back to the opener.
    l = await openUrl(page, `${ctx.site}/popup`, "popup", fail);
    const opener = l.tab;
    await pressFrame(page, l, 0.5, 1 / 6);
    l = await until(page, (x) => x.tab !== opener && openTitle(x) === "opened by link" && !!x.frame?.drawn, 10000);
    r.details.follow = { opener, tab: l.tab, title: openTitle(l) };
    if (l.tab === opener || openTitle(l) !== "opened by link") fail(`after a tap on the page's target=_blank link the pane shows "${openTitle(l)}", not the new tab "opened by link"`);
    else {
      const back = '[data-testid="browser-back"], [data-testid="browser-foot-back"]';
      const name = await wordsOf(page, back);
      if (name !== "Back to popup") fail(`the followed tab's Back is named "${name}", not "Back to popup"`);
      const shot = ctx.shotName("browser-follow", vp, theme);
      await page.screenshot(join(ctx.shots, shot)).catch(() => {});
      r.details.followShot = shot;
      if (!(await press(page, back))) fail("the followed tab has no Back");
      l = await until(page, (x) => x.tab === opener && openTitle(x) === "popup" && !!x.frame?.drawn, 10000);
      if (l.tab !== opener || openTitle(l) !== "popup") fail(`Back to popup shows "${openTitle(l)}", not the opener`);
    }

    // Settings > Browser (DESIGN-B1 4.14): Open chat links shows its choices' words whole; where the section is narrow
    // (the phone) it is Settings' choice menu, a sheet of rows, as Settings' other long choices are.
    await page.navigate(ctx.base + "/settings/browser");
    if (!(await untilShown(page, '[data-testid="setting-browser-links"]', 8000))) fail("Settings > Browser has no Open chat links row");
    else {
      await sleep(300);
      const row = await page.evaluate<{ menu: boolean; seg: boolean; clipped: string[] }>(`(() => { const row = document.querySelector('[data-testid="setting-browser-links"]'); return { menu: !!row.querySelector('[data-testid="browser-links-button"]'), seg: !!row.querySelector('[role="radiogroup"]'), clipped: [...row.querySelectorAll(".set-control *")].filter((e) => e.getClientRects().length && e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent.trim()) }; })()`);
      r.details.linksRow = row;
      if (row.clipped.length) fail(`Settings > Browser's Open chat links cuts off its words: ${row.clipped.join("; ")}`);
      if (vp.name === "phone" && (!row.menu || row.seg)) fail("on the phone, Open chat links is not Settings' choice menu");
      if (row.menu) {
        await press(page, '[data-testid="browser-links-button"]');
        if (!(await untilShown(page, '[data-testid="browser-links-menu"]', 3000))) fail("Open chat links' menu did not open");
        else {
          await sleep(500);
          const words = await page.evaluate<string[]>(`[...document.querySelectorAll('[data-testid="browser-links-menu"] [role="menuitemradio"]')].map((e) => e.textContent.trim())`);
          if (words.join("|") !== "Ask the first time|In the browser pane|In a new tab") fail(`Open chat links' menu offers ${JSON.stringify(words)}`);
          const shot = ctx.shotName("browser-settings-links", vp, theme);
          await page.screenshot(join(ctx.shots, shot)).catch(() => {});
          r.details.linksShot = shot;
          await page.key("Escape");
          await sleep(300);
        }
      }
      const shot = ctx.shotName("browser-cases-settings", vp, theme);
      await page.screenshot(join(ctx.shots, shot)).catch(() => {});
      r.details.settingsShot = shot;
    }
    for (const i of page.takeIssues()) fail(`${i.kind}: ${i.text}`, "issue");
  } catch (e) {
    fail(`the check could not run: ${(e as Error).message}`, "run");
  } finally {
    off();
    await page.close().catch(() => {});
    r.ms = Date.now() - t0;
  }
  return r;
}

/**
 * browser-restart: the done line's three sizes at once (see the head of this file): three viewers of one tab; Chrome
 * stopped and started; a reboot stand-in; a kitespan restart. It runs last: the restart leaves a successor on the port.
 */
export async function browserRestartFlow(ctx: BrowserFlowCtx, theme: Theme, life: BrowserLife): Promise<BrowserFlowResult> {
  const t0 = Date.now();
  const sizes = BROWSER_DONE_SIZES;
  const r = result("browser-restart", "chatBrowserTab", sizes[0]!, theme, `/c/${ctx.chat}/browser`);
  r.note = "three viewers of one tab (1280x800, 834x1194, 390x844); Chrome stopped and started; a reboot stand-in; a kitespan restart that keeps the tabs";
  const fail = (text: string, code = "flow") => r.failures.push({ code, text });
  const who = (i: number) => `${sizes[i]!.width}x${sizes[i]!.height}`;
  const pages: Page[] = [];
  /** The saved kind of tab (the test site's pages), by id and URL. */
  const sites = (tabs: ServerTab[]) => tabs.filter((t) => t.url.startsWith(ctx.site)).map((t) => `${t.id} ${t.url}`).sort();
  const shoot = async (step: string) => {
    for (const [i, p] of pages.entries()) await p.screenshot(join(ctx.shots, ctx.shotName(`browser-restart-${step}`, sizes[i]!, theme))).catch(() => {});
  };
  const looks = (ok: (x: PaneLook) => boolean, ms = 20000) => Promise.all(pages.map((p) => until(p, ok, ms)));
  /** A viewer on the tab with its socket up: a frame drawn and not dimmed, no Reconnecting... pill. */
  const isLive = (x: PaneLook, tab: string) => x.state === "running" && x.tab === tab && !x.reconnecting && !!x.frame?.drawn && !x.frame.dim;
  const said = (x: PaneLook) => `"${x.state}", tab ${x.tab}${x.reconnecting ? ", Reconnecting..." : ""}${x.frame?.drawn ? (x.frame.dim ? ", the frame dimmed" : "") : ", no frame"}`;
  /** The server's view once its saved tabs are `want` again (a reopened tab opens at about:blank, then navigates). */
  const untilSites = async (want: string[], ms = 15000) => {
    const end = Date.now() + ms;
    let v = await serverView(ctx.base);
    while ((!v || JSON.stringify(sites(v.tabs)) !== JSON.stringify(want)) && Date.now() < end) {
      await sleep(300);
      v = await serverView(ctx.base);
    }
    return v;
  };
  const issues = () => {
    for (const [i, p] of pages.entries()) for (const x of p.takeIssues()) fail(`${who(i)}: ${x.kind}: ${x.text}`, "issue");
  };
  try {
    // The tab: a new one of the laptop's, so its id is known.
    const laptop = await Page.open(ctx.cdp, sizes[0]!, theme);
    pages.push(laptop);
    await laptop.navigate(ctx.base + `/c/${ctx.chat}/browser`);
    let l = await until(laptop, (x) => x.state === "running" && !!x.frame?.drawn, 20000);
    if (l.state !== "running") return (fail(`the pane shows "${l.state}", not the running browser`), r);
    if (!(await press(laptop, '[data-testid="browser-new"]'))) return (fail("no New tab"), r);
    await sleep(250);
    await laptop.send("Input.insertText", { text: `${ctx.site}/plain?t=kept` });
    await laptop.key("Enter");
    l = await until(laptop, (x) => openTitle(x) === "kept" && !!x.tab && !!x.frame?.drawn, 20000);
    const tab = l.tab;
    if (!tab || openTitle(l) !== "kept") return (fail(`New tab with the test site's page shows "${openTitle(l)}"`), r);
    const view = `/c/${ctx.chat}/browser/${tab}`;
    r.path = view;

    // Three viewers of the tab (DESIGN-B1 2.9, D-11): each draws its own cast at its own size; one viewer's
    // navigation shows on all three.
    await laptop.navigate(ctx.base + view);
    for (const vp of sizes.slice(1)) {
      const p = await Page.open(ctx.cdp, vp, theme);
      pages.push(p);
      await p.navigate(ctx.base + view);
    }
    let ls = await looks((x) => isLive(x, tab));
    ls.forEach((x, i) => {
      if (!isLive(x, tab)) fail(`${who(i)}: the viewer shows ${said(x)}, not tab ${tab} live`);
    });
    const widths = ls.map((x) => x.frame?.cw ?? 0);
    r.details.castWidths = widths;
    if (new Set(widths).size === 1) fail(`the three viewers' frames are all ${widths[0]} px wide: each viewer's cast should have its own size`);
    await openUrl(pages[2]!, `${ctx.site}/plain?t=seen%20by%20three`, "seen by three", (t) => fail(`${who(2)}: ${t}`));
    ls = await looks((x) => openTitle(x) === "seen by three" && !!x.frame?.drawn);
    ls.forEach((x, i) => {
      if (openTitle(x) !== "seen by three") fail(`${who(i)}: after the phone's navigation this viewer shows "${openTitle(x)}", not "seen by three"`);
    });
    await shoot("viewers");
    issues();

    // Chrome stopped and started: every viewer says stopped; Start on one brings the tabs back under their ids.
    const before = await serverView(ctx.base);
    if (!before) return (fail(`the flow's own pane socket got no opened frame: ${viewProblem}`), r);
    r.details.before = sites(before.tabs);
    const stopped = await stopBrowser(ctx.base);
    if (stopped !== 200) fail(`Stop browser answered ${stopped}`);
    ls = await looks((x) => x.state === "off");
    for (const [i, x] of ls.entries()) {
      const words = x.state === "off" ? await wordsOf(pages[i]!, '[data-testid="browser-state"]', true) : "";
      if (!words.includes("The browser is stopped")) fail(`${who(i)}: after Stop the pane shows "${x.state}" with "${words.slice(0, 80)}"`);
    }
    if (!(await press(pages[2]!, '[data-testid="browser-start"]'))) fail(`${who(2)}: the stopped state has no Start browser`);
    ls = await looks((x) => isLive(x, tab), 30000);
    ls.forEach((x, i) => {
      if (!isLive(x, tab)) fail(`${who(i)}: after Start the pane shows ${said(x)}`);
    });
    const started = await untilSites(sites(before.tabs));
    r.details.afterStart = started && sites(started.tabs);
    if (!started || JSON.stringify(sites(started.tabs)) !== JSON.stringify(sites(before.tabs))) fail(`after Stop and Start the tabs are ${JSON.stringify(started && sites(started.tabs))}, before ${JSON.stringify(sites(before.tabs))}`);
    await shoot("started");
    issues();

    // A reboot stand-in: kitespan's quit (a shutdown's SIGTERM) stops Chrome and leaves it off (S4); Chrome's
    // session folders go; a new kitespan starts; the viewers say stopped; Start reopens the saved URLs under their ids.
    await life.quit();
    const down = await hostNow(ctx.base);
    r.details.afterQuit = down;
    if (down?.state !== "off") fail(`after kitespan's quit and a new start the browser is "${down?.state}", not off`);
    if (!life.portFree(life.cdpPort)) fail("after kitespan's quit the shared browser's port is still in use: Chrome did not stop");
    for (const d of ["Sessions", "Sessions_Encrypted"]) rmSync(join(life.profile, "Default", d), { recursive: true, force: true });
    if (["Sessions", "Sessions_Encrypted"].some((d) => existsSync(join(life.profile, "Default", d)))) fail("Chrome's session folders are still there");
    ls = await looks((x) => x.state === "off" && !x.reconnecting, 30000);
    ls.forEach((x, i) => {
      if (x.state !== "off" || x.reconnecting) fail(`${who(i)}: after the new kitespan the pane shows ${said(x)}, not the stopped browser`);
    });
    await shoot("rebooted");
    if (!(await press(pages[1]!, '[data-testid="browser-start"]'))) fail(`${who(1)}: the stopped state has no Start browser`);
    ls = await looks((x) => isLive(x, tab) && openTitle(x) === "seen by three", 30000);
    ls.forEach((x, i) => {
      if (!isLive(x, tab) || openTitle(x) !== "seen by three") fail(`${who(i)}: after the reboot stand-in's Start the pane shows ${said(x)} "${openTitle(x)}"`);
    });
    const reopened = await untilSites(sites(before.tabs));
    r.details.afterReboot = reopened && sites(reopened.tabs);
    if (!reopened || JSON.stringify(sites(reopened.tabs)) !== JSON.stringify(sites(before.tabs))) fail(`after the reboot stand-in the tabs are ${JSON.stringify(reopened && sites(reopened.tabs))}, before ${JSON.stringify(sites(before.tabs))}`);
    issues();

    // A kitespan restart (POST /api/restart, as Restart now sends): the successor adopts the running Chrome; every tab
    // stays, each saved one under its id (an about:blank tab is never saved, so it gets a new id: SERVER-B1 5.3); each
    // viewer comes back to its tab.
    const live = await serverView(ctx.base);
    const res = await fetch(`${ctx.base}/api/restart`, { method: "POST", headers: { "x-kitespan": "1", "content-type": "application/json", origin: ctx.base }, body: JSON.stringify({ when: "now" }) }).catch((e: Error) => e);
    if (res instanceof Error || res.status !== 202) fail(`POST /api/restart answered ${res instanceof Error ? res.message : res.status}`);
    let host: { state: string; how?: string } | null = null;
    const end = Date.now() + 40000;
    while (Date.now() < end) {
      host = await hostNow(ctx.base);
      if (host?.state === "running" && host.how === "adopted") break;
      await sleep(250);
    }
    r.details.afterRestart = host;
    if (host?.state !== "running" || host.how !== "adopted") fail(`after the restart the browser is ${JSON.stringify(host)}, not running and adopted`);
    ls = await looks((x) => isLive(x, tab), 30000);
    ls.forEach((x, i) => {
      if (!isLive(x, tab)) fail(`${who(i)}: after the restart the pane shows ${said(x)}`);
    });
    const kept = await serverView(ctx.base);
    const all = (v: { tabs: ServerTab[] } | null) => (v ? v.tabs.map((t) => `${t.id} ${t.url}`).sort() : null);
    const urls = (v: { tabs: ServerTab[] } | null) => (v ? v.tabs.map((t) => t.url).sort() : null);
    r.details.restartTabs = { before: all(live), after: all(kept) };
    if (!kept || !live) fail("the flow's own pane socket got no opened frame around the restart");
    else if (JSON.stringify(sites(kept.tabs)) !== JSON.stringify(sites(live.tabs)) || JSON.stringify(urls(kept)) !== JSON.stringify(urls(live))) fail(`after the restart the tabs are ${JSON.stringify(all(kept))}, before ${JSON.stringify(all(live))}`);
    await shoot("restarted");
    issues();
  } catch (e) {
    fail(`the check could not run: ${(e as Error).message}`, "run");
  } finally {
    for (const p of pages) await p.close().catch(() => {});
    r.ms = Date.now() - t0;
  }
  return r;
}
