// One page under test (DESIGN.md 8.2): its own browser context (so storage starts empty), the emulated size, touch
// and colour scheme, the console errors, exceptions and failed requests it produced, navigation that waits for the page
// to settle, and real input (mouse clicks on a laptop, touch taps on touch sizes, key events).
import type { Cdp, CdpEvent } from "./cdp";
import { sleep } from "./cdp";

export type SizeName = "laptop" | "medium" | "phone";
export type Theme = "dark" | "light";

/** The sizes that --sizes names (DESIGN-T1 3.1): the three of DESIGN 8.2, and v0.6 touch's five. */
export const SIZE_LABELS = ["laptop", "medium", "phone", "m626", "m768", "large", "large-land", "phone-land"] as const;
export type SizeLabel = (typeof SIZE_LABELS)[number];

/** Safe-area insets in CSS px, as a phone with a notch reports them (Emulation.setSafeAreaInsetsOverride). */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface Viewport {
  /** The size class the page must report (DESIGN 7.1). */
  name: SizeName;
  width: number;
  height: number;
  scale: number;
  mobile: boolean;
  touch: boolean;
  /** One of --sizes, so shots and results of two sizes of one class never overwrite each other. */
  label?: SizeLabel;
  /** The safe areas the page is opened with (a phone on its side). */
  insets?: Insets;
  /** A size's own tag in results and shots when one label has two forms (the large tablet's column form). */
  tag?: string;
  /** A script run before the page's own on every load (a device's stored view, such as a hidden sidebar). */
  preload?: string;
}

// DESIGN.md 8.2: device scale 2 for the tablet and 3 for the phone; the laptop has a fine pointer and no touch.
// DESIGN-T1 3.1 (v0.6 touch): 626x890 and 768x1024 (medium, the docked pane at 250 and 307 px), the large tablet in
// portrait and landscape (the laptop's class with touch) and a phone on its side with its safe areas.
export const VIEWPORTS: Viewport[] = [
  { name: "laptop", label: "laptop", width: 1100, height: 800, scale: 1, mobile: false, touch: false },
  { name: "medium", label: "medium", width: 834, height: 1194, scale: 2, mobile: true, touch: true },
  { name: "phone", label: "phone", width: 390, height: 844, scale: 3, mobile: true, touch: true },
  { name: "medium", label: "m626", width: 626, height: 890, scale: 2, mobile: true, touch: true },
  { name: "medium", label: "m768", width: 768, height: 1024, scale: 2, mobile: true, touch: true },
  { name: "laptop", label: "large", width: 1024, height: 1366, scale: 2, mobile: true, touch: true },
  { name: "laptop", label: "large-land", width: 1366, height: 1024, scale: 2, mobile: true, touch: true },
  { name: "phone", label: "phone-land", width: 844, height: 390, scale: 3, mobile: true, touch: true, insets: { top: 0, right: 47, bottom: 21, left: 47 } },
];

/** A size's tag in file names and results: its label, else its class with its size (a flow's own window). */
export function sizeTag(vp: Viewport): string {
  return vp.tag ?? vp.label ?? `${vp.name}-${vp.width}x${vp.height}`;
}

export interface Issue {
  kind: "console" | "exception" | "request" | "log";
  text: string;
}

/** What the page shows, read in the page (see PROBE). */
export interface PageState {
  path: string;
  ids: string[];
  expanded: string[];
  stubs: string[];
  scrollWidth: number;
  clientWidth: number;
  offenders: string[];
  actions: string[] | null;
  notices: string[];
  size: string | null;
  touch: boolean;
  /** The primary pointer and hover the page sees: "fine hover" on a laptop, "coarse none" on touch. */
  pointer: string;
}

export interface Confirm {
  found: boolean;
  id?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  covered?: string | null;
  candidates: string[];
  disabled: string[];
}

// Shared in-page helpers: an element counts as shown when it has a box and is not hidden. Content hidden until found
// (U2's folded work) keeps its boxes for the browser's Find, but the reader does not see it until it is revealed.
const HELPERS = `
  const shown = (el) => {
    if (!el.getClientRects().length) return false;
    if (el.closest('[hidden="until-found"]')) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.visibility !== "collapse";
  };
  const describe = (el) => {
    if (!el || !el.tagName) return String(el);
    const id = el.getAttribute("data-testid");
    const cls = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".") : "";
    return el.tagName.toLowerCase() + cls + (id ? "[data-testid=" + id + "]" : "");
  };
`;

/** Read the state: shown test ids, open (aria-expanded) controls, stubs, sideways overflow, recorded actions. */
const PROBE = `(() => {
  ${HELPERS}
  const ids = [...new Set([...document.querySelectorAll("[data-testid]")].filter(shown).map((e) => e.getAttribute("data-testid")))].sort();
  const expanded = [...document.querySelectorAll('[aria-expanded="true"]')].filter(shown).map((e) => {
    const owner = e.parentElement ? e.parentElement.closest("[data-testid]") : null;
    const label = (e.getAttribute("aria-label") || e.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 40);
    return (owner ? owner.getAttribute("data-testid") : "") + " > " + label;
  }).sort();
  const stubs = [...document.querySelectorAll("[data-stub]")].map((e) => e.getAttribute("data-stub") || describe(e));
  const de = document.documentElement;
  const vw = de.clientWidth;
  // An element past the right edge counts unless an ancestor that clips or scrolls sideways ends inside the viewport.
  const clipped = (el) => {
    if (getComputedStyle(el).position === "fixed") return false;
    for (let a = el.parentElement; a && a !== document.body && a !== de; a = a.parentElement) {
      const ox = getComputedStyle(a).overflowX;
      if (ox !== "visible" && a.getBoundingClientRect().right <= vw + 1) return true;
      if (getComputedStyle(a).position === "fixed") return false;
    }
    return false;
  };
  const offenders = [];
  for (const el of document.body ? document.body.querySelectorAll("*") : []) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || r.right <= vw + 1) continue;
    if (!shown(el) || clipped(el)) continue;
    offenders.push(describe(el) + " right=" + Math.round(r.right));
    if (offenders.length >= 5) break;
  }
  // The page's record of its mutating frames and requests (web/net/frames.ts): {t, at} each.
  const acts = window.__kitespanFrames;
  return {
    path: location.pathname + location.search,
    ids,
    expanded,
    stubs,
    scrollWidth: de.scrollWidth,
    clientWidth: vw,
    offenders,
    actions: Array.isArray(acts) ? acts.map((a) => (a && typeof a.t === "string" ? a.t : String(a))) : null,
    notices: [...document.querySelectorAll('[data-testid="link-notice"]')].filter(shown).map((e) => e.textContent.trim()),
    size: document.body ? document.body.dataset.size || null : null,
    touch: document.body ? document.body.classList.contains("touch") : false,
    pointer: ["fine", "coarse", "none"].find((p) => matchMedia("(pointer: " + p + ")").matches) + " " + (matchMedia("(hover: hover)").matches ? "hover" : "none"),
  };
})()`;

/** Wait until the document has loaded, fonts are ready, the DOM has been quiet for quietMs and no finite animation runs. */
const SETTLE = (quietMs: number, maxMs: number) => `(async () => {
  const t0 = performance.now();
  if (document.readyState !== "complete") await new Promise((r) => addEventListener("load", r, { once: true }));
  if (document.fonts) await document.fonts.ready;
  let last = performance.now();
  const mo = new MutationObserver(() => { last = performance.now(); });
  mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  const busy = () => document.getAnimations().some((a) => {
    if (a.playState !== "running") return false;
    const t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
    return !t || Number.isFinite(t.endTime);
  });
  try {
    while (performance.now() - t0 < ${maxMs}) {
      await new Promise((r) => setTimeout(r, 40));
      if (!busy() && performance.now() - last >= ${quietMs}) {
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return { settled: true, ms: Math.round(performance.now() - t0) };
      }
    }
    return { settled: false, ms: Math.round(performance.now() - t0) };
  } finally { mo.disconnect(); }
})()`;

/**
 * The confirm button to press, among the shown and enabled confirm-* buttons: inside the open modal sheet or dialog
 * when there is one; then the focused button; then the primary button near the focused field (its form, dialog or
 * test-id container); then the primary button; then the first one.
 */
const FIND_CONFIRM = (only?: string) => `(() => {
  ${HELPERS}
  const only = ${JSON.stringify(only ?? null)};
  // A named button may be a row's own (Send again on a Not sent message, send-again); else every confirm-* button.
  const all = [...document.querySelectorAll(only ? '[data-testid="' + only + '"]' : '[data-testid^="confirm-"]')].filter(shown);
  const enabled = all.filter((e) => !e.disabled && e.getAttribute("aria-disabled") !== "true");
  const disabled = all.filter((e) => !enabled.includes(e)).map((e) => e.getAttribute("data-testid"));
  const modals = [...document.querySelectorAll('[aria-modal="true"]')].filter(shown);
  const modal = modals[modals.length - 1];
  const pool = modal && enabled.some((e) => modal.contains(e)) ? enabled.filter((e) => modal.contains(e)) : enabled;
  const best = (list) => list.find((e) => e.classList.contains("primary")) || list[0];
  const active = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
  let near = null;
  for (let a = active; a && a !== document.body && !near; a = a.parentElement) {
    if (a.tagName !== "FORM" && a.getAttribute("role") !== "dialog" && !a.hasAttribute("data-testid")) continue;
    const inside = pool.filter((e) => a.contains(e));
    if (inside.length) near = best(inside);
  }
  const pick = pool.find((e) => active && (e === active || e.contains(active))) || near || best(pool);
  if (!pick) return { found: false, candidates: [], disabled };
  pick.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  const r = pick.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const at = document.elementFromPoint(x, y);
  return {
    found: true,
    id: pick.getAttribute("data-testid"),
    x, y, w: Math.round(r.width), h: Math.round(r.height),
    covered: at && !(at === pick || pick.contains(at)) ? describe(at) : null,
    candidates: pool.map((e) => e.getAttribute("data-testid")),
    disabled,
  };
})()`;

export class Page {
  issues: Issue[] = [];
  warnings: string[] = [];
  lastSettle: { settled: boolean; ms: number } = { settled: true, ms: 0 };
  private inflight = new Map<string, string>();
  private off: () => void;

  private constructor(
    private cdp: Cdp,
    readonly session: string,
    readonly targetId: string,
    readonly contextId: string,
    readonly vp: Viewport,
    readonly theme: Theme,
  ) {
    this.off = cdp.on((e) => {
      if (e.sessionId === session) this.event(e);
    });
  }

  /** A fresh page in a browser context of its own, with the size, touch and colour scheme set before any load. */
  static async open(cdp: Cdp, vp: Viewport, theme: Theme): Promise<Page> {
    const { browserContextId } = await cdp.send("Target.createBrowserContext", { disposeOnDetach: true });
    try {
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", browserContextId, newWindow: true });
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      const page = new Page(cdp, sessionId, targetId, browserContextId, vp, theme);
      await Promise.all(["Page.enable", "Runtime.enable", "Log.enable", "Network.enable"].map((m) => page.send(m)));
      await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      await page.send("Emulation.setEmulatedMedia", { media: "screen", features: [{ name: "prefers-color-scheme", value: theme }] });
      await page.send("Emulation.setTouchEmulationEnabled", vp.touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
      await page.metrics();
      if (vp.insets) await page.insets(vp.insets);
      if (vp.preload) await page.send("Page.addScriptToEvaluateOnNewDocument", { source: vp.preload });
      return page;
    } catch (e) {
      await cdp.send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
      throw e;
    }
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    return this.cdp.send<T>(method, params, this.session, timeoutMs);
  }

  /** Set the safe areas (null: none), as a phone with a notch reports them to env(safe-area-inset-*). */
  insets(i: Insets | null) {
    const v = i ?? { top: 0, right: 0, bottom: 0, left: 0 };
    return this.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: v.top, right: v.right, bottom: v.bottom, left: v.left } });
  }

  /** Send the view size again. DESIGN.md 8.2 does it after every navigation, reload and history move. */
  metrics() {
    const { width, height, scale, mobile } = this.vp;
    return this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile, screenWidth: width, screenHeight: height });
  }

  private event(e: CdpEvent) {
    const p = e.params;
    switch (e.method) {
      case "Runtime.consoleAPICalled": {
        const text = (p.args ?? []).map((a: any) => a.value ?? a.description ?? a.unserializableValue ?? a.type).join(" ");
        const at = p.stackTrace?.callFrames?.[0];
        const where = at?.url ? ` (${at.url.replace(/^https?:\/\/[^/]+/, "")}:${at.lineNumber + 1})` : "";
        if (p.type === "error" || p.type === "assert") this.issues.push({ kind: "console", text: `console.${p.type}: ${text}${where}` });
        else if (p.type === "warning") this.warnings.push(`console.warn: ${text}${where}`);
        break;
      }
      case "Runtime.exceptionThrown": {
        const d = p.exceptionDetails ?? {};
        const text = d.exception?.description?.split("\n")[0] ?? d.text ?? "exception";
        this.issues.push({ kind: "exception", text: `uncaught: ${text}` });
        break;
      }
      case "Log.entryAdded": {
        const en = p.entry ?? {};
        // Network entries repeat what Network.* already reported, with less detail.
        if (en.level === "error" && en.source !== "network") this.issues.push({ kind: "log", text: `${en.source}: ${en.text}${en.url ? ` (${en.url})` : ""}` });
        break;
      }
      case "Network.requestWillBeSent":
        this.inflight.set(p.requestId, p.request?.url ?? "");
        break;
      case "Network.loadingFinished":
        this.inflight.delete(p.requestId);
        break;
      case "Network.loadingFailed": {
        const url = this.inflight.get(p.requestId) ?? "";
        this.inflight.delete(p.requestId);
        if (!p.canceled) this.issues.push({ kind: "request", text: `request failed: ${p.errorText} ${url}`.trim() });
        break;
      }
      case "Network.responseReceived": {
        const r = p.response ?? {};
        if (r.status >= 400) this.issues.push({ kind: "request", text: `HTTP ${r.status} ${r.url}` });
        break;
      }
    }
  }

  /** The issues since the last call, and clear them. */
  takeIssues(): Issue[] {
    const out = this.issues;
    this.issues = [];
    return out;
  }

  async evaluate<T = any>(expression: string, timeoutMs?: number): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (r.exceptionDetails) throw new Error(`in-page script failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value as T;
  }

  /** Wait for the page to settle: quiet DOM, no finite animation, no request in flight (capped). */
  async settle(quietMs = 250, maxMs = 6000) {
    try {
      this.lastSettle = await this.evaluate(SETTLE(quietMs, maxMs), maxMs + 5000);
    } catch (e) {
      // A navigation during the wait destroys the context; wait once more on the new document.
      this.lastSettle = await this.evaluate(SETTLE(quietMs, maxMs), maxMs + 5000).catch(() => ({ settled: false, ms: maxMs }));
    }
    const t0 = Date.now();
    while (this.inflight.size && Date.now() - t0 < 3000) await sleep(50);
    if (this.inflight.size) this.lastSettle = { settled: false, ms: this.lastSettle.ms + 3000 };
  }

  async navigate(url: string) {
    const load = this.cdp.expect("Page.loadEventFired", { sessionId: this.session, timeoutMs: 20000 });
    const r = await this.send("Page.navigate", { url });
    if (r.errorText) {
      load.cancel();
      throw new Error(`could not open ${url}: ${r.errorText}`);
    }
    await load.promise;
    await this.metrics();
    await this.settle();
  }

  /** Reload with CDP Page.reload (DESIGN.md 8.2). */
  async reload() {
    const load = this.cdp.expect("Page.loadEventFired", { sessionId: this.session, timeoutMs: 20000 });
    await this.send("Page.reload", {});
    await load.promise;
    await this.metrics();
    await this.settle();
  }

  history(): Promise<{ currentIndex: number; entries: { id: number; url: string; title: string }[] }> {
    return this.send("Page.getNavigationHistory");
  }

  /** Move to a history entry, as Back and Forward do, and wait for the page to settle. */
  async goToEntry(entryId: number) {
    const moved = this.cdp.expect(["Page.navigatedWithinDocument", "Page.loadEventFired"], { sessionId: this.session, timeoutMs: 10000 });
    await this.send("Page.navigateToHistoryEntry", { entryId });
    const ev = await moved.promise.catch(() => null);
    if (ev?.method === "Page.navigatedWithinDocument") await sleep(30);
    await this.metrics();
    await this.settle();
  }

  probe(): Promise<PageState> {
    return this.evaluate<PageState>(PROBE);
  }

  /** The confirm button to press (or, with a test id, that one button). */
  findConfirm(only?: string): Promise<Confirm> {
    return this.evaluate<Confirm>(FIND_CONFIRM(only));
  }

  /** The text of the container (the closest element with a test id) around a shown element with this test id. */
  textAround(testId: string): Promise<string | null> {
    return this.evaluate(`(() => {
      ${HELPERS}
      const el = [...document.querySelectorAll('[data-testid="' + ${JSON.stringify(testId)} + '"]')].find(shown);
      if (!el) return null;
      const box = el.parentElement ? el.parentElement.closest("[data-testid]") : null;
      return (box || el).textContent.replace(/\\s+/g, " ").trim();
    })()`);
  }

  /** Find the first shown element for a selector, scroll it into view, and return its centre and what covers it. */
  async locate(selector: string): Promise<{ x: number; y: number; covered: string | null; label: string } | null> {
    return this.evaluate(`(() => {
      ${HELPERS}
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(shown);
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const at = document.elementFromPoint(x, y);
      return { x, y, covered: at && !(at === el || el.contains(at)) ? describe(at) : null, label: describe(el) };
    })()`);
  }

  /** A click on a laptop (mouse events), a tap on a touch size (touch events, which Chrome follows with a click). */
  async press(x: number, y: number) {
    if (this.vp.touch) {
      await this.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, radiusX: 4, radiusY: 4, force: 1 }] });
      await this.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else {
      await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
      await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    }
  }

  /** A long-press on touch (the finger stays down `ms`); a laptop has none, so it is a right-click there. */
  async hold(x: number, y: number, ms = 750) {
    if (this.vp.touch) {
      await this.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, radiusX: 4, radiusY: 4, force: 1 }] });
      await sleep(ms);
      await this.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else {
      await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "right", buttons: 2, clickCount: 1 });
      await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "right", buttons: 0, clickCount: 1 });
    }
  }

  async key(key: "Escape" | "Enter") {
    const code = key === "Escape" ? 27 : 13;
    const base = { key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...base, ...(key === "Enter" ? { text: "\r" } : {}) });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  /** A viewport-sized JPEG (DESIGN.md 8.2: never one huge reply). */
  async screenshot(file: string, quality = 70) {
    const { data } = await this.send<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality });
    await Bun.write(file, Buffer.from(data, "base64"));
  }

  async close() {
    this.off();
    await this.cdp.send("Target.disposeBrowserContext", { browserContextId: this.contextId }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------------------------
// v0.6 touch's route measures (DESIGN-T1 3.2), read in the page on touch sizes. One script returns them all, so a route
// check reads the page once: control-out (the box test and the point test, mockups/tools/control-out.js), blur-touch,
// name-cut, named-touch, opener-touch and name-break (mockups/tools/name-break.js). Each list holds a short name per
// finding; an empty list is clean.

export interface TouchMeasures {
  /** Controls checked by the box test and by the point test, and those the point test leaves out as designed. */
  counts: { checked: number; pointChecked: number; clipped: number; underPane: number };
  controlBox: string[];
  controlPoint: string[];
  blur: string[];
  nameCut: string[];
  named: string[];
  opener: string[];
  nameBreak: string[];
  /** The named tools seen, by their bar: for the report. */
  tools: Record<string, string[]>;
}

export const TOUCH_MEASURES = String.raw`(() => {
  const CONT = ".cmp-slab, .side-pane, .sheet, .menu, .dialog, .topbar, .term-keys, .pane-bar";
  const MODAL = '[aria-modal="true"], .menu, .sheet, .scrim';
  const KEYS = ".cmp-bar-end > *, .cmp-keys > *, .cmp-slab .cmp-key, .side-pane-head button, .side-pane-head a[href], .pane-bar button, .pane-bar a[href]";
  const all = (sel, root) => [...(root || document).querySelectorAll(sel)];
  const vis = (e) => {
    if (!e.getClientRects().length) return false;
    if (e.closest('[hidden="until-found"]')) return false;
    if (e.checkVisibility && !e.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true })) return false;
    const c = getComputedStyle(e);
    if (c.visibility === "hidden" || c.display === "none") return false;
    let o = 1;
    for (let p = e; p && p !== document.documentElement; p = p.parentElement) o *= Number(getComputedStyle(p).opacity);
    return o > 0.01;
  };
  const name = (e) => String(e.getAttribute("data-testid") || e.getAttribute("aria-label") || (e.textContent || "").trim().replace(/\s+/g, " ").slice(0, 24) || e.className).slice(0, 40);
  const inside = (r, b, slack) => r.left >= b.left - slack && r.right <= b.right + slack && r.top >= b.top - slack && r.bottom <= b.bottom + slack;
  const overlaps = (r, b) => r.left < b.right && r.right > b.left && r.top < b.bottom && r.bottom > b.top;
  const scroller = (e) => {
    for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
      const c = getComputedStyle(p);
      if (/(auto|scroll)/.test(c.overflowY + " " + c.overflowX) && (p.scrollHeight > p.clientHeight + 1 || p.scrollWidth > p.clientWidth + 1)) return p;
    }
    return null;
  };
  const clippedBy = (e, r) => {
    for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
      const c = getComputedStyle(p);
      if (c.overflowX === "visible" && c.overflowY === "visible") continue;
      if (!inside(r, p.getBoundingClientRect(), 1)) return true;
    }
    return false;
  };
  const out = { counts: { checked: 0, pointChecked: 0, clipped: 0, underPane: 0 }, controlBox: [], controlPoint: [], blur: [], nameCut: [], named: [], opener: [], nameBreak: [], tools: {} };

  // control-out
  const view = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  const modals = all(MODAL).filter(vis);
  const band = all(".main-col > .topbar, .scr-bar").filter(vis);
  // The composer's dock, the waiting card's, the floating Jump to latest over the chat's end, and a split's divider (on
  // touch its grab room lies 16 px over the upper half, whose scroll moves a control out from under it): a control under
  // them is under a floating part by design.
  const dock = all('.cmp-dock, .chat-dock, [data-testid="chat-jump"], [data-testid="split-divider"]').filter(vis);
  const over = all("aside.side-pane.side-over").filter(vis);
  for (const c of all('button, a[href], [role="button"], input:not([type="hidden"]), textarea, select').filter(vis)) {
    const r = c.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    // A control that a part slides out of view (a closing pane's inert box) is not on screen as a control.
    if (c.closest("[inert], [aria-hidden='true']")) continue;
    let cont = c.parentElement && c.parentElement.closest(CONT);
    const sc0 = scroller(c);
    // A control that a scroller scrolls (the container itself, or a part inside it: the key bar's) may lie past the
    // container's box: that is its design, so only a control that is not scrolled takes the box test.
    if (cont && sc0 && cont.contains(sc0)) cont = null;
    if (cont) {
      out.counts.checked++;
      if (!inside(r, cont.getBoundingClientRect(), 1)) out.controlBox.push(name(c) + " (" + Math.round(r.left) + "-" + Math.round(r.right) + ", " + Math.round(r.top) + "-" + Math.round(r.bottom) + ") out of " + String(cont.className).split(" ")[0]);
    }
    const key = c.matches(KEYS);
    if (modals.some((m) => !m.contains(c))) continue;
    // A layer over the whole chat (the Browser at 834, the changes view at 626 and 768) covers the composer whole: it
    // is the view then. G-30's defect is a pane that covers only part of the composer's keys.
    const slab = c.closest(".cmp-slab");
    if (key && slab && over.some((o) => !o.contains(c) && inside(slab.getBoundingClientRect(), o.getBoundingClientRect(), 1))) { out.counts.underPane++; continue; }
    if (!key) {
      if (!inside(r, view, 0)) continue;
      if (clippedBy(c, r)) { out.counts.clipped++; continue; }
      if (over.some((o) => !o.contains(c) && overlaps(r, o.getBoundingClientRect()))) { out.counts.underPane++; continue; }
      const sc = scroller(c);
      if (sc && !inside(r, sc.getBoundingClientRect(), 0)) continue;
      if (band.concat(dock).some((b) => !b.contains(c) && overlaps(r, b.getBoundingClientRect()))) continue;
    }
    out.counts.pointChecked++;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const pts = [[cx, r.top + 4], [cx, r.bottom - 4], [r.left + 4, cy], [r.right - 4, cy]];
    const bad = pts.filter((p) => {
      if (p[0] < 0 || p[1] < 0 || p[0] >= innerWidth || p[1] >= innerHeight) return true;
      const hit = document.elementFromPoint(p[0], p[1]);
      if (!hit) return true;
      if (hit === c || c.contains(hit)) return false;
      // Only a control nested in this one, or around it (a row that is a link holding a button), shares its points; a
      // sibling control of the same row there covers it (G-30's defect inside a row).
      const other = hit.closest('button, a[href], [role="button"]');
      return !(other && (other.contains(c) || c.contains(other)));
    });
    if (bad.length) {
      const hit = document.elementFromPoint(bad[0][0], bad[0][1]);
      out.controlPoint.push(name(c) + " covered at " + bad.length + " of 4 points by " + (hit ? String(hit.getAttribute("data-testid") || hit.className || hit.tagName).split(" ")[0] : "nothing"));
    }
  }

  // blur-touch: on touch every bar, drawer, sheet and menu is opaque (DESIGN 7.9).
  // A computed colour's alpha in any of its forms: rgb(r g b / a), rgba(r, g, b, a), color(srgb r g b / a),
  // oklch(l c h / a) and the rest of the functions, a percent or a number; none given is opaque.
  const alpha = (v) => {
    if (!v || v === "transparent") return v === "transparent" ? 0 : 1;
    const m = /^[a-z-]+\((.*)\)$/i.exec(v.trim());
    if (!m) return 1;
    const slash = m[1].lastIndexOf("/");
    const commas = m[1].split(",");
    const a = slash >= 0 ? m[1].slice(slash + 1).trim() : /^(rgba|hsla)\(/i.test(v) && commas.length === 4 ? commas[3].trim() : null;
    if (a === null) return 1;
    return a.endsWith("%") ? parseFloat(a) / 100 : parseFloat(a);
  };
  for (const el of all(".topbar, .pane-bar, .sidebar, .shell-drawer, .scr-drawer, .sheet, .menu").filter(vis)) {
    const cs = getComputedStyle(el);
    const before = getComputedStyle(el, "::before");
    const hasBefore = before.content !== "none" && before.content !== "normal";
    const filters = [cs.backdropFilter, cs.webkitBackdropFilter].concat(hasBefore ? [before.backdropFilter, before.webkitBackdropFilter] : []).filter((f) => f && f !== "none");
    if (filters.length) out.blur.push(name(el) + ": backdrop " + filters[0]);
    const a = Math.max(alpha(cs.backgroundColor), hasBefore ? alpha(before.backgroundColor) : 0);
    if (a < 0.999) out.blur.push(name(el) + ": background alpha " + a);
  }

  // name-cut: a name wider than its box.
  const cut = (e) => e.scrollWidth > e.clientWidth + 1;
  for (const e of all(".side-pane .side-pl-name, .side-pane .seg-label, .side-pane .side-row-text, .side-pane .srch-name").filter(vis)) if (cut(e)) out.nameCut.push(e.textContent.trim().slice(0, 40));
  for (const e of all(".scr-bar-heading").filter(vis)) if (cut(e)) out.nameCut.push("heading " + e.textContent.trim().slice(0, 30));
  for (const e of all(".scr-head-name").filter(vis)) if (!e.closest("[data-tight]") && (cut(e) || e.getBoundingClientRect().width > e.parentElement.getBoundingClientRect().width + 1)) out.nameCut.push("head name " + e.textContent.trim());
  // A chat's title gives way only under T-28's rule: it keeps its whole width or 40% of the band, whichever is less.
  for (const e of all(".scr-bar-title").filter(vis)) {
    const text = e.querySelector(".scr-bar-title-text") || e;
    if (!cut(text)) continue;
    const bar = e.closest(".scr-bar, .topbar");
    const bw = bar ? bar.getBoundingClientRect().width : innerWidth;
    if (text.clientWidth + 1 < Math.min(text.scrollWidth, 0.4 * bw)) out.nameCut.push("title " + Math.round(text.clientWidth) + " px of " + text.scrollWidth + " in a " + Math.round(bw) + " px band");
  }

  // named-touch: a bar's named tools show their names, or (data-tight) carry them as their accessible names.
  const toolName = (t) => (t.getAttribute("aria-label") || t.textContent || "").trim().replace(/\s+/g, " ");
  // A name the bar's own form hides (the band's Chats word beside a docked pane: clipped to nothing) counts as an
  // icon's, as a tight bar's does: its words must then be the tool's accessible name.
  const dropped = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width <= 1 || r.height <= 1 || cs.clipPath === "inset(50%)" || cs.display === "none"; };
  const checkTool = (t, nameEl, where) => {
    const tight = !!t.closest("[data-tight]") || (!!nameEl && dropped(nameEl));
    const words = toolName(t);
    (out.tools[where] = out.tools[where] || []).push(words + (tight ? " (tight)" : ""));
    if (tight) {
      if (!words) out.named.push(where + ": a tight tool has no name");
      return;
    }
    if (!nameEl || !vis(nameEl) || nameEl.closest(".visually-hidden")) { out.named.push(where + ": " + (words || "a tool") + " shows no name"); return; }
    if (cut(nameEl) || !inside(nameEl.getBoundingClientRect(), t.getBoundingClientRect(), 1)) out.named.push(where + ": " + words + "'s name is cut");
  };
  for (const t of all(".touch .scr-bar-tool").filter(vis)) checkTool(t, t.querySelector(":scope > span:not(.dot)"), "bar");
  for (const t of all(".touch .scr-head-tool").filter(vis)) checkTool(t, t.querySelector(".scr-head-name"), "list head");
  const size = document.body.dataset.size;
  const touch = document.body.classList.contains("touch");
  const want = (where, names) => {
    const have = (out.tools[where] || []).map((n) => n.replace(/ \(tight\)$/, ""));
    for (const n of names) if (!have.some((h) => h === n || h.startsWith(n + " ") || h.startsWith(n + ","))) out.named.push(where + ": no " + n);
  };
  if (touch) {
    for (const head of all('[data-testid="head-tools"]').filter(vis)) {
      // By their parts, since a name changes with the place (on /browser the Browser button reads Close browser).
      for (const [sel, n] of [[".scr-search", "Search"], ['[data-testid="browser-button"]', "Browser"], [".scr-compose", "New"]]) if (!all(sel, head).some(vis)) out.named.push("list head: no " + n);
      if (size === "laptop" && head.closest('[data-testid="sidebar"]') && !head.querySelector(".sidebar-hide")) out.named.push("list head: no Hide sidebar");
    }
    if (size === "phone" && /^\/chats(\?|$)/.test(location.pathname + location.search)) want("bar", ["Search", "Browser", "New"]);
    const sidebar = all('[data-testid="sidebar"]').filter(vis).filter((e) => !e.closest(".shell-drawer, .scr-drawer"));
    const chatBand = all(".main-col > .topbar .scr-bar-tools").filter(vis);
    if (size === "laptop" && !sidebar.length && chatBand.length && !all('[data-testid="topbar-search"]').some(vis)) out.named.push("title bar: no Search while the sidebar is hidden");
  }

  // opener-touch: each long-press target has a visible "..." in its row (or, where the pane is wide, its own buttons).
  if (touch) {
    for (const t of all("[data-row-press]").filter(vis)) {
      const tr = t.getBoundingClientRect();
      if (tr.bottom <= 0 || tr.top >= innerHeight) continue;
      if (t.closest("[inert], [aria-hidden='true']")) continue;
      let row = t, ok = false;
      for (let i = 0; i < 5 && row && !ok; i++, row = row.parentElement) {
        const more = all("[aria-haspopup]", row).filter(vis).find((b) => { const r = b.getBoundingClientRect(); return r.width >= 43.5 && r.height >= 43.5 && r.top < tr.bottom && r.bottom > tr.top; });
        if (more) ok = true;
        else if (row.matches(".side-up, li") && all("button", row).filter(vis).filter((b) => b.getBoundingClientRect().width >= 43.5).length >= 3) ok = true;
      }
      if (!ok) out.opener.push(name(t));
    }
  }

  // name-break: a name breaks at its own punctuation (after "/", "-" or a space, before "." or "_"), unless the part
  // between two such points is wider than its box.
  const clean = (text, i) => { const a = text[i - 1], b = text[i]; return a === "/" || a === "-" || a === " " || b === "." || b === "_" || b === " "; };
  const range = document.createRange();
  for (const el of all(".side-pl-name, .row-menu-head").filter(vis)) {
    let text = "";
    const nodes = [], tops = [];
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode()); ) for (let i = 0; i < n.data.length; i++) {
      range.setStart(n, i);
      range.setEnd(n, i + 1);
      const rs = range.getClientRects();
      text += n.data[i];
      nodes.push([n, i]);
      tops.push(rs.length ? Math.round(rs[0].top) : null);
    }
    const box = el.clientWidth;
    for (let i = 1; i < text.length; i++) {
      if (tops[i] === null || tops[i - 1] === null || tops[i] <= tops[i - 1] + 2 || clean(text, i)) continue;
      // The part between the clean points around the break: wider than the box, it may break anywhere.
      let a = i - 1, b = i;
      while (a > 0 && !clean(text, a)) a--;
      while (b < text.length && !clean(text, b)) b++;
      const s = nodes[a], e = nodes[b - 1];
      range.setStart(s[0], s[1]);
      range.setEnd(e[0], e[1] + 1);
      let wide = 0;
      for (const r of range.getClientRects()) wide += r.width;
      if (wide <= box + 1) out.nameBreak.push(text.slice(0, i) + " / " + text.slice(i));
    }
  }
  return out;
})()`;

/**
 * The safe-area measure's reads (DESIGN-T1 3.2 `safe-area`): every shown element's bottom padding, by a mark the page
 * keeps, so a second read with other insets compares the same elements; and on a phone on its side whether the bars'
 * and sheets' controls clear the side insets.
 */
export const SAFE_AREA_READ = String.raw`((mark) => {
  const vis = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
  const els = window.__fdSafe || (window.__fdSafe = [...document.body.querySelectorAll("*")].filter(vis));
  const pads = els.map((e) => parseFloat(getComputedStyle(e).paddingBottom) || 0);
  return { n: els.length, pads, names: mark ? els.map((e) => (e.getAttribute("data-testid") || (typeof e.className === "string" ? e.className.split(" ")[0] : "") || e.tagName.toLowerCase())) : null };
})`;

export const SAFE_AREA_SIDES = String.raw`((left, right) => {
  const vis = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
  const out = [];
  for (const host of [...document.querySelectorAll(".topbar, .scr-bar, .sheet")].filter(vis)) {
    for (const c of [...host.querySelectorAll("button, a[href], input, textarea")].filter(vis)) {
      const r = c.getBoundingClientRect();
      if (!r.width || r.right <= 0 || r.left >= innerWidth) continue;
      if (r.left < left - 1 || r.right > innerWidth - right + 1) out.push((c.getAttribute("data-testid") || c.getAttribute("aria-label") || c.textContent.trim().slice(0, 20)) + " at " + Math.round(r.left) + "-" + Math.round(r.right));
    }
  }
  return out;
})`;
