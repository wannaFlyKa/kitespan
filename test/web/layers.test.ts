// The page's layers, by z-index: an anchored menu (a Popup that is not a sheet: a row's "...", a long-press, the
// pickers) is the newest surface wherever it opens, so it draws over a modal layer that is open under it. A chat row's
// menu opens in the chat-list drawer (medium touch, and a laptop window under 1,000 px), whose scrim and drawer once
// drew over it: a tap on Rename or Archive landed on the scrim and closed the drawer. The composer's ride and the
// toasts stay under the menus; the sheets and dialogs over the page's own layers.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const STYLES = join(import.meta.dir, "..", "..", "web", "styles");

/** The z-index of the first rule whose selector list is exactly `selector`, in one of the stylesheets. */
function zOf(selector: string): number {
  for (const file of ["base.css", "layout.css", "screens.css", "composer.css"]) {
    const css = readFileSync(join(STYLES, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const re = /([^{}]+)\{([^{}]*)\}/g;
    for (let m = re.exec(css); m; m = re.exec(css)) {
      if (m[1]!.trim() !== selector) continue;
      const z = /(?:^|;)\s*z-index:\s*(-?\d+)/.exec(m[2]!);
      if (z) return Number(z[1]);
    }
  }
  throw new Error(`no z-index for ${selector}`);
}

describe("layers", () => {
  test("an anchored menu draws over the scrim, the drawers, the sheets and the dialogs", () => {
    const menu = zOf(".menu");
    for (const s of [".scrim", ".sheet", ".dialog", ".shell-drawer", ".scr-drawer"]) expect([s, menu > zOf(s)]).toEqual([s, true]);
  });

  test("the composer's ride and the toasts stay under the menus; the modal layers over the toasts", () => {
    const menu = zOf(".menu");
    expect(zOf(".cmp-ride.is-riding")).toBeLessThan(menu);
    expect(zOf(".toasts")).toBeLessThan(menu);
    expect(zOf(".toasts")).toBeLessThan(zOf(".scrim"));
    expect(zOf(".scrim")).toBeLessThan(zOf(".sheet"));
  });
});
