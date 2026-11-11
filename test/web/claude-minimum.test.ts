// The minimum Claude Code version's line on the page (rows 118 (3), 119): Settings > Claude Code (in the drift line's
// place, in the row line's warn look) and the new-chat form (under the box, in its under-box look), from GET
// /api/settings's probe, else the welcome frame's. A stock build gets `claude update` as a code span that one tap
// selects whole; a company's own build gets the company's way, with no command. At or above the minimum, and for a
// version that cannot be read: nothing new (the drift line as before). Rendered with React's server renderer.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ClaudeBelow, ClaudeStatus } from "../../shared/protocol";
import type { SettingsReply } from "../../server/http/api-types";
import { resetState } from "../../web/state/store";
import type { Project } from "../../web/state/types";
import { SectionBody } from "../../web/screens/Settings";
import { NewChatForm } from "../../web/screens/NewChatForm";

const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const ids = (html: string) => [...html.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]!);
/** The element with this test id, whole (its tag, its text and its children's tags). */
const element = (html: string, id: string) => html.match(new RegExp(`<(span|p)[^>]*data-testid="${id}"[^>]*>[\\s\\S]*?</\\1>`))?.[0] ?? "";

const P: Project = { id: "kitespanxx", name: "kitespan", folder: "/work/kitespan", branch: "", picks: { model: "claude-opus-5-5" } };
const STOCK: ClaudeBelow = { version: "2.1.250", minimum: "2.1.296", stock: true };
const COMPANY: ClaudeBelow = { version: "2.1.250-acme.2", minimum: "2.1.296", stock: false };
const STOCK_LINE = "Claude Code 2.1.250 runs here; kitespan supports 2.1.296 and later. Run claude update.";
const COMPANY_LINE = "Claude Code 2.1.250-acme.2 runs here; kitespan supports 2.1.296 and later. Update it the way your company provides it.";

type Claude = SettingsReply["claude"];
function reply(claude: Claude): SettingsReply {
  return {
    settings: {},
    server: { host: "127.0.0.1", port: 7945, auth: "none", version: "0.1.0" },
    access: { origins: [], hint: [] },
    adaptersProblem: null,
    phoneNotes: [],
    claude,
    uploads: { ok: true, path: "/tmp/kitespan-uploads-dev" },
    agent: { respondToBash: true, cleanupPeriodDays: null, promptSuggestions: false, defaultMode: null },
    account: { provider: "bedrock", at: null },
    facts: null,
  };
}
const claude = (version: string | null, more: Partial<Claude> = {}): Claude => ({ ok: true, path: "/usr/local/bin/claude", realpath: "/usr/local/bin/claude", version, drift: null, ...more });
const welcome = (c: ClaudeStatus) => ({ version: "0.1.0", claude: c, epoch: null });

const LAPTOP = { touch: false, laptop: true, phone: false, narrow: false };
const settings = () => renderToStaticMarkup(createElement(SectionBody, { id: "claude-code", ctx: LAPTOP }));
const form = () => renderToStaticMarkup(createElement(NewChatForm, { init: { project: P.id }, autoFocus: false }));

// The form's menus read the viewport (layout/size.ts): a laptop window with a mouse for these renders.
const gm = globalThis as unknown as { matchMedia?: unknown; window?: unknown };
const own = { mm: !gm.matchMedia, win: !gm.window };
beforeAll(() => {
  gm.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  gm.window = { innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {} };
});
afterAll(() => {
  if (own.mm) delete gm.matchMedia;
  if (own.win) delete gm.window;
  resetState();
});
beforeEach(() => resetState({ projects: [P], ready: true }));

describe("Settings > Claude Code", () => {
  test("a stock build below it: the line in the drift line's place, warn-coloured, with the command as a code span", () => {
    resetState({ projects: [P], ready: true, host: reply(claude("2.1.250 (Claude Code)", { drift: "Claude Code 2.1.250 runs here; this SDK was built for 2.1.312.", belowMinimum: STOCK })) });
    const html = settings();
    const line = element(html, "setting-claude-minimum");
    expect(line).toMatch(/^<span class="set-row-line" data-testid="setting-claude-minimum">/);
    expect(text(line)).toBe(STOCK_LINE);
    expect(line).toContain('<code class="select-all">claude update</code>.');
    // One line per row: the drift line goes.
    expect(html).not.toContain("this SDK was built for");
    expect(html).not.toContain("set-drift");
    // The Version row still shows the whole version.
    expect(text(html)).toContain("Version 2.1.250");
  });

  test("a company's own build below it: the company's way, no command", () => {
    resetState({ projects: [P], ready: true, host: reply(claude("2.1.250-acme.2 (Acme Claude Code)", { belowMinimum: COMPANY })) });
    const line = element(settings(), "setting-claude-minimum");
    expect(text(line)).toBe(COMPANY_LINE);
    expect(line).not.toContain("<code");
    expect(line).not.toContain("claude update");
  });

  test("at or above it: no line, and the drift line as before", () => {
    resetState({ projects: [P], ready: true, host: reply(claude("2.1.317", { drift: "Claude Code 2.1.317 runs here; this SDK was built for 2.1.312." })) });
    const html = settings();
    expect(ids(html)).not.toContain("setting-claude-minimum");
    expect(text(html)).toContain("Claude Code 2.1.317 runs here; this SDK was built for 2.1.312.");
    resetState({ projects: [P], ready: true, host: reply(claude("2.1.296", { belowMinimum: null })) });
    expect(ids(settings())).not.toContain("setting-claude-minimum");
  });

  test("a version that cannot be read, or no claude: nothing new", () => {
    resetState({ projects: [P], ready: true, host: reply(claude("garbage")) });
    expect(ids(settings())).not.toContain("setting-claude-minimum");
    resetState({ projects: [P], ready: true, host: reply({ ok: false, path: null, realpath: null, version: null, drift: null }) });
    const none = settings();
    expect(ids(none)).not.toContain("setting-claude-minimum");
    expect(text(none)).toContain("There is no claude on your PATH, so no chat can start.");
  });

  test("before the settings read, the welcome's facts; after it, the read's (a page load after claude update)", () => {
    resetState({ projects: [P], ready: true, server: welcome({ ok: true, version: "2.1.250", drift: null, belowMinimum: STOCK }) });
    expect(text(element(settings(), "setting-claude-minimum"))).toBe(STOCK_LINE);
    resetState({ projects: [P], ready: true, server: welcome({ ok: true, version: "2.1.250", drift: null, belowMinimum: STOCK }), host: reply(claude("2.1.317")) });
    expect(ids(settings())).not.toContain("setting-claude-minimum");
    // Nor does the welcome's old drift line come back in its place once the read says the versions match.
    const old = { ok: true, version: "2.1.250", drift: "Claude Code 2.1.250 runs here; this SDK was built for 2.1.312.", belowMinimum: STOCK };
    resetState({ projects: [P], ready: true, server: welcome(old), host: reply(claude("2.1.312")) });
    const html = settings();
    expect(html).not.toContain("runs here");
    expect(text(html)).toContain("Version 2.1.312");
  });
});

describe("the new-chat form", () => {
  test("a stock build below it: one note under the box, in the under-box look, with the command as a code span", () => {
    resetState({ projects: [P], ready: true, host: reply(claude("2.1.250 (Claude Code)", { belowMinimum: STOCK })) });
    const html = form();
    const line = element(html, "form-claude-minimum");
    expect(line).toMatch(/^<p class="cmp-ext" role="note" data-testid="form-claude-minimum">/);
    expect(text(line)).toBe(STOCK_LINE);
    expect(line).toContain('<code class="select-all">claude update</code>');
    expect(ids(html).filter((i) => i === "form-claude-minimum")).toHaveLength(1);
    // It holds nothing back: Start is the form's own button, as without the line.
    expect(ids(html)).toContain("confirm-start");
  });

  test("a company's own build below it, from the welcome frame: the company's way", () => {
    resetState({ projects: [P], ready: true, server: welcome({ ok: true, version: "2.1.250-acme.2", drift: null, belowMinimum: COMPANY }) });
    const line = element(form(), "form-claude-minimum");
    expect(text(line)).toBe(COMPANY_LINE);
    expect(line).not.toContain("<code");
  });

  test("at or above it, a version that cannot be read, or a frame of an older server: no line (the form shows no drift)", () => {
    for (const c of [claude("2.1.317", { drift: "Claude Code 2.1.317 runs here; this SDK was built for 2.1.312." }), claude("2.1.296.1"), claude(null), claude("garbage", { belowMinimum: null })]) {
      resetState({ projects: [P], ready: true, host: reply(c) });
      const html = form();
      expect(ids(html)).not.toContain("form-claude-minimum");
      expect(html).not.toContain("runs here");
    }
    resetState({ projects: [P], ready: true, server: welcome({ ok: true, version: "2.1.250", drift: null }) });
    expect(ids(form())).not.toContain("form-claude-minimum");
  });
});

test("the code span selects whole on one tap or click, in every browser kitespan supports", () => {
  const css = readFileSync(join(import.meta.dir, "..", "..", "web", "styles", "base.css"), "utf8");
  const rule = css.match(/\.select-all\s*\{([^}]*)\}/)?.[1] ?? "";
  expect(rule).toContain("-webkit-user-select: all;");
  expect(rule).toMatch(/(^|[^-])user-select: all;/);
});
