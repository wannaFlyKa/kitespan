// The demo frame's first and last modules (site/demo/shim.ts and bridge.ts, DESIGN-W1 4.1 to 4.6), in a process of
// their own (test/web/demo-frame-probe.ts), with the globals of a frame at demo/?device=<device>: before the app runs,
// the frame's URL is its device's start route at the origin's root, its storage is its own and in memory with the
// landing page's theme (and the laptop's split share), the phone acts as a phone and the laptop as a laptop, no
// service worker shows, window.open goes nowhere, fetch and WebSocket reach the landing page's server over the frame's
// port and nothing else, the landing page's later theme becomes the app's own setting, and while the frame is not shown
// (inert on the landing page) nothing in it takes the focus. Opened alone, the frame goes to the landing page, posts to
// no one, and its storage is still its own, in memory, for the moment before it leaves.
import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { DEMO_TAG, START_ROUTES } from "../../site/demo/lines";
// Type-checked with the page's types here (tsconfig.web.json): the demo frame's entry and its words swap.
import type * as _frame from "../../site/demo/frame";
import type * as _words from "../../site/demo/swap/notify-words";

const ORIGIN = "https://wannaflyka.github.io";
const PROBE = join(import.meta.dir, "demo-frame-probe.ts");

async function probe(...args: string[]): Promise<Record<string, any>> {
  const proc = Bun.spawn([process.execPath, "--no-env-file", PROBE, ...args], { cwd: join(import.meta.dir, "..", ".."), stdout: "pipe", stderr: "pipe", env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: process.env.HOME ?? "/", TMPDIR: process.env.TMPDIR ?? "/tmp" } });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`the probe failed (exit ${code}): ${err.slice(-2000)}`);
  return JSON.parse(out.trim().split("\n").at(-1)!);
}

describe("the frame's shim and bridge", () => {
  test("the phone: its start route, a coarse pointer and touch points, the page's theme, the stand-ins", async () => {
    const r = await probe("phone");
    expect(r.moves).toEqual([`${ORIGIN}${START_ROUTES.phone}`]);
    expect(r.posted).toEqual([{ data: { [DEMO_TAG]: 1, device: "phone" }, origin: ORIGIN }]);
    expect(JSON.parse(r.settings)).toEqual({ theme: "dark" });
    expect(r.view).toBe(null);
    expect(r.session).toBe(0);
    expect([r.coarse, r.fine, r.touchPoints]).toEqual([true, false, 5]);
    // Other media queries are the browser's own.
    expect(r.dark).toBe(true);
    expect(r.serviceWorker).toBe(true);
    expect(r.open).toBe(null);
    expect(r.fetch).toEqual({ status: 200, names: ["kitespan", "scratch", "notes-api"] });
    expect(r.offSite).toBe("Failed to fetch");
    expect(r.welcome).toBe("box");
    expect([r.themeAtStart, r.themeAfter]).toEqual(["dark", "light"]);
    // The shim's focus guard and its guard on API links, then the bridge's modified and middle clicks.
    expect(r.docListeners).toEqual(["focusin", "click", "click", "auxclick"]);
    expect(r.memoryStorage).toBe(true);
  }, 30_000);

  test("hidden on the landing page, the frame takes no focus: focus() does nothing, and a focus that comes goes back", async () => {
    const r = await probe("laptop");
    expect(r.focus).toEqual({ whileHidden: 0, whileShown: 1, hiddenFocusin: { targetBlurs: 1, frameBlurs: 1 }, shownFocusin: { targetBlurs: 0, frameBlurs: 0 } });
  }, 30_000);

  test("the laptop: its start route with the split panel, a fine pointer, no touch points", async () => {
    const r = await probe("laptop");
    expect(r.moves).toEqual([`${ORIGIN}${START_ROUTES.laptop}`]);
    expect(JSON.parse(r.view)).toEqual({ split: 0.62 });
    expect([r.coarse, r.fine, r.touchPoints]).toEqual([false, true, 0]);
  }, 30_000);

  test("full width on a phone: the device's own pointer", async () => {
    const r = await probe("auto");
    expect(r.moves).toEqual([`${ORIGIN}${START_ROUTES.auto}`]);
    expect(r.coarse).toBe(false);
  }, 30_000);

  test("opened alone: it goes to the landing page, moves no URL, posts to no one and keeps nothing in the browser", async () => {
    const r = await probe("phone", "alone");
    expect(r.replaced).toEqual([`${ORIGIN}/kitespan/`]);
    expect(r.moves).toEqual([]);
    expect(r.posted).toEqual([]);
    // The app runs for a moment before the browser leaves: its tab id and entry URLs go to the frame's own storage.
    expect(r.memoryStorage).toBe(true);
    expect([r.settings, r.view, r.session]).toEqual([null, null, 0]);
    expect(r.docListeners).toEqual(["click"]);
  }, 30_000);
});
