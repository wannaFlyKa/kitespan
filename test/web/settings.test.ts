// Settings and About (DESIGN.md 6.8, 6.11, 6.13; build checklist B7 and B8; MINIMALISM M14 to M16, M32; 8.3 checks 1,
// 12 and 24): each section drawn from the store as /api/settings fills it (react-dom/server). The raw statement word
// for word; Account shows only the provider Claude Code reports, or "Start a chat to read it"; the read-only lines for
// retention (SL-18) and the 30-minute background limit (PA-11); the Fast mode line (read-only), Skills and plugins and
// Output style from the chat's init facts, or "Start a chat to read it" (AR-7, SE-3, SE-4); the shortcut list of this
// version only; no other agent named (row 117); at most one short line per row, the rest in the row's own view;
// no "Read-only" badge and no milestone label; the four looks and a link's look as a draft until Save.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SETTINGS_SECTIONS, SETTING_KEYS } from "../../shared/route";
import type { SettingsReply } from "../../server/http/api-types";
import { act, getState, resetState } from "../../web/state/store";
import { LOOKS } from "../../web/state/catalog";
import type { Chat, InitFacts, Project } from "../../web/state/types";
import { LookRow, parseLook } from "../../web/screens/LookPicker";
import { KEY_SECTION, MORE, NOTHING_CHANGES, NOT_IN_THIS_VERSION, RAW_STATEMENT, SHORTCUTS, START_A_CHAT, SectionBody, SettingsLine, chatOfPath, effortLine, fastModeWords, keptLine, providerName } from "../../web/screens/Settings";
import { parse, pushedState } from "../../web/router";
import { closeSettings, settingsSteps } from "../../web/screens/settingsHistory";
import { LOOK_BRANDS, scripted } from "./fixtures";

type Section = (typeof SETTINGS_SECTIONS)[number];
type Key = (typeof SETTING_KEYS)[number];

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");
const ids = (html: string) => [...html.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]!);

const P: Project = { id: "kitespanxx", name: "kitespan", folder: "/work/kitespan", branch: "", picks: { model: "claude-opus-5-5" } };

function reply(p: Partial<SettingsReply> = {}): SettingsReply {
  return {
    settings: {},
    server: { host: "127.0.0.1", port: 7946, auth: "none", version: "0.1.0" },
    access: { origins: [], hint: [] },
    adaptersProblem: null,
    phoneNotes: [],
    claude: { ok: true, path: "/usr/local/bin/claude", realpath: "/opt/claude/2.1.400/claude", version: "2.1.400", drift: null },
    uploads: { ok: true, path: "/tmp/kitespan-uploads-dev" },
    agent: { respondToBash: true, cleanupPeriodDays: null, promptSuggestions: false, defaultMode: null },
    account: { provider: "bedrock", at: null },
    facts: null,
    ...p,
  };
}

function chat(p: Partial<Chat> = {}): Chat {
  return {
    ...scripted({
      id: "k3m7q2x4abk3m7q2x4ab",
      projectId: P.id,
      title: "Fix the flaky upload test",
      titleSource: "first-prompt",
      state: "idle",
      updatedAt: "2026-10-31T08:00:00.000Z",
      sessionId: "",
      model: "default",
      effort: "default",
      mode: "default",
      items: [],
      pending: [],
      context: { usedPct: 0, usedTokens: 0, windowTokens: 0, parts: [] },
      connectors: [],
      outputs: [],
    }),
    ...p,
  };
}

function init(p: Partial<InitFacts> = {}): InitFacts {
  return { fastMode: null, skills: [], plugins: [], outputStyle: null, ...p };
}

interface Ctx {
  focusKey?: Key;
  urlValue?: string;
  touch: boolean;
  laptop: boolean;
  phone: boolean;
  narrow: boolean;
  chat?: Chat;
}
const LAPTOP: Ctx = { touch: false, laptop: true, phone: false, narrow: false };

function section(id: Section, ctx: Partial<Ctx> = {}): string {
  return renderToStaticMarkup(createElement(SectionBody, { id, ctx: { ...LAPTOP, ...ctx } }));
}

// A menu row reads the viewport (layout/size.ts): a laptop window with a mouse for these renders.
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

beforeEach(() => resetState({ projects: [P], ready: true }));

describe("About (8.3 check 1, REQUIREMENTS items 3 and 18)", () => {
  test("the raw statement exactly, in its own paragraph", () => {
    expect(RAW_STATEMENT).toBe("Raw Claude Code experience. This app adds no ACP layer and no prompt of its own.");
    expect(section("about")).toContain(`<p class="set-claim" data-testid="raw-statement">${RAW_STATEMENT}</p>`);
  });

  test("the warning line, kitespan's version from the server, and the Restart row (4.10); no milestone label", () => {
    resetState({ projects: [P], server: { version: "0.1.0", claude: null, epoch: null }, ready: true });
    const html = section("about");
    const t = text(html);
    expect(t).toContain("kitespan is experimental and is not guaranteed to work. It runs your own Claude Code, and you can open any chat in the terminal at any time.");
    expect(t).toContain("Version 0.1.0");
    expect(html).toContain('data-testid="setting-restart"');
    expect(t).not.toMatch(/v0\.4|Comes with/);
  });

  test("the Licence row names the licence of the repository's LICENSE file (launch/PLAN.md L2)", () => {
    expect(text(section("about"))).toContain("Licence Apache-2.0");
    expect(text(section("about"))).not.toContain("To be decided");
  });

  // The guard is on the sentence that About had; it names no agent itself.
  test("no other agent is named anywhere: kitespan is for Claude Code (row 117)", () => {
    expect(text(section("about"))).not.toMatch(/support is coming/);
    const root = join(import.meta.dir, "..", "..", "web");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && /support is coming/.test(readFileSync(p, "utf8"))) hits.push(p.slice(root.length + 1));
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});

describe("Account (SE-6): only the provider Claude Code reports", () => {
  test("before /api/settings answers: ...; with no live chat: Start a chat to read it", () => {
    expect(text(section("account"))).toContain("Account ...");
    resetState({ projects: [P], host: reply({ account: null }), ready: true });
    expect(text(section("account"))).toContain(`Account ${START_A_CHAT}`);
  });

  test("the provider a live chat reports, by its name; never an email or an organisation", () => {
    resetState({ projects: [P], host: reply({ account: { provider: "bedrock", at: null } }), ready: true });
    const t = text(section("account"));
    expect(t).toContain("Provider Bedrock");
    expect(t).not.toMatch(/mail|organi[sz]ation/i);
    expect(providerName("firstParty")).toBe("Anthropic");
    expect(providerName("something-new")).toBe("something-new");
  });

  test("when Claude Code reports no provider, there is no provider row", () => {
    resetState({ projects: [P], host: reply({ account: { provider: null, at: null } }), ready: true });
    expect(ids(section("account"))).toEqual([]);
  });
});

describe("Chats: the read-only lines from Claude Code (SL-18, PA-11) and the settings with their controls", () => {
  test("retention: Claude Code's 30 days while cleanupPeriodDays is unset, else its value; the 30-minute background limit", () => {
    resetState({ projects: [P], host: reply(), ready: true });
    let t = text(section("chats"));
    expect(t).toContain("Claude Code keeps transcripts for 30 days");
    expect(t).toContain("Background commands stop after 30 minutes");
    expect(t).toContain("Prompt suggestions Off");
    resetState({ projects: [P], host: reply({ agent: { respondToBash: true, cleanupPeriodDays: 14, promptSuggestions: true, defaultMode: null } }), ready: true });
    t = text(section("chats"));
    expect(t).toContain("Claude Code keeps transcripts for 14 days");
    expect(t).toContain("Prompt suggestions On");
  });

  test("before the read: ...; with no project at all: Start a chat to read it", () => {
    expect(text(section("chats"))).toContain("Claude Code keeps transcripts for ...");
    resetState({ projects: [], ready: true });
    expect(text(section("chats"))).toContain(`Prompt suggestions ${START_A_CHAT}`);
  });

  test("every row of 6.8 is there, with the Uploads group's four folder choices", () => {
    resetState({ projects: [P], host: reply(), ready: true });
    const html = section("chats");
    for (const k of ["idle-minutes", "live-max", "new-chats", "remembered", "allow-bypass", "auto-title", "bash-reply", "upload-folder", "max-upload", "keep-days", "prompt-suggestions", "transcripts", "background-commands"]) expect(ids(html)).toContain(`setting-${k}`);
    for (const f of ["temp", "state", "claude", "custom"]) expect(ids(html)).toContain(`upload-folder-${f}`);
    expect(text(html)).toContain("Cleared when the machine restarts.");
    expect(text(html)).toContain("/tmp/kitespan-uploads-dev/");
  });

  test("a folder that fails the server's check shows the server's line under Upload folder", () => {
    resetState({ projects: [P], host: reply({ uploads: { ok: false, line: "The upload folder is a symbolic link. Pick another folder." } }), ready: true });
    expect(text(section("chats"))).toContain("The upload folder is a symbolic link. Pick another folder.");
  });

  test("the bypass row keeps its safety clause on the row", () => {
    expect(text(section("chats"))).toContain("Allow bypass permissions mode In that mode Claude skips most permission prompts.");
  });
});

describe("principle 0 (D51, M14 to M16): one short line at most, the rest one tap away", () => {
  const all = (ctx: Partial<Ctx> = {}) => SETTINGS_SECTIONS.map((id) => section(id, ctx)).join("");

  test("no Read-only badge, no milestone label, no section intro paragraph, no later-milestone shortcuts", () => {
    resetState({ projects: [P], host: reply(), ready: true });
    const t = text(all());
    expect(t).not.toMatch(/Read-only|With a later milestone|Comes with|v0\.[0-9]|Nothing here changes/);
    expect(all()).not.toContain("set-intro");
  });

  test("each row shows at most one short line, and no longer explanation outside its own view", () => {
    resetState({ projects: [P], host: reply(), ready: true });
    const html = all();
    for (const row of html.split('<li class="set-row').slice(1)) expect((row.match(/class="set-help"/g) ?? []).length).toBeLessThanOrEqual(1);
    expect(html).not.toContain("set-more\"");
    expect(text(html)).not.toContain("After this long with nothing running");
  });

  test("the i beside a row opens its own view, where the longer text shows; a Claude Code row starts with the spike's line", () => {
    const html = section("chats");
    expect(html).toContain('href="/settings/chats/idle-minutes" class="set-more-link" data-testid="setting-more-idle-minutes" aria-label="About Keep an idle chat running for"');
    const own = text(section("chats", { focusKey: "idle-minutes" }));
    expect(own).toContain("After this long with nothing running and nobody viewing it");
    const claude = section("chats", { focusKey: "bash-reply" });
    expect(text(claude)).toContain(`${NOTHING_CHANGES} Follow Claude Code uses your own Claude Code setting`);
    expect(ids(claude)).not.toContain("setting-more-bash-reply");
  });

  test("every longer text belongs to a key of the route table and opens in that key's section", () => {
    for (const k of Object.keys(MORE) as Key[]) {
      expect(SETTING_KEYS).toContain(k);
      expect(ids(section(KEY_SECTION[k], { focusKey: k }))).toContain(`setting-more-text-${k}`);
    }
  });
});

describe("General: the Return key, and Keyboard shortcuts one tap away (6.11, AR-9)", () => {
  test("a row opens /settings/general/shortcuts; there the list of this version's shortcuts", () => {
    expect(section("general")).toContain('href="/settings/general/shortcuts"');
    const t = text(section("general", { focusKey: "shortcuts" }));
    for (const s of SHORTCUTS) expect(t).toContain(s.words);
    expect(t).not.toMatch(/diff pane|split view/);
    expect(SHORTCUTS.map((s) => s.words)).toEqual([
      "Show keyboard shortcuts",
      "Next or previous chat",
      "Stop Claude's response",
      // Iteration 8 (T-9): Tab and Right arrow leave the list until the suggested prompt is drawn (CO-16).
      "Toggle terminal pane",
      // Iteration 5 (U4): Desktop's "Close focused pane", Cmd backslash (Ctrl backslash off macOS), in Desktop's order.
      "Close focused pane",
      // Iteration 5 (R124, row 124): Desktop's "Open side chat", Cmd ; (Ctrl ; off macOS), in Desktop's order.
      "Open side chat",
      // Iteration 7 (DESIGN-B1 4.14): Desktop's "Toggle Browser pane", after Open side chat.
      "Toggle Browser pane",
      "Cycle view modes",
      "Open permission mode menu",
      "Open model menu",
      "Open effort menu",
      "Select item in an open menu",
      "Search",
      // Iteration 7: kitespan's way out of the browser pane's frame.
      "Go to the address",
      "Send now",
      "Jump to the previous or next turn",
    ]);
    // kitespan's own rows at the end of 6.11's table: Search (v0.3 search), Cmd K, which this platform writes as Ctrl K
    // off macOS; from v0.4 resume the CLI's Ctrl+Enter, Send now (row 111; send-now.test.ts); and from iteration 5 the
    // CLI's transcript keys `{` and `}` (U3, DESIGN-U3 7), outside the message box.
    expect(SHORTCUTS[SHORTCUTS.length - 4]!.keys).toEqual([["Cmd", "K"]]);
    // Iteration 7: Go to the address (Cmd L, Ctrl L off macOS), in the browser pane, after Search.
    expect(SHORTCUTS[SHORTCUTS.length - 3]).toEqual({ words: "Go to the address", keys: [["Cmd", "L"]], note: "In the browser pane" });
    expect(SHORTCUTS.find((s) => s.words === "Toggle Browser pane")!.keys).toEqual([["Cmd", "Shift", "B"]]);
    expect(SHORTCUTS[SHORTCUTS.length - 2]!.keys[0]).toEqual(["Ctrl", "Enter"]);
    expect(SHORTCUTS[SHORTCUTS.length - 1]).toEqual({ words: "Jump to the previous or next turn", keys: [["{"], ["}"]], note: "Outside the message box" });
    expect(SHORTCUTS.find((s) => s.words === "Open side chat")!.keys).toEqual([["Cmd", ";"]]);
  });

  test("on every size: a tablet or a phone with a hardware keyboard has every key (iteration 8, T-7)", () => {
    for (const ctx of [{ laptop: false, touch: true, phone: true, narrow: true }, { laptop: false, touch: true, phone: false, narrow: false }]) {
      expect(ids(section("general", ctx))).toEqual(["setting-return-key", "setting-more-return-key", "setting-shortcuts"]);
      const t = text(section("general", { ...ctx, focusKey: "shortcuts" }));
      for (const s of SHORTCUTS) expect(t).toContain(s.words);
      expect(t).not.toContain("show on a laptop");
    }
    expect(text(section("general", { focusKey: "shortcuts" }))).not.toMatch(/Accept the suggested prompt|Right arrow/);
  });
});

describe("Models and fast mode (AR-7)", () => {
  test("the picker's rows as Claude Code reports them for the chat, each with its effort range", () => {
    const c = chat({ models: [{ value: "claude-opus-5-5", displayName: "Opus 5.5", description: "Most capable for complex work", efforts: ["low", "medium", "high", "xhigh", "max"], supportsAutoMode: true }] });
    resetState({ projects: [P], chats: [c], ready: true });
    const t = text(section("models", { chat: c }));
    expect(t).toContain("Opus 5.5 claude-opus-5-5 Most capable for complex work Effort low to max");
    expect(effortLine(["high"])).toBe("Effort high only");
  });

  test("with no chat: Start a chat to read it, for the picker's rows", () => {
    resetState({ projects: [P], chats: [], ready: true });
    expect(text(section("models"))).toContain(`Model picker rows ${START_A_CHAT}`);
  });

  test("the Fast mode line, read-only: the CLI's state and its reason from the chat's init facts (D35, AR-7)", () => {
    const c = chat({ serverState: "idle", init: init({ fastMode: { state: "off", reason: "not_first_party" } }) });
    resetState({ projects: [P], chats: [c], ready: true });
    const html = section("models", { chat: c });
    expect(text(html)).toContain("Fast mode Not available with this provider. Off");
    // No toggle: kitespan builds no fast mode.
    const row = html.slice(html.indexOf('data-testid="setting-fast-mode"'));
    expect(row.slice(0, row.indexOf("</li>"))).not.toMatch(/<button|<input|role="switch"/);
    expect(fastModeWords({ state: "on", reason: null })).toEqual({ value: "On", line: null });
    expect(fastModeWords({ state: "cooldown", reason: null }).value).toBe("Cooling down");
    // A reason the page has no words for shows as the CLI sent it.
    expect(fastModeWords({ state: "off", reason: "something_new" }).line).toBe("something_new");
  });

  test("before any chat started (no init facts): Start a chat to read it; with a CLI that sends no state, no row", () => {
    for (const chats of [[], [chat({ serverState: "sleeping" })]]) {
      resetState({ projects: [P], chats, ready: true });
      expect(text(section("models"))).toContain(`Fast mode ${START_A_CHAT}`);
    }
    const c = chat({ serverState: "idle", init: init({ fastMode: null }) });
    resetState({ projects: [P], chats: [c], ready: true });
    expect(ids(section("models", { chat: c }))).not.toContain("setting-fast-mode");
  });
});

describe("Claude Code: the claude on PATH, from /api/settings", () => {
  test("its path, real path and version, the SDK version, and the drift line when the versions differ", () => {
    resetState({ projects: [P], host: reply({ claude: { ok: true, path: "/usr/local/bin/claude", realpath: "/opt/claude/2.1.400/claude", version: "2.1.400", drift: "Claude Code 2.1.400 runs here; this SDK was built for 2.1.322." } }), ready: true });
    const t = text(section("claude-code"));
    expect(t).toContain("/ usr/ local/ bin/ claude");
    expect(t).toContain("Version 2.1.400");
    expect(t).toContain("Agent SDK Version 0.3.322");
    expect(t).toContain("Claude Code 2.1.400 runs here; this SDK was built for 2.1.322.");
  });

  test("with no claude on PATH, one line says so", () => {
    resetState({ projects: [P], host: reply({ claude: { ok: false, path: null, realpath: null, version: null, drift: null } }), ready: true });
    expect(text(section("claude-code"))).toContain("There is no claude on your PATH, so no chat can start.");
  });

  test("the version without the CLI's own name after it (claude --version prints 2.1.322 (Claude Code))", () => {
    resetState({ projects: [P], host: reply({ claude: { ok: true, path: "/usr/local/bin/claude", realpath: null, version: "2.1.322 (Claude Code)", drift: null } }), ready: true });
    const t = text(section("claude-code"));
    expect(t).toContain("Version 2.1.322 Agent SDK");
    expect(t).not.toContain("(Claude Code)");
  });

  test("Skills and plugins and Output style from the chat's init facts: the skills, each plugin with its version, the style", () => {
    const c = chat({ serverState: "idle", init: init({ skills: ["review-pr", "release-notes"], plugins: [{ name: "lint-tools", version: "1.4.0" }, { name: "notes", version: null }], outputStyle: "Explanatory" }) });
    resetState({ projects: [P], chats: [c], host: reply(), ready: true });
    const html = section("claude-code", { chat: c });
    expect(ids(html)).toContain("setting-skills");
    expect(ids(html)).toContain("setting-output-style");
    const t = text(html);
    expect(t).toContain("review-pr");
    expect(t).toContain("release-notes");
    expect(t).toContain("lint-tools 1.4.0");
    expect(t).toMatch(/notes(?! \d)/);
    expect(t).toContain("Output style");
    expect(t).toContain("Explanatory");
    expect(t).not.toContain(START_A_CHAT);
  });

  test("before the chat's Claude Code started: Start a chat to read it, and no Reload", () => {
    for (const ctx of [{}, { chat: chat({ serverState: "sleeping" }) }]) {
      resetState({ projects: [P], chats: [chat({ serverState: "sleeping" })], host: reply(), ready: true });
      const html = section("claude-code", ctx);
      expect(text(html)).toContain(`Skills and plugins ${START_A_CHAT}`);
      expect(text(html)).toContain(`Output style ${START_A_CHAT}`);
      expect(ids(html)).not.toContain("confirm-reload-skills");
    }
  });

  test("while the facts are on their way (the list has not come, or a live chat's read runs), the rows wait quietly", () => {
    const live = chat({ serverState: "idle" });
    for (const [p, ctx] of [[{ ready: false, chats: [] }, {}], [{ ready: true, chats: [live] }, { chat: live }], [{ ready: true, chats: [live] }, {}]] as const) {
      resetState({ projects: [P], host: reply(), ...p, chats: [...p.chats] });
      const t = text(section("claude-code", ctx)) + text(section("models", ctx));
      expect(t).toContain("Skills and plugins");
      expect(t).toContain("Output style");
      expect(t).toContain("Fast mode");
      expect(t).not.toContain(`Skills and plugins ${START_A_CHAT}`);
      expect(t).not.toContain(`Output style ${START_A_CHAT}`);
      expect(t).not.toContain(`Fast mode ${START_A_CHAT}`);
    }
  });

  test("Settings opened from a chat that sleeps shows the facts of the newest chat that has them", () => {
    const asleep = chat({ id: "planthesearchindex2a", serverState: "sleeping" });
    const live = chat({ serverState: "idle", init: init({ skills: ["review-pr"], outputStyle: "Explanatory" }) });
    resetState({ projects: [P], chats: [live, asleep], host: reply(), ready: true });
    const t = text(section("claude-code", { chat: asleep }));
    expect(t).toContain("review-pr");
    expect(t).toContain("Explanatory");
    expect(t).not.toContain(START_A_CHAT);
  });

  test("one Reload, drawn once the store can send it, acts only on its click", () => {
    const c = chat({ serverState: "idle", init: init({ skills: ["review-pr"] }) });
    resetState({ projects: [P], chats: [c], host: reply(), ready: true });
    const a = act as unknown as { reloadSkills?: () => void };
    const had = a.reloadSkills;
    try {
      a.reloadSkills = undefined;
      expect(ids(section("claude-code", { chat: c }))).not.toContain("confirm-reload-skills");
      let n = 0;
      a.reloadSkills = () => n++;
      const html = section("claude-code", { chat: c });
      expect(ids(html).filter((x) => x === "confirm-reload-skills").length).toBe(1);
      expect(text(html)).toContain("Reload");
      expect(n).toBe(0);
    } finally {
      a.reloadSkills = had;
    }
  });

  test("their own views say the spike's line first, and their links show no Not in this version", () => {
    expect(Object.keys(MORE)).toContain("skills");
    expect(Object.keys(MORE)).toContain("output-style");
    const c = chat({ serverState: "idle", init: init({ skills: ["review-pr"], outputStyle: "default" }) });
    for (const key of ["skills", "output-style"] as const) {
      resetState({ projects: [P], chats: [c], host: reply(), ready: true });
      const route = parse(new URL(`/settings/claude-code/${key}`, "http://127.0.0.1"));
      expect(route.name).toBe("setting");
      const line = renderToStaticMarkup(createElement(SettingsLine, { route, section: "claude-code", ctx: { ...LAPTOP } }));
      expect(text(line)).not.toContain(NOT_IN_THIS_VERSION);
      const html = section("claude-code", { chat: c, focusKey: key });
      expect(html).toContain(`data-testid="setting-more-text-${key}"`);
      expect(text(html)).toContain(NOTHING_CHANGES);
    }
  });
});

describe("the four looks and the Look picker (B8, D36, 8.3 check 24)", () => {
  const look = (urlRaw?: string) => renderToStaticMarkup(createElement(LookRow, { focused: urlRaw !== undefined, urlRaw, touch: false }));

  test("four tiles, Glass first and checked by default, each a live preview of its look", () => {
    const html = look();
    expect(LOOKS.map((l) => l.label)).toEqual(["Glass", "Paper", "Mono", "Editor"]);
    for (const l of LOOKS) expect(html).toContain(`data-look="${l.id}"`);
    expect(html).toMatch(/aria-checked="true"[^>]*data-testid="look-glass"/);
    expect(text(html)).toContain("Pick the feel you like. Every look works in light and dark.");
  });

  test("?value=editor checks Editor as a draft, Not saved and Save, while the page keeps its look", () => {
    const html = look("editor");
    expect(html).toMatch(/aria-checked="true"[^>]*data-testid="look-editor"/);
    expect(text(html)).toContain("Not saved Save");
    expect(getState().settings.look).toBe("glass");
    expect(parseLook("Mono")).toBe("mono");
    expect(parseLook("nope")).toBeNull();
  });

  test("a link names a look by its id or its name, in any case; another word names none", () => {
    expect(["glass", "PAPER", "Mono", " editor ", "noir"].map(parseLook)).toEqual(["glass", "paper", "mono", "editor", null]);
    const html = look("Editor");
    expect(html).toMatch(/aria-checked="true"[^>]*data-testid="look-editor"/);
    expect(text(html)).toContain("Not saved Save");
    expect(text(look("glass"))).not.toContain("Not saved");
  });

  test("Settings > Appearance names no product: the looks' names, hints, tooltips, labels and previews (row 105)", () => {
    for (const html of [section("appearance"), section("appearance", { focusKey: "look", urlValue: "editor" }), section("appearance", { touch: true, laptop: false, phone: true })]) {
      expect(text(html).match(LOOK_BRANDS)).toBeNull();
      const attrs = [...html.matchAll(/\s(?:title|aria-label|alt|placeholder)="([^"]*)"/g)].map((m) => m[1]!);
      expect(attrs.filter((a) => LOOK_BRANDS.test(a))).toEqual([]);
      expect(html).not.toMatch(/data-(?:look|testid)="(?:look-)?(?:apple|claude)"/);
    }
    for (const l of LOOKS) expect(section("appearance")).toContain(`title="${l.hint}"`);
  });
});

describe("the chat Settings came from", () => {
  test("a real chat id names it; any other path names none", () => {
    expect(chatOfPath("/c/k3m7q2x4abk3m7q2x4ab/details")).toBe("k3m7q2x4abk3m7q2x4ab");
    expect(chatOfPath("/c/k3m7q2x4abk3m7q2x4ab")).toBe("k3m7q2x4abk3m7q2x4ab");
    expect(chatOfPath("/c/c_demo01")).toBeUndefined();
    expect(chatOfPath("/p/k3m7q2x4ab")).toBeUndefined();
  });

  test("Settings reads that chat's init facts: the read passes its id to the store, and runs again when it is known", () => {
    // A reload of Settings opened from a chat keeps settingsFrom, but this page life never attached that chat; the
    // store reads its facts only when Settings names it (act.refreshSettings's second argument).
    const src = readFileSync(join(import.meta.dir, "..", "..", "web", "screens", "Settings.tsx"), "utf8");
    const read = src.slice(src.indexOf("function useSettingsRead"), src.indexOf("export function Settings("));
    expect(read).toMatch(/act\.refreshSettings\(project, chat\?\.id\)/);
    // Again once the chat list has come (a reload: Settings draws before it), and before the first paint, so the
    // rows wait quietly instead of saying Start a chat.
    expect(read).toMatch(/useLayoutEffect\(\(\) => \{\s*act\.refreshSettings\(project, chat\?\.id\);\s*\}, \[project, chat\?\.id, ready\]\)/);
  });
});

describe("the restart route (4.10, M32)", () => {
  test("the dialog is the restart's own, not a later milestone's line: its buttons act, opening it sends nothing", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "web", "screens", "Settings.tsx"), "utf8");
    expect(src).not.toContain("<p>{NOT_IN_THIS_VERSION}</p>");
    const dialog = readFileSync(join(import.meta.dir, "..", "..", "web", "settings", "RestartDialog.tsx"), "utf8");
    expect(dialog).toMatch(/data-testid="confirm-restart"[^>]*onClick=\{press\(\(\) => act\.restart\("finish"\)\)\}/);
    expect(dialog).not.toMatch(/useEffect\([^)]*act\.restart/);
  });
});

describe("Done goes back over the Settings entries only inside this document (5.1 rule 4, as closeTo)", () => {
  const CHAT_URL = "/c/k3m7q2x4abk3m7q2x4ab";
  const g = globalThis as Record<string, unknown>;
  const had = { history: g.history, location: g.location };
  let entries: { url: string; state: unknown }[] = [];
  let at = 0;
  let wentBack = 0;
  const go = (n: number) => {
    wentBack -= n;
    at = Math.max(0, Math.min(entries.length - 1, at + n));
  };
  beforeAll(() => {
    g.history = {
      get state() {
        return entries[at]!.state;
      },
      get length() {
        return entries.length;
      },
      pushState(state: unknown, _t: string, url: string) {
        entries = [...entries.slice(0, at + 1), { url, state: structuredClone(state) }];
        at++;
      },
      replaceState(state: unknown, _t: string, url?: string) {
        entries[at] = { url: url ?? entries[at]!.url, state: structuredClone(state) };
      },
      go,
      back: () => go(-1),
    };
    g.location = {
      get pathname() {
        return entries[at]!.url.split("?")[0];
      },
      get search() {
        const q = entries[at]!.url.indexOf("?");
        return q >= 0 ? entries[at]!.url.slice(q) : "";
      },
    };
  });
  afterAll(() => {
    if (had.history === undefined) delete g.history;
    else g.history = had.history;
    if (had.location === undefined) delete g.location;
    else g.location = had.location;
  });
  const start = (list: { url: string; state: unknown }[]) => {
    entries = list;
    at = list.length - 1;
    wentBack = 0;
  };

  test("settingsSteps: the Settings entries and the entry before them must all be this document's", () => {
    const one = { from: CHAT_URL, back: [CHAT_URL, "/"], doc: "doc1", inDoc: 2, settingsDepth: 1, settingsFrom: CHAT_URL };
    expect(settingsSteps(one, "doc1")).toBe(1);
    const two = { from: "/settings", back: ["/settings", CHAT_URL, "/"], doc: "doc1", inDoc: 3, settingsDepth: 2, settingsFrom: CHAT_URL };
    expect(settingsSteps(two, "doc1")).toBe(2);
    // Settings opened as a new document after the chat: the trail is seeded (no document), so the chat is not behind it here.
    expect(settingsSteps({ from: CHAT_URL, back: [CHAT_URL], settingsDepth: 1, settingsFrom: CHAT_URL }, "doc1")).toBe(0);
    // A section pushed in the new document: its Settings entry is this document's, the chat before it is not.
    expect(settingsSteps({ ...two, inDoc: 1 }, "doc1")).toBe(0);
    // Another document's entry (an id this page does not have).
    expect(settingsSteps(one, "doc2")).toBe(0);
    // A trail that does not lead to the place Settings came from.
    expect(settingsSteps({ ...one, back: ["/p/k3m7q2x4ab", "/"] }, "doc1")).toBe(0);
    expect(settingsSteps({ from: CHAT_URL, back: [CHAT_URL], doc: "doc1", inDoc: 1 }, "doc1")).toBe(0);
  });

  test("Done on Settings opened as a new document after a chat replaces the entry with the chat: no step into the earlier document", () => {
    start([
      { url: CHAT_URL, state: null },
      { url: "/settings/chats", state: { from: CHAT_URL, back: [CHAT_URL], settingsDepth: 1, settingsFrom: CHAT_URL } },
    ]);
    closeSettings();
    expect(wentBack).toBe(0);
    expect(entries.map((e) => e.url)).toEqual([CHAT_URL, CHAT_URL]);
    expect(at).toBe(1);
  });

  test("Done on Settings this page opened goes back over its entries, as before", () => {
    const behind = pushedState(null, "/");
    const first = { ...pushedState(behind, CHAT_URL), settingsDepth: 1, settingsFrom: CHAT_URL };
    const second = { ...pushedState(first, "/settings"), settingsDepth: 2, settingsFrom: CHAT_URL };
    start([
      { url: "/", state: null },
      { url: CHAT_URL, state: behind },
      { url: "/settings", state: first },
      { url: "/settings/chats", state: second },
    ]);
    closeSettings();
    expect(wentBack).toBe(2);
    expect(entries[at]!.url).toBe(CHAT_URL);
    // With no place to go back to (a fresh tab), Home replaces Settings.
    start([{ url: "/settings", state: null }]);
    closeSettings();
    expect([wentBack, entries.map((e) => e.url)]).toEqual([0, ["/"]]);
  });
});

// Row 97: what the last chat's Claude Code reported, while no chat is live, with one dim line per section with its age.
describe("the kept values while no chat is live (row 97)", () => {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  const kept = (h = 3) => ({ at: hoursAgo(h), fastMode: { state: "off" as const, reason: "not_first_party" }, skills: ["review-pr"], plugins: [{ name: "lint-tools", version: "1.4.0" }], outputStyle: "Explanatory" });
  const lines = (html: string) => [...html.matchAll(/data-testid="settings-kept"[^>]*>([^<]*)</g)].map((m) => m[1]);
  test("the line's words: the app's relative time", () => {
    expect(keptLine(hoursAgo(3))).toBe("From the last chat, 3 h ago.");
    expect(keptLine(hoursAgo(0.25))).toBe("From the last chat, 15 min ago.");
    expect(keptLine(new Date().toISOString())).toBe("From the last chat, just now.");
    expect(keptLine(hoursAgo(50))).toBe("From the last chat, 2 d ago.");
  });

  test("Claude Code and Models: the kept start facts in their rows, one line under each section, no Start a chat", () => {
    resetState({ projects: [P], chats: [chat({ serverState: "sleeping" })], host: reply({ facts: kept() }), ready: true });
    const cc = section("claude-code");
    expect(text(cc)).toContain("review-pr");
    expect(text(cc)).toContain("lint-tools");
    expect(text(cc)).toContain("Output style Explanatory");
    expect(text(cc)).not.toContain(START_A_CHAT);
    expect(lines(cc)).toEqual(["From the last chat, 3 h ago."]);
    // Reload acts on live chats: none with a kept list.
    expect(ids(cc)).not.toContain("confirm-reload-skills");
    const models = section("models");
    expect(text(models)).toContain("Fast mode Not available with this provider. Off");
    expect(lines(models)).toEqual(["From the last chat, 3 h ago."]);
    // Kept facts with no fast-mode state: no Fast mode row, and no line in Models.
    resetState({ projects: [P], chats: [], host: reply({ facts: { ...kept(), fastMode: null } }), ready: true });
    expect(lines(section("models"))).toEqual([]);
  });

  test("Account: the kept provider, by its name, and its line; a kept 'none' shows nothing", () => {
    resetState({ projects: [P], host: reply({ account: { provider: "bedrock", at: hoursAgo(5) } }), ready: true });
    const a = section("account");
    expect(text(a)).toContain("Provider Bedrock");
    expect(lines(a)).toEqual(["From the last chat, 5 h ago."]);
    resetState({ projects: [P], host: reply({ account: { provider: null, at: hoursAgo(5) } }), ready: true });
    expect(ids(section("account"))).toEqual([]);
  });

  test("a live value replaces the kept one at once, and the line goes", () => {
    const live = chat({ serverState: "idle", init: init({ skills: ["live-skill"], outputStyle: "Concise" }) });
    resetState({ projects: [P], chats: [live], host: reply({ facts: kept(), account: { provider: "vertex", at: null } }), ready: true });
    const cc = section("claude-code");
    expect(text(cc)).toContain("live-skill");
    expect(text(cc)).not.toContain("review-pr");
    expect(lines(cc)).toEqual([]);
    expect(lines(section("account"))).toEqual([]);
    expect(text(section("account"))).toContain("Provider Google Vertex AI");
  });

  test("nothing kept: the rows stay as today, with no line", () => {
    resetState({ projects: [P], chats: [chat({ serverState: "sleeping" })], host: reply({ facts: null, account: null }), ready: true });
    for (const id of ["claude-code", "account"] as const) {
      expect([id, text(section(id)).includes(START_A_CHAT)]).toEqual([id, true]);
      expect(lines(section(id))).toEqual([]);
    }
  });
});
