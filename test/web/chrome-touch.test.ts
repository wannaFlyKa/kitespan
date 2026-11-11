// Iteration 8 (touch; DESIGN-T1 2.1, 2.4, 2.8 and 2.9; T-21, T-23, G-2, G-4, G-23, G-28, G-34): a tap holds a toast on
// touch until its Close or a second tap; Settings > About shows the notes for a phone's browser that the server sends,
// under "On a phone", and nothing where there are none; the chat title is a press target on touch with no callout, no
// word selection and no drag; the new-chat form's chips wrap on the phone; and every user-select: none in this lane's
// style sheets has its -webkit- twin.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SettingsReply } from "../../server/http/api-types";
import { resetState } from "../../web/state/store";
import { SectionBody } from "../../web/screens/Settings";
import { NO_HOLD, pointerHold, toastHeld, type ToastHold } from "../../web/ui/Toasts";

const STYLES = join(import.meta.dir, "..", "..", "web", "styles");
const css = (name: string) => readFileSync(join(STYLES, name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

describe("a toast's hold (T-21)", () => {
  test("on touch a tap holds it, and a second tap lets it go; a finger's enter and leave do nothing", () => {
    let h: ToastHold = NO_HOLD;
    h = pointerHold(h, "enter", "touch");
    h = pointerHold(h, "down", "touch");
    h = pointerHold(h, "leave", "touch");
    expect(toastHeld(h)).toBe(true);
    h = pointerHold(h, "down", "touch");
    expect(toastHeld(h)).toBe(false);
  });
  test("a mouse or a pen holds it while over it, as before; its press changes nothing", () => {
    for (const kind of ["mouse", "pen"]) {
      let h = pointerHold(NO_HOLD, "enter", kind);
      expect(toastHeld(h)).toBe(true);
      h = pointerHold(h, "down", kind);
      expect(toastHeld(h)).toBe(true);
      expect(toastHeld(pointerHold(h, "leave", kind))).toBe(false);
    }
  });
  test("the focus inside holds it too, whatever the pointer did", () => {
    expect(toastHeld({ ...NO_HOLD, focus: true })).toBe(true);
    expect(toastHeld(pointerHold({ ...NO_HOLD, focus: true }, "leave", "mouse"))).toBe(true);
  });
});

describe("Settings > About: the notes for a phone's browser (T-23, G-23)", () => {
  const gm = globalThis as unknown as { matchMedia?: unknown; window?: unknown };
  const own = { mm: !gm.matchMedia, win: !gm.window };
  beforeAll(() => {
    gm.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    gm.window = { innerWidth: 1100, innerHeight: 800, addEventListener() {}, removeEventListener() {} };
  });
  afterAll(() => {
    if (own.mm) delete gm.matchMedia;
    if (own.win) delete gm.window;
    resetState();
  });
  const host = (phoneNotes: string[]): SettingsReply => ({
    settings: {},
    server: { host: "127.0.0.1", port: 7946, auth: "none", version: "0.1.0" },
    access: { origins: [], hint: [] },
    adaptersProblem: null,
    phoneNotes,
    claude: { ok: true, path: "/usr/local/bin/claude", realpath: "/opt/claude/2.1.400/claude", version: "2.1.400", drift: null },
    uploads: { ok: true, path: "/tmp/kitespan-uploads-dev" },
    agent: { respondToBash: true, cleanupPeriodDays: null, promptSuggestions: false, defaultMode: null },
    account: { provider: "bedrock", at: null },
    facts: null,
  }) as SettingsReply;
  const about = () => renderToStaticMarkup(createElement(SectionBody, { id: "about", ctx: { touch: false, laptop: true, phone: false, narrow: false } }));
  const NOTE = "Add to Home Screen gives kitespan a window of its own.";

  test("under the intro, a group headed On a phone with one row a line", () => {
    resetState({ ready: true, host: host([NOTE, "A second line."]) });
    const html = about();
    expect(html).toMatch(/On a phone<\/h3><ul class="group set-group"[^>]*data-testid="phone-notes">/);
    expect([...html.matchAll(/<li class="set-row"><span class="set-note-line">([^<]*)<\/span><\/li>/g)].map((m) => m[1])).toEqual([NOTE, "A second line."]);
    expect(html.indexOf("phone-notes")).toBeGreaterThan(html.indexOf("set-warn-line"));
    expect(html.indexOf("phone-notes")).toBeLessThan(html.indexOf("setting-version"));
  });
  test("no notes, no group (principle 0)", () => {
    resetState({ ready: true, host: host([]) });
    expect(about()).not.toContain("phone-notes");
    resetState({ ready: true, host: null });
    expect(about()).not.toContain("On a phone");
  });
});

describe("the chat title on touch: a press target (G-2)", () => {
  test("no link callout, no word selection, no drag; the pressed wash while the finger rests (screens.css)", () => {
    const screens = css("screens.css");
    const rule = /\n\.touch \.scr-bar-title \{([^}]*)\}/.exec(screens)?.[1] ?? "";
    for (const d of ["-webkit-touch-callout: none;", "-webkit-user-select: none;", "user-select: none;", "-webkit-user-drag: none;"]) expect([d, rule.includes(d)]).toEqual([d, true]);
    expect(screens).toMatch(/:is\(\.scr-bar-press, \.scr-bar-titlewrap\)\[data-pressing\] > \.scr-bar-title \{\s*background: var\(--selected\);/);
  });
});

describe("the new-chat form's chips wrap on the phone, so the model's shows whole (G-28)", () => {
  test("no sideways scroll of the row on the phone", () => {
    const screens = css("screens.css");
    expect(screens).not.toMatch(/\[data-size="phone"\] \.scr-chips \{[^}]*nowrap/);
    expect(screens).toMatch(/\n\.scr-chips \{[^}]*flex-wrap: wrap;/);
  });
});

describe("-webkit-user-select beside every user-select: none of this lane's sheets (G-34)", () => {
  test("base.css, layout.css and screens.css", () => {
    for (const name of ["base.css", "layout.css", "screens.css"])
      for (const m of css(name).matchAll(/([^{}]+)\{([^{}]*)\}/g))
        if (/(^|[^-])user-select: none/.test(m[2]!)) expect([name, m[1]!.trim(), m[2]!.includes("-webkit-user-select: none")]).toEqual([name, m[1]!.trim(), true]);
  });
});
