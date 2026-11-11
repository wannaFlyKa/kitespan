// A probe that test/web/demo-frame.test.ts runs in a process of its own: it gives the demo frame's first module
// (site/demo/shim.ts) the globals of a page at <origin>/kitespan/demo/?device=<device>, inside a landing page of the same
// origin (or alone), imports it and then the bridge (site/demo/bridge.ts), and prints what they did as one JSON line.
// A process of its own, because the shim changes the globals (fetch, WebSocket, storage) for the page's whole life.
import { DemoServer } from "../../site/demo/server";

const ORIGIN = "https://wannaflyka.github.io";
const device = process.argv[2] ?? "phone";
const alone = process.argv[3] === "alone";
const g = globalThis as unknown as Record<string, unknown>;

let href = `${ORIGIN}/kitespan/demo/?device=${device}`;
const replaced: string[] = [];
const moves: string[] = [];
g.location = {
  get href() {
    return href;
  },
  get search() {
    return new URL(href).search;
  },
  get pathname() {
    return new URL(href).pathname;
  },
  get host() {
    return new URL(href).host;
  },
  get protocol() {
    return new URL(href).protocol;
  },
  origin: ORIGIN,
  replace: (u: string) => void replaced.push(new URL(u, href).href),
};
g.history = {
  state: null,
  replaceState: (_s: unknown, _t: string, u: string) => {
    href = new URL(u, href).href;
    moves.push(href);
  },
  pushState: (_s: unknown, _t: string, u: string) => {
    href = new URL(u, href).href;
  },
};
const server = new DemoServer({ lang: "en", pace: 0 });
server.setTheme("dark");
const posted: { data: unknown; origin: string }[] = [];
g.window = g;
g.parent = alone
  ? g
  : {
      location: { origin: ORIGIN },
      document: { documentElement: { getAttribute: (n: string) => (n === "data-theme" ? "dark" : null) } },
      postMessage: (data: unknown, origin: string, transfer: unknown[]) => {
        posted.push({ data, origin });
        server.connectPort(transfer[0] as never);
      },
    };
g.matchMedia = (q: string) => ({ matches: /dark/.test(q), media: q, addEventListener() {}, removeEventListener() {} });
const docListeners: string[] = [];
const handlers = new Map<string, ((e: unknown) => void)[]>();
g.document = {
  addEventListener: (t: string, fn: (e: unknown) => void) => {
    docListeners.push(t);
    handlers.set(t, [...(handlers.get(t) ?? []), fn]);
  },
  documentElement: { dataset: {}, setAttribute() {}, removeAttribute() {} },
};
// The frame's element on the landing page: inert while the device switch shows the other frame.
let frameHidden = false;
let frameBlurs = 0;
g.frameElement = alone ? null : { closest: (sel: string) => (sel === "[inert]" && frameHidden ? {} : null), blur: () => void frameBlurs++ };
// The elements' focus(), as the browser's: each call that reaches it is counted.
let focusCalls = 0;
class FakeElement {
  blurs = 0;
  focus(_o?: unknown) {
    focusCalls++;
  }
  blur() {
    this.blurs++;
  }
}
g.HTMLElement = class extends FakeElement {};
g.SVGElement = class extends FakeElement {};

await import("../../site/demo/shim");
const out: Record<string, unknown> = { href, moves, replaced, posted, docListeners: [...docListeners] };
// The frame's own storage, in memory (alone too: the app runs for a moment before the browser leaves).
const local = g.localStorage as Storage | undefined;
out.settings = local?.getItem("kitespan.settings") ?? null;
out.view = local?.getItem("kitespan.view") ?? null;
out.session = (g.sessionStorage as Storage | undefined)?.length ?? null;
out.coarse = (g.matchMedia as (q: string) => { matches: boolean })("(pointer: coarse)").matches;
out.fine = (g.matchMedia as (q: string) => { matches: boolean })("(pointer: fine)").matches;
out.dark = (g.matchMedia as (q: string) => { matches: boolean })("(prefers-color-scheme: dark)").matches;
out.touchPoints = navigator.maxTouchPoints;
out.serviceWorker = (navigator as unknown as { serviceWorker?: unknown }).serviceWorker === undefined;
out.open = (g.open as () => unknown)();
out.memoryStorage = typeof local?.setItem === "function" && typeof (g.sessionStorage as Storage | undefined)?.setItem === "function";

// The keyboard: an element's focus() while the frame is hidden, then shown; and a focus that arrives while hidden.
const El = g.HTMLElement as new () => FakeElement;
const Svg = g.SVGElement as new () => FakeElement;
frameHidden = true;
new El().focus();
new Svg().focus({ preventScroll: true });
const whileHidden = focusCalls;
const target = new El();
for (const fn of handlers.get("focusin") ?? []) fn({ target });
const hiddenFocusin = { targetBlurs: target.blurs, frameBlurs };
frameHidden = false;
new El().focus();
const shownTarget = new El();
for (const fn of handlers.get("focusin") ?? []) fn({ target: shownTarget });
out.focus = { whileHidden, whileShown: focusCalls - whileHidden, hiddenFocusin, shownFocusin: { targetBlurs: shownTarget.blurs, frameBlurs: frameBlurs - hiddenFocusin.frameBlurs } };

if (!alone) {
  // The stand-ins: the app's API read and its socket reach the landing page's server, over the frame's port.
  const res = await (g.fetch as typeof fetch)("/api/projects");
  out.fetch = { status: res.status, names: ((await res.json()) as { projects: { name: string }[] }).projects.map((p) => p.name) };
  out.offSite = await (g.fetch as typeof fetch)("https://example.com/x").then(
    () => "answered",
    (e: Error) => e.message,
  );
  const WS = g.WebSocket as new (u: string) => { onopen: (() => void) | null; onmessage: ((e: { data: unknown }) => void) | null; send(d: string): void; readyState: number };
  out.welcome = await new Promise((resolve) => {
    const ws = new WS(`wss://wannaflyka.github.io/ws`);
    ws.onopen = () => ws.send(JSON.stringify({ t: "hello", v: 4, tab: "probeTab01" }));
    ws.onmessage = (e) => {
      const f = JSON.parse(String(e.data)) as { t: string; host?: string };
      if (f.t === "welcome") resolve(f.host);
    };
  });
  // The bridge, after the app: the landing page's theme becomes the app's own setting.
  await import("../../site/demo/bridge");
  const { getState } = await import("../../web/state/store");
  out.themeAtStart = getState().settings.theme;
  server.setTheme("light");
  await Bun.sleep(50);
  out.themeAfter = getState().settings.theme;
  out.docListeners = [...docListeners];
}
console.log(JSON.stringify(out));
process.exit(0);
